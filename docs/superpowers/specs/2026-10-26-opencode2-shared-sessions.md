# OpenCode 2 shared sessions

The user confirmed that DingTalk and the existing OpenCode installation must continue the same live session.

## Contract

- Connect Bridge to the user's existing OpenCode 2.0.24 service through HTTP and SSE.
- Preserve native session IDs, message IDs, project directories, configured Agents, models, and permissions.
- Never open the OpenCode database for writes, downgrade it, or copy transcripts into the legacy runtime.
- Preserve the existing OpenCode 1 SDK path for users of legacy servers.
- Preserve the currently running deployment until a test-backed replacement is built.
- Discover the native service URL and authentication at each Windows login; its port is not fixed.
- Stopping Bridge must not terminate the user's native OpenCode service.
- Do not send messages to DingTalk during verification. Use a dedicated native test session for prompt tests.

## Architecture

Introduce an in-process compatibility transport shared by the old SDK and explicit OpenCode HTTP calls.
It detects the native API through authenticated `/api/info`, translates legacy requests to native `/api/*`,
unwraps paginated responses, and maps native records and SSE events to the Bridge's established representations.
No additional network listener or database conversion is needed.

Record conversion and event conversion are isolated from transport so they can be tested with synthetic fixtures.
The native session is the authority for its current model and Agent; Bridge changes are sent only when explicitly selected.
Unsupported native operations return explicit errors rather than pretending that a legacy request succeeded.

## Required behavior

List and bind existing sessions across projects; load history; create and rename sessions; continue a selected
session with text and attachments; stream assistant text, reasoning and tools; report completion/errors;
switch model/Agent when requested; interrupt generation; respond to native permission requests and basic forms.
Pagination must not silently hide older sessions or messages. Reconnect must not duplicate text.
The legacy SDK path and its tests must continue to work.

## Verification

Unit tests cover records, SSE framing/state, pagination, native request shapes, permissions and protocol errors.
HTTP fixture tests cover the actual compatibility transport and existing SDK entry points.
Local read checks compare native session IDs to Bridge IDs. A dedicated test session verifies that a Bridge prompt
appears under the same native ID and that its assistant output is readable from both interfaces.
No existing user session is deleted or used for test prompts. Local secrets and transcript fixtures stay out of Git.
