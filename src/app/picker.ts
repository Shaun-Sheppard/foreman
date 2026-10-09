import {
  ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild,
} from '@angular/core';

export interface PickerOption {
  value: string;
  label: string;
  note?: string;
  /** Extra data handed back on pick. */
  data?: string;
}

/** Top-bar dropdown with a search box: used for the sprint and person filters. */
@Component({
  selector: 'fm-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:mousedown)': 'onDocDown($event)', '(keydown.escape)': 'close($event)' },
  styles: `
    :host { position: relative; display: block; }
    .trigger { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; max-width: 260px; }
    .trigger:hover:not(:disabled) { background: var(--hover); }
    .trigger:disabled { opacity: 0.5; }
    .trigger.avatar { padding-left: 4px; }
    .label { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { font-size: 11px; color: var(--text3); }
    .caret { font-size: 9px; color: var(--text3); }
    .pop { position: absolute; top: 34px; left: 0; z-index: 30; width: 260px; background: var(--raised); border: 1px solid var(--border2); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .search { height: 28px; padding: 0 8px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 5px; background: var(--input); outline: none; }
    .list { max-height: 280px; display: flex; flex-direction: column; gap: 2px; }
    .opt { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; text-align: left; flex: none; }
    .opt:hover { background: var(--hover); }
    .opt.on { background: var(--sel); }
    .mark { width: 12px; font-size: 11px; flex: none; }
    .opt .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opt .note { font-size: 12px; white-space: nowrap; }
    .hint { padding: 6px 8px; color: var(--text3); font-size: 12px; }
  `,
  template: `
    <button class="trigger" [class.avatar]="hasAvatar()" [disabled]="disabled()" (click)="toggle()" [attr.aria-expanded]="open()">
      <ng-content />
      <span class="label">{{ label() }}</span>
      @if (note()) {
        <span class="note">{{ note() }}</span>
      }
      <span class="caret">▼</span>
    </button>
    @if (open()) {
      <div class="pop">
        <input #search class="search" [placeholder]="placeholder()" [value]="q()" (input)="q.set(search.value)" (keydown.enter)="pickFirst()" />
        <div class="list scroll">
          @for (o of shown(); track o.value) {
            <button class="opt" [class.on]="o.value === value()" (click)="choose(o)">
              <span class="mark">{{ o.value === value() ? '✓' : '' }}</span>
              <span class="name">{{ o.label }}</span>
              @if (o.note) {
                <span class="note">{{ o.note }}</span>
              }
            </button>
          } @empty {
            <div class="hint">{{ loading() ? 'Loading…' : 'No matches' }}</div>
          }
        </div>
      </div>
    }
  `,
})
export class Picker {
  readonly label = input.required<string>();
  readonly note = input('');
  readonly value = input.required<string>();
  readonly options = input.required<PickerOption[]>();
  readonly placeholder = input('Search');
  readonly disabled = input(false);
  readonly loading = input(false);
  readonly hasAvatar = input(false);
  readonly picked = output<PickerOption>();
  readonly opened = output<void>();

  protected readonly open = signal(false);
  protected readonly q = signal('');
  protected readonly shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.options().filter((o) => !q || o.label.toLowerCase().includes(q) || (o.note ?? '').toLowerCase().includes(q));
  });

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected toggle(): void {
    this.open.update((v) => !v);
    this.q.set('');
    if (this.open()) {
      this.opened.emit();
      setTimeout(() => this.search()?.nativeElement.focus());
    }
  }

  protected choose(o: PickerOption): void {
    this.open.set(false);
    this.picked.emit(o);
  }

  protected pickFirst(): void {
    const first = this.shown()[0];
    if (first) this.choose(first);
  }

  protected close(ev?: Event): void {
    if (this.open()) {
      ev?.stopPropagation();
      this.open.set(false);
    }
  }

  protected onDocDown(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.open.set(false);
  }
}
