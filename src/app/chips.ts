import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

const CHIP_CSS = `
  :host { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px; border: 1px solid var(--border2); border-radius: 5px; background: transparent; }
  .chip.mono { font-family: var(--mono); font-size: 12px; }
  .x { border: 0; background: transparent; padding: 0 2px; color: var(--text3); }
  .x:hover { color: var(--text); }
  .add { border-style: dashed; color: var(--text2); }
  .add:hover { background: var(--hover); }
  .entry { height: 26px; width: 180px; padding: 0 8px; border: 1px solid var(--border2); border-radius: 5px; background: var(--input); outline: none; }
  .toggle { padding: 0 9px; color: var(--text2); border-color: var(--border); }
  .toggle.on { color: var(--text); background: var(--sel); border-color: var(--text2); }
  .mark { font-size: 11px; width: 10px; }
`;

/** Removable chips with an inline "+ Add" entry: projects and area paths. */
@Component({
  selector: 'fm-chip-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: CHIP_CSS,
  template: `
    @for (v of values(); track v) {
      <span class="chip" [class.mono]="mono()">{{ v }}<button class="x" (click)="remove(v)" [attr.aria-label]="'Remove ' + v">×</button></span>
    }
    @if (adding()) {
      <input #entry class="entry" [class.mono]="mono()" [placeholder]="placeholder()" (keydown.enter)="commit(entry.value)" (keydown.escape)="cancel($event)" (blur)="commit(entry.value)" autofocus />
    } @else {
      <button class="chip add" (click)="adding.set(true)">+ {{ addLabel() }}</button>
    }
  `,
})
export class ChipList {
  readonly values = input.required<string[]>();
  readonly mono = input(false);
  readonly addLabel = input('Add');
  readonly placeholder = input('');
  readonly changed = output<string[]>();
  protected readonly adding = signal(false);

  protected remove(v: string): void {
    this.changed.emit(this.values().filter((x) => x !== v));
  }

  protected commit(raw: string): void {
    if (!this.adding()) return;
    this.adding.set(false);
    const v = raw.trim();
    if (v && !this.values().includes(v)) this.changed.emit([...this.values(), v]);
  }

  protected cancel(ev: Event): void {
    ev.stopPropagation();
    this.adding.set(false);
  }
}

/** On/off chips over a known set, plus custom additions: work item types and states. */
@Component({
  selector: 'fm-toggle-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: CHIP_CSS,
  template: `
    @for (o of all(); track o) {
      <button class="chip toggle" [class.on]="values().includes(o)" [attr.aria-pressed]="values().includes(o)" (click)="toggle(o)">
        <span class="mark">{{ values().includes(o) ? '✓' : '' }}</span>{{ o }}
      </button>
    }
    @if (adding()) {
      <input #entry class="entry" placeholder="Exact name in DevOps" (keydown.enter)="commit(entry.value)" (keydown.escape)="cancel($event)" (blur)="commit(entry.value)" autofocus />
    } @else {
      <button class="chip add" (click)="adding.set(true)">+ Add</button>
    }
  `,
})
export class ToggleChips {
  readonly values = input.required<string[]>();
  readonly options = input.required<string[]>();
  readonly changed = output<string[]>();
  protected readonly adding = signal(false);
  protected readonly all = computed(() => [...new Set([...this.options(), ...this.values()])]);

  protected toggle(o: string): void {
    const v = this.values();
    this.changed.emit(v.includes(o) ? v.filter((x) => x !== o) : [...v, o]);
  }

  protected commit(raw: string): void {
    if (!this.adding()) return;
    this.adding.set(false);
    const v = raw.trim();
    if (v && !this.values().includes(v)) this.changed.emit([...this.values(), v]);
  }

  protected cancel(ev: Event): void {
    ev.stopPropagation();
    this.adding.set(false);
  }
}
