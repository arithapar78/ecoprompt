// Every optimizer engine returns the same shape. Today: 'rules' only.
// Later a small local model can be added as engine 'local-llm' without
// touching the UI.
//
// Returns { engine, original, optimized, savings, ms }
//   savings = window.EcoPromptOptimizer.calculateSavings(original, optimized)
//   ms      = time the optimize call took, so the UI can later show
//             "energy spent optimizing" next to "energy saved".

import { log } from './log.js';

const ENGINES = {
  rules: async (text) => window.EcoPromptOptimizer.optimizePrompt(text),
  // TODO(local-llm): 'local-llm': async (text) => ...
};

export async function optimize(text, { engine = 'rules' } = {}) {
  const run = ENGINES[engine];
  if (!run) throw new Error(`Unknown optimizer engine: ${engine}`);

  const original = String(text ?? '');
  const t0 = performance.now();
  const optimized = await run(original);
  const ms = performance.now() - t0;
  const savings = window.EcoPromptOptimizer.calculateSavings(original, optimized);

  // Never log the prompt text, only counts.
  log.debug('[engine] ' + JSON.stringify({ engine, ms: Math.round(ms * 100) / 100, tokensSaved: savings.tokensSaved }));
  return { engine, original, optimized, savings, ms };
}
