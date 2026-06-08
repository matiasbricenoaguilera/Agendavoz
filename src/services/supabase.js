/**
 * Servicio de Supabase — gestión de estado de conversación e historial de eventos.
 *
 * Las conversaciones expiran automáticamente si llevan más de 30 minutos
 * sin actividad, evitando estados "fantasma" en la base de datos.
 */

import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutos

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configurados.');
  return createClient(url, key);
}

// ─── Estado de conversación ───────────────────────────────────────────────────

/**
 * Carga el estado de conversación activo para un usuario.
 * Retorna null si no existe o si expiró (> 30 min sin actividad).
 *
 * @param {string|number} telegramId
 * @returns {Promise<{state: string, context: object}|null>}
 */
export async function getConversation(telegramId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('conversations')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .single();

  if (error || !data) return null;

  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > CONVERSATION_TTL_MS) {
    logger.info('Conversación expirada, limpiando', { telegramId });
    await clearConversation(telegramId);
    return null;
  }

  return { state: data.state, context: data.context ?? {} };
}

/**
 * Guarda o actualiza el estado de conversación para un usuario.
 *
 * @param {string|number} telegramId
 * @param {string}        state   - Nombre del estado (e.g. 'AWAITING_CONFIRMATION')
 * @param {object}        context - Datos necesarios para retomar la conversación
 */
export async function saveConversation(telegramId, state, context = {}) {
  const sb = getClient();
  const { error } = await sb.from('conversations').upsert(
    {
      telegram_id: String(telegramId),
      state,
      context,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'telegram_id' },
  );

  if (error) logger.error('Error guardando conversación en Supabase', { error: error.message });
  else logger.info('Estado de conversación guardado', { telegramId, state });
}

/**
 * Elimina el estado de conversación de un usuario.
 *
 * @param {string|number} telegramId
 */
export async function clearConversation(telegramId) {
  const sb = getClient();
  await sb.from('conversations').delete().eq('telegram_id', String(telegramId));
  logger.info('Estado de conversación eliminado', { telegramId });
}

// ─── Historial de eventos ─────────────────────────────────────────────────────

/**
 * Registra una acción (creación, cancelación o sobreescritura) en el historial.
 *
 * @param {string|number} telegramId
 * @param {string}        calendarId
 * @param {object}        eventData
 * @param {string}        [eventData.id]            - ID del evento en Google Calendar
 * @param {string}        eventData.summary
 * @param {string}        [eventData.start_time]    - ISO string
 * @param {string}        [eventData.end_time]      - ISO string
 * @param {string}        [eventData.transcription]
 * @param {'created'|'cancelled'|'overwritten'} eventData.action
 */
export async function logEvent(telegramId, calendarId, eventData) {
  const sb = getClient();
  const { error } = await sb.from('event_log').insert({
    telegram_id:     String(telegramId),
    calendar_id:     calendarId,
    google_event_id: eventData.id ?? null,
    summary:         eventData.summary ?? '',
    start_time:      eventData.start_time ?? null,
    end_time:        eventData.end_time ?? null,
    transcription:   eventData.transcription ?? '',
    action:          eventData.action,
  });

  if (error) logger.error('Error guardando log en Supabase', { error: error.message });
  else logger.info('Evento registrado en historial', { telegramId, action: eventData.action, summary: eventData.summary });
}
