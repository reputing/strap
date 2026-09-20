import { app, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings, Profile } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ServiceHost } from './service-host';
import { SearchService, COMMANDS } from '@main/search/search-service';
import { DiagnosticsService } from '@main/diagnostics/diagnostics-service';
import { sanitiseScope } from '@main/interception/scope';
import { FastFlagService } from '@main/fastflags/fastflag-service';
import { writeFileAtomic } from './fs-utils';

export interface HandlerContext {
  host: ServiceHost;
  mainWindow: () => BrowserWindow | null;
  navigate: (route: string) => void;
  quit: () => void;
}

/**
 * Wires every channel in the IPC contract to a service.
 *
 * Handlers are thin: they validate the shape of what the renderer sent, call
 * one service, and return its Result. Business logic lives in services, so the
 * same behaviour is reachable from the tray, a hotkey or a command without
 * going through the UI.
 */
export function registerHandlers(ctx: HandlerContext): void {
  const { host } = ctx;
  const ipc = host.ipc;

  const search = new SearchService({
    profiles: () => host.profiles.list().map((p) => ({ id: p.id, name: p.name, description: p.description })),
    ruleSets: () => {
      const sets = host.assets.listSets();
      return sets.ok ? sets.value.map((s) => ({ id: s.id, name: s.name, description: s.description })) : [];
    },
    activeFlags: () => host.profiles.active().fastFlags
  });

  const profileFor = (id?: string): Result<Profile> =>
    id ? host.profiles.get(id) : Ok(host.profiles.active());

  const activeInstall = () => host.roblox.active(host.profiles.active().launcher.kind);

  // ── app ────────────────────────────────────────────────────────────────
  ipc.handle('app:info', () => Ok({
    version: app.getVersion(),
    channel: host.config.get().updates.channel,
    electron: process.versions['electron'] ?? 'unknown',
    node: process.versions.node,
    chrome: process.versions['chrome'] ?? 'unknown',
    platform: process.platform,
    portable: !app.isPackaged
  }));

  ipc.handle('app:settings:get', () => Ok(host.config.get()));

  ipc.handle('app:settings:update', async (patch) => {
    const safe: Partial<AppSettings> = { ...patch };
    // The scope list is the security boundary; never take it verbatim.
    if (safe.interception?.scope) {
      safe.interception = { ...safe.interception, scope: sanitiseScope(safe.interception.scope) };
    }
    const next = host.config.update(safe);
    await host.config.flush();
    return Ok(next);
  });

  ipc.handle('app:settings:reset', async () => {
    const next = host.config.reset();
    await host.config.flush();
    return Ok(next);
  });

  ipc.handle('app:window', (action) => {
    const window = ctx.mainWindow();
    if (!window) return Ok(undefined);
    switch (action) {
      case 'minimise': window.minimize(); break;
      case 'maximise': window.isMaximized() ? window.unmaximize() : window.maximize(); break;
      case 'hide': window.hide(); break;
      case 'close': window.close(); break;
    }
    return Ok(undefined);
  });

  ipc.handle('app:open-path', async ({ target, custom }) => {
    const map: Record<string, string | null> = {
      roblox: activeInstall()?.directory ?? host.paths.robloxRoot,
      blossom: host.paths.root,
      logs: host.paths.logs,
      cache: host.paths.blobs,
      backups: host.paths.backups,
      profiles: host.paths.profiles,
      custom: custom ?? null
    };
    const path = map[target];
    if (!path) return Err('invalid-argument', 'There is no folder to open for that.');

    // Opening a path the renderer supplied is the one place a bad value could
    // reach the shell, so custom paths must be inside folders we own.
    if (target === 'custom' && !isInsideKnownRoot(path, host)) {
      return Err('permission-denied', 'Blossom will only open folders it manages.');
    }

    const error = await shell.openPath(path);
    return error ? Err('io-failure', `That folder could not be opened: ${error}`) : Ok(undefined);
  });

  ipc.handle('app:open-external', async (url) => {
    if (!/^https:\/\//i.test(url)) {
      return Err('invalid-argument', 'Blossom only opens https links.');
    }
    await shell.openExternal(url);
    return Ok(undefined);
  });

  ipc.handle('app:quit', () => { ctx.quit(); return Ok(undefined); });

  // ── search and commands ────────────────────────────────────────────────
  ipc.handle('search:query', (term) => Ok(search.query(String(term ?? ''))));

  ipc.handle('commands:list', () => {
    const running = host.monitor.isRunning();
    const interceptionRunning = host.interception.state().status === 'running';
    return Ok(COMMANDS.map((c) => {
      let unavailableReason: string | undefined;
      if (c.id === 'launch.roblox' && running && !host.profiles.active().launcher.multiInstance) {
        unavailableReason = 'Roblox is already running.';
      }
      if (c.id === 'launch.close' && !running) unavailableReason = 'Roblox is not running.';
      if (c.id === 'roblox.clear-cache' && running) unavailableReason = 'Close Roblox first.';
      if (c.id === 'capture.stop' && !host.capture.isActive) unavailableReason = 'Capture is not running.';
      if (c.id === 'capture.start' && host.capture.isActive) unavailableReason = 'Capture is already running.';
      if (c.id === 'interception.toggle' && !host.config.get().interception.enabled) {
        unavailableReason = 'Asset interception is turned off in Settings.';
      }
      if (c.id === 'overlay.toggle-crosshair' && !interceptionRunning && !running) {
        unavailableReason = undefined; // The crosshair can be previewed without Roblox.
      }
      return unavailableReason ? { ...c, unavailableReason } : c;
    }));
  });

  ipc.handle('commands:run', async ({ id }) => runCommand(ctx, id));

  // ── roblox ─────────────────────────────────────────────────────────────
  ipc.handle('roblox:state', () => Ok(host.roblox.state()));
  ipc.handle('roblox:rescan', async () => Ok(await host.roblox.rescan()));
  ipc.handle('roblox:check-latest', async () => Ok(await host.roblox.checkLatest()));
  ipc.handle('roblox:set-active', (guid) => host.roblox.setActive(String(guid)));
  ipc.handle('roblox:repair', () => host.roblox.repair());
  ipc.handle('roblox:clear-temp-cache', () => host.roblox.clearTemporaryCache());

  // ── launcher ───────────────────────────────────────────────────────────
  ipc.handle('launch:preview', async (request) => {
    const profile = profileFor(request?.profileId);
    if (!profile.ok) return profile;

    const install = host.roblox.active(request?.kind ?? profile.value.launcher.kind);
    const modFiles = await host.mods.list(install);
    const sets = host.assets.listSets();
    const activeSets = sets.ok
      ? sets.value.filter((s) => profile.value.assets.assetProfileIds.includes(s.id))
      : [];

    return Ok({
      profileName: profile.value.name,
      clientVersion: install?.clientVersion ?? install?.versionGuid ?? null,
      fastFlagCount: Object.keys(profile.value.fastFlags).length,
      modFileCount: modFiles.length,
      assetRuleCount: activeSets.reduce((n, s) => n + s.ruleCount, 0),
      interception: profile.value.assets.interception && host.config.get().interception.enabled,
      capture: profile.value.assets.capture,
      overlays: [
        profile.value.overlay.crosshair.enabled ? 'crosshair' : null,
        profile.value.overlay.hud.enabled ? 'performance HUD' : null
      ].filter((v): v is string => v !== null),
      priority: profile.value.launcher.priority,
      filesTouched: install ? [FastFlagService.settingsPath(install)] : []
    });
  });

  ipc.handle('launch:start', async (request) => {
    const profile = profileFor(request?.profileId);
    if (!profile.ok) return profile;

    const started = Date.now();
    const result = await host.launcher.launch(request ?? {}, profile.value);
    if (result.ok) host.lastLaunchMs = Date.now() - started;

    if (result.ok && profile.value.launcher.hideOnLaunch) {
      ctx.mainWindow()?.hide();
    }
    return result;
  });

  ipc.handle('launch:cancel', () => { host.launcher.cancel(); return Ok(undefined); });

  ipc.handle('launch:close-roblox', async ({ pid }) => {
    if (typeof pid === 'number') {
      const closed = await host.monitor.closePid(pid);
      return Ok({ closed: closed ? 1 : 0 });
    }
    return Ok({ closed: await host.monitor.close() });
  });

  // ── profiles ───────────────────────────────────────────────────────────
  ipc.handle('profiles:list', () => Ok(host.profiles.list()));
  ipc.handle('profiles:get', (id) => host.profiles.get(String(id)));
  ipc.handle('profiles:create', ({ name, from }) => host.profiles.create(String(name ?? ''), from));
  ipc.handle('profiles:update', ({ id, patch }) => host.profiles.update(String(id), patch ?? {}));
  ipc.handle('profiles:delete', (id) => host.profiles.delete(String(id)));
  ipc.handle('profiles:duplicate', ({ id, name }) => host.profiles.duplicate(String(id), String(name ?? '')));
  ipc.handle('profiles:validate', (id) => host.profiles.validate(String(id)));

  ipc.handle('profiles:activate', async (id) => {
    const activated = host.profiles.setActive(String(id));
    if (activated.ok) {
      host.config.update({ activeProfileId: activated.value.id });
      await host.config.flush();
    }
    return activated;
  });

  ipc.handle('profiles:export', async ({ id, path }) => {
    const json = host.profiles.exportJson(String(id));
    if (!json.ok) return json;

    const target = path ?? (await pickSavePath(ctx, `${id}.blossom-profile.json`));
    if (!target) return Err('cancelled', 'Export cancelled.');
    await writeFileAtomic(target, json.value);
    return Ok({ path: target });
  });

  ipc.handle('profiles:import', async ({ path, json }) => {
    let text = json ?? null;
    if (!text) {
      const chosen = path ?? (await pickOpenPath(ctx, 'Blossom profile', ['json']));
      if (!chosen) return Err('cancelled', 'Import cancelled.');
      text = await fs.readFile(chosen, 'utf8').catch(() => null);
      if (text === null) return Err('io-failure', 'That file could not be read.');
    }
    return host.profiles.importJson(text);
  });

  // ── fastflags ──────────────────────────────────────────────────────────
  ipc.handle('flags:catalog', () => Ok(host.flags.catalog()));

  ipc.handle('flags:diff', async ({ profileId }) => {
    const profile = profileFor(profileId);
    if (!profile.ok) return profile;
    const install = activeInstall();
    const applied = install ? await host.flags.readApplied(install) : {};
    return Ok(host.flags.diff(profile.value.fastFlags, applied));
  });

  ipc.handle('flags:validate', (flags) => Ok(host.flags.validate(flags ?? {})));

  ipc.handle('flags:set', async ({ profileId, flags }) => {
    const profile = profileFor(profileId);
    if (!profile.ok) return profile;
    return host.profiles.update(profile.value.id, {
      fastFlags: { ...profile.value.fastFlags, ...host.flags.normalise(flags ?? {}) }
    });
  });

  ipc.handle('flags:remove', async ({ profileId, names }) => {
    const profile = profileFor(profileId);
    if (!profile.ok) return profile;
    const next = { ...profile.value.fastFlags };
    for (const name of names ?? []) delete next[name];
    return host.profiles.update(profile.value.id, { fastFlags: next });
  });

  ipc.handle('flags:import', async ({ json, profileId, merge }) => {
    const parsed = host.flags.parseImport(String(json ?? ''));
    if (!parsed.ok) return parsed;

    const profile = profileFor(profileId);
    if (!profile.ok) return profile;

    const next = merge ? { ...profile.value.fastFlags, ...parsed.value } : parsed.value;
    const updated = await host.profiles.update(profile.value.id, { fastFlags: next });
    if (!updated.ok) return updated;
    return Ok({ profile: updated.value, issues: host.flags.validate(next) });
  });

  ipc.handle('flags:export', ({ profileId }) => {
    const profile = profileFor(profileId);
    if (!profile.ok) return profile;
    return Ok(JSON.stringify(profile.value.fastFlags, null, 2) + '\n');
  });

  ipc.handle('flags:apply-now', async () => {
    const install = activeInstall();
    if (!install) return Err('roblox-not-found', 'Roblox is not installed.');
    const path = FastFlagService.settingsPath(install);
    const point = await host.backups.create('Apply FastFlags manually', [path]);
    if (!point.ok) return point;
    return host.flags.apply(install, host.profiles.active().fastFlags);
  });

  ipc.handle('flags:clear-applied', async () => {
    const install = activeInstall();
    if (!install) return Err('roblox-not-found', 'Roblox is not installed.');
    return host.flags.clear(install);
  });

  // ── optimizer ──────────────────────────────────────────────────────────
  ipc.handle('optimizer:catalog', () => Ok(host.optimizer.catalog()));
  ipc.handle('optimizer:hardware', ({ refresh }) => host.optimizer.probeHardware(refresh === true));
  ipc.handle('optimizer:state', () => Ok(host.optimizer.state()));
  ipc.handle('optimizer:plan', async ({ preset, overrides }) => Ok(await host.optimizer.plan(preset, overrides)));
  ipc.handle('optimizer:apply', ({ preset, overrides }) => host.optimizer.apply(preset, overrides));
  ipc.handle('optimizer:undo', () => host.optimizer.undo());
  ipc.handle('optimizer:reset-defaults', () => host.optimizer.resetToDefaults());
  ipc.handle('optimizer:recommend', async () => Ok(await host.optimizer.recommend()));

  // ── mods ───────────────────────────────────────────────────────────────
  ipc.handle('mods:list', async () => Ok(await host.mods.list(activeInstall())));

  ipc.handle('mods:apply', async () => {
    const install = activeInstall();
    if (!install) return Err('roblox-not-found', 'Roblox is not installed.');
    return host.mods.apply(install);
  });

  ipc.handle('mods:restore', async () => {
    const points = await host.backups.list();
    const latest = points.find((p) => p.reason.includes('mod') && !p.restored);
    if (!latest) return Err('not-found', 'There is no mod backup to restore from.');
    return host.mods.restore(latest.id);
  });

  ipc.handle('mods:open-folder', async () => {
    await shell.openPath(await host.mods.openFolder());
    return Ok(undefined);
  });

  // ── assets ─────────────────────────────────────────────────────────────
  ipc.handle('assets:sets', () => host.assets.listSets());
  ipc.handle('assets:set:create', ({ name, description }) => host.assets.createSet(String(name ?? ''), description));
  ipc.handle('assets:set:update', ({ id, patch }) => host.assets.updateSet(String(id), patch ?? {}));
  ipc.handle('assets:set:delete', (id) => host.assets.deleteSet(String(id)));
  ipc.handle('assets:set:duplicate', ({ id, name }) => host.assets.duplicateSet(String(id), String(name ?? '')));
  ipc.handle('assets:set:reorder', (ids) => host.assets.reorderSets(ids ?? []));

  ipc.handle('assets:set:export', async ({ id, path }) => {
    const json = host.assets.exportSet(String(id));
    if (!json.ok) return json;
    const target = path ?? (await pickSavePath(ctx, `${id}.blossom-assets.json`));
    if (!target) return Err('cancelled', 'Export cancelled.');
    await writeFileAtomic(target, json.value);
    return Ok({ path: target });
  });

  ipc.handle('assets:set:import', async ({ path, json }) => {
    let text = json ?? null;
    if (!text) {
      const chosen = path ?? (await pickOpenPath(ctx, 'Blossom asset rules', ['json']));
      if (!chosen) return Err('cancelled', 'Import cancelled.');
      text = await fs.readFile(chosen, 'utf8').catch(() => null);
      if (text === null) return Err('io-failure', 'That file could not be read.');
    }
    return host.assets.importSet(text);
  });

  ipc.handle('assets:rules', ({ setId }) => host.assets.listRules(String(setId)));
  ipc.handle('assets:rule:upsert', (rule) => host.assets.upsertRule(rule));
  ipc.handle('assets:rule:delete', (id) => host.assets.deleteRule(String(id)));

  ipc.handle('assets:rule:test', ({ assetId }) => {
    const setIds = host.profiles.active().assets.assetProfileIds;
    const resolution = host.assets.testResolve(
      { assetId: String(assetId), url: `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}` },
      setIds
    );
    if (resolution.kind === 'passthrough') {
      return Ok({ rule: null, setId: null, reason: resolution.reason });
    }
    return Ok({
      rule: resolution.rule,
      setId: resolution.rule.setId,
      reason: `Matched by rule "${resolution.rule.source}" (${resolution.rule.action}).`
    });
  });

  // ── cache ──────────────────────────────────────────────────────────────
  ipc.handle('cache:query', (query) => host.assets.query(query ?? {}));
  ipc.handle('cache:get', (id) => host.assets.get(String(id)));
  ipc.handle('cache:stats', () => host.assets.stats());
  ipc.handle('cache:preview', ({ assetId, kind }) => host.assets.preview(String(assetId), kind ?? 'auto'));
  ipc.handle('cache:blob-path', (id) => host.assets.blobPath(String(id)));
  ipc.handle('cache:duplicates', () => host.assets.duplicates());
  ipc.handle('cache:delete', ({ assetIds }) => host.assets.deleteAssets(assetIds ?? []));
  ipc.handle('cache:clear', () => host.assets.clearCache());

  ipc.handle('cache:export', async ({ assetIds, directory }) => {
    const target = directory ?? (await pickDirectory(ctx));
    if (!target) return Err('cancelled', 'Export cancelled.');
    return host.assets.exportAssets(assetIds ?? [], target);
  });

  ipc.handle('cache:import-file', async ({ assetId, path }) => {
    const chosen = path ?? (await pickOpenPath(ctx, 'Replacement file', ['*']));
    if (!chosen) return Err('cancelled', 'Import cancelled.');
    return host.assets.importFile(String(assetId), chosen);
  });

  // ── interception and capture ───────────────────────────────────────────
  ipc.handle('interception:state', () => Ok(host.interception.state()));
  ipc.handle('interception:start', () => host.interception.start(host.config.get(), activeInstall()));
  ipc.handle('interception:stop', async () => Ok(await host.interception.stop()));
  ipc.handle('interception:explain', () => Ok(host.interception.explain(activeInstall())));

  ipc.handle('interception:install-certificate', async ({ confirm }) => {
    if (confirm !== true) {
      return Err('invalid-argument', 'Installing the certificate needs an explicit confirmation.');
    }
    const install = activeInstall();
    if (!install) return Err('roblox-not-found', 'Roblox is not installed.');
    return host.interception.installCertificate(install);
  });

  ipc.handle('interception:remove-certificate', () => host.interception.removeCertificate(activeInstall()));

  ipc.handle('capture:start', async () => {
    const running = host.interception.state().status === 'running';
    return host.capture.start(running);
  });
  ipc.handle('capture:stop', async () => { await host.capture.stop(); return Ok(undefined); });
  ipc.handle('capture:state', () => Ok(host.capture.state()));
  ipc.handle('capture:recent', ({ limit }) => Ok(host.capture.recent(limit)));
  ipc.handle('capture:clear', () => { host.capture.clear(); return Ok(undefined); });

  ipc.handle('capture:export', async ({ path }) => {
    const target = path ?? (await pickSavePath(ctx, `capture-${Date.now()}.json`));
    if (!target) return Err('cancelled', 'Export cancelled.');
    return host.capture.exportEvents(target);
  });

  // ── overlay ────────────────────────────────────────────────────────────
  ipc.handle('overlay:state', () => Ok(host.overlay.state()));
  ipc.handle('overlay:set-crosshair', async (enabled) => { await host.overlay.setCrosshair(enabled === true); return Ok(undefined); });
  ipc.handle('overlay:set-hud', async (enabled) => { await host.overlay.setHud(enabled === true); return Ok(undefined); });
  ipc.handle('overlay:preview', async ({ enabled }) => {
    await host.overlay.preview(enabled === true, host.profiles.active().overlay);
    return Ok(undefined);
  });

  // ── diagnostics ────────────────────────────────────────────────────────
  ipc.handle('diagnostics:report', () => Ok(host.diagnostics.report()));
  ipc.handle('diagnostics:logs', ({ limit, level }) => Ok(host.diagnostics.logs(limit, level)));
  ipc.handle('diagnostics:benchmark', async ({ id }) => Ok(await host.diagnostics.runBenchmarks(id)));
  ipc.handle('diagnostics:benchmarks', () => Ok(host.diagnostics.lastBenchmarks()));

  ipc.handle('diagnostics:save', async ({ path }) => {
    const target = path ?? (await pickSavePath(ctx, `blossom-diagnostics-${Date.now()}.txt`));
    if (!target) return Err('cancelled', 'Save cancelled.');
    return host.diagnostics.save(target);
  });

  // ── backups ────────────────────────────────────────────────────────────
  ipc.handle('backups:list', async () => Ok(await host.backups.list()));
  ipc.handle('backups:restore', (id) => host.backups.restore(String(id)));
  ipc.handle('backups:delete', (id) => host.backups.delete(String(id)));
  ipc.handle('backups:prune', async ({ keep }) => Ok({ deleted: await host.backups.prune(Number(keep) || 10) }));

  // ── updates ────────────────────────────────────────────────────────────
  ipc.handle('updates:check', async () => host.updates.check(host.config.get().updates.channel));
  ipc.handle('updates:download', () => host.updates.download());
  ipc.handle('updates:state', () => Ok(host.updates.current()));

  ipc.handle('updates:install', () => {
    const staged = host.updates.stagedUpdate();
    if (!staged) return Err('not-found', 'There is no downloaded update to install.');
    ctx.quit();
    return Ok(undefined);
  });
}

/** Shared implementation behind the palette, the tray and every hotkey. */
export async function runCommand(ctx: HandlerContext, id: string): Promise<Result<void>> {
  const { host } = ctx;
  const install = () => host.roblox.active(host.profiles.active().launcher.kind);

  switch (id) {
    case 'launch.roblox': {
      const result = await host.launcher.launch({}, host.profiles.active());
      return result.ok ? Ok(undefined) : result;
    }
    case 'launch.close':
      await host.monitor.close();
      return Ok(undefined);
    case 'roblox.rescan':
      await host.roblox.rescan();
      return Ok(undefined);
    case 'roblox.open-folder':
      await shell.openPath(install()?.directory ?? host.paths.robloxRoot);
      return Ok(undefined);
    case 'roblox.repair': {
      const r = await host.roblox.repair();
      return r.ok ? Ok(undefined) : r;
    }
    case 'roblox.clear-cache': {
      const r = await host.roblox.clearTemporaryCache();
      return r.ok ? Ok(undefined) : r;
    }

    case 'nav.optimizer': ctx.navigate('/optimizer'); return Ok(undefined);
    case 'nav.profiles': ctx.navigate('/profiles'); return Ok(undefined);
    case 'nav.assets': ctx.navigate('/assets'); return Ok(undefined);
    case 'nav.cache': ctx.navigate('/cache'); return Ok(undefined);
    case 'nav.fastflags': ctx.navigate('/fastflags'); return Ok(undefined);
    case 'nav.diagnostics': ctx.navigate('/diagnostics'); return Ok(undefined);
    case 'nav.settings': ctx.navigate('/settings'); return Ok(undefined);

    case 'profile.create': ctx.navigate('/profiles?new=1'); return Ok(undefined);

    case 'optimizer.apply-recommended': {
      const recommended = await host.optimizer.recommend();
      const r = await host.optimizer.apply(recommended.preset);
      return r.ok ? Ok(undefined) : r;
    }
    case 'optimizer.undo': {
      const r = await host.optimizer.undo();
      return r.ok ? Ok(undefined) : r;
    }
    case 'optimizer.reset': {
      const r = await host.optimizer.resetToDefaults();
      return r.ok ? Ok(undefined) : r;
    }

    case 'capture.start': {
      const r = await host.capture.start(host.interception.state().status === 'running');
      return r.ok ? Ok(undefined) : r;
    }
    case 'capture.stop':
      await host.capture.stop();
      return Ok(undefined);

    case 'interception.toggle': {
      if (host.interception.state().status === 'running') {
        await host.interception.stop();
        return Ok(undefined);
      }
      const r = await host.interception.start(host.config.get(), install());
      return r.ok ? Ok(undefined) : r;
    }
    case 'cache.clear': {
      const r = await host.assets.clearCache();
      return r.ok ? Ok(undefined) : r;
    }

    case 'overlay.toggle-crosshair':
      await host.overlay.setCrosshair(!host.overlay.state().crosshair);
      return Ok(undefined);
    case 'overlay.toggle-hud':
      await host.overlay.setHud(!host.overlay.state().hud);
      return Ok(undefined);

    case 'diagnostics.report':
      ctx.navigate('/diagnostics');
      return Ok(undefined);
    case 'diagnostics.benchmark':
      await host.diagnostics.runBenchmarks('all');
      ctx.navigate('/diagnostics');
      return Ok(undefined);

    case 'app.check-updates': {
      const r = await host.updates.check(host.config.get().updates.channel);
      return r.ok ? Ok(undefined) : r;
    }
    case 'app.open-logs':
      await shell.openPath(host.paths.logs);
      return Ok(undefined);

    default:
      return Err('not-found', 'That command is not available.');
  }
}

/** Custom paths from the renderer may only point inside folders Blossom owns. */
function isInsideKnownRoot(path: string, host: ServiceHost): boolean {
  const roots = [host.paths.root, host.paths.robloxRoot];
  const normalised = join(path);
  return roots.some((root) => normalised.startsWith(join(root)));
}

async function pickSavePath(ctx: HandlerContext, defaultName: string): Promise<string | null> {
  const window = ctx.mainWindow();
  const result = await dialog.showSaveDialog(window ?? undefined as never, {
    defaultPath: join(ctx.host.paths.exports, defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt'] }]
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function pickOpenPath(ctx: HandlerContext, name: string, extensions: string[]): Promise<string | null> {
  const window = ctx.mainWindow();
  const result = await dialog.showOpenDialog(window ?? undefined as never, {
    properties: ['openFile'],
    filters: [{ name, extensions }]
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function pickDirectory(ctx: HandlerContext): Promise<string | null> {
  const window = ctx.mainWindow();
  const result = await dialog.showOpenDialog(window ?? undefined as never, {
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

export { DiagnosticsService };
