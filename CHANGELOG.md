# Changelog — Agenda por Voz

Todos los cambios notables de este proyecto están documentados aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).

---

## [1.0.0] — 2026-06-07

### Añadido

- **Estructura del proyecto** Netlify Functions con Node.js 20+ y ES Modules.
- **`netlify/functions/telegram-bot.js`** — Webhook principal que orquesta todo el flujo de procesamiento.
  - Validación de token secreto del webhook (`TELEGRAM_WEBHOOK_SECRET`).
  - Filtro de seguridad por `OWNER_CHAT_ID` para responder solo al chat autorizado.
  - Manejo de mensajes de voz (`voice`) y audio (`audio`) de Telegram.
  - Comandos de texto `/start` y `/help`.
  - Siempre retorna `HTTP 200` a Telegram para evitar reintentos automáticos.
- **`src/services/gemini.js`** — Integración con Google Gemini 2.0 Flash.
  - `transcribeAudio()`: STT multimodal nativo con audio inline (base64).
  - `extractEventDetails()`: NLU estructurado que retorna JSON con `intent`, `summary`, `start_time`, `end_time`, `notes`.
  - Contexto de fecha estático para el 7 de junio de 2026 (cálculo de fechas relativas en español).
  - Temperatura 0.1 + `responseMimeType: application/json` para respuestas deterministas.
- **`src/services/calendar.js`** — Integración con Google Calendar API v3.
  - Autenticación via Service Account desde variable de entorno `GOOGLE_SERVICE_ACCOUNT_JSON`.
  - `checkAvailability()`: Verifica si un bloque de tiempo está libre.
  - `createCalendarEvent()`: Inserta un evento con zona horaria `America/Santiago`.
  - `findNextFreeSlots()`: Busca los próximos N bloques libres de 1 hora en horario laboral (08:00–20:00).
    Busca en el día actual y, si no hay suficientes, continúa en el día siguiente.
- **`src/services/telegram.js`** — Cliente de la Telegram Bot API.
  - `sendMessage()`: Envío de mensajes con MarkdownV2.
  - `sendTypingAction()`: Indicador "escribiendo..." (no bloqueante).
  - `downloadFile()`: Descarga archivos de audio con inferencia de MIME type.
- **`src/utils/dateUtils.js`** — Utilidades de fecha/hora.
  - `getChileDateString()`, `formatDateTime()`, `formatTimeOnly()`, `toChileISO()`, `addHoursToISO()`.
  - Zona horaria `America/Santiago` (UTC-4 en invierno).
- **`src/utils/logger.js`** — Logger estructurado JSON compatible con Netlify Functions.
  - Niveles: `info`, `warn`, `error`, `debug`.
  - Formato legible en desarrollo, JSON compacto en producción.
- **`package.json`** con dependencias: `@google/genai`, `googleapis`, `axios`; y devDependencies: `netlify-cli`, `dotenv`.
- **`netlify.toml`** con bundler `esbuild`, timeout de 26 s y redirecciones `/api/*`.
- **`.env.example`** con documentación de todas las variables de entorno requeridas.
- **`.gitignore`** que excluye `.env`, `node_modules/` y archivos de audio de prueba.
- **`tests/test-local.js`** — Script multi-modo para pruebas locales:
  - `--phrase "..."`: Prueba el NLU de Gemini directamente sin Telegram.
  - `--audio archivo.ogg`: Prueba STT + NLU con un archivo de audio real.
  - `--voice`: Envía el mock de nota de voz al servidor local.
  - Default: Envía un payload de texto `/start` al servidor local.
- **`tests/mock-payload.json`** — Payload simulado de nota de voz de Telegram.
- **`tests/mock-text-payload.json`** — Payload simulado de mensaje de texto `/start`.

### Decisiones de diseño

- **MarkdownV2** en lugar de Markdown para mayor compatibilidad futura con Telegram.
- **ESM (`"type": "module"`)** en todo el proyecto para código moderno y consistente.
- **esbuild** como bundler de Netlify para soporte nativo de ESM y tree-shaking.
- **Inline data (base64)** para el audio en Gemini (válido hasta ~20MB; para audios mayores usar File API).
- **UTC-4 fijo** para junio 2026 en Chile; en producción considerar `luxon` o `date-fns-tz` para manejo dinámico de DST.

---

## [Próximas versiones — Roadmap]

- [ ] Consulta de próximos eventos del calendario (`intent: consultar`).
- [ ] Cancelación automática de eventos (`intent: cancelar`).
- [ ] Persistencia de conversación con Supabase para confirmaciones en dos pasos.
- [ ] Background Functions para tiempos de procesamiento mayores a 26 s.
- [ ] Soporte de adjuntos de archivo de audio mayores usando la File API de Gemini.
- [ ] Tests unitarios con Vitest o Jest.
