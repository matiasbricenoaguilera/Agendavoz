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

import { sendMessage }      from '../../src/services/telegram.js';
import { listEvents }        from '../../src/services/calendar.js';
import { getAllActiveUsers }  from '../../src/services/supabase.js';
import {
  formatTimeOnly, getChileDateString, dayBoundsChileISO,
} from '../../src/utils/dateUtils.js';
import { logger } from '../../src/utils/logger.js';

const TIMEZONE = 'America/Santiago';

export const handler = async () => {
  logger.info('Iniciando envío de resumen diario');

  const users = await getAllActiveUsers();
  if (users.length === 0) { logger.warn('Sin usuarios activos'); return { statusCode: 200 }; }

  const today   = new Date();
  const dateStr = getChileDateString(today);
  const { dayStart, dayEnd } = dayBoundsChileISO(dateStr);
  const dayLabel = today.toLocaleDateString('es-CL', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' });

  for (const { chatId, calendarId, morningSummary } of users) {
    if (!morningSummary) continue; // Respeta preferencia del usuario

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
