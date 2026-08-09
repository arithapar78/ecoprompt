// lib/ai-energy-database.js
// AI model energy data and site detection patterns.
// Used by the service worker to identify AI sites and estimate backend energy.

// ── Provider infrastructure ────────────────────────────────────────────────
// Datacenter multipliers from Jegham et al., "How Hungry is AI?" (arXiv:2505.09598),
// Table 1. Used to turn a model's per-query energy into water and CO2.
//
//   PUE        — power usage effectiveness (facility overhead per unit of IT power)
//   wueSite    — on-site water for cooling, L per kWh of IT power
//   wueSource  — off-site water embedded in generation, L per kWh of total power
//   cif        — carbon intensity factor, kgCO2e per kWh

const AI_PROVIDER_INFRA = {
  openai:    { pue: 1.12, wueSite: 0.30, wueSource: 4.350, cif: 0.350 }, // Azure
  anthropic: { pue: 1.14, wueSite: 0.18, wueSource: 5.110, cif: 0.287 }, // AWS
  deepseek:  { pue: 1.27, wueSite: 1.20, wueSource: 6.016, cif: 0.600 },
  meta:      { pue: 1.14, wueSite: 0.18, wueSource: 5.110, cif: 0.287 }, // AWS
  google:    { pue: 1.10, wueSite: 0.20, wueSource: 4.000, cif: 0.300 },
};

// Fallback for platforms whose host infrastructure isn't published — the AWS
// row is the most common case and sits mid-range across all five providers.
const DEFAULT_PROVIDER = 'meta';

// ── Model energy data ──────────────────────────────────────────────────────
// energyPerQuery: Wh for ONE inference request, from the same benchmark, using
// the medium-prompt case (1k tokens in / 1k tokens out) mean. These are 100–300×
// the values this file previously carried, which were low by orders of magnitude.

const AI_MODEL_DATABASE = {
  'gpt-5': {
    name: 'GPT-5',
    energyPerQuery: 2.33,
    provider: 'openai',
    sites: ['chatgpt.com', 'chat.openai.com', 'openai.com'],
    detectionPatterns: [/gpt-?5/i, /chatgpt/i],
    category: 'large-multimodal',
  },
  'gpt-5-thinking': {
    name: 'GPT-5 Thinking',
    energyPerQuery: 17.15,
    provider: 'openai',
    sites: ['chatgpt.com', 'chat.openai.com'],
    detectionPatterns: [/thinking/i, /reasoning/i],
    category: 'reasoning',
  },
  'gpt-4o': {
    name: 'GPT-4o',
    energyPerQuery: 1.215,
    provider: 'openai',
    sites: ['chatgpt.com', 'chat.openai.com', 'openai.com'],
    detectionPatterns: [/gpt-?4o/i],
    category: 'large-multimodal',
  },
  'gpt-4.1': {
    name: 'GPT-4.1',
    energyPerQuery: 3.382,
    provider: 'openai',
    sites: ['chatgpt.com', 'chat.openai.com', 'openai.com'],
    detectionPatterns: [/gpt-?4\.1/i],
    category: 'large-multimodal',
  },
  'o3': {
    name: 'OpenAI o3',
    energyPerQuery: 5.15,
    provider: 'openai',
    sites: ['chatgpt.com', 'chat.openai.com'],
    detectionPatterns: [/\bo3\b/i],
    category: 'reasoning',
  },
  'claude-sonnet': {
    name: 'Claude Sonnet',
    energyPerQuery: 2.99,
    provider: 'anthropic',
    sites: ['claude.ai', 'anthropic.com'],
    detectionPatterns: [/sonnet/i, /claude/i],
    category: 'large-language',
  },
  'claude-haiku': {
    name: 'Claude Haiku',
    energyPerQuery: 0.8,
    provider: 'anthropic',
    sites: ['claude.ai'],
    detectionPatterns: [/haiku/i],
    category: 'small-language',
  },
  'gemini': {
    name: 'Gemini',
    energyPerQuery: 2.0, // no benchmark entry; mid estimate against the OpenAI row
    provider: 'google',
    sites: ['gemini.google.com', 'ai.google.dev'],
    detectionPatterns: [/gemini/i],
    category: 'large-multimodal',
  },
  'deepseek-r1': {
    name: 'DeepSeek-R1',
    energyPerQuery: 23.8,
    provider: 'deepseek',
    sites: ['deepseek.com', 'chat.deepseek.com'],
    detectionPatterns: [/r1/i, /reason/i],
    category: 'reasoning',
  },
  'deepseek-v3': {
    name: 'DeepSeek-V3',
    energyPerQuery: 13.2,
    provider: 'deepseek',
    sites: ['deepseek.com', 'chat.deepseek.com'],
    detectionPatterns: [/deepseek/i, /v3/i],
    category: 'large-language',
  },
  'llama-3.1-70b': {
    name: 'Llama 3.1 70B',
    energyPerQuery: 4.5,
    provider: 'meta',
    sites: ['huggingface.co', 'together.ai', 'replicate.com', 'meta.ai'],
    detectionPatterns: [/llama/i, /meta.*llama/i],
    category: 'large-language',
  },
};

// ── Platform site patterns ─────────────────────────────────────────────────
// Ordered from most-specific to least. Detection tries pathPatterns first,
// then falls back to defaultModel for the matched platform.

const AI_SITE_PATTERNS = {
  openai: {
    domains: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'platform.openai.com'],
    // GPT-5 is the current default model on chatgpt.com.
    defaultModel: 'gpt-5',
    pathPatterns: [
      { pattern: /gpt-?4o/i,  model: 'gpt-4o' },
      { pattern: /gpt-?4\.1/i, model: 'gpt-4.1' },
      { pattern: /\bo3\b/i,   model: 'o3' },
      { pattern: /thinking/i, model: 'gpt-5-thinking' },
    ],
  },
  anthropic: {
    domains: ['claude.ai', 'anthropic.com'],
    defaultModel: 'claude-sonnet',
    pathPatterns: [
      { pattern: /haiku/i,  model: 'claude-haiku' },
      { pattern: /sonnet/i, model: 'claude-sonnet' },
    ],
  },
  google: {
    domains: ['gemini.google.com', 'ai.google.dev'],
    defaultModel: 'gemini',
    pathPatterns: [],
  },
  deepseek: {
    domains: ['deepseek.com', 'chat.deepseek.com'],
    defaultModel: 'deepseek-v3',
    pathPatterns: [
      { pattern: /r1|reason/i, model: 'deepseek-r1' },
    ],
  },
  grok: {
    domains: ['grok.com', 'x.ai'],
    defaultModel: 'llama-3.1-70b', // no benchmark entry; large-model proxy
    pathPatterns: [],
  },
  perplexity: {
    domains: ['perplexity.ai'],
    defaultModel: 'llama-3.1-70b',
    pathPatterns: [],
  },
  copilot: {
    domains: ['copilot.microsoft.com'],
    defaultModel: 'gpt-5', // Copilot runs on OpenAI models via Azure
    pathPatterns: [],
  },
  meta: {
    domains: ['meta.ai'],
    defaultModel: 'llama-3.1-70b',
    pathPatterns: [],
  },
  huggingface: {
    domains: ['huggingface.co'],
    defaultModel: 'llama-3.1-70b',
    pathPatterns: [],
  },
  together: {
    domains: ['together.ai'],
    defaultModel: 'llama-3.1-70b',
    pathPatterns: [],
  },
  replicate: {
    domains: ['replicate.com'],
    defaultModel: 'llama-3.1-70b',
    pathPatterns: [],
  },
};

// ── Query cadence ──────────────────────────────────────────────────────────
// One query per 3 minutes of active tab time. Everything downstream — watts,
// water, carbon — amortizes a single query over this window, so these three
// constants must stay in agreement.

const QUERY_CADENCE_MS  = 3 * 60 * 1000;
const QUERY_CADENCE_HRS = QUERY_CADENCE_MS / 3600000;  // 0.05 hr
const QUERIES_PER_HR    = 1 / QUERY_CADENCE_HRS;       // 20 queries/hr

// ── AIEnergyManager ────────────────────────────────────────────────────────

class AIEnergyManager {
  constructor() {
    // tabId -> { modelKey, queries, energy, timestamp }
    this.sessionUsage = new Map();
  }

  /**
   * Detect which AI model/platform the given URL belongs to.
   * Detection order:
   *   1. Match hostname against AI_SITE_PATTERNS domains
   *   2. Within the matched platform, try pathPatterns against path + title
   *   3. Fall back to the platform's defaultModel
   *   4. If no platform matched, return null
   *
   * @param {string} url
   * @param {string} [title]
   * @returns {{ platform: string, modelKey: string, model: object, confidence: number }|null}
   */
  detectAIModel(url, title = '') {
    if (!url) return null;

    let urlObj;
    try { urlObj = new URL(url); } catch (_) { return null; }

    const domain = urlObj.hostname.toLowerCase();
    const path   = urlObj.pathname.toLowerCase();

    // Step 1 — find matching platform by hostname
    for (const [platform, config] of Object.entries(AI_SITE_PATTERNS)) {
      const matched = config.domains.some(
        d => domain === d || domain.endsWith('.' + d)
      );
      if (!matched) continue;

      // Step 2 — try path patterns for a more specific model
      for (const { pattern, model: modelKey } of config.pathPatterns) {
        if (pattern.test(path) || pattern.test(title)) {
          return { platform, modelKey, model: AI_MODEL_DATABASE[modelKey], confidence: 0.9 };
        }
      }

      // Step 3 — use default model for the platform
      const modelKey = config.defaultModel;
      return { platform, modelKey, model: AI_MODEL_DATABASE[modelKey], confidence: 0.7 };
    }

    // Step 4 — no match
    return null;
  }

  /**
   * Estimate how many queries have been made based on time spent on the page.
   * Conservative: one query per 3 minutes of active tab time, capped at 20.
   *
   * @param {number} durationMs - Time the tab has been active (ms)
   * @returns {number}
   */
  estimateQueryCount(durationMs) {
    // Minimum 1 query: once an AI site is detected the user has already
    // made at least one request. After that, one more query per 3 minutes.
    const queries = 1 + Math.floor(durationMs / QUERY_CADENCE_MS);
    return Math.min(queries, 20);
  }

  /**
   * Compute backend AI energy (Wh) for a tab given its active duration.
   *
   * @param {string} modelKey
   * @param {number} durationMs
   * @returns {{ queries: number, energyWh: number }}
   */
  computeEnergy(modelKey, durationMs) {
    const model = AI_MODEL_DATABASE[modelKey];
    if (!model) return { queries: 0, energyWh: 0 };
    const queries  = this.estimateQueryCount(durationMs);
    const energyWh = queries * model.energyPerQuery;
    return { queries, energyWh };
  }

  /**
   * Convert per-query energy to an average watt value.
   * Amortizes one query over the same 3-minute cadence estimateQueryCount
   * assumes, so watts and query count describe the same user behaviour. Using
   * raw session duration instead would spike on tab open and decay to
   * near-zero after a long session.
   *
   * @param {number} energyWh  - energy for one query (Wh)
   * @param {number} _durationMs - unused, kept for signature compatibility
   * @returns {number} watts
   */
  energyToWatts(energyWh, _durationMs) {
    return Math.max(0, energyWh / QUERY_CADENCE_HRS);
  }

  /**
   * Per-query water and carbon for a model, using the paper's formulas:
   *   water_L = (E_kWh / PUE) x WUE_site + E_kWh x WUE_source
   *   co2_g   = E_kWh x CIF x 1000
   *
   * @param {string} modelKey
   * @returns {{ waterLPerQuery: number, co2GPerQuery: number }}
   */
  perQueryFootprint(modelKey) {
    const model = AI_MODEL_DATABASE[modelKey];
    if (!model) return { waterLPerQuery: 0, co2GPerQuery: 0 };

    const infra = AI_PROVIDER_INFRA[model.provider] ?? AI_PROVIDER_INFRA[DEFAULT_PROVIDER];
    const energyKWh = model.energyPerQuery / 1000;

    return {
      waterLPerQuery:
        (energyKWh / infra.pue) * infra.wueSite + energyKWh * infra.wueSource,
      co2GPerQuery: energyKWh * infra.cif * 1000,
    };
  }

  /**
   * Hourly water and carbon for a model at the assumed query cadence.
   *
   * @param {string} modelKey
   * @returns {{ waterLPerHr: number, co2GPerHr: number }}
   */
  hourlyFootprint(modelKey) {
    const { waterLPerQuery, co2GPerQuery } = this.perQueryFootprint(modelKey);
    return {
      waterLPerHr: waterLPerQuery * QUERIES_PER_HR,
      co2GPerHr:   co2GPerQuery  * QUERIES_PER_HR,
    };
  }

  /**
   * Record/update usage for a tab.
   * @param {number} tabId
   * @param {{ modelKey: string, queries: number, energyWh: number }} data
   */
  updateTabUsage(tabId, data) {
    this.sessionUsage.set(tabId, { ...data, timestamp: Date.now() });
  }

  /** Remove a tab's usage record (call when tab closes). */
  removeTab(tabId) {
    this.sessionUsage.delete(tabId);
  }
}
