# SalesPulse Mission Control

App **desktop** (Electron) para operar a frota de instâncias SalesPulse — uma
instância Azure por empresa, sem multi-tenant.

## O que faz

- **Frota**: cada empresa vira um card com status online/offline (health check
  real + estado no Azure), latência, links (app, Kudu, portal Azure).
- **Por instância**:
  - *Visão geral*: usuários, quem está online agora (atividade < 5 min) e o que
    está fazendo (em treinamento / em chamada real), sessões e mensagens de
    hoje, feed de atividade (logins, treinos iniciados/concluídos, chamadas).
  - *Usuários*: criar, editar, suspender/reativar, resetar senha, excluir.
  - *Conversas*: histórico completo de chats de treinamento, com transcrição.
  - *Live Coach*: chamadas reais, transcrição, dicas do coach e resumo.
  - *Logs*: tail do log do container direto do Kudu, com auto-refresh.
  - *Config*: App Settings (segredos mascarados), estado do Azure, ai_settings,
    reiniciar o app, testar o banco.
- **Nova instância**: wizard que cria o Web App no Azure (mesmo runtime/plano da
  instância atual), configura App Settings, roda as migrations no banco novo,
  cria o gestor inicial e faz o deploy do código atual — acompanhando cada passo
  ao vivo.

## Como abrir

Duplo clique em `MissionControl.bat` (ou `npm start` dentro de `mission-control/`).

O backend sobe em `http://127.0.0.1:5599` **apenas local** — nada é exposto na rede.

## Pré-requisitos

- `az login` válido (assinatura Wisenbit) — usado para estado das instâncias,
  App Settings, credenciais Kudu e criação de web apps.
- Python no PATH (usado para zipar o deploy — nunca Compress-Archive).
- Para provisionar empresa nova: criar antes um projeto no Supabase e colar a
  connection string no wizard (1 banco por empresa).

## Onde ficam os dados

`mission-control/data/instances.json` — registro empresa ↔ instância, incluindo
a DATABASE_URL de cada uma. **Fora do git** (está no .gitignore), não sincronize
nem compartilhe esse arquivo.

## Observações

- "Online agora" é derivado do banco (último login, última mensagem enviada,
  chamada em aberto) — o app das empresas não precisou ser alterado.
- O AVG desta máquina intercepta TLS de vez em quando; o painel já contorna
  (mesma razão do `--ssl-no-revoke` no playbook de deploy). Se o az CLI
  reclamar de certificado, desligue temporariamente o Web Shield do AVG ou
  rode `az login` de novo quando ele estiver desligado.
