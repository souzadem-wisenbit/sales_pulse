# 💼 AntiGravity — Planos de Preço e Estrutura de Custos

> Documento interno de precificação para os 3 produtos: **Neural Sales**, **BI Inteligente** e **Consultoria Comercial**

---

## 📊 PARTE 1 — CUSTO DE INFRAESTRUTURA (O que você paga para operar)

### 1.1 · Custo de API OpenAI por empresa cliente

O Neural Sales usa o modelo **GPT-4o-mini** por padrão (ótima relação custo/qualidade). Abaixo o custo real de API por sessão de treinamento:

| Componente | Estimativa por sessão |
|---|---|
| System prompt (contexto do cliente) | ~1.400 tokens |
| Mensagens do vendedor (15 msgs × 80 tokens) | ~1.200 tokens |
| Respostas do bot (15 msgs × 150 tokens) | ~2.250 tokens |
| Coach tips + avaliação final | ~600 tokens |
| **Total por sessão** | **~5.450 tokens** |

#### Custo por sessão por modelo:

| Modelo | Custo Input | Custo Output | **Custo total/sessão** |
|---|---|---|---|
| GPT-4o-mini | $0.15/1M tokens | $0.60/1M tokens | **~$0,004 (≈ R$ 0,02)** |
| GPT-4o | $2.50/1M tokens | $10.00/1M tokens | **~$0,035 (≈ R$ 0,20)** |

#### Custo mensal de API por porte de empresa (usando GPT-4o-mini):

| Porte | Vendedores | Sessões/vendedor/mês | Total sessões | **Custo API/mês (USD)** | **Custo API/mês (BRL ~R$5,90)** |
|---|---|---|---|---|---|
| Micro | 3 | 5 | 15 | ~$0,06 | ~R$ 0,35 |
| Pequena | 8 | 8 | 64 | ~$0,28 | ~R$ 1,65 |
| Média | 20 | 10 | 200 | ~$0,87 | ~R$ 5,13 |
| Grande | 50 | 12 | 600 | ~$2,60 | ~R$ 15,34 |
| Enterprise | 100 | 15 | 1.500 | ~$6,53 | ~R$ 38,53 |

> 💡 **Conclusão:** O custo de API é praticamente desprezível. O produto é altamente escalável e a maior parte do que você cobra é **valor percebido, não custo operacional.**

---

### 1.2 · Custo de Infraestrutura Azure por cliente

O Neural Sales é uma **SPA (Single Page Application)** com dados em localStorage. Para uma versão mais robusta com backend (dados na nuvem, multi-tenancy, relatórios avançados):

#### Opção A — Infraestrutura Mínima (atual / sem backend)

| Serviço | Plano | Custo/mês (USD) | Custo/mês (BRL) |
|---|---|---|---|
| Azure Static Web Apps | Standard | $9,00 | ~R$ 53 |
| Azure DNS (domínio personalizado) | — | $0,90 | ~R$ 5 |
| **Total mensal** | | **$9,90** | **~R$ 58/mês** |

> ✅ Ideal para: fase atual da plataforma. Clientes usam a própria chave OpenAI.

#### Opção B — Infraestrutura Escalável (versão SaaS futura com backend)

| Serviço | Plano | Custo/mês (USD) | Custo/mês (BRL) |
|---|---|---|---|
| Azure Static Web Apps | Standard | $9,00 | ~R$ 53 |
| Azure App Service | B2 (backend API) | $28,00 | ~R$ 165 |
| Azure Cosmos DB | Serverless | ~$5-15 | ~R$ 30–88 |
| Azure Blob Storage | LRS 50GB | $1,00 | ~R$ 6 |
| Azure Active Directory B2C | 50K MAU grátis | $0 | R$ 0 |
| Azure DNS | — | $0,90 | ~R$ 5 |
| **Total mensal** | | **~$44–58** | **~R$ 260–342/mês** |

> ✅ Ideal para: múltiplos clientes no mesmo ambiente, controle centralizado, dashboards de BI.

#### Custo por cliente (rateio com 10 clientes ativos na Opção B):
| | Custo total infra | Por cliente (10 clientes) |
|---|---|---|
| Azure + hosting | ~R$ 300/mês | **~R$ 30/cliente/mês** |
| API OpenAI (empresa média) | ~R$ 5/cliente/mês | **~R$ 5/cliente/mês** |
| **Total de custo real** | | **~R$ 35/cliente/mês** |

---

## 🛍️ PARTE 2 — PRODUTOS E PRECIFICAÇÃO

---

## 🤖 PRODUTO 1 — Neural Sales (Plataforma de Treinamento IA)

> **O que é:** Plataforma SaaS de simulação de vendas com IA. Vendedores treinam com clientes virtuais ultra-realistas, recebem feedback em tempo real, coaching por IA e relatórios de performance.

### Proposta de Valor
- Substitui role-plays manuais (que desperdiçam horas do gestor)
- Treina vendedores 24h/dia, sem agenda, sem deslocamento
- Dados objetivos de performance: pontuação, progresso, frases vencedoras
- Clientes customizados com personalidade e comportamento real do mercado

### Planos Neural Sales

| | 🌱 **Starter** | 🚀 **Professional** | 💼 **Business** | 🏢 **Enterprise** |
|---|---|---|---|---|
| **Vendedores incluídos** | até 5 | até 15 | até 35 | Ilimitado |
| **Clientes virtuais** | 3 | 10 | 25 | Ilimitado |
| **Sessões/mês** | 50 | 200 | Ilimitado | Ilimitado |
| **Relatórios** | Básico | Avançado | Avançado + BI | Personalizado |
| **Coach IA em tempo real** | ✅ | ✅ | ✅ | ✅ |
| **Múltiplos gestores** | ❌ | ✅ | ✅ | ✅ |
| **API Key própria do cliente** | Sim | Sim | Sim | Sim ou gerenciada |
| **Onboarding** | Self-service | 1 call 1h | 2 calls + suporte | Dedicado |
| **SLA de suporte** | — | 48h | 24h | 4h |
| **Preço mensal** | **R$ 497** | **R$ 1.197** | **R$ 2.397** | **R$ 4.497** |
| **Preço anual (20% off)** | **R$ 397/mês** | **R$ 957/mês** | **R$ 1.917/mês** | **R$ 3.597/mês** |

### Margem Neural Sales (Opção B infra, 10 clientes):
| Plano | Receita | Custo real | **Margem bruta** |
|---|---|---|---|
| Starter | R$ 497 | ~R$ 35 | **~93%** |
| Professional | R$ 1.197 | ~R$ 45 | **~96%** |
| Business | R$ 2.397 | ~R$ 60 | **~97%** |

---

## 📈 PRODUTO 2 — BI Inteligente (Business Intelligence com Manutenção)

> **O que é:** Construção, entrega e manutenção contínua de painéis de Business Intelligence para a área comercial. Inclui dashboards de performance de vendas, funil de conversão, análise por segmento, vendedor e produto.

### Entregáveis incluídos
- Dashboards no Power BI / Looker Studio / Metabase (conforme preferência)
- Conexão com CRM, planilhas, ERP ou sistemas internos
- Relatórios automáticos por e-mail (diário/semanal/mensal)
- Manutenção: atualizações de métricas, novos gráficos, correção de dados
- Reunião de revisão mensal ou quinzenal (inclusa no plano)

### Planos BI Inteligente

| | 📊 **BI Essencial** | 📈 **BI Profissional** | 🔬 **BI Estratégico** |
|---|---|---|---|
| **Manutenção** | Mensal | Quinzenal | Quinzenal |
| **Dashboards incluídos** | até 3 painéis | até 8 painéis | Ilimitado |
| **Fontes de dados** | 2 (ex: planilha + CRM) | 5 fontes | Ilimitado |
| **Reunião de revisão** | 1h/mês | 2h a cada 15 dias | 3h a cada 15 dias |
| **Alertas automáticos** | ❌ | ✅ | ✅ |
| **Relatórios personalizados** | ❌ | Básico | Avançado |
| **Análise preditiva (IA)** | ❌ | ❌ | ✅ |
| **Integração Neural Sales** | ❌ | ✅ | ✅ |
| **SLA de resposta** | 72h | 48h | 24h |
| **Implantação inicial** | R$ 2.500 (único) | R$ 4.500 (único) | R$ 8.000 (único) |
| **Mensalidade** | **R$ 1.200/mês** | **R$ 2.400/mês** | **R$ 4.200/mês** |
| **Anual (15% off)** | **R$ 1.020/mês** | **R$ 2.040/mês** | **R$ 3.570/mês** |

> 💡 **Estimativa de horas de trabalho por plano:**
> - Essencial: ~6h/mês → custo hora efetivo: R$ 200/h
> - Profissional: ~12h/mês → custo hora efetivo: R$ 200/h
> - Estratégico: ~20h/mês → custo hora efetivo: R$ 210/h

---

## 🎯 PRODUTO 3 — Consultoria Comercial Quinzenal

> **O que é:** Acompanhamento estratégico quinzenal da operação comercial. Análise de dados de vendas, revisão de processos, coaching de líderes, definição de metas e plano de ação com resultados mensuráveis.

### O que é coberto nas sessões
- Análise dos KPIs da última quinzena (taxa de conversão, CAC, ticket médio, etc.)
- Revisão do funil e identificação de gargalos
- Coaching do gestor de vendas
- Plano de ação para próximos 15 dias (com responsáveis e prazos)
- Recomendações de script, abordagem e segmentação
- Gravação disponível para referência futura

### Planos Consultoria Quinzenal

| | 🌟 **Consultoria Start** | 🔥 **Consultoria Pro** | 👑 **Consultoria Executive** |
|---|---|---|---|
| **Sessões/mês** | 2 sessões de 1h | 2 sessões de 2h | 2 sessões de 3h |
| **Total horas/mês** | 2h | 4h | 6h |
| **Análise de dados prévia** | Básica | Completa | Completa + preditiva |
| **Plano de ação escrito** | ❌ | ✅ | ✅ |
| **Acesso via WhatsApp/e-mail** | ❌ | Até 2h resposta | Até 1h resposta |
| **Gravações das sessões** | ✅ | ✅ | ✅ |
| **Revisão de playbook** | ❌ | Trimestral | Mensal |
| **Integração Neural Sales** | ❌ | ✅ | ✅ |
| **Integração BI** | ❌ | ✅ | ✅ |
| **Preço mensal** | **R$ 1.600/mês** | **R$ 2.800/mês** | **R$ 4.800/mês** |
| **Anual (10% off)** | **R$ 1.440/mês** | **R$ 2.520/mês** | **R$ 4.320/mês** |

> 💡 **Valor hora efetivo:**
> - Start: R$ 800/h (2h/mês)
> - Pro: R$ 700/h (4h/mês)
> - Executive: R$ 800/h (6h/mês)

---

## 🎁 PARTE 3 — BUNDLES (Combinações com Desconto)

### Por que bundles funcionam
Clientes que usam os 3 produtos têm 3x mais retenção (efeito de lock-in), e você aumenta o ticket médio sem aumentar o CAC.

| Bundle | Inclui | Valor separado | **Preço Bundle** | **Economia** |
|---|---|---|---|---|
| 🥉 **Combo Growth** | Neural Sales Starter + BI Essencial | R$ 1.697 | **R$ 1.497/mês** | R$ 200 (12%) |
| 🥈 **Combo Scale** | Neural Sales Pro + BI Profissional + Consultoria Start | R$ 5.397 | **R$ 4.597/mês** | R$ 800 (15%) |
| 🥇 **Combo Full** | Neural Sales Business + BI Estratégico + Consultoria Pro | R$ 9.397 | **R$ 7.897/mês** | R$ 1.500 (16%) |
| 💎 **Combo Elite** | Neural Sales Enterprise + BI Estratégico + Consultoria Executive | R$ 13.497 | **R$ 10.997/mês** | R$ 2.500 (19%) |

---

## 💡 PARTE 4 — ESTRATÉGIA DE PRECIFICAÇÃO

### Lógica de entrada (funil de conversão)
```
Lead frio
  └─► Demo Neural Sales GRATUITA (30 min) → Ativação emocional
        └─► Trial Neural Sales 15 dias (1 gestor + 2 vendedores)
              └─► Proposta Starter → upsell Pro em 60 dias
                    └─► Adiciona BI após ver dados do Neural Sales
                          └─► Adiciona Consultoria para interpretar os dados
```

### Posicionamento de preço no mercado BR

| Produto | Referência de mercado | Nosso preço | Posição |
|---|---|---|---|
| Neural Sales | Ferramentas similares (Rehearsal, Spekit) | $200–$800 USD/user/mês | **Premium acessível** |
| BI | Agências de BI no Brasil | R$ 3.000–8.000/mês | **Competitivo** |
| Consultoria | Consultores independentes | R$ 800–1.500/h | **Médio-alto** |

### Gatilhos de upsell
- **Neural Sales → BI:** "Você está coletando dados incríveis. Vamos transformá-los em painel visual?"
- **BI → Consultoria:** "Os dados mostram esse padrão. Quer que a gente monte a estratégia juntos?"
- **Starter → Pro:** "Você já tem 5 vendedores acima da capacidade. O Pro não tem limite."

---

## 📊 PARTE 5 — PROJEÇÃO DE RECEITA

### Cenário conservador (6 meses de operação)

| Mês | Clientes Neural Sales | Clientes BI | Clientes Consultoria | **MRR estimado** |
|---|---|---|---|---|
| 1 | 2 | 0 | 1 | ~R$ 3.400 |
| 2 | 4 | 1 | 1 | ~R$ 7.000 |
| 3 | 6 | 2 | 2 | ~R$ 12.000 |
| 4 | 8 | 3 | 2 | ~R$ 17.000 |
| 5 | 10 | 4 | 3 | ~R$ 23.000 |
| 6 | 12 | 5 | 4 | ~R$ 30.000 |

> MRR estimado com ticket médio Neural Sales R$ 1.400 · BI R$ 2.200 · Consultoria R$ 2.200

### Custo operacional total (Mês 6, 12 clientes NS):
| Item | Custo |
|---|---|
| Infraestrutura Azure | ~R$ 350 |
| API OpenAI (12 empresas médias) | ~R$ 60 |
| Ferramentas (Notion, Cal, etc.) | ~R$ 200 |
| **Total infra** | **~R$ 610/mês** |

**Margem bruta estimada no mês 6: ~R$ 29.390 (~98%)**

---

## 📋 RESUMO EXECUTIVO

| Produto | Plano Entrada | Plano Premium | Custo real/cliente |
|---|---|---|---|
| 🤖 Neural Sales | R$ 497/mês | R$ 4.497/mês | ~R$ 35/mês |
| 📊 BI Inteligente | R$ 1.200/mês + R$ 2.500 setup | R$ 4.200/mês + R$ 8.000 setup | ~R$ 200-400/mês (horas) |
| 🎯 Consultoria | R$ 1.600/mês | R$ 4.800/mês | ~R$ 300-600/mês (horas) |

> **Nota importante:** Os custos de BI e Consultoria são principalmente **custo de mão de obra** (seu tempo ou de um colaborador), não custos de infraestrutura. Por isso, escalar essas linhas exige contratação ou automação progressiva.

---

*Documento criado em Junho/2026 · AntiGravity · Revisão recomendada a cada 6 meses ou quando houver variação cambial superior a 15%.*
