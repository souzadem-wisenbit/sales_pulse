-- Conhecimento do coach (RAG): metodologia em documentos → trechos com embedding.
-- Duas origens, mesma mesa:
--   • manager_id NULL  = base oficial do Júnior (pasta "Material Junior", ingerida por script)
--   • manager_id UUID  = documentos que o gestor sobe pela UI para complementar um coach
-- A busca de dicas SEMPRE une a base do Júnior + os docs do coach atribuído — o material
-- enviado complementa a metodologia padrão, nunca a substitui.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS coach_documents (
    id VARCHAR(50) PRIMARY KEY,
    -- 'junior' = coach padrão | UUID de vendedor = coach-estilo desse colega
    coach_id VARCHAR(80) NOT NULL DEFAULT 'junior',
    manager_id UUID REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    mime VARCHAR(120),
    status VARCHAR(20) DEFAULT 'processing', -- processing | ready | error
    error TEXT,
    pages INTEGER,
    chars INTEGER,
    chunk_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coach_chunks (
    id BIGSERIAL PRIMARY KEY,
    doc_id VARCHAR(50) REFERENCES coach_documents(id) ON DELETE CASCADE,
    coach_id VARCHAR(80) NOT NULL DEFAULT 'junior',
    manager_id UUID,
    seq INTEGER DEFAULT 0,
    content TEXT NOT NULL,
    -- text-embedding-3-small (1536 dims); poucos milhares de linhas → busca exata, sem índice ANN
    embedding vector(1536)
);

CREATE INDEX IF NOT EXISTS idx_coach_chunks_scope ON coach_chunks (coach_id, manager_id);
CREATE INDEX IF NOT EXISTS idx_coach_documents_scope ON coach_documents (coach_id, manager_id);
