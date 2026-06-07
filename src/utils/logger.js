/**
 * Logger estructurado (JSON) compatible con los logs de Netlify Functions.
 * En producción usa console.log/warn/error para que Netlify los capture.
 */

const isDev = process.env.NODE_ENV !== 'production';

function serialize(data) {
  if (data instanceof Error) {
    return { message: data.message, stack: data.stack, name: data.name };
  }
  return data;
}

function log(level, message, data) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(data !== undefined ? { data: serialize(data) } : {}),
  };

  const output = isDev
    ? `[${level}] ${message}${data !== undefined ? ' ' + JSON.stringify(serialize(data), null, 2) : ''}`
    : JSON.stringify(entry);

  if (level === 'ERROR') {
    console.error(output);
  } else if (level === 'WARN') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  info:  (message, data) => log('INFO',  message, data),
  warn:  (message, data) => log('WARN',  message, data),
  error: (message, data) => log('ERROR', message, data),
  debug: (message, data) => { if (isDev) log('DEBUG', message, data); },
};
