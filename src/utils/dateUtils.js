/**
 * Utilidades de fecha y hora para la zona horaria de Chile (America/Santiago).
 * Chile en junio (invierno) opera en UTC-4.
 */

const TIMEZONE = 'America/Santiago';
const LOCALE   = 'es-CL';

/**
 * Retorna la cadena de fecha en formato YYYY-MM-DD en hora de Chile
 * a partir de cualquier Date (que internamente está en UTC).
 * Truco: el locale sv-SE produce el formato ISO YYYY-MM-DD.
 */
export function getChileDateString(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

/**
 * Formatea una fecha ISO/UTC para mostrarla al usuario en español:
 * "lunes 8 de junio, 15:00"
 */
export function formatDateTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(LOCALE, {
    timeZone: TIMEZONE,
    weekday: 'long',
    day:     'numeric',
    month:   'long',
    hour:    '2-digit',
    minute:  '2-digit',
    hour12:  false,
  });
}

/**
 * Formatea solo la hora en hora de Chile: "16:00"
 */
export function formatTimeOnly(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(LOCALE, {
    timeZone: TIMEZONE,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

/**
 * Calcula el offset UTC vigente para Chile en una fecha dada,
 * detectando automáticamente horario de verano (UTC-3) o invierno (UTC-4).
 *
 * @param {Date} [date] - Fecha de referencia (por defecto, ahora).
 * @returns {string}    - "-03:00" o "-04:00"
 */
export function getChileOffsetString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-4';
  const match = tzName.match(/GMT([+-]\d+)/);
  const hours = match ? parseInt(match[1], 10) : -4;
  const sign = hours < 0 ? '-' : '+';
  return `${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}

/**
 * Convierte un Date de UTC a un ISO 8601 con offset explícito de Chile,
 * detectando automáticamente horario de verano/invierno.
 * Útil para pasar tiempos a la API de Google Calendar de forma legible.
 */
export function toChileISO(date) {
  const offsetStr   = getChileOffsetString(date);
  const offsetHours = parseInt(offsetStr.slice(0, 3), 10);
  const localMs     = date.getTime() + offsetHours * 3600 * 1000;
  const localDate   = new Date(localMs);
  return localDate.toISOString().replace('Z', offsetStr);
}

/**
 * Añade N horas a una cadena ISO y retorna una nueva cadena ISO.
 */
export function addHoursToISO(isoString, hours) {
  const date = new Date(isoString);
  return new Date(date.getTime() + hours * 3600 * 1000).toISOString();
}

/**
 * Formatea solo la fecha (sin hora) en español legible:
 * "lunes 8 de junio"
 */
export function formatDateLong(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString(LOCALE, {
    timeZone: TIMEZONE,
    weekday: 'long',
    day:     'numeric',
    month:   'long',
  });
}

/**
 * Extrae solo la parte de fecha "YYYY-MM-DD" de un ISO string.
 */
export function extractDateFromISO(isoString) {
  return isoString.split('T')[0];
}

/**
 * Extrae solo la parte de hora "HH:MM" de un ISO string.
 */
export function extractTimeFromISO(isoString) {
  return isoString.split('T')[1]?.slice(0, 5) ?? '12:00';
}

/**
 * Construye un ISO string para Chile (offset detectado según temporada) combinando una fecha y una hora.
 *
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} timeStr - "HH:MM"
 * @returns {string}       - "YYYY-MM-DDTHH:MM:00-04:00" o "-03:00" según corresponda
 */
export function buildChileISO(dateStr, timeStr) {
  const offsetStr = getChileOffsetString(new Date(`${dateStr}T12:00:00Z`));
  return `${dateStr}T${timeStr}:00${offsetStr}`;
}

/**
 * Retorna un ISO string con offset Chile (según temporada) sumando milisegundos a otro ISO.
 */
export function addMsToChileISO(isoString, ms) {
  const newDate = new Date(new Date(isoString).getTime() + ms);
  return toChileISO(newDate);
}

/**
 * Re-normaliza un ISO string para que use el offset correcto de Chile según
 * la fecha que contiene, sin modificar la fecha/hora local indicada.
 * Corrige offsets incorrectos (e.g. -04:00 generados en horario de verano).
 */
export function normalizeToChileISO(isoString) {
  const dateStr = isoString.slice(0, 10);
  const timeStr = isoString.slice(11, 16);
  return buildChileISO(dateStr, timeStr);
}

/**
 * Retorna el inicio y fin de un día completo en hora de Chile,
 * con el offset correcto según la temporada de esa fecha.
 *
 * @param {string} dateStr - "YYYY-MM-DD"
 * @returns {{dayStart: string, dayEnd: string}}
 */
export function dayBoundsChileISO(dateStr) {
  const offsetStr = getChileOffsetString(new Date(`${dateStr}T12:00:00Z`));
  return {
    dayStart: `${dateStr}T00:00:00${offsetStr}`,
    dayEnd:   `${dateStr}T23:59:59${offsetStr}`,
  };
}
