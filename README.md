# Foreman

Desktop app that lists your Azure DevOps work items and (in later phases) runs Claude Code sessions on them.
Tauri 2 + Rust core + Angular UI. See `Foreman — Product Requirements.md` and `design/`.

**Status: all four phases built** — work items, sessions in git worktrees, PR monitoring with Fix it, and Complete merge with clean-up. See "Not yet proven" below.

## Run

```bash
npm install
npm run dev            # real Azure DevOps; opens in Settings until URL, project and token are saved
npm run dev:fixtures   # canned DevOps responses and a stubbed agent: no network, keychain, Claude usage or git changes
```

`FOREMAN_FIXTURES=fresh` starts with an empty database (setup flow); `FOREMAN_FIXTURES=offline` makes every
request fail with a rejected token (sync-error banner).

## Installers

```bash
npm run bundle
```

Builds the agent host into a single executable (needs [Bun](https://bun.sh)), then the app and its installer for the
machine you run it on: a `.dmg` on macOS, NSIS `.exe` and `.msi` on Windows, under `src-tauri/target/release/bundle`.
Windows installers must be built on Windows; `.github/workflows/build.yml` builds both platforms on GitHub Actions.

The installed app needs Claude Code installed and signed in (it drives your `claude`, found on the PATH or set in
Settings → Sessions) and `git`. It does not need Node. Builds are not code-signed with a developer certificate, so
macOS and Windows will warn on first launch.

## Not yet proven

- Nothing has been run against a real Azure DevOps organisation; DevOps calls are tested against canned responses.
- A real Claude session has been driven through the agent host from the command line, but not started from the app
  on a real repository.
- The Windows build has never been run.

## Check

```bash
cd src-tauri && cargo clippy --all-targets && cargo test
npm run test:host
npx ng build
```

## Layout

- `src-tauri/src` — Rust core: `devops/` (REST client, WIQL builder, fixtures), `poller.rs`, `db.rs` (SQLite),
  `secrets.rs` (PAT in the OS keychain only), `lib.rs` (Tauri commands).
- `agent-host` — Node sidecar, one process per session, driving Claude Code through the Claude Agent SDK.
  JSON Lines protocol with the core (`src/protocol.ts`); `--stub` runs a scripted session for fixture mode.
  Needs `node` on your PATH and a logged-in Claude Code (or `ANTHROPIC_API_KEY`).
- `src-tauri/src/pr.rs` — PR polling and the failed / ready / stuck calculation, including reading the review tool's comment.
- `src-tauri/src/sessions.rs` — queueing, worktrees, sidecar supervision; `prompt.rs` builds the session prompt.
- `src/app` — Angular UI. It mirrors core state via events and calls commands; it never touches the network.
