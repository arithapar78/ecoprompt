// Parity: the vendored optimizer must give byte-identical output to the
// extension's originals. Run: node desktop/test/parity.test.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const ORIG = join(here, '..', '..', 'extension', 'lib');
const VEND = join(here, '..', 'src', 'vendor', 'optimizer');
const FILES = ['prompt-rules-db.js', 'token-counter.js', 'prompt-optimizer.js', 'prompt-generator.js'];

function load(dir) {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(readFileSync(join(dir, f), 'utf8'), sandbox, { filename: f });
  return sandbox.window.EcoPromptOptimizer;
}
const orig = load(ORIG);
const vend = load(VEND);

const long = Array.from({ length: 700 }, (_, i) =>
  `Please could you kindly just basically explain item ${i} in order to help me understand it very much, thanks.`).join(' ');
assert.ok(long.split(/\s+/).length > 3000);

const PROMPTS = {
  empty: '',
  whitespace: '   \n  ',
  minimal: 'Sort list.',
  polite: 'Hi there! Could you please kindly help me write a short summary of this article? Thank you so much in advance!',
  fenced: 'Please just fix this:\n```js\nconst   a  =  1; // basically really\nfunction x() { return a }\n```\nThanks a lot!',
  url: 'Could you please summarize https://example.com/a/b?x=1&y=2 for me, if you don\'t mind?',
  email: 'I would like you to email bob.smith+test@example.co.uk and basically tell him the meeting is moved.',
  nonEnglish: 'Por favor, ¿podrías ayudarme a escribir un resumen? 你好，请帮我写一个摘要。 Merci beaucoup!',
  numbers: 'In order to calculate 12,345.67 * 8 please just show every single step in detail.',
  verbose: 'I was wondering if you could possibly help me out with something. I basically need you to, um, really just write me a function.',
  list: '- first, please do A\n- second, kindly do B\n- third, just do C',
  multiline: 'Line one is very important.\n\n\nLine two, actually, is also quite important.\n\tIndented line.',
  emoji: 'Hey 😀 can you please make this sound nicer 🙏 thanks!!!',
  quoted: 'Translate "I would really like a coffee, please" into French, if possible.',
  json: 'Please format this: {"name": "x", "value": 3} and just return it nicely.',
  long,
};

let n = 0;
for (const [name, text] of Object.entries(PROMPTS)) {
  const a = orig.getOptimizationStats(text);
  const b = vend.getOptimizationStats(text);
  assert.equal(b.optimized, a.optimized, `optimized differs for "${name}"`);
  assert.equal(JSON.stringify(b.stats), JSON.stringify(a.stats), `stats differ for "${name}"`);
  assert.equal(JSON.stringify(vend.calculateSavings(text, a.optimized)), JSON.stringify(orig.calculateSavings(text, a.optimized)));
  n++;
}
assert.ok(n >= 15, 'need at least 15 prompts');

// SYNC.json hashes match the vendored files.
const sync = JSON.parse(readFileSync(join(VEND, 'SYNC.json'), 'utf8'));
for (const f of FILES) {
  const h = createHash('sha256').update(readFileSync(join(VEND, f))).digest('hex');
  assert.equal(h, sync.sha256[f], `SYNC.json hash mismatch for ${f}`);
}

console.log(`parity OK: ${n} prompts byte-identical, ${FILES.length} hashes match SYNC.json`);
