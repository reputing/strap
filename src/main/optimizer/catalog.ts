import type { OptimizationAction } from '@shared/types';

/**
 * The optimization catalog.
 *
 * Every entry names its mechanism, states what it actually does, and says what
 * to expect — including when the answer is "nothing, on your hardware". None of
 * them claims a frame rate figure, because a figure that is not measured on the
 * user's machine is a guess dressed up as a fact. The benchmark suite in
 * Diagnostics exists so the user can measure instead.
 *
 * Presets are selections over this catalog, not separate lists, so an action
 * can never behave differently depending on which preset pulled it in.
 */
export const OPTIMIZATION_CATALOG: OptimizationAction[] = [
  // ── scheduler ─────────────────────────────────────────────────────────
  {
    id: 'scheduler.raise-fps-ceiling',
    title: 'Raise the frame rate ceiling',
    description:
      'Sets the client\'s frame rate target to 240 and disables the internal 240 cap, instead of leaving it at the default 60.',
    expectedEffect:
      'Frames are no longer held at 60. The actual rate is still bounded by your GPU, CPU and display refresh rate; on a machine that cannot exceed 60 this changes nothing.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'scheduler',
    flags: {
      DFIntTaskSchedulerTargetFps: '240',
      FFlagTaskSchedulerLimitTargetFpsTo2402: 'False'
    },
    presets: ['balanced', 'performance', 'low-end'],
    compatibility: 'Pair with your display\'s refresh rate. Uncapped frame rates raise power draw and heat on laptops.'
  },
  {
    id: 'scheduler.match-display',
    title: 'Match the frame rate target to the display',
    description: 'Sets the frame rate target to 144 rather than removing the ceiling entirely.',
    expectedEffect:
      'Smoother pacing than the 60 default without the extra heat and power draw of an uncapped client. Adjust the value under Custom if your display differs.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'scheduler',
    flags: { DFIntTaskSchedulerTargetFps: '144' },
    presets: ['conservative']
  },

  // ── rendering ─────────────────────────────────────────────────────────
  {
    id: 'render.prefer-d3d11',
    title: 'Prefer the Direct3D 11 renderer',
    description: 'Asks the client to select the Direct3D 11 graphics backend.',
    expectedEffect:
      'The most widely compatible backend on Windows. Useful when the automatic choice picks Vulkan on a driver that handles it poorly.',
    mechanism: 'fastflag',
    risk: 'low',
    reversible: true,
    category: 'rendering',
    flags: { FFlagDebugGraphicsPreferD3D11: 'True' },
    presets: ['balanced', 'performance'],
    compatibility: 'Only one backend preference can be active. Blossom will not apply two at once.'
  },
  {
    id: 'render.disable-post-effects',
    title: 'Disable post-processing',
    description: 'Turns off bloom, colour correction, depth of field and similar full-screen passes.',
    expectedEffect:
      'Removes several full-screen passes per frame. The effect is largest on GPUs limited by fill rate and in experiences that lean on these effects; it changes how the game looks.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'rendering',
    flags: { FFlagDisablePostFx: 'True' },
    presets: ['performance', 'low-end']
  },
  {
    id: 'render.disable-shadows',
    title: 'Remove dynamic shadows',
    description: 'Sets shadow intensity to zero and pauses the voxel lighting grid.',
    expectedEffect:
      'Removes shadow rendering and its per-frame update cost. Lighting becomes flat, which is a large visual change and a large saving in shadow-heavy experiences.',
    mechanism: 'fastflag',
    risk: 'low',
    reversible: true,
    category: 'rendering',
    flags: { FIntRenderShadowIntensity: '0', DFFlagDebugPauseVoxelizer: 'True' },
    presets: ['performance', 'low-end']
  },
  {
    id: 'render.disable-antialiasing',
    title: 'Turn off anti-aliasing',
    description: 'Forces the multisample level to zero.',
    expectedEffect: 'Less work per frame at the cost of jagged edges. Most noticeable at low resolutions.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'rendering',
    flags: { FIntDebugForceMSAASamples: '0' },
    presets: ['performance', 'low-end']
  },
  {
    id: 'render.remove-grass',
    title: 'Remove terrain grass',
    description: 'Sets both grass distances to zero.',
    expectedEffect:
      'Removes grass geometry and its animation. Only matters in experiences that use Roblox terrain grass; elsewhere it does nothing.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'rendering',
    flags: { FIntFRMMinGrassDistance: '0', FIntFRMMaxGrassDistance: '0' },
    presets: ['performance', 'low-end']
  },
  {
    id: 'render.pin-quality-low',
    title: 'Pin render quality to the lowest level',
    description: 'Overrides the automatic quality level, pinning it to 1.',
    expectedEffect:
      'Stops the client raising quality when it has headroom, keeping frame times consistent. Everything looks noticeably simpler.',
    mechanism: 'fastflag',
    risk: 'low',
    reversible: true,
    category: 'rendering',
    flags: { DFIntDebugFRMQualityLevelOverride: '1' },
    presets: ['low-end']
  },
  {
    id: 'render.flat-sky',
    title: 'Replace the sky with flat grey',
    description: 'Disables skybox rendering.',
    expectedEffect:
      'Removes the skybox pass and a common source of visual noise. Some players prefer this for target visibility; it makes most experiences look worse.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'rendering',
    flags: { FFlagDebugSkyGray: 'True' },
    presets: ['low-end']
  },

  // ── interface ─────────────────────────────────────────────────────────
  {
    id: 'ui.remove-menu-blur',
    title: 'Remove the menu blur',
    description: 'Sets the in-experience menu blur intensity to zero.',
    expectedEffect:
      'The Escape menu opens without a full-screen blur pass behind it, which makes it feel faster to open on weaker GPUs.',
    mechanism: 'fastflag',
    risk: 'safe',
    reversible: true,
    category: 'ui',
    flags: { FIntRobloxGuiBlurIntensity: '0' },
    presets: ['balanced', 'performance', 'low-end']
  },
  {
    id: 'ui.disable-ads',
    title: 'Stop the in-experience ad service',
    description: 'Turns off the client-side ad service.',
    expectedEffect: 'The ad service does not run locally. Experiences that do not use it are unaffected.',
    mechanism: 'fastflag',
    risk: 'low',
    reversible: true,
    category: 'ui',
    flags: { FFlagAdServiceEnabled: 'False' },
    presets: ['balanced', 'performance', 'low-end']
  },

  // ── memory ────────────────────────────────────────────────────────────
  {
    id: 'memory.trim-preloading',
    title: 'Trim asset preloading',
    description: 'Lowers the number of assets fetched in one preload batch to 100.',
    expectedEffect:
      'Spreads loading work out instead of front-loading it. Helps machines that stutter while joining; slightly longer until everything is visible.',
    mechanism: 'fastflag',
    risk: 'low',
    reversible: true,
    category: 'memory',
    flags: { DFIntNumAssetsMaxToPreload: '100' },
    presets: ['low-end']
  },
  {
    id: 'memory.larger-mesh-cache',
    title: 'Enlarge the mesh cache',
    description: 'Raises the mesh cache to 512 MB.',
    expectedEffect:
      'Fewer repeated mesh loads when moving around a large place, in exchange for memory. Only suitable on machines with RAM to spare.',
    mechanism: 'fastflag',
    risk: 'moderate',
    reversible: true,
    category: 'memory',
    flags: { DFIntDefaultMeshCacheSizeMB: '512' },
    presets: ['performance'],
    compatibility: 'Skipped automatically on machines with less than 12 GB of RAM.'
  },

  // ── process ───────────────────────────────────────────────────────────
  {
    id: 'process.above-normal-priority',
    title: 'Run the client at above-normal priority',
    description: 'Sets the Roblox process priority class to Above Normal after launch.',
    expectedEffect:
      'Windows schedules the client ahead of ordinary background work. Helps when something else on the machine is competing for CPU; does nothing on an otherwise idle system.',
    mechanism: 'process',
    risk: 'low',
    reversible: true,
    category: 'system',
    presets: ['performance'],
    compatibility: 'High priority is deliberately not offered as a preset: it can make the rest of Windows feel unresponsive.'
  },
  {
    id: 'process.texture-compositor-jobs',
    title: 'Parallelise texture compositing',
    description: 'Raises the number of concurrent texture compositing jobs to 4.',
    expectedEffect:
      'Character and clothing textures finish sooner on machines with spare cores. No benefit below four logical processors.',
    mechanism: 'fastflag',
    risk: 'moderate',
    reversible: true,
    category: 'memory',
    flags: { DFIntTextureCompositorActiveJobs: '4' },
    presets: ['performance'],
    compatibility: 'Skipped automatically on machines with fewer than four logical processors.'
  },

  // ── network ───────────────────────────────────────────────────────────
  {
    id: 'network.connection-cache',
    title: 'Keep more connections warm',
    description: 'Raises the client\'s HTTP connection cache size to 32.',
    expectedEffect:
      'Fewer new connections during asset-heavy loading. The effect depends heavily on your network path and may be nil.',
    mechanism: 'fastflag',
    risk: 'moderate',
    reversible: true,
    category: 'network',
    flags: { DFIntHttpCurlConnectionCacheSize: '32' },
    presets: ['performance']
  },

  // ── Blossom's own behaviour ───────────────────────────────────────────
  {
    id: 'blossom.trim-cache',
    title: 'Keep the asset cache inside its budget',
    description: 'Evicts least-recently-used cached assets once the cache passes the configured size.',
    expectedEffect: 'Blossom\'s own disk use stays bounded. Does not affect the client.',
    mechanism: 'blossom',
    risk: 'safe',
    reversible: true,
    category: 'system',
    presets: ['conservative', 'balanced', 'performance', 'low-end']
  }
];

const BY_ID = new Map(OPTIMIZATION_CATALOG.map((a) => [a.id, a]));

export function findAction(id: string): OptimizationAction | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Every flag any action in the catalog can write. Used by "Reset to Roblox
 * defaults" so it removes exactly what Blossom is capable of setting rather
 * than guessing at what Roblox's defaults are.
 */
export function allManagedFlags(): string[] {
  const names = new Set<string>();
  for (const action of OPTIMIZATION_CATALOG) {
    for (const name of Object.keys(action.flags ?? {})) names.add(name);
  }
  return [...names].sort();
}
