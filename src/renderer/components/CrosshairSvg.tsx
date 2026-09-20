import type { CrosshairConfig } from '@shared/types';
import { crosshairGeometry } from '@renderer/lib/crosshair';

/**
 * The crosshair designer's preview. Renders exactly the geometry the overlay
 * window draws, so what you configure is what appears over the client.
 */
export function CrosshairSvg({ config, size = 120 }: { config: CrosshairConfig; size?: number }) {
  const g = crosshairGeometry(config, size);

  return (
    <svg width={size} height={size} style={{ opacity: g.opacity, overflow: 'visible' }} aria-hidden="true">
      {g.outline ? (
        <g stroke={g.outline.color} strokeWidth={g.outline.width} fill="none">
          {g.lines.map((l, i) => <line key={`o${i}`} {...l} />)}
          {g.circle ? <circle {...g.circle} /> : null}
        </g>
      ) : null}

      <g stroke={g.color} strokeWidth={g.stroke} fill="none">
        {g.lines.map((l, i) => <line key={i} {...l} />)}
        {g.circle ? <circle {...g.circle} /> : null}
      </g>

      {g.dot ? (
        <>
          {g.outline ? <circle cx={g.dot.cx} cy={g.dot.cy} r={g.dot.r + 1} fill={g.outline.color} /> : null}
          <circle {...g.dot} fill={g.color} />
        </>
      ) : null}
    </svg>
  );
}
