/**
 * Servicio de Telegram — encapsula todas las llamadas a la Bot API.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

function getApiUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no está configurado.');
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Envía un mensaje de texto al chat indicado.
 * Usa parse_mode Markdown para negritas, enlaces, etc.
 */
export async function sendMessage(chatId, text, extraOptions = {}) {
  const payload = {
    chat_id:    chatId,
    text,
    parse_mode: 'MarkdownV2',
    ...extraOptions,
  };
  const response = await axios.post(getApiUrl('sendMessage'), payload);
  return response.data;
}

/**
 * Muestra el indicador "escribiendo..." en el chat.
 * No es crítico; los errores se silencian para no interrumpir el flujo.
 */
export async function sendTypingAction(chatId) {
  await axios
    .post(getApiUrl('sendChatAction'), { chat_id: chatId, action: 'typing' })
    .catch((err) => logger.warn('sendTypingAction falló (no crítico)', err.message));
}

/**
 * Obtiene la URL de descarga de un archivo de Telegram y lo descarga
 * como Buffer, infiriendo el tipo MIME a partir de la ruta del archivo.
 *
 * @returns {{ buffer: Buffer, mimeType: string, filePath: string }}
 */
export async function downloadFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no está configurado.');

  // Paso 1: obtener la ruta del archivo
  const infoRes = await axios.get(getApiUrl('getFile'), {
    params: { file_id: fileId },
  });

  const filePath = infoRes.data.result?.file_path;
  if (!filePath) throw new Error(`No se pudo obtener file_path para file_id: ${fileId}`);

  logger.debug('Descargando archivo de Telegram', { filePath });

  // Paso 2: descargar el binario
  const fileUrl  = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const fileRes  = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const buffer   = Buffer.from(fileRes.data);

  const mimeType = resolveMimeType(filePath);
  logger.info('Archivo descargado', { filePath, bytes: buffer.length, mimeType });

  return { buffer, mimeType, filePath };
}

/** Infiere el MIME type a partir de la extensión del archivo. */
function resolveMimeType(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map = {
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
  };
  return map[ext] ?? 'audio/ogg'; // Telegram Voice usa ogg+opus por defecto
}
