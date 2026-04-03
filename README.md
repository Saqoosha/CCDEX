# CCDEX

**Claude Code Desktop Context Extension** — Injects a real-time context usage + rate limit indicator into Claude Desktop's footer bar.

<p align="center">
  <img src="screenshot.png" alt="CCDEX in Claude Desktop footer bar">
</p>

## What It Shows

- **Context window usage** — progress bar + token count (e.g., `46.7k / 200.0k` or `171.2k / 1.0M`)
- **5-hour rate limit** — usage % + reset countdown (e.g., `5h 4% 4h30m`)
- **Weekly rate limit** — usage % + reset countdown (e.g., `Wk 6% 6d`)

Color coding: green (< 50%) / amber (50–80%) / red (> 80%).

## How It Works

Claude Desktop is an Electron app. Its **Code tab** renders a web page from `https://claude.ai/claude-code-desktop/...` inside an Electron renderer process. CCDEX appends a small JavaScript snippet to the app's preload script (`mainView.js` inside `app.asar`), which gives it access to both the **DOM** and **Electron IPC**.

From this position, the script can observe everything the Code tab does — and that's how it gets the two pieces of data it needs:

### Context Token Usage (from Electron IPC)

Every time Claude Code receives an assistant response, the app fires an IPC event on the `LocalSessions` channel. These events include a `usage` object with token counts (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). The script simply listens for these events and tallies them per session.

The model's **context window size** (200k, 1M, etc.) is also delivered via IPC — each completed turn emits a `result` event containing `modelUsage` with the actual `contextWindow` value. No hardcoded limits needed; the indicator adapts automatically to whatever model is in use.

### Rate Limit Usage (from the claude.ai API)

Because the Code tab's renderer is loaded from `https://claude.ai`, any `fetch('/api/...')` call is a **same-origin request** — the browser automatically attaches the user's `sessionKey` cookie. The script reads the org ID from the `lastActiveOrg` cookie, then calls:

```
GET /api/organizations/{orgId}/usage
```

This returns utilization percentages (0–100) and reset timestamps for both the 5-hour and 7-day rate limit windows. No API keys or manual setup needed.

### UI Injection

The indicator is injected into the footer bar's spacer element (between the path display and the action buttons). A `MutationObserver` watches for DOM rebuilds (caused by tab switches or navigation) and re-injects as needed.

## Requirements

- macOS
- [Claude Desktop](https://claude.ai/download) app
- Python 3
- Node.js (for `npx`) — or [Bun](https://bun.sh) as an alternative
- `codesign` — included with macOS, no extra install needed

## Installation

```bash
# 1. Close Claude Desktop

# 2. Disable ASAR integrity fuse (first time only, or after app updates)
#    Electron validates per-file SHA256 hashes embedded in the ASAR archive.
#    Since we modify mainView.js, the hash no longer matches — the app would
#    crash on startup. Disabling this fuse skips the integrity check.
#    Note: this also modifies the Electron Framework binary, invalidating the code signature.
npx @electron/fuses@1.8.0 write \
  --app "/Applications/Claude.app" \
  EnableEmbeddedAsarIntegrityValidation=off
# Alternative if npx has permission issues: bun x @electron/fuses@1.8.0 write ...

# 3. Patch the ASAR
python3 patch.py

# 4. Install (no sudo needed if you own the app)
cp /tmp/app-patched.asar "/Applications/Claude.app/Contents/Resources/app.asar"

# 5. Re-sign (required — fuse write in step 2 invalidates the code signature)
codesign --force --deep --sign - "/Applications/Claude.app"

# 6. Launch
open /Applications/Claude.app
```

> **Note:** `sudo` is not needed — you typically own `/Applications/Claude.app` on a personal Mac. The re-sign step is required because the fuse write modifies the `Electron Framework` binary.

> **Security disclaimer:** Disabling the ASAR integrity fuse means Electron will no longer verify that the app's code hasn't been tampered with. This is required for CCDEX to work, but it also means other software could modify `app.asar` without detection. Only use this on a machine you trust.

## After Claude Desktop Updates

Auto-updates overwrite both `app.asar` and `Electron Framework`. Re-run all steps above.

## Project Structure

```
CCDEX/
├── README.md              # This file
├── CLAUDE.md              # Project instructions for Claude Code
├── RESEARCH.md            # Detailed technical research & architecture notes
├── context-indicator.js   # Injection script (appended to mainView.js preload)
└── patch.py               # Binary ASAR patcher
```

## How Patching Works

Electron's ASAR format includes per-file SHA256 integrity hashes, so `npx asar pack` won't work. Instead, `patch.py` does binary-level patching:

1. Parse the ASAR header (pickle format + JSON)
2. Locate `mainView.js` — read offset and size
3. Append `context-indicator.js` to the original content
4. Update the SHA256 hash and file size in the header
5. Shift offsets of all subsequent files
6. Reconstruct the binary

The `EnableEmbeddedAsarIntegrityValidation` Electron fuse must be disabled first, otherwise the app will crash on startup regardless of hash correctness.

## Debugging

Enable DevTools (survives updates):

```bash
echo '{"allowDevTools": true}' > ~/Library/Application\ Support/Claude/developer_settings.json
```

Then `Option+Cmd+I` to open DevTools. Look for `[CCDEX]` in the console.

## License

MIT
