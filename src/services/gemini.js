/**
 * Servicio de Gemini AI — transcripción de audio (STT) y extracción de
 * detalles de eventos de calendario (NLU) en un solo módulo.
 */

import { GoogleGenAI } from '@google/genai';
import { logger } from '../utils/logger.js';

const MODEL = 'gemini-2.0-flash';

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no está configurado.');
  return new GoogleGenAI({ apiKey });
}

// ─── Contexto de fecha estático para que Gemini calcule días relativos ────────
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
- La próxima semana comienza el lunes 15 de junio de 2026.
`.trim();

// ─── 1. Transcripción de voz a texto ──────────────────────────────────────────

/**
 * Transcribe un archivo de audio usando las capacidades multimodales de Gemini.
 *
 * @param {Buffer} audioBuffer  - Buffer con los bytes del audio.
 * @param {string} mimeType     - MIME type del audio (e.g. 'audio/ogg').
 * @returns {Promise<string>}   - Texto transcrito en español.
 */
export async function transcribeAudio(audioBuffer, mimeType) {
  const ai = getClient();
  const base64Audio = audioBuffer.toString('base64');

  logger.debug('Enviando audio a Gemini para transcripción', { mimeType, bytes: audioBuffer.length });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        parts: [
          {
            inlineData: { mimeType, data: base64Audio },
          },
          {
            text: [
              'Transcribe exactamente lo que se dice en este audio.',
              'El idioma es español (variante chilena o latinoamericana).',
              'Responde ÚNICAMENTE con la transcripción literal, sin comentarios, sin puntuación extra.',
            ].join(' '),
          },
        ],
      },
    ],
  });

  const transcription = response.text?.trim() ?? '';
  logger.info('Transcripción completada', { transcription });
  return transcription;
}

// ─── 2. Extracción de detalles del evento (NLU) ───────────────────────────────

/**
 * Analiza el texto transcrito y extrae un objeto JSON con los detalles
 * necesarios para crear un evento en Google Calendar.
 *
 * @param {string} transcription - Texto en español con la petición del usuario.
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
  const ai = getClient();

  const prompt = `
${DATE_CONTEXT}

Analiza el siguiente texto en español y extrae los detalles del evento de calendario.

Texto del usuario: "${transcription}"

Responde ÚNICAMENTE con un objeto JSON válido. No uses markdown ni bloques de código.
Usa exactamente esta estructura:

{
  "intent": "agendar",
  "summary": "Título claro y conciso del evento",
  "start_time": "2026-06-08T15:00:00-04:00",
  "end_time": "2026-06-08T16:00:00-04:00",
  "notes": "Notas opcionales del evento"
}

Reglas de extracción:
1. intent puede ser: "agendar", "cancelar", "consultar" o "desconocido".
2. Si no se especifica hora de fin, asume exactamente 1 hora de duración.
3. Si no se especifica fecha, usa mañana (lunes 8 de junio de 2026).
4. Si no se especifica hora:
   - Citas médicas, dentistas, médicos → 10:00
   - Reuniones de trabajo → 09:00
   - Llamadas → 11:00
   - Actividades sociales o cenas → 19:00
   - Cualquier otro evento → 12:00
5. Usa siempre formato ISO 8601 con offset de zona horaria -04:00.
   Ejemplo correcto: "2026-06-09T14:30:00-04:00"
6. summary debe ser un título corto y descriptivo (máx. 60 caracteres).
7. Si el intent es "desconocido", igual llena summary con lo que se entiende.
8. notes puede estar vacío ("") si no hay detalles adicionales.
`.trim();

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      temperature:      0.1,
      responseMimeType: 'application/json',
    },
  });

  const rawText = response.text?.trim() ?? '{}';

  // Limpia posibles bloques markdown que el modelo igualmente pueda añadir
  const cleanedText = rawText
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  const details = JSON.parse(cleanedText);
  logger.info('Detalles del evento extraídos', { details });
  return details;
}
