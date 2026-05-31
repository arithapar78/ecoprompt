// lib/prompt-optimizer.js
// EcoPrompt prompt optimizer — Caveman-inspired compression, browser-safe, no deps.
//
// Pipeline per call to optimizePrompt():
//   1. protectSensitiveSegments  — swap code/URLs/numbers/etc. for placeholders
//   2. applyPhraseReplacements   — verbose multi-word phrase → shorter phrase
//   3. applyCompressionRules     — structural rewrites (COMPRESSION_RULES from rules-db)
//   4. applyFillerRemoval        — strip leftover single-word and multi-word filler
//   5. cleanupText               — fix spacing and punctuation artifacts
//   6. restoreSensitiveSegments  — swap placeholders back
//
// Caveman principle (research/caveman/caveman-activate.md):
//   Drop filler, keep substance. Technical terms exact. Code/URLs/numbers untouched.
//
// Loaded after: prompt-rules-db.js  (provides FILLER_WORDS, COMPRESSION_RULES, GENERATOR_GUIDANCE)
// Exposes:      window.EcoPromptOptimizer

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────

const LEVELS = { LIGHT: 'light', BALANCED: 'balanced', AGGRESSIVE: 'aggressive' };

// Energy/water/CO2 per saved token (mid-size model estimates)
const WH_PER_TOKEN        = 0.001;   // Wh per output token
const LITERS_WATER_PER_KWH = 1.8;   // data-center WUE average
const G_CO2_PER_KWH        = 386;   // US grid carbon intensity g/kWh
const KWH_PER_WH           = 0.001;

// Placeholder format: §P0§, §P1§, … — ASCII-safe, not valid in prompts
const PH_OPEN  = '§P';
const PH_CLOSE = '§';
const PH_RE    = /§P(\d+)§/g;

// ── Protection patterns ────────────────────────────────────────────────────────
// Applied in order — more-specific before less-specific.
// Each is a factory () => RegExp so we get a fresh instance every call (no stale lastIndex).

const PROTECTION_PATTERNS = [
  // Fenced code blocks  ```...``` or ~~~...~~~
  () => /```[\s\S]*?```|~~~[\s\S]*?~~~/g,
  // Inline code  `...`
  () => /`[^`\n]+`/g,
  // URLs
  () => /https?:\/\/[^\s)>\]"',]+|ftp:\/\/[^\s)>\]"',]+/gi,
  // Email addresses
  () => /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  // AI model names — protect before generic word removal
  () => /\b(?:GPT-?[0-9][\w.-]*|Claude[-\s]?[0-9][\w.-]*|Gemini[\w.-]*|Grok[\w.-]*|DeepSeek[\w.-]*|Llama[\w.-]*|Mistral[\w.-]*|PaLM[\w.-]*|Cohere[\w.-]*)\b/gi,
  // Numbers with units: 12px, 300 DPI, 24x36, 3.5%, 5kg, $50 …
  () => /\$\d[\d,.]*/g,
  () => /\b\d[\d,.]*\s*(?:x\s*\d[\d,.]*|DPI|dpi|px|em|rem|vh|vw|pt|cm|mm|in|ft|m|km|kg|g|lb|oz|ml|L|kWh|Wh|W|kW|MW|GW|ms|s|min|hr|hrs|MHz|GHz|TB|GB|MB|KB|°[CF]|%)\b/gi,
  // Plain integers/decimals (preserve counts like "5 bullet points")
  () => /\b\d[\d,.]*\b/g,
  // Quoted strings  "..." or '...'
  () => /"[^"\n]*"|'[^'\n]*'/g,
  // JSON objects/arrays
  () => /\{[^{}]*\}|\[[^\[\]]*\]/g,
  // Unix file paths
  () => /(?:^|\s)(\/[\w.\-]+(?:\/[\w.\-]+)+)/g,
  // Windows file paths
  () => /[A-Za-z]:\\(?:[\w.\- ]+\\)*[\w.\- ]+/g,
  // Markdown tables  (lines starting with |)
  () => /(?:^\|.+\|[ \t]*$\n?)+/gm,
  // Dates  2024-01-31 or 01/31/2024
  () => /\b\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}\b/g,
];

function protect(text) {
  const segs = [];
  for (const factory of PROTECTION_PATTERNS) {
    text = text.replace(factory(), (m, ...args) => {
      // Unix-path pattern has a leading-space capture group — preserve it
      const hasGroup = args.length > 1 && typeof args[0] === 'string' && args[0].trim() === '';
      const captured = hasGroup ? args[0] : '';
      const match    = hasGroup ? m.slice(captured.length) : m;
      const ph = PH_OPEN + segs.length + PH_CLOSE;
      segs.push(match);
      return captured + ph;
    });
  }
  return { text, segs };
}

function restore(text, segs) {
  return text.replace(PH_RE, (_, i) => segs[+i] ?? '');
}

// Public wrappers (part of the exposed API)
function protectSensitiveSegments(text) {
  const { text: protected_, segs } = protect(text);
  return { protected: protected_, segments: segs };
}
function restoreSensitiveSegments(text, segments) {
  return restore(text, segments);
}

// ── Phrase replacement table ───────────────────────────────────────────────────
// Format: [verbosePhrase, replacement, minLevel]
//   replacement '' = delete entirely.
//   minLevel = the lowest level at which this rule activates.
// Phrases are sorted longest-first at apply-time so longer matches win.
// All phrases lowercase — matching is case-insensitive.

const PHRASE_REPLACEMENTS = [

  // ════════════════════════════════════════════════════════
  // LIGHT — safe structural shorthands, always apply
  // ════════════════════════════════════════════════════════

  // Fact wrappers → shorter conjunction
  ['in spite of the fact that',                    'although',    'light'],
  ['despite the fact that',                        'although',    'light'],
  ['in light of the fact that',                    'because',     'light'],
  ['because of the fact that',                     'because',     'light'],
  ['owing to the fact that',                       'because',     'light'],
  ['due to the fact that',                         'because',     'light'],
  ['given the fact that',                          'given that',  'light'],
  ['based on the fact that',                       'because',     'light'],
  ['considering the fact that',                    'given that',  'light'],

  // About-synonyms
  ['concerning the matter of',                     'about',       'light'],
  ['regarding the matter of',                      'about',       'light'],
  ['with reference to',                            'about',       'light'],
  ['with regard to',                               'about',       'light'],
  ['with respect to',                              'about',       'light'],
  ['in relation to',                               'about',       'light'],
  ['pertaining to',                                'about',       'light'],
  ['in connection with',                           'about',       'light'],
  ['as far as this is concerned',                  'regarding',   'light'],
  ['when it comes to',                             'regarding',   'light'],
  ['in terms of',                                  'regarding',   'light'],

  // Time verbosity → single word
  ['at this point in time',                        'now',         'light'],
  ['at the present time',                          'now',         'light'],
  ['at the current time',                          'now',         'light'],
  ['currently right now',                          'now',         'light'],
  ['as of right now',                              'now',         'light'],

  // Conditional verbosity → if
  ['in the event that',                            'if',          'light'],
  ['in the case that',                             'if',          'light'],
  ['in the situation where',                       'if',          'light'],
  ['under circumstances where',                    'if',          'light'],

  // Time prepositions
  ['subsequent to',                                'after',       'light'],
  ['prior to',                                     'before',      'light'],
  ['over the course of',                           'during',      'light'],
  ['during the course of',                         'during',      'light'],
  ['throughout the course of',                     'throughout',  'light'],

  // Purpose prepositions
  ['in order for',                                 'for',         'light'],
  ['for the purpose of',                           'to',          'light'],
  ['for purposes of',                              'for',         'light'],
  ['with the aim of',                              'to',          'light'],
  ['with the goal of',                             'to',          'light'],
  ['with the intention of',                        'to',          'light'],
  ['in an effort to',                              'to',          'light'],
  ['in a bid to',                                  'to',          'light'],
  ['so as to',                                     'to',          'light'],
  ['in order to',                                  'to',          'light'],
  ['in the process of',                            'while',       'light'],

  // Quantity verbosity → concise
  ['a large number of',                            'many',        'light'],
  ['a wide variety of',                            'various',     'light'],
  ['a wide range of',                              'various',     'light'],
  ['a small number of',                            'a few',       'light'],
  ['a number of',                                  'several',     'light'],
  ['many different',                               'many',        'light'],
  ['various different',                            'various',     'light'],
  ['different kinds of',                           'various',     'light'],
  ['different types of',                           'various',     'light'],
  ['all kinds of',                                 'various',     'light'],
  ['a lot of',                                     'many',        'light'],
  ['lots of',                                      'many',        'light'],
  ['tons of',                                      'many',        'light'],
  ['plenty of',                                    'many',        'light'],

  // Tautologies — always safe
  ['completely eliminate',                         'eliminate',   'light'],
  ['totally remove',                               'remove',      'light'],
  ['exactly identical',                            'identical',   'light'],
  ['same exact',                                   'same',        'light'],
  ['exact same',                                   'same',        'light'],
  ['combine together',                             'combine',     'light'],
  ['merge together',                               'merge',       'light'],
  ['join together',                                'join',        'light'],
  ['connect together',                             'connect',     'light'],
  ['collaborate together',                         'collaborate', 'light'],
  ['return back',                                  'return',      'light'],
  ['revert back',                                  'revert',      'light'],
  ['repeat again',                                 'repeat',      'light'],
  ['continue on',                                  'continue',    'light'],
  ['summarize briefly',                            'summarize',   'light'],
  ['briefly summarize',                            'summarize',   'light'],
  ['general consensus',                            'consensus',   'light'],
  ['close proximity',                              'proximity',   'light'],
  ['advance planning',                             'planning',    'light'],
  ['added bonus',                                  'bonus',       'light'],
  ['free gift',                                    'gift',        'light'],
  ['end result',                                   'result',      'light'],
  ['final outcome',                                'outcome',     'light'],
  ['future plans',                                 'plans',       'light'],
  ['past history',                                 'history',     'light'],
  ['null and void',                                'void',        'light'],
  ['true and accurate',                            'accurate',    'light'],
  ['full and complete',                            'complete',    'light'],
  ['any and all',                                  'all',         'light'],
  ['each and every',                               'every',       'light'],
  ['first and foremost',                           'first',       'light'],
  ['basic fundamentals',                           'fundamentals','light'],
  ['basic essentials',                             'essentials',  'light'],
  ['important essentials',                         'essentials',  'light'],
  ['necessary requirements',                       'requirements','light'],
  ['true facts',                                   'facts',       'light'],
  ['actual facts',                                 'facts',       'light'],
  ['personal opinion',                             'opinion',     'light'],
  ['unexpected surprise',                          'surprise',    'light'],
  ['new innovation',                               'innovation',  'light'],
  ['small little',                                 'small',       'light'],
  ['large big',                                    'large',       'light'],
  ['new beginning',                                'beginning',   'light'],
  ['still remains',                                'remains',     'light'],
  ['whether or not',                               'whether',     'light'],
  ['reason why',                                   'reason',      'light'],
  ['the reason is because',                        'because',     'light'],

  // ════════════════════════════════════════════════════════
  // BALANCED — remove meta-commentary, preamble, verbose clusters
  //            Only delete when meaning obviously survives
  // ════════════════════════════════════════════════════════

  // Meta-commentary filler — delete entirely
  ['it is important to note that',                 '',            'balanced'],
  ['it is worth mentioning that',                  '',            'balanced'],
  ['it is worth noting that',                      '',            'balanced'],
  ['it should be noted that',                      '',            'balanced'],
  ['it is also important to note',                 '',            'balanced'],
  ['it goes without saying that',                  '',            'balanced'],
  ['it goes without saying',                       '',            'balanced'],
  ['needless to say,',                             '',            'balanced'],
  ['needless to say',                              '',            'balanced'],
  ['with that being said,',                        '',            'balanced'],
  ['with that being said',                         '',            'balanced'],
  ['having said that,',                            '',            'balanced'],
  ['having said that',                             '',            'balanced'],
  ['that being said,',                             '',            'balanced'],
  ['that being said',                              '',            'balanced'],
  ['as a matter of fact,',                         '',            'balanced'],
  ['as a matter of fact',                          '',            'balanced'],
  ["for what it's worth,",                         '',            'balanced'],
  ["for what it's worth",                          '',            'balanced'],
  ['for what its worth,',                          '',            'balanced'],
  ['for what its worth',                           '',            'balanced'],
  ['to be perfectly honest,',                      '',            'balanced'],
  ['to be perfectly honest',                       '',            'balanced'],
  ['to be honest,',                                '',            'balanced'],
  ['to be honest',                                 '',            'balanced'],
  ['to tell the truth,',                           '',            'balanced'],
  ['to tell the truth',                            '',            'balanced'],
  ['truth be told,',                               '',            'balanced'],
  ['truth be told',                                '',            'balanced'],
  ['in all honesty,',                              '',            'balanced'],
  ['in all honesty',                               '',            'balanced'],
  ['to be fair,',                                  '',            'balanced'],
  ['to be fair',                                   '',            'balanced'],
  ['frankly speaking,',                            '',            'balanced'],
  ['frankly speaking',                             '',            'balanced'],
  ['the fact that',                                'that',        'balanced'],
  ['one thing to note is',                         '',            'balanced'],
  ['keep in mind that',                            '',            'balanced'],
  ['bear in mind that',                            '',            'balanced'],
  ['remember that',                                '',            'balanced'],
  ['as a reminder,',                               '',            'balanced'],
  ['as a reminder',                                '',            'balanced'],

  // Weak openers — delete the opener, leave the core request
  ['i was really hoping you could',                '',            'balanced'],
  ['i was hoping you could',                       '',            'balanced'],
  ['i am really hoping you could',                 '',            'balanced'],
  ['i am hoping you could',                        '',            'balanced'],
  ['i would really appreciate it if you could',    '',            'balanced'],
  ['i would really appreciate it if',              '',            'balanced'],
  ['i would appreciate it if you could',           '',            'balanced'],
  ['i would appreciate it if',                     '',            'balanced'],
  ["i'd really appreciate it if you could",        '',            'balanced'],
  ["i'd really appreciate it if",                  '',            'balanced'],
  ["i'd appreciate it if you could",               '',            'balanced'],
  ["i'd appreciate it if",                         '',            'balanced'],
  ['i would really appreciate your help with',     '',            'balanced'],
  ['i would appreciate your help with',            '',            'balanced'],
  ['appreciate your help with',                    '',            'balanced'],
  ['appreciate the help with',                     '',            'balanced'],
  ['i would like you to',                          '',            'balanced'],
  ["i'd like you to",                              '',            'balanced'],
  ['i need you to',                                '',            'balanced'],
  ['i want you to',                                '',            'balanced'],
  ['could you please help me',                     '',            'balanced'],
  ['can you please help me',                       '',            'balanced'],
  ['would you please help me',                     '',            'balanced'],
  ['could you help me',                            '',            'balanced'],
  ['can you help me',                              '',            'balanced'],
  ['would you help me',                            '',            'balanced'],
  ['please help me',                               '',            'balanced'],
  ['i need help with',                             '',            'balanced'],
  ['i would like help with',                       '',            'balanced'],
  ['i want help with',                             '',            'balanced'],
  ['provide assistance with',                      '',            'balanced'],
  ['assist me with',                               '',            'balanced'],
  ['help me with',                                 '',            'balanced'],
  ['help me',                                      '',            'balanced'],
  ['i am asking you to',                           '',            'balanced'],
  ["i'm asking you to",                            '',            'balanced'],
  ['i request',                                    '',            'balanced'],
  ['i am requesting',                              '',            'balanced'],
  ['i would request',                              '',            'balanced'],
  ['my request is',                                '',            'balanced'],
  ['the request is',                               '',            'balanced'],
  ["i'm reaching out because",                     '',            'balanced'],
  ['i am reaching out because',                    '',            'balanced'],
  ["i'm reaching out to",                          '',            'balanced'],
  ['i am reaching out to',                         '',            'balanced'],
  ["i'm writing to",                               '',            'balanced'],
  ['i am writing to',                              '',            'balanced'],
  ['i wanted to ask',                              '',            'balanced'],
  ['i just wanted to ask',                         '',            'balanced'],
  ['i wanted to know',                             '',            'balanced'],
  ['i just wanted to know',                        '',            'balanced'],
  ['i need your help with',                        '',            'balanced'],
  ['i would like your help with',                  '',            'balanced'],
  ['i was wondering if you could',                 '',            'balanced'],
  ['i was wondering if',                           '',            'balanced'],
  ['i am wondering if',                            '',            'balanced'],
  ["i'm wondering if",                             '',            'balanced'],
  ["i'm looking to",                               '',            'balanced'],
  ['i am looking to',                              '',            'balanced'],
  ["i'm trying to figure out",                     '',            'balanced'],
  ['i am trying to figure out',                    '',            'balanced'],
  ['i was trying to figure out',                   '',            'balanced'],
  ["i'm hoping to",                                '',            'balanced'],
  ['i am hoping to',                               '',            'balanced'],
  ['i was hoping to',                              '',            'balanced'],
  ["i'd like to know if",                          '',            'balanced'],
  ['i would like to know if',                      '',            'balanced'],
  ['i wanted to know if',                          '',            'balanced'],
  ['i want to know if',                            '',            'balanced'],
  ['i have a quick question about',                '',            'balanced'],
  ['i have a question about',                      '',            'balanced'],
  ['my question is',                               '',            'balanced'],
  ['the question is',                              '',            'balanced'],
  ['what i want to ask is',                        '',            'balanced'],
  ["what i'm trying to ask is",                    '',            'balanced'],
  ['what i am trying to ask is',                   '',            'balanced'],
  ["what i'm asking is",                           '',            'balanced'],
  ['what i am asking is',                          '',            'balanced'],
  ["i'm curious about",                            '',            'balanced'],
  ['i am curious about',                           '',            'balanced'],
  ["i was curious about",                          '',            'balanced'],
  ['i need to know',                               '',            'balanced'],
  ['i just need to know',                          '',            'balanced'],
  ['basically what i need is',                     '',            'balanced'],
  ['basically what i want is',                     '',            'balanced'],
  ['what i really need is',                        '',            'balanced'],
  ['what i really want is',                        '',            'balanced'],

  // Soft uncertain openers
  ['not sure if this makes sense but',             '',            'balanced'],
  ["i don't know if this makes sense but",         '',            'balanced'],
  ['this might be a silly question but',           '',            'balanced'],
  ['this may be a silly question but',             '',            'balanced'],
  ['this might be dumb but',                       '',            'balanced'],
  ['this may be dumb but',                         '',            'balanced'],
  ["correct me if i'm wrong but",                  '',            'balanced'],
  ["correct me if i'm wrong",                      '',            'balanced'],
  ['i could be wrong but',                         '',            'balanced'],
  ['i may be wrong but',                           '',            'balanced'],

  // Action wrappers — delete, keep the action verb
  ['please ensure that',                           '',            'balanced'],
  ['please make sure that',                        '',            'balanced'],
  ['really make sure that',                        '',            'balanced'],
  ['also make sure that',                          '',            'balanced'],
  ['i want to make sure that',                     '',            'balanced'],
  ['try to make sure that',                        '',            'balanced'],
  ['make sure to',                                 '',            'balanced'],
  ['be sure to',                                   '',            'balanced'],
  ["don't forget to",                              '',            'balanced'],
  ['do not forget to',                             '',            'balanced'],
  ['i also need you to include',                   '',            'balanced'],
  ['could you also include',                       '',            'balanced'],
  ['please also include',                          '',            'balanced'],
  ['it would be great if you could include',       '',            'balanced'],
  ['i would appreciate if you could include',      '',            'balanced'],
  ['i would love if you could include',            '',            'balanced'],
  ['in addition, please include',                  '',            'balanced'],
  ['make sure to include',                         '',            'balanced'],
  ['be sure to include',                           '',            'balanced'],
  ['do not forget to include',                     '',            'balanced'],
  ["don't forget to include",                      '',            'balanced'],
  ['ensure that',                                  '',            'balanced'],
  ['be certain to',                                '',            'balanced'],
  ['make certain to',                              '',            'balanced'],
  ['do your best to',                              '',            'balanced'],
  ['try to',                                       '',            'balanced'],
  ['attempt to',                                   '',            'balanced'],

  // Direct-object shorthands
  ['write me a',                                   'write a',     'balanced'],
  ['create me a',                                  'create a',    'balanced'],
  ['give me a',                                    'give a',      'balanced'],
  ['show me a',                                    'show a',      'balanced'],
  ['draft me a',                                   'draft a',     'balanced'],
  ['build me a',                                   'build a',     'balanced'],
  ['make me a',                                    'make a',      'balanced'],
  ['generate me a',                                'generate a',  'balanced'],
  ['write for me',                                 'write',       'balanced'],
  ['create for me',                                'create',      'balanced'],
  ['make for me',                                  'make',        'balanced'],
  ['draft for me',                                 'draft',       'balanced'],
  ['build for me',                                 'build',       'balanced'],
  ['generate for me',                              'generate',    'balanced'],
  ['provide me with',                              'provide',     'balanced'],
  ['explain to me',                                'explain',     'balanced'],
  ['tell me about',                                'explain',     'balanced'],
  ['give me information about',                    'explain',     'balanced'],
  ['provide information about',                    'explain',     'balanced'],
  ['provide details about',                        'explain',     'balanced'],
  ['give me details about',                        'explain',     'balanced'],
  ['give me a detailed explanation of',            'explain',     'balanced'],
  ['write a detailed explanation of',              'explain',     'balanced'],

  // Verbose adjective clusters
  ['very detailed and thorough',                   'detailed',    'balanced'],
  ['detailed and comprehensive',                   'detailed',    'balanced'],
  ['comprehensive and detailed',                   'detailed',    'balanced'],
  ['a really detailed explanation',                'a detailed explanation', 'balanced'],
  ['in a way that is really easy to understand',   'clearly',     'balanced'],
  ['in a way that students can understand',        'clearly',     'balanced'],
  ['in a way that is easy to understand',          'clearly',     'balanced'],
  ['clear and easy to understand',                 'clear',       'balanced'],
  ['simple to understand',                         'clear',       'balanced'],
  ['easy to understand',                           'clear',       'balanced'],
  ['understandable for students',                  'clear',       'balanced'],
  ['educational and engaging',                     'engaging',    'balanced'],

  // School / audience fluff
  ['for a science fair audience',                  '',            'balanced'],
  ['for my science fair',                          '',            'balanced'],
  ['for science fair',                             '',            'balanced'],
  ['for my school project',                        '',            'balanced'],
  ['this is for school',                           '',            'balanced'],
  ['for middle school students',                   '',            'balanced'],
  ['for high school students',                     '',            'balanced'],
  ['for middle school',                            '',            'balanced'],
  ['for high school',                              '',            'balanced'],
  ['suitable for students',                        '',            'balanced'],
  ['appropriate for students',                     '',            'balanced'],
  ['good for students',                            '',            'balanced'],
  ['student friendly',                             '',            'balanced'],
  ['kid friendly',                                 '',            'balanced'],
  ['age appropriate',                              '',            'balanced'],
  ['make it educational',                          '',            'balanced'],
  ['make it fun',                                  '',            'balanced'],
  ['make it very detailed',                        '',            'balanced'],
  ['make it really detailed',                      '',            'balanced'],
  ['make it really thorough',                      '',            'balanced'],
  ['make it thorough',                             '',            'balanced'],
  ['make it very clear',                           '',            'balanced'],
  ['make it detailed',                             '',            'balanced'],
  ['make it clear',                                '',            'balanced'],
  ['make it interesting',                          '',            'balanced'],
  ['make it engaging',                             '',            'balanced'],

  // Email / social fluff — safe to remove when NOT writing an email
  ['i hope this email finds you well',             '',            'balanced'],
  ['hope this finds you well',                     '',            'balanced'],
  ["i hope you're doing well",                     '',            'balanced'],
  ['i hope you are doing well',                    '',            'balanced'],
  ['just checking in',                             '',            'balanced'],
  ['i wanted to follow up',                        '',            'balanced'],
  ['wanted to follow up',                          '',            'balanced'],
  ['following up on',                              '',            'balanced'],
  ['following up',                                 '',            'balanced'],
  ['circling back on',                             '',            'balanced'],
  ['just circling back',                           '',            'balanced'],
  ['circling back',                                '',            'balanced'],
  ['touching base on',                             '',            'balanced'],
  ['just touching base',                           '',            'balanced'],
  ['touching base',                                '',            'balanced'],
  ['i wanted to reach out',                        '',            'balanced'],
  ["i'm reaching out",                             '',            'balanced'],
  ['i am reaching out',                            '',            'balanced'],
  ['quick reminder,',                              '',            'balanced'],
  ['quick reminder',                               '',            'balanced'],
  ['friendly reminder,',                           '',            'balanced'],
  ['friendly reminder',                            '',            'balanced'],
  ['gentle reminder,',                             '',            'balanced'],
  ['gentle reminder',                              '',            'balanced'],
  ['quick note,',                                  '',            'balanced'],
  ['quick note',                                   '',            'balanced'],
  ['looking forward to hearing from you',          '',            'balanced'],
  ['i look forward to hearing from you',           '',            'balanced'],
  ['please let me know',                           '',            'balanced'],
  ['let me know',                                  '',            'balanced'],
  ['feel free to',                                 '',            'balanced'],
  ["don't hesitate to",                            '',            'balanced'],
  ['do not hesitate to',                           '',            'balanced'],
  ['thank you again',                              '',            'balanced'],
  ['thanks again',                                 '',            'balanced'],

  // Weak endings
  ['and stuff like that',                          '',            'balanced'],
  ['and things like that',                         '',            'balanced'],
  ['and all that kind of stuff',                   '',            'balanced'],
  ['and all that',                                 '',            'balanced'],
  ['or something like that',                       '',            'balanced'],
  ['stuff like that',                              '',            'balanced'],
  ['things like that',                             '',            'balanced'],
  ['that kind of thing',                           '',            'balanced'],
  ['you get the idea',                             '',            'balanced'],
  ['you know what i mean',                         '',            'balanced'],
  ['if that makes sense',                          '',            'balanced'],
  ['hope that makes sense',                        '',            'balanced'],
  ['does that make sense',                         '',            'balanced'],
  ['and so on',                                    '',            'balanced'],
  ['and everything',                               '',            'balanced'],
  ['and so forth',                                 '',            'balanced'],
  ['or something',                                 '',            'balanced'],
  ['or anything',                                  '',            'balanced'],
  ['or whatever',                                  '',            'balanced'],
  ['and whatever',                                 '',            'balanced'],
  ['and stuff',                                    '',            'balanced'],
  ['and things',                                   '',            'balanced'],

  // ════════════════════════════════════════════════════════
  // AGGRESSIVE — transitions, AI fluff, hedging blocks
  //              Compress hard while preserving core meaning
  // ════════════════════════════════════════════════════════

  ['to make a long story short,',                  '',            'aggressive'],
  ['to make a long story short',                   '',            'aggressive'],
  ['long story short,',                            '',            'aggressive'],
  ['long story short',                             '',            'aggressive'],
  ['at the end of the day,',                       '',            'aggressive'],
  ['at the end of the day',                        '',            'aggressive'],
  ['when all is said and done,',                   '',            'aggressive'],
  ['when all is said and done',                    '',            'aggressive'],
  ['all things considered,',                       '',            'aggressive'],
  ['all things considered',                        '',            'aggressive'],
  ['in the grand scheme of things,',               '',            'aggressive'],
  ['in the grand scheme of things',                '',            'aggressive'],
  ['from the perspective of',                      'from',        'aggressive'],
  ['from the standpoint of',                       'from',        'aggressive'],
  ['from the point of view of',                    'from',        'aggressive'],
  ['in the context of',                            'in',          'aggressive'],
  ['in addition to that,',                         '',            'aggressive'],
  ['in addition to that',                          '',            'aggressive'],
  ['on top of that,',                              '',            'aggressive'],
  ['on top of that',                               '',            'aggressive'],
  ['as you can see,',                              '',            'aggressive'],
  ['as you can see',                               '',            'aggressive'],
  ['as previously stated,',                        '',            'aggressive'],
  ['as previously stated',                         '',            'aggressive'],
  ['as stated earlier,',                           '',            'aggressive'],
  ['as stated earlier',                            '',            'aggressive'],
  ['as mentioned earlier,',                        '',            'aggressive'],
  ['as mentioned earlier',                         '',            'aggressive'],
  ['as mentioned,',                                '',            'aggressive'],
  ['as mentioned',                                 '',            'aggressive'],
  ['in other words,',                              '',            'aggressive'],
  ['in other words',                               '',            'aggressive'],
  ['to put it another way,',                       '',            'aggressive'],
  ['to put it another way',                        '',            'aggressive'],
  ['to put it differently,',                       '',            'aggressive'],
  ['to put it differently',                        '',            'aggressive'],
  ['to put it simply,',                            '',            'aggressive'],
  ['to put it simply',                             '',            'aggressive'],
  ['simply put,',                                  '',            'aggressive'],
  ['simply put',                                   '',            'aggressive'],
  ['going forward,',                               '',            'aggressive'],
  ['going forward',                                '',            'aggressive'],
  ['moving forward,',                              '',            'aggressive'],
  ['moving forward',                               '',            'aggressive'],
  ['on the other hand,',                           '',            'aggressive'],
  ['on the other hand',                            '',            'aggressive'],
  ['on the flip side,',                            '',            'aggressive'],
  ['on the flip side',                             '',            'aggressive'],
  ['by the same token,',                           '',            'aggressive'],
  ['by the same token',                            '',            'aggressive'],
  ['in comparison,',                               '',            'aggressive'],
  ['in contrast,',                                 '',            'aggressive'],

  // Hedging opinion blocks
  ['in my opinion,',                               '',            'aggressive'],
  ['in my opinion',                                '',            'aggressive'],
  ['from my perspective,',                         '',            'aggressive'],
  ['from my perspective',                          '',            'aggressive'],
  ['from my point of view,',                       '',            'aggressive'],
  ['from my point of view',                        '',            'aggressive'],
  ['i think that',                                 '',            'aggressive'],
  ['i believe that',                               '',            'aggressive'],
  ['i feel that',                                  '',            'aggressive'],
  ['i assume that',                                '',            'aggressive'],
  ['i imagine that',                               '',            'aggressive'],
  ['i suspect that',                               '',            'aggressive'],
  ['as far as i can tell,',                        '',            'aggressive'],
  ['as far as i can tell',                         '',            'aggressive'],
  ['as best as i can tell,',                       '',            'aggressive'],
  ['as best as i can tell',                        '',            'aggressive'],

  // AI-prompt fluff
  ['i want you to act as',                         '',            'aggressive'],
  ['act as',                                       '',            'aggressive'],
  ['pretend you are',                              '',            'aggressive'],
  ['you are an expert in',                         '',            'aggressive'],
  ['you are an expert',                            '',            'aggressive'],
  ['as an expert',                                 '',            'aggressive'],
  ['world-class expert',                           '',            'aggressive'],
  ['professional expert',                          '',            'aggressive'],
  ['experienced professional',                     '',            'aggressive'],
  ['highly skilled',                               '',            'aggressive'],
  ['explain like i\'m five',                       'explain simply', 'aggressive'],
  ['explain like i am five',                       'explain simply', 'aggressive'],
  ['eli5',                                         'explain simply', 'aggressive'],
  ['go step by step',                              '',            'aggressive'],
  ['step by step',                                 '',            'aggressive'],
  ['step-by-step',                                 '',            'aggressive'],
  ['walk me through',                              'explain',     'aggressive'],
  ['break it down',                                'explain',     'aggressive'],
  ['make it better',                               'improve',     'aggressive'],
  ['make it more professional',                    'improve',     'aggressive'],
  ['make it more clear',                           'clarify',     'aggressive'],
  ['make this sound better',                       'improve',     'aggressive'],
  ['make this more professional',                  'improve',     'aggressive'],
  ['make this more clear',                         'clarify',     'aggressive'],
  ['make this clearer',                            'clarify',     'aggressive'],
  ['make this concise',                            'shorten',     'aggressive'],
  ['make this shorter',                            'shorten',     'aggressive'],
  ['make this stronger',                           'improve',     'aggressive'],
  ['clean this up',                                'improve',     'aggressive'],
  ['fix this',                                     'fix',         'aggressive'],
  ['polish this',                                  'improve',     'aggressive'],
  ['refine this',                                  'improve',     'aggressive'],
  ['rewrite this',                                 'rewrite',     'aggressive'],
  ['optimize this',                                'optimize',    'aggressive'],
  ['improve this',                                 'improve',     'aggressive'],
  ['best possible',                                '',            'aggressive'],
  ['high quality',                                 '',            'aggressive'],
  ['top quality',                                  '',            'aggressive'],
  ['detailed and comprehensive',                   'detailed',    'aggressive'],
  ['comprehensive and detailed',                   'detailed',    'aggressive'],
];

// ── Filler word lists per level ────────────────────────────────────────────────
// DESIGN RULES:
//  1. Only strip words whose removal never alters grammatical meaning.
//  2. 'so', 'well', 'right', 'too', 'also', 'ok', 'yet', 'still', 'even',
//     'then', 'now', 'here', 'there' are NOT in any list — they carry meaning
//     in content ("so that X", "right-click", "even if", "still works", etc.)
//  3. Multi-word phrases are applied BEFORE single-word passes.
//  4. Each level is ADDITIVE — balanced includes everything in light, etc.

// ── LIGHT ─────────────────────────────────────────────────────────────────────
// Remove the most obvious zero-content words: greetings, sign-offs, please/kindly,
// and a tiny set of clearly hollow intensifiers.

const FILLERS_LIGHT = [
  // Greetings (multi-word first)
  'hello there', 'hi there', 'hey there', 'dear assistant',
  'good morning', 'good afternoon', 'good evening', 'good day',
  // Greetings (single)
  'hello', 'howdy', 'greetings', 'hey', 'hi',
  // Sign-offs (multi-word)
  'thank you so much', 'thanks so much', 'thank you very much',
  'thanks a lot', 'thanks a bunch', 'many thanks',
  'thank you again', 'thanks again',
  'best regards', 'kind regards', 'warm regards',
  'yours truly', 'with appreciation',
  // Sign-offs (single)
  'thanks', 'sincerely', 'regards', 'cheers', 'goodbye',
  // Appreciation multi-word
  'much appreciated', 'i appreciate it', 'i really appreciate it',
  'i would appreciate it', 'i would really appreciate it',
  "i'd appreciate it",
  'appreciate your help', 'appreciate the help',
  // Basic softeners
  'please', 'pls', 'plz', 'kindly', 'please kindly',
  // The safest hollow intensifiers — never meaningful
  'just', 'really', 'very',
];

// ── BALANCED ───────────────────────────────────────────────────────────────────
// Add: politeness hedges, soft openers, obvious intensifiers, throat-clearing.
// Still conservative — only words that are safe across nearly all contexts.

const FILLERS_BALANCED = [
  // Politeness hedges (multi-word)
  'sorry to bother you', 'sorry for bothering you',
  'sorry for the trouble', 'sorry for the inconvenience',
  'if it is not too much trouble', "if it's not too much trouble",
  'at your earliest convenience', 'at your convenience',
  'whenever you have time', 'whenever you get a chance',
  'when you get a chance', 'when you have time',
  'no rush',
  "if you wouldn't mind", "if you don't mind",
  'if you do not mind',
  'if that is okay', "if that's okay",
  'if it is okay', "if it's okay",
  "if it's possible", 'if possible',
  'if you could', 'if you can', 'if you would',
  'hope you are well', "hope you're well",
  'hope you are doing well', "hope you're doing well",
  'hope all is well',
  'could you please', 'could you kindly',
  'would you please', 'would you kindly',
  'can you please',
  // Apologies (single)
  'sorry', 'apologies',
  'excuse me', 'pardon me',

  // Soft opener phrases (multi-word)
  'i hope', "i'm hoping", 'i am hoping', 'i was hoping', 'hoping',
  "i'm really hoping", 'i am really hoping', 'i was really hoping',
  'i just wanted', 'i wanted',
  "i'd like", 'i would like', "i'd love", 'i would love',
  'i just need', 'i need',
  'so basically', 'so i guess', 'so i think', 'so i was thinking',
  'i was thinking', "i'm thinking", 'i am thinking',
  'i think maybe', 'i sort of feel like', 'i kind of feel like',
  'i have a quick question', 'i have a question',
  'quick question', 'small question', 'dumb question', 'silly question',

  // Hedging phrases (multi-word)
  'as far as i can tell', 'as best as i can tell',
  'it would seem', 'it seems that', 'it seems like',
  'it looks like', 'it appears that', 'it appears like',
  'it might be', 'it may be', 'it could be', 'it would be',
  'it may seem', 'it might seem',
  'more or less', 'to some extent', 'in some ways', 'in a sense', 'in a way',
  'to a certain extent', 'to a degree',
  'for the most part', 'in many cases', 'in most cases',
  'at times', 'roughly speaking', 'generally speaking', 'broadly speaking',
  "i'd say", 'i would say',
  'i would suggest', 'i would argue', 'i reckon',
  'as you may know', 'as you probably know', 'as you know', 'as we know',

  // Throat-clearing (multi-word)
  'it goes without saying', 'suffice it to say',
  'first and foremost', 'first of all', 'last but not least',
  'to begin with', 'to start with', 'to start off',
  'by the way', 'the bottom line is', "here's the thing", 'the main point is',
  'the key thing is', 'the important thing is', 'the point is',
  'you get the idea', 'you know what i mean',
  'you see', 'look,', 'listen,',

  // Single-word intensifiers — safe to strip
  'simply', 'basically', 'essentially', 'fundamentally',
  'actually', 'literally', 'honestly', 'frankly',
  'truly', 'genuinely',
  'quite', 'fairly', 'rather',
  'somewhat', 'slightly',
  'obviously', 'clearly', 'certainly', 'definitely',
  'absolutely', 'totally', 'completely', 'utterly', 'entirely', 'fully',
  'ultimately',
  // Weak single qualifiers
  'arguably', 'presumably', 'supposedly', 'allegedly', 'reportedly', 'apparently',
  // Transition connectors that add no meaning
  'additionally', 'furthermore', 'moreover',
  // Incidental
  'incidentally',
];

// ── AGGRESSIVE ────────────────────────────────────────────────────────────────
// Add: hedging singles, strong intensifiers, weak ending tags,
// and words that are almost always pure filler.
// Still NEVER removes: so/well/right/too/also/yet/still/even — they're content words.

const FILLERS_AGGRESSIVE = [
  // Hedging singles
  'maybe', 'perhaps', 'probably', 'possibly', 'potentially',
  'seemingly', 'supposedly', 'somehow', 'presumably',
  // Opinion / uncertainty singles
  'i think', 'i believe', 'i feel', 'i guess', 'i suppose',
  'i assume', 'i imagine', 'i suspect',
  // Strong intensifiers (too risky for balanced — "extremely dangerous" keeps "extremely")
  'super', 'extremely', 'incredibly', 'unbelievably', 'amazingly',
  'seriously', 'massively', 'hugely', 'deeply', 'especially', 'particularly',
  'remarkably', 'significantly', 'substantially', 'dramatically',
  'enormously', 'exceptionally', 'extraordinarily', 'intensely',
  'terribly', 'awfully', 'insanely', 'ridiculously', 'wildly',
  'crazy', 'ultra', 'mega', 'majorly',
  // Weak ending tags (single word)
  'etc', 'anyways', 'anyway',
  // AI / school single words
  'educational', 'engaging', 'comprehensive', 'thorough',
  // Approximate qualifiers that rarely add meaning
  'roughly', 'approximately', 'nearly', 'almost', 'relatively',
  'typically', 'generally', 'commonly', 'usually', 'often', 'sometimes',
];

// ── Apply phrase replacements ──────────────────────────────────────────────────
// Uses a capturing group for the leading boundary so we don't rely on
// variable-width lookbehinds (which have edge-case issues in some builds).

const LEVEL_ORDER = { light: 0, balanced: 1, aggressive: 2 };

function applyPhraseReplacements(text, level) {
  const maxOrder = LEVEL_ORDER[level] ?? 1;

  // Sort longest phrase first to prevent sub-phrase matches eating longer ones
  const rules = PHRASE_REPLACEMENTS
    .filter(([, , minLvl]) => (LEVEL_ORDER[minLvl] ?? 0) <= maxOrder)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [phrase, replacement] of rules) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match: optional leading whitespace (captured) + phrase + word/punctuation boundary
    const re = new RegExp(
      '(^|[\\s,;])' + esc + '(?=$|[\\s,.!?;:\\-])',
      'gi'
    );
    text = text.replace(re, (_, lead) => {
      if (!replacement) return lead;          // delete: keep only leading whitespace
      return lead + replacement;              // replace: keep leading whitespace + new phrase
    });
  }

  return text;
}

// ── Apply filler removal ───────────────────────────────────────────────────────
// Multi-word fillers: applied individually (each with own fresh regex).
// Single-word fillers: combined into one regex pass for speed.
// This avoids the ambiguous-group-capture problem of a single giant alternation.

function getFillerList(level) {
  if (level === LEVELS.LIGHT)      return FILLERS_LIGHT;
  if (level === LEVELS.AGGRESSIVE) return [...FILLERS_BALANCED, ...FILLERS_AGGRESSIVE];
  return FILLERS_BALANCED; // balanced default
}

function applyFillerRemoval(text, level) {
  const allFillers = [
    ...FILLERS_LIGHT,                          // always include light base
    ...(level !== LEVELS.LIGHT ? FILLERS_BALANCED : []),
    ...(level === LEVELS.AGGRESSIVE ? FILLERS_AGGRESSIVE : []),
  ];

  // Deduplicate and sort longest-first
  const seen = new Set();
  const sorted = allFillers
    .filter(f => { if (seen.has(f)) return false; seen.add(f); return true; })
    .sort((a, b) => b.length - a.length);

  const multi  = sorted.filter(f => f.includes(' '));
  const single = sorted.filter(f => !f.includes(' '));

  // Multi-word: one fresh regex per phrase, capturing leading boundary
  for (const phrase of multi) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp('(^|[\\s])' + esc + '(?=$|[\\s,.!?;:])', 'gi');
    text = text.replace(re, (_, lead) => lead || ' ');
  }

  // Single-word: one combined pass, plain word boundaries
  if (single.length) {
    const parts = single.map(f => '\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    const re    = new RegExp(parts.join('|'), 'gi');
    text = text.replace(re, ' ');
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

// ── Clean up whitespace and punctuation artifacts ─────────────────────────────

function cleanupText(text) {
  // Collapse runs of spaces/tabs (but not newlines — preserve structure)
  text = text.replace(/[ \t]{2,}/g, ' ');
  // Trim each line
  text = text.split('\n').map(l => l.trim()).join('\n');
  // Collapse 3+ blank lines → 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // Remove space before punctuation: "word ," → "word,"
  text = text.replace(/\s+([,.!?;:])/g, '$1');
  // Collapse double punctuation: ",." → "."  but preserve "..." ellipsis
  text = text.replace(/([,.!?;:])(?!\.\.)([,.!?;:])+/g, '$1');
  // Remove lone comma or semicolon left at the start of a sentence
  text = text.replace(/(^|[.!?]\s+)[,;]\s*/g, '$1');
  // Capitalise first letter of each sentence (may have been lowercased by removal)
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());

  return text.trim();
}

// ── Main optimizer pipeline ────────────────────────────────────────────────────

function optimizePrompt(text, options = {}) {
  const level    = options.level || LEVELS.BALANCED;
  const minChars = (GENERATOR_GUIDANCE && GENERATOR_GUIDANCE.minLengthToOptimize) || 5;
  const minRatio = (GENERATOR_GUIDANCE && GENERATOR_GUIDANCE.minRetainRatio) || 0.3;

  if (!text || text.length < minChars) return (text || '').trim();

  // 1. Protect sensitive segments
  const { text: safe, segs } = protect(text);

  // 2. Phrase replacements (verbose → concise)
  let out = applyPhraseReplacements(safe, level);

  // 3. Structural compression rules (balanced + aggressive only — light is already concise)
  if (level !== LEVELS.LIGHT) {
    out = applyCompressionRules(out);
  }

  // 4. Filler word/phrase removal
  out = applyFillerRemoval(out, level);

  // 5. Fix whitespace and punctuation
  out = cleanupText(out);

  // 6. Restore protected segments
  out = restore(out, segs);

  // Safety net: if we over-compressed, return original trimmed
  if (!out || out.length < text.length * minRatio) return text.trim();

  return out;
}

// ── Savings calculations ───────────────────────────────────────────────────────

function calculateSavings(original, optimized) {
  const words     = t => (t.trim().match(/\S+/g) || []).length;
  const origWords = words(original);
  const optWords  = words(optimized);
  const removed   = Math.max(0, origWords - optWords);
  const pctOff    = origWords > 0 ? Math.round((removed / origWords) * 100) : 0;

  // 1 token ≈ 4 chars (tiktoken approximation for English)
  const tok    = t => Math.ceil(t.length / 4);
  const origTok = tok(original);
  const optTok  = tok(optimized);
  const tokSaved = Math.max(0, origTok - optTok);

  const energyWh  = tokSaved * WH_PER_TOKEN;
  const waterL    = energyWh * KWH_PER_WH * LITERS_WATER_PER_KWH;
  const co2g      = energyWh * KWH_PER_WH * G_CO2_PER_KWH;

  return {
    originalWords:   origWords,
    optimizedWords:  optWords,
    wordsRemoved:    removed,
    percentReduction: pctOff,
    originalTokens:  origTok,
    optimizedTokens: optTok,
    tokensSaved:     tokSaved,
    energySavedWh:   energyWh,
    waterSavedLiters: waterL,
    co2SavedGrams:   co2g,
  };
}

function getOptimizationStats(text, options = {}) {
  const optimized = optimizePrompt(text, options);
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
  LEVELS,
};
