# Foreman — Product Requirements

Oct 9, 2026 · @Shaun Sheppard

Foreman is a single-user desktop app that lists my Azure DevOps work items, starts a Claude Code session on any of them in one click, runs several sessions in parallel, and watches each resulting PR through to merge, offering to fix failures. This document defines what to build and how it should behave; the visual design is supplied separately and is the authority on look and layout.

## Goals and non-goals

Foreman replaces typing "work on item 4512" into Claude by hand with one click per work item, and replaces checking PRs by hand with a live status board.

**Goals**

1. Show only my work items, filtered by sprint and assignee, refreshed from Azure DevOps about every 60 seconds.
2. Start a Claude Code session on a work item in at most two clicks, in an isolated git worktree and branch.
3. Run several sessions at once, switch between them instantly, and see each one's step-by-step progress with a status icon per step.
4. Surface anything that needs me (a question, a permission, a failed PR, a PR ready to merge) at a glance and with a desktop notification.
5. After Claude raises a PR, monitor its build, automated review and merge status, and offer a one-click Fix it that resumes the session with the failure details.
6. Let me complete the merge from Foreman with a deliberate click.

**Non-goals**

- Reviewing code. A separate existing tool reviews each PR; Foreman only reads its result.
- Merging automatically. Merge is always a manual action.
- Multi-user or team use. Foreman runs on one machine for one person.
- Replacing Azure DevOps. Foreman reads and updates DevOps; DevOps stays the source of truth.
- Mobile or web versions.

## Architecture

Four services in the Tauri Rust core do all the work; the Angular UI only displays their state and sends user actions back as Tauri commands.

&#91;embedded content: Foreman architecture · renderer, four main-process services, four external systems\]

Each Claude Code session runs with its worktree as the working directory, so its edits, commits and pushes stay on that work item's branch. The DevOps poller then picks up the PR Claude raised.

## Tech stack and key decisions

Build Foreman as a Tauri 2 app: an Angular UI in the webview, a Rust core that owns all state, and a small Node sidecar per session that drives Claude Code through the Claude Agent SDK. Check every SDK, Tauri and Azure DevOps API detail below against current documentation before relying on it.

| Area | Decision | Why |
| --- | --- | --- |
| Shell | Tauri 2, latest stable | Owner's choice; small installers and a native Rust core |
| UI | Angular (latest), standalone components, signals, in the Tauri webview | Matches the owner's core stack, so he can maintain it |
| Core | Rust: DevOps polling, git, storage, process supervision, notifications | One place owns state and every side effect |
| Agent runtime | A Node "agent host" sidecar, one process per session, running the Claude Agent SDK for TypeScript; talks to the core over stdin/stdout as JSON Lines | The SDK is TypeScript/Python only, so it can't run inside Rust; one process per session isolates crashes |
| Fallback runtime | Rust spawns `claude -p --output-format stream-json --input-format stream-json` directly | No sidecar to bundle, but permission prompts and questions need extra plumbing; use only if the sidecar route fails |
| Azure DevOps | REST API (api-version 7.1 or later) via `reqwest`, PAT auth | Full control over polling and back-off |
| Git | `git` CLI via `std::process::Command` | Worktrees are the isolation mechanism; the CLI is the most reliable interface |
| Local storage | SQLite via `rusqlite` in the app data directory | Sessions, attempts and settings survive restarts |
| Secrets | `keyring` crate (Windows Credential Manager, macOS Keychain) for the DevOps PAT | Never store the PAT in plain text or in SQLite |
| IPC | Tauri commands for user actions, Tauri events for state updates | The webview never touches git, the network or the filesystem directly |
| Notifications | `tauri-plugin-notification` | Native desktop notifications with click-through |
| Packaging | Tauri bundler; the agent host compiled to a single executable per target and declared as an external binary (sidecar) | Users need no separate Node install for the agent host |

**Key decisions**

- **The Rust core owns all state.** Sessions, polling, git and storage are managed by the core. The webview is a view that subscribes to state events, so closing or reloading the window never kills a session.
- **One agent host per session.** The core starts a sidecar process for each session, passing the worktree path, prompt and (for fixes) the SDK session ID to resume. If a sidecar crashes, only that session is marked Interrupted.
- **A small, versioned sidecar protocol.** Core to sidecar: start, resume, reply, approve, deny, stop. Sidecar to core: steps updated, log entry, needs input, session ID, ended (with outcome and cost). Every message carries a protocol version.
- **One worktree per work item.** Branch name `foreman/{workItemId}-{slug-of-title}`, worktree under a configurable root (default `{repo}/../.foreman-worktrees/{workItemId}`). Fix sessions reuse the same worktree and branch.
- **Resume, don't restart, for fixes.** Store the SDK session ID for every session so Fix it can resume with full context.

## Functional requirements

Requirements are numbered so issues and commits can reference them. The visual design defines how each one looks; this section defines what it does.

### FR1 — Work items

- **FR1.1** Fetch work items with a WIQL query built from the current filters (project, sprint/iteration path, assigned to, work item types, states), then fetch details in batches of up to 200 IDs.
- **FR1.2** Fields shown: ID, type, title, state, assigned to, iteration, priority, changed date, description, acceptance criteria, linked items and the latest comments.
- **FR1.3** Top-bar filters: sprint (default: the team's current iteration) and person (default: me; also any team member or Everyone). Filter changes take effect immediately and persist between launches.
- **FR1.4** Poll every 60 seconds (configurable) plus a manual refresh. Show the time of the last successful sync. Merge results into local state without resetting the user's selection or scroll position.
- **FR1.5** Group the list into Needs attention, Active sessions, Not started and Completed, with the counts shown in the summary strip. Free-text search over ID and title.

### FR2 — Starting a session

- **FR2.1** Start session takes a mode: Implement (default) or Review. Each mode has an editable prompt template in settings.
- **FR2.2** Build the prompt from the template plus the work item's title, description, acceptance criteria, linked items and comments. Show it in an optional, editable preview before launch.
- **FR2.3** Starting a session always asks which repository and base branch to use, pre-filled from the repository mapping in settings (the project's default branch, e.g. `dev`), so a fix can be based on another branch such as `releases/1.33`. If no mapping matches, ask the user to pick one and offer to save it.
- **FR2.8** Starting a session also asks which Claude model to use.
- **FR2.4** Create the worktree and branch (see Key decisions), then start the SDK session with `cwd` set to the worktree.
- **FR2.5** Implement-mode prompts must instruct Claude to: keep a task list as it works; commit with a message referencing the work item (`AB#{id}`); push the branch; and raise a PR to the base branch linked to the work item. Foreman detects the PR (FR4.1) rather than creating it.
- **FR2.6** Enforce a configurable concurrency limit (default 3). Starts beyond the limit are queued in order and launched when a slot frees.
- **FR2.7** Each session gets environment variables `FOREMAN_WORK_ITEM_ID` and `FOREMAN_PORT_BASE` (a unique block of 10 ports per session), and the prompt tells Claude to use them for dev servers, so parallel sessions don't collide.

### FR3 — Session progress and input

- **FR3.1** Parse the SDK message stream. When Claude updates its task list, replace the session's step list with the new items and their states: pending, in progress, completed. (Current SDK builds don't expose TodoWrite to SDK sessions, so the agent host provides its own `mcp__foreman__set_steps` tool and the prompt tells Claude to use it; TodoWrite and TaskCreate/TaskUpdate are still understood if they appear.)
- **FR3.2** Record every message in a per-session log: assistant text, tool calls (name and a short summary of inputs), tool results (truncated), and errors. Stream log entries to the renderer live.
- **FR3.3** Use the SDK's permission callback to intercept tool permission requests not covered by the allow-list in settings. Put the session into Needs input, show the request, and resolve it with the user's approve or deny.
- **FR3.4** When Claude asks the user a question, put the session into Needs input and send the user's typed reply back into the session.
- **FR3.5** Stop session cancels the SDK query, marks the session Cancelled, and keeps the worktree.
- **FR3.6** When a session ends, record its outcome (success, error, cancelled), duration and cost if the SDK reports it.

### FR4 — PR monitoring

- **FR4.1** After a session ends successfully, find the PR whose source branch matches the session's branch. If none exists after the session ends, mark the item Failed with "No PR raised" and offer Fix it.
- **FR4.2** Poll each open PR every 60 seconds (configurable) for: PR status and `mergeStatus` (conflicts); branch policy evaluations (build validation and any other required policies); and comment threads.
- **FR4.3** Treat the PR as Failed when any of: a required policy is rejected; build validation failed; `mergeStatus` reports conflicts; or the automated review tool's latest review of the current push is a Reject whose thread is still active (identified by a configurable marker in the comment text, since the tool posts as the user).
- **FR4.4** For a failed build, fetch the build timeline, identify the failed task, and download only that task's log. Keep the last 200 lines around the first error.
- **FR4.5** Treat the PR as Ready to merge when all required policies are approved, there are no conflicts and no active review threads.
- **FR4.6** Stop polling a PR once it is completed or abandoned.

### FR5 — Fix it

- **FR5.1** Fix it resumes the original SDK session by session ID in the same worktree. If resume fails, start a new session in the same worktree with the work item brief plus a summary of the previous session.
- **FR5.2** The fix prompt includes the failure details from FR4.3–FR4.4: the trimmed build log, each active review thread (file, line, comment text), and any conflict. It instructs Claude to fix them, push to the same branch, and reply to and resolve each review thread it addressed.
- **FR5.3** Count fix attempts per PR. When the configurable maximum (default 3) is reached, mark the item Stuck and replace Fix it with Open in DevOps and Start manual session.
- **FR5.4** Fix it is manual by default. A settings option allows automatic fixes, which still respect the attempt limit.

### FR6 — Merge and clean-up

- **FR6.1** Complete merge sets the PR to completed through the API, using the PR's last merge source commit and the merge strategy from settings (default squash), with delete source branch and complete linked work items configurable.
- **FR6.2** After a successful merge, remove the worktree and local branch, and move the item to Completed.
- **FR6.3** Never merge without an explicit user click.

### FR7 — Settings

- **FR7.1** Azure DevOps: organisation URL, projects, PAT (stored per NFR1), and a connection test.
- **FR7.2** Watching: default sprint and people, work item types, states counted as "to do", area paths.
- **FR7.3** Repositories: map a DevOps project or area path to a local repo path, DevOps repository and default base branch (configurable per project). Foreman supports several DevOps projects at once.
- **FR7.4** Sessions: concurrency limit, default mode, prompt templates, tool allow-list, model choice, worktree root.
- **FR7.5** PR monitoring: polling intervals, review tool author name, maximum fix attempts, automatic fixes on or off, merge strategy.
- **FR7.6** Notifications: on or off for needs input, PR failed, ready to merge and stuck.

### FR8 — Notifications

- **FR8.1** Raise a desktop notification when an item enters Needs input, Failed, Ready to merge or Stuck, per the settings. Clicking it focuses Foreman with that item selected.
- **FR8.2** Show the Needs attention count as a badge on the app or taskbar icon.

## Data and storage

Five SQLite tables hold everything Foreman needs to survive a restart; work item content itself is cached, not owned, and is always refreshed from DevOps.

| Table | Key fields | Notes |
| --- | --- | --- |
| `work_item_cache` | `id`, `rev`, `json`, `fetched_at` | Last fetched copy; overwritten on each sync |
| `session` | `id`, `work_item_id`, `mode`, `sdk_session_id`, `repo_path`, `worktree_path`, `branch`, `state`, `started_at`, `ended_at`, `outcome`, `cost_usd` | One row per session, including fix sessions |
| `session_step` | `session_id`, `position`, `text`, `state`, `updated_at` | Latest task list for each session |
| `pull_request` | `id`, `work_item_id`, `repo_id`, `branch`, `status`, `merge_status`, `checks_json`, `fix_attempts`, `last_polled_at` | One row per PR Foreman is tracking |
| `setting` | `key`, `value_json` | All settings except the PAT |

- Session logs are written as JSON Lines files under `{appDataDir}/logs/{sessionId}.jsonl`, not in SQLite, and pruned after 30 days (configurable).
- On startup, any session that was running when Foreman closed is marked Interrupted, with a Resume action that resumes it by SDK session ID.
- Item lifecycle state is derived from the session and PR rows, not stored separately, so it can't drift.

## Non-functional requirements

Foreman handles client source code and a DevOps token, so security comes first; it must also keep working through network drops and restarts.

**NFR1 — Security**

- Store the PAT only in the OS keychain through the `keyring` crate. Never log it, never send it to the webview or the agent host, never include it in a prompt.
- Document the minimum PAT scopes: Work Items (read and write), Code (read and write), Build (read). Warn in settings if the test call shows broader access than needed.
- Tauri capabilities grant the webview only Foreman's own commands and the notification plugin: no filesystem, shell or HTTP plugins. Set a strict content security policy.
- Sessions run only inside their own worktree. The tool allow-list defaults to no network-fetch tools and no commands outside the worktree; anything else goes through the permission callback (FR3.3).
- Work item text is untrusted input. Prompt templates must wrap it in clearly marked delimiters and tell Claude to treat it as a description of the task, not as instructions that override the template.

**NFR2 — Reliability**

- DevOps errors (network, 401, 429, 5xx) never crash the app. Back off exponentially on 429 and 5xx, respect `Retry-After`, and show a non-blocking banner with the last good sync time.
- A crashed or erroring session never affects other sessions.
- All git operations check for an existing worktree or branch before creating one, so a retried start is safe.

**NFR3 — Performance**

- The UI stays responsive (no frame over 100 ms) with 5 sessions streaming and 200 work items listed.
- Switching between items renders the detail pane in under 100 ms from local state.
- Log views virtualise long logs; never render more than a few hundred lines at once.

**NFR4 — Quality**

- TypeScript strict mode in the UI and agent host; Rust passes clippy with no warnings. Unit tests for the WIQL builder, the stream-message parser, the PR state calculation (FR4.3, FR4.5) and the fix-attempt counter.
- An integration test mode that runs against recorded DevOps API responses and a stubbed agent runtime, so the UI can be exercised without a real organisation or Claude usage.

## Delivery phases

Build in four phases, each usable on its own; stop at the end of each phase for the owner to try it before starting the next.

### Phase 1 — See my items

Scope: app shell, settings for DevOps connection and filters, work item list and detail (FR1, FR7.1–FR7.2, NFR1).

- [ ] Entering an organisation URL and PAT and pressing Test shows success or a specific error.
- [ ] The list shows only items for the selected sprint and person, and changes when either filter changes.
- [ ] Editing an item in DevOps shows in Foreman within 60 seconds without losing the current selection.
- [ ] The PAT is not present in plain text anywhere on disk.

### Phase 2 — Run sessions

Scope: starting sessions, worktrees, step tracking, needs input, concurrency (FR2, FR3, FR7.3–FR7.4, FR8).

- [ ] Start session on an item creates its worktree and branch and shows steps updating live.
- [ ] Three sessions run at once; a fourth start is queued and launches when one finishes.
- [ ] A permission request or question moves the item into Needs attention, raises a notification, and the reply reaches Claude.
- [ ] Closing and reopening Foreman mid-session shows the session as Interrupted with a working Resume.

### Phase 3 — Watch PRs and fix

Scope: PR detection, polling, failure details, Fix it, attempt limit (FR4, FR5, FR7.5).

- [ ] A session that raises a PR shows the PR number and live check states.
- [ ] A failing build shows the failed task and its log excerpt; Fix it resumes the session and the PR re-runs its checks.
- [ ] Active threads from the review tool show as Failed with file and line, and Fix it resolves the threads it addresses.
- [ ] After the maximum attempts the item shows Stuck and Fix it is no longer offered.

### Phase 4 — Merge and polish

Scope: merge, clean-up, keyboard navigation, packaging (FR6, NFR3, NFR4).

- [ ] Complete merge merges the PR with the configured strategy and removes the worktree and branch.
- [ ] Nothing merges without a click.
- [ ] Up/down, Enter and the next-attention shortcut all work.
- [ ] Installers build for Windows and macOS.

## Open questions

The building agent should ask the owner these before the phase that depends on each one, and must not guess.

- [x] How does the PR review tool report its result: comment threads, a PR status, a vote, or more than one? (Phase 3) — Checked in the tool's source (Warden, `RandomProjects/prreview`): one PR-level comment thread starting `**Decision: Approve | Approve (with suggestions) | Reject**`, posted under the user's own identity (so it is identified by that marker text, not by author). A Reject thread is left active; an Approve thread is posted already closed. Issues are listed inside the comment as `` `path:line` — text `` under Critical / Major / Minor headings, not as separate inline threads. Optionally it also votes (Approved, Approved with suggestions, or Waiting for author). It re-reviews on every new commit and does not close its earlier threads, so Foreman uses the latest review and resolves the Reject thread itself after a fix is pushed.
- [x] Should Foreman change the work item's state in DevOps when a session starts or a PR merges, and to which states? (Phase 2) — Not for now; to be revisited.
- [x] Are all repos Azure Repos Git, or are some hosted elsewhere? (Phase 2) — All Azure Repos.
- [x] Which Claude model and tool allow-list should be the defaults? (Phase 2) — Model: chosen by the user when starting each session. Tools: allow all for now.
- [ ] Is macOS needed, or Windows only? (Phase 4)
