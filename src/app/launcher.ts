import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { backend, Mode, MODELS, RepoInfo, RepoMapping, WorkItem } from './backend';
import { StatusIcon } from './icons';
import { Store } from './store';

/**
 * Start panel for a work item: mode, then which repository, base branch and model to use.
 * The branch is pre-filled from the project's default but is asked for every time, so a
 * fix can be based on a release branch instead.
 */
@Component({
  selector: 'fm-launcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon],
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .start { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px 0 12px; }
    .start svg polygon { fill: var(--btn-text); }
    .seg { display: flex; border: 1px solid var(--border); border-radius: 7px; padding: 2px; gap: 2px; background: var(--surface); }
    .seg button { height: 28px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text2); font-weight: 500; }
    .seg button.on { background: var(--sel); color: var(--text); }
    .note { font-size: 12px; color: var(--text3); }
    .note.full { color: var(--att); }
    .opts { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; max-width: 760px; }
    .opts label { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .opts label > span { font-size: 12px; color: var(--text2); }
    .hint { font-size: 12px; color: var(--text3); }
    .hint.bad { color: var(--fail); }
    .card { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); max-width: 760px; }
    .toggle { width: 100%; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border: 0; background: transparent; text-align: left; }
    .chev { width: 10px; font-size: 9px; color: var(--text3); }
    .preview { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 6px; }
    textarea { width: 100%; font-family: var(--mono); font-size: 12px; line-height: 1.6; background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; resize: vertical; outline: none; user-select: text; -webkit-user-select: text; }
    .nomap { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--att); border-radius: 8px; background: var(--att-bg); max-width: 760px; }
    .nomap div { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .nomap span { font-size: 12.5px; color: var(--text2); }
  `,
  template: `
    @if (mappings().length === 0) {
      <div class="nomap">
        <fm-status-icon status="needs_input" [size]="18" />
        <div>
          <b style="font-weight:600">No repository mapped for {{ item().project }}</b>
          <span>Sessions run in a worktree of a local clone. Map this project to one, with its default branch.</span>
        </div>
        <button class="btn primary" data-primary (click)="store.openSettings('repos')">Map repository</button>
      </div>
    } @else {
      <div class="row">
        <button class="btn primary start" data-primary [disabled]="!canStart() || starting()" (click)="start()">
          <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="1.5,1 9,5 1.5,9" /></svg>{{ full() ? 'Queue session' : 'Start session' }}
        </button>
        <div class="seg" role="radiogroup" aria-label="Session mode">
          @for (m of modes; track m.key) {
            <button role="radio" [attr.aria-checked]="mode() === m.key" [class.on]="mode() === m.key" (click)="mode.set(m.key)">{{ m.label }}</button>
          }
        </div>
        <span class="note" [class.full]="full()">{{ slotNote() }}</span>
      </div>

      <div class="opts">
        <label><span>Repository</span>
          <select class="field" (change)="pickRepo($any($event.target).value)">
            @for (m of mappings(); track m.repoPath + m.areaPath) {
              <option [value]="m.repoPath" [selected]="m.repoPath === repoPath()">{{ repoName(m.repoPath) }}{{ m.areaPath ? ' · ' + m.areaPath : '' }}</option>
            }
          </select>
        </label>
        <label><span>Base branch</span>
          <input class="field mono" spellcheck="false" list="launch-branches" placeholder="dev" [value]="branch()" (input)="branch.set($any($event.target).value.trim())" />
          <datalist id="launch-branches">
            @for (b of repo()?.branches ?? []; track b) {
              <option [value]="b"></option>
            }
          </datalist>
        </label>
        <label><span>Model</span>
          <select class="field" (change)="model.set($any($event.target).value)">
            @for (m of models; track m.id) {
              <option [value]="m.id" [selected]="m.id === model()">{{ m.label }}</option>
            }
          </select>
        </label>
      </div>
      @if (branchProblem(); as problem) {
        <span class="hint bad">{{ problem }}</span>
      } @else {
        <span class="hint mono">New branch {{ newBranch() }} from {{ branch() }}</span>
      }

      <div class="card">
        <button class="toggle" [attr.aria-expanded]="promptOpen()" (click)="promptOpen.set(!promptOpen())">
          <span class="chev">{{ promptOpen() ? '▼' : '▶' }}</span>
          <span style="font-weight:500">Prompt preview</span>
          <span class="note">{{ edited() !== null ? 'edited for this launch' : mode() + ' template + work item' }}</span>
        </button>
        @if (promptOpen()) {
          <div class="preview">
            <textarea rows="12" spellcheck="false" [value]="edited() ?? preview()" (input)="edited.set($any($event.target).value)"></textarea>
            <span class="note">Edits apply to this launch only. Change the template in Settings → Sessions.</span>
          </div>
        }
      </div>
    }
  `,
})
export class Launcher {
  protected readonly store = inject(Store);
  readonly item = input.required<WorkItem>();

  protected readonly modes: { key: Mode; label: string }[] = [
    { key: 'implement', label: 'Implement' },
    { key: 'review', label: 'Review' },
  ];
  protected readonly models = MODELS;

  protected readonly mode = signal<Mode>(this.store.settings()?.defaultMode ?? 'implement');
  protected readonly model = signal(this.store.settings()?.defaultModel ?? '');
  protected readonly repoPath = signal('');
  protected readonly branch = signal('');
  protected readonly repo = signal<RepoInfo | null>(null);
  protected readonly promptOpen = signal(false);
  protected readonly preview = signal('');
  /** Non-null once the user has edited the preview for this launch. */
  protected readonly edited = signal<string | null>(null);
  protected readonly starting = signal(false);

  /** Mappings for this item's project, most specific area path first. */
  protected readonly mappings = computed<RepoMapping[]>(() => {
    const item = this.item();
    return (this.store.settings()?.repositories ?? [])
      .filter((r) => r.project === item.project && r.repoPath && (!r.areaPath || (item.areaPath + '\\').startsWith(r.areaPath + '\\')))
      .sort((a, b) => b.areaPath.length - a.areaPath.length);
  });

  protected readonly full = computed(() => this.store.activeCount() >= (this.store.settings()?.concurrencyLimit ?? 3));
  protected readonly slotNote = computed(() => {
    const limit = this.store.settings()?.concurrencyLimit ?? 3;
    const used = this.store.activeCount();
    return used >= limit ? `All ${limit} slots in use — this will start when one frees` : `${used} of ${limit} slots in use`;
  });

  protected readonly branchProblem = computed(() => {
    if (!this.branch()) return 'Choose the branch to start from.';
    const branches = this.repo()?.branches;
    return branches && !branches.includes(this.branch()) ? `Branch "${this.branch()}" doesn't exist in this repository.` : null;
  });
  protected readonly canStart = computed(() => !!this.repoPath() && !this.branchProblem());

  protected readonly newBranch = computed(() => {
    const slug = this.item().title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join('-');
    return `foreman/${this.item().id}${slug ? '-' + slug : ''}`;
  });

  constructor() {
    // A different item (or changed mappings) resets the choices to that project's defaults.
    effect(() => {
      const first = this.mappings()[0];
      this.item().id;
      untracked(() => {
        this.edited.set(null);
        this.pickRepo(first?.repoPath ?? '');
      });
    });
    effect(() => {
      const [open, item, mode, repo, branch] = [this.promptOpen(), this.item(), this.mode(), this.repoPath(), this.branch()];
      if (!open || !repo) return;
      backend.previewPrompt(item.id, mode, repo, branch).then(
        (text) => {
          if (this.item().id === item.id && this.mode() === mode && this.branch() === branch) this.preview.set(text);
        },
        () => this.preview.set(''),
      );
    });
  }

  protected repoName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  protected pickRepo(path: string): void {
    this.repoPath.set(path);
    this.repo.set(null);
    const mapping = this.mappings().find((m) => m.repoPath === path);
    this.branch.set(mapping?.defaultBranch ?? '');
    if (!path) return;
    backend.inspectRepo(path).then(
      (info) => {
        if (this.repoPath() === path) this.repo.set(info);
      },
      () => undefined,
    );
  }

  protected async start(): Promise<void> {
    if (!this.canStart()) return;
    this.starting.set(true);
    await this.store.run(() =>
      backend.startSession({
        workItemId: this.item().id,
        mode: this.mode(),
        repoPath: this.repoPath(),
        baseBranch: this.branch(),
        model: this.model(),
        prompt: this.edited(),
      }),
    );
    this.starting.set(false);
  }
}
