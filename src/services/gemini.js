/**
 * Servicio de IA — transcripción de audio con OpenAI Whisper (STT)
 * y extracción de detalles de eventos con GPT-4o-mini (NLU).
 *
 * Reemplaza la integración anterior con Google Gemini.
 */

import OpenAI, { toFile } from 'openai';
import { logger } from '../utils/logger.js';
import { getChileOffsetString, normalizeToChileISO } from '../utils/dateUtils.js';
import { withRetry } from '../utils/retry.js';
import { logApiUsage } from './supabase.js';

const MODEL_NLU = 'gpt-4o-mini';
const MODEL_STT = 'whisper-1';

// Precios estimados de OpenAI (USD), para estimar costos en el dashboard de
// administración. Actualizar manualmente si OpenAI cambia sus tarifas.
const PRICING = {
  'gpt-4o-mini': { perMTokIn: 0.150, perMTokOut: 0.600 },
  'whisper-1':   { perMinute: 0.006 },
};

function registerUsage(usage) {
  logApiUsage(usage).catch((err) => logger.error('Error registrando consumo de API', { error: err.message }));
}

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no está configurado.');
  return new OpenAI({ apiKey });
}

// ─── Contexto de fecha dinámico ───────────────────────────────────────────────
const TIMEZONE    = 'America/Santiago';
const LOCALE      = 'es-CL';

function buildDateContext() {
  const now      = new Date();
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: TIMEZONE }); // YYYY-MM-DD
  const offset   = getChileOffsetString(now);

  const lines = [`Contexto de fecha y hora (OBLIGATORIO para interpretar referencias relativas):`];
  lines.push(`- Hoy es ${now.toLocaleDateString(LOCALE, { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`);
  lines.push(`- Zona horaria: America/Santiago (UTC${offset}).`);
  lines.push(`- Si no se menciona fecha, usa HOY: ${todayStr}.`);

  for (let i = 1; i <= 7; i++) {
    const d        = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const date     = d.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
    const weekday  = d.toLocaleDateString(LOCALE, { timeZone: TIMEZONE, weekday: 'long' });
    const name     = i === 1 ? 'Mañana' : `Este ${weekday}`;
    lines.push(`- ${name} = ${date}`);
  }

  return lines.join('\n');
}

// ─── 1. Transcripción de voz a texto (Whisper) ────────────────────────────────

/**
 * Transcribe un Buffer de audio usando OpenAI Whisper.
 *
 * @param {Buffer} audioBuffer  - Bytes del archivo de audio.
 * @param {string} mimeType     - MIME type (e.g. 'audio/ogg').
 * @param {string|number} [chatId] - ID de Telegram del usuario, para registrar el consumo.
 * @param {string} [vocabularyHint] - Vocabulario habitual del usuario (nombres, lugares,
 *   títulos de eventos frecuentes) para mejorar el reconocimiento de palabras poco comunes.
 * @returns {Promise<string>}   - Texto transcrito en español.
 */
export async function transcribeAudio(audioBuffer, mimeType, chatId, vocabularyHint) {
  const client = getClient();

  // Mapear MIME type a extensión para que Whisper identifique el formato
  const ext = mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
    : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
    : mimeType.includes('wav') ? 'wav'
    : 'ogg';

  logger.debug('Enviando audio a Whisper para transcripción', { mimeType, bytes: audioBuffer.length });

  const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType });

  const response = await withRetry(() => client.audio.transcriptions.create({
    model:           MODEL_STT,
    file,
    language:        'es',
    response_format: 'verbose_json',
    ...(vocabularyHint ? { prompt: vocabularyHint } : {}),
  }), { label: 'transcribeAudio' });

  const transcription = response.text?.trim() ?? '';
  logger.info('Transcripción completada', { transcription });

  const audioSeconds = response.duration ?? null;
  if (audioSeconds != null) {
    registerUsage({
      telegramId: chatId,
      model:      MODEL_STT,
      kind:       'stt',
      audioSeconds,
      costUsd:    (audioSeconds / 60) * PRICING['whisper-1'].perMinute,
    });
  }

  return transcription;
}

// ─── 2. Extracción de detalles del evento (GPT NLU) ───────────────────────────

/**
 * Construye un bloque de contexto con el historial reciente del usuario,
 * para que el modelo pueda inferir horarios habituales por tipo de evento
 * (e.g. "gimnasio" siempre se agenda a las 07:00).
 *
 * @param {Array<{summary: string, start_time: string}>} history
 * @returns {string}
 */
function buildHistoryContext(history) {
  if (!history || history.length === 0) return '';

  const lines = history.slice(0, 15).map((h) => {
    const time = h.start_time ? extractTimeForHistory(h.start_time) : '??:??';
    return `- "${h.summary}" → ${time}`;
  });

  return [
    `Historial reciente de eventos de este usuario (más reciente primero).`,
    `Útil para inferir el horario habitual cuando el usuario no especifica hora`,
    `para un tipo de evento similar a uno del historial:`,
    ...lines,
  ].join('\n');
}

function extractTimeForHistory(isoString) {
  return isoString.slice(11, 16);
}

/**
 * Construye un hint de vocabulario para Whisper a partir de los títulos de
 * eventos recientes del usuario (nombres propios, lugares, términos habituales)
 * y de las correcciones previas que el usuario aplicó a títulos mal transcritos.
 *
 * @param {Array<{summary: string}>} history
 * @param {Array<{original: string, corrected: string}>} [corrections]
 * @returns {string} - Términos únicos separados por coma, truncado a 200 caracteres.
 */
export function buildVocabularyHint(history, corrections = []) {
  const fromHistory    = (history ?? []).map((h) => h.summary).filter(Boolean);
  const fromCorrections = (corrections ?? []).map((c) => c.corrected).filter(Boolean);
  const unique = [...new Set([...fromCorrections, ...fromHistory])];

  if (unique.length === 0) return '';
  const hint = unique.join(', ');
  return hint.length > 200 ? hint.slice(0, 200) : hint;
}

/**
 * Extrae detalles de un evento de calendario a partir de texto en español.
 *
 * @param {string} transcription - Texto con la petición del usuario.
 * @param {object} [options]
 * @param {Array<{summary: string, start_time: string}>} [options.history] - Historial reciente del usuario.
 * @param {string|number} [options.chatId] - ID de Telegram del usuario, para registrar el consumo.
 * @returns {Promise<EventDetails>}
 *
 * @typedef {Object} EventDetails
 * @property {'agendar'|'cancelar'|'consultar'|'desconocido'} intent
 * @property {string} summary    - Título del evento.
 * @property {string} start_time - ISO 8601 con offset -04:00.
 * @property {string} end_time   - ISO 8601 con offset -04:00.
 * @property {string} [notes]    - Notas adicionales opcionales.
 * @property {Array<object>} [additional_events] - Otros eventos mencionados en el mismo mensaje (solo intent "agendar").
 */
export async function extractEventDetails(transcription, options = {}) {
  const client = getClient();
  const historyContext = buildHistoryContext(options.history);

  const systemPrompt = `
Eres un asistente que extrae detalles de eventos de calendario a partir de texto en español.

${buildDateContext()}

${historyContext ? historyContext + '\n' : ''}
Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{
  "intent": "agendar" | "cancelar" | "consultar" | "mover" | "anotar" | "editar" | "desconocido",
  "summary": "Título claro y conciso del evento (máx 60 caracteres)",
  "start_time": "2026-06-08T15:00:00-04:00",
  "end_time": "2026-06-08T16:00:00-04:00",
  "notes": "",
  "new_start_time": null,
  "new_end_time": null,
  "new_summary": null,
  "new_notes": null,
  "date_specified": true,
  "time_specified": true,
  "category": "trabajo",
  "additional_events": []
}

Reglas generales:
1. Si no se especifica hora de fin, asume exactamente 1 hora de duración.
2. Si no se menciona explícitamente un día o fecha, usa hoy y marca "date_specified": false.
3. Si no se menciona explícitamente una hora, usa el valor por defecto y marca "time_specified": false:
   - Citas médicas, dentista → 10:00
   - Reuniones de trabajo → 09:00
   - Llamadas → 11:00
   - Actividades sociales o cenas → 19:00
   - Cualquier otro evento → 12:00
   - EXCEPCIÓN: si el "Historial reciente" muestra un horario habitual para un
     evento de tipo similar (mismo texto o muy parecido), usa ESE horario en
     vez del valor por defecto, y marca "time_specified": false igualmente
     (porque el usuario no lo dijo explícitamente, solo lo infirimos).
4. Si el usuario SÍ dijo un día marca "date_specified": true.
5. Si el usuario SÍ dijo una hora marca "time_specified": true.
6. Usa siempre formato ISO 8601 con offset -04:00.
7. No incluyas markdown, solo el JSON puro.
8. "category" (solo aplica a intents "agendar" y "editar"; en otros casos usa "otro"):
   clasifica el evento en UNA de estas categorías según su naturaleza:
   - "trabajo": reuniones, llamadas laborales, entregas, tareas de oficina.
   - "salud": médico, dentista, gimnasio, terapia, exámenes.
   - "personal": trámites, compras, citas personales.
   - "social": juntas con amigos, cumpleaños, eventos familiares.
   - "estudio": clases, cursos, certámenes.
   - "otro": cualquier cosa que no calce claramente en las anteriores.

Reglas por intent:
- "mover": El usuario quiere cambiar el horario de un evento existente.
  • start_time = fecha/hora aproximada del evento ORIGINAL (para buscarlo).
  • new_start_time = nuevo horario deseado con fecha completa.
  • new_end_time = nueva hora de fin (si no se dice, suma la misma duración o 1 hora).
  • date_specified y time_specified aplican sobre new_start_time.
- "anotar": El usuario quiere AGREGAR una nota o descripción a un evento existente
  (sin borrar lo que ya tenía).
  • start_time = fecha/hora aproximada del evento.
  • notes = la nota o texto a agregar.
  • new_start_time = null, new_end_time = null.
- "editar": El usuario quiere CAMBIAR el título y/o REEMPLAZAR la descripción de
  un evento existente (a diferencia de "anotar", que solo agrega texto).
  • start_time = fecha/hora aproximada del evento a editar (para buscarlo).
  • new_summary = nuevo título del evento, o null si no lo cambia.
  • new_notes = nueva descripción que reemplaza la anterior, o null si no la cambia.
  • new_start_time = null, new_end_time = null.
- "consultar": start_time = fecha del día a consultar (si dice "mañana" usa la fecha correcta).
- "cancelar": start_time = fecha/hora aproximada del evento a cancelar.

Eventos múltiples (solo para intent "agendar"):
- Si el usuario menciona VARIOS eventos distintos en el mismo mensaje
  (e.g. "agenda dentista el lunes a las 10 y reunión el martes a las 4"),
  usa los campos principales (summary, start_time, end_time, etc.) para el
  PRIMER evento, y coloca los demás en "additional_events" como objetos con
  la misma forma: { "summary", "start_time", "end_time", "notes",
  "date_specified", "time_specified", "category" }.
- Si solo hay un evento, "additional_events" debe ser un arreglo vacío [].
- Cada evento en "additional_events" debe tener fecha Y hora especificadas
  por el usuario (date_specified y time_specified en true). Si a algún
  evento adicional le falta fecha u hora, ignóralo (no lo incluyas).
`.trim();

  const response = await withRetry(() => client.chat.completions.create({
    model:           MODEL_NLU,
    temperature:     0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Texto del usuario: "${transcription}"` },
    ],
  }), { label: 'extractEventDetails' });

  const rawText = response.choices[0]?.message?.content ?? '{}';
  const details = JSON.parse(rawText);

  const tokensIn  = response.usage?.prompt_tokens ?? null;
  const tokensOut = response.usage?.completion_tokens ?? null;
  if (tokensIn != null || tokensOut != null) {
    registerUsage({
      telegramId: options.chatId,
      model:      MODEL_NLU,
      kind:       'chat',
      tokensIn,
      tokensOut,
      costUsd:    ((tokensIn ?? 0) / 1_000_000) * PRICING['gpt-4o-mini'].perMTokIn
                 + ((tokensOut ?? 0) / 1_000_000) * PRICING['gpt-4o-mini'].perMTokOut,
    });
  }

  // El modelo siempre responde con offset -04:00; lo normalizamos al offset
  // real de Chile para esa fecha (puede ser -03:00 en horario de verano).
  for (const field of ['start_time', 'end_time', 'new_start_time', 'new_end_time']) {
    if (details[field]) details[field] = normalizeToChileISO(details[field]);
  }

  for (const extra of details.additional_events ?? []) {
    for (const field of ['start_time', 'end_time']) {
      if (extra[field]) extra[field] = normalizeToChileISO(extra[field]);
    }
  }

  logger.info('Detalles del evento extraídos', { details });
  return details;
}
