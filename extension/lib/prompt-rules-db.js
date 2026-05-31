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

const FILLER_WORDS = [

  // ── Greetings / salutations ──────────────────────────────────────────────────
  'hello there', 'hi there', 'hey there',
  'dear assistant',
  'good morning', 'good afternoon', 'good evening', 'good day',
  'hi', 'hey', 'hello', 'howdy', 'greetings',
  'dear sir', 'dear madam', 'dear',

  // ── Sign-offs / closings ─────────────────────────────────────────────────────
  'thank you so much', 'thanks so much', 'thank you very much',
  'much appreciated', 'many thanks', 'thanks a lot', 'thanks a bunch',
  'thanks again', 'thank you again',
  'thank you', 'thanks',
  'bye', 'goodbye', 'cheers',
  'sincerely', 'regards', 'best regards', 'kind regards', 'warm regards',
  'yours truly', 'with appreciation',
  'i appreciate it', 'i would appreciate it', 'i would really appreciate it',

  // ── Politeness / softeners ───────────────────────────────────────────────────
  'sorry to bother you', 'sorry for the trouble', 'sorry for the inconvenience',
  'apologies', 'my apologies', 'excuse me', 'pardon me',
  'if it is not too much trouble', 'if it\'s not too much trouble',
  'at your earliest convenience', 'at your convenience',
  'whenever you have time', 'when you get a chance', 'when you have time',
  'whenever you get a chance',
  'if you wouldn\'t mind', 'if you don\'t mind',
  'if that is okay', 'if that\'s okay',
  'if it\'s possible', 'if possible',
  'feel free to', 'don\'t hesitate to',
  'if you could', 'if you can',
  'hope you are well', 'hope you\'re doing well', 'hope all is well',
  'i hope you can',
  'please kindly', 'could you please', 'could you kindly',
  'would you please', 'would you kindly',
  'can you please', 'may you please',
  'please', 'kindly',

  // ── Weak openers / meta-requests ─────────────────────────────────────────────
  'i was really hoping you could', 'i was hoping you could',
  'i am asking you to', 'i wanted to ask', 'i just wanted to ask',
  'i\'m reaching out because', 'i am reaching out because',
  'i need your help with', 'i would like your help with',
  'i am writing to', 'i am reaching out to',
  'i wanted to know if', 'i want to know if',
  'i would like to know if', 'i\'d like to know if',
  'i\'m trying to figure out', 'i am trying to figure out',
  'i was trying to figure out',
  'i\'m looking to', 'i am looking to',
  'i\'m hoping to', 'i am hoping to', 'i was hoping to',
  'i was wondering if', 'i am wondering if', 'i\'m wondering if',
  'i wanted to', 'i\'d like to', 'i would like to', 'i would love to',
  'i need to know', 'i just need to know',
  'i\'m curious about', 'i am curious about',
  'i have a question about', 'my question is', 'what i want to ask is',
  'what i\'m trying to ask is', 'the thing is', 'basically what i need is',

  // ── Filler / meaningless openers ────────────────────────────────────────────
  'so basically', 'so i guess', 'so i was thinking',
  'i think maybe', 'i sort of feel like', 'i kind of feel like',
  'it seems like', 'it looks like', 'it appears that',
  'i may be wrong but', 'i could be wrong but',
  'correct me if i\'m wrong',
  'not sure if this makes sense but',
  'this might be dumb but', 'this may be a silly question but',

  // ── Hedging / uncertainty markers (balanced) ─────────────────────────────────
  // NOTE: aggressive level adds more via FILLER_AGGRESSIVE_EXTRA in prompt-optimizer.js
  'it would seem', 'it seems that',
  'i would say', 'i\'d say',
  'more or less', 'to some extent', 'in some ways', 'in a sense', 'in a way',
  'to a certain extent', 'to a degree',
  'roughly speaking', 'generally speaking', 'broadly speaking',
  'i reckon', 'i would argue', 'i would suggest',
  'as you may know', 'as you probably know', 'as you know', 'as we know',
  'it seems', 'it appears',
  'i feel', 'i suppose', 'i guess', 'i mean',
  'you know', 'you see',
  'i think', 'i believe',
  'i would say',

  // ── Filler intensifiers ──────────────────────────────────────────────────────
  'a little bit', 'just a little', 'just a bit', 'a tad',
  'ever so slightly', 'marginally', 'nominally',
  'kind of', 'sort of', 'kinda', 'sorta',
  'in a way', 'in some ways', 'to some extent',
  'just', 'simply', 'basically', 'essentially', 'fundamentally',
  'actually', 'literally', 'honestly', 'truly', 'genuinely',
  'really', 'very', 'quite', 'pretty', 'fairly', 'rather',
  'somewhat', 'slightly', 'a little', 'a bit',
  'of course', 'obviously', 'clearly', 'certainly', 'definitely',
  'absolutely', 'totally', 'completely', 'utterly', 'entirely',

  // ── Weak qualifiers ──────────────────────────────────────────────────────────
  'arguably', 'presumably', 'supposedly', 'allegedly', 'reportedly', 'apparently',

  // ── Throat-clearing / meta-commentary ───────────────────────────────────────
  'it goes without saying', 'suffice it to say', 'needless to say',
  'at the end of the day', 'when all is said and done', 'all things considered',
  'on that note', 'with that said', 'that being said', 'having said that', 'that said',
  'all in all', 'in any case', 'in any event', 'in the end', 'at the end',
  'first of all', 'first and foremost', 'last but not least',
  'to begin with', 'to start with', 'to start off',
  'by the way', 'incidentally',
  'in other words', 'to put it another way', 'to put it simply', 'to put it differently',
  'long story short', 'to make a long story short',
  'the bottom line is', 'the thing is', 'here\'s the thing', 'the point is',
  'the main point is',
  'so', 'well', 'okay', 'ok', 'alright', 'right',

  // ── Redundant openers / request preambles ────────────────────────────────────
  'do you think you could', 'will you', 'can you', 'would you', 'could you',
  'i need you to', 'i want you to',
  'can you please', 'could you please', 'would you please',
  'could you kindly', 'would you kindly',

  // ── Padding phrases / fact-wrappers ──────────────────────────────────────────
  'in order to', 'for the purpose of', 'with the aim of',
  'with the goal of', 'with the intention of', 'in an effort to', 'in a bid to',
  'due to the fact that', 'owing to the fact that',
  'in light of the fact that', 'given the fact that',
  'as a matter of fact', 'in point of fact',
  'it is worth noting that', 'it is important to note that',
  'it should be noted that', 'it is worth mentioning that',
  'ultimately',

  // ── Filler connectors ────────────────────────────────────────────────────────
  'and so', 'and also', 'and then',
  'as well as', 'as well', 'too', 'also',
  'additionally', 'furthermore', 'moreover',
  'in addition', 'in addition to that', 'on top of that',
  'not only that', 'along with that',

  // ── Empty courtesy phrases ────────────────────────────────────────────────────
  'no problem', 'no worries', 'sure thing', 'go ahead', 'feel free',
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
