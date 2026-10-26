# OpenCode 2 Shared Sessions Implementation Plan

> **For agentic workers:** Use test-driven implementation and task review. Tasks are coupled at the declared transport/record interface; the controller integrates them in this session.

**Goal:** Continue the same native OpenCode 2.0 session from DingTalk and Bridge Web chat.

**Architecture:** Keep the existing SDK-facing contract and introduce an in-process native API transport. Map native records/events in pure modules, route SDK and raw requests through that transport, and update the Windows launcher to discover the existing native service.

**Tech Stack:** TypeScript, native fetch/Streams, Vitest, existing OpenCode SDK, PowerShell.

**Spec:** `docs/superpowers/specs/2026-10-26-opencode2-shared-sessions.md`

## Global Constraints

- Native OpenCode version: 2.0.24; retain legacy OpenCode 1 behavior.
- Preserve session IDs and message IDs. Never write the native database or upload local secrets/history.
- Use a dedicated session for live prompt verification. Do not send DingTalk messages.
- Native service owns its model/Agent defaults; stop only Bridge-owned processes.

## Task 1: Native record and event conversion

**Files:** Create `src/opencode/v2-records.ts`, `src/opencode/v2-events.ts`, `tests/opencode-v2-records.test.ts`, `tests/opencode-v2-events.test.ts`.

**Interfaces:** Export `toLegacySession(value: unknown): Record<string, any>`, `toLegacyMessages(sessionId: string, values: unknown[]): Array<{info: any; parts: any[]}>`, `toLegacyProviders(providers: unknown[], models: unknown[]): {providers: any[]; default: Record<string,string>}`.
Export class `V2EventMapper` with `map(event: unknown): Array<{type: string; properties: Record<string, any>}>`, `getForm(id: string): any`, and `forgetForm(id: string): void`.
Use validated object guards at external boundaries; synthetic test fixtures must contain no local transcript data.

- [ ] Write failing tests with native IDs `ses_shared` and `msg_shared`, ISO timestamps, two text ordinals, reasoning and tool success/failure.
- [ ] Run `npx vitest run tests/opencode-v2-records.test.ts tests/opencode-v2-events.test.ts` and observe missing behavior.
- [ ] Map native user text/files and assistant content to SDK info/parts without changing IDs; convert timestamps to milliseconds and tool content to readable output.
- [ ] Map native text/reasoning deltas and terminal snapshots without duplicating text; retain tool identity across input/start/progress/success events.
- [ ] Map execution status/errors, permission requests, and native basic forms. Preserve form field keys for reply translation.
- [ ] Run the focused tests and `npm run build`; commit the task.

## Task 2: Version-aware HTTP/SSE transport and Bridge integration

**Files:** Create `src/opencode/transport.ts`, `src/opencode/v2-transport.ts`, `tests/opencode-v2-transport.test.ts`; modify `src/opencode/client.ts`, `messages.ts`, `event-stream.ts`, and direct OpenCode HTTP call sites.

**Interfaces:** `fetchOpenCode(input: RequestInfo | URL, init?: RequestInit): Promise<Response>`, `getOpenCodeProtocol(): 'v1' | 'v2' | undefined`; `V2Transport` receives base URL, auth headers, and injectable `fetch`, with `fetch` and protocol detection.
Consumes Task 1 conversion exports. SDK `createOpencodeClient` must receive the shared fetch implementation.

- [ ] Use an HTTP fixture server to assert `/api/session` cursor pagination, exact `/api/session/ses_shared/prompt` submission, `/agent` and `/model` switches, and failed authentication.
- [ ] Verify tests fail before implementation.
- [ ] Implement detection using JSON `/api/info`; a 401/403 is an auth failure, not a legacy fallback.
- [ ] Translate list/get/create/update/messages/prompt/interrupt/permission/form and metadata routes; unwrap native envelopes; reject unsupported writes explicitly.
- [ ] Translate `/api/event` SSE incrementally with cancellation and native event mapping; use one native subscription instead of duplicate per-directory subscriptions.
- [ ] Native prompts inherit session defaults unless explicit model/Agent options are present. Legacy prompts retain existing Bridge default behavior.
- [ ] Run focused tests and baseline suite/build, review, then commit.

## Task 3: Native Windows deployment and live verification

**Files:** Update `deploy/windows-node/start.ps1`, `stop.ps1`, `prepare.mjs`, `admin.mjs`, README and add local verification scripts without embedded secrets.

**Interfaces:** Discover native URL through the global `opencode service status/start` commands; read the existing local service credential only into memory; start the fork's compiled Bridge with native service settings.

- [ ] Test repeated launcher execution with a native service and ensure it does not start the legacy executable or stop native OpenCode.
- [ ] Retain rollback records and legacy data; build the fork and use its existing Web assets.
- [ ] Verify all native session IDs are visible in Bridge and selected history loads under the same ID.
- [ ] Create a dedicated session, submit one harmless prompt through Bridge, and verify native history and SSE completion under that ID.
- [ ] Verify native Agents/models, permission mapping and Windows startup entry; run regression tests.
- [ ] Request a whole-branch code review, fix important findings, commit, and push the feature branch.
