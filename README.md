# EcoPrompt

Minimal Chrome extension MVP for prompt optimization and usage tracking.

## What It Does

- User opens the extension popup
- User enters a prompt
- Extension optimizes the prompt
- Optimized prompt is displayed
- Event is saved to the backend

## Structure

```
extension/          Chrome extension (Manifest V3)
  manifest.json     Extension config
  background/       Service worker (background coordination)
  content/          Content script (page-level events)
  popup/            Popup UI (HTML, JS, CSS)
  lib/              Core logic (prompt generator, API, energy estimator)
backend/            Backend service (database integration)
docs/               Requirements, architecture, contract
```

## Setup

1. Load `extension/` as an unpacked extension in Chrome (`chrome://extensions`)
2. Start the backend (see `backend/`)
3. Open any page and click the extension icon

## Docs

- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Backend Contract](docs/backend-contract.md)

## Scope

MVP only. See [SKILL.md](SKILL.md) for what is and is not included.