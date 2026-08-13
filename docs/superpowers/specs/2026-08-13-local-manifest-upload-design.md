# Local Manifest Upload Design

## Goal

Allow users to start Client Wizard either by entering a manifest URL or by selecting a local `manifest.json` file from disk.

## User experience

The initial screen keeps the existing manifest URL form and adds a secondary action:

- Primary path: enter a HTTPS or localhost manifest URL and click **Load**.
- Local path: click **Select manifest file**, choose a `.json` file, and let the app load it.

After either path loads a manifest, the existing consent, document review, permission review, artifact loading, and runtime startup flow remains unchanged.

## Source model

Manifest loading will support two source kinds:

1. `remote-url`
   - Existing behavior.
   - Manifest, documents, scripts, and ZIP packages are fetched by URL.
   - URLs must use HTTPS, except localhost development URLs.
2. `local-file`
   - New behavior.
   - The user selects a local manifest file through a native Tauri file picker.
   - The app reads the selected file through the native backend.
   - Relative document and artifact paths are resolved from the selected manifest file's parent directory.
   - Absolute HTTPS URLs inside a local manifest continue to work.

The app should keep enough source metadata to audit how the manifest was loaded and to resolve later document/artifact references:

```ts
type ManifestSource =
  | { kind: "remote-url"; url: string }
  | { kind: "local-file"; path: string; baseDir: string; displayName: string };
```

## Local reference resolution

For a local manifest:

- `./docs/terms.md` resolves to a local file under the selected manifest directory.
- `./wizard.js` resolves to a local script file under the selected manifest directory.
- `./package.zip` resolves to a local ZIP file under the selected manifest directory.
- HTTPS URLs remain HTTPS URLs and are fetched with the existing remote path.
- Non-HTTPS remote URLs remain rejected.
- Local references must not be treated as browser `file://` URLs in the frontend. They should be read through explicit Tauri commands.

The implementation should reject unsupported local reference forms with clear user-facing errors.

## Native backend surface

Add focused native commands instead of exposing arbitrary filesystem reads to the frontend:

- `select_manifest_file()`
  - Opens a native file picker for JSON files.
  - Reads the selected file as UTF-8 text.
  - Returns the selected path and file contents.
- `read_local_text_file(path)`
  - Reads a local text file needed by an already selected local manifest.
  - Used for local consent documents and local script entries.
- `read_local_binary_file(path)`
  - Reads a local binary file needed by an already selected local manifest.
  - Used for local ZIP entries.

The frontend owns the manifest validation and existing consent flow. The backend only opens or reads explicit local files requested by the frontend.

## Runtime flow

### Remote URL manifest

The existing flow remains:

```text
User enters manifest URL
  -> fetch manifest
  -> validate manifest
  -> fetch consent documents
  -> user accepts documents and permissions
  -> fetch script or ZIP
  -> start worker
```

### Local file manifest

The new flow is:

```text
User clicks Select manifest file
  -> native file picker returns manifest path + text
  -> parse JSON
  -> validate manifest using local source context
  -> read local or fetch remote consent documents
  -> user accepts documents and permissions
  -> read local or fetch remote script/ZIP
  -> start worker
```

The local script or ZIP artifact is still loaded only after consent and permission review. Selecting a local manifest must not immediately execute local JavaScript.

## Error handling

The UI should show clear errors for:

- user cancels the file picker;
- selected file is not readable;
- selected file is not valid UTF-8 JSON;
- manifest schema is invalid;
- a relative local document/script/ZIP path does not exist or cannot be read;
- a local ZIP does not contain `entry.script` or `wizard.js`;
- a local artifact uses an unsupported entry type;
- a remote URL in a local manifest violates the existing HTTPS policy.

Canceling the file picker should leave the app idle without showing a scary error.

## Security and consent

Local manifests are more powerful because they can reference local sibling files. The app must preserve the same safety model:

- no artifact is loaded before consent;
- native permissions still require explicit manifest permissions and user approval;
- local references are explicit and resolved from the manifest file directory;
- the audit log records the source kind and selected manifest path;
- remote URL validation remains HTTPS-first.

This feature does not add `require()`, Node.js module loading, or `node_modules` resolution for `wizard.js`.

## Documentation updates

Update user-facing docs to explain:

- users can load a manifest by URL or local file;
- local relative paths resolve from the selected manifest directory;
- local scripts/ZIP packages are still loaded after consent;
- `wizard.js` is still a Web Worker script and does not gain Node.js `require`.

## Validation

Implementation should be validated with:

1. A successful remote URL manifest load to prove existing behavior still works.
2. A successful local manifest that references local `docs/terms.md` and local `wizard.js`.
3. A successful local manifest that references local `package.zip`.
4. An invalid JSON local manifest error.
5. A missing local artifact error.
6. Existing build/type-check.
