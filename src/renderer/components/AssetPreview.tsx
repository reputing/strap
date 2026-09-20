import { useEffect, useRef, useState } from 'react';
import { call } from '@renderer/lib/api';
import { bytes, count } from '@renderer/lib/format';
import { Icon } from '@renderer/components/icons';
import { Badge, Button, Empty, Segmented } from '@renderer/components/ui';
import type { CachedAsset } from '@shared/types';

interface PreviewPayload {
  mime: string;
  dataUrl: string | null;
  text: string | null;
  meta: Record<string, string | number>;
}

/**
 * Asset preview.
 *
 * Previews are fetched on demand and released on navigation — holding decoded
 * assets in renderer memory is how a cache browser starts costing more than the
 * cache. Where a format cannot be previewed, the panel says so plainly instead
 * of showing a broken image.
 */
export function AssetPreview({ asset }: { asset: CachedAsset }) {
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'raw'>('auto');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPayload(null);

    void call('cache:preview', { assetId: asset.assetId, kind: mode }).then((r) => {
      if (cancelled) return;
      if (r.ok) setPayload(r.value);
      else setError(r.error.message);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [asset.assetId, mode]);

  if (loading) {
    return <div className="skeleton" style={{ height: 220, width: '100%' }} />;
  }
  if (error || !payload) {
    return <Empty icon={<Icon.warning size={20} />} title="No preview">{error ?? 'This asset has no cached content.'}</Empty>;
  }

  const kind = classify(asset, payload);

  return (
    <div className="col" style={{ gap: 'var(--s3)' }}>
      <div className="flex between">
        <div className="flex" style={{ gap: 'var(--s2)' }}>
          <Badge tone="accent">{asset.assetType}</Badge>
          <span className="micro dim mono">{payload.mime}</span>
          {payload.meta['confidence'] === 'guess' ? <Badge tone="warn">type inferred</Badge> : null}
        </div>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[{ value: 'auto', label: 'Preview' }, { value: 'raw', label: 'Raw' }]}
        />
      </div>

      {kind === 'image' ? <ImagePreview src={payload.dataUrl!} meta={payload.meta} /> : null}
      {kind === 'audio' ? <AudioPreview src={payload.dataUrl!} /> : null}
      {kind === 'mesh' ? <MeshPreview text={payload.text ?? ''} /> : null}
      {kind === 'text' ? <TextPreview text={payload.text ?? ''} /> : null}
      {kind === 'none' ? (
        <Empty icon={<Icon.file size={20} />} title="No viewer for this format">
          {payload.meta['previewSkipped'] === 'too-large'
            ? `This asset is ${bytes(asset.sizeBytes)}, which is larger than Blossom will decode into the interface. Export it to open it elsewhere.`
            : 'Blossom can index and replace this asset, but it has no viewer for this format. Export it to open it in another program.'}
        </Empty>
      ) : null}
    </div>
  );
}

function classify(asset: CachedAsset, payload: PreviewPayload): 'image' | 'audio' | 'mesh' | 'text' | 'none' {
  if (payload.text !== null) {
    return asset.assetType === 'mesh' ? 'mesh' : 'text';
  }
  if (!payload.dataUrl) return 'none';
  if (payload.mime.startsWith('image/')) return 'image';
  if (payload.mime.startsWith('audio/')) return 'audio';
  return 'none';
}

function ImagePreview({ src, meta }: { src: string; meta: Record<string, string | number> }) {
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [checker, setChecker] = useState(true);

  return (
    <>
      <div
        style={{
          height: 260,
          display: 'grid',
          placeItems: 'center',
          overflow: 'auto',
          borderRadius: 'var(--r)',
          border: '1px solid var(--line)',
          background: checker
            ? 'repeating-conic-gradient(#1c1b24 0% 25%, #16151d 0% 50%) 50% / 16px 16px'
            : 'var(--surface-input)'
        }}
      >
        <img
          src={src}
          alt=""
          style={
            zoom === 'fit'
              ? { maxWidth: '100%', maxHeight: 258, imageRendering: 'auto' }
              : { imageRendering: 'pixelated' }
          }
        />
      </div>
      <div className="flex between">
        <span className="micro dim num">
          {meta['width'] && meta['height'] ? `${meta['width']} × ${meta['height']}` : 'dimensions unknown'}
        </span>
        <div className="flex" style={{ gap: 'var(--s2)' }}>
          <Segmented value={zoom} onChange={setZoom} options={[{ value: 'fit', label: 'Fit' }, { value: 'actual', label: '1:1' }]} />
          <Button variant="ghost" onClick={() => setChecker((c) => !c)} title="Toggle transparency checkerboard">
            <Icon.grid size={13} />
          </Button>
        </div>
      </div>
    </>
  );
}

function AudioPreview({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState(0);

  return (
    <div className="panel" style={{ padding: 'var(--s5)' }}>
      <audio
        ref={ref}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
      />
      <div className="flex" style={{ gap: 'var(--s4)' }}>
        <Button
          variant="primary"
          size="icon"
          onClick={() => { const el = ref.current; if (!el) return; playing ? el.pause() : void el.play(); }}
        >
          {playing ? <Icon.pause size={13} /> : <Icon.play size={13} />}
        </Button>
        <input
          className="slider"
          style={{ flex: 1, width: 'auto' }}
          type="range"
          min={0}
          max={Number.isFinite(length) && length > 0 ? length : 1}
          step={0.01}
          value={position}
          aria-label="Seek"
          onChange={(e) => {
            const el = ref.current;
            if (el) { el.currentTime = Number(e.target.value); setPosition(Number(e.target.value)); }
          }}
        />
        <span className="micro dim num nowrap">
          {formatSeconds(position)} / {Number.isFinite(length) ? formatSeconds(length) : '—'}
        </span>
      </div>
    </div>
  );
}

/**
 * Roblox mesh viewer.
 *
 * Version 1.x meshes are plain text and can be parsed and drawn directly.
 * Binary meshes (2.0 and later) are not decoded here — rather than showing an
 * empty canvas, the panel says which format it found and what it can do with it.
 */
function MeshPreview({ text }: { text: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rotation, setRotation] = useState({ x: -0.4, y: 0.6 });
  const [zoom, setZoom] = useState(1);
  const [wireframe, setWireframe] = useState(true);
  const [grid, setGrid] = useState(true);
  const [spin, setSpin] = useState(false);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  const parsed = parseTextMesh(text);

  useEffect(() => {
    if (!spin) return;
    let frame = 0;
    const tick = () => {
      setRotation((r) => ({ ...r, y: r.y + 0.008 }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spin]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !parsed) return;
    drawMesh(canvas, parsed, rotation, zoom, wireframe, grid);
  }, [parsed, rotation, zoom, wireframe, grid]);

  if (!parsed) {
    return (
      <Empty icon={<Icon.cube size={20} />} title="Binary mesh">
        This is a binary Roblox mesh. Blossom indexes and replaces it, but only the text mesh format
        (version 1.x) can be drawn here. Export it to open it in a 3D program.
      </Empty>
    );
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        width={640}
        height={320}
        style={{
          width: '100%', height: 260, borderRadius: 'var(--r)',
          border: '1px solid var(--line)', background: 'var(--surface-input)',
          cursor: dragging.current ? 'grabbing' : 'grab'
        }}
        onMouseDown={(e) => { dragging.current = { x: e.clientX, y: e.clientY }; }}
        onMouseUp={() => { dragging.current = null; }}
        onMouseLeave={() => { dragging.current = null; }}
        onMouseMove={(e) => {
          const from = dragging.current;
          if (!from) return;
          setRotation((r) => ({ x: r.x + (e.clientY - from.y) * 0.01, y: r.y + (e.clientX - from.x) * 0.01 }));
          dragging.current = { x: e.clientX, y: e.clientY };
        }}
        onWheel={(e) => setZoom((z) => Math.max(0.2, Math.min(6, z * (e.deltaY > 0 ? 0.92 : 1.08))))}
      />
      <div className="flex between">
        <span className="micro dim num">{count(parsed.vertices.length / 3)} vertices · {count(parsed.faces.length / 3)} triangles</span>
        <div className="flex" style={{ gap: 'var(--s2)' }}>
          <Button variant="ghost" onClick={() => setWireframe((w) => !w)} title="Wireframe">
            <Icon.grid size={13} />
          </Button>
          <Button variant="ghost" onClick={() => setGrid((g) => !g)} title="Ground grid">
            <Icon.square size={13} />
          </Button>
          <Button variant="ghost" onClick={() => setSpin((s) => !s)} title="Auto rotate">
            <Icon.refresh size={13} />
          </Button>
          <Button variant="ghost" onClick={() => { setRotation({ x: -0.4, y: 0.6 }); setZoom(1); }} title="Reset camera">
            <Icon.crosshair size={13} />
          </Button>
        </div>
      </div>
    </>
  );
}

function TextPreview({ text }: { text: string }) {
  return (
    <pre
      className="mono selectable"
      style={{
        margin: 0, padding: 'var(--s4)', maxHeight: 280, overflow: 'auto',
        borderRadius: 'var(--r)', border: '1px solid var(--line)',
        background: 'var(--surface-input)', fontSize: 'var(--t-micro)',
        lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      }}
    >
      {text.slice(0, 40_000) || '(empty)'}
    </pre>
  );
}

interface Mesh {
  vertices: number[];
  faces: number[];
}

/**
 * Parses the version 1.x Roblox mesh format: a header line, a count, then
 * bracketed vertex/normal/uv triples, three per triangle.
 */
export function parseTextMesh(text: string): Mesh | null {
  if (!/^version 1\.\d\d/.test(text)) return null;

  const body = text.slice(text.indexOf('\n') + 1);
  const numbers = body.indexOf('[');
  if (numbers < 0) return null;

  const triples: number[][] = [];
  const pattern = /\[([-\d.eE+,\s]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const parts = match[1]!.split(',').map((n) => Number.parseFloat(n.trim()));
    if (parts.length === 3 && parts.every(Number.isFinite)) triples.push(parts);
    if (triples.length > 90_000) break; // A preview does not need a whole city.
  }

  // Groups of three: position, normal, uv. We only need positions.
  const vertices: number[] = [];
  for (let i = 0; i + 2 < triples.length; i += 3) {
    const position = triples[i]!;
    vertices.push(position[0]!, position[1]!, position[2]!);
  }
  if (vertices.length < 9) return null;

  const faces: number[] = [];
  for (let i = 0; i + 2 < vertices.length / 3; i += 3) faces.push(i, i + 1, i + 2);

  return { vertices, faces };
}

function drawMesh(
  canvas: HTMLCanvasElement,
  mesh: Mesh,
  rotation: { x: number; y: number },
  zoom: number,
  wireframe: boolean,
  grid: boolean
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  // Fit the model into the viewport from its bounding sphere.
  let cx = 0, cy = 0, cz = 0;
  const vertexCount = mesh.vertices.length / 3;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    cx += mesh.vertices[i]!; cy += mesh.vertices[i + 1]!; cz += mesh.vertices[i + 2]!;
  }
  cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;

  let radius = 0.0001;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const dx = mesh.vertices[i]! - cx, dy = mesh.vertices[i + 1]! - cy, dz = mesh.vertices[i + 2]! - cz;
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }

  const scale = (Math.min(width, height) * 0.38 * zoom) / radius;
  const sinX = Math.sin(rotation.x), cosX = Math.cos(rotation.x);
  const sinY = Math.sin(rotation.y), cosY = Math.cos(rotation.y);

  const project = (x: number, y: number, z: number): [number, number] => {
    const px = x - cx, py = y - cy, pz = z - cz;
    const x1 = px * cosY - pz * sinY;
    const z1 = px * sinY + pz * cosY;
    const y1 = py * cosX - z1 * sinX;
    return [width / 2 + x1 * scale, height / 2 - y1 * scale];
  };

  if (grid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const extent = radius * 1.4;
    const step = extent / 5;
    for (let i = -5; i <= 5; i++) {
      const offset = i * step;
      const [ax, ay] = project(cx - extent, cy - radius, cz + offset);
      const [bx, by] = project(cx + extent, cy - radius, cz + offset);
      const [ex, ey] = project(cx + offset, cy - radius, cz - extent);
      const [fx, fy] = project(cx + offset, cy - radius, cz + extent);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(fx, fy); ctx.stroke();
    }
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff6fa8';
  ctx.lineWidth = 1;

  // Painter's algorithm: sort triangles back to front so the solid fill reads.
  const triangles: { depth: number; points: [number, number][] }[] = [];
  for (let f = 0; f + 2 < mesh.faces.length; f += 3) {
    const points: [number, number][] = [];
    let depth = 0;
    for (let k = 0; k < 3; k++) {
      const index = mesh.faces[f + k]! * 3;
      const x = mesh.vertices[index]!, y = mesh.vertices[index + 1]!, z = mesh.vertices[index + 2]!;
      const px = x - cx, pz = z - cz;
      depth += px * sinY + pz * cosY;
      points.push(project(x, y, z));
    }
    triangles.push({ depth: depth / 3, points });
  }
  triangles.sort((a, b) => a.depth - b.depth);

  for (const triangle of triangles) {
    ctx.beginPath();
    ctx.moveTo(triangle.points[0]![0], triangle.points[0]![1]);
    ctx.lineTo(triangle.points[1]![0], triangle.points[1]![1]);
    ctx.lineTo(triangle.points[2]![0], triangle.points[2]![1]);
    ctx.closePath();
    if (!wireframe) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
    }
    ctx.strokeStyle = wireframe ? `${accent}55` : 'rgba(255,255,255,0.14)';
    ctx.stroke();
  }
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return '0:00';
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
