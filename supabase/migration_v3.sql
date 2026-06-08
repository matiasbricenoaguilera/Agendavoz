-- ============================================================
-- Migración v3 — Onboarding, Admin Panel y Dashboard Usuario
-- Ejecutar si ya tienes las tablas de v1 y v2.
-- ============================================================

-- Tabla de usuarios con preferencias
CREATE TABLE IF NOT EXISTS users (
  telegram_id       TEXT        PRIMARY KEY,
  name              TEXT,
  calendar_id       TEXT,
  status            TEXT        NOT NULL DEFAULT 'onboarding'
                    CHECK (status IN ('onboarding', 'active', 'disabled')),
  reminder_minutes  INTEGER     NOT NULL DEFAULT 30,
  morning_summary   BOOLEAN     NOT NULL DEFAULT true,
  morning_hour      INTEGER     NOT NULL DEFAULT 8,
  evening_preview   BOOLEAN     NOT NULL DEFAULT true,
  weekly_summary    BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla de magic links para el dashboard de usuario
CREATE TABLE IF NOT EXISTS magic_links (
  token       TEXT        PRIMARY KEY,
  telegram_id TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS magic_links_telegram_idx ON magic_links (telegram_id);

ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_links ENABLE ROW LEVEL SECURITY;
