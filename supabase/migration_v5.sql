-- ============================================================
-- Migración v5 — Edición de eventos y recordatorios de confirmaciones pendientes
-- Ejecutar si ya tienes las tablas de v1, v2, v3 y v4.
-- ============================================================

-- Permite registrar en el historial cuando se edita el título/descripción
-- de un evento (intent "editar").
ALTER TABLE event_log
  DROP CONSTRAINT IF EXISTS event_log_action_check;

ALTER TABLE event_log
  ADD CONSTRAINT event_log_action_check
  CHECK (action IN ('created', 'cancelled', 'overwritten', 'moved', 'noted', 'edited'));

-- Marca si ya se envió un recordatorio "¿sigues ahí?" para una conversación
-- pendiente de confirmación, para no enviarlo más de una vez.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS nudged BOOLEAN NOT NULL DEFAULT false;
