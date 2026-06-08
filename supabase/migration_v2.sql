-- ============================================================
-- Migración v2 — Ejecutar si ya tienes las tablas de v1
-- Solo añade lo nuevo sin tocar lo existente.
-- ============================================================

-- Tabla de recordatorios (nueva)
CREATE TABLE IF NOT EXISTS reminders (
  id              UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     TEXT  NOT NULL,
  google_event_id TEXT  NOT NULL,
  event_date      DATE  NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, google_event_id, event_date)
);

CREATE INDEX IF NOT EXISTS reminders_sent_at_idx ON reminders (sent_at);
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

-- Ampliar el CHECK de event_log para las nuevas acciones
ALTER TABLE event_log
  DROP CONSTRAINT IF EXISTS event_log_action_check;

ALTER TABLE event_log
  ADD CONSTRAINT event_log_action_check
  CHECK (action IN ('created', 'cancelled', 'overwritten', 'moved', 'noted'));
