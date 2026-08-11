const repo = "ventoy/Ventoy";
const releaseApi = `https://api.github.com/repos/${repo}/releases/latest`;

const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "intro",
        title: "Ventoy",
        btnPrev: "none",
        btnNext: "enabled",
        markdown:
          "# Baixar pacote Ventoy\n\nEste teste usa o projeto **Ventoy** no GitHub.\n\nRepositorio: https://github.com/ventoy/Ventoy\n\nO wizard vai detectar seu sistema e localizar um pacote compactado no release mais recente.\n\n> O teste nao grava em disco/USB. Ele apenas descompacta o pacote em uma pasta local."
      },
      {
        id: "package",
        title: "Pacote",
        btnPrev: "enabled",
        btnNext: "enabled",
        markdown:
          "## Pacote selecionado\n\nSistema: `{{ storage.os }}` / `{{ storage.arch }}`\n\nRelease: `{{ storage.release }}`\n\nAsset: `{{ storage.assetName }}`\n\nTamanho: `{{ storage.assetSizeMb }} MB`\n\nDestino: `{{ storage.installPath }}`\n\n<ProgressiveBar name=\"progress\" />"
      },
      {
        id: "extract",
        title: "Extracao",
        btnPrev: "enabled",
        btnNext: "disabled",
        markdown:
          "## Download e extracao\n\nStatus: `{{ storage.status }}`\n\nDestino: `{{ storage.installPath }}`\n\nA pasta de destino sera aberta ao final quando o sistema permitir.\n\n<ProgressiveBar name=\"progress\" />"
      },
      {
        id: "done",
        title: "Concluido",
        btnPrev: "enabled",
        btnNext: "none",
        markdown:
          "## Teste concluido\n\nO pacote do Ventoy foi baixado do GitHub Releases e descompactado com sucesso.\n\nDestino: `{{ storage.installPath }}`\n\nArquivos extraidos: `{{ storage.extractedFiles }}`\n\nNenhum instalador foi executado e nenhuma unidade USB/disco foi alterada."
      }
    ]
  },
  {
    storage: {
      progress: 5,
      status: "aguardando"
    }
  }
);

wizard.events(async (event) => {
  if (event.type !== "next") {
    return;
  }

  if (event.data.index === 1) {
    await preparePackage();
  }

  if (event.data.index === 2) {
    await extractPackage();
  }
});

async function preparePackage() {
  await wizard.setStorage({ progress: 20, status: "detectando sistema" });

  const systemResult = await clientWizard.invoke({ type: "systemInfo" });
  const system = JSON.parse(systemResult.stdout || "{}");
  const release = await fetch(releaseApi).then((response) => {
    if (!response.ok) {
      throw new Error(`GitHub retornou HTTP ${response.status}`);
    }
    return response.json();
  });
  const asset = selectAsset(release.assets || [], system);

  if (!asset) {
    throw new Error(`Nenhum pacote compactado Ventoy encontrado para ${system.os} / ${system.cpuArchitecture}`);
  }

  await wizard.setStorage({
    progress: 55,
    os: system.os || "desconhecido",
    arch: system.cpuArchitecture || "desconhecida",
    release: release.tag_name || release.name || "latest",
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    assetSizeMb: Math.round((asset.size || 0) / 1024 / 1024),
    installPath: installPathFor(system.os || ""),
    status: "pacote pronto para descompactar"
  });
}

async function extractPackage() {
  const storage = await wizard.getStorage();
  const assetUrl = String(storage.assetUrl || "");
  const assetName = String(storage.assetName || "");
  const os = String(storage.os || "");
  const format = archiveFormatFor(assetName);

  if (!assetUrl || !assetName) {
    throw new Error("Prepare o pacote antes de iniciar a extracao.");
  }

  const confirmed = await wizard.openDialog({
    title: "Baixar e descompactar Ventoy?",
    text: `O Client Wizard vai baixar ${assetName} e descompactar em ${installPathFor(os)}. Nenhum disco/USB sera modificado.`,
    okText: "Descompactar",
    cancelText: "Cancelar"
  });

  if (!confirmed) {
    await wizard.setStorage({ status: "extracao cancelada", progress: 55 });
    return;
  }

  await wizard.setStorage({ status: "baixando pacote", progress: 60 });

  try {
    const downloaded = await wizard.download(
      {
        url: assetUrl,
        fileName: assetName
      },
      { progressName: "progress", statusName: "status", progressStart: 60, progressEnd: 75 }
    );

    await wizard.setStorage({ status: "descompactando pacote", progress: 70 });

    const extracted = await wizard.extract(
      {
        archivePath: downloaded.path,
        destinationName: assetName.replace(/\.(zip|tar\.gz|tgz)$/i, ""),
        format,
        stripComponents: format === "zip" ? 0 : 1
      },
      { progressName: "progress", statusName: "status", progressStart: 75, progressEnd: 100 }
    );

    await wizard.setStorage({
      status: `download e extracao concluidos (${extracted.files} arquivos)`,
      installPath: extracted.destinationPath,
      extractedFiles: extracted.files,
      progress: 100
    });
    await wizard.goTo("done");
  } catch (error) {
    await wizard.setStorage({
      status: `erro: ${error instanceof Error ? error.message : String(error)}`,
      installPath: installPathFor(os),
      progress: 70
    });
  }
}

function selectAsset(assets, system) {
  const os = String(system.os || "").toLowerCase();

  if (os.includes("windows")) {
    return findAsset(assets, /ventoy-.*-windows\.zip$/i);
  }

  if (os.includes("linux")) {
    return findAsset(assets, /ventoy-.*-linux\.tar\.gz$/i);
  }

  return undefined;
}

function findAsset(assets, pattern) {
  return assets.find((asset) => pattern.test(asset.name) && asset.browser_download_url);
}

function installPathFor(os) {
  const normalizedOs = os.toLowerCase();
  if (normalizedOs.includes("windows")) {
    return "%LOCALAPPDATA%\\\\ClientWizardTests\\\\Ventoy";
  }
  return "$HOME/Applications/Ventoy";
}

function archiveFormatFor(assetName) {
  const normalized = assetName.toLowerCase();
  if (normalized.endsWith(".zip")) {
    return "zip";
  }
  if (normalized.endsWith(".tar.gz")) {
    return "tar.gz";
  }
  if (normalized.endsWith(".tgz")) {
    return "tgz";
  }
  throw new Error(`Formato compactado nao suportado: ${assetName}`);
}
