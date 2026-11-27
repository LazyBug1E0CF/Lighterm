import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
const version = pkg.version || '0.1.0';
const releaseDir = resolve(rootDir, 'target', 'release');
const setupName = `Lighterm-Setup-${version}-x64.exe`;
const setupPath = resolve(releaseDir, setupName);

function run(cmd, args, options = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: Boolean(options.shell),
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
}

run('pnpm', ['tauri', 'build', '--no-bundle'], { shell: process.platform === 'win32' });
run('cargo', ['build', '--release', '-p', 'lighterm-installer']);
run(resolve(releaseDir, 'pack-setup.exe'), [
  '--stub',
  resolve(releaseDir, 'lighterm-installer.exe'),
  '--app',
  resolve(releaseDir, 'lighterm.exe'),
  '--out',
  setupPath,
]);
run(setupPath, ['--verify-bundle']);

const hash = createHash('sha256').update(readFileSync(setupPath)).digest('hex');
const shaFile = `${setupPath}.sha256`;
writeFileSync(shaFile, `${hash}  ${setupName}\n`, 'utf8');

console.log(`\nBuilt ${setupPath}`);
console.log(`SHA-256: ${hash}`);
console.log(`Checksum written to ${shaFile}`);
