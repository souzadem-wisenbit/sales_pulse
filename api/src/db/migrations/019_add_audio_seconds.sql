-- Transcrição (Whisper) também passa a rodar no backend e é medida por tenant.
-- Whisper é cobrado por MINUTO de áudio (não por token), então guardamos os
-- segundos transcritos aqui. Linhas de transcrição têm audio_seconds > 0 e
-- tokens 0; linhas de dica têm tokens > 0 e audio_seconds NULL.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS audio_seconds INTEGER;
