/**
 * Servicio de Google Calendar — autenticado con Service Account.
 * Provee: verificación de disponibilidad, creación de eventos y
 * búsqueda de próximos bloques libres de 1 hora.
 */

import { google } from 'googleapis';
import { logger } from '../utils/logger.js';
import { getChileDateString } from '../utils/dateUtils.js';

const TIMEZONE          = 'America/Santiago';
const EVENT_DURATION_MS = 60 * 60 * 1000;     // 1 hora
const WORKDAY_START_H   = 8;                   // 08:00 Chile
const WORKDAY_END_H     = 20;                  // 20:00 Chile
const CHILE_UTC_OFFSET  = '-04:00';

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
  return `${dateStr}T${hh}:${mm}:00${CHILE_UTC_OFFSET}`;
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
 * Verifica si el bloque [startTime, endTime] está libre en el calendario.
 *
 * @param {string} calendarId - ID del calendario a consultar.
 * @returns {Promise<boolean>} true si no hay eventos que se solapen.
 */
export async function checkAvailability(startTime, endTime, calendarId) {
  const calendar = getCalendarClient();

  const response = await calendar.events.list({
    calendarId,
    timeMin:     startTime,
    timeMax:     endTime,
    singleEvents: true,
    orderBy:     'startTime',
  });

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
export async function createCalendarEvent({ summary, start_time, end_time, notes = '', calendarId }) {
  const calendar = getCalendarClient();

  const event = {
    summary,
    description: notes,
    start: { dateTime: start_time, timeZone: TIMEZONE },
    end:   { dateTime: end_time,   timeZone: TIMEZONE },
  };

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

  const response = await calendar.events.list({
    calendarId,
    timeMin:      cursor.toISOString(),
    timeMax:      dayEnd.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
  });

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

  const response = await calendar.events.list({
    calendarId,
    timeMin:      startISO,
    timeMax:      endISO,
    singleEvents: true,
    orderBy:      'startTime',
  });

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
