/**
 * Servicio de Google Calendar — autenticado con Service Account.
 * Provee: verificación de disponibilidad, creación de eventos y
 * búsqueda de próximos bloques libres de 1 hora.
 */

import { google } from 'googleapis';
import { logger } from '../utils/logger.js';
import { getChileDateString, getChileOffsetString } from '../utils/dateUtils.js';
import { withRetry } from '../utils/retry.js';

const TIMEZONE          = 'America/Santiago';
const EVENT_DURATION_MS = 60 * 60 * 1000;     // 1 hora
const WORKDAY_START_H   = 8;                   // 08:00 Chile
const WORKDAY_END_H     = 20;                  // 20:00 Chile

// Mapeo de categoría → colorId de Google Calendar, para que el usuario
// distinga sus eventos visualmente por tipo de actividad.
export const CATEGORY_COLOR_IDS = {
  trabajo:  '9',  // Blueberry
  salud:    '11', // Tomato
  personal: '8',  // Graphite
  social:   '5',  // Banana
  estudio:  '7',  // Peacock
  otro:     null,
};

export const CATEGORY_EMOJIS = {
  trabajo:  '💼',
  salud:    '🏥',
  personal: '👤',
  social:   '🎉',
  estudio:  '📚',
  otro:     '📌',
};

/** Retorna la categoría correspondiente a un colorId de Google Calendar, o null. */
export function categoryFromColorId(colorId) {
  for (const [category, id] of Object.entries(CATEGORY_COLOR_IDS)) {
    if (id && id === colorId) return category;
  }
  return null;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getCalendarClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no está configurado.');

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// ─── Helpers de fecha ─────────────────────────────────────────────────────────

/**
 * Crea una fecha ISO en hora chilena (con offset -04:00)
 * a partir de una fecha UTC y una hora local chilena.
 */
function makeChileISO(utcDate, chileHour, chileMinute = 0) {
  const dateStr = getChileDateString(utcDate);
  const hh = String(chileHour).padStart(2, '0');
  const mm = String(chileMinute).padStart(2, '0');
  return `${dateStr}T${hh}:${mm}:00${getChileOffsetString(utcDate)}`;
}

/**
 * Redondea un Date UTC hacia arriba a la siguiente hora completa.
 */
function roundUpToNextHour(date) {
  const ms = date.getTime();
  const remainder = ms % EVENT_DURATION_MS;
  return remainder === 0 ? new Date(ms) : new Date(ms + (EVENT_DURATION_MS - remainder));
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Lista los eventos en un rango de tiempo dado.
 * Opcionalmente acepta una cadena de búsqueda para filtrar por título.
 *
 * @param {string} startTime  - ISO string del inicio del rango.
 * @param {string} endTime    - ISO string del fin del rango.
 * @param {string} calendarId - ID del calendario.
 * @param {string} [query]    - Texto de búsqueda opcional.
 * @returns {Promise<Array>}  - Array de eventos de Google Calendar.
 */
export async function listEvents(startTime, endTime, calendarId, query = '') {
  const calendar = getCalendarClient();

  const params = {
    calendarId,
    timeMin:      startTime,
    timeMax:      endTime,
    singleEvents: true,
    orderBy:      'startTime',
  };
  if (query) params.q = query;

  const response = await withRetry(() => calendar.events.list(params), { label: 'listEvents' });
  const items = response.data.items ?? [];
  logger.info('Eventos listados', { cantidad: items.length, startTime, endTime });
  return items;
}

/**
 * Retorna el primer evento que se solapa con el bloque [startTime, endTime].
 * Útil para identificar qué evento bloquea un horario.
 *
 * @param {string} startTime
 * @param {string} endTime
 * @param {string} calendarId
 * @returns {Promise<{id, summary, start, end}|null>}
 */
export async function getBusyEvent(startTime, endTime, calendarId) {
  const calendar = getCalendarClient();

  const response = await withRetry(() => calendar.events.list({
    calendarId,
    timeMin:      startTime,
    timeMax:      endTime,
    singleEvents: true,
    orderBy:      'startTime',
  }), { label: 'getBusyEvent' });

  const first = (response.data.items ?? [])[0];
  if (!first) return null;

  return {
    id:      first.id,
    summary: first.summary ?? 'Evento sin título',
    start:   first.start.dateTime ?? first.start.date,
    end:     first.end.dateTime   ?? first.end.date,
  };
}

/**
 * Obtiene un evento por su ID. Retorna null si no existe.
 *
 * @param {string} eventId    - ID del evento en Google Calendar.
 * @param {string} calendarId - ID del calendario.
 * @returns {Promise<Object|null>}
 */
export async function getEventById(eventId, calendarId) {
  const calendar = getCalendarClient();
  try {
    const response = await withRetry(() => calendar.events.get({ calendarId, eventId }), { label: 'getEventById' });
    return response.data;
  } catch (err) {
    if (err.code === 404 || err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Elimina un evento del calendario por su ID.
 *
 * @param {string} eventId    - ID del evento en Google Calendar.
 * @param {string} calendarId - ID del calendario.
 */
export async function deleteCalendarEvent(eventId, calendarId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId, eventId });
  logger.info('Evento eliminado de Google Calendar', { eventId });
}

/**
 * Actualiza parcialmente un evento existente (PATCH).
 * Solo se aplican los campos presentes en `updates`.
 *
 * @param {string} eventId    - ID del evento a modificar.
 * @param {string} calendarId - ID del calendario.
 * @param {object} updates    - Campos a actualizar (e.g. { start, end, description }).
 * @returns {Promise<Object>} - Evento actualizado devuelto por Google Calendar.
 */
export async function updateCalendarEvent(eventId, calendarId, updates) {
  const calendar = getCalendarClient();
  const response = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: updates,
  });
  logger.info('Evento actualizado en Google Calendar', { eventId, updates });
  return response.data;
}

/**
 * Verifica si el bloque [startTime, endTime] está libre en el calendario.
 *
 * @param {string} calendarId - ID del calendario a consultar.
 * @returns {Promise<boolean>} true si no hay eventos que se solapen.
 */
export async function checkAvailability(startTime, endTime, calendarId) {
  const calendar = getCalendarClient();

  const response = await withRetry(() => calendar.events.list({
    calendarId,
    timeMin:     startTime,
    timeMax:     endTime,
    singleEvents: true,
    orderBy:     'startTime',
  }), { label: 'checkAvailability' });

  const events  = response.data.items ?? [];
  const isFree  = events.length === 0;
  logger.info('Disponibilidad verificada', { startTime, endTime, eventosEncontrados: events.length, libre: isFree });
  return isFree;
}

/**
 * Crea un evento en el calendario indicado.
 *
 * @param {{ summary, start_time, end_time, notes, calendarId }} eventData
 * @returns {Promise<Object>} Objeto del evento creado por Google Calendar.
 */
export async function createCalendarEvent({ summary, start_time, end_time, notes = '', category, calendarId }) {
  const calendar = getCalendarClient();

  const event = {
    summary,
    description: notes,
    start: { dateTime: start_time, timeZone: TIMEZONE },
    end:   { dateTime: end_time,   timeZone: TIMEZONE },
  };

  const colorId = CATEGORY_COLOR_IDS[category];
  if (colorId) event.colorId = colorId;

  const response = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });

  logger.info('Evento creado en Google Calendar', { summary, start_time, eventId: response.data.id });
  return response.data;
}

/**
 * Busca los próximos N bloques libres de 1 hora a partir de referenceStartTime.
 *
 * @param {string} referenceStartTime - ISO string del momento de referencia.
 * @param {number} count              - Cantidad de slots libres a retornar.
 * @param {string} calendarId         - ID del calendario a consultar.
 * @returns {Promise<Array<{start: string, end: string}>>}
 */
export async function findNextFreeSlots(referenceStartTime, count = 2, calendarId) {
  const calendar = getCalendarClient();
  const refDate  = new Date(referenceStartTime);

  // Límite del día laboral en Chile
  const dayEndISO  = makeChileISO(refDate, WORKDAY_END_H);
  const dayEnd     = new Date(dayEndISO);

  // Inicio de búsqueda: redondeamos el tiempo de referencia a la siguiente hora completa
  let cursor = roundUpToNextHour(refDate);

  // No buscar más allá del horario laboral de hoy
  if (cursor >= dayEnd) {
    return findSlotsNextDay(calendar, refDate, count, calendarId);
  }

  const response = await withRetry(() => calendar.events.list({
    calendarId,
    timeMin:      cursor.toISOString(),
    timeMax:      dayEnd.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
  }), { label: 'findNextFreeSlots' });

  const events = (response.data.items ?? []).map((e) => ({
    start: new Date(e.start.dateTime ?? e.start.date),
    end:   new Date(e.end.dateTime   ?? e.end.date),
  }));

  const freeSlots = [];

  for (const event of events) {
    // Llenar con slots hasta que choque con este evento
    while (
      freeSlots.length < count &&
      cursor.getTime() + EVENT_DURATION_MS <= event.start.getTime()
    ) {
      freeSlots.push(buildSlot(cursor));
      cursor = new Date(cursor.getTime() + EVENT_DURATION_MS);
    }
    // Avanzar el cursor más allá del evento
    if (event.end > cursor) {
      cursor = roundUpToNextHour(event.end);
    }
  }

  // Slots después del último evento hasta el fin del día
  while (freeSlots.length < count && cursor.getTime() + EVENT_DURATION_MS <= dayEnd.getTime()) {
    freeSlots.push(buildSlot(cursor));
    cursor = new Date(cursor.getTime() + EVENT_DURATION_MS);
  }

  // Si no hubo suficientes hoy, completamos con el día siguiente
  if (freeSlots.length < count) {
    const nextDaySlots = await findSlotsNextDay(calendar, refDate, count - freeSlots.length, calendarId);
    freeSlots.push(...nextDaySlots);
  }

  logger.info('Slots libres encontrados', { cantidad: freeSlots.length });
  return freeSlots;
}

// ─── Helpers privados ────────────────────────────────────────────────────────

function buildSlot(cursorDate) {
  return {
    start: cursorDate.toISOString(),
    end:   new Date(cursorDate.getTime() + EVENT_DURATION_MS).toISOString(),
  };
}

async function findSlotsNextDay(calendar, refDate, count, calendarId) {
  const tomorrow = new Date(refDate.getTime() + 24 * 60 * 60 * 1000);
  const startISO = makeChileISO(tomorrow, 9);  // 09:00 del día siguiente
  const endISO   = makeChileISO(tomorrow, WORKDAY_END_H);

  const response = await withRetry(() => calendar.events.list({
    calendarId,
    timeMin:      startISO,
    timeMax:      endISO,
    singleEvents: true,
    orderBy:      'startTime',
  }), { label: 'findSlotsNextDay' });

  const events = (response.data.items ?? []).map((e) => ({
    start: new Date(e.start.dateTime ?? e.start.date),
    end:   new Date(e.end.dateTime   ?? e.end.date),
  }));

  let cursor     = new Date(startISO);
  const dayEnd   = new Date(endISO);
  const slots    = [];

  for (const event of events) {
    while (slots.length < count && cursor.getTime() + EVENT_DURATION_MS <= event.start.getTime()) {
      slots.push(buildSlot(cursor));
      cursor = new Date(cursor.getTime() + EVENT_DURATION_MS);
    }
    if (event.end > cursor) cursor = roundUpToNextHour(event.end);
  }

  while (slots.length < count && cursor.getTime() + EVENT_DURATION_MS <= dayEnd.getTime()) {
    slots.push(buildSlot(cursor));
    cursor = new Date(cursor.getTime() + EVENT_DURATION_MS);
  }

  return slots;
}
