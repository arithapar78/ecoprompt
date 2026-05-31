// lib/prompt-optimizer.js
// Central optimizer module for EcoPrompt.
//
// Architecture:
//   1. protectSensitiveSegments()  — replace code/URLs/numbers/etc. with placeholders
//   2. applyPhraseReplacements()   — verbose-phrase → short-phrase map (level-aware)
//   3. applyFillerRemoval()        — remove filler words (level-aware word lists)
//   4. cleanupText()               — whitespace / punctuation repair
//   5. restoreSensitiveSegments()  — swap placeholders back
//
// Caveman-inspired rules (from research/caveman/caveman-activate.md):
//   - Drop articles, pleasantries, hedging when meaning survives
//   - Keep technical terms exact
//   - Keep code, URLs, numbers, paths unchanged
//   - Fragments OK in Aggressive level
//
// Depends on: prompt-rules-db.js (COMPRESSION_RULES, FILLER_WORDS, GENERATOR_GUIDANCE)
// Loaded before this file in popup.html.

'use strict';

// ── Energy / water / CO2 constants ────────────────────────────────────────────
// Average inference energy per token (Wh). Based on published estimates for
// mid-sized models (GPT-4 class): ~0.001 Wh per output token.
const WH_PER_TOKEN = 0.001;

// Data-center water usage effectiveness (WUE): ~1.8 L per kWh consumed.
// Source: Google/Microsoft sustainability reports (2023 average).
const LITERS_WATER_PER_KWH = 1.8;

// US average grid carbon intensity: 386 g CO2 per kWh.
const G_CO2_PER_KWH = 386;

// Wh → kWh conversion
const KWH_PER_WH = 0.001;

// ── Optimization levels ────────────────────────────────────────────────────────
// Each level adds progressively more aggressive rules.
//   light      — remove only the most obvious filler / politeness
//   balanced   — default; removes hedging, verbose openers, redundant phrases
//   aggressive — Caveman-style; maximum compression while preserving meaning
const LEVELS = { LIGHT: 'light', BALANCED: 'balanced', AGGRESSIVE: 'aggressive' };

// ── Protected segment placeholder format ──────────────────────────────────────
// We replace sensitive segments with ⟦P0⟧, ⟦P1⟧, … before optimization,
// then restore them afterward. Unicode brackets make accidental regex matches
// nearly impossible.
const PLACEHOLDER_PREFIX = '⟦P';
const PLACEHOLDER_SUFFIX = '⟧';

function makePlaceholder(index) {
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

// ── Regex patterns for protected segments ─────────────────────────────────────
// Order matters: longer / more-specific patterns first.
// Each entry is a factory function so we get a fresh RegExp instance per call,
// avoiding stale `lastIndex` state on stateful /g flag regexes.
const PROTECTION_PATTERNS = [
  // Fenced code blocks (``` or ~~~, optional language tag)
  { name: 'fenced-code',    re: () => /```[\s\S]*?```|~~~[\s\S]*?~~~/g },
  // Inline code (`...`)
  { name: 'inline-code',    re: () => /`[^`\n]+`/g },
  // URLs (http/https/ftp)
  { name: 'url',            re: () => /https?:\/\/[^\s)>\]"']+|ftp:\/\/[^\s)>\]"']+/gi },
  // Email addresses
  { name: 'email',          re: () => /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  // File paths (Unix and Windows)
  { name: 'filepath',       re: () => /(?:\/(?:[\w.\-]+\/)*[\w.\-]+)|(?:[A-Za-z]:\\(?:[\w.\- ]+\\)*[\w.\- ]+)/g },
  // Model names (GPT-4, Claude-3, Gemini, Grok, DeepSeek, Llama, Mistral …)
  { name: 'model-name',     re: () => /\b(?:GPT-?[34][\w.-]*|Claude[-\s]?\d[\w.-]*|Gemini[\w.-]*|Grok[\w.-]*|DeepSeek[\w.-]*|Llama[\w.-]*|Mistral[\w.-]*|PaLM[\w.-]*|Cohere[\w.-]*)\b/gi },
  // Numbers with units (12px, 300 DPI, 24x36, $50, 3.5%, 5kg, 10ms …)
  { name: 'num-unit',       re: () => /\b\d+(?:[.,]\d+)*\s*(?:x\s*\d+(?:[.,]\d+)*|DPI|dpi|px|em|rem|vh|vw|pt|cm|mm|in|ft|m|km|kg|g|lb|oz|ml|L|kWh|Wh|W|kW|MW|GW|ms|s|min|hr|hrs|MHz|GHz|TB|GB|MB|KB|°[CF]|%|USD|\$)\b/gi },
  // Plain numbers (preserve bare integers and decimals that could be counts/IDs)
  { name: 'number',         re: () => /\b\d+(?:[.,]\d+)*\b/g },
  // Dollar/currency amounts
  { name: 'currency',       re: () => /\$\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s*(?:dollars?|USD|EUR|GBP)/gi },
  // Quoted strings (double or single quotes)
  { name: 'quoted',         re: () => /"[^"]*"|'[^']*'/g },
  // JSON blobs
  { name: 'json',           re: () => /\{[\s\S]*?\}/g },
  // Markdown tables (line starting with |)
  { name: 'md-table',       re: () => /(?:^\|.+\|\s*$\n?)+/gm },
  // Date-like strings
  { name: 'date',           re: () => /\b\d{1,4}[-\/]\d{1,2}[-\/]\d{1,4}\b/g },
];

// ── Phrase replacement map ─────────────────────────────────────────────────────
// Applied before filler removal. Longer phrases first to avoid partial matches.
// Organized by Caveman categories from the task specification.
//
// Format: [verbosePhrase, replacement, minLevel]
//   minLevel = 'light' | 'balanced' | 'aggressive'
//   A replacement of '' means delete the phrase entirely.

const PHRASE_REPLACEMENTS = [
  // ── Wordy prepositions / conjunctions (all levels) ──────────────────────────
  ['in order to',                          'to',          'light'],
  ['so as to',                             'to',          'light'],
  ['in order for',                         'for',         'light'],
  ['prior to',                             'before',      'light'],
  ['subsequent to',                        'after',       'light'],
  ['at this point in time',               'now',          'light'],
  ['at the present time',                 'now',          'light'],
  ['currently right now',                 'now',          'light'],
  ['due to the fact that',                'because',      'light'],
  ['because of the fact that',            'because',      'light'],
  ['in light of the fact that',           'because',      'light'],
  ['owing to the fact that',              'because',      'light'],
  ['given the fact that',                 'given that',   'light'],
  ['in the event that',                   'if',           'light'],
  ['in the case that',                    'if',           'light'],
  ['in spite of the fact that',           'although',     'light'],
  ['despite the fact that',               'although',     'light'],
  ['with regard to',                      'about',        'light'],
  ['with respect to',                     'about',        'light'],
  ['in relation to',                      'about',        'light'],
  ['pertaining to',                       'about',        'light'],
  ['concerning the matter of',            'about',        'light'],
  ['with reference to',                   'about',        'light'],

  // ── Verbose quantity phrases ─────────────────────────────────────────────────
  ['a large number of',                   'many',         'light'],
  ['a wide variety of',                   'various',      'light'],
  ['a wide range of',                     'various',      'light'],
  ['a number of',                         'several',      'light'],
  ['a small number of',                   'a few',        'light'],

  // ── Filler meta-commentary (balanced+) ──────────────────────────────────────
  ['it is important to note that',        '',             'balanced'],
  ['it should be noted that',             '',             'balanced'],
  ['it is worth noting that',             '',             'balanced'],
  ['it is worth mentioning that',         '',             'balanced'],
  ['it goes without saying',             '',              'balanced'],
  ['needless to say',                     '',             'balanced'],
  ['as a matter of fact',                '',              'balanced'],
  ['the fact that',                       'that',         'balanced'],
  ['for what it\'s worth',               '',              'balanced'],
  ['to be honest',                        '',             'balanced'],
  ['to be fair',                          '',             'balanced'],
  ['to tell the truth',                   '',             'balanced'],
  ['truth be told',                       '',             'balanced'],
  ['in all honesty',                      '',             'balanced'],
  ['with that being said',               '',              'balanced'],
  ['that being said',                     '',             'balanced'],
  ['having said that',                    '',             'balanced'],

  // ── Request/instruction openers to trim (balanced+) ─────────────────────────
  ['i would like you to',                 '',             'balanced'],
  ['i\'d like you to',                    '',             'balanced'],
  ['i need you to',                       '',             'balanced'],
  ['i want you to',                       '',             'balanced'],
  ['can you help me',                     '',             'balanced'],
  ['could you help me',                   '',             'balanced'],
  ['would you help me',                   '',             'balanced'],
  ['please help me',                      '',             'balanced'],
  ['help me with',                        '',             'balanced'],
  ['help me',                             '',             'balanced'],
  ['assist me with',                      '',             'balanced'],
  ['make sure to',                        '',             'balanced'],
  ['be sure to',                          '',             'balanced'],
  ['don\'t forget to',                    '',             'balanced'],
  ['do not forget to',                    '',             'balanced'],
  ['ensure that',                         '',             'balanced'],
  ['please ensure that',                  '',             'balanced'],
  ['write me a',                          'write a',      'balanced'],
  ['create me a',                         'create a',     'balanced'],
  ['give me a',                           'give a',       'balanced'],
  ['provide me with',                     'provide',      'balanced'],
  ['explain to me',                       'explain',      'balanced'],
  ['tell me about',                       'explain',      'balanced'],
  ['give me information about',           'explain',      'balanced'],
  ['provide information about',           'explain',      'balanced'],
  ['give me details about',               'explain',      'balanced'],

  // ── Verbose adjective clusters (balanced+) ───────────────────────────────────
  ['a really detailed explanation',       'a detailed explanation', 'balanced'],
  ['very detailed and thorough',          'detailed',     'balanced'],
  ['detailed and comprehensive',          'detailed',     'balanced'],
  ['comprehensive and detailed',          'detailed',     'balanced'],
  ['clear and easy to understand',        'clear',        'balanced'],
  ['educational and engaging',            'engaging',     'balanced'],

  // ── Tautological pairs (balanced+) ──────────────────────────────────────────
  ['each and every',                      'every',        'balanced'],
  ['any and all',                         'all',          'balanced'],
  ['null and void',                       'void',         'balanced'],
  ['full and complete',                   'complete',     'balanced'],
  ['true and accurate',                   'accurate',     'balanced'],
  ['past history',                        'history',      'balanced'],
  ['future plans',                        'plans',        'balanced'],
  ['final outcome',                       'outcome',      'balanced'],
  ['end result',                          'result',       'balanced'],
  ['free gift',                           'gift',         'balanced'],
  ['added bonus',                         'bonus',        'balanced'],
  ['advance planning',                    'planning',     'balanced'],
  ['completely eliminate',                'eliminate',    'balanced'],
  ['totally remove',                      'remove',       'balanced'],
  ['exactly identical',                   'identical',    'balanced'],
  ['close proximity',                     'proximity',    'balanced'],
  ['general consensus',                   'consensus',    'balanced'],
  ['repeat again',                        'repeat',       'balanced'],
  ['return back',                         'return',       'balanced'],
  ['revert back',                         'revert',       'balanced'],
  ['combine together',                    'combine',      'balanced'],
  ['join together',                       'join',         'balanced'],
  ['merge together',                      'merge',        'balanced'],

  // ── Verbose transitions (aggressive) ────────────────────────────────────────
  ['in addition to that',                 'also',         'aggressive'],
  ['on top of that',                      'also',         'aggressive'],
  ['as you can see',                      '',             'aggressive'],
  ['as mentioned',                        '',             'aggressive'],
  ['as previously stated',               '',              'aggressive'],
  ['as stated earlier',                   '',             'aggressive'],
  ['in other words',                      '',             'aggressive'],
  ['to put it simply',                    '',             'aggressive'],
  ['simply put',                          '',             'aggressive'],
  ['in short',                            '',             'aggressive'],
  ['long story short',                    '',             'aggressive'],
  ['to make a long story short',         '',              'aggressive'],
  ['moving forward',                      '',             'aggressive'],
  ['going forward',                       '',             'aggressive'],
  ['from the standpoint of',             'from',          'aggressive'],
  ['from the perspective of',            'from',          'aggressive'],
  ['in the context of',                   'in',           'aggressive'],

  // ── AI-prompt fluff (aggressive) ────────────────────────────────────────────
  ['step by step',                        '',             'aggressive'],
  ['step-by-step',                        '',             'aggressive'],
  ['go step by step',                     '',             'aggressive'],
  ['walk me through',                     'explain',      'aggressive'],
  ['break it down',                       'explain',      'aggressive'],
  ['explain like i\'m five',             'explain simply','aggressive'],
  ['explain like i am five',             'explain simply','aggressive'],
  ['make it better',                      'improve',      'aggressive'],
  ['make it easy to understand',         'make it clear', 'aggressive'],
  ['best possible',                       '',             'aggressive'],
  ['high quality',                        '',             'aggressive'],
  ['top quality',                         '',             'aggressive'],
];

// ── Filler word lists, organized by level ─────────────────────────────────────
// FILLER_WORDS from prompt-rules-db.js covers balanced level.
// We add extra words for aggressive, and restrict to a safer subset for light.

// Light: only the most obvious pleasantries and empty openers.
// (The full FILLER_WORDS list from prompt-rules-db.js is used for balanced.)
const FILLER_LIGHT = [
  // Greetings / sign-offs
  'hi', 'hey', 'hello', 'greetings', 'good morning', 'good afternoon', 'good evening',
  'thank you', 'thanks', 'thank you so much', 'thanks so much', 'many thanks',
  'thank you very much', 'thanks a bunch', 'thanks again',
  // Closing pleasantries
  'sincerely', 'regards', 'best regards', 'kind regards', 'warm regards',
  // Empty softeners
  'please', 'kindly', 'if possible', 'if you can', 'if you could',
  'if you don\'t mind', 'if you wouldn\'t mind',
  // Most obvious filler intensifiers
  'just', 'simply', 'basically', 'really', 'very',
];

// Aggressive: everything in balanced plus hedging words that are almost always safe to drop.
const FILLER_AGGRESSIVE_EXTRA = [
  // Hedging
  'maybe', 'perhaps', 'probably', 'possibly', 'potentially',
  'seemingly', 'apparently', 'arguably',
  // Weak openers
  'i think', 'i believe', 'i feel', 'i suppose', 'i guess',
  'in my opinion', 'from my perspective',
  // Intensifiers
  'extremely', 'incredibly', 'unbelievably', 'amazingly', 'massively',
  'hugely', 'insanely', 'ridiculously', 'wildly', 'awfully', 'terribly',
  // Verbose transitions
  'additionally', 'furthermore', 'moreover',
  // School-project fluff
  'for my school project', 'this is for school', 'for a science fair audience',
  'make it educational', 'make it interesting', 'make it engaging',
  'make it easy to understand', 'in a way students can understand',
  'for middle school students', 'for high school students',
  'suitable for students', 'age appropriate', 'student friendly', 'kid friendly',
  'easy and simple', 'clear and detailed', 'very clear', 'very detailed',
  'really detailed', 'thorough explanation', 'really thorough explanation',
];

// ── Build filler regex for a given level ─────────────────────────────────────
function buildFillerRegexForLevel(level) {
  let words;
  if (level === LEVELS.LIGHT) {
    words = FILLER_LIGHT;
  } else if (level === LEVELS.AGGRESSIVE) {
    // FILLER_WORDS comes from prompt-rules-db.js
    words = [...FILLER_WORDS, ...FILLER_AGGRESSIVE_EXTRA];
  } else {
    // balanced — use the existing full list
    words = FILLER_WORDS;
  }

  // Sort longest-first so multi-word phrases match before sub-words
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const parts = sorted.map(phrase => {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (phrase.includes(' ')) {
      return `(?<=\\s|^)${esc}(?=\\s|[,.!?;:]|$)`;
    }
    return `\\b${esc}\\b`;
  });
  return new RegExp(parts.join('|'), 'gi');
}

// ── Step 1: protect sensitive segments ───────────────────────────────────────

/**
 * Replace all sensitive segments (code, URLs, numbers, quoted strings, …)
 * with indexed placeholders so they pass through optimization unchanged.
 *
 * @param {string} text
 * @returns {{ protected: string, segments: string[] }}
 */
function protectSensitiveSegments(text) {
  const segments = [];
  let result = text;

  for (const { re } of PROTECTION_PATTERNS) {
    result = result.replace(re(), match => {
      const idx = segments.length;
      segments.push(match);
      return makePlaceholder(idx);
    });
  }

  return { protected: result, segments };
}

/**
 * Swap placeholders back to their original content.
 *
 * @param {string} text
 * @param {string[]} segments
 * @returns {string}
 */
function restoreSensitiveSegments(text, segments) {
  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, idx) => segments[parseInt(idx, 10)] ?? ''
  );
}

// ── Step 2: apply phrase replacements ────────────────────────────────────────

/**
 * Apply the verbose-phrase → short-phrase replacement map.
 * Only rules at or below the requested level are applied.
 *
 * @param {string} text
 * @param {string} level  'light' | 'balanced' | 'aggressive'
 * @returns {string}
 */
function applyPhraseReplacements(text, level) {
  const levelOrder = { light: 0, balanced: 1, aggressive: 2 };
  const maxOrder = levelOrder[level] ?? 1;

  // Sort longest phrase first to avoid partial matches
  const sorted = [...PHRASE_REPLACEMENTS].sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [phrase, replacement, minLevel] of sorted) {
    if ((levelOrder[minLevel] ?? 1) > maxOrder) continue;

    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = phrase.includes(' ')
      ? new RegExp(`(?<=\\s|^)${escaped}(?=\\s|[,.!?;:]|$)`, 'gi')
      : new RegExp(`\\b${escaped}\\b`, 'gi');

    text = text.replace(pattern, replacement);
  }

  return text;
}

// ── Step 3: apply structural COMPRESSION_RULES from prompt-rules-db.js ───────
// (Already defined in prompt-rules-db.js; applied here for balanced/aggressive.)

function applyCompressionRules(text) {
  for (const rule of COMPRESSION_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  return text;
}

// ── Step 4: apply filler removal ─────────────────────────────────────────────

function applyFillerRemoval(text, level) {
  // Build a fresh regex each call to avoid stale lastIndex on /g regexes.
  // The word lists are cached; only the RegExp object is recreated.
  return text.replace(buildFillerRegexForLevel(level), ' ');
}

// ── Step 5: text cleanup ──────────────────────────────────────────────────────

function cleanupText(text) {
  // Collapse runs of spaces/tabs
  text = text.replace(/[ \t]{2,}/g, ' ');
  // Trim each line
  text = text.split('\n').map(l => l.trim()).join('\n');
  // Collapse 3+ blank lines → 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // Remove space before punctuation
  text = text.replace(/\s+([,.!?;:])/g, '$1');
  // Remove double punctuation
  text = text.replace(/([,.!?;:]){2,}/g, '$1');
  // Remove lone comma or semicolon at sentence start
  text = text.replace(/(^|\.\s+)[,;]\s*/g, '$1');
  // Capitalize first letter of each sentence
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());

  return text.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Optimize a prompt through the full pipeline.
 *
 * @param {string} text     The original prompt text.
 * @param {object} options
 * @param {string} [options.level='balanced']  'light' | 'balanced' | 'aggressive'
 * @returns {string}        The optimized prompt.
 */
function optimizePrompt(text, options = {}) {
  const level = options.level || LEVELS.BALANCED;
  const guidance = GENERATOR_GUIDANCE;

  if (!text || text.length < guidance.minLengthToOptimize) {
    return (text || '').trim();
  }

  // Step 1: protect sensitive segments
  const { protected: safe, segments } = protectSensitiveSegments(text);

  // Step 2: phrase replacements (verbose → concise)
  let result = applyPhraseReplacements(safe, level);

  // Step 3: structural compression rules (balanced + aggressive)
  if (level !== LEVELS.LIGHT) {
    result = applyCompressionRules(result);
  }

  // Step 4: filler word removal
  result = applyFillerRemoval(result, level);

  // Step 5: cleanup
  result = cleanupText(result);

  // Step 6: restore protected segments
  result = restoreSensitiveSegments(result, segments);

  // Safety net: if over-compressed, return trimmed original
  if (
    result.length === 0 ||
    result.length < text.length * guidance.minRetainRatio
  ) {
    return text.trim();
  }

  return result;
}

/**
 * Calculate word-level and token-level savings between two prompt versions.
 *
 * @param {string} original
 * @param {string} optimized
 * @returns {{
 *   originalWords: number,
 *   optimizedWords: number,
 *   wordsRemoved: number,
 *   percentReduction: number,
 *   originalTokens: number,
 *   optimizedTokens: number,
 *   tokensSaved: number,
 *   energySavedWh: number,
 *   waterSavedLiters: number,
 *   co2SavedGrams: number,
 * }}
 */
function calculateSavings(original, optimized) {
  const countWords = t => (t.trim().match(/\S+/g) || []).length;
  const originalWords   = countWords(original);
  const optimizedWords  = countWords(optimized);
  const wordsRemoved    = Math.max(0, originalWords - optimizedWords);
  const percentReduction =
    originalWords > 0 ? Math.round((wordsRemoved / originalWords) * 100) : 0;

  // Token estimates: 1 token ≈ 4 chars (GPT-style tiktoken approximation)
  // More accurate than the existing 8-char estimate for typical English prose.
  const CHARS_PER_TOKEN_EST = 4;
  const estTokens = t => Math.ceil(t.length / CHARS_PER_TOKEN_EST);
  const originalTokens  = estTokens(original);
  const optimizedTokens = estTokens(optimized);
  const tokensSaved     = Math.max(0, originalTokens - optimizedTokens);

  // Energy: tokens saved × Wh per token
  const energySavedWh    = tokensSaved * WH_PER_TOKEN;
  // Water: Wh → kWh → liters
  const waterSavedLiters = energySavedWh * KWH_PER_WH * LITERS_WATER_PER_KWH;
  // CO2: Wh → kWh → grams
  const co2SavedGrams    = energySavedWh * KWH_PER_WH * G_CO2_PER_KWH;

  return {
    originalWords,
    optimizedWords,
    wordsRemoved,
    percentReduction,
    originalTokens,
    optimizedTokens,
    tokensSaved,
    energySavedWh,
    waterSavedLiters,
    co2SavedGrams,
  };
}

/**
 * Convenience wrapper: optimize + calculate in one call.
 *
 * @param {string} text
 * @param {object} options  Same as optimizePrompt options.
 * @returns {{ optimized: string, stats: object }}
 */
function getOptimizationStats(text, options = {}) {
  const optimized = optimizePrompt(text, options);
  const stats     = calculateSavings(text, optimized);
  return { optimized, stats };
}

// ── Attach to window so popup.js can access without ES modules ────────────────
// (Chrome MV3 popup scripts share the page's window object)
window.EcoPromptOptimizer = {
  optimizePrompt,
  calculateSavings,
  getOptimizationStats,
  protectSensitiveSegments,
  restoreSensitiveSegments,
  LEVELS,
};
