//! Session supervision: queueing, worktrees, one agent-host sidecar per session,
//! and the JSON Lines protocol between the core and each sidecar (FR2, FR3).

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Notify};

use crate::git;
use crate::state::AppState;

pub const PROTOCOL_VERSION: u64 = 1;
pub const EVENT_SESSIONS: &str = "sessions";
pub const EVENT_LOG: &str = "session-log";

pub const QUEUED: &str = "queued";
pub const RUNNING: &str = "running";
pub const NEEDS_INPUT: &str = "needs_input";
pub const DONE: &str = "done";
pub const FAILED: &str = "failed";
pub const CANCELLED: &str = "cancelled";
pub const INTERRUPTED: &str = "interrupted";

const PORT_BLOCK_START: u32 = 42000;
const PORT_BLOCK_SIZE: u32 = 10;
const STOP_GRACE: Duration = Duration::from_secs(5);
const LOG_TAIL: usize = 1000;
const LOG_RETENTION_DAYS: u64 = 30;
const RESUME_PROMPT: &str = "Foreman was closed while you were working. Continue this task from where you left off.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub work_item_id: u64,
    pub mode: String,
    pub sdk_session_id: Option<String>,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub state: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub outcome: Option<String>,
    pub cost_usd: Option<f64>,
    pub base_branch: String,
    pub model: String,
    #[serde(skip_serializing, default)]
    pub prompt: String,
    pub error: Option<String>,
    pub created_at: String,
    pub port_base: u32,
    /// DevOps project of the work item, used to find its PR.
    pub project: String,
    /// SDK session to resume from: set on fix sessions so they keep the original context (FR5.1).
    #[serde(skip_serializing, default)]
    pub resume_from: Option<String>,
}

impl Session {
    pub fn is_active(&self) -> bool {
        matches!(self.state.as_str(), QUEUED | RUNNING | NEEDS_INPUT)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Step {
    pub text: String,
    /// `pending`, `in_progress` or `completed`.
    pub state: String,
}

/// A permission request or question the session is blocked on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInput {
    pub request_id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub questions: Value,
    #[serde(default)]
    pub since: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    session: Session,
    steps: Vec<Step>,
    pending: Option<PendingInput>,
    /// 1-based place in the queue, for queued sessions.
    queue_position: Option<usize>,
}

/// In-memory handle on a session whose sidecar is (about to be) running.
pub struct Live {
    tx: mpsc::UnboundedSender<String>,
    kill: Arc<Notify>,
    pending: Option<PendingInput>,
    stopping: bool,
}

pub type LiveMap = Mutex<HashMap<String, Live>>;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn wire(mut msg: Value) -> String {
    msg["v"] = json!(PROTOCOL_VERSION);
    msg.to_string()
}

pub fn views(state: &AppState) -> Vec<SessionView> {
    let sessions = state.db.sessions();
    let live = state.live.lock().unwrap();
    let mut queued = 0;
    sessions
        .into_iter()
        .map(|session| {
            let queue_position = (session.state == QUEUED).then(|| {
                queued += 1;
                queued
            });
            SessionView {
                steps: state.db.steps(&session.id),
                pending: live.get(&session.id).and_then(|l| l.pending.clone()),
                queue_position,
                session,
            }
        })
        .collect()
}

fn emit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let views = views(&state);
    // FR8.2: the Needs attention count rides on the dock/taskbar icon.
    let prs = state.db.pull_requests();
    let waiting_prs = prs.iter().filter(|p| matches!(p.state.as_str(), crate::pr::FAILED | crate::pr::READY | crate::pr::STUCK)).count();
    let attention = views.iter().filter(|v| matches!(v.session.state.as_str(), NEEDS_INPUT | FAILED | INTERRUPTED)).count() + waiting_prs;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count((attention > 0).then_some(attention as i64));
    }
    let _ = app.emit(EVENT_SESSIONS, views);
}

pub fn notify(app: &AppHandle, enabled: bool, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    // Fixture mode stays silent so test runs don't raise real notifications.
    if enabled && !app.state::<AppState>().fixture {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn item_title(state: &AppState, work_item_id: u64) -> String {
    state
        .items
        .read()
        .unwrap()
        .iter()
        .find(|i| i.id == work_item_id)
        .map(|i| i.title.clone())
        .unwrap_or_default()
}

// ---- Session log: JSON Lines files, not SQLite ------------------------------------------

fn log_path(state: &AppState, session_id: &str) -> PathBuf {
    state.data_dir.join("logs").join(format!("{session_id}.jsonl"))
}

fn append_log(app: &AppHandle, session_id: &str, mut entry: Value) {
    let state = app.state::<AppState>();
    entry["ts"] = json!(now());
    let path = log_path(&state, session_id);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{entry}");
    }
    let _ = app.emit(EVENT_LOG, json!({ "sessionId": session_id, "entry": entry }));
}

pub fn log_info(app: &AppHandle, session_id: &str, kind: &str, text: impl Into<String>) {
    append_log(app, session_id, json!({ "kind": kind, "text": text.into() }));
}

pub fn read_log(state: &AppState, session_id: &str) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(log_path(state, session_id)) else {
        return vec![];
    };
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(LOG_TAIL);
    lines[from..].iter().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn prune_logs(state: &AppState) {
    let dir = state.data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let max_age = Duration::from_secs(LOG_RETENTION_DAYS * 86_400);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---- Launching ---------------------------------------------------------------------------

/// GUI apps don't inherit the shell's PATH, so ask the login shell once for it;
/// otherwise `node`, `git`, `az` and friends may not be found.
fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let inherited = std::env::var("PATH").unwrap_or_default();
        if cfg!(windows) {
            return inherited;
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = std::process::Command::new(shell)
            .args(["-lic", "printf '\\n%s' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().last().map(str::to_string))
            .filter(|p| p.contains('/'));
        match from_shell {
            Some(p) if inherited.is_empty() => p,
            Some(p) => format!("{p}:{inherited}"),
            None => inherited,
        }
    })
}

/// How to start the agent host: the bundled single executable in a packaged app,
/// otherwise the compiled script run with Node (development).
enum AgentHost {
    Bundled(PathBuf),
    Script(PathBuf),
}

fn agent_host() -> Result<AgentHost, String> {
    if let Ok(path) = std::env::var("FOREMAN_AGENT_HOST") {
        return Ok(AgentHost::Script(PathBuf::from(path)));
    }
    let name = if cfg!(windows) { "foreman-agent-host.exe" } else { "foreman-agent-host" };
    let bundled = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(name))).filter(|p| p.is_file());
    if let Some(path) = bundled {
        return Ok(AgentHost::Bundled(path));
    }
    let script = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../agent-host/dist/host.js"));
    if script.is_file() {
        Ok(AgentHost::Script(script))
    } else {
        Err(format!("The agent host isn't built ({}). Run: npm run build:host", script.display()))
    }
}

/// The installed Claude Code executable, which the bundled agent host drives.
fn find_claude(configured: &str) -> Result<PathBuf, String> {
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        return if path.is_file() { Ok(path) } else { Err(format!("Claude Code wasn't found at {configured} (Settings → Sessions)")) };
    }
    let names: &[&str] = if cfg!(windows) { &["claude.exe"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = std::env::split_paths(login_path()).collect();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
        .ok_or_else(|| "Claude Code isn't installed, or isn't on your PATH. Install it and sign in, or set its path in Settings → Sessions.".to_string())
}

/// A unique block of 10 ports per session so parallel dev servers don't collide (FR2.7).
fn free_port_base(state: &AppState, session_id: &str) -> u32 {
    let taken: Vec<u32> = state
        .db
        .sessions()
        .iter()
        .filter(|s| s.id != session_id && matches!(s.state.as_str(), RUNNING | NEEDS_INPUT))
        .map(|s| s.port_base)
        .collect();
    (0..)
        .map(|slot| PORT_BLOCK_START + slot * PORT_BLOCK_SIZE)
        .find(|base| !taken.contains(base))
        .unwrap_or(PORT_BLOCK_START)
}

/// Starts queued sessions while there are free slots (FR2.6).
pub fn pump(app: &AppHandle) {
    let state = app.state::<AppState>();
    let limit = state.settings().concurrency_limit as usize;
    loop {
        let (session, rx, kill) = {
            let mut live = state.live.lock().unwrap();
            if live.len() >= limit {
                break;
            }
            let Some(next) = state.db.sessions().into_iter().find(|s| s.state == QUEUED && !live.contains_key(&s.id)) else {
                break;
            };
            let (tx, rx) = mpsc::unbounded_channel();
            let kill = Arc::new(Notify::new());
            live.insert(next.id.clone(), Live { tx, kill: kill.clone(), pending: None, stopping: false });
            (next, rx, kill)
        };
        tauri::async_runtime::spawn(launch(app.clone(), session, rx, kill));
    }
}

async fn launch(app: AppHandle, mut session: Session, mut rx: mpsc::UnboundedReceiver<String>, kill: Arc<Notify>) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    // Either picking an interrupted session back up, or a fix continuing from an earlier session.
    let resuming = session.started_at.is_some() && session.sdk_session_id.is_some();
    let resume_id = if resuming { session.sdk_session_id.clone() } else { session.resume_from.clone() };

    session.state = RUNNING.into();
    session.started_at.get_or_insert_with(now);
    session.ended_at = None;
    session.outcome = None;
    session.error = None;
    session.port_base = free_port_base(&state, &session.id);
    let _ = state.db.save_session(&session);
    emit(&app);
    log_info(&app, &session.id, "info", if resuming { "Resuming session" } else { "Starting session" });

    // Fixture mode never touches a real repository.
    let cwd = if state.fixture {
        std::env::temp_dir()
    } else {
        let (repo, worktree, branch, base) =
            (session.repo_path.clone(), PathBuf::from(&session.worktree_path), session.branch.clone(), session.base_branch.clone());
        let made = tauri::async_runtime::spawn_blocking(move || git::ensure_worktree(&repo, &worktree, &branch, &base))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        if let Err(err) = made {
            return finish(&app, &session.id, FAILED, "error", None, Some(err));
        }
        PathBuf::from(&session.worktree_path)
    };

    let mut std_command = match agent_host() {
        Ok(AgentHost::Bundled(exe)) => {
            let mut c = std::process::Command::new(exe);
            // The stubbed runtime never starts Claude Code, so it doesn't need to be installed.
            if !state.fixture {
                match find_claude(&settings.claude_path) {
                    Ok(path) => c.env("FOREMAN_CLAUDE_PATH", path),
                    Err(err) => return finish(&app, &session.id, FAILED, "error", None, Some(err)),
                };
            }
            c
        }
        Ok(AgentHost::Script(script)) => {
            let mut c = std::process::Command::new(std::env::var("FOREMAN_NODE").unwrap_or_else(|_| "node".into()));
            c.arg(script);
            if !settings.claude_path.is_empty() {
                c.env("FOREMAN_CLAUDE_PATH", &settings.claude_path);
            }
            c
        }
        Err(err) => return finish(&app, &session.id, FAILED, "error", None, Some(err)),
    };
    git::hide_window(&mut std_command);
    let mut command = tokio::process::Command::from(std_command);
    command
        .current_dir(&cwd)
        .env("PATH", login_path())
        .env("FOREMAN_WORK_ITEM_ID", session.work_item_id.to_string())
        .env("FOREMAN_PORT_BASE", session.port_base.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if state.fixture {
        command.arg("--stub");
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(err) => {
            let msg = format!("Couldn't start the agent host: {err}");
            return finish(&app, &session.id, FAILED, "error", None, Some(msg));
        }
    };

    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let start = wire(json!({
        "type": "start",
        "cwd": cwd,
        "prompt": if resuming { RESUME_PROMPT } else { session.prompt.as_str() },
        "model": if session.model.is_empty() { Value::Null } else { json!(session.model) },
        "resume": json!(resume_id),
        "allowAllTools": settings.allow_all_tools,
        "allowedTools": settings.allowed_tools,
    }));
    tauri::async_runtime::spawn(async move {
        let mut next = Some(start);
        while let Some(line) = next {
            if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
            next = rx.recv().await;
        }
    });

    // Keep the tail of stderr so a crash can say why.
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let tail = stderr_tail.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut tail = tail.lock().unwrap();
            tail.push(line);
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut ended = false;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                        ended |= handle_message(&app, &session.id, msg);
                    }
                }
                _ => break,
            },
            _ = kill.notified() => {
                let _ = child.kill().await;
                break;
            }
        }
    }
    let _ = child.wait().await;

    if !ended {
        let stopping = state.live.lock().unwrap().get(&session.id).is_some_and(|l| l.stopping);
        if stopping {
            finish(&app, &session.id, CANCELLED, "cancelled", None, None);
        } else {
            // A crashed sidecar only takes its own session down (NFR2).
            let detail = stderr_tail.lock().unwrap().join("\n");
            let msg = if detail.is_empty() { "The agent host stopped unexpectedly".to_string() } else { format!("The agent host stopped unexpectedly:\n{detail}") };
            finish(&app, &session.id, INTERRUPTED, "error", None, Some(msg));
        }
    }
}

/// Handles one sidecar message. Returns true once the session has ended.
fn handle_message(app: &AppHandle, session_id: &str, msg: Value) -> bool {
    let state = app.state::<AppState>();
    if msg["v"].as_u64() != Some(PROTOCOL_VERSION) {
        return false;
    }
    match msg["type"].as_str().unwrap_or_default() {
        "session_id" => {
            if let (Some(mut s), Some(id)) = (state.db.session(session_id), msg["sessionId"].as_str()) {
                s.sdk_session_id = Some(id.to_string());
                let _ = state.db.save_session(&s);
            }
        }
        "steps" => {
            if let Ok(steps) = serde_json::from_value::<Vec<Step>>(msg["items"].clone()) {
                let _ = state.db.replace_steps(session_id, &steps, &now());
                emit(app);
            }
        }
        "log" => append_log(app, session_id, msg["entry"].clone()),
        "needs_input" => {
            let Ok(mut pending) = serde_json::from_value::<PendingInput>(msg.clone()) else {
                return false;
            };
            pending.since = now();
            let summary = if pending.text.is_empty() { pending.detail.clone() } else { pending.text.clone() };
            if let Some(live) = state.live.lock().unwrap().get_mut(session_id) {
                live.pending = Some(pending.clone());
            }
            if let Some(mut s) = state.db.session(session_id) {
                s.state = NEEDS_INPUT.into();
                let _ = state.db.save_session(&s);
                append_log(app, session_id, json!({ "kind": "info", "text": format!("Waiting for you: {}", pending.title) }));
                notify(app, state.settings().notify.needs_input, &format!("{} needs input", s.work_item_id), &summary);
            }
            emit(app);
        }
        "ended" => {
            let outcome = msg["outcome"].as_str().unwrap_or("error");
            if outcome == "error" && retry_without_resume(app, session_id) {
                return true;
            }
            let next = match outcome {
                "success" => DONE,
                "cancelled" => CANCELLED,
                _ => FAILED,
            };
            finish(app, session_id, next, outcome, msg["costUsd"].as_f64(), msg["error"].as_str().map(str::to_string));
            return true;
        }
        _ => {}
    }
    false
}

/// FR5.1: if a fix couldn't resume the earlier session, run it fresh in the same worktree.
/// Its prompt already carries the failure details and the original brief.
fn retry_without_resume(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<AppState>();
    let Some(mut s) = state.db.session(session_id) else {
        return false;
    };
    let quick = s
        .started_at
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .is_some_and(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() < 60);
    if s.resume_from.is_none() || !quick {
        return false;
    }
    s.resume_from = None;
    s.sdk_session_id = None;
    s.started_at = None;
    s.state = QUEUED.into();
    let _ = state.db.save_session(&s);
    state.live.lock().unwrap().remove(session_id);
    log_info(app, session_id, "info", "Couldn't resume the earlier session; starting fresh in the same worktree");
    emit(app);
    pump(app);
    true
}

/// After a fix is pushed, reply to and resolve the review thread it addressed (FR5.2).
fn resolve_review_thread(app: &AppHandle, session: &Session) {
    let state = app.state::<AppState>();
    let Some(pr) = state.db.pull_requests().into_iter().rev().find(|p| p.work_item_id == session.work_item_id) else {
        return;
    };
    let (Some(thread_id), Ok(client)) = (pr.review_thread_id, state.client(&state.settings())) else {
        return;
    };
    let (app, session_id) = (app.clone(), session.id.clone());
    let reply = format!("Addressed by Foreman fix attempt {} of {}, pushed to `{}`.", pr.fix_attempts, pr.max_attempts, pr.branch);
    tauri::async_runtime::spawn(async move {
        match client.resolve_thread(&pr.project, &pr.repo_id, pr.id, thread_id, &reply).await {
            Ok(()) => log_info(&app, &session_id, "info", "Replied to and resolved the review thread"),
            Err(err) => log_info(&app, &session_id, "error", format!("Couldn't resolve the review thread: {err}")),
        }
        app.state::<AppState>().pr_refresh.notify_one();
    });
}

/// Records how a session ended (FR3.6), frees its slot and starts the next queued one.
fn finish(app: &AppHandle, session_id: &str, next_state: &str, outcome: &str, cost: Option<f64>, error: Option<String>) {
    let state = app.state::<AppState>();
    state.live.lock().unwrap().remove(session_id);
    if let Some(mut s) = state.db.session(session_id) {
        s.state = next_state.into();
        s.outcome = Some(outcome.into());
        s.ended_at = Some(now());
        s.cost_usd = cost.or(s.cost_usd);
        s.error = error.clone();
        let _ = state.db.save_session(&s);
        let line = match (next_state, &error) {
            (DONE, _) => "Session finished".to_string(),
            (CANCELLED, _) => "Session stopped".to_string(),
            (_, Some(e)) => e.clone(),
            _ => "Session failed".to_string(),
        };
        log_info(app, session_id, if next_state == DONE || next_state == CANCELLED { "info" } else { "error" }, line);
        if matches!(next_state, FAILED | INTERRUPTED) {
            let title = item_title(&state, s.work_item_id);
            notify(app, state.settings().notify.failed, &format!("{} session failed", s.work_item_id), &title);
        }
        if next_state == DONE && s.mode == "fix" {
            resolve_review_thread(app, &s);
        }
    }
    emit(app);
    // A finished session may have raised or updated a PR.
    state.pr_refresh.notify_one();
    pump(app);
}

// ---- Actions from the UI -----------------------------------------------------------------

pub struct StartRequest {
    pub work_item_id: u64,
    pub mode: String,
    pub repo_path: String,
    pub base_branch: String,
    pub model: String,
    pub prompt: String,
    pub title: String,
    pub project: String,
}

pub fn start(app: &AppHandle, req: StartRequest) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if state.db.sessions().iter().any(|s| s.work_item_id == req.work_item_id && s.is_active()) {
        return Err("This work item already has a session running or queued".into());
    }
    if req.base_branch.trim().is_empty() {
        return Err("Choose the branch to start from".into());
    }
    let created_at = now();
    let session = Session {
        id: format!("{}-{:x}", req.work_item_id, chrono::Utc::now().timestamp_millis()),
        work_item_id: req.work_item_id,
        mode: if req.mode == "review" { "review".into() } else { "implement".into() },
        sdk_session_id: None,
        worktree_path: git::worktree_path(&req.repo_path, &settings.worktree_root, req.work_item_id).to_string_lossy().into_owned(),
        branch: git::branch_name(req.work_item_id, &req.title),
        repo_path: req.repo_path,
        state: QUEUED.into(),
        started_at: None,
        ended_at: None,
        outcome: None,
        cost_usd: None,
        base_branch: req.base_branch.trim().to_string(),
        model: req.model,
        prompt: req.prompt,
        error: None,
        created_at,
        port_base: 0,
        project: req.project,
        resume_from: None,
    };
    state.db.save_session(&session)?;
    state.no_pr.lock().unwrap().remove(&session.work_item_id);
    emit(app);
    pump(app);
    Ok(())
}

/// Fix it (FR5): a new session in the same worktree and branch that resumes the previous
/// one with the failure details. Counts against the PR's attempt limit (FR5.3).
pub fn start_fix(app: &AppHandle, work_item_id: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let all = state.db.sessions();
    let mine: Vec<&Session> = all.iter().filter(|s| s.work_item_id == work_item_id).collect();
    let last = *mine.last().ok_or("This work item has no session to fix")?;
    if last.is_active() {
        return Err("This work item already has a session running or queued".into());
    }
    let mut pr = state.db.pull_requests().into_iter().rev().find(|p| p.work_item_id == work_item_id && p.branch == last.branch);
    if let Some(pr) = pr.as_mut() {
        let max = state.settings().max_fix_attempts;
        if pr.fix_attempts >= max {
            return Err(format!("All {max} fix attempts have been used"));
        }
        pr.fix_attempts += 1;
        pr.max_attempts = max;
        state.db.save_pull_request(pr)?;
    }
    let original = mine.iter().find(|s| s.mode != "fix").map(|s| s.prompt.as_str()).unwrap_or_default();
    let session = Session {
        id: format!("{}-{:x}", work_item_id, chrono::Utc::now().timestamp_millis()),
        mode: "fix".into(),
        sdk_session_id: None,
        state: QUEUED.into(),
        started_at: None,
        ended_at: None,
        outcome: None,
        cost_usd: None,
        prompt: crate::prompt::fix(pr.as_ref(), work_item_id, &last.branch, &last.base_branch, original),
        error: None,
        created_at: now(),
        port_base: 0,
        resume_from: last.sdk_session_id.clone(),
        ..last.clone()
    };
    state.db.save_session(&session)?;
    state.no_pr.lock().unwrap().remove(&work_item_id);
    emit(app);
    let _ = app.emit(crate::pr::EVENT_PRS, crate::pr::snapshot(&state));
    pump(app);
    Ok(())
}

/// Stop cancels the session and keeps its worktree (FR3.5). A queued session just leaves the queue.
pub fn stop(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let kill = {
        let mut live = state.live.lock().unwrap();
        live.get_mut(session_id).map(|l| {
            l.stopping = true;
            l.pending = None;
            let _ = l.tx.send(wire(json!({ "type": "stop" })));
            l.kill.clone()
        })
    };
    match kill {
        Some(kill) => {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(STOP_GRACE).await;
                kill.notify_one();
            });
        }
        None => {
            let s = state.db.session(session_id).ok_or("That session no longer exists")?;
            if s.state == QUEUED {
                finish(app, session_id, CANCELLED, "cancelled", None, None);
            }
        }
    }
    Ok(())
}

/// Relays the user's approve / deny / reply to the waiting session (FR3.3, FR3.4).
pub fn answer(app: &AppHandle, session_id: &str, request_id: &str, action: &str, message: &str, answers: Value) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut live = state.live.lock().unwrap();
        let l = live.get_mut(session_id).ok_or("That session is no longer running")?;
        if l.pending.as_ref().map(|p| p.request_id.as_str()) != Some(request_id) {
            return Err("That request has already been answered".into());
        }
        let msg = match action {
            "approve" => json!({ "type": "approve", "requestId": request_id }),
            "reply" => json!({ "type": "reply", "requestId": request_id, "answers": answers }),
            _ => json!({ "type": "deny", "requestId": request_id, "message": message }),
        };
        l.tx.send(wire(msg)).map_err(|_| "The session has stopped")?;
        l.pending = None;
    }
    if let Some(mut s) = state.db.session(session_id) {
        s.state = RUNNING.into();
        state.db.save_session(&s)?;
    }
    let said = match action {
        "approve" => "You approved".to_string(),
        "reply" => format!("You answered: {}", answers.as_object().map(|o| o.values().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
        _ if message.is_empty() => "You denied".to_string(),
        _ => format!("You denied: {message}"),
    };
    log_info(app, session_id, "info", said);
    emit(app);
    Ok(())
}

/// Puts an interrupted, failed or stopped session back in the queue; it resumes by SDK session ID.
pub fn resume(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut s = state.db.session(session_id).ok_or("That session no longer exists")?;
    if s.is_active() {
        return Err("That session is already running".into());
    }
    if state.db.sessions().iter().any(|o| o.work_item_id == s.work_item_id && o.is_active()) {
        return Err("This work item already has a session running or queued".into());
    }
    s.state = QUEUED.into();
    s.created_at = now();
    state.db.save_session(&s)?;
    emit(app);
    pump(app);
    Ok(())
}

/// On startup nothing is actually running, whatever the database says: mark those
/// sessions Interrupted so they can be resumed, then start anything still queued.
pub fn recover(app: &AppHandle) {
    let state = app.state::<AppState>();
    prune_logs(&state);
    for mut s in state.db.sessions() {
        if matches!(s.state.as_str(), RUNNING | NEEDS_INPUT) {
            s.state = INTERRUPTED.into();
            s.outcome = Some("error".into());
            s.ended_at = Some(now());
            s.error = Some("Foreman was closed while this session was running".into());
            let _ = state.db.save_session(&s);
        }
    }
    emit(app);
    pump(app);
}
