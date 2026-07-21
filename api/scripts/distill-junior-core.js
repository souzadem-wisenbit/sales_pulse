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

async function reduceCore(openai, extracts) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Compile o SISTEMA OPERACIONAL DE VENDAS de Júnior Smarzaro a partir dos extratos dos livros dele abaixo. O resultado será o cérebro-base de um coach que sopra dicas EM TEMPO REAL durante chamadas de venda: denso, prático, acionável e 100% fiel ao material — nada de teoria genérica de vendas (mencione outras escolas só se os extratos citarem).

ESTRUTURA OBRIGATÓRIA (markdown, nesta ordem):
# IDENTIDADE E TOM — como Júnior fala e ensina: bordões, vocabulário, postura
# OS PILARES — 6-8 princípios inegociáveis, 1 linha cada
# A SEQUÊNCIA DA VENDA — as etapas na ordem, com o objetivo e a jogada-chave de cada uma
# ARSENAL DE OBJEÇÕES — as ~10 mais importantes: gatilho → a virada de Júnior → frase-modelo característica
# FECHAMENTOS — técnicas nomeadas com a execução exata
# PERGUNTAS PODEROSAS — as ~15 melhores, agrupadas por estágio
# GATILHOS MENTAIS EM VENDAS — os principais e COMO aplicar numa fala
# REGRAS DE OURO — mandamentos finais (sempre/nunca)

REGRAS: máximo ~2300 palavras; prefira a formulação do próprio autor (frases dele quase literais); não cite livros nem páginas; escreva como manual de operação, não como resenha.

EXTRATOS DOS LIVROS:
${extracts.join('\n\n═══════════════\n\n')}`,
    }],
  });
  return resp.choices[0]?.message?.content || '';
}

(async () => {
  const openai = await getOpenAI();
  const { rows: docs } = await db.query(
    "SELECT id, filename FROM coach_documents WHERE manager_id IS NULL AND coach_id = 'junior' AND status = 'ready' ORDER BY filename"
  );
  if (docs.length === 0) throw new Error('Base do Júnior vazia — rode antes o ingest-material-junior.js');
  console.log(`MAP: extraindo a essência de ${docs.length} livros...\n`);

  const extracts = [];
  for (const doc of docs) {
    const { rows: chunks } = await db.query('SELECT content FROM coach_chunks WHERE doc_id = $1 ORDER BY seq', [doc.id]);
    const text = chunks.map(c => c.content).join('\n');
    process.stdout.write(`⏳ ${doc.filename} (${text.length} chars) ... `);
    const t0 = Date.now();
    const extract = await mapBook(openai, doc.filename, text);
    extracts.push(`## LIVRO: ${doc.filename}\n${extract}`);
    console.log(`OK — ${extract.length} chars (${Math.round((Date.now() - t0) / 1000)}s)`);
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
