-- ==========================================
-- CLIENTS
-- ==========================================
CREATE TABLE IF NOT EXISTS clients (
    id VARCHAR(50) PRIMARY KEY, -- Usando VARCHAR porque o frontend gera IDs como cli_1782782...
    name VARCHAR(255) NOT NULL,
    emoji VARCHAR(10) DEFAULT '👨‍💼',
    difficulty VARCHAR(20) DEFAULT 'medium',
    description TEXT,
    humanidade INTEGER DEFAULT 50,
    formalidade INTEGER DEFAULT 70,
    nivel_erros INTEGER DEFAULT 10,
    nivel_girias INTEGER DEFAULT 20,
    emotividade INTEGER DEFAULT 40,
    objetividade INTEGER DEFAULT 60,
    sotaque_regiao VARCHAR(50) DEFAULT 'neutro',
    velocidade_resposta VARCHAR(20) DEFAULT 'normal',
    nivel_tecnico INTEGER DEFAULT 35,
    usa_abreviacoes BOOLEAN DEFAULT false,
    usa_maiusculas BOOLEAN DEFAULT false,
    usa_emojis BOOLEAN DEFAULT false,
    faz_perguntas BOOLEAN DEFAULT true,
    skepticism INTEGER DEFAULT 60,
    urgency INTEGER DEFAULT 40,
    price_sensitivity INTEGER DEFAULT 65,
    product_knowledge INTEGER DEFAULT 35,
    negotiation_will INTEGER DEFAULT 50,
    trick_frequency INTEGER DEFAULT 40,
    trick_types JSONB DEFAULT '[]'::jsonb,
    vendedores_atribuidos JSONB DEFAULT '[]'::jsonb,
    archetype VARCHAR(100),
    hidden_agenda TEXT,
    market_segment VARCHAR(100) DEFAULT 'generico',
    hostile_mode BOOLEAN DEFAULT false,
    hostile_competitors JSONB DEFAULT '[]'::jsonb,
    session_constraints JSONB DEFAULT '{}'::jsonb,
    custom_behavior TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- PRODUCTS
-- ==========================================
CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price VARCHAR(100),
    description TEXT,
    benefits JSONB DEFAULT '[]'::jsonb,
    objections JSONB DEFAULT '[]'::jsonb,
    clientes_atribuidos JSONB DEFAULT '[]'::jsonb,
    vendedores_atribuidos JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- SCHEDULED SESSIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS scheduled_sessions (
    id VARCHAR(50) PRIMARY KEY,
    seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
    client_id VARCHAR(50) REFERENCES clients(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending', -- pending, done, cancelled
    show_realtime BOOLEAN DEFAULT true,
    show_report BOOLEAN DEFAULT true,
    scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    done_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- COMPATIBILITY ADJUSTMENTS
-- ==========================================
-- Sessions and messages were using UUID but frontend uses 'sess_123'. We need to fix this.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_session_id_fkey;
ALTER TABLE sessions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE sessions ALTER COLUMN id TYPE VARCHAR(50);
ALTER TABLE messages ALTER COLUMN session_id TYPE VARCHAR(50);
ALTER TABLE messages ADD CONSTRAINT messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE messages ALTER COLUMN id TYPE VARCHAR(50);
