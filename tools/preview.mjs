/**
 * Visual preview of the built renderer.
 *
 * Serves `out/renderer` over loopback and drives it with a stub of the IPC
 * bridge, so the screenshots show the shipped CSS and markup with
 * representative data. It exists because the interface is most of this
 * project's surface area, and "it compiles" says nothing about whether a
 * column collapsed or a control disappeared.
 *
 * Needs Playwright and a Chromium build, neither of which is a dependency of
 * the application:
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node tools/preview-fixtures.mjs /tmp/fixtures.json
 *   BLOSSOM_FIXTURES=/tmp/fixtures.json node tools/preview.mjs /tmp/shots
 */

import { chromium } from 'playwright';
import { join, extname } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Real catalogs, generated from the shipped source, so the preview shows the
// data the application actually has rather than invented rows.
const fixtures = JSON.parse(await readFile(process.env.BLOSSOM_FIXTURES, 'utf8'));

/**
 * Chromium refuses module scripts over file:// (Electron does not), so the
 * built output is served over loopback for the capture.
 */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = join(root, 'out/renderer', (req.url ?? '/').split('?')[0]);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const root = process.cwd();
const out = process.argv[2];

const now = Date.now();
const profile = {
  schemaVersion: 1, id: 'competitive', name: 'Competitive', description: 'Frame consistency over fidelity.',
  builtIn: false, createdAt: now - 86400000, updatedAt: now - 3600000,
  launcher: { kind: 'player', multiInstance: false, priority: 'above-normal', affinityMask: null, extraArgs: [], onExit: 'restore', hideOnLaunch: true },
  fastFlags: { DFIntTaskSchedulerTargetFps: '240', FFlagTaskSchedulerLimitTargetFpsTo2402: 'False', FFlagDisablePostFx: 'True', FIntRenderShadowIntensity: '0', FIntRobloxGuiBlurIntensity: '0' },
  optimizer: { preset: 'performance', overrides: {} },
  assets: { interception: true, assetProfileIds: ['set-1'], capture: true },
  overlay: {
    crosshair: { enabled: true, style: 'cross-dot', size: 12, thickness: 2, gap: 4, color: '#ff5fa2', opacity: 0.9, outline: true, outlineColor: '#000000', offsetX: 0, offsetY: 0 },
    hud: { enabled: true, corner: 'top-left', showFps: true, showCpu: true, showMemory: true, showUptime: true, showPing: false, opacity: 0.85, scale: 1 }
  },
  appearance: { accent: 'blossom', density: 'comfortable', reduceMotion: false }
};

const install = {
  kind: 'player', versionGuid: 'version-9f2c41ab77e0d3c5', clientVersion: '0.678.1.6780512',
  directory: 'C:\\Users\\user\\AppData\\Local\\Roblox\\Versions\\version-9f2c41ab77e0d3c5',
  executable: 'C:\\...\\RobloxPlayerBeta.exe', source: 'user', installedAt: now - 172800000
};

const responses = {
  'app:info': { version: '0.1.0', channel: 'stable', electron: '33.4.11', node: '20.18.3', chrome: '130.0.6723.191', platform: 'win32', portable: false },
  'app:settings:get': {
    schemaVersion: 1, activeProfileId: 'competitive',
    appearance: { accent: 'blossom', density: 'comfortable', reduceMotion: false },
    registerProtocolHandler: false, startWithWindows: false, startMinimised: false,
    closeToTray: true, confirmBeforeLaunch: false, logLevel: 'info',
    updates: { channel: 'stable', checkAutomatically: true, lastCheckedAt: now - 7200000 },
    interception: { enabled: true, port: 0, scope: ['assetdelivery.roblox.com','c0.rbxcdn.com','c1.rbxcdn.com','c2.rbxcdn.com','t0.rbxcdn.com','fts.rbxcdn.com'], cacheResponses: true, cacheBudgetBytes: 4294967296 },
    hotkeys: { enabled: false, bindings: { 'show-window': 'Alt+B', 'quick-launch': 'Alt+Shift+L', 'toggle-interception': 'Alt+Shift+I', 'toggle-capture': 'Alt+Shift+C', 'toggle-crosshair': 'Alt+Shift+X', 'toggle-hud': 'Alt+Shift+H' } },
    diagnostics: { includeHardware: true }
  },
  'roblox:state': {
    installations: [install, { ...install, kind: 'studio', clientVersion: null }],
    active: install, processes: [{ pid: 18244, kind: 'player', startedAt: now - 1926000, executable: null, ownedByBlossom: true }],
    latest: { channel: 'LIVE', clientVersion: '0.678.1.6780512', versionGuid: install.versionGuid },
    updateAvailable: false, scannedAt: now - 120000
  },
  'profiles:list': [
    { ...profile, id: 'default', name: 'Default', builtIn: true, description: 'Roblox exactly as it ships.', fastFlags: {}, optimizer: { preset: 'conservative', overrides: {} } },
    profile,
    { ...profile, id: 'low-end', name: 'Low End', builtIn: true, description: 'For limited RAM or an integrated GPU.', optimizer: { preset: 'low-end', overrides: {} } },
    { ...profile, id: 'recording', name: 'Recording', builtIn: true, description: 'Steady pacing and a clean screen.' }
  ],
  'interception:state': {
    status: 'running', port: 51473, detail: null, certificateInstalled: true, startedAt: now - 1926000,
    stats: { requests: 3412, intercepted: 2884, tunnelled: 528, replaced: 117, cacheHits: 1946, errors: 2, meanOverheadMs: 1.84, droppedCaptureEvents: 0 }
  },
  'cache:stats': {
    assetCount: 14238, blobCount: 11902, totalBytes: 2847362048, duplicateBytesSaved: 612483072,
    byType: { image: { count: 6120, bytes: 940000000 }, audio: { count: 2210, bytes: 1200000000 } },
    oldest: now - 1209600000, newest: now - 60000
  },
  'capture:state': { active: true, count: 2884, dropped: 0, source: 'proxy' },
  'optimizer:hardware': {
    cpu: { model: 'AMD Ryzen 7 5800X 8-Core Processor', cores: 8, threads: 16, speedMhz: 3800 },
    memory: { totalBytes: 34359738368, freeBytes: 18253611008 },
    gpu: [{ model: 'NVIDIA GeForce RTX 3070', vendor: 'NVIDIA', memoryBytes: null }],
    os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', build: '22631', arch: '64-bit' },
    tier: 'high', probedAt: now
  },
  'optimizer:recommend': { preset: 'performance', reason: '32 GB of RAM, 16 logical processors and a discrete GPU. Performance targets frame consistency.' },
  'optimizer:state': { preset: 'performance', appliedActionIds: ['scheduler.raise-fps-ceiling','render.disable-post-effects','render.disable-shadows'], appliedAt: now - 3600000, restorePointId: 'profile:competitive', hardware: null },
  'profiles:validate': { valid: true, issues: [] },
  'mods:list': [
    { relativePath: 'content\\sounds\\ouch.ogg', sizeBytes: 18422, applied: true, backedUp: true },
    { relativePath: 'content\\textures\\ui\\LuaApp\\icons\\ic-home.png', sizeBytes: 3120, applied: false, backedUp: false }
  ],
  'assets:sets': [
    { id: 'set-1', name: 'Low Texture', description: 'Flat replacement textures for visibility', enabled: true, order: 0, createdAt: now, updatedAt: now, ruleCount: 42 },
    { id: 'set-2', name: 'Custom Sounds', description: 'Personal sound pack', enabled: true, order: 1, createdAt: now, updatedAt: now, ruleCount: 17 },
    { id: 'set-3', name: 'Testing', description: '', enabled: false, order: 2, createdAt: now, updatedAt: now, ruleCount: 3 }
  ],
  'backups:list': [
    { id: 'p1', createdAt: now - 3600000, reason: 'Launch with "Competitive"', entries: [{ path: 'C:\\...\\ClientAppSettings.json', existed: false, sizeBytes: 0 }], restored: false },
    { id: 'p2', createdAt: now - 86400000, reason: 'Install the local asset CA into Roblox', entries: [{ path: 'C:\\...\\cacert.pem', existed: true, sizeBytes: 217334 }], restored: false }
  ],
  'updates:state': { phase: 'idle', progress: 0, version: null, error: null },
  'overlay:state': { crosshair: true, hud: true, attachedPid: 18244, supported: true, detail: null },
  'commands:list': [],
  'optimizer:catalog': null,
  'flags:catalog': null,
  'optimizer:plan': null,
  'flags:diff': null,
  'diagnostics:benchmarks': [],
  'cache:query': { items: [], total: 0, offset: 0, limit: 100 },
  'assets:rules': [],
  'capture:recent': [],
  'diagnostics:logs': [],
  'cache:duplicates': [],
  'interception:explain': null,
  'flags:validate': [],
  'assets:rule:test': { rule: null, setId: null, reason: 'No rule matched.' }
};

const browser = await chromium.launch({ executablePath: process.env.BLOSSOM_CHROMIUM || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 });

responses['optimizer:catalog'] = fixtures.optimizer;
responses['flags:catalog'] = fixtures.flags;
responses['optimizer:plan'] = fixtures.plan;
responses['flags:diff'] = Object.entries(profile.fastFlags).map(([name, value]) => {
  const def = fixtures.flags.find((f) => f.name === name) ?? null;
  return { name, kind: 'added', robloxDefault: def?.robloxDefault ?? null, blossomValue: value, definition: def };
});
responses['diagnostics:report'] = {
  generatedAt: now,
  blossom: { version: '0.1.0', channel: 'stable', electron: '33.4.11', node: '20.18.3', chrome: '130.0.6723.191' },
  system: { os: 'Windows_NT 10.0.22631', version: '10.0.22631', arch: 'x64', memoryBytes: 34359738368, cpu: 'AMD Ryzen 7 5800X (16 threads) / NVIDIA GeForce RTX 3070' },
  hardwareIncluded: true,
  roblox: { installations: [{ kind: 'player', version: '0.678.1.6780512', guid: install.versionGuid, path: 'C:\\Users\\%USER%\\AppData\\Local\\Roblox\\Versions\\' + install.versionGuid }], active: '0.678.1.6780512', running: 1, latestKnown: '0.678.1.6780512' },
  profile: { id: 'competitive', name: 'Competitive', valid: true, issues: 0 },
  modifications: { fastFlagCount: 5, optimizerPreset: 'performance', appliedActions: 3, modFileCount: 2, assetRuleCount: 59 },
  interception: { status: 'running', port: 51473, certificateInstalled: true },
  cache: { assets: 14238, bytes: 2847362048 },
  recentErrors: [],
  log: [
    '[13:47:28] INFO  roblox       Roblox detected  version=0.678.1.6780512',
    '[13:47:28] INFO  profiles     Profiles loaded  count=5 active=competitive',
    '[13:47:29] INFO  intercept    Asset interception started  port=51473 hosts=6',
    '[13:47:29] INFO  launcher     Roblox launched  pid=18244'
  ]
};
responses['interception:explain'] = {
  requiresElevation: false,
  changes: [
    { target: 'A local certificate in the Blossom Strap folder', description: 'Blossom generates a certificate authority stored only in your user profile. It is used to read asset requests and nothing else.', reversible: true },
    { target: 'C:\\...\\version-9f2c41ab77e0d3c5\\ssl\\cacert.pem', description: "That certificate is added to Roblox Player's own bundle, inside a marked block. Windows' certificate store is not touched.", reversible: true },
    { target: 'A loopback-only proxy on an automatic port', description: "The proxy listens on 127.0.0.1 and is reachable only by the Roblox process Blossom launches.", reversible: true }
  ]
};
responses['cache:query'] = {
  total: 14238, offset: 0, limit: 200,
  items: Array.from({ length: 200 }, (_, i) => ({
    assetId: String(100000000 + i * 7919),
    assetType: ['image','texture','mesh','audio','model','json'][i % 6],
    sourceUrl: 'https://c' + (i % 8) + '.rbxcdn.com/' + 'abcdef0123456789'.repeat(2),
    hash: (i.toString(16).padStart(2, '0')).repeat(32).slice(0, 64),
    sizeBytes: 2048 + ((i * 7717) % 4_000_000),
    firstSeen: now - 86400000 - i * 1000,
    lastSeen: now - i * 60000,
    hitCount: 1 + (i % 17),
    origin: i % 9 === 0 ? 'roblox-cache' : 'proxy',
    meta: { mime: 'image/png', width: 512, height: 512 }
  }))
};
responses['capture:recent'] = Array.from({ length: 60 }, (_, i) => ({
  at: now - i * 1400,
  assetId: String(5000000 + i * 131),
  assetType: ['texture','mesh','audio','image'][i % 4],
  url: 'https://c' + (i % 8) + '.rbxcdn.com/deadbeefcafe' + i,
  sizeBytes: 4096 + i * 311,
  outcome: i % 11 === 0 ? 'replaced' : i % 17 === 0 ? 'cache-hit' : 'passthrough',
  ruleId: i % 11 === 0 ? 'r1' : null,
  overheadMs: 0.8 + (i % 5) * 0.4
}));
responses['assets:rules'] = Array.from({ length: 12 }, (_, i) => ({
  id: 'r' + i, setId: 'set-1',
  source: String(200000000 + i * 977),
  action: ['replace-asset','replace-file','remove','replace-url'][i % 4],
  target: i % 4 === 1 ? 'C:\\textures\\flat.png' : i % 4 === 2 ? '' : i % 4 === 3 ? 'https://example.com/a.png' : String(300000000 + i),
  assetType: ['texture','image','mesh','audio'][i % 4],
  enabled: i % 5 !== 0, priority: (12 - i), notes: '', createdAt: now, updatedAt: now, hits: i * 13
}));
responses['diagnostics:logs'] = [
  { at: now - 5000, level: 'info', scope: 'roblox', message: 'Roblox detected', data: { version: '0.678.1.6780512' } },
  { at: now - 4000, level: 'info', scope: 'profiles', message: 'Profiles loaded', data: { count: 5, active: 'competitive' } },
  { at: now - 3000, level: 'info', scope: 'intercept', message: 'Asset interception started', data: { port: 51473, hosts: 6 } },
  { at: now - 2000, level: 'warn', scope: 'capture', message: 'Capture is running behind and is dropping the oldest events', data: { dropped: 1 } },
  { at: now - 1000, level: 'info', scope: 'launcher', message: 'Roblox launched', data: { pid: 18244 } }
];
responses['diagnostics:benchmarks'] = [
  { id: 'startup.time', name: 'Blossom startup', unit: 'ms', value: 282, samples: 1, detail: 'From process start to the main window being ready to show.', ranAt: now },
  { id: 'memory.resident', name: 'Blossom resident memory', unit: 'bytes', value: 96_468_992, samples: 1, detail: 'Resident set size of the main process.', ranAt: now },
  { id: 'asset.hash', name: 'Content hash (256 KB)', unit: 'ms', value: 0.612, samples: 24, detail: 'Mean SHA-256 time. This is the deduplication cost per captured asset.', ranAt: now },
  { id: 'asset.hit-rate', name: 'Cache hit rate', unit: 'ratio', value: 0.674, samples: 1, detail: 'Share of intercepted requests served from the local cache.', ranAt: now },
  { id: 'asset.overhead', name: 'Interception overhead', unit: 'ms', value: 1.84, samples: 1, detail: 'Mean milliseconds Blossom added to each intercepted request.', ranAt: now },
  { id: 'launch.time', name: 'Last Roblox launch', unit: 'ms', value: -1, samples: 0, detail: 'Roblox has not been launched through Blossom in this session.', ranAt: now }
];
responses['cache:duplicates'] = [];

await page.addInitScript(({ responses }) => {
  const listeners = new Map();
  const fire = (event, payload) => { for (const l of listeners.get(event) ?? []) l(payload); };
  window.__fire = fire;
  window.blossom = {
    async invoke(channel, params) {
      if (channel in responses) return { ok: true, value: responses[channel] };
      return { ok: false, error: { code: 'not-found', message: 'Not stubbed in this preview.' } };
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    }
  };
  // A live sample so the status bar and Home panel show real-looking figures.
  setInterval(() => {
    fire('roblox:sample', { pid: 18244, at: Date.now(), cpuPercent: 23.4, memoryBytes: 2415919104, uptimeMs: 1926000 });
  }, 400);
}, { responses });

page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}/index.html`);
await page.waitForSelector('.rail-item', { timeout: 15000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: join(out, 'home.png') });

for (const label of ['Optimizer', 'Profiles', 'Modifications', 'FastFlags', 'Assets', 'Cache', 'Appearance', 'Settings', 'Diagnostics', 'Launch']) {
  // Rail items carry badges, so the accessible name is not exactly the label.
  await page.locator('.rail-item', { hasText: label }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, `${label.toLowerCase()}.png`) });

  if (label === 'FastFlags') {
    await page.getByRole('button', { name: /^Catalog/ }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, 'fastflags-catalog.png') });
    await page.getByRole('button', { name: 'Diff' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, 'fastflags-diff.png') });
  }

  if (label === 'Cache' && process.env.BLOSSOM_MEASURE) {
    console.log('cache table:', JSON.stringify(await page.evaluate(() => {
      const row = document.querySelector('.vlist-row');
      const head = document.querySelector('.panel.flush > div');
      const box = (el) => el ? Math.round(el.getBoundingClientRect().width) : null;
      return {
        vlist: box(document.querySelector('.vlist')),
        inner: box(document.querySelector('.vlist-inner')),
        row: box(row),
        rowTemplate: row ? getComputedStyle(row).gridTemplateColumns : null,
        headTemplate: head ? getComputedStyle(head).gridTemplateColumns : null,
        firstCell: box(row?.firstElementChild),
        firstCellText: row?.firstElementChild?.textContent
      };
    })));
  }
}

// The command palette, opened the way a user would.
await page.keyboard.press('Control+Shift+KeyP');
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'palette.png') });

console.log('captured into', out);
await browser.close();
server.close();
