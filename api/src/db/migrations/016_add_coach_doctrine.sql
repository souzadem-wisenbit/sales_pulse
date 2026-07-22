-- Doutrina por estágio da venda: o que Júnior ensina para CADA momento
-- (objetivo, condutas, proibições, pré-requisito para avançar). Sem isso o
-- coach oferecia produto no primeiro "oi" — a metodologia proíbe.
ALTER TABLE coach_core ADD COLUMN IF NOT EXISTS doctrine JSONB;
