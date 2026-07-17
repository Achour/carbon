# Codex Integration — Final Verification

**Review date:** 2026-07-13
**Repository:** Carbon (`ai-gui`)
**Branch:** `sdk-integration-features`

## Verdict

The Codex integration is complete and verified. All previously reported correctness findings are fixed, the production application packages successfully, and live packaged turns pass for both Codex and Claude Code.

## Verified capabilities

- Provider-specific model selection and effort mapping.
- Codex Default model defers to the user's Codex configuration.
- Multi-turn thread reuse and resume after application restart.
- Automatic recovery when a persisted Codex rollout no longer exists.
- Workspace-write, read-only Plan mode, and full-access sandbox mapping.
- Plan proposal review with **Request changes** and **Approve plan**.
- Approval switches out of Plan mode and automatically implements the approved plan.
- Terminal commands, file changes, tool status updates, interruption, and recovery.
- Image attachments and temporary-file cleanup.
- Built-in Codex image generation displayed inline, including Low effort turns that return no final text.
- Generated-image source/intermediate suppression and final-output preference.
- Local-image cache invalidation for active chats, background chats, reopened chats, and file refreshes.
- Provider-isolated slash commands, session details, notifications, context display, and rewind controls.
- Viewport-bounded model, effort, and permission selectors with internal scrolling.
- Production dependency pruning and packaged subprocess/native-module operation.

## Final live verification

### Codex

- First turn, terminal execution, file creation, and exact marker response: passed.
- Second turn on the same thread: passed.
- Resume after packaged application restart with the same thread id: passed.
- Stale/missing rollout recovery with the original prompt preserved: passed.
- Read-only sandbox rejected a requested write: passed.
- Image attachment recognition and temporary-file cleanup: passed.
- Interrupt followed by a successful next turn: passed.
- Low-effort image generation rendered the generated file: passed.
- Plan proposal → request changes → revised proposal → approve → automatic implementation: passed.
- Planning and revision turns made no file changes; approval wrote exactly the revised content: passed.

### Claude Code regression

Packaged Claude turns were repeated after the Codex session, image, Plan-mode, and UI changes. The final exact response was:

```text
CLAUDE_PLAN_REVIEW_REGRESSION_OK
```

No Claude session implementation was changed by the final Codex Plan-mode or selector fixes.

## Automated and build gates

- `npm test` — **37/37 passed**
- `npm run typecheck` — **passed**
- `git diff --check` — **passed**
- `npm run package` — **passed**
- Minimum-height model-selector screenshot regression — **passed**

The production dependency tree contains only main-process runtime dependencies:

- `@anthropic-ai/claude-agent-sdk`
- `@openai/codex-sdk`
- `node-pty`

## Notes

- The Codex SDK does not currently expose the interactive client's collaboration-mode switch or per-tool approval callback. Carbon supplies equivalent Plan/Default turn instructions, enforces Plan mode with the read-only sandbox, and maps completed Codex proposals into the existing provider-neutral plan-review UI.
- Electron Builder warns because ASAR is intentionally disabled. Both agent SDKs launch subprocess runtimes that must remain unpacked; packaged Codex, Claude, and node-pty operation were verified.
- Chromium development cache and insecure-development-CSP messages are development-only warnings and are not Codex integration failures.

## Final status

No unresolved Codex integration correctness findings remain from this review.
