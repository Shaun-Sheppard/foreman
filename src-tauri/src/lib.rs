mod db;
mod devops;
mod git;
mod poller;
mod pr;
mod prompt;
mod secrets;
mod sessions;
mod settings;
mod state;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Window};
use tokio::sync::Notify;

use devops::model::{Comment, LinkedItem, Person, Sprint, WorkItem};
use devops::{Client, DevOpsError, ErrorKind};
use secrets::Secrets;
use settings::{Filters, Settings, PERSON_EVERYONE};
use state::{AppState, SyncState, SyncStatus, KEY_FILTERS, KEY_LAST_GOOD_SYNC, KEY_ME, KEY_SETTINGS};

type CmdResult<T> = Result<T, DevOpsError>;

fn invalid(message: impl Into<String>) -> DevOpsError {
    DevOpsError::new(ErrorKind::Invalid, message)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    settings: Settings,
    filters: Filters,
    /// Whether a token is saved. The token itself never leaves the core.
    has_pat: bool,
    me: Option<Person>,
    items: Vec<WorkItem>,
    sync: SyncState,
    sessions: Vec<sessions::SessionView>,
    pull_requests: pr::PrSnapshot,
    fixture: bool,
}

fn changed(state: &AppState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.refresh.notify_one();
}

#[tauri::command]
fn get_state(state: State<AppState>) -> Snapshot {
    Snapshot {
        settings: state.settings(),
        filters: state.filters(),
        has_pat: state.has_pat(),
        me: state.me(),
        items: state.items.read().unwrap().clone(),
        sync: state.sync_snapshot(),
        sessions: sessions::views(&state),
        pull_requests: pr::snapshot(&state),
        fixture: state.fixture,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> CmdResult<Settings> {
    let settings = settings.normalised();
    if !settings.org_url.is_empty() {
        Client::new(&settings.org_url, "", state.fixture)?;
    }
    if state.settings().org_url != settings.org_url {
        state.db.set(KEY_ME, &None::<Person>).map_err(invalid)?;
    }
    state.db.set(KEY_SETTINGS, &settings).map_err(invalid)?;
    changed(&state);
    // A raised concurrency limit may free a slot for a queued session.
    sessions::pump(&app);
    Ok(settings)
}

#[tauri::command]
fn set_pat(state: State<AppState>, pat: String) -> CmdResult<()> {
    let pat = pat.trim();
    if pat.is_empty() {
        return Err(invalid("Paste a personal access token first"));
    }
    state.secrets.set_pat(pat).map_err(invalid)?;
    state.db.set(KEY_ME, &None::<Person>).map_err(invalid)?;
    changed(&state);
    Ok(())
}

/// Checks the token and that every project is reachable. `pat` is only supplied
/// when the user has typed a new one; otherwise the saved token is used.
#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    org_url: String,
    projects: Vec<String>,
    pat: Option<String>,
) -> CmdResult<Person> {
    let probe = Settings { org_url, projects, ..Default::default() }.normalised();
    if probe.org_url.is_empty() {
        return Err(invalid("Enter your organisation URL"));
    }
    if probe.projects.is_empty() {
        return Err(invalid("Add at least one project"));
    }
    let client = match pat.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(pat) => Client::new(&probe.org_url, pat, state.fixture)?,
        None => state.client(&probe)?,
    };
    let me = client.me().await?;
    for project in &probe.projects {
        client.sprints(project, true).await?;
    }
    Ok(me)
}

#[tauri::command]
fn set_filters(state: State<AppState>, filters: Filters) -> CmdResult<Filters> {
    state.db.set(KEY_FILTERS, &filters).map_err(invalid)?;
    changed(&state);
    Ok(filters)
}

#[tauri::command]
fn refresh(state: State<AppState>) {
    state.refresh.notify_one();
}

#[tauri::command]
async fn list_sprints(state: State<'_, AppState>) -> CmdResult<Vec<Sprint>> {
    let settings = state.settings();
    let client = state.client(&settings)?;
    let mut all = vec![];
    for project in &settings.projects {
        all.extend(client.sprints(project, false).await?);
    }
    Ok(all)
}

/// Everyone with an item in the sprint currently shown, for the person filter.
#[tauri::command]
async fn list_people(state: State<'_, AppState>) -> CmdResult<Vec<Person>> {
    let settings = state.settings();
    let client = state.client(&settings)?;
    let sprint = poller::resolve_sprint(&client, &settings, &state.filters().sprint).await?;
    let ids = poller::query_ids(&client, &settings, &sprint, PERSON_EVERYONE).await?;
    client.assignees(&ids).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    id: u64,
    comments: Vec<Comment>,
    linked: Vec<LinkedItem>,
}

/// Linked items and latest comments, fetched when an item is opened (FR1.2).
#[tauri::command]
async fn get_work_item_detail(state: State<'_, AppState>, id: u64) -> CmdResult<Detail> {
    let item = state
        .items
        .read()
        .unwrap()
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .ok_or_else(|| invalid("That work item is no longer in the list"))?;
    let client = state.client(&state.settings())?;
    let comments = client.comments(&item.project, id, 5).await?;
    let linked = client.linked_items(&item.links).await?;
    Ok(Detail { id, comments, linked })
}

fn open_external(url: &str) -> CmdResult<()> {
    let parsed = reqwest::Url::parse(url).map_err(|_| invalid("Not a valid link"))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(invalid("Only web links can be opened"));
    }
    open::that_detached(parsed.as_str()).map_err(|e| invalid(format!("Couldn't open the browser: {e}")))
}

#[tauri::command]
fn open_work_item(state: State<AppState>, id: u64) -> CmdResult<()> {
    let org = state.settings().org_url;
    open_external(&format!("{org}/_workitems/edit/{id}"))
}

/// Opens a link from work item text in the default browser, never in the webview.
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    open_external(&url)
}

fn listed_item(state: &AppState, id: u64) -> CmdResult<WorkItem> {
    state
        .items
        .read()
        .unwrap()
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .ok_or_else(|| invalid("That work item is no longer in the list"))
}

/// Template for the mode plus the work item's content. Linked items and comments are best-effort.
async fn build_prompt(state: &AppState, item: &WorkItem, mode: &str, repo_path: &str, base_branch: &str) -> String {
    let settings = state.settings();
    let (comments, linked) = match state.client(&settings) {
        Ok(client) => (
            client.comments(&item.project, item.id, 5).await.unwrap_or_default(),
            client.linked_items(&item.links).await.unwrap_or_default(),
        ),
        Err(_) => (vec![], vec![]),
    };
    let template = if mode == "review" { &settings.review_template } else { &settings.implement_template };
    let branch = git::branch_name(item.id, &item.title);
    prompt::build(
        template,
        &prompt::Context { item, linked: &linked, comments: &comments, branch: &branch, base_branch, repo_path },
    )
}

/// The prompt a session would start with, for the editable preview (FR2.2).
#[tauri::command]
async fn preview_prompt(state: State<'_, AppState>, work_item_id: u64, mode: String, repo_path: String, base_branch: String) -> CmdResult<String> {
    let item = listed_item(&state, work_item_id)?;
    Ok(build_prompt(&state, &item, &mode, &repo_path, &base_branch).await)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs {
    work_item_id: u64,
    mode: String,
    repo_path: String,
    base_branch: String,
    model: String,
    /// Only supplied when the user edited the preview.
    prompt: Option<String>,
    /// Anything the user wants to add to the brief for this item.
    note: Option<String>,
}

/// Queues a session on a work item, in the chosen repository, base branch and model (FR2).
#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, AppState>, request: StartArgs) -> CmdResult<()> {
    let StartArgs { work_item_id, mode, repo_path, base_branch, model, prompt, note } = request;
    let item = listed_item(&state, work_item_id)?;
    if !state.fixture && !state.settings().repositories.iter().any(|r| r.repo_path == repo_path) {
        return Err(invalid("Map this project to a local repository in Settings first"));
    }
    let prompt = match prompt.filter(|p| !p.trim().is_empty()) {
        Some(edited) => edited,
        None => build_prompt(&state, &item, &mode, &repo_path, &base_branch).await,
    };
    let prompt = match note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(note) => format!("{prompt}\n\nA note from me before you start:\n{note}"),
        None => prompt,
    };
    let req = sessions::StartRequest { work_item_id, mode, repo_path, base_branch, model, prompt, title: item.title, project: item.project };
    sessions::start(&app, req).map_err(invalid)
}

/// Fix it: resume the item's session with the PR's failure details (FR5).
#[tauri::command]
fn fix_pr(app: AppHandle, work_item_id: u64) -> CmdResult<()> {
    sessions::start_fix(&app, work_item_id).map_err(invalid)
}

/// Complete merge. This command is the only path to a merge, and only the user's click calls it (FR6.3).
#[tauri::command]
async fn complete_merge(app: AppHandle, work_item_id: u64) -> CmdResult<()> {
    pr::complete(&app, work_item_id).await.map_err(invalid)
}

#[tauri::command]
fn refresh_prs(state: State<AppState>) {
    state.pr_refresh.notify_one();
}

/// The user's next message in an item's conversation.
#[tauri::command]
fn send_message(app: AppHandle, session_id: String, text: String, images: Vec<sessions::ImageUpload>) -> CmdResult<()> {
    sessions::send_message(&app, &session_id, &text, images).map_err(invalid)
}

#[tauri::command]
async fn open_in_desktop(app: AppHandle, session_id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || sessions::open_in_desktop(&app, &session_id))
        .await
        .map_err(|e| invalid(e.to_string()))?
        .map_err(invalid)
}

#[tauri::command]
fn stop_session(app: AppHandle, session_id: String) -> CmdResult<()> {
    sessions::stop(&app, &session_id).map_err(invalid)
}

#[tauri::command]
fn resume_session(app: AppHandle, session_id: String) -> CmdResult<()> {
    sessions::resume(&app, &session_id).map_err(invalid)
}

/// `action` is `approve`, `deny` or `reply`.
#[tauri::command]
fn answer_session(
    app: AppHandle,
    session_id: String,
    request_id: String,
    action: String,
    message: Option<String>,
    answers: Option<serde_json::Value>,
) -> CmdResult<()> {
    let answers = answers.unwrap_or(serde_json::Value::Null);
    sessions::answer(&app, &session_id, &request_id, &action, message.as_deref().unwrap_or(""), answers).map_err(invalid)
}

/// Opens the session's worktree folder in the file manager.
#[tauri::command]
fn open_worktree(state: State<AppState>, session_id: String) -> CmdResult<()> {
    let session = state.db.session(&session_id).ok_or_else(|| invalid("That session no longer exists"))?;
    if !std::path::Path::new(&session.worktree_path).is_dir() {
        return Err(invalid("The worktree folder hasn't been created yet"));
    }
    open::that_detached(&session.worktree_path).map_err(|e| invalid(format!("Couldn't open the folder: {e}")))
}

#[tauri::command]
fn get_session_log(state: State<AppState>, session_id: String) -> Vec<serde_json::Value> {
    sessions::read_log(&state, &session_id)
}

/// Validates a local repository path and lists its branches (FR7.3).
#[tauri::command]
async fn inspect_repo(path: String) -> CmdResult<git::RepoInfo> {
    tauri::async_runtime::spawn_blocking(move || git::inspect(path.trim()))
        .await
        .map_err(|e| invalid(e.to_string()))?
        .map_err(invalid)
}

/// Native folder chooser, run by the core so the webview needs no filesystem access.
#[tauri::command]
async fn pick_folder() -> Option<String> {
    let folder = rfd::AsyncFileDialog::new().set_title("Choose the local repository folder").pick_folder().await?;
    Some(folder.path().to_string_lossy().into_owned())
}

// The title bar is drawn by the UI, so window controls are our own commands
// rather than window-plugin permissions granted to the webview.

#[tauri::command]
fn window_minimize(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_toggle_maximize(window: Window) {
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = if maximized { window.unmaximize() } else { window.maximize() };
}

#[tauri::command]
fn window_close(window: Window) {
    let _ = window.close();
}

#[tauri::command]
fn window_start_drag(window: Window) {
    let _ = window.start_dragging();
}

fn build_state(app: &AppHandle) -> Result<AppState, String> {
    let mode = std::env::var("FOREMAN_FIXTURES").ok().filter(|v| !v.is_empty() && v != "0");
    let fixture = mode.is_some();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join(if fixture { "fixture.db" } else { "foreman.db" });
    if mode.as_deref() == Some("fresh") {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", db_path.display()));
        }
    }
    let db = db::Db::open(&db_path)?;
    let secrets = if fixture { Secrets::Memory(Mutex::new(None)) } else { Secrets::Keychain };

    if fixture && mode.as_deref() != Some("fresh") {
        secrets.set_pat("fixture-token")?;
        if !db.get::<Settings>(KEY_SETTINGS).is_some_and(|s| s.is_configured()) {
            let seeded = Settings {
                org_url: devops::fixture::ORG_URL.into(),
                projects: vec![devops::fixture::PROJECT.into()],
                ..Default::default()
            };
            db.set(KEY_SETTINGS, &seeded)?;
        }
    }

    let items = db.load_cache();
    let sync = SyncState {
        status: SyncStatus::Unconfigured,
        last_good_sync: db.get(KEY_LAST_GOOD_SYNC),
        error: None,
        sprint_names: vec![],
    };
    Ok(AppState {
        db,
        secrets,
        fixture,
        data_dir: dir,
        live: Mutex::new(std::collections::HashMap::new()),
        no_pr: Mutex::new(std::collections::BTreeSet::new()),
        pr_refresh: Notify::new(),
        items: RwLock::new(items),
        sync: RwLock::new(sync),
        refresh: Notify::new(),
        generation: AtomicU64::new(0),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let state = build_state(app.handle())?;
            app.manage(state);
            sessions::recover(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(poller::run(handle));
            tauri::async_runtime::spawn(pr::run(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            save_settings,
            set_pat,
            test_connection,
            set_filters,
            refresh,
            list_sprints,
            list_people,
            get_work_item_detail,
            open_work_item,
            open_url,
            inspect_repo,
            preview_prompt,
            start_session,
            stop_session,
            send_message,
            open_in_desktop,
            fix_pr,
            complete_merge,
            refresh_prs,
            resume_session,
            answer_session,
            get_session_log,
            open_worktree,
            pick_folder,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Foreman");
}
