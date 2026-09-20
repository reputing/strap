import { app } from 'electron';
import { EventEmitter } from 'node:events';
import type { AppSettings, Profile } from '@shared/types';
import { createPaths, type BlossomPaths } from './paths';
import { Logger, type ScopedLogger } from './logger';
import { ConfigService } from './config-service';
import { ensureDir } from './fs-utils';
import { createPlatformAdapter, type PlatformAdapter } from '@main/platform';
import { BackupService } from '@main/backups/backup-service';
import { ProfileService } from '@main/profiles/profile-service';
import { FastFlagService } from '@main/fastflags/fastflag-service';
import { ModService } from '@main/mods/mod-service';
import { ProcessMonitor } from '@main/roblox/process-monitor';
import { RobloxService } from '@main/roblox/roblox-service';
import { LauncherService } from '@main/roblox/launcher-service';
import { AssetService } from '@main/assets/asset-service';
import { CaptureService } from '@main/assets/capture-service';
import { InterceptionService } from '@main/interception/interception-service';
import { OptimizerService } from '@main/optimizer/optimizer-service';
import { OverlayService } from '@main/overlay/overlay-service';
import { DiagnosticsService } from '@main/diagnostics/diagnostics-service';
import { UpdateService } from '@main/updater/update-service';
import { IpcRouter } from './ipc';

/**
 * Constructs every service, in dependency order, and holds the wiring between
 * them.
 *
 * Services never reach for each other through globals and never touch a
 * BrowserWindow. Everything that needs to reach the UI emits, and this class is
 * the single place those emissions become IPC events.
 */
export class ServiceHost extends EventEmitter {
  readonly paths: BlossomPaths;
  readonly logger: Logger;
  readonly log: ScopedLogger;
  readonly ipc: IpcRouter;

  readonly config: ConfigService;
  readonly platform: PlatformAdapter;
  readonly backups: BackupService;
  readonly profiles: ProfileService;
  readonly flags: FastFlagService;
  readonly mods: ModService;
  readonly monitor: ProcessMonitor;
  readonly roblox: RobloxService;
  readonly launcher: LauncherService;
  readonly assets: AssetService;
  readonly capture: CaptureService;
  readonly interception: InterceptionService;
  readonly optimizer: OptimizerService;
  readonly overlay: OverlayService;
  readonly updates: UpdateService;
  diagnostics!: DiagnosticsService;

  /** Milliseconds from process start to the first window being ready. */
  startupMs: number | null = null;
  lastLaunchMs: number | null = null;
  /** Cached so a diagnostics report does not walk the mods folder inline. */
  modFileCount = 0;

  private samplingRelease: (() => void) | null = null;
  private disposed = false;

  constructor(options: {
    rendererUrl: { devServer: string | null; file: string };
    manifestUrl: string | null;
    rootOverride?: string;
    consoleLogging?: boolean;
  }) {
    super();

    this.paths = createPaths(process.env, options.rootOverride);
    this.logger = new Logger({
      directory: this.paths.logs,
      level: 'info',
      console: options.consoleLogging ?? !app.isPackaged
    });
    this.log = this.logger.scope('app');
    this.ipc = new IpcRouter(this.logger.scope('ipc'));

    this.config = new ConfigService(this.paths, this.logger.scope('settings'));
    this.platform = createPlatformAdapter(this.logger.scope('platform'));
    this.backups = new BackupService(this.paths, this.logger.scope('backup'));
    this.profiles = new ProfileService(this.paths, this.logger.scope('profiles'));
    this.flags = new FastFlagService(this.logger.scope('fastflags'));
    this.mods = new ModService(this.paths, this.backups, this.logger.scope('mods'));

    this.monitor = new ProcessMonitor(this.platform, this.logger.scope('roblox'));
    this.roblox = new RobloxService(this.paths, this.monitor, this.logger.scope('roblox'));

    this.assets = new AssetService(this.paths, this.logger.scope('assets'));
    this.capture = new CaptureService(this.paths, this.assets, this.logger.scope('capture'));
    this.interception = new InterceptionService(
      this.paths, this.assets, this.capture, this.backups, this.logger.scope('intercept')
    );

    this.optimizer = new OptimizerService(
      this.platform, this.profiles, this.roblox, this.logger.scope('optimizer')
    );
    this.overlay = new OverlayService(this.platform, options.rendererUrl, this.logger.scope('overlay'));

    this.launcher = new LauncherService(
      this.roblox, this.monitor, this.flags, this.mods, this.backups, this.platform,
      this.logger.scope('launcher'),
      {
        interception: {
          prepare: (profile, install) =>
            this.interception.prepareForLaunch(profile, install, this.config.get()),
          release: () => this.interception.release(),
          status: () => this.interception.statusForLaunch()
        },
        overlay: {
          attach: (pid, profile) => this.overlay.attach(pid, profile),
          detach: () => this.overlay.detach()
        }
      }
    );

    this.updates = new UpdateService(
      this.paths, app.getVersion(), options.manifestUrl, this.logger.scope('updates')
    );
  }

  async start(): Promise<void> {
    for (const dir of [this.paths.root, this.paths.logs, this.paths.profiles, this.paths.backups, this.paths.exports]) {
      await ensureDir(dir);
    }

    const settings = await this.config.load();
    this.logger.setLevel(settings.logLevel);

    await this.platform.init();
    await this.profiles.load(settings.activeProfileId);

    const indexed = await this.assets.start();
    if (!indexed.ok) {
      this.log.warn('Continuing without the asset index', { reason: indexed.error.message });
    }

    await this.monitor.start();
    await this.roblox.start();

    this.wireEvents();
    this.buildDiagnostics();

    // Reconcile anything an unclean shutdown left behind, and keep the backup
    // folder from growing without limit.
    await this.backups.prune(20);
    await this.updates.prune();

    void this.refreshModCount();
    void this.optimizer.probeHardware();
    if (settings.updates.checkAutomatically) {
      void this.updates.check(settings.updates.channel);
    }
    void this.roblox.checkLatest();
    void this.interception.refreshCertificateState(this.roblox.active());

    this.log.info('Blossom Strap ready', {
      version: app.getVersion(),
      profile: this.profiles.active().name,
      roblox: this.roblox.active()?.clientVersion ?? 'not detected'
    });
  }

  /** Re-counts the mod overlay files. Cheap, and only run when something asks. */
  async refreshModCount(): Promise<number> {
    const files = await this.mods.list(this.roblox.active());
    this.modFileCount = files.length;
    return this.modFileCount;
  }

  private wireEvents(): void {
    this.config.on('changed', (settings: AppSettings) => {
      this.logger.setLevel(settings.logLevel);
      this.ipc.emit('settings:changed', settings);
    });

    this.profiles.on('changed', (list: Profile[]) => {
      this.ipc.emit('profiles:changed', list);
      this.config.update({ activeProfileId: this.profiles.activeIdValue() });
    });

    this.profiles.on('activated', (profile: Profile) => {
      this.interception.setActiveSets(profile.assets.assetProfileIds);
    });

    this.roblox.on('changed', (state) => this.ipc.emit('roblox:changed', state));
    this.roblox.on('version-changed', (install) => this.onRobloxUpdated(install));

    this.monitor.on('sample', (sample) => {
      this.ipc.emit('roblox:sample', sample);
      this.overlay.pushSample(sample);
    });

    // Sampling runs only while a client is alive; the release is held here and
    // dropped the moment nothing is running.
    this.monitor.on('started', () => {
      this.samplingRelease ??= this.monitor.acquireSampling(1000);
    });
    this.monitor.on('changed', () => {
      if (!this.monitor.isRunning()) {
        this.samplingRelease?.();
        this.samplingRelease = null;
      }
    });

    this.launcher.on('progress', (progress) => this.ipc.emit('launch:progress', progress));
    // Forwarded rather than acted on here: services never quit the application.
    this.launcher.on('quit-requested', () => this.emit('quit-requested'));
    this.launcher.on('exited', () => { void this.refreshModCount(); });
    this.launcher.on('interception-degraded', (error: { message: string }) => {
      this.ipc.emit('toast', {
        kind: 'warning',
        title: 'Asset interception did not start',
        message: `${error.message} Roblox was launched without it.`
      });
    });

    this.interception.on('changed', (state) => this.ipc.emit('interception:changed', state));
    this.capture.on('events', (events) => this.ipc.emit('capture:event', events));
    this.assets.on('cache-changed', () => {
      const stats = this.assets.stats();
      if (stats.ok) this.ipc.emit('cache:changed', stats.value);
    });
    this.optimizer.on('changed', (state) => this.ipc.emit('optimizer:changed', state));
    this.updates.on('changed', (state) => this.ipc.emit('updates:changed', state));
    this.updates.on('checked', (at: number) => {
      this.config.update({ updates: { ...this.config.get().updates, lastCheckedAt: at } });
    });

    this.logger.on('record', (record) => this.ipc.emit('log:record', record));
  }

  /**
   * Roblox updated underneath us. Nothing is silently re-applied: the profile
   * is preserved, incompatible modifications are disabled, and the user is told.
   */
  private async onRobloxUpdated(install: { clientVersion: string | null; versionGuid: string }): Promise<void> {
    this.log.info('Roblox updated', { version: install.clientVersion ?? install.versionGuid });

    // The client update wiped ClientSettings, so nothing Blossom wrote survives.
    // The certificate lives in the version directory too, so it is gone as well.
    await this.interception.refreshCertificateState(this.roblox.active());
    const state = this.interception.state();
    if (!state.certificateInstalled && state.status === 'running') {
      await this.interception.stop();
    }

    this.ipc.emit('toast', {
      kind: 'info',
      title: 'Roblox updated',
      message: `Now on ${install.clientVersion ?? install.versionGuid}. Your profiles are unchanged; modifications will be re-applied the next time you launch.`
    });
  }

  private buildDiagnostics(): void {
    this.diagnostics = new DiagnosticsService(this.paths, this.logger, {
      appVersion: app.getVersion(),
      channel: this.config.get().updates.channel,
      versions: {
        electron: process.versions['electron'] ?? 'unknown',
        node: process.versions.node,
        chrome: process.versions['chrome'] ?? 'unknown'
      },
      roblox: () => {
        const state = this.roblox.state();
        return {
          installations: state.installations.map((i) => ({
            kind: i.kind, version: i.clientVersion, guid: i.versionGuid, path: i.directory
          })),
          active: state.active?.clientVersion ?? state.active?.versionGuid ?? null,
          running: state.processes.length,
          latestKnown: state.latest?.clientVersion ?? null
        };
      },
      profile: () => {
        const profile = this.profiles.active();
        const report = this.profiles.validate(profile.id);
        return {
          id: profile.id,
          name: profile.name,
          valid: report.ok ? report.value.valid : false,
          issues: report.ok ? report.value.issues.length : 0
        };
      },
      modifications: () => {
        const profile = this.profiles.active();
        const sets = this.assets.listSets();
        return {
          fastFlagCount: Object.keys(profile.fastFlags).length,
          optimizerPreset: profile.optimizer.preset,
          appliedActions: this.optimizer.state().appliedActionIds.length,
          // Refreshed by a cheap directory walk whenever the Modifications page
          // or a report asks for it; see `refreshModCount`.
          modFileCount: this.modFileCount,
          assetRuleCount: sets.ok ? sets.value.reduce((n, s) => n + s.ruleCount, 0) : 0
        };
      },
      interception: () => {
        const state = this.interception.state();
        return {
          status: state.status,
          port: state.port,
          certificateInstalled: state.certificateInstalled
        };
      },
      cache: () => {
        const stats = this.assets.stats();
        return stats.ok
          ? { assets: stats.value.assetCount, bytes: stats.value.totalBytes }
          : { assets: 0, bytes: 0 };
      },
      includeHardware: () => this.config.get().diagnostics.includeHardware,
      hardwareSummary: () => {
        const hardware = this.optimizer.state().hardware;
        if (!hardware) return null;
        const gpu = hardware.gpu[0]?.model;
        return `${hardware.cpu.model} (${hardware.cpu.threads} threads)${gpu ? ` / ${gpu}` : ''}`;
      },
      benchmarkContext: () => {
        const stats = this.interception.state().stats;
        const profile = this.profiles.active();
        const sets = this.assets.listSets();
        return {
          paths: this.paths,
          startupMs: this.startupMs,
          lastLaunchMs: this.lastLaunchMs,
          cacheHitRate: stats.intercepted > 0 ? stats.cacheHits / stats.intercepted : null,
          interceptionOverheadMs: stats.intercepted > 0 ? stats.meanOverheadMs : null,
          configurationSize: {
            flags: Object.keys(profile.fastFlags).length,
            rules: sets.ok ? sets.value.reduce((n, s) => n + s.ruleCount, 0) : 0,
            profiles: this.profiles.list().length
          }
        };
      }
    }, this.logger.scope('diagnostics'));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.log.info('Shutting down');

    this.samplingRelease?.();
    this.overlay.dispose();
    await this.interception.dispose();
    this.capture.dispose();
    this.roblox.dispose();
    this.monitor.dispose();
    this.assets.close();
    await this.config.flush();
    await this.platform.dispose();
    this.ipc.dispose();
    await this.logger.close();
  }
}
