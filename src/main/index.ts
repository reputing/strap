import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import type { HotkeyAction } from '@shared/types';
import { ServiceHost } from './core/service-host';
import { registerHandlers, runCommand, type HandlerContext } from './core/handlers';
import { TrayController } from './tray';
import { HotkeyController } from './hotkeys';

const PROTOCOL = 'blossom-strap';
/** Set by the release pipeline. A development build simply has no feed. */
const UPDATE_MANIFEST_URL = process.env['BLOSSOM_UPDATE_MANIFEST'] ?? null;

const startedAt = Date.now();

let host: ServiceHost | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
let hotkeys: HotkeyController | null = null;
let quitting = false;
/** A deeplink that arrived before the services were ready. */
let pendingDeeplink: string | null = null;

/**
 * Only one Blossom may run at a time: two copies would fight over the Roblox
 * files they both modify. A second launch hands its arguments to the first.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

function rendererTargets(): { devServer: string | null; file: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL'] ?? null;
  return { devServer, file: join(__dirname, '../renderer/index.html') };
}

function overlayTargets(): { devServer: string | null; file: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL'] ?? null;
  return { devServer, file: join(__dirname, '../renderer/overlay.html') };
}

async function main(): Promise<void> {
  // Chromium's shared GPU process is the largest fixed cost of an Electron app
  // that mostly renders static panels. Disabling the software rasteriser keeps
  // idle GPU work down without giving up hardware compositing.
  app.commandLine.appendSwitch('disable-software-rasterizer');

  app.on('second-instance', (_event, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}:`) || a.startsWith('roblox-player:'));
    if (link) void handleDeeplink(link);
    showMainWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    void handleDeeplink(url);
  });

  await app.whenReady();

  host = new ServiceHost({
    rendererUrl: overlayTargets(),
    manifestUrl: UPDATE_MANIFEST_URL
  });

  try {
    await host.start();
  } catch (e) {
    // Starting must not be able to leave a half-built app with no way out.
    host.log.critical('Blossom could not start', {
      reason: e instanceof Error ? e.message : String(e)
    });
  }

  const ctx: HandlerContext = {
    host,
    mainWindow: () => mainWindow,
    navigate: (route) => {
      showMainWindow();
      host?.ipc.emit('navigate', { route });
    },
    quit: () => { quitting = true; app.quit(); }
  };

  registerHandlers(ctx);
  host.ipc.listen();

  hotkeys = new HotkeyController((action) => runHotkey(ctx, action), host.logger.scope('hotkeys'));
  hotkeys.apply(host.config.get());
  host.config.on('changed', (settings) => hotkeys?.apply(settings));

  tray = new TrayController(host, {
    show: showMainWindow,
    launch: (profileId) => void launchFromTray(ctx, profileId),
    toggleInterception: () => void runCommand(ctx, 'interception.toggle'),
    openDiagnostics: () => ctx.navigate('/diagnostics'),
    quit: () => { quitting = true; app.quit(); }
  }, TrayController.defaultIconPath());
  tray.create();

  await applyProtocolRegistration();

  const settings = host.config.get();
  if (!settings.startMinimised) createMainWindow();

  if (pendingDeeplink) {
    const link = pendingDeeplink;
    pendingDeeplink = null;
    void handleDeeplink(link);
  }

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createMainWindow();
  });

  app.on('window-all-closed', () => {
    // Blossom keeps running in the tray: that is the whole point of the
    // background mode. Quitting here would kill interception mid-session.
    if (!host?.config.get().closeToTray) {
      quitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', async (event) => {
    if (!host) return;
    event.preventDefault();
    hotkeys?.unregisterAll();
    tray?.destroy();
    await host.dispose();
    host = null;
    app.exit(0);
  });
}

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return mainWindow;
  }

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#12111a',
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The UI is panels and lists; throttling a hidden window is free.
      backgroundThrottling: true,
      spellcheck: false
    }
  });

  window.once('ready-to-show', () => {
    if (host && host.startupMs === null) {
      host.startupMs = Date.now() - startedAt;
      host.log.info('Window ready', { ms: host.startupMs });
    }
    if (!host?.config.get().startMinimised) window.show();
  });

  window.on('close', (event) => {
    // Closing hides; quitting is an explicit action from the tray or the menu.
    if (!quitting && host?.config.get().closeToTray) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => { mainWindow = null; });

  // Nothing in the app ever navigates away or opens a window; both are refused.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const targets = rendererTargets();
    if (targets.devServer && url.startsWith(targets.devServer)) return;
    event.preventDefault();
  });

  const targets = rendererTargets();
  if (targets.devServer) void window.loadURL(targets.devServer);
  else void window.loadFile(targets.file);

  host?.ipc.register(window.webContents);
  mainWindow = window;
  return window;
}

function showMainWindow(): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function launchFromTray(ctx: HandlerContext, profileId?: string): Promise<void> {
  if (!host) return;
  const profile = profileId ? host.profiles.get(profileId) : { ok: true as const, value: host.profiles.active() };
  if (!profile.ok) return;
  const result = await host.launcher.launch({ profileId }, profile.value);
  if (!result.ok) {
    host.ipc.emit('toast', { kind: 'error', title: 'Could not launch Roblox', message: result.error.message });
    ctx.navigate('/home');
  }
}

function runHotkey(ctx: HandlerContext, action: HotkeyAction): void {
  switch (action) {
    case 'show-window': showMainWindow(); break;
    case 'quick-launch': void runCommand(ctx, 'launch.roblox'); break;
    case 'toggle-interception': void runCommand(ctx, 'interception.toggle'); break;
    case 'toggle-capture':
      void runCommand(ctx, host?.capture.isActive ? 'capture.stop' : 'capture.start');
      break;
    case 'toggle-crosshair': void runCommand(ctx, 'overlay.toggle-crosshair'); break;
    case 'toggle-hud': void runCommand(ctx, 'overlay.toggle-hud'); break;
  }
}

/**
 * Registers Blossom as a handler for its own protocol only.
 *
 * Taking over `roblox-player:` would route every launch from the website
 * through Blossom, which is a large, surprising change to make on somebody's
 * machine; it stays behind an explicit setting and is undone when turned off.
 */
async function applyProtocolRegistration(): Promise<void> {
  if (!host) return;
  const wanted = host.config.get().registerProtocolHandler;

  try {
    if (wanted) {
      app.setAsDefaultProtocolClient(PROTOCOL);
      host.log.info('Registered as a handler for blossom-strap links');
    } else {
      app.removeAsDefaultProtocolClient(PROTOCOL);
    }
  } catch (e) {
    host.log.warn('Could not change the protocol registration', {
      reason: e instanceof Error ? e.message : String(e)
    });
  }
}

/**
 * A deeplink is forwarded to the client untouched. It carries the join ticket,
 * and rewriting any part of it is how launchers break joining.
 */
async function handleDeeplink(url: string): Promise<void> {
  if (!host) { pendingDeeplink = url; return; }

  const profile = host.profiles.active();
  host.log.info('Launch requested from a link', { profile: profile.name });

  const result = await host.launcher.launch({ deeplink: url }, profile);
  if (!result.ok) {
    host.ipc.emit('toast', { kind: 'error', title: 'Could not launch Roblox', message: result.error.message });
    showMainWindow();
  }
}
