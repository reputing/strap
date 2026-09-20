import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type { AppSettings, InterceptionState, Profile, RobloxInstallation } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import type { BackupService } from '@main/backups/backup-service';
import type { AssetService } from '@main/assets/asset-service';
import type { CaptureService } from '@main/assets/capture-service';
import { CertificateAuthority } from './certificate-authority';
import { RobloxTrustStore } from './trust-store';
import { InterceptionProxy } from './proxy';
import { sanitiseScope } from './scope';

/** Local file replacements are read at most this large. */
const MAX_LOCAL_FILE_BYTES = 64 * 1024 * 1024;

export interface InterceptionChange {
  target: string;
  description: string;
  reversible: boolean;
}

/**
 * The interception engine's lifecycle and public surface.
 *
 * Interception is opt-in twice over: a global switch in Settings and a
 * per-profile switch. Starting it requires that the user has seen `explain()`
 * and installed the certificate, because adding a CA to Roblox's bundle is not
 * something that should ever happen quietly.
 */
export class InterceptionService extends EventEmitter {
  private readonly ca: CertificateAuthority;
  private readonly trust: RobloxTrustStore;
  private readonly proxy: InterceptionProxy;

  private status: InterceptionState['status'] = 'stopped';
  private detail: string | null = null;
  private certificateInstalled = false;
  private activeSetIds: string[] = [];

  constructor(
    paths: BlossomPaths,
    private readonly assets: AssetService,
    private readonly capture: CaptureService,
    backups: BackupService,
    private readonly log: ScopedLogger
  ) {
    super();
    this.ca = new CertificateAuthority(paths.proxy, log.child('ca'));
    this.trust = new RobloxTrustStore(backups, log.child('trust'));
    this.proxy = new InterceptionProxy(this.ca, {
      rules: () => this.assets.activeRules(this.activeSetIds),
      resolveAssetBytes: (assetId) => this.readCachedAsset(assetId),
      readLocalFile: (path) => this.readLocalFile(path),
      onCapture: (event, body) => this.capture.record(event, body),
      shouldCache: () => this.cacheResponses
    }, log.child('proxy'));
  }

  private cacheResponses = true;

  state(): InterceptionState {
    return {
      status: this.status,
      port: this.proxy.boundPort,
      detail: this.detail,
      certificateInstalled: this.certificateInstalled,
      startedAt: this.proxy.since,
      stats: {
        ...this.proxy.snapshotStats(),
        droppedCaptureEvents: this.capture.state().dropped
      }
    };
  }

  /**
   * Exactly what starting interception will change on the machine. Shown before
   * anything happens, and before any elevation is ever requested.
   */
  explain(install: RobloxInstallation | null): { changes: InterceptionChange[]; requiresElevation: boolean } {
    const changes: InterceptionChange[] = [
      {
        target: 'A local certificate in the Blossom Strap folder',
        description:
          'Blossom generates a certificate authority stored only in your user profile. It is used to read asset requests and nothing else.',
        reversible: true
      },
      {
        target: install ? RobloxTrustStore.bundlePath(install) : "Roblox Player's own certificate bundle",
        description:
          "That certificate is added to Roblox Player's own bundle, inside a marked block. Windows' certificate store is not touched, and no other program on this machine is affected.",
        reversible: true
      },
      {
        target: 'A loopback-only proxy on an automatic port',
        description:
          'The proxy listens on 127.0.0.1 and is reachable only by the Roblox process Blossom launches, because the proxy settings are placed in that process\'s environment. The hosts file and the system proxy settings are not changed.',
        reversible: true
      },
      {
        target: 'Asset hosts only',
        description:
          'Only Roblox asset delivery and CDN hosts are read. Sign-in, account, payment and telemetry connections are passed through without being decrypted.',
        reversible: true
      }
    ];

    // Nothing here needs administrator rights: that is the point of scoping the
    // change to Roblox's own bundle and a high loopback port.
    return { changes, requiresElevation: false };
  }

  async installCertificate(install: RobloxInstallation): Promise<Result<{ installed: boolean; path: string }>> {
    const loaded = await this.ca.load();
    if (!loaded.ok) return loaded;
    if (!this.ca.certificatePem) {
      return Err('unknown', 'The local certificate could not be prepared.');
    }

    const installed = await this.trust.install(install, this.ca.certificatePem);
    if (installed.ok) {
      this.certificateInstalled = true;
      this.emit('changed', this.state());
    }
    return installed;
  }

  async removeCertificate(install: RobloxInstallation | null): Promise<Result<{ removed: boolean }>> {
    let removed = false;
    if (install) {
      const r = await this.trust.remove(install);
      if (!r.ok) return r;
      removed = r.value.removed;
    }
    await this.ca.destroy();
    this.certificateInstalled = false;
    this.emit('changed', this.state());
    return Ok({ removed });
  }

  async refreshCertificateState(install: RobloxInstallation | null): Promise<void> {
    this.certificateInstalled = install ? await this.trust.isInstalled(install) : false;
  }

  /**
   * Starts the proxy. Refuses rather than proceeding when the prerequisites are
   * not met, so the user gets a clear reason instead of a client that silently
   * fails to load assets.
   */
  async start(settings: AppSettings, install: RobloxInstallation | null): Promise<Result<InterceptionState>> {
    if (this.status === 'running') return Ok(this.state());

    if (!settings.interception.enabled) {
      return Err('invalid-argument', 'Asset interception is turned off in Settings.', {
        remediation: 'Turn it on under Settings → Asset interception, then try again.'
      });
    }
    if (!install) {
      return Err('roblox-not-found', 'Roblox must be installed before interception can start.');
    }
    if (!this.assets.available) {
      return Err('io-failure', 'The asset index is unavailable, so interception has nowhere to record what it sees.');
    }

    this.status = 'starting';
    this.detail = null;
    this.cacheResponses = settings.interception.cacheResponses;
    this.emit('changed', this.state());

    const loaded = await this.ca.load();
    if (!loaded.ok) {
      return this.fail(loaded.error.message);
    }

    await this.refreshCertificateState(install);
    if (!this.certificateInstalled) {
      this.status = 'stopped';
      this.emit('changed', this.state());
      return Err('permission-denied', 'Blossom\'s local certificate is not installed in Roblox yet.', {
        remediation: 'Open Assets → Interception and review what will change, then install the certificate.'
      });
    }

    const scope = sanitiseScope(settings.interception.scope);
    if (!scope.length) {
      return this.fail('No asset hosts are in scope, so there would be nothing to intercept.');
    }

    const started = await this.proxy.start(settings.interception.port, scope);
    if (!started.ok) {
      return this.fail(started.error.message);
    }

    this.status = 'running';
    this.detail = null;
    this.log.info('Asset interception started', { port: started.value, hosts: scope.length });
    this.emit('changed', this.state());
    return Ok(this.state());
  }

  async stop(): Promise<InterceptionState> {
    await this.proxy.stop();
    this.status = 'stopped';
    this.detail = null;
    this.emit('changed', this.state());
    return this.state();
  }

  /** Marks the engine degraded without stopping it. */
  degrade(reason: string): void {
    if (this.status !== 'running') return;
    this.status = 'degraded';
    this.detail = reason;
    this.log.warn('Interception is degraded', { reason });
    this.emit('changed', this.state());
  }

  private fail(reason: string): Result<never> {
    this.status = 'failed';
    this.detail = reason;
    this.log.error('Interception could not start', { reason });
    this.emit('changed', this.state());
    return Err('io-failure', reason);
  }

  /**
   * Environment variables that scope the proxy to one child process.
   *
   * Roblox Player's networking honours the standard libcurl proxy variables.
   * Setting them here — and only here — is what keeps the redirect local to the
   * client Blossom launched instead of changing anything machine-wide. If the
   * client ignores them, the proxy simply sees no traffic and the engine
   * reports itself degraded rather than pretending it is working.
   */
  environmentFor(install: RobloxInstallation): Record<string, string> {
    const port = this.proxy.boundPort;
    if (!port) return {};
    const endpoint = `http://127.0.0.1:${port}`;

    return {
      HTTP_PROXY: endpoint,
      HTTPS_PROXY: endpoint,
      ALL_PROXY: endpoint,
      http_proxy: endpoint,
      https_proxy: endpoint,
      all_proxy: endpoint,
      // Point the client at the bundle that now contains our CA. It is the same
      // file the client already uses; naming it explicitly avoids depending on
      // the working directory.
      CURL_CA_BUNDLE: RobloxTrustStore.bundlePath(install),
      SSL_CERT_FILE: RobloxTrustStore.bundlePath(install)
    };
  }

  /** Called by the launcher before spawning the client. */
  async prepareForLaunch(
    profile: Profile,
    install: RobloxInstallation,
    settings: AppSettings
  ): Promise<Result<Record<string, string>>> {
    this.activeSetIds = profile.assets.assetProfileIds;

    const started = await this.start(settings, install);
    if (!started.ok) return started;

    if (profile.assets.capture) {
      await this.capture.start(true);
    }

    // The proxy sees no traffic if the client ignores the environment. Check
    // after a grace period and report honestly rather than claiming success.
    const timer = setTimeout(() => {
      if (this.status === 'running' && this.proxy.snapshotStats().requests === 0) {
        this.degrade(
          'The client has not sent any requests through the proxy. Asset replacement is not active for this session.'
        );
      }
    }, 45_000);
    timer.unref?.();

    return Ok(this.environmentFor(install));
  }

  async release(): Promise<void> {
    await this.capture.stop();
    await this.stop();
    this.activeSetIds = [];
  }

  statusForLaunch(): 'off' | 'active' | 'degraded' | 'failed' {
    switch (this.status) {
      case 'running': return 'active';
      case 'degraded': return 'degraded';
      case 'failed': return 'failed';
      default: return 'off';
    }
  }

  setActiveSets(ids: string[]): void {
    this.activeSetIds = ids;
    this.assets.invalidateRules();
  }

  private async readCachedAsset(assetId: string): Promise<Buffer | null> {
    const asset = this.assets.get(assetId);
    if (!asset.ok || !asset.value.hash) return null;
    const bytes = await this.assets.blobs.get(asset.value.hash);
    return bytes.ok ? bytes.value : null;
  }

  private async readLocalFile(path: string): Promise<Buffer | null> {
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile() || stat.size > MAX_LOCAL_FILE_BYTES) return null;
      return await fs.readFile(path);
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    await this.proxy.stop();
    this.removeAllListeners();
  }
}
