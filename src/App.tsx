import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import JSZip from "jszip";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { eventsToCsv, listAuditEvents, logAuditEvent, type AuditCategory, type AuditEvent, type AuditEventInput, type AuditLevel } from "./audit";
import {
  clearLocalManifestScope,
  confirmLocalManifestScope,
  deactivateLocalManifestScope,
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
  readLocalConsentDocument,
  readLocalTextFile,
  selectManifestFile,
  type FsExecuteRequest,
  type FsPath,
  type LaunchManifestPayload,
  type LocalManifestFile,
  type LocalManifestReference
} from "./native";
import type {
  ActiveSurface,
  ClientWizardManifest,
  ClientWizardTheme,
  DialogDefinition,
  ManifestEntry,
  ManifestPermission,
  NativeCommand,
  NavigationButtonState,
  WizardStep
} from "./types";

type AppState = "idle" | "loading-manifest" | "consent" | "loading-artifact" | "running";
type ConsentStep = "terms" | "documents" | "permissions";
type ConsentDocumentKind = "terms" | "license" | "privacy";
type ConsentDocument = {
  id: string;
  kind: ConsentDocumentKind;
  name: string;
  url: string;
  markdown: string;
};

type ManifestSource =
  | { kind: "remote-url"; url: string; display: string }
  | { kind: "local-file"; path: string; baseDir: string; display: string };

type ResolvedReference =
  | { kind: "remote-url"; url: string }
  | ({ kind: "local-file"; display: string } & LocalManifestReference);

type RuntimeMessage = {
  source: "client-wizard-script";
  runtimeId: string;
  requestId?: string;
  surfaceId?: string;
  type: string;
  payload?: unknown;
};

type DialogRequest = {
  dialog: DialogDefinition;
  resolve: (value: boolean) => void;
};

type WizardThemeStyle = CSSProperties & Record<`--${string}`, string>;
type NativeProgressEvent = {
  operationId: string;
  phase: string;
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  message: string;
};

const localhostNames = new Set(["localhost", "127.0.0.1", "::1"]);

export function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [manifestUrl, setManifestUrl] = useState("");
  const [manifestSource, setManifestSource] = useState<ManifestSource>();
  const [manifest, setManifest] = useState<ClientWizardManifest>();
  const [error, setError] = useState("");
  const [consentStep, setConsentStep] = useState<ConsentStep>("terms");
  const [currentTermIndex, setCurrentTermIndex] = useState(0);
  const [consentDocuments, setConsentDocuments] = useState<ConsentDocument[]>([]);
  const [acceptedTermIds, setAcceptedTermIds] = useState<Record<string, boolean>>({});
  const [acceptedDocumentIds, setAcceptedDocumentIds] = useState<Record<string, boolean>>({});
  const [acceptedPermissions, setAcceptedPermissions] = useState<Record<string, boolean>>({});
  const [activeSurface, setActiveSurface] = useState<ActiveSurface>();
  const [dialogRequest, setDialogRequest] = useState<DialogRequest>();
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const sessionIdRef = useRef(crypto.randomUUID());
  const runtimeIdRef = useRef("");
  const workerRef = useRef<Worker | undefined>(undefined);
  const activeSurfaceRef = useRef<ActiveSurface | undefined>(undefined);
  const acceptedPermissionIdsRef = useRef(new Set<string>());
  const progressTargetsRef = useRef(new Map<string, { progressName: string; statusName: string; surfaceId: string; progressStart: number; progressEnd: number }>());

  const acceptedPermissionIds = useMemo(
    () => new Set(Object.entries(acceptedPermissions).filter(([, accepted]) => accepted).map(([id]) => id)),
    [acceptedPermissions]
  );
  const themeStyle = useMemo(() => createThemeStyle(manifest?.theme), [manifest?.theme]);
  const isAuditWindow = useMemo(() => new URLSearchParams(window.location.search).get("view") === "audit", []);
  const isAboutWindow = useMemo(() => new URLSearchParams(window.location.search).get("view") === "about", []);
  const isDocumentWindow = useMemo(() => new URLSearchParams(window.location.search).get("view") === "document", []);

  useEffect(() => {
    acceptedPermissionIdsRef.current = acceptedPermissionIds;
  }, [acceptedPermissionIds]);

  useEffect(() => {
    activeSurfaceRef.current = activeSurface;
  }, [activeSurface]);

  useEffect(() => {
    return () => stopWorker();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setIsAppMenuOpen((isOpen) => !isOpen);
        return;
      }

      if (event.key === "Escape") {
        setIsAppMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    let active = true;

    Promise.all([
      listen<NativeProgressEvent>("client-wizard://download-progress", (event) => applyNativeProgress(event.payload)),
      listen<NativeProgressEvent>("client-wizard://extract-progress", (event) => applyNativeProgress(event.payload)),
      listen<LaunchManifestPayload>("client-wizard-open-manifest", (event) => {
        if (!isAuditWindow && !isAboutWindow && !isDocumentWindow) {
          void runManifestLoad(() => loadRemoteManifest(event.payload.manifestUrl, event.payload.source));
        }
      }),
      listen<string>("client-wizard-open-manifest-error", (event) => {
        if (!isAuditWindow && !isAboutWindow && !isDocumentWindow) {
          setAppState("idle");
          setError(event.payload);
        }
      }),
      listen("client-wizard-switch-manifest", () => {
        if (!isAuditWindow && !isAboutWindow && !isDocumentWindow) {
          resetToIdle(stopWorker);
        }
      })
    ]).then((listeners) => {
      if (!active) {
        listeners.forEach((unsubscribe) => unsubscribe());
        return;
      }
      unsubscribers.push(...listeners);
    });

    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    if (isAuditWindow || isAboutWindow || isDocumentWindow) {
      return;
    }

    let active = true;
    getLaunchManifestUrl()
      .then((payload) => {
        if (active && payload) {
        void runManifestLoad(() => loadRemoteManifest(payload.manifestUrl, payload.source));
        }
      })
      .catch((caughtError) => {
        if (active) {
          setError(errorMessage(caughtError));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("clientWizardAbout", JSON.stringify(createAboutData(manifest, manifestSource?.display ?? manifestUrl)));
  }, [manifest, manifestUrl, manifestSource?.display]);

  const canStart =
    manifest !== undefined &&
    consentDocuments.filter((document) => document.kind === "terms").every((document) => acceptedTermIds[document.id]) &&
    consentDocuments.filter((document) => document.kind !== "terms").every((document) => acceptedDocumentIds[document.id]) &&
    manifest.permissions.every((permission) => acceptedPermissions[permission.id]);

  async function submitManifest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runManifestLoad(() => loadRemoteManifest(manifestUrl, "manual"));
  }

  async function runManifestLoad(loader: () => Promise<void>) {
    try {
      await loader();
    } catch (caughtError) {
      await clearLocalManifestScope();
      setError(errorMessage(caughtError));
      setAppState("idle");
      audit({
        level: "error",
        category: "manifest",
        action: "manifest.load.error",
        summary: "Falha ao carregar manifesto",
        error: errorMessage(caughtError)
      });
    }
  }

  async function loadRemoteManifest(inputUrl: string, source: "manual" | LaunchManifestPayload["source"]) {
    setError("");
    setActiveSurface(undefined);
    stopWorker();
    setAppState("loading-manifest");
    await clearLocalManifestScope();
    const url = normalizeAllowedUrl(inputUrl, "manifesto");
    const sourceData: ManifestSource = { kind: "remote-url", url, display: url };
    sessionIdRef.current = crypto.randomUUID();
    audit({
      level: "info",
      category: "manifest",
      action: "manifest.load.start",
      summary: "Carregando manifesto",
      input: { source: sourceData, sourceKind: source }
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Manifesto retornou HTTP ${response.status}.`);
    }
    const loadedManifest = validateManifest(await response.json(), sourceData);
    const loadedDocuments = await loadConsentDocuments(loadedManifest, sourceData);

    setManifestSource(sourceData);
    setManifestUrl(sourceData.display);
    setManifest(loadedManifest);
    setConsentDocuments(loadedDocuments);
    setCurrentTermIndex(0);
    setAcceptedTermIds({});
    setAcceptedDocumentIds({});
    setAcceptedPermissions({});
    setConsentStep(getInitialConsentStep(loadedDocuments));
    setAppState("consent");
    audit({
      level: "info",
      category: "manifest",
      action: "manifest.load.success",
      summary: `Manifesto carregado: ${loadedManifest.name}`,
      output: {
        name: loadedManifest.name,
        source: sourceData,
        launchSource: source,
        documents: loadedDocuments.map((document) => ({ kind: document.kind, name: document.name, url: document.url })),
        permissions: loadedManifest.permissions.map((permission) => permission.id)
      }
    });
  }

  async function loadSelectedManifestFile() {
    setError("");
    setActiveSurface(undefined);
    stopWorker();
    setAppState("loading-manifest");
    await clearLocalManifestScope();

    const selected: LocalManifestFile | null = await selectManifestFile();
    if (!selected) {
      setAppState("idle");
      return;
    }

    const source: ManifestSource = {
      kind: "local-file",
      path: selected.path,
      baseDir: selected.baseDir,
      display: selected.path
    };

    sessionIdRef.current = crypto.randomUUID();
    audit({
      level: "info",
      category: "manifest",
      action: "manifest.load.start",
      summary: "Carregando manifesto local",
      input: { source }
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripUtf8Bom(selected.content));
    } catch (caughtError) {
      throw new Error(`Manifesto local nao contem JSON valido: ${errorMessage(caughtError)}`);
    }

    const loadedManifest = validateManifest(parsed, source);
    const loadedDocuments = await loadConsentDocuments(loadedManifest, source);

    setManifestSource(source);
    setManifestUrl(source.display);
    setManifest(loadedManifest);
    setConsentDocuments(loadedDocuments);
    setCurrentTermIndex(0);
    setAcceptedTermIds({});
    setAcceptedDocumentIds({});
    setAcceptedPermissions({});
    setConsentStep(getInitialConsentStep(loadedDocuments));
    setAppState("consent");
    audit({
      level: "info",
      category: "manifest",
      action: "manifest.load.success",
      summary: `Manifesto carregado: ${loadedManifest.name}`,
      output: {
        name: loadedManifest.name,
        source,
        documents: loadedDocuments.map((document) => ({ kind: document.kind, name: document.name, url: document.url })),
        permissions: loadedManifest.permissions.map((permission) => permission.id)
      }
    });
  }

  async function startWizard() {
    if (!manifest || !canStart) {
      return;
    }

    setError("");
    setAppState("loading-artifact");
    audit({
      level: "info",
      category: "artifact",
      action: "artifact.load.start",
      summary: "Baixando artefato aprovado",
      input: manifest.entry
    });
    try {
      const localManifestPath = manifestSource?.kind === "local-file" ? manifestSource.path : undefined;
      if (localManifestPath) {
        await confirmLocalManifestScope(localManifestPath);
      }
      let script: string;
      try {
        script = await loadEntryScript(manifest.entry, manifestSource ?? { kind: "remote-url", url: manifestUrl, display: manifestUrl });
      } finally {
        if (localManifestPath) {
          await deactivateLocalManifestScope();
        }
      }
      startWorker(script);
      setAppState("running");
      audit({
        level: "info",
        category: "runtime",
        action: "runtime.start.success",
        summary: "Runtime iniciado"
      });
    } catch (caughtError) {
      setError(errorMessage(caughtError));
      setConsentStep("permissions");
      setAppState("consent");
      audit({
        level: "error",
        category: "artifact",
        action: "artifact.load.error",
        summary: "Falha ao baixar ou iniciar artefato",
        error: errorMessage(caughtError)
      });
    }
  }

  function stopWorker() {
    workerRef.current?.terminate();
    workerRef.current = undefined;
    runtimeIdRef.current = "";
  }

  function startWorker(script: string) {
    stopWorker();
    setActiveSurface(undefined);

    const runtimeId = crypto.randomUUID();
    runtimeIdRef.current = runtimeId;
    const source = `${createWorkerSdk(runtimeId)}\n\n${script}`;
    const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(workerUrl, { name: `client-wizard-${runtimeId}` });
    URL.revokeObjectURL(workerUrl);
    workerRef.current = worker;
    audit({
      level: "info",
      category: "runtime",
      action: "worker.created",
      summary: "Worker do wizard criado",
      output: { runtimeId }
    });

    worker.onmessage = (event: MessageEvent<RuntimeMessage>) => {
      void handleRuntimeMessage(event.data);
    };
    worker.onerror = (event) => {
      setError(event.message || "Erro ao executar wizard.js.");
      audit({
        level: "error",
        category: "runtime",
        action: "worker.error",
        summary: "Erro no worker do wizard",
        error: event.message
      });
    };
  }

  async function handleRuntimeMessage(message: RuntimeMessage) {
    if (!isRuntimeMessage(message) || message.runtimeId !== runtimeIdRef.current) {
      return;
    }

    audit({
      level: "debug",
      category: "sdk",
      action: message.type,
      summary: `Mensagem SDK recebida: ${message.type}`,
      surfaceId: message.surfaceId,
      input: message.payload
    });

    try {
      if (message.type === "screen.create") {
        const payload = asRecord(message.payload);
        const surfaceId = String(payload.surfaceId || message.surfaceId || crypto.randomUUID());
        setActiveSurface({
          id: surfaceId,
          kind: "markdown",
          markdown: String(payload.markdown ?? ""),
          storage: asRecord(payload.storage)
        });
        postWorkerResult(message, { ok: true, surfaceId });
        return;
      }

      if (message.type === "wizard.create") {
        const payload = asRecord(message.payload);
        const surfaceId = String(payload.surfaceId || message.surfaceId || crypto.randomUUID());
        const steps = normalizeWizardSteps(payload.wizard);
        if (!steps.length) {
          throw new Error("wizard.create precisa receber pelo menos um step com markdown.");
        }
        setActiveSurface({
          id: surfaceId,
          kind: "wizard",
          currentStep: clamp(Number(payload.currentStep ?? 0), 0, steps.length - 1),
          steps,
          storage: asRecord(payload.storage)
        });
        postWorkerResult(message, { ok: true, surfaceId, steps: steps.length });
        return;
      }

      if (message.type === "surface.setStorage") {
        const payload = asRecord(message.payload);
        patchSurfaceStorage(String(message.surfaceId ?? payload.surfaceId ?? ""), asRecord(payload.patch));
        postWorkerResult(message, { ok: true });
        return;
      }

      if (message.type === "surface.getStorage") {
        const surfaceId = String(message.surfaceId ?? asRecord(message.payload).surfaceId ?? "");
        const surface = activeSurfaceRef.current;
        postWorkerResult(message, { storage: surface?.id === surfaceId ? surface.storage : {} });
        return;
      }

      if (message.type === "surface.openDialog") {
        const confirmed = await openDialog(asRecord(message.payload) as DialogDefinition);
        postWorkerResult(message, { confirmed });
        return;
      }

      if (message.type === "surface.navigate") {
        const payload = asRecord(message.payload);
        const result = navigateWizard(String(message.surfaceId ?? payload.surfaceId ?? ""), {
          direction: payload.direction === "prev" ? "prev" : payload.direction === "next" ? "next" : undefined,
          target: typeof payload.target === "number" || typeof payload.target === "string" ? payload.target : undefined
        });
        postWorkerResult(message, result);
        return;
      }

      if (message.type === "native.invoke") {
        const command = asRecord(message.payload).command as NativeCommand;
        assertNativePermission(command, acceptedPermissionIdsRef.current);
        audit({
          level: "security",
          category: "native",
          action: `native.${String(asRecord(command).type)}`,
          summary: `Comando nativo autorizado: ${String(asRecord(command).type)}`,
          input: command
        });
        const result = await executeNative(command);
        audit({
          level: result.ok ? "info" : "error",
          category: "native",
          action: `native.${String(asRecord(command).type)}.result`,
          summary: `Resultado do comando nativo: ${String(asRecord(command).type)}`,
          output: result
        });
        postWorkerResult(message, result);
        return;
      }

      if (message.type === "native.download") {
        assertPermissionForAction("download", acceptedPermissionIdsRef.current);
        const payload = asRecord(message.payload);
        const operationId = crypto.randomUUID();
        const surfaceId = String(message.surfaceId ?? payload.surfaceId ?? "");
        registerProgressTarget(operationId, surfaceId, payload);
        const request = asRecord(payload.request);
        audit({
          level: "security",
          category: "native",
          action: "native.download",
          summary: "Download nativo autorizado",
          surfaceId,
          input: request
        });
        try {
          const result = await downloadFile({
            url: requireString(request.url, "download.url"),
            fileName: typeof request.fileName === "string" ? request.fileName : undefined,
            operationId
          });
          postWorkerResult(message, result);
          audit({
            level: "info",
            category: "native",
            action: "native.download.result",
            summary: "Download nativo concluido",
            surfaceId,
            output: result
          });
        } finally {
          progressTargetsRef.current.delete(operationId);
        }
        return;
      }

      if (message.type === "native.extract") {
        assertPermissionForAction("extract", acceptedPermissionIdsRef.current);
        const payload = asRecord(message.payload);
        const operationId = crypto.randomUUID();
        const surfaceId = String(message.surfaceId ?? payload.surfaceId ?? "");
        registerProgressTarget(operationId, surfaceId, payload);
        const request = asRecord(payload.request);
        audit({
          level: "security",
          category: "native",
          action: "native.extract",
          summary: "Extracao nativa autorizada",
          surfaceId,
          input: request
        });
        try {
          const result = await extractArchive({
            archivePath: requireString(request.archivePath, "extract.archivePath"),
            destinationName: typeof request.destinationName === "string" ? request.destinationName : undefined,
            format: normalizeArchiveFormat(request.format),
            stripComponents: typeof request.stripComponents === "number" ? request.stripComponents : undefined,
            operationId
          });
          postWorkerResult(message, result);
          audit({
            level: "info",
            category: "native",
            action: "native.extract.result",
            summary: "Extracao nativa concluida",
            surfaceId,
            output: result
          });
        } finally {
          progressTargetsRef.current.delete(operationId);
        }
        return;
      }

      if (message.type === "native.fs") {
        const payload = asRecord(message.payload);
        const request = asRecord(payload.request ?? payload);
        const action = requireString(request.action, "fs.action");
        assertFsPermission(action, acceptedPermissionIdsRef.current);
        const surfaceId = String(message.surfaceId ?? payload.surfaceId ?? "");
        audit({
          level: "security",
          category: "native",
          action: `native.fs.${action}`,
          summary: `FS nativo autorizado: ${action}`,
          surfaceId,
          input: request
        });
        const result = await fsExecute(normalizeFsExecuteRequest(request, action));
        audit({
          level: "info",
          category: "native",
          action: `native.fs.${action}.result`,
          summary: `FS nativo concluido: ${action}`,
          surfaceId,
          output: result
        });
        postWorkerResult(message, result);
        return;
      }
    } catch (caughtError) {
      audit({
        level: "error",
        category: "sdk",
        action: `${message.type}.error`,
        summary: `Falha ao processar mensagem SDK: ${message.type}`,
        surfaceId: message.surfaceId,
        error: errorMessage(caughtError)
      });
      postWorkerError(message, caughtError);
    }
  }

  function postWorkerResult(message: RuntimeMessage, result: unknown) {
    workerRef.current?.postMessage({
      source: "client-wizard-host",
      runtimeId: runtimeIdRef.current,
      requestId: message.requestId,
      result
    });
  }

  function postWorkerError(message: RuntimeMessage, caughtError: unknown) {
    workerRef.current?.postMessage({
      source: "client-wizard-host",
      runtimeId: runtimeIdRef.current,
      requestId: message.requestId,
      error: errorMessage(caughtError)
    });
  }

  function emitSurfaceEvent(surfaceId: string, eventName: string, data: unknown) {
    audit({
      level: "debug",
      category: "event",
      action: eventName,
      summary: `Evento de UI enviado: ${eventName}`,
      surfaceId,
      input: data
    });
    workerRef.current?.postMessage({
      source: "client-wizard-host",
      runtimeId: runtimeIdRef.current,
      type: "ui-event",
      surfaceId,
      eventName,
      data
    });
  }

  async function handleMarkdownLink(surfaceId: string, href: string) {
    const decodedHref = safeDecode(href);
    if (isDynamicMarkdownHref(decodedHref)) {
      emitSurfaceEvent(surfaceId, "link", parseMarkdownTarget(decodedHref));
      return;
    }

    try {
      if (isHttpUrl(decodedHref)) {
        await openExternalUrl(decodedHref);
        audit({
          level: "info",
          category: "event",
          action: "link.external.open",
          summary: "Link externo aberto no navegador",
          surfaceId,
          input: { href: decodedHref }
        });
        return;
      }

      if (isLocalMarkdownHref(decodedHref)) {
        const reference = resolveReference(decodedHref, manifestSource ?? { kind: "remote-url", url: manifestUrl || window.location.href, display: manifestUrl || window.location.href }, "markdown");
        const markdown =
          reference.kind === "remote-url"
            ? await fetchRemoteText(reference.url, `Markdown ${reference.url}`)
            : await readLocalConsentDocument({ baseDir: reference.baseDir, relativePath: reference.relativePath });
        const resolvedUrl = reference.kind === "remote-url" ? reference.url : reference.display;
        setActiveSurface({
          id: crypto.randomUUID(),
          kind: "markdown",
          markdown,
          storage: activeSurfaceRef.current?.storage ?? {}
        });
        audit({
          level: "info",
          category: "event",
          action: "link.markdown.open",
          summary: "Markdown local aberto",
          surfaceId,
          input: { href: decodedHref, url: resolvedUrl }
        });
        return;
      }

      audit({
        level: "warning",
        category: "event",
        action: "link.unsupported",
        summary: "Link nao dinamico ignorado por formato nao suportado",
        surfaceId,
        input: { href: decodedHref }
      });
    } catch (caughtError) {
      audit({
        level: "error",
        category: "event",
        action: "link.open.error",
        summary: "Falha ao abrir link",
        surfaceId,
        input: { href: decodedHref },
        error: errorMessage(caughtError)
      });
      setError(errorMessage(caughtError));
    }
  }

  function patchSurfaceStorage(surfaceId: string, patch: Record<string, unknown>) {
    audit({
      level: "debug",
      category: "storage",
      action: "storage.patch",
      summary: "Storage da surface atualizado",
      surfaceId,
      input: patch
    });
    setActiveSurface((surface) =>
      surface?.id === surfaceId
        ? (() => {
            const nextSurface = { ...surface, storage: { ...surface.storage, ...patch } };
            activeSurfaceRef.current = nextSurface;
            return nextSurface;
          })()
        : surface
    );
  }

  function registerProgressTarget(operationId: string, surfaceId: string, payload: Record<string, unknown>) {
    if (!surfaceId) {
      return;
    }

    progressTargetsRef.current.set(operationId, {
      surfaceId,
      progressName: typeof payload.progressName === "string" ? payload.progressName : "progress",
      statusName: typeof payload.statusName === "string" ? payload.statusName : "status",
      progressStart: typeof payload.progressStart === "number" ? clamp(payload.progressStart, 0, 100) : 0,
      progressEnd: typeof payload.progressEnd === "number" ? clamp(payload.progressEnd, 0, 100) : 100
    });
  }

  function applyNativeProgress(event: NativeProgressEvent) {
    const target = progressTargetsRef.current.get(event.operationId);
    if (!target) {
      return;
    }

    const nativeProgress = clamp(Number(event.progress), 0, 100);
    const mappedProgress = target.progressStart + ((target.progressEnd - target.progressStart) * nativeProgress) / 100;
    patchSurfaceStorage(target.surfaceId, {
      [target.progressName]: clamp(mappedProgress, 0, 100),
      [target.statusName]: event.message,
      [`${event.phase}Bytes`]: event.downloadedBytes,
      [`${event.phase}TotalBytes`]: event.totalBytes
    });
  }

  function openDialog(dialog: DialogDefinition) {
    audit({
      level: "info",
      category: "dialog",
      action: "dialog.open",
      summary: dialog.title ? `Dialog aberto: ${dialog.title}` : "Dialog aberto",
      input: dialog
    });
    return new Promise<boolean>((resolve) => {
      setDialogRequest({ dialog, resolve });
    });
  }

  function closeDialog(value: boolean) {
    audit({
      level: "info",
      category: "dialog",
      action: value ? "dialog.confirm" : "dialog.cancel",
      summary: value ? "Dialog confirmado" : "Dialog cancelado",
      output: { confirmed: value }
    });
    dialogRequest?.resolve(value);
    setDialogRequest(undefined);
  }

  function acceptCurrentTerm(term: ConsentDocument) {
    setAcceptedTermIds((current) => ({ ...current, [term.id]: true }));
    audit({
      level: "info",
      category: "permission",
      action: "terms.accepted",
      summary: `Termo aceito: ${term.name}`,
      input: { documentId: term.id, url: term.url }
    });

    const termDocuments = consentDocuments.filter((document) => document.kind === "terms");
    if (currentTermIndex < termDocuments.length - 1) {
      setCurrentTermIndex((index) => index + 1);
      return;
    }

    setConsentStep(getNextConsentStepAfterTerms(consentDocuments));
  }

  function setDocumentAccepted(document: ConsentDocument, accepted: boolean) {
    setAcceptedDocumentIds((current) => ({ ...current, [document.id]: accepted }));
    audit({
      level: "info",
      category: "permission",
      action: accepted ? "document.accepted" : "document.revoked",
      summary: `${accepted ? "Documento aceito" : "Aceite do documento removido"}: ${document.name}`,
      input: { documentId: document.id, kind: document.kind, url: document.url }
    });
  }

  function openConsentDocument(document: ConsentDocument) {
    void openMarkdownDocumentWindow({
      title: document.name,
      kind: document.kind,
      url: document.url,
      markdown: document.markdown
    }).catch((caughtError) => {
      audit({
        level: "error",
        category: "native",
        action: "native.document.open.error",
        summary: `Falha ao abrir documento: ${document.name}`,
        error: errorMessage(caughtError),
        input: { documentId: document.id, kind: document.kind, url: document.url }
      });
    });
  }

  function goBackConsent(hasTerms: boolean, hasReviewDocuments: boolean) {
    if (consentStep === "terms" && currentTermIndex > 0) {
      setCurrentTermIndex((index) => Math.max(0, index - 1));
      return;
    }

    if (consentStep === "documents" && hasTerms) {
      setConsentStep("terms");
      setCurrentTermIndex(Math.max(0, consentDocuments.filter((document) => document.kind === "terms").length - 1));
      return;
    }

    if (consentStep === "permissions") {
      if (hasReviewDocuments) {
        setConsentStep("documents");
        return;
      }
      if (hasTerms) {
        setConsentStep("terms");
        setCurrentTermIndex(Math.max(0, consentDocuments.filter((document) => document.kind === "terms").length - 1));
      }
    }
  }

  function setPermissionAccepted(permission: ManifestPermission, accepted: boolean) {
    setAcceptedPermissions((current) => ({ ...current, [permission.id]: accepted }));
    audit({
      level: "info",
      category: "permission",
      action: accepted ? "permission.accepted" : "permission.revoked",
      summary: `${accepted ? "Permissao aceita" : "Permissao removida"}: ${permission.title}`,
      input: { permissionId: permission.id, title: permission.title }
    });
  }

  function moveWizard(direction: "prev" | "next") {
    const surfaceId = activeSurfaceRef.current?.id ?? "";
    navigateWizard(surfaceId, { direction });
  }

  function navigateWizard(surfaceId: string, navigation: { direction?: "prev" | "next"; target?: number | string }) {
    let result: { ok: boolean; index: number; step?: WizardStep } = { ok: false, index: -1 };

    setActiveSurface((surface) => {
      if (!surface || surface.kind !== "wizard" || surface.id !== surfaceId) {
        return surface;
      }

      const nextIndex =
        typeof navigation.target === "number"
          ? clamp(navigation.target, 0, surface.steps.length - 1)
          : typeof navigation.target === "string"
            ? surface.steps.findIndex((step) => step.id === navigation.target)
          : navigation.direction === "next"
            ? Math.min(surface.steps.length - 1, surface.currentStep + 1)
            : Math.max(0, surface.currentStep - 1);
      if (nextIndex < 0) {
        throw new Error(`Step nao encontrado: ${String(navigation.target)}.`);
      }
      const eventType = navigation.direction ?? "goTo";
      emitSurfaceEvent(surface.id, eventType, {
        index: nextIndex,
        step: surface.steps[nextIndex],
        storage: surface.storage
      });
      result = { ok: true, index: nextIndex, step: surface.steps[nextIndex] };
      return { ...surface, currentStep: nextIndex };
    });

    return result;
  }

  if (isAuditWindow) {
    return <AuditPanel />;
  }

  if (isAboutWindow) {
    return <AboutPage />;
  }

  if (isDocumentWindow) {
    return <MarkdownDocumentPage />;
  }

  const appMenu = (
    <AppCommandMenu
      open={isAppMenuOpen}
      onOpenChange={setIsAppMenuOpen}
      onAbout={() => {
        void openAboutWindow(createAboutData(manifest, manifestSource?.display ?? manifestUrl)).catch((caughtError) => {
          audit({
            level: "error",
            category: "native",
            action: "native.about.open.error",
            summary: "Falha ao abrir janela About",
            error: errorMessage(caughtError)
          });
        });
      }}
      onAudit={() => {
        void openAuditWindow().catch((caughtError) => {
          audit({
            level: "error",
            category: "native",
            action: "native.audit.open.error",
            summary: "Falha ao abrir janela de auditoria",
            error: errorMessage(caughtError)
          });
        });
      }}
      onSwitchManifest={() => resetToIdle(stopWorker)}
    />
  );

  if (appState === "running") {
    return (
      <main className="min-h-screen bg-background text-foreground" data-client-wizard-theme style={themeStyle}>
        <section className="flex h-screen min-h-0 flex-col gap-[var(--wizard-section-gap)] overflow-hidden p-[var(--wizard-page-padding)]">
          {activeSurface ? (
            <SurfaceRenderer
              surface={activeSurface}
              onLink={(href) => {
                void handleMarkdownLink(activeSurface.id, href);
              }}
              onNext={() => moveWizard("next")}
              onPrev={() => moveWizard("prev")}
              onStoragePatch={(patch) => patchSurfaceStorage(activeSurface.id, patch)}
            />
          ) : (
            <div className="flex min-h-[560px] items-center justify-center text-muted-foreground">
              Aguardando o script criar uma tela com clientWizard.useMarkdown() ou clientWizard.useWizard().
            </div>
          )}
        </section>
        <RuntimeDialog request={dialogRequest} onClose={closeDialog} />
        {appMenu}
      </main>
    );
  }

  if (appState === "loading-artifact" && manifest) {
    return (
      <main className="min-h-screen bg-background text-foreground" data-client-wizard-theme style={themeStyle}>
        <section className="flex min-h-screen flex-col p-[var(--wizard-page-padding)]">
          <div className="flex flex-1 items-center justify-center">
            <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
              <div className="size-12 animate-spin rounded-full border-4 border-muted border-t-primary" />
              <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-medium tracking-tight">Preparando wizard</h1>
                <p className="text-muted-foreground">
                  Baixando e preparando o JavaScript aprovado. Isso pode levar alguns instantes.
                </p>
              </div>
              <Progress className="w-full" value={65}>
                <ProgressLabel>Carregando artefato</ProgressLabel>
              </Progress>
            </div>
          </div>
        </section>
        {appMenu}
      </main>
    );
  }

  if (appState === "consent" && manifest) {
    const termDocuments = consentDocuments.filter((document) => document.kind === "terms");
    const reviewDocuments = consentDocuments.filter((document) => document.kind !== "terms");
    const currentTerm = termDocuments[currentTermIndex];
    const allReviewDocumentsAccepted = reviewDocuments.every((document) => acceptedDocumentIds[document.id]);
    const allPermissionsAccepted = manifest.permissions.every((permission) => acceptedPermissions[permission.id]);
    const stepPosition = getConsentStepPosition(consentStep, termDocuments.length > 0, reviewDocuments.length > 0);
    const stepCount = getConsentStepCount(termDocuments.length > 0, reviewDocuments.length > 0);
    const stepLabel = consentStep === "terms" && currentTerm
      ? `Termo ${currentTermIndex + 1} de ${termDocuments.length}`
      : `Step ${stepPosition} de ${stepCount}`;
    const title =
      consentStep === "terms"
        ? currentTerm?.name ?? "Termos de uso"
        : consentStep === "documents"
          ? "Licencas e privacidade"
          : "Permissoes solicitadas";
    const description =
      consentStep === "terms"
        ? "Leia o documento completo para aceitar e continuar."
        : consentStep === "documents"
          ? "Revise e marque todas as licencas e documentos de privacidade declarados pelo manifesto."
          : "Autorize cada permissao solicitada antes de baixar e iniciar o wizard.";

    return (
      <main className="min-h-screen bg-background text-foreground" data-client-wizard-theme style={themeStyle}>
        <section className="flex h-screen min-h-0 flex-col gap-[var(--wizard-section-gap)] overflow-hidden p-[var(--wizard-page-padding)]">
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="-mx-[var(--wizard-page-padding)] -mt-[var(--wizard-page-padding)] flex shrink-0 flex-col gap-4 border-b border-border bg-muted/40 px-[var(--wizard-page-padding)] py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm text-muted-foreground">{stepLabel}</span>
                  <h1 className="text-2xl font-medium">{title}</h1>
                </div>
                <Badge variant="secondary">consentimento</Badge>
              </div>
              <p className="text-muted-foreground">{description}</p>
            </div>

            <div className="min-h-0 flex-1 overflow-auto pb-6">
              {consentStep === "terms" && currentTerm ? (
                <FieldGroup>
                  <FieldSet>
                    <FieldLegend>{currentTerm.name}</FieldLegend>
                    <FieldDescription className="break-all">{currentTerm.url}</FieldDescription>
                    <div className="bg-muted/30 p-[var(--wizard-surface-padding)]">
                      <MarkdownContent markdown={currentTerm.markdown} storage={{}} onLink={() => undefined} />
                    </div>
                  </FieldSet>
                  {error ? <FieldError>{error}</FieldError> : null}
                </FieldGroup>
              ) : consentStep === "documents" ? (
                <FieldGroup>
                  <FieldSet>
                    <FieldLegend>Documentos obrigatorios</FieldLegend>
                    {reviewDocuments.map((document) => (
                      <Field key={document.id} orientation="horizontal">
                        <Checkbox
                          checked={Boolean(acceptedDocumentIds[document.id])}
                          id={`document-${document.id}`}
                          onCheckedChange={(checked) => setDocumentAccepted(document, checked === true)}
                        />
                        <div className="flex min-w-0 flex-col gap-1">
                          <FieldLabel htmlFor={`document-${document.id}`}>
                            {document.kind === "license" ? "Licenca" : "Privacidade"}: {document.name}
                          </FieldLabel>
                          <Button
                            className="h-auto justify-start p-0 text-left text-muted-foreground"
                            type="button"
                            variant="link"
                            onClick={() => openConsentDocument(document)}
                          >
                            {document.url}
                          </Button>
                        </div>
                      </Field>
                    ))}
                  </FieldSet>
                  {error ? <FieldError>{error}</FieldError> : null}
                </FieldGroup>
              ) : (
                <FieldGroup>
                  <FieldSet>
                    <FieldLegend>Permissoes solicitadas</FieldLegend>
                    {manifest.permissions.map((permission) => (
                      <Field key={permission.id} orientation="horizontal">
                        <Checkbox
                          checked={Boolean(acceptedPermissions[permission.id])}
                          id={`permission-${permission.id}`}
                          onCheckedChange={(checked) => setPermissionAccepted(permission, checked === true)}
                        />
                        <div className="flex flex-col gap-1">
                          <FieldLabel htmlFor={`permission-${permission.id}`}>{permission.title}</FieldLabel>
                          <FieldDescription>{permission.description ?? permission.id}</FieldDescription>
                        </div>
                      </Field>
                    ))}
                  </FieldSet>
                  {error ? <FieldError>{error}</FieldError> : null}
                </FieldGroup>
              )}
            </div>

            <div className="-mx-[var(--wizard-page-padding)] mb-[calc(var(--wizard-page-padding)*-1)] flex shrink-0 justify-end gap-2 border-t border-border bg-muted/30 px-[var(--wizard-page-padding)] py-3">
              {canGoBackConsent(consentStep, currentTermIndex, termDocuments.length > 0, reviewDocuments.length > 0) ? (
                <Button type="button" variant="secondary" onClick={() => goBackConsent(termDocuments.length > 0, reviewDocuments.length > 0)}>
                  Voltar
                </Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={() => resetToIdle(stopWorker)}>
                Cancelar
              </Button>
              {consentStep === "terms" && currentTerm ? (
                <Button type="button" onClick={() => acceptCurrentTerm(currentTerm)}>
                  Eu aceito os termos e condições de "{currentTerm.name}"
                </Button>
              ) : consentStep === "documents" ? (
                <Button disabled={!allReviewDocumentsAccepted} type="button" onClick={() => setConsentStep("permissions")}>
                  Continuar para permissoes
                </Button>
              ) : (
                <Button disabled={!allPermissionsAccepted} type="button" onClick={startWizard}>
                  Baixar e iniciar
                </Button>
              )}
            </div>
          </div>
        </section>
        {appMenu}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background p-[2em] text-foreground">
      <section className="flex min-h-[calc(100vh-4em)] flex-col justify-center gap-8">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-medium tracking-tight">Client Wizard</h1>
            <Badge variant="secondary">Manifest runtime</Badge>
          </div>
          <p className="max-w-2xl text-muted-foreground">
            Enter a manifest URL or select a local manifest.json file. The app shows terms and permissions before loading any script.
          </p>
        </div>
        <form className="max-w-2xl" onSubmit={submitManifest}>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="manifest-url">Manifest URL</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  autoFocus
                  aria-invalid={Boolean(error)}
                  id="manifest-url"
                  inputMode="url"
                  placeholder="https://example.com/client-wizard/manifest.json"
                  type="url"
                  value={manifestUrl}
                  onChange={(event) => setManifestUrl(event.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton disabled={appState === "loading-manifest"} type="submit" variant="default">
                    {appState === "loading-manifest" ? "Reading..." : "Load"}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <FieldError>{error}</FieldError>
            </Field>
            <div className="flex max-w-2xl flex-wrap gap-2">
              <Button
                disabled={appState === "loading-manifest"}
                type="button"
                variant="secondary"
                onClick={() => void runManifestLoad(loadSelectedManifestFile)}
              >
                Select manifest file
              </Button>
              <p className="text-sm text-muted-foreground">Local relative paths resolve from the selected manifest file folder.</p>
            </div>
          </FieldGroup>
        </form>
      </section>
      {appMenu}
    </main>
  );

  function resetToIdle(beforeReset?: () => void) {
    audit({
      level: "info",
      category: "runtime",
      action: "app.reset",
      summary: "Voltando para tela inicial"
    });
    void clearLocalManifestScope();
    beforeReset?.();
    setAppState("idle");
    setManifest(undefined);
    setConsentStep("terms");
    setCurrentTermIndex(0);
    setConsentDocuments([]);
    setAcceptedTermIds({});
    setAcceptedDocumentIds({});
    setAcceptedPermissions({});
    setActiveSurface(undefined);
    setError("");
    setManifestSource(undefined);
  }

  function AppCommandMenu({
    open,
    onOpenChange,
    onAbout,
    onAudit,
    onSwitchManifest
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAbout: () => void;
    onAudit: () => void;
    onSwitchManifest: () => void;
  }) {
    if (!open) {
      return null;
    }

    function runAction(action: () => void) {
      onOpenChange(false);
      action();
    }

    return (
      <div className="fixed inset-0 z-50" onClick={() => onOpenChange(false)}>
        <div
          className="absolute right-4 top-4 flex w-56 flex-col gap-1 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          role="menu"
          aria-label="Menu do Client Wizard"
          onClick={(event) => event.stopPropagation()}
        >
          <Button className="justify-start" type="button" variant="ghost" role="menuitem" onClick={() => runAction(onAbout)}>
            About
          </Button>
          <Button className="justify-start" type="button" variant="ghost" role="menuitem" onClick={() => runAction(onSwitchManifest)}>
            Trocar manifesto
          </Button>
          <Button className="justify-start" type="button" variant="ghost" role="menuitem" onClick={() => runAction(onAudit)}>
            Auditoria
          </Button>
        </div>
      </div>
    );
  }

  function audit(input: Omit<AuditEventInput, "sessionId" | "runtimeId" | "manifestUrl" | "manifestName">) {
    const sourceDisplay = manifestSource?.display ?? manifestUrl;
    void logAuditEvent({
      ...input,
      sessionId: sessionIdRef.current,
      runtimeId: runtimeIdRef.current || undefined,
      manifestUrl: sourceDisplay || undefined,
      manifestName: manifest?.name
    }).catch((caughtError) => {
      console.error("Falha ao gravar auditoria.", caughtError);
    });
  }
}

type AboutData = {
  appVersion?: string;
  manifest?: {
    name?: string;
    description?: string;
    version?: string;
    permissions?: Array<{ id: string; title: string; description?: string }>;
  };
  manifestUrl?: string;
};

function AboutPage() {
  const [aboutData, setAboutData] = useState<AboutData>({});

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const encodedAboutData = params.get("about");
      const serializedAboutData = encodedAboutData ? decodeURIComponent(encodedAboutData) : localStorage.getItem("clientWizardAbout") || "{}";
      setAboutData(JSON.parse(serializedAboutData) as AboutData);
    } catch {
      setAboutData({});
    }
  }, []);

  const permissions = aboutData.manifest?.permissions ?? [];

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <section className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Badge className="w-fit" variant="secondary">About</Badge>
          <h1 className="text-3xl font-medium tracking-tight">Client Wizard</h1>
          <p className="text-muted-foreground">Versao do app: {aboutData.appVersion ?? "0.1.0"}</p>
        </div>

        <div className="grid gap-4 rounded-xl border border-border bg-muted/40 p-5 text-sm">
          <div className="grid gap-1">
            <span className="text-muted-foreground">Manifesto</span>
            <span className="font-medium">{aboutData.manifest?.name ?? "Nenhum manifesto carregado"}</span>
          </div>
          {aboutData.manifest?.version ? (
            <div className="grid gap-1">
              <span className="text-muted-foreground">Versao do manifesto</span>
              <span>{aboutData.manifest.version}</span>
            </div>
          ) : null}
          {aboutData.manifest?.description ? (
            <div className="grid gap-1">
              <span className="text-muted-foreground">Descricao</span>
              <span>{aboutData.manifest.description}</span>
            </div>
          ) : null}
          <div className="grid gap-1">
            <span className="text-muted-foreground">Endereco</span>
            <span className="break-all">{aboutData.manifestUrl || "Nao carregado"}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-muted-foreground">Permissoes solicitadas</span>
            <span>{permissions.length}</span>
          </div>
        </div>

        {permissions.length ? (
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">Permissoes</h2>
            <div className="flex flex-col gap-2">
              {permissions.map((permission) => (
                <div key={permission.id} className="rounded-lg border border-border p-3">
                  <div className="font-medium">{permission.title}</div>
                  <div className="text-sm text-muted-foreground">{permission.description ?? permission.id}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

type MarkdownDocumentData = {
  title?: string;
  kind?: ConsentDocumentKind;
  url?: string;
  markdown?: string;
};

function MarkdownDocumentPage() {
  const [documentData, setDocumentData] = useState<MarkdownDocumentData>({});

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const encodedDocumentData = params.get("document");
      const serializedDocumentData = encodedDocumentData ? decodeURIComponent(encodedDocumentData) : "{}";
      setDocumentData(JSON.parse(serializedDocumentData) as MarkdownDocumentData);
    } catch {
      setDocumentData({});
    }
  }, []);

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <section className="mx-auto flex max-w-3xl flex-col gap-5">
        <div className="flex flex-col gap-2">
          {documentData.kind ? <Badge className="w-fit" variant="secondary">{documentKindLabel(documentData.kind)}</Badge> : null}
          <h1 className="text-3xl font-medium tracking-tight">{documentData.title ?? "Documento"}</h1>
          {documentData.url ? <p className="break-all text-sm text-muted-foreground">{documentData.url}</p> : null}
        </div>
        <div className="bg-muted/30 p-[var(--wizard-surface-padding)]">
          <MarkdownContent markdown={documentData.markdown ?? "Documento nao disponivel."} storage={{}} onLink={() => undefined} />
        </div>
      </section>
    </main>
  );
}

function createAboutData(manifest: ClientWizardManifest | undefined, manifestUrl: string): AboutData {
  return {
    appVersion: "0.1.0",
    manifest: manifest
      ? {
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          permissions: manifest.permissions.map((permission) => ({
            id: permission.id,
            title: permission.title,
            description: permission.description
          }))
        }
      : undefined,
    manifestUrl
  };
}

function AuditPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AuditCategory | "all">("all");
  const [level, setLevel] = useState<AuditLevel | "all">("all");
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    listAuditEvents({ query, category, level })
      .then((loadedEvents) => {
        if (!active) {
          return;
        }
        setEvents(loadedEvents);
        setSelectedEvent((currentEvent) =>
          currentEvent && loadedEvents.some((event) => event.id === currentEvent.id) ? currentEvent : loadedEvents[0]
        );
        setError("");
      })
      .catch((caughtError) => {
        if (active) {
          setError(errorMessage(caughtError));
        }
      });

    return () => {
      active = false;
    };
  }, [category, level, query]);

  function exportCsv() {
    const csv = eventsToCsv(events);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `client-wizard-audit-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="h-screen bg-background text-foreground">
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium">Auditoria</h1>
            <Badge variant="secondary">{events.length} eventos</Badge>
          </div>
          <div className="flex gap-2">
            <Button disabled={!events.length} size="sm" type="button" onClick={exportCsv}>
              Exportar CSV
            </Button>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 border-b p-4">
          <Input
            className="max-w-md"
            placeholder="Buscar eventos..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            value={category}
            onChange={(event) => setCategory(event.target.value as AuditCategory | "all")}
          >
            <option value="all">Todas categorias</option>
            {auditCategories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            value={level}
            onChange={(event) => setLevel(event.target.value as AuditLevel | "all")}
          >
            <option value="all">Todos niveis</option>
            {auditLevels.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>

        {error ? <div className="border-b p-4 text-sm text-destructive">{error}</div> : null}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,0.8fr)_1.2fr]">
          <div className="min-h-0 overflow-auto border-r">
            {events.map((event) => (
              <button
                className="flex w-full flex-col gap-1 border-b px-4 py-3 text-left hover:bg-muted"
                key={event.id}
                type="button"
                onClick={() => setSelectedEvent(event)}
              >
                <div className="flex items-center gap-2">
                  <Badge variant={event.level === "error" || event.level === "security" ? "destructive" : "outline"}>
                    {event.level}
                  </Badge>
                  <span className="truncate text-sm font-medium">{event.action}</span>
                </div>
                <span className="text-sm text-muted-foreground">{event.summary}</span>
                <span className="text-xs text-muted-foreground">{event.timestamp}</span>
              </button>
            ))}
            {!events.length ? (
              <div className="p-4 text-sm text-muted-foreground">Nenhum evento encontrado.</div>
            ) : null}
          </div>

          <div className="min-h-0 overflow-auto p-4">
            {selectedEvent ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h2 className="text-xl font-medium">{selectedEvent.summary}</h2>
                  <p className="text-sm text-muted-foreground">
                    {selectedEvent.category} / {selectedEvent.action} / {selectedEvent.timestamp}
                  </p>
                </div>
                <Separator />
                <AuditDetail title="Erro" value={selectedEvent.error} />
                <AuditDetail title="Input" value={selectedEvent.input} />
                <AuditDetail title="Output" value={selectedEvent.output} />
                <AuditDetail title="Evento completo" value={selectedEvent} />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Selecione um evento.</div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function AuditDetail({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === "") {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre className="overflow-auto bg-muted p-3 text-xs">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

const auditCategories: AuditCategory[] = [
  "manifest",
  "permission",
  "artifact",
  "runtime",
  "sdk",
  "surface",
  "wizard",
  "event",
  "storage",
  "dialog",
  "native",
  "render",
  "security"
];

const auditLevels: AuditLevel[] = ["debug", "info", "warning", "error", "security"];

function SurfaceRenderer({
  onLink,
  onNext,
  onPrev,
  onStoragePatch,
  surface
}: {
  onLink: (href: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onStoragePatch: (patch: Record<string, unknown>) => void;
  surface: ActiveSurface;
}) {
  const step = surface.kind === "wizard" ? surface.steps[surface.currentStep] : undefined;
  const markdown = surface.kind === "wizard" ? step?.markdown ?? "" : surface.markdown;
  const btnPrev =
    surface.kind === "wizard" ? step?.btnPrev ?? (surface.currentStep === 0 ? "disabled" : "enabled") : "none";
  const btnNext =
    surface.kind === "wizard"
      ? resolveNavigationButtonState(step?.btnNext, step?.btnNextWhen, surface.storage, surface.currentStep === surface.steps.length - 1)
      : "none";

  const hasNavigation = btnPrev !== "none" || btnNext !== "none";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
    <div className="-mx-[var(--wizard-page-padding)] -mt-[var(--wizard-page-padding)] flex shrink-0 flex-col gap-4 border-b border-border bg-muted/40 px-[var(--wizard-page-padding)] py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm text-muted-foreground">
              {surface.kind === "wizard" ? `Step ${surface.currentStep + 1} de ${surface.steps.length}` : "Markdown"}
            </span>
            <h1 className="text-2xl font-medium">{surface.kind === "wizard" ? step?.title ?? "Wizard" : "Tela"}</h1>
          </div>
          <Badge variant="secondary">{surface.kind}</Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        <MarkdownContent markdown={markdown} storage={surface.storage} onLink={onLink} onStoragePatch={onStoragePatch} />
      </div>

      {hasNavigation ? (
        <div className="-mx-[var(--wizard-page-padding)] mb-[calc(var(--wizard-page-padding)*-1)] flex shrink-0 justify-end gap-2 border-t border-border bg-muted/30 px-[var(--wizard-page-padding)] py-3">
          <NavigationButton state={btnPrev} onClick={onPrev}>
            Voltar
          </NavigationButton>
          <NavigationButton state={btnNext} onClick={onNext}>
            Avancar
          </NavigationButton>
        </div>
      ) : null}
    </div>
  );
}

function MarkdownContent({
  markdown,
  onLink,
  onStoragePatch,
  storage
}: {
  markdown: string;
  onLink: (href: string) => void;
  onStoragePatch?: (patch: Record<string, unknown>) => void;
  storage: Record<string, unknown>;
}) {
  const preparedMarkdown = interpolateStorage(markdown, storage).replace(
    /<ProgressiveBar\s+name=["']([^"']+)["']\s*\/?>/gi,
    (_match, name: string) => `<div data-progressive-bar="${escapeHtmlAttribute(name)}"></div>`
  ).replace(
    /<WizardCheckbox\s+name=["']([^"']+)["']\s+label=["']([^"']+)["']\s*\/?>/gi,
    (_match, name: string, label: string) =>
      `<div data-wizard-checkbox="${escapeHtmlAttribute(name)}" data-label="${escapeHtmlAttribute(label)}"></div>`
  );
  const components: Components = {
    a: ({ children, href }) => (
      <Button
        size="sm"
        type="button"
        variant="outline"
        onClick={(event) => {
          event.preventDefault();
          if (href) {
            onLink(href);
          }
        }}
      >
        {children}
      </Button>
    ),
    div: ({ children, ...props }) => {
      const progressName = String((props as Record<string, unknown>)["data-progressive-bar"] ?? "");
      if (progressName) {
        const value = clamp(Number(storage[progressName] ?? 0), 0, 100);
        return (
          <Progress className="my-4" value={value}>
            <ProgressLabel>{progressName}</ProgressLabel>
          </Progress>
        );
      }

      const checkboxName = String((props as Record<string, unknown>)["data-wizard-checkbox"] ?? "");
      if (checkboxName) {
        const label = String((props as Record<string, unknown>)["data-label"] ?? checkboxName);
        return (
          <label className="my-4 flex items-center gap-3 rounded-lg border border-border p-4">
            <Checkbox
              checked={Boolean(storage[checkboxName])}
              onCheckedChange={(value) => onStoragePatch?.({ [checkboxName]: Boolean(value) })}
            />
            <span className="text-sm leading-6">{label}</span>
          </label>
        );
      }

      return <div {...props}>{children}</div>;
    },
    h1: ({ children }) => <h1 className="mb-4 text-3xl font-medium tracking-tight">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-3 mt-6 text-2xl font-medium tracking-tight">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-2 mt-5 text-xl font-medium">{children}</h3>,
    img: ({ alt, src }) => <img alt={alt ?? ""} className="my-4 max-h-[420px] rounded-3xl object-contain" src={src ?? ""} />,
    li: ({ children }) => <li className="leading-7">{children}</li>,
    ol: ({ children }) => <ol className="my-4 flex list-decimal flex-col gap-2 pl-6">{children}</ol>,
    p: ({ children }) => <p className="my-3 leading-7 text-foreground">{children}</p>,
    ul: ({ children }) => <ul className="my-4 flex list-disc flex-col gap-2 pl-6">{children}</ul>,
    video: ({ src, ...props }) => <video className="my-4 max-h-[420px] w-full rounded-3xl" controls src={String(src ?? "")} {...props} />
  };

  return (
    <ReactMarkdown components={components} rehypePlugins={[rehypeRaw]} remarkPlugins={[remarkGfm]}>
      {preparedMarkdown}
    </ReactMarkdown>
  );
}

function NavigationButton({
  children,
  onClick,
  state
}: {
  children: string;
  onClick: () => void;
  state: NavigationButtonState;
}) {
  if (state === "none") {
    return null;
  }

  return (
    <Button disabled={state === "disabled"} type="button" variant="secondary" onClick={onClick}>
      {children}
    </Button>
  );
}

function RuntimeDialog({ onClose, request }: { onClose: (value: boolean) => void; request?: DialogRequest }) {
  return (
    <AlertDialog open={Boolean(request)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.dialog.title ?? "Confirmacao"}</AlertDialogTitle>
          <AlertDialogDescription>{request?.dialog.text ?? ""}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {request?.dialog.cancelText ? (
            <AlertDialogCancel onClick={() => onClose(false)}>{request.dialog.cancelText}</AlertDialogCancel>
          ) : null}
          <AlertDialogAction
            variant={request?.dialog.destructive ? "destructive" : "default"}
            onClick={() => onClose(true)}
          >
            {request?.dialog.okText ?? "OK"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function createWorkerSdk(runtimeId: string) {
  return `
const __clientWizardRuntimeId = ${JSON.stringify(runtimeId)};
const __clientWizardPending = new Map();
const __clientWizardCallbacks = new Map();
function __clientWizardId() {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
}
function __clientWizardSend(type, payload, surfaceId) {
  const requestId = __clientWizardId();
  globalThis.postMessage({ source: "client-wizard-script", runtimeId: __clientWizardRuntimeId, requestId, surfaceId, type, payload });
  return new Promise((resolve, reject) => __clientWizardPending.set(requestId, { resolve, reject }));
}
function __clientWizardFs(action, request) {
  return __clientWizardSend("native.fs", { request: { ...(request || {}), action } });
}
const __clientWizardFsApi = {
  exists(path) {
    return __clientWizardFs("exists", { path }).then((result) => Boolean(result.exists));
  },
  stat(path) {
    return __clientWizardFs("stat", { path });
  },
  listDir(path) {
    return __clientWizardFs("listDir", { path }).then((result) => result.entries || []);
  },
  readText(path) {
    return __clientWizardFs("readText", { path }).then((result) => result.content || "");
  },
  writeText(path, content) {
    return __clientWizardFs("writeText", { path, content });
  },
  appendText(path, content) {
    return __clientWizardFs("appendText", { path, content });
  },
  mkdir(path) {
    return __clientWizardFs("mkdir", { path });
  },
  remove(path, options = {}) {
    return __clientWizardFs("remove", { path, recursive: Boolean(options.recursive) });
  },
  copy(from, to) {
    return __clientWizardFs("copy", { from, to });
  },
  move(from, to) {
    return __clientWizardFs("move", { from, to });
  },
  openPath(path) {
    return __clientWizardFs("openPath", { path });
  }
};
function __clientWizardHandle(surfaceId) {
  return {
    id: surfaceId,
    fs: __clientWizardFsApi,
    events(callback) {
      __clientWizardCallbacks.set(surfaceId, callback);
      return () => __clientWizardCallbacks.delete(surfaceId);
    },
    setStorage(patch) {
      return __clientWizardSend("surface.setStorage", { patch }, surfaceId);
    },
    getStorage() {
      return __clientWizardSend("surface.getStorage", {}, surfaceId).then((result) => result.storage || {});
    },
    openDialog(dialog) {
      return __clientWizardSend("surface.openDialog", dialog, surfaceId).then((result) => Boolean(result.confirmed));
    },
    next() {
      return __clientWizardSend("surface.navigate", { direction: "next" }, surfaceId);
    },
    prev() {
      return __clientWizardSend("surface.navigate", { direction: "prev" }, surfaceId);
    },
    goTo(step) {
      return __clientWizardSend("surface.navigate", { target: step }, surfaceId);
    },
    download(request, options = {}) {
      return __clientWizardSend("native.download", { request, progressName: options.progressName || "progress", statusName: options.statusName || "status", progressStart: options.progressStart, progressEnd: options.progressEnd }, surfaceId);
    },
    extract(request, options = {}) {
      return __clientWizardSend("native.extract", { request, progressName: options.progressName || "progress", statusName: options.statusName || "status", progressStart: options.progressStart, progressEnd: options.progressEnd }, surfaceId);
    }
  };
}
globalThis.clientWizard = {
  fs: __clientWizardFsApi,
  useMarkdown(markdown, options = {}) {
    const surfaceId = options.id || __clientWizardId();
    __clientWizardSend("screen.create", { surfaceId, markdown, storage: options.storage || {} }, surfaceId);
    return __clientWizardHandle(surfaceId);
  },
  useWizard(wizard, options = {}) {
    const surfaceId = options.id || __clientWizardId();
    __clientWizardSend("wizard.create", { surfaceId, wizard, currentStep: options.currentStep || 0, storage: options.storage || {} }, surfaceId);
    return __clientWizardHandle(surfaceId);
  },
  invoke(command) {
    return __clientWizardSend("native.invoke", { command });
  },
  download(request, options = {}) {
    return __clientWizardSend("native.download", { request, progressName: options.progressName || "progress", statusName: options.statusName || "status", progressStart: options.progressStart, progressEnd: options.progressEnd, surfaceId: options.surfaceId }, options.surfaceId);
  },
  extract(request, options = {}) {
    return __clientWizardSend("native.extract", { request, progressName: options.progressName || "progress", statusName: options.statusName || "status", progressStart: options.progressStart, progressEnd: options.progressEnd, surfaceId: options.surfaceId }, options.surfaceId);
  }
};
globalThis.onmessage = (event) => {
  const message = event.data || {};
  if (message.source !== "client-wizard-host" || message.runtimeId !== __clientWizardRuntimeId) return;
  if (message.requestId && __clientWizardPending.has(message.requestId)) {
    const pending = __clientWizardPending.get(message.requestId);
    __clientWizardPending.delete(message.requestId);
    message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
    return;
  }
  if (message.type === "ui-event") {
    const callback = __clientWizardCallbacks.get(message.surfaceId);
    if (callback) callback({ type: message.eventName, data: message.data, surfaceId: message.surfaceId });
  }
};
`;
}

async function loadEntryScript(entry: ManifestEntry, source: ManifestSource) {
  if (entry.type === "script") {
    const reference = resolveReference(entry.url, source, "artefato");
    return reference.kind === "remote-url"
      ? fetchRemoteText(reference.url, "Artefato")
      : readLocalTextFile({ baseDir: reference.baseDir, relativePath: reference.relativePath });
  }

  const reference = resolveReference(entry.url, source, "artefato");
  const bytes =
    reference.kind === "remote-url"
      ? await fetchRemoteArrayBuffer(reference.url, "Artefato")
      : Uint8Array.from(await readLocalBinaryFile({ baseDir: reference.baseDir, relativePath: reference.relativePath })).buffer;
  const zip = await JSZip.loadAsync(bytes);
  const scriptPath = entry.script ?? "wizard.js";
  const scriptFile = zip.file(scriptPath);
  if (!scriptFile) {
    throw new Error(`ZIP nao contem ${scriptPath}.`);
  }

  return scriptFile.async("text");
}

async function loadConsentDocuments(manifest: ClientWizardManifest, source: ManifestSource): Promise<ConsentDocument[]> {
  const documentEntries: Array<{ kind: ConsentDocumentKind; url: string }> = [
    ...(manifest.terms ?? []).map((url) => ({ kind: "terms" as const, url })),
    ...(manifest.license ?? []).map((url) => ({ kind: "license" as const, url })),
    ...(manifest.privacy ?? []).map((url) => ({ kind: "privacy" as const, url }))
  ];

  return Promise.all(
    documentEntries.map(async (entry, index) => {
      const reference = resolveReference(entry.url, source, documentKindLabel(entry.kind));
      const markdown =
        reference.kind === "remote-url"
          ? await fetchRemoteText(reference.url, `Documento ${reference.url}`, { validateContentType: isAllowedDocumentContentType })
          : await readLocalConsentDocument({ baseDir: reference.baseDir, relativePath: reference.relativePath });
      const documentUrl = reference.kind === "remote-url" ? reference.url : reference.display;
      const name = resolveDocumentName(markdown, documentUrl);
      return {
        id: `${entry.kind}-${index}-${hashDocumentId(documentUrl)}`,
        kind: entry.kind,
        name,
        url: documentUrl,
        markdown
      };
    })
  );
}

function validateManifest(value: unknown, source: ManifestSource): ClientWizardManifest {
  const manifest = asRecord(value);
  const name = requireString(manifest.name, "manifest.name");
  const description = requireString(manifest.description, "manifest.description");
  const entry = validateEntry(manifest.entry, source);
  const permissions = validatePermissions(manifest.permissions);
  const theme = validateTheme(manifest.theme);

  return {
    name,
    description,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    terms: validateDocumentUrlList(manifest.terms, "manifest.terms", source),
    license: validateDocumentUrlList(manifest.license, "manifest.license", source),
    privacy: validateDocumentUrlList(manifest.privacy, "manifest.privacy", source),
    entry,
    theme,
    permissions
  };
}

function validateDocumentUrlList(value: unknown, field: string, source: ManifestSource): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} deve ser uma lista de URLs.`);
  }
  return value.map((item, index) => {
    const reference = requireString(item, `${field}[${index}]`);
    return source.kind === "remote-url" ? normalizeAllowedUrl(new URL(reference, source.url).toString(), field) : reference;
  });
}

function validateEntry(value: unknown, source: ManifestSource): ManifestEntry {
  const entry = asRecord(value);
  const type = requireString(entry.type, "manifest.entry.type");
  const entryUrl = requireString(entry.url, "manifest.entry.url");
  const url =
    source.kind === "remote-url"
      ? normalizeAllowedUrl(new URL(entryUrl, source.url).toString(), "artefato")
      : entryUrl;
  if (type === "script") {
    return { type, url };
  }
  if (type === "zip") {
    return {
      type,
      url,
      script: typeof entry.script === "string" && entry.script ? entry.script : undefined
    };
  }
  throw new Error("manifest.entry.type deve ser script ou zip.");
}

function validatePermissions(value: unknown): ManifestPermission[] {
  if (!Array.isArray(value)) {
    throw new Error("manifest.permissions deve ser uma lista.");
  }

  return value.map((item, index) => {
    const permission = asRecord(item);
    return {
      id: requireString(permission.id, `manifest.permissions[${index}].id`),
      title: requireString(permission.title, `manifest.permissions[${index}].title`),
      description: typeof permission.description === "string" ? permission.description : undefined,
      required: permission.required !== false
    };
  });
}

function validateTheme(value: unknown): ClientWizardTheme | undefined {
  if (value === undefined) {
    return undefined;
  }

  const theme = asRecord(value);
  const mode = optionalEnum(theme.mode, ["light", "dark", "system"], "manifest.theme.mode");
  const colors = validateThemeColors(theme.colors);
  const radius = validateLengthGroup(theme.radius, "manifest.theme.radius", {
    sm: [0, 32],
    md: [0, 32],
    lg: [0, 32],
    xl: [0, 32]
  });
  const font = validateThemeFont(theme.font);
  const spacing = validateLengthGroup(theme.spacing, "manifest.theme.spacing", {
    page: [0, 64],
    surfacePadding: [0, 64],
    sectionGap: [0, 64],
    fieldGap: [0, 32],
    controlHeight: [28, 64]
  });
  const layout = validateThemeLayout(theme.layout);

  return omitUndefined({
    mode,
    colors,
    radius,
    font,
    spacing,
    layout
  });
}

function validateThemeColors(value: unknown): ClientWizardTheme["colors"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const colors = asRecord(value);
  return omitUndefined({
    background: optionalColor(colors.background, "manifest.theme.colors.background"),
    foreground: optionalColor(colors.foreground, "manifest.theme.colors.foreground"),
    primary: optionalColor(colors.primary, "manifest.theme.colors.primary"),
    primaryForeground: optionalColor(colors.primaryForeground, "manifest.theme.colors.primaryForeground"),
    secondary: optionalColor(colors.secondary, "manifest.theme.colors.secondary"),
    secondaryForeground: optionalColor(colors.secondaryForeground, "manifest.theme.colors.secondaryForeground"),
    muted: optionalColor(colors.muted, "manifest.theme.colors.muted"),
    mutedForeground: optionalColor(colors.mutedForeground, "manifest.theme.colors.mutedForeground"),
    accent: optionalColor(colors.accent, "manifest.theme.colors.accent"),
    accentForeground: optionalColor(colors.accentForeground, "manifest.theme.colors.accentForeground"),
    border: optionalColor(colors.border, "manifest.theme.colors.border"),
    input: optionalColor(colors.input, "manifest.theme.colors.input"),
    ring: optionalColor(colors.ring, "manifest.theme.colors.ring"),
    destructive: optionalColor(colors.destructive, "manifest.theme.colors.destructive"),
    destructiveForeground: optionalColor(colors.destructiveForeground, "manifest.theme.colors.destructiveForeground")
  });
}

function validateThemeFont(value: unknown): ClientWizardTheme["font"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const font = asRecord(value);
  return omitUndefined({
    family: optionalFontFamily(font.family, "manifest.theme.font.family"),
    headingFamily: optionalFontFamily(font.headingFamily, "manifest.theme.font.headingFamily"),
    size: optionalLength(font.size, "manifest.theme.font.size", 12, 22),
    headingWeight: optionalNumberEnum(font.headingWeight, [400, 500, 600, 700], "manifest.theme.font.headingWeight"),
    bodyWeight: optionalNumberEnum(font.bodyWeight, [400, 500, 600], "manifest.theme.font.bodyWeight")
  });
}

function validateThemeLayout(value: unknown): ClientWizardTheme["layout"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const layout = asRecord(value);
  return omitUndefined({
    contentWidth: optionalEnum(layout.contentWidth, ["full", "readable", "compact"], "manifest.theme.layout.contentWidth"),
    header: optionalEnum(layout.header, ["none", "inline", "sticky"], "manifest.theme.layout.header"),
    alignment: optionalEnum(layout.alignment, ["start", "center"], "manifest.theme.layout.alignment")
  });
}

function validateLengthGroup<T extends string>(
  value: unknown,
  field: string,
  limits: Record<T, readonly [number, number]>
): Partial<Record<T, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const group = asRecord(value);
  const entries = (Object.keys(limits) as T[]).map((key) => {
    const [min, max] = limits[key];
    return [key, optionalLength(group[key], `${field}.${key}`, min, max)];
  });
  return omitUndefined(Object.fromEntries(entries) as Partial<Record<T, string>>);
}

function createThemeStyle(theme?: ClientWizardTheme): WizardThemeStyle {
  const style: WizardThemeStyle = {
    "--wizard-page-padding": theme?.spacing?.page ?? "2em",
    "--wizard-surface-padding": theme?.spacing?.surfacePadding ?? "2em",
    "--wizard-section-gap": theme?.spacing?.sectionGap ?? "24px",
    "--wizard-field-gap": theme?.spacing?.fieldGap ?? "12px",
    "--wizard-control-height": theme?.spacing?.controlHeight ?? "40px"
  };

  assignColor(style, "--background", theme?.colors?.background);
  assignColor(style, "--foreground", theme?.colors?.foreground);
  assignColor(style, "--primary", theme?.colors?.primary);
  assignColor(style, "--primary-foreground", theme?.colors?.primaryForeground);
  assignColor(style, "--secondary", theme?.colors?.secondary);
  assignColor(style, "--secondary-foreground", theme?.colors?.secondaryForeground);
  assignColor(style, "--muted", theme?.colors?.muted);
  assignColor(style, "--muted-foreground", theme?.colors?.mutedForeground);
  assignColor(style, "--accent", theme?.colors?.accent);
  assignColor(style, "--accent-foreground", theme?.colors?.accentForeground);
  assignColor(style, "--border", theme?.colors?.border);
  assignColor(style, "--input", theme?.colors?.input);
  assignColor(style, "--ring", theme?.colors?.ring);
  assignColor(style, "--destructive", theme?.colors?.destructive);
  assignColor(style, "--destructive-foreground", theme?.colors?.destructiveForeground);

  if (theme?.colors?.background) {
    style["--card"] = theme.colors.background;
    style["--popover"] = theme.colors.background;
  }
  if (theme?.colors?.foreground) {
    style["--card-foreground"] = theme.colors.foreground;
    style["--popover-foreground"] = theme.colors.foreground;
  }

  if (theme?.radius?.sm) {
    style["--wizard-radius-sm"] = theme.radius.sm;
  }
  if (theme?.radius?.md) {
    style["--wizard-radius-md"] = theme.radius.md;
    style["--radius"] = theme.radius.md;
  }
  if (theme?.radius?.lg) {
    style["--wizard-radius-lg"] = theme.radius.lg;
  }
  if (theme?.radius?.xl) {
    style["--wizard-radius-xl"] = theme.radius.xl;
  }

  if (theme?.font?.family) {
    style["--wizard-font-family"] = theme.font.family;
    style.fontFamily = "var(--wizard-font-family)";
  }
  if (theme?.font?.headingFamily) {
    style["--wizard-font-heading-family"] = theme.font.headingFamily;
  }
  if (theme?.font?.size) {
    style["--wizard-font-size"] = theme.font.size;
    style.fontSize = "var(--wizard-font-size)";
  }
  if (theme?.font?.headingWeight) {
    style["--wizard-heading-weight"] = String(theme.font.headingWeight);
  }
  if (theme?.font?.bodyWeight) {
    style["--wizard-body-weight"] = String(theme.font.bodyWeight);
    style.fontWeight = "var(--wizard-body-weight)";
  }

  return style;
}

function normalizeWizardSteps(value: unknown): WizardStep[] {
  const record = asRecord(value);
  const maybeSteps = Array.isArray(value) ? value : Array.isArray(record.steps) ? record.steps : [];
  return maybeSteps
    .map((step): WizardStep | undefined => {
      const item = asRecord(step);
      const markdown = typeof item.markdown === "string" ? item.markdown : "";
      if (!markdown) {
        return undefined;
      }
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        title: typeof item.title === "string" ? item.title : undefined,
        markdown,
        btnPrev: normalizeButtonState(item.btnPrev),
        btnNext: normalizeButtonState(item.btnNext),
        btnNextWhen: typeof item.btnNextWhen === "string" ? item.btnNextWhen : undefined
      };
    })
    .filter((step): step is WizardStep => Boolean(step));
}

function normalizeButtonState(value: unknown): NavigationButtonState {
  if (value === "enabled" || value === "disabled" || value === "none") {
    return value;
  }
  return "enabled";
}

function resolveNavigationButtonState(
  state: NavigationButtonState | undefined,
  enabledWhen: string | undefined,
  storage: Record<string, unknown>,
  isLastStep: boolean
): NavigationButtonState {
  const fallback = isLastStep ? "disabled" : "enabled";
  const normalizedState = state ?? fallback;
  if (normalizedState === "none") {
    return "none";
  }
  if (enabledWhen) {
    return readPath(storage, enabledWhen) ? "enabled" : "disabled";
  }
  return normalizedState;
}

function assertNativePermission(command: NativeCommand, permissionIds: Set<string>) {
  const commandType = asRecord(command).type;
  const candidates = [`native:${commandType}`, String(commandType)];
  if (!candidates.some((permission) => permissionIds.has(permission))) {
    throw new Error(`Permissao nao concedida para executar ${String(commandType)}.`);
  }
}

function assertPermissionForAction(action: string, permissionIds: Set<string>) {
  const candidates = [`native:${action}`, action];
  if (!candidates.some((permission) => permissionIds.has(permission))) {
    throw new Error(`Permissao nao concedida para executar ${action}.`);
  }
}

function assertFsPermission(action: string, permissionIds: Set<string>) {
  const readActions = new Set(["exists", "stat", "listDir", "readText"]);
  const writeActions = new Set(["writeText", "appendText", "mkdir", "copy", "move"]);
  const deleteActions = new Set(["remove"]);
  const openActions = new Set(["openPath"]);

  const requiredPermissions = [
    ...(readActions.has(action) || action === "copy" || action === "move" ? ["native:fs:read", "fs:read"] : []),
    ...(writeActions.has(action) ? ["native:fs:write", "fs:write"] : []),
    ...(deleteActions.has(action) ? ["native:fs:delete", "fs:delete"] : []),
    ...(openActions.has(action) ? ["native:fs:open", "fs:open"] : [])
  ];

  if (!requiredPermissions.length) {
    throw new Error(`Acao de fs nao suportada: ${action}.`);
  }

  const permissionGroups = [
    requiredPermissions.filter((permission) => permission.endsWith(":read")),
    requiredPermissions.filter((permission) => permission.endsWith(":write")),
    requiredPermissions.filter((permission) => permission.endsWith(":delete")),
    requiredPermissions.filter((permission) => permission.endsWith(":open"))
  ].filter((group) => group.length);

  const missing = permissionGroups.some((group) => !group.some((permission) => permissionIds.has(permission)));
  if (missing) {
    throw new Error(`Permissao nao concedida para fs.${action}.`);
  }
}

function normalizeFsExecuteRequest(value: Record<string, unknown>, action: string): FsExecuteRequest {
  return {
    action: normalizeFsAction(action),
    path: normalizeFsPath(value.path),
    from: normalizeFsPath(value.from),
    to: normalizeFsPath(value.to),
    content: typeof value.content === "string" ? value.content : undefined,
    recursive: typeof value.recursive === "boolean" ? value.recursive : undefined
  };
}

function normalizeFsAction(action: string): FsExecuteRequest["action"] {
  const allowedActions: FsExecuteRequest["action"][] = [
    "exists",
    "stat",
    "listDir",
    "readText",
    "writeText",
    "appendText",
    "mkdir",
    "remove",
    "copy",
    "move",
    "openPath"
  ];
  if (allowedActions.includes(action as FsExecuteRequest["action"])) {
    return action as FsExecuteRequest["action"];
  }
  throw new Error(`Acao de fs nao suportada: ${action}.`);
}

function normalizeFsPath(value: unknown): FsPath | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  const base = requireString(record.base, "fs.path.base");
  if (base !== "appData" && base !== "appCache" && base !== "temp" && base !== "downloads") {
    throw new Error(`Base de fs nao permitida: ${base}.`);
  }
  return {
    base,
    path: requireString(record.path, "fs.path.path")
  };
}

function normalizeArchiveFormat(value: unknown): "zip" | "tar.gz" | "tgz" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "zip" || value === "tar.gz" || value === "tgz") {
    return value;
  }
  throw new Error("Formato de extracao deve ser zip, tar.gz ou tgz.");
}

function normalizeAllowedUrl(value: string, label: string) {
  const url = new URL(value.trim());
  const isLocalhost = localhostNames.has(url.hostname);
  if (url.protocol !== "https:" && !(isLocalhost && (url.protocol === "http:" || url.protocol === "https:"))) {
    throw new Error(`A URL do ${label} deve usar HTTPS.`);
  }
  return url.toString();
}

function stripUtf8Bom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isAbsoluteRemoteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function sanitizeLocalManifestReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Referencia local nao pode ser vazia.");
  }

  const withoutSuffix = trimmed.split(/[?#]/, 1)[0] ?? "";
  const decodedPath = safeDecode(withoutSuffix);
  const normalized = decodedPath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//")) {
    throw new Error(`Referencia local nao permitida: ${value}`);
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Referencia local nao permitida: ${value}`);
  }

  const sanitized = segments.filter((segment) => segment !== ".").join("/");
  if (!sanitized) {
    throw new Error("Referencia local nao pode ser vazia.");
  }

  return sanitized;
}

function resolveReference(value: string, source: ManifestSource, label: string): ResolvedReference {
  if (source.kind === "remote-url") {
    return { kind: "remote-url", url: normalizeAllowedUrl(new URL(value, source.url).toString(), label) };
  }

  if (isAbsoluteRemoteUrl(value)) {
    return { kind: "remote-url", url: normalizeAllowedUrl(value, label) };
  }

  const relativePath = sanitizeLocalManifestReference(value);
  return {
    kind: "local-file",
    baseDir: source.baseDir,
    relativePath,
    display: relativePath
  };
}

async function fetchRemoteText(
  url: string,
  label: string,
  options?: { validateContentType?: (contentType: string) => boolean }
) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} retornou HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && options?.validateContentType && !options.validateContentType(contentType)) {
    throw new Error(`${label} retornou Content-Type nao suportado: ${contentType}.`);
  }
  return response.text();
}

async function fetchRemoteArrayBuffer(url: string, label: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} retornou HTTP ${response.status}.`);
  }
  return response.arrayBuffer();
}

function getInitialConsentStep(documents: ConsentDocument[]): ConsentStep {
  if (documents.some((document) => document.kind === "terms")) {
    return "terms";
  }
  if (documents.some((document) => document.kind !== "terms")) {
    return "documents";
  }
  return "permissions";
}

function getNextConsentStepAfterTerms(documents: ConsentDocument[]): ConsentStep {
  return documents.some((document) => document.kind !== "terms") ? "documents" : "permissions";
}

function getConsentStepCount(hasTerms: boolean, hasReviewDocuments: boolean) {
  return Number(hasTerms) + Number(hasReviewDocuments) + 1;
}

function getConsentStepPosition(step: ConsentStep, hasTerms: boolean, hasReviewDocuments: boolean) {
  if (step === "terms") {
    return 1;
  }
  if (step === "documents") {
    return hasTerms ? 2 : 1;
  }
  return getConsentStepCount(hasTerms, hasReviewDocuments);
}

function canGoBackConsent(step: ConsentStep, currentTermIndex: number, hasTerms: boolean, hasReviewDocuments: boolean) {
  if (step === "terms") {
    return currentTermIndex > 0;
  }
  if (step === "documents") {
    return hasTerms;
  }
  return hasTerms || hasReviewDocuments;
}

function documentKindLabel(kind: ConsentDocumentKind) {
  if (kind === "terms") {
    return "termo";
  }
  return kind === "license" ? "licenca" : "privacidade";
}

function isAllowedDocumentContentType(contentType: string) {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/markdown") ||
    normalized.includes("text/plain") ||
    normalized.includes("text/x-markdown") ||
    normalized.includes("application/octet-stream")
  );
}

function resolveDocumentName(markdown: string, documentUrl: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  const isRemote = /^https?:\/\//i.test(documentUrl);
  if (isRemote) {
    const url = new URL(documentUrl);
    const fileName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.[^.]+$/, "");
    return fileName || url.host;
  }

  const fileName = documentUrl.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return fileName.replace(/\.[^.]+$/, "") || documentUrl;
}

function hashDocumentId(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function interpolateStorage(markdown: string, storage: Record<string, unknown>) {
  return markdown.replace(/\{\{\s*storage\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) =>
    String(readPath(storage, path) ?? "")
  );
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (asRecord(current)[key]), value);
}

function parseMarkdownTarget(href: string): unknown {
  const decodedHref = safeDecode(href);
  if (!decodedHref.trim().startsWith("{")) {
    return { href: decodedHref };
  }

  try {
    return JSON.parse(decodedHref);
  } catch {
    return { href: decodedHref };
  }
}

function isDynamicMarkdownHref(href: string) {
  return href.trim().startsWith("{");
}

function isHttpUrl(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalMarkdownHref(href: string) {
  if (isHttpUrl(href)) {
    return false;
  }
  const pathname = href.split(/[?#]/, 1)[0] ?? "";
  return pathname.toLowerCase().endsWith(".md");
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  const record = asRecord(value);
  return record.source === "client-wizard-script" && typeof record.runtimeId === "string" && typeof record.type === "string";
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} e obrigatorio.`);
  }
  return value;
}

function optionalColor(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} deve ser uma cor valida.`);
  }

  const trimmedValue = value.trim();
  const isHex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmedValue);
  const isRgb = /^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmedValue);
  const isHsl = /^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmedValue);
  if (!isHex && !isRgb && !isHsl) {
    throw new Error(`${field} deve usar hex, rgb() ou hsl().`);
  }
  return trimmedValue;
}

function optionalLength(value: unknown, field: string, minPx: number, maxPx: number) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} deve ser um comprimento CSS valido.`);
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(px|rem|em)$/);
  if (!match) {
    throw new Error(`${field} deve usar unidade px, rem ou em.`);
  }

  const numericValue = Number(match[1]);
  const unit = match[2];
  const pxValue = unit === "px" ? numericValue : numericValue * 16;
  if (pxValue < minPx || pxValue > maxPx) {
    throw new Error(`${field} deve ficar entre ${minPx}px e ${maxPx}px.`);
  }

  return value.trim();
}

function optionalFontFamily(value: unknown, field: string) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} deve ser uma familia de fonte valida.`);
  }

  const trimmedValue = value.trim();
  if (/url\s*\(|@import|[{};]/i.test(trimmedValue)) {
    throw new Error(`${field} nao pode carregar fontes remotas ou conter CSS livre.`);
  }
  if (!/^[\w\s"',-]+$/.test(trimmedValue)) {
    throw new Error(`${field} contem caracteres nao permitidos.`);
  }
  return trimmedValue;
}

function optionalEnum<const T extends string>(value: unknown, allowedValues: readonly T[], field: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && allowedValues.includes(value as T)) {
    return value as T;
  }
  throw new Error(`${field} deve ser um de: ${allowedValues.join(", ")}.`);
}

function optionalNumberEnum<const T extends number>(value: unknown, allowedValues: readonly T[], field: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && allowedValues.includes(value as T)) {
    return value as T;
  }
  throw new Error(`${field} deve ser um de: ${allowedValues.join(", ")}.`);
}

function assignColor(style: WizardThemeStyle, name: `--${string}`, value: string | undefined) {
  if (value) {
    style[name] = value;
  }
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (!entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries) as Partial<T>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/["&<>]/g, (char) => {
    const entities: Record<string, string> = {
      '"': "&quot;",
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;"
    };
    return entities[char] ?? char;
  });
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
