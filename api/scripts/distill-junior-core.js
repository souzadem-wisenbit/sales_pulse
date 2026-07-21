'use strict';
// ================================================
// Destilação do NÚCLEO da metodologia Júnior Smarzaro
// Uso (da pasta api/): node scripts/distill-junior-core.js [--db="...pooler..."]
//
// Map-reduce sobre a base já ingerida (coach_chunks globais do Júnior):
//   MAP    — por livro: extrai técnicas nomeadas, frases-modelo, sequências
//            e regras EXATAMENTE como o autor ensina (gpt-4o-mini, 1x/livro)
//   REDUCE — compila tudo no "sistema operacional de vendas" do Júnior
//            (gpt-4o, mais capricho de escrita), com orçamento de ~2300
//            palavras — denso o bastante para caber em TODA dica ao vivo.
// Resultado vai para coach_core('junior') e vira o prompt-base permanente
// do coach padrão. Rodar de novo sempre que a base de livros mudar.
// ================================================
const dbArg = process.argv.find(a => a.startsWith('--db='));
if (dbArg) process.env.DATABASE_URL = dbArg.slice(5);

const db = require('../src/db/pool');
const { getOpenAI } = require('../src/services/knowledgeService');

async function mapBook(openai, filename, text) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 2200,
    messages: [{
      role: 'user',
      content: `Você é um engenheiro de conhecimento extraindo a metodologia de vendas de JÚNIOR SMARZARO do livro «${filename}». Extraia SOMENTE o que está no texto — não invente, não misture com outras escolas de vendas.

EXTRAIA:
1. TÉCNICAS: nome usado no livro → quando usar (o gatilho na conversa) → como executar em 1-2 frases → e, quando o livro der, a FRASE PRONTA característica (quase literal).
2. SEQUÊNCIAS/FRAMEWORKS: os passos na ordem exata.
3. REGRAS/MANDAMENTOS do autor (sempre/nunca).
4. LINGUAGEM: bordões, expressões e vocabulário característicos.

Formato: markdown compacto em bullets. Máximo ~900 palavras. Zero opinião sua, zero enrolação.

TEXTO DO LIVRO:
${text}`,
    }],
  });
  return resp.choices[0]?.message?.content || '';
}

// Reduce em 3 partes: uma chamada por grupo de seções, cada uma com orçamento
// próprio — num reduce único o modelo resumia demais (895 e depois 1244
// palavras para um pedido de 1800+). Por partes, cada seção sai densa.
const REDUCE_PARTS = [
  {
    label: 'identidade + pilares + sequência + leitura',
    sections: `# IDENTIDADE E TOM — como Júnior fala e ensina: bordões, vocabulário, postura (um parágrafo denso)
# OS PILARES — 6-8 princípios inegociáveis, 1 linha cada
# A SEQUÊNCIA DA VENDA — as etapas na ordem, e para CADA etapa: objetivo, a jogada-chave e 1 frase-modelo do vendedor
# LEITURA DO CLIENTE — ~10 sinais (verbais/comportamentais) → o que cada um significa → a reação certa do vendedor`,
    budget: 'entre 550 e 750 palavras',
  },
  {
    label: 'objeções + fechamentos',
    sections: `# ARSENAL DE OBJEÇÕES — as ~12 objeções mais importantes. Para CADA uma: o gatilho (a fala típica do cliente) → a virada de Júnior (o raciocínio) → FRASE-MODELO pronta (1-2 frases de vendedor, característica do autor)
# FECHAMENTOS — TODAS as técnicas de fechamento presentes nos extratos, cada uma com o NOME usado nos livros → quando usar → a fala exata do vendedor`,
    budget: 'entre 700 e 900 palavras',
  },
  {
    label: 'perguntas + gatilhos + preço + regras',
    sections: `# PERGUNTAS PODEROSAS — as ~18 melhores perguntas, agrupadas por estágio da venda, quase literais do material
# GATILHOS MENTAIS EM VENDAS — os ~10 principais: nome → como aplicar numa FALA (exemplo pronto de 1 frase)
# COBRAR CARO E DEFENDER PREÇO — as jogadas específicas do autor para ancorar valor e não ceder desconto
# REGRAS DE OURO — os mandamentos finais (sempre/nunca), em bullets curtos`,
    budget: 'entre 550 e 750 palavras',
  },
];

async function reduceCore(openai, extracts) {
  const joined = extracts.join('\n\n═══════════════\n\n');
  const parts = [];
  for (const part of REDUCE_PARTS) {
    process.stdout.write(`  ⏳ reduce: ${part.label} ... `);
    const t0 = Date.now();
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.2,
      max_tokens: 3600,
      messages: [{
        role: 'user',
        content: `Você está compilando o SISTEMA OPERACIONAL DE VENDAS de Júnior Smarzaro (o cérebro-base de um coach que sopra dicas EM TEMPO REAL em chamadas de venda) a partir dos extratos dos livros dele. Nesta chamada, escreva SOMENTE as seções abaixo — outras seções serão compiladas separadamente.

SEÇÕES DESTA CHAMADA (markdown, nesta ordem):
${part.sections}

REGRAS INEGOCIÁVEIS:
- Escreva ${part.budget}. Menos que o piso = INCOMPLETO. Use o orçamento com conteúdo, não com enrolação.
- 100% fiel aos extratos: nada de teoria genérica de vendas; toda técnica mantém o NOME PRÓPRIO usado nos livros.
- Prefira a formulação do próprio autor (frases quase literais).
- Frases-modelo são falas PRONTAS de vendedor, em PT-BR falado natural.
- Não cite livros nem páginas. Manual de operação, não resenha.

EXTRATOS DOS LIVROS:
${joined}`,
      }],
    });
    const text = resp.choices[0]?.message?.content || '';
    parts.push(text);
    console.log(`OK — ~${text.split(/\s+/).length} palavras (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  return parts.join('\n\n');
}

const fs = require('fs');
const path = require('path');
const EXTRACT_CACHE = path.join(__dirname, '.junior-extracts.json'); // fora do git

(async () => {
  const openai = await getOpenAI();
  const { rows: docs } = await db.query(
    "SELECT id, filename FROM coach_documents WHERE manager_id IS NULL AND coach_id = 'junior' AND status = 'ready' ORDER BY filename"
  );
  if (docs.length === 0) throw new Error('Base do Júnior vazia — rode antes o ingest-material-junior.js');

  // Cache do MAP: refazer só o REDUCE (ajuste de prompt) sem repagar 15 livros
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(EXTRACT_CACHE, 'utf8')); } catch (e) {}
  console.log(`MAP: extraindo a essência de ${docs.length} livros...\n`);

  const extracts = [];
  for (const doc of docs) {
    if (cache[doc.filename]) {
      console.log(`↷ ${doc.filename} — extrato em cache`);
      extracts.push(`## LIVRO: ${doc.filename}\n${cache[doc.filename]}`);
      continue;
    }
    const { rows: chunks } = await db.query('SELECT content FROM coach_chunks WHERE doc_id = $1 ORDER BY seq', [doc.id]);
    const text = chunks.map(c => c.content).join('\n');
    process.stdout.write(`⏳ ${doc.filename} (${text.length} chars) ... `);
    const t0 = Date.now();
    const extract = await mapBook(openai, doc.filename, text);
    console.log(`OK — ${extract.length} chars (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (extract.length < 200) { console.log(`   ↳ extrato raso demais, livro fora do núcleo`); continue; }
    cache[doc.filename] = extract;
    fs.writeFileSync(EXTRACT_CACHE, JSON.stringify(cache, null, 1), 'utf8');
    extracts.push(`## LIVRO: ${doc.filename}\n${extract}`);
  }

  console.log('\nREDUCE: compilando o núcleo (gpt-4o)...');
  const t0 = Date.now();
  const core = await reduceCore(openai, extracts);
  console.log(`Núcleo compilado: ${core.length} chars (~${Math.round(core.split(/\s+/).length)} palavras) em ${Math.round((Date.now() - t0) / 1000)}s`);

  await db.query(`
    INSERT INTO coach_core (coach_id, core, model, source_docs, updated_at)
    VALUES ('junior', $1, 'gpt-4o', $2, CURRENT_TIMESTAMP)
    ON CONFLICT (coach_id) DO UPDATE SET core = $1, model = 'gpt-4o', source_docs = $2, updated_at = CURRENT_TIMESTAMP
  `, [core, docs.length]);
  console.log('\n✅ coach_core(junior) gravado. Prévia:\n');
  console.log(core.slice(0, 1200));
  await db.pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
