# CCDEX - Claude Code Desktop Context Extension

Injects a real-time context window usage + rate limit indicator into the Claude Desktop Electron app's footer bar.

## Project Structure

```
CCDEX/
├── CLAUDE.md              # This file
├── RESEARCH.md            # Detailed technical research & architecture notes
├── context-indicator.js   # Injection script (appended to mainView.js preload)
└── patch.py               # Automated patching script
```

## What This Does

Adds a lightweight indicator to the footer bar of Claude Desktop's Code tab showing:
- **Context usage**: progress bar + token count (e.g., `46.7k / 200.0k` or `171.2k / 1.0M`)
- **5-hour rate limit**: usage percentage + countdown (e.g., `5h 2% 4h35m`)
- **Weekly rate limit**: usage percentage + countdown (e.g., `Wk 5% 6d`)

Light theme design, blends with the existing footer UI.

## How It Works

**context-indicator.js** is appended to `.vite/build/mainView.js` inside `app.asar`. Since this is a preload script, it has access to both `require('electron').ipcRenderer` and the DOM.

The indicator displays two types of data, each obtained through a different mechanism:

### 1. Context Token Usage (via IPC)

The script listens on the Electron IPC channel for `LocalSessions` events:

```
Channel: $eipc_message$_<uuid>_$_claude.web_$_LocalSessions_$_onEvent
```

When Claude Code sends an assistant response, the event payload includes a `usage` object:

```json
{
  "input_tokens": 12345,
  "output_tokens": 678,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 9000
}
```

The script tracks per-session token counts (input + cache + output) and displays them against the model's context limit.

The context limit is obtained dynamically from `result` events, which include a `modelUsage` object:

```json
{
  "modelUsage": {
    "claude-opus-4-6": {
      "contextWindow": 200000,
      "maxOutputTokens": 64000
    }
  }
}
```

The largest `contextWindow` value is used as the session's limit. The context bar is hidden until the first `result` event provides this data.

Session lifecycle events (`session_updated`, `stopped`, `archived`, `deleted`) are also handled to keep the display in sync.

### 2. Rate Limit Usage (via Same-Origin API)

This is the key insight: **the Code tab's renderer process loads from `https://claude.ai/claude-code-desktop/...`**, which means any `fetch()` call to `/api/...` is a **same-origin request**. The browser automatically includes the `sessionKey` cookie — no manual token extraction, no external scripts, no Keychain access needed.

External tools (e.g., standalone scripts) would need to manually obtain and pass the `sessionKey` cookie. Because our script runs *inside* the Electron renderer, authentication is free.

**How the fetch works:**

1. Read the org ID from the `lastActiveOrg` cookie: `document.cookie.match(/lastActiveOrg=([^;]+)/)`
2. Fetch `GET /api/organizations/{orgId}/usage` — session cookies are sent automatically
3. Parse the response and update the indicator

**Response format:**

```json
{
  "five_hour": { "utilization": 0.0, "resets_at": "2026-04-03T14:00:01+00:00" },
  "seven_day": { "utilization": 5.0, "resets_at": "2026-04-10T04:00:00+00:00" },
  "seven_day_sonnet": { "utilization": 4.0, "resets_at": "2026-04-05T23:00:00+00:00" }
}
```

`utilization` is 0–100 (percentage).

**Fetch triggers:**
- On startup (3s delay to wait for DOM)
- Every 60s (polling interval)
- On `rate_limit_event` IPC events (immediate refresh when rate-limited)
- Throttled to at most once per 30s to avoid excessive requests

### 3. UI Injection

The indicator is injected into the footer bar's `flex-1` spacer element (between the path display and action buttons). A `MutationObserver` watches for DOM rebuilds (tab switches, navigation) and re-injects as needed.

## Key Technical Facts

- Claude Desktop's Code tab is internally called "ccd" (Claude Code Desktop)
- The three tabs are Chat, Cowork (NOT Claude Code), and Code
- Code tab loads from `https://claude.ai/claude-code-desktop/...`
- IPC namespace UUID: `ecf9b7a0-beb7-40a8-9885-aa723c019ace`
- Event channel: `$eipc_message$_<uuid>_$_claude.web_$_LocalSessions_$_onEvent`
- ASAR has per-file integrity hashes in JSON header — must update when patching
- Electron Fuses control security features at the binary level

## Patching Procedure

### Prerequisites
- `npx @electron/fuses@1.8.0` (use v1.x, v2.x changed CLI)
- Python 3 (for binary ASAR patching)

### Steps

```bash
# 1. Close Claude Desktop

# 2. Disable ASAR integrity fuse (first time only, or after updates)
#    This modifies the Electron Framework binary, which invalidates the code signature.
npx @electron/fuses@1.8.0 write \
  --app "/Applications/Claude.app" \
  EnableEmbeddedAsarIntegrityValidation=off
# Alternative if npx has permission issues:
# bun x @electron/fuses@1.8.0 write --app "/Applications/Claude.app" EnableEmbeddedAsarIntegrityValidation=off

# 3. Run the binary ASAR patcher
python3 patch.py

# 4. Install patched ASAR (no sudo needed if you own the app)
cp /tmp/app-patched.asar "/Applications/Claude.app/Contents/Resources/app.asar"

# 5. Re-sign the app (required — fuse write invalidates the code signature)
codesign --force --deep --sign - "/Applications/Claude.app"

# 6. Launch Claude Desktop
open /Applications/Claude.app
```

Note: `sudo` is not needed — the user typically owns `/Applications/Claude.app` on a personal Mac. The `codesign` step is **required**: the fuse write in step 2 modifies the `Electron Framework` binary, which invalidates the original signature.

### After Claude Desktop Updates

Updates overwrite both `app.asar` and `Electron Framework`. Re-run all steps above.

## Binary ASAR Patching (How It Works)

Cannot use `npx asar pack` because Electron validates per-file SHA256 hashes stored in the ASAR JSON header. Instead, we patch the ASAR binary directly:

1. Parse ASAR header (4x UInt32 pickle format + JSON string)
2. Locate `mainView.js` entry — get offset and size
3. Read original content, append `context-indicator.js`
4. Compute new SHA256 hash, update header entry
5. Shift offsets of all subsequent files by the size difference
6. Reconstruct the binary: new header + patched data segments

## Electron Fuses Reference

Read current state:
```bash
npx @electron/fuses@1.8.0 read --app "/Applications/Claude.app"
```

Key fuses for this project:
| Fuse | Default | Required |
|------|---------|----------|
| EnableEmbeddedAsarIntegrityValidation | Enabled | **Must disable** |
| EnableNodeCliInspectArguments | Disabled | Enable for `--inspect` debugging |
| RunAsNode | Disabled | Enable for `ELECTRON_RUN_AS_NODE` |
| EnableNodeOptionsEnvironmentVariable | Disabled | Enable for `NODE_OPTIONS` |

## DevTools Access

Already configured (survives updates):
```bash
# ~/Library/Application Support/Claude/developer_settings.json
{"allowDevTools": true}
```

Open DevTools: `Option+Cmd+I`

## Code Conventions

- Injection script is a single IIFE, no external dependencies
- All DOM elements use `ccdex-` prefix to avoid conflicts
- Indicator is injected into footer bar's `flex-1` spacer (light theme)
- Text color: `rgba(0, 0, 0, 0.36)`, bar backgrounds: `rgba(0, 0, 0, 0.08)`
- Color coding: green (< 50%), amber (50–80%), red (> 80%)
- MutationObserver re-injects on DOM rebuilds (tab switches, navigation)
- Script logs `[CCDEX]` prefix to console for debugging
- Token formatting: `k` for thousands, `M` for millions

## Known Limitations

- Token counts reflect the last API response, not cumulative session total
- Context bar only appears after first `result` event (which provides `contextWindow` via `modelUsage`)
- Rate limits appear after first API fetch (on startup with 3s delay)
- Auto-updates will revert the patch
