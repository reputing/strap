// Bundles the real catalogs so the UI preview shows shipped data, not invented data.
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const result = await build({
  stdin: {
    contents: `
      export { OPTIMIZATION_CATALOG } from '@main/optimizer/catalog';
      export { FLAG_CATALOG } from '@main/fastflags/catalog';
      export { buildPlan } from '@main/optimizer/planner';
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true, format: 'esm', write: false, platform: 'node',
  alias: { '@main': join(process.cwd(), 'src/main'), '@shared': join(process.cwd(), 'src/shared') }
});

const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const plan = mod.buildPlan({
  preset: 'performance', overrides: {},
  hardware: { cpu: { model: 'x', cores: 8, threads: 16, speedMhz: 3800 }, memory: { totalBytes: 34359738368, freeBytes: 1 }, gpu: [], os: { name: 'w', version: '', build: null, arch: 'x64' }, tier: 'high', probedAt: Date.now() },
  install: null, currentFlags: {}, currentPriority: 'normal'
});

await writeFile(process.argv[2], JSON.stringify({
  optimizer: mod.OPTIMIZATION_CATALOG,
  flags: mod.FLAG_CATALOG,
  plan
}, null, 2));
console.log('optimizer actions:', mod.OPTIMIZATION_CATALOG.length, 'flags:', mod.FLAG_CATALOG.length, 'plan changes:', plan.changes.length);
