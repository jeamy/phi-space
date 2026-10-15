// Builds what the test bed ships to the server: the production bundle, the compiled examples and the compiled
// scenarios. No TypeScript source, tests or docs leave this machine. Same bundling as scripts/bundle-mobile.mjs
// (esm, node22, @earendil-works/* external), so the library under test is what the mobile runtime gets.
//   node test/testbed/build-artifacts.mjs <outDir>
// outDir: pi-spaces.mjs  examples/*.mjs  scenarios/*.mjs  package.json  package-lock.json  MANIFEST.json
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const out = resolve(process.argv[2] ?? '');
if (!process.argv[2] || out === root || !out.startsWith('/')) throw new Error('usage: build-artifacts.mjs <absolute outDir>');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['@earendil-works/*'], legalComments: 'none', logLevel: 'warning' };
const names = async (dir) => (await readdir(resolve(root, dir))).filter((n) => n.endsWith('.ts')).sort();

// 1. the library, exactly as the mobile runtime gets it
await build({ ...common, entryPoints: ['src/index.ts'], outfile: resolve(out, 'pi-spaces.mjs') });

// 2. the examples, self-contained like the ones in runtime/space-examples
const examples = await names('examples');
await build({ ...common, entryPoints: examples.map((n) => `examples/${n}`), outdir: resolve(out, 'examples'), outExtension: { '.js': '.mjs' } });

// 3. the scenarios use the shipped library instead of a second copy: every import of src/index.ts becomes ../pi-spaces.mjs
const sharedLibrary = {
	name: 'shared-library',
	setup(b) { b.onResolve({ filter: /(^|\/)src\/index\.ts$/ }, () => ({ path: '../pi-spaces.mjs', external: true })); },
};
// Examples have a "run when started directly" block (import.meta.url === argv[1]). Inlined into a scenario bundle that
// comparison would be true and start the example's CLI, so inside scenarios import.meta.url of an example is neutralised.
const inlinedExamples = {
	name: 'inlined-examples',
	setup(b) {
		b.onLoad({ filter: /\/examples\/[^/]+\.ts$/ }, async (args) => {
			const source = await readFile(args.path, 'utf8');
			return { contents: source.replaceAll('import.meta.url', JSON.stringify('file:///inlined-into-scenario')), loader: 'ts' };
		});
	},
};
const scenarios = await names('test/testbed/scenarios');
await build({ ...common, entryPoints: scenarios.map((n) => `test/testbed/scenarios/${n}`), outdir: resolve(out, 'scenarios'), outExtension: { '.js': '.mjs' }, plugins: [sharedLibrary, inlinedExamples] });

// Read-only space inspector, using the same shipped library as the scenarios.
await build({ ...common, entryPoints: ['test/testbed/inspect.ts'], outfile: resolve(out, 'tools/inspect.mjs'), plugins: [sharedLibrary] });

// Provisioned production-mode federation daemon, no TypeScript shipped.
await build({ ...common, entryPoints: ['test/testbed/federation-host.ts'], outfile: resolve(out, 'tools/federation-host.mjs'), plugins: [sharedLibrary] });

await build({ ...common, entryPoints: ['test/testbed/audit-native.ts'], outfile: resolve(out, 'tools/audit-native.mjs'), plugins: [sharedLibrary] });

await build({ ...common, entryPoints: ['test/testbed/audit-maintenance.ts'], outfile: resolve(out, 'tools/audit-maintenance.mjs'), plugins: [sharedLibrary] });

await build({ ...common, entryPoints: ['test/testbed/erase-compact.ts'], outfile: resolve(out, 'tools/erase-compact.mjs'), plugins: [sharedLibrary] });

// Administrative backup/data-recovery helper; requires an explicitly provisioned exclusive runtime.
await build({ ...common, entryPoints: ['test/testbed/recovery-data-host.ts'], outfile: resolve(out, 'tools/recovery-data-host.mjs'), plugins: [sharedLibrary] });

// Isolated independent recovery register, including bounded fresh-mTLS read batches.
await build({ ...common, entryPoints: ['test/testbed/recovery-register-host.ts'], outfile: resolve(out, 'tools/recovery-register-host.mjs'), plugins: [sharedLibrary] });

// Administrative component fault proxy; built artifact, no source shipped.
await build({ ...common, entryPoints: ['test/testbed/netbird/fault-proxy.mjs'], outfile: resolve(out, 'tools/fault-proxy.mjs') });

// 4. manifests for `npm ci --omit=dev` (versions come from the lock file)
await copyFile(resolve(root, 'package.json'), resolve(out, 'package.json'));
await copyFile(resolve(root, 'package-lock.json'), resolve(out, 'package-lock.json'));

// 5. what is in it, and from which commit
const files = [];
const walk = async (dir) => {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = resolve(dir, e.name);
		if (e.isDirectory()) await walk(p); else files.push(p);
	}
};
await walk(out);
const hashes = {};
for (const f of files.sort()) hashes[relative(out, f)] = createHash('sha256').update(await readFile(f)).digest('hex').slice(0, 16);
const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
const manifest = { builtAt: new Date().toISOString(), commit: git('rev-parse', '--short', 'HEAD') || null, dirty: git('status', '--porcelain') !== '', node: process.version, files: hashes };
await writeFile(resolve(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
const bad = Object.keys(hashes).filter((f) => /\.tsx?$/.test(f));
if (bad.length) throw new Error(`TypeScript source in the artifacts: ${bad.join(', ')}`);
console.log(`artifacts: ${Object.keys(hashes).length} files, commit ${manifest.commit ?? '?'}${manifest.dirty ? ' (uncommitted changes)' : ''}`);
