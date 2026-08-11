import { invoke } from "@tauri-apps/api/core";
import type { ExecutorResult, NativeCommand } from "./types";

export type DownloadFileRequest = {
  url: string;
  fileName?: string;
  operationId: string;
};

export type DownloadFileResult = {
  path: string;
  fileName: string;
  bytes: number;
};

export type ExtractArchiveRequest = {
  archivePath: string;
  destinationName?: string;
  format?: "zip" | "tar.gz" | "tgz";
  stripComponents?: number;
  operationId: string;
};

export type ExtractArchiveResult = {
  destinationPath: string;
  files: number;
};

export type FsBase = "appData" | "appCache" | "temp" | "downloads";

export type FsPath = {
  base: FsBase;
  path: string;
};

export type FsExecuteRequest = {
  action:
    | "exists"
    | "stat"
    | "listDir"
    | "readText"
    | "writeText"
    | "appendText"
    | "mkdir"
    | "remove"
    | "copy"
    | "move"
    | "openPath";
  path?: FsPath;
  from?: FsPath;
  to?: FsPath;
  content?: string;
  recursive?: boolean;
};

export async function executeNative(command: NativeCommand): Promise<ExecutorResult> {
  return invoke<ExecutorResult>("execute_native", { command });
}

export async function downloadFile(request: DownloadFileRequest): Promise<DownloadFileResult> {
  return invoke<DownloadFileResult>("download_file", { request });
}

export async function extractArchive(request: ExtractArchiveRequest): Promise<ExtractArchiveResult> {
  return invoke<ExtractArchiveResult>("extract_archive", { request });
}

export async function fsExecute<T = unknown>(request: FsExecuteRequest): Promise<T> {
  return invoke<T>("fs_execute", { request });
}

export async function openExternalUrl(url: string): Promise<void> {
  return invoke<void>("open_external_url", { url });
}

export async function openAboutWindow(aboutData: unknown): Promise<void> {
  return invoke<void>("open_about", { aboutData });
}

export async function openAuditWindow(): Promise<void> {
  return invoke<void>("open_audit");
}

export async function openMarkdownDocumentWindow(documentData: unknown): Promise<void> {
  return invoke<void>("open_markdown_document", { documentData });
}

export async function showNativeMenu(): Promise<void> {
  return invoke<void>("show_native_menu");
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
