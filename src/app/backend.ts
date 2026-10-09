import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const PERSON_ME = '@me';
export const PERSON_EVERYONE = '@everyone';
export const SPRINT_CURRENT = '@current';

export interface Person {
  displayName: string;
  uniqueName: string;
}

export interface RepoMapping {
  project: string;
  /** Optional; empty means the whole project. */
  areaPath: string;
  repoPath: string;
  defaultBranch: string;
}

export interface RepoInfo {
  branches: string[];
  current: string | null;
}

export interface Settings {
  orgUrl: string;
  projects: string[];
  defaultPerson: string;
  defaultSprint: string;
  areaPaths: string[];
  workItemTypes: string[];
  todoStates: string[];
  pollIntervalSecs: number;
  repositories: RepoMapping[];
  concurrencyLimit: number;
  defaultMode: Mode;
  implementTemplate: string;
  reviewTemplate: string;
  allowAllTools: boolean;
  allowedTools: string[];
  defaultModel: string;
  worktreeRoot: string;
  notify: { needsInput: boolean; failed: boolean; ready: boolean; stuck: boolean };
  prPollIntervalSecs: number;
  maxFixAttempts: number;
  autoFix: boolean;
  reviewMarker: string;
  requireReview: boolean;
  mergeStrategy: 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge';
  deleteSourceBranch: boolean;
  completeWorkItems: boolean;
  claudePath: string;
}

export interface ReviewIssue {
  severity: string;
  location: string;
  text: string;
}

export interface Check {
  name: string;
  state: 'passed' | 'failed' | 'running' | 'pending';
  result: string;
  logTask: string | null;
  logLines: string[];
  issues: ReviewIssue[];
}

export interface PullRequest {
  id: number;
  workItemId: number;
  branch: string;
  targetBranch: string;
  title: string;
  webUrl: string;
  state: 'checks' | 'failed' | 'ready' | 'stuck' | 'merged' | 'abandoned';
  fixAttempts: number;
  maxAttempts: number;
  checks: Check[];
  failSummary: string;
  cleaned: boolean;
  lastPolledAt: string;
}

export interface PrSnapshot {
  prs: PullRequest[];
  /** Work items whose session finished without raising a PR. */
  missing: number[];
}

export type Mode = 'implement' | 'review' | 'fix';
export type SessionState = 'queued' | 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface Step {
  text: string;
  state: 'pending' | 'in_progress' | 'completed';
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface PendingInput {
  requestId: string;
  kind: 'permission' | 'question';
  title: string;
  text: string;
  detail: string;
  questions: Question[] | null;
  since: string;
}

export interface Session {
  id: string;
  workItemId: number;
  mode: Mode;
  state: SessionState;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  model: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  outcome: string | null;
  costUsd: number | null;
  error: string | null;
  steps: Step[];
  pending: PendingInput | null;
  queuePosition: number | null;
}

export interface LogEntry {
  kind: 'text' | 'tool' | 'result' | 'error' | 'info';
  tool?: string;
  id?: string;
  text: string;
  ts: string;
}

export interface StartRequest {
  workItemId: number;
  mode: Mode;
  repoPath: string;
  baseBranch: string;
  model: string;
  prompt: string | null;
}

/** Offered when starting a session; an empty id leaves the choice to Claude Code's own default. */
export const MODELS = [
  { id: '', label: 'Claude Code default' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

export interface Filters {
  sprint: string;
  person: string;
  personLabel: string;
}

export interface WorkItem {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  assignedTo: Person | null;
  iterationPath: string;
  areaPath: string;
  project: string;
  priority: number | null;
  changedDate: string;
  descriptionHtml: string;
  acceptanceHtml: string;
  links: { rel: string; id: number }[];
}

export type ErrorKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'server' | 'network' | 'invalid';

export interface DevOpsError {
  kind: ErrorKind;
  message: string;
}

export interface SyncState {
  status: 'unconfigured' | 'idle' | 'syncing' | 'error';
  lastGoodSync: string | null;
  error: DevOpsError | null;
  sprintNames: string[];
}

export interface Snapshot {
  settings: Settings;
  filters: Filters;
  hasPat: boolean;
  me: Person | null;
  items: WorkItem[];
  sync: SyncState;
  sessions: Session[];
  pullRequests: PrSnapshot;
  fixture: boolean;
}

export interface Sprint {
  path: string;
  name: string;
  project: string;
  timeFrame: 'past' | 'current' | 'future';
  startDate: string | null;
  finishDate: string | null;
}

export interface Detail {
  id: number;
  comments: { author: string; date: string; html: string }[];
  linked: { id: number; rel: string; title: string; type: string; state: string }[];
}

/** Every side effect goes through the Rust core; the webview holds no secrets and makes no requests. */
export const backend = {
  getState: () => invoke<Snapshot>('get_state'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  setPat: (pat: string) => invoke<void>('set_pat', { pat }),
  testConnection: (orgUrl: string, projects: string[], pat: string | null) =>
    invoke<Person>('test_connection', { orgUrl, projects, pat }),
  setFilters: (filters: Filters) => invoke<Filters>('set_filters', { filters }),
  refresh: () => invoke<void>('refresh'),
  listSprints: () => invoke<Sprint[]>('list_sprints'),
  listPeople: () => invoke<Person[]>('list_people'),
  workItemDetail: (id: number) => invoke<Detail>('get_work_item_detail', { id }),
  openWorkItem: (id: number) => invoke<void>('open_work_item', { id }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  inspectRepo: (path: string) => invoke<RepoInfo>('inspect_repo', { path }),
  pickFolder: () => invoke<string | null>('pick_folder'),
  previewPrompt: (workItemId: number, mode: Mode, repoPath: string, baseBranch: string) =>
    invoke<string>('preview_prompt', { workItemId, mode, repoPath, baseBranch }),
  startSession: (request: StartRequest) => invoke<void>('start_session', { request }),
  fixPr: (workItemId: number) => invoke<void>('fix_pr', { workItemId }),
  completeMerge: (workItemId: number) => invoke<void>('complete_merge', { workItemId }),
  refreshPrs: () => invoke<void>('refresh_prs'),
  stopSession: (sessionId: string) => invoke<void>('stop_session', { sessionId }),
  resumeSession: (sessionId: string) => invoke<void>('resume_session', { sessionId }),
  answerSession: (
    sessionId: string,
    requestId: string,
    action: 'approve' | 'deny' | 'reply',
    message: string | null,
    answers: Record<string, string> | null,
  ) => invoke<void>('answer_session', { sessionId, requestId, action, message, answers }),
  sessionLog: (sessionId: string) => invoke<LogEntry[]>('get_session_log', { sessionId }),
  openWorktree: (sessionId: string) => invoke<void>('open_worktree', { sessionId }),
  windowMinimize: () => invoke<void>('window_minimize'),
  windowToggleMaximize: () => invoke<void>('window_toggle_maximize'),
  windowClose: () => invoke<void>('window_close'),
  windowStartDrag: () => invoke<void>('window_start_drag'),
  onSync: (fn: (s: SyncState) => void) => listen<SyncState>('sync-state', (e) => fn(e.payload)),
  onPrs: (fn: (s: PrSnapshot) => void) => listen<PrSnapshot>('pull-requests', (e) => fn(e.payload)),
  onSessions: (fn: (s: Session[]) => void) => listen<Session[]>('sessions', (e) => fn(e.payload)),
  onSessionLog: (fn: (sessionId: string, entry: LogEntry) => void) =>
    listen<{ sessionId: string; entry: LogEntry }>('session-log', (e) => fn(e.payload.sessionId, e.payload.entry)),
  onItems: (fn: (items: WorkItem[]) => void) => listen<WorkItem[]>('work-items', (e) => fn(e.payload)),
};

export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return 'Something went wrong';
}
