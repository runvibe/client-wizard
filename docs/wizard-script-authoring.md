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

Options:

| Option | Type | Description |
|---|---|---|
| `id` | `string` | Optional stable wizard surface ID. |
| `currentStep` | `number` | Optional zero-based starting step index. Use to start the wizard on a non-zero step. |
| `storage` | `object` | Initial storage for the surface. |

Example (start on step index 1):

```js
const wizard = clientWizard.useWizard(
  {
    steps: [ /* ... */ ]
  },
  {
    currentStep: 1,
    storage: { status: "ready" }
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

Wizard surfaces emit UI notifications to registered handlers via `handle.events(callback)`. Each event is an object with `type` and `data` properties. The following event types are implemented by the host:

Normal HTTP links are opened externally by the host. Local `.md` links are loaded by the host without notifying `wizard.events()`.

| Event | Description | data payload |
|---|---|---|
| `next` | The user activated the Next button (or equivalent). | `{ index: number, step: WizardStep, storage: object }` |
| `prev` | The user activated the Previous button. | `{ index: number, step: WizardStep, storage: object }` |
| `goTo` | A navigation request to a specific step (user or script-driven). | `{ index: number, step: WizardStep, storage: object }` |
| `link` | Emitted only when a Markdown link uses a dynamic JSON `href` target. | carries the parsed JSON object from the `href`. |

Example usage:

```js
wizard.events((event) => {
  switch (event.type) {
    case "next":
      console.log("Next ->", event.data.index, event.data.step);
      break;
    case "prev":
      console.log("Prev ->", event.data.step);
      break;
    case "goTo":
      console.log("GoTo ->", event.data.index, event.data.step);
      break;
    case "link":
      console.log("Link clicked ->", event.data.href);
      break;
  }
});
```

Use events to trigger background work when the user arrives at a step, to intercept link clicks, or to coordinate wizard state with native operations.

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

### Allowlisted components

The host provides a small set of allowlisted primitives you can use inside Markdown. These are rendered by the host and may read from and write to the surface storage via the `name` prop.

- ProgressiveBar
  - Usage: `<ProgressiveBar name="progress" />`
  - Binds to a numeric storage path and renders progress.

- WizardCheckbox
  - Usage: `<WizardCheckbox name="termsAccepted" label="I accept the terms" />`
  - Props:
    - `name` (string) — Storage path the checkbox value is written to (boolean).
    - `label` (string) — Visible label shown next to the checkbox.
  - Behavior: toggling the checkbox updates `storage[name]` to `true`/`false`. Initial checked state should be provided via the surface initial storage, for example when creating the wizard: `{ storage: { termsAccepted: false } }`. Use `btnNextWhen` or script logic to gate progression on the checkbox state.



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
