/**
 * Puts the better-sqlite3 binaries in place, without a C++ toolchain.
 *
 * better-sqlite3 is native, and Electron's Node ABI is not the ABI of the Node
 * that runs the tests. One of them would always be wrong, and the usual answer
 * — `electron-rebuild -f` — compiles from source, which on Windows means
 * installing Visual Studio and a Windows SDK to produce a binary the project
 * already publishes.
 *
 * So this downloads both published binaries instead, and keeps them apart:
 *
 *   build/Release/better_sqlite3.node       Electron's ABI — what the app and
 *                                           the installer use
 *   build/Release-node/better_sqlite3.node  this Node's ABI — what the tests
 *                                           use, via the `nativeBinding`
 *                                           option in src/main/storage/database.ts
 *
 * No compiler, on any platform. It never fails the install: if a binary is
 * missing or the machine is offline, the asset index reports itself
 * unavailable, which the storage layer already handles.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));

function resolveOptional(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function skip(reason) {
  console.log(`[native] ${reason}`);
  console.log('[native] The app still runs; the asset index will report itself unavailable.');
  process.exit(0);
}

// An optional dependency, so a machine that cannot install it still gets a
// working checkout.
const sqlitePackage = resolveOptional('better-sqlite3/package.json');
if (!sqlitePackage) skip('better-sqlite3 is not installed.');

const electronPackage = resolveOptional('electron/package.json');
if (!electronPackage) skip('Electron is not installed, so there is no ABI to target yet.');

const prebuildInstall = resolveOptional('prebuild-install/bin.js');
if (!prebuildInstall) skip('prebuild-install is missing from better-sqlite3.');

const moduleRoot = dirname(sqlitePackage);
const releaseBinary = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
const nodeBinary = join(moduleRoot, 'build', 'Release-node', 'better_sqlite3.node');

/** Downloads one published binary into build/Release. */
function fetchBinary(runtime, target) {
  const result = spawnSync(
    process.execPath,
    [
      prebuildInstall,
      `--runtime=${runtime}`,
      `--target=${target}`,
      `--arch=${process.arch}`,
      `--platform=${process.platform}`
    ],
    { cwd: moduleRoot, stdio: 'inherit' }
  );
  return result.status === 0 && existsSync(releaseBinary);
}

// The tests' copy first, because the second download overwrites build/Release.
if (fetchBinary('node', process.versions.node)) {
  mkdirSync(dirname(nodeBinary), { recursive: true });
  rmSync(nodeBinary, { force: true });
  renameSync(releaseBinary, nodeBinary);
} else {
  console.log(`[native] No published binary for Node ${process.versions.node}; the tests that use the asset index will not run.`);
}

const electronVersion = require(electronPackage).version;
if (fetchBinary('electron', electronVersion)) {
  console.log(`[native] better-sqlite3 is ready for Electron ${electronVersion}.`);
  process.exit(0);
}

console.log(`[native] No published better-sqlite3 binary for Electron ${electronVersion} on ${process.platform}-${process.arch}.`);
console.log('[native] The app still runs; the asset index will report itself unavailable.');
console.log('[native] With a C++ toolchain you can build one: npx @electron/rebuild -f -w better-sqlite3');
process.exit(0);
