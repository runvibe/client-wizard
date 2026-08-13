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
