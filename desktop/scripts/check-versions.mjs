// Fails if the app version differs between package.json (the single source),
// tauri.conf.json, Cargo.toml and Cargo.lock. Optionally checks a release tag:
//   node scripts/check-versions.mjs desktop-v0.1.0
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const pkg = JSON.parse(read('package.json')).version;

// tauri.conf.json may hold a literal version or a path to package.json.
const confRaw = JSON.parse(read('src-tauri', 'tauri.conf.json')).version;
const conf = /package\.json$/.test(confRaw)
  ? JSON.parse(readFileSync(resolve(root, 'src-tauri', confRaw), 'utf8')).version
  : confRaw;

const cargoToml = read('src-tauri', 'Cargo.toml').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const crateName = read('src-tauri', 'Cargo.toml').match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = read('src-tauri', 'Cargo.lock').match(new RegExp(`name = "${crateName}"\\nversion = "([^"]+)"`))?.[1];

const found = { 'package.json': pkg, 'tauri.conf.json': conf, 'Cargo.toml': cargoToml, 'Cargo.lock': cargoLock };
let ok = true;
for (const [file, v] of Object.entries(found)) {
  const good = v === pkg;
  if (!good) ok = false;
  console.log(`${good ? 'ok  ' : 'FAIL'} ${file.padEnd(16)} ${v ?? '(not found)'}`);
}

const tag = process.argv[2];
if (tag) {
  const good = tag === `desktop-v${pkg}`;
  if (!good) ok = false;
  console.log(`${good ? 'ok  ' : 'FAIL'} tag ${tag} ${good ? 'matches' : `does not match desktop-v${pkg}`}`);
}
if (!ok) {
  console.error('\nVersion mismatch. Set the version in package.json, then update src-tauri/Cargo.toml and run `cargo update -p ' + crateName + '` (or `npm run version:set -- X.Y.Z`).');
  process.exit(1);
}
