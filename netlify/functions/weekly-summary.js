/**
 * Netlify Scheduled Function: weekly-summary
 *
 * Cada domingo a las 10:00 hora Chile (14:00 UTC) envía el resumen
 * de la semana entrante (lunes a domingo) a todos los usuarios.
 *
 * netlify.toml: schedule = "0 14 * * 0"
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage }      from '../../src/services/telegram.js';
import { listEvents }        from '../../src/services/calendar.js';
import { getAllActiveUsers }  from '../../src/services/supabase.js';
import { formatTimeOnly, getChileDateString, dayBoundsChileISO } from '../../src/utils/dateUtils.js';
import { logger } from '../../src/utils/logger.js';

const TIMEZONE = 'America/Santiago';

export const handler = async () => {
  logger.info('Iniciando resumen semanal');

  const users = await getAllActiveUsers();
  if (users.length === 0) { logger.warn('Sin usuarios activos'); return { statusCode: 200 }; }

  const now          = new Date();
  const dayOfWeek    = now.getUTCDay();
  const daysToMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const monday       = new Date(now.getTime() + daysToMonday * 24 * 60 * 60 * 1000);
  const sunday       = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekStart    = dayBoundsChileISO(getChileDateString(monday)).dayStart;
  const weekEnd      = dayBoundsChileISO(getChileDateString(sunday)).dayEnd;
  const mondayLabel  = monday.toLocaleDateString('es-CL', { timeZone: TIMEZONE, day: 'numeric', month: 'long' });
  const sundayLabel  = sunday.toLocaleDateString('es-CL', { timeZone: TIMEZONE, day: 'numeric', month: 'long' });

  for (const { chatId, calendarId, weeklySummary } of users) {
    if (!weeklySummary) continue; // Respeta preferencia del usuario

    try {
      const events = await listEvents(weekStart, weekEnd, calendarId);

      let msg = `📆 <b>Tu semana del ${mondayLabel} al ${sundayLabel}:</b>\n\n`;

      if (events.length === 0) {
        msg += `✨ No tienes eventos programados esta semana.\n¡Que tengas una semana tranquila! 🌟`;
      } else {
        // Agrupar por día
        const byDay = {};
        for (const e of events) {
          const dt   = e.start.dateTime ?? e.start.date;
          const dKey = dt.slice(0, 10); // YYYY-MM-DD
          if (!byDay[dKey]) byDay[dKey] = [];
          byDay[dKey].push(e);
        }

        for (const [dKey, dayEvents] of Object.entries(byDay).sort()) {
          const dayName = new Date(`${dKey}T12:00:00Z`).toLocaleDateString('es-CL', {
            timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long',
          });
          msg += `📅 <b>${dayName}:</b>\n`;
          dayEvents.forEach((e) => {
            const startStr = e.start.dateTime ? formatTimeOnly(e.start.dateTime) : 'Todo el día';
            const endStr   = e.end.dateTime   ? formatTimeOnly(e.end.dateTime)   : '';
            msg += `  • ${escapeHtml(e.summary ?? 'Sin título')}`;
            msg += ` 🕐 ${startStr}${endStr ? `–${endStr}` : ''}\n`;
          });
          msg += '\n';
        }

        msg += `¡Que tengas una excelente semana! 💪`;
      }

      await sendMessage(chatId, msg);
      logger.info('Resumen semanal enviado', { chatId, eventos: events.length });

    } catch (err) {
      logger.error('Error enviando resumen semanal', { chatId, error: err.message });
    }
  }

  return { statusCode: 200 };
};

function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
