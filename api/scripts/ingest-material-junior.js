'use strict';
// ================================================
// Ingestão da base oficial do Júnior (pasta "Material Junior")
// Uso (da pasta api/):
//   node scripts/ingest-material-junior.js [--db="postgresql://...pooler..."] [--force]
//
// Cada PDF vira um coach_document GLOBAL (coach_id='junior', manager_id=NULL):
// é a metodologia padrão que TODO vendedor recebe no Live Coach, seja qual
// for o coach atribuído. Roda uma vez por arquivo (idempotente): arquivos já
// ingeridos com sucesso são pulados, a menos que --force.
//
// Atenção nesta rede: a conexão direta do Supabase (db.xxx.supabase.co) é
// IPv6-only — use a connection string do POOLER no --db.
// ================================================
const path = require('path');
const fs = require('fs');

// --db precisa valer ANTES de carregar o pool (dotenv não sobrescreve env já setada)
const dbArg = process.argv.find(a => a.startsWith('--db='));
if (dbArg) process.env.DATABASE_URL = dbArg.slice(5);
const FORCE = process.argv.includes('--force');

const db = require('../src/db/pool');
const knowledge = require('../src/services/knowledgeService');

const DIR = path.join(__dirname, '..', '..', 'Material Junior');

(async () => {
  const files = fs.readdirSync(DIR).filter(f => knowledge.isSupported(f, ''));
  console.log(`Pasta: ${DIR}`);
  console.log(`${files.length} arquivo(s) suportado(s)\n`);

  let ok = 0, skipped = 0, failed = 0;
  for (const filename of files) {
    const { rows } = await db.query(
      "SELECT id, status FROM coach_documents WHERE manager_id IS NULL AND coach_id = 'junior' AND filename = $1",
      [filename]
    );
    if (rows.length > 0 && rows[0].status === 'ready' && !FORCE) {
      console.log(`↷ ${filename} — já ingerido, pulando`);
      skipped++;
      continue;
    }
    if (rows.length > 0) {
      await db.query('DELETE FROM coach_documents WHERE id = $1', [rows[0].id]); // chunks caem por CASCADE
    }

    const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const mime = filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain';
    await db.query(
      "INSERT INTO coach_documents (id, coach_id, manager_id, filename, mime) VALUES ($1, 'junior', NULL, $2, $3)",
      [id, filename, mime]
    );

    process.stdout.write(`⏳ ${filename} ... `);
    const t0 = Date.now();
    try {
      const r = await knowledge.processDocument(id, fs.readFileSync(path.join(DIR, filename)));
      console.log(`OK — ${r.pages ?? '?'} págs, ${r.chars} chars, ${r.chunks} trechos (${Math.round((Date.now() - t0) / 1000)}s)`);
      ok++;
    } catch (e) {
      console.log(`ERRO — ${e.message}`);
      failed++;
    }
  }

  const { rows: tot } = await db.query(
    "SELECT COUNT(*)::int AS docs, COALESCE(SUM(chunk_count),0)::int AS chunks FROM coach_documents WHERE manager_id IS NULL AND coach_id = 'junior' AND status = 'ready'"
  );
  console.log(`\nResumo: ${ok} ingerido(s), ${skipped} pulado(s), ${failed} falha(s)`);
  console.log(`Base global do Júnior: ${tot[0].docs} documentos, ${tot[0].chunks} trechos indexados`);
  await db.pool.end();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
