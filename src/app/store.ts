import { Injectable, computed, signal } from '@angular/core';
import {
  backend, errorMessage, Filters, LogEntry, PERSON_EVERYONE, PERSON_ME, Person, PrSnapshot, PullRequest, Session, Settings,
  SPRINT_CURRENT, SyncState, WorkItem,
} from './backend';
import { Status } from './icons';

export type GroupKey = 'attention' | 'active' | 'todo' | 'done';
export type ChipKey = 'attention' | 'running' | 'pr' | 'done';
export type ItemStatus =
  | 'not_started' | 'queued' | 'running' | 'needs_input' | 'finished' | 'failed' | 'interrupted' | 'cancelled'
  | 'pr_checks' | 'pr_failed' | 'no_pr' | 'fixing' | 'ready' | 'stuck' | 'merged';

interface StatusInfo {
  label: string;
  icon: Status;
  group: GroupKey;
  /** Colour token for the label and badge. */
  tone: 'text3' | 'text2' | 'run' | 'att' | 'fail' | 'pass' | 'merge';
}

const STATUS: Record<ItemStatus, StatusInfo> = {
  not_started: { label: 'Not started', icon: 'not_started', group: 'todo', tone: 'text3' },
  queued: { label: 'Queued', icon: 'queued', group: 'active', tone: 'text2' },
  running: { label: 'Running', icon: 'running', group: 'active', tone: 'run' },
  needs_input: { label: 'Needs input', icon: 'needs_input', group: 'attention', tone: 'att' },
  failed: { label: 'Session failed', icon: 'failed', group: 'attention', tone: 'fail' },
  interrupted: { label: 'Interrupted', icon: 'failed', group: 'attention', tone: 'fail' },
  finished: { label: 'Session finished', icon: 'done', group: 'done', tone: 'pass' },
  cancelled: { label: 'Cancelled', icon: 'cancelled', group: 'done', tone: 'text3' },
  pr_checks: { label: 'PR checks running', icon: 'pr_checks', group: 'active', tone: 'run' },
  fixing: { label: 'Fixing', icon: 'fixing', group: 'active', tone: 'run' },
  pr_failed: { label: 'PR failed', icon: 'failed', group: 'attention', tone: 'fail' },
  no_pr: { label: 'No PR raised', icon: 'failed', group: 'attention', tone: 'fail' },
  stuck: { label: 'Stuck', icon: 'stuck', group: 'attention', tone: 'fail' },
  ready: { label: 'Ready to merge', icon: 'ready', group: 'attention', tone: 'pass' },
  merged: { label: 'Merged', icon: 'merged', group: 'done', tone: 'merge' },
};
const PR_STATUS: Record<PullRequest['state'], ItemStatus> = {
  checks: 'pr_checks', failed: 'pr_failed', ready: 'ready', stuck: 'stuck', merged: 'merged', abandoned: 'cancelled',
};
const SESSION_STATUS: Record<Session['state'], ItemStatus> = {
  queued: 'queued', running: 'running', needs_input: 'needs_input', done: 'finished',
  failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted',
};
const GROUP_LABEL: Record<GroupKey, string> = {
  attention: 'Needs attention', active: 'Active sessions', todo: 'Not started', done: 'Completed',
};
/** Most urgent first within a group. */
const RANK: Record<ItemStatus, number> = {
  needs_input: 0, pr_failed: 1, no_pr: 1, failed: 2, interrupted: 2, stuck: 3, ready: 4,
  running: 0, fixing: 1, pr_checks: 2, queued: 3, not_started: 0, merged: 0, finished: 1, cancelled: 2,
};
const RUNNING: ItemStatus[] = ['running', 'needs_input', 'fixing'];
const PR_OPEN: ItemStatus[] = ['pr_checks', 'pr_failed', 'fixing', 'ready', 'stuck'];
const MAX_LOG = 1000;
const FLASH_MS = 2400;

export interface Row extends StatusInfo {
  item: WorkItem;
  status: ItemStatus;
  /** The item's most recent session, if it has one. */
  session: Session | null;
  /** The PR raised from that session's branch, once found. */
  pr: PullRequest | null;
  /** Second-line detail: what it's waiting for, or what it's doing. */
  reason: string;
  done: number;
  total: number;
}

export interface Group {
  key: GroupKey;
  label: string;
  rows: Row[];
}

export interface Toast {
  status: Status;
  title: string;
  text: string;
  itemId: number | null;
}

export function ago(iso: string, now: number): string {
  const mins = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return '';
  return mins < 1 ? 'now' : mins < 60 ? mins + 'm' : mins < 1440 ? Math.floor(mins / 60) + 'h' : Math.floor(mins / 1440) + 'd';
}

export function leaf(path: string): string {
  return path.split('\\').pop() ?? path;
}

/** `m:ss` or `h:mm:ss` between two instants. */
export function elapsed(fromIso: string | null, to: number): string {
  if (!fromIso) return '';
  const sec = Math.max(0, Math.floor((to - Date.parse(fromIso)) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

function statusFor(s: Session | null, pr: PullRequest | null, missing: boolean): ItemStatus {
  if (!s) return 'not_started';
  if (s.state === 'queued' || s.state === 'needs_input') return SESSION_STATUS[s.state];
  if (s.state === 'running') return s.mode === 'fix' ? 'fixing' : 'running';
  // A session that broke needs attention before the PR's own state matters.
  if (s.state === 'failed' || s.state === 'interrupted') return SESSION_STATUS[s.state];
  if (pr) return PR_STATUS[pr.state];
  if (s.state === 'done' && s.mode !== 'review') return missing ? 'no_pr' : 'pr_checks';
  return SESSION_STATUS[s.state];
}

function reasonFor(status: ItemStatus, s: Session | null, pr: PullRequest | null, item: WorkItem): string {
  if (!s) return `${item.state} · ${leaf(item.areaPath)}`;
  switch (status) {
    case 'needs_input': return s.pending?.text || s.pending?.detail || s.pending?.title || 'Waiting for you';
    case 'failed':
    case 'interrupted': return (s.error ?? '').split('\n')[0];
    case 'queued': return s.queuePosition ? `Position ${s.queuePosition} in queue` : '';
    case 'running': return s.steps.find((x) => x.state === 'in_progress')?.text ?? 'Starting…';
    case 'fixing': return pr ? `Fix attempt ${pr.fixAttempts} of ${pr.maxAttempts}` : 'Raising the pull request';
    case 'pr_failed': return pr?.failSummary ?? '';
    case 'no_pr': return 'The session finished without opening a PR';
    case 'stuck': return pr ? `${pr.fixAttempts} of ${pr.maxAttempts} fix attempts used` : '';
    case 'ready': return 'All checks passed';
    case 'pr_checks': {
      if (!pr) return 'Looking for the pull request…';
      const passed = pr.checks.filter((c) => c.state === 'passed').length;
      return pr.checks.length ? `${passed} of ${pr.checks.length} checks passed` : 'Waiting for checks';
    }
    default: return s.branch;
  }
}

/** Mirrors the state the Rust core owns. Nothing here is the source of truth. */
@Injectable({ providedIn: 'root' })
export class Store {
  readonly loaded = signal(false);
  readonly settings = signal<Settings | null>(null);
  readonly filters = signal<Filters>({ sprint: SPRINT_CURRENT, person: PERSON_ME, personLabel: '' });
  readonly hasPat = signal(false);
  readonly me = signal<Person | null>(null);
  readonly items = signal<WorkItem[]>([]);
  readonly sessions = signal<Session[]>([]);
  readonly prs = signal<PrSnapshot>({ prs: [], missing: [] });
  readonly sync = signal<SyncState>({ status: 'unconfigured', lastGoodSync: null, error: null, sprintNames: [] });
  readonly fixture = signal(false);

  readonly view = signal<'main' | 'settings'>('main');
  readonly settingsSection = signal('connection');
  readonly selectedId = signal<number | null>(null);
  /** True while the selection is being moved by keyboard, so the row draws a focus ring. */
  readonly kbd = signal(false);
  readonly query = signal('');
  readonly chip = signal<ChipKey | null>(null);
  readonly toasts = signal<Toast[]>([]);
  /** Row briefly highlighted after its state changed. */
  readonly flash = signal<number | null>(null);

  /** Activity logs by session id, loaded when a session is first shown. */
  readonly logs = signal<Record<string, LogEntry[]>>({});

  /** Ticks every second for timers, and every 30s for row ages. */
  readonly now = signal(Date.now());
  readonly nowCoarse = signal(Date.now());

  readonly configured = computed(() => {
    const s = this.settings();
    return !!s && !!s.orgUrl && s.projects.length > 0 && this.hasPat();
  });

  /** Latest session per work item. Sessions arrive oldest first. */
  private readonly latestSession = computed(() => {
    const map = new Map<number, Session>();
    for (const s of this.sessions()) map.set(s.workItemId, s);
    return map;
  });

  /** Lifecycle state is derived from session and PR rows, never stored, so it can't drift. */
  readonly rows = computed<Row[]>(() =>
    this.items().map((item) => {
      const session = this.latestSession().get(item.id) ?? null;
      const pr = (session && [...this.prs().prs].reverse().find((p) => p.workItemId === item.id && p.branch === session.branch)) || null;
      const status = statusFor(session, pr, this.prs().missing.includes(item.id));
      const steps = session?.steps ?? [];
      return {
        item, status, session, pr, ...STATUS[status],
        reason: reasonFor(status, session, pr, item),
        done: steps.filter((s) => s.state === 'completed').length,
        total: steps.length,
      };
    }),
  );

  readonly activeCount = computed(() => this.sessions().filter((s) => s.state === 'running' || s.state === 'needs_input').length);

  readonly counts = computed(() => {
    const c = { attention: 0, running: 0, pr: 0, done: 0 };
    for (const r of this.rows()) {
      if (r.group === 'attention') c.attention++;
      if (RUNNING.includes(r.status)) c.running++;
      if (PR_OPEN.includes(r.status)) c.pr++;
      if (r.group === 'done') c.done++;
    }
    return c;
  });

  readonly visible = computed<Row[]>(() => {
    const q = this.query().trim().toLowerCase();
    const chip = this.chip();
    return this.rows().filter((r) => {
      if (q && !(String(r.item.id).includes(q) || r.item.title.toLowerCase().includes(q))) return false;
      if (chip === 'attention') return r.group === 'attention';
      if (chip === 'running') return RUNNING.includes(r.status);
      if (chip === 'pr') return PR_OPEN.includes(r.status);
      if (chip === 'done') return r.group === 'done';
      return true;
    });
  });

  readonly groups = computed<Group[]>(() =>
    (['attention', 'active', 'todo', 'done'] as GroupKey[])
      .map((key) => ({
        key,
        label: GROUP_LABEL[key],
        rows: this.visible().filter((r) => r.group === key).sort((a, b) => RANK[a.status] - RANK[b.status]),
      }))
      .filter((g) => g.rows.length > 0),
  );

  readonly collapsed = signal<Partial<Record<GroupKey, boolean>>>({});

  /** IDs in on-screen order, for ↑↓. */
  readonly visibleIds = computed(() =>
    this.groups().flatMap((g) => (this.collapsed()[g.key] ? [] : g.rows.map((r) => r.item.id))),
  );
  readonly attention = computed(() => this.rows().filter((r) => r.group === 'attention'));
  readonly attentionIds = computed(() => this.attention().map((r) => r.item.id));

  readonly selected = computed(() => this.rows().find((r) => r.item.id === this.selectedId()) ?? null);

  readonly sprintLabel = computed(() => {
    const f = this.filters();
    if (f.sprint !== SPRINT_CURRENT) return leaf(f.sprint);
    const names = this.sync().sprintNames;
    return names.length ? names.join(', ') : 'Current sprint';
  });
  readonly sprintIsCurrent = computed(() => this.filters().sprint === SPRINT_CURRENT);

  readonly personLabel = computed(() => this.personName(this.filters().person, this.filters().personLabel));
  readonly personInitials = computed(() => {
    const f = this.filters();
    if (f.person === PERSON_EVERYONE) return 'All';
    const name = f.person === PERSON_ME ? (this.me()?.displayName ?? 'Me') : f.personLabel || f.person;
    return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  });

  personName(person: string, label = ''): string {
    return person === PERSON_ME ? 'Me' : person === PERSON_EVERYONE ? 'Everyone' : label || person;
  }

  async init(): Promise<void> {
    await backend.onSync((s) => this.sync.set(s));
    await backend.onItems((items) => this.items.set(items));
    await backend.onSessions((sessions) => this.applySessions(sessions));
    await backend.onPrs((prs) => this.applyPrs(prs));
    await backend.onSessionLog((id, entry) => {
      const current = this.logs()[id];
      // Only sessions whose log has been opened are tracked; the rest load on demand.
      if (current) this.logs.update((m) => ({ ...m, [id]: [...current, entry].slice(-MAX_LOG) }));
    });
    await this.reload();
    if (!this.configured()) this.view.set('settings');
    setInterval(() => this.now.set(Date.now()), 1000);
    setInterval(() => this.nowCoarse.set(Date.now()), 30000);
    this.loaded.set(true);
  }

  async reload(): Promise<void> {
    const s = await backend.getState();
    this.settings.set(s.settings);
    this.filters.set(s.filters);
    this.hasPat.set(s.hasPat);
    this.me.set(s.me);
    this.items.set(s.items);
    this.sessions.set(s.sessions);
    this.prs.set(s.pullRequests);
    this.sync.set(s.sync);
    this.fixture.set(s.fixture);
  }

  /** Applies a sessions update, announcing anything that newly needs the user. */
  private applySessions(next: Session[]): void {
    const before = new Map(this.sessions().map((s) => [s.id, s.state]));
    this.sessions.set(next);
    for (const s of next) {
      if (before.get(s.id) === s.state) continue;
      const title = this.items().find((i) => i.id === s.workItemId)?.title ?? '';
      if (s.state === 'needs_input') {
        this.announce({ status: 'needs_input', title: `${s.workItemId} needs input`, text: s.pending?.title ?? title, itemId: s.workItemId });
      } else if (s.state === 'failed' || s.state === 'interrupted') {
        this.announce({ status: 'failed', title: `${s.workItemId} session failed`, text: title, itemId: s.workItemId });
      } else if (s.state === 'done' && s.mode === 'review') {
        this.announce({ status: 'done', title: `${s.workItemId} session finished`, text: title, itemId: s.workItemId });
      }
    }
  }

  /** Applies a PR update, announcing PRs that newly failed, got stuck or became ready. */
  private applyPrs(next: PrSnapshot): void {
    const before = new Map(this.prs().prs.map((p) => [p.id, p.state]));
    const wasMissing = this.prs().missing;
    this.prs.set(next);
    const busy = (id: number) => this.sessions().some((s) => s.workItemId === id && ['queued', 'running', 'needs_input'].includes(s.state));
    for (const p of next.prs) {
      if (before.get(p.id) === p.state || busy(p.workItemId)) continue;
      const id = p.workItemId;
      if (p.state === 'failed') this.announce({ status: 'failed', title: `${id} PR failed`, text: p.failSummary, itemId: id });
      else if (p.state === 'stuck') this.announce({ status: 'stuck', title: `${id} is stuck`, text: p.failSummary, itemId: id });
      else if (p.state === 'ready') this.announce({ status: 'ready', title: `${id} ready to merge`, text: p.title, itemId: id });
      else if (p.state === 'merged') this.announce({ status: 'merged', title: `${id} merged`, text: p.title, itemId: id });
    }
    for (const id of next.missing) {
      if (!wasMissing.includes(id)) this.announce({ status: 'failed', title: `${id} raised no PR`, text: 'The session finished without opening one', itemId: id });
    }
  }

  private announce(toast: Toast): void {
    if (toast.itemId !== null) {
      const id = toast.itemId;
      this.flash.set(id);
      setTimeout(() => this.flash.update((f) => (f === id ? null : f)), FLASH_MS);
      // No toast for the item already on screen.
      if (id === this.selectedId() && this.view() === 'main') return;
    }
    this.toasts.update((t) => [...t.slice(-2), toast]);
    setTimeout(() => this.dismiss(toast), 8000);
  }

  dismiss(toast: Toast): void {
    this.toasts.update((t) => t.filter((x) => x !== toast));
  }

  async loadLog(sessionId: string): Promise<void> {
    if (this.logs()[sessionId]) return;
    const entries = await this.run(() => backend.sessionLog(sessionId));
    if (entries) this.logs.update((m) => ({ ...m, [sessionId]: entries }));
  }

  async setFilters(patch: Partial<Filters>): Promise<void> {
    const next = { ...this.filters(), ...patch };
    this.filters.set(next);
    await this.run(() => backend.setFilters(next));
  }

  resetFilters(): Promise<void> {
    const s = this.settings();
    this.query.set('');
    this.chip.set(null);
    return this.setFilters({
      sprint: s?.defaultSprint ?? SPRINT_CURRENT,
      person: s?.defaultPerson ?? PERSON_ME,
      personLabel: '',
    });
  }

  refresh(): void {
    void this.run(() => backend.refresh());
  }

  select(id: number | null, viaKeyboard = false): void {
    this.selectedId.set(id);
    this.kbd.set(viaKeyboard);
  }

  openSettings(section?: string): void {
    if (section) this.settingsSection.set(section);
    this.view.set('settings');
  }

  /** Runs a backend call, surfacing any failure as a toast instead of an unhandled rejection. */
  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.showToast(errorMessage(err));
      return undefined;
    }
  }

  showToast(message: string): void {
    const toast: Toast = { status: 'failed', title: message, text: '', itemId: null };
    this.toasts.update((t) => [...t.slice(-2), toast]);
    setTimeout(() => this.dismiss(toast), 6000);
  }
}
