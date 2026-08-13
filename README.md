# Client Wizard

Aplicacao desktop com Tauri + Rust e frontend React/shadcn para executar scripts de wizard remotos e renderizar as telas localmente pelo host.

## Fluxo implementado

1. A tela inicial pede a URL de um `manifest.json`.
2. O app baixa somente o manifesto e exibe nome, descricao, termos de uso e permissoes.
3. O usuario precisa aceitar o termo e marcar cada permissao individualmente.
4. Somente depois disso o app baixa o artefato `script` ou `zip`.
5. O script roda em um Web Worker com `clientWizard.useMarkdown()`, `clientWizard.useWizard()` e `clientWizard.invoke()`.
6. As telas sao renderizadas localmente em React/shadcn; nenhum HTML remoto visivel e carregado.

## Frontend

O frontend foi migrado para React + Vite e inicializado com:

```bash
npx shadcn@latest init --preset b1aIuQ2XC --template vite
```

O preset gerou `components.json`, componentes em `src\components\ui\*` e `src\lib\utils.ts`. A UI principal fica em `src\App.tsx`, usando a ponte Tauri/Rust somente para comandos nativos autorizados.

## Comandos

```bash
npm install
npm run build
npm run tauri dev
```

## Instalacao macOS via terminal

Sem assinatura/notarizacao Apple, o DMG pode ser bloqueado pelo Gatekeeper como app nao verificado. Para instalar em Macs de teste, use o instalador via terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash
```

### CLI do instalador macOS

O script `install/macos.sh` e o CLI de instalacao para macOS. Ele aceita a versao/tag como primeiro argumento posicional; quando omitida, usa a ultima release publicada:

```bash
curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash -s -- 2026.08.0
```

Para baixar o script antes de executar e ver o log detalhado:

```bash
curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh -o /tmp/client-wizard-install.sh
bash -x /tmp/client-wizard-install.sh 2026.08.0
```

O script baixa o asset `.app.tar.gz` da release de acordo com a arquitetura do Mac (`arm64` -> `aarch64`, `x86_64` -> `x64`), valida o `.sha256`, instala em `~/Applications`, remove a chave legada `LSRequiresCarbon` do `Info.plist`, aplica assinatura ad-hoc local, remove quarantine quando necessario e abre o app ao final.

Variaveis suportadas:

| Variavel | Padrao | Uso |
|---|---|---|
| `CLIENT_WIZARD_REPO` | `runvibe/client-wizard` | Repositorio GitHub de onde buscar releases. |
| `CLIENT_WIZARD_VERSION` | primeiro argumento ou `latest` | Tag da release a instalar. |
| `CLIENT_WIZARD_INSTALL_DIR` | `$HOME/Applications` | Diretorio onde o `.app` sera instalado. |
| `CLIENT_WIZARD_OPEN` | `1` | Use `0` para instalar sem abrir o app no final. |

Exemplos:

```bash
CLIENT_WIZARD_INSTALL_DIR="/Applications" curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash
```

```bash
CLIENT_WIZARD_OPEN=0 curl -fsSL https://raw.githubusercontent.com/runvibe/client-wizard/main/install/macos.sh | bash -s -- 2026.08.0
```

### CLI do app

Depois de instalado, o app tambem aceita inicializacao por manifesto pela linha de comando:

```bash
open "$HOME/Applications/Client Wizard.app" --args --manifest "https://wizard.example.com/manifest.json"
```

Esse modo e equivalente ao deep link `client-wizard://open?manifest=...`: ele preenche o manifesto e inicia o fluxo normal de consentimento.

## Dependencias Linux/WSL

No Linux, o Tauri compila contra WebKitGTK/JavaScriptCore do sistema. Se aparecer erro como `Package javascriptcoregtk-4.1 was not found`, instale os pacotes nativos:

### Ubuntu/Debian

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  wget \
  file \
  pkg-config \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev
```

### Arch Linux

```bash
sudo pacman -S --needed \
  base-devel \
  pkgconf \
  webkit2gtk-4.1 \
  gtk3 \
  libayatana-appindicator \
  librsvg
```

Depois rode novamente:

```bash
npm run tauri dev
```

Em WSL, use WSLg para abrir a janela do app. Para gerar binarios Windows, compile fora do WSL usando o toolchain Windows.

## Exemplo local

Com `npm run tauri dev`, carregue este manifesto na tela inicial:

```text
http://127.0.0.1:1420/sample/manifest.json
```

Ele aponta para `public\sample\wizard.js`, que cria um wizard via `clientWizard.useWizard()` e chama `clientWizard.invoke({ type: "systemInfo" })` apos a permissao `native:systemInfo` ser aprovada.

## Teste de pacote Ventoy

Para testar um fluxo mais completo, carregue:

```text
http://127.0.0.1:1420/tests/ventoy/manifest.json
```

Esse wizard identifica o sistema, consulta o ultimo release publico de `ventoy/Ventoy` no GitHub, escolhe o pacote compactado adequado (`windows.zip` ou `linux.tar.gz`) e solicita confirmacao antes de baixar e descompactar em uma pasta local de teste. Ele nao instala o Ventoy em disco/USB.

## Exemplo de manifesto

```json
{
  "name": "Meu Wizard",
  "description": "Assistente remoto renderizado pelo host.",
  "terms": {
    "markdown": "# Termos\n\nLeia e aceite para continuar."
  },
  "entry": {
    "type": "script",
    "url": "https://example.com/wizard.js"
  },
  "permissions": [
    {
      "id": "native:systemInfo",
      "title": "Ler informacoes do sistema",
      "description": "Permite consultar dados basicos do sistema operacional."
    }
  ]
}
```

## Proximo endurecimento recomendado

- Expandir o parser Safe MDX para todos os componentes previstos na spec.
- Persistir auditoria das execucoes.
- Separar ambientes de desenvolvimento e producao na politica de origem.
