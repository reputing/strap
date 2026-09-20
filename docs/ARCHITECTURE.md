# Blossom Strap — Architecture

> Status: living document. Updated at the end of every milestone.

Blossom Strap is a Roblox launcher, optimization engine and asset laboratory for
Windows 10/11 x64. It is not a fork of Bloxstrap, Voidstrap or Fleasion. It is a
clean implementation that takes the *ideas* those projects proved viable and
rebuilds them on an architecture that can evolve independently.

---

## 1. Prior art and what we took from it

Before writing any code we studied the two named reference projects. This section
records what they actually do, where their limits are, and what Blossom Strap
does differently. No code was copied from either project.

### Voidstrap (C# / .NET, MIT, fork of Bloxstrap)

What it does:

- Replaces `RobloxPlayerLauncher.exe` as the entry point for the `roblox-player:`
  protocol, so launches from the website route through it.
- Manages Roblox installs under `%LOCALAPPDATA%\Roblox\Versions\version-<id>`.
- Writes FastFlag overrides into `<versionDir>\ClientSettings\ClientAppSettings.json`,
  re-applying them after every Roblox update (Roblox wipes that folder on update).
- Copies "mod" files over `<versionDir>\content` and `ExtraContent` to reskin the client.
- Adds multi-instance, Discord RPC, channel selection and a large curated flag list.

Limits we identified:

- The flag list is a flat dump. There is no model of *why* a flag exists, what it
  costs, whether it is safe, or whether it still applies to the installed client.
- Mods are raw file overwrites with weak provenance. Uninstall/restore is fragile.
- Configuration is a single global blob; there is no first-class profile concept
  that bundles launcher + flags + mods + optimizer state together.
- No asset-level visibility. The user cannot see what the client actually requests.
- Optimization is "apply these flags", not a system that reasons about hardware.

### Fleasion (Python / Qt, GPL-3.0)

What it does:

- Runs a local HTTPS MITM proxy on a loopback high port (58443).
- Relaunches Roblox Player with proxy environment variables so that only that
  process is intercepted, rather than editing the system hosts file (which it
  still supports as a legacy mode requiring elevation).
- Installs its own CA into **Roblox Player's own** `ssl/cacert.pem` bundle, not
  the system trust store.
- Intercepts `assetdelivery.roblox.com/v1/assets/batch` to learn asset IDs and
  their CDN locations, then intercepts the CDN download itself.
- Caches every captured asset with metadata, converts some formats (KTX→PNG,
  mesh→OBJ), and provides mesh/animation viewers.
- Supports replacement rules (ID→ID, ID→file, ID→URL, remove) grouped into
  JSON config profiles.

Limits we identified:

- Interception is all-or-nothing. If the proxy fails, the user finds out by the
  client misbehaving rather than by a status surface.
- The cache index is file-system shaped, which makes search, dedupe and
  filtering expensive as the cache grows.
- GPL-3.0, so nothing from it can be reused in a permissively licensed product.
- Qt/PyInstaller builds are large and start slowly.
- Launcher concerns and asset concerns are entangled in one application.

### The Blossom Strap position

Blossom Strap is the union of both problem domains on one spine:

| Concern | Voidstrap | Fleasion | Blossom Strap |
|---|---|---|---|
| Launch ownership | yes | partial (relaunch) | yes, first-class lifecycle |
| FastFlags | flat list | proxy-injected | catalogued, typed, diffed, validated |
| Mods | file overwrite | n/a | tracked overlay with per-file backup + verified restore |
| Asset interception | no | yes (global to the app) | yes, opt-in module with explicit status and safe fallback |
| Asset index | no | filesystem | SQLite index + content-addressed blob store |
| Optimization | flag presets | n/a | hardware-aware engine with reversible, documented actions |
| Profiles | settings blob | config files | versioned, validated, migratable, exportable bundles |
| Overlays | no | no | crosshair + performance HUD as separate GPU-light windows |
| Recovery | manual | manual | backup manifests, restore points, automatic rollback |

**Licensing.** Voidstrap is MIT and Fleasion is GPL-3.0. Blossom Strap ships as
MIT. Taking code from Fleasion would force GPL on the whole product, so nothing
from it is reused. Nothing from Voidstrap is reused either — the launcher is
written against documented Roblox layout, not against their source. What we take
from both is *knowledge of the integration points*, which is not copyrightable.

---

## 2. Technology

- **Electron 33 + TypeScript.** Chosen explicitly by the brief. The cost of
  Electron is the runtime footprint; the mitigations are in §11, and the
  measured results are in `docs/PERFORMANCE.md`.
- **React 19** for the renderer, with hand-written CSS using design tokens. No UI
  kit, no CSS framework — the visual language is ours and generic framework
  defaults are exactly what we are trying to avoid.
- **better-sqlite3** for the asset/cache index, behind an interface with a pure-JS
  fallback so a failed native load degrades instead of bricking the app (§8).
- **node-forge** for generating the interception CA. No shelling out to OpenSSL.
- **electron-vite** for build, **vitest** for tests, **electron-builder** (NSIS) for packaging.

Everything else is Node and Windows built-ins. The dependency surface is kept
deliberately small: every dependency is a supply-chain and startup-cost liability.

---

## 3. Process model

```
┌──────────────────────────────────────────────────────────────┐
│ main process  (Node, privileged)                             │
│                                                              │
│  ServiceHost ── lifecycle, DI, IPC router                    │
│    ├─ ConfigService        settings + persistence            │
│    ├─ LogService           structured, rotating              │
│    ├─ StorageService       SQLite index + blob store         │
│    ├─ RobloxService        discovery / versions / channels   │
│    ├─ LauncherService      launch lifecycle                  │
│    ├─ ProcessMonitor       event-driven, WMI-backed          │
│    ├─ ProfileService       profiles, validation, migration   │
│    ├─ FastFlagService      catalog, diff, apply              │
│    ├─ ModService           overlay files + backups           │
│    ├─ OptimizerService     hardware model + actions          │
│    ├─ AssetService         rules, resolver, cache index      │
│    ├─ InterceptionService  proxy engine (opt-in, isolated)   │
│    ├─ OverlayService       crosshair / HUD windows           │
│    ├─ DiagnosticsService   reports + benchmarks              │
│    └─ UpdateService        channels, staging, handoff        │
└──────────────────────────────────────────────────────────────┘
        │ contextBridge (typed, allow-listed)
┌───────┴──────────────────┐   ┌──────────────────────────────┐
│ renderer  (UI, sandboxed)│   │ overlay renderers            │
│  no Node, no remote      │   │  transparent, click-through  │
└──────────────────────────┘   └──────────────────────────────┘

        ↓ spawned, short-lived, separate executables
┌──────────────────────┐  ┌──────────────────────────────────┐
│ updater process      │  │ elevation helper (only if asked) │
└──────────────────────┘  └──────────────────────────────────┘
```

Rules:

1. The renderer has `nodeIntegration: false`, `contextIsolation: true`,
   `sandbox: true`. It talks to the main process only through the allow-listed
   bridge in `src/preload`.
2. No service touches `BrowserWindow`. UI updates leave the main process as
   events on a single typed channel.
3. The interception proxy runs inside the main process but is fully isolated
   behind a lifecycle interface; it can be started, stopped and crashed without
   taking anything else down.
4. Anything needing elevation is a separate, minimal helper invoked explicitly.
   The main process never runs elevated.

---

## 4. Module map

```
src/
├── shared/          contracts shared by main and renderer (types, IPC map, schemas)
├── preload/         contextBridge surface
├── main/
│   ├── core/        service host, config, logging, ipc, paths, result types
│   ├── platform/    Windows adapter (registry, WMI, processes) + test fake
│   ├── roblox/      discovery, version parsing, client-version API, launcher, monitor
│   ├── profiles/    schema, validation, migration, store, import/export
│   ├── fastflags/   catalog, typed values, diff engine, applier
│   ├── mods/        overlay manifest, backup, apply/restore
│   ├── optimizer/   hardware probe, action catalog, presets, planner, applier
│   ├── assets/      rule model, resolver, router, cache index, capture sources
│   ├── interception/ CA store, MITM proxy, env scoping, status
│   ├── overlay/     crosshair + HUD window management, hotkeys
│   ├── diagnostics/ report builder, benchmark suite
│   ├── updater/     channel client, downloader, verifier, staging
│   └── index.ts     entry point
├── renderer/        React UI
└── tests/           vitest suites
```

Dependency direction is strictly downward: `shared` ← `main/core` ← feature
modules. Feature modules never import each other's internals; they communicate
through interfaces declared in `shared` or injected by the service host.

---

## 5. Roblox launch lifecycle

```
launch(request)
  1 resolve profile            → merged effective configuration
  2 discover installation      → version dir, player exe, channel
  3 pre-flight validation      → exe exists, version known, profile compatible
  4 create restore point       → snapshot of every file we are about to touch
  5 apply FastFlags            → write ClientSettings/ClientAppSettings.json
  6 apply mods                 → copy overlay files, record backup manifest
  7 prepare interception       → start proxy, mint cert, build scoped env  (opt-in)
  8 build argv + env           → deeplink args, proxy vars, working dir
  9 spawn                      → detached, stdio ignored
 10 confirm                    → wait for the process to register with the monitor
 11 attach                     → monitor CPU/RAM/uptime; start overlays; start capture
 12 exit                       → detect exit, stop capture, stop overlays
 13 restore                    → roll the restore point back if configured
```

Every step is a `Result<T>`; a failure at any step runs the compensation for the
steps already completed, in reverse. Step 4 exists so that step 13 is always
possible even after a crash — restore points survive process death and are
reconciled at next start.

Player and Studio are separate `RobloxKind`s with separate installations,
separate flag targets and separate monitors. Studio is never modified unless a
feature explicitly declares `supportsStudio`.

---

## 6. Asset interception lifecycle

```
Roblox Player
   │  (libcurl honours http_proxy / https_proxy / CURL_CA_BUNDLE,
   │   set only in the child process environment)
   ▼
Blossom proxy (loopback, ephemeral port)
   │
   ├─ CONNECT → is this host in scope?  ── no ──► blind tunnel (untouched bytes)
   │                                      yes
   ▼
 TLS terminate with a per-host leaf signed by the Blossom CA
   │
   ▼
 AssetRouter
   ├─ observe   → record request into the capture stream
   ├─ resolve   → ReplacementResolver: rules for the active asset profile
   │              ordered by priority; first enabled match wins
   ├─ hit       → serve from blob store (ID→file / ID→URL / ID→ID / remove)
   └─ miss      → forward upstream, tee the response into the cache, index it
```

Scope is an explicit allow-list of Roblox asset hosts. Everything else —
authentication, payments, telemetry, anything not asset delivery — is tunnelled
without decryption. That is a hard boundary, enforced in one place, and covered
by a test.

**Failure policy is always "the original request wins".** If the resolver
throws, the blob is missing, the disk is full, or a rule is malformed, the proxy
forwards the untouched upstream request. A customization bug must never be able
to break someone's client.

**Capture without the proxy.** Interception is opt-in and needs a CA in Roblox's
bundle. For users who do not want that, a passive capture source watches
Roblox's own on-disk HTTP cache and log directory and indexes what it can. It
sees less (newer clients strip request headers from cache entries) and it is
reported as `degraded` rather than silently pretending to be equivalent.

---

## 7. Configuration and storage

All state lives under `%LOCALAPPDATA%\BlossomStrap\`:

```
BlossomStrap/
├── config.json            settings (atomic write, schema-versioned)
├── profiles/*.json        one file per profile, versioned + validated
├── assets/
│   ├── index.db           SQLite: assets, rules, capture sessions
│   └── blobs/ab/cd/<sha256>   content-addressed blob store
├── backups/<restorePointId>/  file backups + manifest.json
├── proxy/                 CA key + cert, per-host leaf cache
├── logs/blossom-*.log     rotating structured logs
└── updates/               staged update payloads
```

Writes to `config.json` and every profile go through the same atomic
write-temp-then-rename helper, with a `.bak` retained. A corrupt file is moved
aside to `*.corrupt-<timestamp>` and replaced by defaults rather than crashing.

The blob store is content-addressed by SHA-256: identical bytes are stored once,
which is what makes cache dedupe free. SQLite holds metadata only; blobs never
go inside the database.

---

## 8. Profiles

A profile is a versioned bundle:

```jsonc
{
  "schemaVersion": 1,
  "id": "…", "name": "Competitive",
  "launcher":  { /* args, priority, multi-instance, close behaviour */ },
  "fastFlags": { /* flag id → value */ },
  "optimizer": { /* preset + per-action overrides */ },
  "assets":    { /* enabled asset profile ids, interception toggle */ },
  "overlay":   { /* crosshair + HUD */ },
  "appearance":{ /* accent, density */ }
}
```

Validation happens before anything is applied, and returns a list of issues
rather than throwing. A profile that fails validation can still be opened and
repaired in the UI — it simply cannot be launched with. Migration is a chain of
pure `v(n) → v(n+1)` functions, so an old export always loads.

---

## 9. Optimizer

The optimizer is a catalog of `OptimizationAction`s, not a flag dump. Each action
declares: id, title, description, the *mechanism* it uses (FastFlag, client
setting, process attribute, filesystem), expected effect, risk level, whether it
is reversible, and a compatibility predicate over `{hardware, windows, robloxVersion}`.

A preset (Conservative / Balanced / Performance / Low End / Custom) is a
selection over that catalog. Applying a preset:

1. builds a **plan** — the exact set of changes, with a preview the user can read;
2. takes a restore point;
3. applies each change, recording the prior value;
4. verifies;
5. on any failure, rolls the whole plan back.

`Undo` replays recorded prior values. `Reset to Roblox defaults` removes every
Blossom-owned key rather than writing guesses about what Roblox's default is.

No action claims an FPS number. Each action states its mechanism and lets the
benchmark suite produce measurements.

---

## 10. Diagnostics, logging, errors

Logging is structured (`level`, `time`, `scope`, `message`, `data`) and rendered
in a compact human format. Default level is `Information`; `Trace`/`Debug` are
opt-in. Logs rotate by size and count. The renderer never writes log files.

Errors use a `Result<T, BlossomError>` type across service boundaries.
`BlossomError` carries a stable `code`, a user-facing message, and optional
remediation. Unexpected exceptions are caught at the IPC boundary, logged with
their stack, and returned as a generic error — the renderer never sees a raw stack.

The diagnostics report is assembled from live service state and redacts the user
name from every path before it can be copied or saved.

---

## 11. Performance strategy

The honest risk of an Electron app in this category is that the launcher costs
more than it saves. Concretely, we:

- **Do not poll.** Process lifetime comes from a WMI event subscription, not a
  `tasklist` loop. Sampling of CPU/RAM only runs while a window that displays it
  is visible, at 1 Hz, and stops on blur/hide.
- **Do not rescan.** Roblox discovery is cached and invalidated by a directory
  watcher on the Versions folder, not re-run per navigation.
- **Never block the UI thread.** All JSON parsing, hashing and SQLite work is in
  the main process; large scans run in worker threads.
- **Virtualize.** The cache browser renders a window of rows over a keyset-paginated
  query. Thousands of assets never enter renderer memory.
- **Lazy previews.** Previews are decoded on demand, bounded by an LRU with a
  byte budget, and cancelled on navigation.
- **Bounded queues.** Capture ingestion is a bounded async queue that drops
  oldest-first under pressure and reports the drop, rather than growing without limit.
- **Idle down.** With no Roblox process and no visible window, every timer is
  cleared; the app sits on event subscriptions only.
- **Background mode.** Closing to tray destroys the renderer window by default,
  leaving the main process and its subscriptions alive.

The benchmark suite in Diagnostics measures launch time, memory, cache hit rate
and interception overhead so these claims stay testable rather than aspirational.

---

## 12. Security boundaries

- Renderer is sandboxed and context-isolated; the bridge is an explicit allow-list.
- The main process never runs elevated. Privileged work is a separate helper,
  invoked only after the UI has explained exactly what will be changed and why.
- The interception CA is generated locally, stored with the user's profile, and
  installed **only** into Roblox's own `ssl/cacert.pem` (with a backup), never
  into the Windows trust store.
- Interception scope is an allow-list of asset hosts. Auth, payment and telemetry
  traffic is tunnelled opaquely and is never decrypted.
- Uninstall reverses everything: flags removed, mods restored from manifest, CA
  removed from Roblox's bundle, protocol handler unregistered.
- Out of scope, permanently: code injection, Lua execution, memory manipulation,
  anti-cheat interaction, credential or token access. Blossom Strap is a local
  customization and configuration tool. See `docs/SECURITY.md`.

---

## 13. Update system

Channels: `stable` and `preview`. The app checks a release manifest, verifies the
downloaded payload against the SHA-256 in the manifest, and stages it under
`updates/`. A separate updater executable performs the swap after the main
process exits, and keeps the previous version so a failed start rolls back. The
running executable is never overwritten in place.

---

## 14. Roblox version changes

`RobloxService` watches the Versions directory. On a version change:

1. the new version is recorded;
2. every active modification is re-evaluated against its compatibility predicate;
3. anything incompatible is **disabled, not adapted**, and reported;
4. FastFlags are re-applied (Roblox wipes `ClientSettings` on update);
5. profiles are untouched.

Nothing potentially incompatible is applied silently.

---

## 15. Decisions made during implementation

Recorded here because each one was a change of direction, not a detail.

**The native module is probed in a child process.** A native module built
against a different Node ABI does not throw: `require` succeeds and the process
dies the first time the module is used. That is a hard crash mid-startup that no
`try`/`catch` can intercept, and it is reachable in production whenever an
update changes Electron's ABI before the rebuild lands. So the first use happens
in a short-lived child that opens an in-memory database and exits. If it
crashes, we learn that safely and the index reports itself unavailable — which
every caller already handles. The answer is cached against the runtime's ABI, so
it costs one child process per Electron version.

**The overlay shares geometry, not a component.** Sharing a React component
between the crosshair designer and the overlay window was the obvious way to
keep one source of truth, and it put a 613 kB chunk into a 400-pixel transparent
window. Sharing the geometry instead — a pure function returning lines, a dot
and a circle — keeps one source of truth while the designer renders JSX and the
overlay renders SVG DOM with no framework at all.

**Optimizations are written into the profile, not into Roblox.** The launcher is
the single place that touches the client. Routing the optimizer through it means
the optimizer inherits restore points and rollback for free, and the user can
see a preset's complete effect before Roblox is ever started.

**Interception reports itself degraded rather than assuming success.** The proxy
is reached through environment variables in the launched client's process. If
the client ignores them, the proxy simply sees no traffic. Rather than claim to
be working, the engine checks after a grace period and marks itself degraded
with a reason the UI shows.

**The interception scope is a positive allow-list.** The first version was a
deny-list of sensitive hosts with a negative lookahead for "not Roblox", which
was both hard to read and wrong at the apex domain. A deny-list is one
forgotten hostname away from being wrong; the allow-list is checked in one
function and covered by tests that include substring-collision attempts.
