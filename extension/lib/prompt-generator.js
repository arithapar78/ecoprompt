// lib/prompt-generator.js
// Delegates to window.EcoPromptOptimizer (prompt-optimizer.js) when available.
// Falls back to a simple two-pass pipeline for any context where the full
// optimizer hasn't loaded yet (e.g. service worker).
//
// Loaded after: prompt-rules-db.js, prompt-optimizer.js

// ── Legacy fallback pipeline ───────────────────────────────────────────────────

function _buildLegacyFillerStructures() {
  const sorted = [...FILLER_WORDS].sort((a, b) => b.length - a.length);
  const multi = [], singleParts = [];
  for (const phrase of sorted) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    phrase.includes(' ') ? multi.push(esc) : singleParts.push('\\b' + esc + '\\b');
  }
  return {
    multi,
    singleRe: singleParts.length ? new RegExp(singleParts.join('|'), 'gi') : null,
  };
}
const _legacyFillers = _buildLegacyFillerStructures();

function _legacyRemoveFillers(text) {
  for (const esc of _legacyFillers.multi) {
    const re = new RegExp('(^|[\\s])' + esc + '(?=$|[\\s,.!?;:])', 'gi');
    text = text.replace(re, (_, lead) => lead || ' ');
  }
  if (_legacyFillers.singleRe) {
    _legacyFillers.singleRe.lastIndex = 0;
    text = text.replace(_legacyFillers.singleRe, ' ');
  }
  return text;
}

function _legacyCleanup(text) {
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.split('\n').map(l => l.trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\s+([,.!?;:])/g, '$1');
  text = text.replace(/([,.!?;:]){2,}/g, '$1');
  text = text.replace(/(^|\.\s+)[,;]\s*/g, '$1');
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
  return text.trim();
}

// ── Public entry point ─────────────────────────────────────────────────────────

function optimizePrompt(text) {
  if (typeof window !== 'undefined' && window.EcoPromptOptimizer) {
    return window.EcoPromptOptimizer.optimizePrompt(text);
  }

  // Fallback: balanced-equivalent, no protection pass
  const minChars = GENERATOR_GUIDANCE.minLengthToOptimize;
  const minRatio = GENERATOR_GUIDANCE.minRetainRatio;
  if (!text || text.length < minChars) return (text || '').trim();

  let result = text;
  for (const rule of COMPRESSION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  result = _legacyRemoveFillers(result);
  result = _legacyCleanup(result);

  if (!result || result.length < text.length * minRatio) return text.trim();
  return result;
}
