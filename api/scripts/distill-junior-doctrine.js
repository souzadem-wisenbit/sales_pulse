'use strict';
// ================================================
// DOUTRINA POR ESTÁGIO — o que Júnior ensina para CADA momento da venda
// Uso (da pasta api/): node scripts/distill-junior-doctrine.js [--db="...pooler..."]
//
// O catálogo de jogadas (distill-junior-plays) diz QUAIS técnicas existem.
// Faltava o porquê e a REGRA DE CONDUTA de cada fase — sem isso o coach
// mandava o vendedor apresentar produto no primeiro "oi", coisa que a
// metodologia proíbe. Aqui destilamos, por estágio: objetivo, o que fazer,
// o que NUNCA fazer, o pré-requisito para avançar e como Júnior formula.
// Resultado em coach_core.doctrine (migração 016).
// ================================================
const dbArg = process.argv.find(a => a.startsWith('--db='));
if (dbArg) process.env.DATABASE_URL = dbArg.slice(5);

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const { getOpenAI } = require('../src/services/knowledgeService');

const EXTRACT_CACHE = path.join(__dirname, '.junior-extracts.json');

const STAGES = [
  { key: 'rapport', label: 'ABERTURA E RAPPORT (os primeiros segundos do contato, antes de qualquer produto)' },
  { key: 'descoberta', label: 'DESCOBERTA (entender a necessidade real antes de oferecer qualquer coisa)' },
  { key: 'apresentacao', label: 'APRESENTAÇÃO DA SOLUÇÃO (conectar o produto à dor que o cliente revelou)' },
  { key: 'objecoes', label: 'OBJEÇÕES E NEGOCIAÇÃO (preço, adiamento, autoridade, concorrente, desconfiança)' },
  { key: 'fechamento', label: 'FECHAMENTO (conduzir à decisão e amarrar o próximo passo)' },
];

async function doctrineFor(openai, extracts, stage) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: `Com base EXCLUSIVAMENTE nos extratos dos livros de Júnior Smarzaro abaixo, escreva a DOUTRINA dele para o estágio: ${stage.label}.

Retorne SÓ JSON:
{
 "objetivo": "o que se busca neste estágio, na visão do Júnior — 1 frase",
 "principio": "o princípio/bordão dele que rege este momento — 1 frase, quase literal",
 "fazer": ["4 a 6 condutas concretas que ele MANDA fazer aqui"],
 "naoFazer": ["3 a 5 erros que ele condena EXPRESSAMENTE neste estágio"],
 "preRequisito": "o que precisa estar conquistado ANTES de avançar para o próximo estágio — 1 frase",
 "comoEleFormula": "como Júnior constrói a fala neste momento (ritmo, tipo de pergunta, tom) — 1 a 2 frases"
}

REGRAS: nada inventado nem teoria genérica de vendas — só o que os extratos sustentam. Linguagem direta, de manual de operação. Se os extratos condenam algo neste estágio (ex.: falar de produto cedo demais, empurrar, enrolar), isso PRECISA aparecer em "naoFazer".

EXTRATOS DOS LIVROS:
${extracts}`,
    }],
  });
  try { return JSON.parse(resp.choices[0]?.message?.content || '{}'); } catch (e) { return null; }
}

(async () => {
  const openai = await getOpenAI();
  const cache = JSON.parse(fs.readFileSync(EXTRACT_CACHE, 'utf8'));
  const extracts = Object.entries(cache).map(([f, x]) => `## LIVRO: ${f}\n${x}`).join('\n\n═══════════\n\n');
  console.log(`Extratos: ${Object.keys(cache).length} livros\n`);

  const doctrine = {};
  for (const stage of STAGES) {
    process.stdout.write(`⏳ doutrina de ${stage.key} ... `);
    const t0 = Date.now();
    const d = await doctrineFor(openai, extracts, stage);
    if (!d) { console.log('FALHOU'); continue; }
    doctrine[stage.key] = d;
    console.log(`OK (${Math.round((Date.now() - t0) / 1000)}s) — ${(d.fazer || []).length} condutas, ${(d.naoFazer || []).length} proibições`);
  }

  await db.query("UPDATE coach_core SET doctrine = $1, updated_at = CURRENT_TIMESTAMP WHERE coach_id = 'junior'", [JSON.stringify(doctrine)]);
  console.log('\n✅ coach_core.doctrine gravada. Amostra (rapport):\n');
  console.log(JSON.stringify(doctrine.rapport, null, 2));
  await db.pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
