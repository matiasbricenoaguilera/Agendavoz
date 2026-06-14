-- ============================================================
-- Migración v4 — Memoria de último evento referenciado
-- Ejecutar si ya tienes las tablas de v1, v2 y v3.
-- ============================================================

-- Guarda una referencia ligera al último evento creado/encontrado/movido
-- por el usuario, para poder resolver referencias como "ese evento" o
-- "muévelo" sin que el usuario repita el resumen y la fecha.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_event JSONB;
