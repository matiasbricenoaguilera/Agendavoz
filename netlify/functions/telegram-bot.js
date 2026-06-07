/**
 * Netlify Function: telegram-bot
 *
 * Webhook multi-usuario: cada chat_id de Telegram se mapea a un Google Calendar
 * distinto mediante la variable USER_CALENDARS (formato: "chatId1:cal1,chatId2:cal2").
 *
 * IMPORTANTE: La función siempre retorna statusCode 200 a Telegram para
 * evitar reintentos automáticos de entrega, incluso ante errores internos.
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage, sendTypingAction, downloadFile } from '../../src/services/telegram.js';
import { transcribeAudio, extractEventDetails }        from '../../src/services/gemini.js';
import { checkAvailability, createCalendarEvent, findNextFreeSlots } from '../../src/services/calendar.js';
import { formatDateTime, formatTimeOnly }              from '../../src/utils/dateUtils.js';
import { logger }                                      from '../../src/utils/logger.js';

// ─── Respuesta estándar de éxito (siempre 200 a Telegram) ───────────────────

const OK_RESPONSE = { statusCode: 200, body: 'OK' };

// ─── Validación de configuración al arrancar ─────────────────────────────────

const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'USER_CALENDARS',
];

function assertConfig() {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Variables de entorno faltantes: ${missing.join(', ')}`);
  }
}

/**
 * Retorna el calendarId asociado a un chatId según USER_CALENDARS.
 * Formato de la variable: "chatId1:email1@gmail.com,chatId2:email2@gmail.com"
 */
function getCalendarForUser(chatId) {
  const raw = process.env.USER_CALENDARS ?? '';
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);

  logger.info('Buscando calendario para usuario', {
    chatId: String(chatId),
    entries,
  });

  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const id       = entry.slice(0, colonIdx).trim();
    const calendar = entry.slice(colonIdx + 1).trim();
    if (id === String(chatId)) return calendar;
  }
  return null;
}

// ─── Handler principal ───────────────────────────────────────────────────────

export const handler = async (event) => {
  // Solo aceptar POST
  if (event.httpMethod !== 'POST') return OK_RESPONSE;

  // Validar token secreto del webhook (si está configurado)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && event.headers['x-telegram-bot-api-secret-token'] !== secret) {
    logger.warn('Solicitud con token secreto inválido rechazada.');
    return OK_RESPONSE; // Telegram requiere 200 incluso en rechazos
  }

  let chatId = null;

  try {
    assertConfig();

    const update = JSON.parse(event.body ?? '{}');
    logger.info('Update de Telegram recibido', { update_id: update.update_id });

    const message = update.message ?? update.edited_message;
    if (!message) return OK_RESPONSE;

    chatId = message.chat.id;

    // Verificar que el usuario está registrado en USER_CALENDARS
    const calendarId = getCalendarForUser(chatId);
    if (!calendarId) {
      logger.warn('Usuario no registrado en USER_CALENDARS', { chatId });
      await sendMessage(chatId, '⛔ No tienes acceso a este bot. Contacta al administrador.').catch(() => {});
      return OK_RESPONSE;
    }

    if (message.voice || message.audio) {
      await handleVoiceMessage(message, calendarId);
    } else if (message.text) {
      await handleTextMessage(message);
    }
  } catch (err) {
    logger.error('Error no manejado en el webhook', err);
    if (chatId) {
      await sendMessage(
        chatId,
        '❌ Ocurrió un error inesperado. Por favor, intenta de nuevo en unos momentos.',
      ).catch(() => {});
    }
  }

  return OK_RESPONSE;
};

// ─── Manejador de mensajes de voz / audio ────────────────────────────────────

async function handleVoiceMessage(message, calendarId) {
  const chatId   = message.chat.id;
  const fileData = message.voice ?? message.audio;

  await sendTypingAction(chatId);
  await sendMessage(chatId, '🎙️ Recibí tu nota de voz. Procesando...');

  // ── Paso 1: Descargar el audio ──────────────────────────────────────────────
  const { buffer, mimeType } = await downloadFile(fileData.file_id);

  // ── Paso 2: Transcripción STT ───────────────────────────────────────────────
  await sendMessage(chatId, '🧠 Transcribiendo con Gemini AI...');
  const transcription = await transcribeAudio(buffer, mimeType);

  if (!transcription) {
    await sendMessage(chatId, '⚠️ No pude escuchar el audio con claridad. ¿Puedes intentarlo de nuevo?');
    return;
  }

  // ── Paso 3: Extracción NLU ──────────────────────────────────────────────────
  const eventDetails = await extractEventDetails(transcription);

  if (!eventDetails || eventDetails.intent === 'desconocido') {
    await sendMessage(
      chatId,
      `🤔 No pude identificar un evento claro.\n\nEsto fue lo que transcribí:\n<i>"${escapeHtml(transcription)}"</i>\n\nPrueba diciendo algo como: <i>"Agendar cita con el dentista mañana a las 3 de la tarde"</i>`,
    );
    return;
  }

  // ── Verificar si faltan datos antes de agendar ─────────────────────────────
  if (eventDetails.intent === 'agendar') {
    const missingDate = eventDetails.date_specified === false;
    const missingTime = eventDetails.time_specified === false;

    if (missingDate && missingTime) {
      await sendMessage(chatId,
        `📋 Entendí que quieres agendar: <b>${escapeHtml(eventDetails.summary)}</b>\n\n` +
        `⚠️ No mencionaste el <b>día ni la hora</b>.\n\n` +
        `Envíame otro mensaje de voz indicando cuándo, por ejemplo:\n` +
        `<i>"El martes a las 3 de la tarde"</i> 🎙️`
      );
      return;
    }

    if (missingDate) {
      await sendMessage(chatId,
        `📋 Entendí que quieres agendar: <b>${escapeHtml(eventDetails.summary)}</b> a las <b>${escapeHtml(formatTimeOnly(eventDetails.start_time))}</b>\n\n` +
        `⚠️ No mencionaste el <b>día</b>.\n\n` +
        `Envíame otro mensaje de voz con la fecha, por ejemplo:\n` +
        `<i>"El martes"</i> o <i>"El 15 de junio"</i> 🎙️`
      );
      return;
    }

    if (missingTime) {
      await sendMessage(chatId,
        `📋 Entendí que quieres agendar: <b>${escapeHtml(eventDetails.summary)}</b> el <b>${escapeHtml(formatDateTime(eventDetails.start_time))}</b>\n\n` +
        `⚠️ No mencionaste la <b>hora</b>.\n\n` +
        `Envíame otro mensaje de voz con la hora, por ejemplo:\n` +
        `<i>"A las 3 de la tarde"</i> o <i>"A las 10 de la mañana"</i> 🎙️`
      );
      return;
    }
  }

  // ── Enrutar según intent ────────────────────────────────────────────────────
  switch (eventDetails.intent) {
    case 'agendar':
      await handleScheduleIntent(chatId, eventDetails, calendarId);
      break;
    case 'consultar':
      await handleQueryIntent(chatId);
      break;
    case 'cancelar':
      await sendMessage(
        chatId,
        `📋 Entendí que quieres cancelar: <b>${escapeHtml(eventDetails.summary)}</b>\n\nLa cancelación automática estará disponible próximamente. Por ahora cancela desde <a href="https://calendar.google.com">Google Calendar</a>.`,
      );
      break;
    default:
      await sendMessage(chatId, '❓ No entendí la acción. ¿Quieres <b>agendar</b>, <b>consultar</b> o <b>cancelar</b> un evento?');
  }
}

// ─── Flujo: agendar evento ────────────────────────────────────────────────────

async function handleScheduleIntent(chatId, eventDetails, calendarId) {
  const { summary, start_time, end_time } = eventDetails;

  await sendMessage(
    chatId,
    `📋 <b>Entendí lo siguiente:</b>\n\n📌 <b>${escapeHtml(summary)}</b>\n` +
    `🕐 Inicio: ${escapeHtml(formatDateTime(start_time))}\n` +
    `🕑 Fin: ${escapeHtml(formatTimeOnly(end_time))}\n\n` +
    `🔍 Verificando disponibilidad...`,
  );

  const isFree = await checkAvailability(start_time, end_time, calendarId);

  if (isFree) {
    const createdEvent = await createCalendarEvent({
      summary,
      start_time,
      end_time,
      notes:      eventDetails.notes ?? '',
      calendarId,
    });

    await sendMessage(
      chatId,
      `✅ <b>¡Listo! Evento agendado:</b>\n\n` +
      `📌 <b>${escapeHtml(summary)}</b>\n` +
      `📅 ${escapeHtml(formatDateTime(start_time))}\n` +
      `⏱ Hasta las ${escapeHtml(formatTimeOnly(end_time))}\n\n` +
      `<a href="${createdEvent.htmlLink}">👉 Ver en Google Calendar</a>`,
    );
  } else {
    const freeSlots = await findNextFreeSlots(start_time, 2, calendarId);

    let msg =
      `⚠️ <b>Ese horario ya está ocupado:</b>\n` +
      `🚫 ${escapeHtml(formatDateTime(start_time))} — ${escapeHtml(formatTimeOnly(end_time))}\n\n` +
      `Te sugiero estos horarios disponibles para <b>${escapeHtml(summary)}</b>:\n`;

    freeSlots.forEach((slot, i) => {
      const emoji = i === 0 ? '1️⃣' : '2️⃣';
      msg += `\n${emoji} ${escapeHtml(formatDateTime(slot.start))} — ${escapeHtml(formatTimeOnly(slot.end))}`;
    });

    msg += '\n\n¿Te acomoda alguno? Envíame otra nota de voz con tu elección. 🎙️';
    await sendMessage(chatId, msg);
  }
}

// ─── Flujo: consultar eventos ─────────────────────────────────────────────────

async function handleQueryIntent(chatId) {
  await sendMessage(
    chatId,
    '🔍 La consulta de eventos estará disponible próximamente.\n' +
    'Por ahora revisa tu <a href="https://calendar.google.com">Google Calendar</a> directamente.',
  );
}

// ─── Manejador de mensajes de texto ──────────────────────────────────────────

async function handleTextMessage(message) {
  const chatId = message.chat.id;
  const text   = message.text?.trim() ?? '';

  if (text === '/start' || text === '/help') {
    await sendMessage(
      chatId,
      `👋 <b>¡Hola! Soy tu asistente de agenda por voz.</b> 🎙️\n\n` +
      `Envíame una nota de voz y agendaré el evento automáticamente en tu Google Calendar.\n\n` +
      `<b>Ejemplos de lo que puedes decir:</b>\n` +
      `• <i>"Agendar cita con el médico mañana a las 10 de la mañana"</i>\n` +
      `• <i>"Reunión con el equipo el martes a las 9"</i>\n` +
      `• <i>"Cumpleaños de mamá el 15 de junio a las 7 de la tarde"</i>\n\n` +
      `<b>Comandos:</b>\n` +
      `/start — Mostrar este mensaje\n` +
      `/help — Ayuda y ejemplos`,
    );
  } else {
    await sendMessage(
      chatId,
      '🎙️ Para agendar un evento, <b>envíame una nota de voz</b>.\nEscribe /help para ver ejemplos.',
    );
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/** Escapa caracteres especiales de HTML para el parse_mode HTML de Telegram. */
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
