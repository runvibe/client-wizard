const repo = "localsend/localsend";
const releaseApi = `https://api.github.com/repos/${repo}/releases/latest`;

const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        title: "LocalSend",
        btnPrev: "none",
        btnNext: "enabled",
        markdown:
          "# Instalar LocalSend\n\nEste teste instala o **LocalSend**, um app open source para compartilhar arquivos na rede local.\n\nRepositorio: https://github.com/localsend/localsend\n\nClique em **Avancar** para detectar o sistema e localizar o pacote mais recente no GitHub Releases."
      },
      {
        title: "Pacote selecionado",
        btnPrev: "enabled",
        btnNext: "enabled",
        markdown:
          "## Pacote encontrado\n\nSistema: `{{ storage.os }}` / `{{ storage.arch }}`\n\nRelease: `{{ storage.release }}`\n\nAsset: `{{ storage.assetName }}`\n\nTamanho: `{{ storage.assetSizeMb }} MB`\n\n<ProgressiveBar name=\"progress\" />"
      },
      {
        title: "Instalacao",
        btnPrev: "enabled",
        btnNext: "disabled",
        markdown:
          "## Instalacao iniciada\n\nStatus: `{{ storage.status }}`\n\nDestino: `{{ storage.installPath }}`\n\nO processo nativo foi iniciado em segundo plano. Em alguns sistemas, uma janela de terminal ou permissao do sistema pode aparecer.\n\n<ProgressiveBar name=\"progress\" />"
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
    await installPackage();
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
    throw new Error(`Nenhum pacote LocalSend compativel encontrado para ${system.os} / ${system.cpuArchitecture}`);
  }

  await wizard.setStorage({
    progress: 55,
    os: system.os || "desconhecido",
    arch: system.cpuArchitecture || "desconhecida",
    release: release.tag_name || release.name || "latest",
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    assetSizeMb: Math.round((asset.size || 0) / 1024 / 1024),
    status: "pacote pronto para instalar"
  });
}

async function installPackage() {
  const storage = await wizard.getStorage();
  const assetUrl = String(storage.assetUrl || "");
  const assetName = String(storage.assetName || "");
  const os = String(storage.os || "");

  if (!assetUrl || !assetName) {
    throw new Error("Prepare o pacote antes de iniciar a instalacao.");
  }

  const confirmed = await wizard.openDialog({
    title: "Instalar LocalSend?",
    text: `O Client Wizard vai executar um script nativo para baixar e instalar ${assetName}.`,
    okText: "Instalar",
    cancelText: "Cancelar"
  });

  if (!confirmed) {
    await wizard.setStorage({ status: "instalacao cancelada", progress: 55 });
    return;
  }

  await wizard.setStorage({ status: "iniciando instalador", progress: 70 });

  const command = buildInstallCommand(os, assetUrl, assetName);
  const result = await clientWizard.invoke(command);

  await wizard.setStorage({
    status: result.ok ? "instalador iniciado" : "falha ao iniciar instalador",
    installPath: installPathFor(os),
    progress: result.ok ? 100 : 70
  });
}

function selectAsset(assets, system) {
  const os = String(system.os || "").toLowerCase();
  const arch = String(system.cpuArchitecture || "").toLowerCase();
  const wantsArm = arch.includes("arm") || arch.includes("aarch64");

  if (os.includes("windows")) {
    return findAsset(assets, wantsArm ? /windows-arm-64\.zip$/i : /windows-x86-64\.zip$/i);
  }

  if (os.includes("darwin") || os.includes("mac")) {
    return findAsset(assets, /\.dmg$/i);
  }

  if (os.includes("linux")) {
    return findAsset(assets, wantsArm ? /linux-arm-64\.tar\.gz$/i : /linux-x86-64\.AppImage$/i);
  }

  return undefined;
}

function findAsset(assets, pattern) {
  return assets.find((asset) => pattern.test(asset.name) && asset.browser_download_url);
}

function buildInstallCommand(os, assetUrl, assetName) {
  const normalizedOs = os.toLowerCase();

  if (normalizedOs.includes("windows")) {
    return {
      type: "runScript",
      shell: "powershell",
      script: windowsInstaller(assetUrl, assetName)
    };
  }

  if (normalizedOs.includes("darwin") || normalizedOs.includes("mac")) {
    return {
      type: "runScript",
      shell: "sh",
      script: macInstaller(assetUrl, assetName)
    };
  }

  return {
    type: "runScript",
    shell: "sh",
    script: linuxInstaller(assetUrl, assetName)
  };
}

function windowsInstaller(assetUrl, assetName) {
  const body = [
    "$ErrorActionPreference = 'Stop'",
    "$root = Join-Path $env:LOCALAPPDATA 'ClientWizardTests\\\\LocalSend'",
    "$zip = Join-Path $env:TEMP " + psQuote(assetName),
    "New-Item -ItemType Directory -Force -Path $root | Out-Null",
    "Invoke-WebRequest -Uri " + psQuote(assetUrl) + " -OutFile $zip",
    "Expand-Archive -Path $zip -DestinationPath $root -Force",
    "$exe = Get-ChildItem -Path $root -Filter 'LocalSend*.exe' -Recurse | Select-Object -First 1",
    "if ($exe) { Start-Process -FilePath $exe.FullName }",
    "Write-Output ('LocalSend instalado em ' + $root)"
  ].join("\n");

  return [
    "$job = Join-Path $env:TEMP 'client-wizard-localsend-install.ps1'",
    "@'",
    body,
    "'@ | Set-Content -Path $job -Encoding UTF8",
    "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$job",
    "Write-Output ('Instalador iniciado em segundo plano: ' + $job)"
  ].join("\n");
}

function macInstaller(assetUrl, assetName) {
  const body = [
    "set -eu",
    "mkdir -p \"$HOME/Applications\"",
    "dmg=\"$TMPDIR/" + shEscape(assetName) + "\"",
    "curl -L " + shQuote(assetUrl) + " -o \"$dmg\"",
    "mount_dir=$(mktemp -d)",
    "hdiutil attach \"$dmg\" -mountpoint \"$mount_dir\" -nobrowse -quiet",
    "cp -R \"$mount_dir\"/*.app \"$HOME/Applications/\"",
    "hdiutil detach \"$mount_dir\" -quiet || true",
    "open \"$HOME/Applications/LocalSend.app\" || true",
    "echo \"LocalSend instalado em $HOME/Applications\""
  ].join("\n");

  return shBackgroundInstaller(body);
}

function linuxInstaller(assetUrl, assetName) {
  const isAppImage = /\.AppImage$/i.test(assetName);
  if (isAppImage) {
    const body = [
      "set -eu",
      "mkdir -p \"$HOME/Applications\"",
      "target=\"$HOME/Applications/LocalSend.AppImage\"",
      "curl -L " + shQuote(assetUrl) + " -o \"$target\"",
      "chmod +x \"$target\"",
      "\"$target\" >/tmp/localsend-client-wizard.log 2>&1 &",
      "echo \"LocalSend AppImage instalado em $target\""
    ].join("\n");

    return shBackgroundInstaller(body);
  }

  const body = [
    "set -eu",
    "mkdir -p \"$HOME/Applications/LocalSend\"",
    "archive=\"$TMPDIR/" + shEscape(assetName) + "\"",
    "curl -L " + shQuote(assetUrl) + " -o \"$archive\"",
    "tar -xzf \"$archive\" -C \"$HOME/Applications/LocalSend\"",
    "echo \"LocalSend extraido em $HOME/Applications/LocalSend\""
  ].join("\n");

  return shBackgroundInstaller(body);
}

function installPathFor(os) {
  const normalizedOs = os.toLowerCase();
  if (normalizedOs.includes("windows")) {
    return "%LOCALAPPDATA%\\\\ClientWizardTests\\\\LocalSend";
  }
  if (normalizedOs.includes("darwin") || normalizedOs.includes("mac")) {
    return "$HOME/Applications/LocalSend.app";
  }
  return "$HOME/Applications/LocalSend.AppImage";
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function shBackgroundInstaller(body) {
  return [
    "job=\"$TMPDIR/client-wizard-localsend-install.sh\"",
    "cat > \"$job\" <<'CLIENT_WIZARD_INSTALLER'",
    body,
    "CLIENT_WIZARD_INSTALLER",
    "chmod +x \"$job\"",
    "nohup sh \"$job\" >/tmp/client-wizard-localsend-install.log 2>&1 &",
    "echo \"Instalador iniciado em segundo plano: $job\""
  ].join("\n");
}

function shEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}
