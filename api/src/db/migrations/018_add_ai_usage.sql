-- ==========================================
-- MEDIÇÃO DE USO DE IA (por usuário → rollup por tenant/gestor)
-- ------------------------------------------
-- Toda dica do Live Coach passa a ser gerada no BACKEND (a chave da OpenAI
-- nunca vai para o navegador). Cada chamada registra os tokens gastos aqui,
-- para faturar por tenant e vigiar a margem (o custo da OpenAI é variável).
-- Log append-only: sem FK, para preservar o histórico mesmo se o usuário
-- for removido. O rollup por gestor sai de manager_id (preenchido no insert)
-- ou de um JOIN em users.manager_id no relatório.
-- ==========================================
CREATE TABLE IF NOT EXISTS ai_usage (
    id                BIGSERIAL PRIMARY KEY,
    user_id           UUID,
    manager_id        UUID,
    model             TEXT,
    source            TEXT,               -- 'live_coach' | 'whatsapp_coach' | 'coach'
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON ai_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_mgr_time  ON ai_usage (manager_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_time      ON ai_usage (created_at);
