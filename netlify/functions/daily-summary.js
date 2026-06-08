/**
 * Netlify Scheduled Function: daily-summary
 *
 * Envía automáticamente el resumen del día a todos los usuarios registrados
 * en USER_CALENDARS. Se ejecuta de lunes a viernes a las 08:00 hora Chile
 * (12:00 UTC con Chile en UTC-4).
 *
 * Configuración del cron en netlify.toml:
 *   schedule = "0 12 * * 1-5"
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage }   from '../../src/services/telegram.js';
import { listEvents }    from '../../src/services/calendar.js';
import {
  formatTimeOnly, formatDateLong, getChileDateString,
} from '../../src/utils/dateUtils.js';
import { logger } from '../../src/utils/logger.js';

const TIMEZONE        = 'America/Santiago';
const CHILE_UTC_OFFSET = '-04:00';

export const handler = async () => {
  logger.info('Iniciando envío de resumen diario');

  const raw     = process.env.USER_CALENDARS ?? '';
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);

  if (entries.length === 0) {
    logger.warn('USER_CALENDARS vacío, nada que enviar');
    return { statusCode: 200 };
  }

  const today   = new Date();
  const dateStr = getChileDateString(today);
  const dayStart = `${dateStr}T00:00:00${CHILE_UTC_OFFSET}`;
  const dayEnd   = `${dateStr}T23:59:59${CHILE_UTC_OFFSET}`;
  const dayLabel = today.toLocaleDateString('es-CL', {
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

      let msg = `🌅 <b>Buenos días! Tu agenda del ${dayLabel}:</b>\n\n`;

      if (events.length === 0) {
        msg += `✨ No tienes eventos programados para hoy.\n¡Que tengas un excelente día! 🌟`;
      } else {
        events.forEach((e, i) => {
          const startStr = e.start.dateTime ? formatTimeOnly(e.start.dateTime) : 'Todo el día';
          const endStr   = e.end.dateTime   ? formatTimeOnly(e.end.dateTime)   : '';
          msg += `${i + 1}. <b>${escapeHtml(e.summary ?? 'Sin título')}</b>\n`;
          msg += `   🕐 ${startStr}${endStr ? ` — ${endStr}` : ''}\n`;
          if (e.description) msg += `   📝 ${escapeHtml(e.description.slice(0, 80))}\n`;
          msg += '\n';
        });
        msg += `¡Que tengas un gran día! 🌟`;
      }

      await sendMessage(chatId, msg);
      logger.info('Resumen diario enviado', { chatId, eventos: events.length });

    } catch (err) {
      logger.error('Error enviando resumen a usuario', { chatId, error: err.message });
    }
  }

  return { statusCode: 200 };
};

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
