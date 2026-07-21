-- Núcleo destilado da metodologia do coach: os livros inteiros passam por uma
-- destilação offline (api/scripts/distill-junior-core.js) que compila o
-- "sistema operacional de vendas" do coach em um bloco denso. Esse núcleo é o
-- prompt-base PERMANENTE do coach em toda dica (estático → prompt cache),
-- enquanto o RAG (coach_chunks) continua puxando a profundidade do momento.
CREATE TABLE IF NOT EXISTS coach_core (
    coach_id VARCHAR(80) PRIMARY KEY,
    core TEXT NOT NULL,
    model VARCHAR(60),
    source_docs INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
