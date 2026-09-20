import type { AppSettings, OverlayConfig, Profile } from '@shared/types';
import { PROFILE_SCHEMA_VERSION } from '@shared/types';

export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Hosts the interception proxy is allowed to decrypt. Everything else is
 * tunnelled without being read. Asset delivery only — never auth, never
 * payments, never telemetry.
 */
export const DEFAULT_INTERCEPTION_SCOPE = [
  'assetdelivery.roblox.com',
  'assetdelivery.rbxcdn.com',
  'c0.rbxcdn.com',
  'c1.rbxcdn.com',
  'c2.rbxcdn.com',
  'c3.rbxcdn.com',
  'c4.rbxcdn.com',
  'c5.rbxcdn.com',
  'c6.rbxcdn.com',
  'c7.rbxcdn.com',
  't0.rbxcdn.com',
  't1.rbxcdn.com',
  't2.rbxcdn.com',
  't3.rbxcdn.com',
  't4.rbxcdn.com',
  't5.rbxcdn.com',
  't6.rbxcdn.com',
  't7.rbxcdn.com',
  'fts.rbxcdn.com'
];

export function defaultOverlay(): OverlayConfig {
  return {
    crosshair: {
      enabled: false,
      style: 'cross-dot',
      size: 12,
      thickness: 2,
      gap: 4,
      color: '#ff5fa2',
      opacity: 0.9,
      outline: true,
      outlineColor: '#000000',
      offsetX: 0,
      offsetY: 0
    },
    hud: {
      enabled: false,
      corner: 'top-left',
      showFps: true,
      showCpu: true,
      showMemory: true,
      showUptime: true,
      showPing: false,
      opacity: 0.85,
      scale: 1
    }
  };
}

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    activeProfileId: 'default',
    appearance: { accent: 'blossom', density: 'comfortable', reduceMotion: false },
    registerProtocolHandler: false,
    startWithWindows: false,
    startMinimised: false,
    closeToTray: true,
    confirmBeforeLaunch: false,
    logLevel: 'info',
    updates: { channel: 'stable', checkAutomatically: true, lastCheckedAt: null },
    interception: {
      enabled: false,
      port: 0,
      scope: [...DEFAULT_INTERCEPTION_SCOPE],
      cacheResponses: true,
      cacheBudgetBytes: 4 * 1024 * 1024 * 1024
    },
    hotkeys: {
      enabled: false,
      bindings: {
        'show-window': 'Alt+B',
        'quick-launch': 'Alt+Shift+L',
        'toggle-interception': 'Alt+Shift+I',
        'toggle-capture': 'Alt+Shift+C',
        'toggle-crosshair': 'Alt+Shift+X',
        'toggle-hud': 'Alt+Shift+H'
      }
    },
    diagnostics: { includeHardware: true }
  };
}

export function emptyProfile(id: string, name: string): Profile {
  const now = Date.now();
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id,
    name,
    description: '',
    builtIn: false,
    createdAt: now,
    updatedAt: now,
    launcher: {
      kind: 'player',
      multiInstance: false,
      priority: 'normal',
      affinityMask: null,
      extraArgs: [],
      onExit: 'restore',
      hideOnLaunch: true
    },
    fastFlags: {},
    optimizer: { preset: 'balanced', overrides: {} },
    assets: { interception: false, assetProfileIds: [], capture: false },
    overlay: defaultOverlay(),
    appearance: { accent: 'blossom', density: 'comfortable', reduceMotion: false }
  };
}

/**
 * The profiles Blossom ships with. They are ordinary profiles marked `builtIn`,
 * which means they cannot be deleted; editing one forks it into a copy.
 */
export function builtInProfiles(): Profile[] {
  const base = (id: string, name: string, description: string): Profile => ({
    ...emptyProfile(id, name),
    description,
    builtIn: true
  });

  const def = base('default', 'Default', 'Roblox exactly as it ships. Blossom changes nothing.');
  def.optimizer = { preset: 'conservative', overrides: {} };

  const competitive = base(
    'competitive',
    'Competitive',
    'Frame consistency and input responsiveness over visual fidelity.'
  );
  competitive.launcher.priority = 'above-normal';
  competitive.optimizer = { preset: 'performance', overrides: {} };
  competitive.overlay.crosshair.enabled = true;
  competitive.overlay.hud.enabled = true;

  const lowEnd = base('low-end', 'Low End', 'Cuts resource use on machines with limited RAM or an integrated GPU.');
  lowEnd.optimizer = { preset: 'low-end', overrides: {} };

  const highQuality = base('high-quality', 'High Quality', 'Leaves rendering alone and only removes scheduler ceilings.');
  highQuality.optimizer = { preset: 'conservative', overrides: {} };

  const recording = base('recording', 'Recording', 'Steady frame pacing and a clean screen for capture.');
  recording.optimizer = { preset: 'balanced', overrides: {} };
  recording.overlay.hud.enabled = false;
  recording.overlay.crosshair.enabled = false;

  return [def, competitive, lowEnd, highQuality, recording];
}
