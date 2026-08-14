// lib/optimizer-ui.js
// Role: the prompt optimizer UI, mounted by BOTH the popup and the Settings
// page. One implementation, two mount points.
//
// Everything user-visible about optimizing lives here: the input, the live
// token count, the Optimize button, the metrics row, the output block, the Copy
// button, and the single backend event per optimize. If the optimizer ever
// behaves differently in the popup than on the Settings page, it is because
// something was reimplemented outside this file — don't.
//
// `variant` may only change LAYOUT ('page' goes side-by-side above ~700px).
// It must never change behaviour, wording, numbers, units, or rounding.
//
// Loaded after: prompt-rules-db.js, token-counter.js, prompt-optimizer.js,
//               prompt-generator.js, api.js

(function () {
  'use strict';

  /** Debounce for the live token count while typing. */
  const TOKEN_DEBOUNCE_MS = 150;

  /** How long the Copy button shows its confirmation. */
  const COPY_FEEDBACK_MS = 1400;

  /**
   * Resolve the optimizer exactly the way the popup did before this module
   * existed: prefer the full optimizer, fall back to prompt-generator.js.
   * Kept as a function (not captured at load) so script order can't freeze in a
   * stale answer.
   */
  function runOptimizer(text) {
    if (typeof window !== 'undefined' && window.EcoPromptOptimizer) {
      return window.EcoPromptOptimizer.getOptimizationStats(text);
    }
    // Fallback: prompt-generator.js's optimizePrompt + the shared savings math.
    const optimized = optimizePrompt(text);
    const stats = typeof calculateSavings === 'function'
      ? calculateSavings(text, optimized)
      : null;
    return { optimized, stats };
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function template(variant) {
    return `
      <div class="eco-opt eco-opt--${esc(variant)}">
        <div class="eco-opt-panes">

          <section class="eco-opt-card eco-opt-input">
            <label class="eco-opt-label" for="eco-opt-input">Your prompt</label>
            <textarea id="eco-opt-input" class="eco-opt-textarea"
                      placeholder="Paste or type your prompt…" rows="6"></textarea>
            <div class="eco-opt-tokenrow">
              <span class="eco-opt-token-label" id="eco-opt-token-label">Tokens</span>
              <span class="eco-opt-token-count" data-eco="live-tokens"
                    aria-live="polite" aria-labelledby="eco-opt-token-label">0</span>
            </div>
            <button type="button" class="eco-opt-btn" data-eco="optimize">Optimize</button>
          </section>

          <section class="eco-opt-card eco-opt-result hidden" data-eco="result"
                   aria-live="polite">
            <div class="eco-opt-outhead">
              <span class="eco-opt-label">Optimized prompt</span>
              <button type="button" class="eco-opt-copy" data-eco="copy">Copy</button>
            </div>
            <div class="eco-opt-output" data-eco="output"></div>

            <div class="eco-opt-statgrid">
              <div class="eco-opt-stat">
                <span class="eco-opt-stat-label">Original</span>
                <span class="eco-opt-stat-value" data-eco="tok-before">—</span>
              </div>
              <div class="eco-opt-stat">
                <span class="eco-opt-stat-label">Optimized</span>
                <span class="eco-opt-stat-value" data-eco="tok-after">—</span>
              </div>
              <div class="eco-opt-stat eco-opt-stat--accent">
                <span class="eco-opt-stat-label">Tokens saved</span>
                <span class="eco-opt-stat-value" data-eco="tok-saved">—</span>
              </div>
              <div class="eco-opt-stat eco-opt-stat--accent">
                <span class="eco-opt-stat-label">Reduction</span>
                <span class="eco-opt-stat-value" data-eco="reduction">—</span>
              </div>
              <div class="eco-opt-stat eco-opt-stat--wide">
                <span class="eco-opt-stat-label">Words removed</span>
                <span class="eco-opt-stat-value" data-eco="words-removed">—</span>
              </div>
            </div>

            <div class="eco-opt-savings">
              <span class="eco-opt-label">Estimated savings per query</span>
              <ul class="eco-opt-datalist">
                <li class="eco-opt-datarow">
                  <span class="eco-opt-datarow-label">Energy</span>
                  <span class="eco-opt-datarow-value">
                    <span data-eco="energy">—</span>
                    <span class="eco-opt-unit" data-eco="energy-unit">Wh</span>
                  </span>
                </li>
                <li class="eco-opt-datarow">
                  <span class="eco-opt-datarow-label">Water</span>
                  <span class="eco-opt-datarow-value">
                    <span data-eco="water">—</span> <span class="eco-opt-unit">mL</span>
                  </span>
                </li>
                <li class="eco-opt-datarow">
                  <span class="eco-opt-datarow-label">CO₂</span>
                  <span class="eco-opt-datarow-value">
                    <span data-eco="co2">—</span> <span class="eco-opt-unit">mg</span>
                  </span>
                </li>
              </ul>
            </div>
          </section>

        </div>
      </div>`;
  }

  /**
   * Format the environmental figures. These conversions and rounding rules are
   * the popup's originals and are the single source of truth for both surfaces —
   * changing one here changes both, which is the point.
   */
  function formatSavings(stats) {
    // Energy: µWh below 1 mWh, else Wh — the unit label switches with it.
    const wh = stats.energySavedWh;
    const energyValue = wh < 0.001 ? (wh * 1000).toFixed(4) : wh.toFixed(6);
    const energyUnit  = wh < 0.001 ? 'µWh' : 'Wh';

    return {
      energyValue,
      energyUnit,
      water: (stats.waterSavedLiters * 1000).toFixed(4),   // L → mL
      co2:   (stats.co2SavedGrams * 1000).toFixed(3),      // g → mg
    };
  }

  window.EcoPromptOptimizerUI = {
    /**
     * Render the optimizer into rootEl.
     * @param {HTMLElement} rootEl
     * @param {{ variant?: 'popup'|'page', logEvents?: boolean }} [opts]
     * @returns {{ destroy: () => void }}
     */
    mount(rootEl, opts = {}) {
      const variant   = opts.variant === 'page' ? 'page' : 'popup';
      const logEvents = opts.logEvents !== false;

      rootEl.innerHTML = template(variant);

      const q = (name) => rootEl.querySelector(`[data-eco="${name}"]`);
      const input      = rootEl.querySelector('#eco-opt-input');
      const liveTokens = q('live-tokens');
      const optimizeBtn= q('optimize');
      const resultCard = q('result');
      const output     = q('output');
      const copyBtn    = q('copy');

      let debounceId = null;
      let copyTimer  = null;
      let lastOptimized = '';

      // ── Live token count ───────────────────────────────────────────────
      function onInput() {
        if (debounceId !== null) clearTimeout(debounceId);
        debounceId = setTimeout(() => {
          debounceId = null;
          liveTokens.textContent = countTokens(input.value);
        }, TOKEN_DEBOUNCE_MS);
      }
      input.addEventListener('input', onInput);

      // ── Optimize ───────────────────────────────────────────────────────
      async function onOptimize() {
        const original = input.value.trim();
        if (!original) return;

        optimizeBtn.disabled = true;
        optimizeBtn.classList.add('is-loading');

        try {
          const { optimized, stats } = runOptimizer(original);
          lastOptimized = optimized;

          output.textContent = optimized;

          q('tok-before').textContent    = stats.originalTokens;
          q('tok-after').textContent     = stats.optimizedTokens;
          q('tok-saved').textContent     = stats.tokensSaved;
          q('reduction').textContent     = `${stats.percentReduction}%`;
          q('words-removed').textContent = `${stats.wordsRemoved} words`;

          const f = formatSavings(stats);
          q('energy').textContent      = f.energyValue;
          q('energy-unit').textContent = f.energyUnit;
          q('water').textContent       = f.water;
          q('co2').textContent         = f.co2;

          resultCard.classList.remove('hidden');

          // Exactly one backend event per optimize, fired from this module only.
          // Both surfaces mount this same code, so logging here (and nowhere
          // else) is what guarantees no double-logging when both are open.
          if (logEvents && window.ecoTrackPromptOptimization) {
            await window.ecoTrackPromptOptimization({
              originalPrompt:   original,
              optimizedPrompt:  optimized,
              optimizationMode: 'balanced',
              platform:         'EcoPrompt',
              source:           'prompt-generator-widget',
            });
          }
        } finally {
          optimizeBtn.disabled = false;
          optimizeBtn.classList.remove('is-loading');
        }
      }
      optimizeBtn.addEventListener('click', onOptimize);

      // ── Copy ───────────────────────────────────────────────────────────
      async function onCopy() {
        if (!lastOptimized) return;
        try {
          await navigator.clipboard.writeText(lastOptimized);
        } catch (_) {
          // Clipboard can be denied; fall back to a selection-based copy.
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(output);
          sel.removeAllRanges();
          sel.addRange(range);
          try { document.execCommand('copy'); } catch (__) {}
          sel.removeAllRanges();
        }
        copyBtn.textContent = 'Copied';
        if (copyTimer !== null) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyTimer = null;
        }, COPY_FEEDBACK_MS);
      }
      copyBtn.addEventListener('click', onCopy);

      return {
        destroy() {
          if (debounceId !== null) clearTimeout(debounceId);
          if (copyTimer !== null) clearTimeout(copyTimer);
          input.removeEventListener('input', onInput);
          optimizeBtn.removeEventListener('click', onOptimize);
          copyBtn.removeEventListener('click', onCopy);
          rootEl.innerHTML = '';
        },
      };
    },
  };

})();
