# Local Manifest Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users start Client Wizard by either entering a manifest URL or selecting a local `manifest.json` file whose relative documents and artifacts resolve from the manifest folder.

**Architecture:** Add small native Tauri commands for selecting and reading local files, then teach the React runtime to carry a `ManifestSource` instead of assuming every manifest has a URL base. Remote manifests keep the existing HTTPS flow; local manifests use native reads for relative documents, scripts, and ZIP packages while preserving the current consent-before-artifact-load sequence.

**Tech Stack:** Tauri 2, Rust, `tauri-plugin-dialog`, React 19, TypeScript, JSZip, Vite.

## Global Constraints

- Users can load a manifest by URL or by selecting a local `manifest.json` file.
- Remote URL behavior must remain unchanged.
- Local manifest relative references resolve from the selected manifest file's parent directory.
- HTTPS URLs inside a local manifest continue to work.
- Non-HTTPS remote URLs remain rejected except localhost development URLs.
- Local references must be read through explicit Tauri commands, not browser `file://` fetches.
- Consent, document review, permission review, artifact loading, and runtime startup flow remain unchanged after manifest load.
- Local script or ZIP artifact is loaded only after consent and permission review.
- Selecting a local manifest must not immediately execute local JavaScript.
- This feature does not add `require()`, Node.js module loading, or `node_modules` resolution for `wizard.js`.

---

## File Structure

- Modify `src-tauri\Cargo.toml`
  - Add `tauri-plugin-dialog = "2"` for the native file picker.
- Modify `src-tauri\src\lib.rs`
  - Add native response structs and commands:
    - `select_manifest_file() -> Result<Option<LocalManifestFile>, String>`
    - `read_local_text_file(path: String) -> Result<String, String>`
    - `read_local_binary_file(path: String) -> Result<Vec<u8>, String>`
  - Register `tauri_plugin_dialog::init()` and the new commands.
  - Add Rust unit tests for local file read guards and UTF-8/error behavior.
- Modify `src\native.ts`
  - Add TypeScript wrappers for the three new commands.
- Modify `src\App.tsx`
  - Add `ManifestSource`, local/remote reference resolution, local document loading, local script loading, local ZIP loading, and a **Select manifest file** UI action beside the existing URL form.
- Modify `src\types.ts`
  - Add exported source/reference helper types only if they are shared outside `App.tsx`.
- Modify `README.md`
  - Document URL or local file startup.
- Modify `docs\wizard-script-authoring.md`
  - Document local manifest relative path behavior and reiterate that local `wizard.js` still runs as a Web Worker without Node `require()`.
- Optional create `public\tests\local-manifest\manifest.json`
  - Only if useful as a documented local fixture; do not rely on it for native file-picker tests.

---

### Task 1: Add native local file selection and read commands

**Files:**
- Modify: `src-tauri\Cargo.toml`
- Modify: `src-tauri\src\lib.rs`
- Modify: `src\native.ts`

**Interfaces:**
- Produces:
  - Rust struct:
    ```rust
    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LocalManifestFile {
        path: String,
        base_dir: String,
        display_name: String,
        content: String,
    }
    ```
  - Tauri commands:
    ```rust
    async fn select_manifest_file(app: AppHandle) -> Result<Option<LocalManifestFile>, String>
    async fn read_local_text_file(path: String) -> Result<String, String>
    async fn read_local_binary_file(path: String) -> Result<Vec<u8>, String>
    ```
  - TypeScript wrappers:
    ```ts
    export type LocalManifestFile = {
      path: string;
      baseDir: string;
      displayName: string;
      content: string;
    };

    export async function selectManifestFile(): Promise<LocalManifestFile | null>;
    export async function readLocalTextFile(path: string): Promise<string>;
    export async function readLocalBinaryFile(path: string): Promise<number[]>;
    ```

- [ ] **Step 1: Write failing Rust tests for local text/binary reads**

Add tests at the bottom of `src-tauri\src\lib.rs`:

```rust
#[cfg(test)]
mod local_manifest_tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("client-wizard-{name}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn read_local_text_file_rejects_invalid_utf8() {
        let dir = temp_dir("invalid-utf8");
        let file = dir.join("manifest.json");
        fs::write(&file, [0xff, 0xfe, 0xfd]).expect("write invalid utf8");

        let result = read_local_text_file_blocking(file.display().to_string());

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn read_local_binary_file_returns_bytes() {
        let dir = temp_dir("binary");
        let file = dir.join("package.zip");
        fs::write(&file, [1_u8, 2, 3, 4]).expect("write binary");

        let result = read_local_binary_file_blocking(file.display().to_string()).expect("read binary");

        assert_eq!(result, vec![1, 2, 3, 4]);
    }

    #[test]
    fn read_local_text_file_rejects_directories() {
        let dir = temp_dir("directory");

        let result = read_local_text_file_blocking(dir.display().to_string());

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Somente arquivos"));
    }
}
```

These tests intentionally reference helper functions that do not exist yet:

```rust
fn read_local_text_file_blocking(path: String) -> Result<String, String>
fn read_local_binary_file_blocking(path: String) -> Result<Vec<u8>, String>
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo test local_manifest_tests
```

Expected: FAIL because `read_local_text_file_blocking` and `read_local_binary_file_blocking` are not defined.

- [ ] **Step 3: Add dialog dependency**

Modify `src-tauri\Cargo.toml`:

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 4: Implement local file read helpers and commands**

In `src-tauri\src\lib.rs`, update imports:

```rust
use tauri_plugin_dialog::DialogExt;
```

Add the response struct near other serialized structs:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalManifestFile {
    path: String,
    base_dir: String,
    display_name: String,
    content: String,
}
```

Add helpers near `safe_join`:

```rust
const LOCAL_TEXT_FILE_LIMIT: u64 = 2 * 1024 * 1024;
const LOCAL_BINARY_FILE_LIMIT: u64 = 50 * 1024 * 1024;

fn ensure_readable_file(path: &Path, max_bytes: u64) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Falha ao ler metadados do arquivo local: {error}"))?;
    if !metadata.is_file() {
        return Err("Somente arquivos podem ser lidos.".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!("Arquivo local excede limite de {} MB.", max_bytes / 1024 / 1024));
    }
    Ok(())
}

fn read_local_text_file_blocking(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    ensure_readable_file(&path, LOCAL_TEXT_FILE_LIMIT)?;
    fs::read_to_string(&path)
        .map_err(|error| format!("Falha ao ler arquivo local como UTF-8: {error}"))
}

fn read_local_binary_file_blocking(path: String) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(path);
    ensure_readable_file(&path, LOCAL_BINARY_FILE_LIMIT)?;
    fs::read(&path).map_err(|error| format!("Falha ao ler arquivo local: {error}"))
}
```

Add commands near other `#[tauri::command]` functions:

```rust
#[tauri::command]
async fn select_manifest_file(app: AppHandle) -> Result<Option<LocalManifestFile>, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("Client Wizard manifest", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = file_path
        .into_path()
        .map_err(|_| "O seletor retornou um caminho de arquivo invalido.".to_string())?;
    let content = read_local_text_file_blocking(path.display().to_string())?;
    let base_dir = path
        .parent()
        .ok_or_else(|| "Manifesto local nao possui diretorio pai.".to_string())?
        .display()
        .to_string();
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("manifest.json")
        .to_string();

    Ok(Some(LocalManifestFile {
        path: path.display().to_string(),
        base_dir,
        display_name,
        content,
    }))
}

#[tauri::command]
async fn read_local_text_file(path: String) -> Result<String, String> {
    read_local_text_file_blocking(path)
}

#[tauri::command]
async fn read_local_binary_file(path: String) -> Result<Vec<u8>, String> {
    read_local_binary_file_blocking(path)
}
```

Register plugin and commands:

```rust
.plugin(tauri_plugin_dialog::init())
```

and add to `generate_handler!`:

```rust
select_manifest_file,
read_local_text_file,
read_local_binary_file,
```

- [ ] **Step 5: Add TypeScript wrappers**

In `src\native.ts`, add:

```ts
export type LocalManifestFile = {
  path: string;
  baseDir: string;
  displayName: string;
  content: string;
};

export async function selectManifestFile(): Promise<LocalManifestFile | null> {
  return invoke<LocalManifestFile | null>("select_manifest_file");
}

export async function readLocalTextFile(path: string): Promise<string> {
  return invoke<string>("read_local_text_file", { path });
}

export async function readLocalBinaryFile(path: string): Promise<number[]> {
  return invoke<number[]>("read_local_binary_file", { path });
}
```

- [ ] **Step 6: Run Rust tests to verify they pass**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo test local_manifest_tests
```

Expected: PASS, all three local manifest tests pass.

- [ ] **Step 7: Run TypeScript build**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src/native.ts
git commit -m "Add native local manifest file reads" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add manifest source resolution in the frontend

**Files:**
- Modify: `src\App.tsx`

**Interfaces:**
- Consumes Task 1 wrappers:
  - `selectManifestFile(): Promise<LocalManifestFile | null>`
  - `readLocalTextFile(path: string): Promise<string>`
  - `readLocalBinaryFile(path: string): Promise<number[]>`
- Produces:
  - `ManifestSource` internal type.
  - Remote and local manifest loading paths.
  - Local relative document/script/ZIP resolution.

- [ ] **Step 1: Add a failing type-check expectation by referencing local loading helpers**

Before implementation, temporarily add this minimal call inside `App` near `submitManifest`:

```ts
void loadSelectedManifestFile();
```

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: FAIL because `loadSelectedManifestFile` does not exist. Remove the temporary line before implementing the real UI.

- [ ] **Step 2: Import native local file wrappers**

Update the import from `./native`:

```ts
import {
  downloadFile,
  errorMessage,
  executeNative,
  extractArchive,
  fsExecute,
  getLaunchManifestUrl,
  openAboutWindow,
  openAuditWindow,
  openExternalUrl,
  openMarkdownDocumentWindow,
  readLocalBinaryFile,
  readLocalTextFile,
  selectManifestFile,
  type FsExecuteRequest,
  type FsPath,
  type LaunchManifestPayload,
  type LocalManifestFile
} from "./native";
```

- [ ] **Step 3: Add source/reference types inside `App.tsx`**

Near existing local types, add:

```ts
type ManifestSource =
  | { kind: "remote-url"; url: string; display: string }
  | { kind: "local-file"; path: string; baseDir: string; display: string };

type ResolvedReference =
  | { kind: "remote-url"; url: string }
  | { kind: "local-file"; path: string; display: string };
```

Change state:

```ts
const [manifestUrl, setManifestUrl] = useState("");
const [manifestSource, setManifestSource] = useState<ManifestSource>();
```

Update about data persistence to use `manifestSource?.display ?? manifestUrl` as the displayed source if needed.

- [ ] **Step 4: Implement reference resolution helpers**

Replace direct URL-only assumptions with helpers:

```ts
function isAbsoluteRemoteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function joinLocalPath(baseDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || normalized.startsWith("/") || normalized.includes("../")) {
    throw new Error(`Referencia local nao permitida: ${relativePath}`);
  }
  const separator = baseDir.includes("\\") ? "\\" : "/";
  return `${baseDir.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/^[\\/]+/, "")}`;
}

function resolveReference(value: string, source: ManifestSource, label: string): ResolvedReference {
  if (source.kind === "remote-url") {
    return { kind: "remote-url", url: normalizeAllowedUrl(new URL(value, source.url).toString(), label) };
  }

  if (isAbsoluteRemoteUrl(value)) {
    return { kind: "remote-url", url: normalizeAllowedUrl(value, label) };
  }

  return {
    kind: "local-file",
    path: joinLocalPath(source.baseDir, value),
    display: value
  };
}
```

This initial implementation rejects `../` local references. If users later need parent-directory references, add a canonicalizing backend resolver in a separate task.

- [ ] **Step 5: Split remote and local manifest loading**

Keep existing URL form behavior by changing `submitManifest`:

```ts
await loadRemoteManifest(manifestUrl, "manual");
```

Implement:

```ts
async function loadRemoteManifest(inputUrl: string, source: "manual" | LaunchManifestPayload["source"]) {
  const url = normalizeAllowedUrl(inputUrl, "manifesto");
  const manifestSource: ManifestSource = { kind: "remote-url", url, display: url };
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Manifesto retornou HTTP ${response.status}.`);
  }
  await loadManifestFromContent(await response.json(), manifestSource, source);
}

async function loadSelectedManifestFile() {
  setError("");
  const selected = await selectManifestFile();
  if (!selected) {
    return;
  }
  const manifestSource: ManifestSource = {
    kind: "local-file",
    path: selected.path,
    baseDir: selected.baseDir,
    display: selected.path
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(selected.content);
  } catch (error) {
    throw new Error(`Manifesto local nao contem JSON valido: ${errorMessage(error)}`);
  }
  await loadManifestFromContent(parsed, manifestSource, "local-file");
}
```

Refactor the existing `loadManifest` body into:

```ts
async function loadManifestFromContent(value: unknown, source: ManifestSource, auditSource: string) {
  setError("");
  setActiveSurface(undefined);
  stopWorker();
  setAppState("loading-manifest");
  setManifestSource(source);
  setManifestUrl(source.display);
  sessionIdRef.current = crypto.randomUUID();
  audit({ ... input: { source } ... });
  const loadedManifest = validateManifest(value, source);
  const loadedDocuments = await loadConsentDocuments(loadedManifest, source);
  ...
}
```

Keep the existing catch behavior around both `loadRemoteManifest` and `loadSelectedManifestFile` by using a shared wrapper:

```ts
async function runManifestLoad(loader: () => Promise<void>) {
  try {
    await loader();
  } catch (caughtError) {
    setError(errorMessage(caughtError));
    setAppState("idle");
    audit({ level: "error", category: "manifest", action: "manifest.load.error", summary: "Falha ao carregar manifesto", error: errorMessage(caughtError) });
  }
}
```

Use it in `submitManifest`, launch event handling, and file selection.

- [ ] **Step 6: Update validation and loaders to accept `ManifestSource`**

Change signatures:

```ts
function validateManifest(value: unknown, source: ManifestSource): ClientWizardManifest
function validateDocumentUrlList(value: unknown, field: string, source: ManifestSource): string[] | undefined
function validateEntry(value: unknown, source: ManifestSource): ManifestEntry
async function loadConsentDocuments(manifest: ClientWizardManifest, source: ManifestSource): Promise<ConsentDocument[]>
async function loadEntryScript(entry: ManifestEntry, source: ManifestSource): Promise<string>
```

Important: `ClientWizardManifest` and `ManifestEntry` can keep their current string fields. Use `resolveReference(...)` at load time instead of mutating manifest types.

For documents:

```ts
const reference = resolveReference(entry.url, source, documentKindLabel(entry.kind));
const markdown = reference.kind === "remote-url"
  ? await fetchRemoteText(reference.url, `Documento ${reference.url}`)
  : await readLocalTextFile(reference.path);
```

For script entries:

```ts
if (entry.type === "script") {
  const reference = resolveReference(entry.url, source, "artefato");
  return reference.kind === "remote-url"
    ? await fetchRemoteText(reference.url, "Artefato")
    : await readLocalTextFile(reference.path);
}
```

For ZIP entries:

```ts
const reference = resolveReference(entry.url, source, "artefato");
const bytes = reference.kind === "remote-url"
  ? await fetchRemoteArrayBuffer(reference.url, "Artefato")
  : Uint8Array.from(await readLocalBinaryFile(reference.path)).buffer;
const zip = await JSZip.loadAsync(bytes);
```

Add helpers:

```ts
async function fetchRemoteText(url: string, label: string) { ... }
async function fetchRemoteArrayBuffer(url: string, label: string) { ... }
```

- [ ] **Step 7: Add the select-file UI**

In the idle screen, update the intro copy:

```tsx
Enter a manifest URL or select a local manifest.json file. The app shows terms and permissions before loading any script.
```

Add a secondary button after the URL form:

```tsx
<div className="flex max-w-2xl flex-wrap gap-2">
  <Button
    disabled={appState === "loading-manifest"}
    type="button"
    variant="secondary"
    onClick={() => void runManifestLoad(loadSelectedManifestFile)}
  >
    Select manifest file
  </Button>
  <p className="text-sm text-muted-foreground">
    Local relative paths resolve from the selected manifest file folder.
  </p>
</div>
```

- [ ] **Step 8: Run build**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/App.tsx
git commit -m "Support local manifest sources" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Add local manifest fixtures and documentation

**Files:**
- Create: `public\tests\local-file-basic\manifest.json`
- Create: `public\tests\local-file-basic\docs\terms.md`
- Create: `public\tests\local-file-basic\wizard.js`
- Modify: `README.md`
- Modify: `docs\wizard-script-authoring.md`

**Interfaces:**
- Consumes:
  - Local manifest support from Task 2.
- Produces:
  - A local-file example folder users can copy out of the repo and select with the native file picker.
  - Updated docs.

- [ ] **Step 1: Write failing documentation/fixture coverage check**

Run before creating files:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$requiredFiles = @(
  'public\tests\local-file-basic\manifest.json',
  'public\tests\local-file-basic\docs\terms.md',
  'public\tests\local-file-basic\wizard.js'
)
$missing = $requiredFiles | Where-Object { !(Test-Path $_) }
if ($missing) {
  $missing | ForEach-Object { Write-Host "Missing $_" }
  exit 1
}
```

Expected: FAIL with all three files missing.

- [ ] **Step 2: Create local manifest fixture**

Create `public\tests\local-file-basic\manifest.json`:

```json
{
  "name": "Local File Manifest Example",
  "description": "Loads documents and wizard.js from files next to the selected manifest.",
  "terms": [
    "./docs/terms.md"
  ],
  "entry": {
    "type": "script",
    "url": "./wizard.js"
  },
  "permissions": [
    {
      "id": "native:systemInfo",
      "title": "Read system information",
      "description": "Allows the local wizard example to show OS and CPU details."
    }
  ]
}
```

Create `public\tests\local-file-basic\docs\terms.md`:

```markdown
# Local File Example Terms

This example is loaded from a local `manifest.json` file.

The wizard script is not executed until you accept these terms and approve the requested permissions.
```

Create `public\tests\local-file-basic\wizard.js`:

```js
const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "intro",
        title: "Local manifest",
        markdown: "# Local manifest loaded\n\nThis wizard.js file was resolved relative to the selected manifest file."
      },
      {
        id: "system",
        title: "System",
        markdown:
          "## System information\n\nStatus: `{{ storage.status }}`\n\nOS: `{{ storage.os }}`\n\nArchitecture: `{{ storage.arch }}`"
      }
    ]
  },
  { storage: { status: "waiting" } }
);

wizard.events(async (event) => {
  if (event.type !== "next" || event.data.index !== 1) {
    return;
  }

  await wizard.setStorage({ status: "reading system information" });
  const result = await clientWizard.invoke({ type: "systemInfo" });
  const system = JSON.parse(result.stdout || "{}");
  await wizard.setStorage({
    status: "complete",
    os: system.os || "unknown",
    arch: system.cpuArchitecture || "unknown"
  });
});
```

- [ ] **Step 3: Update README**

Add to the examples section:

```markdown
### Local manifest file

You can also start from a local `manifest.json` file. Click **Select manifest file** on the initial screen and choose:

```text
public\tests\local-file-basic\manifest.json
```

When a local manifest uses relative paths such as `./docs/terms.md`, `./wizard.js`, or `./package.zip`, Client Wizard resolves them from the selected manifest file's folder. The script or ZIP is still loaded only after the consent and permission steps.
```

- [ ] **Step 4: Update authoring guide**

Add a section near manifest entry points:

```markdown
## Local manifest files

Users can load a manifest from disk with **Select manifest file**. In that mode, relative document and artifact paths resolve from the selected manifest file's folder:

```json
{
  "terms": ["./docs/terms.md"],
  "entry": {
    "type": "script",
    "url": "./wizard.js"
  }
}
```

HTTPS URLs inside a local manifest still work. Non-HTTPS remote URLs are rejected, except localhost development URLs. Local scripts still run as Web Worker scripts; selecting a local manifest does not add Node.js `require()`, `node_modules` resolution, or access to Node built-ins.
```

- [ ] **Step 5: Run coverage check**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$requiredFiles = @(
  'public\tests\local-file-basic\manifest.json',
  'public\tests\local-file-basic\docs\terms.md',
  'public\tests\local-file-basic\wizard.js'
)
$missing = $requiredFiles | Where-Object { !(Test-Path $_) }
if ($missing) {
  $missing | ForEach-Object { Write-Host "Missing $_" }
  exit 1
}
$readme = Get-Content -Raw README.md
$guide = Get-Content -Raw docs\wizard-script-authoring.md
foreach ($needle in @('Select manifest file', 'public\tests\local-file-basic\manifest.json', 'relative paths')) {
  if (!$readme.Contains($needle)) { Write-Host "README missing $needle"; exit 1 }
}
foreach ($needle in @('Local manifest files', 'Node.js `require()`', 'selected manifest file''s folder')) {
  if (!$guide.Contains($needle)) { Write-Host "Guide missing $needle"; exit 1 }
}
Write-Host 'Local manifest docs coverage passed.'
```

Expected: PASS.

- [ ] **Step 6: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add public/tests/local-file-basic README.md docs/wizard-script-authoring.md
git commit -m "Document local manifest file loading" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Validate end-to-end behavior and publish

**Files:**
- Modify only if validation reveals defects:
  - `src-tauri\src\lib.rs`
  - `src\native.ts`
  - `src\App.tsx`
  - `README.md`
  - `docs\wizard-script-authoring.md`

**Interfaces:**
- Consumes:
  - Backend commands from Task 1.
  - Frontend local source support from Task 2.
  - Docs/fixtures from Task 3.
- Produces:
  - Verified and pushed implementation.

- [ ] **Step 1: Run Rust local manifest tests**

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo test local_manifest_tests
```

Expected: PASS.

- [ ] **Step 2: Run full frontend build**

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run Tauri compile check**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6\src-tauri'
cargo check
```

Expected: PASS.

- [ ] **Step 4: Validate remote example still works at fetch level**

Run:

```powershell
curl.exe -fsSL --max-time 15 https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json | Select-String -Pattern '"type": "zip"|"url": "./package.zip"|"script": "wizard.js"'
```

Expected output includes:

```text
"type": "zip"
"url": "./package.zip"
"script": "wizard.js"
```

- [ ] **Step 5: Commit validation fixes if any**

If Steps 1-4 required fixes, commit them:

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src/native.ts src/App.tsx README.md docs/wizard-script-authoring.md public/tests/local-file-basic
git commit -m "Polish local manifest file loading" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

Skip this commit if no files changed.

- [ ] **Step 6: Push**

```powershell
git push origin main
```

Expected: push succeeds. If GitHub rejects with an internal server error, retry once. If the second push fails, report the local HEAD SHA and exact remote error.

---

## Self-Review

Spec coverage:

- URL and local file entry paths: Tasks 2 and 3.
- Local relative documents, script, and ZIP resolution: Task 2.
- Native file picker/read commands: Task 1.
- Consent before local artifact load: Task 2 keeps artifact loading in `startWizard`.
- Clear errors for invalid JSON, missing local files, invalid UTF-8, missing ZIP script: Tasks 1 and 2.
- No Node `require()` or `node_modules`: Task 3 docs.
- Validation of remote and local paths: Task 4.

Placeholder scan:

- The plan contains concrete file paths, code snippets, commands, expected failures, expected passes, and commit commands.

Type consistency:

- Native command wrappers in `src\native.ts` match Rust command names.
- `ManifestSource` and `ResolvedReference` are internal frontend types.
- `readLocalBinaryFile()` returns `number[]`, converted to `Uint8Array` before JSZip.
- Existing `ManifestEntry` remains unchanged; source resolution happens at load time.
