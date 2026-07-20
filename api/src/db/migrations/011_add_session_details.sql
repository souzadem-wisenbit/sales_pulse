-- Detalhes da sessão agendada que antes só existiam no eco do POST e se
-- perdiam no reload: prazo, observações do gestor e tempo máximo de resposta.
ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS due_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS response_time_sec INTEGER DEFAULT 0;
