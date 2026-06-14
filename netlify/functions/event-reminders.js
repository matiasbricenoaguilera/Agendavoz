/**
 * Netlify Scheduled Function: event-reminders
 *
 * Corre cada 15 minutos. Busca eventos que comiencen en los próximos 20–45 minutos
 * y envía un recordatorio si aún no se ha enviado (deduplicación en Supabase).
 *
 * netlify.toml: schedule = "* /15 * * * *" (sin el espacio: cada 15 minutos)
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage }       from '../../src/services/telegram.js';
import { listEvents }        from '../../src/services/calendar.js';
import {
  getAllActiveUsers, hasReminderBeenSent, markReminderSent, cleanOldReminders,
}                            from '../../src/services/supabase.js';
import { formatTimeOnly, getChileDateString } from '../../src/utils/dateUtils.js';
import { logger }            from '../../src/utils/logger.js';

const DEFAULT_WINDOW_MIN = 25; // Ventana de detección alrededor de los minutos configurados

export const handler = async () => {
  logger.info('Ejecutando chequeo de recordatorios');

  const users = await getAllActiveUsers();
  if (users.length === 0) return { statusCode: 200 };

  if (Math.random() < 0.05) await cleanOldReminders().catch(() => {});

  const now = new Date();

  for (const { chatId, calendarId, reminderMinutes } of users) {
    // Ventana centrada en reminderMinutes con ±12 min de margen para cubrir la ejecución cada 15 min
    const margin     = 12;
    const windowFrom = new Date(now.getTime() + (reminderMinutes - margin) * 60 * 1000);
    const windowTo   = new Date(now.getTime() + (reminderMinutes + margin) * 60 * 1000);

    try {
      const events = await listEvents(windowFrom.toISOString(), windowTo.toISOString(), calendarId);

      for (const event of events) {
        if (!event.id || !event.start.dateTime) continue;

        const eventDate = getChileDateString(new Date(event.start.dateTime));
        const alreadySent = await hasReminderBeenSent(chatId, event.id, eventDate);
        if (alreadySent) continue;

        const startStr    = formatTimeOnly(event.start.dateTime);
        const endStr      = event.end.dateTime ? formatTimeOnly(event.end.dateTime) : '';
        const minutesLeft = Math.round((new Date(event.start.dateTime) - now) / 60000);

        const msg =
          `⏰ <b>Recordatorio — en ~${minutesLeft} minutos:</b>\n\n` +
          `📌 <b>${escapeHtml(event.summary ?? 'Sin título')}</b>\n` +
          `🕐 ${startStr}${endStr ? ` — ${endStr}` : ''}\n` +
          (event.description ? `📝 ${escapeHtml(event.description.slice(0, 120))}\n` : '') +
          `\n¡Prepárate! 🎯`;

        await sendMessage(chatId, msg, {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Ok',              callback_data: `ok:${event.id}` },
              { text: '⏰ Posponer 15 min', callback_data: `postpone15:${event.id}` },
            ]],
          },
        });
        await markReminderSent(chatId, event.id, eventDate);
        logger.info('Recordatorio enviado', { chatId, eventId: event.id, summary: event.summary });
      }

    } catch (err) {
      logger.error('Error procesando recordatorios', { chatId, error: err.message });
    }
  }

  return { statusCode: 200 };
};

function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
