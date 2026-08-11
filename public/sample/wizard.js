const wizard = clientWizard.useWizard(
  {
    steps: [
      {
        id: "welcome",
        title: "Boas-vindas",
        markdown:
          "# Client Wizard\n\nEste exemplo demonstra como um `manifest.json` pode carregar um `wizard.js` remoto e montar uma experiencia nativa dentro do app, sem abrir uma pagina externa.\n\nRepositorio: [runvibe/client-wizard](https://github.com/runvibe/client-wizard)\n\nNeste fluxo o script vai:\n\n- renderizar as telas pelo host React/shadcn;\n- solicitar permissao nativa declarada no manifesto;\n- consultar informacoes basicas do sistema;\n- atualizar o progresso da operacao;\n- navegar automaticamente para uma step de sucesso ou falha.\n\nClique em **Avancar** para iniciar a demonstracao."
      },
      {
        id: "terms",
        title: "Termos e licencas",
        btnNext: "disabled",
        btnNextWhen: "termsAccepted",
        markdown:
          "## Termos e licencas\n\nAntes de continuar, revise as licencas principais usadas pelo Client Wizard e pelo runtime deste exemplo.\n\n### Produto\n\n- Repositorio: [runvibe/client-wizard](https://github.com/runvibe/client-wizard)\n- O codigo do produto deve seguir a licenca publicada no repositório. Caso o repositorio ainda nao publique um arquivo `LICENSE`, trate o codigo do produto como uso restrito ate que a licenca seja definida.\n\n### Dependencias principais\n\n| Componente | Licenca |\n|---|---|\n| Tauri | MIT / Apache-2.0 |\n| Rust crates do runtime | conforme cada crate no `Cargo.lock` |\n| React | MIT |\n| Vite | MIT |\n| TypeScript | Apache-2.0 |\n| Tailwind CSS | MIT |\n| shadcn/ui | MIT |\n| Base UI | MIT |\n| Remix Icon | Apache-2.0 |\n| Raleway Font | OFL-1.1 |\n\nMarque o checkbox abaixo para confirmar que leu os termos deste exemplo e habilitar o botao **Avancar**.\n\n" +
          "<WizardCheckbox name=\"termsAccepted\" label=\"Li e concordo com os termos\" />"
      },
      {
        id: "system",
        title: "Sistema",
        markdown:
          "## Instalando\n\nStatus: `{{ storage.status }}`\n\nSistema: `{{ storage.os }}`\n\nArquitetura: `{{ storage.arch }}`\n\nCPU: `{{ storage.cpu }}`\n\n<ProgressiveBar name=\"progress\" />"
      },
      {
        id: "success",
        title: "Sucesso",
        btnPrev: "none",
        btnNext: "none",
        markdown:
          "## Instalacao concluida\n\nO progresso chegou a 100% e o fluxo foi movido automaticamente para a tela de sucesso.\n\nSistema: `{{ storage.os }}`\n\nArquitetura: `{{ storage.arch }}`\n\nCPU: `{{ storage.cpu }}`"
      },
      {
        id: "failure",
        title: "Falha",
        btnNext: "none",
        markdown:
          "## Falha na instalacao\n\nO wizard encontrou um erro e pulou automaticamente para a ultima step.\n\nErro: `{{ storage.errorMessage }}`"
      }
    ]
  },
  { storage: { progress: 10, status: "aguardando", termsAccepted: false } }
);

wizard.events(async (event) => {
  if (event.type !== "next" || event.data.index !== 2) {
    return;
  }

  try {
    await wizard.setStorage({ progress: 40, status: "consultando sistema" });
    const info = await clientWizard.invoke({ type: "systemInfo" });
    const system = info.stdout ? JSON.parse(info.stdout) : {};
    await wizard.setStorage({
      progress: 100,
      status: "instalacao concluida",
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
