//! Pull request monitoring (FR4): find the PR a session raised, poll its policies,
//! merge status and review, and work out whether it failed, is ready, or is stuck.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::devops::{Client, DevOpsError};
use crate::sessions::{self, Session};
use crate::state::AppState;

pub const EVENT_PRS: &str = "pull-requests";
const LOG_LINES_BEFORE: usize = 60;
const LOG_LINES_KEPT: usize = 200;

pub const CHECKS: &str = "checks";
pub const FAILED: &str = "failed";
pub const READY: &str = "ready";
pub const STUCK: &str = "stuck";
pub const MERGED: &str = "merged";
pub const ABANDONED: &str = "abandoned";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewIssue {
    pub severity: String,
    /// `path:line` when the review gave one.
    pub location: String,
    pub text: String,
}

/// The automated review tool's latest verdict, read from its PR comment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub thread_id: u64,
    pub decision: String,
    pub rejected: bool,
    pub summary: String,
    pub issues: Vec<ReviewIssue>,
    pub published: String,
    /// The thread is still open in DevOps.
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// `passed`, `failed`, `running` or `pending`.
    pub state: String,
    pub result: String,
    /// Failed build task and the trimmed log around its first error.
    pub log_task: Option<String>,
    pub log_lines: Vec<String>,
    pub issues: Vec<ReviewIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: u64,
    pub work_item_id: u64,
    pub project: String,
    pub repo_id: String,
    pub branch: String,
    pub target_branch: String,
    pub title: String,
    pub web_url: String,
    /// DevOps status: `active`, `completed` or `abandoned`.
    pub status: String,
    pub merge_status: String,
    /// Foreman's verdict: `checks`, `failed`, `ready`, `stuck`, `merged` or `abandoned`.
    pub state: String,
    pub fix_attempts: u32,
    pub max_attempts: u32,
    pub checks: Vec<Check>,
    /// One-line reason shown when the PR has failed.
    pub fail_summary: String,
    /// Review thread a fix should resolve once it has been pushed.
    pub review_thread_id: Option<u64>,
    /// Head of the source branch when last polled; a merge is pinned to it.
    pub source_commit: String,
    /// The worktree and local branch have been removed after the merge.
    pub cleaned: bool,
    pub last_polled_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub name: String,
    /// `approved`, `rejected`, `running`, `queued`, `notApplicable` or `broken`.
    pub status: String,
    pub blocking: bool,
    pub build_id: Option<u64>,
}

fn s(v: &Value, pointer: &str) -> String {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn parse_policies(evaluations: &[Value]) -> Vec<Policy> {
    evaluations
        .iter()
        .filter(|e| e.pointer("/configuration/isEnabled").and_then(Value::as_bool).unwrap_or(true))
        .map(|e| {
            let kind = s(e, "/configuration/type/displayName");
            let custom = s(e, "/configuration/settings/displayName");
            Policy {
                name: if custom.is_empty() { kind } else { custom },
                status: s(e, "/status"),
                blocking: e.pointer("/configuration/isBlocking").and_then(Value::as_bool).unwrap_or(true),
                build_id: e.pointer("/context/buildId").and_then(Value::as_u64),
            }
        })
        .collect()
}

/// Parses the review tool's comment: `**Decision: X**`, a summary, then issues listed
/// under bold severity headings as `1. \`path:line\` — text`.
pub fn parse_review_comment(content: &str, marker: &str) -> Option<(String, String, Vec<ReviewIssue>)> {
    let at = content.find(marker)?;
    let after = &content[at + marker.len()..];
    let (decision, rest) = after.split_once("**")?;
    let mut summary: Vec<&str> = vec![];
    let mut issues: Vec<ReviewIssue> = vec![];
    let mut severity: Option<String> = None;
    let mut in_criteria = false;
    for line in rest.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("**").and_then(|h| h.strip_suffix("**")) {
            // Section headings look like "Critical (2)" or "Acceptance criteria (1 of 3 met)".
            in_criteria = heading.to_lowercase().starts_with("acceptance");
            severity = (!in_criteria).then(|| heading.split(" (").next().unwrap_or(heading).to_string());
            continue;
        }
        if in_criteria {
            if let Some(unmet) = trimmed.strip_prefix("- ❌ ") {
                issues.push(ReviewIssue { severity: "Criterion not met".into(), location: String::new(), text: unmet.to_string() });
            }
            continue;
        }
        let Some(sev) = &severity else {
            if !trimmed.is_empty() {
                summary.push(trimmed);
            }
            continue;
        };
        let numbered = trimmed.split_once(". ").filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
        match numbered {
            Some((_, body)) => {
                let (location, text) = match body.strip_prefix('`').and_then(|b| b.split_once('`')) {
                    Some((loc, tail)) => (loc.to_string(), tail.trim_start_matches([' ', '—', '-']).to_string()),
                    None => (String::new(), body.to_string()),
                };
                issues.push(ReviewIssue { severity: sev.clone(), location, text });
            }
            // Continuation lines of a multi-line issue.
            None if !trimmed.is_empty() => {
                if let Some(last) = issues.last_mut() {
                    last.text.push(' ');
                    last.text.push_str(trimmed);
                }
            }
            None => {}
        }
    }
    Some((decision.trim().to_string(), summary.join(" "), issues))
}

/// The most recent review among the PR's threads, identified by the marker text (the
/// tool posts under the user's own identity, so the author can't distinguish it).
pub fn latest_review(threads: &[Value], marker: &str) -> Option<Review> {
    threads
        .iter()
        .filter(|t| !t.get("isDeleted").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|t| {
            let first = t.pointer("/comments/0")?;
            let (decision, summary, issues) = parse_review_comment(first.get("content")?.as_str()?, marker)?;
            Some(Review {
                thread_id: t.get("id")?.as_u64()?,
                rejected: decision.to_lowercase().starts_with("reject"),
                decision,
                summary,
                issues,
                published: s(first, "/publishedDate"),
                active: matches!(t.get("status").and_then(Value::as_str), Some("active" | "pending")),
            })
        })
        .max_by(|a, b| a.published.cmp(&b.published))
}

/// Keeps at most 200 lines around the first error in a build log (FR4.4).
pub fn trim_log(text: &str) -> Vec<String> {
    // Azure Pipelines prefixes each line with a timestamp; drop it for readability.
    let clean = |l: &str| -> String {
        match l.split_once(' ') {
            Some((stamp, rest)) if stamp.len() > 20 && stamp.ends_with('Z') && stamp.contains('T') => rest.to_string(),
            _ => l.to_string(),
        }
    };
    let lines: Vec<String> = text.lines().map(clean).collect();
    let first_error = lines.iter().position(|l| {
        let lower = l.to_lowercase();
        lower.contains("##[error]") || lower.contains("error ") || lower.contains("error:") || lower.contains("failed!")
    });
    let start = match first_error {
        Some(at) => at.saturating_sub(LOG_LINES_BEFORE),
        None => lines.len().saturating_sub(LOG_LINES_KEPT),
    };
    lines.into_iter().skip(start).take(LOG_LINES_KEPT).collect()
}

pub struct Inputs<'a> {
    pub status: &'a str,
    pub merge_status: &'a str,
    pub policies: &'a [Policy],
    pub review: Option<&'a Review>,
    /// The review predates the latest push, so it says nothing about the current code.
    pub review_stale: bool,
    pub require_review: bool,
    pub fix_attempts: u32,
    pub max_attempts: u32,
    pub target_branch: &'a str,
}

pub struct Verdict {
    pub state: &'static str,
    pub checks: Vec<Check>,
    pub fail_summary: String,
}

fn check(name: &str, state: &str, result: impl Into<String>) -> Check {
    Check { name: name.into(), state: state.into(), result: result.into(), ..Default::default() }
}

/// The PR state calculation (FR4.3, FR4.5, FR5.3).
pub fn evaluate(i: &Inputs) -> Verdict {
    let mut checks = vec![];
    let mut failures: Vec<String> = vec![];
    let mut waiting = false;

    for p in i.policies.iter().filter(|p| p.status != "notApplicable") {
        let (state, result) = match p.status.as_str() {
            "approved" => ("passed", "Passed"),
            "rejected" => ("failed", "Failed"),
            "broken" => ("failed", "Couldn't be evaluated"),
            "running" => ("running", "Running"),
            _ => ("pending", "Waiting to start"),
        };
        let required = if p.blocking { "" } else { " · optional" };
        checks.push(check(&p.name, state, format!("{result}{required}")));
        if p.blocking {
            match state {
                "failed" => failures.push(format!("{} failed", p.name)),
                "passed" => {}
                _ => waiting = true,
            }
        }
    }

    match i.merge_status {
        "conflicts" => {
            checks.push(check("Merge conflicts", "failed", format!("Conflicts with {}", i.target_branch)));
            failures.push(format!("conflicts with {}", i.target_branch));
        }
        "succeeded" => checks.push(check("Merge conflicts", "passed", format!("No conflicts with {}", i.target_branch))),
        _ => {
            checks.push(check("Merge conflicts", "running", "Checking"));
            waiting = true;
        }
    }

    match i.review {
        Some(r) if i.review_stale => {
            checks.push(check("Automated review", "pending", "Waiting for a review of the latest push"));
            waiting |= i.require_review;
            let _ = r;
        }
        Some(r) if r.rejected && r.active => {
            let n = r.issues.len();
            let mut c = check("Automated review", "failed", format!("{} · {n} issue{}", r.decision, if n == 1 { "" } else { "s" }));
            c.issues = r.issues.clone();
            checks.push(c);
            failures.push(format!("review found {n} issue{}", if n == 1 { "" } else { "s" }));
        }
        Some(r) if r.rejected => checks.push(check("Automated review", "passed", "Rejected earlier · thread resolved")),
        Some(r) => checks.push(check("Automated review", "passed", r.decision.clone())),
        None => {
            checks.push(check("Automated review", "pending", "Not reviewed yet"));
            waiting |= i.require_review;
        }
    }

    let state = match i.status {
        "completed" => MERGED,
        "abandoned" => ABANDONED,
        _ if !failures.is_empty() && i.fix_attempts >= i.max_attempts => STUCK,
        _ if !failures.is_empty() => FAILED,
        _ if waiting => CHECKS,
        _ => READY,
    };
    let mut fail_summary = failures.join(", ");
    if let Some(first) = fail_summary.get(..1) {
        fail_summary = first.to_uppercase() + &fail_summary[1..];
    }
    Verdict { state, checks, fail_summary }
}

fn web_url(org_url: &str, project: &str, repo: &str, id: u64) -> String {
    let mut url = reqwest::Url::parse(org_url).unwrap_or_else(|_| reqwest::Url::parse("https://dev.azure.com").unwrap());
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.pop_if_empty().extend([project, "_git", repo, "pullrequest", &id.to_string()]);
    }
    url.to_string()
}

/// Fetches everything about one PR and evaluates it.
async fn poll_one(state: &AppState, client: &Client, known: &PullRequest, last_push: Option<&str>) -> Result<PullRequest, DevOpsError> {
    let settings = state.settings();
    let raw = client.pull_request(&known.project, &known.repo_id, known.id).await?;
    let status = s(&raw, "/status");
    let merge_status = s(&raw, "/mergeStatus");
    let target = s(&raw, "/targetRefName").trim_start_matches("refs/heads/").to_string();
    let project_id = s(&raw, "/repository/project/id");

    let (policies, threads) = if status == "active" {
        (
            parse_policies(&client.policy_evaluations(&known.project, &project_id, known.id).await?),
            client.pr_threads(&known.project, &known.repo_id, known.id).await?,
        )
    } else {
        (vec![], vec![])
    };
    let review = latest_review(&threads, &settings.review_marker);
    let review_stale = match (&review, last_push) {
        (Some(r), Some(pushed)) => r.published.as_str() < pushed,
        _ => false,
    };
    let verdict = evaluate(&Inputs {
        status: &status,
        merge_status: &merge_status,
        policies: &policies,
        review: review.as_ref(),
        review_stale,
        require_review: settings.require_review,
        fix_attempts: known.fix_attempts,
        max_attempts: settings.max_fix_attempts,
        target_branch: &target,
    });

    // A closed PR isn't re-checked: keep the checks as they stood when it was last open.
    let mut checks = if status == "active" { verdict.checks } else { known.checks.clone() };
    // Only the failed task's log is downloaded, and only its interesting part is kept.
    for policy in policies.iter().filter(|p| p.status == "rejected") {
        let (Some(build_id), Some(check)) = (policy.build_id, checks.iter_mut().find(|c| c.name == policy.name)) else {
            continue;
        };
        if let Ok(Some((task, text))) = client.failed_task_log(&known.project, build_id).await {
            check.result = format!("Failed · {task}");
            check.log_task = Some(task);
            check.log_lines = trim_log(&text);
        }
    }

    Ok(PullRequest {
        title: s(&raw, "/title"),
        web_url: web_url(&settings.org_url, &known.project, &s(&raw, "/repository/name"), known.id),
        target_branch: target,
        status,
        merge_status,
        state: verdict.state.to_string(),
        max_attempts: settings.max_fix_attempts,
        checks,
        fail_summary: verdict.fail_summary,
        review_thread_id: review.filter(|r| r.rejected && r.active && !review_stale).map(|r| r.thread_id),
        source_commit: s(&raw, "/lastMergeSourceCommit/commitId"),
        last_polled_at: chrono::Utc::now().to_rfc3339(),
        ..known.clone()
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSnapshot {
    pub prs: Vec<PullRequest>,
    /// Work items whose session finished without a PR being found (FR4.1).
    pub missing: Vec<u64>,
}

pub fn snapshot(state: &AppState) -> PrSnapshot {
    PrSnapshot { prs: state.db.pull_requests(), missing: state.no_pr.lock().unwrap().iter().copied().collect() }
}

fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT_PRS, snapshot(&app.state::<AppState>()));
}

/// Latest session per work item.
fn latest_sessions(state: &AppState) -> Vec<Session> {
    let mut latest: std::collections::BTreeMap<u64, Session> = std::collections::BTreeMap::new();
    for session in state.db.sessions() {
        latest.insert(session.work_item_id, session);
    }
    latest.into_values().collect()
}

fn notify_transition(app: &AppHandle, before: &str, pr: &PullRequest) {
    if before == pr.state {
        return;
    }
    let notify = app.state::<AppState>().settings().notify;
    let id = pr.work_item_id;
    match pr.state.as_str() {
        FAILED => sessions::notify(app, notify.failed, &format!("{id} PR failed"), &pr.fail_summary),
        READY => sessions::notify(app, notify.ready, &format!("{id} ready to merge"), &pr.title),
        STUCK => sessions::notify(app, notify.stuck, &format!("{id} is stuck"), &pr.fail_summary),
        _ => {}
    }
}

/// FR6.2: once the PR is merged, remove the session's worktree and local branch.
fn clean_up(app: &AppHandle, pr: &mut PullRequest, session: Option<&Session>) {
    let state = app.state::<AppState>();
    let Some(session) = session.filter(|s| !s.is_active() && s.branch == pr.branch) else {
        return;
    };
    pr.cleaned = true;
    if state.fixture {
        return;
    }
    let outcome = crate::git::remove_worktree(&session.repo_path, std::path::Path::new(&session.worktree_path), &session.branch);
    let (kind, text) = match outcome {
        Ok(()) => ("info", format!("PR !{} merged: removed the worktree and local branch {}", pr.id, pr.branch)),
        Err(err) => ("error", err),
    };
    sessions::log_info(app, &session.id, kind, text);
}

/// Complete merge (FR6.1, FR6.3): only ever called from the user's click, only for a PR
/// Foreman currently rates Ready, and pinned to the commit that was checked.
pub async fn complete(app: &AppHandle, work_item_id: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let pr = state
        .db
        .pull_requests()
        .into_iter()
        .rev()
        .find(|p| p.work_item_id == work_item_id && p.status == "active")
        .ok_or("This work item has no open pull request")?;
    if pr.state != READY {
        return Err("This pull request isn't ready to merge".into());
    }
    if pr.source_commit.is_empty() {
        return Err("Foreman hasn't seen this pull request's latest commit yet; try again after the next check".into());
    }
    let client = state.client(&settings).map_err(|e| e.message)?;
    client
        .complete_pull_request(
            &pr.project,
            &pr.repo_id,
            pr.id,
            &pr.source_commit,
            &settings.merge_strategy,
            settings.delete_source_branch,
            settings.complete_work_items,
        )
        .await
        .map_err(|e| format!("Azure DevOps didn't accept the merge: {}", e.message))?;
    // DevOps finishes the merge in the background; the next poll picks up the result.
    state.pr_refresh.notify_one();
    Ok(())
}

async fn poll_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let Ok(client) = state.client(&settings) else {
        return;
    };
    let latest = latest_sessions(&state);
    let tracked = state.db.pull_requests();

    // 1. Sessions that finished: find the PR raised from their branch (FR4.1).
    for session in latest.iter().filter(|s| s.state == sessions::DONE && s.mode != "review") {
        if tracked.iter().any(|p| p.work_item_id == session.work_item_id && p.branch == session.branch) || session.project.is_empty() {
            continue;
        }
        match client.prs_for_branch(&session.project, &session.branch).await {
            Ok(found) => match found.iter().max_by_key(|p| p.get("pullRequestId").and_then(Value::as_u64)) {
                Some(raw) => {
                    state.no_pr.lock().unwrap().remove(&session.work_item_id);
                    let pr = PullRequest {
                        id: raw.get("pullRequestId").and_then(Value::as_u64).unwrap_or_default(),
                        work_item_id: session.work_item_id,
                        project: session.project.clone(),
                        repo_id: s(raw, "/repository/id"),
                        branch: session.branch.clone(),
                        status: "active".into(),
                        state: CHECKS.into(),
                        max_attempts: settings.max_fix_attempts,
                        ..Default::default()
                    };
                    let _ = state.db.save_pull_request(&pr);
                }
                None => {
                    state.no_pr.lock().unwrap().insert(session.work_item_id);
                }
            },
            Err(_) => continue,
        }
    }

    // 2. Open PRs: refresh and re-evaluate. Completed and abandoned ones are left alone (FR4.6).
    for known in state.db.pull_requests().into_iter().filter(|p| p.status == "active") {
        let session = latest.iter().find(|s| s.work_item_id == known.work_item_id);
        let last_push = session.and_then(|s| s.ended_at.as_deref());
        let Ok(fresh) = poll_one(&state, &client, &known, last_push).await else {
            continue;
        };
        // A fix may have bumped the counter while we were fetching.
        let attempts = state.db.pull_request(known.id).map(|p| p.fix_attempts).unwrap_or(fresh.fix_attempts);
        let fresh = PullRequest { fix_attempts: attempts, ..fresh };
        let mut fresh = fresh;
        if fresh.state == MERGED {
            clean_up(app, &mut fresh, session);
        }
        let _ = state.db.save_pull_request(&fresh);
        let busy = session.is_some_and(Session::is_active);
        if !busy {
            notify_transition(app, &known.state, &fresh);
            if fresh.state == FAILED && known.state != FAILED && settings.auto_fix {
                let _ = sessions::start_fix(app, fresh.work_item_id);
            }
        }
    }
    emit(app);
}

pub async fn run(app: AppHandle) {
    loop {
        poll_all(&app).await;
        let state = app.state::<AppState>();
        let wait = Duration::from_secs(state.settings().pr_poll_interval_secs);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = state.pr_refresh.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MARKER: &str = "**Decision:";

    fn policy(name: &str, status: &str, blocking: bool) -> Policy {
        Policy { name: name.into(), status: status.into(), blocking, build_id: None }
    }

    fn review(rejected: bool, active: bool) -> Review {
        Review {
            thread_id: 7,
            decision: if rejected { "Reject".into() } else { "Approve".into() },
            rejected,
            summary: String::new(),
            issues: if rejected { vec![ReviewIssue { severity: "Major".into(), location: "a.cs:1".into(), text: "x".into() }] } else { vec![] },
            published: "2026-10-09T10:00:00Z".into(),
            active,
        }
    }

    fn inputs<'a>(policies: &'a [Policy], review: Option<&'a Review>) -> Inputs<'a> {
        Inputs { status: "active", merge_status: "succeeded", policies, review, review_stale: false, require_review: true, fix_attempts: 0, max_attempts: 3, target_branch: "dev" }
    }

    #[test]
    fn ready_when_everything_passes() {
        let p = [policy("Build", "approved", true), policy("Docs", "queued", false)];
        let r = review(false, false);
        let v = evaluate(&inputs(&p, Some(&r)));
        assert_eq!(v.state, READY);
        assert!(v.fail_summary.is_empty());
    }

    #[test]
    fn failed_on_rejected_policy_conflict_or_active_reject() {
        let ok = review(false, false);
        let rejected = [policy("Build", "rejected", true)];
        assert_eq!(evaluate(&inputs(&rejected, Some(&ok))).state, FAILED);

        let passing = [policy("Build", "approved", true)];
        let conflicted = Inputs { merge_status: "conflicts", ..inputs(&passing, Some(&ok)) };
        let v = evaluate(&conflicted);
        assert_eq!(v.state, FAILED);
        assert_eq!(v.fail_summary, "Conflicts with dev");

        let bad = review(true, true);
        let v = evaluate(&inputs(&passing, Some(&bad)));
        assert_eq!(v.state, FAILED);
        assert_eq!(v.checks.last().unwrap().issues.len(), 1);
    }

    #[test]
    fn optional_policy_failure_does_not_fail_the_pr() {
        let p = [policy("Build", "approved", true), policy("Lint", "rejected", false)];
        let r = review(false, false);
        assert_eq!(evaluate(&inputs(&p, Some(&r))).state, READY);
    }

    #[test]
    fn waiting_while_checks_run_or_review_is_missing_or_stale() {
        let running = [policy("Build", "running", true)];
        let r = review(false, false);
        assert_eq!(evaluate(&inputs(&running, Some(&r))).state, CHECKS);

        let passing = [policy("Build", "approved", true)];
        assert_eq!(evaluate(&inputs(&passing, None)).state, CHECKS);
        assert_eq!(evaluate(&Inputs { require_review: false, ..inputs(&passing, None) }).state, READY);

        // A reject that predates the latest push no longer counts against the PR.
        let old = review(true, true);
        assert_eq!(evaluate(&Inputs { review_stale: true, ..inputs(&passing, Some(&old)) }).state, CHECKS);
    }

    #[test]
    fn resolved_reject_thread_no_longer_fails() {
        let passing = [policy("Build", "approved", true)];
        let resolved = review(true, false);
        assert_eq!(evaluate(&inputs(&passing, Some(&resolved))).state, READY);
    }

    #[test]
    fn stuck_once_fix_attempts_are_used_up() {
        let rejected = [policy("Build", "rejected", true)];
        let r = review(false, false);
        assert_eq!(evaluate(&Inputs { fix_attempts: 2, ..inputs(&rejected, Some(&r)) }).state, FAILED);
        assert_eq!(evaluate(&Inputs { fix_attempts: 3, ..inputs(&rejected, Some(&r)) }).state, STUCK);
        // Attempts only matter while something is failing.
        let passing = [policy("Build", "approved", true)];
        assert_eq!(evaluate(&Inputs { fix_attempts: 3, ..inputs(&passing, Some(&r)) }).state, READY);
    }

    #[test]
    fn completed_and_abandoned_are_final() {
        let rejected = [policy("Build", "rejected", true)];
        assert_eq!(evaluate(&Inputs { status: "completed", ..inputs(&rejected, None) }).state, MERGED);
        assert_eq!(evaluate(&Inputs { status: "abandoned", ..inputs(&rejected, None) }).state, ABANDONED);
    }

    #[test]
    fn parses_the_review_comment() {
        let content = "🤖 AI-assisted review: @<abc> **Decision: Reject**\n\nMissing validation.\n\n**Acceptance criteria (1 of 2 met)**\n\n- ✅ #12 Shows dose\n- ❌ #13 Rejects negatives — not handled\n\n**Critical (1)**\n\n1. `src/Dose.cs:42` — **Null deref** Crashes when dose is null\n   on the second line\n\n**Minor (1)**\n\n1. Rename the helper";
        let (decision, summary, issues) = parse_review_comment(content, MARKER).unwrap();
        assert_eq!(decision, "Reject");
        assert_eq!(summary, "Missing validation.");
        assert_eq!(issues.len(), 3);
        assert_eq!(issues[0].severity, "Criterion not met");
        assert_eq!(issues[1], ReviewIssue { severity: "Critical".into(), location: "src/Dose.cs:42".into(), text: "**Null deref** Crashes when dose is null on the second line".into() });
        assert_eq!(issues[2], ReviewIssue { severity: "Minor".into(), location: String::new(), text: "Rename the helper".into() });
        assert!(parse_review_comment("LGTM", MARKER).is_none());
    }

    #[test]
    fn latest_review_wins_and_other_threads_are_ignored() {
        let thread = |id: u64, status: &str, content: &str, date: &str| {
            json!({ "id": id, "status": status, "comments": [{ "content": content, "publishedDate": date }] })
        };
        let threads = [
            thread(1, "active", "**Decision: Reject**\n\nBad", "2026-10-09T09:00:00Z"),
            thread(2, "active", "Can you rename this?", "2026-10-09T11:00:00Z"),
            thread(3, "closed", "**Decision: Approve (with suggestions)**\n\nFine", "2026-10-09T10:00:00Z"),
        ];
        let r = latest_review(&threads, MARKER).unwrap();
        assert_eq!(r.thread_id, 3);
        assert!(!r.rejected && !r.active);
        assert!(latest_review(&threads[1..2], MARKER).is_none());
    }

    #[test]
    fn log_is_trimmed_around_the_first_error() {
        let mut text = String::new();
        for i in 0..500 {
            text.push_str(&format!("2026-10-09T10:00:00.0000000Z line {i}\n"));
        }
        text.push_str("2026-10-09T10:00:01.0000000Z ##[error]Tests failed\n");
        for i in 0..500 {
            text.push_str(&format!("after {i}\n"));
        }
        let lines = trim_log(&text);
        assert_eq!(lines.len(), 200);
        assert_eq!(lines[0], "line 440");
        assert_eq!(lines[60], "##[error]Tests failed");

        let quiet: String = (0..300).map(|i| format!("l{i}\n")).collect();
        let tail = trim_log(&quiet);
        assert_eq!((tail.len(), tail[0].as_str()), (200, "l100"));
    }

    #[test]
    fn policies_are_read_from_evaluations() {
        let evals = [
            json!({ "status": "rejected", "configuration": { "isBlocking": true, "isEnabled": true, "type": { "displayName": "Build" }, "settings": { "displayName": "CI build" } }, "context": { "buildId": 99 } }),
            json!({ "status": "approved", "configuration": { "isBlocking": false, "isEnabled": true, "type": { "displayName": "Comment requirements" }, "settings": {} } }),
            json!({ "status": "queued", "configuration": { "isEnabled": false, "type": { "displayName": "Off" } } }),
        ];
        let p = parse_policies(&evals);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0], Policy { name: "CI build".into(), status: "rejected".into(), blocking: true, build_id: Some(99) });
        assert_eq!(p[1].name, "Comment requirements");
    }
}
