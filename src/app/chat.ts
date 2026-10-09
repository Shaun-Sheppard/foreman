import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { marked } from 'marked';
import { backend, ImageUpload, LogEntry } from './backend';
import { StatusIcon, TypeIcon } from './icons';
import { Launcher } from './launcher';
import { Store, elapsed } from './store';

interface Line {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'info' | 'error' | 'brief';
  time: string;
  text: string;
  /** Rendered markdown, for assistant messages. */
  html: string;
  tool: string;
  /** Tool output, shown when the line is expanded. */
  result: string | null;
  failed: boolean;
  images: number;
  label: string;
}

interface Attachment extends ImageUpload {
  /** Data URL for the thumbnail. */
  preview: string;
}

const SHOWN_LINES = 400;
const HIDDEN_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'mcp__foreman__set_steps'];

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The conversation with Claude about one work item. */
@Component({
  selector: 'fm-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, TypeIcon, Launcher],
  styles: `
    :host { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }
    .hdr { flex: none; padding: 12px 24px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; background: var(--surface); }
    .crumb { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text2); min-width: 0; }
    .crumb .id { font-family: var(--mono); color: var(--text); }
    .crumb .area { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link { border: 0; background: transparent; padding: 0; color: var(--text2); white-space: nowrap; font-size: 12px; }
    .link:hover { text-decoration: underline; color: var(--text); }
    .title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; text-wrap: pretty; }
    .start { flex: 1; min-height: 0; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
    .start .lead { font-size: 14px; font-weight: 600; }
    .start .sub { color: var(--text2); max-width: 640px; text-wrap: pretty; margin-top: -8px; }
    .feed { flex: 1; min-height: 0; padding: 18px 24px 8px; display: flex; flex-direction: column; gap: 10px; }
    .feed > * { max-width: 860px; width: 100%; margin: 0 auto; }
    .user { align-self: flex-end; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .bubble { max-width: 80%; padding: 8px 12px; border-radius: 12px 12px 3px 12px; background: var(--sel); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
    .chip { font-size: 11.5px; color: var(--text2); border: 1px solid var(--border2); border-radius: 999px; padding: 1px 8px; }
    .assistant { line-height: 1.6; }
    .tool { display: flex; flex-direction: column; font-family: var(--mono); font-size: 12px; }
    .tool .row { display: flex; gap: 8px; padding: 2px 6px; border-radius: 4px; color: var(--text2); }
    .tool .row.can { cursor: pointer; }
    .tool .row:hover { background: var(--hover); }
    .tool .chev { width: 10px; font-size: 9px; color: var(--text3); flex: none; padding-top: 3px; }
    .tool .name { color: var(--run); font-weight: 500; flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool .name.bad { color: var(--fail); }
    .tool .arg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .out { margin: 2px 6px 4px 24px; padding: 6px 10px; border-left: 1px solid var(--border2); color: var(--text2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }
    .note { font-size: 12px; color: var(--text3); display: flex; align-items: center; gap: 8px; }
    .note::before, .note::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .err { font-size: 12.5px; color: var(--fail); white-space: pre-wrap; overflow-wrap: anywhere; }
    .brief { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .brief button { width: 100%; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border: 0; background: transparent; text-align: left; color: var(--text2); }
    .brief pre { margin: 0; padding: 0 12px 10px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
    .working { display: flex; align-items: center; gap: 8px; color: var(--text2); font-size: 12.5px; padding: 2px 0 6px; }
    .needs { flex: none; margin: 0 24px 10px; border: 1px solid var(--att); border-radius: 8px; background: var(--att-bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .needs .top { display: flex; align-items: center; gap: 8px; }
    .needs .top b { font-weight: 600; }
    .kind { font-family: var(--mono); font-size: 11px; color: var(--text2); border: 1px solid var(--border2); border-radius: 4px; padding: 0 6px; }
    .cmd { font-family: var(--mono); font-size: 12px; background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; }
    .choices { display: flex; flex-wrap: wrap; gap: 6px; }
    .choice { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 10px; border: 1px solid var(--border2); border-radius: 6px; background: var(--btn2); text-align: left; max-width: 260px; }
    .choice.on { border-color: var(--text); background: var(--sel); }
    .choice small { font-size: 11.5px; color: var(--text2); }
    .acts { display: flex; gap: 8px; }
    .banner { flex: none; margin: 0 24px 10px; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--fail); border-radius: 8px; background: var(--fail-bg); }
    .banner span { flex: 1; min-width: 0; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 90px; overflow: auto; }
    .composer { flex: none; padding: 0 24px 16px; }
    .box { max-width: 860px; margin: 0 auto; border: 1px solid var(--border2); border-radius: 10px; background: var(--input); display: flex; flex-direction: column; }
    .box:focus-within { outline: 2px solid var(--run); outline-offset: 1px; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 8px 0; }
    .thumb { position: relative; width: 56px; height: 56px; border: 1px solid var(--border2); border-radius: 6px; overflow: hidden; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb button { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border: 0; border-radius: 50%; background: var(--btn); color: var(--btn-text); font-size: 11px; line-height: 16px; padding: 0; }
    textarea { border: 0; outline: none; resize: none; background: transparent; padding: 10px 12px 4px; font-family: var(--sans); font-size: 13px; line-height: 1.5; max-height: 200px; user-select: text; -webkit-user-select: text; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 4px 8px 8px 12px; font-size: 11.5px; color: var(--text3); }
    .stop { border-color: var(--fail); background: transparent; color: var(--fail); }
    .none { flex: 1; display: grid; place-items: center; padding: 24px; overflow: auto; }
    .none > div { width: min(440px, 100%); display: flex; flex-direction: column; gap: 12px; }
    .none .t { font-size: 16px; font-weight: 600; }
    .none .s { color: var(--text2); text-wrap: pretty; }
    .alist { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .alist button { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 0; border-top: 1px solid var(--border); background: transparent; text-align: left; }
    .alist button:first-child { border-top: 0; }
    .alist button:hover { background: var(--hover); }
    .alist .id { font-family: var(--mono); font-size: 12px; color: var(--text2); }
    .alist .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .alist .lbl { font-size: 12px; font-weight: 500; white-space: nowrap; }
  `,
  template: `
    @if (row(); as r) {
      <div class="hdr">
        <div class="crumb">
          <fm-type-icon [type]="r.item.type" [size]="13" />
          <span>{{ r.item.type }}</span>
          <span class="id selectable">#{{ r.item.id }}</span>
          <span style="color:var(--text3)">·</span>
          <span class="area">{{ r.item.areaPath }}</span>
          <span class="spacer"></span>
          @if (live() && r.session) {
            <span class="mono tnum">{{ elapsed(r.session.startedAt, store.now()) }}</span>
          }
          <button class="link" (click)="openInDevOps(r.item.id)">Open in DevOps ↗</button>
        </div>
        <div class="title selectable">{{ r.item.title }}</div>
      </div>

      @if (r.session; as s) {
        <div class="feed scroll" #feed (scroll)="onScroll()" (click)="onLinkClick($event)">
          @if (hidden()) {
            <div class="note">Showing the latest {{ lines().length }} entries</div>
          }
          @for (l of lines(); track l.key) {
            @switch (l.kind) {
              @case ('user') {
                <div class="user">
                  @if (l.text) {
                    <div class="bubble selectable">{{ l.text }}</div>
                  }
                  @if (l.images) {
                    <span class="chip">{{ l.images }} image{{ l.images === 1 ? '' : 's' }} attached</span>
                  }
                </div>
              }
              @case ('assistant') {
                <div class="assistant rich selectable" [innerHTML]="l.html"></div>
              }
              @case ('tool') {
                <div class="tool">
                  <div class="row" [class.can]="l.result !== null" (click)="toggle(l)">
                    <span class="chev">{{ l.result === null ? '' : open()[l.key] ? '▼' : '▶' }}</span>
                    <span class="name" [class.bad]="l.failed">{{ l.tool }}</span>
                    <span class="arg">{{ l.text }}</span>
                  </div>
                  @if (l.result !== null && open()[l.key]) {
                    <div class="out selectable">{{ l.result || '(no output)' }}</div>
                  }
                </div>
              }
              @case ('brief') {
                <div class="brief">
                  <button (click)="toggle(l)" [attr.aria-expanded]="!!open()[l.key]">
                    <span style="width:10px;font-size:9px;color:var(--text3)">{{ open()[l.key] ? '▼' : '▶' }}</span>
                    <span>{{ l.label }}</span>
                    <span class="spacer"></span>
                    <span class="mono" style="font-size:11px;color:var(--text3)">{{ l.time }}</span>
                  </button>
                  @if (open()[l.key]) {
                    <pre class="selectable">{{ l.text }}</pre>
                  }
                </div>
              }
              @case ('error') {
                <div class="err selectable">{{ l.text }}</div>
              }
              @default {
                <div class="note">{{ l.text }}</div>
              }
            }
          }
          @if (s.state === 'running') {
            <div class="working"><fm-status-icon [status]="s.turn === 'fix' ? 'fixing' : 'running'" [size]="14" />{{ r.reason || 'Working…' }}</div>
          } @else if (s.state === 'queued') {
            <div class="working"><fm-status-icon status="queued" [size]="14" [animate]="false" />Queued{{ s.queuePosition ? ' — position ' + s.queuePosition : '' }}. It starts when a session slot frees.</div>
          }
        </div>

        @if (s.pending; as p) {
          <div class="needs" role="alert">
            <div class="top">
              <fm-status-icon status="needs_input" [size]="16" />
              <b>{{ p.title }}</b>
              <span class="kind">{{ p.kind }}</span>
              <span class="spacer"></span>
              <span class="tnum" style="font-size:12px;color:var(--text2)">Waiting {{ elapsed(p.since, store.now()) }}</span>
            </div>
            @if (p.kind === 'question') {
              @for (q of p.questions ?? []; track q.question) {
                <div style="line-height:1.5;text-wrap:pretty">{{ q.question }}</div>
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
              <div class="acts">
                <button class="btn primary" data-primary [disabled]="!canAnswer()" (click)="answer()">Send answer</button>
                <button class="btn" (click)="deny()">Skip</button>
                <span class="spacer"></span>
                <span style="font-size:12px;color:var(--text3);align-self:center">or type your own answer below</span>
              </div>
            } @else {
              @if (p.detail) {
                <div class="cmd selectable">{{ p.detail }}</div>
              }
              <div class="acts">
                <button class="btn primary" data-primary (click)="approve()">Approve</button>
                <button class="btn" (click)="deny()">Deny</button>
              </div>
            }
          </div>
        }

        @if (s.state === 'failed' || s.state === 'interrupted') {
          <div class="banner">
            <fm-status-icon status="failed" [size]="16" />
            <span class="selectable">{{ s.state === 'interrupted' ? 'Interrupted. ' : '' }}{{ s.error || 'The session stopped with an error.' }}</span>
            <button class="btn primary" data-primary (click)="resume()">Resume</button>
          </div>
        }

        <div class="composer">
          <div class="box">
            @if (attachments().length > 0) {
              <div class="thumbs">
                @for (a of attachments(); track $index) {
                  <div class="thumb"><img [src]="a.preview" alt="Attached image" /><button aria-label="Remove image" (click)="removeAttachment($index)">×</button></div>
                }
              </div>
            }
            <textarea
              #input
              rows="1"
              [placeholder]="placeholder()"
              [value]="draft()"
              (input)="onInput(input)"
              (paste)="onPaste($event)"
              (keydown.enter)="onEnter($event)"
            ></textarea>
            <div class="bar">
              <span>{{ hint() }}</span>
              <span class="spacer"></span>
              @if (s.state === 'queued') {
                <button class="btn sm" (click)="stop()">Remove from queue</button>
              } @else if (live()) {
                <button class="btn sm stop" (click)="stop()">Stop</button>
              }
              <button class="btn sm primary" [disabled]="!canSend()" (click)="send()">Send</button>
            </div>
          </div>
        </div>
      } @else {
        <div class="start scroll">
          <div class="lead">Start a session on this item</div>
          <div class="sub">Claude gets the work item's details straight away, works in its own copy of the repository, and you can talk to it here as it goes.</div>
          <fm-launcher [item]="r.item" />
        </div>
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
            <div style="font-size:12px;color:var(--text3)">Press <span class="kbd">N</span> to jump to the next one.</div>
          }
        </div>
      </div>
    }
  `,
})
export class Chat {
  protected readonly store = inject(Store);
  protected readonly elapsed = elapsed;
  protected readonly row = this.store.selected;
  private readonly feed = viewChild<ElementRef<HTMLElement>>('feed');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  protected readonly draft = signal('');
  protected readonly attachments = signal<Attachment[]>([]);
  protected readonly open = signal<Record<string, boolean>>({});
  protected readonly chosen = signal<Record<string, string>>({});
  /** Whether the transcript is scrolled to the end, so new entries should keep it there. */
  private pinned = true;

  private readonly session = computed(() => this.row()?.session ?? null);
  protected readonly live = computed(() => ['queued', 'running', 'needs_input'].includes(this.session()?.state ?? ''));
  private readonly entries = computed<LogEntry[]>(() => {
    const s = this.session();
    return s ? (this.store.logs()[s.id] ?? []) : [];
  });
  protected readonly hidden = computed(() => this.lines().length >= SHOWN_LINES);

  /** Tool results fold into the call that produced them; only the tail of a long transcript is rendered. */
  protected readonly lines = computed<Line[]>(() => {
    const out: Line[] = [];
    const calls = new Map<string, Line>();
    this.entries().forEach((e, i) => {
      if ((e.kind === 'result' || e.kind === 'error') && e.id) {
        const call = calls.get(e.id);
        if (call) {
          call.result = e.text;
          call.failed = e.kind === 'error';
        }
        if (call || e.kind === 'result') return;
      }
      if (e.kind === 'result') return;
      if (e.kind === 'tool' && HIDDEN_TOOLS.includes(e.tool ?? '')) return;
      const line: Line = {
        key: String(i), kind: e.kind === 'text' ? 'assistant' : (e.kind as Line['kind']), time: clock(e.ts), text: e.text,
        html: e.kind === 'text' ? (marked.parse(e.text, { async: false, breaks: true }) as string) : '',
        tool: e.tool ?? '', result: null, failed: false, images: e.images ?? 0, label: e.label ?? 'Instructions sent to Claude',
      };
      if (e.kind === 'tool' && e.id) calls.set(e.id, line);
      out.push(line);
    });
    return out.slice(-SHOWN_LINES);
  });

  protected readonly canSend = computed(() => {
    const s = this.session();
    if (!s) return false;
    const typed = !!this.draft().trim() || this.attachments().length > 0;
    // While Claude waits on a question, a typed message is the answer.
    return typed && (!this.live() || s.pending?.kind === 'question');
  });
  protected readonly canAnswer = computed(() => (this.session()?.pending?.questions ?? []).every((q) => this.chosen()[q.question]));

  protected readonly placeholder = computed(() => {
    const s = this.session();
    if (s?.pending?.kind === 'question') return 'Type your own answer…';
    if (s?.state === 'running') return 'Claude is working — stop it to send a new message';
    return 'Message Claude about this item…';
  });

  protected readonly hint = computed(() => {
    const s = this.session();
    if (s?.pending) return s.pending.kind === 'question' ? 'Claude is waiting for your answer' : 'Claude is waiting for your approval';
    if (s?.state === 'queued') return 'Queued';
    return this.live() ? 'Claude is working' : 'Enter to send · Shift+Enter for a new line · paste images';
  });

  protected readonly emptyTitle = computed(() => {
    const n = this.store.attention().length;
    if (this.store.items().length === 0) return 'No work items match these filters';
    return n > 0 ? `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'Select a work item';
  });
  protected readonly emptySub = computed(() => {
    if (this.store.items().length === 0) return 'Change the sprint or person in the top bar, or reset to your defaults.';
    return this.store.attention().length > 0 ? "Select one to see what it's waiting for." : 'Pick an item on the left to start a session on it or carry on its conversation.';
  });

  constructor() {
    // Switching item loads its transcript and resets the composer.
    effect(() => {
      const id = this.session()?.id;
      this.row()?.item.id;
      untracked(() => {
        if (id) void this.store.loadLog(id);
        this.draft.set('');
        this.attachments.set([]);
        this.open.set({});
        this.pinned = true;
      });
    });
    effect(() => {
      this.session()?.pending?.requestId;
      untracked(() => this.chosen.set({}));
    });
    // Keep the newest entry in view unless the user has scrolled up to read.
    effect(() => {
      this.lines();
      this.session()?.state;
      queueMicrotask(() => {
        const el = this.feed()?.nativeElement;
        if (el && this.pinned) el.scrollTop = el.scrollHeight;
      });
    });
  }

  protected onScroll(): void {
    const el = this.feed()?.nativeElement;
    if (el) this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  protected toggle(l: Line): void {
    if (l.kind === 'brief' || l.result !== null) this.open.update((o) => ({ ...o, [l.key]: !o[l.key] }));
  }

  protected onInput(el: HTMLTextAreaElement): void {
    this.draft.set(el.value);
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  protected onEnter(ev: Event): void {
    const key = ev as KeyboardEvent;
    if (key.shiftKey || key.isComposing) return;
    ev.preventDefault();
    this.send();
  }

  protected onPaste(ev: ClipboardEvent): void {
    const files = Array.from(ev.clipboardData?.items ?? []).filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (!files.length) return;
    ev.preventDefault();
    for (const file of files) {
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const preview = String(reader.result);
        this.attachments.update((a) => [...a, { mediaType: file.type, data: preview.slice(preview.indexOf(',') + 1), preview }]);
      };
      reader.readAsDataURL(file);
    }
  }

  protected removeAttachment(index: number): void {
    this.attachments.update((a) => a.filter((_, i) => i !== index));
  }

  protected async send(): Promise<void> {
    const s = this.session();
    if (!s || !this.canSend()) return;
    const text = this.draft().trim();
    if (s.pending?.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const q of s.pending.questions ?? []) answers[q.question] = text;
      await this.store.run(() => backend.answerSession(s.id, s.pending!.requestId, 'reply', null, answers));
    } else {
      const images = this.attachments().map(({ mediaType, data }) => ({ mediaType, data }));
      const ok = await this.store.run(() => backend.sendMessage(s.id, text, images).then(() => true));
      if (!ok) return;
    }
    this.draft.set('');
    this.attachments.set([]);
    this.pinned = true;
    const el = this.input()?.nativeElement;
    if (el) el.style.height = 'auto';
  }

  protected choose(question: string, label: string): void {
    this.chosen.update((c) => ({ ...c, [question]: c[question] === label ? '' : label }));
  }

  private reply(action: 'approve' | 'deny' | 'reply', answers: Record<string, string> | null): void {
    const s = this.session();
    if (s?.pending) void this.store.run(() => backend.answerSession(s.id, s.pending!.requestId, action, null, answers));
  }

  protected answer(): void {
    if (this.canAnswer()) this.reply('reply', { ...this.chosen() });
  }

  protected approve(): void {
    this.reply('approve', null);
  }

  protected deny(): void {
    this.reply('deny', null);
  }

  protected stop(): void {
    const s = this.session();
    if (s) void this.store.run(() => backend.stopSession(s.id));
  }

  protected resume(): void {
    const s = this.session();
    if (s) void this.store.run(() => backend.resumeSession(s.id));
  }

  protected openInDevOps(id: number): void {
    void this.store.run(() => backend.openWorkItem(id));
  }

  /** Links in Claude's replies open in the default browser, never inside the app. */
  protected onLinkClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    ev.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) void this.store.run(() => backend.openUrl(href));
  }
}
