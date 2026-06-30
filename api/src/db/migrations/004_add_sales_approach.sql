ALTER TABLE scheduled_sessions ADD COLUMN IF NOT EXISTS sales_approach VARCHAR(20) DEFAULT 'active';
