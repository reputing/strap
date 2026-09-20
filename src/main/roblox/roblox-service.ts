import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { RobloxChannel, RobloxInstallation, RobloxKind, RobloxState } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import { dirSize } from '@main/core/fs-utils';
import { compareClientVersions, discoverInstallations, selectActive } from './discovery';
import { fetchLatestClientVersion, type ClientVersionInfo } from './client-version';
import type { ProcessMonitor } from './process-monitor';

/**
 * Owns everything Blossom knows about the Roblox installation.
 *
 * Discovery results are cached and invalidated by a directory watcher on the
 * Versions folder rather than re-scanned on every navigation — a Roblox install
 * is thousands of files, and walking it repeatedly is exactly the kind of cost
 * a launcher has no business adding.
 */
export class RobloxService extends EventEmitter {
  private installations: RobloxInstallation[] = [];
  private pinnedGuid: string | null = null;
  private latest: ClientVersionInfo | null = null;
  private scannedAt = 0;
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private scanning: Promise<RobloxInstallation[]> | null = null;
  /** The version we last told the user about, so an update is announced once. */
  private announcedGuid: string | null = null;

  constructor(
    private readonly paths: BlossomPaths,
    private readonly monitor: ProcessMonitor,
    private readonly log: ScopedLogger
  ) {
    super();
    this.monitor.on('changed', () => this.emit('changed', this.state()));
  }

  async start(): Promise<void> {
    await this.rescan();
    this.startWatching();
  }

  /**
   * Watches the Versions directory. Roblox creates and removes directories
   * there when it updates, which is the only moment discovery needs to re-run.
   */
  private startWatching(): void {
    try {
      this.watcher = watch(this.paths.robloxVersions, { persistent: false }, () => {
        // An update touches the directory many times; coalesce into one rescan.
        if (this.rescanTimer) clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => { void this.rescan(); }, 2000);
        this.rescanTimer.unref?.();
      });
      this.watcher.on('error', (e) => {
        this.log.debug('Stopped watching the Roblox folder', { reason: e.message });
        this.watcher = null;
      });
      this.log.debug('Watching the Roblox versions folder for updates');
    } catch {
      // No Roblox folder yet. It will be picked up by the next manual rescan.
      this.log.debug('Roblox versions folder is not present yet');
    }
  }

  async rescan(): Promise<RobloxState> {
    // Collapse concurrent callers onto one scan.
    if (!this.scanning) {
      this.scanning = discoverInstallations({
        versionsDirectory: this.paths.robloxVersions,
        logsDirectory: this.paths.robloxLogs
      }).finally(() => { this.scanning = null; });
    }

    const previousActive = this.active()?.versionGuid ?? null;
    this.installations = await this.scanning;
    this.scannedAt = Date.now();

    const active = this.active();
    if (!this.installations.length) {
      this.log.info('Roblox was not found on this machine');
    } else if (active && active.versionGuid !== previousActive) {
      this.log.info('Roblox detected', {
        version: active.clientVersion ?? 'unknown',
        guid: active.versionGuid
      });
      if (previousActive !== null && this.announcedGuid !== active.versionGuid) {
        // A different version directory means Roblox updated underneath us.
        this.announcedGuid = active.versionGuid;
        this.emit('version-changed', active);
      }
    }

    const state = this.state();
    this.emit('changed', state);
    return state;
  }

  state(): RobloxState {
    const active = this.active();
    return {
      installations: this.installations,
      active,
      processes: this.monitor.list(),
      latest: this.latest
        ? { channel: this.latest.channel, clientVersion: this.latest.clientVersion, versionGuid: this.latest.versionGuid }
        : null,
      updateAvailable: this.isUpdateAvailable(active),
      scannedAt: this.scannedAt
    };
  }

  private isUpdateAvailable(active: RobloxInstallation | null): boolean {
    if (!active || !this.latest) return false;
    if (active.versionGuid === this.latest.versionGuid) return false;
    if (!active.clientVersion) return true;
    return compareClientVersions(active.clientVersion, this.latest.clientVersion) < 0;
  }

  active(kind: RobloxKind = 'player'): RobloxInstallation | null {
    return selectActive(this.installations, kind, this.pinnedGuid);
  }

  require(kind: RobloxKind = 'player'): Result<RobloxInstallation> {
    const install = this.active(kind);
    if (install) return Ok(install);
    return Err('roblox-not-found', `Blossom could not find an installed Roblox ${kind === 'studio' ? 'Studio' : 'Player'}.`, {
      remediation: 'Install or run Roblox once, then press Rescan on the Home page.'
    });
  }

  setActive(versionGuid: string): Result<RobloxState> {
    if (!this.installations.some((i) => i.versionGuid === versionGuid)) {
      return Err('not-found', 'That Roblox version is no longer installed.');
    }
    this.pinnedGuid = versionGuid;
    this.log.info('Roblox version pinned', { guid: versionGuid });
    const state = this.state();
    this.emit('changed', state);
    return Ok(state);
  }

  /** Asks Roblox which client version is current. Failure means "unknown". */
  async checkLatest(channel: RobloxChannel = 'LIVE'): Promise<RobloxState['latest']> {
    const r = await fetchLatestClientVersion('player', channel);
    if (!r.ok) {
      this.log.debug('Could not check the current Roblox version', { reason: r.error.message });
      return this.state().latest;
    }
    this.latest = r.value;

    // Fill in a marketing version for the install that matches, which is the
    // one case where we can attribute one with certainty.
    for (const install of this.installations) {
      if (install.versionGuid === r.value.versionGuid && !install.clientVersion) {
        install.clientVersion = r.value.clientVersion;
      }
    }

    const state = this.state();
    this.emit('changed', state);
    return state.latest;
  }

  /**
   * Removes Blossom's own modifications from every installed version, putting
   * the client back the way Roblox shipped it. Roblox's own files are not
   * touched beyond removing what Blossom added.
   */
  async repair(): Promise<Result<{ removed: string[]; restored: string[] }>> {
    const removed: string[] = [];
    const restored: string[] = [];

    for (const install of this.installations) {
      const settings = join(install.directory, 'ClientSettings', 'ClientAppSettings.json');
      try {
        await fs.rm(settings, { force: true });
        removed.push(settings);
      } catch { /* nothing there, or Roblox has it open */ }
    }

    this.log.info('Repair finished', { removed: removed.length, restored: restored.length });
    await this.rescan();
    return Ok({ removed, restored });
  }

  /**
   * Clears Roblox's own temporary HTTP cache. This is the thing users are told
   * to do when assets load wrong; doing it from here means they do not have to
   * go hunting in %TEMP%.
   */
  async clearTemporaryCache(): Promise<Result<{ filesRemoved: number; bytesFreed: number }>> {
    if (this.monitor.isRunning()) {
      return Err('roblox-already-running', 'Close Roblox before clearing its cache.', {
        remediation: 'The client keeps these files open while it is running.'
      });
    }

    const target = join(this.paths.robloxTemp, 'http');
    let bytesFreed = 0;
    let filesRemoved = 0;

    try {
      bytesFreed = await dirSize(target);
      const entries = await fs.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        try {
          await fs.rm(join(target, entry.name), { recursive: true, force: true });
          filesRemoved += 1;
        } catch { /* a file still held open; skip it */ }
      }
    } catch {
      // No cache directory is a perfectly normal state.
      return Ok({ filesRemoved: 0, bytesFreed: 0 });
    }

    this.log.info('Roblox temporary cache cleared', { filesRemoved, bytesFreed });
    return Ok({ filesRemoved, bytesFreed });
  }

  dispose(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.watcher?.close();
    this.watcher = null;
    this.removeAllListeners();
  }
}
