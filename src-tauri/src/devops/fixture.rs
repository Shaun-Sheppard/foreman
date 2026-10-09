//! Canned Azure DevOps responses for integration-test mode (NFR4).
//! Enabled with `FOREMAN_FIXTURES=1`; no network or keychain access happens in this mode.

use reqwest::Url;
use serde_json::{json, Value};

use super::{DevOpsError, ErrorKind, Result};

const CONNECTION: &str = include_str!("../../fixtures/connection.json");
const ITERATIONS: &str = include_str!("../../fixtures/iterations.json");
const WORK_ITEMS: &str = include_str!("../../fixtures/workitems.json");
const COMMENTS: &str = include_str!("../../fixtures/comments.json");

pub const ORG_URL: &str = "https://dev.azure.com/fixture-org";
pub const PROJECT: &str = "Clinical Platform";
const ME: &str = "shaun@fixture.example";

fn load(src: &str) -> Value {
    serde_json::from_str(src).expect("fixture JSON is valid")
}

fn field<'a>(item: &'a Value, name: &str) -> &'a str {
    item.pointer(&format!("/fields/{name}")).and_then(Value::as_str).unwrap_or_default()
}

fn assignee(item: &Value) -> &str {
    item.pointer("/fields/System.AssignedTo/uniqueName").and_then(Value::as_str).unwrap_or_default()
}

/// A rough WIQL evaluator: enough for the filters to visibly change the list.
fn matches(item: &Value, query: &str) -> bool {
    let quoted = |v: &str| query.contains(&format!("'{}'", v.replace('\'', "''")));
    let clause = |f: &str| query.contains(&format!("[{f}]"));
    (!clause("System.IterationPath") || quoted(field(item, "System.IterationPath")))
        && (!clause("System.WorkItemType") || quoted(field(item, "System.WorkItemType")))
        && (!clause("System.State") || quoted(field(item, "System.State")))
        && if query.contains("[System.AssignedTo] = @Me") {
            assignee(item) == ME
        } else {
            !clause("System.AssignedTo") || quoted(assignee(item))
        }
}

/// PRs completed from the app in this run.
static MERGED: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());

/// Set once the fix for PR 1287 has resolved its review thread; from then on it passes.
static FIXED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const REJECT_COMMENT: &str = "🤖 AI-assisted review: **Decision: Reject**\n\nThe checksum is validated on submit but not on blur, and one edge case crashes.\n\n**Acceptance criteria (3 of 4 met)**\n\n- ✅ #4512 Spaces and hyphens are stripped before validation.\n- ❌ #4512 Numbers failing the Modulus 11 check show an inline error on blur. — only checked on submit\n\n**Critical (1)**\n\n1. `src/Intake/NhsNumber.cs:41` — **Index out of range** A nine-digit input throws instead of failing validation.\n\n**Minor (1)**\n\n1. `src/Intake/IntakeForm.razor:118` — The error text is hard-coded; use the resource file.";

const BUILD_LOG: &str = "2026-10-09T13:40:01.1000000Z Starting: Run tests\n2026-10-09T13:40:02.1000000Z dotnet test --no-build\n2026-10-09T13:40:09.1000000Z   Passed NhsNumberTests.Accepts_published_test_numbers [12 ms]\n2026-10-09T13:40:09.2000000Z   Failed NhsNumberTests.Rejects_nine_digit_input [4 ms]\n2026-10-09T13:40:09.3000000Z   Error Message:\n2026-10-09T13:40:09.4000000Z    System.IndexOutOfRangeException : Index was outside the bounds of the array.\n2026-10-09T13:40:09.5000000Z   Stack Trace:\n2026-10-09T13:40:09.6000000Z      at Clinical.Intake.NhsNumber.IsValid(String value) in src/Intake/NhsNumber.cs:line 41\n2026-10-09T13:40:10.1000000Z Failed!  - Failed: 1, Passed: 411, Skipped: 0, Total: 412\n2026-10-09T13:40:10.2000000Z ##[error]Dotnet command failed with non-zero exit code on the following projects : Clinical.Tests.csproj\n2026-10-09T13:40:10.3000000Z Finishing: Run tests";

/// Canned PR scenarios keyed by work item: 4512 fails until fixed, 4498 is ready,
/// 4471 has checks running, and nothing else raised a PR.
fn fixture_pr(pr_id: u64) -> Option<Value> {
    let (work_item, title) = match pr_id {
        1287 => (4512, "Add NHS number validation to patient intake form"),
        1290 => (4498, "Fix duplicate appointment reminders across clock changes"),
        1291 => (4471, "Export clinic schedules as an iCal feed"),
        _ => return None,
    };
    let status = if MERGED.lock().unwrap().contains(&pr_id) { "completed" } else { "active" };
    Some(json!({
        "pullRequestId": pr_id, "title": title, "status": status, "mergeStatus": "succeeded",
        "lastMergeSourceCommit": { "commitId": "0123456789abcdef0123456789abcdef01234567" },
        "targetRefName": "refs/heads/dev", "workItem": work_item,
        "repository": { "id": "repo-1", "name": "clinical-platform", "project": { "id": "proj-1", "name": PROJECT } }
    }))
}

fn pr_id_in(path: &str) -> u64 {
    path.split('/').skip_while(|seg| !seg.eq_ignore_ascii_case("pullrequests")).nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn fixture_pr_api(url: &Url, body: Option<&Value>) -> Option<Value> {
    use std::sync::atomic::Ordering;
    let path = url.path();
    let fixed = FIXED.load(Ordering::SeqCst);
    let now = chrono::Utc::now().to_rfc3339();
    if path.contains("/threads/") {
        // A reply (POST …/comments) or the status change that follows it.
        if !path.ends_with("/comments") && body.is_some_and(|b| b["status"] == "fixed") {
            FIXED.store(true, Ordering::SeqCst);
        }
        return Some(json!({}));
    }
    if path.ends_with("/threads") {
        let thread = |id: u64, status: &str, content: &str| json!({ "id": id, "status": status, "comments": [{ "content": content, "publishedDate": now, "author": { "displayName": "Shaun Sheppard" } }] });
        let approve = "🤖 AI-assisted review: **Decision: Approve**\n\nMeets every acceptance criterion; no issues found.";
        return Some(json!({ "value": match (pr_id_in(path), fixed) {
            (1287, false) => vec![thread(1, "active", REJECT_COMMENT)],
            (1287, true) => vec![thread(1, "fixed", REJECT_COMMENT), thread(2, "closed", approve)],
            (1290, _) => vec![thread(1, "closed", approve)],
            _ => vec![],
        }}));
    }
    if path.ends_with("/policy/evaluations") {
        let pr: u64 = url.query_pairs().find(|(k, _)| k == "artifactId").and_then(|(_, v)| v.rsplit('/').next().and_then(|n| n.parse().ok())).unwrap_or(0);
        let policy = |name: &str, status: &str, build: Option<u64>| json!({ "status": status, "configuration": { "isBlocking": true, "isEnabled": true, "type": { "displayName": "Build" }, "settings": { "displayName": name } }, "context": { "buildId": build } });
        let build = match (pr, fixed) {
            (1287, false) => "rejected",
            (1291, _) => "running",
            _ => "approved",
        };
        return Some(json!({ "value": [policy("Build validation", build, Some(9001)), policy("Linked work items", "approved", None)] }));
    }
    if path.ends_with("/timeline") {
        return Some(json!({ "records": [
            { "type": "Task", "name": "Restore", "result": "succeeded", "log": { "id": 3 } },
            { "type": "Task", "name": "Run tests", "result": "failed", "log": { "id": 7 } }
        ]}));
    }
    if path.contains("/build/builds/") && path.contains("/logs/") {
        return Some(json!(BUILD_LOG));
    }
    if path.ends_with("/git/pullrequests") {
        let source = url.query_pairs().find(|(k, _)| k == "searchCriteria.sourceRefName").map(|(_, v)| v.into_owned()).unwrap_or_default();
        let found = [1287, 1290, 1291].into_iter().filter_map(fixture_pr).find(|pr| source.starts_with(&format!("refs/heads/foreman/{}-", pr["workItem"])));
        return Some(json!({ "value": found.into_iter().collect::<Vec<_>>() }));
    }
    if path.to_ascii_lowercase().contains("/pullrequests/") {
        if body.is_some_and(|b| b["status"] == "completed") {
            MERGED.lock().unwrap().push(pr_id_in(path));
        }
        return fixture_pr(pr_id_in(path));
    }
    None
}

pub fn respond(url: &Url, body: Option<&Value>) -> Result<Value> {
    let path = url.path();
    if std::env::var("FOREMAN_FIXTURES").as_deref() == Ok("offline") {
        return Err(DevOpsError::new(ErrorKind::Unauthorized, "Personal access token was rejected (wrong, expired or revoked)"));
    }
    if path.ends_with("/connectionData") {
        return Ok(load(CONNECTION));
    }
    if path.ends_with("/teamsettings/iterations") {
        let mut v = load(ITERATIONS);
        if url.query_pairs().any(|(k, v)| k == "$timeframe" && v == "current") {
            let list = v["value"].as_array().cloned().unwrap_or_default();
            v["value"] = list.into_iter().filter(|i| i["attributes"]["timeFrame"] == "current").collect();
        }
        return Ok(v);
    }
    if let Some(v) = fixture_pr_api(url, body) {
        return Ok(v);
    }
    let all = load(WORK_ITEMS);
    let all = all["value"].as_array().cloned().unwrap_or_default();
    if path.ends_with("/wit/wiql") {
        let query = body.and_then(|b| b["query"].as_str()).unwrap_or_default();
        let ids: Vec<Value> = all.iter().filter(|i| matches(i, query)).map(|i| json!({ "id": i["id"] })).collect();
        return Ok(json!({ "workItems": ids }));
    }
    if path.ends_with("/wit/workitemsbatch") {
        let ids = body.and_then(|b| b["ids"].as_array()).cloned().unwrap_or_default();
        let value: Vec<Value> = all.into_iter().filter(|i| ids.contains(&i["id"])).collect();
        return Ok(json!({ "count": value.len(), "value": value }));
    }
    if path.ends_with("/comments") {
        return Ok(load(COMMENTS));
    }
    Err(DevOpsError::new(ErrorKind::NotFound, format!("No fixture for {path}")))
}
