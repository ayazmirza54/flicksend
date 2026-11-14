// Compiles the portable server core with the host C++ compiler and runs its tests.
// Works on Linux/macOS (and Windows with MinGW/clang on PATH).
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build', 'native-tests');
mkdirSync(out, {recursive: true});
const isWin = process.platform === 'win32';
const exe = join(out, isWin ? 'core_host.exe' : 'core_host');
const cxx = process.env.CXX || 'c++';

const args = [
  '-std=c++17',
  '-O1',
  '-g',
  '-Wall',
  '-Wextra',
  join(root, 'native-tests', 'core_host.cpp'),
  join(root, 'windows', 'FlickSendDesktop', 'server', 'FlickServerCore.cpp'),
  '-o',
  exe,
  ...(isWin ? ['-lws2_32'] : ['-pthread']),
  ...(process.env.SANITIZE ? ['-fsanitize=address,undefined'] : []),
];
console.log(`> ${cxx} ${args.join(' ')}`);
execFileSync(cxx, args, {stdio: 'inherit'});
execFileSync(exe, ['--selftest'], {stdio: 'inherit'});
const r = spawnSync(process.execPath, ['--test', join(root, 'native-tests', 'server.test.mjs')], {
  stdio: 'inherit',
  env: {...process.env, CORE_HOST: exe},
});
process.exit(r.status ?? 1);
