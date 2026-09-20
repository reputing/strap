import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '@main/backups/backup-service';
import { FastFlagService } from '@main/fastflags/fastflag-service';
import { ModService } from '@main/mods/mod-service';
import { ProfileService } from '@main/profiles/profile-service';
import { ProcessMonitor } from '@main/roblox/process-monitor';
import { RobloxService } from '@main/roblox/roblox-service';
import { LauncherService, buildArguments } from '@main/roblox/launcher-service';
import { FakeAdapter } from '@main/platform';
import { Logger } from '@main/core/logger';
import { createPaths } from '@main/core/paths';
import { emptyProfile } from '@main/core/defaults';
import { Ok } from '@shared/result';
import type { Profile, RobloxInstallation } from '@shared/types';

/**
 * An end-to-end exercise of the launch sequence against a fake Roblox
 * installation and a fake platform, verifying the properties that matter:
 * flags reach the client, the original state is captured, and a failure at any
 * step rolls everything back.
 */

const scratches: string[] = [];
let spawnedArgs: string[] = [];
let spawnedEnv: Record<string, string> = {};
let spawnShouldFail = false;

vi.mock('node:child_process', () => ({
  spawn: (_exe: string, args: string[], options: { env?: Record<string, string> }) => {
    if (spawnShouldFail) throw new Error('blocked by antivirus');
    spawnedArgs = args;
    spawnedEnv = options.env ?? {};
    return { pid: 4242, unref() { /* detached */ } };
  }
}));

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'blossom-launch-'));
  scratches.push(root);

  const appRoot = join(root, 'app');
  const paths = { ...createPaths(process.env, appRoot) };
  // Point discovery at the fake Roblox tree rather than the real machine.
  (paths as { robloxVersions: string }).robloxVersions = join(root, 'Roblox', 'Versions');
  (paths as { robloxLogs: string }).robloxLogs = join(root, 'Roblox', 'logs');

  const versionDir = join(paths.robloxVersions, 'version-0123456789abcdef');
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, 'RobloxPlayerBeta.exe'), 'fake client');

  const logger = new Logger({ directory: join(root, 'logs'), level: 'critical' });
  const platform = new FakeAdapter();
  const backups = new BackupService(paths, logger.scope('backup'));
  const profiles = new ProfileService(paths, logger.scope('profiles'));
  await profiles.load('default');
  const flags = new FastFlagService(logger.scope('flags'));
  const mods = new ModService(paths, backups, logger.scope('mods'));
  const monitor = new ProcessMonitor(platform, logger.scope('monitor'));
  // Subscribing is what the real application does at start; without it the
  // monitor never learns that a client exited.
  await monitor.start();
  const roblox = new RobloxService(paths, monitor, logger.scope('roblox'));
  await roblox.rescan();

  return { root, paths, versionDir, platform, backups, profiles, flags, mods, monitor, roblox, logger };
}

function launcherFor(h: Awaited<ReturnType<typeof harness>>, hooks = {}) {
  return new LauncherService(
    h.roblox, h.monitor, h.flags, h.mods, h.backups, h.platform,
    h.logger.scope('launcher'), hooks
  );
}

/** The fake platform only reports a process once a test says one exists. */
function simulateClientStart(platform: FakeAdapter, pid = 4242) {
  platform.simulateStart({
    pid, name: 'RobloxPlayerBeta.exe',
    executable: 'C:\\fake\\RobloxPlayerBeta.exe', startedAt: Date.now()
  });
}

function profileWith(patch: Partial<Profile> = {}): Profile {
  return { ...emptyProfile('test', 'Test'), ...patch };
}

beforeEach(() => {
  spawnedArgs = [];
  spawnedEnv = {};
  spawnShouldFail = false;
});

afterEach(async () => {
  for (const s of scratches.splice(0)) await rm(s, { recursive: true, force: true });
});

describe('launch arguments', () => {
  it('forwards a deeplink untouched', () => {
    const args = buildArguments(
      { deeplink: 'roblox-player:1+launchmode:play+gameinfo:TICKET' },
      profileWith()
    );
    expect(args[0]).toBe('roblox-player:1+launchmode:play+gameinfo:TICKET');
  });

  it('opens the client to the home screen with no deeplink', () => {
    expect(buildArguments({}, profileWith())).toEqual(['--app']);
  });

  it('appends profile and request arguments', () => {
    const profile = profileWith();
    profile.launcher.extraArgs = ['--fromProfile'];
    expect(buildArguments({ extraArgs: ['--fromRequest'] }, profile))
      .toEqual(['--app', '--fromProfile', '--fromRequest']);
  });

  it('drops arguments containing control characters', () => {
    const profile = profileWith();
    profile.launcher.extraArgs = ['--ok', 'bad\nvalue', 'also\0bad'];
    expect(buildArguments({}, profile)).toEqual(['--app', '--ok']);
  });
});

describe('the launch sequence', () => {
  it('writes flags, spawns the client and reports the running pid', async () => {
    const h = await harness();
    const launcher = launcherFor(h);

    const profile = profileWith({ fastFlags: { DFIntTaskSchedulerTargetFps: '144' } });
    const stages: string[] = [];
    launcher.on('progress', (p: { stage: string }) => stages.push(p.stage));

    // The client "appears" shortly after the spawn call, as it does in reality.
    setTimeout(() => simulateClientStart(h.platform), 30);

    const result = await launcher.launch({}, profile);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;

    expect(result.value.pid).toBe(4242);
    expect(result.value.versionGuid).toBe('version-0123456789abcdef');
    expect(spawnedArgs).toEqual(['--app']);

    const written = JSON.parse(
      await readFile(join(h.versionDir, 'ClientSettings', 'ClientAppSettings.json'), 'utf8')
    );
    expect(written).toEqual({ DFIntTaskSchedulerTargetFps: '144' });

    expect(stages).toContain('applying-fastflags');
    expect(stages).toContain('running');
  });

  it('takes a restore point that deletes a file it created', async () => {
    const h = await harness();
    const launcher = launcherFor(h);
    const settings = join(h.versionDir, 'ClientSettings', 'ClientAppSettings.json');

    setTimeout(() => simulateClientStart(h.platform), 30);
    const result = await launcher.launch({}, profileWith({ fastFlags: { FFlagDisablePostFx: 'True' } }));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.restorePointId) throw new Error('no restore point');

    expect(existsSync(settings)).toBe(true);
    await h.backups.restore(result.value.restorePointId);
    // The file did not exist before the launch, so restoring removes it again.
    expect(existsSync(settings)).toBe(false);
  });

  it('restores prior flag contents rather than deleting the file', async () => {
    const h = await harness();
    const settings = join(h.versionDir, 'ClientSettings', 'ClientAppSettings.json');
    await mkdir(join(h.versionDir, 'ClientSettings'), { recursive: true });
    await writeFile(settings, '{"FFlagSomethingTheUserHad":"True"}');

    const launcher = launcherFor(h);
    setTimeout(() => simulateClientStart(h.platform), 30);
    const result = await launcher.launch({}, profileWith({ fastFlags: { FFlagDisablePostFx: 'True' } }));
    if (!result.ok || !result.value.restorePointId) throw new Error('launch failed');

    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ FFlagDisablePostFx: 'True' });
    await h.backups.restore(result.value.restorePointId);
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ FFlagSomethingTheUserHad: 'True' });
  });

  it('refuses a profile with an invalid flag before touching anything', async () => {
    const h = await harness();
    const launcher = launcherFor(h);

    const result = await launcher.launch({}, profileWith({ fastFlags: { DFIntTaskSchedulerTargetFps: 'fast' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('profile-invalid');
    expect(existsSync(join(h.versionDir, 'ClientSettings'))).toBe(false);
  });

  it('refuses to launch a second client unless the profile allows it', async () => {
    const h = await harness();
    simulateClientStart(h.platform, 999);

    const result = await launcherFor(h).launch({}, profileWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('roblox-already-running');
  });

  it('rolls the flag file back when the spawn itself fails', async () => {
    const h = await harness();
    const launcher = launcherFor(h);
    spawnShouldFail = true;

    const result = await launcher.launch({}, profileWith({ fastFlags: { FFlagDisablePostFx: 'True' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('launch-failed');

    // The compensation ran: nothing Blossom wrote survives a failed launch.
    expect(existsSync(join(h.versionDir, 'ClientSettings', 'ClientAppSettings.json'))).toBe(false);
  });

  it('reports a missing Roblox installation instead of guessing', async () => {
    const h = await harness();
    await rm(join(h.versionDir, 'RobloxPlayerBeta.exe'), { force: true });
    await h.roblox.rescan();

    const result = await launcherFor(h).launch({}, profileWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('roblox-not-found');
  });
});

describe('interception during launch', () => {
  const install = (h: Awaited<ReturnType<typeof harness>>): RobloxInstallation =>
    h.roblox.active()!;

  it('passes the prepared environment to the client', async () => {
    const h = await harness();
    const launcher = launcherFor(h, {
      interception: {
        prepare: async () => Ok({
          HTTPS_PROXY: 'http://127.0.0.1:51234',
          CURL_CA_BUNDLE: 'C:\\fake\\ssl\\cacert.pem'
        }),
        release: async () => undefined,
        status: () => 'active' as const
      }
    });

    const profile = profileWith();
    profile.assets.interception = true;

    setTimeout(() => simulateClientStart(h.platform), 30);
    const result = await launcher.launch({}, profile);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.interception).toBe('active');
    expect(spawnedEnv['HTTPS_PROXY']).toBe('http://127.0.0.1:51234');
    expect(spawnedEnv['CURL_CA_BUNDLE']).toBe('C:\\fake\\ssl\\cacert.pem');
    expect(install(h)).toBeTruthy();
  });

  it('launches anyway when interception cannot start', async () => {
    const h = await harness();
    let degraded = false;
    const launcher = launcherFor(h, {
      interception: {
        prepare: async () => ({ ok: false as const, error: { code: 'io-failure' as const, message: 'no certificate' } }),
        release: async () => undefined,
        status: () => 'failed' as const
      }
    });
    launcher.on('interception-degraded', () => { degraded = true; });

    const profile = profileWith();
    profile.assets.interception = true;

    setTimeout(() => simulateClientStart(h.platform), 30);
    const result = await launcher.launch({}, profile);

    // A customization feature failing must never stop somebody playing.
    expect(result.ok).toBe(true);
    expect(degraded).toBe(true);
    // The client inherits the parent environment, as any spawned program does,
    // and the host running these tests may well have its own proxy variables.
    // What must be absent is any value Blossom itself would have injected.
    expect(Object.values(spawnedEnv)).not.toContain('http://127.0.0.1:51234');
    expect(Object.values(spawnedEnv)).not.toContain('C:\\fake\\ssl\\cacert.pem');
  });
});

describe('post-launch behaviour', () => {
  it('applies the profile\'s process priority', async () => {
    const h = await harness();
    const setPriority = vi.spyOn(h.platform, 'setPriority');
    const launcher = launcherFor(h);

    const profile = profileWith();
    profile.launcher.priority = 'above-normal';

    setTimeout(() => simulateClientStart(h.platform), 30);
    await launcher.launch({}, profile);

    expect(setPriority).toHaveBeenCalledWith(4242, 'above-normal');
  });

  it('attaches overlays and detaches them when the client exits', async () => {
    const h = await harness();
    const attach = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const launcher = launcherFor(h, { overlay: { attach, detach } });

    setTimeout(() => simulateClientStart(h.platform), 30);
    await launcher.launch({}, profileWith());
    expect(attach).toHaveBeenCalledWith(4242, expect.objectContaining({ id: 'test' }));

    h.platform.simulateStop(4242);
    await new Promise((r) => setTimeout(r, 20));
    expect(detach).toHaveBeenCalled();
  });
});
