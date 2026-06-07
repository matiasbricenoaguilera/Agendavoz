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

// ─── Contexto de fecha para el NLU ────────────────────────────────────────────
const DATE_CONTEXT = `
Contexto de fecha y hora (OBLIGATORIO para interpretar referencias relativas):
- Hoy es domingo, 7 de junio de 2026.
- Zona horaria: America/Santiago (UTC-4, horario de invierno en Chile).
- Mañana         = lunes 8 de junio de 2026
- Este lunes     = lunes 8 de junio de 2026
- Este martes    = martes 9 de junio de 2026
- Este miércoles = miércoles 10 de junio de 2026
- Este jueves    = jueves 11 de junio de 2026
- Este viernes   = viernes 12 de junio de 2026
- Este sábado    = sábado 13 de junio de 2026
- El próximo lunes (semana siguiente) = lunes 15 de junio de 2026
`.trim();

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

${DATE_CONTEXT}

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{
  "intent": "agendar" | "cancelar" | "consultar" | "desconocido",
  "summary": "Título claro y conciso del evento (máx 60 caracteres)",
  "start_time": "2026-06-08T15:00:00-04:00",
  "end_time": "2026-06-08T16:00:00-04:00",
  "notes": ""
}

Reglas:
1. Si no se especifica hora de fin, asume exactamente 1 hora de duración.
2. Si no se especifica fecha, usa mañana (lunes 8 de junio de 2026).
3. Si no se especifica hora:
   - Citas médicas, dentista → 10:00
   - Reuniones de trabajo → 09:00
   - Llamadas → 11:00
   - Actividades sociales o cenas → 19:00
   - Cualquier otro evento → 12:00
4. Usa siempre formato ISO 8601 con offset -04:00.
5. No incluyas markdown, solo el JSON puro.
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
