# CCDEX - Claude Code Desktop Context Extension

Injects a real-time context window usage + rate limit indicator into the Claude Desktop Electron app's footer bar.

## Project Structure

```
CCDEX/
├── CLAUDE.md              # This file
├── RESEARCH.md            # Detailed technical research & architecture notes
├── context-indicator.js   # Injection script (appended to mainView.js preload)
├── patch.py               # Automated patching script
└── fetch-usage.sh         # (deprecated) Companion script, no longer needed
```

## What This Does

Adds a lightweight indicator to the footer bar of Claude Desktop's Code tab showing:
- **Context usage**: progress bar + token count (e.g., `46.7k / 200.0k`)
- **5-hour rate limit**: usage percentage + countdown (e.g., `5h 2% 4h35m`)
- **Weekly rate limit**: usage percentage + countdown (e.g., `Wk 5% 6d`)

Light theme design, blends with the existing footer UI.

## How It Works

1. **context-indicator.js** is appended to `.vite/build/mainView.js` inside `app.asar`
2. The preload script has access to `require('electron').ipcRenderer` and the DOM
3. **Context tokens**: Listens on the LocalSessions IPC channel for assistant messages containing `usage` data
4. **Rate limits**: Fetches `GET /api/organizations/{orgId}/usage` directly (same-origin, cookie auth automatic). The org ID is read from the `lastActiveOrg` cookie
5. The indicator is injected into the footer bar's `flex-1` spacer element (between path display and action buttons)

### Rate Limit API

The renderer loads from `https://claude.ai/claude-code-desktop/...`, so fetching `/api/organizations/{orgId}/usage` is a same-origin request — session cookies are sent automatically. No external scripts, no Keychain access, no manual token setup.

Response format:
```json
{
  "five_hour": { "utilization": 0.0, "resets_at": "2026-04-03T14:00:01+00:00" },
  "seven_day": { "utilization": 5.0, "resets_at": "2026-04-10T04:00:00+00:00" },
  "seven_day_sonnet": { "utilization": 4.0, "resets_at": "2026-04-05T23:00:00+00:00" }
}
```

`utilization` is 0–100 (percentage). Fetched on startup (3s delay), every 60s, and on `rate_limit_event` IPC events.

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
npx @electron/fuses@1.8.0 write \
  --app "/Applications/Claude.app" \
  EnableEmbeddedAsarIntegrityValidation=off

# 3. Run the binary ASAR patcher
python3 patch.py

# 4. Install patched ASAR
cp /tmp/app-patched.asar "/Applications/Claude.app/Contents/Resources/app.asar"

# 5. Launch Claude Desktop
open /Applications/Claude.app
```

Note: `sudo` is typically not needed for the `cp` step if your user owns the file. Re-signing with `codesign` is also not required when the ASAR integrity fuse is disabled.

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
- Model context limit is hardcoded to 200k (doesn't detect 1M context)
- Indicator only appears after first assistant response (context) or first API fetch (rate limits)
- Auto-updates will revert the patch
