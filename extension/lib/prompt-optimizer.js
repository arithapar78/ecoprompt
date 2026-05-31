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
// Loaded after: prompt-rules-db.js (provides COMPRESSION_RULES, GENERATOR_GUIDANCE)
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
  () => /"[^"\n]*"|'[^'\n]*'/g,                                                    // quoted strings
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

// ── Phrases to delete ──────────────────────────────────────────────────────────
// Every entry is deleted unconditionally.
// Sorted longest-first at apply time so longer phrases match before sub-phrases.

const PHRASES_TO_DELETE = [
  // Fact wrappers
  'in spite of the fact that',
  'despite the fact that',
  'in light of the fact that',
  'because of the fact that',
  'owing to the fact that',
  'due to the fact that',
  'given the fact that',
  'based on the fact that',
  'considering the fact that',
  // About-synonyms
  'concerning the matter of',
  'regarding the matter of',
  'with reference to',
  'with regard to',
  'with respect to',
  'in relation to',
  'pertaining to',
  'in connection with',
  'as far as this is concerned',
  'when it comes to',
  'in terms of',
  // Time verbosity
  'at this point in time',
  'at the present time',
  'at the current time',
  'currently right now',
  'as of right now',
  // Conditional verbosity
  'in the event that',
  'in the case that',
  'in the situation where',
  'under circumstances where',
  // Time prepositions
  'subsequent to',
  'prior to',
  'over the course of',
  'during the course of',
  'throughout the course of',
  // Purpose prepositions
  'in order for',
  'for the purpose of',
  'for purposes of',
  'with the aim of',
  'with the goal of',
  'with the intention of',
  'in an effort to',
  'in a bid to',
  'so as to',
  'in order to',
  'in the process of',
  // Quantity verbosity
  'a large number of',
  'a wide variety of',
  'a wide range of',
  'a small number of',
  'a number of',
  'many different',
  'various different',
  'different kinds of',
  'different types of',
  'all kinds of',
  'a lot of',
  'lots of',
  'tons of',
  'plenty of',
  // Tautologies
  'completely eliminate',
  'totally remove',
  'exactly identical',
  'same exact',
  'exact same',
  'combine together',
  'merge together',
  'join together',
  'connect together',
  'collaborate together',
  'return back',
  'revert back',
  'repeat again',
  'continue on',
  'summarize briefly',
  'briefly summarize',
  'general consensus',
  'close proximity',
  'advance planning',
  'added bonus',
  'free gift',
  'end result',
  'final outcome',
  'future plans',
  'past history',
  'null and void',
  'true and accurate',
  'full and complete',
  'any and all',
  'each and every',
  'first and foremost',
  'basic fundamentals',
  'basic essentials',
  'important essentials',
  'necessary requirements',
  'true facts',
  'actual facts',
  'personal opinion',
  'unexpected surprise',
  'new innovation',
  'small little',
  'large big',
  'new beginning',
  'still remains',
  'whether or not',
  'reason why',
  'the reason is because',
  // Meta-commentary
  'it is important to note that',
  'it is worth mentioning that',
  'it is worth noting that',
  'it should be noted that',
  'it is also important to note',
  'it goes without saying that',
  'it goes without saying',
  'needless to say,',
  'needless to say',
  'with that being said,',
  'with that being said',
  'having said that,',
  'having said that',
  'that being said,',
  'that being said',
  'as a matter of fact,',
  'as a matter of fact',
  "for what it's worth,",
  "for what it's worth",
  'for what its worth,',
  'for what its worth',
  'to be perfectly honest,',
  'to be perfectly honest',
  'to be honest,',
  'to be honest',
  'to tell the truth,',
  'to tell the truth',
  'truth be told,',
  'truth be told',
  'in all honesty,',
  'in all honesty',
  'to be fair,',
  'to be fair',
  'frankly speaking,',
  'frankly speaking',
  'the fact that',
  'one thing to note is',
  'keep in mind that',
  'bear in mind that',
  'remember that',
  'as a reminder,',
  'as a reminder',
  // Weak openers
  'i was really hoping you could',
  'i was hoping you could',
  'i am really hoping you could',
  'i am hoping you could',
  'i would really appreciate it if you could',
  'i would really appreciate it if',
  'i would appreciate it if you could',
  'i would appreciate it if',
  "i'd really appreciate it if you could",
  "i'd really appreciate it if",
  "i'd appreciate it if you could",
  "i'd appreciate it if",
  'i would really appreciate your help with',
  'i would appreciate your help with',
  'appreciate your help with',
  'appreciate the help with',
  'i would like you to',
  "i'd like you to",
  'i need you to',
  'i want you to',
  'could you please help me',
  'can you please help me',
  'would you please help me',
  'could you help me',
  'can you help me',
  'would you help me',
  'please help me',
  'i need help with',
  'i would like help with',
  'i want help with',
  'provide assistance with',
  'assist me with',
  'help me with',
  'help me',
  'i am asking you to',
  "i'm asking you to",
  'i request',
  'i am requesting',
  'i would request',
  'my request is',
  'the request is',
  "i'm reaching out because",
  'i am reaching out because',
  "i'm reaching out to",
  'i am reaching out to',
  "i'm writing to",
  'i am writing to',
  'i wanted to ask',
  'i just wanted to ask',
  'i wanted to know',
  'i just wanted to know',
  'i need your help with',
  'i would like your help with',
  'i was wondering if you could',
  'i was wondering if',
  'i am wondering if',
  "i'm wondering if",
  "i'm looking to",
  'i am looking to',
  "i'm trying to figure out",
  'i am trying to figure out',
  'i was trying to figure out',
  "i'm hoping to",
  'i am hoping to',
  'i was hoping to',
  "i'd like to know if",
  'i would like to know if',
  'i wanted to know if',
  'i want to know if',
  'i have a quick question about',
  'i have a question about',
  'my question is',
  'the question is',
  'what i want to ask is',
  "what i'm trying to ask is",
  'what i am trying to ask is',
  "what i'm asking is",
  'what i am asking is',
  "i'm curious about",
  'i am curious about',
  'i was curious about',
  'i need to know',
  'i just need to know',
  'basically what i need is',
  'basically what i want is',
  'what i really need is',
  'what i really want is',
  // Soft uncertain openers
  'not sure if this makes sense but',
  "i don't know if this makes sense but",
  'this might be a silly question but',
  'this may be a silly question but',
  'this might be dumb but',
  'this may be dumb but',
  "correct me if i'm wrong but",
  "correct me if i'm wrong",
  'i could be wrong but',
  'i may be wrong but',
  // Action wrappers
  'please ensure that',
  'please make sure that',
  'really make sure that',
  'also make sure that',
  'i want to make sure that',
  'try to make sure that',
  'make sure to',
  'be sure to',
  "don't forget to",
  'do not forget to',
  'i also need you to include',
  'could you also include',
  'please also include',
  'it would be great if you could include',
  'i would appreciate if you could include',
  'i would love if you could include',
  'in addition, please include',
  'make sure to include',
  'be sure to include',
  'do not forget to include',
  "don't forget to include",
  'ensure that',
  'be certain to',
  'make certain to',
  'do your best to',
  'try to',
  'attempt to',
  // Direct-object "me" padding
  'write me a',
  'create me a',
  'give me a',
  'show me a',
  'draft me a',
  'build me a',
  'make me a',
  'generate me a',
  'write for me',
  'create for me',
  'make for me',
  'draft for me',
  'build for me',
  'generate for me',
  'provide me with',
  'explain to me',
  'tell me about',
  'give me information about',
  'provide information about',
  'provide details about',
  'give me details about',
  'give me a detailed explanation of',
  'write a detailed explanation of',
  // Verbose adjective clusters
  'very detailed and thorough',
  'detailed and comprehensive',
  'comprehensive and detailed',
  'a really detailed explanation',
  'in a way that is really easy to understand',
  'in a way that students can understand',
  'in a way that is easy to understand',
  'clear and easy to understand',
  'simple to understand',
  'easy to understand',
  'understandable for students',
  'educational and engaging',
  // School / audience fluff
  'for a science fair audience',
  'for my science fair',
  'for science fair',
  'for my school project',
  'this is for school',
  'for middle school students',
  'for high school students',
  'for middle school',
  'for high school',
  'suitable for students',
  'appropriate for students',
  'good for students',
  'student friendly',
  'kid friendly',
  'age appropriate',
  'make it educational',
  'make it fun',
  'make it very detailed',
  'make it really detailed',
  'make it really thorough',
  'make it thorough',
  'make it very clear',
  'make it detailed',
  'make it clear',
  'make it interesting',
  'make it engaging',
  // Email / social fluff
  'i hope this email finds you well',
  'hope this finds you well',
  "i hope you're doing well",
  'i hope you are doing well',
  'just checking in',
  'i wanted to follow up',
  'wanted to follow up',
  'following up on',
  'following up',
  'circling back on',
  'just circling back',
  'circling back',
  'touching base on',
  'just touching base',
  'touching base',
  'i wanted to reach out',
  "i'm reaching out",
  'i am reaching out',
  'quick reminder,',
  'quick reminder',
  'friendly reminder,',
  'friendly reminder',
  'gentle reminder,',
  'gentle reminder',
  'quick note,',
  'quick note',
  'looking forward to hearing from you',
  'i look forward to hearing from you',
  'please let me know',
  'let me know',
  'feel free to',
  "don't hesitate to",
  'do not hesitate to',
  'thank you again',
  'thanks again',
  // Weak endings
  'and stuff like that',
  'and things like that',
  'and all that kind of stuff',
  'and all that',
  'or something like that',
  'stuff like that',
  'things like that',
  'that kind of thing',
  'you get the idea',
  'you know what i mean',
  'if that makes sense',
  'hope that makes sense',
  'does that make sense',
  'and so on',
  'and everything',
  'and so forth',
  'or something',
  'or anything',
  'or whatever',
  'and whatever',
  'and stuff',
  'and things',
  // Transitions / throat-clearing
  'to make a long story short,',
  'to make a long story short',
  'long story short,',
  'long story short',
  'at the end of the day,',
  'at the end of the day',
  'when all is said and done,',
  'when all is said and done',
  'all things considered,',
  'all things considered',
  'in the grand scheme of things,',
  'in the grand scheme of things',
  'from the perspective of',
  'from the standpoint of',
  'from the point of view of',
  'in the context of',
  'in addition to that,',
  'in addition to that',
  'on top of that,',
  'on top of that',
  'as you can see,',
  'as you can see',
  'as previously stated,',
  'as previously stated',
  'as stated earlier,',
  'as stated earlier',
  'as mentioned earlier,',
  'as mentioned earlier',
  'as mentioned,',
  'as mentioned',
  'in other words,',
  'in other words',
  'to put it another way,',
  'to put it another way',
  'to put it differently,',
  'to put it differently',
  'to put it simply,',
  'to put it simply',
  'simply put,',
  'simply put',
  'going forward,',
  'going forward',
  'moving forward,',
  'moving forward',
  'on the other hand,',
  'on the other hand',
  'on the flip side,',
  'on the flip side',
  'by the same token,',
  'by the same token',
  'in comparison,',
  'in contrast,',
  // Hedging opinion blocks
  'in my opinion,',
  'in my opinion',
  'from my perspective,',
  'from my perspective',
  'from my point of view,',
  'from my point of view',
  'i think that',
  'i believe that',
  'i feel that',
  'i assume that',
  'i imagine that',
  'i suspect that',
  'as far as i can tell,',
  'as far as i can tell',
  'as best as i can tell,',
  'as best as i can tell',
  // AI-prompt fluff
  'i want you to act as',
  'act as',
  'pretend you are',
  'you are an expert in',
  'you are an expert',
  'as an expert',
  'world-class expert',
  'professional expert',
  'experienced professional',
  'highly skilled',
  "explain like i'm five",
  'explain like i am five',
  'eli5',
  'go step by step',
  'step by step',
  'step-by-step',
  'walk me through',
  'break it down',
  'make it better',
  'make it more professional',
  'make it more clear',
  'make this sound better',
  'make this more professional',
  'make this more clear',
  'make this clearer',
  'make this concise',
  'make this shorter',
  'make this stronger',
  'clean this up',
  'fix this',
  'polish this',
  'refine this',
  'rewrite this',
  'optimize this',
  'improve this',
  'best possible',
  'high quality',
  'top quality',
  'detailed and comprehensive',
  'comprehensive and detailed',
];

// ── Filler words to delete ─────────────────────────────────────────────────────
// Every entry is deleted unconditionally.
// Multi-word entries must come before single-word entries in the pass order
// (handled in deleteFillers — multi applied first, then single combined pass).

const FILLERS = [
  // Greetings (multi-word first, then single)
  'hello there', 'hi there', 'hey there', 'dear assistant',
  'good morning', 'good afternoon', 'good evening', 'good day',
  'hello', 'howdy', 'greetings', 'hey', 'hi',
  // Sign-offs
  'thank you so much', 'thanks so much', 'thank you very much',
  'thanks a lot', 'thanks a bunch', 'many thanks',
  'thank you again', 'thanks again',
  'best regards', 'kind regards', 'warm regards',
  'yours truly', 'with appreciation',
  'thank you', 'thanks',
  'much appreciated', 'i appreciate it', 'i really appreciate it',
  'i would appreciate it', 'i would really appreciate it',
  "i'd appreciate it",
  'appreciate your help', 'appreciate the help',
  'sincerely', 'regards', 'cheers', 'goodbye',
  // Politeness hedges
  'please kindly', 'could you please', 'could you kindly',
  'would you please', 'would you kindly', 'can you please',
  'sorry to bother you', 'sorry for bothering you',
  'sorry for the trouble', 'sorry for the inconvenience',
  'if it is not too much trouble', "if it's not too much trouble",
  'at your earliest convenience', 'at your convenience',
  'whenever you have time', 'whenever you get a chance',
  'when you get a chance', 'when you have time',
  'no rush',
  "if you wouldn't mind", "if you don't mind", 'if you do not mind',
  'if that is okay', "if that's okay", 'if it is okay', "if it's okay",
  "if it's possible", 'if possible',
  'if you could', 'if you can', 'if you would',
  'hope you are well', "hope you're well",
  'hope you are doing well', "hope you're doing well", 'hope all is well',
  'please', 'pls', 'plz', 'kindly',
  'sorry', 'apologies', 'excuse me', 'pardon me',
  // Soft openers
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
  // Hedging phrases
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
  // Throat-clearing
  'it goes without saying', 'suffice it to say',
  'first and foremost', 'first of all', 'last but not least',
  'to begin with', 'to start with', 'to start off',
  'by the way', 'the bottom line is', "here's the thing", 'the main point is',
  'the key thing is', 'the important thing is', 'the point is',
  'you get the idea', 'you know what i mean',
  'you see',
  // Single-word fillers
  'just', 'really', 'very',
  'simply', 'basically', 'essentially', 'fundamentally',
  'actually', 'literally', 'honestly', 'frankly', 'truly', 'genuinely',
  'quite', 'fairly', 'rather', 'somewhat', 'slightly',
  'obviously', 'clearly', 'certainly', 'definitely',
  'absolutely', 'totally', 'completely', 'utterly', 'entirely', 'fully',
  'ultimately',
  'arguably', 'presumably', 'supposedly', 'allegedly', 'reportedly', 'apparently',
  'additionally', 'furthermore', 'moreover',
  'incidentally',
  'maybe', 'perhaps', 'probably', 'possibly', 'potentially',
  'seemingly', 'supposedly', 'somehow', 'presumably',
  'i think', 'i believe', 'i feel', 'i guess', 'i suppose',
  'i assume', 'i imagine', 'i suspect',
  'super', 'extremely', 'incredibly', 'unbelievably', 'amazingly',
  'seriously', 'massively', 'hugely', 'deeply', 'especially', 'particularly',
  'remarkably', 'significantly', 'substantially', 'dramatically',
  'enormously', 'exceptionally', 'extraordinarily', 'intensely',
  'terribly', 'awfully', 'insanely', 'ridiculously', 'wildly',
  'crazy', 'ultra', 'mega', 'majorly',
  'etc', 'anyways', 'anyway',
  'educational', 'engaging', 'comprehensive', 'thorough',
  'roughly', 'approximately', 'nearly', 'almost', 'relatively',
  'typically', 'generally', 'commonly', 'usually', 'often', 'sometimes',
];

// ── Preamble wipe ──────────────────────────────────────────────────────────────
// Erases the full greeting sentence + opener clause in one shot, before any
// word-by-word passes, so no debris ("that you could,") is left behind.

function wipePreamble(text) {
  // 1. Strip a leading greeting sentence ("Hello there! ", "Hi, …")
  text = text.replace(
    /^(hello[\s\S]*?|hi[\s\S]*?|hey[\s\S]*?|good (?:morning|afternoon|evening)[\s\S]*?|dear assistant[\s\S]*?|greetings[\s\S]*?)[.!]\s*/i,
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
    if (m && m.index > 0 && !/[.!?]/.test(text.slice(0, m.index))) {
      text = text.slice(m.index);
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
    const parts = single.map(f => '\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
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
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.split('\n').map(l => l.trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\s+([,.!?;:])/g, '$1');
  text = text.replace(/([,.!?;:])(?!\.\.)([,.!?;:])+/g, '$1');
  text = text.replace(/(^|[.!?]\s+)[,;]\s*/g, '$1');
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
  return text.trim();
}

// ── Main pipeline ──────────────────────────────────────────────────────────────

function optimizePrompt(text) {
  const minChars = (GENERATOR_GUIDANCE && GENERATOR_GUIDANCE.minLengthToOptimize) || 5;
  const minRatio = (GENERATOR_GUIDANCE && GENERATOR_GUIDANCE.minRetainRatio)       || 0.3;

  if (!text || text.length < minChars) return (text || '').trim();

  const { text: safe, segs } = protect(text);        // 1. protect
  let out = wipePreamble(safe);                       // 2. wipe greeting + opener
  out = deletePhrases(out);                           // 3. delete verbose phrases
  out = applyCompressionRules(out);                   // 4. structural compression
  out = deleteFillers(out);                           // 5. delete filler words
  out = cleanDebris(out);                             // 6. remove leftover debris
  out = cleanupText(out);                             // 7. fix spacing/punctuation
  out = restore(out, segs);                           // 8. restore protected content

  if (!out || out.length < text.length * minRatio) return text.trim();
  return out;
}

// ── Savings calculations ───────────────────────────────────────────────────────

function calculateSavings(original, optimized) {
  const words    = t => (t.trim().match(/\S+/g) || []).length;
  const origW    = words(original);
  const optW     = words(optimized);
  const removed  = Math.max(0, origW - optW);
  const pctOff   = origW > 0 ? Math.round((removed / origW) * 100) : 0;

  const tok      = t => Math.ceil(t.length / 4);
  const origTok  = tok(original);
  const optTok   = tok(optimized);
  const tokSaved = Math.max(0, origTok - optTok);

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
