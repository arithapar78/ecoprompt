// lib/prompt-generator.js
// Role: optimize a user-supplied prompt.
//
// PRESERVED behavior:
//   - optimizePrompt(text) — backwards-compatible single-argument call
//   - Uses COMPRESSION_RULES and FILLER_WORDS from prompt-rules-db.js
//
// NEW behavior (Caveman-style, wired through prompt-optimizer.js):
//   - optimizePrompt(text, options) — optional { level } parameter
//   - Delegates to window.EcoPromptOptimizer when available, falls back to
//     the original two-pass pipeline for environments where prompt-optimizer.js
//     isn't loaded yet (e.g. service worker context).
//
// Depends on: prompt-rules-db.js (loaded first), prompt-optimizer.js (loaded after)

// ── Legacy two-pass pipeline (kept as fallback) ────────────────────────────────

function buildFillerRegex() {
  const sorted = [...FILLER_WORDS].sort((a, b) => b.length - a.length);
  const flags = GENERATOR_GUIDANCE.caseInsensitive ? 'gi' : 'g';
  const parts = sorted.map(phrase => {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (esc.includes(' ')) {
      return `(?<=\\s|^)${esc}(?=\\s|[,.!?;:]|$)`;
    }
    return `\\b${esc}\\b`;
  });
  return new RegExp(parts.join('|'), flags);
}

const _fillerRegex = buildFillerRegex();

function applyCompressionRules(text) {
  for (const rule of COMPRESSION_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  return text;
}

function applyFillerRemoval(text) {
  return text.replace(_fillerRegex, ' ');
}

function cleanupText(text) {
  const guidance = GENERATOR_GUIDANCE;
  if (guidance.cleanupWhitespace) {
    text = text.replace(/[ \t]{2,}/g, ' ');
    text = text.split('\n').map(l => l.trim()).join('\n');
  }
  if (guidance.collapseNewlines) {
    text = text.replace(/\n{3,}/g, '\n\n');
  }
  text = text.replace(/\s+([,.!?;:])/g, '$1');
  text = text.replace(/([,.!?;:]){2,}/g, '$1');
  text = text.replace(/(^|\.\s+)[,;]\s*/g, '$1');
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
  return text.trim();
}

// ── Public entry point ─────────────────────────────────────────────────────────
// Delegates to EcoPromptOptimizer when loaded; falls back to legacy pipeline.

/**
 * Optimize a prompt.
 *
 * @param {string} originalPrompt
 * @param {object} [options]
 * @param {string} [options.level='balanced']  'light' | 'balanced' | 'aggressive'
 * @returns {string}
 */
function optimizePrompt(originalPrompt, options = {}) {
  // Delegate to the richer optimizer when available
  if (typeof window !== 'undefined' && window.EcoPromptOptimizer) {
    return window.EcoPromptOptimizer.optimizePrompt(originalPrompt, options);
  }

  // Legacy fallback (balanced only, no protection pass)
  const guidance = GENERATOR_GUIDANCE;
  if (!originalPrompt || originalPrompt.length < guidance.minLengthToOptimize) {
    return (originalPrompt || '').trim();
  }

  let result = originalPrompt;
  result = applyCompressionRules(result);
  result = applyFillerRemoval(result);
  result = cleanupText(result);

  if (result.length === 0 || result.length < originalPrompt.length * guidance.minRetainRatio) {
    return originalPrompt.trim();
  }

  return result;
}
