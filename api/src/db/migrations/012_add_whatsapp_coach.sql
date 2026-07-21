-- WhatsApp Coach: segunda modalidade do Live Coach.
-- O vendedor escaneia o QR do WhatsApp Web; o servidor mantém o socket
-- (Baileys) e o coach sugere respostas por escrito para cada conversa.

-- Sessão do WhatsApp por vendedor. As credenciais do Baileys ficam aqui
-- (e não em disco) para a sessão sobreviver a restart/redeploy do App
-- Service — sem isso o vendedor teria que reescanear o QR a cada deploy.
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    creds JSONB,
    keys JSONB DEFAULT '{}'::jsonb,
    phone VARCHAR(40),
    briefing JSONB DEFAULT '{}'::jsonb,
    connected_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Cada conversa de WhatsApp acompanhada vira uma linha em live_calls
-- (mesma tela de histórico do gestor). 'channel' separa as modalidades.
ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'audio';
ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS contact_name VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_live_calls_channel ON live_calls(channel);
