ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS product_ids JSONB DEFAULT '[]'::jsonb;
