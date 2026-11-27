# Local-model optimizer: options (not built)

Goal: an optional `engine: 'local-llm'` in `src/engine.js` that rewrites a prompt shorter while keeping its meaning, fully on-device. The rules engine stays the default. `engine.js` already returns `ms` so the UI can show energy spent optimizing next to energy saved.

## Options

| Option | How | Size | Notes |
|---|---|---|---|
| **A. llama.cpp inside the app (recommended)** | Rust crate `llama-cpp-2`, GGUF model downloaded on first use | 0.4-1 GB model | No extra install. Metal on Mac, CPU/Vulkan on Windows. Biggest build-complexity cost (C++ build in CI for 3 targets). |
| B. Ollama | Talk to a local Ollama server | user installs Ollama | Easiest code, worst UX (extra install, extra background process). |
| C. ONNX Runtime / candle | Pure Rust or ONNX | similar | Fewer mature small instruct models; more porting work. |

## Candidate models (check current licences and file sizes before choosing)

Small instruct models around 0.5B-1.5B parameters at 4-bit quantization, for example Qwen2.5 0.5B/1.5B Instruct or Llama 3.2 1B Instruct. Pick by test results, not reputation.

## Rules for shipping it

1. **Opt-in download.** Off by default. A button in Settings downloads the model once (this is a second user-clicked network call, same privacy rule as updates) and verifies its SHA-256.
2. **Net energy must be positive.** Measure joules per optimize call (SystemLoad on Mac) against tokens saved times the per-token energy the app already uses. If the model costs more than it saves for typical prompts, do not ship it, or only offer it for long prompts.
3. **Meaning preserved.** Build a test set (30+ prompts incl. code blocks, URLs, other languages). Reuse the rules engine's protection pipeline so code, URLs and emails are masked before the model sees them and restored after. Reject any output that is longer than the input or that loses a protected span, and fall back to the rules result.
4. **Bounded.** Prompts over a size limit skip the model. Generation has a timeout.
5. **Never log prompt text** (same log-privacy test applies).

## Decide before building

- Model size vs quality (0.5B is fast but sloppy; 1.5B is better but slower and costs more energy).
- Whether to build for Windows at launch or Mac first.
- Whether the energy test in rule 2 is a hard gate (recommended).
