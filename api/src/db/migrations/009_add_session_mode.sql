-- Modalidade da sessão de treinamento escolhida pelo gestor ao atribuir:
-- 'text' = chat por texto (padrão) | 'voice' = ligação por voz em tempo real
ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'text';
