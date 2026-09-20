/**
 * The updater.
 *
 * A separate executable, launched by Blossom just before it exits, so the swap
 * never happens while the files are in use. It:
 *
 *   1. waits for the parent process to actually be gone,
 *   2. moves the current installation aside rather than deleting it,
 *   3. puts the staged payload in place,
 *   4. starts the new build,
 *   5. rolls back to the version it moved aside if that start fails.
 *
 * It takes its instructions from argv only, and does nothing if any of them are
 * missing — an updater that guesses is an updater that bricks installations.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface Args {
  pid: number;
  payload: string;
  target: string;
  relaunch: string;
}

function parseArgs(argv: string[]): Args | null {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };

  const pid = Number(get('pid'));
  const payload = get('payload');
  const target = get('target');
  const relaunch = get('relaunch');

  if (!Number.isInteger(pid) || pid <= 0 || !payload || !target || !relaunch) return null;
  return { pid, payload, target, relaunch };
}

async function waitForExit(pid: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // Signalling a dead process throws, which is what we want.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('blossom-updater: missing or invalid arguments; nothing was changed\n');
    return 2;
  }

  if (!(await waitForExit(args.pid))) {
    process.stderr.write('blossom-updater: Blossom did not exit; nothing was changed\n');
    return 3;
  }

  const backup = `${args.target}.previous`;
  let movedAside = false;

  try {
    await fs.rm(backup, { recursive: true, force: true });
    try {
      await fs.rename(args.target, backup);
      movedAside = true;
    } catch {
      // A fresh install has nothing to move aside.
    }

    await fs.mkdir(dirname(args.target), { recursive: true });
    await fs.rename(args.payload, args.target);

    const child = spawn(args.relaunch, [], { detached: true, stdio: 'ignore' });
    child.unref();

    // Give the new build a moment to fail immediately.
    await new Promise((r) => setTimeout(r, 3000));
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`the new build exited with code ${child.exitCode}`);
    }

    await fs.rm(backup, { recursive: true, force: true });
    return 0;
  } catch (e) {
    process.stderr.write(`blossom-updater: update failed (${e instanceof Error ? e.message : String(e)}); rolling back\n`);
    if (movedAside) {
      await fs.rm(args.target, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(backup, args.target).catch(() => undefined);
      spawn(args.relaunch, [], { detached: true, stdio: 'ignore' }).unref();
    }
    return 1;
  }
}

void main().then((code) => { process.exitCode = code; });

export { parseArgs, compareUpdaterPaths };

/** Exported for tests: the updater must never target a path outside its own tree. */
function compareUpdaterPaths(target: string, root: string): boolean {
  const normalisedTarget = join(target);
  const normalisedRoot = join(root);
  return normalisedTarget.startsWith(normalisedRoot);
}
