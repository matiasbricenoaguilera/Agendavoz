-- ============================================================
-- Migración v8 — Deshacer acciones recientes ("↩️ Deshacer")
-- Ejecutar si ya tienes las tablas de v1 a v7.
-- ============================================================

-- Guarda los datos necesarios para revertir la última acción del usuario
-- (agendar, sobreescribir, cancelar, mover, anotar o editar). Cada fila se
-- consume una sola vez (used = true) y solo es válida por unos minutos
-- (ver UNDO_TTL_MS en src/services/supabase.js).
CREATE TABLE IF NOT EXISTS undo_actions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id TEXT        NOT NULL,
  calendar_id TEXT        NOT NULL,
  action_type TEXT        NOT NULL CHECK (action_type IN (
    'delete_event', 'restore_overwrite', 'restore_cancelled',
    'restore_move', 'restore_note', 'restore_edit'
  )),
  payload     JSONB       NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS undo_actions_telegram_id_idx ON undo_actions (telegram_id);

-- Sin políticas: solo el backend (vía SUPABASE_SERVICE_ROLE_KEY, que ignora RLS)
-- puede leer/escribir esta tabla. Las claves anon/authenticated quedan bloqueadas.
ALTER TABLE undo_actions ENABLE ROW LEVEL SECURITY;
