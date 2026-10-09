import { ChangeDetectionStrategy, Component, ElementRef, effect, inject } from '@angular/core';
import { StatusIcon, TypeIcon } from './icons';
import { GroupKey, Store, ago, leaf } from './store';

@Component({
  selector: 'fm-work-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, TypeIcon],
  host: { role: 'listbox', 'aria-label': 'Work items' },
  styles: `
    :host { width: 410px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--surface); min-height: 0; }
    @media (max-width: 1100px) { :host { width: 340px; } }
    .list { flex: 1; }
    .empty { padding: 32px 20px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
    .empty b { font-weight: 600; }
    .empty span { font-size: 12.5px; color: var(--text2); text-wrap: pretty; }
    .ghead { position: sticky; top: 0; z-index: 2; width: 100%; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface); }
    .ghead.att { color: var(--att); }
    .chev { width: 10px; font-size: 9px; color: var(--text3); }
    .count { font-family: var(--mono); color: var(--text3); font-weight: 500; letter-spacing: 0; }
    .row { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border); transition: background 0.6s; outline-offset: -2px; }
    .row:hover { background: var(--hover); transition: none; }
    .row.att { background: var(--att-bg); }
    .row.att:hover { background: var(--att-hover); }
    .row.sel, .row.sel:hover { background: var(--sel); transition: none; }
    .row.sel.kbd { outline: 2px solid var(--run); }
    .l1, .l2 { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .id { font-family: var(--mono); font-size: 12px; color: var(--text2); flex: none; }
    .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 450; }
    .row.att .title { font-weight: 600; }
    .row.done .title { color: var(--text2); }
    .l2 { padding-left: 22px; font-size: 12px; color: var(--text2); }
    .status { color: var(--text3); font-weight: 500; white-space: nowrap; flex: none; }
    .row.att .status { font-weight: 600; }
    .row.flash { background: var(--att-flash); outline: 1px solid var(--att); transition: none; }
    .segs { display: flex; gap: 2px; width: 56px; flex: none; }
    .segs div { flex: 1; height: 4px; border-radius: 1px; background: var(--border2); }
    .segs div.completed { background: var(--pass); }
    .segs div.in_progress { background: var(--run); }
    .prog { font-family: var(--mono); font-size: 11.5px; flex: none; }
    .reason { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ago { flex: none; color: var(--text3); }
  `,
  template: `
    <div class="list scroll">
      @if (store.groups().length === 0) {
        <div class="empty">
          <b>No work items match</b>
          <span>{{ emptyText() }}</span>
          <button class="btn" style="height:28px;padding:0 10px;margin-top:6px" (click)="store.resetFilters()">{{ resetLabel() }}</button>
        </div>
      }
      @for (g of store.groups(); track g.key) {
        <div>
          <button class="ghead caps" [class.att]="g.key === 'attention'" (click)="toggle(g.key)" [attr.aria-expanded]="!store.collapsed()[g.key]">
            <span class="chev">{{ store.collapsed()[g.key] ? '▶' : '▼' }}</span>
            <span>{{ g.label }}</span>
            <span class="count">{{ g.rows.length }}</span>
          </button>
          @if (!store.collapsed()[g.key]) {
            @for (r of g.rows; track r.item.id) {
              <div
                class="row"
                role="option"
                [attr.data-id]="r.item.id"
                [attr.aria-selected]="r.item.id === store.selectedId()"
                [class.sel]="r.item.id === store.selectedId()"
                [class.kbd]="store.kbd()"
                [class.att]="r.group === 'attention'"
                [class.done]="r.group === 'done'"
                [class.flash]="store.flash() === r.item.id && r.item.id !== store.selectedId()"
                (click)="store.select(r.item.id)"
              >
                <div class="l1">
                  <fm-status-icon [status]="r.icon" [size]="14" [label]="r.label" />
                  <span class="id">{{ r.item.id }}</span>
                  <fm-type-icon [type]="r.item.type" [size]="13" />
                  <span class="title">{{ r.item.title }}</span>
                </div>
                <div class="l2">
                  <span class="status" [style.color]="'var(--' + r.tone + ')'">{{ r.label }}</span>
                  @if (r.total > 0 && (r.status === 'running' || r.status === 'needs_input' || r.status === 'fixing')) {
                    <div class="segs">
                      @for (st of r.session?.steps ?? []; track $index) {
                        <div [class]="st.state"></div>
                      }
                    </div>
                    <span class="prog">{{ r.done }}/{{ r.total }}</span>
                  }
                  <span class="reason">{{ r.reason }}</span>
                  <span class="spacer"></span>
                  @if (r.pr) {
                    <span class="prog">!{{ r.pr.id }}</span>
                  }
                  <span class="ago tnum">{{ ago(r.item.changedDate, store.nowCoarse()) }}</span>
                </div>
              </div>
            }
          }
        </div>
      }
    </div>
  `,
})
export class WorkList {
  protected readonly store = inject(Store);
  protected readonly ago = ago;
  protected readonly leaf = leaf;
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  constructor() {
    // Keep a keyboard-moved selection in view without disturbing scroll otherwise.
    effect(() => {
      const id = this.store.selectedId();
      if (id === null || !this.store.kbd()) return;
      queueMicrotask(() =>
        this.host.nativeElement.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
    });
  }

  protected toggle(key: GroupKey): void {
    this.store.collapsed.update((c) => ({ ...c, [key]: !c[key] }));
  }

  protected emptyText(): string {
    const q = this.store.query().trim();
    if (q) return `Nothing matches "${q}".`;
    if (this.store.chip()) return 'No items in this filter.';
    const who = this.store.personLabel();
    const whose = who === 'Me' ? 'you' : who === 'Everyone' ? 'anyone' : who;
    return `Nothing assigned to ${whose} in ${this.store.sprintLabel()}.`;
  }

  protected resetLabel(): string {
    const s = this.store.settings();
    const person = this.store.personName(s?.defaultPerson ?? '@me');
    const sprint = !s || s.defaultSprint === '@current' ? 'current sprint' : leaf(s.defaultSprint);
    return `Reset to ${person} · ${sprint}`;
  }
}
