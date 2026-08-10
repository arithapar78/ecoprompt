// extension/test/optimizer-test.js
// Proof harness for the prompt optimizer. Run with:  node extension/test/optimizer-test.js
//
// Loads the browser globals the way popup.html does (rules-db → token-counter →
// optimizer) inside a vm context, then asserts on real prompts.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Load the extension libs in popup.html's script order ─────────────────────

const LIB = path.join(__dirname, '..', 'lib');
const FILES = ['prompt-rules-db.js', 'token-counter.js', 'prompt-optimizer.js'];

const source = FILES.map(f => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n;\n')
  // Top-level `const` in a vm script stays in the script's lexical scope, so
  // hand the bindings we need out to the context explicitly.
  + '\n;globalThis.__exports = { REMOVAL_PHRASES, REMOVAL_WORDS, FILLER_WORDS, countTokens };';

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const { REMOVAL_PHRASES, REMOVAL_WORDS, countTokens } = sandbox.__exports;
const { optimizePrompt, protectSensitiveSegments } = sandbox.window.EcoPromptOptimizer;

// ── Tiny assertion helpers ───────────────────────────────────────────────────

let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
  return ok;
}

// ── Removal-list leakage check ───────────────────────────────────────────────
// Reuses the optimizer's own protection pass so we only scan unprotected prose.

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Entries that are legitimately reachable as substrings of surviving content
// (e.g. "a" inside a protected placeholder) are excluded by scanning the
// protected form, where code/URLs/numbers are already placeholders.
function survivingEntries(output) {
  const { protected: prose } = protectSensitiveSegments(output);
  const found = [];

  for (const phrase of REMOVAL_PHRASES) {
    const re = new RegExp('(^|[\\s,;])' + escapeRe(phrase) + '(?=$|[\\s,.!?;:\\-])', 'i');
    if (re.test(prose)) found.push(phrase);
  }
  for (const word of REMOVAL_WORDS) {
    const re = new RegExp('\\b' + escapeRe(word) + '\\b', 'i');
    if (re.test(prose)) found.push(word);
  }
  return found;
}

// ── Test prompts ─────────────────────────────────────────────────────────────

const CASES = [
  {
    name: 'Bug 1 regression — photosynthesis (was reverted to 0%)',
    input: "Hello there! I was hoping you could please write me a really detailed explanation of photosynthesis, it's for my school project. Thank you so much!",
    prose: true,
    mustContain: ['photosynthesis'],
    mustNotContain: ["'s", 'Hello', 'Thank you'],
  },
  {
    name: 'Bug 2 regression — two contractions (quote-protection freeze)',
    input: "Hey, can you write a poem about the ocean? It doesn't need to be long, but I'd love it if it rhymes.",
    prose: true,
    mustContain: ['poem', 'ocean', 'rhymes'],
    // The negation must survive — caveman rule: never flip meaning.
    mustContainRe: [/doesn'?t|does not/i],
  },
  {
    name: 'Fenced code block preserved byte-identical',
    input: "Hi! I was wondering if you could please help me debug this function, I'd really appreciate it:\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nThanks so much!",
    prose: true,
    verbatim: ['```js\nfunction add(a, b) {\n  return a + b;\n}\n```'],
  },
  {
    name: 'URL preserved byte-identical',
    input: 'Could you please take a look at https://example.com/docs/api?v=2 and summarize the authentication section for me? Thanks a lot!',
    prose: true,
    verbatim: ['https://example.com/docs/api?v=2'],
    mustContain: ['summarize'],
  },
  {
    name: 'Numbers and units preserved',
    input: 'I was just wondering if you could basically explain why the server uses 512 MB of RAM and runs at 3.2 GHz, it would be really helpful. Thank you!',
    prose: true,
    verbatim: ['512 MB', '3.2 GHz'],
  },
  {
    name: 'ALL-CAPS prompt',
    input: 'HELLO THERE! I WAS REALLY HOPING YOU COULD PLEASE WRITE A VERY DETAILED SUMMARY OF THE FRENCH REVOLUTION. THANK YOU SO MUCH!',
    prose: true,
    mustContainRe: [/FRENCH REVOLUTION/i],
  },
  {
    name: 'Multiline prompt with a list',
    input: [
      'Hi there, I hope you are doing well!',
      '',
      'I was hoping you could please help me with the following, if it is not too much trouble:',
      '- First of all, explain what a closure is in JavaScript',
      '- Secondly, show a really simple example',
      '- Last but not least, list some common pitfalls',
      '',
      'Thanks so much in advance, I really appreciate it!',
    ].join('\n'),
    prose: true,
    mustContain: ['closure', 'JavaScript', 'pitfalls'],
  },
  {
    name: 'Negations must survive',
    input: 'Please write a summary that does not include any spoilers and never mentions the ending. Only use information from chapter one. Thank you!',
    prose: true,
    mustContainRe: [/\bnot\b/i, /\bnever\b/i, /\bOnly\b/i],
  },
  {
    name: 'Email address and file path preserved',
    input: 'Hey! Could you kindly check the config at /etc/nginx/nginx.conf and email the results to admin@example.com? Thanks a bunch!',
    prose: true,
    verbatim: ['/etc/nginx/nginx.conf', 'admin@example.com'],
  },
  {
    name: 'Double-quoted string preserved',
    input: 'I was wondering if you could please explain what "premature optimization is the root of all evil" actually means. Thanks!',
    prose: true,
    verbatim: ['"premature optimization is the root of all evil"'],
  },
  {
    name: 'Heavy politeness wrapper',
    input: "Good morning! I hope this email finds you well. If it's not too much trouble, and whenever you get a chance, I would really appreciate it if you could kindly translate this sentence into Spanish. No rush at all. Best regards!",
    prose: true,
    mustContain: ['Spanish'],
  },
  {
    name: 'Inline code preserved',
    input: 'Quick question — could you basically explain what `Array.prototype.flatMap()` does? I would really appreciate it, thanks so much!',
    prose: true,
    verbatim: ['`Array.prototype.flatMap()`'],
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────

console.log('\nEcoPrompt optimizer — proof harness\n');

const rows = [];

for (const tc of CASES) {
  const output = optimizePrompt(tc.input);

  const inTok = countTokens(tc.input);
  const outTok = countTokens(output);
  const pct = inTok > 0 ? Math.round(((inTok - outTok) / inTok) * 100) : 0;

  console.log(`▸ ${tc.name}`);

  check(output.trim().length > 0, 'output is non-empty');

  if (tc.prose) {
    check(outTok < inTok, 'output tokens < input tokens', `in=${inTok} out=${outTok}`);
  }

  for (const frag of tc.verbatim || []) {
    check(output.includes(frag), `preserved byte-identical: ${JSON.stringify(frag.slice(0, 40))}`,
      `output: ${JSON.stringify(output)}`);
  }

  for (const frag of tc.mustContain || []) {
    check(output.includes(frag), `retains substance: ${JSON.stringify(frag)}`,
      `output: ${JSON.stringify(output)}`);
  }

  for (const re of tc.mustContainRe || []) {
    check(re.test(output), `retains substance: ${re}`, `output: ${JSON.stringify(output)}`);
  }

  for (const frag of tc.mustNotContain || []) {
    check(!output.includes(frag), `no debris: ${JSON.stringify(frag)}`,
      `output: ${JSON.stringify(output)}`);
  }

  // No removal-list entry may survive outside protected segments.
  const leaked = survivingEntries(output);
  check(leaked.length === 0, 'no removal-list entry survives in prose',
    leaked.length ? `leaked: ${JSON.stringify(leaked.slice(0, 8))}` : '');

  // Cosmetic debris gates.
  check(!/\s'(s|t|re|ll|d|m|ve)\b/.test(output), 'no orphaned contraction suffix',
    `output: ${JSON.stringify(output)}`);
  check(!/^[,;]/.test(output.trim()), 'no leading comma');

  // Double spaces are legitimate inside protected content (code indentation),
  // so this only inspects the unprotected prose.
  // Checked per line: a blank line is legitimate paragraph structure, and
  // joining lines with a space would read as a double space.
  const prose = protectSensitiveSegments(output).protected;
  const doubled = prose.split('\n').filter(l => /  /.test(l));
  check(doubled.length === 0, 'no double spaces in prose',
    doubled.length ? `lines: ${JSON.stringify(doubled)}` : '');
  check(!/,\s*$/.test(output.trim()), 'no trailing comma',
    `output: ${JSON.stringify(output)}`);

  console.log(`  in:  ${JSON.stringify(tc.input.slice(0, 110))}${tc.input.length > 110 ? '…' : ''}`);
  console.log(`  out: ${JSON.stringify(output)}`);
  console.log('');

  rows.push({ name: tc.name, inTok, outTok, saved: inTok - outTok, pct });
}

// ── Token table ──────────────────────────────────────────────────────────────

const nameW = Math.max(...rows.map(r => r.name.length), 4);
const line = `+${'-'.repeat(nameW + 2)}+-------+-------+-------+-------+`;

console.log(line);
console.log(`| ${'Case'.padEnd(nameW)} | ${'in'.padStart(5)} | ${'out'.padStart(5)} | ${'saved'.padStart(5)} | ${'%'.padStart(5)} |`);
console.log(line);
for (const r of rows) {
  console.log(
    `| ${r.name.padEnd(nameW)} | ${String(r.inTok).padStart(5)} | ${String(r.outTok).padStart(5)} | ` +
    `${String(r.saved).padStart(5)} | ${(r.pct + '%').padStart(5)} |`
  );
}
console.log(line);

const totIn = rows.reduce((a, r) => a + r.inTok, 0);
const totOut = rows.reduce((a, r) => a + r.outTok, 0);
console.log(`  totals: ${totIn} → ${totOut} tokens (${Math.round(((totIn - totOut) / totIn) * 100)}% reduction)\n`);

// ── List sanity ──────────────────────────────────────────────────────────────

console.log(`  removal lists: ${REMOVAL_PHRASES.length} phrases + ${REMOVAL_WORDS.length} words ` +
  `= ${REMOVAL_PHRASES.length + REMOVAL_WORDS.length} entries`);

const NEGATIONS = ['not', 'no', 'never', 'none', 'only', 'except', 'without',
  "don't", "won't", "can't", "isn't", "doesn't", 'cannot', 'nor', 'neither'];
const badEntries = REMOVAL_WORDS.filter(w => NEGATIONS.includes(w));
check(badEntries.length === 0, 'no standalone negation on REMOVAL_WORDS',
  badEntries.length ? JSON.stringify(badEntries) : '');

console.log('');

// ── Verdict ──────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`FAILED — ${failures} of ${checks} assertions failed\n`);
  process.exit(1);
}
console.log(`PASSED — all ${checks} assertions passed\n`);
