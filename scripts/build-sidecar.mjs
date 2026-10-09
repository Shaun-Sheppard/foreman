// Compiles the agent host to a single executable named for the Rust target triple,
// which is how Tauri expects external binaries (sidecars) to be laid out.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const triple = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!triple) throw new Error('Could not read the host target triple from rustc');

const outDir = join(root, 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `foreman-agent-host-${triple}${process.platform === 'win32' ? '.exe' : ''}`);

execFileSync('npm', ['--prefix', join(root, 'agent-host'), 'install', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync('bun', ['build', '--compile', '--minify', join(root, 'agent-host', 'src', 'host.ts'), '--outfile', out], { stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`Agent host → ${out}`);
