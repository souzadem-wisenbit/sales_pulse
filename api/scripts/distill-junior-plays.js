'use strict';
// ================================================
// Catálogo de JOGADAS do Júnior Smarzaro (coach_core.plays)
// Uso (da pasta api/): node scripts/distill-junior-plays.js [--db="...pooler..."]
//
// A partir dos extratos dos livros (cache do distill-junior-core), o gpt-4o
// monta um catálogo estruturado: cada jogada = nome original + estágio +
// gatilho + execução + frase-modelo pronta. O Live Coach então ESCOLHE uma
// jogada por número a cada dica (menu no prompt) — a identidade da
// metodologia entra por estrutura, e a rotação é imposta por código.
// ================================================
const dbArg = process.argv.find(a => a.startsWith('--db='));
if (dbArg) process.env.DATABASE_URL = dbArg.slice(5);

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const { getOpenAI } = require('../src/services/knowledgeService');

const EXTRACT_CACHE = path.join(__dirname, '.junior-extracts.json');

const GROUPS = [
  { label: 'abertura, rapport, descoberta e apresentação', estagios: 'rapport | descoberta | apresentacao', min: 16, max: 24 },
  { label: 'objeções (todas), negociação e preço', estagios: 'objecoes | preco', min: 18, max: 26 },
  { label: 'fechamento, sinais de compra e pós-fechamento', estagios: 'fechamento', min: 12, max: 18 },
];

async function extractPlays(openai, extracts, group) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    max_tokens: 4600,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: `Monte o CATÁLOGO DE JOGADAS de vendas de Júnior Smarzaro para ${group.label}, a partir dos extratos dos livros dele abaixo. Uma "jogada" é uma técnica acionável em tempo real numa chamada de vendas.

Retorne SÓ JSON neste formato:
{"plays": [{"name": "nome CURTO da técnica, o nome original dos livros",
  "estagio": "${group.estagios}",
  "gatilho": "quando usar — o momento/fala do cliente que pede esta jogada, 1 linha",
  "como": "a execução em 1 linha (o raciocínio da virada)",
  "frase": "frase-modelo PRONTA do vendedor em PT-BR falado natural, 1-2 frases"}]}

REGRAS:
- Entre ${group.min} e ${group.max} jogadas, TODAS vindas dos extratos (nada inventado, nada de teoria genérica).
- Nomes ORIGINAIS dos livros (ex: "Fechamento 'Eu Vou Pensar'", "Gatilho da Escassez", "Transformando 'É Caro' em 'Vale a Pena'").
- A frase-modelo NUNCA contém colchetes, placeholders, nomes próprios de cliente nem números/preços inventados — formule de modo falado e genérico ("me conta o que te levou a...", "o que exatamente ficou caro pra você?").
- Sem jogadas duplicadas ou quase iguais.

EXTRATOS DOS LIVROS:
${extracts}`,
    }],
  });
  try {
    const parsed = JSON.parse(resp.choices[0]?.message?.content || '{}');
    return Array.isArray(parsed.plays) ? parsed.plays : [];
  } catch (e) { return []; }
}

(async () => {
  const openai = await getOpenAI();
  const cache = JSON.parse(fs.readFileSync(EXTRACT_CACHE, 'utf8'));
  const extracts = Object.entries(cache).map(([f, x]) => `## LIVRO: ${f}\n${x}`).join('\n\n═══════════\n\n');
  console.log(`Extratos: ${Object.keys(cache).length} livros, ${extracts.length} chars\n`);

  let all = [];
  for (const group of GROUPS) {
    process.stdout.write(`⏳ jogadas de ${group.label} ... `);
    const t0 = Date.now();
    const plays = await extractPlays(openai, extracts, group);
    console.log(`${plays.length} jogadas (${Math.round((Date.now() - t0) / 1000)}s)`);
    all = all.concat(plays);
  }

  // Dedupe por nome normalizado e numeração final
  const seen = new Set();
  const unique = [];
  for (const p of all) {
    const key = String(p.name || '').toLowerCase().replace(/[^a-zà-úç0-9 ]/gi, '').trim();
    if (!key || seen.has(key)) continue;
    if (!p.frase || /[\[\]{}]/.test(p.frase)) continue; // frase com placeholder não serve
    seen.add(key);
    unique.push({ n: unique.length + 1, name: p.name, estagio: p.estagio, gatilho: p.gatilho, como: p.como, frase: p.frase });
  }

  await db.query("UPDATE coach_core SET plays = $1, updated_at = CURRENT_TIMESTAMP WHERE coach_id = 'junior'", [JSON.stringify(unique)]);
  console.log(`\n✅ ${unique.length} jogadas gravadas em coach_core.plays. Amostra:\n`);
  for (const p of unique.slice(0, 8)) {
    console.log(`${p.n}. [${p.estagio}] ${p.name}\n   gatilho: ${p.gatilho}\n   frase: ${p.frase}\n`);
  }
  await db.pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
