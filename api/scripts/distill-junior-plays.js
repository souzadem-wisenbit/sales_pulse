'use strict';
// ================================================
// Catálogo de JOGADAS do Júnior Smarzaro (coach_core.plays)
// Uso (da pasta api/): node scripts/distill-junior-plays.js [--db="..."] [--dry]
//
// A partir dos extratos dos livros (cache do distill-junior-core), o gpt-4o
// monta um catálogo estruturado. O Live Coach ESCOLHE uma jogada por número a
// cada dica — a identidade da metodologia entra por estrutura, e a rotação é
// imposta por código.
//
// ⚠️ POR QUE NÃO EXISTE MAIS O CAMPO "frase":
// A primeira versão guardava uma frase-modelo pronta por jogada. Auditoria de
// chamada real (2026-07-22) mostrou que o modelo COPIAVA a frase-modelo em
// ~100% das dicas, por mais que o prompt proibisse — uma frase pronta é a
// âncora mais forte que existe num prompt. O resultado eram dicas de balcão de
// loja num call de consultoria: "essa é a última disponível", "deixa eu ver a
// TABELA atualizada", "com mais de 10 anos de experiência posso garantir".
// Frase pronta no prompt = dica copiada. Então a jogada agora carrega só a
// MECÂNICA (por que funciona) e a ESTRUTURA (o movimento a executar, sem
// palavras finais): não há o que copiar, o modelo é obrigado a redigir com as
// palavras DESTA conversa.
//
// ⚠️ E O CAMPO "exigeFonte": jogadas que afirmam fato sobre o mundo (escassez,
// prova social, garantia, autoridade, desconto) só entram no menu quando o
// briefing sustenta esse fato. É a vacina ESTRUTURAL contra alucinação: em vez
// de pedir ao modelo que não invente, a jogada que exige invenção some do menu.
// ================================================
const dbArg = process.argv.find(a => a.startsWith('--db='));
if (dbArg) process.env.DATABASE_URL = dbArg.slice(5);
const DRY = process.argv.includes('--dry');

const fs = require('fs');
const path = require('path');
const db = require('../src/db/pool');
const { getOpenAI } = require('../src/services/knowledgeService');

const EXTRACT_CACHE = path.join(__dirname, '.junior-extracts.json');
const DRY_OUT = path.join(__dirname, '.plays-preview.json');

const GROUPS = [
  { label: 'abertura, rapport, descoberta e apresentação', estagios: 'rapport | descoberta | apresentacao', validos: ['rapport', 'descoberta', 'apresentacao'], padrao: 'descoberta', min: 16, max: 24 },
  { label: 'objeções (todas), negociação e preço', estagios: 'objecoes | preco', validos: ['objecoes', 'preco'], padrao: 'objecoes', min: 18, max: 26 },
  { label: 'fechamento, sinais de compra e pós-fechamento', estagios: 'fechamento', validos: ['fechamento'], padrao: 'fechamento', min: 12, max: 18 },
];

// O modelo inventa rótulos de estágio fora do enum pedido ("negociacao",
// "abertura"). Uma jogada com estágio desconhecido nunca entra no menu do
// coach — some do produto em silêncio. Aqui todo rótulo cai num estágio real.
const SINONIMOS = {
  negociacao: 'objecoes', objeção: 'objecoes', objecao: 'objecoes', objeções: 'objecoes',
  abertura: 'rapport', conexao: 'rapport', conexão: 'rapport', saudacao: 'rapport',
  qualificacao: 'descoberta', qualificação: 'descoberta', diagnostico: 'descoberta', diagnóstico: 'descoberta',
  valor: 'preco', precificacao: 'preco', precificação: 'preco', preço: 'preco',
  apresentação: 'apresentacao', proposta: 'apresentacao',
  'pos-fechamento': 'fechamento', posfechamento: 'fechamento', fechamentos: 'fechamento',
};

// ̀-ͯ = marcas de acento combinantes (escape explícito de propósito:
// o range literal sobrevive mal a zip/deploy com recodificação de arquivo)
const DIACRITICOS = new RegExp('[\u0300-\u036f]', 'g');
const semAcento = (s) => String(s || '').normalize('NFD').replace(DIACRITICOS, '').toLowerCase().trim();

// O nome da técnica é a fonte mais confiável de estágio que existe aqui: o
// modelo erra o rótulo com frequência (devolveu "Fechamento por Culpa" como
// "apresentacao" e inventou "negociacao"), mas o nome que ele copia dos livros
// diz sozinho a que momento a jogada pertence. Nome bate → nome manda.
const NOME_ESTAGIO = [
  { re: /^fechamento\b|^fecha(r|mento)/i, estagio: 'fechamento' },
  { re: /pre[çc]o|(^|\W)caro(\W|$)|ancoragem|desconto|or[çc]amento|cobrar caro/i, estagio: 'preco' },
  { re: /obje[çc]/i, estagio: 'objecoes' },
  { re: /rapport|adula[çc]|empatia|espelhamento|humaniza/i, estagio: 'rapport' },
  { re: /pergunta|descoberta|diagn[óo]stico|explorat[óo]ri|sondagem/i, estagio: 'descoberta' },
];

function normEstagio(raw, group, name) {
  for (const r of NOME_ESTAGIO) if (r.re.test(String(name || ''))) return r.estagio;
  const k = semAcento(raw);
  const alvo = group.validos.includes(k) ? k : (SINONIMOS[k] || SINONIMOS[String(raw || '').toLowerCase().trim()]);
  return group.validos.includes(alvo) ? alvo : group.padrao;
}

// Chave de dedupe sem acento e sem os prefixos que o modelo alterna: sem isso
// "Gatilho da Adulacao", "Gatilho Mental da Adulação" e "Gatilho da Adulação"
// viravam três jogadas distintas no catálogo (e três dicas "diferentes").
function chaveNome(name) {
  return semAcento(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\bgatilho (mental )?(d[ao] |de )?/g, 'gatilho ')
    .replace(/\btecnica (d[ao] |de )?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const FONTES = 'escassez | prova_social | garantia | autoridade | desconto | preco | nenhuma';

async function extractPlays(openai, extracts, group, jaTenho) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.2,
    max_tokens: 5200,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: `Monte o CATÁLOGO DE JOGADAS de vendas de Júnior Smarzaro para ${group.label}, a partir dos extratos dos livros dele abaixo. Uma "jogada" é uma técnica acionável em tempo real numa chamada de vendas.

Este catálogo alimenta um coach que sopra dicas AO VIVO. Ele NÃO pode receber frases prontas: se receber, copia. Ele precisa receber o MECANISMO da jogada, para redigir a fala com as palavras do cliente daquela conversa específica.

Retorne SÓ JSON neste formato:
{"plays": [{
  "name": "nome CURTO da técnica, o nome ORIGINAL dos livros",
  "estagio": "${group.estagios}",
  "gatilho": "o momento/fala do cliente que PEDE esta jogada — 1 linha concreta",
  "mecanica": "POR QUE funciona na cabeça do cliente — o efeito psicológico que a jogada produz. 1-2 frases. Esta é a parte que ensina o coach a pensar.",
  "estrutura": "O MOVIMENTO a executar, em imperativo, descrito como RECEITA e não como frase. Deve dizer o que fazer com o material DA CONVERSA (a palavra que o cliente usou, o número que ele deu, a dor que ele citou). Ex: 'Devolva a objeção como pergunta que obriga o cliente a especificar o critério: pegue a palavra exata que ele usou e peça que ele diga em relação a QUÊ.' PROIBIDO escrever uma fala pronta aqui.",
  "erroComum": "o jeito errado de executar esta jogada, que a queima — 1 linha",
  "exigeFonte": "${FONTES}"
}]}

REGRAS ABSOLUTAS:
- Entre ${group.min} e ${group.max} jogadas, TODAS vindas dos extratos (nada inventado, nada de teoria genérica de vendas).
- Nomes ORIGINAIS dos livros (ex: "Fechamento 'Eu Vou Pensar'", "Gatilho da Escassez", "Transformando 'É Caro' em 'Vale a Pena'").
- ⛔ NENHUM campo pode conter uma fala pronta de vendedor, nem entre aspas, nem como exemplo. Nada de "diga: ...". Se você escrever uma frase que o vendedor poderia ler em voz alta, a jogada está ERRADA. Descreva o movimento, não o texto.
- ⛔ ZERO exemplos de varejo/loja física. Os livros usam vestido, desodorante, sofá, joia, prateleira, caixa, "última peça". Isso é EXEMPLO, não é a técnica. Traduza sempre para o PRINCÍPIO, que vale igual para consultoria, software, serviço B2B, indústria ou varejo. Nunca cite um produto específico.
- ⛔ ZERO números nos textos. Os números dos livros ("10% de desconto", "85% dos clientes", "10 anos de experiência", "R$ 99,99") são didáticos daquele exemplo — repetir isso faz o coach inventar dado falso numa venda real.
- "exigeFonte" classifica de que FATO a jogada depende para ser honesta:
  · "escassez" = afirma estoque/vaga/prazo limitado
  · "prova_social" = afirma que outros compraram/aprovaram
  · "garantia" = promete devolução, teste, SLA, reversão de risco
  · "autoridade" = afirma tempo de casa, credencial, número de clientes
  · "desconto" = propõe abatimento de preço
  · "preco" = precisa dizer um valor
  · "nenhuma" = a jogada é só pergunta/raciocínio/condução, não afirma fato sobre o mundo
  Classifique com rigor: se a jogada afirma QUALQUER coisa sobre o mundo que precise ser verdade, ela NÃO é "nenhuma".
- Sem jogadas duplicadas ou quase iguais. Prefira poucas jogadas distintas a muitas variações do mesmo movimento.
- O campo "estagio" só aceita os valores: ${group.estagios}. Não invente outro rótulo.
- Os livros trazem DEZENAS de técnicas NOMEADAS para este momento da venda. Vasculhe os extratos e traga TODAS as que encontrar, cada uma com o nome exato do material — não pare na meia dúzia mais óbvia.
${(jaTenho && jaTenho.length) ? `
⚠️ SEGUNDA PASSADA: estas jogadas JÁ estão no catálogo e NÃO devem voltar, nem com outro nome ou variação:
${jaTenho.map(n => `- ${n}`).join('\n')}
Traga jogadas DIFERENTES destas, tiradas de outras partes dos extratos. Vasculhe o material atrás das técnicas que ainda não apareceram.` : ''}

EXTRATOS DOS LIVROS:
${extracts}`,
    }],
  });
  try {
    const parsed = JSON.parse(resp.choices[0]?.message?.content || '{}');
    return Array.isArray(parsed.plays) ? parsed.plays : [];
  } catch (e) { return []; }
}

// ── Guarda de qualidade: rejeita jogada que veio com fala pronta ──
// O modelo às vezes desobedece e enfia uma frase de vendedor na "estrutura".
// Frase pronta é exatamente o que envenenou a versão anterior, então ela morre
// aqui em vez de chegar ao prompt do coach.
const FALA_PRONTA = [
  /\bdiga\s*:/i, /\bfale\s*:/i, /\bpergunte\s*:/i, /\bexemplo\s*:/i,
  /["“”][^"“”]{25,}["“”]/,          // trecho longo entre aspas = fala pronta
  /\bo\s+sr\.?\b|\bo\s+senhor\b|\ba\s+senhora\b/i,
];
const VAREJO = /vestido|desodorante|sof[áa]|joia|prateleira|\bcaixa\b|camisa|gravata|amostra gr[áa]tis|[úu]ltima pe[çc]a|estoque|vitrine|provador/i;

// O coach só recebe a TRANSCRIÇÃO da conversa — ele não enxerga o cliente.
// Uma jogada baseada em postura, olhar ou expressão facial é inexecutável
// aqui: o contrato da dica é uma FALA pronta, e "observe os braços cruzados
// dele" não é uma fala. Os livros ensinam muito disso; fora do catálogo.
const VISUAL = /postura|express[õo]es? faciais|linguagem corporal|bra[çc]os cruzados|contato visual|gestos?|sorriso|olhar d[oe]|inclina[çc][ãa]o do corpo|n[ãa]o.?verbal/i;

function limpa(p, group) {
  const campos = [p.gatilho, p.mecanica, p.estrutura, p.erroComum].map(s => String(s || ''));
  const texto = campos.join(' ');
  if (!p.name || !p.estrutura || !p.mecanica) return null;
  if (FALA_PRONTA.some(re => re.test(texto))) return null;
  if (VAREJO.test(texto)) return null;
  if (VISUAL.test(texto) || VISUAL.test(String(p.name || ''))) return null;
  if (/\d/.test(texto)) return null;                       // número didático dos livros
  if (/[\[\]{}]/.test(texto)) return null;
  const fonte = String(p.exigeFonte || 'nenhuma').toLowerCase().trim();
  return {
    name: String(p.name).trim(),
    estagio: normEstagio(p.estagio, group, p.name),
    gatilho: String(p.gatilho || '').trim(),
    mecanica: String(p.mecanica).trim(),
    estrutura: String(p.estrutura).trim(),
    erroComum: String(p.erroComum || '').trim(),
    exigeFonte: FONTES.includes(fonte) ? fonte : 'nenhuma',
  };
}

(async () => {
  const openai = await getOpenAI();
  const cache = JSON.parse(fs.readFileSync(EXTRACT_CACHE, 'utf8'));
  const extracts = Object.entries(cache).map(([f, x]) => `## LIVRO: ${f}\n${x}`).join('\n\n═══════════\n\n');
  console.log(`Extratos: ${Object.keys(cache).length} livros, ${extracts.length} chars\n`);

  const seen = new Set();
  const unique = [];
  let rejeitadas = 0;

  // Acumula com dedupe imediato: assim a 2ª passada de um grupo enxerga o que
  // já entrou e pode pedir jogadas realmente novas.
  //
  // REETIQUETAGEM: o grupo que PEDE um estágio é a autoridade sobre ele. Sem
  // isso o primeiro grupo (rapport/descoberta/apresentação) devolvia meia dúzia
  // de "Fechamento por X" rotulados como "apresentacao", e quando o grupo de
  // fechamento trazia as mesmas técnicas elas morriam no dedupe — o catálogo
  // ficou com ZERO jogadas de fechamento, que simplesmente sumiam do produto.
  const dono = new Map();  // chave → índice em unique
  function absorve(plays, group) {
    let novas = 0, reetiquetadas = 0;
    for (const raw of plays) {
      const p = limpa(raw, group);
      if (!p) { rejeitadas++; continue; }
      const key = chaveNome(p.name);
      if (!key) continue;
      if (seen.has(key)) {
        // Reemissão: aproveita só o que faltava, sem mexer no estágio (quem
        // decide o estágio é o nome da técnica, em normEstagio).
        const atual = unique[dono.get(key)];
        if (atual && p.erroComum && !atual.erroComum) { atual.erroComum = p.erroComum; reetiquetadas++; }
        continue;
      }
      seen.add(key);
      dono.set(key, unique.length);
      unique.push({ n: 0, ...p });
      novas++;
    }
    if (reetiquetadas) process.stdout.write(`[${reetiquetadas} completadas] `);
    return novas;
  }

  for (const group of GROUPS) {
    process.stdout.write(`⏳ jogadas de ${group.label} ... `);
    let t0 = Date.now();
    let novas = absorve(await extractPlays(openai, extracts, group), group);
    console.log(`${novas} jogadas (${Math.round((Date.now() - t0) / 1000)}s)`);

    // Segunda passada quando o grupo veio magro. Objeções e fechamento são
    // justamente onde o coach mais precisa de munição, e a 1ª rodada costuma
    // devolver metade do pedido — com dedupe agressivo sobrava quase nada.
    // (Só conta jogadas que de fato entraram; reetiquetagem não é jogada nova.)
    if (novas < group.min) {
      const jaTenho = unique.filter(p => group.validos.includes(p.estagio)).map(p => p.name);
      process.stdout.write(`   ↻ grupo magro (${novas} < ${group.min}), 2ª passada ... `);
      t0 = Date.now();
      const extra = await extractPlays(openai, extracts, group, jaTenho);
      const n2 = absorve(extra, group);
      console.log(`+${n2} jogadas (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }

  unique.forEach((p, i) => { p.n = i + 1; });

  console.log(`\n${unique.length} jogadas aprovadas · ${rejeitadas} rejeitadas na guarda de qualidade`);
  const porFonte = unique.reduce((a, p) => { a[p.exigeFonte] = (a[p.exigeFonte] || 0) + 1; return a; }, {});
  const porEstagio = unique.reduce((a, p) => { a[p.estagio] = (a[p.estagio] || 0) + 1; return a; }, {});
  console.log('Por estágio:', porEstagio);
  console.log('Dependência de fato:', porFonte);

  if (DRY) {
    fs.writeFileSync(DRY_OUT, JSON.stringify(unique, null, 1), 'utf8');
    console.log(`\n🧪 DRY-RUN — nada gravado no banco. Prévia em ${DRY_OUT}`);
  } else {
    await db.query("UPDATE coach_core SET plays = $1, updated_at = CURRENT_TIMESTAMP WHERE coach_id = 'junior'", [JSON.stringify(unique)]);
    console.log(`\n✅ ${unique.length} jogadas gravadas em coach_core.plays.`);
  }
  console.log('\nAmostra:\n');
  for (const p of unique.slice(0, 6)) {
    console.log(`${p.n}. [${p.estagio}] ${p.name}  (fonte: ${p.exigeFonte})\n   gatilho: ${p.gatilho}\n   mecânica: ${p.mecanica}\n   estrutura: ${p.estrutura}\n   erro comum: ${p.erroComum}\n`);
  }
  await db.pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
