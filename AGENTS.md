# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

## Prerequisites and setup

- Use Node.js `^22.19.0` or `>=24.0.0` and the root Yarn `4.18.0` release through Corepack.
- Initialize the pinned upstream checkout with `git submodule update --init --recursive`.
- Install root dependencies with `corepack yarn install --immutable`.

## Build, run, and verify

- Start the desktop development workflow with `corepack yarn dev`.
- Build the desktop package with `corepack yarn build`.
- Run unit tests with `corepack yarn test`.
- Run type checking with `corepack yarn typecheck`.
- Run the complete headless gate with `corepack yarn check`.
- Run upstream operations through the root scripts, such as `corepack yarn upstream:build`.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- `dsh-community-fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- `dsh-community-market/` owns the community-market shell. Until its runtime is implemented, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).

## gs-worker form and server dependency

- `dsh-plugin-desktop/` ships as the gs-worker office Agent and depends on the external gsclaw-server (a separate repository) for sign-in, models, skills, and client-log upload. See [docs/gs-worker-integration.md](docs/gs-worker-integration.md) for the full integration contract.
- A login gate in `dsh-plugin-desktop/src/main.ts` blocks Host boot until a gsclaw-server session exists; the login window and the settings account page never hold tokens themselves.
- The local-skill ban covers only local discovery (`skill-filesystem`) and is enforced in three places: the `skill-filesystem` `disabled: true` row in `dsh-plugin-desktop/cordis.patch.yml`, the stripping/sanitization helpers in `dsh-plugin-desktop/src/profile.ts` (`filterLocalSkillPatches`, `stripLocalSkillCompositionRows`, `materializeDesktopPresetRoot`), and the post-composition assertion `assertEffectiveSkillRows`. `tool-skill` (the model-facing catalog over the `ctx.skills` registry) is allowed — presets mount it per agent to consume the server catalog — but it must keep its canonical package identity `@deepseek-ai/dsh-tool-skill`. Server-delivered skills arrive only through `dsh-plugin-desktop/src/server-skill-provider.ts`. Server-executed skills (`data-query` / `server-mcp` runtime types) never materialize a local bundle: the provider loads their definitions from `/api/v1/skills/:name/definition`, and the desktop-owned Host-plane plugin `server-skill-tools` (`dsh-plugin-desktop/src/server-skill-tools.ts`) bridges the model-facing `run_data_query` / `run_mcp_skill` tools to `POST /api/v1/skills/:name/execute`; any surviving `server-skill-tools` row must keep its canonical package identity `dsh-plugin-desktop/server-skill-tools`.
- LLM calls route only through the loopback proxy (`src/server/gs-llm-proxy.ts`) fed by the mirrored `llm-pi-ai` settings. When changing LLM- or skill-related profile composition, keep `assertEffectiveLlmRows` and `assertEffectiveSkillRows` passing: `llm-deepseek`, `ui-settings-models`, and `skill-filesystem` must never survive composition in an enabled state, the pinned `llm-pi-ai`/`agent-default-model` rows must keep their canonical package identities, and any surviving `tool-skill` or `server-skill-tools` row must keep its canonical package identity.
- Server-pushed application updates (`config.appUpdate`) are consumed by the `desktop-server-updates` plugin (`dsh-plugin-desktop/src/server-updates.ts`, mounted in `cordis.patch.yml`); the headless parse/evaluate logic lives in `dsh-plugin-desktop/src/server-app-update.ts`, and downloads go through `downloadDesktopUpdateFromUrl` in `dsh-plugin-desktop/src/update-download.ts` against the server-delivered credential-free direct links. The only user interaction is the one "Upgrade" click on the prompt; the download then runs unattended into the managed `updates/` directory below userData, and Windows installs silently (NSIS `/S`) and exits, while macOS opens the DMG for a manual install. Managed installer leftovers are deleted silently on the next launch. The contract's `downloadWindow` is shape-validated but never evaluated because this client has no automatic downloads.
