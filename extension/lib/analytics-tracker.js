// lib/analytics-tracker.js
// Anonymous prompt optimization analytics — no prompt text is ever sent.
console.log('[EcoPrompt Analytics] analytics-tracker.js loaded');

const ECO_ANALYTICS_ENDPOINT =
  "https://trackoptimizationevent-5rbyyypj3a-ue.a.run.app";

const ECO_ANALYTICS_KEYS = {
  USER_ID: "ecoPromptAnonymousUserId",
  CONSENT: "ecoPromptAnalyticsConsent",
  LOCAL_EVENTS: "ecoPromptLocalOptimizationEvents"
};

async function ecoGetStorageValue(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function ecoSetStorageValue(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function ecoGetOrCreateAnonymousUserId() {
  let userId = await ecoGetStorageValue(ECO_ANALYTICS_KEYS.USER_ID);

  if (userId) return userId;

  userId = `eco_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await ecoSetStorageValue(ECO_ANALYTICS_KEYS.USER_ID, userId);

  return userId;
}

function ecoEstimateTokens(text) {
  if (!text || typeof text !== "string") return 0;

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;

  const charEstimate = Math.ceil(chars / 4);
  const wordEstimate = Math.ceil(words * 1.3);

  return Math.max(charEstimate, wordEstimate);
}

async function ecoSaveEventLocally(event) {
  const existingEvents =
    (await ecoGetStorageValue(ECO_ANALYTICS_KEYS.LOCAL_EVENTS)) || [];

  existingEvents.push(event);

  const trimmedEvents = existingEvents.slice(-1000);

  await ecoSetStorageValue(ECO_ANALYTICS_KEYS.LOCAL_EVENTS, trimmedEvents);
}

async function ecoSendEventToDatabase(event) {
  const consent = await ecoGetStorageValue(ECO_ANALYTICS_KEYS.CONSENT);

  if (consent !== true) {
    console.log("[EcoPrompt Analytics] Skipped upload: consent is off");
    return { skipped: true };
  }

  const response = await fetch(ECO_ANALYTICS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics upload failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function ecoTrackPromptOptimization({
  originalPrompt,
  optimizedPrompt,
  optimizationMode = "balanced",
  platform = "EcoPrompt",
  source = "prompt-generator-widget"
}) {
  const safeOriginalPrompt =
    typeof originalPrompt === "string" ? originalPrompt : "";

  const safeOptimizedPrompt =
    typeof optimizedPrompt === "string" ? optimizedPrompt : "";

  const userId = await ecoGetOrCreateAnonymousUserId();

  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.slice(0, 10);
  const month = timestamp.slice(0, 7);

  const originalTokens = ecoEstimateTokens(safeOriginalPrompt);
  const optimizedTokens = ecoEstimateTokens(safeOptimizedPrompt);
  const tokensSaved = Math.max(originalTokens - optimizedTokens, 0);

  const reductionPercent =
    originalTokens > 0
      ? Number(((tokensSaved / originalTokens) * 100).toFixed(2))
      : 0;

  const event = {
    userId,
    eventId: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,

    timestamp,
    date,
    month,

    originalTokens,
    optimizedTokens,
    tokensSaved,
    reductionPercent,

    originalCharacters: safeOriginalPrompt.length,
    optimizedCharacters: safeOptimizedPrompt.length,
    charactersSaved: Math.max(
      safeOriginalPrompt.length - safeOptimizedPrompt.length,
      0
    ),

    optimizationMode,
    platform,
    source,

    extensionVersion: chrome.runtime.getManifest().version
  };

  await ecoSaveEventLocally(event);

  console.log("[EcoPrompt Analytics] Event tracked:", event.eventId, `(${tokensSaved} tokens saved)`);

  try {
    await ecoSendEventToDatabase(event);
    console.log("[EcoPrompt Analytics] Event sent:", event);
  } catch (error) {
    console.warn("[EcoPrompt Analytics] Saved locally but upload failed:", error);
  }

  return event;
}

window.ecoTrackPromptOptimization = ecoTrackPromptOptimization;
window.ecoEstimateTokens = ecoEstimateTokens;
