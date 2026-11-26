// Privacy: optimizing a prompt must never write the prompt text to the logs.
// Captures every log line from engine.js, both via the console fallback and via
// the Tauri log-plugin path, and fails if the input (or a chunk of it) appears.
// Run: node desktop/test/log-privacy.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const VEND = join(here, '..', 'src', 'vendor', 'optimizer');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const f of ['prompt-rules-db.js', 'token-counter.js', 'prompt-optimizer.js', 'prompt-generator.js']) {
  vm.runInContext(readFileSync(join(VEND, f), 'utf8'), sandbox, { filename: f });
}

const say = console.log.bind(console); // real output, before we capture console below
const captured = [];
const levels = ['debug', 'info', 'warn', 'error', 'log'];
for (const l of levels) console[l] = (...args) => captured.push(args.map(String).join(' '));

globalThis.window = { EcoPromptOptimizer: sandbox.window.EcoPromptOptimizer };
const { optimize } = await import('../src/engine.js');

const PROMPTS = [
  'Could you please kindly review ZQXCANARY-7731 my private medical notes about Dr. Okafor and basically summarize them in order to help me?',
  'Hi! Email jane.doe+secret@example.com the password hunter2-ZQXCANARY and just tell her thanks a lot.',
  '```js\nconst apiKey = "sk-ZQXCANARY-0000";\n```\nPlease just fix this, thanks!',
];

function assertNoLeak(lines, label) {
  const joined = lines.join('\n');
  for (const prompt of PROMPTS) {
    assert.ok(!joined.includes(prompt), `${label}: full prompt leaked into logs`);
    for (let i = 0; i + 12 <= prompt.length; i += 4) {
      const chunk = prompt.slice(i, i + 12);
      assert.ok(!joined.includes(chunk), `${label}: prompt text leaked into logs: "${chunk}"`);
    }
  }
  assert.ok(!joined.includes('ZQXCANARY'), `${label}: canary leaked into logs`);
}

// 1. console fallback path (no Tauri present)
for (const p of PROMPTS) await optimize(p);
await assert.rejects(() => optimize(PROMPTS[0], { engine: 'nope' }), /Unknown optimizer engine/);
assert.ok(captured.length >= PROMPTS.length, 'expected optimize() to log something (test would be vacuous)');
assert.ok(captured.every((l) => l.startsWith('[engine]')), 'unexpected log line shape');
assertNoLeak(captured, 'console path');

// 2. Tauri log-plugin path
const forwarded = [];
globalThis.window.__TAURI__ = {
  log: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, async (m) => { forwarded.push(`${l}: ${m}`); }])),
};
captured.length = 0;
for (const p of PROMPTS) await optimize(p);
assert.ok(forwarded.length >= PROMPTS.length, 'optimize() did not forward to the Tauri logger');
assert.equal(captured.length, 0, 'should not also write to console when Tauri logger exists');
assertNoLeak(forwarded, 'tauri path');

// Lines carry only engine, timing and token counts.
assert.match(forwarded[0], /"engine":"rules".*"tokensSaved":\d+/);

say(`log privacy OK: ${PROMPTS.length} prompts x 2 paths, ${forwarded.length + PROMPTS.length * 2} log lines checked, no prompt text found`);
