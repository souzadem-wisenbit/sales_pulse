-- Migration 002: Add manager_id to users

ALTER TABLE users 
ADD COLUMN manager_id UUID REFERENCES users(id) ON DELETE SET NULL;
