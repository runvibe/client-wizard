# Client Wizard Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the project documentation in professional English, with clear installation commands and a comprehensive guide for writing `wizard.js` scripts.

**Architecture:** Keep `README.md` as the concise product entry point and create `docs/wizard-script-authoring.md` as the deep authoring guide. Use the current implementation in `src\App.tsx`, `src\types.ts`, `src\native.ts`, and existing `public\*\wizard.js` examples as the source of truth; do not document planned APIs as implemented behavior.

**Tech Stack:** Markdown documentation, Tauri 2, Rust native bridge, React/Vite frontend, Web Worker runtime, `clientWizard` JavaScript SDK.

## Global Constraints

- Documentation must be written in professional English.
- `README.md` must clearly explain what Client Wizard is.
- `README.md` must include installation commands.
- Installation docs must show macOS as the currently supported terminal installer path.
- Windows and Linux installation sections must be present as packaging/platform notes, not false complete installers.
- `docs/wizard-script-authoring.md` must document how to write `wizard.js`, all currently available resources, and examples.
- The documentation must distinguish implemented behavior from future recommendations.
- This pass must not change runtime behavior, installer behavior, permissions, or packaging.
- Use Windows-style paths in commands and file references where local repository paths are needed.

---

## File Structure

- Modify `README.md`
  - Responsibility: Product overview, installation, quick start, source development commands, examples, security summary, and links to deeper docs.
- Create `docs/wizard-script-authoring.md`
  - Responsibility: Complete English authoring guide for `wizard.js`, including manifest entries, SDK APIs, screen definitions, storage, native commands, file system APIs, downloads, extraction, network behavior, packaging, examples, and debugging.
- Read-only source references:
  - `src\types.ts`: manifest, theme, wizard step, dialog, and native command types.
  - `src\App.tsx`: SDK injected into the worker, permissions, URL policy, ZIP loading, surface behavior, and wizard navigation.
  - `src\native.ts`: native bridge request/result types for download, extract, and file-system APIs.
  - `install\macos.sh`: exact macOS installer commands, environment variables, install behavior.
  - `public\sample\wizard.js`, `public\tests\ventoy\wizard.js`, `public\tests\zip-basic\package\wizard.js`: examples to cite and adapt.

---

### Task 1: Rewrite README as the English product entry point

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes:
  - macOS installer command: `curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash`
  - version install command: `curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash -s -- 2026.08.0`
  - app CLI command: `open "$HOME/Applications/Client Wizard.app" --args --manifest "https://wizard.example.com/manifest.json"`
  - public ZIP manifest URL: `https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json`
- Produces:
  - A professional English `README.md` that links to `docs/wizard-script-authoring.md` and `docs/client-wizard-runtime-spec.md`.

- [ ] **Step 1: Write the failing documentation coverage check**

Run this before editing `README.md`:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$required = @(
  'Client Wizard is a cross-platform desktop runtime',
  '## Installation',
  '### macOS terminal installer',
  '### Windows',
  '### Linux',
  '## Writing wizard.js scripts',
  'docs/wizard-script-authoring.md',
  'https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json'
)
$content = Get-Content -Raw README.md
$missing = $required | Where-Object { $content -notlike "*$_*" }
if ($missing) {
  Write-Host "Missing README content:"
  $missing | ForEach-Object { Write-Host "- $_" }
  exit 1
}
```

Expected: FAIL, listing at least the English product description and `docs/wizard-script-authoring.md`.

- [ ] **Step 2: Replace README with professional English content**

Write `README.md` with this structure and content:

```markdown
# Client Wizard

Client Wizard is a cross-platform desktop runtime for building secure, manifest-driven setup assistants, installers, diagnostics, and guided automation flows.

Instead of rendering arbitrary remote HTML, Client Wizard downloads a trusted `manifest.json`, asks the user to review terms and permissions, then runs a remote `wizard.js` orchestrator inside an isolated worker. The visible UI is rendered locally by the Tauri/React host, and native operations are routed through a controlled Rust bridge.

## What Client Wizard does

- Loads a HTTPS `manifest.json` that describes the wizard, documents, permissions, theme, and script entry point.
- Presents terms, license, privacy, and permission consent before downloading executable wizard artifacts.
- Executes `wizard.js` in a Web Worker with the `clientWizard` SDK.
- Renders Markdown and wizard steps locally with React/shadcn components.
- Exposes controlled native capabilities such as system information, process listing, scripts, downloads, archive extraction, and scoped file-system operations.
- Supports direct script entries and ZIP packages containing `wizard.js`.

## How it works

1. The user enters a manifest URL or opens the app with `--manifest`.
2. The app downloads and validates only the manifest.
3. The app downloads declared consent documents and shows them to the user.
4. The user accepts required documents and permissions.
5. The app downloads the declared script or ZIP package.
6. The host injects `clientWizard` into an isolated worker.
7. `wizard.js` creates screens with `useMarkdown()` or `useWizard()`.
8. Native operations go through permission-checked host APIs.

## Installation

### macOS terminal installer

The macOS terminal installer is the currently supported installation path for test Macs and non-notarized releases.

Install the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash
```

Install a specific release tag:

```bash
curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash -s -- 2026.08.0
```

Download the installer first and run it with shell tracing:

```bash
curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh -o /tmp/client-wizard-install.sh
bash -x /tmp/client-wizard-install.sh 2026.08.0
```

Supported installer variables:

| Variable | Default | Description |
|---|---|---|
| `CLIENT_WIZARD_REPO` | `runvibe/client-wizard` | GitHub repository used to resolve releases. |
| `CLIENT_WIZARD_VERSION` | first argument or `latest` | Release tag to install. |
| `CLIENT_WIZARD_INSTALL_DIR` | `$HOME/Applications` | Destination directory for `Client Wizard.app`. |
| `CLIENT_WIZARD_OPEN` | `1` | Set to `0` to install without opening the app. |

Install into `/Applications`:

```bash
CLIENT_WIZARD_INSTALL_DIR="/Applications" curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash
```

Install without opening the app:

```bash
CLIENT_WIZARD_OPEN=0 curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash -s -- 2026.08.0
```

Open the installed app with a manifest:

```bash
open "$HOME/Applications/Client Wizard.app" --args --manifest "https://wizard.example.com/manifest.json"
```

The installer downloads the architecture-specific `.app.tar.gz`, verifies the `.sha256`, installs `Client Wizard.app`, removes the legacy `LSRequiresCarbon` plist key, applies an ad-hoc local signature, removes quarantine when present, and opens the app unless disabled.

### Windows

Windows packaging is expected to use release assets such as `.msi`, `.exe`, or a Windows-specific archive. A dedicated Windows installer command is not finalized in this repository yet.

### Linux

Linux packaging is expected to use release assets such as `.deb`, `.rpm`, `.AppImage`, or a generic `.tar.gz`. A dedicated Linux installer command is not finalized in this repository yet.

## Run from source

```bash
npm install
npm run build
npm run tauri dev
```

### Linux native dependencies

Tauri on Linux requires WebKitGTK and JavaScriptCore development packages. On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  wget \
  file \
  pkg-config \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev
```

On Arch Linux:

```bash
sudo pacman -S --needed \
  base-devel \
  pkgconf \
  webkit2gtk-4.1 \
  gtk3 \
  libayatana-appindicator \
  librsvg
```

In WSL, use WSLg to display the Tauri window. Build Windows binaries outside WSL with the Windows toolchain.

## Examples

### Local sample manifest

When running `npm run tauri dev`, load:

```text
http://127.0.0.1:1420/sample/manifest.json
```

### Public HTTPS ZIP manifest

When using an installed app, use the HTTPS manifest hosted in this repository:

```text
https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json
```

That manifest points to `package.zip` in the same directory. The app downloads the ZIP after consent, extracts `wizard.js` in memory, and runs it as the wizard orchestrator.

### Ventoy package test

During local development, load:

```text
http://127.0.0.1:1420/tests/ventoy/manifest.json
```

This flow detects the operating system, queries the latest public Ventoy release, selects a Windows ZIP or Linux tarball, asks for confirmation, downloads the archive, and extracts it into a local test directory. It does not install Ventoy onto a disk or USB device.

## Writing wizard.js scripts

See [Writing `wizard.js` scripts](docs/wizard-script-authoring.md) for the complete authoring guide, including manifest entries, `clientWizard` APIs, permissions, storage, native commands, file-system access, downloads, extraction, ZIP packaging, network behavior, and complete examples.

## Security model

Client Wizard uses a default-deny model:

- Manifest, document, script, and ZIP URLs must use HTTPS, except localhost development URLs.
- The app downloads the script or ZIP only after consent.
- Remote HTML is not displayed as the main UI surface.
- `wizard.js` runs as an orchestrator in an isolated worker.
- All visible screens are rendered by the local host.
- Native operations require explicit manifest permissions.
- Native downloads, extraction, file-system actions, and command execution are audited by the host.

The worker may have standard web APIs such as `fetch()` available, but Client Wizard does not yet expose a first-class permission-gated `httpRequest` bridge. Treat direct network access from `wizard.js` as current web runtime behavior, not as the final audited network API.

## Documentation

- [Writing `wizard.js` scripts](docs/wizard-script-authoring.md)
- [Runtime architecture specification](docs/client-wizard-runtime-spec.md)
```

- [ ] **Step 3: Run the README coverage check**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$required = @(
  'Client Wizard is a cross-platform desktop runtime',
  '## Installation',
  '### macOS terminal installer',
  '### Windows',
  '### Linux',
  '## Writing wizard.js scripts',
  'docs/wizard-script-authoring.md',
  'https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json'
)
$content = Get-Content -Raw README.md
$missing = $required | Where-Object { $content -notlike "*$_*" }
if ($missing) {
  Write-Host "Missing README content:"
  $missing | ForEach-Object { Write-Host "- $_" }
  exit 1
}
Write-Host 'README coverage check passed.'
```

Expected: PASS with `README coverage check passed.`

- [ ] **Step 4: Commit README rewrite**

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
git add README.md
git commit -m "Rewrite README documentation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

If the session worktree git metadata is broken, copy `README.md` to `C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6`, commit there, and push from that clean clone.

---

### Task 2: Add the comprehensive wizard.js authoring guide

**Files:**
- Create: `docs/wizard-script-authoring.md`

**Interfaces:**
- Consumes:
  - `clientWizard.useMarkdown(markdown, options?)`
  - `clientWizard.useWizard(wizard, options?)`
  - `clientWizard.invoke(command)`
  - `clientWizard.download(request, options?)`
  - `clientWizard.extract(request, options?)`
  - `clientWizard.fs.*`
  - surface handle methods: `events`, `setStorage`, `getStorage`, `openDialog`, `next`, `prev`, `goTo`, `download`, `extract`, `fs`
- Produces:
  - A complete authoring guide at `docs/wizard-script-authoring.md`.

- [ ] **Step 1: Write the failing authoring guide coverage check**

Run before creating the file:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$path = 'docs\wizard-script-authoring.md'
if (!(Test-Path $path)) {
  Write-Host "$path does not exist."
  exit 1
}
```

Expected: FAIL because `docs\wizard-script-authoring.md` does not exist.

- [ ] **Step 2: Create `docs/wizard-script-authoring.md`**

Write this guide:

````markdown
# Writing `wizard.js` Scripts

This guide explains how to write `wizard.js` scripts for Client Wizard.

A `wizard.js` script is an orchestrator. It does not render arbitrary remote HTML and it does not own the visible DOM. Instead, it asks the Client Wizard host to render local Markdown or wizard screens, update local storage, react to UI events, and execute permission-checked native operations.

## Runtime model

Client Wizard loads a manifest first. After the user accepts required documents and permissions, the host downloads the script or ZIP artifact declared by the manifest.

The script runs in a Web Worker with a global `clientWizard` object injected by the host:

```js
const screen = clientWizard.useMarkdown("# Hello");
const wizard = clientWizard.useWizard({ steps: [] });
const result = await clientWizard.invoke({ type: "systemInfo" });
```

The script has no direct access to the host DOM. All visible UI is rendered by the app from screen definitions passed through `clientWizard`.

## Manifest entry points

### Direct script

```json
{
  "name": "Direct Script Example",
  "description": "Loads wizard.js directly over HTTPS.",
  "terms": ["https://wizard.example.com/terms.md"],
  "entry": {
    "type": "script",
    "url": "https://wizard.example.com/wizard.js"
  },
  "permissions": []
}
```

### ZIP package

```json
{
  "name": "ZIP Example",
  "description": "Loads wizard.js from a ZIP package.",
  "terms": ["./docs/terms.md"],
  "entry": {
    "type": "zip",
    "url": "./package.zip",
    "script": "wizard.js"
  },
  "permissions": [
    {
      "id": "native:systemInfo",
      "title": "Read system information",
      "description": "Allows the wizard to read basic OS and CPU details."
    }
  ]
}
```

For ZIP entries, `entry.script` is optional. If it is omitted, Client Wizard looks for `wizard.js` at the ZIP root.

## URL rules

Manifest, document, script, and ZIP URLs must use HTTPS. Local development URLs may use localhost HTTP, for example:

```text
http://127.0.0.1:1420/sample/manifest.json
```

An installed app should use HTTPS, for example:

```text
https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json
```

## Permissions

The manifest must declare every native capability the script needs. The user reviews and accepts permissions before the script artifact is downloaded.

Common permission IDs:

| Permission | Enables |
|---|---|
| `native:systemInfo` | `clientWizard.invoke({ type: "systemInfo" })` |
| `native:processList` | `clientWizard.invoke({ type: "processList" })` |
| `native:runScript` | `clientWizard.invoke({ type: "runScript", ... })` |
| `native:download` | `clientWizard.download(...)` and `surface.download(...)` |
| `native:extract` | `clientWizard.extract(...)` and `surface.extract(...)` |
| `native:fs:read` | `exists`, `stat`, `listDir`, `readText`, and the read side of `copy` and `move` |
| `native:fs:write` | `writeText`, `appendText`, `mkdir`, `copy`, and `move` |
| `native:fs:delete` | `remove` |
| `native:fs:open` | `openPath` |

The host also accepts the short forms used internally by the current implementation, such as `systemInfo`, `download`, and `fs:read`, but new manifests should prefer the explicit `native:*` IDs.

## The clientWizard API

### `clientWizard.useMarkdown(markdown, options?)`

Creates a single Markdown surface.

```js
const screen = clientWizard.useMarkdown(
  "# Welcome\n\nStatus: `{{ storage.status }}`",
  {
    id: "welcome",
    storage: {
      status: "ready"
    }
  }
);

await screen.setStorage({ status: "running" });
```

Options:

| Option | Type | Description |
|---|---|---|
| `id` | `string` | Optional stable surface ID. |
| `storage` | `object` | Initial storage for this surface. |

### `clientWizard.useWizard(wizard, options?)`

Creates a multi-step wizard surface.

```js
const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "intro",
        title: "Intro",
        markdown: "# Welcome\n\nClick **Next** to continue."
      },
      {
        id: "done",
        title: "Done",
        btnPrev: "none",
        btnNext: "none",
        markdown: "## Complete\n\nStatus: `{{ storage.status }}`"
      }
    ]
  },
  {
    storage: {
      status: "ready"
    }
  }
);
```

Wizard steps:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Optional stable step ID. |
| `title` | `string` | Optional title shown by the host. |
| `markdown` | `string` | Required screen content. Steps without markdown are ignored. |
| `btnPrev` | `"enabled" \| "disabled" \| "none"` | Previous button state. |
| `btnNext` | `"enabled" \| "disabled" \| "none"` | Next button state. |
| `btnNextWhen` | `string` | Storage path that must be truthy to enable Next. |

### Surface handles

Both `useMarkdown()` and `useWizard()` return a surface handle:

```js
const unsubscribe = wizard.events((event) => {
  console.log(event.type, event.data);
});

await wizard.setStorage({ progress: 50 });
const storage = await wizard.getStorage();
const confirmed = await wizard.openDialog({
  title: "Continue?",
  text: "This will start the operation.",
  okText: "Continue",
  cancelText: "Cancel"
});

await wizard.next();
await wizard.prev();
await wizard.goTo("done");

unsubscribe();
```

Handle methods:

| Method | Description |
|---|---|
| `events(callback)` | Receives host UI events for the surface and returns an unsubscribe function. |
| `setStorage(patch)` | Merges a storage patch into the active surface. |
| `getStorage()` | Reads current storage for the active surface. |
| `openDialog(dialog)` | Opens a host confirmation dialog and resolves to `true` or `false`. |
| `next()` | Navigates to the next wizard step. |
| `prev()` | Navigates to the previous wizard step. |
| `goTo(step)` | Navigates to a step index or step ID. |
| `download(request, options?)` | Downloads a file with progress linked to this surface. |
| `extract(request, options?)` | Extracts an archive with progress linked to this surface. |
| `fs` | Scoped file-system helper API. |

## UI events

Wizard navigation emits events to registered handlers. A common pattern is to start work when the user enters a specific step:

```js
wizard.events(async (event) => {
  if (event.type !== "next" || event.data.index !== 1) {
    return;
  }

  await wizard.setStorage({ status: "working", progress: 25 });
});
```

## Storage and Markdown bindings

Storage is local to the active surface. Markdown can read storage values with template expressions:

```md
Status: `{{ storage.status }}`

<ProgressiveBar name="progress" />
```

Example:

```js
const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "progress",
        markdown:
          "## Installing\n\nStatus: `{{ storage.status }}`\n\n<ProgressiveBar name=\"progress\" />"
      }
    ]
  },
  {
    storage: {
      status: "waiting",
      progress: 0
    }
  }
);

await wizard.setStorage({ status: "downloading", progress: 40 });
```

The current renderer supports host-defined Markdown and allowlisted components. Do not depend on arbitrary MDX imports, custom remote components, global CSS, DOM mutation, or arbitrary JavaScript inside Markdown.

## Native commands with `clientWizard.invoke()`

### System information

Requires `native:systemInfo`.

```js
const result = await clientWizard.invoke({ type: "systemInfo" });
const system = JSON.parse(result.stdout || "{}");
await wizard.setStorage({
  os: system.os,
  arch: system.cpuArchitecture,
  cpu: system.cpuCount
});
```

Result shape:

```ts
{
  ok: boolean;
  code?: number;
  stdout: string;
  stderr: string;
}
```

### Process list

Requires `native:processList`.

```js
const result = await clientWizard.invoke({ type: "processList" });
const processes = JSON.parse(result.stdout || "[]");
```

### Run script

Requires `native:runScript`.

```js
const result = await clientWizard.invoke({
  type: "runScript",
  shell: "bash",
  script: "echo \"$1\"",
  args: ["hello"]
});

if (!result.ok) {
  throw new Error(result.stderr || `Script exited with code ${result.code}`);
}
```

Supported shells are `powershell`, `bash`, and `sh`.

## Downloads

Requires `native:download`.

```js
const downloaded = await wizard.download(
  {
    url: "https://example.com/package.zip",
    fileName: "package.zip"
  },
  {
    progressName: "progress",
    statusName: "status",
    progressStart: 10,
    progressEnd: 60
  }
);

await wizard.setStorage({ downloadedPath: downloaded.path });
```

Result:

```ts
{
  path: string;
  fileName: string;
  bytes: number;
}
```

`clientWizard.download(request, options)` is also available. Use the surface handle form when you want progress updates bound to that surface.

## Archive extraction

Requires `native:extract`.

```js
const extracted = await wizard.extract(
  {
    archivePath: downloaded.path,
    destinationName: "package",
    format: "zip",
    stripComponents: 0
  },
  {
    progressName: "progress",
    statusName: "status",
    progressStart: 60,
    progressEnd: 100
  }
);

await wizard.setStorage({
  destinationPath: extracted.destinationPath,
  extractedFiles: extracted.files
});
```

Supported formats are `zip`, `tar.gz`, and `tgz`.

Result:

```ts
{
  destinationPath: string;
  files: number;
}
```

## File-system API

The file-system API uses scoped paths instead of arbitrary absolute paths:

```js
const path = { base: "appData", path: "logs/install.log" };
```

Allowed bases:

| Base | Meaning |
|---|---|
| `appData` | Application data directory. |
| `appCache` | Application cache directory. |
| `temp` | Temporary directory. |
| `downloads` | Downloads directory. |

Available helpers:

```js
const exists = await clientWizard.fs.exists({ base: "appData", path: "config.json" });
const stat = await clientWizard.fs.stat({ base: "appData", path: "config.json" });
const entries = await clientWizard.fs.listDir({ base: "appData", path: "logs" });
const text = await clientWizard.fs.readText({ base: "appData", path: "config.json" });

await clientWizard.fs.writeText({ base: "appData", path: "config.json" }, "{}");
await clientWizard.fs.appendText({ base: "appData", path: "logs/install.log" }, "started\n");
await clientWizard.fs.mkdir({ base: "appData", path: "logs" });
await clientWizard.fs.copy(
  { base: "appData", path: "config.json" },
  { base: "appData", path: "config.backup.json" }
);
await clientWizard.fs.move(
  { base: "appData", path: "config.backup.json" },
  { base: "appData", path: "archive/config.backup.json" }
);
await clientWizard.fs.remove({ base: "appData", path: "archive" }, { recursive: true });
await clientWizard.fs.openPath({ base: "downloads", path: "" });
```

Permission requirements:

- Read operations require `native:fs:read`.
- Write operations require `native:fs:write`.
- Delete operations require `native:fs:delete`.
- Opening a path requires `native:fs:open`.

## Network access

Because `wizard.js` currently runs in a Web Worker, standard worker APIs such as `fetch()` may be available:

```js
const release = await fetch("https://api.github.com/repos/ventoy/Ventoy/releases/latest").then((response) => {
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }
  return response.json();
});
```

This is current runtime behavior, not a dedicated Client Wizard permission model. Client Wizard does not yet provide an audited `clientWizard.httpRequest()` or `clientWizard.invoke({ type: "httpRequest" })` API. Future network access should be modeled as an explicit permission-gated capability with origin allowlists.

## Complete minimal example

Manifest:

```json
{
  "name": "System Info Example",
  "description": "Shows basic system information.",
  "terms": ["./docs/terms.md"],
  "entry": {
    "type": "script",
    "url": "./wizard.js"
  },
  "permissions": [
    {
      "id": "native:systemInfo",
      "title": "Read system information",
      "description": "Allows the wizard to show OS and CPU details."
    }
  ]
}
```

`wizard.js`:

```js
const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "intro",
        title: "Intro",
        markdown: "# System Info\n\nClick **Next** to inspect this machine."
      },
      {
        id: "system",
        title: "System",
        markdown:
          "## Result\n\nStatus: `{{ storage.status }}`\n\nOS: `{{ storage.os }}`\n\nArchitecture: `{{ storage.arch }}`"
      },
      {
        id: "done",
        title: "Done",
        btnPrev: "none",
        btnNext: "none",
        markdown: "## Done\n\nThe wizard completed successfully."
      }
    ]
  },
  {
    storage: {
      status: "waiting"
    }
  }
);

wizard.events(async (event) => {
  if (event.type !== "next" || event.data.index !== 1) {
    return;
  }

  try {
    await wizard.setStorage({ status: "reading system information" });
    const result = await clientWizard.invoke({ type: "systemInfo" });
    const system = JSON.parse(result.stdout || "{}");
    await wizard.setStorage({
      status: "complete",
      os: system.os || "unknown",
      arch: system.cpuArchitecture || "unknown"
    });
    await wizard.goTo("done");
  } catch (error) {
    await wizard.setStorage({
      status: error instanceof Error ? error.message : String(error)
    });
  }
});
```

## ZIP packaging example

Create a ZIP that contains `wizard.js` at the root:

```text
package.zip
└── wizard.js
```

Reference it from the manifest:

```json
{
  "entry": {
    "type": "zip",
    "url": "./package.zip",
    "script": "wizard.js"
  }
}
```

The repository includes a working public example:

```text
https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json
```

## Error handling

Add global handlers so unexpected script failures can update the UI:

```js
async function fail(error) {
  await wizard.setStorage({
    status: "failed",
    errorMessage: error instanceof Error ? error.message : String(error)
  });
  await wizard.goTo("failure");
}

globalThis.addEventListener("error", (event) => {
  void fail(event.error || event.message || "Unexpected error");
});

globalThis.addEventListener("unhandledrejection", (event) => {
  void fail(event.reason || "Unhandled promise rejection");
});
```

## Debugging

- Use localhost manifests only with `npm run tauri dev`.
- Use HTTPS manifests for installed apps.
- If an installed app reports `Failed to fetch`, check that the manifest and artifacts are reachable over HTTPS and allow CORS when the WebView requires it.
- If a native operation fails with a permission error, add the matching permission to the manifest and reload the flow.
- If a ZIP fails with `ZIP nao contem wizard.js`, confirm the ZIP contains the script path declared by `entry.script`.

## Best practices

- Request only the permissions the wizard actually needs.
- Prefer host-rendered Markdown and wizard steps over complex script-driven UI.
- Keep `wizard.js` deterministic and easy to audit.
- Use explicit error states and failure screens.
- Use `wizard.openDialog()` before destructive or surprising actions.
- Prefer surface handle downloads and extraction so progress appears in the current UI.
- Do not rely on remote HTML, DOM mutation, global CSS, or custom components not provided by the host.
````

- [ ] **Step 3: Run the authoring guide coverage check**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$required = @(
  '# Writing `wizard.js` Scripts',
  'clientWizard.useMarkdown',
  'clientWizard.useWizard',
  'clientWizard.invoke',
  'clientWizard.download',
  'clientWizard.extract',
  'clientWizard.fs.exists',
  'native:systemInfo',
  'native:processList',
  'native:runScript',
  'native:download',
  'native:extract',
  'native:fs:read',
  'fetch()',
  'ZIP packaging example',
  'https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json'
)
$content = Get-Content -Raw docs\wizard-script-authoring.md
$missing = $required | Where-Object { $content -notlike "*$_*" }
if ($missing) {
  Write-Host "Missing authoring guide content:"
  $missing | ForEach-Object { Write-Host "- $_" }
  exit 1
}
Write-Host 'Authoring guide coverage check passed.'
```

Expected: PASS with `Authoring guide coverage check passed.`

- [ ] **Step 4: Commit authoring guide**

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
git add docs/wizard-script-authoring.md
git commit -m "Add wizard script authoring guide" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

If the session worktree git metadata is broken, copy `docs\wizard-script-authoring.md` to the clean clone, commit there, and push from that clean clone.

---

### Task 3: Validate documentation consistency and publish

**Files:**
- Modify only if validation finds factual documentation errors:
  - `README.md`
  - `docs/wizard-script-authoring.md`

**Interfaces:**
- Consumes:
  - Completed `README.md`.
  - Completed `docs/wizard-script-authoring.md`.
- Produces:
  - Verified documentation with matching commands, links, and implemented API references.

- [ ] **Step 1: Run link and command consistency checks**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$errors = @()
$readme = Get-Content -Raw README.md
$guide = Get-Content -Raw docs\wizard-script-authoring.md
$installer = Get-Content -Raw install\macos.sh
$types = Get-Content -Raw src\types.ts
$native = Get-Content -Raw src\native.ts

foreach ($needle in @(
  'CLIENT_WIZARD_REPO',
  'CLIENT_WIZARD_VERSION',
  'CLIENT_WIZARD_INSTALL_DIR',
  'CLIENT_WIZARD_OPEN'
)) {
  if ($installer -notlike "*$needle*") { $errors += "install\macos.sh missing $needle" }
  if ($readme -notlike "*$needle*") { $errors += "README.md missing $needle" }
}

foreach ($needle in @(
  'type: "systemInfo"',
  'type: "processList"',
  'type: "runScript"',
  'type: "zip"',
  'type: "script"'
)) {
  if ($types -notlike "*$needle*") { $errors += "src\types.ts missing $needle" }
}

foreach ($needle in @(
  'exists',
  'stat',
  'listDir',
  'readText',
  'writeText',
  'appendText',
  'mkdir',
  'remove',
  'copy',
  'move',
  'openPath'
)) {
  if ($native -notlike "*$needle*") { $errors += "src\native.ts missing fs action $needle" }
  if ($guide -notlike "*$needle*") { $errors += "docs\wizard-script-authoring.md missing fs action $needle" }
}

foreach ($path in @(
  'docs/wizard-script-authoring.md',
  'docs/client-wizard-runtime-spec.md'
)) {
  if ($readme -notlike "*$path*") { $errors += "README.md missing link to $path" }
}

if ($errors) {
  $errors | ForEach-Object { Write-Host "- $_" }
  exit 1
}

Write-Host 'Documentation consistency check passed.'
```

Expected: PASS with `Documentation consistency check passed.`

- [ ] **Step 2: Validate public example URLs**

Run:

```powershell
curl.exe -fsSL --max-time 15 https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/manifest.json | Select-String -Pattern '"type": "zip"|"url": "./package.zip"|"script": "wizard.js"'
curl.exe -fsSL --max-time 15 https://raw.githubusercontent.com/runvibe/client-wizard/main/public/tests/zip-basic/package.zip -o $env:TEMP\client-wizard-zip-basic-package.zip
tar -tf $env:TEMP\client-wizard-zip-basic-package.zip
```

Expected:

```text
"type": "zip"
"url": "./package.zip"
"script": "wizard.js"
wizard.js
```

- [ ] **Step 3: Run the existing build**

Run:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
npm run build
```

Expected: PASS. This is a documentation-only change, but the build confirms no accidental source edits broke the project.

- [ ] **Step 4: Commit any consistency fixes**

If Step 1, Step 2, or Step 3 required documentation corrections, commit them:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
git add README.md docs/wizard-script-authoring.md
git commit -m "Polish Client Wizard documentation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
```

If no fixes were needed, skip this commit.

- [ ] **Step 5: Push from the clean clone if needed**

Because this session worktree has broken git metadata, publish by copying the changed files to the clean clone and pushing from there:

```powershell
$source = 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
$clone = 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
Set-Location $clone
git pull --ff-only origin main
Copy-Item -Path "$source\README.md" -Destination "$clone\README.md" -Force
New-Item -ItemType Directory -Force -Path "$clone\docs" | Out-Null
Copy-Item -Path "$source\docs\wizard-script-authoring.md" -Destination "$clone\docs\wizard-script-authoring.md" -Force
git status --short
git add README.md docs/wizard-script-authoring.md
git commit -m "Improve Client Wizard documentation" -m "Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"
git push origin main
```

If GitHub rejects the push with an internal server error, retry once:

```powershell
Set-Location 'C:\Users\phili\AppData\Local\Temp\client-wizard-release-clean-0481feefdb8a4d219f73c08a4713fdc6'
git push origin main
```

If the second push fails, leave the commit in the clean clone and report the exact local commit SHA and remote error.

---

## Self-Review

Spec coverage:

- README product explanation: Task 1.
- Installation commands: Task 1.
- macOS current support plus Windows/Linux placeholders: Task 1.
- Comprehensive `wizard.js` guide: Task 2.
- All available SDK resources and examples: Task 2.
- Implemented vs future behavior distinction: Task 1 security model and Task 2 network section.
- Validation against current implementation: Task 3.

Placeholder scan:

- The plan contains no unresolved placeholder markers or vague implementation steps.
- Each task includes concrete file paths, commands, and expected outputs.

Type consistency:

- Manifest entry types match `src\types.ts`: `script`, `zip`, optional `entry.script`.
- Native command types match `src\types.ts`: `systemInfo`, `processList`, `runScript`.
- File-system actions match `src\native.ts`: `exists`, `stat`, `listDir`, `readText`, `writeText`, `appendText`, `mkdir`, `remove`, `copy`, `move`, `openPath`.
- Installer variables match `install\macos.sh`: `CLIENT_WIZARD_REPO`, `CLIENT_WIZARD_VERSION`, `CLIENT_WIZARD_INSTALL_DIR`, `CLIENT_WIZARD_OPEN`.
