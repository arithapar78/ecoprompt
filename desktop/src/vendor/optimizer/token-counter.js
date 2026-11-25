// lib/token-counter.js
// Simple token estimation: 1 token = 8 characters.

const CHARS_PER_TOKEN = 4;

/**
 * Count tokens for a string.
 * @param {string} text
 * @returns {number} token count (always >= 0)
 */
function countTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Return token stats for an original and optimized prompt pair.
 * @param {string} original
 * @param {string} optimized
 * @returns {{ original: number, optimized: number, saved: number }}
 */
function getTokenStats(original, optimized) {
  const originalTokens = countTokens(original);
  const optimizedTokens = countTokens(optimized);
  return {
    original: originalTokens,
    optimized: optimizedTokens,
    saved: Math.max(0, originalTokens - optimizedTokens),
  };
}
