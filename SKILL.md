---
name: power-tracker-v3-builder
description: Build and maintain the EcoPrompt v3 Chrome extension MVP. Use this skill whenever working on the EcoPrompt project, including setting up the extension structure, building the popup UI, implementing the prompt generator, adding frontend event tracking, and connecting to the backend database. Always prioritize minimal, working implementations and avoid adding advanced features unless explicitly requested.
---

# EcoPrompt v3 Builder Skill

## Purpose
This skill guides Claude to rebuild EcoPrompt from scratch as a **minimal Chrome extension MVP**.

The goal is to create a clean, working system — not a complex, over-engineered product.

---

## MVP Scope

### INCLUDED (build these)
- Chrome extension (Manifest V3)
- Popup UI
- Prompt generator
- Frontend event tracking
- Backend database integration
- Basic analytics summary

---

### EXCLUDED (DO NOT BUILD unless explicitly asked)
- Premium access code system
- Full analytics dashboard
- AI model detection (GPT, Claude, etc.)
- OODA agent system
- Pattern recognition system
- Notification system
- Website integration
- Export/import features
- Advanced settings page

---

## Repository Structure

The project must follow this structure:
powertracker/
├── extension/
│ ├── manifest.json
│ ├── background/
│ ├── content/
│ ├── popup/
│ ├── lib/
│ └── assets/
├── backend/
├── docs/
├── README.md
└── SKILL.md

Do NOT reorganize this structure unless explicitly asked.

---

## File Responsibilities

Each file has a clear role:

### Core Extension
- `manifest.json` → Chrome extension configuration
- `background/service-worker.js` → background coordination (minimal logic only)
- `content/content-script.js` → collect page-level events only

### Popup UI
- `popup/popup.html` → UI structure
- `popup/popup.js` → user interactions and logic
- `popup/popup.css` → styling

### Core Logic
- `lib/prompt-generator.js` → prompt optimization logic
- `lib/api.js` → backend communication
- `lib/energy-estimator.js` → simple estimation logic (keep minimal)

---

## Architecture Overview

### Data Flow

1. User opens extension popup
2. User enters a prompt
3. Prompt is optimized using `prompt-generator.js`
4. Optimized prompt is displayed
5. Event is sent to backend using `api.js`
6. Backend stores event and returns success

---

## Backend Contract

### Save Event
Input:
- originalPrompt (string)
- optimizedPrompt (string)
- timestamp (string)
- pageUrl (optional)

Output:
- success (boolean)

---

## Working Rules

Claude MUST follow these rules:

- Keep everything simple and minimal
- Do not add features outside MVP scope
- Prefer working code over abstraction
- Do not create unnecessary files
- Do not refactor structure unless asked
- Reuse backend code if available
- Explain changes briefly after making them

---

## Build Order (VERY IMPORTANT)

Always build in this order:

1. Confirm scope (MVP only)
2. Scaffold file structure (if missing)
3. Implement popup UI
4. Implement prompt generator
5. Connect popup to prompt generator
6. Add API integration
7. Add event tracking
8. Test full flow
9. Refine only if needed

---

## Success Criteria

The MVP is complete when:

- Extension loads in Chrome
- Popup opens correctly
- User can enter a prompt
- Prompt can be optimized
- Event is sent to backend
- Basic response is shown

---

## Anti-Overengineering Rule

If unsure between:
- simple vs complex  
→ ALWAYS choose simple

If unsure whether to add a feature  
→ DO NOT add it

---

## Communication Style

When working:
- Be concise
- Explain what was done
- Do not over-explain
- Do not introduce unnecessary concepts

---

## Summary

This skill exists to ensure:
- fast iteration
- clean structure
- minimal working product

NOT to build the full original EcoPrompt system.