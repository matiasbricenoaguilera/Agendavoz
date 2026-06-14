-- ============================================================
-- Migración v7 — Tracking de consumo de APIs de IA (OpenAI)
-- Ejecutar si ya tienes las tablas de v1 a v6.
-- ============================================================

-- Registra cada llamada a OpenAI (Whisper STT o GPT-4o-mini NLU) para
-- poder estimar costos y uso por usuario en el panel de administración.
CREATE TABLE IF NOT EXISTS api_usage (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  telegram_id   TEXT,
  model         TEXT NOT NULL,
  kind          TEXT NOT NULL,  -- 'chat' | 'stt'
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  audio_seconds NUMERIC,
  cost_usd      NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage (created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_telegram_id ON api_usage (telegram_id);

-- Sin políticas: solo el backend (vía SUPABASE_SERVICE_ROLE_KEY, que ignora RLS)
-- puede leer/escribir esta tabla. Las claves anon/authenticated quedan bloqueadas.
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
