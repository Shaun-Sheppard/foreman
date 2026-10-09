import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type Status =
  | 'not_started' | 'queued' | 'running' | 'needs_input' | 'pending' | 'done' | 'passed' | 'failed'
  | 'pr_failed' | 'fixing' | 'pr_checks' | 'ready' | 'merged' | 'skipped' | 'cancelled' | 'stuck';

/**
 * Every status owns a unique silhouette on a 16px grid, so nothing depends on colour alone.
 * Filled = needs you or has a final result; hollow = quiet or not yet reached.
 */
@Component({
  selector: 'fm-status-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:block;flex:none;line-height:0' },
  styles: `
    .o { fill: none; stroke-width: 1.5; }
    .mute { stroke: var(--icon-mute); }
    .run { stroke: var(--run); }
    .ink { fill: none; stroke: var(--icon-ink); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .inkf { fill: var(--icon-ink); }
  `,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 16 16" role="img" [attr.aria-label]="label() || status()">
      @switch (status()) {
        @case ('queued') {
          <circle cx="8" cy="8" r="6" class="o mute" stroke-dasharray="2.4 2.1" />
          <circle cx="8" cy="8" r="1.4" style="fill:var(--icon-mute)" />
        }
        @case ('running') {
          <circle cx="8" cy="8" r="6" class="o run" opacity="0.3" />
          <path d="M8 2 A6 6 0 0 1 14 8" class="o run" [class.fm-spin]="animate()" style="stroke-width:1.8;stroke-linecap:round" />
          <circle cx="8" cy="8" r="2" style="fill:var(--run)" />
        }
        @case ('needs_input') {
          <polygon points="8,0.8 15.2,8 8,15.2 0.8,8" style="fill:var(--att)" />
          <rect x="7.2" y="4.2" width="1.6" height="4.6" rx="0.8" class="inkf" />
          <circle cx="8" cy="11" r="0.95" class="inkf" />
        }
        @case ('pending') {
          <circle cx="8" cy="8" r="3" class="o mute" style="stroke-width:1.4" />
        }
        @case ('passed') {
          <circle cx="8" cy="8" r="7" style="fill:var(--pass)" />
          <path d="M4.9 8.3 L7.1 10.4 L11.2 6" class="ink" />
        }
        @case ('failed') {
          <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" style="fill:var(--fail)" />
          <path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" class="ink" />
        }
        @case ('fixing') {
          <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.5" class="o run" />
          <path d="M8 4.6 A3.4 3.4 0 0 1 11.4 8" class="o run" [class.fm-spin]="animate()" style="stroke-width:1.8;stroke-linecap:round" />
          <circle cx="8" cy="8" r="1.3" style="fill:var(--run)" />
        }
        @case ('pr_checks') {
          <circle cx="8" cy="8" r="6" class="o run" />
          <path d="M8 2 A6 6 0 0 1 8 14 Z" style="fill:var(--run)" />
        }
        @case ('ready') {
          <circle cx="8" cy="8" r="6.4" class="o" style="stroke:var(--pass);stroke-width:1.6" />
          <circle cx="8" cy="8" r="3.4" style="fill:var(--pass)" />
        }
        @case ('merged') {
          <polygon points="8,0.8 14.4,4.4 14.4,11.6 8,15.2 1.6,11.6 1.6,4.4" style="fill:var(--merge)" />
          <path d="M4.9 8.3 L7.1 10.4 L11.2 6" class="ink" />
        }
        @case ('cancelled') {
          <circle cx="8" cy="8" r="6" class="o mute" />
          <path d="M3.9 12.1 L12.1 3.9" class="o mute" />
        }
        @case ('stuck') {
          <polygon points="8,1 15.3,14.4 0.7,14.4" style="fill:var(--fail);stroke-linejoin:round" />
          <rect x="7.2" y="5.6" width="1.6" height="4" rx="0.8" class="inkf" />
          <circle cx="8" cy="11.8" r="0.95" class="inkf" />
        }
        @default {
          <circle cx="8" cy="8" r="6" class="o mute" />
        }
      }
    </svg>
  `,
})
export class StatusIcon {
  readonly name = input.required<Status>({ alias: 'status' });
  readonly size = input(14);
  readonly animate = input(true);
  readonly label = input('');

  // Aliases that share a silhouette.
  protected readonly status = computed(() => {
    const s = this.name();
    return s === 'done' ? 'passed' : s === 'pr_failed' ? 'failed' : s === 'skipped' ? 'cancelled' : s;
  });
}

export type TypeGlyph = 'task' | 'bug' | 'story';

export function typeGlyph(workItemType: string): TypeGlyph {
  const t = workItemType.toLowerCase();
  if (t === 'bug' || t === 'issue') return 'bug';
  if (t === 'task') return 'task';
  return 'story';
}

/** Work item type icons are monochrome; colour is never used for type. */
@Component({
  selector: 'fm-type-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:block;flex:none;line-height:0' },
  styles: `
    .o { fill: none; stroke: var(--icon-mute); stroke-width: 1.4; stroke-linejoin: round; }
  `,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 16 16" role="img" [attr.aria-label]="type()">
      @switch (glyph()) {
        @case ('bug') {
          <circle cx="8" cy="8" r="5.5" class="o" />
          <circle cx="8" cy="8" r="2" style="fill:var(--icon-mute)" />
        }
        @case ('story') {
          <path d="M4 2.5 H12 V13.8 L8 11 L4 13.8 Z" class="o" />
        }
        @default {
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" class="o" />
          <path d="M5.4 8.2 L7.2 10 L10.8 6.2" class="o" />
        }
      }
    </svg>
  `,
})
export class TypeIcon {
  readonly type = input.required<string>();
  readonly size = input(13);
  protected readonly glyph = computed(() => typeGlyph(this.type()));
}
