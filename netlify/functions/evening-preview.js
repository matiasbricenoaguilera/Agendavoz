/**
 * Netlify Scheduled Function: evening-preview
 *
 * Cada día a las 21:00 hora Chile (01:00 UTC) envía un preview
 * de los eventos del día siguiente a todos los usuarios registrados.
 *
 * netlify.toml: schedule = "0 1 * * *"
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage }   from '../../src/services/telegram.js';
import { listEvents }    from '../../src/services/calendar.js';
import { formatTimeOnly, formatDateLong, getChileDateString } from '../../src/utils/dateUtils.js';
import { logger } from '../../src/utils/logger.js';

const TIMEZONE         = 'America/Santiago';
const CHILE_UTC_OFFSET = '-04:00';

export const handler = async () => {
  logger.info('Iniciando preview nocturno del día siguiente');

  const raw     = process.env.USER_CALENDARS ?? '';
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);

  if (entries.length === 0) {
    logger.warn('USER_CALENDARS vacío');
    return { statusCode: 200 };
  }

  // Calcular mañana en hora Chile
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dateStr  = getChileDateString(tomorrow);
  const dayStart = `${dateStr}T00:00:00${CHILE_UTC_OFFSET}`;
  const dayEnd   = `${dateStr}T23:59:59${CHILE_UTC_OFFSET}`;
  const dayLabel = tomorrow.toLocaleDateString('es-CL', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day:     'numeric',
    month:   'long',
  });

  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;

    const chatId     = entry.slice(0, colonIdx).trim();
    const calendarId = entry.slice(colonIdx + 1).trim();

    try {
      const events = await listEvents(dayStart, dayEnd, calendarId);

      let msg = `🌙 <b>Mañana es ${dayLabel}:</b>\n\n`;

      if (events.length === 0) {
        msg += `✨ No tienes eventos programados para mañana.\n¡Buenas noches! 🌟`;
      } else {
        msg += `Tienes <b>${events.length}</b> evento${events.length > 1 ? 's' : ''}:\n\n`;
        events.forEach((e, i) => {
          const startStr = e.start.dateTime ? formatTimeOnly(e.start.dateTime) : 'Todo el día';
          const endStr   = e.end.dateTime   ? formatTimeOnly(e.end.dateTime)   : '';
          msg += `${i + 1}. <b>${escapeHtml(e.summary ?? 'Sin título')}</b>\n`;
          msg += `   🕐 ${startStr}${endStr ? ` — ${endStr}` : ''}\n`;
          if (e.description) msg += `   📝 ${escapeHtml(e.description.slice(0, 80))}\n`;
          msg += '\n';
        });
        msg += `¡Buenas noches! 🌙`;
      }

      await sendMessage(chatId, msg);
      logger.info('Preview nocturno enviado', { chatId, eventos: events.length });

    } catch (err) {
      logger.error('Error enviando preview nocturno', { chatId, error: err.message });
    }
  }

  return { statusCode: 200 };
};

function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
