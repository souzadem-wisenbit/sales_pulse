-- Gênero e voz do cliente-bot, escolhidos pelo gestor no perfil do cliente.
-- gender: 'male' | 'female' | NULL (automático por nome/emoji)
-- voice:  id da voz OpenAI Realtime (marin, cedar, coral, sage, ...) | NULL (automática)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS voice VARCHAR(20);
