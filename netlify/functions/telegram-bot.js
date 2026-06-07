/**
 * Netlify Function: telegram-bot
 *
 * Webhook principal que recibe todas las actualizaciones del bot de Telegram.
 * Flujo para notas de voz:
 *   1. Descarga el audio de los servidores de Telegram.
 *   2. Transcribe con Gemini (STT multimodal).
 *   3. Extrae detalles del evento con Gemini (NLU → JSON).
 *   4. Verifica disponibilidad en Google Calendar.
 *   5a. Si está LIBRE  → crea el evento y confirma por Telegram.
 *   5b. Si está OCUPADO → busca 2 slots alternativos y los sugiere.
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
  'GEMINI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_CALENDAR_ID',
];

function assertConfig() {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Variables de entorno faltantes: ${missing.join(', ')}`);
  }
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

    // Filtro de seguridad: solo responder al chat autorizado (si está configurado)
    const ownerId = process.env.OWNER_CHAT_ID;
    if (ownerId && String(chatId) !== String(ownerId)) {
      logger.warn('Mensaje de chat no autorizado ignorado', { chatId });
      return OK_RESPONSE;
    }

    if (message.voice || message.audio) {
      await handleVoiceMessage(message);
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

async function handleVoiceMessage(message) {
  const chatId   = message.chat.id;
  const fileData = message.voice ?? message.audio;

  await sendTypingAction(chatId);
  await sendMessage(chatId, '🎙️ Recibí tu nota de voz\\. Procesando...');

  // ── Paso 1: Descargar el audio ──────────────────────────────────────────────
  const { buffer, mimeType } = await downloadFile(fileData.file_id);

  // ── Paso 2: Transcripción STT ───────────────────────────────────────────────
  await sendMessage(chatId, '🧠 Transcribiendo con Gemini AI\\.\\.\\.');
  const transcription = await transcribeAudio(buffer, mimeType);

  if (!transcription) {
    await sendMessage(chatId, '⚠️ No pude escuchar el audio con claridad\\. ¿Puedes intentarlo de nuevo?');
    return;
  }

  // ── Paso 3: Extracción NLU ──────────────────────────────────────────────────
  const eventDetails = await extractEventDetails(transcription);

  if (!eventDetails || eventDetails.intent === 'desconocido') {
    await sendMessage(
      chatId,
      `🤔 No pude identificar un evento claro\\.\n\nEsto fue lo que transcribí:\n_"${escapeMarkdown(transcription)}"_\n\nPrueba diciendo algo como: _"Agendar cita con el dentista mañana a las 3 de la tarde"_`,
    );
    return;
  }

  // ── Enrutar según intent ────────────────────────────────────────────────────
  switch (eventDetails.intent) {
    case 'agendar':
      await handleScheduleIntent(chatId, eventDetails, transcription);
      break;
    case 'consultar':
      await handleQueryIntent(chatId);
      break;
    case 'cancelar':
      await sendMessage(
        chatId,
        `📋 Entendí que quieres cancelar: *${escapeMarkdown(eventDetails.summary)}*\n\nLa cancelación automática estará disponible próximamente\\. Por ahora, cancela directamente desde [Google Calendar](https://calendar.google.com)\\.`,
      );
      break;
    default:
      await sendMessage(chatId, '❓ No entendí la acción\\. ¿Quieres *agendar*, *consultar* o *cancelar* un evento?');
  }
}

// ─── Flujo: agendar evento ────────────────────────────────────────────────────

async function handleScheduleIntent(chatId, eventDetails, transcription) {
  const { summary, start_time, end_time } = eventDetails;

  await sendMessage(
    chatId,
    `📋 *Entendí lo siguiente:*\n\n📌 *${escapeMarkdown(summary)}*\n` +
    `🕐 Inicio: ${escapeMarkdown(formatDateTime(start_time))}\n` +
    `🕑 Fin: ${escapeMarkdown(formatTimeOnly(end_time))}\n\n` +
    `🔍 Verificando disponibilidad\\.\\.\\.`,
  );

  const isFree = await checkAvailability(start_time, end_time);

  if (isFree) {
    const createdEvent = await createCalendarEvent({
      summary,
      start_time,
      end_time,
      notes: eventDetails.notes ?? '',
    });

    await sendMessage(
      chatId,
      `✅ *¡Listo\\! Evento agendado:*\n\n` +
      `📌 *${escapeMarkdown(summary)}*\n` +
      `📅 ${escapeMarkdown(formatDateTime(start_time))}\n` +
      `⏱ Hasta las ${escapeMarkdown(formatTimeOnly(end_time))}\n\n` +
      `[👉 Ver en Google Calendar](${createdEvent.htmlLink})`,
    );
  } else {
    // Horario ocupado → buscar alternativas
    const freeSlots = await findNextFreeSlots(start_time, 2);

    let msg =
      `⚠️ *Ese horario ya está ocupado:*\n` +
      `🚫 ${escapeMarkdown(formatDateTime(start_time))} — ${escapeMarkdown(formatTimeOnly(end_time))}\n\n` +
      `Te sugiero estos horarios disponibles para *${escapeMarkdown(summary)}*:\n`;

    freeSlots.forEach((slot, i) => {
      const emoji = i === 0 ? '1️⃣' : '2️⃣';
      msg += `\n${emoji} ${escapeMarkdown(formatDateTime(slot.start))} — ${escapeMarkdown(formatTimeOnly(slot.end))}`;
    });

    msg += '\n\n¿Te acomoda alguno? Envíame otra nota de voz con tu elección\\. 🎙️';

    await sendMessage(chatId, msg);
  }
}

// ─── Flujo: consultar eventos ─────────────────────────────────────────────────

async function handleQueryIntent(chatId) {
  await sendMessage(
    chatId,
    '🔍 La consulta de eventos estará disponible próximamente\\.\n' +
    'Por ahora revisa tu [Google Calendar](https://calendar.google.com) directamente\\.',
  );
}

// ─── Manejador de mensajes de texto ──────────────────────────────────────────

async function handleTextMessage(message) {
  const chatId = message.chat.id;
  const text   = message.text?.trim() ?? '';

  if (text === '/start' || text === '/help') {
    await sendMessage(
      chatId,
      `👋 *¡Hola\\! Soy tu asistente de agenda por voz\\.* 🎙️\n\n` +
      `Envíame una nota de voz y agendaré el evento automáticamente en tu Google Calendar\\.\n\n` +
      `*Ejemplos de lo que puedes decir:*\n` +
      `• _"Agendar cita con el médico mañana a las 10 de la mañana"_\n` +
      `• _"Reunión con el equipo el martes a las 9"_\n` +
      `• _"Cumpleaños de mamá el 15 de junio a las 7 de la tarde"_\n\n` +
      `*Comandos disponibles:*\n` +
      `/start — Mostrar este mensaje\n` +
      `/help  — Ayuda y ejemplos`,
    );
  } else {
    await sendMessage(
      chatId,
      '🎙️ Para agendar un evento, *envíame una nota de voz*\\.\nEscribe /help para ver ejemplos\\.',
    );
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/**
 * Escapa caracteres reservados del modo MarkdownV2 de Telegram.
 * Telegram MarkdownV2 requiere escapar: . ! - ( ) [ ] { } + = | > # ~
 */
function escapeMarkdown(text = '') {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (c) => `\\${c}`);
}
