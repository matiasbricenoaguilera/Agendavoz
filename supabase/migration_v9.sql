-- ============================================================
-- Migración v9 — Correcciones de título ("✏️ Editar título")
-- Ejecutar si ya tienes las tablas de v1 a v8.
-- ============================================================

-- Guarda los pares original → corregido cuando el usuario edita el título
-- de un evento recién agendado. Se usa para mejorar el vocabulario de Whisper
-- en futuras transcripciones del mismo usuario.
CREATE TABLE IF NOT EXISTS title_corrections (
  id          BIGSERIAL   PRIMARY KEY,
  telegram_id TEXT        NOT NULL,
  original    TEXT        NOT NULL,
  corrected   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS title_corrections_telegram_id_idx ON title_corrections (telegram_id);

-- Sin políticas: solo el backend (vía SUPABASE_SERVICE_ROLE_KEY, que ignora RLS)
-- puede leer/escribir esta tabla. Las claves anon/authenticated quedan bloqueadas.
ALTER TABLE title_corrections ENABLE ROW LEVEL SECURITY;
