import type { FlagDefinition } from '@shared/types';
import { parseFlagName } from './flag-syntax';

/**
 * The flags Blossom knows something about.
 *
 * This is deliberately a short, curated list rather than a dump of every flag
 * name that has ever circulated. Each entry carries a `confidence`:
 *
 *   documented — described in Bloxstrap's public FastFlag guide and in long,
 *                consistent community use; behaviour is well understood.
 *   community  — widely used and reliably reproduced, but not formally
 *                documented by anyone with access to the engine.
 *   unverified — anything the user adds by hand. Blossom validates the syntax
 *                and leaves the meaning alone.
 *
 * Blossom never invents a flag, and never claims a specific FPS gain. Where the
 * effect depends on hardware or on the experience being played, the description
 * says so.
 */
const DEFS: Omit<FlagDefinition, 'prefix' | 'valueType'>[] = [
  // ── scheduler / frame pacing ──────────────────────────────────────────
  {
    name: 'DFIntTaskSchedulerTargetFps',
    category: 'performance',
    description: 'Frame rate the client schedules work against. Raising it removes the default ceiling; the client still cannot draw faster than the machine and the display allow.',
    robloxDefault: '60',
    confidence: 'documented',
    risk: 'safe',
    suggestions: ['60', '75', '120', '144', '240', '360']
  },
  {
    name: 'FFlagTaskSchedulerLimitTargetFpsTo2402',
    category: 'performance',
    description: 'Caps the task scheduler at 240 FPS regardless of the target. Set to False when a target above 240 is intended.',
    robloxDefault: 'True',
    confidence: 'community',
    risk: 'low'
  },
  {
    name: 'DFIntTaskSchedulerAsyncTaskTimeBudgetMs',
    category: 'performance',
    description: 'Milliseconds per frame the scheduler will spend on background tasks such as asset decoding.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'moderate'
  },

  // ── renderer selection ────────────────────────────────────────────────
  {
    name: 'FFlagDebugGraphicsPreferD3D11',
    category: 'rendering',
    description: 'Asks the client to use the Direct3D 11 backend. The most broadly compatible choice on Windows.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'low'
  },
  {
    name: 'FFlagDebugGraphicsPreferVulkan',
    category: 'rendering',
    description: 'Asks the client to use the Vulkan backend. Can help on some AMD and Intel drivers and can break on others.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'moderate'
  },
  {
    name: 'FFlagDebugGraphicsPreferD3D11FL10',
    category: 'rendering',
    description: 'Direct3D 11 restricted to feature level 10. A fallback for very old GPUs; reduces visual features.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'moderate'
  },
  {
    name: 'FFlagDebugGraphicsDisableDirect3D11',
    category: 'rendering',
    description: 'Prevents the Direct3D 11 backend from being selected. Only useful alongside another backend preference.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'advanced'
  },

  // ── rendering quality ─────────────────────────────────────────────────
  {
    name: 'DFIntDebugFRMQualityLevelOverride',
    category: 'rendering',
    description: 'Pins the render quality level the client would otherwise choose automatically. 1 is the lowest, 21 the highest.',
    robloxDefault: null,
    confidence: 'documented',
    risk: 'low',
    suggestions: ['1', '5', '10', '15', '21']
  },
  {
    name: 'FFlagDisablePostFx',
    category: 'rendering',
    description: 'Disables post-processing effects such as bloom, colour correction and depth of field.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'safe'
  },
  {
    name: 'FIntRenderShadowIntensity',
    category: 'rendering',
    description: 'Intensity of dynamic shadows, 0 to 100. Zero removes shadow rendering entirely.',
    robloxDefault: null,
    confidence: 'documented',
    risk: 'safe',
    suggestions: ['0', '25', '50', '100']
  },
  {
    name: 'DFFlagDebugPauseVoxelizer',
    category: 'rendering',
    description: 'Stops the voxel lighting grid from updating. Removes dynamic voxel shadows and their per-frame cost; lighting will look flat.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'low'
  },
  {
    name: 'FIntDebugForceMSAASamples',
    category: 'rendering',
    description: 'Forces a multisample anti-aliasing level: 0, 1, 2, 4 or 8. Higher values cost fill rate.',
    robloxDefault: null,
    confidence: 'documented',
    risk: 'low',
    suggestions: ['0', '1', '2', '4', '8']
  },
  {
    name: 'FIntRenderLocalLightUpdatesMax',
    category: 'rendering',
    description: 'Upper bound on dynamic local lights updated per frame. Lower values reduce lighting cost in busy scenes.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'moderate'
  },
  {
    name: 'FIntRenderLocalLightUpdatesMin',
    category: 'rendering',
    description: 'Lower bound on dynamic local lights updated per frame. Must be at or below the maximum.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'moderate'
  },
  {
    name: 'FIntFRMMinGrassDistance',
    category: 'rendering',
    description: 'Distance at which grass stops being drawn. Zero with a zero maximum removes grass.',
    robloxDefault: null,
    confidence: 'documented',
    risk: 'safe',
    suggestions: ['0', '20', '40', '80']
  },
  {
    name: 'FIntFRMMaxGrassDistance',
    category: 'rendering',
    description: 'Furthest distance grass is drawn at. Lower values reduce terrain cost.',
    robloxDefault: null,
    confidence: 'documented',
    risk: 'safe',
    suggestions: ['0', '40', '80', '120']
  },
  {
    name: 'FIntTerrainArraySliceSize',
    category: 'rendering',
    description: 'Texture slice size used for terrain. Lower values reduce terrain texture memory and detail.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'low',
    suggestions: ['4', '8', '16', '32', '64']
  },
  {
    name: 'FFlagDebugSkyGray',
    category: 'rendering',
    description: 'Replaces the sky with flat grey. Removes skybox rendering cost and, incidentally, a lot of visual noise.',
    robloxDefault: 'False',
    confidence: 'documented',
    risk: 'safe'
  },
  {
    name: 'DFIntCSGLevelOfDetailSwitchingDistance',
    category: 'rendering',
    description: 'Distance at which solid-modelled parts drop to a cheaper level of detail.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'low'
  },

  // ── interface ─────────────────────────────────────────────────────────
  {
    name: 'FIntRobloxGuiBlurIntensity',
    category: 'ui',
    description: 'Blur strength behind the in-experience menu. Zero removes the blur pass.',
    robloxDefault: null,
    confidence: 'documented',
    risk: 'safe',
    suggestions: ['0', '12', '24']
  },
  {
    name: 'FFlagDebugDisplayUnthemedInstanceNames',
    category: 'debug',
    description: 'Developer diagnostic that labels unthemed interface instances. Noisy; leave off unless debugging.',
    robloxDefault: 'False',
    confidence: 'community',
    risk: 'low'
  },
  {
    name: 'FFlagHandleAltEnterFullscreenManually',
    category: 'input',
    description: 'Handles Alt+Enter fullscreen switching inside the client. Set to False if fullscreen toggling misbehaves.',
    robloxDefault: 'True',
    confidence: 'documented',
    risk: 'safe'
  },
  {
    name: 'FFlagAdServiceEnabled',
    category: 'ui',
    description: 'Controls the in-experience ad service. Setting it to False stops that service running locally.',
    robloxDefault: 'True',
    confidence: 'community',
    risk: 'low'
  },

  // ── memory and asset pipeline ─────────────────────────────────────────
  {
    name: 'DFIntNumAssetsMaxToPreload',
    category: 'performance',
    description: 'Ceiling on assets the client will preload in one batch. Lower values smooth loading spikes; higher values front-load them.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'low',
    suggestions: ['100', '250', '500']
  },
  {
    name: 'DFIntDefaultMeshCacheSizeMB',
    category: 'performance',
    description: 'Megabytes reserved for the mesh cache. Larger caches trade memory for fewer repeat loads.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'moderate'
  },
  {
    name: 'DFIntTextureCompositorActiveJobs',
    category: 'performance',
    description: 'Concurrent texture compositing jobs. Raising it can shorten character load times on multi-core machines.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'moderate'
  },

  // ── network ───────────────────────────────────────────────────────────
  {
    name: 'DFIntConnectionMTUSize',
    category: 'network',
    description: 'Maximum transmission unit the client negotiates. Only change this if you understand your network path; a wrong value causes fragmentation.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'advanced'
  },
  {
    name: 'DFIntHttpCurlConnectionCacheSize',
    category: 'network',
    description: 'How many HTTP connections the client keeps warm. Higher values can reduce reconnection overhead during asset-heavy loads.',
    robloxDefault: null,
    confidence: 'community',
    risk: 'moderate'
  },

  // ── logging ───────────────────────────────────────────────────────────
  {
    name: 'FLogNetwork',
    category: 'debug',
    description: 'Verbosity of the client network log. Useful when diagnosing connection problems; noisy otherwise.',
    robloxDefault: '0',
    confidence: 'documented',
    risk: 'safe',
    suggestions: ['0', '1', '7']
  }
];

/** The catalog, with prefix and value type derived from each name. */
export const FLAG_CATALOG: FlagDefinition[] = DEFS.map((d) => {
  const parsed = parseFlagName(d.name);
  if (!parsed) {
    // A typo in this file is a build-time bug, not a runtime condition.
    throw new Error(`Catalog entry has an unrecognised flag prefix: ${d.name}`);
  }
  return { ...d, prefix: parsed.prefix, valueType: parsed.valueType };
});

const BY_NAME = new Map(FLAG_CATALOG.map((f) => [f.name.toLowerCase(), f]));

export function findFlag(name: string): FlagDefinition | null {
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

/**
 * Flags that must not be set at the same time, with the reason. Used by
 * validation to warn before the user launches into a broken client.
 */
export const MUTUALLY_EXCLUSIVE: { flags: string[]; reason: string }[] = [
  {
    flags: [
      'FFlagDebugGraphicsPreferD3D11',
      'FFlagDebugGraphicsPreferVulkan',
      'FFlagDebugGraphicsPreferD3D11FL10'
    ],
    reason: 'Only one graphics backend can be preferred at a time.'
  }
];
