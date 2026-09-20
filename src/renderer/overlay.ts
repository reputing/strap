import type { CrosshairConfig, HudConfig, ProcessSample } from '@shared/types';
import { crosshairGeometry } from './lib/crosshair';

/**
 * The overlay windows.
 *
 * Written against the DOM directly, with no framework. Two transparent
 * click-through windows that draw a crosshair and a few live figures do not
 * justify shipping a renderer library into their bundle, and the whole point of
 * the overlay is that it costs nothing while a game is running.
 *
 * The bridge here is one-way: configuration and samples come in, nothing goes
 * back out. An overlay has no reason to be able to ask for anything.
 */

declare global {
  interface Window {
    blossomOverlay: {
      onConfig(listener: (payload: { kind: 'crosshair' | 'hud'; config: unknown }) => void): () => void;
      onSample(listener: (payload: unknown) => void): () => void;
    };
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const root = document.getElementById('overlay-root');
const kind = new URLSearchParams(window.location.search).get('overlay') ?? 'crosshair';

if (root) {
  if (kind === 'crosshair') startCrosshair(root);
  else startHud(root);
}

function startCrosshair(container: HTMLElement): void {
  container.style.display = 'grid';
  container.style.placeItems = 'center';
  container.style.height = '100vh';

  window.blossomOverlay.onConfig(({ kind: which, config }) => {
    if (which !== 'crosshair') return;
    container.replaceChildren();
    const settings = config as CrosshairConfig;
    if (!settings?.enabled) return;
    container.append(drawCrosshair(settings, 400));
  });
}

function drawCrosshair(config: CrosshairConfig, size: number): SVGSVGElement {
  const g = crosshairGeometry(config, size);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.style.opacity = String(g.opacity);
  svg.style.overflow = 'visible';

  const stroke = (width: number, color: string): SVGGElement => {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('stroke', color);
    group.setAttribute('stroke-width', String(width));
    group.setAttribute('fill', 'none');
    for (const line of g.lines) {
      const element = document.createElementNS(SVG_NS, 'line');
      element.setAttribute('x1', String(line.x1));
      element.setAttribute('y1', String(line.y1));
      element.setAttribute('x2', String(line.x2));
      element.setAttribute('y2', String(line.y2));
      group.append(element);
    }
    if (g.circle) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(g.circle.cx));
      circle.setAttribute('cy', String(g.circle.cy));
      circle.setAttribute('r', String(g.circle.r));
      group.append(circle);
    }
    return group;
  };

  // Outline first, so the coloured stroke sits on top of it.
  if (g.outline) svg.append(stroke(g.outline.width, g.outline.color));
  svg.append(stroke(g.stroke, g.color));

  if (g.dot) {
    if (g.outline) {
      const halo = document.createElementNS(SVG_NS, 'circle');
      halo.setAttribute('cx', String(g.dot.cx));
      halo.setAttribute('cy', String(g.dot.cy));
      halo.setAttribute('r', String(g.dot.r + 1));
      halo.setAttribute('fill', g.outline.color);
      svg.append(halo);
    }
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(g.dot.cx));
    dot.setAttribute('cy', String(g.dot.cy));
    dot.setAttribute('r', String(g.dot.r));
    dot.setAttribute('fill', g.color);
    svg.append(dot);
  }

  return svg;
}

function startHud(container: HTMLElement): void {
  let config: HudConfig | null = null;
  const values = new Map<string, HTMLElement>();
  let panel: HTMLElement | null = null;

  const build = (settings: HudConfig): void => {
    container.replaceChildren();
    values.clear();
    if (!settings.enabled) { panel = null; return; }

    const scale = settings.scale;
    panel = document.createElement('div');
    Object.assign(panel.style, {
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      fontSize: `${11 * scale}px`,
      lineHeight: '1.5',
      color: '#e9e7f2',
      background: `rgba(14, 13, 19, ${settings.opacity})`,
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '5px',
      padding: `${6 * scale}px ${9 * scale}px`,
      display: 'inline-grid',
      gridTemplateColumns: 'max-content max-content',
      columnGap: `${10 * scale}px`,
      fontVariantNumeric: 'tabular-nums',
      margin: '4px'
    } satisfies Partial<CSSStyleDeclaration>);

    const addRow = (key: string, label: string) => {
      const name = document.createElement('span');
      name.style.color = '#6a667a';
      name.textContent = label;
      const value = document.createElement('span');
      value.style.textAlign = 'right';
      value.textContent = '—';
      panel!.append(name, value);
      values.set(key, value);
    };

    if (settings.showCpu) addRow('cpu', 'CPU');
    if (settings.showMemory) addRow('memory', 'RAM');
    if (settings.showUptime) addRow('uptime', 'Uptime');
    // Frame rate and ping are intentionally never added. Both would require
    // reading state from inside the Roblox process, which Blossom does not do;
    // an empty row is more honest than an invented number.

    container.append(panel);
  };

  window.blossomOverlay.onConfig(({ kind: which, config: next }) => {
    if (which !== 'hud') return;
    config = next as HudConfig;
    build(config);
  });

  window.blossomOverlay.onSample((raw) => {
    if (!config?.enabled || !panel) return;
    const sample = raw as ProcessSample;

    const cpu = values.get('cpu');
    if (cpu) cpu.textContent = sample.cpuPercent === null ? '—' : `${sample.cpuPercent.toFixed(0)}%`;

    const memory = values.get('memory');
    if (memory) {
      memory.textContent = sample.memoryBytes === null ? '—' : `${(sample.memoryBytes / 1024 ** 3).toFixed(2)} GB`;
    }

    const uptime = values.get('uptime');
    if (uptime) uptime.textContent = formatUptime(sample.uptimeMs);
  });
}

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
