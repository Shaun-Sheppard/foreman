import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import {
  backend, errorMessage, MODELS, PERSON_EVERYONE, PERSON_ME, Person, RepoInfo, RepoMapping, Settings, Sprint, SPRINT_CURRENT,
} from './backend';
import { ChipList, ToggleChips } from './chips';
import { StatusIcon } from './icons';
import { Store } from './store';

const PAT_SCOPES = 'Work Items (Read & write) · Code (Read & write) · Build (Read)';
const KNOWN_TYPES = ['Bug', 'Task', 'User Story', 'Product Backlog Item', 'Feature', 'Issue'];
const KNOWN_STATES = ['New', 'Approved', 'Committed', 'Active', 'To Do', 'In Progress', 'Doing', 'Resolved'];

@Component({
  selector: 'fm-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusIcon, ChipList, ToggleChips],
  styles: `
    :host { flex: 1; min-height: 0; display: flex; }
    nav { width: 220px; flex: none; border-right: 1px solid var(--border); background: var(--surface); padding: 10px; display: flex; flex-direction: column; gap: 2px; }
    nav button { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text2); text-align: left; }
    nav button:hover { background: var(--hover); }
    nav button.on { background: var(--sel); color: var(--text); font-weight: 500; }
    nav .caps { padding: 14px 10px 6px; }
    nav .kbd { margin-left: auto; font-size: 10.5px; padding: 0 4px; }
    .pane { flex: 1; min-width: 0; padding: 28px 36px 80px; }
    .col { max-width: 760px; display: flex; flex-direction: column; gap: 36px; }
    section { display: flex; flex-direction: column; gap: 14px; }
    .h { font-size: 15px; font-weight: 600; }
    .sub { font-size: 12.5px; color: var(--text2); margin-top: 3px; }
    .grid { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 12px 20px; align-items: center; }
    .grid > label { color: var(--text2); }
    .grid > label.top { align-self: start; padding-top: 6px; }
    .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hint { font-size: 12px; color: var(--text3); }
    .result { font-size: 12.5px; }
    .narrow { max-width: 280px; }
    .repos { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .rhead, .rrow { display: grid; grid-template-columns: 1fr 1fr 1.7fr 1fr 28px; gap: 8px; padding: 8px 12px; align-items: center; }
    .rhead { border-bottom: 1px solid var(--border); }
    .rrow { border-top: 1px solid var(--border); }
    .rrow:first-of-type { border-top: 0; }
    .rrow .field { height: 28px; font-size: 12px; padding: 0 8px; }
    .rrow select.field { background-position: calc(100% - 14px) 12px, calc(100% - 10px) 12px; }
    .path { display: flex; gap: 6px; min-width: 0; }
    .x { border: 0; background: transparent; color: var(--text3); height: 28px; border-radius: 5px; }
    .x:hover { background: var(--hover); color: var(--text); }
    .rnote { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); margin-top: -2px; }
    .rnote.bad { color: var(--fail); }
    .rnote.warn { color: var(--att); }
    .prep { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .prep label { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--text3); }
    .rempty { padding: 14px 12px; color: var(--text3); }
    .dashed { height: 28px; padding: 0 10px; border: 1px dashed var(--border2); border-radius: 6px; background: transparent; color: var(--text2); }
    .dashed:hover:not(:disabled) { background: var(--hover); }
    .dashed:disabled { opacity: 0.5; }
    .stepper { display: flex; align-items: center; width: max-content; border: 1px solid var(--border2); border-radius: 6px; overflow: hidden; }
    .stepper button { width: 30px; height: 28px; border: 0; background: var(--btn2); }
    .stepper button:hover { background: var(--hover); }
    .stepper span { width: 40px; text-align: center; font-family: var(--mono); border-left: 1px solid var(--border2); border-right: 1px solid var(--border2); line-height: 28px; }
    .seg { display: flex; border: 1px solid var(--border); border-radius: 7px; padding: 2px; gap: 2px; width: max-content; }
    .seg button { height: 26px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text2); font-weight: 500; }
    .seg button.on { background: var(--sel); color: var(--text); }
    .switch { width: 32px; height: 18px; border-radius: 9px; border: 1px solid var(--border2); background: transparent; padding: 0; position: relative; flex: none; }
    .switch span { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--text3); }
    .switch.on { background: var(--text); border-color: var(--text); }
    .switch.on span { left: 16px; background: var(--surface); }
    .tpl { display: flex; flex-direction: column; gap: 6px; }
    .tpl label { color: var(--text2); }
    textarea { font-family: var(--mono); font-size: 12px; line-height: 1.6; background: var(--code); border: 1px solid var(--border2); border-radius: 6px; padding: 10px 12px; resize: vertical; outline: none; user-select: text; -webkit-user-select: text; }
    .nlist { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .nlist > div { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
    .nlist > div:first-child { border-top: 0; }
    .setup { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--att); border-radius: 8px; background: var(--att-bg); }
    .setup b { font-weight: 600; }
    .setup div { display: flex; flex-direction: column; gap: 2px; }
    .setup span { font-size: 12.5px; color: var(--text2); }
    nav button:disabled { opacity: 0.5; }
    nav button:disabled:hover { background: transparent; }
  `,
  template: `
    <nav>
      <button [disabled]="!store.configured()" (click)="store.view.set('main')"><span>← Work items</span><span class="kbd">Esc</span></button>
      <div class="caps">Settings</div>
      @for (n of nav; track n.key) {
        <button [class.on]="section() === n.key" (click)="go(n.key)">{{ n.label }}</button>
      }
    </nav>
    <div class="pane scroll" #pane>
      @if (s(); as s) {
        <div class="col">
          @if (missing().length > 0) {
            <div class="setup" role="status">
              <fm-status-icon status="needs_input" [size]="16" />
              <div>
                <b>Finish connecting to Azure DevOps</b>
                <span>Still needed: {{ missing().join(', ') }}. Work items appear once these are saved.</span>
              </div>
            </div>
          }
          <section data-sec="connection">
            <div><div class="h">Azure DevOps connection</div><div class="sub">Used to read work items. The token is kept in your system keychain, never on disk in plain text.</div></div>
            <div class="grid">
              <label for="org">Organisation URL</label>
              <input id="org" class="field mono" spellcheck="false" placeholder="https://dev.azure.com/your-org" [value]="s.orgUrl" (change)="patch({ orgUrl: $any($event.target).value })" />

              <label class="top">Projects</label>
              <fm-chip-list [values]="s.projects" addLabel="Add project" placeholder="Project name" (changed)="patch({ projects: $event })" />

              <label for="pat" class="top">Personal access token</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                <div class="line" style="flex-wrap:nowrap">
                  @if (store.hasPat() && !replacing()) {
                    <input id="pat" class="field" type="password" value="saved-in-keychain-placeholder" disabled />
                    <button class="btn" (click)="replacing.set(true)">Replace</button>
                  } @else {
                    <input id="pat" class="field" type="password" placeholder="Paste token" autocomplete="off" [value]="pat()" (input)="pat.set($any($event.target).value)" (keydown.enter)="savePat()" />
                    <button class="btn" [disabled]="!pat().trim()" (click)="savePat()">Save token</button>
                    @if (store.hasPat()) {
                      <button class="btn ghost" (click)="replacing.set(false); pat.set('')">Cancel</button>
                    }
                  }
                </div>
                <span class="hint">Minimum scopes: {{ scopes }}. Avoid full-access tokens.</span>
              </div>

              <div></div>
              <div class="line">
                <button class="btn" [disabled]="conn().state === 'testing'" (click)="test()">Test connection</button>
                @if (conn().state !== 'idle') {
                  <fm-status-icon [status]="conn().state === 'testing' ? 'running' : conn().state === 'ok' ? 'done' : 'failed'" [size]="14" />
                  <span class="result" [style.color]="conn().state === 'ok' ? 'var(--pass)' : conn().state === 'error' ? 'var(--fail)' : 'var(--text2)'">{{ conn().text }}</span>
                }
              </div>
            </div>
          </section>

          <section data-sec="watching">
            <div><div class="h">Watching</div><div class="sub">What the list shows when the app opens, and what Reset returns to.</div></div>
            <div class="grid">
              <label for="dp">Default person</label>
              <select id="dp" class="field narrow" [value]="s.defaultPerson" (change)="patch({ defaultPerson: $any($event.target).value })">
                @for (o of personOptions(); track o.value) {
                  <option [value]="o.value" [selected]="o.value === s.defaultPerson">{{ o.label }}</option>
                }
              </select>

              <label for="ds">Default sprint</label>
              <select id="ds" class="field narrow" [value]="s.defaultSprint" (change)="patch({ defaultSprint: $any($event.target).value })">
                @for (o of sprintOptions(); track o.value) {
                  <option [value]="o.value" [selected]="o.value === s.defaultSprint">{{ o.label }}</option>
                }
              </select>

              <label class="top">Area paths</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                <fm-chip-list [values]="s.areaPaths" [mono]="true" placeholder="Project\\Area" (changed)="patch({ areaPaths: $event })" />
                @if (s.areaPaths.length === 0) {
                  <span class="hint">No area paths: items from every area are shown.</span>
                }
              </div>

              <label class="top">Work-item types</label>
              <fm-toggle-chips [values]="s.workItemTypes" [options]="knownTypes" (changed)="patch({ workItemTypes: $event })" />

              <label class="top">States that count as to do</label>
              <fm-toggle-chips [values]="s.todoStates" [options]="knownStates" (changed)="patch({ todoStates: $event })" />

              <label for="poll">Sync interval</label>
              <div class="line">
                <input id="poll" class="field mono" style="width:64px" inputmode="numeric" [value]="s.pollIntervalSecs" (change)="setInterval($any($event.target))" />
                <span style="color:var(--text2)">seconds</span>
              </div>
            </div>
          </section>

          <section data-sec="repos">
            <div><div class="h">Repositories</div><div class="sub">Where sessions run for each project. Each item gets its own worktree from the default branch (or another you pick when starting), with your local config copied in and the setup command run, so it can build and run like your main checkout.</div></div>
            <div class="repos">
              <div class="rhead caps"><span>Project</span><span>Area path (optional)</span><span>Local repo path</span><span>Default branch</span><span></span></div>
              @for (r of s.repositories; track $index; let i = $index) {
                <div class="rrow">
                  <select class="field" [attr.aria-label]="'Project for mapping ' + (i + 1)" (change)="editRepo(i, { project: $any($event.target).value })">
                    @for (p of projectChoices(r.project); track p) {
                      <option [value]="p" [selected]="p === r.project">{{ p }}</option>
                    }
                  </select>
                  <input class="field mono" placeholder="Whole project" spellcheck="false" aria-label="Area path" [value]="r.areaPath" (change)="editRepo(i, { areaPath: $any($event.target).value })" />
                  <div class="path">
                    <input class="field mono" placeholder="/path/to/repo" spellcheck="false" aria-label="Local repo path" [value]="r.repoPath" (change)="editRepo(i, { repoPath: $any($event.target).value })" />
                    <button class="btn sm" style="height:28px" (click)="browse(i)">Browse…</button>
                  </div>
                  @if (repoInfo()[r.repoPath]?.info?.branches; as branches) {
                    <select class="field mono" aria-label="Default branch" (change)="editRepo(i, { defaultBranch: $any($event.target).value })">
                      @if (!branches.includes(r.defaultBranch)) {
                        <option value="" selected>{{ r.defaultBranch ? r.defaultBranch + ' (missing)' : 'Choose a branch…' }}</option>
                      }
                      @for (b of branches; track b) {
                        <option [value]="b" [selected]="b === r.defaultBranch">{{ b }}</option>
                      }
                    </select>
                  } @else {
                    <select class="field mono" aria-label="Default branch" disabled><option>{{ r.repoPath ? 'Reading branches…' : 'Choose the repo first' }}</option></select>
                  }
                  <button class="x" [attr.aria-label]="'Remove mapping ' + (i + 1)" (click)="removeRepo(i)">×</button>
                  <div class="prep">
                    <label>Copy into new worktrees
                      <input class="field mono" spellcheck="false" placeholder=".env, **/appsettings.Development.json" [value]="r.copyFiles.join(', ')" (change)="editRepoFiles(i, $any($event.target).value)" />
                    </label>
                    <label>Setup command
                      <input class="field mono" spellcheck="false" placeholder="dotnet restore && npm ci" [value]="r.setupCommand" (change)="editRepo(i, { setupCommand: $any($event.target).value })" />
                    </label>
                  </div>
                  @if (repoNote(r); as note) {
                    <div class="rnote" [class.bad]="note.tone === 'bad'" [class.warn]="note.tone === 'warn'">
                      <fm-status-icon [status]="note.tone === 'bad' ? 'failed' : note.tone === 'warn' ? 'needs_input' : 'done'" [size]="12" />{{ note.text }}
                    </div>
                  }
                </div>
              } @empty {
                <div class="rempty">No repositories mapped yet. Add one for each project you want to run sessions on.</div>
              }
            </div>
            <div><button class="dashed" [disabled]="s.projects.length === 0" (click)="addRepo()">+ Add mapping</button></div>
          </section>

          <section data-sec="sessions">
            <div><div class="h">Sessions</div><div class="sub">When the limit is reached, Start session becomes Queue session.</div></div>
            <div class="grid">
              <label>Max concurrent sessions</label>
              <div class="stepper">
                <button aria-label="Fewer" (click)="patch({ concurrencyLimit: max(1, s.concurrencyLimit - 1) })">−</button>
                <span>{{ s.concurrencyLimit }}</span>
                <button aria-label="More" (click)="patch({ concurrencyLimit: min(12, s.concurrencyLimit + 1) })">+</button>
              </div>

              <label>Default mode</label>
              <div class="seg">
                <button [class.on]="s.defaultMode === 'implement'" (click)="patch({ defaultMode: 'implement' })">Implement</button>
                <button [class.on]="s.defaultMode === 'review'" (click)="patch({ defaultMode: 'review' })">Review</button>
              </div>

              <label for="dm">Default model</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                <select id="dm" class="field narrow" (change)="patch({ defaultModel: $any($event.target).value })">
                  @for (m of models; track m.id) {
                    <option [value]="m.id" [selected]="m.id === s.defaultModel">{{ m.label }}</option>
                  }
                </select>
                <span class="hint">Pre-selected when you start a session; you can change it each time.</span>
              </div>

              <label for="wt">Worktree folder</label>
              <input id="wt" class="field mono" spellcheck="false" placeholder="Beside each repository, in .foreman-worktrees" [value]="s.worktreeRoot" (change)="patch({ worktreeRoot: $any($event.target).value })" />

              <label for="cp">Claude Code path</label>
              <input id="cp" class="field mono" spellcheck="false" placeholder="Found automatically on your PATH" [value]="s.claudePath" (change)="patch({ claudePath: $any($event.target).value })" />

              <label class="top">Tools</label>
              <div style="display:flex;flex-direction:column;gap:8px">
                <div class="line">
                  <button class="switch" role="switch" [class.on]="s.allowAllTools" [attr.aria-checked]="s.allowAllTools" aria-label="Allow all tools without asking" (click)="patch({ allowAllTools: !s.allowAllTools })"><span></span></button>
                  <span>Allow all tools without asking</span>
                </div>
                @if (s.allowAllTools) {
                  <span class="hint">Claude can run any command, including outside the worktree and over the network. It still stops to ask you questions.</span>
                } @else {
                  <fm-chip-list [values]="s.allowedTools" [mono]="true" addLabel="Add tool" placeholder="Tool name, e.g. Bash" (changed)="patch({ allowedTools: $event })" />
                  <span class="hint">These run without asking. Anything else pauses the session for your approval.</span>
                }
              </div>
            </div>
            <div class="tpl">
              <label for="it">Implement prompt template</label>
              <textarea id="it" rows="11" spellcheck="false" [value]="s.implementTemplate" (change)="patch({ implementTemplate: $any($event.target).value })"></textarea>
              <span class="hint">Variables: {{ '{id} {type} {title} {branch} {repo} {area} {target}' }}. The work item's text is added underneath automatically. Clear the box to restore the default.</span>
            </div>
            <div class="tpl">
              <label for="rt">Review prompt template</label>
              <textarea id="rt" rows="8" spellcheck="false" [value]="s.reviewTemplate" (change)="patch({ reviewTemplate: $any($event.target).value })"></textarea>
            </div>
          </section>

          <section data-sec="pr">
            <div><div class="h">PR monitoring</div><div class="sub">Merging is never automatic, whatever these are set to.</div></div>
            <div class="grid">
              <label for="prpoll">Polling interval</label>
              <div class="line">
                <input id="prpoll" class="field mono" style="width:64px" inputmode="numeric" [value]="s.prPollIntervalSecs" (change)="setNumber('prPollIntervalSecs', $any($event.target), 15, 3600, 60)" />
                <span style="color:var(--text2)">seconds</span>
              </div>

              <label for="maxfix">Max fix attempts</label>
              <div class="line">
                <input id="maxfix" class="field mono" style="width:64px" inputmode="numeric" [value]="s.maxFixAttempts" (change)="setNumber('maxFixAttempts', $any($event.target), 1, 10, 3)" />
                <span style="color:var(--text2)">then mark as Stuck</span>
              </div>

              <label>Fix it requires a click</label>
              <div class="line">
                <button class="switch" role="switch" [class.on]="!s.autoFix" [attr.aria-checked]="!s.autoFix" aria-label="Fix it requires a click" (click)="patch({ autoFix: !s.autoFix })"><span></span></button>
                <span class="hint" style="font-size:12.5px">{{ s.autoFix ? 'Off: a failed PR starts a fix by itself, up to the attempt limit.' : 'On: nothing is fixed until you click Fix it.' }}</span>
              </div>

              <label for="marker" class="top">Review comment marker</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                <input id="marker" class="field mono narrow" spellcheck="false" [value]="s.reviewMarker" (change)="patch({ reviewMarker: $any($event.target).value })" />
                <span class="hint">Text that identifies the review tool's PR comment; its decision follows it. Warden posts "**Decision: Reject**" or "**Decision: Approve**".</span>
              </div>

              <label for="strategy">Merge strategy</label>
              <select id="strategy" class="field narrow" (change)="patch({ mergeStrategy: $any($event.target).value })">
                @for (m of strategies; track m.id) {
                  <option [value]="m.id" [selected]="m.id === s.mergeStrategy">{{ m.label }}</option>
                }
              </select>

              <label>After merging</label>
              <div style="display:flex;flex-direction:column;gap:8px">
                <div class="line">
                  <button class="switch" role="switch" [class.on]="s.deleteSourceBranch" [attr.aria-checked]="s.deleteSourceBranch" aria-label="Delete the source branch after merging" (click)="patch({ deleteSourceBranch: !s.deleteSourceBranch })"><span></span></button>
                  <span>Delete the source branch in DevOps</span>
                </div>
                <div class="line">
                  <button class="switch" role="switch" [class.on]="s.completeWorkItems" [attr.aria-checked]="s.completeWorkItems" aria-label="Complete linked work items after merging" (click)="patch({ completeWorkItems: !s.completeWorkItems })"><span></span></button>
                  <span>Let DevOps complete the linked work items</span>
                </div>
                <span class="hint">The local worktree and branch are always removed once the PR is merged.</span>
              </div>

              <label>Wait for the review</label>
              <div class="line">
                <button class="switch" role="switch" [class.on]="s.requireReview" [attr.aria-checked]="s.requireReview" aria-label="Wait for the review before Ready to merge" (click)="patch({ requireReview: !s.requireReview })"><span></span></button>
                <span class="hint" style="font-size:12.5px">{{ s.requireReview ? 'On: a PR is only Ready to merge once the review has approved the latest push.' : 'Off: a PR with no review can still be Ready to merge.' }}</span>
              </div>
            </div>
          </section>

          <section data-sec="notify">
            <div><div class="h">Notifications</div><div class="sub">Desktop notifications. In-app toasts always show.</div></div>
            <div class="nlist">
              <div>
                <fm-status-icon status="needs_input" [size]="14" />
                <span class="spacer">A session needs input</span>
                <button class="switch" role="switch" [class.on]="s.notify.needsInput" [attr.aria-checked]="s.notify.needsInput" aria-label="Notify when a session needs input" (click)="patch({ notify: { ...s.notify, needsInput: !s.notify.needsInput } })"><span></span></button>
              </div>
              <div>
                <fm-status-icon status="failed" [size]="14" />
                <span class="spacer">A session or PR fails</span>
                <button class="switch" role="switch" [class.on]="s.notify.failed" [attr.aria-checked]="s.notify.failed" aria-label="Notify when a session fails" (click)="patch({ notify: { ...s.notify, failed: !s.notify.failed } })"><span></span></button>
              </div>
              <div>
                <fm-status-icon status="ready" [size]="14" />
                <span class="spacer">A PR is ready to merge</span>
                <button class="switch" role="switch" [class.on]="s.notify.ready" [attr.aria-checked]="s.notify.ready" aria-label="Notify when a PR is ready to merge" (click)="patch({ notify: { ...s.notify, ready: !s.notify.ready } })"><span></span></button>
              </div>
              <div>
                <fm-status-icon status="stuck" [size]="14" />
                <span class="spacer">An item is stuck</span>
                <button class="switch" role="switch" [class.on]="s.notify.stuck" [attr.aria-checked]="s.notify.stuck" aria-label="Notify when an item is stuck" (click)="patch({ notify: { ...s.notify, stuck: !s.notify.stuck } })"><span></span></button>
              </div>
            </div>
          </section>
        </div>
      }
    </div>
  `,
})
export class SettingsView {
  protected readonly store = inject(Store);
  protected readonly s = this.store.settings;
  protected readonly scopes = PAT_SCOPES;
  protected readonly knownTypes = KNOWN_TYPES;
  protected readonly knownStates = KNOWN_STATES;
  protected readonly nav = [
    { key: 'connection', label: 'Azure DevOps' },
    { key: 'watching', label: 'Watching' },
    { key: 'repos', label: 'Repositories' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'pr', label: 'PR monitoring' },
    { key: 'notify', label: 'Notifications' },
  ];
  protected readonly section = this.store.settingsSection;
  protected readonly models = MODELS;
  protected readonly strategies = [
    { id: 'squash', label: 'Squash merge' },
    { id: 'noFastForward', label: 'Merge commit (no fast-forward)' },
    { id: 'rebase', label: 'Rebase and fast-forward' },
    { id: 'rebaseMerge', label: 'Rebase with merge commit' },
  ];
  protected readonly max = Math.max;
  protected readonly min = Math.min;
  protected readonly replacing = signal(false);
  protected readonly pat = signal('');
  protected readonly conn = signal<{ state: 'idle' | 'testing' | 'ok' | 'error'; text: string }>({ state: 'idle', text: '' });

  private readonly pane = viewChild.required<ElementRef<HTMLElement>>('pane');
  private readonly people = signal<Person[]>([]);
  private readonly sprints = signal<Sprint[]>([]);

  protected readonly personOptions = computed(() => {
    const me = this.store.me();
    const opts = [
      { value: PERSON_ME, label: me ? `Me (${me.displayName})` : 'Me' },
      { value: PERSON_EVERYONE, label: 'Everyone' },
      ...this.people().map((p) => ({ value: p.uniqueName, label: p.displayName })),
    ];
    const current = this.s()?.defaultPerson;
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return opts;
  });

  protected readonly sprintOptions = computed(() => {
    const multi = (this.s()?.projects.length ?? 0) > 1;
    const opts = [
      { value: SPRINT_CURRENT, label: 'Current sprint' },
      ...[...this.sprints()].reverse().map((sp) => ({ value: sp.path, label: multi ? `${sp.name} — ${sp.project}` : sp.name })),
    ];
    const current = this.s()?.defaultSprint;
    if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    return opts;
  });

  /** Required config that hasn't been entered yet; settings is the only screen until this is empty. */
  protected readonly missing = computed(() => {
    const s = this.s();
    const out: string[] = [];
    if (!s?.orgUrl) out.push('organisation URL');
    if (!s?.projects.length) out.push('a project');
    if (!this.store.hasPat()) out.push('personal access token');
    return out;
  });

  /** Git check results keyed by repo path. */
  protected readonly repoInfo = signal<Record<string, { info?: RepoInfo; error?: string }>>({});

  constructor() {
    // Arriving via a deep link (e.g. "Map repository") lands on that section.
    afterNextRender(() => {
      if (this.section() !== 'connection') this.go(this.section());
    });
    effect(() => {
      const known = this.repoInfo();
      for (const r of this.s()?.repositories ?? []) {
        const path = r.repoPath;
        if (!path || path in known) continue;
        backend.inspectRepo(path).then(
          (info) => this.repoInfo.update((m) => ({ ...m, [path]: { info } })),
          (err) => this.repoInfo.update((m) => ({ ...m, [path]: { error: errorMessage(err) } })),
        );
      }
    });
    effect(() => {
      if (!this.store.configured()) return;
      backend.listPeople().then((p) => this.people.set(p), () => undefined);
      backend.listSprints().then((sp) => this.sprints.set(sp), () => undefined);
    });
  }

  /** Configured projects, plus the row's own value if that project has since been removed. */
  protected projectChoices(current: string): string[] {
    const projects = this.s()?.projects ?? [];
    return projects.includes(current) || !current ? projects : [...projects, current];
  }

  protected repoNote(r: RepoMapping): { tone: 'ok' | 'warn' | 'bad'; text: string } | null {
    if (!r.repoPath) return { tone: 'warn', text: 'Choose the local clone of this repository.' };
    const res = this.repoInfo()[r.repoPath];
    if (!res) return null;
    if (res.error) return { tone: 'bad', text: res.error };
    const branches = res.info?.branches ?? [];
    if (!r.defaultBranch) return { tone: 'warn', text: 'Set the branch new work should start from.' };
    if (!branches.includes(r.defaultBranch)) return { tone: 'bad', text: `Branch "${r.defaultBranch}" doesn't exist in this repository.` };
    return { tone: 'ok', text: `Git repository · ${branches.length} branch${branches.length === 1 ? '' : 'es'}` };
  }

  protected addRepo(): void {
    const s = this.s();
    if (!s) return;
    const unmapped = s.projects.find((p) => !s.repositories.some((r) => r.project === p));
    const row: RepoMapping = { project: unmapped ?? s.projects[0], areaPath: '', repoPath: '', defaultBranch: '', copyFiles: [], setupCommand: '' };
    void this.patch({ repositories: [...s.repositories, row] });
  }

  protected removeRepo(index: number): void {
    const s = this.s();
    if (s) void this.patch({ repositories: s.repositories.filter((_, i) => i !== index) });
  }

  protected editRepoFiles(index: number, raw: string): void {
    const s = this.s();
    const copyFiles = raw.split(',').map((f) => f.trim()).filter(Boolean);
    if (s) void this.patch({ repositories: s.repositories.map((r, i) => (i === index ? { ...r, copyFiles } : r)) });
  }

  protected editRepo(index: number, change: Partial<Omit<RepoMapping, 'copyFiles'>>): void {
    const s = this.s();
    if (!s) return;
    const trimmed = Object.fromEntries(Object.entries(change).map(([k, v]) => [k, v.trim()]));
    void this.patch({ repositories: s.repositories.map((r, i) => (i === index ? { ...r, ...trimmed } : r)) });
  }

  protected async browse(index: number): Promise<void> {
    const path = await this.store.run(() => backend.pickFolder());
    if (!path) return;
    const info = await backend.inspectRepo(path).catch(() => null);
    const row = this.s()?.repositories[index];
    // A fresh mapping takes the repo's checked-out branch as a starting suggestion.
    const defaultBranch = row?.defaultBranch || info?.current || '';
    this.editRepo(index, { repoPath: path, defaultBranch });
  }

  protected go(key: string): void {
    this.section.set(key);
    this.pane().nativeElement.querySelector(`[data-sec="${key}"]`)?.scrollIntoView({ block: 'start' });
  }

  /** Settings save as they change; there is no separate Save button. */
  protected async patch(change: Partial<Settings>): Promise<void> {
    const current = this.s();
    if (!current) return;
    const saved = await this.store.run(() => backend.saveSettings({ ...current, ...change }));
    // Re-set even on failure so an invalid edit snaps back to the stored value.
    this.store.settings.set(saved ?? { ...current });
    this.conn.set({ state: 'idle', text: '' });
  }

  protected setInterval(el: HTMLInputElement): void {
    const n = Math.round(Number(el.value));
    const secs = Number.isFinite(n) ? Math.min(3600, Math.max(15, n)) : 60;
    el.value = String(secs);
    void this.patch({ pollIntervalSecs: secs });
  }

  protected setNumber(key: 'prPollIntervalSecs' | 'maxFixAttempts', el: HTMLInputElement, min: number, max: number, fallback: number): void {
    const n = Math.round(Number(el.value));
    const value = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    el.value = String(value);
    void this.patch({ [key]: value });
  }

  protected async savePat(): Promise<void> {
    if (!this.pat().trim()) return;
    const ok = await this.store.run(() => backend.setPat(this.pat()).then(() => true));
    if (!ok) return;
    this.pat.set('');
    this.replacing.set(false);
    await this.store.reload();
    await this.test();
  }

  protected async test(): Promise<void> {
    const s = this.s();
    if (!s) return;
    this.conn.set({ state: 'testing', text: 'Testing…' });
    try {
      // An unsaved token in the box is tested as typed; otherwise the saved one is used.
      const me = await backend.testConnection(s.orgUrl, s.projects, this.pat().trim() || null);
      const n = s.projects.length;
      this.conn.set({ state: 'ok', text: `Connected as ${me.displayName} · ${n} project${n === 1 ? '' : 's'} reachable` });
    } catch (err) {
      this.conn.set({ state: 'error', text: errorMessage(err) });
    }
  }
}
