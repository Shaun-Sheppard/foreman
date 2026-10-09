import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { backend, LogEntry, Session } from './backend';
import { StatusIcon } from './icons';
import { Store, elapsed } from './store';

interface LogLine {
  time: string;
  kind: LogEntry['kind'];
  tool: string;
  text: string;
  /** Tool output, shown when the line is expanded. */
  result: string | null;
  failed: boolean;
  key: string;
}

const SHOWN_LOG_LINES = 300;

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Everything about one session: what it needs from you, its steps and its activity log. */
@Component({
  selector: 'fm-session-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  styles: `
    :host { display: flex; flex-direction: column; gap: 20px; }
    .panel { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .panel.dashed { border-style: dashed; border-color: var(--border2); }
    .panel.fail { border-color: var(--fail); background: var(--fail-bg); }
    .panel.pass { border-color: var(--pass); background: var(--pass-bg); }
    .panel .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .panel .body b { font-weight: 600; }
    .panel .body span { font-size: 12.5px; color: var(--text2); text-wrap: pretty; white-space: pre-wrap; overflow-wrap: anywhere; }
    .needs { border: 1px solid var(--att); border-radius: 8px; background: var(--att-bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .needs .top { display: flex; align-items: center; gap: 8px; }
    .needs .top b { font-weight: 600; }
    .kind { font-family: var(--mono); font-size: 11px; color: var(--text2); border: 1px solid var(--border2); border-radius: 4px; padding: 0 6px; }
    .waiting { font-size: 12px; color: var(--text2); }
    .qtext { text-wrap: pretty; line-height: 1.5; }
    .cmd { font-family: var(--mono); font-size: 12px; background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; }
    .choices { display: flex; flex-wrap: wrap; gap: 6px; }
    .choice { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 10px; border: 1px solid var(--border2); border-radius: 6px; background: var(--btn2); text-align: left; max-width: 260px; }
    .choice.on { border-color: var(--text); background: var(--sel); }
    .choice small { font-size: 11.5px; color: var(--text2); }
    .actions { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
    .actions input { flex: 1; min-width: 220px; height: 32px; }
    .actions .btn { height: 32px; }
    .keys { font-family: var(--mono); font-size: 10.5px; opacity: 0.7; margin-left: 8px; }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .prog { font-family: var(--mono); font-size: 12px; color: var(--text2); }
    .segs { flex: 1; max-width: 180px; display: flex; gap: 2px; }
    .segs div { flex: 1; height: 4px; border-radius: 1px; background: var(--border2); }
    .segs div.completed { background: var(--pass); }
    .segs div.in_progress { background: var(--run); }
    .card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .step { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-top: 1px solid var(--border); }
    .step:first-child { border-top: 0; }
    .step.in_progress { background: var(--run-bg); font-weight: 500; }
    .step.pending { color: var(--text2); }
    .step .n { font-family: var(--mono); font-size: 11px; color: var(--text3); width: 16px; text-align: right; flex: none; }
    .step span:last-child { flex: 1; min-width: 0; }
    .logbar { width: 100%; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border: 0; background: var(--surface); text-align: left; }
    .chev { width: 10px; font-size: 9px; color: var(--text3); flex: none; }
    .log { background: var(--code); border-top: 1px solid var(--border); padding: 6px 0; font-family: var(--mono); font-size: 12px; line-height: 1.65; max-height: 320px; user-select: text; -webkit-user-select: text; }
    .line { display: flex; gap: 10px; padding: 0 12px; }
    .line.can { cursor: pointer; }
    .line:hover { background: var(--hover); }
    .line .t { color: var(--text3); flex: none; }
    .line .tool { color: var(--run); font-weight: 500; flex: none; width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .line .arg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .line.text .arg { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--sans); font-size: 12.5px; }
    .line.info .tool, .line.info .arg { color: var(--text3); }
    .line.error .tool, .line.error .arg, .line.bad .tool { color: var(--fail); }
    .out { margin: 2px 12px 4px 108px; padding-left: 10px; border-left: 1px solid var(--border2); color: var(--text2); white-space: pre-wrap; overflow-wrap: anywhere; }
    .muted { padding: 6px 12px; color: var(--text3); }
  `,
  template: `
    @let s = session();

    @if (s.pending; as p) {
      <div class="needs" role="alert">
        <div class="top">
          <fm-status-icon status="needs_input" [size]="16" />
          <b>{{ p.title }}</b>
          <span class="kind">{{ p.kind }}</span>
          <span class="spacer"></span>
          <span class="waiting tnum">Waiting {{ elapsed(p.since, store.now()) }}</span>
        </div>
        @if (p.kind === 'question') {
          @for (q of p.questions ?? []; track q.question) {
            <div class="qtext">{{ q.question }}</div>
            <div class="choices">
              @for (o of q.options; track o.label) {
                <button class="choice" [class.on]="chosen()[q.question] === o.label" (click)="choose(q.question, o.label)">
                  <span style="font-weight:500">{{ o.label }}</span>
                  @if (o.description) {
                    <small>{{ o.description }}</small>
                  }
                </button>
              }
            </div>
          }
        } @else if (p.text) {
          <div class="qtext">{{ p.text }}</div>
        }
        @if (p.detail) {
          <div class="cmd selectable">{{ p.detail }}</div>
        }
        <div class="actions">
          <input
            class="field"
            [placeholder]="p.kind === 'question' ? 'Or type your own answer' : 'Reply to Claude (optional), sent if you deny'"
            [value]="reply()"
            (input)="reply.set($any($event.target).value)"
            (keydown.control.enter)="primary()"
            (keydown.meta.enter)="primary()"
          />
          @if (p.kind === 'question') {
            <button class="btn primary" data-primary [disabled]="!canAnswer()" (click)="sendAnswer()">Send answer<span class="keys">Ctrl ↵</span></button>
            <button class="btn" (click)="deny()">Skip</button>
          } @else {
            <button class="btn primary" data-primary (click)="approve()">Approve<span class="keys">Ctrl ↵</span></button>
            <button class="btn" (click)="deny()">Deny</button>
          }
        </div>
      </div>
    }

    @switch (s.state) {
      @case ('queued') {
        <div class="panel dashed">
          <fm-status-icon status="queued" [size]="18" />
          <div class="body"><b>Queued{{ s.queuePosition === 1 ? ' — next in line' : '' }}</b><span>Position {{ s.queuePosition }} in the queue. It starts when a session slot frees.</span></div>
          <button class="btn" (click)="stop()">Remove from queue</button>
        </div>
      }
      @case ('cancelled') {
        <div class="panel">
          <fm-status-icon status="cancelled" [size]="18" />
          <div class="body"><b>Session stopped</b><span>The worktree and branch {{ s.branch }} were kept.</span></div>
          <button class="btn primary" data-primary (click)="resume()">Resume session</button>
        </div>
      }
      @case ('failed') {
        <div class="panel fail">
          <fm-status-icon status="failed" [size]="20" />
          <div class="body"><b>Session failed</b><span class="selectable">{{ s.error || 'The session ended with an error.' }}</span></div>
          <button class="btn primary" data-primary (click)="resume()">{{ s.startedAt ? 'Resume session' : 'Try again' }}</button>
        </div>
      }
      @case ('interrupted') {
        <div class="panel fail">
          <fm-status-icon status="failed" [size]="20" />
          <div class="body"><b>Interrupted</b><span class="selectable">{{ s.error || 'The session stopped before it finished' }}. Resume picks up with its full context.</span></div>
          <button class="btn primary" data-primary (click)="resume()">Resume session</button>
        </div>
      }
      @case ('done') {
        @if (showOutcome()) {
        <div class="panel pass">
          <fm-status-icon status="done" [size]="20" />
          <div class="body"><b>Session finished</b><span>{{ summary() }}</span></div>
        </div>
        }
      }
    }

    @if (s.steps.length > 0) {
      <div>
        <div class="head">
          <span class="caps">{{ s.mode === 'fix' ? 'Fix steps' : 'Steps' }}</span>
          <span class="prog">{{ doneCount() }} of {{ s.steps.length }}</span>
          <div class="segs">
            @for (st of s.steps; track $index) {
              <div [class]="st.state"></div>
            }
          </div>
        </div>
        <div class="card">
          @for (st of s.steps; track $index) {
            <div class="step" [class]="st.state === 'in_progress' && !live() ? 'pending' : st.state">
              <span class="n">{{ $index + 1 }}</span>
              <fm-status-icon [status]="st.state === 'completed' ? 'done' : st.state === 'in_progress' ? (s.state === 'needs_input' ? 'needs_input' : live() ? 'running' : 'pending') : 'pending'" [size]="15" />
              <span>{{ st.text }}</span>
            </div>
          }
        </div>
      </div>
    }

    @if (s.state !== 'queued') {
      <div class="card">
        <button class="logbar" [attr.aria-expanded]="logOpen()" (click)="logOpen.set(!logOpen())">
          <span class="chev">{{ logOpen() ? '▼' : '▶' }}</span>
          <span class="caps">Activity</span>
          <span style="font-size:12px;color:var(--text3)">{{ lines().length }} {{ lines().length === 1 ? 'entry' : 'entries' }}{{ hidden() ? ' · showing the latest ' + lines().length : '' }}</span>
        </button>
        @if (logOpen()) {
          <div class="log scroll">
            @for (l of lines(); track l.key) {
              <div class="line" [class]="l.kind" [class.bad]="l.failed" [class.can]="l.result !== null" (click)="toggle(l)">
                <span class="t">{{ l.time }}</span>
                <span class="chev">{{ l.result === null ? '' : open()[l.key] ? '▼' : '▶' }}</span>
                @if (l.kind !== 'text') {
                  <span class="tool">{{ l.tool }}</span>
                }
                <span class="arg">{{ l.text }}</span>
              </div>
              @if (l.result !== null && open()[l.key]) {
                <div class="out">{{ l.result || '(no output)' }}</div>
              }
            } @empty {
              <div class="muted">Nothing yet.</div>
            }
          </div>
        }
      </div>
    }

  `,
})
export class SessionPanel {
  protected readonly store = inject(Store);
  protected readonly elapsed = elapsed;
  readonly session = input.required<Session>();
  /** Off when a PR panel above already says how the session turned out. */
  readonly showOutcome = input(true);

  protected readonly live = computed(() => this.session().state === 'running' || this.session().state === 'needs_input');
  protected readonly doneCount = computed(() => this.session().steps.filter((s) => s.state === 'completed').length);
  protected readonly logOpen = signal(true);
  protected readonly open = signal<Record<string, boolean>>({});
  protected readonly reply = signal('');
  protected readonly chosen = signal<Record<string, string>>({});

  private readonly entries = computed(() => this.store.logs()[this.session().id] ?? []);
  protected readonly hidden = computed(() => this.entries().length > SHOWN_LOG_LINES);

  /** Tool results fold into the line of the call that produced them; long logs show only their tail (NFR3). */
  protected readonly lines = computed<LogLine[]>(() => {
    const out: LogLine[] = [];
    const byId = new Map<string, LogLine>();
    this.entries().forEach((e, i) => {
      if ((e.kind === 'result' || e.kind === 'error') && e.id && byId.has(e.id)) {
        const call = byId.get(e.id)!;
        call.result = e.text;
        call.failed = e.kind === 'error';
        return;
      }
      // The step list has its own section, so its bookkeeping calls stay out of the log.
      if (e.kind === 'tool' && (e.tool === 'TodoWrite' || e.tool === 'TaskCreate' || e.tool === 'TaskUpdate')) return;
      if (e.kind === 'result') return;
      const line: LogLine = {
        time: clock(e.ts), kind: e.kind, tool: e.kind === 'tool' ? (e.tool ?? '') : e.kind === 'error' ? 'error' : e.kind === 'info' ? '·' : '',
        text: e.text, result: null, failed: false, key: String(i),
      };
      if (e.kind === 'tool' && e.id) byId.set(e.id, line);
      out.push(line);
    });
    return out.slice(-SHOWN_LOG_LINES);
  });

  protected readonly canAnswer = computed(() => {
    const p = this.session().pending;
    if (!p) return false;
    return !!this.reply().trim() || (p.questions ?? []).every((q) => this.chosen()[q.question]);
  });

  protected readonly summary = computed(() => {
    const s = this.session();
    const parts = [`Branch ${s.branch}`];
    if (s.startedAt && s.endedAt) parts.push(`took ${elapsed(s.startedAt, Date.parse(s.endedAt))}`);
    if (s.costUsd !== null) parts.push(`$${s.costUsd.toFixed(2)}`);
    return parts.join(' · ');
  });

  constructor() {
    effect(() => {
      const id = this.session().id;
      untracked(() => void this.store.loadLog(id));
    });
    // A new request starts with a clean reply box.
    effect(() => {
      this.session().pending?.requestId;
      untracked(() => {
        this.reply.set('');
        this.chosen.set({});
      });
    });
  }

  protected toggle(l: LogLine): void {
    if (l.result !== null) this.open.update((o) => ({ ...o, [l.key]: !o[l.key] }));
  }

  protected choose(question: string, label: string): void {
    this.chosen.update((c) => ({ ...c, [question]: c[question] === label ? '' : label }));
  }

  protected primary(): void {
    if (this.session().pending?.kind === 'question') this.sendAnswer();
    else this.approve();
  }

  private send(action: 'approve' | 'deny' | 'reply', message: string | null, answers: Record<string, string> | null): void {
    const s = this.session();
    if (s.pending) void this.store.run(() => backend.answerSession(s.id, s.pending!.requestId, action, message, answers));
  }

  protected approve(): void {
    this.send('approve', null, null);
  }

  protected deny(): void {
    this.send('deny', this.reply().trim() || null, null);
  }

  protected sendAnswer(): void {
    if (!this.canAnswer()) return;
    const typed = this.reply().trim();
    const answers: Record<string, string> = {};
    for (const q of this.session().pending?.questions ?? []) answers[q.question] = typed || this.chosen()[q.question];
    this.send('reply', null, answers);
  }

  protected stop(): void {
    void this.store.run(() => backend.stopSession(this.session().id));
  }

  protected resume(): void {
    void this.store.run(() => backend.resumeSession(this.session().id));
  }

}
