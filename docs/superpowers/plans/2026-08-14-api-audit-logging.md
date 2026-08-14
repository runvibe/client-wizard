# API Audit Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured API audit events for host and native network calls, and mirror sanitized audit events to a disk-backed JSONL log that external tools can tail.

**Architecture:** Keep the existing IndexedDB audit store for the in-app Audit window, and add an independent Tauri-backed disk sink for sanitized events. Introduce a frontend `auditedFetch` helper for browser network calls and a Rust-to-frontend native network audit event for `download_file` so all API calls produce request/response/error records.

**Tech Stack:** React 19, TypeScript, Tauri 2, Rust, IndexedDB, JSONL files in Tauri app data, existing `reqwest` native downloads.

## Global Constraints

- Do not bypass browser CORS in the frontend.
- Do not add a new backend proxy for manifest/document/artifact fetches in this change.
- Do not persist full response bodies or binary payload content in the audit log.
- Do not change manifest validation rules, consent flow rules, or artifact trust rules.
- Do not replace the current IndexedDB audit UI in this change.
- Body previews are limited to 4 KB per audit event.
- Binary responses store byte/hash summaries only, never raw binary content.
- Disk audit file is `audit/current.jsonl` under the Tauri app data directory.
- Rotate `current.jsonl` when it exceeds 10 MB and keep the 10 most recent rotated files.
- Audit persistence failures must not change network request behavior or wizard execution.

---

## File Structure

- Modify `src-tauri/src/lib.rs`
  - Add `append_audit_event` command to append sanitized events to `audit/current.jsonl`.
  - Add JSONL rotation helpers and tests.
  - Emit `client-wizard://network-audit` events from `download_file`.
- Modify `src/native.ts`
  - Add `appendAuditEventToDisk(event: AuditEvent)` and native event payload types.
- Modify `src/audit.ts`
  - Keep IndexedDB behavior.
  - Build a sanitized `AuditEvent` once, then write independently to IndexedDB and disk.
  - Export sanitizer helpers used by network audit code if needed.
- Create `src/auditedFetch.ts`
  - Central wrapper around `fetch()` for request/response/error audit records.
  - Safe header capture, body preview, binary summary, and CORS/no-response diagnostics.
- Modify `src/App.tsx`
  - Listen for native network audit events.
  - Replace direct remote `fetch()` calls with `auditedFetch`.
  - Route native `downloadFile` request/result/error through network audit records.
- Modify docs after implementation:
  - `README.md`
  - `docs/wizard-script-authoring.md`

---

### Task 1: Disk-backed JSONL audit sink

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/native.ts`

**Interfaces:**
- Produces Rust command:
  - `append_audit_event(app: AppHandle, event: serde_json::Value) -> Result<AuditDiskWriteResult, String>`
- Produces TypeScript wrapper:
  - `appendAuditEventToDisk(event: AuditEvent): Promise<AuditDiskWriteResult>`
- Produces result type:
  - `{ path: string; bytes: number }`

- [ ] **Step 1: Add Rust test for appending JSONL**

Add a focused helper-level test under `#[cfg(test)] mod local_manifest_tests` or create a new `audit_disk_tests` module in `src-tauri/src/lib.rs`:

```rust
#[test]
fn append_audit_event_to_disk_writes_one_json_line() {
    let dir = temp_dir("audit-jsonl");
    let event = serde_json::json!({
        "id": "event-1",
        "action": "network.response",
        "input": { "url": "https://example.com/manifest.json" }
    });

    let result = append_audit_event_to_dir(&dir, &event, 10 * 1024 * 1024, 10)
        .expect("append audit event");
    let content = fs::read_to_string(&result.path).expect("read jsonl");

    assert_eq!(result.bytes, content.len() as u64);
    assert!(content.ends_with('\n'));
    assert!(content.lines().any(|line| line.contains("\"network.response\"")));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo test append_audit_event_to_disk_writes_one_json_line
```

Expected: FAIL because `append_audit_event_to_dir` does not exist.

- [ ] **Step 3: Implement JSONL append and rotation helpers**

Add constants and structs near the other command structs:

```rust
const AUDIT_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const AUDIT_LOG_MAX_ROTATED_FILES: usize = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditDiskWriteResult {
    path: String,
    bytes: u64,
}
```

Add helpers:

```rust
fn append_audit_event_to_dir(
    app_data_dir: &Path,
    event: &serde_json::Value,
    max_bytes: u64,
    max_rotated_files: usize,
) -> Result<AuditDiskWriteResult, String> {
    let audit_dir = app_data_dir.join("audit");
    fs::create_dir_all(&audit_dir)
        .map_err(|error| format!("Falha ao criar diretorio de auditoria: {error}"))?;
    let current_path = audit_dir.join("current.jsonl");
    rotate_audit_log_if_needed(&audit_dir, &current_path, max_bytes, max_rotated_files)?;

    let mut line = serde_json::to_string(event)
        .map_err(|error| format!("Falha ao serializar evento de auditoria: {error}"))?;
    line.push('\n');
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current_path)
        .map_err(|error| format!("Falha ao abrir arquivo de auditoria: {error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("Falha ao gravar auditoria em disco: {error}"))?;

    let bytes = fs::metadata(&current_path)
        .map_err(|error| format!("Falha ao ler metadados da auditoria: {error}"))?
        .len();

    Ok(AuditDiskWriteResult {
        path: current_path.display().to_string(),
        bytes,
    })
}

fn rotate_audit_log_if_needed(
    audit_dir: &Path,
    current_path: &Path,
    max_bytes: u64,
    max_rotated_files: usize,
) -> Result<(), String> {
    if !current_path.exists() {
        return Ok(());
    }
    let current_size = fs::metadata(current_path)
        .map_err(|error| format!("Falha ao ler tamanho da auditoria: {error}"))?
        .len();
    if current_size < max_bytes {
        return Ok(());
    }

    let timestamp = chrono_like_timestamp_for_file();
    let rotated_path = audit_dir.join(format!("{timestamp}.jsonl"));
    fs::rename(current_path, rotated_path)
        .map_err(|error| format!("Falha ao rotacionar auditoria: {error}"))?;
    prune_rotated_audit_logs(audit_dir, max_rotated_files)
}
```

Use only `std` for timestamp if no date crate is present:

```rust
fn chrono_like_timestamp_for_file() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("audit-{millis}")
}
```

Prune helper:

```rust
fn prune_rotated_audit_logs(audit_dir: &Path, max_rotated_files: usize) -> Result<(), String> {
    let mut rotated = fs::read_dir(audit_dir)
        .map_err(|error| format!("Falha ao listar auditorias rotacionadas: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy() != "current.jsonl")
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .collect::<Vec<_>>();
    rotated.sort_by_key(|entry| entry.metadata().and_then(|metadata| metadata.modified()).ok());
    while rotated.len() > max_rotated_files {
        let entry = rotated.remove(0);
        fs::remove_file(entry.path())
            .map_err(|error| format!("Falha ao remover auditoria antiga: {error}"))?;
    }
    Ok(())
}
```

- [ ] **Step 4: Add Tauri command and TypeScript wrapper**

Register command:

```rust
#[tauri::command]
async fn append_audit_event(
    app: AppHandle,
    event: serde_json::Value,
) -> Result<AuditDiskWriteResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Falha ao localizar dados da aplicacao: {error}"))?;
    append_audit_event_to_dir(
        &app_data_dir,
        &event,
        AUDIT_LOG_MAX_BYTES,
        AUDIT_LOG_MAX_ROTATED_FILES,
    )
}
```

Add `append_audit_event` to `tauri::generate_handler![...]`.

In `src/native.ts`:

```ts
import type { AuditEvent } from "./audit";

export type AuditDiskWriteResult = {
  path: string;
  bytes: number;
};

export async function appendAuditEventToDisk(event: AuditEvent): Promise<AuditDiskWriteResult> {
  return invoke<AuditDiskWriteResult>("append_audit_event", { event });
}
```

If importing `AuditEvent` creates a runtime cycle, use `import type` only.

- [ ] **Step 5: Add rotation test**

```rust
#[test]
fn append_audit_event_to_disk_rotates_when_limit_is_exceeded() {
    let dir = temp_dir("audit-rotation");
    let event = serde_json::json!({ "id": "event-1", "message": "abcdefghijklmnopqrstuvwxyz" });

    append_audit_event_to_dir(&dir, &event, 20, 10).expect("first append");
    append_audit_event_to_dir(&dir, &event, 20, 10).expect("second append");

    let audit_dir = dir.join("audit");
    let current = audit_dir.join("current.jsonl");
    let rotated_count = fs::read_dir(&audit_dir)
        .expect("read audit dir")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy() != "current.jsonl")
        .count();

    assert!(current.exists());
    assert!(rotated_count >= 1);
}
```

- [ ] **Step 6: Run validation**

Run:

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo test audit
cargo check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
git add src-tauri/src/lib.rs src/native.ts
git commit -m "Add disk audit JSONL sink" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Dual audit persistence in `audit.ts`

**Files:**
- Modify: `src/audit.ts`

**Interfaces:**
- Consumes: `appendAuditEventToDisk(event: AuditEvent): Promise<AuditDiskWriteResult>` from `src/native.ts`.
- Produces:
  - `createAuditEvent(input: AuditEventInput): AuditEvent`
  - `sanitizeAuditPayload(value: unknown): unknown`
  - `logAuditEvent(input: AuditEventInput): Promise<void>` writes to IndexedDB and disk independently.

- [ ] **Step 1: Refactor event creation**

Replace inline event creation in `logAuditEvent` with:

```ts
export function createAuditEvent(input: AuditEventInput): AuditEvent {
  const sanitizedInput = sanitizeAuditPayload(input.input);
  const sanitizedOutput = sanitizeAuditPayload(input.output);
  return {
    ...input,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    input: sanitizedInput,
    output: sanitizedOutput,
    searchableText: createSearchableText({
      ...input,
      input: sanitizedInput,
      output: sanitizedOutput
    })
  };
}
```

Rename `sanitizePayload` to exported `sanitizeAuditPayload` and update all local calls.

- [ ] **Step 2: Write independent persistence implementation**

Change `logAuditEvent`:

```ts
import { appendAuditEventToDisk } from "./native";

export async function logAuditEvent(input: AuditEventInput) {
  const event = createAuditEvent(input);
  const results = await Promise.allSettled([writeAuditEventToIndexedDb(event), appendAuditEventToDisk(event)]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Falha ao persistir auditoria.", result.reason);
    }
  }
}

async function writeAuditEventToIndexedDb(event: AuditEvent) {
  const database = await openAuditDatabase();
  try {
    await writeEvent(database, event);
  } finally {
    database.close();
  }
}
```

Do not call `logAuditEvent` from inside this error handler. Disk write failures must not recursively create audit events.

- [ ] **Step 3: Preserve search behavior**

Update `createSearchableText` to consume already-sanitized input/output:

```ts
function createSearchableText(input: AuditEventInput) {
  return normalizeText(
    [
      input.sessionId,
      input.runtimeId,
      input.surfaceId,
      input.manifestUrl,
      input.manifestName,
      input.level,
      input.category,
      input.action,
      input.summary,
      input.error,
      safeStringify(input.input),
      safeStringify(input.output)
    ]
      .filter(Boolean)
      .join(" ")
  );
}
```

- [ ] **Step 4: Run validation**

Run:

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/audit.ts
git commit -m "Mirror audit events to disk" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Central audited fetch helper

**Files:**
- Create: `src/auditedFetch.ts`
- Modify: `src/audit.ts`

**Interfaces:**
- Produces:
  - `type NetworkAuditSource = "manifest" | "document" | "markdown" | "artifact" | "native-download" | "wizard"`
  - `type NetworkAuditSink = (input: Omit<AuditEventInput, "sessionId" | "runtimeId" | "manifestUrl" | "manifestName">) => void`
  - `auditedFetch(url: string, init: RequestInit | undefined, options: AuditedFetchOptions): Promise<Response>`
  - `auditNetworkRequest(...)`, `auditNetworkResponse(...)`, `auditNetworkError(...)`
- Consumes:
  - `sanitizeAuditPayload` from `src/audit.ts`

- [ ] **Step 1: Add network category**

In `src/audit.ts`, extend `AuditCategory`:

```ts
  | "network"
```

- [ ] **Step 2: Create `src/auditedFetch.ts`**

Add:

```ts
import type { AuditEventInput } from "./audit";
import { sanitizeAuditPayload } from "./audit";

export type NetworkAuditSource = "manifest" | "document" | "markdown" | "artifact" | "native-download" | "wizard";

export type NetworkAuditSink = (
  input: Omit<AuditEventInput, "sessionId" | "runtimeId" | "manifestUrl" | "manifestName">
) => void;

export type AuditedFetchOptions = {
  audit: NetworkAuditSink;
  source: NetworkAuditSource;
  label: string;
  previewBinary?: boolean;
};

const bodyPreviewLimit = 4096;
const sensitiveHeaderPattern = /authorization|cookie|set-cookie|token|secret|password|credential|x-api-key|x-amz-security-token/i;

export async function auditedFetch(url: string, init: RequestInit | undefined, options: AuditedFetchOptions): Promise<Response> {
  const requestId = crypto.randomUUID();
  const method = normalizeMethod(init?.method);
  const startedAt = performance.now();
  auditNetworkRequest(options.audit, { requestId, method, url, source: options.source, headers: sanitizeHeaders(init?.headers) });

  try {
    const response = await fetch(url, init);
    const durationMs = Math.round(performance.now() - startedAt);
    const preview = await createResponsePreview(response, options.previewBinary === true);
    auditNetworkResponse(options.audit, {
      requestId,
      method,
      url,
      source: options.source,
      label: options.label,
      response,
      durationMs,
      preview
    });
    return response;
  } catch (caughtError) {
    const durationMs = Math.round(performance.now() - startedAt);
    auditNetworkError(options.audit, {
      requestId,
      method,
      url,
      source: options.source,
      label: options.label,
      durationMs,
      error: caughtError
    });
    throw caughtError;
  }
}
```

Add request/response/error emitters:

```ts
export function auditNetworkRequest(
  audit: NetworkAuditSink,
  input: { requestId: string; method: string; url: string; source: NetworkAuditSource; headers: Record<string, string> }
) {
  audit({
    level: "info",
    category: "network",
    action: "network.request",
    summary: `API request: ${input.method} ${input.url}`,
    input
  });
}

export function auditNetworkResponse(
  audit: NetworkAuditSink,
  input: {
    requestId: string;
    method: string;
    url: string;
    source: NetworkAuditSource;
    label: string;
    response: Response;
    durationMs: number;
    preview: ResponsePreview;
  }
) {
  audit({
    level: input.response.ok ? "info" : "error",
    category: "network",
    action: "network.response",
    summary: `API response ${input.response.status}: ${input.label}`,
    input: {
      requestId: input.requestId,
      method: input.method,
      url: input.url,
      source: input.source
    },
    output: {
      status: input.response.status,
      statusText: input.response.statusText,
      ok: input.response.ok,
      headers: sanitizeHeaders(input.response.headers),
      contentType: input.response.headers.get("content-type") ?? "",
      contentLength: input.response.headers.get("content-length") ?? "",
      durationMs: input.durationMs,
      ...input.preview
    }
  });
}

export function auditNetworkError(
  audit: NetworkAuditSink,
  input: {
    requestId: string;
    method: string;
    url: string;
    source: NetworkAuditSource;
    label: string;
    durationMs: number;
    error: unknown;
  }
) {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  audit({
    level: "error",
    category: "network",
    action: "network.error",
    summary: `API error: ${input.label}`,
    input: {
      requestId: input.requestId,
      method: input.method,
      url: input.url,
      source: input.source
    },
    output: {
      durationMs: input.durationMs,
      responseAvailable: false,
      likelyCause: error.name === "TypeError" ? "cors-or-network" : undefined
    },
    error: `${error.name}: ${error.message}`
  });
}
```

Add preview helpers:

```ts
type ResponsePreview =
  | { bodyPreview?: unknown; bodyPreviewTruncated?: boolean; bodyPreviewError?: string }
  | { binarySummary: { bytes?: number; contentType: string } };

async function createResponsePreview(response: Response, previewBinary: boolean): Promise<ResponsePreview> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!isTextLikeContentType(contentType)) {
    return {
      binarySummary: {
        bytes: parseContentLength(response.headers.get("content-length")),
        contentType
      }
    };
  }

  try {
    const text = await response.clone().text();
    const truncated = text.length > bodyPreviewLimit;
    const previewText = truncated ? text.slice(0, bodyPreviewLimit) : text;
    return {
      bodyPreview: sanitizeBodyPreview(previewText, contentType),
      bodyPreviewTruncated: truncated
    };
  } catch (caughtError) {
    return { bodyPreviewError: caughtError instanceof Error ? caughtError.message : String(caughtError) };
  }
}

function sanitizeBodyPreview(value: string, contentType: string) {
  if (contentType.includes("json")) {
    try {
      return sanitizeAuditPayload(JSON.parse(value));
    } catch {
      return sanitizeAuditPayload(value);
    }
  }
  return sanitizeAuditPayload(value);
}

function isTextLikeContentType(contentType: string) {
  return /application\/json|text\/|application\/xml|application\/xhtml\+xml|javascript|markdown/i.test(contentType);
}

function sanitizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) {
    return output;
  }
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    output[key] = sensitiveHeaderPattern.test(key) ? "[redacted]" : String(value);
  }
  return output;
}

function normalizeMethod(method: string | undefined) {
  return (method ?? "GET").toUpperCase();
}

function parseContentLength(value: string | null) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
```

- [ ] **Step 3: Run validation**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add src/audit.ts src/auditedFetch.ts
git commit -m "Add audited fetch helper" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Replace host `fetch()` calls with `auditedFetch`

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes:
  - `auditedFetch(url, init, { audit, source, label, previewBinary })`
  - `NetworkAuditSink`
- Produces:
  - No new public API.

- [ ] **Step 1: Import helper**

Add:

```ts
import { auditedFetch, type NetworkAuditSink, type NetworkAuditSource } from "./auditedFetch";
```

- [ ] **Step 2: Audit remote manifest loading**

Change:

```ts
const response = await fetch(url);
```

to:

```ts
const response = await auditedFetch(url, undefined, {
  audit,
  source: "manifest",
  label: "Manifesto"
});
```

Keep the existing `if (!response.ok)` and `response.json()` behavior.

- [ ] **Step 3: Pass audit sink to remote loaders**

Update signatures:

```ts
async function loadEntryScript(entry: ManifestEntry, source: ManifestSource, audit: NetworkAuditSink) { ... }

async function loadConsentDocuments(
  manifest: ClientWizardManifest,
  source: ManifestSource,
  audit: NetworkAuditSink
): Promise<ConsentDocument[]> { ... }

async function fetchRemoteText(
  url: string,
  label: string,
  options: { audit: NetworkAuditSink; source: NetworkAuditSource; validateContentType?: (contentType: string) => boolean }
) { ... }

async function fetchRemoteArrayBuffer(
  url: string,
  label: string,
  options: { audit: NetworkAuditSink; source: NetworkAuditSource }
) { ... }
```

Update all call sites:

```ts
const loadedDocuments = await loadConsentDocuments(loadedManifest, sourceData, audit);
script = await loadEntryScript(manifest.entry, manifestSource ?? { kind: "remote-url", url: manifestUrl, display: manifestUrl }, audit);
```

- [ ] **Step 4: Replace `fetchRemoteText` and `fetchRemoteArrayBuffer` internals**

Use:

```ts
const response = await auditedFetch(url, undefined, {
  audit: options.audit,
  source: options.source,
  label
});
```

For array buffers:

```ts
const response = await auditedFetch(url, undefined, {
  audit: options.audit,
  source: options.source,
  label,
  previewBinary: true
});
```

Keep status and content-type validation unchanged.

- [ ] **Step 5: Audit remote Markdown links**

In `handleMarkdownLink`, change remote Markdown fetch to:

```ts
const markdown =
  reference.kind === "remote-url"
    ? await fetchRemoteText(reference.url, `Markdown ${reference.url}`, { audit, source: "markdown" })
    : await readLocalConsentDocument({ baseDir: reference.baseDir, relativePath: reference.relativePath });
```

- [ ] **Step 6: Run validation**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/App.tsx
git commit -m "Audit host network fetches" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Native download network audit events

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces Rust-emitted event:
  - event name: `client-wizard://network-audit`
  - payload shape compatible with `Omit<AuditEventInput, "sessionId" | "runtimeId" | "manifestUrl" | "manifestName">`
- Consumes in React:
  - `listen<NativeNetworkAuditEvent>("client-wizard://network-audit", (event) => audit(event.payload))`

- [ ] **Step 1: Add TypeScript event type and listener**

In `src/App.tsx`, define:

```ts
type NativeNetworkAuditEvent = Omit<AuditEventInput, "sessionId" | "runtimeId" | "manifestUrl" | "manifestName">;
```

In the existing `Promise.all([ listen(...) ])`, add:

```ts
listen<NativeNetworkAuditEvent>("client-wizard://network-audit", (event) => {
  if (!isAuditWindow && !isAboutWindow && !isDocumentWindow) {
    audit(event.payload);
  }
})
```

- [ ] **Step 2: Add Rust payload struct**

In `src-tauri/src/lib.rs`:

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeNetworkAuditPayload {
    level: String,
    category: String,
    action: String,
    summary: String,
    input: Option<serde_json::Value>,
    output: Option<serde_json::Value>,
    error: Option<String>,
}
```

Add emitter:

```rust
fn emit_network_audit(app: &AppHandle, payload: NativeNetworkAuditPayload) {
    if let Err(error) = app.emit("client-wizard://network-audit", payload) {
        eprintln!("Falha ao emitir auditoria de rede: {error}");
    }
}
```

- [ ] **Step 3: Emit native request/response/error in `download_file`**

Before `reqwest::Client::new().get(...)`:

```rust
let request_id = request.operation_id.clone();
let started_at = std::time::Instant::now();
emit_network_audit(
    &app,
    NativeNetworkAuditPayload {
        level: "info".to_string(),
        category: "network".to_string(),
        action: "network.request".to_string(),
        summary: format!("API request: GET {}", request.url),
        input: Some(serde_json::json!({
            "requestId": request_id,
            "method": "GET",
            "url": request.url,
            "source": "native-download",
            "headers": {}
        })),
        output: None,
        error: None,
    },
);
```

When `.send().await` fails, emit `network.error` before returning:

```rust
let response_result = reqwest::Client::new().get(url.clone()).send().await;
let mut response = match response_result {
    Ok(response) => response,
    Err(error) => {
        emit_network_audit(&app, native_network_error_payload(&request_id, "GET", &request.url, started_at, &error.to_string()));
        return Err(format!("Falha ao baixar arquivo: {error}"));
    }
};
```

For non-success status, capture status, headers, content type, and up to 4096 bytes of text preview:

```rust
let status = response.status();
let headers = response_headers_to_json(response.headers());
if !status.is_success() {
    let body_preview = response.text().await.unwrap_or_default();
    emit_network_audit(&app, native_network_response_payload(
        &request_id,
        "GET",
        &request.url,
        status.as_u16(),
        status.canonical_reason().unwrap_or(""),
        false,
        headers,
        started_at,
        Some(body_preview.chars().take(4096).collect()),
        None,
    ));
    return Err(format!("Download retornou HTTP {}.", status));
}
```

For success, after the file is written and `downloaded` is known, emit:

```rust
emit_network_audit(&app, native_network_response_payload(
    &request_id,
    "GET",
    &request.url,
    status.as_u16(),
    status.canonical_reason().unwrap_or(""),
    true,
    headers,
    started_at,
    None,
    Some(serde_json::json!({
        "bytes": downloaded,
        "fileName": safe_file_name,
        "destination": "downloads"
    })),
));
```

- [ ] **Step 4: Add safe header helper**

```rust
fn response_headers_to_json(headers: &reqwest::header::HeaderMap) -> serde_json::Value {
    let mut output = serde_json::Map::new();
    for (key, value) in headers.iter() {
        let key_text = key.as_str().to_string();
        let value_text = value.to_str().unwrap_or("").to_string();
        if key_text.to_ascii_lowercase().contains("token")
            || key_text.eq_ignore_ascii_case("set-cookie")
            || key_text.eq_ignore_ascii_case("authorization")
            || key_text.to_ascii_lowercase().contains("secret")
            || key_text.to_ascii_lowercase().contains("password")
            || key_text.to_ascii_lowercase().contains("credential")
        {
            output.insert(key_text, serde_json::Value::String("[redacted]".to_string()));
        } else {
            output.insert(key_text, serde_json::Value::String(value_text));
        }
    }
    serde_json::Value::Object(output)
}
```

- [ ] **Step 5: Run validation**

Run:

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo check
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/lib.rs src/App.tsx
git commit -m "Audit native download network calls" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Documentation and final validation

**Files:**
- Modify: `README.md`
- Modify: `docs/wizard-script-authoring.md`

**Interfaces:**
- Consumes completed audit behavior from Tasks 1-5.
- Produces user-facing documentation for `audit/current.jsonl` and network audit records.

- [ ] **Step 1: Document external audit file in README**

Add a short section near existing audit/runtime documentation:

```markdown
### External audit log

Client Wizard mirrors sanitized audit events to a JSONL file in the operating system's application data directory:

`audit/current.jsonl`

Each line is one audit event. External tools can tail this file for support, automation, or diagnostics. The log rotates at 10 MB and keeps the 10 most recent rotated files. Sensitive headers and fields such as tokens, cookies, passwords, and secrets are redacted before writing to disk.
```

- [ ] **Step 2: Document API/network events in wizard authoring guide**

Add:

```markdown
### API audit events

Host network calls and native downloads create `network.request`, `network.response`, and `network.error` events. For CORS failures, the browser may not expose an HTTP status or response body; in that case the audit event records `responseAvailable: false` and `likelyCause: cors-or-network`.

Text and JSON responses include a sanitized preview up to 4 KB. Binary responses include a byte/type summary only.
```

- [ ] **Step 3: Run full validation**

Run:

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo test local_manifest_tests
cargo check
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected:

- Rust tests pass.
- `cargo check` exits 0.
- `npm run build` exits 0. The existing large chunk warning is acceptable.

- [ ] **Step 4: Manual S3 CORS validation**

Run the app:

```powershell
Set-Location -LiteralPath 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run tauri dev
```

Enter:

```text
https://operations-artifacts-autob-prd-274118516892-us-east-1.s3.us-east-1.amazonaws.com/auto-ops/manifest.json
```

Expected:

- UI may still show `Failed to fetch` if S3 CORS remains disabled.
- Audit window contains `network.request`.
- Audit window contains `network.error` with `responseAvailable: false` and `likelyCause: cors-or-network`.
- Disk file `audit/current.jsonl` contains the same sanitized events.

- [ ] **Step 5: Commit docs**

```powershell
git add README.md docs/wizard-script-authoring.md
git commit -m "Document API audit logs" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 6: Request final review**

Run a final code review against the branch:

```text
Review origin/main..HEAD for API audit logging, disk JSONL persistence, sanitization, native download network audit events, and regression risk.
```

Fix any blocking findings before pushing.

- [ ] **Step 7: Push branch**

```powershell
git push origin local-manifest-upload
```

---

## Self-Review Checklist

- Spec coverage:
  - Host fetch audit: Task 3 and Task 4.
  - Native download audit: Task 5.
  - Disk JSONL sink: Task 1 and Task 2.
  - Sanitization/body limits: Task 2 and Task 3.
  - Rotation: Task 1.
  - Documentation: Task 6.
- Placeholder scan: no placeholder markers or unspecified edge handling remains.
- Type consistency:
  - `AuditEventInput` and `AuditEvent` remain owned by `src/audit.ts`.
  - `NetworkAuditSink` uses the same stripped input shape as `App.audit`.
  - Native event payload is compatible with `App.audit`.
