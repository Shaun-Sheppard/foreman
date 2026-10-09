//! Polls Azure DevOps for work items (FR1.4) and pushes state to the webview.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::devops::model::WorkItem;
use crate::devops::{wiql, Client, DevOpsError, ErrorKind};
use crate::settings::{Filters, Settings, SPRINT_CURRENT};
use crate::state::{AppState, SyncStatus, KEY_LAST_GOOD_SYNC, KEY_ME};

pub const EVENT_SYNC: &str = "sync-state";
pub const EVENT_ITEMS: &str = "work-items";

const BACKOFF_BASE_SECS: u64 = 5;
const BACKOFF_MAX_SECS: u64 = 900;

/// Exponential back-off for 429/5xx/network errors, never shorter than `Retry-After` (NFR2).
pub fn backoff(failures: u32, retry_after: Option<u64>) -> Duration {
    let exp = BACKOFF_BASE_SECS.saturating_mul(1u64 << failures.saturating_sub(1).min(16));
    Duration::from_secs(exp.min(BACKOFF_MAX_SECS).max(retry_after.unwrap_or(0)))
}

pub struct ResolvedSprint {
    pub paths: Vec<String>,
    pub names: Vec<String>,
}

pub async fn resolve_sprint(client: &Client, settings: &Settings, sprint: &str) -> Result<ResolvedSprint, DevOpsError> {
    if sprint != SPRINT_CURRENT {
        let name = sprint.rsplit('\\').next().unwrap_or(sprint).to_string();
        return Ok(ResolvedSprint { paths: vec![sprint.to_string()], names: vec![name] });
    }
    let mut out = ResolvedSprint { paths: vec![], names: vec![] };
    for project in &settings.projects {
        for s in client.sprints(project, true).await? {
            if !out.names.contains(&s.name) {
                out.names.push(s.name);
            }
            out.paths.push(s.path);
        }
    }
    Ok(out)
}

pub async fn query_ids(
    client: &Client,
    settings: &Settings,
    sprint: &ResolvedSprint,
    person: &str,
) -> Result<Vec<u64>, DevOpsError> {
    // No iteration to look in (e.g. no current sprint) means no items, not every item.
    if sprint.paths.is_empty() {
        return Ok(vec![]);
    }
    let query = wiql::build(&wiql::Query {
        projects: &settings.projects,
        iteration_paths: &sprint.paths,
        person,
        types: &settings.work_item_types,
        states: &settings.todo_states,
        area_paths: &settings.area_paths,
    });
    client.query_ids(&query).await
}

async fn fetch(
    state: &AppState,
    settings: &Settings,
    filters: &Filters,
) -> Result<(Vec<WorkItem>, Vec<String>), DevOpsError> {
    let client = state.client(settings)?;
    if state.me().is_none() {
        let me = client.me().await?;
        let _ = state.db.set(KEY_ME, &Some(me));
    }
    let sprint = resolve_sprint(&client, settings, &filters.sprint).await?;
    let ids = query_ids(&client, settings, &sprint, &filters.person).await?;
    let items = client.work_items(&ids).await?;
    Ok((items, sprint.names))
}

fn emit_sync(app: &AppHandle, state: &AppState) {
    let _ = app.emit(EVENT_SYNC, state.sync_snapshot());
}

async fn sync_once(app: &AppHandle) -> Result<(), DevOpsError> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.is_configured() || !state.has_pat() {
        state.sync.write().unwrap().status = SyncStatus::Unconfigured;
        emit_sync(app, &state);
        return Ok(());
    }
    let filters = state.filters();
    let generation = state.generation.load(Ordering::SeqCst);
    state.sync.write().unwrap().status = SyncStatus::Syncing;
    emit_sync(app, &state);

    let result = fetch(&state, &settings, &filters).await;
    if state.generation.load(Ordering::SeqCst) != generation {
        // Filters or settings changed while we were fetching; the next loop will redo it.
        return Ok(());
    }
    match result {
        Ok((items, sprint_names)) => {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = state.db.replace_cache(&items, &now);
            let _ = state.db.set(KEY_LAST_GOOD_SYNC, &now);
            *state.items.write().unwrap() = items.clone();
            {
                let mut sync = state.sync.write().unwrap();
                sync.status = SyncStatus::Idle;
                sync.last_good_sync = Some(now);
                sync.error = None;
                sync.sprint_names = sprint_names;
            }
            let _ = app.emit(EVENT_ITEMS, items);
            emit_sync(app, &state);
            Ok(())
        }
        Err(err) => {
            // Keep showing the last good data; the UI raises a non-blocking banner.
            {
                let mut sync = state.sync.write().unwrap();
                // A rejected token (expired, revoked or wrong) needs the user: tell them once,
                // when it first happens, even if the window isn't in front.
                let already_known = sync.error.as_ref().is_some_and(|e| e.kind == ErrorKind::Unauthorized);
                if err.kind == ErrorKind::Unauthorized && !already_known {
                    crate::sessions::notify(
                        app,
                        true,
                        "Azure DevOps token rejected",
                        "Foreman can't sync. The personal access token may have expired; update it in Settings.",
                    );
                }
                sync.status = SyncStatus::Error;
                sync.error = Some(err.clone());
            }
            emit_sync(app, &state);
            Err(err)
        }
    }
}

pub async fn run(app: AppHandle) {
    let mut failures = 0u32;
    loop {
        let before = app.state::<AppState>().generation.load(Ordering::SeqCst);
        let delay = match sync_once(&app).await {
            Err(err) if err.is_transient() => {
                failures += 1;
                backoff(failures, err.retry_after)
            }
            _ => {
                failures = 0;
                Duration::from_secs(app.state::<AppState>().settings().poll_interval_secs)
            }
        };
        let state = app.state::<AppState>();
        if state.generation.load(Ordering::SeqCst) != before {
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = state.refresh.notified() => { failures = 0; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff(1, None).as_secs(), 5);
        assert_eq!(backoff(2, None).as_secs(), 10);
        assert_eq!(backoff(4, None).as_secs(), 40);
        assert_eq!(backoff(30, None).as_secs(), 900);
    }

    #[test]
    fn backoff_respects_retry_after() {
        assert_eq!(backoff(1, Some(120)).as_secs(), 120);
        assert_eq!(backoff(6, Some(30)).as_secs(), 160);
    }
}
