# CCDEX Research Document

**Claude Code Desktop Context Extension** -- Technical Research & Architecture Notes

---

## Project Overview

**Goal:** Inject a lightweight, always-visible context window usage indicator into the Claude Desktop Electron application's Code tab (Claude Code Desktop, or "CCD").

**Result:** A lightweight indicator in the footer bar of Claude Desktop's Code tab that displays:
- Context usage as a progress bar + token count (e.g., `46.7k / 200.0k`)
- 5-hour rate limit usage + countdown (e.g., `5h 2% 4h35m`)
- Weekly rate limit usage + countdown (e.g., `Wk 5% 6d`)

The indicator uses a light theme design that blends with the existing footer UI. Color coding transitions from gray (< 50%) to amber (50-80%) to red (> 80%).

**Motivation:** Claude Desktop does not natively expose real-time token usage or rate limit metrics in its UI. While a `/context` slash command exists, it is scoped to the Cowork tab and requires manual invocation. CCDEX provides a passive, non-intrusive alternative that is always visible during Code tab sessions, combining both context window and rate limit awareness in a single glanceable indicator.

---

## Architecture Discovery

### Claude Desktop App Structure

Claude Desktop is an Electron application distributed as a macOS app bundle:

- **Location:** `/Applications/Claude.app`
- **Main binary:** `Contents/MacOS/Claude` -- Mach-O universal binary (x86_64 + arm64)
- **Electron version:** Bundled within `Contents/Frameworks/Electron Framework.framework/`
- **Key frameworks:**
  - `Electron Framework.framework` -- Core Electron runtime
  - `Mantle.framework` -- Model layer framework (Objective-C)
  - `ReactiveObjC.framework` -- Reactive extensions for Objective-C
  - `Squirrel.framework` -- Auto-update framework (Sparkle-based for Electron)
- **Application resources:**
  - `Contents/Resources/app.asar` -- Packed application source (~19 MB)
  - `Contents/Resources/app.asar.unpacked/` -- Native modules excluded from ASAR packing
- **Native modules (in `app.asar.unpacked/node_modules/`):**
  - `@anthropic/claude-native` -- Native Node.js addon for platform integration
  - `@anthropic/claude-swift` -- Swift-based native addon (`swift_addon.node`, ~35 MB); handles macOS-specific functionality including system integration, possibly including MCP server management
  - `node-pty` -- Pseudo-terminal bindings for terminal emulation (used by Code tab)

### Internal Tab System

Claude Desktop exposes three user-facing tabs in its sidebar:

| Tab Label | Internal Name | Route / Rendering |
|-----------|---------------|-------------------|
| **Chat** | `chat` | Rendered locally via `claude.operon` APIs |
| **Cowork** | `epitaxy` / `operon` | Rendered locally via `claude.operon` APIs; NOT Claude Code |
| **Code** | `ccd` (Claude Code Desktop) | Loads from `claude.ai` web frontend at route `/claude-code-desktop` |

**Critical distinction:** "Cowork" is a separate collaborative tab and is **not** Claude Code. The Code tab is the one that runs Claude Code sessions locally.

The sidebar mode is controlled by an enum with the following known values:
```
sidebarMode: "chat" | "code" | "task" | "epitaxy" | "operon"
```

- `"code"` corresponds to the Code tab (CCD)
- `"epitaxy"` and `"operon"` correspond to Cowork-related views
- `"task"` may relate to background task management
- `"chat"` is the standard Chat tab

### Build System

The app is built with **Vite** and follows Electron's multi-process architecture:

```
Contents/Resources/app.asar/
  .vite/
    build/                    # Main process bundles
      index.js                # Main process entry (~9.3 MB minified)
      mainView.js             # Preload script for the main WebContentsView (~173 KB)
      mainWindow.js           # Preload script for the window chrome (~154 KB)
      coworkArtifact.js       # Preload for Cowork artifact sub-views
    renderer/                 # Renderer process assets
      MainWindowPage-TTlZcG1-.js  # Titlebar/error UI (~13.5 KB)
      (additional renderer chunks)
```

**Key files for CCDEX:**
- `mainView.js` is the **injection target** -- it runs as a preload script in the main `WebContentsView` and has access to both `require('electron').ipcRenderer` and the DOM via `window`/`document`.
- `index.js` is the main process bundle containing all IPC handlers, session management logic, and native module integration.

### IPC Architecture

Claude Desktop uses **eipc** (Electron IPC), a structured IPC layer built on top of Electron's native `ipcMain`/`ipcRenderer`. All channels are namespaced under a fixed UUID:

```
ecf9b7a0-beb7-40a8-9885-aa723c019ace
```

Channel naming convention:
```
$eipc_message$_{UUID}_$_{namespace}_$_{service}_$_{method_or_event}
```

**Discovered namespaces and their services:**

| Namespace | Services | Purpose |
|-----------|----------|---------|
| `claude.settings` | `AppConfig`, `AppFeatures`, `AppPreferences`, `WindowState`, `DeveloperSettings` | Application configuration, feature flags, user preferences |
| `claude.web` | `ClaudeCode`, `ClaudeVM`, `LocalSessions`, `LocalAgentModeSessions`, `WebAuth`, `WebNavigation` | Code tab sessions, authentication, web view management |
| `claude.operon` | `OperonFrames`, `OperonEvents`, `OperonNavigation` | Chat & Cowork tab rendering and eventing |
| `claude.skills` | `Skills` | Skill/plugin management |
| `claude.hybrid` | `DesktopIntl` | Internationalization bridge between native and web |
| `claude.officeAddin` | `OfficeAddinFiles` | Office add-in file management |

### Code Tab (CCD) Session Management

`claude.web.LocalSessions` is the primary API governing Code tab sessions. It manages the lifecycle of local Claude Code instances.

**Methods (invokable via IPC):**
- `start(config)` -- Start a new CCD session
- `sendMessage(sessionId, message)` -- Send user input to a session
- `stop(sessionId)` -- Terminate a session
- `getSession(sessionId)` -- Retrieve session metadata
- `getAll()` -- List all active/recent sessions
- `getTranscript(sessionId)` -- Fetch full conversation transcript
- `setModel(sessionId, model)` -- Change the model mid-session
- `setEffort(sessionId, effort)` -- Adjust reasoning effort level
- `setPermissionMode(sessionId, mode)` -- Set tool permission mode (ask/auto/etc.)
- `getSupportedCommands()` -- List available slash commands
- `getAgents()` -- List available agent configurations

**Event channel:**
```
$eipc_message$_ecf9b7a0-beb7-40a8-9885-aa723c019ace_$_claude.web_$_LocalSessions_$_onEvent
```

**Event types emitted on this channel:**
- `message` -- New message in the conversation (user, assistant, system, tool output)
- `session_updated` -- Session metadata changed (model, permissions, etc.)
- `session_started` -- A new session has been created
- `stopped` -- Session terminated
- `archived` -- Session archived
- `deleted` -- Session deleted
- `error` -- An error occurred in the session
- `tool_permission_request` -- A tool is requesting user permission
- `tool_permission_resolved` -- User responded to a permission request
- `initialization_status` -- Session initialization progress

### Message Structure

Messages flowing through the `onEvent` channel have the following structure:

```typescript
interface SessionEvent {
  type: string;           // Event type (see above)
  sessionId: string;      // UUID of the session
  message?: Message;      // Present when type === "message"
  session?: SessionMeta;  // Present when type === "session_updated"
}

interface Message {
  type: "user" | "assistant" | "system" | "result" | "stream_event"
      | "tool_use_summary" | "tool_progress" | "auth_status"
      | "rate_limit_event" | "prompt_suggestion";
  message?: APIResponse;  // Present for "assistant" type
}

interface APIResponse {
  model: string;          // e.g., "claude-sonnet-4-20250514"
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  context_management?: object;  // Context window management metadata
  // ... additional fields
}
```

**Total context usage calculation:**
```
total_tokens = input_tokens
             + cache_creation_input_tokens
             + cache_read_input_tokens
             + output_tokens
```

Note: `input_tokens` from the API represents the non-cached input tokens. The full context window occupancy requires summing all four fields. The `usage` object in each assistant message reflects the **cumulative** state for that turn -- it is not a delta.

### Developer Settings

Claude Desktop supports a developer mode that can be enabled via a JSON configuration file:

- **File:** `~/Library/Application Support/Claude/developer_settings.json`
- **Setting:**
  ```json
  {"allowDevTools": true}
  ```
- **Effect:** Enables Chromium DevTools access:
  - `Option+Cmd+I` keyboard shortcut opens DevTools
  - Right-click context menu gains "Show Dev Tools" and "Inspect Element" entries
- **Persistence:** This file resides in the user data directory, not within the app bundle, so it survives app updates.
- **Internal implementation:** The setting is read by an internal function (minified names: `nj()` / `O8e()`) during app initialization.

### Built-in Slash Commands

Claude Desktop includes several built-in slash commands. Of particular relevance:

```javascript
{
  name: "context",
  description: "Show what's using your context window",
  scope: "cowork"
}
```

**Important:** The `/context` command is scoped to `"cowork"`, meaning it is available in the Cowork tab and provides a detailed breakdown of context usage (MCP tools, skills, plugins, etc.). CCDEX's indicator is **complementary** -- it provides a simpler, always-visible metric specifically for Code tab sessions without requiring manual invocation.

---

## Security Mechanisms Discovered

### Electron Fuses (Critical Discovery)

Electron fuses are compile-time binary flags embedded in the Electron Framework binary. They control security-sensitive behaviors and **cannot** be overridden by environment variables, command-line arguments, or configuration files. They can only be changed by binary-patching the Electron Framework binary itself.

**Tool for reading/writing fuses:**
```bash
npx @electron/fuses@1.8.0 read --app "/Applications/Claude.app"
```

> **Note:** Use v1.8.0 of `@electron/fuses`. The v2.x series changed the CLI syntax.

**Original fuse state in Claude Desktop:**

| Fuse | State | Implication |
|------|-------|-------------|
| `RunAsNode` | **Disabled** | Blocks `ELECTRON_RUN_AS_NODE` environment variable; cannot use the Electron binary as a generic Node.js runtime |
| `EnableCookieEncryption` | Enabled | Cookies are encrypted at rest |
| `EnableNodeOptionsEnvironmentVariable` | **Disabled** | Blocks `NODE_OPTIONS` env var; cannot use `--require` to inject scripts |
| `EnableNodeCliInspectArguments` | **Disabled** | Blocks `--inspect`, `--remote-debugging-port`, etc.; cannot attach debuggers |
| `EnableEmbeddedAsarIntegrityValidation` | **Enabled** | **THE key blocker** -- validates ASAR file integrity at load time |
| `OnlyLoadAppFromAsar` | Enabled | App must be loaded from `.asar`; cannot use an unpacked directory |
| `LoadBrowserProcessSpecificV8Snapshot` | Disabled | No custom V8 snapshot |
| `GrantFileProtocolExtraPrivileges` | Enabled | `file://` protocol has additional privileges |

### ASAR Integrity (Multi-Layer Protection)

Claude Desktop employs three layers of ASAR integrity validation:

**Layer 1: Info.plist `ElectronAsarIntegrity`**

The macOS app bundle's `Info.plist` contains an `ElectronAsarIntegrity` dictionary with a SHA256 hash of the entire `app.asar` file:

```xml
<key>ElectronAsarIntegrity</key>
<dict>
  <key>Resources/app.asar</key>
  <dict>
    <key>algorithm</key>
    <string>SHA256</string>
    <key>hash</key>
    <string>abc123...</string>
  </dict>
</dict>
```

Electron reads this hash at startup and compares it against the actual ASAR file.

**Layer 2: Per-file integrity in ASAR header**

Each file entry in the ASAR archive's JSON header contains an `integrity` sub-object:

```json
{
  "files": {
    ".vite/build/mainView.js": {
      "offset": "12345",
      "size": 173000,
      "integrity": {
        "algorithm": "SHA256",
        "hash": "cbc3...",
        "blockSize": 4194304,
        "blocks": ["cbc3..."]
      }
    }
  }
}
```

The `hash` is the SHA256 of the file's contents. The `blocks` array contains per-block hashes for files larger than `blockSize` (4 MB).

**Layer 3: Electron Fuse**

The `EnableEmbeddedAsarIntegrityValidation` fuse is the master switch. When enabled, Electron enforces both Layer 1 and Layer 2 checks. When disabled, integrity validation is skipped entirely.

### Code Signing

- **Team ID:** Q6L2SF6YDW (Anthropic)
- **Hardened runtime:** Enabled
- **Entitlements:** Standard Electron entitlements (JIT, unsigned memory, dylib loading)
- **Behavior after modification:**
  - `codesign --remove-signature` has issues with complex Electron bundles (reports internal errors)
  - `codesign --force --deep --sign -` (ad-hoc signing) works as a replacement
  - Ad-hoc signed apps can run locally but will trigger Gatekeeper warnings if re-distributed

---

## Approaches Attempted

### 1. `--remote-debugging-port` (FAILED)

**Approach:** Launch Claude Desktop with `--remote-debugging-port=9222` to enable the Chrome DevTools Protocol (CDP) on a WebSocket port. An external script would then connect via WebSocket and inject JavaScript.

**Result:** App crashes immediately on startup with a signal abort.

**Root cause:** The `EnableNodeCliInspectArguments` fuse is disabled. Electron terminates the process when it detects a blocked CLI flag.

### 2. `--inspect=9229` (PARTIAL)

**Approach:** Attach the V8 Inspector Protocol (a different protocol from CDP) to enable debugging the main process.

**Result:** The app launches successfully (the flag is silently accepted), but no inspector port is bound.

**Root cause:** The fuse blocks the actual port binding even though the flag doesn't cause a crash. The flag is parsed by V8 before Electron's fuse check suppresses it.

### 3. `NODE_OPTIONS` environment variable (BLOCKED)

**Approach:** Set `NODE_OPTIONS=--require=/path/to/inject.js` to force-load a script into the main process before the app's own code executes.

**Result:** Environment variable is silently ignored.

**Root cause:** The `EnableNodeOptionsEnvironmentVariable` fuse is disabled. Electron strips `NODE_OPTIONS` from the environment before V8 processes it.

### 4. ASAR repack with `npx asar pack` (FAILED)

**Approach:**
1. Extract `app.asar` with `npx asar extract`
2. Modify `mainView.js` by appending injection code
3. Repack with `npx asar pack`
4. Update the `ElectronAsarIntegrity` hash in `Info.plist`

**Result:** `EXC_BREAKPOINT` crash on startup.

**Root cause:** The `npx asar pack` tool generates a new ASAR file with completely different internal layout (file offsets, header structure). While the Info.plist hash was updated for the new file, the **per-file integrity hashes inside the ASAR header** (Layer 2) were recalculated by the packer using the new file contents -- but the fuse-level integrity check (Layer 3) still detected a mismatch because the validation compares against expected hashes embedded elsewhere, or the overall header structure/alignment differed from the original.

### 5. Binary ASAR patching with header hash update (FAILED)

**Approach:** A custom Python script to perform in-place binary patching of the ASAR file:
1. Parse the ASAR header JSON
2. Locate `mainView.js` by offset and size
3. Replace the file content in the binary data section
4. Update the file's `integrity.hash` in the header JSON
5. Update file sizes and offsets for all subsequent files
6. Rewrite the ASAR file with the corrected header
7. Update the Info.plist hash

**Result:** Still `EXC_BREAKPOINT` on startup.

**Root cause:** The `EnableEmbeddedAsarIntegrityValidation` fuse was still enabled. Even with perfectly correct per-file hashes and a correct Info.plist hash, the fuse-level check performs its own validation that rejected the modified file. The fuse check may compare against hashes baked into the Electron Framework binary at build time, or uses a different validation path that our patching didn't account for.

### 6. Removing `ElectronAsarIntegrity` from Info.plist (FAILED)

**Approach:** Use `plutil -remove ElectronAsarIntegrity Info.plist` to completely remove the integrity metadata, hoping Electron would skip the check.

**Result:** Still crashes.

**Root cause:** The fuse-level check is independent of the Info.plist key's presence. When the fuse is enabled, Electron expects the integrity data to be present and valid. Removing it is treated as a validation failure, not a "skip validation" signal.

### 7. Disable Fuse + Binary ASAR Patch (SUCCESS)

**Approach (three-step):**

**Step 1: Disable the ASAR integrity fuse**
```bash
npx @electron/fuses@1.8.0 write \
  --app "/Applications/Claude.app" \
  EnableEmbeddedAsarIntegrityValidation=off
```
This flips a single byte in the `Electron Framework` binary from `1` to `0`.

**Step 2: Binary-patch the ASAR**
Using the custom Python script:
1. Parse ASAR header, find `mainView.js` entry
2. Read original file content from the data section
3. Append the CCDEX injection script to the end of the file
4. Compute new SHA256 hash for the modified content
5. Update the ASAR header: new file size, new integrity hash, shifted offsets for all subsequent files
6. Reconstruct the ASAR binary: new header + pre-patch data + patched file + post-patch data
7. Compute whole-file SHA256 and update Info.plist (for completeness, though the fuse is now off)

**Step 3: Install and launch**
```bash
cp /tmp/app-patched.asar "/Applications/Claude.app/Contents/Resources/app.asar"
open /Applications/Claude.app
```

Note: `sudo` is typically not needed if the user owns the file. Re-signing with `codesign --force --deep --sign -` is optional — the app runs without it when the ASAR integrity fuse is disabled.

**Result:** App launches normally, Code tab loads, footer bar shows context usage + rate limit indicators. Full success.

---

## Implementation Details

### Injection Point

- **File:** `.vite/build/mainView.js` (inside `app.asar`)
- **Method:** Code is appended to the end of the file, after the existing source map comment (`//# sourceMappingURL=...`)
- **Execution context:** The preload script runs in a privileged context with access to:
  - `require('electron').ipcRenderer` -- for listening to IPC events
  - `window` / `document` -- for DOM manipulation in the renderer
  - Node.js APIs (fs, path, etc.) -- though CCDEX does not use these

### Binary ASAR Patching (Python)

**ASAR file format:**

```
+---------------------------------------------------+
| Header Block                                       |
|  - 4 bytes: UInt32 pickle header size              |
|  - 4 bytes: UInt32 header string size              |
|  - 4 bytes: UInt32 total header size               |
|  - 4 bytes: UInt32 header string size (repeated)   |
|  - N bytes: JSON header string (UTF-8)             |
|  - P bytes: Padding to align to 4-byte boundary    |
+---------------------------------------------------+
| Data Block                                         |
|  - File 1 content (at offset 0, relative to data)  |
|  - File 2 content (at offset = file1.size)          |
|  - ...                                             |
+---------------------------------------------------+
```

File offsets in the JSON header are **relative to the start of the data block** (i.e., relative to the end of the header block).

**Patching process (pseudocode):**

```python
# 1. Read ASAR file
raw = open("app.asar", "rb").read()

# 2. Parse header
header_size = struct.unpack("<I", raw[4:8])[0]
header_json = json.loads(raw[16:16+header_size])

# 3. Find mainView.js entry
entry = header_json["files"][".vite"]["files"]["build"]["files"]["mainView.js"]
original_offset = int(entry["offset"])
original_size = entry["size"]

# 4. Read original content, append injection
data_start = 16 + header_size + padding
original_content = raw[data_start + original_offset : data_start + original_offset + original_size]
injection = open("context-indicator.js", "rb").read()
new_content = original_content + b"\n" + injection
size_delta = len(new_content) - original_size

# 5. Update header entry
entry["size"] = len(new_content)
entry["integrity"]["hash"] = sha256(new_content).hexdigest()
entry["integrity"]["blocks"] = [sha256(new_content).hexdigest()]

# 6. Shift offsets for all files after mainView.js
for file_entry in all_entries_after(original_offset):
    file_entry["offset"] = str(int(file_entry["offset"]) + size_delta)

# 7. Reconstruct ASAR
new_header_json = json.dumps(header_json)
new_asar = build_header(new_header_json) + data_before + new_content + data_after

# 8. Write and update Info.plist
open("app.asar", "wb").write(new_asar)
update_infoplist_hash(sha256(new_asar).hexdigest())
```

### The Injection Script (`context-indicator.js`)

**Architecture:**
- Self-executing IIFE (Immediately Invoked Function Expression) to avoid polluting the global scope
- Listens on the eipc event channel for `LocalSessions` `onEvent` messages
- Maintains a `Map<sessionId, SessionState>` to track per-session token usage
- Fetches rate limit data directly from `claude.ai` via same-origin `fetch`
- Injects indicator into the footer bar using MutationObserver for resilience

**Token tracking logic:**
- On `message` events with `type === "assistant"`, extract `usage` from the API response
- Track `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` as input
- Track `output_tokens` separately
- Sum all for total context usage
- Compare against model-specific limits (default: 200,000 tokens)

**Rate limit fetching:**
- The Code tab loads from `https://claude.ai/claude-code-desktop/...`
- Fetching `GET /api/organizations/{orgId}/usage` is same-origin — session cookies are sent automatically
- The org ID is extracted from the `lastActiveOrg` cookie: `document.cookie.match(/lastActiveOrg=([^;]+)/)`
- Response format: `{ five_hour: { utilization: 0-100, resets_at: "ISO8601" }, seven_day: { ... } }`
- Fetched on startup (3s delay), every 60s, and triggered by `rate_limit_event` IPC events
- No external scripts, Keychain access, or manual token configuration needed

**UI component:**

The indicator is injected into the footer bar's `flex-1` spacer element, positioned between the path display and the action buttons (VS Code button, etc.).

```
┌─────────────────────────────────────────────────────────────────────┐
│ ~/path/to/project  [==]  46.7k / 200.0k · 5h [==] 2% 4h35m · Wk [==] 5% 6d  🔈 ▼ │
│                    ╰── context bar ────╯   ╰── 5h rate limit ──╯   ╰── weekly ─╯     │
└─────────────────────────────────────────────────────────────────────┘
```

- **Injection target:** `section#turn-form` → parent → nextElementSibling (footer) → firstElementChild (row) → child with class `flex-1` (spacer)
- **MutationObserver:** Watches for DOM rebuilds (tab switches, navigation) and re-injects as needed
- **Font:** 11px, `tabular-nums` for stable numeric widths
- **Text color:** `rgba(0, 0, 0, 0.36)` — matches footer's subdued appearance
- **Bar backgrounds:** `rgba(0, 0, 0, 0.08)`, 40px wide, 3px height, 1.5px border-radius
- **Bar fills:** Must be `display: block` — rate limit bars use `<span>` elements (inline by default), so explicit block display is required for `width`/`height` to take effect
- **Pointer events:** Disabled (`pointer-events: none`) so it doesn't interfere with the app
- **Transitions:** 300ms ease on width, background-color, and opacity

**Color coding:**

| Usage Level | Color | Hex |
|-------------|-------|-----|
| < 50% | Green | `#34d399` |
| 50% - 80% | Amber | `#fbbf24` |
| > 80% | Red | `#f87171` |

**Rate limit display modes:**
- **Percentage mode** (from API fetch): Shows bar + percentage + countdown (e.g., `5h [====] 2% 4h35m`)
- **Dot mode** (from IPC events only, no percentage): Shows green/red dot + countdown

**Lifecycle:**
1. MutationObserver watches for footer bar availability
2. Indicator is injected into footer spacer when found
3. Context bar updates on each assistant message
4. Rate limits fetched on startup, periodically, and on rate_limit_event
5. Hides when session is stopped, archived, or deleted
6. Re-injects automatically if DOM is rebuilt

### Fuse Modification

**What fuses are:** Fuses are single-byte flags stored at known offsets within the Electron Framework binary. The `@electron/fuses` npm package knows these offsets and can read/write them.

**Command to disable ASAR integrity validation:**
```bash
npx @electron/fuses@1.8.0 write \
  --app "/Applications/Claude.app" \
  EnableEmbeddedAsarIntegrityValidation=off
```

**What it does:** Finds the `Electron Framework` binary at:
```
/Applications/Claude.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework
```
and flips the `EnableEmbeddedAsarIntegrityValidation` fuse byte from `0x01` (enabled/on) to `0x00` (disabled/off).

**Important:** The `@electron/fuses` v2.x package changed its CLI syntax. Stick with v1.8.0 for the `write --app ... FuseName=off` format.

---

## Files Modified in Claude.app

| # | File | Modification |
|---|------|-------------|
| 1 | `Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework` | Single byte flipped (ASAR integrity fuse disabled) |
| 2 | `Contents/Resources/app.asar` | `mainView.js` extended with CCDEX injection code; ASAR header updated with new hashes and offsets |

---

## Maintenance Notes

### Auto-Update Impact

Claude Desktop auto-updates (via Squirrel framework) will replace:
- The entire `Contents/` directory (including Electron Framework and app.asar)
- This means **both the fuse flip and the ASAR patch are lost** after every update

**After each update, reapply:**
1. Fuse disable: `npx @electron/fuses@1.8.0 write --app "/Applications/Claude.app" EnableEmbeddedAsarIntegrityValidation=off`
2. ASAR binary patch: `python3 patch.py`
3. Install: `cp /tmp/app-patched.asar "/Applications/Claude.app/Contents/Resources/app.asar"`

Note: `sudo` is typically not needed if your user owns the app.asar file. Re-signing with `codesign` is not required when the ASAR integrity fuse is disabled.

### What Survives Updates

- `~/Library/Application Support/Claude/developer_settings.json` (user data directory, not inside app bundle)
- CCDEX source files in `/Users/hiko/Documents/repos/Personal/CCDEX/`

### Backup

- Original unmodified ASAR is backed up at `/tmp/claude-app-extract-backup.asar` (ephemeral; copy to a persistent location if needed)

---

## Future Improvements

- **Automation:** Combine fuse flip, ASAR patch, and install into a single idempotent shell script that can be run after each Claude Desktop update
- **Model-aware limits:** Detect the active model and adjust the context limit accordingly (200k for standard models, 1M for extended context models like Opus with 1M)
- **Cache hit ratio display:** Show what percentage of input tokens came from cache vs. fresh computation
- **Cost estimation:** Calculate approximate API cost based on token counts and model pricing
- **Update watcher:** Monitor Claude Desktop for updates (e.g., watch the app bundle's modification time via `FSEvents`) and automatically re-patch
- **Richer metrics:** Display per-turn token deltas, cumulative cost, or a mini-chart of context growth over time
- **Dark mode support:** Currently light theme only; detect `prefers-color-scheme` and adjust colors
- **Per-model rate limits:** API also returns `seven_day_sonnet`, `seven_day_opus` — could show model-specific breakdown
