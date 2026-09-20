# Blossom Strap

A Roblox launcher, optimization engine and asset laboratory for Windows 10/11.

Blossom Strap is not a Bloxstrap fork. It studies what Voidstrap and Fleasion
proved viable — launcher ownership and FastFlag management on one side, local
asset interception and caching on the other — and rebuilds both on one spine
that can evolve independently. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for what each of those projects does, where their limits are, and why nothing is
reused from either.

---

## What it does

**Launcher.** Owns the whole launch: resolves a profile, validates it, backs up
every file it is about to change, applies FastFlags and mods, starts the client
and tracks it until it exits. Each step registers how to undo itself, so a
failure rolls back in reverse and never leaves a half-modified client.

**Optimizer.** A catalog of optimizations, not a flag dump. Each names the
mechanism it uses, what it actually does and what to expect — including "nothing,
on your hardware". Actions incompatible with your machine are skipped with a
stated reason. You see the complete plan before anything is written, and `Undo`
replays the exact prior state.

**Profiles.** One unit carrying launcher settings, flags, optimizer choices,
asset rule sets and overlays. Versioned, validated, migrated forward, and
importable from a stranger's export without crashing on a malformed file.

**Assets.** Replace textures, sounds and meshes by asset id, glob or URL
fragment. A rule that cannot be served falls back to the original request, so a
customization mistake can never break your client.

**Cache.** Everything captured, indexed in SQLite and stored content-addressed,
so identical bytes are stored once. Search, filter, preview, export, deduplicate.

**FastFlags.** Values validated against the type their prefix implies, a curated
catalog with honest confidence levels, and a diff showing Roblox's default
beside your override.

**Overlays.** A configurable crosshair and a performance HUD, drawn in separate
transparent click-through windows. Nothing is injected into the Roblox process.

**Diagnostics.** A redacted report you can paste when asking for help, a live
log, and benchmarks that measure your machine rather than quoting numbers.

---

## What it will never do

No code injection, no Lua execution, no memory manipulation, no anti-cheat
interaction, no credential access. Asset replacement is a local rendering
substitution: it changes what your client draws, not what the server sends or
what other players see. [docs/SECURITY.md](docs/SECURITY.md) states the
boundaries and where they are enforced.

---

## Building

```bash
npm install          # also rebuilds native modules against Electron's ABI
npm run dev          # development, with hot reload
npm test             # 190 tests
npm run typecheck
npm run build        # production bundles into out/
npm run package:win  # NSIS installer into release/
```

Requires Node 20+. The installer is per-user and runs `asInvoker`: Blossom never
needs administrator rights, because everything it changes is in your own profile
or in Roblox's own folder.

> **Native module note.** `better-sqlite3` must be built against Electron's ABI,
> not Node's. `npm run package:win` handles this. If you run the app from source
> and see "the asset index is unavailable", run `npx electron-rebuild -f -w
> better-sqlite3`. Blossom detects the mismatch in a child process and degrades
> to "cache unavailable" rather than crashing — see
> `src/main/storage/native-probe.ts` for why that check exists.

---

## Layout

```
src/
  shared/          contracts shared by main and renderer
  preload/         the two-function bridge, and nothing else
  main/
    core/          service host, config, logging, IPC, paths
    platform/      Windows adapter (one PowerShell agent) + test fake
    roblox/        discovery, versions, launcher, process monitor
    profiles/      schema, validation, migration, store
    fastflags/     catalog, syntax, diff, applier
    mods/          content overlay with per-file backup
    optimizer/     hardware probe, action catalog, planner
    assets/        rules, resolver, capture, type sniffing
    interception/  CA, scope, proxy, trust store
    overlay/       crosshair and HUD windows
    diagnostics/   reports and benchmarks
    updater/       channels, verification, separate updater process
    backups/       restore points
    storage/       SQLite index, blob store, native probe
  renderer/        React UI, hand-written CSS
tests/             unit and integration suites
tools/             preview tooling (not shipped)
docs/
```

Dependency direction is strictly downward. Feature modules never import each
other's internals; they talk through interfaces in `shared` or through the
service host.

---

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — process model, launch lifecycle, interception lifecycle, storage, prior art
- [SECURITY.md](docs/SECURITY.md) — what is written, what is refused, where the boundaries live
- [PERFORMANCE.md](docs/PERFORMANCE.md) — what is measured, what it costs, and how to check
- [MODDING.md](docs/MODDING.md) — asset rules, client mods, previews, FastFlags

---

## Licence

MIT. Voidstrap is MIT and Fleasion is GPL-3.0; taking code from the latter would
force GPL on this project, so nothing is reused from either. What was taken is
knowledge of the integration points, which is not copyrightable.
