# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Equipes tecnicas e de infraestrutura que precisam configurar clientes em maquinas Windows, Mac e Linux usando um assistente controlado por pacotes remotos.

## Product Purpose

Client Wizard e uma aplicacao desktop com Tauri e Rust que carrega definicoes em JSON ou pacotes HTML verificados para montar fluxos de configuracao. O sucesso e permitir que a equipe distribua um instalador pequeno, atualize a experiencia do wizard pelo servidor e execute tarefas locais com uma ponte nativa auditavel.

## Positioning

O produto combina uma interface declarativa por JSON/HTML com um executor Rust local que valida checksum antes de abrir conteudo baixado e limita o acesso do JavaScript a comandos nativos bem definidos.

## Operating Context

O instalador abre uma splash page local, baixa um pacote base configurado, valida checksum, descompacta em uma pasta temporaria ou de cache e apresenta o HTML ou o fluxo JSON vindo do pacote. O JavaScript do pacote conversa com a aplicacao por uma funcao nativa exposta pelo shell do wizard.

## Capabilities and Constraints

- Deve rodar como aplicacao desktop cross-platform com Tauri e Rust.
- Deve renderizar telas a partir de JSON.
- Deve baixar pacotes remotos, validar SHA-256 e descompactar arquivos zip antes de uso.
- Deve oferecer uma ponte JavaScript para operacoes nativas como leitura de informacoes do sistema e execucao de scripts.
- A execucao nativa deve ser mediada por uma biblioteca interna, nao por acesso irrestrito do HTML ao sistema operacional.
- Decisao em aberto: formato final do manifesto remoto, politica de assinatura, permissao por comando e origem dos pacotes em producao.

## Evidence on Hand

Brief inicial do usuario nesta sessao. Nao ha assets, clientes, benchmarks, copy comercial ou identidade visual confirmados.

## Product Principles

- Conteudo remoto so roda depois de integridade verificada.
- A interface e declarativa, mas a autoridade operacional fica no Rust.
- O pacote inicial deve ser pequeno e atualizavel sem recompilar o instalador.
- A ponte nativa deve ser explicita, tipada e extensivel por permissoes.

## Accessibility & Inclusion

O wizard deve ser operavel por teclado, legivel em ambientes tecnicos e resiliente a estados de erro durante download, validacao e execucao de comandos.
