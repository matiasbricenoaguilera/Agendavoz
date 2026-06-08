/**
 * Netlify Scheduled Function: event-reminders
 *
 * Corre cada 15 minutos. Busca eventos que comiencen en los próximos 20–45 minutos
 * y envía un recordatorio si aún no se ha enviado (deduplicación en Supabase).
 *
 * netlify.toml: schedule = "*/15 * * * *"
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage }        from '../../src/services/telegram.js';
import { listEvents }         from '../../src/services/calendar.js';
import { hasReminderBeenSent, markReminderSent, cleanOldReminders } from '../../src/services/supabase.js';
import { formatTimeOnly, formatDateLong, getChileDateString }        from '../../src/utils/dateUtils.js';
import { logger }             from '../../src/utils/logger.js';

const WINDOW_START_MIN = 20; // Buscar eventos que comienzan en mínimo 20 min
const WINDOW_END_MIN   = 45; // y máximo 45 min (ventana de 25 min por ejecución)

export const handler = async () => {
  logger.info('Ejecutando chequeo de recordatorios');

  const raw     = process.env.USER_CALENDARS ?? '';
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);

  if (entries.length === 0) return { statusCode: 200 };

  // Limpiar recordatorios antiguos ocasionalmente (1 de cada 20 ejecuciones ≈ cada 5h)
  if (Math.random() < 0.05) await cleanOldReminders().catch(() => {});

  const now        = new Date();
  const windowFrom = new Date(now.getTime() + WINDOW_START_MIN * 60 * 1000);
  const windowTo   = new Date(now.getTime() + WINDOW_END_MIN   * 60 * 1000);

  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;

    const chatId     = entry.slice(0, colonIdx).trim();
    const calendarId = entry.slice(colonIdx + 1).trim();

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
          `⏰ <b>Recordatorio — en ${minutesLeft} minutos:</b>\n\n` +
          `📌 <b>${escapeHtml(event.summary ?? 'Sin título')}</b>\n` +
          `🕐 ${startStr}${endStr ? ` — ${endStr}` : ''}\n` +
          (event.description ? `📝 ${escapeHtml(event.description.slice(0, 120))}\n` : '') +
          `\n¡Prepárate! 🎯`;

        await sendMessage(chatId, msg);
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
