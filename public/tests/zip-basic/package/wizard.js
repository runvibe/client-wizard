const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "intro",
        title: "Pacote ZIP",
        markdown:
          "# Wizard carregado de um ZIP\n\nEste script veio de `package.zip` e foi localizado pelo campo `entry.script` do manifesto.\n\nClique em **Avancar** para consultar informacoes do sistema usando a permissao aprovada."
      },
      {
        id: "system",
        title: "Sistema",
        markdown:
          "## Consulta nativa\n\nStatus: `{{ storage.status }}`\n\nSistema: `{{ storage.os }}`\n\nArquitetura: `{{ storage.arch }}`\n\nCPU: `{{ storage.cpu }}`\n\n<ProgressiveBar name=\"progress\" />"
      },
      {
        id: "success",
        title: "Sucesso",
        btnPrev: "none",
        btnNext: "none",
        markdown:
          "## ZIP executado com sucesso\n\nO `wizard.js` foi extraido do ZIP e conseguiu atualizar a interface renderizada pelo host.\n\nSistema: `{{ storage.os }}`\n\nArquitetura: `{{ storage.arch }}`"
      },
      {
        id: "failure",
        title: "Falha",
        btnNext: "none",
        markdown: "## Falha no exemplo ZIP\n\nErro: `{{ storage.errorMessage }}`"
      }
    ]
  },
  { storage: { progress: 10, status: "aguardando" } }
);

wizard.events(async (event) => {
  if (event.type !== "next" || event.data.index !== 1) {
    return;
  }

  try {
    await wizard.setStorage({ progress: 40, status: "consultando sistema" });
    const info = await clientWizard.invoke({ type: "systemInfo" });
    const system = info.stdout ? JSON.parse(info.stdout) : {};
    await wizard.setStorage({
      progress: 100,
      status: "consulta concluida",
      os: system.os || "desconhecido",
      arch: system.cpuArchitecture || "desconhecida",
      cpu: system.cpuCount || "desconhecida"
    });
    await wizard.goTo("success");
  } catch (error) {
    await goToFailure(error);
  }
});

async function goToFailure(error) {
  await wizard.setStorage({
    progress: 0,
    status: "falha",
    errorMessage: error instanceof Error ? error.message : String(error)
  });
  await wizard.goTo("failure");
}

globalThis.addEventListener("error", (event) => {
  void goToFailure(event.error || event.message || "Erro inesperado");
});

globalThis.addEventListener("unhandledrejection", (event) => {
  void goToFailure(event.reason || "Promise rejeitada sem tratamento");
});
