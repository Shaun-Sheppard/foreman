use std::sync::atomic::AtomicU64;
use std::sync::RwLock;

use serde::Serialize;
use tokio::sync::Notify;

use crate::db::Db;
use crate::devops::model::{Person, WorkItem};
use crate::devops::{Client, DevOpsError, ErrorKind};
use crate::secrets::Secrets;
use crate::sessions::LiveMap;
use crate::settings::{Filters, Settings};

pub const KEY_SETTINGS: &str = "settings";
pub const KEY_FILTERS: &str = "filters";
pub const KEY_ME: &str = "me";
pub const KEY_LAST_GOOD_SYNC: &str = "last_good_sync";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Unconfigured,
    Idle,
    Syncing,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub status: SyncStatus,
    /// RFC 3339 time of the last successful sync.
    pub last_good_sync: Option<String>,
    pub error: Option<DevOpsError>,
    /// Names of the iterations the list currently shows (resolved from `@current`).
    pub sprint_names: Vec<String>,
}

/// The core owns all state; the webview only mirrors it.
pub struct AppState {
    pub db: Db,
    pub secrets: Secrets,
    pub fixture: bool,
    pub data_dir: std::path::PathBuf,
    /// Sessions whose sidecar is running; everything durable about them is in SQLite.
    pub live: LiveMap,
    /// Work items whose finished session raised no PR (FR4.1).
    pub no_pr: std::sync::Mutex<std::collections::BTreeSet<u64>>,
    /// Wakes the PR poller, e.g. when a session finishes.
    pub pr_refresh: Notify,
    pub items: RwLock<Vec<WorkItem>>,
    pub sync: RwLock<SyncState>,
    /// Wakes the poller for a manual refresh or a filter/settings change.
    pub refresh: Notify,
    /// Bumped whenever filters or settings change, so a sync that started earlier is discarded.
    pub generation: AtomicU64,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.db.get::<Settings>(KEY_SETTINGS).unwrap_or_default().normalised()
    }

    pub fn filters(&self) -> Filters {
        self.db.get(KEY_FILTERS).unwrap_or_else(|| Filters::defaults(&self.settings()))
    }

    pub fn me(&self) -> Option<Person> {
        self.db.get::<Option<Person>>(KEY_ME).flatten()
    }

    pub fn has_pat(&self) -> bool {
        matches!(self.secrets.pat(), Ok(Some(_)))
    }

    pub fn client(&self, settings: &Settings) -> Result<Client, DevOpsError> {
        let pat = self
            .secrets
            .pat()
            .map_err(|m| DevOpsError::new(ErrorKind::Unauthorized, m))?
            .ok_or_else(|| DevOpsError::new(ErrorKind::Unauthorized, "No personal access token saved"))?;
        Client::new(&settings.org_url, &pat, self.fixture)
    }

    pub fn sync_snapshot(&self) -> SyncState {
        self.sync.read().unwrap().clone()
    }
}
