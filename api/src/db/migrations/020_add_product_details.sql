-- Mais parâmetros no cadastro de produto, num JSONB flexível (sem migração por
-- campo). Alimenta o briefing do coach com munição REAL — em especial os CASES,
-- pra o coach usar prova social verdadeira em vez de inventar.
-- Chaves usadas: icp, diferenciais, cases, garantia, prazo, resultados.
ALTER TABLE products ADD COLUMN IF NOT EXISTS details JSONB;
