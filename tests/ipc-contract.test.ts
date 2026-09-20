import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The IPC contract and its handlers are checked statically rather than by
 * importing them: `handlers.ts` pulls in Electron, which does not load outside
 * an Electron process. Static analysis still catches the failure that actually
 * happens — a channel added to the contract and never wired up, which the UI
 * would hit as "that action is not available in this version".
 */
const root = join(__dirname, '..');
const contract = readFileSync(join(root, 'src/shared/ipc.ts'), 'utf8');
const handlers = readFileSync(join(root, 'src/main/core/handlers.ts'), 'utf8');
const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8');

const declaredChannels = [...contract.matchAll(/^ {2}'([a-z:-]+)':\s*\{\s*params/gm)].map((m) => m[1]!);
const wiredChannels = new Set([...handlers.matchAll(/ipc\.handle\('([^']+)'/g)].map((m) => m[1]!));
const declaredEvents = [...contract.matchAll(/^ {2}'([a-z:-]+)':\s*(?!\{\s*params)/gm)].map((m) => m[1]!);

describe('IPC contract', () => {
  it('declares a meaningful number of channels', () => {
    expect(declaredChannels.length).toBeGreaterThan(50);
  });

  it('has a handler for every declared channel', () => {
    const missing = declaredChannels.filter((c) => !wiredChannels.has(c));
    expect(missing, `channels with no handler: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no handler for a channel the contract does not declare', () => {
    const declared = new Set(declaredChannels);
    const extra = [...wiredChannels].filter((c) => !declared.has(c));
    expect(extra, `handlers with no contract entry: ${extra.join(', ')}`).toEqual([]);
  });

  it('declares no duplicate channels', () => {
    expect(new Set(declaredChannels).size).toBe(declaredChannels.length);
  });

  it('declares push events for the state the UI has to track live', () => {
    for (const event of ['roblox:changed', 'launch:progress', 'capture:event', 'toast', 'navigate']) {
      expect(declaredEvents, `missing event ${event}`).toContain(event);
    }
  });
});

describe('preload surface', () => {
  it('exposes exactly two entry points and nothing else', () => {
    const exposed = [...preload.matchAll(/exposeInMainWorld\('([^']+)'/g)].map((m) => m[1]);
    expect(exposed.sort()).toEqual(['blossom', 'blossomOverlay']);
  });

  it('never exposes Node or Electron internals to the renderer', () => {
    for (const forbidden of ['require(', 'process.', '__dirname', 'child_process', 'node:fs']) {
      expect(preload.includes(forbidden), `preload references ${forbidden}`).toBe(false);
    }
  });

  it('gives the overlay a receive-only bridge', () => {
    const overlayBlock = preload.slice(preload.indexOf("'blossomOverlay'"));
    expect(overlayBlock).not.toContain('ipcRenderer.invoke');
    expect(overlayBlock).not.toContain('ipcRenderer.send');
  });
});

describe('renderer isolation', () => {
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8');

  it('creates every window sandboxed and context-isolated', () => {
    const overlay = readFileSync(join(root, 'src/main/overlay/overlay-service.ts'), 'utf8');
    for (const [name, source] of [['main window', main], ['overlay', overlay]] as const) {
      expect(source, `${name} enables nodeIntegration`).toContain('nodeIntegration: false');
      expect(source, `${name} disables contextIsolation`).toContain('contextIsolation: true');
      expect(source, `${name} is not sandboxed`).toContain('sandbox: true');
    }
  });

  it('refuses navigation and window opening from the renderer', () => {
    expect(main).toContain('setWindowOpenHandler');
    expect(main).toContain("will-navigate");
  });

  it('declares a content security policy in both HTML entries', () => {
    for (const file of ['src/renderer/index.html', 'src/renderer/overlay.html']) {
      const html = readFileSync(join(root, file), 'utf8');
      expect(html, `${file} has no CSP`).toContain('Content-Security-Policy');
      expect(html, `${file} allows remote scripts`).toContain("default-src 'none'");
    }
  });
});
