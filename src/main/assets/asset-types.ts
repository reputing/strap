import type { AssetType } from '@shared/types';

/**
 * Roblox does not label what it serves, so the type of a captured asset has to
 * be inferred. We prefer content sniffing over the URL because CDN paths carry
 * no type information at all, and we return `unknown` rather than guessing.
 */

interface Signature {
  type: AssetType;
  /** Bytes that must appear at `offset`. */
  magic: number[];
  offset: number;
  mime: string;
}

const SIGNATURES: Signature[] = [
  { type: 'image', magic: [0x89, 0x50, 0x4e, 0x47], offset: 0, mime: 'image/png' },
  { type: 'image', magic: [0xff, 0xd8, 0xff], offset: 0, mime: 'image/jpeg' },
  { type: 'image', magic: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: 'image/gif' },
  { type: 'image', magic: [0x42, 0x4d], offset: 0, mime: 'image/bmp' },
  // WEBP is RIFF....WEBP; the inner tag is checked separately below.
  { type: 'audio', magic: [0x4f, 0x67, 0x67, 0x53], offset: 0, mime: 'audio/ogg' },
  { type: 'audio', magic: [0x49, 0x44, 0x33], offset: 0, mime: 'audio/mpeg' },
  { type: 'audio', magic: [0xff, 0xfb], offset: 0, mime: 'audio/mpeg' },
  { type: 'audio', magic: [0x66, 0x4c, 0x61, 0x43], offset: 0, mime: 'audio/flac' },
  // KTX is the container Roblox uses for compressed textures.
  { type: 'texture', magic: [0xab, 0x4b, 0x54, 0x58], offset: 0, mime: 'application/octet-stream' },
  { type: 'texture', magic: [0x44, 0x44, 0x53, 0x20], offset: 0, mime: 'image/vnd-ms.dds' },
  { type: 'font', magic: [0x00, 0x01, 0x00, 0x00], offset: 0, mime: 'font/ttf' },
  { type: 'font', magic: [0x4f, 0x54, 0x54, 0x4f], offset: 0, mime: 'font/otf' },
  { type: 'video', magic: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: 'video/mp4' }
];

const TEXT_PREFIXES: { prefix: string; type: AssetType; mime: string }[] = [
  { prefix: 'version 1.00', type: 'mesh', mime: 'application/x-roblox-mesh' },
  { prefix: 'version 2.00', type: 'mesh', mime: 'application/x-roblox-mesh' },
  { prefix: 'version 3.00', type: 'mesh', mime: 'application/x-roblox-mesh' },
  { prefix: 'version 4.00', type: 'mesh', mime: 'application/x-roblox-mesh' },
  { prefix: 'version 5.00', type: 'mesh', mime: 'application/x-roblox-mesh' },
  { prefix: '<roblox', type: 'model', mime: 'application/xml' }
];

export interface SniffResult {
  type: AssetType;
  mime: string;
  /** How sure we are. Used by the UI to mark a type as inferred. */
  confidence: 'certain' | 'likely' | 'guess';
}

/** Identifies an asset from the first bytes of its content. */
export function sniffAsset(head: Buffer): SniffResult {
  if (head.length === 0) return { type: 'unknown', mime: 'application/octet-stream', confidence: 'guess' };

  // Roblox's binary place/model format.
  if (head.length >= 8 && head.subarray(0, 8).toString('latin1') === '<roblox!') {
    return { type: 'model', mime: 'application/x-roblox-binary', confidence: 'certain' };
  }

  for (const sig of SIGNATURES) {
    if (head.length < sig.offset + sig.magic.length) continue;
    let match = true;
    for (let i = 0; i < sig.magic.length; i++) {
      if (head[sig.offset + i] !== sig.magic[i]) { match = false; break; }
    }
    if (match) return { type: sig.type, mime: sig.mime, confidence: 'certain' };
  }

  // RIFF containers: WAV and WEBP share the outer header.
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF') {
    const tag = head.subarray(8, 12).toString('latin1');
    if (tag === 'WAVE') return { type: 'audio', mime: 'audio/wav', confidence: 'certain' };
    if (tag === 'WEBP') return { type: 'image', mime: 'image/webp', confidence: 'certain' };
  }

  const text = head.subarray(0, 64).toString('latin1').toLowerCase();
  for (const { prefix, type, mime } of TEXT_PREFIXES) {
    if (text.startsWith(prefix)) return { type, mime, confidence: 'certain' };
  }

  const trimmed = head.subarray(0, 512).toString('utf8').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return { type: 'json', mime: 'application/json', confidence: 'likely' };
  }
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    return { type: 'text', mime: 'application/xml', confidence: 'likely' };
  }
  if (isProbablyText(head)) {
    return { type: 'text', mime: 'text/plain', confidence: 'likely' };
  }

  return { type: 'unknown', mime: 'application/octet-stream', confidence: 'guess' };
}

/** Heuristic: mostly printable ASCII with no NUL bytes. */
export function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 512);
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1;
  }
  return printable / sample.length > 0.9;
}

/**
 * Pulls a Roblox asset id out of a request URL. Handles the two shapes the
 * client uses: the asset delivery query parameter, and CDN paths whose final
 * segment is a content hash rather than an id.
 */
export function assetIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, 'https://assetdelivery.roblox.com');

    const id = parsed.searchParams.get('id') ?? parsed.searchParams.get('assetId');
    if (id && /^\d{1,20}$/.test(id)) return id;

    // .../asset/?id=123 and /v1/asset/123 style paths.
    const segments = parsed.pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg && /^\d{6,20}$/.test(seg)) return seg;
    }
    return null;
  } catch {
    return null;
  }
}

/** The CDN content hash a URL points at, when it has one. */
export function contentHashFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, 'https://c0.rbxcdn.com');
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last && /^[0-9a-f]{32}$/i.test(last) ? last.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function mimeForType(type: AssetType): string {
  switch (type) {
    case 'image': return 'image/png';
    case 'audio': return 'audio/ogg';
    case 'json': return 'application/json';
    case 'text': return 'text/plain';
    case 'video': return 'video/mp4';
    case 'font': return 'font/ttf';
    default: return 'application/octet-stream';
  }
}

/** Reads image dimensions from the header, where the format makes it cheap. */
export function imageDimensions(head: Buffer): { width: number; height: number } | null {
  // PNG: IHDR is always the first chunk.
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // GIF: little-endian logical screen descriptor.
  if (head.length >= 10 && head.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  // BMP: DIB header.
  if (head.length >= 26 && head[0] === 0x42 && head[1] === 0x4d) {
    return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) };
  }
  // JPEG: walk the segment chain to the first start-of-frame marker.
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) { offset += 1; continue; }
      const marker = head[offset + 1] ?? 0;
      const length = head.readUInt16BE(offset + 2);
      // SOF0..SOF3 and SOF5..SOF15, excluding the non-frame markers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
      }
      if (length <= 0) break;
      offset += 2 + length;
    }
  }
  return null;
}
