-- ============================================================
-- Agenda por Voz — Esquema Supabase
-- Ejecutar en el SQL Editor de tu proyecto Supabase
-- ============================================================

-- ─── Tabla: conversations ─────────────────────────────────
-- Almacena el estado de conversación activo por usuario.
-- Solo puede haber un estado pendiente por usuario a la vez.
CREATE TABLE IF NOT EXISTS conversations (
  telegram_id   TEXT        PRIMARY KEY,
  state         TEXT        NOT NULL,
  context       JSONB       NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Tabla: event_log ─────────────────────────────────────
-- Historial de todas las acciones realizadas sobre eventos.
CREATE TABLE IF NOT EXISTS event_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     TEXT        NOT NULL,
  calendar_id     TEXT        NOT NULL,
  google_event_id TEXT,
  summary         TEXT,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  transcription   TEXT        DEFAULT '',
  action          TEXT        NOT NULL CHECK (action IN ('created', 'cancelled', 'overwritten')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Índices ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS event_log_telegram_id_idx ON event_log (telegram_id);
CREATE INDEX IF NOT EXISTS event_log_created_at_idx  ON event_log (created_at DESC);

-- ─── Row Level Security ────────────────────────────────────
-- La función usa la service role key, que omite RLS.
-- Habilitamos RLS de todas formas como buena práctica.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log     ENABLE ROW LEVEL SECURITY;
