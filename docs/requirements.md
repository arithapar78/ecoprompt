# EcoPrompt MVP Requirements

## Goal

Rebuild EcoPrompt from scratch with only the minimum required features for a working MVP.

## Must Have

| Feature | Description |
|---|---|
| Chrome extension popup | User-facing UI via Manifest V3 |
| Prompt generator | Optimizes the user's input prompt |
| Frontend event tracking | Captures page URL and prompt events |
| Backend integration | Sends events to backend, receives success/failure |
| Basic analytics summary | Show count of saved events in popup |

## Not In Scope

- Premium access code system
- Full analytics dashboard
- AI model detection (GPT, Claude, etc.)
- OODA agent system
- Pattern recognition system
- Notification system
- Website integration
- Export / import features
- Advanced settings page

## First Milestone: Working End-to-End Flow

A user can:

1. Open the extension popup
2. Enter a prompt
3. Click "Optimize"
4. See the optimized prompt
5. Event is saved to the backend
6. Popup shows a success message

## Success Criteria

- Extension loads without errors in Chrome
- Popup opens and renders correctly
- Prompt optimization returns a result
- Backend receives and stores the event
- User sees feedback after submission