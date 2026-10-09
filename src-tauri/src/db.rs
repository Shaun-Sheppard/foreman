use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use crate::devops::model::WorkItem;
use crate::pr::PullRequest;
use crate::sessions::{Session, Step};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS work_item_cache (
    id INTEGER PRIMARY KEY,
    rev INTEGER NOT NULL,
    json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    work_item_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    sdk_session_id TEXT,
    repo_path TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    outcome TEXT,
    cost_usd REAL
);
CREATE TABLE IF NOT EXISTS session_step (
    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, position)
);
CREATE TABLE IF NOT EXISTS pull_request (
    id INTEGER PRIMARY KEY,
    work_item_id INTEGER NOT NULL,
    repo_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL,
    merge_status TEXT,
    checks_json TEXT,
    fix_attempts INTEGER NOT NULL DEFAULT 0,
    last_polled_at TEXT
);
CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
";

pub struct Db(Mutex<Connection>);

type DbResult<T> = Result<T, String>;

fn e(err: impl std::fmt::Display) -> String {
    format!("Local storage error: {err}")
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        let conn = Connection::open(path).map_err(e)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> DbResult<Self> {
        Self::init(Connection::open_in_memory().map_err(e)?)
    }

    fn init(conn: Connection) -> DbResult<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;").map_err(e)?;
        conn.execute_batch(SCHEMA).map_err(e)?;
        // Columns added after the first release; ignore "duplicate column" on later launches.
        for column in ["base_branch TEXT NOT NULL DEFAULT ''", "model TEXT NOT NULL DEFAULT ''", "prompt TEXT NOT NULL DEFAULT ''", "error TEXT", "created_at TEXT NOT NULL DEFAULT ''", "port_base INTEGER NOT NULL DEFAULT 0", "project TEXT NOT NULL DEFAULT ''", "resume_from TEXT"] {
            let _ = conn.execute(&format!("ALTER TABLE session ADD COLUMN {column}"), []);
        }
        Ok(Self(Mutex::new(conn)))
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let conn = self.0.lock().unwrap();
        let json: Option<String> = conn
            .query_row("SELECT value_json FROM setting WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        json.and_then(|j| serde_json::from_str(&j).ok())
    }

    pub fn set<T: Serialize>(&self, key: &str, value: &T) -> DbResult<()> {
        let json = serde_json::to_string(value).map_err(e)?;
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO setting (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                params![key, json],
            )
            .map_err(e)?;
        Ok(())
    }

    /// Overwrite the cache with the latest sync (the cache is a copy, never the source of truth).
    pub fn replace_cache(&self, items: &[WorkItem], fetched_at: &str) -> DbResult<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(e)?;
        tx.execute("DELETE FROM work_item_cache", []).map_err(e)?;
        for item in items {
            let json = serde_json::to_string(item).map_err(e)?;
            tx.execute(
                "INSERT INTO work_item_cache (id, rev, json, fetched_at) VALUES (?1, ?2, ?3, ?4)",
                params![item.id, item.rev, json, fetched_at],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    pub fn load_cache(&self) -> Vec<WorkItem> {
        let conn = self.0.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT json FROM work_item_cache") else {
            return vec![];
        };
        let rows = stmt.query_map([], |r| r.get::<_, String>(0));
        match rows {
            Ok(rows) => rows.flatten().filter_map(|j| serde_json::from_str(&j).ok()).collect(),
            Err(_) => vec![],
        }
    }
}

const SESSION_COLUMNS: &str = "id, work_item_id, mode, sdk_session_id, repo_path, worktree_path, branch, state, \
     started_at, ended_at, outcome, cost_usd, base_branch, model, prompt, error, created_at, port_base, project, resume_from";

fn session_from_row(r: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        work_item_id: r.get(1)?,
        mode: r.get(2)?,
        sdk_session_id: r.get(3)?,
        repo_path: r.get(4)?,
        worktree_path: r.get(5)?,
        branch: r.get(6)?,
        state: r.get(7)?,
        started_at: r.get(8)?,
        ended_at: r.get(9)?,
        outcome: r.get(10)?,
        cost_usd: r.get(11)?,
        base_branch: r.get(12)?,
        model: r.get(13)?,
        prompt: r.get(14)?,
        error: r.get(15)?,
        created_at: r.get(16)?,
        port_base: r.get(17)?,
        project: r.get(18)?,
        resume_from: r.get(19)?,
    })
}

impl Db {
    pub fn save_session(&self, s: &Session) -> DbResult<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                // An upsert, not INSERT OR REPLACE: replacing would delete the row and cascade away its steps.
                &format!(
                    "INSERT INTO session ({SESSION_COLUMNS})
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
                     ON CONFLICT(id) DO UPDATE SET
                       sdk_session_id = excluded.sdk_session_id, worktree_path = excluded.worktree_path,
                       branch = excluded.branch, state = excluded.state, started_at = excluded.started_at,
                       ended_at = excluded.ended_at, outcome = excluded.outcome, cost_usd = excluded.cost_usd,
                       base_branch = excluded.base_branch, model = excluded.model, prompt = excluded.prompt,
                       error = excluded.error, created_at = excluded.created_at, port_base = excluded.port_base,
                       project = excluded.project, resume_from = excluded.resume_from"
                ),
                params![
                    s.id, s.work_item_id, s.mode, s.sdk_session_id, s.repo_path, s.worktree_path, s.branch, s.state,
                    s.started_at, s.ended_at, s.outcome, s.cost_usd, s.base_branch, s.model, s.prompt, s.error,
                    s.created_at, s.port_base, s.project, s.resume_from
                ],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        self.0
            .lock()
            .unwrap()
            .query_row(&format!("SELECT {SESSION_COLUMNS} FROM session WHERE id = ?1"), [id], session_from_row)
            .optional()
            .ok()
            .flatten()
    }

    /// Every session, oldest first.
    pub fn sessions(&self) -> Vec<Session> {
        let conn = self.0.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(&format!("SELECT {SESSION_COLUMNS} FROM session ORDER BY created_at, id")) else {
            return vec![];
        };
        let rows = stmt.query_map([], session_from_row);
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }

    /// The whole evaluated PR lives in `checks_json`; the other columns mirror it for querying.
    pub fn save_pull_request(&self, pr: &PullRequest) -> DbResult<()> {
        let json = serde_json::to_string(pr).map_err(e)?;
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO pull_request (id, work_item_id, repo_id, branch, status, merge_status, checks_json, fix_attempts, last_polled_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   status = excluded.status, merge_status = excluded.merge_status, checks_json = excluded.checks_json,
                   fix_attempts = excluded.fix_attempts, last_polled_at = excluded.last_polled_at",
                params![pr.id, pr.work_item_id, pr.repo_id, pr.branch, pr.status, pr.merge_status, json, pr.fix_attempts, pr.last_polled_at],
            )
            .map_err(e)?;
        Ok(())
    }

    /// Every tracked PR, oldest first.
    pub fn pull_requests(&self) -> Vec<PullRequest> {
        let conn = self.0.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT checks_json FROM pull_request ORDER BY id") else {
            return vec![];
        };
        let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0));
        rows.map(|r| r.flatten().flatten().filter_map(|j| serde_json::from_str(&j).ok()).collect()).unwrap_or_default()
    }

    pub fn pull_request(&self, id: u64) -> Option<PullRequest> {
        self.pull_requests().into_iter().find(|p| p.id == id)
    }

    /// Replaces a session's task list with Claude's latest (FR3.1).
    pub fn replace_steps(&self, session_id: &str, steps: &[Step], now: &str) -> DbResult<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction().map_err(e)?;
        tx.execute("DELETE FROM session_step WHERE session_id = ?1", [session_id]).map_err(e)?;
        for (i, step) in steps.iter().enumerate() {
            tx.execute(
                "INSERT INTO session_step (session_id, position, text, state, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, i as i64, step.text, step.state, now],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    pub fn steps(&self, session_id: &str) -> Vec<Step> {
        let conn = self.0.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT text, state FROM session_step WHERE session_id = ?1 ORDER BY position") else {
            return vec![];
        };
        let rows = stmt.query_map([session_id], |r| Ok(Step { text: r.get(0)?, state: r.get(1)? }));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    #[test]
    fn saving_a_session_again_keeps_its_steps() {
        let db = Db::in_memory().unwrap();
        let mut s = Session {
            id: "a".into(), work_item_id: 1, mode: "implement".into(), sdk_session_id: None, repo_path: "/r".into(),
            worktree_path: "/w".into(), branch: "b".into(), state: "running".into(), started_at: None, ended_at: None,
            outcome: None, cost_usd: None, base_branch: "dev".into(), model: String::new(), prompt: "p".into(),
            error: None, created_at: "t".into(), port_base: 42000, project: "P".into(), resume_from: None,
        };
        db.save_session(&s).unwrap();
        db.replace_steps("a", &[Step { text: "one".into(), state: "completed".into() }], "t").unwrap();
        s.state = "needs_input".into();
        db.save_session(&s).unwrap();
        assert_eq!(db.steps("a").len(), 1);
        assert_eq!(db.session("a").unwrap(), s);
        assert_eq!(db.sessions().len(), 1);
    }

    #[test]
    fn pull_requests_round_trip_and_keep_one_row() {
        let db = Db::in_memory().unwrap();
        let mut pr = PullRequest { id: 12, work_item_id: 4512, branch: "b".into(), status: "active".into(), state: "checks".into(), ..Default::default() };
        db.save_pull_request(&pr).unwrap();
        pr.fix_attempts = 2;
        pr.state = "failed".into();
        db.save_pull_request(&pr).unwrap();
        assert_eq!(db.pull_requests(), vec![pr.clone()]);
        assert_eq!(db.pull_request(12).unwrap().fix_attempts, 2);
    }

    #[test]
    fn settings_round_trip() {
        let db = Db::in_memory().unwrap();
        assert!(db.get::<Settings>("settings").is_none());
        let s = Settings { org_url: "https://dev.azure.com/x".into(), ..Default::default() };
        db.set("settings", &s).unwrap();
        db.set("settings", &s).unwrap();
        assert_eq!(db.get::<Settings>("settings").unwrap(), s);
    }
}
