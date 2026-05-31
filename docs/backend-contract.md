# EcoPrompt Backend Contract

## Base URL

```
http://localhost:3000
```

(Configurable in `extension/lib/api.js`)

---

## Endpoints

### POST /events

Save a prompt optimization event.

**Request**

```json
{
  "originalPrompt": "string (required)",
  "optimizedPrompt": "string (required)",
  "timestamp": "string (required, ISO 8601)",
  "pageUrl": "string (optional)"
}
```

**Response — success**

```json
{
  "success": true
}
```

**Response — error**

```json
{
  "success": false,
  "error": "string"
}
```

**Status codes**

| Code | Meaning |
|---|---|
| 200 | Event saved |
| 400 | Missing required fields |
| 500 | Server error |

---

## Notes

- `pageUrl` is collected by the content script and may be `null` if the content script is not active on the current tab.
- The backend is responsible for assigning a record ID and storing timestamps.
- No authentication in MVP scope.
