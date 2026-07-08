-- Briefing pré-chamada do Live Coach: produtos em venda, ramo do cliente e diretrizes
ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS briefing JSONB DEFAULT '{}'::jsonb;
