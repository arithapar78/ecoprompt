// lib/prompt-rules-db.js
// Internal database for the prompt generator.
// Exports: FILLER_WORDS (array), COMPRESSION_RULES (array), GENERATOR_GUIDANCE (object)
//
// Caveman-inspired additions (research/caveman/caveman-activate.md):
//   - Expanded every category with phrases from the EcoPrompt task specification
//   - Organized by category for easy auditing and future editing
//   - Safe removal only: do not strip words that carry meaning

// ── Filler words & phrases to remove (BALANCED level) ─────────────────────────
// Used by prompt-generator.js (legacy) and prompt-optimizer.js (new).
// Rules:
//  - Match whole words only (word boundaries) to avoid partial replacements
//  - Case-insensitive matching
//  - Listed by category for easy editing; longest phrases first within each group

// FILLER_WORDS is used only by the legacy fallback in prompt-generator.js.
// The main optimizer (prompt-optimizer.js) uses FILLERS_LIGHT/BALANCED/AGGRESSIVE instead.
// This list mirrors FILLERS_LIGHT + FILLERS_BALANCED — balanced is the fallback default.
const FILLER_WORDS = [

  // ── Greetings ─────────────────────────────────────────────────────────────────
  'hello there', 'hi there', 'hey there', 'dear assistant',
  'good morning', 'good afternoon', 'good evening', 'good day',
  'hello', 'howdy', 'greetings', 'hey', 'hi',

  // ── Sign-offs ─────────────────────────────────────────────────────────────────
  'thank you so much', 'thanks so much', 'thank you very much',
  'thanks a lot', 'thanks a bunch', 'many thanks',
  'thank you again', 'thanks again',
  'best regards', 'kind regards', 'warm regards',
  'yours truly', 'with appreciation',
  'thank you', 'thanks',
  'much appreciated', 'i appreciate it', 'i really appreciate it',
  'i would appreciate it', 'i would really appreciate it',
  "i'd appreciate it", 'appreciate your help', 'appreciate the help',
  'sincerely', 'regards', 'cheers', 'goodbye',

  // ── Basic softeners ───────────────────────────────────────────────────────────
  'please kindly', 'could you please', 'could you kindly',
  'would you please', 'would you kindly', 'can you please',
  'please', 'pls', 'plz', 'kindly',

  // ── Politeness hedges ─────────────────────────────────────────────────────────
  'sorry to bother you', 'sorry for bothering you',
  'sorry for the trouble', 'sorry for the inconvenience',
  'if it is not too much trouble', "if it's not too much trouble",
  'at your earliest convenience', 'at your convenience',
  'whenever you have time', 'whenever you get a chance',
  'when you get a chance', 'when you have time', 'no rush',
  "if you wouldn't mind", "if you don't mind", 'if you do not mind',
  'if that is okay', "if that's okay", 'if it is okay', "if it's okay",
  "if it's possible", 'if possible',
  'if you could', 'if you can', 'if you would',
  'hope you are well', "hope you're well",
  'hope you are doing well', "hope you're doing well", 'hope all is well',
  'sorry', 'apologies', 'excuse me', 'pardon me',

  // ── Soft openers ──────────────────────────────────────────────────────────────
  'i was really hoping you could', 'i was hoping you could',
  'i am really hoping you could', 'i am hoping you could',
  'i just wanted', 'i wanted',
  "i'd like", 'i would like', "i'd love", 'i would love',
  'i just need', 'i need',
  'so basically', 'so i guess', 'so i think', 'so i was thinking',
  'i was thinking', "i'm thinking", 'i am thinking',
  'i think maybe', 'i sort of feel like', 'i kind of feel like',
  'i have a quick question', 'i have a question',
  'quick question', 'small question',

  // ── Hedging phrases ───────────────────────────────────────────────────────────
  'it would seem', 'it seems that', 'it seems like',
  'it looks like', 'it appears that', 'it appears like',
  'more or less', 'to some extent', 'in some ways', 'in a sense', 'in a way',
  'to a certain extent', 'to a degree', 'for the most part',
  'at times', 'roughly speaking', 'generally speaking', 'broadly speaking',
  "i'd say", 'i would say', 'i would suggest', 'i would argue', 'i reckon',
  'as you may know', 'as you probably know', 'as you know', 'as we know',
  'i may be wrong but', 'i could be wrong but',
  "correct me if i'm wrong",
  'not sure if this makes sense but',
  'this might be dumb but', 'this may be a silly question but',
  'basically what i need is',

  // ── Throat-clearing ───────────────────────────────────────────────────────────
  'it goes without saying', 'suffice it to say',
  'first and foremost', 'first of all', 'last but not least',
  'to begin with', 'to start with', 'to start off',
  'by the way', 'the bottom line is', "here's the thing", 'the main point is',
  'the point is', 'the key thing is', 'the important thing is',

  // ── Single-word intensifiers (safe) ───────────────────────────────────────────
  'just', 'really', 'very',
  'simply', 'basically', 'essentially', 'fundamentally',
  'actually', 'literally', 'honestly', 'frankly', 'truly', 'genuinely',
  'quite', 'fairly', 'rather', 'somewhat', 'slightly',
  'obviously', 'clearly', 'certainly', 'definitely',
  'absolutely', 'totally', 'completely', 'utterly', 'entirely', 'fully',
  'ultimately',
  // Weak qualifiers
  'arguably', 'presumably', 'supposedly', 'allegedly', 'reportedly', 'apparently',
  // Connectors
  'additionally', 'furthermore', 'moreover',
  'incidentally',
];

// ── Structural compression rules ──────────────────────────────────────────────
// Applied BEFORE filler removal, in order.
// Each rule: { pattern: RegExp, replacement: string|Function, note: string }
//
// Rules are conservative: compress structure only when meaning survives intact.
// No synonym swaps, no creative rewrites.

const COMPRESSION_RULES = [

  // ── Comparative constructions ─────────────────────────────────────────────────
  { pattern: /\bthe more ([^,\.]+?),\s*the more ([^,\.]+)/gi,  replacement: 'More $1 means more $2',  note: '"the-more…the-more" compression' },
  { pattern: /\bthe more ([^,\.]+?),\s*the less ([^,\.]+)/gi,  replacement: 'More $1 means less $2',  note: '"the-more…the-less"' },
  { pattern: /\bthe less ([^,\.]+?),\s*the more ([^,\.]+)/gi,  replacement: 'Less $1 means more $2',  note: '"the-less…the-more"' },

  // ── Relative clause simplification ───────────────────────────────────────────
  { pattern: /\bthat you\b/gi,                                  replacement: 'you',                    note: 'drop "that" before "you"' },
  { pattern: /\b(?:which|that) is (\w+)(?=[,\.\s]|$)/gi,       replacement: '$1',                     note: '"which/that is ADJ" → ADJ' },

  // ── Ability / modal verbosity ──────────────────────────────────────────────────
  { pattern: /\byou will be able to\b/gi,   replacement: 'you can',   note: '"you will be able to" → "you can"' },
  { pattern: /\byou are able to\b/gi,       replacement: 'you can',   note: '"you are able to" → "you can"' },
  { pattern: /\bwill be able to\b/gi,       replacement: 'can',       note: '"will be able to" → "can"' },
  { pattern: /\bwas able to\b/gi,           replacement: 'could',     note: '"was able to" → "could"' },
  { pattern: /\bare able to\b/gi,           replacement: 'can',       note: '"are able to" → "can"' },
  { pattern: /\bis able to\b/gi,            replacement: 'can',       note: '"is able to" → "can"' },

  // ── "There is/are" expletive ──────────────────────────────────────────────────
  { pattern: /\bThere (?:is|are) (a|an|the) (\w+) that\b/gi,   replacement: '$1 $2 that',   note: '"There is/are [art] [noun] that" → collapse' },
  { pattern: /\bThere (?:is|are) no\b/gi,                       replacement: 'No',           note: '"There is/are no" → "No"' },

  // ── Wordy prepositions & conjunctions ────────────────────────────────────────
  { pattern: /\bin the event that\b/gi,         replacement: 'if',       note: '"in the event that" → "if"' },
  { pattern: /\bin the event of\b/gi,           replacement: 'if',       note: '"in the event of" → "if"' },
  { pattern: /\bprior to\b/gi,                  replacement: 'before',   note: '"prior to" → "before"' },
  { pattern: /\bsubsequent to\b/gi,             replacement: 'after',    note: '"subsequent to" → "after"' },
  { pattern: /\bin spite of the fact that\b/gi, replacement: 'although', note: '"in spite of the fact that" → "although"' },
  { pattern: /\bdespite the fact that\b/gi,     replacement: 'although', note: '"despite the fact that" → "although"' },
  { pattern: /\bat this point in time\b/gi,     replacement: 'now',      note: '"at this point in time" → "now"' },
  { pattern: /\bat the present time\b/gi,       replacement: 'now',      note: '"at the present time" → "now"' },
  { pattern: /\bon a (\w+) basis\b/gi,          replacement: '$1',       note: '"on a X basis" → "X"' },

  // ── Wordy verb constructions ──────────────────────────────────────────────────
  { pattern: /\bmake use of\b/gi,               replacement: 'use',          note: '"make use of" → "use"' },
  { pattern: /\bmake a decision\b/gi,           replacement: 'decide',       note: '"make a decision" → "decide"' },
  { pattern: /\bcome to a conclusion\b/gi,      replacement: 'conclude',     note: '"come to a conclusion" → "conclude"' },
  { pattern: /\btake into consideration\b/gi,   replacement: 'consider',     note: '"take into consideration" → "consider"' },
  { pattern: /\bgive consideration to\b/gi,     replacement: 'consider',     note: '"give consideration to" → "consider"' },
  { pattern: /\bprovide an explanation for\b/gi,replacement: 'explain',      note: '"provide an explanation for" → "explain"' },
  { pattern: /\bconduct an investigation\b/gi,  replacement: 'investigate',  note: '"conduct an investigation" → "investigate"' },
  { pattern: /\bperform an analysis\b/gi,       replacement: 'analyze',      note: '"perform an analysis" → "analyze"' },

  // ── Tautological pairs ────────────────────────────────────────────────────────
  { pattern: /\beach and every\b/gi,   replacement: 'every',    note: '"each and every" → "every"' },
  { pattern: /\bany and all\b/gi,      replacement: 'all',      note: '"any and all" → "all"' },
  { pattern: /\bfull and complete\b/gi,replacement: 'complete', note: '"full and complete" → "complete"' },
  { pattern: /\btrue and accurate\b/gi,replacement: 'accurate', note: '"true and accurate" → "accurate"' },
  { pattern: /\bnull and void\b/gi,    replacement: 'void',     note: '"null and void" → "void"' },

  // ── Vague quantity phrases ─────────────────────────────────────────────────────
  { pattern: /\ba large number of\b/gi,replacement: 'many',    note: '"a large number of" → "many"' },
  { pattern: /\ba number of\b/gi,      replacement: 'several', note: '"a number of" → "several"' },
  { pattern: /\ba small number of\b/gi,replacement: 'a few',   note: '"a small number of" → "a few"' },
  { pattern: /\ba wide variety of\b/gi,replacement: 'various', note: '"a wide variety of" → "various"' },
  { pattern: /\ba wide range of\b/gi,  replacement: 'various', note: '"a wide range of" → "various"' },

  // ── Hollow intensifiers with structure ────────────────────────────────────────
  { pattern: /\bthe fact that\b/gi,        replacement: 'that',    note: '"the fact that" → "that"' },
  { pattern: /\bIt is (\w+) that\b/gi,     replacement: '$1:',     note: '"It is X that" → "X:"' },
  { pattern: /\bthe reason why\b/gi,       replacement: 'why',     note: '"the reason why" → "why"' },
  { pattern: /\bthe reason that\b/gi,      replacement: 'why',     note: '"the reason that" → "why"' },
  { pattern: /\bwhether or not\b/gi,       replacement: 'whether', note: '"whether or not" → "whether"' },

  // ── Modal + actually ──────────────────────────────────────────────────────────
  { pattern: /\bcan actually\b/gi,   replacement: 'can',   note: '"can actually" → "can"' },
  { pattern: /\bcould actually\b/gi, replacement: 'could', note: '"could actually" → "could"' },
  { pattern: /\bwill actually\b/gi,  replacement: 'will',  note: '"will actually" → "will"' },
  { pattern: /\bdo actually\b/gi,    replacement: 'do',    note: '"do actually" → "do"' },

  // ── Drop "the" before comparative adjectives ──────────────────────────────────
  { pattern: /\bthe (higher|lower|greater|fewer|larger|smaller|longer|shorter|faster|slower)\b/gi, replacement: '$1', note: 'drop "the" before comparative adjective' },

  // ── Redundant relative openers ────────────────────────────────────────────────
  { pattern: /,\s*which means that\b/gi, replacement: ', meaning', note: '", which means that" → ", meaning"' },
  { pattern: /,\s*which means\b/gi,      replacement: ', meaning', note: '", which means" → ", meaning"' },

  // ── Hollow purpose / result phrases ──────────────────────────────────────────
  { pattern: /\bin order for\b/gi,           replacement: 'for',      note: '"in order for" → "for"' },
  { pattern: /\bso as to\b/gi,               replacement: 'to',       note: '"so as to" → "to"' },
  { pattern: /\bthe process of (\w+ing)\b/gi,replacement: '$1',       note: '"the process of Xing" → "Xing"' },
  { pattern: /\bthe act of (\w+ing)\b/gi,    replacement: '$1',       note: '"the act of Xing" → "Xing"' },

  // ── Filler connector ─────────────────────────────────────────────────────────
  { pattern: /\b(\w+) as well as\b/gi, replacement: '$1 and', note: '"X as well as" → "X and"' },
];

// ── Generator guidance ─────────────────────────────────────────────────────────
// Controls how the legacy optimizePrompt() in prompt-generator.js applies rules.
// Also consumed by prompt-optimizer.js for the safety-net minRetainRatio check.

const GENERATOR_GUIDANCE = {
  wholeWordOnly:       true,
  caseInsensitive:     true,
  cleanupWhitespace:   true,
  minLengthToOptimize: 5,
  // If optimized result is shorter than this fraction of original, revert.
  minRetainRatio:      0.3,
  collapseNewlines:    true,
};
