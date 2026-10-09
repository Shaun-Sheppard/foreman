import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { backend, PERSON_EVERYONE, PERSON_ME, Person, Sprint, SPRINT_CURRENT } from './backend';
import { Chat } from './chat';
import { StatusIcon } from './icons';
import { Picker, PickerOption } from './picker';
import { SettingsView } from './settings-view';
import { SidePanel } from './side-panel';
import { ChipKey, Store } from './store';
import { WorkList } from './work-list';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function since(iso: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, Picker, WorkList, Chat, SidePanel, SettingsView],
  host: { '(window:keydown)': 'onKey($event)' },
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(Store);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('search');

  /** Until the organisation, a project and a token are saved, settings is the only screen. */
  protected readonly firstRun = computed(() => this.store.loaded() && !this.store.configured());
  protected readonly syncError = computed(() => (this.firstRun() ? null : this.store.sync().error));
  protected readonly showMain = computed(() => this.store.loaded() && !this.firstRun() && this.store.view() === 'main');
  protected readonly showSettings = computed(() => this.store.loaded() && (this.firstRun() || this.store.view() === 'settings'));

  protected readonly syncText = computed(() => {
    if (!this.store.loaded()) return '';
    if (this.firstRun()) return 'Not connected';
    const sync = this.store.sync();
    if (sync.error) return sync.lastGoodSync ? `Sync failed · last good ${clock(sync.lastGoodSync)}` : 'Sync failed';
    if (sync.status === 'syncing' || !sync.lastGoodSync) return 'Syncing…';
    return `Synced ${since(sync.lastGoodSync, this.store.now())} ago`;
  });

  protected readonly bannerDetail = computed(() => {
    const last = this.store.sync().lastGoodSync;
    return last
      ? `Showing data from the last good sync at ${clock(last)} (${since(last, this.store.now())} ago).`
      : 'Nothing has synced yet.';
  });
  protected readonly tokenProblem = computed(() => {
    const kind = this.syncError()?.kind;
    return kind === 'unauthorized' || kind === 'forbidden';
  });

  protected readonly chips: { key: ChipKey; label: string; status: 'running' | 'pr_checks' | 'merged' }[] = [
    { key: 'running', label: 'Running', status: 'running' },
    { key: 'pr', label: 'PR open', status: 'pr_checks' },
    { key: 'done', label: 'Done', status: 'merged' },
  ];

  // Sprint and person lists are fetched when their popover opens.
  private readonly sprints = signal<Sprint[] | null>(null);
  private readonly people = signal<Person[] | null>(null);
  protected readonly sprintsLoading = computed(() => this.sprints() === null);
  protected readonly peopleLoading = computed(() => this.people() === null);

  protected readonly sprintOptions = computed<PickerOption[]>(() => {
    const multi = (this.store.settings()?.projects.length ?? 0) > 1;
    const currentNames = this.store.sync().sprintNames.join(', ');
    return [
      { value: SPRINT_CURRENT, label: 'Current sprint', note: currentNames },
      ...[...(this.sprints() ?? [])].reverse().map((s) => ({
        value: s.path,
        label: s.name,
        note: [s.timeFrame === 'current' ? 'current' : '', multi ? s.project : ''].filter(Boolean).join(' · '),
      })),
    ];
  });

  protected readonly personOptions = computed<PickerOption[]>(() => {
    const me = this.store.me();
    return [
      { value: PERSON_ME, label: 'Me', note: me?.displayName ?? '' },
      { value: PERSON_EVERYONE, label: 'Everyone' },
      ...(this.people() ?? [])
        .filter((p) => p.uniqueName !== me?.uniqueName)
        .map((p) => ({ value: p.uniqueName, label: p.displayName })),
    ];
  });

  constructor() {
    void this.store.init();
  }

  protected loadSprints(): void {
    backend.listSprints().then((s) => this.sprints.set(s), () => this.sprints.set([]));
  }

  protected loadPeople(): void {
    backend.listPeople().then((p) => this.people.set(p), () => this.people.set([]));
  }

  protected pickSprint(o: PickerOption): void {
    this.people.set(null);
    void this.store.setFilters({ sprint: o.value });
  }

  protected pickPerson(o: PickerOption): void {
    const named = o.value !== PERSON_ME && o.value !== PERSON_EVERYONE;
    void this.store.setFilters({ person: o.value, personLabel: named ? o.label : '' });
  }

  protected toggleChip(key: ChipKey): void {
    this.store.chip.update((c) => (c === key ? null : key));
  }

  protected viewToast(itemId: number): void {
    this.store.view.set('main');
    this.store.chip.set(null);
    this.store.query.set('');
    this.store.select(itemId);
  }

  protected toggleSettings(): void {
    this.store.view.update((v) => (v === 'settings' ? 'main' : 'settings'));
  }

  protected readonly win = {
    minimize: () => void backend.windowMinimize(),
    maximize: () => void backend.windowToggleMaximize(),
    close: () => void backend.windowClose(),
  };

  private interactive(ev: Event): boolean {
    return !!(ev.target as HTMLElement).closest('button, input, select, textarea, a, fm-picker');
  }

  /** The title bar is the drag region, except over its controls. */
  protected startDrag(ev: MouseEvent): void {
    if (ev.button !== 0 || ev.detail > 1 || this.interactive(ev)) return;
    void backend.windowStartDrag();
  }

  protected titleDblClick(ev: MouseEvent): void {
    if (!this.interactive(ev)) this.win.maximize();
  }

  protected onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
      if (ev.key === 'Escape') target.blur();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey || this.firstRun()) return;
    const s = this.store;
    if (ev.key === 'Escape') {
      s.view.set('main');
    } else if (ev.key === 'Enter' && s.view() === 'main' && target.tagName !== 'BUTTON') {
      // Enter moves focus to the detail pane's primary action (Start, Approve, Resume…).
      (document.querySelector<HTMLElement>('fm-chat [data-primary]:not(:disabled)') ?? document.querySelector<HTMLElement>('fm-chat textarea'))?.focus();
    } else if (ev.key === '/') {
      ev.preventDefault();
      s.view.set('main');
      setTimeout(() => this.searchBox()?.nativeElement.focus());
    } else if (ev.key === 'n' || ev.key === 'N') {
      const ids = s.attentionIds();
      if (!ids.length) return;
      s.view.set('main');
      s.select(ids[(ids.indexOf(s.selectedId() ?? -1) + 1) % ids.length], true);
    } else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && s.view() === 'main') {
      ev.preventDefault();
      const ids = s.visibleIds();
      if (!ids.length) return;
      const at = ids.indexOf(s.selectedId() ?? -1);
      const next = ev.key === 'ArrowDown' ? Math.min(ids.length - 1, at + 1) : Math.max(0, at - 1);
      s.select(ids[next], true);
    }
  }
}
