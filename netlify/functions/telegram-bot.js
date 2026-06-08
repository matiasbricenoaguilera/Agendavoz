/**
 * Netlify Function: telegram-bot
 *
 * Webhook con máquina de estados conversacional apoyada en Supabase.
 * Funcionalidades: agendar, confirmar, consultar, cancelar, sobreescribir.
 *
 * Estados de conversación:
 *   AWAITING_DATE         — tenemos resumen + hora, falta el día
 *   AWAITING_TIME         — tenemos resumen + día, falta la hora
 *   AWAITING_DATETIME     — tenemos resumen, falta día y hora
 *   AWAITING_CONFIRMATION — evento completo esperando "sí" o "no"
 *   AWAITING_SLOT_CHOICE  — slot ocupado, esperando 1 / 2 / reemplazar
 *   AWAITING_CANCEL_CONFIRM — evento encontrado para cancelar, esperando "sí" o "no"
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { sendMessage, sendTypingAction, downloadFile }            from '../../src/services/telegram.js';
import { transcribeAudio, extractEventDetails, detectSimpleIntent } from '../../src/services/gemini.js';
import {
  checkAvailability, createCalendarEvent, findNextFreeSlots,
  listEvents, getBusyEvent, deleteCalendarEvent,
}                                                                  from '../../src/services/calendar.js';
import { getConversation, saveConversation, clearConversation, logEvent } from '../../src/services/supabase.js';
import {
  formatDateTime, formatDateLong, formatTimeOnly,
  extractDateFromISO, extractTimeFromISO, buildChileISO, addMsToChileISO,
  getChileDateString,
}                                                                  from '../../src/utils/dateUtils.js';
import { logger }                                                  from '../../src/utils/logger.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

const OK_RESPONSE = { statusCode: 200, body: 'OK' };
const DEFAULT_DURATION_MS = 60 * 60 * 1000; // 1 hora
const CHILE_UTC_OFFSET = '-04:00';
const TIMEZONE = 'America/Santiago';

const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'USER_CALENDARS',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

// ─── Validación de configuración ──────────────────────────────────────────────

function assertConfig() {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) throw new Error(`Variables de entorno faltantes: ${missing.join(', ')}`);
}

// ─── Mapeo chatId → calendarId ────────────────────────────────────────────────

function getCalendarForUser(chatId) {
  const raw = process.env.USER_CALENDARS ?? '';
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    if (entry.slice(0, colonIdx).trim() === String(chatId)) {
      return entry.slice(colonIdx + 1).trim();
    }
  }
  return null;
}

// ─── Handler principal ────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return OK_RESPONSE;

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && event.headers['x-telegram-bot-api-secret-token'] !== secret) {
    logger.warn('Token secreto inválido rechazado.');
    return OK_RESPONSE;
  }

  let chatId = null;

  try {
    assertConfig();

    const update  = JSON.parse(event.body ?? '{}');
    const message = update.message ?? update.edited_message;
    if (!message) return OK_RESPONSE;

    chatId = message.chat.id;
    logger.info('Mensaje recibido', { chatId, update_id: update.update_id });

    const calendarId = getCalendarForUser(chatId);
    if (!calendarId) {
      logger.warn('Usuario no registrado', { chatId });
      await sendMessage(chatId, '⛔ No tienes acceso a este bot. Contacta al administrador.').catch(() => {});
      return OK_RESPONSE;
    }

    await processMessage(message, calendarId);

  } catch (err) {
    logger.error('Error no manejado', err);
    if (chatId) {
      await sendMessage(chatId, '❌ Ocurrió un error inesperado. Intenta de nuevo en unos momentos.').catch(() => {});
    }
  }

  return OK_RESPONSE;
};

// ─── Procesamiento principal de mensajes ──────────────────────────────────────

async function processMessage(message, calendarId) {
  const chatId  = message.chat.id;
  const isVoice = !!(message.voice || message.audio);

  // Obtener el contenido de texto del mensaje
  let textContent = null;

  if (isVoice) {
    await sendTypingAction(chatId);
    await sendMessage(chatId, '🎙️ Recibí tu nota de voz. Procesando...');

    const fileData = message.voice ?? message.audio;
    const { buffer, mimeType } = await downloadFile(fileData.file_id);

    await sendMessage(chatId, '🧠 Transcribiendo con IA...');
    textContent = await transcribeAudio(buffer, mimeType);

    if (!textContent) {
      await sendMessage(chatId, '⚠️ No pude entender el audio. ¿Puedes intentarlo de nuevo?');
      return;
    }

    logger.info('Audio transcrito', { chatId, texto: textContent });
  } else {
    textContent = message.text?.trim() ?? '';
  }

  // Verificar si hay un estado de conversación pendiente
  const pending = await getConversation(chatId);

  if (pending) {
    await handlePendingState(chatId, textContent, pending, calendarId);
    return;
  }

  // Sin estado pendiente: procesar como nuevo mensaje
  if (isVoice) {
    await processVoiceIntent(chatId, textContent, calendarId);
  } else {
    await handleTextCommands(chatId, textContent, calendarId);
  }
}

// ─── Máquina de estados ───────────────────────────────────────────────────────

async function handlePendingState(chatId, textContent, pending, calendarId) {
  const { state, context } = pending;
  logger.info('Procesando estado pendiente', { chatId, state });

  switch (state) {

    // ── Falta solo el día ───────────────────────────────────────────────────
    case 'AWAITING_DATE': {
      const newDetails = await extractEventDetails(textContent);

      if (!newDetails.date_specified) {
        await sendMessage(chatId,
          `⚠️ Aún no indicas el día.\n\n` +
          `Dime cuándo quieres agendar: <b>${escapeHtml(context.partial_event.summary)}</b>\n` +
          `Por ejemplo: <i>"El martes"</i> o <i>"El 15 de junio"</i> 🎙️`,
        );
        return;
      }

      const dateStr    = extractDateFromISO(newDetails.start_time);
      const durationMs = context.partial_event.duration_ms ?? DEFAULT_DURATION_MS;
      const start_time = buildChileISO(dateStr, context.partial_event.time);
      const end_time   = addMsToChileISO(start_time, durationMs);

      await clearConversation(chatId);
      await askForConfirmation(chatId, {
        summary:    context.partial_event.summary,
        start_time, end_time,
        notes:      context.partial_event.notes ?? '',
      }, calendarId, context.transcription ?? textContent);
      break;
    }

    // ── Falta solo la hora ──────────────────────────────────────────────────
    case 'AWAITING_TIME': {
      const newDetails = await extractEventDetails(textContent);

      if (!newDetails.time_specified) {
        await sendMessage(chatId,
          `⚠️ Aún no indicas la hora.\n\n` +
          `Dime a qué hora quieres agendar: <b>${escapeHtml(context.partial_event.summary)}</b>\n` +
          `Por ejemplo: <i>"A las 3 de la tarde"</i> o <i>"A las 10 de la mañana"</i> 🎙️`,
        );
        return;
      }

      const timeStr    = extractTimeFromISO(newDetails.start_time);
      const durationMs = new Date(newDetails.end_time) - new Date(newDetails.start_time);
      const start_time = buildChileISO(context.partial_event.date, timeStr);
      const end_time   = addMsToChileISO(start_time, durationMs);

      await clearConversation(chatId);
      await askForConfirmation(chatId, {
        summary:    context.partial_event.summary,
        start_time, end_time,
        notes:      context.partial_event.notes ?? '',
      }, calendarId, context.transcription ?? textContent);
      break;
    }

    // ── Faltan día y hora ───────────────────────────────────────────────────
    case 'AWAITING_DATETIME': {
      const newDetails = await extractEventDetails(textContent);
      const missingDate = !newDetails.date_specified;
      const missingTime = !newDetails.time_specified;

      if (missingDate && missingTime) {
        await sendMessage(chatId,
          `⚠️ Aún faltan el día y la hora para: <b>${escapeHtml(context.partial_event.summary)}</b>\n` +
          `Por ejemplo: <i>"El martes a las 3 de la tarde"</i> 🎙️`,
        );
        return;
      }

      if (missingDate) {
        // Tenemos hora, falta día
        await saveConversation(chatId, 'AWAITING_DATE', {
          partial_event: {
            ...context.partial_event,
            time:        extractTimeFromISO(newDetails.start_time),
            duration_ms: new Date(newDetails.end_time) - new Date(newDetails.start_time),
          },
          transcription: context.transcription,
        });
        await sendMessage(chatId,
          `📋 Hora guardada: <b>${formatTimeOnly(newDetails.start_time)}</b>\n\n` +
          `⚠️ Aún falta el día. ¿Cuándo quieres agendar: <b>${escapeHtml(context.partial_event.summary)}</b>?\n` +
          `Por ejemplo: <i>"El martes"</i> 🎙️`,
        );
        return;
      }

      if (missingTime) {
        // Tenemos día, falta hora
        await saveConversation(chatId, 'AWAITING_TIME', {
          partial_event: {
            ...context.partial_event,
            date: extractDateFromISO(newDetails.start_time),
          },
          transcription: context.transcription,
        });
        await sendMessage(chatId,
          `📋 Día guardado: <b>${formatDateLong(newDetails.start_time)}</b>\n\n` +
          `⚠️ Aún falta la hora. ¿A qué hora quieres agendar: <b>${escapeHtml(context.partial_event.summary)}</b>?\n` +
          `Por ejemplo: <i>"A las 3 de la tarde"</i> 🎙️`,
        );
        return;
      }

      // Tenemos todo
      await clearConversation(chatId);
      await askForConfirmation(chatId, {
        summary:    context.partial_event.summary,
        start_time: newDetails.start_time,
        end_time:   newDetails.end_time,
        notes:      context.partial_event.notes ?? '',
      }, calendarId, context.transcription ?? textContent);
      break;
    }

    // ── Esperando confirmación del evento ───────────────────────────────────
    case 'AWAITING_CONFIRMATION': {
      const intent = detectSimpleIntent(textContent);

      if (intent === 'yes') {
        await clearConversation(chatId);
        await scheduleEvent(chatId, context.event, calendarId, context.transcription ?? textContent);
      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. No se agendó ningún evento.');
      } else {
        await sendMessage(chatId,
          '🤔 No entendí tu respuesta.\n\n' +
          'Responde <b>"sí"</b> para confirmar el evento o <b>"no"</b> para cancelarlo. 🎙️',
        );
      }
      break;
    }

    // ── Esperando elección de horario alternativo ───────────────────────────
    case 'AWAITING_SLOT_CHOICE': {
      const intent     = detectSimpleIntent(textContent);
      const { event, free_slots, busy_event, requested_start, requested_end } = context;

      if (intent === 'slot_1' && free_slots?.[0]) {
        await clearConversation(chatId);
        const chosen = { ...event, start_time: free_slots[0].start, end_time: free_slots[0].end };
        await scheduleEvent(chatId, chosen, calendarId, context.transcription ?? textContent);

      } else if (intent === 'slot_2' && free_slots?.[1]) {
        await clearConversation(chatId);
        const chosen = { ...event, start_time: free_slots[1].start, end_time: free_slots[1].end };
        await scheduleEvent(chatId, chosen, calendarId, context.transcription ?? textContent);

      } else if (intent === 'overwrite' && busy_event) {
        await clearConversation(chatId);
        await overwriteEvent(
          chatId, event,
          { start: requested_start, end: requested_end },
          busy_event, calendarId,
          context.transcription ?? textContent,
        );

      } else if (intent === 'force') {
        // Agendar igualmente, dejando ambos eventos superpuestos
        await clearConversation(chatId);
        const forcedEvent = { ...event, start_time: requested_start, end_time: requested_end };
        await forceScheduleEvent(chatId, forcedEvent, calendarId, context.transcription ?? textContent);

      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. No se agendó ningún evento.');

      } else {
        let msg =
          '🤔 No entendí tu elección. Responde:\n\n' +
          '• <b>"primera"</b> o <b>"1"</b> — primer horario disponible\n' +
          '• <b>"segunda"</b> o <b>"2"</b> — segundo horario disponible\n';
        if (busy_event) msg += '• <b>"reemplazar"</b> — sobreescribir el evento existente\n';
        msg += '• <b>"de todas formas"</b> o <b>"4"</b> — agendar aunque el horario esté ocupado\n';
        msg += '• <b>"no"</b> — cancelar 🎙️';
        await sendMessage(chatId, msg);
      }
      break;
    }

    // ── Esperando confirmación de cancelación ───────────────────────────────
    case 'AWAITING_CANCEL_CONFIRM': {
      const intent = detectSimpleIntent(textContent);

      if (intent === 'yes') {
        await clearConversation(chatId);
        await deleteCalendarEvent(context.event_id, calendarId);
        await logEvent(chatId, calendarId, {
          id:         context.event_id,
          summary:    context.event_summary,
          start_time: context.event_start,
          end_time:   context.event_end,
          action:     'cancelled',
        });
        await sendMessage(chatId,
          `🗑 <b>Evento cancelado:</b>\n\n` +
          `📌 ${escapeHtml(context.event_summary)}\n` +
          `📅 ${escapeHtml(formatDateTime(context.event_start))}`,
        );

      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelación abortada. El evento permanece en tu calendario.');

      } else {
        await sendMessage(chatId,
          '🤔 No entendí. Responde <b>"sí"</b> para cancelar el evento o <b>"no"</b> para dejarlo. 🎙️',
        );
      }
      break;
    }

    default:
      await clearConversation(chatId);
      await sendMessage(chatId, '↩️ Se reinició la conversación. ¿En qué puedo ayudarte?');
  }
}

// ─── Procesamiento de notas de voz (sin estado previo) ────────────────────────

async function processVoiceIntent(chatId, transcription, calendarId) {
  const eventDetails = await extractEventDetails(transcription);

  if (!eventDetails || eventDetails.intent === 'desconocido') {
    await sendMessage(chatId,
      `🤔 No pude identificar un evento claro.\n\n` +
      `Esto fue lo que entendí:\n<i>"${escapeHtml(transcription)}"</i>\n\n` +
      `Prueba diciendo algo como:\n` +
      `<i>"Agendar cita con el dentista mañana a las 3 de la tarde"</i>`,
    );
    return;
  }

  switch (eventDetails.intent) {
    case 'agendar':  await processAgendarIntent(chatId, eventDetails, transcription, calendarId); break;
    case 'consultar': await processConsultarIntent(chatId, eventDetails, calendarId); break;
    case 'cancelar':  await processCancelarIntent(chatId, eventDetails, calendarId); break;
    default:
      await sendMessage(chatId, '❓ No entendí la acción. Puedes <b>agendar</b>, <b>consultar</b> o <b>cancelar</b> un evento.');
  }
}

// ─── Flujo: agendar ───────────────────────────────────────────────────────────

async function processAgendarIntent(chatId, eventDetails, transcription, calendarId) {
  const missingDate = eventDetails.date_specified === false;
  const missingTime = eventDetails.time_specified === false;

  if (missingDate && missingTime) {
    await saveConversation(chatId, 'AWAITING_DATETIME', {
      partial_event: { summary: eventDetails.summary, notes: eventDetails.notes ?? '' },
      transcription,
    });
    await sendMessage(chatId,
      `📋 Entendí que quieres agendar: <b>${escapeHtml(eventDetails.summary)}</b>\n\n` +
      `⚠️ No mencionaste el <b>día ni la hora</b>.\n\n` +
      `Envíame otra nota de voz indicando cuándo:\n` +
      `<i>"El martes a las 3 de la tarde"</i> 🎙️`,
    );
    return;
  }

  if (missingDate) {
    await saveConversation(chatId, 'AWAITING_DATE', {
      partial_event: {
        summary:     eventDetails.summary,
        notes:       eventDetails.notes ?? '',
        time:        extractTimeFromISO(eventDetails.start_time),
        duration_ms: new Date(eventDetails.end_time) - new Date(eventDetails.start_time),
      },
      transcription,
    });
    await sendMessage(chatId,
      `📋 Entendí: <b>${escapeHtml(eventDetails.summary)}</b> a las <b>${formatTimeOnly(eventDetails.start_time)}</b>\n\n` +
      `⚠️ No mencionaste el <b>día</b>.\n\n` +
      `Envíame otra nota de voz con la fecha:\n` +
      `<i>"El martes"</i> o <i>"El 15 de junio"</i> 🎙️`,
    );
    return;
  }

  if (missingTime) {
    await saveConversation(chatId, 'AWAITING_TIME', {
      partial_event: {
        summary: eventDetails.summary,
        notes:   eventDetails.notes ?? '',
        date:    extractDateFromISO(eventDetails.start_time),
      },
      transcription,
    });
    await sendMessage(chatId,
      `📋 Entendí: <b>${escapeHtml(eventDetails.summary)}</b> el <b>${formatDateLong(eventDetails.start_time)}</b>\n\n` +
      `⚠️ No mencionaste la <b>hora</b>.\n\n` +
      `Envíame otra nota de voz con la hora:\n` +
      `<i>"A las 3 de la tarde"</i> o <i>"A las 10 de la mañana"</i> 🎙️`,
    );
    return;
  }

  // Tenemos todo — pedir confirmación
  await askForConfirmation(chatId, {
    summary:    eventDetails.summary,
    start_time: eventDetails.start_time,
    end_time:   eventDetails.end_time,
    notes:      eventDetails.notes ?? '',
  }, calendarId, transcription);
}

// ─── Pedir confirmación antes de agendar ─────────────────────────────────────

async function askForConfirmation(chatId, event, calendarId, transcription) {
  await saveConversation(chatId, 'AWAITING_CONFIRMATION', { event, calendarId, transcription });

  await sendMessage(chatId,
    `📋 <b>¿Confirmas este evento?</b>\n\n` +
    `📌 <b>${escapeHtml(event.summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(event.start_time))}\n` +
    `⏱ Hasta las ${escapeHtml(formatTimeOnly(event.end_time))}\n\n` +
    `Responde <b>"sí"</b> para agendar o <b>"no"</b> para cancelar 🎙️`,
  );
}

// ─── Crear evento en calendario (luego de confirmación) ──────────────────────

async function scheduleEvent(chatId, event, calendarId, transcription) {
  const isFree = await checkAvailability(event.start_time, event.end_time, calendarId);

  if (isFree) {
    const created = await createCalendarEvent({ ...event, calendarId });

    await logEvent(chatId, calendarId, {
      id:           created.id,
      summary:      event.summary,
      start_time:   event.start_time,
      end_time:     event.end_time,
      transcription,
      action:       'created',
    });

    await sendMessage(chatId,
      `✅ <b>¡Listo! Evento agendado:</b>\n\n` +
      `📌 <b>${escapeHtml(event.summary)}</b>\n` +
      `📅 ${escapeHtml(formatDateTime(event.start_time))}\n` +
      `⏱ Hasta las ${escapeHtml(formatTimeOnly(event.end_time))}\n\n` +
      `<a href="${created.htmlLink}">👉 Ver en Google Calendar</a>`,
    );

  } else {
    // Horario ocupado — ofrecer alternativas
    const busyEvent  = await getBusyEvent(event.start_time, event.end_time, calendarId);
    const freeSlots  = await findNextFreeSlots(event.start_time, 2, calendarId);

    await saveConversation(chatId, 'AWAITING_SLOT_CHOICE', {
      event:            { summary: event.summary, notes: event.notes ?? '' },
      busy_event:       busyEvent,
      requested_start:  event.start_time,
      requested_end:    event.end_time,
      free_slots:       freeSlots,
      transcription,
    });

    let msg =
      `⚠️ <b>Ese horario está ocupado:</b>\n` +
      `🚫 ${escapeHtml(formatDateTime(event.start_time))} — ${escapeHtml(formatTimeOnly(event.end_time))}\n`;

    if (busyEvent) msg += `📌 Hay: <i>${escapeHtml(busyEvent.summary)}</i>\n`;

    msg += `\n<b>Elige una opción para <i>${escapeHtml(event.summary)}</i>:</b>\n\n`;

    freeSlots.forEach((slot, i) => {
      const emoji = i === 0 ? '1️⃣' : '2️⃣';
      msg += `${emoji} ${escapeHtml(formatDateTime(slot.start))} — ${escapeHtml(formatTimeOnly(slot.end))}\n`;
    });

    if (busyEvent) msg += `3️⃣ Reemplazar <i>${escapeHtml(busyEvent.summary)}</i>\n`;
    msg += `4️⃣ Agendar de todas formas (ambos eventos quedarán simultáneos)\n`;
    msg += `\nResponde con tu elección o <b>"no"</b> para cancelar 🎙️`;

    await sendMessage(chatId, msg);
  }
}

// ─── Sobreescribir evento existente ──────────────────────────────────────────

async function overwriteEvent(chatId, event, slot, busyEvent, calendarId, transcription) {
  await deleteCalendarEvent(busyEvent.id, calendarId);

  await logEvent(chatId, calendarId, {
    id:         busyEvent.id,
    summary:    busyEvent.summary,
    start_time: busyEvent.start,
    end_time:   busyEvent.end,
    action:     'overwritten',
  });

  const newEvent = { ...event, start_time: slot.start, end_time: slot.end };
  const created  = await createCalendarEvent({ ...newEvent, calendarId });

  await logEvent(chatId, calendarId, {
    id:           created.id,
    summary:      event.summary,
    start_time:   slot.start,
    end_time:     slot.end,
    transcription,
    action:       'created',
  });

  await sendMessage(chatId,
    `♻️ <b>¡Evento reemplazado!</b>\n\n` +
    `🗑 Se eliminó: <i>${escapeHtml(busyEvent.summary)}</i>\n` +
    `✅ Se agendó: <b>${escapeHtml(event.summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(slot.start))}\n` +
    `⏱ Hasta las ${escapeHtml(formatTimeOnly(slot.end))}\n\n` +
    `<a href="${created.htmlLink}">👉 Ver en Google Calendar</a>`,
  );
}

// ─── Agendar aunque haya conflicto (doble agenda) ────────────────────────────

async function forceScheduleEvent(chatId, event, calendarId, transcription) {
  const created = await createCalendarEvent({ ...event, calendarId });

  await logEvent(chatId, calendarId, {
    id:           created.id,
    summary:      event.summary,
    start_time:   event.start_time,
    end_time:     event.end_time,
    transcription,
    action:       'created',
  });

  await sendMessage(chatId,
    `✅ <b>¡Evento agendado (horario compartido):</b>\n\n` +
    `📌 <b>${escapeHtml(event.summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(event.start_time))}\n` +
    `⏱ Hasta las ${escapeHtml(formatTimeOnly(event.end_time))}\n\n` +
    `ℹ️ Este evento se superpone con otro existente.\n` +
    `<a href="${created.htmlLink}">👉 Ver en Google Calendar</a>`,
  );
}

// ─── Flujo: consultar eventos del día ────────────────────────────────────────

async function processConsultarIntent(chatId, eventDetails, calendarId) {
  const refDate  = eventDetails.start_time ? new Date(eventDetails.start_time) : new Date();
  const dateStr  = getChileDateString(refDate);
  const dayStart = `${dateStr}T00:00:00${CHILE_UTC_OFFSET}`;
  const dayEnd   = `${dateStr}T23:59:59${CHILE_UTC_OFFSET}`;

  const events = await listEvents(dayStart, dayEnd, calendarId);

  if (events.length === 0) {
    await sendMessage(chatId,
      `📅 No tienes eventos para el <b>${formatDateLong(refDate.toISOString())}</b>.\n✨ ¡Día libre!`,
    );
    return;
  }

  let msg = `📅 <b>Tu agenda del ${formatDateLong(refDate.toISOString())}:</b>\n\n`;
  events.forEach((e, i) => {
    const startStr = e.start.dateTime ? formatTimeOnly(e.start.dateTime) : 'Todo el día';
    const endStr   = e.end.dateTime   ? formatTimeOnly(e.end.dateTime)   : '';
    msg += `${i + 1}. <b>${escapeHtml(e.summary || 'Sin título')}</b>\n`;
    msg += `   🕐 ${startStr}${endStr ? ` — ${endStr}` : ''}\n`;
    if (e.description) msg += `   📝 ${escapeHtml(e.description.slice(0, 80))}\n`;
    msg += '\n';
  });

  await sendMessage(chatId, msg.trimEnd());
}

// ─── Flujo: cancelar evento ───────────────────────────────────────────────────

async function processCancelarIntent(chatId, eventDetails, calendarId) {
  const refDate  = eventDetails.start_time ? new Date(eventDetails.start_time) : new Date();
  const dateStr  = getChileDateString(refDate);
  const dayStart = `${dateStr}T00:00:00${CHILE_UTC_OFFSET}`;
  const dayEnd   = `${dateStr}T23:59:59${CHILE_UTC_OFFSET}`;

  // Buscar con la descripción del evento como query para filtrar
  const events = await listEvents(dayStart, dayEnd, calendarId, eventDetails.summary ?? '');

  if (events.length === 0) {
    await sendMessage(chatId,
      `🔍 No encontré eventos que coincidan con <i>"${escapeHtml(eventDetails.summary)}"</i> ` +
      `para el ${formatDateLong(refDate.toISOString())}.\n\n` +
      `Intenta con otro día o descripción. 🎙️`,
    );
    return;
  }

  if (events.length > 3) {
    // Demasiados resultados — pedir más especificidad
    let msg = `🔍 Encontré varios eventos ese día:\n\n`;
    events.slice(0, 5).forEach((e, i) => {
      msg += `${i + 1}. <b>${escapeHtml(e.summary)}</b> — ${e.start.dateTime ? formatTimeOnly(e.start.dateTime) : 'Todo el día'}\n`;
    });
    msg += `\nEnvíame una nota de voz más específica indicando cuál quieres cancelar. 🎙️`;
    await sendMessage(chatId, msg);
    return;
  }

  // Tomamos el primer resultado (el más próximo al horario indicado)
  const target = events[0];

  await saveConversation(chatId, 'AWAITING_CANCEL_CONFIRM', {
    event_id:      target.id,
    event_summary: target.summary ?? 'Sin título',
    event_start:   target.start.dateTime ?? target.start.date,
    event_end:     target.end.dateTime   ?? target.end.date,
  });

  await sendMessage(chatId,
    `🔍 Encontré este evento:\n\n` +
    `📌 <b>${escapeHtml(target.summary ?? 'Sin título')}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(target.start.dateTime ?? target.start.date))}\n\n` +
    `¿Confirmas que quieres cancelarlo?\n` +
    `Responde <b>"sí"</b> o <b>"no"</b> 🎙️`,
  );
}

// ─── Manejador de mensajes de texto ──────────────────────────────────────────

async function handleTextCommands(chatId, text, calendarId) {
  const lower = text.toLowerCase().trim();

  if (lower === '/start' || lower === '/help') {
    await sendMessage(chatId,
      `👋 <b>¡Hola! Soy tu asistente de agenda por voz.</b> 🎙️\n\n` +
      `Envíame notas de voz y gestionaré tu Google Calendar automáticamente.\n\n` +
      `<b>Ejemplos:</b>\n` +
      `• <i>"Agendar cita con el médico mañana a las 10"</i>\n` +
      `• <i>"Reunión con el equipo el martes a las 9"</i>\n` +
      `• <i>"¿Qué tengo hoy?"</i>\n` +
      `• <i>"Cancelar la reunión del viernes"</i>\n\n` +
      `<b>Comandos disponibles:</b>\n` +
      `/start — Mostrar este mensaje\n` +
      `/hoy — Ver tu agenda de hoy`,
    );
    return;
  }

  if (lower === '/hoy') {
    const today = new Date();
    const dateStr  = getChileDateString(today);
    const fakeEventDetails = { start_time: `${dateStr}T12:00:00${CHILE_UTC_OFFSET}` };
    await processConsultarIntent(chatId, fakeEventDetails, calendarId);
    return;
  }

  // Texto libre sin estado previo — intentar procesar como solicitud
  await sendMessage(chatId,
    '🎙️ Para agendar, consultar o cancelar eventos, <b>envíame una nota de voz</b>.\n\n' +
    'Escribe /help para ver ejemplos.',
  );
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
