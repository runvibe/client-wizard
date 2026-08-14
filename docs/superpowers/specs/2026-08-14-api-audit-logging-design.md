# API Audit Logging Design

## Context

Client Wizard already has an IndexedDB-backed audit log, but network calls are currently logged only around higher-level actions such as `manifest.load.start` and `manifest.load.error`. When a browser `fetch()` fails because of CORS, the application only receives a generic `TypeError: Failed to fetch`; the audit log does not record the attempted HTTP request, elapsed time, safe request metadata, or the fact that the browser did not expose a response.

The audit trail should make API behavior diagnosable from inside the app. Every API call made by the host runtime or by native download operations should produce structured request/response/error events with sanitized, bounded metadata.

## Goals

- Audit every host network call for manifests, consent documents, Markdown documents, script artifacts, and archive artifacts.
- Audit native network/download operations triggered by `wizard.js`, including `clientWizard.downloadFile`.
- Record both successful and failed responses with enough detail to diagnose HTTP, CORS, content-type, and payload issues.
- Include sanitized body previews for successful and failed text/JSON responses.
- Persist sanitized audit events to a disk-backed JSONL log so external tools can read or tail the audit stream.
- Avoid logging secrets, cookies, authorization headers, or large/binary payload contents.
- Preserve existing UX and existing higher-level audit events.

## Non-goals

- Do not bypass browser CORS in the frontend.
- Do not add a new backend proxy for manifest/document/artifact fetches in this change.
- Do not persist full response bodies or binary payload content in the audit log.
- Do not change manifest validation rules, consent flow rules, or artifact trust rules.
- Do not replace the current IndexedDB audit UI in this change.

## Recommended Approach

Introduce a centralized `auditedFetch` helper for frontend network calls, add equivalent native-side audit events for Tauri download commands, and mirror sanitized audit events to a disk-backed JSONL sink.

The frontend helper wraps `fetch()` and emits:

1. `network.request` before the call starts.
2. `network.response` when a `Response` is available, including non-2xx responses.
3. `network.error` when no `Response` is available, such as CORS failures, DNS failures, connection failures, or browser-blocked requests.

Native download operations should emit the same logical event family through the existing audit bridge from the caller side, using request metadata before invoking native code and native command results/errors after completion.

The existing IndexedDB audit store remains the source for the in-app Audit window. The new disk sink is an additional persistence target designed for external access by support tools, log collectors, shell users, and automation.

## Event Shape

Each network event should include a correlation id so request and response/error records can be paired.

### Request event

- `requestId`
- `method`
- `url`
- `source`: one of `manifest`, `document`, `markdown`, `artifact`, `native-download`, or `wizard`
- `headers`: sanitized safe headers only
- `startedAt`

### Response event

- `requestId`
- `method`
- `url`
- `source`
- `status`
- `statusText`
- `ok`
- `headers`: sanitized safe response headers
- `contentType`
- `contentLength`
- `durationMs`
- `bodyPreview`: sanitized preview for text-like payloads
- `bodyPreviewTruncated`: boolean
- `binarySummary`: byte count and optional hash for binary payloads, without raw content

### Error event

- `requestId`
- `method`
- `url`
- `source`
- `durationMs`
- `errorName`
- `errorMessage`
- `responseAvailable`: false when the browser did not expose a response
- `likelyCause`: optional diagnostic string such as `cors-or-network` when the error is a browser `TypeError` from `fetch()`

## Body Preview Rules

- Text-like responses include `application/json`, `text/*`, `application/xml`, `application/xhtml+xml`, and JavaScript/Markdown MIME types.
- Success and error body previews are logged with the same limit.
- The preview limit is 4 KB per audit event.
- Truncated previews must include `bodyPreviewTruncated: true`.
- Binary responses must not store raw body previews.
- If reading a preview fails, the audit log should record the preview error without hiding the original network result.

## Sanitization Rules

Headers and body previews must be sanitized before persistence.

Headers to redact:

- `authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `x-amz-security-token`
- any header containing `token`, `secret`, `password`, or `credential`

Body fields to redact in JSON-like previews:

- `token`
- `secret`
- `password`
- `authorization`
- `cookie`
- `credential`
- `apiKey`
- `accessKey`
- `secretKey`

The existing audit payload sanitizer remains a final defense-in-depth layer.

## Disk JSONL Sink

Audit events should be written automatically to disk after sanitization. The default location should be the operating system's application data directory, under a Client Wizard audit subdirectory:

- Windows: app data directory resolved by Tauri for Client Wizard.
- macOS: app data directory resolved by Tauri for Client Wizard.
- Linux: app data directory resolved by Tauri for Client Wizard.

The primary file should be line-delimited JSON:

- `audit/current.jsonl`

Each line contains one sanitized `AuditEvent` object using the same schema shown in the in-app Audit window. This keeps external consumption simple with tools such as `tail`, `jq`, log shippers, or support scripts.

### Rotation

The writer should rotate logs to prevent unbounded growth:

- Rotate when `current.jsonl` exceeds 10 MB.
- Keep the most recent 10 rotated files.
- Name rotated files with a timestamp, for example `audit/2026-08-14T14-30-00Z.jsonl`.
- Rotation must never block or fail the wizard flow.

### Write Semantics

The disk sink is best-effort but observable:

- A failed disk write must not prevent the IndexedDB audit write.
- A failed IndexedDB write must not prevent a disk write.
- If disk persistence fails, log the failure to the developer console and continue running.
- Disk write failures should not recursively generate more disk audit events.

### Security and Privacy

Only sanitized events should be written to disk. The disk sink must not bypass existing redaction rules. Body previews remain bounded to 4 KB per event and binary payloads remain summarized without raw content.

## Frontend Integration

Replace direct host `fetch()` calls with `auditedFetch` in:

- Manifest loading.
- Remote consent document loading.
- Remote Markdown link loading.
- Remote script artifact loading.
- Remote ZIP/archive artifact loading.

The helper should preserve the existing response behavior: callers still receive a `Response` or thrown error and continue to enforce current status, content-type, HTTPS, and manifest validation rules.

For error responses where callers currently throw after `!response.ok`, the helper should already have emitted `network.response` with status and body preview before the caller throws the domain-specific error.

For CORS failures, the helper should emit `network.error` with URL/method/source and indicate that the browser did not expose status, headers, or body.

## Native/Wizard Download Integration

For `clientWizard.downloadFile` and related native download paths:

- Emit a `network.request` event before invoking the Tauri command.
- Emit a `network.response` event after the command returns, including file name, bytes written, destination path category, and duration.
- Emit a `network.error` event when the command rejects.

Native commands that already report progress should keep progress behavior unchanged.

## Error Handling

Audit logging must never convert a failed network request into a success. If audit persistence fails, the app may report the audit write failure to the console, matching current audit behavior, but the original network error or response handling must remain unchanged.

The helper should use `response.clone()` before reading previews so application code can still consume the original response body.

The audit writer should attempt IndexedDB and disk persistence independently so one unavailable storage backend does not disable the other.

## Testing

Add focused tests or test harness coverage for:

- A mocked HTTP 403 response logs `network.response` with status, headers, and body preview.
- A rejected `fetch()` logs `network.error` with `responseAvailable: false`.
- Successful JSON response logs a sanitized, limited preview.
- Sensitive headers/body fields are redacted.
- Binary artifact responses do not store raw body content.
- Audit events are appended to `audit/current.jsonl` in the app data directory.
- JSONL disk writes contain sanitized payloads only.
- Disk write failure does not break network requests or IndexedDB audit logging.
- Log rotation occurs when the configured size limit is exceeded.
- Existing manifest/document/artifact validation behavior remains unchanged.

Manual validation should include the S3 CORS failure case. The audit log should show the attempted URL and a `network.error` event explaining that no response was exposed by the browser.
