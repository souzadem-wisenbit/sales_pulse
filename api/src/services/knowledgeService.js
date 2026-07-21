'use strict';
// ================================================
// Conhecimento do coach (RAG)
// Documento (PDF/texto/imagem) → texto → trechos (~1400 chars) → embedding
// (text-embedding-3-small) → coach_chunks. Na chamada ao vivo, o frontend
// pede os trechos mais próximos da última fala do cliente e injeta no prompt.
// A metodologia inteira fica indexada UMA vez; cada dica lê só o que importa.
// ================================================
const db = require('../db/pool');
const { OpenAI } = require('openai');

const EMBED_MODEL = 'text-embedding-3-small';
const CHUNK_TARGET = 1400;   // chars por trecho — grande o bastante p/ técnica completa
const CHUNK_OVERLAP = 200;   // continuidade entre trechos vizinhos
const MAX_DOC_CHARS = 1200000;

// Cliente cacheado (TTL 5 min): o retrieve roda a cada dica do Live Coach —
// sem cache seriam uma ida ao banco + um client novo por dica, latência pura.
let _openaiCache = { at: 0, client: null };
async function getOpenAI() {
  if (_openaiCache.client && Date.now() - _openaiCache.at < 5 * 60 * 1000) return _openaiCache.client;
  const { rows } = await db.query('SELECT openai_key FROM ai_settings LIMIT 1');
  if (rows.length === 0 || !rows[0].openai_key) {
    throw new Error('Chave OpenAI não configurada nas Configurações.');
  }
  _openaiCache = { at: Date.now(), client: new OpenAI({ apiKey: rows[0].openai_key }) };
  return _openaiCache.client;
}

// ── Extração de texto ──

async function extractPdf(buffer) {
  // pdfjs-dist (legacy) calcula espaços pela posição dos glifos — extrai bem
  // até PDFs de design (Canva etc). Avisos de canvas/DOMMatrix são inofensivos.
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let out = '';
    for (const item of tc.items) {
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    pages.push(out);
    page.cleanup();
  }
  await doc.destroy();
  return { text: pages.join('\n\n'), pages: pages.length };
}

async function extractImage(buffer, mime, openai) {
  // OCR + leitura de layout via modelo de visão: imagens de metodologia
  // (prints, quadros, slides) viram texto indexável.
  const b64 = buffer.toString('base64');
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Transcreva TODO o texto desta imagem em português, preservando títulos e listas. Se houver diagramas/quadros, descreva o conteúdo deles de forma completa e objetiva. Retorne apenas a transcrição, sem comentários.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
  });
  return { text: resp.choices[0]?.message?.content || '', pages: 1 };
}

const TEXT_EXTS = ['.txt', '.md', '.markdown', '.csv', '.rtf'];
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function extOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

function isSupported(filename, mime) {
  const ext = extOf(filename);
  return ext === '.pdf' || TEXT_EXTS.includes(ext) || IMAGE_MIMES.includes(mime);
}

async function extractText(buffer, mime, filename, openai) {
  const ext = extOf(filename);
  if (ext === '.pdf' || mime === 'application/pdf') return await extractPdf(buffer);
  if (IMAGE_MIMES.includes(mime)) return await extractImage(buffer, mime, openai);
  if (TEXT_EXTS.includes(ext) || /^text\//.test(mime || '')) {
    return { text: buffer.toString('utf8'), pages: null };
  }
  throw new Error('Formato não suportado. Envie PDF, imagem (PNG/JPG/WebP) ou texto (.txt/.md/.csv).');
}

// ── Correção de espaçamento ──
// Alguns PDFs não codificam espaços (palavras saem coladas: "Vençacomações").
// Detecta pela proporção de espaços e reconstrói via LLM — custo único, na ingestão.

function needsSpacingFix(text) {
  const len = text.length;
  if (len < 200) return false;
  const spaces = (text.match(/[ \n]/g) || []).length;
  return spaces / len < 0.06;
}

async function fixSpacing(text, openai) {
  const SLICE = 3500;
  const slices = [];
  for (let i = 0; i < text.length; i += SLICE) slices.push(text.slice(i, i + SLICE));
  const out = new Array(slices.length);
  const BATCH = 8;
  for (let i = 0; i < slices.length; i += BATCH) {
    await Promise.all(slices.slice(i, i + BATCH).map(async (slice, j) => {
      try {
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: `O texto abaixo veio de um PDF sem espaços entre as palavras. Reescreva-o EXATAMENTE igual, apenas reinserindo os espaços corretos do português. Não resuma, não corrija, não comente — só devolva o texto com espaços.\n\n${slice}`,
          }],
        });
        out[i + j] = resp.choices[0]?.message?.content || slice;
      } catch (e) {
        out[i + j] = slice; // falhou: segue com o texto colado, ainda é indexável
      }
    }));
  }
  return out.join(' ');
}

// ── Chunking ──
// Corta em parágrafos/frases, acumulando até ~CHUNK_TARGET com overlap.

function chunkText(text) {
  const clean = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];

  const paras = clean.split(/\n\n+/);
  const chunks = [];
  let buf = '';
  const push = () => {
    const c = buf.trim();
    if (c.length > 80) chunks.push(c); // migalha de sumário/rodapé não vira chunk
    buf = '';
  };
  for (let para of paras) {
    // Parágrafo gigante (PDF sem quebras): corta por frase
    while (para.length > CHUNK_TARGET * 1.6) {
      let cut = para.lastIndexOf('. ', CHUNK_TARGET);
      if (cut < CHUNK_TARGET * 0.4) cut = CHUNK_TARGET;
      buf += (buf ? '\n' : '') + para.slice(0, cut + 1);
      push();
      para = para.slice(Math.max(0, cut + 1 - CHUNK_OVERLAP));
    }
    if (buf.length + para.length > CHUNK_TARGET && buf) {
      const tail = buf.slice(-CHUNK_OVERLAP);
      push();
      buf = tail.includes('. ') ? tail.slice(tail.indexOf('. ') + 2) : '';
    }
    buf += (buf ? '\n' : '') + para;
  }
  push();
  return chunks;
}

// ── Embeddings ──

async function embedMany(texts, openai) {
  const vectors = [];
  const BATCH = 100;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map(t => t.slice(0, 6000));
    const resp = await openai.embeddings.create({ model: EMBED_MODEL, input: batch });
    for (const d of resp.data) vectors.push(d.embedding);
  }
  return vectors;
}

function toVectorLiteral(vec) {
  // 7 casas bastam (o vetor é normalizado) e cortam o payload pela metade
  return '[' + vec.map(v => +v.toFixed(7)).join(',') + ']';
}

// ── Pipeline completo de um documento já registrado em coach_documents ──

async function processDocument(docId, buffer) {
  try {
    const { rows } = await db.query('SELECT * FROM coach_documents WHERE id = $1', [docId]);
    if (rows.length === 0) return;
    const doc = rows[0];
    const openai = await getOpenAI();

    let { text, pages } = await extractText(buffer, doc.mime, doc.filename, openai);
    text = String(text || '').slice(0, MAX_DOC_CHARS);
    if (text.replace(/\s+/g, '').length < 80) {
      throw new Error('Não consegui extrair texto deste arquivo (PDF escaneado sem OCR?).');
    }
    if (needsSpacingFix(text)) text = await fixSpacing(text, openai);

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error('Documento sem conteúdo aproveitável.');
    const vectors = await embedMany(chunks, openai);

    await db.query('DELETE FROM coach_chunks WHERE doc_id = $1', [docId]);
    // Insert em lotes: um a um via pooler seriam ~2 min por livro
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const values = [];
      const params = [];
      slice.forEach((content, j) => {
        const base = j * 6;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector)`);
        params.push(docId, doc.coach_id, doc.manager_id, i + j, content, toVectorLiteral(vectors[i + j]));
      });
      await db.query(
        `INSERT INTO coach_chunks (doc_id, coach_id, manager_id, seq, content, embedding) VALUES ${values.join(', ')}`,
        params
      );
    }
    await db.query(
      "UPDATE coach_documents SET status = 'ready', error = NULL, pages = $2, chars = $3, chunk_count = $4 WHERE id = $1",
      [docId, pages, text.length, chunks.length]
    );
    return { chunks: chunks.length, chars: text.length, pages };
  } catch (err) {
    console.error('[KNOWLEDGE PROCESS]', docId, err.message);
    await db.query("UPDATE coach_documents SET status = 'error', error = $2 WHERE id = $1", [docId, String(err.message).slice(0, 500)])
      .catch(() => {});
    throw err;
  }
}

// ── Busca: base global do Júnior + docs do gestor para o coach atribuído ──

async function retrieve({ coachId, managerId, query, k = 4 }) {
  const openai = await getOpenAI();
  const emb = await openai.embeddings.create({ model: EMBED_MODEL, input: [String(query).slice(0, 4000)] });
  const qvec = toVectorLiteral(emb.data[0].embedding);
  const kk = Math.min(8, Math.max(1, k));
  const { rows } = await db.query(`
    SELECT c.content, c.doc_id, (c.embedding <=> $1::vector) AS dist
    FROM coach_chunks c
    JOIN coach_documents d ON d.id = c.doc_id
    WHERE d.status = 'ready' AND (
      (c.manager_id IS NULL AND c.coach_id = 'junior')
      OR (c.manager_id = $2 AND c.coach_id = $3)
    )
    ORDER BY c.embedding <=> $1::vector
    LIMIT $4
  `, [qvec, managerId || null, coachId || 'junior', kk * 3]);
  // Corte de relevância (dist alta = ruído) + diversidade: no máx. 2 trechos
  // por documento — evita a dica virar refém de um único livro de modelos.
  const perDoc = {};
  const picked = [];
  for (const r of rows) {
    if (r.dist >= 0.72) break;
    perDoc[r.doc_id] = (perDoc[r.doc_id] || 0) + 1;
    if (perDoc[r.doc_id] > 2) continue;
    picked.push({ content: r.content });
    if (picked.length >= kk) break;
  }
  return picked;
}

module.exports = { getOpenAI, extractText, chunkText, embedMany, toVectorLiteral, needsSpacingFix, fixSpacing, processDocument, retrieve, isSupported };
