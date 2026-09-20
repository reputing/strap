import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Writes a file atomically: temp file in the same directory, fsync, rename.
 * A crash mid-write leaves either the old file or the new one, never a
 * half-written one. The previous contents are kept as `<file>.bak`.
 */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Keep one generation of backup so a corrupt parse is always recoverable.
  if (await exists(path)) {
    await fs.copyFile(path, `${path}.bak`).catch(() => undefined);
  }
  await fs.rename(tmp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses JSON. On a parse failure the file is moved aside rather than
 * deleted, so nothing the user wrote is ever silently destroyed.
 */
export async function readJsonSafe<T>(
  path: string,
  fallback: T,
  onCorrupt?: (movedTo: string, reason: string) => void
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const movedTo = `${path}.corrupt-${Date.now()}`;
    await fs.rename(path, movedTo).catch(() => undefined);
    onCorrupt?.(movedTo, e instanceof Error ? e.message : String(e));
    // Try the backup before giving up entirely.
    try {
      return JSON.parse(await fs.readFile(`${path}.bak`, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function dirSize(path: string): Promise<number> {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch { /* file vanished mid-walk; ignore */ }
      }
    }
  }
  return total;
}

/** Recursively lists files, returning paths relative to `root`. */
export async function listFilesRecursive(root: string, max = 20_000): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel);
      if (out.length >= max) break;
    }
  }
  return out;
}

export async function removeIfExists(path: string): Promise<boolean> {
  try {
    await fs.rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
