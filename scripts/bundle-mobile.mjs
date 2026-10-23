// Build the library and keep the sibling mobile runtime in sync without deploying hosts.
import { build } from 'esbuild';
import { readFile, readdir, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist/phi-spaces.mjs');
const localOnly = process.argv.includes('--local');
const mobileRoot = resolve(process.env.PHI_SPACES_MOBILE_ROOT || resolve(root, '../pi-termux-mobile'));
async function syncFile(target, bytes) {
  let prior;
  try { prior = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior?.equals(bytes)) return false;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try { await writeFile(temporary, bytes); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  return true;
}
let available = false;
try { available = !localOnly && (await stat(resolve(mobileRoot, 'runtime/package.json'))).isFile(); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!available && !localOnly && process.env.PHI_SPACES_MOBILE_ROOT) throw new Error(`Mobile runtime not found: ${mobileRoot}`);

await build({ absWorkingDir: root, entryPoints: ['agent/src/with-agent.ts'], outfile: output,
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  external: ['@earendil-works/*'], legalComments: 'none' });
if (!available) {
  console.log('Built dist/phi-spaces.mjs (no sibling mobile checkout).');
} else {
  const target = resolve(mobileRoot, 'runtime/phi-spaces.mjs');
  const bytes = await readFile(output);
  console.log(await syncFile(target, bytes) ? `Updated ${target}` : 'Mobile phi-spaces bundle is current.');
  // the examples of the library and of the agent package (the phone hosts both)
  const examples = [];
  for (const dir of ['examples', 'agent/examples']) for (const name of (await readdir(resolve(root, dir))).filter(n => n.endsWith('.ts')).sort()) examples.push(`${dir}/${name}`);
  const compiled = await build({ absWorkingDir: root, entryPoints: examples,
    outdir: resolve(root, 'dist/mobile-examples'), outExtension: { '.js': '.mjs' }, write: false,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['@earendil-works/*'], legalComments: 'none' });
  const targetDir = resolve(mobileRoot, 'runtime/space-examples');
  const manifestPath = resolve(targetDir, 'generated.json');
  let oldNames = [];
  try { oldNames = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const names = [];
  for (const file of compiled.outputFiles) {
    const name = file.path.split('/').at(-1);
    names.push(name);
    await syncFile(resolve(targetDir, name), Buffer.from(file.contents));
  }
  // Delete only files explicitly owned by the previous generated manifest.
  for (const name of oldNames) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.mjs$/.test(name)) throw new Error('Invalid generated example manifest');
    if (!names.includes(name)) await rm(resolve(targetDir, name), { force: true });
  }
  await syncFile(manifestPath, Buffer.from(JSON.stringify(names.sort(), null, 2) + '\n'));
  console.log(`Synchronized ${names.length} mobile space example modules.`);
}
