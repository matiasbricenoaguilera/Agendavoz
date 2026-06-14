-- ============================================================
-- Migración v6 — Categorías automáticas de eventos
-- Ejecutar si ya tienes las tablas de v1 a v5.
-- ============================================================

-- Guarda la categoría inferida por el NLU (trabajo, salud, personal,
-- social, estudio, otro) para cada evento creado, para poder agrupar
-- el resumen semanal por tipo de actividad.
ALTER TABLE event_log ADD COLUMN IF NOT EXISTS category TEXT;
