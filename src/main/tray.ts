import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { ServiceHost } from './core/service-host';

export interface TrayActions {
  show: () => void;
  launch: (profileId?: string) => void;
  toggleInterception: () => void;
  openDiagnostics: () => void;
  quit: () => void;
}

/**
 * The tray icon.
 *
 * Blossom is useful with no window open — it can watch for Roblox, hold the
 * interception engine and serve a hotkey — so closing the window destroys the
 * renderer and leaves the services running. The tray is how the user gets back.
 *
 * The menu is rebuilt whenever the state it shows changes, rather than on a
 * timer, so an idle Blossom does no work here at all.
 */
export class TrayController {
  private tray: Tray | null = null;
  private rebuildQueued = false;

  constructor(
    private readonly host: ServiceHost,
    private readonly actions: TrayActions,
    private readonly iconPath: string
  ) {}

  create(): void {
    if (this.tray) return;

    const image = nativeImage.createFromPath(this.iconPath);
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip('Blossom Strap');
    this.tray.on('double-click', () => this.actions.show());

    this.rebuild();

    // Rebuild on the events that change what the menu says.
    this.host.monitor.on('changed', () => this.queueRebuild());
    this.host.profiles.on('changed', () => this.queueRebuild());
    this.host.interception.on('changed', () => this.queueRebuild());
  }

  private queueRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    setImmediate(() => {
      this.rebuildQueued = false;
      this.rebuild();
    });
  }

  rebuild(): void {
    if (!this.tray) return;

    const running = this.host.monitor.isRunning();
    const profiles = this.host.profiles.list();
    const activeProfile = this.host.profiles.active();
    const interception = this.host.interception.state();
    const roblox = this.host.roblox.state();

    const statusLabel = !roblox.active
      ? 'Roblox not detected'
      : running
        ? `Roblox running — ${roblox.active.clientVersion ?? roblox.active.versionGuid}`
        : `Roblox ready — ${roblox.active.clientVersion ?? roblox.active.versionGuid}`;

    const template: MenuItemConstructorOptions[] = [
      { label: statusLabel, enabled: false },
      { label: `Profile: ${activeProfile.name}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Launch Roblox',
        enabled: !running || activeProfile.launcher.multiInstance,
        click: () => this.actions.launch()
      },
      {
        label: 'Launch with profile',
        enabled: !running || activeProfile.launcher.multiInstance,
        submenu: profiles.map((p) => ({
          label: p.name,
          type: 'radio' as const,
          checked: p.id === activeProfile.id,
          click: () => this.actions.launch(p.id)
        }))
      },
      { type: 'separator' },
      {
        label: interception.status === 'running' ? 'Pause interception' : 'Resume interception',
        enabled: this.host.config.get().interception.enabled,
        click: () => this.actions.toggleInterception()
      },
      { type: 'separator' },
      { label: 'Open Blossom Strap', click: () => this.actions.show() },
      { label: 'Diagnostics', click: () => this.actions.openDiagnostics() },
      { type: 'separator' },
      { label: 'Exit', click: () => this.actions.quit() }
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
    this.tray.setToolTip(`Blossom Strap — ${statusLabel}`);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  static defaultIconPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png');
  }
}
