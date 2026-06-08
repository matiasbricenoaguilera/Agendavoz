-- ============================================================
-- Agenda por Voz — Esquema Supabase
-- Ejecutar en el SQL Editor de tu proyecto Supabase
-- ============================================================

-- ─── Tabla: users ────────────────────────────────────────
-- Usuarios registrados con preferencias y estado de onboarding.
CREATE TABLE IF NOT EXISTS users (
  telegram_id       TEXT        PRIMARY KEY,
  name              TEXT,
  calendar_id       TEXT,
  status            TEXT        NOT NULL DEFAULT 'onboarding'
                    CHECK (status IN ('onboarding', 'active', 'disabled')),
  -- Preferencias de notificaciones
  reminder_minutes  INTEGER     NOT NULL DEFAULT 30,
  morning_summary   BOOLEAN     NOT NULL DEFAULT true,
  morning_hour      INTEGER     NOT NULL DEFAULT 8,
  evening_preview   BOOLEAN     NOT NULL DEFAULT true,
  weekly_summary    BOOLEAN     NOT NULL DEFAULT true,
  -- Metadata
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Tabla: magic_links ───────────────────────────────────
-- Tokens de acceso temporal para el dashboard de usuario (30 min).
CREATE TABLE IF NOT EXISTS magic_links (
  token       TEXT        PRIMARY KEY,
  telegram_id TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS magic_links_telegram_idx ON magic_links (telegram_id);

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

-- ─── Tabla: reminders ─────────────────────────────────────
-- Evita enviar el mismo recordatorio dos veces para el mismo evento y usuario.
CREATE TABLE IF NOT EXISTS reminders (
  id              UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     TEXT  NOT NULL,
  google_event_id TEXT  NOT NULL,
  event_date      DATE  NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, google_event_id, event_date)
);

CREATE INDEX IF NOT EXISTS reminders_sent_at_idx ON reminders (sent_at);

-- ─── Row Level Security ────────────────────────────────────
-- La función usa la service role key, que omite RLS.
-- Habilitamos RLS de todas formas como buena práctica.
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_links   ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders     ENABLE ROW LEVEL SECURITY;
