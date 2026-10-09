import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { backend, Check } from './backend';
import { StatusIcon } from './icons';
import { Row, Store, ago } from './store';

/** PR status for a work item: what failed, the one action it needs, and every check. */
@Component({
  selector: 'fm-pr-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  styles: `
    :host { display: flex; flex-direction: column; gap: 20px; }
    .prcard { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .prcard .l1 { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .prcard .num { font-family: var(--mono); font-weight: 600; }
    .prcard .name { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prcard .l2 { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; color: var(--text2); flex-wrap: wrap; }
    .link { border: 0; background: transparent; padding: 0; color: var(--text2); white-space: nowrap; font-size: 12px; }
    .link:hover { text-decoration: underline; color: var(--text); }
    .panel { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .panel.fail { border-color: var(--fail); background: var(--fail-bg); }
    .panel.stuck { border: 2px solid var(--fail); background: var(--fail-bg); }
    .panel.pass { border-color: var(--pass); background: var(--pass-bg); }
    .panel.run { border-color: var(--run); background: var(--run-bg); }
    .panel.merge { background: var(--merge-bg); }
    .panel .body { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 3px; }
    .panel .body b { font-weight: 600; font-size: 14px; }
    .panel .body span { font-size: 12.5px; color: var(--text2); text-wrap: pretty; }
    .act { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
    .act .btn { height: 36px; padding: 0 18px; font-size: 13.5px; }
    .act small { font-family: var(--mono); font-size: 11.5px; color: var(--text2); }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .head .sum { font-size: 12px; color: var(--text2); }
    .head .poll { font-size: 12px; color: var(--text3); }
    .card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .check { border-top: 1px solid var(--border); }
    .check:first-child { border-top: 0; }
    .crow { display: flex; align-items: center; gap: 10px; padding: 8px 14px; }
    .crow .cname { width: 160px; flex: none; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crow .res { flex: 1; min-width: 0; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crow .res.failed { color: var(--fail); }
    .more { height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px; background: transparent; font-size: 12px; color: var(--text2); }
    .more:hover { background: var(--hover); }
    .detail { padding: 0 14px 12px 39px; display: flex; flex-direction: column; gap: 6px; }
    .log { font-family: var(--mono); font-size: 12px; line-height: 1.6; background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; white-space: pre; overflow: auto; max-height: 300px; user-select: text; -webkit-user-select: text; }
    .log .err { color: var(--fail); }
    .issue { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
    .issue .loc { font-family: var(--mono); font-size: 12px; color: var(--text2); }
    .issue .txt { text-wrap: pretty; line-height: 1.5; user-select: text; -webkit-user-select: text; }
    @media (max-width: 1100px) { .crow .cname { width: 130px; } }
  `,
  template: `
    @let r = row();
    @if (r.pr; as pr) {
      <div class="prcard">
        <div class="l1">
          <span class="num">!{{ pr.id }}</span>
          <span class="name">{{ pr.title || 'Pull request' }}</span>
          <button class="link" (click)="open(pr.webUrl)">Open PR in DevOps ↗</button>
        </div>
        <div class="l2"><span>{{ pr.branch }}</span><span style="color:var(--text3)">→</span><span>{{ pr.targetBranch }}</span></div>
      </div>
    }

    @switch (r.status) {
      @case ('pr_failed') {
        <div class="panel fail">
          <fm-status-icon status="failed" [size]="20" />
          <div class="body"><b>PR failed</b><span>{{ r.pr?.failSummary }}. Fix it resumes the session with the details below.</span></div>
          <div class="act">
            <button class="btn primary" data-primary [disabled]="busy()" (click)="fix()">Fix it</button>
            <small>Attempt {{ (r.pr?.fixAttempts ?? 0) + 1 }} of {{ r.pr?.maxAttempts }}</small>
          </div>
        </div>
      }
      @case ('no_pr') {
        <div class="panel fail">
          <fm-status-icon status="failed" [size]="20" />
          <div class="body"><b>No PR raised</b><span>The session finished but no pull request was found for {{ r.session?.branch }}. Fix it resumes the session and asks Claude to push and open one.</span></div>
          <div class="act"><button class="btn primary" data-primary [disabled]="busy()" (click)="fix()">Fix it</button></div>
        </div>
      }
      @case ('fixing') {
        <div class="panel run">
          <fm-status-icon status="fixing" [size]="20" />
          <div class="body"><b>{{ r.pr ? 'Fix attempt ' + r.pr.fixAttempts + ' of ' + r.pr.maxAttempts : 'Raising the pull request' }}</b><span>Claude is working through the failures. The checks re-run when it pushes.</span></div>
        </div>
      }
      @case ('stuck') {
        <div class="panel stuck">
          <fm-status-icon status="stuck" [size]="22" />
          <div class="body"><b>Stuck — {{ r.pr?.fixAttempts }} of {{ r.pr?.maxAttempts }} fix attempts failed</b><span>Automatic fixes are used up. {{ r.pr?.failSummary }}. This one needs you: open it in DevOps, or start a manual session below.</span></div>
          <div class="act"><button class="btn" data-primary (click)="open(r.pr?.webUrl ?? '')">Open in DevOps ↗</button></div>
        </div>
      }
      @case ('ready') {
        <div class="panel pass">
          <fm-status-icon status="ready" [size]="20" />
          <div class="body">
            <b>Ready to merge</b>
            <span>All required checks passed, there are no conflicts and the review approved the latest push.</span>
            <span>{{ mergeNote() }} <span class="mono">{{ r.pr?.branch }}</span></span>
          </div>
          <div class="act">
            <button class="btn primary" data-primary [disabled]="busy() || merging()" (click)="merge()">{{ merging() ? 'Merging…' : 'Complete merge' }}</button>
            <small style="font-family:var(--sans)">Nothing merges automatically</small>
          </div>
        </div>
      }
      @case ('pr_checks') {
        <div class="panel">
          <fm-status-icon status="pr_checks" [size]="18" />
          <div class="body"><b>{{ r.pr ? 'Checks running — nothing needs you yet' : 'Looking for the pull request' }}</b><span>You'll get a notification if a check fails or the PR is ready to merge.</span></div>
        </div>
      }
      @case ('merged') {
        <div class="panel merge">
          <fm-status-icon status="merged" [size]="18" />
          <div class="body"><b>Merged into {{ r.pr?.targetBranch }}</b><span>The pull request is complete{{ r.pr?.cleaned ? '; the worktree and local branch were removed' : '' }}.</span></div>
        </div>
      }
    }

    @if (r.pr; as pr) {
      @if (pr.checks.length > 0) {
        <div>
          <div class="head">
            <span class="caps">Checks</span>
            <span class="sum">{{ summary() }}</span>
            <span class="spacer"></span>
            <span class="poll">{{ pr.lastPolledAt ? 'Checked ' + ago(pr.lastPolledAt, store.nowCoarse()) + ' ago' : '' }}</span>
            <button class="more" title="Check now" (click)="refresh()">↻</button>
          </div>
          <div class="card">
            @for (c of pr.checks; track c.name) {
              <div class="check">
                <div class="crow">
                  <fm-status-icon [status]="c.state" [size]="15" [animate]="false" />
                  <span class="cname">{{ c.name }}</span>
                  <span class="res" [class.failed]="c.state === 'failed'">{{ c.result }}</span>
                  @if (expandable(c)) {
                    <button class="more" [attr.aria-expanded]="isOpen(c)" (click)="toggle(c)">{{ isOpen(c) ? 'Hide' : c.logLines.length ? 'Show log' : 'Show issues' }}</button>
                  }
                </div>
                @if (expandable(c) && isOpen(c)) {
                  <div class="detail">
                    @if (c.logLines.length > 0) {
                      <div class="log scroll">@for (l of c.logLines; track $index) {<div [class.err]="isError(l)">{{ l }}</div>}</div>
                    }
                    @for (i of c.issues; track $index) {
                      <div class="issue">
                        <span class="loc">{{ i.severity }}{{ i.location ? ' · ' + i.location : '' }}</span>
                        <span class="txt">{{ i.text }}</span>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        </div>
      }
    }
  `,
})
export class PrPanel {
  protected readonly store = inject(Store);
  protected readonly ago = ago;
  readonly row = input.required<Row>();
  protected readonly busy = signal(false);
  /** Failed checks start expanded; the user's toggles override that. */
  private readonly toggled = signal<Record<string, boolean>>({});

  protected readonly summary = computed(() => {
    const checks = this.row().pr?.checks ?? [];
    const failed = checks.filter((c) => c.state === 'failed').length;
    const passed = checks.filter((c) => c.state === 'passed').length;
    return failed ? `${failed} failed · ${passed} passed` : `${passed} of ${checks.length} passed`;
  });

  protected expandable(c: Check): boolean {
    return c.logLines.length > 0 || c.issues.length > 0;
  }

  protected isOpen(c: Check): boolean {
    return this.toggled()[c.name] ?? c.state === 'failed';
  }

  protected toggle(c: Check): void {
    this.toggled.update((t) => ({ ...t, [c.name]: !this.isOpen(c) }));
  }

  protected isError(line: string): boolean {
    return /##\[error\]|\bFailed\b|Exception|error /.test(line);
  }

  protected open(url: string): void {
    if (url) void this.store.run(() => backend.openUrl(url));
  }

  protected refresh(): void {
    void this.store.run(() => backend.refreshPrs());
  }

  /** True from the click until DevOps reports the PR as completed. */
  protected readonly merging = signal(false);

  protected readonly mergeNote = computed(() => {
    const s = this.store.settings();
    const strategy = { squash: 'Squash merge', noFastForward: 'Merge commit', rebase: 'Rebase and fast-forward', rebaseMerge: 'Rebase with merge commit' }[s?.mergeStrategy ?? 'squash'];
    return `${strategy}${s?.deleteSourceBranch ? ' and delete' : ', keeping'}`;
  });

  /** Complete merge only ever happens from this click (FR6.3). */
  protected async merge(): Promise<void> {
    this.merging.set(true);
    const ok = await this.store.run(() => backend.completeMerge(this.row().item.id).then(() => true));
    // On success the panel is replaced when the next poll reports the merge; give up waiting after a while.
    setTimeout(() => this.merging.set(false), ok ? 30000 : 0);
  }

  protected async fix(): Promise<void> {
    this.busy.set(true);
    await this.store.run(() => backend.fixPr(this.row().item.id));
    this.busy.set(false);
  }
}
