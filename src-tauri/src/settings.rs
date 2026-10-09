use serde::{Deserialize, Serialize};

pub const PERSON_ME: &str = "@me";
pub const PERSON_EVERYONE: &str = "@everyone";
pub const SPRINT_CURRENT: &str = "@current";

/// Where sessions for a project (or one area of it) run: a local clone and the branch
/// new work starts from unless another is chosen at launch (FR7.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoMapping {
    pub project: String,
    /// Optional. Empty means the whole project; otherwise the most specific match wins.
    pub area_path: String,
    pub repo_path: String,
    pub default_branch: String,
}

pub const DEFAULT_IMPLEMENT_TEMPLATE: &str = "\
Work on Azure DevOps {type} #{id}: \"{title}\".

You are in a git worktree of {repo} on branch {branch}, created from {target}. Keep all changes inside this folder.

1. Read the work item below and plan your steps before you start.
2. Implement the change and run the relevant tests.
3. Commit with a message that references the work item as AB#{id}.
4. Push {branch} and open a pull request into {target} linked to work item #{id} (for example: az repos pr create --source-branch {branch} --target-branch {target} --work-items {id}).

Do not change the work item's state in Azure DevOps. If you need a decision from me, ask with the AskUserQuestion tool instead of guessing.";

pub const DEFAULT_REVIEW_TEMPLATE: &str = "\
Review Azure DevOps {type} #{id}: \"{title}\".

You are in a git worktree of {repo} on branch {branch}, created from {target}. Do not change code, commit or push.

1. Read the work item below and plan your steps before you start.
2. Check the existing implementation against every acceptance criterion and run the tests.
3. Finish with a summary of what is done, what is missing and any risks, with file and line references.

Do not change the work item's state in Azure DevOps. If you need a decision from me, ask with the AskUserQuestion tool instead of guessing.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifySettings {
    pub needs_input: bool,
    pub failed: bool,
    pub ready: bool,
    pub stuck: bool,
}

impl Default for NotifySettings {
    fn default() -> Self {
        Self { needs_input: true, failed: true, ready: true, stuck: true }
    }
}

/// Everything in FR7.1–FR7.4 and FR7.6 except the PAT, which lives only in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub org_url: String,
    pub projects: Vec<String>,
    /// `@me`, `@everyone` or a user's unique name.
    pub default_person: String,
    /// `@current` or an iteration path.
    pub default_sprint: String,
    pub area_paths: Vec<String>,
    pub work_item_types: Vec<String>,
    pub todo_states: Vec<String>,
    pub poll_interval_secs: u64,
    pub repositories: Vec<RepoMapping>,
    pub concurrency_limit: u32,
    /// `implement` or `review`.
    pub default_mode: String,
    pub implement_template: String,
    pub review_template: String,
    /// When true every tool runs without asking; otherwise only `allowed_tools` do (FR3.3).
    pub allow_all_tools: bool,
    pub allowed_tools: Vec<String>,
    /// Pre-selected in the start panel; empty means Claude Code's own default.
    pub default_model: String,
    /// Empty means `{repo}/../.foreman-worktrees`.
    pub worktree_root: String,
    pub notify: NotifySettings,
    pub pr_poll_interval_secs: u64,
    pub max_fix_attempts: u32,
    /// Start a fix as soon as a PR fails, still within the attempt limit (FR5.4).
    pub auto_fix: bool,
    /// Text that identifies the review tool's comment; the decision follows it.
    pub review_marker: String,
    /// A PR isn't Ready to merge until the review tool has approved the latest push.
    pub require_review: bool,
    /// `squash`, `noFastForward`, `rebase` or `rebaseMerge` (FR6.1).
    pub merge_strategy: String,
    pub delete_source_branch: bool,
    /// Let DevOps move linked work items on when the PR completes.
    pub complete_work_items: bool,
    /// Claude Code executable for the packaged agent host; empty means find `claude` on the PATH.
    pub claude_path: String,
}

impl Default for Settings {
    fn default() -> Self {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect();
        Self {
            org_url: String::new(),
            projects: vec![],
            default_person: PERSON_ME.into(),
            default_sprint: SPRINT_CURRENT.into(),
            area_paths: vec![],
            work_item_types: s(&["Bug", "Task", "User Story", "Product Backlog Item"]),
            todo_states: s(&["New", "Approved", "Committed", "Active", "To Do", "In Progress", "Doing"]),
            poll_interval_secs: 60,
            repositories: vec![],
            concurrency_limit: 3,
            default_mode: "implement".into(),
            implement_template: DEFAULT_IMPLEMENT_TEMPLATE.into(),
            review_template: DEFAULT_REVIEW_TEMPLATE.into(),
            allow_all_tools: true,
            allowed_tools: s(&["Read", "Glob", "Grep", "Edit", "Write", "TodoWrite"]),
            default_model: String::new(),
            worktree_root: String::new(),
            notify: NotifySettings::default(),
            pr_poll_interval_secs: 60,
            max_fix_attempts: 3,
            auto_fix: false,
            review_marker: "**Decision:".into(),
            require_review: true,
            merge_strategy: "squash".into(),
            delete_source_branch: true,
            complete_work_items: false,
            claude_path: String::new(),
        }
    }
}

impl Settings {
    pub fn is_configured(&self) -> bool {
        !self.org_url.trim().is_empty() && !self.projects.is_empty()
    }

    pub fn normalised(mut self) -> Self {
        let clean = |v: Vec<String>| -> Vec<String> {
            let mut out: Vec<String> = vec![];
            for x in v {
                let x = x.trim().to_string();
                if !x.is_empty() && !out.contains(&x) {
                    out.push(x);
                }
            }
            out
        };
        self.org_url = self.org_url.trim().trim_end_matches('/').to_string();
        self.projects = clean(self.projects);
        self.area_paths = clean(self.area_paths);
        self.work_item_types = clean(self.work_item_types);
        self.todo_states = clean(self.todo_states);
        self.poll_interval_secs = self.poll_interval_secs.clamp(15, 3600);
        self.concurrency_limit = self.concurrency_limit.clamp(1, 12);
        self.pr_poll_interval_secs = self.pr_poll_interval_secs.clamp(15, 3600);
        self.max_fix_attempts = self.max_fix_attempts.clamp(1, 10);
        if !["squash", "noFastForward", "rebase", "rebaseMerge"].contains(&self.merge_strategy.as_str()) {
            self.merge_strategy = "squash".into();
        }
        self.claude_path = self.claude_path.trim().to_string();
        if self.review_marker.trim().is_empty() {
            self.review_marker = "**Decision:".into();
        }
        if self.default_mode != "review" {
            self.default_mode = "implement".into();
        }
        if self.implement_template.trim().is_empty() {
            self.implement_template = DEFAULT_IMPLEMENT_TEMPLATE.into();
        }
        if self.review_template.trim().is_empty() {
            self.review_template = DEFAULT_REVIEW_TEMPLATE.into();
        }
        self.allowed_tools = clean(self.allowed_tools);
        self.default_model = self.default_model.trim().to_string();
        self.worktree_root = self.worktree_root.trim().to_string();
        for r in &mut self.repositories {
            r.project = r.project.trim().to_string();
            r.area_path = r.area_path.trim().trim_end_matches('\\').to_string();
            r.repo_path = r.repo_path.trim().to_string();
            r.default_branch = r.default_branch.trim().to_string();
        }
        self
    }
}

/// The top-bar filters (FR1.3). Persisted between launches.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    pub sprint: String,
    pub person: String,
    /// Display name for `person` when it is a specific user.
    #[serde(default)]
    pub person_label: String,
}

impl Filters {
    pub fn defaults(settings: &Settings) -> Self {
        Self {
            sprint: settings.default_sprint.clone(),
            person: settings.default_person.clone(),
            person_label: String::new(),
        }
    }
}
