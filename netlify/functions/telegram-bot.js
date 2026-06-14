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

import { sendMessage, sendTypingAction, downloadFile, answerCallbackQuery } from '../../src/services/telegram.js';
import { transcribeAudio, extractEventDetails, detectSimpleIntent } from '../../src/services/gemini.js';
import {
  checkAvailability, createCalendarEvent, findNextFreeSlots,
  listEvents, getBusyEvent, deleteCalendarEvent, updateCalendarEvent, getEventById,
}                                                                  from '../../src/services/calendar.js';
import {
  getConversation, saveConversation, clearConversation, logEvent,
  getUserByTelegramId, createUser, updateUser, generateMagicLink,
  getLastEvent, setLastEvent, getRecentEventHistory,
} from '../../src/services/supabase.js';
import {
  formatDateTime, formatDateLong, formatTimeOnly,
  extractDateFromISO, extractTimeFromISO, buildChileISO, addMsToChileISO,
  getChileDateString, toChileISO, dayBoundsChileISO,
}                                                                  from '../../src/utils/dateUtils.js';
import { logger }                                                  from '../../src/utils/logger.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

const OK_RESPONSE = { statusCode: 200, body: 'OK' };
const DEFAULT_DURATION_MS = 60 * 60 * 1000; // 1 hora
const TIMEZONE = 'America/Santiago';

const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

// ─── Validación de configuración ──────────────────────────────────────────────

function assertConfig() {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) throw new Error(`Variables de entorno faltantes: ${missing.join(', ')}`);
}

// ─── Resolución de calendarId ─────────────────────────────────────────────────

/** Lee USER_CALENDARS env var (fallback para usuarios pre-Supabase). */
function getCalendarFromEnv(chatId) {
  const raw = process.env.USER_CALENDARS ?? '';
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    if (entry.slice(0, colonIdx).trim() === String(chatId)) return entry.slice(colonIdx + 1).trim();
  }
  return null;
}

/** Retorna el calendarId activo de un usuario (Supabase → env fallback). */
async function getCalendarForUser(chatId) {
  try {
    const user = await getUserByTelegramId(chatId);
    if (user?.status === 'active' && user?.calendar_id) return user.calendar_id;
  } catch {}
  return getCalendarFromEnv(chatId);
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

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return OK_RESPONSE;
    }

    const message = update.message ?? update.edited_message;
    if (!message) return OK_RESPONSE;

    chatId = message.chat.id;
    logger.info('Mensaje recibido', { chatId, update_id: update.update_id });

    // ── Determinar estado del usuario ──────────────────────────────────────
    const supabaseUser = await getUserByTelegramId(chatId).catch(() => null);
    const envCalendar  = getCalendarFromEnv(chatId);

    // Usuario desactivado
    if (supabaseUser?.status === 'disabled') {
      await sendMessage(chatId, '⛔ Tu acceso ha sido desactivado. Contacta al administrador.').catch(() => {});
      return OK_RESPONSE;
    }

    // Usuario en onboarding (ya registrado en Supabase pero aún configurando)
    if (supabaseUser?.status === 'onboarding') {
      await handleOnboarding(chatId, message);
      return OK_RESPONSE;
    }

    // Usuario sin registro en Supabase → onboarding siempre.
    // USER_CALENDARS ya no otorga acceso directo; solo se usa para
    // pre-rellenar el calendar_id durante el onboarding o al auto-registrar
    // usuarios vía /mipanel. Esto garantiza que un usuario eliminado desde
    // el panel admin deba volver a registrarse.
    if (!supabaseUser) {
      await handleNewUser(chatId, message);
      return OK_RESPONSE;
    }

    // Usuario activo — obtener su calendarId
    const calendarId = await getCalendarForUser(chatId);
    if (!calendarId) {
      await sendMessage(chatId, '⛔ Tu cuenta no tiene un calendario configurado. Contacta al administrador.').catch(() => {});
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

// ─── Botones de recordatorios (confirmar / posponer) ─────────────────────────

/**
 * Maneja el toque de los botones inline de un recordatorio:
 * "✅ Ok" (solo confirma recepción) y "⏰ Posponer 15 min" (mueve el evento).
 */
async function handleCallbackQuery(callback) {
  const chatId = callback.message?.chat?.id;
  const [action, eventId] = (callback.data ?? '').split(':');

  if (!chatId || !eventId) {
    await answerCallbackQuery(callback.id).catch(() => {});
    return;
  }

  try {
    const calendarId = await getCalendarForUser(chatId);
    if (!calendarId) {
      await answerCallbackQuery(callback.id, '⛔ No se encontró tu calendario.').catch(() => {});
      return;
    }

    if (action === 'ok') {
      await answerCallbackQuery(callback.id, '👍 ¡Entendido!');

    } else if (action === 'postpone15') {
      const ev = await getEventById(eventId, calendarId);
      if (!ev || !ev.start?.dateTime) {
        await answerCallbackQuery(callback.id, '⚠️ No encontré ese evento.').catch(() => {});
        return;
      }

      const newStart = addMsToChileISO(ev.start.dateTime, 15 * 60 * 1000);
      const newEnd   = ev.end?.dateTime ? addMsToChileISO(ev.end.dateTime, 15 * 60 * 1000) : newStart;

      await updateCalendarEvent(eventId, calendarId, {
        start: { dateTime: newStart, timeZone: 'America/Santiago' },
        end:   { dateTime: newEnd,   timeZone: 'America/Santiago' },
      });

      await logEvent(chatId, calendarId, {
        id:         eventId,
        summary:    ev.summary ?? '',
        start_time: newStart,
        end_time:   newEnd,
        action:     'moved',
      });

      await setLastEvent(chatId, { id: eventId, summary: ev.summary ?? '', start_time: newStart, end_time: newEnd });

      await answerCallbackQuery(callback.id, '⏰ Evento pospuesto 15 minutos.');
      await sendMessage(chatId,
        `⏰ <b>Recordatorio pospuesto:</b>\n\n` +
        `📌 <b>${escapeHtml(ev.summary ?? 'Sin título')}</b>\n` +
        `🕐 Nuevo horario: ${escapeHtml(formatTimeOnly(newStart))}`,
      );

    } else {
      await answerCallbackQuery(callback.id).catch(() => {});
    }

  } catch (err) {
    logger.error('Error procesando callback_query', { error: err.message });
    await answerCallbackQuery(callback.id, '❌ Ocurrió un error.').catch(() => {});
  }
}

// ─── Onboarding: usuarios nuevos ─────────────────────────────────────────────

/** Primer contacto: el usuario no está en Supabase ni en USER_CALENDARS. */
async function handleNewUser(chatId, message) {
  await createUser(String(chatId));

  // Si el chat_id ya está en USER_CALENDARS el calendario ya está compartido,
  // así que solo pedimos el nombre y lo activamos automáticamente al responder.
  const envCalendar = getCalendarFromEnv(chatId);
  if (envCalendar) {
    await updateUser(chatId, { calendar_id: envCalendar, status: 'onboarding' });
    await saveConversation(chatId, 'ONBOARDING_NAME_FAST', {});
    await sendMessage(chatId,
      `👋 ¡Hola de nuevo! Para completar tu registro solo necesito saber tu nombre.\n\n` +
      `¿Cómo te llamas?`,
    );
    return;
  }

  await saveConversation(chatId, 'ONBOARDING_NAME', {});
  await sendMessage(chatId,
    `👋 ¡Hola! Soy tu asistente de agenda por voz. 🎙️\n\n` +
    `Voy a configurar tu cuenta en 3 pasos simples.\n\n` +
    `<b>Paso 1 de 3</b> — ¿Cómo te llamas?`,
  );
}

/** Maneja los mensajes de un usuario en proceso de onboarding. */
async function handleOnboarding(chatId, message) {
  const text    = message.text?.trim() ?? '';
  const pending = await getConversation(chatId);
  const state   = pending?.state;

  switch (state) {
    // Onboarding rápido para usuarios de USER_CALENDARS que fueron eliminados
    // y se están re-registrando. El calendario ya está compartido, solo pedimos nombre.
    case 'ONBOARDING_NAME_FAST': {
      if (!text || text.startsWith('/')) {
        await sendMessage(chatId, '📝 Por favor dime tu nombre para activar tu cuenta.');
        return;
      }
      const name = text.split(' ')[0];
      await updateUser(chatId, { name, status: 'active' });
      await clearConversation(chatId);
      await sendMessage(chatId,
        `✅ <b>¡Listo, ${escapeHtml(name)}! Tu cuenta está activa nuevamente.</b>\n\n` +
        `Ya puedes enviarme notas de voz para gestionar tu agenda. 🎙️`,
      );
      return;
    }

    case 'ONBOARDING_NAME': {
      if (!text || text.startsWith('/')) {
        await sendMessage(chatId, '📝 Por favor dime tu nombre para continuar con la configuración.');
        return;
      }
      const name = text.split(' ')[0]; // Solo el primer nombre
      await updateUser(chatId, { name });

      // Leer el email de la service account del JSON de credenciales
      let serviceEmail = 'agenda241088@agenda241088.iam.gserviceaccount.com';
      try {
        serviceEmail = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
      } catch {}

      await saveConversation(chatId, 'ONBOARDING_WAITING_SHARE', { name });
      await sendMessage(chatId,
        `¡Hola, <b>${escapeHtml(name)}</b>! 😊\n\n` +
        `<b>Paso 2 de 3</b> — Compartir tu Google Calendar\n\n` +
        `Necesito acceso a tu calendario para gestionarlo. Sigue estos pasos:\n\n` +
        `1. Abre <a href="https://calendar.google.com">Google Calendar</a> en el computador\n` +
        `2. Haz clic en los tres puntos junto a tu calendario principal\n` +
        `3. Selecciona <b>Configuración y uso compartido</b>\n` +
        `4. En <b>"Compartir con personas específicas"</b> agrega:\n` +
        `   <code>${escapeHtml(serviceEmail)}</code>\n` +
        `5. Dale permiso <b>"Hacer cambios en eventos"</b>\n` +
        `6. Guarda los cambios\n\n` +
        `Cuando termines, escríbeme <b>"listo"</b> ✅`,
      );
      break;
    }

    case 'ONBOARDING_WAITING_SHARE': {
      const lower = text.toLowerCase();
      if (!lower.includes('listo') && !lower.includes('ok') && !lower.includes('hice') && !lower.includes('ya')) {
        await sendMessage(chatId,
          `Cuando hayas compartido el calendario con la cuenta de servicio, escríbeme <b>"listo"</b> para continuar. 😊`,
        );
        return;
      }
      await saveConversation(chatId, 'ONBOARDING_EMAIL', pending?.context ?? {});
      await sendMessage(chatId,
        `¡Perfecto! 👍\n\n` +
        `<b>Paso 3 de 3</b> — Dime el email del calendario que compartiste.\n\n` +
        `Generalmente es tu Gmail:\n<i>ejemplo: tumail@gmail.com</i>`,
      );
      break;
    }

    case 'ONBOARDING_EMAIL': {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
      const match = text.match(emailRegex);
      if (!match) {
        await sendMessage(chatId, `⚠️ No reconocí ese email. Por favor escribe tu dirección de Gmail completa, por ejemplo:\n<i>tumail@gmail.com</i>`);
        return;
      }
      const calendarId = match[0].toLowerCase();

      // Verificar que el calendario es accesible
      await sendMessage(chatId, '🔍 Verificando acceso al calendario...');
      try {
        const { listEvents } = await import('../../src/services/calendar.js');
        const now = new Date().toISOString();
        await listEvents(now, now, calendarId);
      } catch (err) {
        logger.warn('Calendario no accesible en onboarding', { chatId, calendarId, err: err.message });
        await sendMessage(chatId,
          `❌ No pude acceder al calendario <i>${escapeHtml(calendarId)}</i>.\n\n` +
          `Asegúrate de haber compartido el calendario con la cuenta correcta y de haber dado permiso <b>"Hacer cambios en eventos"</b>.\n\n` +
          `Intenta de nuevo con el email del calendario. Si el problema persiste, verifica los permisos en Google Calendar. 🔧`,
        );
        return;
      }

      // ¡Todo bien! Activar usuario
      const ctx = pending?.context ?? {};
      await updateUser(chatId, { calendar_id: calendarId, status: 'active' });
      await clearConversation(chatId);

      await sendMessage(chatId,
        `✅ <b>¡Listo, ${escapeHtml(ctx.name ?? '')}! Tu cuenta está configurada.</b>\n\n` +
        `🎉 Ya puedo gestionar tu calendario. Vamos a hacer una prueba:\n\n` +
        `Envíame una nota de voz diciendo algo como:\n` +
        `<i>"Agendar reunión de prueba mañana a las 10 de la mañana"</i> 🎙️`,
      );
      break;
    }

    default:
      // Estado desconocido — reiniciar onboarding
      await clearConversation(chatId);
      await sendMessage(chatId,
        `Parece que hubo un problema con tu configuración. Vamos a empezar de nuevo.\n\n` +
        `¿Cómo te llamas?`,
      );
      await saveConversation(chatId, 'ONBOARDING_NAME', {});
  }
}

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

      const dateStr = extractDateFromISO(newDetails.start_time);

      // Si el usuario también corrigió la hora en este mensaje, usamos esa
      // en vez de la hora previamente guardada.
      const timeStr    = newDetails.time_specified
        ? extractTimeFromISO(newDetails.start_time)
        : context.partial_event.time;
      const durationMs = newDetails.time_specified
        ? new Date(newDetails.end_time).getTime() - new Date(newDetails.start_time).getTime()
        : context.partial_event.duration_ms ?? DEFAULT_DURATION_MS;

      const start_time = buildChileISO(dateStr, timeStr);
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
        await scheduleEvent(chatId, context.event, calendarId, context.transcription ?? textContent, context.queue ?? []);
      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. No se agendó ningún evento.');
        await proceedWithQueue(chatId, context, calendarId);
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
        await scheduleEvent(chatId, chosen, calendarId, context.transcription ?? textContent, context.queue ?? []);

      } else if (intent === 'slot_2' && free_slots?.[1]) {
        await clearConversation(chatId);
        const chosen = { ...event, start_time: free_slots[1].start, end_time: free_slots[1].end };
        await scheduleEvent(chatId, chosen, calendarId, context.transcription ?? textContent, context.queue ?? []);

      } else if (intent === 'overwrite' && busy_event) {
        await clearConversation(chatId);
        await overwriteEvent(
          chatId, event,
          { start: requested_start, end: requested_end },
          busy_event, calendarId,
          context.transcription ?? textContent,
        );
        await proceedWithQueue(chatId, context, calendarId);

      } else if (intent === 'force') {
        // Agendar igualmente, dejando ambos eventos superpuestos
        await clearConversation(chatId);
        const forcedEvent = { ...event, start_time: requested_start, end_time: requested_end };
        await forceScheduleEvent(chatId, forcedEvent, calendarId, context.transcription ?? textContent);
        await proceedWithQueue(chatId, context, calendarId);

      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. No se agendó ningún evento.');
        await proceedWithQueue(chatId, context, calendarId);

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
        await setLastEvent(chatId, null);
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

    // ── Esperando confirmación para mover evento ────────────────────────────
    case 'AWAITING_MOVE_CONFIRM': {
      const intent = detectSimpleIntent(textContent);

      if (intent === 'yes') {
        await clearConversation(chatId);
        const { event_id, event_summary, new_start_time, new_end_time, transcription } = context;
        await performMove(chatId, calendarId, { event_id, event_summary, new_start_time, new_end_time, transcription });
      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. El evento no fue modificado.');
      } else {
        await sendMessage(chatId, '🤔 Responde <b>"sí"</b> para confirmar el cambio o <b>"no"</b> para cancelar. 🎙️');
      }
      break;
    }

    // ── Esperando elección de horario al mover un evento (conflicto) ────────
    case 'AWAITING_MOVE_SLOT_CHOICE': {
      const intent = detectSimpleIntent(textContent);
      const {
        event_id, event_summary,
        requested_start, requested_end, busy_event, free_slots, transcription,
      } = context;

      if (intent === 'slot_1' || intent === 'slot_2') {
        const slot = intent === 'slot_1' ? free_slots?.[0] : free_slots?.[1];
        if (!slot) {
          await sendMessage(chatId, '🤔 Esa opción no está disponible. Elige otra.');
          break;
        }
        await clearConversation(chatId);
        await performMove(chatId, calendarId, {
          event_id, event_summary,
          new_start_time: slot.start, new_end_time: slot.end,
          transcription,
        });

      } else if (intent === 'overwrite') {
        await clearConversation(chatId);
        if (busy_event?.id) {
          await deleteCalendarEvent(busy_event.id, calendarId);
          await logEvent(chatId, calendarId, {
            id:      busy_event.id,
            summary: busy_event.summary ?? '',
            action:  'cancelled',
          });
        }
        await performMove(chatId, calendarId, {
          event_id, event_summary,
          new_start_time: requested_start, new_end_time: requested_end,
          transcription,
        });

      } else if (intent === 'force') {
        await clearConversation(chatId);
        await performMove(chatId, calendarId, {
          event_id, event_summary,
          new_start_time: requested_start, new_end_time: requested_end,
          transcription,
        });

      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. El evento no fue modificado.');

      } else {
        await sendMessage(chatId,
          '🤔 No entendí. Responde con el número de una opción (1️⃣, 2️⃣, 3️⃣ o 4️⃣) o <b>"no"</b> para cancelar. 🎙️',
        );
      }
      break;
    }

    // ── Esperando confirmación para agregar nota ─────────────────────────────
    case 'AWAITING_NOTE_CONFIRM': {
      const intent = detectSimpleIntent(textContent);

      if (intent === 'yes') {
        await clearConversation(chatId);
        const { event_id, event_summary, event_start, event_end, notes, existing_description } = context;
        const newDescription = existing_description
          ? `${existing_description}\n\n${notes}`
          : notes;

        await updateCalendarEvent(event_id, calendarId, { description: newDescription });
        await logEvent(chatId, calendarId, {
          id:         event_id,
          summary:    event_summary,
          start_time: event_start,
          transcription: notes,
          action:     'noted',
        });
        await setLastEvent(chatId, { id: event_id, summary: event_summary, start_time: event_start, end_time: event_end });
        await sendMessage(chatId,
          `📝 <b>Nota agregada al evento:</b>\n\n` +
          `📌 <b>${escapeHtml(event_summary)}</b>\n` +
          `📅 ${escapeHtml(formatDateTime(event_start))}\n\n` +
          `<i>"${escapeHtml(notes)}"</i>`,
        );
      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. El evento no fue modificado.');
      } else {
        await sendMessage(chatId, '🤔 Responde <b>"sí"</b> para agregar la nota o <b>"no"</b> para cancelar. 🎙️');
      }
      break;
    }

    // ── Esperando confirmación para editar título/descripción ───────────────
    case 'AWAITING_EDIT_CONFIRM': {
      const intent = detectSimpleIntent(textContent);

      if (intent === 'yes') {
        await clearConversation(chatId);
        const { event_id, event_summary, event_start, event_end, new_summary, new_notes } = context;

        const updates = {};
        if (new_summary) updates.summary = new_summary;
        if (new_notes !== null && new_notes !== undefined) updates.description = new_notes;

        await updateCalendarEvent(event_id, calendarId, updates);
        await logEvent(chatId, calendarId, {
          id:         event_id,
          summary:    new_summary ?? event_summary,
          start_time: event_start,
          end_time:   event_end,
          action:     'edited',
        });
        await setLastEvent(chatId, {
          id: event_id, summary: new_summary ?? event_summary,
          start_time: event_start, end_time: event_end,
        });
        await sendMessage(chatId,
          `✏️ <b>Evento actualizado:</b>\n\n` +
          `📌 <b>${escapeHtml(new_summary ?? event_summary)}</b>\n` +
          `📅 ${escapeHtml(formatDateTime(event_start))}`,
        );
      } else if (intent === 'no') {
        await clearConversation(chatId);
        await sendMessage(chatId, '↩️ Cancelado. El evento no fue modificado.');
      } else {
        await sendMessage(chatId, '🤔 Responde <b>"sí"</b> para aplicar los cambios o <b>"no"</b> para cancelar. 🎙️');
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
  const history = await getRecentEventHistory(chatId).catch(() => []);
  const eventDetails = await extractEventDetails(transcription, { history });

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
    case 'agendar':   await processAgendarIntent(chatId, eventDetails, transcription, calendarId); break;
    case 'consultar': await processConsultarIntent(chatId, eventDetails, calendarId); break;
    case 'cancelar':  await processCancelarIntent(chatId, eventDetails, transcription, calendarId); break;
    case 'mover':     await processMoverIntent(chatId, eventDetails, transcription, calendarId); break;
    case 'anotar':    await processAnotarIntent(chatId, eventDetails, transcription, calendarId); break;
    case 'editar':    await processEditarIntent(chatId, eventDetails, transcription, calendarId); break;
    default:
      await sendMessage(chatId,
        '❓ No entendí la acción. Puedes:\n' +
        '• <b>agendar</b> — crear un evento\n' +
        '• <b>consultar</b> — ver tu agenda\n' +
        '• <b>cancelar</b> — eliminar un evento\n' +
        '• <b>mover</b> — cambiar horario de un evento\n' +
        '• <b>agregar nota</b> — añadir descripción a un evento\n' +
        '• <b>editar</b> — cambiar el título o la descripción de un evento',
      );
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

  // Eventos adicionales mencionados en la misma nota de voz, con fecha y hora
  // completas, se encolan para confirmarlos uno por uno después de este.
  const queue = (eventDetails.additional_events ?? [])
    .filter((e) => e.date_specified !== false && e.time_specified !== false && e.start_time && e.end_time)
    .map((e) => ({
      summary:    e.summary,
      start_time: e.start_time,
      end_time:   e.end_time,
      notes:      e.notes ?? '',
    }));

  // Tenemos todo — pedir confirmación
  await askForConfirmation(chatId, {
    summary:    eventDetails.summary,
    start_time: eventDetails.start_time,
    end_time:   eventDetails.end_time,
    notes:      eventDetails.notes ?? '',
  }, calendarId, transcription, queue);
}

// ─── Pedir confirmación antes de agendar ─────────────────────────────────────

async function askForConfirmation(chatId, event, calendarId, transcription, queue = []) {
  await saveConversation(chatId, 'AWAITING_CONFIRMATION', { event, calendarId, transcription, queue });

  const remaining = queue.length > 0 ? `\n\n📋 Quedan ${queue.length} evento(s) más por confirmar después de este.` : '';

  await sendMessage(chatId,
    `📋 <b>¿Confirmas este evento?</b>\n\n` +
    `📌 <b>${escapeHtml(event.summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(event.start_time))}\n` +
    `⏱ Hasta las ${escapeHtml(formatTimeOnly(event.end_time))}${remaining}\n\n` +
    `Responde <b>"sí"</b> para agendar o <b>"no"</b> para cancelar 🎙️`,
  );
}

/**
 * Tras procesar la confirmación de un evento, si quedan eventos en la cola
 * (extraídos del mismo mensaje de voz), pide confirmación del siguiente.
 */
async function proceedWithQueue(chatId, context, calendarId) {
  const queue = context.queue ?? [];
  if (queue.length === 0) return;

  const [next, ...rest] = queue;
  await askForConfirmation(chatId, next, calendarId, context.transcription, rest);
}

// ─── Crear evento en calendario (luego de confirmación) ──────────────────────

async function scheduleEvent(chatId, event, calendarId, transcription, queue = []) {
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

    await setLastEvent(chatId, { id: created.id, summary: event.summary, start_time: event.start_time, end_time: event.end_time });

    await sendMessage(chatId,
      `✅ <b>¡Listo! Evento agendado:</b>\n\n` +
      `📌 <b>${escapeHtml(event.summary)}</b>\n` +
      `📅 ${escapeHtml(formatDateTime(event.start_time))}\n` +
      `⏱ Hasta las ${escapeHtml(formatTimeOnly(event.end_time))}\n\n` +
      `<a href="${created.htmlLink}">👉 Ver en Google Calendar</a>`,
    );

    await proceedWithQueue(chatId, { queue, transcription }, calendarId);

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
      queue,
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

  await setLastEvent(chatId, { id: created.id, summary: event.summary, start_time: slot.start, end_time: slot.end });

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

  await setLastEvent(chatId, { id: created.id, summary: event.summary, start_time: event.start_time, end_time: event.end_time });

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
  const { dayStart, dayEnd } = dayBoundsChileISO(dateStr);

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

// ─── Helper: elegir el evento más cercano al horario solicitado ─────────────

/**
 * De una lista de eventos del mismo día, retorna el que comienza más cerca
 * del horario de referencia. Evita actuar sobre el primer resultado cuando
 * hay varios eventos que coinciden con la búsqueda por texto.
 */
function pickClosestEvent(events, referenceISO) {
  if (events.length <= 1) return events[0];

  const refTime = new Date(referenceISO).getTime();
  return events.reduce((closest, e) => {
    const eStart = new Date(e.start.dateTime ?? e.start.date).getTime();
    const closestStart = new Date(closest.start.dateTime ?? closest.start.date).getTime();
    return Math.abs(eStart - refTime) < Math.abs(closestStart - refTime) ? e : closest;
  });
}

// ─── Helper: memoria del último evento referenciado ─────────────────────────

/**
 * Detecta si el usuario hace referencia a un evento mencionado previamente
 * en la conversación ("ese", "el anterior", "el que acabo de agendar", etc.)
 * en vez de describir un evento nuevo por nombre/fecha.
 */
function referencesPreviousEvent(text = '') {
  const t = text.toLowerCase();
  return /\b(ese|esa|eso|esta|este|el mismo|la misma|anterior|el último|la última|recién agendado|recien agendado|que acabo de|que te dije)\b/.test(t);
}

/** Convierte la referencia liviana de `last_event` al formato {id, summary, start, end} usado en los flujos. */
function lastEventToTarget(lastEvent) {
  if (!lastEvent) return null;
  return {
    id:      lastEvent.id,
    summary: lastEvent.summary,
    start:   { dateTime: lastEvent.start_time },
    end:     { dateTime: lastEvent.end_time },
  };
}

/** Aplica el cambio de horario de un evento ya confirmado y notifica al usuario. */
async function performMove(chatId, calendarId, { event_id, event_summary, new_start_time, new_end_time, transcription }) {
  const updated = await updateCalendarEvent(event_id, calendarId, {
    start: { dateTime: new_start_time, timeZone: TIMEZONE },
    end:   { dateTime: new_end_time,   timeZone: TIMEZONE },
  });

  await logEvent(chatId, calendarId, {
    id:            event_id,
    summary:       event_summary,
    start_time:    new_start_time,
    end_time:      new_end_time,
    transcription:  transcription ?? '',
    action:        'moved',
  });

  await setLastEvent(chatId, { id: event_id, summary: event_summary, start_time: new_start_time, end_time: new_end_time });

  await sendMessage(chatId,
    `✅ <b>Evento movido:</b>\n\n` +
    `📌 <b>${escapeHtml(event_summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(new_start_time))}\n` +
    `⏱ Hasta las ${escapeHtml(formatTimeOnly(new_end_time))}\n\n` +
    `<a href="${updated.htmlLink}">👉 Ver en Google Calendar</a>`,
  );
}

// ─── Flujo: cancelar evento ───────────────────────────────────────────────────

async function processCancelarIntent(chatId, eventDetails, transcription, calendarId) {
  const refDate  = eventDetails.start_time ? new Date(eventDetails.start_time) : new Date();
  const dateStr  = getChileDateString(refDate);
  const { dayStart, dayEnd } = dayBoundsChileISO(dateStr);

  // Buscar con la descripción del evento como query para filtrar
  const events = await listEvents(dayStart, dayEnd, calendarId, eventDetails.summary ?? '');

  let target;

  if (events.length === 0) {
    // Si el usuario se refiere a "ese evento"/"el anterior", probamos con
    // el último evento que recordamos para este usuario.
    target = referencesPreviousEvent(transcription) ? lastEventToTarget(await getLastEvent(chatId)) : null;

    if (!target) {
      await sendMessage(chatId,
        `🔍 No encontré eventos que coincidan con <i>"${escapeHtml(eventDetails.summary)}"</i> ` +
        `para el ${formatDateLong(refDate.toISOString())}.\n\n` +
        `Intenta con otro día o descripción. 🎙️`,
      );
      return;
    }
  } else if (events.length > 3) {
    // Demasiados resultados — pedir más especificidad
    let msg = `🔍 Encontré varios eventos ese día:\n\n`;
    events.slice(0, 5).forEach((e, i) => {
      msg += `${i + 1}. <b>${escapeHtml(e.summary)}</b> — ${e.start.dateTime ? formatTimeOnly(e.start.dateTime) : 'Todo el día'}\n`;
    });
    msg += `\nEnvíame una nota de voz más específica indicando cuál quieres cancelar. 🎙️`;
    await sendMessage(chatId, msg);
    return;
  } else {
    // Elegimos el evento más cercano al horario indicado
    target = pickClosestEvent(events, eventDetails.start_time);
  }

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

// ─── Flujo: mover evento ──────────────────────────────────────────────────────

async function processMoverIntent(chatId, eventDetails, transcription, calendarId) {
  const { summary, start_time, new_start_time, new_end_time, date_specified, time_specified } = eventDetails;

  // Verificar que tengamos el nuevo horario
  if (!new_start_time) {
    await sendMessage(chatId,
      `📋 Entendí que quieres mover: <b>${escapeHtml(summary)}</b>\n\n` +
      `⚠️ No mencionaste el nuevo horario.\n\n` +
      `Dime cuándo quieres reprogramarlo:\n` +
      `<i>"Muévelo al miércoles a las 4 de la tarde"</i> 🎙️`,
    );
    return;
  }

  // Verificar que tengamos la fecha/hora del evento original para buscarlo
  const refDate  = new Date(start_time);
  const dateStr  = getChileDateString(refDate);
  const { dayStart, dayEnd } = dayBoundsChileISO(dateStr);

  const events = await listEvents(dayStart, dayEnd, calendarId, summary);

  let target;
  if (events.length === 0) {
    // Si el usuario se refiere a "ese evento"/"el anterior", probamos con
    // el último evento que recordamos para este usuario.
    target = referencesPreviousEvent(transcription) ? lastEventToTarget(await getLastEvent(chatId)) : null;

    if (!target) {
      await sendMessage(chatId,
        `🔍 No encontré <i>"${escapeHtml(summary)}"</i> en ${formatDateLong(start_time)}.\n\n` +
        `Intenta describiendo mejor el evento o con otra fecha. 🎙️`,
      );
      return;
    }
  } else {
    target = pickClosestEvent(events, start_time);
  }

  const computedEnd = new_end_time ?? addMsToChileISO(
    new_start_time,
    new Date(target.end.dateTime ?? target.end.date) - new Date(target.start.dateTime ?? target.start.date),
  );

  // Verificar si el nuevo horario está disponible antes de confirmar
  const isFree    = await checkAvailability(new_start_time, computedEnd, calendarId);
  const busyEvent = isFree ? null : await getBusyEvent(new_start_time, computedEnd, calendarId);

  if (busyEvent && busyEvent.id !== target.id) {
    const freeSlots = await findNextFreeSlots(new_start_time, 2, calendarId);

    await saveConversation(chatId, 'AWAITING_MOVE_SLOT_CHOICE', {
      event_id:        target.id,
      event_summary:   target.summary ?? summary,
      original_start:  target.start.dateTime ?? target.start.date,
      original_end:    target.end.dateTime   ?? target.end.date,
      requested_start: new_start_time,
      requested_end:   computedEnd,
      busy_event:      busyEvent,
      free_slots:      freeSlots,
      transcription,
    });

    let msg =
      `⚠️ <b>El nuevo horario está ocupado:</b>\n` +
      `🚫 ${escapeHtml(formatDateTime(new_start_time))} — ${escapeHtml(formatTimeOnly(computedEnd))}\n` +
      `📌 Hay: <i>${escapeHtml(busyEvent.summary)}</i>\n\n` +
      `<b>Elige una opción para mover <i>${escapeHtml(target.summary ?? summary)}</i>:</b>\n\n`;

    freeSlots.forEach((slot, i) => {
      const emoji = i === 0 ? '1️⃣' : '2️⃣';
      msg += `${emoji} ${escapeHtml(formatDateTime(slot.start))} — ${escapeHtml(formatTimeOnly(slot.end))}\n`;
    });
    msg += `3️⃣ Reemplazar <i>${escapeHtml(busyEvent.summary)}</i>\n`;
    msg += `4️⃣ Mover de todas formas (quedarán simultáneos)\n`;
    msg += `\nResponde con tu elección o <b>"no"</b> para cancelar 🎙️`;

    await sendMessage(chatId, msg);
    return;
  }

  await saveConversation(chatId, 'AWAITING_MOVE_CONFIRM', {
    event_id:       target.id,
    event_summary:  target.summary ?? summary,
    original_start: target.start.dateTime ?? target.start.date,
    original_end:   target.end.dateTime   ?? target.end.date,
    new_start_time,
    new_end_time:   computedEnd,
    transcription,
  });

  await sendMessage(chatId,
    `🔄 <b>¿Confirmas este cambio de horario?</b>\n\n` +
    `📌 <b>${escapeHtml(target.summary ?? summary)}</b>\n\n` +
    `🗓 <b>Antes:</b> ${escapeHtml(formatDateTime(target.start.dateTime ?? target.start.date))}\n` +
    `🗓 <b>Después:</b> ${escapeHtml(formatDateTime(new_start_time))} — ${escapeHtml(formatTimeOnly(computedEnd))}\n\n` +
    `Responde <b>"sí"</b> para mover o <b>"no"</b> para cancelar 🎙️`,
  );
}

// ─── Flujo: agregar nota a evento ─────────────────────────────────────────────

async function processAnotarIntent(chatId, eventDetails, transcription, calendarId) {
  const { summary, start_time, notes } = eventDetails;

  if (!notes || notes.trim() === '') {
    await sendMessage(chatId,
      `📋 Entendí que quieres agregar una nota al evento: <b>${escapeHtml(summary)}</b>\n\n` +
      `⚠️ No entendí qué nota quieres agregar. Intenta de nuevo:\n` +
      `<i>"Agrega al evento del martes: llevar documentos firmados"</i> 🎙️`,
    );
    return;
  }

  const refDate  = new Date(start_time);
  const dateStr  = getChileDateString(refDate);
  const { dayStart, dayEnd } = dayBoundsChileISO(dateStr);

  const events = await listEvents(dayStart, dayEnd, calendarId, summary);

  let target;
  if (events.length === 0) {
    // Si el usuario se refiere a "ese evento"/"el anterior", probamos con
    // el último evento que recordamos para este usuario.
    target = referencesPreviousEvent(transcription) ? lastEventToTarget(await getLastEvent(chatId)) : null;

    if (!target) {
      await sendMessage(chatId,
        `🔍 No encontré <i>"${escapeHtml(summary)}"</i> en ${formatDateLong(start_time)}.\n\n` +
        `Intenta con otra descripción o fecha. 🎙️`,
      );
      return;
    }
  } else {
    target = pickClosestEvent(events, start_time);
  }

  await saveConversation(chatId, 'AWAITING_NOTE_CONFIRM', {
    event_id:            target.id,
    event_summary:       target.summary ?? summary,
    event_start:         target.start.dateTime ?? target.start.date,
    event_end:           target.end.dateTime   ?? target.end.date,
    notes,
    existing_description: target.description ?? '',
  });

  await sendMessage(chatId,
    `📝 <b>¿Confirmas agregar esta nota?</b>\n\n` +
    `📌 <b>${escapeHtml(target.summary ?? summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(target.start.dateTime ?? target.start.date))}\n\n` +
    `Nota a agregar:\n<i>"${escapeHtml(notes)}"</i>\n\n` +
    `Responde <b>"sí"</b> para confirmar o <b>"no"</b> para cancelar 🎙️`,
  );
}

// ─── Flujo: editar título/descripción de un evento ───────────────────────────

async function processEditarIntent(chatId, eventDetails, transcription, calendarId) {
  const { summary, start_time, new_summary, new_notes } = eventDetails;

  if (!new_summary && (new_notes === null || new_notes === undefined)) {
    await sendMessage(chatId,
      `📋 Entendí que quieres editar el evento: <b>${escapeHtml(summary)}</b>\n\n` +
      `⚠️ No entendí qué quieres cambiar. Intenta de nuevo:\n` +
      `<i>"Cambia el nombre de la reunión del martes a 'Reunión con cliente'"</i> 🎙️`,
    );
    return;
  }

  const refDate  = new Date(start_time);
  const dateStr  = getChileDateString(refDate);
  const { dayStart, dayEnd } = dayBoundsChileISO(dateStr);

  const events = await listEvents(dayStart, dayEnd, calendarId, summary);

  let target;
  if (events.length === 0) {
    // Si el usuario se refiere a "ese evento"/"el anterior", probamos con
    // el último evento que recordamos para este usuario.
    target = referencesPreviousEvent(transcription) ? lastEventToTarget(await getLastEvent(chatId)) : null;

    if (!target) {
      await sendMessage(chatId,
        `🔍 No encontré <i>"${escapeHtml(summary)}"</i> en ${formatDateLong(start_time)}.\n\n` +
        `Intenta con otra descripción o fecha. 🎙️`,
      );
      return;
    }
  } else {
    target = pickClosestEvent(events, start_time);
  }

  await saveConversation(chatId, 'AWAITING_EDIT_CONFIRM', {
    event_id:      target.id,
    event_summary: target.summary ?? summary,
    event_start:   target.start.dateTime ?? target.start.date,
    event_end:     target.end.dateTime   ?? target.end.date,
    new_summary:   new_summary || null,
    new_notes:     new_notes ?? null,
  });

  let msg = `✏️ <b>¿Confirmas estos cambios?</b>\n\n` +
    `📌 <b>${escapeHtml(target.summary ?? summary)}</b>\n` +
    `📅 ${escapeHtml(formatDateTime(target.start.dateTime ?? target.start.date))}\n\n`;

  if (new_summary)            msg += `Nuevo título: <b>${escapeHtml(new_summary)}</b>\n`;
  if (new_notes !== null && new_notes !== undefined) msg += `Nueva descripción:\n<i>"${escapeHtml(new_notes)}"</i>\n`;

  msg += `\nResponde <b>"sí"</b> para confirmar o <b>"no"</b> para cancelar 🎙️`;

  await sendMessage(chatId, msg);
}

// ─── Manejador de mensajes de texto ──────────────────────────────────────────

async function handleTextCommands(chatId, text, calendarId) {
  const lower = text.toLowerCase().trim();

  if (lower === '/start' || lower === '/help') {
    await sendMessage(chatId,
      `👋 <b>¡Hola! Soy tu asistente de agenda por voz.</b> 🎙️\n\n` +
      `Envíame notas de voz y gestionaré tu Google Calendar automáticamente.\n\n` +
      `<b>¿Qué puedo hacer?</b>\n` +
      `📅 <i>"Agendar cita con el médico mañana a las 10"</i>\n` +
      `🔍 <i>"¿Qué tengo hoy?"</i> o <i>"¿Qué tengo el martes?"</i>\n` +
      `🗑 <i>"Cancelar la reunión del viernes"</i>\n` +
      `🔄 <i>"Mover la reunión del martes al miércoles a las 4"</i>\n` +
      `📝 <i>"Agrégale al evento de mañana: llevar documentos"</i>\n` +
      `✏️ <i>"Cambia el nombre de la reunión del martes a 'Reunión con cliente'"</i>\n\n` +
      `<b>Recordatorios automáticos:</b>\n` +
      `• ⏰ 30 min antes de cada evento\n` +
      `• 🌅 Resumen del día cada mañana a las 8\n` +
      `• 🌙 Preview del día siguiente cada noche a las 21\n` +
      `• 📆 Resumen de la semana los domingos a las 10\n\n` +
      `<b>Comandos:</b>\n` +
      `/hoy — Ver tu agenda de hoy\n` +
      `/mipanel — Acceder a tu dashboard personal\n` +
      `/help — Mostrar este mensaje`,
    );
    return;
  }

  if (lower === '/mipanel') {
    try {
      // Asegurarse de que el usuario existe en Supabase.
      // Los usuarios de USER_CALENDARS (pre-onboarding) no tienen registro en la DB.
      const existing = await getUserByTelegramId(chatId).catch(() => null);
      if (!existing) {
        const envCalendar = getCalendarFromEnv(chatId);
        if (envCalendar) {
          // Registrar automáticamente como usuario activo
          await createUser(String(chatId));
          await updateUser(chatId, { calendar_id: envCalendar, status: 'active' });
          logger.info('Usuario de USER_CALENDARS auto-registrado en Supabase', { chatId, envCalendar });
        }
      }

      const url = await generateMagicLink(chatId);
      await sendMessage(chatId,
        `🌐 <b>Tu panel personal (válido 30 minutos):</b>\n\n` +
        `<a href="${url}">👉 Abrir mi agenda</a>\n\n` +
        `Desde ahí puedes ver tu historial y cambiar tus preferencias.`,
      );
    } catch (err) {
      logger.error('Error generando magic link', { chatId, err: err.message });
      await sendMessage(chatId, '❌ No pude generar tu enlace. Intenta de nuevo en un momento.');
    }
    return;
  }

  if (lower === '/hoy') {
    const today = new Date();
    const dateStr  = getChileDateString(today);
    const fakeEventDetails = { start_time: buildChileISO(dateStr, '12:00') };
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
