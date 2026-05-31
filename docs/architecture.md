# EcoPrompt Architecture

## Overview

A Chrome Manifest V3 extension with a minimal backend. The extension handles UI and prompt optimization; the backend handles persistence.

## Data Flow

```
User
 │
 ▼
popup.html / popup.js       ← user enters prompt, clicks Optimize
 │
 ├─► prompt-generator.js    ← returns optimized prompt
 │
 ├─► energy-estimator.js    ← returns estimated token/energy cost (optional display)
 │
 └─► api.js                 ← POSTs event to backend
        │
        ▼
     Backend API             ← stores event, returns { success: true }
```

## Components

### Extension

| File | Role |
|---|---|
| `manifest.json` | Extension metadata, permissions, entry points |
| `background/service-worker.js` | Background coordination (minimal) |
| `content/content-script.js` | Reads current page URL for event context |
| `popup/popup.html` | UI layout |
| `popup/popup.js` | Handles user interaction, wires UI to lib modules |
| `popup/popup.css` | Styling |
| `lib/prompt-generator.js` | Prompt optimization logic |
| `lib/api.js` | HTTP calls to backend |
| `lib/energy-estimator.js` | Simple token/energy estimate |

### Backend

- REST API (to be defined in `backend/`)
- Single endpoint: `POST /events`
- Stores event record, returns `{ success: boolean }`

## Key Decisions

- Manifest V3 (required by Chrome)
- No build step — plain JS files loaded directly
- Backend URL is configurable (set in `lib/api.js`)
- Content script only reads `window.location.href` — no DOM manipulation
