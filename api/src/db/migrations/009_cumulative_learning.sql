-- Aprendizado cumulativo: histórico de eventos (chamadas reais + treinamentos)
-- que alimenta o dossiê evolutivo de cada vendedor
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS history JSONB DEFAULT '[]'::jsonb;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS trainings_analyzed INTEGER DEFAULT 0;
