import { appendAuditEventToDisk } from "./native";

export type AuditLevel = "debug" | "info" | "warning" | "error" | "security";

export type AuditCategory =
  | "manifest"
  | "permission"
  | "artifact"
  | "network"
  | "runtime"
  | "sdk"
  | "surface"
  | "wizard"
  | "event"
  | "storage"
  | "dialog"
  | "native"
  | "render"
  | "security";

export type AuditEvent = {
  id: string;
  sessionId: string;
  runtimeId?: string;
  surfaceId?: string;
  manifestUrl?: string;
  manifestName?: string;
  timestamp: string;
  level: AuditLevel;
  category: AuditCategory;
  action: string;
  summary: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  searchableText: string;
};

export type AuditEventInput = Omit<AuditEvent, "id" | "timestamp" | "searchableText">;

export type AuditSearchQuery = {
  query?: string;
  category?: AuditCategory | "all";
  level?: AuditLevel | "all";
};

const databaseName = "clientWizardAudit";
const databaseVersion = 1;
const eventsStoreName = "events";

export async function logAuditEvent(input: AuditEventInput) {
  const event: AuditEvent = {
    ...input,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    input: sanitizeAuditPayload(input.input),
    output: sanitizeAuditPayload(input.output),
    searchableText: createSearchableText(input)
  };

  const indexedDbWrite = openAuditDatabase()
    .then((database) =>
      writeEvent(database, event).finally(() => {
        database.close();
      })
    );
  const diskWrite = appendAuditEventToDisk(event);

  await Promise.allSettled([indexedDbWrite, diskWrite]);
}

export async function listAuditEvents(query: AuditSearchQuery = {}) {
  const database = await openAuditDatabase();
  const events = await readAllEvents(database);
  database.close();

  const normalizedQuery = normalizeText(query.query ?? "");
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);

  return events
    .filter((event) => query.category === undefined || query.category === "all" || event.category === query.category)
    .filter((event) => query.level === undefined || query.level === "all" || event.level === query.level)
    .filter((event) => queryTerms.every((term) => normalizeText(event.searchableText).includes(term)))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function eventsToCsv(events: AuditEvent[]) {
  const headers = [
    "id",
    "sessionId",
    "runtimeId",
    "surfaceId",
    "manifestUrl",
    "manifestName",
    "timestamp",
    "level",
    "category",
    "action",
    "summary",
    "error",
    "input",
    "output"
  ];

  const rows = events.map((event) =>
    [
      event.id,
      event.sessionId,
      event.runtimeId ?? "",
      event.surfaceId ?? "",
      event.manifestUrl ?? "",
      event.manifestName ?? "",
      event.timestamp,
      event.level,
      event.category,
      event.action,
      event.summary,
      event.error ?? "",
      event.input === undefined ? "" : JSON.stringify(event.input),
      event.output === undefined ? "" : JSON.stringify(event.output)
    ].map(csvCell)
  );

  return [headers.map(csvCell), ...rows].map((row) => row.join(",")).join("\r\n");
}

function openAuditDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(eventsStoreName)) {
        const store = database.createObjectStore(eventsStoreName, { keyPath: "id" });
        store.createIndex("sessionId", "sessionId");
        store.createIndex("timestamp", "timestamp");
        store.createIndex("level", "level");
        store.createIndex("category", "category");
        store.createIndex("action", "action");
        store.createIndex("runtimeId", "runtimeId");
        store.createIndex("surfaceId", "surfaceId");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha ao abrir IndexedDB de auditoria."));
  });
}

function writeEvent(database: IDBDatabase, event: AuditEvent) {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(eventsStoreName, "readwrite");
    transaction.objectStore(eventsStoreName).add(event);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Falha ao gravar auditoria."));
  });
}

function readAllEvents(database: IDBDatabase) {
  return new Promise<AuditEvent[]>((resolve, reject) => {
    const transaction = database.transaction(eventsStoreName, "readonly");
    const request = transaction.objectStore(eventsStoreName).getAll();
    request.onsuccess = () => resolve(request.result as AuditEvent[]);
    request.onerror = () => reject(request.error ?? new Error("Falha ao ler auditoria."));
  });
}

export function sanitizeAuditPayload(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "string") {
    return redactSecrets(truncate(value));
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(sanitizeAuditPayload);
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (/password|token|secret|authorization|cookie|script/i.test(key)) {
        sanitized[key] = "[redacted]";
        continue;
      }
      sanitized[key] = sanitizeAuditPayload(entryValue);
    }
    return sanitized;
  }

  return value;
}

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
      safeStringify(sanitizeAuditPayload(input.input)),
      safeStringify(sanitizeAuditPayload(input.output))
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactSecrets(value: string) {
  return value
    .replace(/(token|secret|password|authorization)\s*[:=]\s*["']?[^"',\s]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted]");
}

function truncate(value: string) {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value;
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
