import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { backend, Detail, errorMessage, MODELS } from './backend';
import { StatusIcon, TypeIcon } from './icons';
import { PrPanel } from './pr-panel';
import { ItemStatus, Store, elapsed, leaf } from './store';

/** Everything about the selected item that isn't the conversation: progress, PR state, branch and the work item itself. */
@Component({
  selector: 'fm-side-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, TypeIcon, PrPanel],
  styles: `
    :host { width: 380px; flex: none; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--surface); min-height: 0; }
    @media (max-width: 1300px) { :host { width: 330px; } }
    .body { flex: 1; min-height: 0; padding: 14px 16px 24px; display: flex; flex-direction: column; gap: 18px; }
    section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px 0 6px; border-radius: 999px; background: var(--mute-bg); color: var(--text3); font-weight: 600; font-size: 12px; width: max-content; }
    .badge.run { background: var(--run-bg); color: var(--run); }
    .badge.att { background: var(--att-bg); color: var(--att); }
    .badge.fail { background: var(--fail-bg); color: var(--fail); }
    .badge.pass { background: var(--pass-bg); color: var(--pass); }
    .badge.merge { background: var(--merge-bg); color: var(--merge); }
    .badge.text2 { color: var(--text2); }
    .why { font-size: 12.5px; color: var(--text2); text-wrap: pretty; overflow-wrap: anywhere; }
    .head { display: flex; align-items: center; gap: 10px; }
    .prog { font-family: var(--mono); font-size: 12px; color: var(--text2); }
    .segs { flex: 1; display: flex; gap: 2px; }
    .segs div { flex: 1; height: 4px; border-radius: 1px; background: var(--border2); }
    .segs div.completed { background: var(--pass); }
    .segs div.in_progress { background: var(--run); }
    .card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg); }
    .step { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--border); font-size: 12.5px; }
    .step:first-child { border-top: 0; }
    .step.in_progress { background: var(--run-bg); font-weight: 500; }
    .step.pending { color: var(--text2); }
    .step fm-status-icon { margin-top: 1px; }
    .kv { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 5px 10px; font-size: 12.5px; }
    .kv i { font-style: normal; color: var(--text3); }
    .kv .v { min-width: 0; overflow-wrap: anywhere; }
    .kv .mono { font-size: 11.5px; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; }
    .muted { color: var(--text3); font-size: 12.5px; }
    .lrow { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 0; border-top: 1px solid var(--border); background: transparent; text-align: left; font-size: 12.5px; }
    .lrow:first-child { border-top: 0; }
    .lrow:hover { background: var(--hover); }
    .lrow .id { font-family: var(--mono); font-size: 11.5px; color: var(--text2); flex: none; }
    .lrow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .comment { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-top: 1px solid var(--border); font-size: 12.5px; }
    .comment:first-child { border-top: 0; }
    .comment .who { font-weight: 500; display: flex; gap: 8px; align-items: baseline; }
    .comment .when { font-family: var(--mono); font-size: 11px; color: var(--text3); font-weight: 400; }
    .rich { font-size: 12.5px; }
  `,
  template: `
    @if (row(); as r) {
      <div class="body scroll" (click)="onRichClick($event)">
        <section>
          <span class="badge" [class]="r.tone"><fm-status-icon [status]="r.icon" [size]="13" />{{ r.label }}</span>
          @if (r.session && r.reason) {
            <span class="why">{{ r.reason }}</span>
          }
        </section>

        @if (r.session; as s) {
          @if (s.steps.length > 0) {
            <section>
              <div class="head">
                <span class="caps">Progress</span>
                <span class="prog">{{ r.done }} of {{ r.total }}</span>
                <div class="segs">
                  @for (st of s.steps; track $index) {
                    <div [class]="st.state"></div>
                  }
                </div>
              </div>
              <div class="card">
                @for (st of s.steps; track $index) {
                  <div class="step" [class]="st.state === 'in_progress' && !live() ? 'pending' : st.state">
                    <fm-status-icon [status]="st.state === 'completed' ? 'done' : st.state === 'in_progress' && live() ? (s.state === 'needs_input' ? 'needs_input' : 'running') : 'pending'" [size]="14" />
                    <span>{{ st.text }}</span>
                  </div>
                }
              </div>
            </section>
          }

          @if (r.pr || prStatuses.includes(r.status)) {
            <section>
              <span class="caps">Pull request</span>
              <fm-pr-panel [row]="r" />
            </section>
          } @else if (s.startedAt) {
            <section>
              <span class="caps">Pull request</span>
              <span class="muted">None yet. Foreman checks for one from this branch every minute and shows its checks here.</span>
            </section>
          }

          <section>
            <span class="caps">Session</span>
            <div class="kv">
              <i>Branch</i><span class="v mono selectable">{{ s.branch }}</span>
              <i>Based on</i><span class="v mono">{{ s.baseBranch }}</span>
              <i>Mode</i><span class="v">{{ s.mode === 'review' ? 'Review' : 'Implement' }}</span>
              <i>Model</i><span class="v">{{ modelName(s.model) }}</span>
              @if (s.startedAt) {
                <i>Started</i><span class="v">{{ when(s.startedAt) }}</span>
              }
              @if (s.costUsd !== null) {
                <i>Cost so far</i><span class="v mono">\${{ s.costUsd.toFixed(2) }}</span>
              }
              <i>Folder</i><span class="v mono selectable">{{ s.worktreePath }}</span>
            </div>
            <div class="btns">
              <button class="btn sm" (click)="openFolder(s.id)">Open folder</button>
              <button class="btn sm" [disabled]="live()" [title]="live() ? 'Available when Claude is not working' : 'Continue this conversation in the Claude desktop app'" (click)="openDesktop(s.id)">Open in Claude desktop ↗</button>
            </div>
          </section>
        }

        <section>
          <span class="caps">Work item</span>
          <div class="kv">
            <i>State</i><span class="v">{{ r.item.state }}</span>
            <i>Assignee</i><span class="v">{{ r.item.assignedTo?.displayName ?? 'Unassigned' }}</span>
            <i>Iteration</i><span class="v">{{ leaf(r.item.iterationPath) }}</span>
            @if (r.item.priority !== null) {
              <i>Priority</i><span class="v">{{ r.item.priority }}</span>
            }
          </div>
        </section>

        <section>
          <span class="caps">Description</span>
          @if (r.item.descriptionHtml.trim()) {
            <div class="rich selectable" [innerHTML]="r.item.descriptionHtml"></div>
          } @else {
            <span class="muted">No description.</span>
          }
        </section>

        <section>
          <span class="caps">Acceptance criteria</span>
          @if (r.item.acceptanceHtml.trim()) {
            <div class="rich ac selectable" [innerHTML]="r.item.acceptanceHtml"></div>
          } @else {
            <span class="muted">None recorded.</span>
          }
        </section>

        @if (r.item.links.length > 0) {
          <section>
            <span class="caps">Linked items</span>
            @if (detail(); as d) {
              <div class="card">
                @for (l of d.linked; track l.id) {
                  <button class="lrow" (click)="openInDevOps(l.id)" [title]="l.rel + ' · ' + l.state + ' · open in DevOps'">
                    <fm-type-icon [type]="l.type" [size]="13" />
                    <span class="id">{{ l.id }}</span>
                    <span class="name">{{ l.title }}</span>
                  </button>
                }
              </div>
            } @else {
              <span class="muted">{{ detailError() ?? 'Loading…' }}</span>
            }
          </section>
        }

        <section>
          <span class="caps">Latest comments</span>
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
              <span class="muted">No comments.</span>
            }
          } @else {
            <span class="muted">{{ detailError() ?? 'Loading…' }}</span>
          }
        </section>
      </div>
    }
  `,
})
export class SidePanel {
  protected readonly store = inject(Store);
  protected readonly leaf = leaf;
  protected readonly elapsed = elapsed;
  protected readonly row = this.store.selected;
  protected readonly prStatuses: ItemStatus[] = ['pr_checks', 'fixing', 'pr_failed', 'ready', 'stuck', 'merged'];
  protected readonly live = computed(() => ['queued', 'running', 'needs_input'].includes(this.row()?.session?.state ?? ''));

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

  protected modelName(id: string): string {
    return MODELS.find((m) => m.id === id)?.label ?? id;
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  protected openFolder(sessionId: string): void {
    void this.store.run(() => backend.openWorktree(sessionId));
  }

  protected openDesktop(sessionId: string): void {
    void this.store.run(() => backend.openInDesktop(sessionId));
  }

  protected openInDevOps(id: number): void {
    void this.store.run(() => backend.openWorkItem(id));
  }

  /** Links inside work item text open in the default browser, never inside the app. */
  protected onRichClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a || !(ev.target as HTMLElement).closest('.rich')) return;
    ev.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) void this.store.run(() => backend.openUrl(href));
  }
}
