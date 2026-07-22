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
 "viradas": ["3 a 5 movimentos de INVERSÃO próprios deste estágio: como tirar o vendedor da defensiva e devolver a conversa a favor dele. Cada item descreve o movimento e por que o cliente cede — não a fala"],
 "quandoInsiste": "o que Júnior manda fazer quando o cliente REPETE a mesma exigência/pergunta e o vendedor ainda não atendeu (ele pediu o preço três vezes, ele cobra objetividade, ele se irrita). O erro clássico é continuar desviando: diga o que fazer no lugar — 1 a 2 frases",
 "preRequisito": "o que precisa estar conquistado ANTES de avançar para o próximo estágio — 1 frase",
 "comoEleFormula": "como Júnior constrói a fala neste momento (ritmo, tipo de pergunta, tom) — 1 a 2 frases"
}

REGRAS: nada inventado nem teoria genérica de vendas — só o que os extratos sustentam. Linguagem direta, de manual de operação. Se os extratos condenam algo neste estágio (ex.: falar de produto cedo demais, empurrar, enrolar), isso PRECISA aparecer em "naoFazer".
⛔ PROIBIDO escrever fala pronta de vendedor em qualquer campo: este texto vira o cérebro de um coach que COPIA literalmente qualquer frase pronta que receba. Descreva o movimento e o raciocínio, nunca a redação. Nada de trechos longos entre aspas, nada de "diga: ...".
⛔ ZERO exemplos de varejo/balcão (vestido, sofá, prateleira, caixa, última peça) e ZERO números de exemplo: escreva o princípio de forma que sirva a consultoria, software, serviço B2B, indústria e varejo.
⛔ ZERO conduta VISUAL. Quem lê isto só recebe a TRANSCRIÇÃO do que foi dito — não vê o cliente. "Mantenha contato visual", "observe a linguagem corporal", "note os braços cruzados" são inexecutáveis e ocupam o lugar de uma conduta útil. Só o que se ouve: o que o cliente diz, como diz, o que repete, o que evita responder, o silêncio dele.

EXTRATOS DOS LIVROS:
${extracts}`,
    }],
  });
  try { return podaVisual(JSON.parse(resp.choices[0]?.message?.content || '{}')); } catch (e) { return null; }
}

// O coach só recebe a transcrição do áudio. Conduta visual ("mantenha contato
// visual", "observe a linguagem corporal") é inexecutável e, pior, faz o coach
// devolver uma "dica" que não é uma fala. Poda determinística: o prompt pede,
// isto garante.
const VISUAL = /postura|express[õo]es? faciais|linguagem corporal|bra[çc]os cruzados|contato visual|gestos?|sorris|olhar|inclina[çc][ãa]o do corpo|n[ãa]o.?verbal|apar[êe]ncia|vestimenta/i;

function podaVisual(d) {
  if (!d) return d;
  for (const campo of ['fazer', 'naoFazer', 'viradas']) {
    if (Array.isArray(d[campo])) d[campo] = d[campo].filter(x => !VISUAL.test(String(x)));
  }
  for (const campo of ['comoEleFormula', 'quandoInsiste', 'objetivo', 'principio', 'preRequisito']) {
    if (VISUAL.test(String(d[campo] || ''))) d[campo] = String(d[campo]).replace(/[^.]*(?:contato visual|linguagem corporal|postura|express[õo]es? faciais|gestos?)[^.]*\.?/gi, '').replace(/\s+/g, ' ').trim();
  }
  return d;
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

  if (process.argv.includes('--dry')) {
    fs.writeFileSync(path.join(__dirname, '.doctrine-preview.json'), JSON.stringify(doctrine, null, 1), 'utf8');
    console.log('\n🧪 DRY-RUN — nada gravado. Prévia em scripts/.doctrine-preview.json');
  } else {
    await db.query("UPDATE coach_core SET doctrine = $1, updated_at = CURRENT_TIMESTAMP WHERE coach_id = 'junior'", [JSON.stringify(doctrine)]);
    console.log('\n✅ coach_core.doctrine gravada.');
  }
  console.log('\nAmostra (objecoes):\n');
  console.log(JSON.stringify(doctrine.objecoes, null, 2));
  await db.pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
