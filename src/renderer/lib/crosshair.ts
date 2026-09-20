import type { CrosshairConfig } from '@shared/types';

export interface Line { x1: number; y1: number; x2: number; y2: number }

export interface CrosshairGeometry {
  lines: Line[];
  dot: { cx: number; cy: number; r: number } | null;
  circle: { cx: number; cy: number; r: number } | null;
  stroke: number;
  color: string;
  outline: { width: number; color: string } | null;
  opacity: number;
}

/**
 * The crosshair's geometry, independent of how it is drawn.
 *
 * The designer preview renders it as React SVG; the overlay window renders it
 * as raw SVG DOM without React at all. Sharing the geometry rather than the
 * component is what lets the overlay stay a few kilobytes instead of shipping a
 * framework into a 400-pixel transparent window.
 */
export function crosshairGeometry(config: CrosshairConfig, size: number): CrosshairGeometry {
  const centre = size / 2;
  const arm = config.size;
  const gap = config.gap;
  const lines: Line[] = [];

  const hasArms = config.style === 'cross' || config.style === 'cross-dot' || config.style === 't-shape';
  if (hasArms) {
    lines.push({ x1: centre - gap - arm, y1: centre, x2: centre - gap, y2: centre });
    lines.push({ x1: centre + gap, y1: centre, x2: centre + gap + arm, y2: centre });
    // A T-shape omits the upper arm so it does not sit over what you are aiming at.
    if (config.style !== 't-shape') {
      lines.push({ x1: centre, y1: centre - gap - arm, x2: centre, y2: centre - gap });
    }
    lines.push({ x1: centre, y1: centre + gap, x2: centre, y2: centre + gap + arm });
  }

  const showDot = config.style === 'dot' || config.style === 'cross-dot';

  return {
    lines,
    dot: showDot ? { cx: centre, cy: centre, r: Math.max(0.5, config.thickness / 2) } : null,
    circle: config.style === 'circle' ? { cx: centre, cy: centre, r: arm } : null,
    stroke: config.thickness,
    color: config.color,
    outline: config.outline ? { width: config.thickness + 2, color: config.outlineColor } : null,
    opacity: config.opacity
  };
}
