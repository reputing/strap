import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { CrosshairConfig, HudConfig, OverlayConfig, ProcessSample, Profile } from '@shared/types';
import type { ScopedLogger } from '@main/core/logger';
import type { PlatformAdapter, WindowBounds } from '@main/platform';

export interface OverlayState {
  crosshair: boolean;
  hud: boolean;
  attachedPid: number | null;
  supported: boolean;
  detail: string | null;
}

/** How often the overlay follows the client window. */
const FOLLOW_INTERVAL_MS = 500;

/**
 * Crosshair and performance overlays.
 *
 * Two frameless, transparent, always-on-top windows that ignore mouse events,
 * positioned over the Roblox client window. They render nothing but what the
 * profile asks for, and they exist only while a client is running.
 *
 * Deliberate limits, stated rather than papered over:
 *
 *  - These are separate windows composited by Windows, not an injected overlay.
 *    Nothing is written into the Roblox process. That is the whole reason this
 *    feature is safe to ship; it also means an exclusive-fullscreen client will
 *    cover them. Borderless and windowed modes work.
 *  - The HUD shows figures Blossom can actually measure from outside the
 *    process: CPU, working set, uptime. It does not show the client's frame
 *    rate, because reading that would mean reaching inside the client. The
 *    field is present in the configuration and marked unavailable in the UI
 *    rather than filled with a number we made up.
 */
export class OverlayService extends EventEmitter {
  private crosshairWindow: BrowserWindow | null = null;
  private hudWindow: BrowserWindow | null = null;
  private followTimer: NodeJS.Timeout | null = null;
  private attachedPid: number | null = null;
  private config: OverlayConfig | null = null;
  private lastBounds: WindowBounds | null = null;
  private previewing = false;
  private detail: string | null = null;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly rendererUrl: { devServer: string | null; file: string },
    private readonly log: ScopedLogger
  ) {
    super();
  }

  state(): OverlayState {
    return {
      crosshair: this.crosshairWindow !== null,
      hud: this.hudWindow !== null,
      attachedPid: this.attachedPid,
      supported: this.platform.operational,
      detail: this.platform.operational
        ? this.detail
        : 'Overlays need the Windows helper, which is not available on this system.'
    };
  }

  /** Called by the launcher once the client is up. */
  async attach(pid: number, profile: Profile): Promise<void> {
    this.attachedPid = pid;
    this.config = profile.overlay;
    this.previewing = false;

    if (!profile.overlay.crosshair.enabled && !profile.overlay.hud.enabled) return;

    if (!this.platform.operational) {
      this.detail = 'Overlays need the Windows helper, which is not available on this system.';
      this.log.warn('Overlays requested but the platform helper is unavailable');
      this.emit('changed', this.state());
      return;
    }

    if (profile.overlay.crosshair.enabled) await this.showCrosshair(profile.overlay.crosshair);
    if (profile.overlay.hud.enabled) await this.showHud(profile.overlay.hud);

    this.startFollowing();
    this.emit('changed', this.state());
  }

  async detach(): Promise<void> {
    this.stopFollowing();
    this.closeWindow('crosshair');
    this.closeWindow('hud');
    this.attachedPid = null;
    this.lastBounds = null;
    this.previewing = false;
    this.emit('changed', this.state());
  }

  /**
   * Shows the overlays over Blossom's own window so the user can see what a
   * crosshair setting looks like without launching Roblox.
   */
  async preview(enabled: boolean, config: OverlayConfig): Promise<void> {
    this.previewing = enabled;
    this.config = config;

    if (!enabled) {
      if (this.attachedPid === null) await this.detach();
      return;
    }

    await this.showCrosshair(config.crosshair);
    const display = screen.getPrimaryDisplay().workArea;
    this.applyBounds({ x: display.x, y: display.y, width: display.width, height: display.height });
    this.emit('changed', this.state());
  }

  async setCrosshair(enabled: boolean): Promise<void> {
    if (!this.config) return;
    if (enabled) await this.showCrosshair(this.config.crosshair);
    else this.closeWindow('crosshair');
    this.emit('changed', this.state());
  }

  async setHud(enabled: boolean): Promise<void> {
    if (!this.config) return;
    if (enabled) await this.showHud(this.config.hud);
    else this.closeWindow('hud');
    this.emit('changed', this.state());
  }

  /** Pushes a live sample into the HUD. */
  pushSample(sample: ProcessSample): void {
    if (!this.hudWindow || this.hudWindow.isDestroyed()) return;
    if (this.attachedPid !== null && sample.pid !== this.attachedPid) return;
    this.hudWindow.webContents.send('overlay:sample', sample);
  }

  private async showCrosshair(config: CrosshairConfig): Promise<void> {
    if (!this.crosshairWindow || this.crosshairWindow.isDestroyed()) {
      this.crosshairWindow = this.createOverlayWindow('crosshair');
      await this.load(this.crosshairWindow, 'crosshair');
    }
    this.crosshairWindow.webContents.send('overlay:config', { kind: 'crosshair', config });
  }

  private async showHud(config: HudConfig): Promise<void> {
    if (!this.hudWindow || this.hudWindow.isDestroyed()) {
      this.hudWindow = this.createOverlayWindow('hud');
      await this.load(this.hudWindow, 'hud');
    }
    this.hudWindow.webContents.send('overlay:config', { kind: 'hud', config });
  }

  private createOverlayWindow(kind: 'crosshair' | 'hud'): BrowserWindow {
    const window = new BrowserWindow({
      width: kind === 'crosshair' ? 400 : 260,
      height: kind === 'crosshair' ? 400 : 160,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      // Never steal focus or clicks from the game.
      alwaysOnTop: true,
      acceptFirstMouse: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Overlays are static and must not spin the GPU when nothing changes.
        backgroundThrottling: true
      }
    });

    window.setIgnoreMouseEvents(true, { forward: false });
    // 'screen-saver' keeps the overlay above full-screen-borderless clients.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on('closed', () => {
      if (kind === 'crosshair') this.crosshairWindow = null;
      else this.hudWindow = null;
    });

    return window;
  }

  private async load(window: BrowserWindow, kind: 'crosshair' | 'hud'): Promise<void> {
    const query = `?overlay=${kind}`;
    try {
      if (this.rendererUrl.devServer) {
        await window.loadURL(`${this.rendererUrl.devServer}/overlay.html${query}`);
      } else {
        await window.loadFile(this.rendererUrl.file, { query: { overlay: kind } });
      }
      window.showInactive();
    } catch (e) {
      this.log.error('An overlay window failed to load', {
        kind, reason: e instanceof Error ? e.message : String(e)
      });
      window.destroy();
    }
  }

  private closeWindow(kind: 'crosshair' | 'hud'): void {
    const window = kind === 'crosshair' ? this.crosshairWindow : this.hudWindow;
    if (window && !window.isDestroyed()) window.destroy();
    if (kind === 'crosshair') this.crosshairWindow = null;
    else this.hudWindow = null;
  }

  /**
   * Follows the client window.
   *
   * There is no OS notification for "another process moved its window", so this
   * is the one place Blossom polls. It runs at 2 Hz, only while an overlay is
   * actually visible, and skips the work entirely when the bounds have not
   * changed.
   */
  private startFollowing(): void {
    if (this.followTimer) return;
    this.followTimer = setInterval(() => { void this.follow(); }, FOLLOW_INTERVAL_MS);
    this.followTimer.unref?.();
    void this.follow();
  }

  private stopFollowing(): void {
    if (this.followTimer) {
      clearInterval(this.followTimer);
      this.followTimer = null;
    }
  }

  private async follow(): Promise<void> {
    if (this.previewing) return;
    const pid = this.attachedPid;
    if (pid === null) { this.stopFollowing(); return; }
    if (!this.crosshairWindow && !this.hudWindow) { this.stopFollowing(); return; }

    const bounds = await this.platform.getMainWindowBounds(pid);
    if (!bounds.ok || !bounds.value) return;

    const b = bounds.value;
    if (this.lastBounds &&
      b.x === this.lastBounds.x && b.y === this.lastBounds.y &&
      b.width === this.lastBounds.width && b.height === this.lastBounds.height) {
      return;
    }
    this.lastBounds = b;
    this.applyBounds(b);
  }

  private applyBounds(b: WindowBounds): void {
    const config = this.config;
    if (!config) return;

    if (this.crosshairWindow && !this.crosshairWindow.isDestroyed()) {
      const size = 400;
      const centreX = Math.round(b.x + b.width / 2 + config.crosshair.offsetX - size / 2);
      const centreY = Math.round(b.y + b.height / 2 + config.crosshair.offsetY - size / 2);
      this.crosshairWindow.setBounds({ x: centreX, y: centreY, width: size, height: size });
    }

    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      const width = Math.round(260 * config.hud.scale);
      const height = Math.round(160 * config.hud.scale);
      const margin = 16;
      const right = config.hud.corner.endsWith('right');
      const bottom = config.hud.corner.startsWith('bottom');
      this.hudWindow.setBounds({
        x: Math.round(right ? b.x + b.width - width - margin : b.x + margin),
        y: Math.round(bottom ? b.y + b.height - height - margin : b.y + margin),
        width,
        height
      });
    }
  }

  dispose(): void {
    void this.detach();
    this.removeAllListeners();
  }
}
