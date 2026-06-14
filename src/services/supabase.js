/**
 * Servicio de Supabase — gestión de estado de conversación e historial de eventos.
 *
 * Las conversaciones expiran automáticamente si llevan más de 30 minutos
 * sin actividad, evitando estados "fantasma" en la base de datos.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutos
const MAGIC_LINK_TTL_MIN  = 30;             // 30 minutos

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configurados.');
  return createClient(url, key);
}

// ─── Usuarios ─────────────────────────────────────────────────────────────────

/**
 * Retorna el registro de un usuario por su Telegram ID.
 * @returns {Promise<object|null>}
 */
export async function getUserByTelegramId(telegramId) {
  const sb = getClient();
  const { data } = await sb
    .from('users')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .maybeSingle();
  return data ?? null;
}

/**
 * Crea un usuario nuevo en estado 'onboarding'.
 */
export async function createUser(telegramId) {
  const sb = getClient();
  const { data } = await sb
    .from('users')
    .upsert({ telegram_id: String(telegramId), updated_at: new Date().toISOString() }, { onConflict: 'telegram_id' })
    .select()
    .single();
  return data;
}

/**
 * Actualiza campos arbitrarios de un usuario.
 * @param {string|number} telegramId
 * @param {object} updates - Campos a actualizar (name, calendar_id, status, prefs, etc.)
 */
export async function updateUser(telegramId, updates) {
  const sb = getClient();
  const { error } = await sb
    .from('users')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('telegram_id', String(telegramId));
  if (error) logger.error('Error actualizando usuario', { error: error.message });
}

/**
 * Retorna todos los usuarios activos combinando Supabase y USER_CALENDARS (fallback).
 * Los usuarios de Supabase tienen prioridad y sus preferencias se respetan.
 *
 * @returns {Promise<Array<{chatId, calendarId, name, reminderMinutes, morningSummary,
 *           morningHour, eveningPreview, weeklySummary}>>}
 */
export async function getAllActiveUsers() {
  const usersMap = new Map();

  // Fuente 1: Supabase (tiene preferencias individuales)
  try {
    const sb = getClient();
    const { data } = await sb.from('users').select('*').eq('status', 'active');
    for (const u of data ?? []) {
      if (!u.calendar_id) continue;
      usersMap.set(u.telegram_id, {
        chatId:          u.telegram_id,
        calendarId:      u.calendar_id,
        name:            u.name ?? '',
        reminderMinutes: u.reminder_minutes ?? 30,
        morningSummary:  u.morning_summary  ?? true,
        morningHour:     u.morning_hour     ?? 8,
        eveningPreview:  u.evening_preview  ?? true,
        weeklySummary:   u.weekly_summary   ?? true,
      });
    }
  } catch (err) {
    logger.warn('Error leyendo usuarios de Supabase, usando fallback', { err: err.message });
  }

  // Fuente 2: USER_CALENDARS env var (usuarios pre-Supabase)
  const raw = process.env.USER_CALENDARS ?? '';
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const chatId     = entry.slice(0, colonIdx).trim();
    const calendarId = entry.slice(colonIdx + 1).trim();
    if (!usersMap.has(chatId)) {
      usersMap.set(chatId, {
        chatId, calendarId, name: '',
        reminderMinutes: 30, morningSummary: true, morningHour: 8,
        eveningPreview: true, weeklySummary: true,
      });
    }
  }

  return Array.from(usersMap.values());
}

// ─── Magic Links ──────────────────────────────────────────────────────────────

/**
 * Genera un enlace mágico temporal para que el usuario acceda a su dashboard.
 * @returns {Promise<string>} URL completa del dashboard con el token.
 */
export async function generateMagicLink(telegramId) {
  const sb      = getClient();
  const token   = randomUUID();
  const expires = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);

  await sb.from('magic_links').insert({
    token,
    telegram_id: String(telegramId),
    expires_at:  expires.toISOString(),
  });

  const baseUrl = process.env.SITE_URL ?? 'https://agendavoz.netlify.app';
  return `${baseUrl}/mi-agenda?token=${token}`;
}

/**
 * Valida un magic link. Retorna el telegram_id si es válido, o null si no.
 * Marca el token como usado para que sea de un solo uso.
 */
export async function validateMagicLink(token) {
  const sb = getClient();
  const { data } = await sb
    .from('magic_links')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!data) return null;

  await sb.from('magic_links').update({ used: true }).eq('token', token);
  return data.telegram_id;
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
    .maybeSingle();

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

// ─── Recordatorios (deduplicación) ───────────────────────────────────────────

/**
 * Comprueba si ya se envió el recordatorio de un evento para un usuario hoy.
 *
 * @param {string|number} telegramId
 * @param {string}        googleEventId
 * @param {string}        eventDate - "YYYY-MM-DD" del día del evento
 * @returns {Promise<boolean>}
 */
export async function hasReminderBeenSent(telegramId, googleEventId, eventDate) {
  const sb = getClient();
  const { data } = await sb
    .from('reminders')
    .select('id')
    .eq('telegram_id', String(telegramId))
    .eq('google_event_id', googleEventId)
    .eq('event_date', eventDate)
    .maybeSingle();
  return !!data;
}

/**
 * Registra que se envió el recordatorio para un evento.
 *
 * @param {string|number} telegramId
 * @param {string}        googleEventId
 * @param {string}        eventDate - "YYYY-MM-DD"
 */
export async function markReminderSent(telegramId, googleEventId, eventDate) {
  const sb = getClient();
  const { error } = await sb.from('reminders').upsert(
    {
      telegram_id:     String(telegramId),
      google_event_id: googleEventId,
      event_date:      eventDate,
      sent_at:         new Date().toISOString(),
    },
    { onConflict: 'telegram_id,google_event_id,event_date' },
  );
  if (error) logger.error('Error registrando recordatorio', { error: error.message });
  else logger.info('Recordatorio registrado en DB', { telegramId, googleEventId });
}

/**
 * Elimina recordatorios con más de 30 días para mantener la tabla limpia.
 */
export async function cleanOldReminders() {
  const sb = getClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await sb.from('reminders').delete().lt('sent_at', cutoff);
}

// ─── Memoria del último evento referenciado ──────────────────────────────────

/**
 * Retorna la referencia ligera al último evento creado/encontrado/movido
 * por el usuario, o null si no hay ninguna guardada.
 *
 * @param {string|number} telegramId
 * @returns {Promise<{id: string, summary: string, start_time: string, end_time: string}|null>}
 */
export async function getLastEvent(telegramId) {
  const sb = getClient();
  const { data } = await sb
    .from('users')
    .select('last_event')
    .eq('telegram_id', String(telegramId))
    .maybeSingle();
  return data?.last_event ?? null;
}

/**
 * Guarda la referencia al último evento con el que interactuó el usuario.
 * Pasa `null` para limpiarla (e.g. tras cancelar el evento).
 *
 * @param {string|number} telegramId
 * @param {{id: string, summary: string, start_time: string, end_time: string}|null} eventRef
 */
export async function setLastEvent(telegramId, eventRef) {
  await updateUser(telegramId, { last_event: eventRef });
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

/**
 * Retorna los eventos creados/movidos más recientes de un usuario, para
 * darle contexto al NLU sobre sus horarios habituales (e.g. "gimnasio"
 * siempre a las 07:00).
 *
 * @param {string|number} telegramId
 * @param {number} [limit]
 * @returns {Promise<Array<{summary: string, start_time: string}>>}
 */
export async function getRecentEventHistory(telegramId, limit = 15) {
  const sb = getClient();
  const { data } = await sb
    .from('event_log')
    .select('summary, start_time')
    .eq('telegram_id', String(telegramId))
    .in('action', ['created', 'moved'])
    .not('start_time', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  return data ?? [];
}
