/**
 * Servicio de IA — transcripción de audio con OpenAI Whisper (STT)
 * y extracción de detalles de eventos con GPT-4o-mini (NLU).
 *
 * Reemplaza la integración anterior con Google Gemini.
 */

import OpenAI, { toFile } from 'openai';
import { logger } from '../utils/logger.js';

const MODEL_NLU = 'gpt-4o-mini';
const MODEL_STT = 'whisper-1';

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no está configurado.');
  return new OpenAI({ apiKey });
}

// ─── Contexto de fecha dinámico ───────────────────────────────────────────────
const TIMEZONE    = 'America/Santiago';
const LOCALE      = 'es-CL';
const DAYS_ES     = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const CHILE_OFFSET_MS = -4 * 60 * 60 * 1000; // UTC-4 (invierno)

function buildDateContext() {
  const now       = new Date(Date.now() + CHILE_OFFSET_MS);
  const todayStr  = now.toLocaleDateString('sv-SE', { timeZone: TIMEZONE }); // YYYY-MM-DD
  const dayName   = DAYS_ES[now.getUTCDay()];

  // Generar los próximos 7 días con su nombre y fecha
  const lines = [`Contexto de fecha y hora (OBLIGATORIO para interpretar referencias relativas):`];
  lines.push(`- Hoy es ${dayName}, ${now.toLocaleDateString(LOCALE, { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`);
  lines.push(`- Zona horaria: America/Santiago (UTC-4).`);
  lines.push(`- Si no se menciona fecha, usa HOY: ${todayStr}.`);

  for (let i = 1; i <= 7; i++) {
    const d    = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const name = i === 1 ? 'Mañana' : `Este ${DAYS_ES[d.getUTCDay()]}`;
    const date = d.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
    lines.push(`- ${name} = ${date}`);
  }

  return lines.join('\n');
}

// ─── 1. Transcripción de voz a texto (Whisper) ────────────────────────────────

/**
 * Transcribe un Buffer de audio usando OpenAI Whisper.
 *
 * @param {Buffer} audioBuffer - Bytes del archivo de audio.
 * @param {string} mimeType    - MIME type (e.g. 'audio/ogg').
 * @returns {Promise<string>}  - Texto transcrito en español.
 */
export async function transcribeAudio(audioBuffer, mimeType) {
  const client = getClient();

  // Mapear MIME type a extensión para que Whisper identifique el formato
  const ext = mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
    : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
    : mimeType.includes('wav') ? 'wav'
    : 'ogg';

  logger.debug('Enviando audio a Whisper para transcripción', { mimeType, bytes: audioBuffer.length });

  const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType });

  const response = await client.audio.transcriptions.create({
    model:    MODEL_STT,
    file,
    language: 'es',
  });

  const transcription = response.text?.trim() ?? '';
  logger.info('Transcripción completada', { transcription });
  return transcription;
}

// ─── 2. Extracción de detalles del evento (GPT NLU) ───────────────────────────

/**
 * Extrae detalles de un evento de calendario a partir de texto en español.
 *
 * @param {string} transcription - Texto con la petición del usuario.
 * @returns {Promise<EventDetails>}
 *
 * @typedef {Object} EventDetails
 * @property {'agendar'|'cancelar'|'consultar'|'desconocido'} intent
 * @property {string} summary    - Título del evento.
 * @property {string} start_time - ISO 8601 con offset -04:00.
 * @property {string} end_time   - ISO 8601 con offset -04:00.
 * @property {string} [notes]    - Notas adicionales opcionales.
 */
export async function extractEventDetails(transcription) {
  const client = getClient();

  const systemPrompt = `
Eres un asistente que extrae detalles de eventos de calendario a partir de texto en español.

${buildDateContext()}

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{
  "intent": "agendar" | "cancelar" | "consultar" | "desconocido",
  "summary": "Título claro y conciso del evento (máx 60 caracteres)",
  "start_time": "2026-06-08T15:00:00-04:00",
  "end_time": "2026-06-08T16:00:00-04:00",
  "notes": "",
  "date_specified": true,
  "time_specified": true
}

Reglas:
1. Si no se especifica hora de fin, asume exactamente 1 hora de duración.
2. Si no se menciona explícitamente un día o fecha, usa hoy y marca "date_specified": false.
3. Si no se menciona explícitamente una hora, usa el valor por defecto y marca "time_specified": false:
   - Citas médicas, dentista → 10:00
   - Reuniones de trabajo → 09:00
   - Llamadas → 11:00
   - Actividades sociales o cenas → 19:00
   - Cualquier otro evento → 12:00
4. Si el usuario SÍ dijo un día ("mañana", "el martes", "el 15") marca "date_specified": true.
5. Si el usuario SÍ dijo una hora ("a las 3", "a las 15:00") marca "time_specified": true.
6. Usa siempre formato ISO 8601 con offset -04:00.
7. No incluyas markdown, solo el JSON puro.
`.trim();

  const response = await client.chat.completions.create({
    model:           MODEL_NLU,
    temperature:     0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Texto del usuario: "${transcription}"` },
    ],
  });

  const rawText = response.choices[0]?.message?.content ?? '{}';
  const details = JSON.parse(rawText);
  logger.info('Detalles del evento extraídos', { details });
  return details;
}
