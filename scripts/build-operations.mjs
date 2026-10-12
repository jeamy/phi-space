// Standalone Node22 operator artifacts: no application dependencies, no source shipped to the register host.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const distImports = { name: 'source-of-built-imports', setup(b) { b.onResolve({ filter: /\.\.\/dist\/[^/]+\.js$/ }, args => ({ path: resolve(root, 'src', args.path.split('/').at(-1).replace(/\.js$/, '.ts')) })); } };
await build({ absWorkingDir: root, entryPoints: ['scripts/recovery-register.mjs', 'scripts/recovery-ssh.mjs', 'scripts/recovery-docker-ssh.mjs', 'scripts/fence-ssh.mjs', 'scripts/fence-docker-ssh.mjs', 'scripts/recovery-register-tls.mjs'], outdir: resolve(process.argv[2] || resolve(root, 'dist/operations')), outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node', target: 'node22', legalComments: 'none', plugins: [distImports] });
