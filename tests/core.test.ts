import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '@main/core/config-service';
import { defaultSettings } from '@main/core/defaults';
import { redact } from '@main/core/redact';
import { redactPath } from '@main/core/paths';
import { readJsonSafe, writeFileAtomic, writeJsonAtomic, hashBuffer } from '@main/core/fs-utils';
import { formatRecord, Logger } from '@main/core/logger';
import { BoundedQueue } from '@main/assets/bounded-queue';
import { splitRobloxCacheEntry } from '@main/assets/capture-service';
import { assetIdFromUrl, contentHashFromUrl, imageDimensions, isProbablyText, sniffAsset } from '@main/assets/asset-types';

const scratches: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'blossom-core-'));
  scratches.push(dir);
  return dir;
}
afterEach(async () => { for (const s of scratches.splice(0)) await rm(s, { recursive: true, force: true }); });

describe('settings migration', () => {
  it('fills in everything missing', () => {
    const settings = migrate({});
    expect(settings).toEqual(defaultSettings());
  });

  it('survives a file that is not an object', () => {
    for (const raw of [null, undefined, 'nope', 42]) {
      expect(migrate(raw as never).schemaVersion).toBe(1);
    }
  });

  it('keeps values it understands and deep-merges nested groups', () => {
    const settings = migrate({ closeToTray: false, updates: { channel: 'preview' } } as never);
    expect(settings.closeToTray).toBe(false);
    expect(settings.updates.channel).toBe('preview');
    // The rest of the updates group survives rather than being wiped.
    expect(settings.updates.checkAutomatically).toBe(true);
  });

  it('clamps nonsensical values instead of rejecting the file', () => {
    const settings = migrate({
      interception: { port: 999_999, cacheBudgetBytes: 1 },
      activeProfileId: ''
    } as never);
    expect(settings.interception.port).toBeLessThanOrEqual(65535);
    expect(settings.interception.cacheBudgetBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(settings.activeProfileId).toBe('default');
  });

  it('falls back to the safe host list when the scope is empty or wrong', () => {
    expect(migrate({ interception: { scope: [] } } as never).interception.scope.length).toBeGreaterThan(0);
    expect(migrate({ interception: { scope: 'nope' } } as never).interception.scope.length).toBeGreaterThan(0);
  });
});

describe('redaction', () => {
  it('removes a Roblox join ticket', () => {
    const line = 'launching roblox-player:1+launchmode:play+gameinfo:ABCDEF123456+browsertrackerid:99';
    const clean = redact(line);
    expect(clean).not.toContain('ABCDEF123456');
    expect(clean).toContain('%TICKET%');
    expect(clean).not.toContain('99');
  });

  it('removes an authentication cookie and bearer token', () => {
    expect(redact('.ROBLOSECURITY=_|WARNING|_abc123')).not.toContain('abc123');
    expect(redact('Authorization: Bearer sk-secret-value')).not.toContain('sk-secret-value');
  });

  it('replaces the user name in Windows and POSIX paths', () => {
    expect(redact('C:\\Users\\alice\\AppData\\Local\\Roblox')).toBe('C:\\Users\\%USER%\\AppData\\Local\\Roblox');
    expect(redactPath('/home/alice/.config/blossom')).toBe('/home/%USER%/.config/blossom');
    expect(redactPath('/Users/alice/Library')).toBe('/Users/%USER%/Library');
  });

  it('leaves text with nothing sensitive untouched', () => {
    expect(redact('Roblox detected version 0.678.1')).toBe('Roblox detected version 0.678.1');
  });

  it('handles empty input', () => {
    expect(redact('')).toBe('');
  });
});

describe('atomic writes', () => {
  it('keeps a backup of the previous contents', async () => {
    const dir = await scratch();
    const file = join(dir, 'config.json');
    await writeFileAtomic(file, 'first');
    await writeFileAtomic(file, 'second');

    expect(await readFile(file, 'utf8')).toBe('second');
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('first');
  });

  it('leaves no temporary files behind', async () => {
    const dir = await scratch();
    await writeJsonAtomic(join(dir, 'a.json'), { a: 1 });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('sets a corrupt file aside and recovers the previous generation', async () => {
    const dir = await scratch();
    const file = join(dir, 'config.json');
    await writeJsonAtomic(file, { generation: 1 });
    await writeJsonAtomic(file, { generation: 2 });
    // Something outside Blossom truncates the file.
    await writeFile(file, '{ this is not json');

    let movedTo: string | null = null;
    const value = await readJsonSafe<{ generation?: number }>(file, {}, (to) => { movedTo = to; });

    // The corrupt file is moved aside, never deleted, and the one retained
    // backup generation is what comes back.
    expect(movedTo).toBeTruthy();
    expect(await readFile(movedTo!, 'utf8')).toBe('{ this is not json');
    expect(value.generation).toBe(1);
  });

  it('returns the fallback when there is nothing to recover', async () => {
    const dir = await scratch();
    const value = await readJsonSafe(join(dir, 'missing.json'), { fallback: true });
    expect(value).toEqual({ fallback: true });
  });
});

describe('logging', () => {
  it('formats a record in the documented shape', () => {
    const line = formatRecord({ at: Date.parse('2026-01-01T12:43:02'), level: 'info', scope: 'roblox', message: 'Roblox detected' });
    expect(line).toMatch(/^\[\d\d:\d\d:\d\d] INFO {2}roblox {7}Roblox detected$/);
  });

  it('appends structured data as key=value pairs', () => {
    const line = formatRecord({ at: Date.now(), level: 'warn', scope: 'x', message: 'm', data: { count: 3, name: 'a b' } });
    expect(line).toContain('count=3');
    expect(line).toContain('name="a b"');
  });

  it('respects the minimum level', async () => {
    const dir = await scratch();
    const logger = new Logger({ directory: dir, level: 'warn' });
    logger.write('debug', 't', 'hidden');
    logger.write('error', 't', 'shown');
    expect(logger.recent().map((r) => r.message)).toEqual(['shown']);
    await logger.close();
  });

  it('redacts messages before they reach the ring buffer', async () => {
    const dir = await scratch();
    const logger = new Logger({ directory: dir, level: 'trace' });
    logger.write('info', 't', 'joining gameinfo:SECRETTICKET now');
    expect(logger.recent()[0]?.message).not.toContain('SECRETTICKET');
    await logger.close();
  });

  it('bounds the ring buffer', async () => {
    const dir = await scratch();
    const logger = new Logger({ directory: dir, level: 'trace' });
    for (let i = 0; i < 900; i++) logger.write('info', 't', `line ${i}`);
    expect(logger.recent(10_000).length).toBeLessThanOrEqual(500);
    await logger.close();
  });
});

describe('bounded queue', () => {
  it('processes everything pushed within capacity', async () => {
    const seen: number[] = [];
    const queue = new BoundedQueue<number>(10, async (n) => { seen.push(n); });
    for (let i = 0; i < 5; i++) queue.push(i);
    await queue.idle();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(queue.dropped).toBe(0);
  });

  it('drops the oldest item and reports it when full', async () => {
    const drops: number[] = [];
    const queue = new BoundedQueue<number>(
      2,
      () => new Promise((r) => setTimeout(r, 5)),
      (item) => drops.push(item)
    );
    for (let i = 0; i < 20; i++) queue.push(i);
    await queue.idle();
    expect(queue.dropped).toBeGreaterThan(0);
    expect(drops.length).toBe(queue.dropped);
  });

  it('keeps going after a worker throws', async () => {
    const seen: number[] = [];
    const queue = new BoundedQueue<number>(10, async (n) => {
      if (n === 1) throw new Error('bad item');
      seen.push(n);
    });
    queue.push(0); queue.push(1); queue.push(2);
    await queue.idle();
    expect(seen).toEqual([0, 2]);
    expect(queue.dropped).toBe(1);
  });
});

describe('asset type sniffing', () => {
  // Signature (8) + chunk length (4) + 'IHDR' (4) puts width at byte 16 and
  // height at byte 20, which is what imageDimensions reads.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(13, 0); return b; })(),
    Buffer.from('IHDR'),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(1024, 0); b.writeUInt32BE(512, 4); return b; })()
  ]);

  it('identifies formats from their magic bytes', () => {
    expect(sniffAsset(png).type).toBe('image');
    expect(sniffAsset(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime).toBe('image/jpeg');
    expect(sniffAsset(Buffer.from('OggS')).type).toBe('audio');
    expect(sniffAsset(Buffer.from([0xab, 0x4b, 0x54, 0x58])).type).toBe('texture');
    expect(sniffAsset(Buffer.from('<roblox!')).type).toBe('model');
    expect(sniffAsset(Buffer.from('version 2.00\n')).type).toBe('mesh');
  });

  it('separates WAV from WEBP inside a RIFF container', () => {
    const riff = (tag: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(tag)]);
    expect(sniffAsset(riff('WAVE')).type).toBe('audio');
    expect(sniffAsset(riff('WEBP')).type).toBe('image');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(sniffAsset(Buffer.from([0x01, 0x02, 0x00, 0x03, 0xff])).type).toBe('unknown');
    expect(sniffAsset(Buffer.alloc(0)).type).toBe('unknown');
  });

  it('recognises text-shaped payloads with lower confidence', () => {
    expect(sniffAsset(Buffer.from('{"a":1}')).type).toBe('json');
    expect(sniffAsset(Buffer.from('{"a":1}')).confidence).toBe('likely');
    expect(isProbablyText(Buffer.from('hello world'))).toBe(true);
    expect(isProbablyText(Buffer.from([0x00, 0x01]))).toBe(false);
  });

  it('reads image dimensions from the header', () => {
    expect(imageDimensions(png)).toEqual({ width: 1024, height: 512 });
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull();
  });
});

describe('URL parsing', () => {
  it('finds an asset id in the shapes the client uses', () => {
    expect(assetIdFromUrl('https://assetdelivery.roblox.com/v1/asset/?id=123456789')).toBe('123456789');
    expect(assetIdFromUrl('https://assetdelivery.roblox.com/v1/asset/987654321')).toBe('987654321');
    expect(assetIdFromUrl('https://c0.rbxcdn.com/abcdef')).toBeNull();
    expect(assetIdFromUrl('not a url at all')).toBeNull();
  });

  it('finds a CDN content hash', () => {
    expect(contentHashFromUrl('https://c0.rbxcdn.com/' + 'a'.repeat(32))).toBe('a'.repeat(32));
    expect(contentHashFromUrl('https://c0.rbxcdn.com/short')).toBeNull();
  });
});

describe('Roblox cache entries', () => {
  it('splits a legacy entry with a header', () => {
    const entry = Buffer.concat([
      Buffer.from('GET https://c0.rbxcdn.com/abc HTTP/1.1\r\n\r\n'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    ]);
    const { body, url } = splitRobloxCacheEntry(entry);
    expect(url).toBe('https://c0.rbxcdn.com/abc');
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('treats a stripped entry as pure payload', () => {
    const entry = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { body, url } = splitRobloxCacheEntry(entry);
    expect(url).toBeNull();
    expect(body).toEqual(entry);
  });
});

describe('content hashing', () => {
  it('produces a stable 64-character hash', () => {
    const hash = hashBuffer(Buffer.from('blossom'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBuffer(Buffer.from('blossom'))).toBe(hash);
    expect(hashBuffer(Buffer.from('blossom '))).not.toBe(hash);
  });
});

describe('scratch directories', () => {
  it('creates nested directories on demand', async () => {
    const dir = await scratch();
    const nested = join(dir, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    await writeFileAtomic(join(nested, 'f.txt'), 'x');
    expect(await readFile(join(nested, 'f.txt'), 'utf8')).toBe('x');
  });
});
