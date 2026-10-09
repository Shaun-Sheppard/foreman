import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { backend, Detail, errorMessage } from './backend';
import { StatusIcon, TypeIcon } from './icons';
import { Launcher } from './launcher';
import { PrPanel } from './pr-panel';
import { SessionPanel } from './session-panel';
import { ItemStatus, Store, elapsed, leaf } from './store';

@Component({
  selector: 'fm-detail-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, TypeIcon, Launcher, SessionPanel, PrPanel],
  styles: `
    :host { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); --pad-x: 28px; }
    @media (max-width: 1100px) { :host { --pad-x: 20px; } }
    .none { flex: 1; display: grid; place-items: center; padding: 24px; overflow: auto; }
    .none > div { width: min(440px, 100%); display: flex; flex-direction: column; gap: 12px; }
    .none .t { font-size: 16px; font-weight: 600; }
    .none .s { color: var(--text2); text-wrap: pretty; }
    .hdr { flex: none; padding: 16px var(--pad-x); border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
    .crumb { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text2); min-width: 0; }
    .crumb .id { font-family: var(--mono); color: var(--text); }
    .crumb .dot { color: var(--text3); }
    .crumb .area { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link { border: 0; background: transparent; padding: 0; color: var(--text2); white-space: nowrap; font-size: 12px; }
    .link:hover { text-decoration: underline; color: var(--text); }
    .title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; text-wrap: pretty; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 12px; color: var(--text2); }
    .meta i { font-style: normal; color: var(--text3); }
    .badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px 0 6px; border-radius: 999px; background: var(--mute-bg); color: var(--text3); font-weight: 600; }
    .badge.run { background: var(--run-bg); color: var(--run); }
    .badge.att { background: var(--att-bg); color: var(--att); }
    .badge.fail { background: var(--fail-bg); color: var(--fail); }
    .badge.pass { background: var(--pass-bg); color: var(--pass); }
    .badge.text2 { color: var(--text2); }
    .badge.merge { background: var(--merge-bg); color: var(--merge); }
    .alist { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .alist button { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 0; border-top: 1px solid var(--border); background: transparent; text-align: left; }
    .alist button:first-child { border-top: 0; }
    .alist button:hover { background: var(--hover); }
    .alist .id { font-family: var(--mono); font-size: 12px; color: var(--text2); }
    .alist .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .alist .lbl { font-size: 12px; font-weight: 500; white-space: nowrap; }
    .hintline { font-size: 12px; color: var(--text3); }
    .foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px var(--pad-x); border-top: 1px solid var(--border); background: var(--surface); }
    .foot .path { font-family: var(--mono); font-size: 12px; color: var(--text3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stop { border-color: var(--fail); background: transparent; color: var(--fail); }
    .stop:hover:not(:disabled) { background: var(--fail-bg); }
    .body { flex: 1; min-height: 0; padding: 16px var(--pad-x) 28px; display: flex; flex-direction: column; gap: 20px; }
    section { display: flex; flex-direction: column; gap: 8px; max-width: 760px; }
    .muted { color: var(--text3); }
    .card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .lrow { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 14px; border: 0; border-top: 1px solid var(--border); background: transparent; text-align: left; }
    .lrow:first-child { border-top: 0; }
    .lrow:hover { background: var(--hover); }
    .lrow .rel { width: 70px; flex: none; color: var(--text2); font-size: 12px; }
    .lrow .id { font-family: var(--mono); font-size: 12px; color: var(--text2); flex: none; }
    .lrow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .lrow .st { font-size: 12px; color: var(--text3); white-space: nowrap; }
    .comment { display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; border-top: 1px solid var(--border); }
    .comment:first-child { border-top: 0; }
    .comment .who { display: flex; gap: 8px; align-items: baseline; font-weight: 500; }
    .comment .when { font-family: var(--mono); font-size: 11.5px; color: var(--text3); font-weight: 400; }
  `,
  template: `
    @if (row(); as r) {
      <div class="hdr">
        <div class="crumb">
          <fm-type-icon [type]="r.item.type" [size]="13" />
          <span>{{ r.item.type }}</span>
          <span class="id selectable">#{{ r.item.id }}</span>
          <span class="dot">·</span>
          <span class="area">{{ r.item.areaPath }}</span>
          <span class="spacer"></span>
          @if (r.session && (r.status === 'running' || r.status === 'needs_input' || r.status === 'fixing')) {
            <span class="mono tnum">{{ elapsed(r.session.startedAt, store.now()) }}</span>
          }
          <button class="link" (click)="openInDevOps(r.item.id)">Open in DevOps ↗</button>
        </div>
        <div class="title selectable">{{ r.item.title }}</div>
        <div class="meta">
          <span class="badge" [class]="r.tone"><fm-status-icon [status]="r.icon" [size]="13" />{{ r.label }}</span>
          <span><i>State </i>{{ r.item.state }}</span>
          <span><i>Assignee </i>{{ r.item.assignedTo?.displayName ?? 'Unassigned' }}</span>
          <span><i>Iteration </i>{{ leaf(r.item.iterationPath) }}</span>
          @if (r.item.priority !== null) {
            <span><i>Priority </i>{{ r.item.priority }}</span>
          }
          @if (r.session; as ses) {
            <span><i>Mode </i>{{ ses.mode === 'review' ? 'Review' : ses.mode === 'fix' ? 'Fix' : 'Implement' }}</span>
            <span class="mono selectable" style="font-size:11.5px">{{ ses.branch }} ← {{ ses.baseBranch }}</span>
          }
        </div>
      </div>

      <div class="body scroll" (click)="onRichClick($event)">
        @if (r.pr || prStatuses.includes(r.status)) {
          <fm-pr-panel [row]="r" />
        }
        @if (r.session; as ses) {
          <fm-session-panel [session]="ses" [showOutcome]="!r.pr && r.status !== 'no_pr'" />
        }
        @if (launchable.includes(r.status)) {
          @if (r.session) {
            <div class="caps" style="margin-bottom:-8px">{{ r.status === 'stuck' ? 'Start a manual session' : 'Start a new session' }}</div>
          }
          <fm-launcher [item]="r.item" />
        }
        <section>
          <div class="caps">Description</div>
          @if (r.item.descriptionHtml.trim()) {
            <div class="rich selectable" [innerHTML]="r.item.descriptionHtml"></div>
          } @else {
            <div class="muted">No description.</div>
          }
        </section>

        <section>
          <div class="caps">Acceptance criteria</div>
          @if (r.item.acceptanceHtml.trim()) {
            <div class="rich ac selectable" [innerHTML]="r.item.acceptanceHtml"></div>
          } @else {
            <div class="muted">None recorded.</div>
          }
        </section>

        @if (r.item.links.length > 0) {
          <section>
            <div class="caps">Linked items</div>
            @if (detail(); as d) {
              <div class="card">
                @for (l of d.linked; track l.id) {
                  <button class="lrow" (click)="openInDevOps(l.id)" title="Open in DevOps">
                    <span class="rel">{{ l.rel }}</span>
                    <fm-type-icon [type]="l.type" [size]="13" />
                    <span class="id">{{ l.id }}</span>
                    <span class="name">{{ l.title }}</span>
                    <span class="st">{{ l.state }}</span>
                  </button>
                }
              </div>
            } @else {
              <div class="muted">{{ detailError() ?? 'Loading…' }}</div>
            }
          </section>
        }

        <section>
          <div class="caps">Latest comments</div>
          @if (detail(); as d) {
            @if (d.comments.length > 0) {
              <div class="card">
                @for (c of d.comments; track $index) {
                  <div class="comment">
                    <div class="who">{{ c.author }}<span class="when">{{ when(c.date) }}</span></div>
                    <div class="rich selectable" [innerHTML]="c.html"></div>
                  </div>
                }
              </div>
            } @else {
              <div class="muted">No comments.</div>
            }
          } @else {
            <div class="muted">{{ detailError() ?? 'Loading…' }}</div>
          }
        </section>
      </div>
      @if (r.session; as ses) {
        @if (ses.startedAt) {
          <div class="foot">
            <button class="btn" (click)="openFolder(ses.id)">Open branch folder</button>
            <span class="path selectable">{{ ses.worktreePath }}</span>
            <span class="spacer"></span>
            @if (ses.state === 'running' || ses.state === 'needs_input') {
              <button class="btn stop" (click)="stop(ses.id)">Stop session</button>
            }
          </div>
        }
      }
    } @else {
      <div class="none">
        <div>
          <div class="t">{{ emptyTitle() }}</div>
          <div class="s">{{ emptySub() }}</div>
          @if (store.attention().length > 0) {
            <div class="alist">
              @for (a of store.attention(); track a.item.id) {
                <button (click)="store.select(a.item.id)">
                  <fm-status-icon [status]="a.icon" [size]="14" />
                  <span class="id">{{ a.item.id }}</span>
                  <span class="name">{{ a.item.title }}</span>
                  <span class="lbl" [style.color]="'var(--' + a.tone + ')'">{{ a.label }}</span>
                </button>
              }
            </div>
            <div class="hintline">Press <span class="kbd">N</span> to jump to the next one.</div>
          }
        </div>
      </div>
    }
  `,
})
export class DetailPane {
  protected readonly store = inject(Store);
  protected readonly leaf = leaf;
  protected readonly elapsed = elapsed;
  protected readonly row = this.store.selected;
  protected readonly prStatuses: ItemStatus[] = ['no_pr', 'pr_checks', 'fixing'];
  protected readonly launchable: ItemStatus[] = ['not_started', 'finished', 'cancelled', 'failed', 'stuck'];

  protected readonly emptyTitle = computed(() => {
    const n = this.store.attention().length;
    if (this.store.items().length === 0) return 'No work items match these filters';
    if (n > 0) return `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you`;
    return this.store.activeCount() > 0 ? 'Nothing needs you right now' : 'Select a work item';
  });
  protected readonly emptySub = computed(() => {
    if (this.store.items().length === 0) return 'Change the sprint or person in the top bar, or reset to your defaults.';
    if (this.store.attention().length > 0) return "Select one to see what it's waiting for.";
    return this.store.activeCount() > 0
      ? "Sessions are running. You'll get a notification when one needs input or fails."
      : 'Pick an item from the list to read it and start a session.';
  });

  /** Linked items and comments are fetched on open, cached per item revision. */
  private readonly cache = signal(new Map<string, Detail>());
  private readonly key = computed(() => {
    const r = this.row();
    return r ? `${r.item.id}@${r.item.rev}` : null;
  });
  protected readonly detail = computed(() => {
    const k = this.key();
    return k ? (this.cache().get(k) ?? null) : null;
  });
  protected readonly detailError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const key = this.key();
      const id = this.row()?.item.id;
      if (!key || id === undefined || this.cache().has(key)) return;
      this.detailError.set(null);
      backend.workItemDetail(id).then(
        (d) => this.cache.update((m) => new Map(m).set(key, d)),
        (err) => {
          if (this.key() === key) this.detailError.set(errorMessage(err));
        },
      );
    });
  }

  protected openFolder(sessionId: string): void {
    void this.store.run(() => backend.openWorktree(sessionId));
  }

  protected stop(sessionId: string): void {
    void this.store.run(() => backend.stopSession(sessionId));
  }

  protected openInDevOps(id: number): void {
    void this.store.run(() => backend.openWorkItem(id));
  }

  /** Links inside work item text open in the default browser, never inside the app. */
  protected onRichClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    ev.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) void this.store.run(() => backend.openUrl(href));
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
