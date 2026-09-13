# Code Context — 6-file summary

## Files Retrieved

1. `src/lib/navigation.ts` (1 line) — WorkbenchView type union.
2. `src/lib/exportSession.ts` (whole file) — transcript → Markdown exporter.
3. `src/lib/askBlock.test.ts` (whole file) — tests for `askBlock.ts` (not in this set).
4. `src/lib/awaitingAnswer.ts` (whole file) — "session is waiting on you" detection.
5. `src/lib/awaitingAnswer.test.ts` (whole file) — tests for `awaitingAnswer.ts`.
6. `src/lib/exportSession.test.ts` (whole file) — tests for `exportSession.ts`.

## Per-file summary

### 1. src/lib/navigation.ts

- **Purpose:** Single source of truth for the workbench's top-level view names.
- **Exports:** `type WorkbenchView = 'sessions' | 'fleet' | 'skills' | 'extensions' | 'settings'`.
- **Relations:** Standalone type; no imports. Consumed by UI routing (not in this set).

### 2. src/lib/exportSession.ts

- **Purpose:** Render a `TimelineItem[]` transcript as readable Markdown (one heading per turn, tool calls collapsed into `<details>`, permission decisions kept), plus a filesystem-safe dated filename.
- **Exports:** `interface ExportMeta` (title, backend, model?, cwd?, exportedAt?); `timelineToMarkdown(items, meta): string`; `exportFilename(title, at?): string`. Private helpers `fence()` (lengthens fence to survive nested backticks) and `trim()` (truncates with a character count).
- **Relations:** Imports `TimelineItem` from `./timeline`. Tested by `exportSession.test.ts`.

### 3. src/lib/askBlock.test.ts

- **Purpose:** Tests for `./askBlock.ts` (the ask-block parser — not among the 6 files read here).
- **Exports:** None (test-only). Exercises `hasAskBlock`, `parseAsk`, `firstAsk`, `messageAsk`, `isAskMessage`.
- **Relations:** Depends on `askBlock.ts`. `isAskMessage` is consumed by `awaitingAnswer.ts`, so this test indirectly guards the awaiting-answer path.

### 4. src/lib/awaitingAnswer.ts

- **Purpose:** Decide whether a settled session turn is parked waiting on a user answer (vs. finished/crashed/interrupted).
- **Exports:** `textAwaitsAnswer(text): boolean` (trailing "?" or ≥2 numbered questions); `isAwaitingAnswer(items, working): boolean` (false while working; finds last user/assistant/tool item, ignores trailing notices; true if `isAskMessage(last.text)` or `textAwaitsAnswer(last.text)`).
- **Relations:** Imports `TimelineItem` from `./timeline.ts` and `isAskMessage` from `./askBlock.ts`. Tested by `awaitingAnswer.test.ts`.

### 5. src/lib/awaitingAnswer.test.ts

- **Purpose:** Tests for `awaitingAnswer.ts`.
- **Exports:** None. Builds `assistant`/`user`/`notice` TimelineItem fixtures; covers trailing-question, numbered-clarify, closing-report (negative), running-turn (negative), answered (negative), trailing-notice, and ask-fence cases.
- **Relations:** Directly tests `isAwaitingAnswer` from `awaitingAnswer.ts`.

### 6. src/lib/exportSession.test.ts

- **Purpose:** Tests for `exportSession.ts`.
- **Exports:** None. Covers header/order rendering, nested-fence escaping, truncation-with-count, and slugged/dated filenames.
- **Relations:** Directly tests `timelineToMarkdown` and `exportFilename` from `exportSession.ts`.

## Cross-file wiring note

- `exportSession.test.ts` → tests `exportSession.ts`; `awaitingAnswer.test.ts` → tests `awaitingAnswer.ts` (both direct, same-name pairs).
- `askBlock.test.ts` → tests `askBlock.ts` (not in this set) but is the upstream guard for `awaitingAnswer.ts`, which imports `isAskMessage` from `askBlock.ts`.
- `awaitingAnswer.ts` and `exportSession.ts` both depend on `TimelineItem` from `./timeline.ts` (shared data model).
- `navigation.ts` is isolated — a pure type, no runtime deps.
