# NanoClaw Migration Guide

Generated: 2026-06-10
Base: 934f063aff5c30e7b49ce58b53b41901d3472a3e
HEAD at generation: 1d48f00759b2a3c8f9e8d7a6b5c4e3d2a1b0c9f8e8d
Upstream: upstream/main (820cd8e)

## Migration Plan

Order of operations:
1. Create worktree from upstream/main
2. Apply upstream skill branches (channels branch for WhatsApp/Telegram/etc.)
3. Copy add-feishu skill directory
4. Copy/create Feishu source files
5. Modify src/channels/index.ts to register feishu
6. Modify src/index.ts and src/types.ts for streaming support
7. Update Dockerfile if needed
8. Validate build

## Applied Skills

### add-feishu
**Source:** Local custom skill (no upstream equivalent)
**Branch:** N/A — entirely custom addition
**Files:** `.claude/skills/add-feishu/` (entire directory)

### Other skills from upstream
These skills exist in upstream branches and will be re-applied via:
- `upstream/channels` — WhatsApp, Telegram, Slack, Discord, Gmail channels
- `upstream/skill/compact` — compact command
- `upstream/skill/emacs` — emacs channel
- `upstream/skill/migrate-nanoclaw` — migrate skill
- etc.

## Skill Interactions

- Feishu streaming uses `createFeishuReplyDispatcher` in index.ts, which requires the feishu channel to be registered before the streaming logic runs
- No known conflicts with other channels

## Modifications to Applied Skills

None — add-feishu is the only custom skill and was not further modified after creation.

## Customizations

### Feishu Channel — Complete Implementation

**Intent:** Add Feishu (飞书) as a messaging channel. Supports receiving messages, sending replies, typing indicators via message reactions, and streaming output with interactive cards.

**Files:**
- `src/channels/feishu.ts` — Main Feishu channel implementation
- `src/channels/feishu-streaming.ts` — Streaming card support using Feishu CardKit API
- `src/channels/feishu-reply-dispatcher.ts` — Reply dispatcher for streaming output
- `src/channels/feishu-reply-dispatcher.test.ts` — Tests for reply dispatcher
- `src/channels/feishu.test.ts` — Tests for feishu channel

**How to apply:**

1. Copy all feishu source files to `src/channels/`:
   - `feishu.ts`
   - `feishu-streaming.ts`
   - `feishu-reply-dispatcher.ts`
   - `feishu-reply-dispatcher.test.ts`
   - `feishu.test.ts`

2. In `src/channels/index.ts`, add after the existing imports:
   ```typescript
   // feishu
   import './feishu.js';
   ```

3. In `src/types.ts`, add streaming methods to the Channel interface:
   ```typescript
   // Optional: streaming output. Channels that support it implement these.
   startStreaming?(jid: string, replyToMessageId?: string): Promise<string>; // returns sessionId
   updateStreaming?(sessionId: string, text: string): Promise<void>;
   endStreaming?(sessionId: string, finalText?: string): Promise<void>;
   ```
   And add the StreamingSession type:
   ```typescript
   export type StreamingSession = {
     id: string;
     jid: string;
     replyToMessageId?: string;
   };
   ```

4. In `src/index.ts`:
   - Add import at top: `import { createFeishuReplyDispatcher } from './channels/feishu-reply-dispatcher.js';`
   - In `processGroupMessages()` function, after the `supportsStreaming` check (around line 290), add reply dispatcher creation when channel supports streaming
   - See the current `src/index.ts` for the full streaming integration pattern (lines 288-365)

### add-feishu Skill Directory

**Intent:** Skill directory for installing/configuring the Feishu channel via `/add-feishu` command.

**Files:** `.claude/skills/add-feishu/` (entire directory)

**How to apply:**
Copy the entire `.claude/skills/add-feishu/` directory to the worktree.

Contains:
- `SKILL.md` — skill definition
- `manifest.yaml` — skill manifest
- `add/src/channels/feishu.test.ts` — skill-provided test file
- `add/src/channels/feishu.ts` — skill version of channel (may differ from main tree)
- `modify/src/channels/index.ts` — modification to register channel
- `modify/src/channels/index.ts.intent.md` — intent documentation
- `tests/feishu.test.ts` — integration tests
- `LICENSE`, `README.md`, `README_zh.md` — documentation

### Dockerfile — Feishu Build Context

**Intent:** The Dockerfile likely includes feishu-related build steps or dependencies from the skill merge.

**Files:** `container/Dockerfile`

**How to apply:**
Check if upstream Dockerfile has changed significantly. If the user's Dockerfile has additions for feishu (check `git diff 934f063..HEAD -- container/Dockerfile`), re-apply those specific additions to the upstream Dockerfile.

### package.json — Dependencies

**Intent:** Feishu SDK dependency (`@larksuiteoapi/node-sdk`) is required.

**Files:** `package.json`, `package-lock.json`

**How to apply:**
The `@larksuiteoapi/node-sdk` dependency should already be present in upstream (since feishu skill was merged via skill mechanism). If not, add:
```json
"@larksuiteoapi/node-sdk": "^2.x"
```