-- Isolamento por gestor + atribuição de coach do Live Coach
ALTER TABLE clients ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;
-- coach_id: NULL = coach padrão | 'junior' = Júnior Smarzaro (coach master) | UUID = estilo de outro vendedor
ALTER TABLE users ADD COLUMN IF NOT EXISTS coach_id VARCHAR(80);
