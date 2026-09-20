import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir, readJsonSafe, writeJsonAtomic } from '@main/core/fs-utils';
import { nativeBindingPath } from './database';

interface ProbeRecord {
  /** The Node ABI of the runtime that ran the probe. */
  abi: string;
  electron: string;
  ok: boolean;
  checkedAt: number;
  detail: string;
}

/**
 * Checks that the native SQLite module is safe to use, in a child process.
 *
 * A native module built against a different Node ABI does not politely throw
 * when it is wrong. `require` succeeds, and the process dies the first time the
 * module is actually used — which is a hard crash with no stack, in the middle
 * of startup, that no try/catch can intercept.
 *
 * So the first use happens somewhere it cannot hurt: a short-lived child that
 * opens an in-memory database and exits. If it crashes, we learn that safely
 * and the asset index reports itself unavailable, which every caller already
 * handles. The answer is cached against the runtime's ABI, so this costs one
 * child process per Electron version rather than one per start.
 *
 * In a normal installation this always passes: `npm install` downloads the
 * binary built for Electron's ABI. It is the abnormal cases — a half-finished
 * update, a module restored from a backup, an install that could not reach the
 * download — that this turns from a crash into a message.
 */
export async function probeNativeSqlite(
  rootDirectory: string,
  log: ScopedLogger
): Promise<{ ok: boolean; detail: string }> {
  const markerPath = join(rootDirectory, 'native-check.json');
  const abi = process.versions.modules;
  const electron = process.versions['electron'] ?? 'none';

  const cached = await readJsonSafe<ProbeRecord | null>(markerPath, null);
  if (cached && cached.abi === abi && cached.electron === electron) {
    if (!cached.ok) log.warn('Skipping the asset index; a previous check found the native module unusable');
    return { ok: cached.ok, detail: cached.detail };
  }

  const result = runProbe();
  log[result.ok ? 'info' : 'error'](
    result.ok ? 'Native SQLite module verified' : 'The native SQLite module is not usable in this build',
    { abi, electron, detail: result.detail }
  );

  try {
    await ensureDir(rootDirectory);
    await writeJsonAtomic(markerPath, {
      abi, electron, ok: result.ok, checkedAt: Date.now(), detail: result.detail
    } satisfies ProbeRecord);
  } catch {
    // Not being able to cache the answer only costs us the next probe.
  }

  return result;
}

/**
 * Runs the check. `ELECTRON_RUN_AS_NODE` makes Electron behave as a plain Node
 * process, which is the only way to get a child with exactly the ABI the main
 * process has.
 */
function runProbe(): { ok: boolean; detail: string } {
  // Outside Electron the probe must open the same binary the storage layer
  // will, or it would test the one built for the other runtime's ABI.
  const binding = nativeBindingPath();
  const options = binding ? `, { nativeBinding: ${JSON.stringify(binding)} }` : '';
  const script = `
    try {
      const Database = require('better-sqlite3');
      const db = new Database(':memory:'${options});
      db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO probe (value) VALUES (?)').run('blossom');
      const row = db.prepare('SELECT value FROM probe').get();
      db.close();
      process.exit(row && row.value === 'blossom' ? 0 : 3);
    } catch (e) {
      process.stderr.write(String((e && e.message) || e));
      process.exit(2);
    }
  `;

  let child;
  try {
    child = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20_000,
      encoding: 'utf8',
      windowsHide: true
    });
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  if (child.status === 0) return { ok: true, detail: 'verified' };

  if (child.signal) {
    return {
      ok: false,
      detail: `The module crashed the probe process (${child.signal}). It was almost certainly built for a different Node version.`
    };
  }
  if (child.status === 2) {
    return { ok: false, detail: (child.stderr || '').trim().split('\n')[0] ?? 'the module failed to load' };
  }
  return { ok: false, detail: `The probe exited with code ${child.status}.` };
}
