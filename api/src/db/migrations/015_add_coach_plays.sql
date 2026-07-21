-- Catálogo de jogadas do coach: a metodologia vira uma lista ESTRUTURADA de
-- técnicas (nome original + gatilho + execução + frase-modelo). A cada dica o
-- modelo é OBRIGADO a escolher uma jogada por número — identidade da
-- metodologia garantida por mecânica, não por esperança de prompt.
ALTER TABLE coach_core ADD COLUMN IF NOT EXISTS plays JSONB;
