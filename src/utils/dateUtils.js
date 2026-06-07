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
 * Convierte un Date de UTC a un ISO 8601 con offset explícito de Chile (-04:00).
 * Útil para pasar tiempos a la API de Google Calendar de forma legible.
 */
export function toChileISO(date) {
  const OFFSET_HOURS = -4;
  const localMs = date.getTime() + OFFSET_HOURS * 3600 * 1000;
  const localDate = new Date(localMs);
  const iso = localDate.toISOString().replace('Z', '-04:00');
  return iso;
}

/**
 * Añade N horas a una cadena ISO y retorna una nueva cadena ISO.
 */
export function addHoursToISO(isoString, hours) {
  const date = new Date(isoString);
  return new Date(date.getTime() + hours * 3600 * 1000).toISOString();
}
