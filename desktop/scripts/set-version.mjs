// Sets the app version everywhere: node scripts/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v ?? '')) {
  console.error('Usage: node scripts/set-version.mjs X.Y.Z');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = v;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const tomlPath = join(root, 'src-tauri', 'Cargo.toml');
const toml = readFileSync(tomlPath, 'utf8').replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${v}$2`);
writeFileSync(tomlPath, toml);

const lockPath = join(root, 'src-tauri', 'Cargo.lock');
const name = toml.match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)[1];
const lock = readFileSync(lockPath, 'utf8').replace(new RegExp(`(name = "${name}"\\nversion = ")[^"]+(")`), `$1${v}$2`);
writeFileSync(lockPath, lock);

console.log(`Version set to ${v}. tauri.conf.json follows package.json.`);
