// One logger for the webview. Inside the app it forwards to the Tauri log plugin,
// so JS and Rust lines end up in the same file. In a plain browser (and in the
// node tests) it falls back to console.
//
// RULE: never pass prompt text or clipboard contents to this. Log lengths and
// counts only. test/log-privacy.test.mjs enforces it for optimize().

function emit(level, message) {
  const sink = typeof window !== 'undefined' ? window.__TAURI__?.log : undefined;
  if (sink && typeof sink[level] === 'function') {
    Promise.resolve(sink[level](String(message))).catch(() => {});
  } else {
    (console[level] || console.log)(String(message));
  }
}

export const log = {
  debug: (m) => emit('debug', m),
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
};
