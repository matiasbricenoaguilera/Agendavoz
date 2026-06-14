/**
 * Helper de reintentos con backoff exponencial para llamadas a APIs externas
 * (OpenAI, Google Calendar). Solo reintenta errores transitorios
 * (rate limits, errores 5xx, fallas de red); cualquier otro error se
 * propaga de inmediato.
 */

import { logger } from './logger.js';

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Determina si un error de OpenAI/googleapis/red es transitorio y vale la pena reintentar. */
export function isRetryableError(err) {
  const status = err.status ?? err.code ?? err.response?.status;
  if (typeof status === 'number' && RETRYABLE_HTTP_STATUS.has(status)) return true;
  if (typeof err.code === 'string' && RETRYABLE_ERROR_CODES.has(err.code)) return true;
  return false;
}

/**
 * Ejecuta `fn` reintentando con backoff exponencial si el error es transitorio.
 *
 * @param {() => Promise<T>} fn
 * @param {object}  [options]
 * @param {number}  [options.retries=2]      - Cantidad máxima de reintentos (no incluye el intento inicial).
 * @param {number}  [options.baseDelayMs=500] - Delay base; se duplica en cada reintento.
 * @param {string}  [options.label='operación'] - Nombre descriptivo para logging.
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { retries = 2, baseDelayMs = 500, label = 'operación' } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err)) throw err;

      const delayMs = baseDelayMs * 2 ** attempt;
      logger.warn('Reintentando operación tras error transitorio', {
        label, attempt: attempt + 1, retries, delayMs, error: err.message,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
