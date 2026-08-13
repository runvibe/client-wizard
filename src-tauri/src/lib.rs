use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::System;
use tauri::{
    menu::{ContextMenu, Menu, MenuItem},
    App, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{timeout, Instant},
};
use url::Url;
use zip::ZipArchive;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapManifest {
    package_url: String,
    sha256: String,
    entry: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedPackage {
    package_dir: String,
    entry_path: String,
    entry_html: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalManifestFile {
    path: String,
    base_dir: String,
    display_name: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum NativeCommand {
    #[serde(rename = "systemInfo")]
    SystemInfo,
    #[serde(rename = "processList")]
    ProcessList,
    #[serde(rename = "runScript")]
    RunScript {
        shell: ScriptShell,
        script: String,
        args: Option<Vec<String>>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScriptShell {
    Powershell,
    Bash,
    Sh,
}

#[derive(Debug, Serialize)]
struct ExecutorResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadFileRequest {
    url: String,
    file_name: Option<String>,
    operation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadFileResult {
    path: String,
    file_name: String,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractArchiveRequest {
    archive_path: String,
    destination_name: Option<String>,
    format: Option<String>,
    strip_components: Option<usize>,
    operation_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractArchiveResult {
    destination_path: String,
    files: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeProgressEvent {
    operation_id: String,
    phase: String,
    progress: u8,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LaunchManifestPayload {
    manifest_url: String,
    source: String,
}

#[derive(Default)]
struct LaunchManifestState {
    current: Mutex<LaunchManifestStateInner>,
}

#[derive(Default)]
struct SelectedLocalManifestState {
    current: Mutex<SelectedLocalManifestStateInner>,
}

#[derive(Default)]
struct SelectedLocalManifestStateInner {
    pending_manifest_path: Option<PathBuf>,
    pending_base_dir: Option<PathBuf>,
    active_base_dir: Option<PathBuf>,
}

#[derive(Default)]
struct LaunchManifestStateInner {
    payload: Option<LaunchManifestPayload>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FsPathRequest {
    base: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FsExecuteRequest {
    action: String,
    path: Option<FsPathRequest>,
    from: Option<FsPathRequest>,
    to: Option<FsPathRequest>,
    content: Option<String>,
    recursive: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    path: String,
    is_file: bool,
    is_directory: bool,
    size: u64,
    modified_at: Option<u64>,
    created_at: Option<u64>,
}

#[tauri::command]
fn get_launch_manifest_url(
    state: State<'_, LaunchManifestState>,
) -> Result<Option<LaunchManifestPayload>, String> {
    let current = state
        .current
        .lock()
        .map_err(|_| "Estado de inicializacao indisponivel.".to_string())?;
    if let Some(error) = &current.error {
        return Err(error.clone());
    }
    Ok(current.payload.clone())
}

#[tauri::command]
async fn download_package(
    app: AppHandle,
    manifest: BootstrapManifest,
) -> Result<DownloadedPackage, String> {
    let url = validate_https_url(&manifest.package_url)?;
    let expected_hash = normalize_sha256(&manifest.sha256)?;
    let response = reqwest::get(url)
        .await
        .map_err(|error| format!("Falha ao baixar pacote: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Pacote retornou status HTTP {}.",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Falha ao ler pacote: {error}"))?;
    let actual_hash = hex::encode(Sha256::digest(&bytes));

    if actual_hash != expected_hash {
        return Err(format!(
            "Checksum invalido. Esperado {expected_hash}, recebido {actual_hash}."
        ));
    }

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Falha ao localizar cache da aplicacao: {error}"))?
        .join("packages")
        .join(&actual_hash[..16]);

    if cache_root.exists() {
        fs::remove_dir_all(&cache_root)
            .map_err(|error| format!("Falha ao limpar pacote anterior: {error}"))?;
    }
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Falha ao criar diretorio do pacote: {error}"))?;

    extract_zip(&bytes, &cache_root)?;

    let entry = manifest.entry.unwrap_or_else(|| "index.html".to_string());
    let entry_path = safe_join(&cache_root, &entry)?;
    let entry_html = fs::read_to_string(&entry_path)
        .map_err(|error| format!("Falha ao abrir entrada {entry}: {error}"))?;

    Ok(DownloadedPackage {
        package_dir: cache_root.display().to_string(),
        entry_path: entry_path.display().to_string(),
        entry_html,
    })
}

#[tauri::command]
async fn select_manifest_file(
    app: AppHandle,
    selected_manifest: State<'_, SelectedLocalManifestState>,
) -> Result<Option<LocalManifestFile>, String> {
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
    let content = read_selected_manifest_text_file(&path)?;
    let base_dir = path
        .parent()
        .ok_or_else(|| "Manifesto local nao possui diretorio pai.".to_string())?
        .to_path_buf();
    let canonical_base_dir = canonicalize_local_manifest_base_dir(&base_dir)?;
    let canonical_manifest_path = path
        .canonicalize()
        .map_err(|error| format!("Falha ao resolver manifesto local selecionado: {error}"))?;
    if let Ok(mut current) = selected_manifest.current.lock() {
        clear_selected_local_manifest_scope(&mut current);
        current.pending_manifest_path = Some(canonical_manifest_path);
        current.pending_base_dir = Some(canonical_base_dir);
    }
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("manifest.json")
        .to_string();

    Ok(Some(LocalManifestFile {
        path: path.display().to_string(),
        base_dir: base_dir.display().to_string(),
        display_name,
        content,
    }))
}

#[tauri::command]
async fn execute_native(command: NativeCommand) -> Result<ExecutorResult, String> {
    match command {
        NativeCommand::SystemInfo => Ok(system_info()),
        NativeCommand::ProcessList => Ok(process_list()),
        NativeCommand::RunScript {
            shell,
            script,
            args,
        } => run_script(shell, script, args.unwrap_or_default()).await,
    }
}

#[tauri::command]
async fn read_local_text_file(
    selected_manifest: State<'_, SelectedLocalManifestState>,
    base_dir: String,
    relative_path: String,
) -> Result<String, String> {
    let selected_base_dir = selected_local_manifest_base_dir(&selected_manifest)?;
    read_local_text_file_blocking(&selected_base_dir, base_dir, relative_path)
}

#[tauri::command]
async fn read_local_binary_file(
    selected_manifest: State<'_, SelectedLocalManifestState>,
    base_dir: String,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    let selected_base_dir = selected_local_manifest_base_dir(&selected_manifest)?;
    read_local_binary_file_blocking(&selected_base_dir, base_dir, relative_path)
}

#[tauri::command]
async fn read_local_consent_document(
    selected_manifest: State<'_, SelectedLocalManifestState>,
    base_dir: String,
    relative_path: String,
) -> Result<String, String> {
    let pending_base_dir = pending_local_manifest_base_dir(&selected_manifest)?;
    read_local_consent_document_blocking(&pending_base_dir, base_dir, relative_path)
}

#[tauri::command]
async fn confirm_local_manifest_scope(
    selected_manifest: State<'_, SelectedLocalManifestState>,
    manifest_path: String,
) -> Result<(), String> {
    let mut current = selected_manifest
        .current
        .lock()
        .map_err(|_| "Falha ao acessar o manifesto local selecionado.".to_string())?;
    activate_selected_local_manifest_scope(&mut current, Path::new(&manifest_path))
}

#[tauri::command]
async fn clear_local_manifest_scope(
    selected_manifest: State<'_, SelectedLocalManifestState>,
) -> Result<(), String> {
    let mut current = selected_manifest
        .current
        .lock()
        .map_err(|_| "Falha ao acessar o manifesto local selecionado.".to_string())?;
    clear_selected_local_manifest_scope(&mut current);
    Ok(())
}

#[tauri::command]
async fn download_file(
    app: AppHandle,
    request: DownloadFileRequest,
) -> Result<DownloadFileResult, String> {
    let url = validate_https_url(&request.url)?;
    let file_name = request
        .file_name
        .clone()
        .or_else(|| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(ToString::to_string)
        })
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "Nome do arquivo de download nao identificado.".to_string())?;
    let safe_file_name = sanitize_file_name(&file_name)?;
    let download_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Falha ao localizar cache da aplicacao: {error}"))?
        .join("downloads");
    fs::create_dir_all(&download_dir)
        .map_err(|error| format!("Falha ao criar diretorio de downloads: {error}"))?;
    let file_path = download_dir.join(&safe_file_name);

    emit_native_progress(
        &app,
        "client-wizard://download-progress",
        NativeProgressEvent {
            operation_id: request.operation_id.clone(),
            phase: "download".to_string(),
            progress: 0,
            downloaded_bytes: Some(0),
            total_bytes: None,
            message: "Iniciando download".to_string(),
        },
    );

    let mut response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Falha ao baixar arquivo: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Download retornou HTTP {}.", response.status()));
    }

    let total_bytes = response.content_length();
    let mut downloaded_bytes = 0_u64;
    let mut output = tokio::fs::File::create(&file_path)
        .await
        .map_err(|error| format!("Falha ao criar arquivo de download: {error}"))?;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Falha ao ler chunk de download: {error}"))?
    {
        output
            .write_all(&chunk)
            .await
            .map_err(|error| format!("Falha ao gravar chunk de download: {error}"))?;
        downloaded_bytes += chunk.len() as u64;
        let progress = total_bytes
            .map(|total| ((downloaded_bytes as f64 / total as f64) * 100.0).round() as u8)
            .unwrap_or(0)
            .min(100);
        emit_native_progress(
            &app,
            "client-wizard://download-progress",
            NativeProgressEvent {
                operation_id: request.operation_id.clone(),
                phase: "download".to_string(),
                progress,
                downloaded_bytes: Some(downloaded_bytes),
                total_bytes,
                message: "Baixando arquivo".to_string(),
            },
        );
    }

    output
        .flush()
        .await
        .map_err(|error| format!("Falha ao finalizar arquivo de download: {error}"))?;

    emit_native_progress(
        &app,
        "client-wizard://download-progress",
        NativeProgressEvent {
            operation_id: request.operation_id,
            phase: "download".to_string(),
            progress: 100,
            downloaded_bytes: Some(downloaded_bytes),
            total_bytes,
            message: "Download concluido".to_string(),
        },
    );

    Ok(DownloadFileResult {
        path: file_path.display().to_string(),
        file_name: safe_file_name,
        bytes: downloaded_bytes,
    })
}

#[tauri::command]
async fn extract_archive(
    app: AppHandle,
    request: ExtractArchiveRequest,
) -> Result<ExtractArchiveResult, String> {
    let archive_path = PathBuf::from(&request.archive_path);
    if !archive_path.is_file() {
        return Err("Arquivo para extracao nao encontrado.".to_string());
    }

    let destination_name = request
        .destination_name
        .as_deref()
        .unwrap_or("package")
        .to_string();
    let safe_destination_name = sanitize_file_name(&destination_name)?;
    let destination = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Falha ao localizar dados da aplicacao: {error}"))?
        .join("extracted")
        .join(safe_destination_name);

    if destination.exists() {
        fs::remove_dir_all(&destination)
            .map_err(|error| format!("Falha ao limpar destino anterior: {error}"))?;
    }
    fs::create_dir_all(&destination)
        .map_err(|error| format!("Falha ao criar destino de extracao: {error}"))?;

    emit_native_progress(
        &app,
        "client-wizard://extract-progress",
        NativeProgressEvent {
            operation_id: request.operation_id.clone(),
            phase: "extract".to_string(),
            progress: 0,
            downloaded_bytes: None,
            total_bytes: None,
            message: "Iniciando extracao".to_string(),
        },
    );

    let format = request
        .format
        .clone()
        .unwrap_or_else(|| infer_archive_format(&archive_path));
    let files = match format.as_str() {
        "zip" => extract_zip_file(&app, &request.operation_id, &archive_path, &destination)?,
        "tar.gz" | "tgz" => extract_tar_gz_file(
            &app,
            &request.operation_id,
            &archive_path,
            &destination,
            request.strip_components.unwrap_or(0),
        )?,
        _ => return Err(format!("Formato de extracao nao suportado: {format}.")),
    };

    emit_native_progress(
        &app,
        "client-wizard://extract-progress",
        NativeProgressEvent {
            operation_id: request.operation_id,
            phase: "extract".to_string(),
            progress: 100,
            downloaded_bytes: None,
            total_bytes: None,
            message: "Extracao concluida".to_string(),
        },
    );

    Ok(ExtractArchiveResult {
        destination_path: destination.display().to_string(),
        files,
    })
}

#[tauri::command]
async fn fs_execute(
    app: AppHandle,
    request: FsExecuteRequest,
) -> Result<serde_json::Value, String> {
    match request.action.as_str() {
        "exists" => {
            let path = resolve_fs_path(&app, request.path.as_ref().ok_or("path e obrigatorio.")?)?;
            Ok(serde_json::json!({ "exists": path.exists() }))
        }
        "stat" => {
            let path = resolve_fs_path(&app, request.path.as_ref().ok_or("path e obrigatorio.")?)?;
            Ok(serde_json::to_value(fs_stat(&path)?).map_err(|error| error.to_string())?)
        }
        "listDir" => {
            let path = resolve_fs_path(&app, request.path.as_ref().ok_or("path e obrigatorio.")?)?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(&path)
                .map_err(|error| format!("Falha ao listar diretorio: {error}"))?
                .take(500)
            {
                let entry =
                    entry.map_err(|error| format!("Falha ao ler item do diretorio: {error}"))?;
                entries.push(fs_stat_with_name(&entry.path())?);
            }
            Ok(serde_json::json!({ "entries": entries }))
        }
        "readText" => {
            let path = resolve_fs_path(&app, request.path.as_ref().ok_or("path e obrigatorio.")?)?;
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Falha ao ler metadados do arquivo: {error}"))?;
            if !metadata.is_file() {
                return Err("Somente arquivos podem ser lidos como texto.".to_string());
            }
            if metadata.len() > 2 * 1024 * 1024 {
                return Err("Arquivo excede limite de leitura de 2 MB.".to_string());
            }
            let mut content = String::new();
            File::open(&path)
                .map_err(|error| format!("Falha ao abrir arquivo: {error}"))?
                .read_to_string(&mut content)
                .map_err(|error| format!("Falha ao ler arquivo como UTF-8: {error}"))?;
            Ok(serde_json::json!({ "content": content }))
        }
        "writeText" => {
            let path_request = request.path.as_ref().ok_or("path e obrigatorio.")?;
            ensure_relative_not_empty(path_request)?;
            let path = resolve_fs_path(&app, path_request)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Falha ao criar diretorio pai: {error}"))?;
            }
            fs::write(&path, request.content.unwrap_or_default())
                .map_err(|error| format!("Falha ao escrever arquivo: {error}"))?;
            Ok(serde_json::json!({ "ok": true, "path": path.display().to_string() }))
        }
        "appendText" => {
            let path_request = request.path.as_ref().ok_or("path e obrigatorio.")?;
            ensure_relative_not_empty(path_request)?;
            let path = resolve_fs_path(&app, path_request)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Falha ao criar diretorio pai: {error}"))?;
            }
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|error| format!("Falha ao abrir arquivo para append: {error}"))?;
            file.write_all(request.content.unwrap_or_default().as_bytes())
                .map_err(|error| format!("Falha ao acrescentar texto: {error}"))?;
            Ok(serde_json::json!({ "ok": true, "path": path.display().to_string() }))
        }
        "mkdir" => {
            let path = resolve_fs_path(&app, request.path.as_ref().ok_or("path e obrigatorio.")?)?;
            fs::create_dir_all(&path)
                .map_err(|error| format!("Falha ao criar diretorio: {error}"))?;
            Ok(serde_json::json!({ "ok": true, "path": path.display().to_string() }))
        }
        "remove" => {
            let path_request = request.path.as_ref().ok_or("path e obrigatorio.")?;
            ensure_relative_not_empty(path_request)?;
            let path = resolve_fs_path(&app, path_request)?;
            if path.is_dir() {
                if request.recursive.unwrap_or(false) {
                    fs::remove_dir_all(&path)
                        .map_err(|error| format!("Falha ao remover diretorio: {error}"))?;
                } else {
                    fs::remove_dir(&path)
                        .map_err(|error| format!("Falha ao remover diretorio vazio: {error}"))?;
                }
            } else {
                fs::remove_file(&path)
                    .map_err(|error| format!("Falha ao remover arquivo: {error}"))?;
            }
            Ok(serde_json::json!({ "ok": true }))
        }
        "copy" => {
            let from_request = request.from.as_ref().ok_or("from e obrigatorio.")?;
            let to_request = request.to.as_ref().ok_or("to e obrigatorio.")?;
            ensure_relative_not_empty(from_request)?;
            ensure_relative_not_empty(to_request)?;
            let from = resolve_fs_path(&app, from_request)?;
            let to = resolve_fs_path(&app, to_request)?;
            if from.is_dir() {
                copy_directory(&from, &to)?;
            } else {
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("Falha ao criar destino da copia: {error}"))?;
                }
                fs::copy(&from, &to)
                    .map_err(|error| format!("Falha ao copiar arquivo: {error}"))?;
            }
            Ok(serde_json::json!({ "ok": true, "path": to.display().to_string() }))
        }
        "move" => {
            let from_request = request.from.as_ref().ok_or("from e obrigatorio.")?;
            let to_request = request.to.as_ref().ok_or("to e obrigatorio.")?;
            ensure_relative_not_empty(from_request)?;
            ensure_relative_not_empty(to_request)?;
            let from = resolve_fs_path(&app, from_request)?;
            let to = resolve_fs_path(&app, to_request)?;
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Falha ao criar destino do move: {error}"))?;
            }
            fs::rename(&from, &to)
                .map_err(|error| format!("Falha ao mover arquivo/diretorio: {error}"))?;
            Ok(serde_json::json!({ "ok": true, "path": to.display().to_string() }))
        }
        "openPath" => {
            let path = resolve_fs_path(&app, request.path.as_ref().ok_or("path e obrigatorio.")?)?;
            if !path.exists() {
                return Err("Caminho para abrir nao existe.".to_string());
            }
            app.opener()
                .open_path(path.display().to_string(), None::<&str>)
                .map_err(|error| format!("Falha ao abrir caminho: {error}"))?;
            Ok(serde_json::json!({ "ok": true }))
        }
        _ => Err(format!("Acao de fs nao suportada: {}.", request.action)),
    }
}

#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| format!("URL invalida: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Somente URLs http/https podem ser abertas externamente.".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Falha ao abrir URL externa: {error}"))
}

#[tauri::command]
async fn show_native_menu(app: AppHandle, window: Window) -> Result<(), String> {
    let about_item = MenuItem::with_id(&app, "show-about", "About", true, None::<&str>)
        .map_err(|error| format!("Falha ao criar item About: {error}"))?;
    let switch_manifest_item = MenuItem::with_id(
        &app,
        "switch-manifest",
        "Trocar manifesto",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("Falha ao criar item Trocar manifesto: {error}"))?;
    let audit_item = MenuItem::with_id(&app, "open-audit", "Auditoria", true, None::<&str>)
        .map_err(|error| format!("Falha ao criar item de menu: {error}"))?;
    let menu = Menu::with_items(&app, &[&about_item, &switch_manifest_item, &audit_item])
        .map_err(|error| format!("Falha ao criar menu nativo: {error}"))?;
    menu.popup(window)
        .map_err(|error| format!("Falha ao abrir menu nativo: {error}"))
}

#[tauri::command]
async fn open_about(app: AppHandle, about_data: serde_json::Value) -> Result<(), String> {
    open_about_window(&app, about_data);
    Ok(())
}

#[tauri::command]
async fn open_audit(app: AppHandle) -> Result<(), String> {
    open_audit_window(&app);
    Ok(())
}

#[tauri::command]
async fn open_markdown_document(
    app: AppHandle,
    document_data: serde_json::Value,
) -> Result<(), String> {
    open_markdown_document_window(&app, document_data);
    Ok(())
}

fn system_info() -> ExecutorResult {
    let mut system = System::new_all();
    system.refresh_all();

    let payload = serde_json::json!({
        "os": System::name(),
        "osVersion": System::os_version(),
        "kernelVersion": System::kernel_version(),
        "hostName": System::host_name(),
        "cpuArchitecture": std::env::consts::ARCH,
        "totalMemory": system.total_memory(),
        "usedMemory": system.used_memory(),
        "cpuCount": system.cpus().len()
    });

    ExecutorResult {
        ok: true,
        code: Some(0),
        stdout: serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()),
        stderr: String::new(),
    }
}

fn process_list() -> ExecutorResult {
    let mut system = System::new_all();
    system.refresh_all();
    let mut processes = system
        .processes()
        .values()
        .map(|process| {
            serde_json::json!({
                "pid": process.pid().as_u32(),
                "name": process.name().to_string_lossy(),
                "status": format!("{:?}", process.status())
            })
        })
        .collect::<Vec<_>>();

    processes.truncate(80);

    ExecutorResult {
        ok: true,
        code: Some(0),
        stdout: serde_json::to_string_pretty(&processes).unwrap_or_else(|_| "[]".to_string()),
        stderr: String::new(),
    }
}

async fn run_script(
    shell: ScriptShell,
    script: String,
    args: Vec<String>,
) -> Result<ExecutorResult, String> {
    if script.trim().is_empty() {
        return Err("Script vazio nao pode ser executado.".to_string());
    }

    if script.len() > 16_384 {
        return Err("Script excede o limite de 16 KB.".to_string());
    }

    let (program, shell_args): (&str, Vec<String>) = match shell {
        ScriptShell::Powershell => {
            if !cfg!(windows) {
                return Err("PowerShell esta habilitado apenas no Windows neste MVP.".to_string());
            }
            (
                "powershell",
                vec![
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-Command".to_string(),
                    script,
                ],
            )
        }
        ScriptShell::Bash => ("bash", vec!["-lc".to_string(), script]),
        ScriptShell::Sh => ("sh", vec!["-c".to_string(), script]),
    };

    let started = Instant::now();
    let mut child = Command::new(program)
        .args(shell_args)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Falha ao iniciar executor {program}: {error}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Falha ao capturar stdout.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Falha ao capturar stderr.".to_string())?;

    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        stdout.read_to_end(&mut buffer).await.map(|_| buffer)
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        stderr.read_to_end(&mut buffer).await.map(|_| buffer)
    });

    let status = match timeout(Duration::from_secs(30), child.wait()).await {
        Ok(result) => result.map_err(|error| format!("Falha ao aguardar executor: {error}"))?,
        Err(_) => {
            child.kill().await.map_err(|error| {
                format!("Executor excedeu timeout e nao pode ser encerrado: {error}")
            })?;
            return Err("Executor excedeu o timeout de 30 segundos.".to_string());
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|error| format!("Falha ao unir stdout: {error}"))?
        .map_err(|error| format!("Falha ao ler stdout: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("Falha ao unir stderr: {error}"))?
        .map_err(|error| format!("Falha ao ler stderr: {error}"))?;

    let elapsed = started.elapsed().as_millis();
    let stderr_text = String::from_utf8_lossy(&stderr).to_string();

    Ok(ExecutorResult {
        ok: status.success(),
        code: status.code(),
        stdout: format!(
            "{}\n[client-wizard] elapsed_ms={elapsed}",
            String::from_utf8_lossy(&stdout)
        ),
        stderr: stderr_text,
    })
}

fn validate_https_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("URL invalida: {error}"))?;
    let is_localhost = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if url.scheme() != "https" && !is_localhost {
        return Err(
            "Pacotes remotos devem usar HTTPS, exceto localhost para desenvolvimento.".to_string(),
        );
    }
    Ok(url)
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err("sha256 deve conter 64 caracteres hexadecimais.".to_string());
    }
    Ok(normalized)
}

fn extract_zip(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let reader = Cursor::new(bytes);
    let mut archive =
        ZipArchive::new(reader).map_err(|error| format!("Pacote zip invalido: {error}"))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Falha ao ler item zip: {error}"))?;
        let Some(enclosed_name) = file.enclosed_name().map(PathBuf::from) else {
            return Err("Pacote contem caminho inseguro.".to_string());
        };
        let output_path = destination.join(enclosed_name);

        if file.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Falha ao criar diretorio extraido: {error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Falha ao criar diretorio extraido: {error}"))?;
        }

        let mut output = File::create(&output_path)
            .map_err(|error| format!("Falha ao criar arquivo extraido: {error}"))?;
        std::io::copy(&mut file, &mut output)
            .map_err(|error| format!("Falha ao escrever arquivo extraido: {error}"))?;
    }

    Ok(())
}

fn extract_zip_file(
    app: &AppHandle,
    operation_id: &str,
    archive_path: &Path,
    destination: &Path,
) -> Result<usize, String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("Falha ao abrir zip para extracao: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Arquivo zip invalido: {error}"))?;
    let total = archive.len().max(1);
    let mut files = 0_usize;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Falha ao ler item zip: {error}"))?;
        let Some(enclosed_name) = file.enclosed_name().map(PathBuf::from) else {
            return Err("Zip contem caminho inseguro.".to_string());
        };
        let output_path = destination.join(enclosed_name);

        if file.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Falha ao criar diretorio extraido: {error}"))?;
        } else {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Falha ao criar diretorio extraido: {error}"))?;
            }
            let mut output = File::create(&output_path)
                .map_err(|error| format!("Falha ao criar arquivo extraido: {error}"))?;
            std::io::copy(&mut file, &mut output)
                .map_err(|error| format!("Falha ao escrever arquivo extraido: {error}"))?;
            files += 1;
        }

        emit_native_progress(
            app,
            "client-wizard://extract-progress",
            NativeProgressEvent {
                operation_id: operation_id.to_string(),
                phase: "extract".to_string(),
                progress: (((index + 1) as f64 / total as f64) * 100.0).round() as u8,
                downloaded_bytes: None,
                total_bytes: None,
                message: "Extraindo zip".to_string(),
            },
        );
    }

    Ok(files)
}

fn extract_tar_gz_file(
    app: &AppHandle,
    operation_id: &str,
    archive_path: &Path,
    destination: &Path,
    strip_components: usize,
) -> Result<usize, String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("Falha ao abrir tar.gz para extracao: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut files = 0_usize;

    for entry in archive
        .entries()
        .map_err(|error| format!("Falha ao ler tar.gz: {error}"))?
    {
        let mut entry = entry.map_err(|error| format!("Falha ao ler item tar.gz: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Falha ao ler caminho tar.gz: {error}"))?;
        let stripped_path = strip_path_components(path.as_ref(), strip_components)?;
        if stripped_path.as_os_str().is_empty() {
            continue;
        }
        let output_path = destination.join(stripped_path);
        ensure_child_path(destination, &output_path)?;

        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Falha ao criar diretorio tar.gz: {error}"))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Falha ao criar diretorio tar.gz: {error}"))?;
        }
        entry
            .unpack(&output_path)
            .map_err(|error| format!("Falha ao extrair item tar.gz: {error}"))?;
        files += 1;
        let progress = (10 + (files.min(90) as u8)).min(99);
        emit_native_progress(
            app,
            "client-wizard://extract-progress",
            NativeProgressEvent {
                operation_id: operation_id.to_string(),
                phase: "extract".to_string(),
                progress,
                downloaded_bytes: None,
                total_bytes: None,
                message: "Extraindo tar.gz".to_string(),
            },
        );
    }

    Ok(files)
}

fn strip_path_components(path: &Path, components: usize) -> Result<PathBuf, String> {
    let mut output = PathBuf::new();
    for component in path.components().skip(components) {
        match component {
            std::path::Component::Normal(value) => output.push(value),
            std::path::Component::CurDir => {}
            _ => return Err("Arquivo contem caminho inseguro.".to_string()),
        }
    }
    Ok(output)
}

fn ensure_child_path(root: &Path, candidate: &Path) -> Result<(), String> {
    let normalized = candidate.components().collect::<PathBuf>();
    if normalized
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
        || !normalized.starts_with(root)
    {
        return Err("Arquivo aponta para fora do diretorio de destino.".to_string());
    }
    Ok(())
}

fn sanitize_file_name(value: &str) -> Result<String, String> {
    let sanitized = value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | '_') {
                char
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.trim_matches('.').is_empty() {
        return Err("Nome de arquivo invalido.".to_string());
    }
    Ok(sanitized)
}

fn infer_archive_format(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.ends_with(".zip") {
        "zip".to_string()
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        "tar.gz".to_string()
    } else {
        String::new()
    }
}

fn emit_native_progress(app: &AppHandle, event: &str, payload: NativeProgressEvent) {
    let _ = app.emit(event, payload);
}

fn resolve_fs_path(app: &AppHandle, request: &FsPathRequest) -> Result<PathBuf, String> {
    let root = match request.base.as_str() {
        "appData" => app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Falha ao localizar appData: {error}"))?,
        "appCache" => app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Falha ao localizar appCache: {error}"))?,
        "downloads" => app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("Falha ao localizar downloads: {error}"))?
            .join("downloads"),
        "temp" => std::env::temp_dir().join("client-wizard"),
        _ => return Err(format!("Base de fs nao permitida: {}.", request.base)),
    };

    fs::create_dir_all(&root).map_err(|error| format!("Falha ao preparar base de fs: {error}"))?;
    let relative = sanitize_relative_path(&request.path)?;
    Ok(root.join(relative))
}

fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("Path absoluto nao e permitido no fs do wizard.".to_string());
    }

    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => output.push(value),
            std::path::Component::CurDir => {}
            _ => return Err("Path contem componente inseguro.".to_string()),
        }
    }
    Ok(output)
}

fn ensure_relative_not_empty(request: &FsPathRequest) -> Result<(), String> {
    if sanitize_relative_path(&request.path)?
        .as_os_str()
        .is_empty()
    {
        return Err("Operacao nao permitida na raiz da base.".to_string());
    }
    Ok(())
}

fn fs_stat(path: &Path) -> Result<FsEntry, String> {
    fs_stat_with_name(path)
}

fn fs_stat_with_name(path: &Path) -> Result<FsEntry, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Falha ao ler metadados: {error}"))?;
    Ok(FsEntry {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        path: path.display().to_string(),
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        modified_at: metadata.modified().ok().and_then(system_time_millis),
        created_at: metadata.created().ok().and_then(system_time_millis),
    })
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn copy_directory(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to)
        .map_err(|error| format!("Falha ao criar diretorio de copia: {error}"))?;
    for entry in
        fs::read_dir(from).map_err(|error| format!("Falha ao ler diretorio de origem: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Falha ao ler item de origem: {error}"))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_directory(&source, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Falha ao criar diretorio de destino: {error}"))?;
            }
            fs::copy(&source, &target)
                .map_err(|error| format!("Falha ao copiar arquivo: {error}"))?;
        }
    }
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Falha ao resolver raiz do pacote: {error}"))?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|error| format!("Entrada do pacote nao encontrada: {error}"))?;

    if !canonical_candidate.starts_with(canonical_root) {
        return Err("Entrada do pacote aponta para fora do diretorio validado.".to_string());
    }

    Ok(canonical_candidate)
}

const LOCAL_TEXT_FILE_LIMIT: u64 = 2 * 1024 * 1024;
const LOCAL_BINARY_FILE_LIMIT: u64 = 50 * 1024 * 1024;

fn ensure_readable_file(path: &Path, max_bytes: u64) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Falha ao ler metadados do arquivo local: {error}"))?;
    if !metadata.is_file() {
        return Err("Somente arquivos podem ser lidos.".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "Arquivo local excede limite de {} MB.",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(())
}

fn canonicalize_local_manifest_base_dir(base_dir: &Path) -> Result<PathBuf, String> {
    let canonical_base_dir = base_dir
        .canonicalize()
        .map_err(|error| format!("Falha ao resolver pasta do manifesto local: {error}"))?;
    if !canonical_base_dir.is_dir() {
        return Err("Pasta do manifesto local invalida.".to_string());
    }
    Ok(canonical_base_dir)
}

fn selected_local_manifest_base_dir(
    selected_manifest: &State<'_, SelectedLocalManifestState>,
) -> Result<PathBuf, String> {
    selected_manifest
        .current
        .lock()
        .map_err(|_| "Falha ao acessar o manifesto local selecionado.".to_string())?
        .active_base_dir
        .clone()
        .ok_or_else(|| "Nenhum manifesto local selecionado.".to_string())
}

fn pending_local_manifest_base_dir(
    selected_manifest: &State<'_, SelectedLocalManifestState>,
) -> Result<PathBuf, String> {
    selected_manifest
        .current
        .lock()
        .map_err(|_| "Falha ao acessar o manifesto local selecionado.".to_string())?
        .pending_base_dir
        .clone()
        .ok_or_else(|| "Nenhum manifesto local pendente.".to_string())
}

fn clear_selected_local_manifest_scope(state: &mut SelectedLocalManifestStateInner) {
    state.pending_manifest_path = None;
    state.pending_base_dir = None;
    state.active_base_dir = None;
}

fn activate_selected_local_manifest_scope(
    state: &mut SelectedLocalManifestStateInner,
    manifest_path: &Path,
) -> Result<(), String> {
    let canonical_manifest_path = manifest_path
        .canonicalize()
        .map_err(|error| format!("Falha ao resolver manifesto local selecionado: {error}"))?;
    let pending_manifest_path = state
        .pending_manifest_path
        .as_ref()
        .ok_or_else(|| "Nenhum manifesto local pendente para confirmacao.".to_string())?;
    if *pending_manifest_path != canonical_manifest_path {
        return Err("Manifesto local nao corresponde ao arquivo selecionado.".to_string());
    }
    let pending_base_dir = state
        .pending_base_dir
        .clone()
        .ok_or_else(|| "Nenhuma pasta local pendente para confirmacao.".to_string())?;
    state.pending_manifest_path = None;
    state.pending_base_dir = None;
    state.active_base_dir = Some(pending_base_dir);
    Ok(())
}

fn resolve_local_manifest_reference(
    selected_base_dir: &Path,
    requested_base_dir: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let requested_base_dir = canonicalize_local_manifest_base_dir(Path::new(requested_base_dir))?;
    if requested_base_dir != selected_base_dir {
        return Err("Pasta base nao corresponde ao manifesto local selecionado.".to_string());
    }
    let relative_path = sanitize_local_manifest_relative_path(relative_path)?;
    let candidate = selected_base_dir.join(relative_path);
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|error| format!("Arquivo local nao encontrado: {error}"))?;
    if !canonical_candidate.starts_with(&selected_base_dir) {
        return Err("Referencia local aponta para fora da pasta do manifesto.".to_string());
    }

    Ok(canonical_candidate)
}

fn sanitize_local_manifest_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(format!("Referencia local absoluta nao permitida: {value}"));
    }

    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(segment) => output.push(segment),
            std::path::Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Referencia local contem componente inseguro: {value}"
                ))
            }
        }
    }

    if output.as_os_str().is_empty() {
        return Err("Referencia local vazia nao permitida.".to_string());
    }

    Ok(output)
}

fn read_selected_manifest_text_file(path: &Path) -> Result<String, String> {
    read_local_text_file_at_path(path)
}

fn read_local_text_file_at_path(path: &Path) -> Result<String, String> {
    ensure_readable_file(path, LOCAL_TEXT_FILE_LIMIT)?;
    fs::read_to_string(path)
        .map_err(|error| format!("Falha ao ler arquivo local como UTF-8: {error}"))
}

fn read_local_text_file_blocking(
    selected_base_dir: &Path,
    base_dir: String,
    relative_path: String,
) -> Result<String, String> {
    let path = resolve_local_manifest_reference(selected_base_dir, &base_dir, &relative_path)?;
    read_local_text_file_at_path(&path)
}

fn read_local_consent_document_blocking(
    selected_base_dir: &Path,
    base_dir: String,
    relative_path: String,
) -> Result<String, String> {
    let path = resolve_local_manifest_reference(selected_base_dir, &base_dir, &relative_path)?;
    ensure_local_consent_document_path(&path)?;
    read_local_text_file_at_path(&path)
}

fn ensure_local_consent_document_path(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Documento local precisa ter extensao de documento.".to_string())?;

    match extension.as_str() {
        "md" | "markdown" | "txt" | "html" | "htm" => Ok(()),
        _ => Err("Documento local precisa ser markdown, texto ou HTML.".to_string()),
    }
}

fn read_local_binary_file_at_path(path: &Path) -> Result<Vec<u8>, String> {
    ensure_readable_file(path, LOCAL_BINARY_FILE_LIMIT)?;
    fs::read(path).map_err(|error| format!("Falha ao ler arquivo local: {error}"))
}

fn read_local_binary_file_blocking(
    selected_base_dir: &Path,
    base_dir: String,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    let path = resolve_local_manifest_reference(selected_base_dir, &base_dir, &relative_path)?;
    read_local_binary_file_at_path(&path)
}

fn parse_manifest_launch_args(args: &[String]) -> Option<Result<LaunchManifestPayload, String>> {
    for (index, arg) in args.iter().enumerate() {
        if arg.starts_with("client-wizard://") {
            return Some(parse_manifest_deep_link(arg));
        }

        if arg == "--manifest" {
            return Some(
                args.get(index + 1)
                    .ok_or_else(|| "--manifest precisa receber a URL do manifesto.".to_string())
                    .and_then(|manifest_url| {
                        Ok(LaunchManifestPayload {
                            manifest_url: validate_launch_manifest_url(manifest_url)?,
                            source: "cli".to_string(),
                        })
                    }),
            );
        }

        if let Some(manifest_url) = arg.strip_prefix("--manifest=") {
            return Some(
                validate_launch_manifest_url(manifest_url).map(|manifest_url| {
                    LaunchManifestPayload {
                        manifest_url,
                        source: "cli".to_string(),
                    }
                }),
            );
        }
    }

    None
}

fn parse_manifest_deep_link(input: &str) -> Result<LaunchManifestPayload, String> {
    let url = Url::parse(input).map_err(|error| format!("Link dinamico invalido: {error}"))?;
    if url.scheme() != "client-wizard" {
        return Err("Link dinamico deve usar o protocolo client-wizard://.".to_string());
    }

    if url.host_str() != Some("open") || !matches!(url.path(), "" | "/") {
        return Err("Link dinamico deve usar client-wizard://open?manifest=...".to_string());
    }

    if url.fragment().is_some() {
        return Err("Link dinamico nao aceita fragmento.".to_string());
    }

    let mut manifest_url = None;
    for (key, value) in url.query_pairs() {
        if key != "manifest" {
            return Err(format!("Parametro de link dinamico nao permitido: {key}."));
        }
        if manifest_url.replace(value.to_string()).is_some() {
            return Err("Link dinamico deve declarar manifest apenas uma vez.".to_string());
        }
    }

    Ok(LaunchManifestPayload {
        manifest_url: validate_launch_manifest_url(
            &manifest_url.ok_or_else(|| "Link dinamico precisa declarar manifest.".to_string())?,
        )?,
        source: "deep-link".to_string(),
    })
}

fn validate_launch_manifest_url(value: &str) -> Result<String, String> {
    let url =
        Url::parse(value.trim()).map_err(|error| format!("URL do manifesto invalida: {error}"))?;
    let is_localhost = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(is_localhost && matches!(url.scheme(), "http" | "https")) {
        return Err("A URL do manifesto deve usar HTTPS.".to_string());
    }
    Ok(url.to_string())
}

fn apply_manifest_launch_result(app: &AppHandle, result: Result<LaunchManifestPayload, String>) {
    match result {
        Ok(payload) => {
            if let Some(state) = app.try_state::<LaunchManifestState>() {
                if let Ok(mut current) = state.current.lock() {
                    current.payload = Some(payload.clone());
                    current.error = None;
                }
            }
            let _ = app.emit("client-wizard-open-manifest", payload);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }
        Err(error) => {
            if let Some(state) = app.try_state::<LaunchManifestState>() {
                if let Ok(mut current) = state.current.lock() {
                    current.payload = None;
                    current.error = Some(error.clone());
                }
            }
            let _ = app.emit("client-wizard-open-manifest-error", error);
        }
    }
}

fn configure_manifest_launch(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        if let Some(url) = event.urls().first() {
            apply_manifest_launch_result(&app_handle, parse_manifest_deep_link(url.as_str()));
        }
    });

    #[cfg(any(windows, target_os = "linux"))]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("Falha ao registrar protocolo client-wizard dinamicamente: {error}");
    }

    if let Some(result) = parse_manifest_launch_args(&env::args().collect::<Vec<_>>()) {
        apply_manifest_launch_result(app.handle(), result);
    }

    if let Some(urls) = app.deep_link().get_current()? {
        if let Some(url) = urls.first() {
            apply_manifest_launch_result(app.handle(), parse_manifest_deep_link(url.as_str()));
        }
    }

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(LaunchManifestState::default())
        .manage(SelectedLocalManifestState::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(result) = parse_manifest_launch_args(&argv) {
                apply_manifest_launch_result(app, result);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(configure_manifest_launch)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-audit" => open_audit_window(app),
            "show-about" => open_about_window(app, serde_json::Value::Null),
            "switch-manifest" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("client-wizard-switch-manifest", ());
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_manifest_url,
            download_package,
            execute_native,
            download_file,
            extract_archive,
            fs_execute,
            open_external_url,
            select_manifest_file,
            open_about,
            open_audit,
            open_markdown_document,
            read_local_text_file,
            read_local_binary_file,
            read_local_consent_document,
            confirm_local_manifest_scope,
            clear_local_manifest_scope,
            show_native_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running Client Wizard");
}

fn open_audit_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("audit") {
        let _ = window.set_focus();
        return;
    }

    if let Err(error) = WebviewWindowBuilder::new(
        app,
        "audit",
        WebviewUrl::App("index.html?view=audit".into()),
    )
    .title("Auditoria")
    .inner_size(1100.0, 760.0)
    .min_inner_size(860.0, 560.0)
    .build()
    {
        eprintln!("Falha ao abrir janela de auditoria: {error}");
    }
}

fn open_about_window(app: &AppHandle, about_data: serde_json::Value) {
    if let Some(window) = app.get_webview_window("about") {
        let _ = window.close();
    }

    let about_query = if about_data.is_null() {
        String::new()
    } else {
        let serialized = serde_json::to_string(&about_data).unwrap_or_else(|_| "{}".to_string());
        format!("&about={}", percent_encode_component(&serialized))
    };

    if let Err(error) = WebviewWindowBuilder::new(
        app,
        "about",
        WebviewUrl::App(format!("index.html?view=about{about_query}").into()),
    )
    .title("About Client Wizard")
    .inner_size(620.0, 520.0)
    .min_inner_size(520.0, 420.0)
    .build()
    {
        eprintln!("Falha ao abrir janela de about: {error}");
    }
}

#[cfg(test)]
mod local_manifest_tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("client-wizard-{name}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn pinned_base(dir: &Path) -> PathBuf {
        dir.canonicalize().expect("canonical base")
    }

    #[test]
    fn read_local_text_file_rejects_invalid_utf8() {
        let dir = temp_dir("invalid-utf8");
        let file = dir.join("manifest.json");
        fs::write(&file, [0xff, 0xfe, 0xfd]).expect("write invalid utf8");

        let result = read_local_text_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "manifest.json".to_string(),
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn read_local_text_file_within_base_dir_succeeds() {
        let dir = temp_dir("scoped-text");
        let docs = dir.join("docs");
        fs::create_dir_all(&docs).expect("create docs");
        let file = docs.join("terms.md");
        fs::write(&file, "# Terms").expect("write terms");

        let result = read_local_text_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "docs/terms.md".to_string(),
        )
        .expect("read text");

        assert_eq!(result, "# Terms");
    }

    #[test]
    fn read_local_consent_document_allows_document_extensions() {
        let dir = temp_dir("consent-doc");
        let docs = dir.join("docs");
        fs::create_dir_all(&docs).expect("create docs");
        fs::write(docs.join("privacy.markdown"), "# Privacy").expect("write privacy");

        let result = read_local_consent_document_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "docs/privacy.markdown".to_string(),
        )
        .expect("read consent document");

        assert_eq!(result, "# Privacy");
    }

    #[test]
    fn read_local_consent_document_rejects_script_extension() {
        let dir = temp_dir("consent-script");
        fs::write(dir.join("wizard.js"), "console.log('nope');").expect("write script");

        let result = read_local_consent_document_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "wizard.js".to_string(),
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Documento local"));
    }

    #[test]
    fn read_local_binary_file_returns_bytes() {
        let dir = temp_dir("binary");
        let file = dir.join("package.zip");
        fs::write(&file, [1_u8, 2, 3, 4]).expect("write binary");

        let result = read_local_binary_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "package.zip".to_string(),
        )
        .expect("read binary");

        assert_eq!(result, vec![1, 2, 3, 4]);
    }

    #[test]
    fn read_local_text_file_rejects_directories() {
        let dir = temp_dir("directory");
        let file = dir.join("folder");
        fs::create_dir_all(&file).expect("create directory");

        let result = read_local_text_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "folder".to_string(),
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Somente arquivos"));
    }

    #[test]
    fn read_local_text_file_rejects_parent_traversal() {
        let dir = temp_dir("traversal");
        let outside = dir.parent().expect("parent").join("secret.txt");
        fs::write(&outside, "secret").expect("write secret");

        let result = read_local_text_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "../secret.txt".to_string(),
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("inseguro"));
    }

    #[test]
    fn read_local_text_file_rejects_absolute_paths() {
        let dir = temp_dir("absolute");
        let absolute = absolute_test_path();

        let result = read_local_text_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            absolute,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absoluta"));
    }

    #[test]
    fn read_local_text_file_rejects_missing_files() {
        let dir = temp_dir("missing");

        let result = read_local_text_file_blocking(
            pinned_base(&dir).as_path(),
            dir.display().to_string(),
            "missing.md".to_string(),
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("nao encontrado"));
    }

    #[test]
    fn resolve_local_manifest_reference_rejects_mismatched_base_dir() {
        let selected = temp_dir("selected-base");
        let requested = temp_dir("requested-base");
        let file = selected.join("terms.md");
        fs::write(&file, "# Terms").expect("write terms");

        let result = resolve_local_manifest_reference(
            selected.as_path(),
            &requested.display().to_string(),
            "terms.md",
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("selecionado"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_local_manifest_reference_rejects_retargeted_selected_base() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("retargeted-base");
        let selected = root.join("selected");
        let outside = root.join("outside");
        fs::create_dir_all(&selected).expect("create selected");
        fs::create_dir_all(&outside).expect("create outside");
        fs::write(outside.join("secret.txt"), "secret").expect("write secret");
        let pinned_selected = selected.canonicalize().expect("canonical selected");

        fs::remove_dir_all(&selected).expect("remove selected");
        symlink(&outside, &selected).expect("retarget selected");

        let result = resolve_local_manifest_reference(
            &pinned_selected,
            &selected.display().to_string(),
            "secret.txt",
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("selecionado"));
    }

    #[test]
    fn activate_selected_local_manifest_scope_promotes_pending_selection() {
        let dir = temp_dir("activate-scope");
        let manifest = dir.join("manifest.json");
        fs::write(&manifest, "{}").expect("write manifest");
        let canonical_base =
            canonicalize_local_manifest_base_dir(dir.as_path()).expect("canonical base");
        let canonical_manifest = manifest.canonicalize().expect("canonical manifest");
        let mut state = SelectedLocalManifestStateInner {
            pending_manifest_path: Some(canonical_manifest.clone()),
            pending_base_dir: Some(canonical_base.clone()),
            active_base_dir: None,
        };

        activate_selected_local_manifest_scope(&mut state, manifest.as_path())
            .expect("activate scope");

        assert_eq!(state.active_base_dir, Some(canonical_base));
        assert!(state.pending_manifest_path.is_none());
        assert!(state.pending_base_dir.is_none());
    }

    #[test]
    fn clear_selected_local_manifest_scope_removes_pending_and_active_access() {
        let dir = temp_dir("clear-scope");
        let manifest = dir.join("manifest.json");
        fs::write(&manifest, "{}").expect("write manifest");
        let canonical_base =
            canonicalize_local_manifest_base_dir(dir.as_path()).expect("canonical base");
        let canonical_manifest = manifest.canonicalize().expect("canonical manifest");
        let mut state = SelectedLocalManifestStateInner {
            pending_manifest_path: Some(canonical_manifest),
            pending_base_dir: Some(canonical_base.clone()),
            active_base_dir: Some(canonical_base),
        };

        clear_selected_local_manifest_scope(&mut state);

        assert!(state.pending_manifest_path.is_none());
        assert!(state.pending_base_dir.is_none());
        assert!(state.active_base_dir.is_none());
    }

    #[cfg(target_os = "windows")]
    fn absolute_test_path() -> String {
        "C:\\Windows\\System32\\drivers\\etc\\hosts".to_string()
    }

    #[cfg(not(target_os = "windows"))]
    fn absolute_test_path() -> String {
        "/etc/hosts".to_string()
    }
}

fn open_markdown_document_window(app: &AppHandle, document_data: serde_json::Value) {
    let title = document_data
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Documento");
    let window_label = format!(
        "document-{}",
        document_data
            .get("url")
            .and_then(|value| value.as_str())
            .map(hash_window_label)
            .unwrap_or_else(|| hash_window_label(title))
    );

    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.close();
    }

    let serialized = serde_json::to_string(&document_data).unwrap_or_else(|_| "{}".to_string());
    let document_query = percent_encode_component(&serialized);

    if let Err(error) = WebviewWindowBuilder::new(
        app,
        window_label,
        WebviewUrl::App(format!("index.html?view=document&document={document_query}").into()),
    )
    .title(title)
    .inner_size(760.0, 680.0)
    .min_inner_size(560.0, 460.0)
    .build()
    {
        eprintln!("Falha ao abrir documento Markdown: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_manifest_deep_link() {
        let payload = parse_manifest_deep_link(
            "client-wizard://open?manifest=https%3A%2F%2Fexample.com%2Fmanifest.json",
        )
        .expect("valid deep link should parse");

        assert_eq!(payload.manifest_url, "https://example.com/manifest.json");
        assert_eq!(payload.source, "deep-link");
    }

    #[test]
    fn rejects_deep_link_with_extra_parameter() {
        let error = parse_manifest_deep_link(
            "client-wizard://open?manifest=https%3A%2F%2Fexample.com%2Fmanifest.json&entry=https%3A%2F%2Fevil.test",
        )
        .expect_err("extra parameters must be rejected");

        assert!(error.contains("Parametro de link dinamico nao permitido"));
    }

    #[test]
    fn accepts_cli_manifest_argument() {
        let args = vec![
            "client-wizard".to_string(),
            "--manifest".to_string(),
            "http://localhost:1420/sample/manifest.json".to_string(),
        ];
        let payload = parse_manifest_launch_args(&args)
            .expect("manifest argument should be detected")
            .expect("localhost manifest URL should be accepted");

        assert_eq!(
            payload.manifest_url,
            "http://localhost:1420/sample/manifest.json"
        );
        assert_eq!(payload.source, "cli");
    }

    #[test]
    fn rejects_non_https_remote_manifest() {
        let error = validate_launch_manifest_url("http://example.com/manifest.json")
            .expect_err("remote http manifest should be rejected");

        assert_eq!(error, "A URL do manifesto deve usar HTTPS.");
    }
}

fn hash_window_label(value: &str) -> String {
    let mut hash: u32 = 0;
    for byte in value.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(byte as u32);
    }
    format!("{hash:x}")
}

fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}
