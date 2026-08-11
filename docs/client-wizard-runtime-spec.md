# Client Wizard Runtime Spec

## 1. Objetivo

Client Wizard e um runtime desktop Tauri/Rust que carrega um script JavaScript orquestrador confiavel e permite que esse script controle telas renderizadas pelo host, estado reativo local e comandos nativos controlados.

O script remoto decide o fluxo. O host Tauri renderiza a UI com componentes locais permitidos. O Rust executa recursos nativos sob politica de permissao default-deny.

## 2. Decisoes de arquitetura

### 2.1 Modelo de surface

O runtime tem **uma surface ativa por janela**.

- `clientWizard.useMarkdown(...)` substitui a surface ativa por uma tela Markdown/MDX.
- `clientWizard.useWizard(...)` substitui a surface ativa por um wizard.
- Criar uma nova surface invalida a anterior.
- Cada surface recebe um `surfaceId`.
- O storage e escopado ao `surfaceId`.
- Handles antigos passam a rejeitar chamadas com erro `surface_destroyed`.

Esse modelo evita concorrencia visual e simplifica o roteamento de eventos.

### 2.2 API publica pequena

```ts
clientWizard.useMarkdown(markdown): ScreenHandle
clientWizard.useWizard(wizard): WizardHandle
clientWizard.invoke(command): Promise<ExecutorResult>
```

Nao existe `useMdx`. O renderer interno aceita um subconjunto seguro de Markdown/MDX.

Nao existe `progressive(name, value)`. Componentes como `ProgressiveBar` leem valores do storage reativo.

### 2.3 Renderer seguro, nao MDX completo

O formato aceito e chamado nesta spec de **Safe MDX**:

- Markdown comum.
- Componentes locais allowlisted.
- Atributos literais.
- Acesso restrito a `storage.<path>` em props.
- Sem `import`.
- Sem `export`.
- Sem chamadas de funcao.
- Sem operadores arbitrarios.
- Sem avaliacao de JavaScript livre.

Exemplo permitido:

```mdx
<Input name="clientName" label="Nome do cliente" value={storage.clientName} />
<ProgressiveBar name="installProgress" value={storage.installProgress} />
```

Exemplo proibido:

```mdx
import X from "./x"
<Input value={window.localStorage.token} />
<Input value={calculate()} />
```

### 2.4 Script orquestrador, nao pagina externa

O app nao carrega mais um HTML externo em iframe como superficie principal. O fluxo de entrada passa a ser:

```text
Usuario informa URL HTTPS do manifest.json
  -> host baixa somente o manifest.json
  -> host valida a estrutura do manifesto
  -> host baixa e prepara apenas documentos declarados em terms/license/privacy
  -> host apresenta termos de uso do manifesto, um documento por pagina
  -> usuario aceita cada termo de uso apresentado
  -> host apresenta uma tela com licencas e documentos de privacidade
  -> usuario marca cada licenca/documento de privacidade listado
  -> host apresenta permissoes solicitadas
  -> usuario marca cada permissao individualmente
  -> se algum documento exibido ou permissao obrigatoria nao for aceito, o fluxo nao continua
  -> host baixa o script ou zip declarado
  -> se for zip, host descompacta e localiza wizard.js
  -> host cria um runtime JS isolado
  -> host injeta a API clientWizard nesse runtime
  -> wizard.js/script chama useMarkdown/useWizard/invoke
  -> host renderiza a UI local React/shadcn
```

O script nao tem DOM proprio e nao injeta CSS global proprio. Toda UI visivel e composta pelo host com React + shadcn + preset configurado. Customizacao visual deve acontecer por **tokens de tema declarados no manifesto**, aplicados pelo host de forma escopada.

Implementacao recomendada para o runtime JS:

- **Web Worker dedicado** para o script orquestrador.
- SDK `clientWizard` injetado no worker antes do script do usuario.
- Comunicacao Worker <-> Host por `postMessage`.
- Sem acesso direto ao DOM do host.
- Sem `window.parent`, iframe ou HTML externo.

Fallback aceitavel em MVP: iframe oculto sandboxed apenas para executar o script. Mesmo nesse fallback, a UI externa nao deve ser exibida; o iframe e detalhe interno de execucao.

### 2.5 Manifesto de app

O app integra somente com endpoints HTTPS validos. A entrada principal e uma URL para `manifest.json`:

```text
https://wizard.example.com/manifest.json
```

Exemplo:

```json
{
  "name": "Instalador Acme",
  "description": "Configura o cliente Acme nesta maquina.",
  "terms": [
    "https://wizard.example.com/docs/terms.md"
  ],
  "license": [
    "https://wizard.example.com/docs/eula.md",
    "https://wizard.example.com/docs/third-party-licenses.md"
  ],
  "privacy": [
    "https://wizard.example.com/docs/privacy.md"
  ],
  "entry": {
    "type": "script",
    "url": "https://wizard.example.com/wizard.js"
  },
  "theme": {
    "mode": "light",
    "colors": {
      "background": "#ffffff",
      "foreground": "#111827",
      "primary": "#2563eb",
      "primaryForeground": "#ffffff",
      "muted": "#f3f4f6",
      "mutedForeground": "#6b7280",
      "border": "#e5e7eb",
      "destructive": "#dc2626"
    },
    "radius": {
      "sm": "6px",
      "md": "10px",
      "lg": "16px"
    },
    "font": {
      "family": "Inter",
      "headingFamily": "Inter",
      "size": "16px"
    },
    "spacing": {
      "page": "2em",
      "sectionGap": "24px",
      "fieldGap": "12px"
    },
    "layout": {
      "contentWidth": "full",
      "header": "inline",
      "surfacePadding": "2em"
    }
  },
  "permissions": [
    {
      "id": "ui.markdown",
      "label": "Renderizar telas",
      "description": "Permite que o script mostre telas Markdown/Safe MDX."
    },
    {
      "id": "native.systemInfo",
      "label": "Ler informacoes do sistema",
      "description": "Permite consultar sistema operacional, memoria e arquitetura."
    },
    {
      "id": "files.select",
      "label": "Selecionar arquivos",
      "description": "Permite abrir o seletor de arquivos quando solicitado."
    }
  ]
}
```

Entrada zip:

```json
{
  "name": "Instalador Acme",
  "description": "Configura o cliente Acme nesta maquina.",
  "terms": [
    "https://wizard.example.com/docs/terms.md"
  ],
  "license": [],
  "privacy": [],
  "entry": {
    "type": "zip",
    "url": "https://wizard.example.com/wizard.zip",
    "script": "wizard.js"
  },
  "permissions": [
    {
      "id": "ui.wizard",
      "label": "Renderizar wizard",
      "description": "Permite mostrar um fluxo de instalacao em etapas."
    }
  ]
}
```

### 2.6 Regras do manifesto

- A URL deve usar `https:`.
- `http://localhost` e `http://127.0.0.1` podem ser aceitos apenas em modo desenvolvimento.
- Nao ha assinatura obrigatoria.
- Nao ha checksum obrigatorio.
- O host deve baixar apenas o manifesto e os documentos declarados em `terms`, `license` e `privacy` antes do consentimento completo.
- O script ou zip so pode ser baixado depois que o usuario aceitar todos os documentos exibidos e marcar todas as permissoes obrigatorias.
- `entry.type = "script"` baixa e executa o JS informado em `entry.url`.
- `entry.type = "zip"` baixa, descompacta em cache temporario e executa `entry.script`, com default `wizard.js`.
- URLs dentro do manifesto tambem devem ser HTTPS validas.
- Redirecionamentos devem continuar em HTTPS ou ser rejeitados.
- `theme` e opcional. Quando ausente, o host usa o tema padrao do app.
- `theme` nao pode conter CSS livre, seletores, `url()`, imports ou scripts.

### 2.7 Consentimento, documentos e permissoes

Antes de baixar `entry.url`, o app deve executar o fluxo de consentimento nesta ordem:

1. Termos de uso declarados em `terms`.
2. Licencas e documentos de privacidade declarados em `license` e `privacy`.
3. Permissoes declaradas em `permissions`.

#### 2.7.1 Termos de uso

`terms` e opcional. Quando existir e tiver itens, o host deve apresentar **um termo por pagina**, na ordem declarada no manifesto.

Cada pagina de termo deve conter:

- nome do manifesto;
- nome do termo;
- origem/URL do documento;
- conteudo renderizado do documento;
- botao de aceite com o texto:

```text
Eu aceito os termos e condições de "NOME DO TERMO"
```

Nao deve haver checkbox na tela individual de termo. Clicar no botao marca aquele termo como aceito e avanca para o proximo termo. Depois do ultimo termo, o host avanca para a tela de licencas/privacidade ou, se ela nao existir, para permissoes.

O nome do termo deve ser resolvido nesta ordem:

1. primeiro titulo Markdown (`# Titulo`) encontrado no documento;
2. nome do arquivo da URL sem extensao;
3. host/origem da URL.

#### 2.7.2 Licencas e privacidade

`license` e `privacy` sao opcionais. Quando qualquer uma dessas listas tiver itens, o host deve apresentar uma tela unica contendo todos os documentos de licenca e privacidade.

Cada item deve mostrar:

- tipo do documento: `Licenca` ou `Privacidade`;
- nome resolvido do documento;
- URL/origem como link de leitura;
- checkbox individual.

O link de leitura deve abrir uma nova janela do app renderizando o documento como Markdown seguro, independentemente da extensao ou `Content-Type` original aceito pelo loader. A janela de leitura e somente para consulta; o aceite continua acontecendo na tela de lista por checkbox.

O botao de continuar fica desabilitado ate que todos os documentos listados nessa tela estejam marcados. Se `license` e `privacy` estiverem ausentes ou vazios, essa tela deve ser pulada.

#### 2.7.3 Permissoes

A tela de permissoes deve aparecer depois dos documentos. Ela deve conter:

- nome do app;
- descricao;
- origem do manifesto;
- tipo de entrada (`script` ou `zip`);
- lista de permissoes solicitadas;
- checkbox individual para cada permissao obrigatoria.

O usuario precisa marcar individualmente cada permissao obrigatoria. Se algum documento exibido ou qualquer permissao obrigatoria ficar sem aceite:

- o botao de continuar fica desabilitado; ou
- ao tentar continuar, o app informa quais documentos ou permissoes faltam;
- o `entry.url` nao e baixado;
- nenhum script e executado.

Permissoes opcionais podem existir no futuro com `required: false`, mas a primeira versao deve tratar todas como obrigatorias.

Se `terms`, `license` e `privacy` estiverem ausentes ou vazios, o fluxo comeca diretamente na tela de permissoes.

### 2.8 Schema do manifesto

```ts
type ClientWizardManifest = {
  name: string;
  description: string;
  terms?: string[];
  license?: string[];
  privacy?: string[];
  entry:
    | {
        type: "script";
        url: string;
      }
    | {
        type: "zip";
        url: string;
        script?: string;
      };
  theme?: ClientWizardTheme;
  permissions: Array<{
    id: string;
    label: string;
    description: string;
    required?: boolean;
  }>;
};
```

`terms`, `license` e `privacy` sao listas opcionais de URLs HTTPS. Nenhuma delas e obrigatoria. Cada item aponta para um documento Markdown/texto renderizado pelo host antes do download de `entry.url`.

Regras dos documentos:

- URLs remotas devem usar `https:`.
- `http://localhost` e `http://127.0.0.1` podem ser aceitos apenas em modo desenvolvimento.
- Redirecionamentos devem continuar em HTTPS ou ser rejeitados.
- O host deve aceitar `text/markdown`, `text/plain` e equivalentes configurados.
- O conteudo deve ser renderizado pelo renderer Markdown seguro do host, sem componentes interativos.
- Links dentro dos documentos devem abrir evento/confirmacao controlada pelo host, nunca navegar automaticamente dentro da janela principal.
- Falha ao baixar ou validar qualquer documento declarado deve bloquear o fluxo com erro claro.

### 2.9 Customizacao visual por manifesto

O manifesto pode declarar `theme` para customizar o visual basico do wizard sem permitir CSS arbitrario. O objetivo e permitir marca, cores, raio de borda, tipografia, espacamento e algumas decisoes de layout, mantendo:

- UI renderizada pelo host;
- acessibilidade controlada pelo host;
- botoes de consentimento e permissao sempre visiveis;
- isolamento entre wizards;
- compatibilidade com componentes shadcn.

#### 2.9.1 Principio

`theme` e uma lista de **design tokens**, nao uma folha CSS livre.

O host valida os tokens, normaliza valores e aplica somente variaveis CSS escopadas no container do app/wizard aprovado.

```text
manifest.theme -> validação -> normalização -> CSS variables escopadas -> componentes host
```

O script remoto nao recebe API para alterar tokens globais em tempo de execucao na primeira versao. Atualizacoes dinamicas de tema podem ser adicionadas no futuro como uma mensagem controlada, mas devem seguir as mesmas regras de validacao.

#### 2.9.2 Schema

```ts
type ClientWizardTheme = {
  mode?: "light" | "dark" | "system";
  colors?: {
    background?: string;
    foreground?: string;
    primary?: string;
    primaryForeground?: string;
    secondary?: string;
    secondaryForeground?: string;
    muted?: string;
    mutedForeground?: string;
    accent?: string;
    accentForeground?: string;
    border?: string;
    input?: string;
    ring?: string;
    destructive?: string;
    destructiveForeground?: string;
  };
  radius?: {
    sm?: CssLengthToken;
    md?: CssLengthToken;
    lg?: CssLengthToken;
    xl?: CssLengthToken;
  };
  font?: {
    family?: FontFamilyToken;
    headingFamily?: FontFamilyToken;
    size?: CssLengthToken;
    headingWeight?: 400 | 500 | 600 | 700;
    bodyWeight?: 400 | 500 | 600;
  };
  spacing?: {
    page?: CssLengthToken;
    surfacePadding?: CssLengthToken;
    sectionGap?: CssLengthToken;
    fieldGap?: CssLengthToken;
    controlHeight?: CssLengthToken;
  };
  layout?: {
    contentWidth?: "full" | "readable" | "compact";
    header?: "none" | "inline" | "sticky";
    alignment?: "start" | "center";
  };
};

type CssLengthToken = `${number}px` | `${number}rem` | `${number}em`;
type FontFamilyToken = string;
```

#### 2.9.3 Exemplo completo

```json
{
  "theme": {
    "mode": "light",
    "colors": {
      "background": "#ffffff",
      "foreground": "#111827",
      "primary": "#2563eb",
      "primaryForeground": "#ffffff",
      "muted": "#f3f4f6",
      "mutedForeground": "#6b7280",
      "border": "#e5e7eb",
      "ring": "#93c5fd",
      "destructive": "#dc2626"
    },
    "radius": {
      "sm": "6px",
      "md": "10px",
      "lg": "16px"
    },
    "font": {
      "family": "Inter",
      "headingFamily": "Inter",
      "size": "16px",
      "headingWeight": 600,
      "bodyWeight": 400
    },
    "spacing": {
      "page": "2em",
      "surfacePadding": "2em",
      "sectionGap": "24px",
      "fieldGap": "12px",
      "controlHeight": "40px"
    },
    "layout": {
      "contentWidth": "full",
      "header": "inline",
      "alignment": "start"
    }
  }
}
```

#### 2.9.4 Mapeamento para CSS variables

O host deve aplicar os tokens em um wrapper escopado, por exemplo:

```html
<main data-client-wizard-theme>
  ...
</main>
```

Mapeamento inicial:

| Manifest token | CSS variable host |
|---|---|
| `colors.background` | `--background` |
| `colors.foreground` | `--foreground` |
| `colors.primary` | `--primary` |
| `colors.primaryForeground` | `--primary-foreground` |
| `colors.secondary` | `--secondary` |
| `colors.secondaryForeground` | `--secondary-foreground` |
| `colors.muted` | `--muted` |
| `colors.mutedForeground` | `--muted-foreground` |
| `colors.accent` | `--accent` |
| `colors.accentForeground` | `--accent-foreground` |
| `colors.border` | `--border` |
| `colors.input` | `--input` |
| `colors.ring` | `--ring` |
| `colors.destructive` | `--destructive` |
| `colors.destructiveForeground` | `--destructive-foreground` |
| `radius.sm` | `--wizard-radius-sm` |
| `radius.md` | `--wizard-radius-md` |
| `radius.lg` | `--wizard-radius-lg` |
| `radius.xl` | `--wizard-radius-xl` |
| `font.family` | `--wizard-font-family` |
| `font.headingFamily` | `--wizard-font-heading-family` |
| `font.size` | `--wizard-font-size` |
| `spacing.page` | `--wizard-page-padding` |
| `spacing.surfacePadding` | `--wizard-surface-padding` |
| `spacing.sectionGap` | `--wizard-section-gap` |
| `spacing.fieldGap` | `--wizard-field-gap` |
| `spacing.controlHeight` | `--wizard-control-height` |

As variaveis shadcn existentes continuam como contrato visual principal. Variaveis `--wizard-*` servem para layout especifico do runtime.

#### 2.9.5 Regras de validacao

O host deve rejeitar o manifesto se `theme` contiver valores invalidos.

Regras:

- Cores aceitas:
  - hex `#rgb`, `#rrggbb`;
  - `rgb(...)` e `hsl(...)` podem ser permitidos somente se parser seguro validar componentes numericos;
  - nomes CSS livres (`red`, `transparent`, etc.) devem ser evitados na primeira versao.
- Comprimentos aceitos:
  - unidades `px`, `rem`, `em`;
  - valores dentro de limites configurados pelo host.
- Fontes:
  - strings simples de familia;
  - sem `url(...)`;
  - sem `@import`;
  - sem carregamento remoto automatico na primeira versao.
- `layout.contentWidth` aceita somente enum documentado.
- `layout.header` aceita somente enum documentado.
- Propriedades desconhecidas devem ser ignoradas ou rejeitadas conforme modo de validacao. Para producao, preferir rejeitar com erro claro.

Limites recomendados:

| Token | Min | Max |
|---|---:|---:|
| `font.size` | `12px` | `22px` |
| `spacing.page` | `0px` | `64px` |
| `spacing.surfacePadding` | `0px` | `64px` |
| `spacing.sectionGap` | `0px` | `64px` |
| `spacing.fieldGap` | `0px` | `32px` |
| `spacing.controlHeight` | `28px` | `64px` |
| `radius.*` | `0px` | `32px` |

#### 2.9.6 Seguranca e UX

`theme` nao pode:

- esconder termos de uso;
- esconder permissoes;
- reposicionar botoes de consentimento para fora da tela;
- aplicar `position`, `z-index`, `display`, `visibility`, `opacity` ou transforms arbitrarios;
- carregar imagens, fontes ou CSS remotos;
- alterar elementos fora do escopo do wizard;
- afetar dialogs de seguranca do host, salvo tokens basicos de cor/tipografia aprovados.

Telas de consentimento podem usar o tema do manifesto parcialmente para preview de marca, mas os controles criticos de permissao devem preservar contraste minimo, foco visivel e legibilidade definidos pelo host.

#### 2.9.7 Folha de estilo externa

CSS externo livre nao faz parte do MVP.

Uma extensao futura pode permitir `theme.stylesheet`, mas apenas se o host implementar sanitizacao e escopo rigorosos:

```ts
type ClientWizardThemeStylesheet = {
  url: string;
  scope: "surface";
  integrity?: string;
  allowedProperties?: Array<
    | "color"
    | "background-color"
    | "border-color"
    | "border-radius"
    | "font-family"
    | "font-size"
    | "font-weight"
    | "gap"
    | "padding"
    | "margin"
  >;
};
```

Regras para essa extensao futura:

- `url` deve ser HTTPS.
- O CSS deve ser baixado e parseado pelo host, nao injetado como `<link>` direto.
- Seletores devem ser reescritos para o escopo da surface.
- Propriedades fora da allowlist devem ser removidas.
- `@import`, `url(...)`, animation arbitraria, positionamento e z-index devem ser proibidos.
- A folha externa tambem so pode ser baixada apos consentimento, junto com o artefato, nunca antes.

## 3. API JavaScript

### 3.1 `clientWizard.useMarkdown(markdown)`

Recebe somente uma string Markdown/Safe MDX.

```js
const screen = clientWizard.useMarkdown(`
# Configuracao

<Input name="clientName" label="Nome do cliente" value={storage.clientName} />

<SelectFile name="installer" label="Selecione o instalador" />

<ProgressiveBar name="installProgress" value={storage.installProgress} />

[Opcao 1]({"value":1})
`);

screen.events((eventName, data) => {
  console.log(eventName, data);
});

await screen.setStorage({
  clientName: "Acme",
  installProgress: 33
});
```

`useMarkdown` nao possui botoes `prev` ou `next`.

### 3.2 `clientWizard.useWizard(wizard)`

Recebe steps. Cada step possui Markdown/Safe MDX e configuracao propria dos botoes de navegacao.

```js
const wizard = clientWizard.useWizard({
  initialStep: 0,
  steps: [
    {
      id: "client",
      markdown: "# Cliente\n<Input name=\"clientName\" label=\"Cliente\" value={storage.clientName} />",
      btnPrev: "none",
      btnNext: "enabled"
    },
    {
      id: "install",
      markdown: "# Instalacao\n<ProgressiveBar name=\"installProgress\" value={storage.installProgress} />",
      btnPrev: "enabled",
      btnNext: "disabled"
    }
  ]
});

wizard.events((eventName, data) => {
  console.log(eventName, data);
});
```

### 3.3 `clientWizard.invoke(command)`

Solicita execucao nativa ao Rust.

```js
const result = await clientWizard.invoke({
  type: "systemInfo"
});
```

`runScript` deve ser default-deny ate que o manifesto declare a permissao e o usuario a aceite explicitamente.

## 4. Handles

### 4.1 `ScreenHandle`

```ts
type ScreenHandle = {
  id: string;
  events(callback: (eventName: string, data: unknown) => void): () => void;
  setStorage(patch: Record<string, unknown>): Promise<void>;
  getStorage(): Promise<Record<string, unknown>>;
  openDialog(dialog: DialogDefinition): Promise<DialogResult>;
  update(markdown: string): Promise<void>;
  destroy(): Promise<void>;
};
```

### 4.2 `WizardHandle`

```ts
type WizardHandle = {
  id: string;
  events(callback: (eventName: string, data: unknown) => void): () => void;
  setStorage(patch: Record<string, unknown>): Promise<void>;
  getStorage(): Promise<Record<string, unknown>>;
  openDialog(dialog: DialogDefinition): Promise<DialogResult>;
  update(wizard: WizardDefinition): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  goTo(step: number | string): Promise<void>; // indice ou id do step
  destroy(): Promise<void>;
};
```

### 4.3 Dialogs

`openDialog()` abre um dialog modal renderizado pelo host. Ele deve ser usado para confirmacoes, avisos bloqueantes e decisoes que precisam interromper o fluxo atual.

```js
const result = await screen.openDialog({
  title: "Executar instalador?",
  description: "O wizard vai iniciar o processo de instalacao local.",
  confirmText: "Executar",
  cancelText: "Cancelar",
  variant: "default"
});

if (result.action === "confirm") {
  await clientWizard.invoke({ type: "systemInfo" });
}
```

Tipo:

```ts
type DialogDefinition = {
  title: string;
  description?: string;
  markdown?: string;
  confirmText?: string;
  cancelText?: string;
  showCancel?: boolean;
  variant?: "default" | "destructive";
  data?: unknown;
};

type DialogResult = {
  action: "confirm" | "cancel" | "dismiss";
  data?: unknown;
};
```

Regras:

- `title` e obrigatorio para acessibilidade.
- `description` e texto simples; `markdown` pode ser usado quando o corpo precisar de formatacao Safe MDX.
- `confirmText` padrao: `"OK"`.
- `cancelText` padrao: `"Cancelar"`.
- `showCancel` padrao: `true`.
- Fechar o dialog pela tecla Esc ou botao de fechar retorna `action: "dismiss"`.
- O dialog pertence ao mesmo `surfaceId`; destruir a surface fecha dialogs abertos.

### 4.4 Ciclo de vida

- `useMarkdown` e `useWizard` retornam um handle imediatamente.
- O SDK gera `surfaceId` no cliente antes de enviar a mensagem ao host.
- O mesmo `surfaceId` identifica eventos, storage e operacoes futuras.
- `destroy()` invalida o handle e remove callbacks registrados.
- Criar nova surface tambem invalida a anterior.

## 5. Storage reativo

Cada surface tem uma arvore local chamada `storage`.

```js
await screen.setStorage({
  clientName: "Acme",
  installProgress: 33,
  installer: null
});
```

No Safe MDX:

```mdx
<Input name="clientName" label="Nome do cliente" value={storage.clientName} />
<ProgressiveBar name="installProgress" value={storage.installProgress} />
```

### 5.1 Regras

- `setStorage(patch)` faz merge raso por padrao.
- Chave com valor `undefined` e ignorada.
- Chave com valor `null` remove ou limpa semanticamente o valor, conforme o componente:
  - Em componentes de formulario, `null` vira vazio.
  - Em dados livres, `null` fica armazenado como `null`.
- Componentes re-renderizam quando paths usados em props mudam.
- Interacoes de componentes com `name` atualizam automaticamente `storage[name]`.
- Toda mudanca gerada pelo usuario dispara evento.

### 5.2 Espelho local no SDK

O SDK pode manter um espelho local de storage para conveniencia, mas a fonte de verdade e o host.

```js
const current = await screen.getStorage();
```

## 6. Componentes Safe MDX

### 6.1 Allowlist inicial

| Componente | Props principais | Evento |
|---|---|---|
| `Input` | `name`, `label`, `value`, `placeholder`, `type` | `input.change` |
| `Textarea` | `name`, `label`, `value`, `placeholder` | `textarea.change` |
| `Checkbox` | `name`, `label`, `checked` | `checkbox.change` |
| `WizardCheckbox` | `name`, `label` | atualiza `storage[name]` |
| `Select` | `name`, `label`, `value`, `options` | `select.change` |
| `SelectFile` | `name`, `label`, `multiple`, `accept` | `file.select` |
| `ProgressiveBar` | `name`, `value` | nenhum por padrao |
| `Button` | `action`, `children` | `button.click` |
| `Alert` | `variant`, `title`, `children` | nenhum |
| `Image` | `src`, `alt`, `caption` | `media.load`, `media.error` |
| `Video` | `src`, `title`, `controls`, `poster` | `media.play`, `media.pause`, `media.error` |

`Alert` e apenas um componente visual inline. Confirmacoes e interrupcoes de fluxo devem usar `screen.openDialog()` ou `wizard.openDialog()`.

### 6.4 Imagens

Markdown padrao de imagem deve renderizar pelo componente host `Image`:

```md
![Logo do cliente](https://example.com/logo.png)
```

Safe MDX tambem pode usar `Image` explicitamente:

```mdx
<Image src="https://example.com/logo.png" alt="Logo do cliente" caption="Cliente validado" />
```

Regras:

- `alt` e obrigatorio quando usar `<Image />`.
- Markdown `![alt](src)` usa o texto alternativo do Markdown.
- Esquemas permitidos: `https:`, `http:` para desenvolvimento local, e assets de pacote validado/cacheado.
- `data:image/*` pode ser permitido somente com limite de tamanho configurado pelo host.
- `file:` e proibido para conteudo externo.
- Falha de carregamento dispara `media.error`.

### 6.5 Videos

Videos devem usar componente Safe MDX explicito:

```mdx
<Video src="https://example.com/demo.mp4" title="Demonstração do fluxo" controls />
```

Regras:

- Markdown puro nao possui sintaxe de video; portanto video sempre usa `<Video />`.
- `title` e obrigatorio para acessibilidade.
- `controls` deve ser `true` por padrao.
- `autoplay` e proibido por padrao.
- Esquemas permitidos: `https:`, `http:` para desenvolvimento local, e assets de pacote validado/cacheado.
- `file:` e `data:` sao proibidos para video.
- Eventos `media.play` e `media.pause` devem incluir `{ name?, src, currentTime, duration }`.

### 6.2 Componentes desconhecidos

Componentes desconhecidos renderizam um erro controlado e disparam evento:

```js
{
  eventName: "render.error",
  data: {
    component: "Foo",
    reason: "unknown-component"
  }
}
```

### 6.3 `SelectFile`

`SelectFile` deve abrir dialog nativo via Rust/Tauri.

Evento:

```ts
type FileSelectEvent = {
  name: string;
  files: Array<{
    path: string;
    name: string;
    size?: number;
  }>;
};
```

O componente atualiza `storage[name]` com:

- objeto unico quando `multiple !== true`;
- array quando `multiple === true`.

## 7. Links Markdown

Links Markdown viram eventos; o host nao navega automaticamente.

### 7.1 Link normal

```md
[Abrir site](https://example.com)
```

Evento:

```js
{
  eventName: "link",
  data: { href: "https://example.com" }
}
```

### 7.2 Link com JSON

```md
[Opcao 1]({"value":1})
```

Evento:

```js
{
  eventName: "option",
  data: { value: 1 }
}
```

O parser deve aceitar JSON cru ou percent-encoded:

```md
[Opcao 1](%7B%22value%22%3A1%7D)
```

### 7.3 Sanitizacao

Esquemas permitidos para links normais:

- `https:`
- `http:`
- `mailto:`

Esquemas proibidos:

- `javascript:`
- `data:`
- `file:`

Links relativos podem ser emitidos como:

```js
{ href: "/path", relative: true }
```

## 8. Wizard

### 8.1 Tipo publico

```ts
type WizardDefinition = {
  initialStep?: number | string;
  steps: Array<{
    id?: string;
    markdown: string;
    btnPrev?: "enabled" | "disabled" | "none";
    btnNext?: "enabled" | "disabled" | "none";
    btnNextWhen?: string; // path no storage que habilita o botao Avancar
  }>;
};
```

`id` e opcional, mas recomendado sempre que o script precisar navegar programaticamente. `wizard.goTo("done")` deve ativar o step com `id: "done"`; `wizard.goTo(2)` deve ativar pelo indice.

`btnNextWhen` permite manter o botao **Avancar** desabilitado ate que um valor do storage seja verdadeiro. Exemplo: `btnNext: "disabled"` com `btnNextWhen: "termsAccepted"` habilita o botao quando o script chama `wizard.setStorage({ termsAccepted: true })`.

O host pode tolerar `desenabled` como alias de entrada para compatibilidade, mas o tipo publico deve documentar somente `disabled`.

### 8.2 Eventos de navegacao

```ts
type WizardNavigationEvent = {
  from: number;
  to: number;
  step: {
    id?: string;
    markdown: string;
  };
};
```

Eventos:

- `wizard.next`
- `wizard.prev`
- `wizard.goTo`

### 8.3 Links em Markdown

Links em Markdown seguem duas regras:

- links dinamicos sao links cujo `href` decodificado começa com `{` e devem ser enviados ao callback `wizard.events`;
- links normais nao devem ser enviados ao callback.

Comportamento para links normais:

- URLs completas `http://` ou `https://` devem abrir no navegador padrao do usuario;
- links locais para arquivos `.md` devem ser carregados e renderizados como Markdown pelo host;
- outros formatos locais devem ser ignorados ou bloqueados ate haver uma regra explicita.

Exemplo de link dinamico:

```md
[Aceitar termos](%7B%22action%22%3A%22acceptTerms%22%7D)
```

Exemplo de link normal:

```md
[Repositorio](https://github.com/runvibe/client-wizard)
[Licenca](./LICENSE.md)
```

## 9. Protocolo canonico

Todas as mensagens do runtime de script para o host usam:

```ts
type ClientWizardRequest = {
  source: "client-wizard-script";
  requestId: string;
  surfaceId?: string;
  type: ClientWizardRequestType;
  payload?: unknown;
};
```

Tipos:

```ts
type ClientWizardRequestType =
  | "native.invoke"
  | "screen.create"
  | "screen.update"
  | "screen.destroy"
  | "screen.storage.patch"
  | "screen.storage.get"
  | "surface.dialog.open"
  | "wizard.create"
  | "wizard.update"
  | "wizard.next"
  | "wizard.prev"
  | "wizard.goTo";
```

### 9.1 Tabela de mensagens

| Metodo SDK | type | payload | result |
|---|---|---|---|
| `useMarkdown(markdown)` | `screen.create` | `{ surfaceId, markdown }` | `{ surfaceId }` |
| `screen.update(markdown)` | `screen.update` | `{ markdown }` | `{ ok: true }` |
| `screen.destroy()` | `screen.destroy` | `{}` | `{ ok: true }` |
| `screen.setStorage(patch)` | `screen.storage.patch` | `{ patch }` | `{ storage }` |
| `screen.getStorage()` | `screen.storage.get` | `{}` | `{ storage }` |
| `screen.openDialog(dialog)` | `surface.dialog.open` | `{ dialog }` | `DialogResult` |
| `useWizard(wizard)` | `wizard.create` | `{ surfaceId, wizard }` | `{ surfaceId }` |
| `wizard.update(wizard)` | `wizard.update` | `{ wizard }` | `{ ok: true }` |
| `wizard.next()` | `wizard.next` | `{}` | `{ index, step }` |
| `wizard.prev()` | `wizard.prev` | `{}` | `{ index, step }` |
| `wizard.goTo(step)` | `wizard.goTo` | `{ step }` | `{ index, step }` |
| `wizard.openDialog(dialog)` | `surface.dialog.open` | `{ dialog }` | `DialogResult` |
| `clientWizard.invoke(command)` | `native.invoke` | `{ command }` | `ExecutorResult` |

### 9.2 Resposta

```ts
type ClientWizardResponse = {
  source: "client-wizard-host";
  requestId: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};
```

### 9.3 Eventos

```ts
type ClientWizardEvent = {
  source: "client-wizard-host";
  type: "ui-event";
  surfaceId: string;
  eventName: string;
  data: unknown;
};
```

O campo canonico e `surfaceId`, nao `id`.

## 10. Segurança de script

### 10.1 Origem e identidade do app

Ao carregar o manifesto, o host registra a identidade:

```ts
manifestOrigin = new URL(manifestUrl).origin
scriptOrigin = new URL(scriptUrl).origin
```

O host deve rejeitar mensagens de runtime que nao estejam associadas ao `runtimeId` ativo criado para esse app aprovado.

```ts
message.runtimeId !== activeRuntimeId
```

### 10.2 Validacao HTTPS e consentimento

Antes de baixar qualquer recurso alem do manifesto:

- `manifestUrl` deve ser parseavel por `new URL(...)`.
- O protocolo do manifesto deve ser `https:`.
- Excecoes `http://localhost` e `http://127.0.0.1` sao permitidas somente em modo desenvolvimento.
- O `Content-Type` esperado do manifesto e JSON: `application/json` ou equivalente configurado.
- O manifesto deve conter `name`, `description`, `entry` e `permissions`.
- `terms`, `license` e `privacy` sao opcionais.
- O app deve baixar, validar e exibir os documentos declarados antes de baixar `entry.url`.
- O usuario deve aceitar cada termo de uso declarado.
- O usuario deve marcar todas as licencas e documentos de privacidade declarados.
- O usuario deve aceitar cada permissao obrigatoria individualmente.
- Sem consentimento completo de documentos e permissoes, o host nao baixa script, nao baixa zip e nao cria runtime.

Antes de executar o script:

- `entry.url` deve ser HTTPS valido.
- Redirecionamentos de `entry.url` devem continuar em `https:` ou ser rejeitados.
- Para `entry.type = "script"`, o `Content-Type` esperado e JavaScript: `application/javascript`, `text/javascript` ou equivalente configurado.
- Para `entry.type = "zip"`, o `Content-Type` esperado e zip: `application/zip`, `application/octet-stream` ou equivalente configurado.
- Zip deve ser descompactado com protecao contra zip-slip.
- O arquivo de entrada do zip deve ser `entry.script` ou `wizard.js`.

### 10.3 Respostas

Quando o runtime for Worker, respostas usam `worker.postMessage(response)` para o worker ativo associado ao `runtimeId`.

Quando houver fallback por iframe oculto, o host nunca deve responder com `targetOrigin: "*"`. Nesse caso, usar a origem do manifesto/script aprovado.

### 10.4 SDK unico

O mecanismo canonico e um SDK injetado pelo host no runtime de script usando `source: "client-wizard-script"`.

Pontes legadas injetadas em HTML externo com `source: "client-wizard-package"` ou `source: "client-wizard-page"` devem ser removidas ou adaptadas para o protocolo de script antes de producao.

## 11. Comandos nativos

### 11.1 Resultado padrao

```ts
type ExecutorResult = {
  ok: boolean;
  code?: number;
  stdout: string;
  stderr: string;
};
```

### 11.2 Comandos iniciais

```ts
type NativeCommand =
  | { type: "systemInfo" }
  | { type: "processList" }
  | {
      type: "runScript";
      shell: "powershell" | "bash" | "sh";
      script: string;
      args?: string[];
    };
```

### 11.3 Politica default-deny

- `systemInfo`: permitido somente quando a permissao correspondente foi aceita no manifesto.
- `processList`: permitido somente quando a permissao correspondente foi aceita no manifesto.
- `runScript`: bloqueado por padrao.
- `runScript` exige permissao declarada no manifesto e aceita individualmente pelo usuario antes da primeira implementacao de producao.

Exemplo futuro:

```json
{
  "manifest": "https://wizard.example.com/manifest.json",
  "permissions": {
    "native": ["systemInfo"],
    "scripts": [
      {
        "id": "install-agent",
        "shell": "powershell"
      }
    ]
  }
}
```

## 12. SDK do runtime de script

### 12.1 Uso

O script remoto nao importa o SDK por tag HTML. O host injeta `clientWizard` no runtime antes de executar o script.

Script remoto:

```js
const screen = clientWizard.useMarkdown(`
# Configuracao

<Input name="clientName" label="Nome do cliente" value={storage.clientName} />
`);

screen.events((eventName, data) => {
  console.log(eventName, data);
});
```

### 12.2 Comportamento esperado

- Expor `clientWizard` no escopo do runtime do script.
- Gerar `requestId` por chamada.
- Gerar `surfaceId` por handle.
- Resolver promises com `result`.
- Rejeitar promises com `error`.
- Roteiar `ui-event` por `surfaceId`.
- `events(callback)` retorna unsubscribe.
- `destroy()` remove callbacks locais.

## 13. Roadmap

### Fase 1: protocolo seguro e SDK

- Implementar protocolo canonico da secao 9.
- Implementar loader de manifest.json HTTPS.
- Validar estrutura do manifesto.
- Validar `theme` do manifesto quando presente.
- Renderizar termos de uso declarados em `terms`, um documento por pagina.
- Renderizar licencas e documentos de privacidade declarados em `license` e `privacy`, com checkbox individual.
- Exigir aceite de todos os documentos declarados antes de permissões.
- Exigir checkbox individual para cada permissao obrigatoria.
- Bloquear download de `entry.url` ate consentimento completo de documentos e permissoes.
- Implementar download de script direto.
- Implementar download/descompactacao segura de zip com entrada `wizard.js`.
- Rejeitar endpoints nao HTTPS, exceto localhost em desenvolvimento.
- Aplicar tokens de tema escopados no runtime visual.
- Criar runtime JS isolado.
- Injetar SDK no runtime.
- Remover protocolo legado `render-markdown`, `render-wizard`, `progressive`.
- Remover iframe visivel de pagina externa.
- Implementar handles reais.

### Fase 2: storage reativo

- Storage por `surfaceId`.
- `setStorage`, `getStorage`.
- Re-render por paths usados em props.
- Eventos de mudanca.

### Fase 3: Safe MDX

- Parser restrito.
- Allowlist de componentes.
- Props com literais e `storage.<path>`.
- Erros de render controlados.

### Fase 4: componentes locais

- `Input`
- `Textarea`
- `Checkbox`
- `Select`
- `SelectFile`
- `ProgressiveBar`
- `Button`
- `Alert`
- `Image`
- `Video`
- `openDialog()` nos handles

### Fase 5: wizard

- `btnPrev` e `btnNext`.
- `next`, `prev`, `goTo`.
- Eventos de navegacao.
- Storage compartilhado entre steps do mesmo wizard.

### Fase 6: comandos nativos

- Catalogo de comandos.
- Politica por manifesto e permissao aceita pelo usuario.
- Auditoria.

### Fase 7: auditoria local e busca

- Registrar eventos do runtime em IndexedDB.
- Registrar manifesto, consentimentos, permissoes, chamadas SDK, eventos UI, storage, dialogs e comandos nativos.
- Criar tela de Auditoria acessivel pela barra/menu nativo do app.
- Implementar busca textual local.
- Implementar busca semantica local/opcional sobre eventos auditados.
- Implementar exportacao CSV dos eventos filtrados.

## 14. Auditoria local

### 14.1 Objetivo

O Client Wizard deve manter um historico local de tudo que aconteceu no app durante a execucao de wizards. Esse historico serve para:

- diagnostico;
- auditoria de seguranca;
- suporte ao usuario;
- rastreabilidade de permissoes;
- investigacao de comandos nativos executados;
- busca textual e semantica sobre eventos.

O armazenamento inicial deve ser **IndexedDB** no frontend do app.

### 14.2 Escopo de captura

Tudo que passar pelo runtime e pelas funcoes publicas deve gerar evento de auditoria.

Eventos obrigatorios:

| Area | Exemplos |
|---|---|
| Manifesto | URL informada, manifesto carregado, validacao, erro de schema |
| Consentimento | aceite do termo, permissao marcada/desmarcada, tentativa bloqueada |
| Artefato | download iniciado, download concluido, falha, zip aberto, script localizado |
| Runtime | worker criado, worker encerrado, erro de script |
| SDK | `useMarkdown`, `useWizard`, `setStorage`, `getStorage`, `openDialog`, `invoke` |
| Surface | criada, atualizada, destruida |
| Wizard | step atual, prev, next, goTo |
| UI events | link, option, button click, input change, file select, media events |
| Storage | patch aplicado, leitura solicitada |
| Dialog | dialog aberto, confirmado, cancelado, dispensado |
| Native | comando solicitado, permissao validada, resultado, erro |
| Render | erro Safe MDX, componente desconhecido, media error |
| Security | origem rejeitada, permissao negada, URL invalida, payload bloqueado |

### 14.3 Modelo de dados

```ts
type AuditLevel = "debug" | "info" | "warning" | "error" | "security";

type AuditCategory =
  | "manifest"
  | "permission"
  | "artifact"
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

type AuditEvent = {
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
```

`sessionId` e criado quando o usuario carrega um manifesto. Um novo manifesto gera nova sessao de auditoria.

`searchableText` deve ser uma versao textual normalizada de:

- `summary`;
- `category`;
- `action`;
- `manifestName`;
- erro;
- partes seguras de `input` e `output`.

### 14.4 IndexedDB

Banco:

```text
clientWizardAudit
```

Stores:

```text
sessions
events
semanticIndex
```

Schema sugerido:

```ts
type AuditSession = {
  id: string;
  manifestUrl: string;
  manifestName?: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
};

type SemanticIndexEntry = {
  id: string;
  eventId: string;
  sessionId: string;
  text: string;
  vector?: number[];
  tokens?: string[];
  createdAt: string;
};
```

Indices obrigatorios:

| Store | Indices |
|---|---|
| `sessions` | `startedAt`, `manifestUrl`, `status` |
| `events` | `sessionId`, `timestamp`, `level`, `category`, `action`, `runtimeId`, `surfaceId` |
| `semanticIndex` | `eventId`, `sessionId`, `createdAt` |

### 14.5 Sanitizacao

Auditoria nao pode virar vazamento de dados sensiveis.

Configuracao:

```ts
type AuditConfig = {
  enabled: boolean;
  capturePayloads: "none" | "safe" | "full";
  retentionDays: number;
  semanticSearch: "off" | "local-basic" | "local-embedding" | "remote-embedding";
};
```

Padrao:

```json
{
  "enabled": true,
  "capturePayloads": "safe",
  "retentionDays": 30,
  "semanticSearch": "local-basic"
}
```

Regras:

- `runScript.script` deve ser redigido ou resumido por hash quando `capturePayloads = "safe"`.
- Paths locais podem ser redigidos para preservar somente nome de arquivo quando necessario.
- Tokens, senhas, secrets e headers sensiveis devem ser mascarados.
- Payloads muito grandes devem ser truncados.
- Exportacao CSV usa os dados ja sanitizados.

### 14.6 API interna

```ts
type AuditLogger = {
  startSession(input: {
    manifestUrl: string;
    manifestName?: string;
  }): Promise<AuditSession>;

  endSession(sessionId: string, status: AuditSession["status"]): Promise<void>;

  log(event: Omit<AuditEvent, "id" | "timestamp" | "searchableText">): Promise<void>;

  search(query: AuditSearchQuery): Promise<AuditEvent[]>;

  exportCsv(query: AuditSearchQuery): Promise<string>;
};

type AuditSearchQuery = {
  query?: string;
  sessionId?: string;
  level?: AuditLevel;
  category?: AuditCategory;
  action?: string;
  from?: string;
  to?: string;
  semantic?: boolean;
};
```

### 14.7 Pontos de instrumentacao

O host deve chamar `AuditLogger.log()` nos pontos abaixo:

```text
submitManifest()
validateManifest()
permission checkbox change
startWizard()
loadEntryScript()
startWorker()
worker.onerror
handleRuntimeMessage()
postWorkerResult()
postWorkerError()
emitSurfaceEvent()
patchSurfaceStorage()
openDialog()
closeDialog()
assertNativePermission()
executeNative()
```

Eventos de baixo nivel podem ser agrupados quando necessario para reduzir ruido, mas eventos de seguranca e comandos nativos nunca devem ser omitidos.

### 14.8 Tela de Auditoria

A barra/menu nativo do app deve expor uma acao:

```text
Exibir > Auditoria
```

Ao acionar, o app abre a tela local de Auditoria.

Layout minimo:

```text
[Buscar...] [Sessao] [Categoria] [Nivel] [Periodo]        [Exportar CSV]

Timeline/lista de eventos

Detalhes do evento selecionado:
- summary
- timestamp
- category/action
- input sanitizado
- output sanitizado
- error
```

Filtros obrigatorios:

- texto livre;
- sessao;
- categoria;
- nivel;
- periodo.

### 14.9 Busca textual e semantica

#### Busca textual MVP

MVP deve implementar busca textual local usando `searchableText`.

Comportamento:

- case-insensitive;
- normalizacao basica de acentos;
- todos os termos digitados devem aparecer em `searchableText`;
- ordenar por timestamp desc por padrao.

#### Busca semantica

Busca semantica deve ser opcional e local por padrao.

Modos:

| Modo | Descricao |
|---|---|
| `off` | sem busca semantica |
| `local-basic` | tokenizacao/score local simples, sem embeddings |
| `local-embedding` | embeddings locais via modelo WASM/WebGPU |
| `remote-embedding` | endpoint HTTPS configurado pelo usuario/admin |

`remote-embedding` nao deve ser habilitado por padrao porque eventos podem conter dados sensiveis.

### 14.10 Exportacao CSV

A tela de Auditoria deve ter um botao:

```text
Exportar CSV
```

Comportamento:

- exporta os eventos atualmente filtrados na tela;
- gera CSV localmente a partir do IndexedDB;
- abre dialog nativo para salvar arquivo;
- nao envia dados para servidores externos;
- exporta somente dados sanitizados conforme `AuditConfig.capturePayloads`.

Nome sugerido:

```text
client-wizard-audit-YYYY-MM-DD-HHmmss.csv
```

Colunas:

```csv
id,sessionId,runtimeId,surfaceId,manifestUrl,manifestName,timestamp,level,category,action,summary,error,input,output
```

Regras de CSV:

- primeira linha contem cabeçalho;
- valores devem usar escape RFC 4180;
- `input` e `output` devem ser JSON serializado em uma celula;
- quebras de linha dentro de valores devem ser preservadas com aspas;
- erro vazio vira celula vazia;
- data usa ISO 8601.

Exemplo:

```csv
id,sessionId,runtimeId,surfaceId,manifestUrl,manifestName,timestamp,level,category,action,summary,error,input,output
evt_1,sess_1,run_1,surf_1,https://wizard.example.com/manifest.json,Instalador Acme,2026-08-10T21:51:03.000Z,info,native,systemInfo,Comando systemInfo executado,,,"{""ok"":true}"
```

## 15. APIs nativas de pacote

Operacoes de pacote devem ser separadas para permitir progresso real, auditoria precisa e consentimento granular.

### 15.1 `clientWizard.download(request, options?)`

Baixa um arquivo para uma pasta controlada pelo app.

Permissao obrigatoria:

- `native:download`

```ts
type DownloadRequest = {
  url: string;
  fileName?: string;
};

type DownloadResult = {
  path: string;
  fileName: string;
  bytes: number;
};
```

### 15.2 `clientWizard.extract(request, options?)`

Extrai um arquivo compactado previamente baixado para uma pasta controlada pelo app.

Permissao obrigatoria:

- `native:extract`

```ts
type ExtractRequest = {
  archivePath: string;
  destinationName?: string;
  format?: "zip" | "tar.gz" | "tgz";
  stripComponents?: number;
};

type ExtractResult = {
  destinationPath: string;
  files: number;
};
```

Formatos suportados inicialmente: `zip`, `tar.gz` e `tgz`.

### 15.3 Progresso

As duas APIs emitem progresso nativo pelo host:

- `client-wizard://download-progress`
- `client-wizard://extract-progress`

```ts
type NativeProgressEvent = {
  operationId: string;
  phase: "download" | "extract";
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  message: string;
};
```

O SDK permite mapear o progresso para campos do storage da tela:

```js
await wizard.download(request, {
  progressName: "progress",
  statusName: "status",
  progressStart: 60,
  progressEnd: 75
});

await wizard.extract(request, {
  progressName: "progress",
  statusName: "status",
  progressStart: 75,
  progressEnd: 100
});
```

### 15.4 Seguranca

- O download grava apenas em diretorio de cache controlado pelo app.
- A extracao grava apenas em diretorio de dados controlado pelo app.
- Nomes de arquivo e destino sao sanitizados no Rust.
- ZIP usa nomes enclausurados para evitar zip-slip.
- TAR.GZ rejeita caminhos absolutos, `..` e componentes inseguros.
- O script remoto nao escolhe um caminho arbitrario do sistema como destino.

## 16. APIs nativas de FS seguro

O runtime pode expor operacoes basicas de sistema de arquivos, mas nunca deve entregar acesso irrestrito ao disco. Toda operacao deve usar uma base permitida e um path relativo seguro.

### 16.1 Bases permitidas

```ts
type FsBase = "appData" | "appCache" | "temp" | "downloads";

type FsPath = {
  base: FsBase;
  path: string;
};
```

Regras:

- `path` deve ser relativo;
- paths absolutos sao rejeitados;
- `..` e componentes inseguros sao rejeitados;
- escrita, remocao, copia e move nao podem operar na raiz da base;
- leitura de texto deve ter limite de tamanho.

### 16.2 Permissoes

```json
[
  "native:fs:read",
  "native:fs:write",
  "native:fs:delete",
  "native:fs:open"
]
```

Mapeamento:

| Permissao | Metodos |
|---|---|
| `native:fs:read` | `exists`, `stat`, `listDir`, `readText` |
| `native:fs:write` | `writeText`, `appendText`, `mkdir`, `copy`, `move` |
| `native:fs:delete` | `remove` |
| `native:fs:open` | `openPath` |

`copy` e `move` exigem leitura e escrita.

### 16.3 SDK

```ts
type ClientWizardFs = {
  exists(path: FsPath): Promise<boolean>;
  stat(path: FsPath): Promise<FsEntry>;
  listDir(path: FsPath): Promise<FsEntry[]>;
  readText(path: FsPath): Promise<string>;
  writeText(path: FsPath, content: string): Promise<{ ok: true; path: string }>;
  appendText(path: FsPath, content: string): Promise<{ ok: true; path: string }>;
  mkdir(path: FsPath): Promise<{ ok: true; path: string }>;
  remove(path: FsPath, options?: { recursive?: boolean }): Promise<{ ok: true }>;
  copy(from: FsPath, to: FsPath): Promise<{ ok: true; path: string }>;
  move(from: FsPath, to: FsPath): Promise<{ ok: true; path: string }>;
  openPath(path: FsPath): Promise<{ ok: true }>;
};

type FsEntry = {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  modifiedAt?: number;
  createdAt?: number;
};
```

Exemplo:

```js
await clientWizard.fs.mkdir({ base: "appData", path: "logs" });
await clientWizard.fs.appendText(
  { base: "appData", path: "logs/install.log" },
  "Instalacao iniciada\n"
);
const exists = await clientWizard.fs.exists({ base: "appData", path: "logs/install.log" });
```

## 17. Exemplo completo

```js
const wizard = clientWizard.useWizard({
  steps: [
    {
      id: "client",
      btnPrev: "none",
      btnNext: "enabled",
      markdown: `
# Dados do cliente

<Input name="clientName" label="Nome do cliente" value={storage.clientName} />

[Usar exemplo]({"action":"fill-example"})
`
    },
    {
      id: "installer",
      btnPrev: "enabled",
      btnNext: "disabled",
      markdown: `
# Instalador

<SelectFile name="installer" label="Selecione o instalador" value={storage.installer} />

<ProgressiveBar name="installProgress" value={storage.installProgress} />
`
    }
  ]
});

wizard.events(async (eventName, data) => {
  if (eventName === "option" && data.action === "fill-example") {
    await wizard.setStorage({ clientName: "Acme" });
  }

  if (eventName === "file.select") {
    await wizard.setStorage({ installer: data.files[0] });
  }

  if (eventName === "wizard.next") {
    const confirmed = await wizard.openDialog({
      title: "Iniciar instalacao?",
      description: "O processo local sera iniciado nesta maquina.",
      confirmText: "Iniciar",
      cancelText: "Voltar"
    });

    if (confirmed.action === "confirm") {
      await wizard.setStorage({ installProgress: 10 });
    }
  }
});
```
