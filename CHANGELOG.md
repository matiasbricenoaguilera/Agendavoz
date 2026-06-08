# Changelog — Agenda por Voz

Todos los cambios notables de este proyecto están documentados aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).

---

## [2.0.0] — 2026-06-08

### Añadido (Supabase + Conversación fluida)

- **Supabase** integrado como backend de estado persistente.
  - `supabase/schema.sql` — Esquema con tablas `conversations` y `event_log`.
  - `src/services/supabase.js` — Operaciones de DB: `getConversation`, `saveConversation`, `clearConversation`, `logEvent`.
  - Las conversaciones expiran automáticamente tras 30 minutos de inactividad.

- **Máquina de estados conversacional** en `telegram-bot.js`:
  - `AWAITING_DATE` — El bot guarda el resumen y la hora; pide el día.
  - `AWAITING_TIME` — El bot guarda el resumen y el día; pide la hora.
  - `AWAITING_DATETIME` — Faltan ambos; el bot guarda el resumen y pregunta.
  - `AWAITING_CONFIRMATION` — Evento completo; el bot pide "sí" o "no" antes de agendar.
  - `AWAITING_SLOT_CHOICE` — Horario ocupado; el bot ofrece 2 alternativas + opción de sobreescribir.
  - `AWAITING_CANCEL_CONFIRM` — Evento encontrado para cancelar; el bot pide confirmación.

- **Confirmación antes de agendar** (`askForConfirmation`): Muestra resumen, fecha y hora del evento y espera la aprobación del usuario antes de crear nada.

- **Consultar eventos del día** (`processConsultarIntent`): Listar la agenda de un día concreto mediante nota de voz ("¿Qué tengo mañana?").

- **Cancelar eventos por voz** (`processCancelarIntent`): Busca el evento por descripción y fecha, muestra detalles y pide confirmación antes de eliminar.

- **Sobreescribir eventos** (`overwriteEvent`): Cuando un horario está ocupado, el usuario puede elegir reemplazar el evento existente.

- **Historial de eventos** (`event_log` en Supabase): Registra cada `created`, `cancelled` y `overwritten` con transcripción original para auditoría.

- **`netlify/functions/daily-summary.js`** — Función programada (cron):
  - Envía automáticamente el resumen del día a todos los usuarios registrados.
  - Se ejecuta de lunes a viernes a las 08:00 hora Chile (12:00 UTC).
  - Configurada en `netlify.toml` con `schedule = "0 12 * * 1-5"`.

- **Nuevas funciones en `src/services/calendar.js`**:
  - `listEvents(startTime, endTime, calendarId, query)` — Lista eventos con filtro opcional.
  - `getBusyEvent(startTime, endTime, calendarId)` — Retorna el evento que bloquea un horario.
  - `deleteCalendarEvent(eventId, calendarId)` — Elimina un evento.

- **`detectSimpleIntent(text)`** en `gemini.js` — Detecta respuestas simples del usuario (sí/no/1/2/reemplazar) sin consumir tokens de GPT.

- **Nuevas utilidades en `dateUtils.js`**:
  - `formatDateLong` — Formato "lunes 8 de junio".
  - `extractDateFromISO` / `extractTimeFromISO` — Parsing de partes de un ISO string.
  - `buildChileISO` — Construye ISO string Chile desde fecha y hora separados.
  - `addMsToChileISO` — Suma milisegundos a un ISO string manteniendo offset Chile.

- **Comando `/hoy`** — Muestra la agenda del día directamente desde texto.

### Cambiado

- `telegram-bot.js` completamente refactorizado para usar la máquina de estados de Supabase en lugar del procesamiento lineal anterior.
- `REQUIRED_VARS` extendido con `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
- Los errores de Supabase se registran en logs pero no interrumpen el flujo principal.

### Dependencias

- `@supabase/supabase-js` ^2.49.4 añadida a `dependencies`.

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
