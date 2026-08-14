import { sanitizeAuditPayload, type AuditEventInput } from "./audit";

export type NetworkAuditSource =
  | "manifest"
  | "document"
  | "markdown"
  | "artifact"
  | "native-download"
  | "wizard";

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
const sensitiveHeaderPattern =
  /authorization|cookie|set-cookie|token|secret|password|credential|x-api-key|x-amz-security-token/i;

export async function auditedFetch(
  url: string,
  init: RequestInit | undefined,
  options: AuditedFetchOptions
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const method = normalizeMethod(init?.method);
  const startedAt = performance.now();

  auditNetworkRequest(options.audit, {
    requestId,
    method,
    url,
    source: options.source,
    headers: sanitizeHeaders(init?.headers)
  });

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

type ResponsePreview =
  | { bodyPreview?: unknown; bodyPreviewTruncated?: boolean; bodyPreviewError?: string }
  | { binarySummary: { bytes?: number; contentType: string; sha256?: string } };

async function createResponsePreview(response: Response, previewBinary: boolean): Promise<ResponsePreview> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!isTextLikeContentType(contentType)) {
    const bytes = parseContentLength(response.headers.get("content-length"));

    if (!previewBinary) {
      return {
        binarySummary: {
          bytes,
          contentType
        }
      };
    }

    try {
      const body = await response.clone().arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", body);

      return {
        binarySummary: {
          bytes: body.byteLength,
          contentType,
          sha256: bytesToHex(digest)
        }
      };
    } catch (caughtError) {
      return {
        binarySummary: {
          bytes,
          contentType
        }
      };
    }
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
    return {
      bodyPreviewError: caughtError instanceof Error ? caughtError.message : String(caughtError)
    };
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

function sanitizeHeaders(headers: HeadersInit | Headers | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  const output: Record<string, string> = {};
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

function bytesToHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
