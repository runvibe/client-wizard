# Design

Client Wizard usa o preset shadcn luma com tema blue/zinc: uma tela limpa, centrada e composta por Card, Field, InputGroup, Badge e Separator para inserir a URL externa que controla o wizard.

## Interface

- Entrada inicial minimalista com um unico Card central.
- Formulario composto com FieldGroup, Field e InputGroup.
- Cores, raio, foco e tipografia seguem os tokens do preset shadcn.
- Quando uma URL e carregada, a origem fica visivel em um Card compacto antes do frame externo.

## Componentes

- `Card`: estrutura da tela inicial e da barra da URL carregada.
- `FieldGroup`/`Field`: estrutura semantica do formulario.
- `InputGroup`: input com botao de abertura integrado.
- `Badge`: indicadores de capacidade do host.
