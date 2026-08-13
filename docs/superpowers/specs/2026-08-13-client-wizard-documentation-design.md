# Client Wizard Documentation Design

## Goal

Create professional English documentation that clearly explains what Client Wizard is, how to install it, and how to author remote `wizard.js` scripts.

## Documentation structure

### README.md

`README.md` will become the product entry point. It should be concise, complete enough for first-time users, and written in professional English.

It will cover:

1. What Client Wizard is: a Tauri/Rust desktop runtime that loads a trusted manifest and executes a remote JavaScript orchestrator while rendering all visible UI locally.
2. Why it exists: to ship guided installers, setup assistants, diagnostics, and environment-specific flows without shipping arbitrary remote HTML.
3. How it works: manifest fetch, consent, permissions, script or ZIP download, isolated worker execution, local React/shadcn rendering, and controlled native commands.
4. Installation:
   - macOS terminal installer as the currently supported install path.
   - version-specific macOS install.
   - debug install command.
   - install environment variables.
   - app CLI startup with `--manifest`.
   - Windows and Linux sections marked as platform packaging notes until dedicated installers are finalized.
5. Run from source: npm install, build, Tauri dev.
6. Examples:
   - local sample manifest.
   - public HTTPS ZIP manifest.
   - Ventoy test flow.
7. Security model: default-deny permissions, consent before artifact download, no visible remote HTML, isolated worker, controlled native bridge, HTTPS-first loading.
8. Links to the dedicated wizard script authoring guide and the runtime spec.

### docs/wizard-script-authoring.md

This will be the comprehensive guide for developers writing `wizard.js`.

It will cover:

1. Runtime model:
   - `wizard.js` runs as an orchestrator, not as a webpage.
   - It has no direct DOM UI surface.
   - The host renders screens through local components.
2. Manifest entry types:
   - direct script entry.
   - ZIP entry with `entry.script`.
   - public HTTPS and local development examples.
3. `clientWizard` API:
   - `clientWizard.useMarkdown(markdown)`.
   - `clientWizard.useWizard(wizard)`.
   - `clientWizard.invoke(command)`.
4. Markdown/Safe MDX usage:
   - when to use markdown screens.
   - host-rendered components and storage bindings where supported.
5. Wizard screens:
   - defining steps.
   - collecting input.
   - updating storage.
   - responding to user actions.
   - success and failure screens.
6. Native commands currently available:
   - document all implemented `invoke` command types from the codebase.
   - show permissions required for each command when applicable.
7. Storage and state:
   - local reactive state model.
   - examples for progress, collected values, and status messages.
8. Network behavior:
   - explain current web `fetch` behavior in the worker.
   - clarify that no first-class audited `httpRequest` bridge exists yet.
   - recommend treating network access as future permission-gated API design.
9. ZIP packaging:
   - how to package `wizard.js`.
   - relative manifest URL behavior.
   - public HTTPS hosting requirements.
10. Complete examples:
   - minimal markdown script.
   - multi-step wizard.
   - system information example.
   - ZIP package example.
11. Debugging:
   - local dev manifest URLs.
   - public HTTPS testing.
   - common fetch/CORS/SSL failures.
12. Security constraints and best practices:
   - request only required permissions.
   - keep scripts deterministic and auditable.
   - do not rely on remote HTML, DOM mutation, or global CSS.

### docs/client-wizard-runtime-spec.md

The runtime spec remains the deeper architecture reference. It should not become the main user-facing guide in this pass.

## Scope

This documentation pass updates documentation only. It does not change runtime behavior, installer behavior, permissions, or packaging.

## Validation

Validate by checking that:

1. README installation commands match `install/macos.sh`.
2. `wizard.js` API documentation matches the implementation in `src/App.tsx`.
3. All example URLs and paths are accurate.
4. The documentation clearly distinguishes implemented behavior from planned/future behavior.
