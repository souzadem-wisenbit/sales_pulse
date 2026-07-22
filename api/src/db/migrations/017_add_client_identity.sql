-- Identidade da EMPRESA do cliente-bot.
--
-- Antes existia só `market_segment`, que entrava no prompt como contexto de
-- mercado ("regulação intensa, margens apertadas"), nunca como identidade do
-- personagem. Resultado numa chamada real: o vendedor disse "na sua farmácia"
-- e o bot respondeu "quem disse que eu tenho farmácia, véi?" — o treino perdeu
-- a credibilidade no meio, porque os dois lados não concordavam sobre quem era
-- o cliente. Aqui a empresa vira fato do personagem.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_name  VARCHAR(160);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_about TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_size  VARCHAR(60);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_city  VARCHAR(120);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_role  VARCHAR(120);
