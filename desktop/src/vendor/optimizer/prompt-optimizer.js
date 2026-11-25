// lib/prompt-optimizer.js
// EcoPrompt prompt optimizer — browser-safe, no external deps.
//
// One mode. Every phrase and filler word in the lists gets deleted.
// Protected content (code, URLs, numbers, etc.) is never touched.
//
// Pipeline:
//   1. protect            — swap code/URLs/numbers/etc. to placeholders
//   2. wipePreamble       — erase the full greeting + opener clause
//   3. deletePhrases      — delete every matched verbose phrase
//   4. deleteFillers      — delete every matched filler word/phrase
//   5. deleteCompressionTargets — structural patterns (from rules-db)
//   6. cleanDebris        — remove grammatical leftovers
//   7. cleanupText        — fix spacing and punctuation
//   8. restore            — swap placeholders back
//
// Loaded after: prompt-rules-db.js — the single source of truth for
//               REMOVAL_PHRASES, REMOVAL_WORDS, COMPRESSION_RULES, GENERATOR_GUIDANCE.
//               This file keeps NO word lists of its own.
// Exposes:      window.EcoPromptOptimizer

'use strict';

// ── Energy/water/CO2 constants ─────────────────────────────────────────────────
const WH_PER_TOKEN         = 0.001;
const LITERS_WATER_PER_KWH = 1.8;
const G_CO2_PER_KWH        = 386;
const KWH_PER_WH           = 0.001;

// ── Placeholder format ─────────────────────────────────────────────────────────
const PH_OPEN  = '§P';
const PH_CLOSE = '§';
const PH_RE    = /§P(\d+)§/g;

// ── Protection patterns ────────────────────────────────────────────────────────
// Each is a factory () => RegExp — fresh instance every call, no stale lastIndex.
const PROTECTION_PATTERNS = [
  () => /```[\s\S]*?```|~~~[\s\S]*?~~~/g,                                          // fenced code
  () => /`[^`\n]+`/g,                                                               // inline code
  () => /https?:\/\/[^\s)>\]"',]+|ftp:\/\/[^\s)>\]"',]+/gi,                       // URLs
  () => /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,                     // email
  () => /\b(?:GPT-?[0-9][\w.-]*|Claude[-\s]?[0-9][\w.-]*|Gemini[\w.-]*|Grok[\w.-]*|DeepSeek[\w.-]*|Llama[\w.-]*|Mistral[\w.-]*|PaLM[\w.-]*|Cohere[\w.-]*)\b/gi, // model names
  () => /\$\d[\d,.]*/g,                                                             // dollar amounts
  () => /\b\d[\d,.]*\s*(?:x\s*\d[\d,.]*|DPI|dpi|px|em|rem|vh|vw|pt|cm|mm|in|ft|m|km|kg|g|lb|oz|ml|L|kWh|Wh|W|kW|MW|GW|ms|s|min|hr|hrs|MHz|GHz|TB|GB|MB|KB|°[CF]|%)\b/gi, // numbers+units
  () => /\b\d[\d,.]*\b/g,                                                           // bare numbers
  // Quoted strings: double quotes only. A single-quote pattern would treat the
  // apostrophes of two contractions ("doesn't … I'd") as an open/close pair and
  // freeze the whole span between them. Single-quoted spans are matched only
  // when both delimiters sit on non-letter boundaries.
  () => /"[^"\n]*"/g,                                                              // double-quoted strings
  () => /(^|[\s(])'[^'\n]*'(?=[\s).,!?;:]|$)/g,                                   // single-quoted strings
  () => /\{[^{}]*\}|\[[^\[\]]*\]/g,                                                // JSON
  () => /(?:^|\s)(\/[\w.\-]+(?:\/[\w.\-]+)+)/g,                                   // unix paths
  () => /[A-Za-z]:\\(?:[\w.\- ]+\\)*[\w.\- ]+/g,                                  // windows paths
  () => /(?:^\|.+\|[ \t]*$\n?)+/gm,                                               // markdown tables
  () => /\b\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}\b/g,                               // dates
];

function protect(text) {
  const segs = [];
  for (const factory of PROTECTION_PATTERNS) {
    text = text.replace(factory(), (m, ...args) => {
      const hasGroup = args.length > 1 && typeof args[0] === 'string' && args[0].trim() === '';
      const lead  = hasGroup ? args[0] : '';
      const match = hasGroup ? m.slice(lead.length) : m;
      segs.push(match);
      return lead + PH_OPEN + (segs.length - 1) + PH_CLOSE;
    });
  }
  return { text, segs };
}

function restore(text, segs) {
  return text.replace(PH_RE, (_, i) => segs[+i] ?? '');
}

function protectSensitiveSegments(text) {
  const { text: p, segs } = protect(text);
  return { protected: p, segments: segs };
}
function restoreSensitiveSegments(text, segments) {
  return restore(text, segments);
}

// ── Removal lists ──────────────────────────────────────────────────────────────
// Single source of truth: prompt-rules-db.js. This file owns no word lists.
// Every entry is deleted unconditionally; only protected segments survive.

const PHRASES_TO_DELETE = REMOVAL_PHRASES;
const FILLERS           = REMOVAL_WORDS;


// ── Preamble wipe ──────────────────────────────────────────────────────────────
// Erases the full greeting sentence + opener clause in one shot, before any
// word-by-word passes, so no debris ("that you could,") is left behind.

function wipePreamble(text) {
  // 1. Strip a leading greeting clause ("Hello there! ", "Hi, …").
  //    Bounded to a few words on one line: an unbounded [\s\S]*? would run to
  //    the first '.'/'!' anywhere in the prompt and swallow the real request
  //    ("Hey, can you write a poem about the ocean? It doesn't need to…").
  text = text.replace(
    /^(?:hello|hi|hey|hiya|howdy|greetings|good (?:morning|afternoon|evening|day)|dear (?:assistant|ai|sir|madam))\b[^.!?\n]{0,20}[,.!]\s*/i,
    ''
  );

  // 2. If the text still starts with an opener trigger, find the first real
  //    action verb and erase everything before it.
  const triggers = [
    "i was", "i am", "i'm", "i'd", "i would", "i need", "i want",
    "could you", "can you", "would you", "please", "i hope", "i just",
    "i really", "so i", "basically", "i have a question", "my question is",
    "quick question", "i wanted", "i was wondering", "i was hoping",
  ];
  const lc = text.toLowerCase();
  if (triggers.some(t => lc.startsWith(t))) {
    const m = text.match(
      /\b(write|explain|create|list|generate|describe|summarize|translate|fix|debug|review|analyze|compare|find|show|give|provide|make|build|draft|outline|convert|check|edit|improve|rewrite|suggest|calculate|define|identify|tell|summarize)\b/i
    );
    // Never slice across a protected placeholder — the preamble wipe would
    // silently delete a URL / code block / number that protect() had set aside.
    if (m && m.index > 0) {
      const head = text.slice(0, m.index);
      if (!/[.!?]/.test(head) && !PH_RE.test(head)) text = text.slice(m.index);
      PH_RE.lastIndex = 0; // /g regex — reset shared lastIndex
    }
  }

  return text;
}

// ── Debris cleanup ─────────────────────────────────────────────────────────────
// Removes grammatical leftovers after phrase deletion:
// "that you could,"  "you could,"  leading commas, "and", "but", etc.

function cleanDebris(text) {
  const patterns = [
    /^(that\s+(?:you|maybe|perhaps|possibly|it|we|they|he|she)\s+(?:could|would|might|can|should|will)[\s,]*)/i,
    /^(you\s+(?:could|would|might|can|should|will)[\s,]*)/i,
    /^((?:so\s+)?that[\s,]+)/i,
    /^(maybe[\s,]+)/i,
    /^(perhaps[\s,]+)/i,
    /^(if\s+(?:you|possible|it['']?s?\s+okay|that['']?s?\s+okay|you\s+don['']?t\s+mind)[\s,]*)/i,
    /^([,;]\s*)/,
    /^(and\s+)/i,
    /^(but\s+)/i,
    /^(or\s+)/i,
  ];
  let prev;
  do {
    prev = text;
    for (const re of patterns) text = text.replace(re, '');
    text = text.trim();
  } while (text !== prev);
  return text;
}

// ── Delete phrases ─────────────────────────────────────────────────────────────

function deletePhrases(text) {
  // Sort longest-first so longer matches win over sub-phrases
  const sorted = [...PHRASES_TO_DELETE].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp('(^|[\\s,;])' + esc + '(?=$|[\\s,.!?;:\\-])', 'gi');
    text = text.replace(re, (_, lead) => lead);
  }
  return text;
}

// ── Delete filler words ────────────────────────────────────────────────────────

// Pronoun/padding words that routinely appear contracted. Deleting the bare word
// out of "it's" would strand an orphan "'s", so these swallow the suffix too.
const CONTRACTIBLE = new Set(['i', 'it', 'we', 'they', 'you', 'that', 'there', 'he', 'she', 'who', 'what']);
const CONTRACTION_SUFFIX = "(?:'|’)(?:s|re|ll|d|m|ve|t)";

function deleteFillers(text) {
  const sorted = [...FILLERS].sort((a, b) => b.length - a.length);
  const multi  = sorted.filter(f => f.includes(' '));
  const single = sorted.filter(f => !f.includes(' '));

  for (const phrase of multi) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp('(^|[\\s])' + esc + '(?=$|[\\s,.!?;:])', 'gi');
    text = text.replace(re, (_, lead) => lead || ' ');
  }

  if (single.length) {
    const parts = single.map(f => {
      const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Contractible pronouns consume their contraction suffix so no "'s" is orphaned.
      return CONTRACTIBLE.has(f)
        ? '\\b' + esc + '(?:' + CONTRACTION_SUFFIX + ')?\\b'
        : '\\b' + esc + '\\b';
    });
    text = text.replace(new RegExp(parts.join('|'), 'gi'), ' ');
  }

  return text;
}

// ── Apply structural compression rules (from prompt-rules-db.js) ──────────────

function applyCompressionRules(text) {
  for (const rule of COMPRESSION_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  return text;
}

// ── Fix whitespace and punctuation ────────────────────────────────────────────

function cleanupText(text) {
  // Orphaned contraction suffixes left behind when a neighbouring word was
  // deleted ("it's" → " 's"). Swept independently of the contraction-aware
  // matcher so debris from any pass gets cleared.
  text = text.replace(/(^|\s)['’](?:s|t|re|ll|d|m|ve)\b/gi, '$1');

  // Punctuation debris left where words were deleted.
  text = text.replace(/\s+([,.!?;:])/g, '$1');            // " ," → ","
  text = text.replace(/([,.!?;:])(?!\.\.)([,.!?;:])+/g, '$1'); // ",." → ","
  text = text.replace(/([,;:])\s*$/gm, '');               // trailing comma on a line
  text = text.replace(/^\s*([-*+]|\d+[.)])\s*[,;:]+\s*/gm, '$1 '); // "- , foo" → "- foo"
  text = text.replace(/^\s*[,;:]+\s*/gm, '');             // line starting with punctuation
  text = text.replace(/^\s*[.!?]+\s*/gm, '');             // line starting with a stray stop
  text = text.replace(/(^|[.!?]\s+)[,;]\s*/g, '$1');

  // Whitespace normalisation — last, so earlier passes cannot reintroduce gaps.
  text = text.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Recapitalize sentence starts.
  text = text.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
  return text.trim();
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

function optimizePrompt(text) {
  const minChars = (GENERATOR_GUIDANCE && GENERATOR_GUIDANCE.minLengthToOptimize) || 5;

  if (!text || text.length < minChars) return (text || '').trim();

  const { text: safe, segs } = protect(text);        // 1. protect
  let out = wipePreamble(safe);                       // 2. wipe greeting + opener
  out = deletePhrases(out);                           // 3. delete verbose phrases
  out = applyCompressionRules(out);                   // 4. structural compression
  out = deleteFillers(out);                           // 5. delete filler words
  out = cleanDebris(out);                             // 6. remove leftover debris
  out = cleanupText(out);                             // 7. fix spacing/punctuation
  out = restore(out, segs);                           // 8. restore protected content

  // Words on the removal lists are deleted no matter what — there is no
  // "too much was removed" revert. The only guard is never returning nothing.
  if (!out.trim()) return text.trim();
  return out;
}

// ── Savings calculations ───────────────────────────────────────────────────────

function calculateSavings(original, optimized) {
  const words    = t => (t.trim().match(/\S+/g) || []).length;
  const origW    = words(original);
  const optW     = words(optimized);
  const removed  = Math.max(0, origW - optW);

  const origTok  = countTokens(original);
  const optTok   = countTokens(optimized);
  const tokSaved = Math.max(0, origTok - optTok);
  const pctOff   = origTok > 0 ? Math.round((tokSaved / origTok) * 100) : 0;

  const energyWh = tokSaved * WH_PER_TOKEN;
  const waterL   = energyWh * KWH_PER_WH * LITERS_WATER_PER_KWH;
  const co2g     = energyWh * KWH_PER_WH * G_CO2_PER_KWH;

  return {
    originalWords:    origW,
    optimizedWords:   optW,
    wordsRemoved:     removed,
    percentReduction: pctOff,
    originalTokens:   origTok,
    optimizedTokens:  optTok,
    tokensSaved:      tokSaved,
    energySavedWh:    energyWh,
    waterSavedLiters: waterL,
    co2SavedGrams:    co2g,
  };
}

function getOptimizationStats(text) {
  const optimized = optimizePrompt(text);
  const stats     = calculateSavings(text, optimized);
  return { optimized, stats };
}

// ── Expose API ─────────────────────────────────────────────────────────────────

window.EcoPromptOptimizer = {
  optimizePrompt,
  calculateSavings,
  getOptimizationStats,
  protectSensitiveSegments,
  restoreSensitiveSegments,
};
