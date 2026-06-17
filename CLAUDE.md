# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Agenda por Voz" — a Telegram bot that lets a user manage their Google Calendar via voice notes. Audio is transcribed with OpenAI Whisper, intent/details are extracted with GPT-4o-mini, and the bot creates/queries/cancels/moves/annotates events in Google Calendar (via a service account). Conversation state and user data are persisted in Supabase. Runs as Netlify Functions (serverless, ESM).

## Commands

- `npm run dev` — start Netlify Dev locally (serves functions on port 8888, proxies to port 3000)
- `npm run deploy` — deploy to production (`netlify deploy --prod`)
- `npm run deploy:preview` — deploy a preview
- `npm run test:local` — run `tests/test-local.js` against the local dev server (requires `npm run dev` running in another terminal)
- `npm run test:mock-voice` — same, but simulates a voice message using `tests/mock-payload.json`
- `npm run logs` — tail production logs for `telegram-bot` (`netlify functions:log telegram-bot`)

Other test-local.js modes (run directly, not via npm scripts):
- `node --env-file=.env tests/test-local.js --phrase "Agendar dentista el martes a las 3 de la tarde"` — test the NLU extraction (`extractEventDetails`) directly, no Telegram/HTTP involved
- `node --env-file=.env tests/test-local.js --audio tests/sample.ogg` — test with a real audio file
- Equivalent manual curl: `curl -X POST http://localhost:8888/.netlify/functions/telegram-bot -H "Content-Type: application/json" -d @tests/mock-text-payload.json`

There is no lint/build step — functions are deployed as-is (esbuild bundler via Netlify).

## Architecture

### Entry points (`netlify/functions/`)

- **`telegram-bot.js`** — the main webhook handler. Everything funnels through this.
- **`admin-api.js`** — REST API for the admin panel (`public/admin/`), protected by `x-admin-password` header (`ADMIN_PASSWORD` env var). Actions: stats, list/toggle/delete users, update prefs, history.
- **`user-portal.js`** — REST API for the per-user dashboard (`public/mi-agenda/`), authenticated via single-use "magic link" tokens (`x-user-token` header or `?token=`).
- **`daily-summary.js`**, **`evening-preview.js`**, **`weekly-summary.js`**, **`event-reminders.js`** — scheduled functions (cron defined in `netlify.toml`) that push proactive Telegram messages (morning summary, next-day preview, weekly summary, 30-min-before reminders). `event-reminders` dedupes via the `reminders` table and self-cleans entries >30 days old.

### Shared services (`src/services/`)

- **`telegram.js`** — `sendMessage`, `sendTypingAction`, `downloadFile` (for voice notes).
- **`gemini.js`** — despite the name, now uses OpenAI: `transcribeAudio` (Whisper STT), `extractEventDetails` (GPT-4o-mini NLU — returns structured intent + date/time + summary/notes), `detectSimpleIntent` (lightweight yes/no/slot-choice/force/overwrite classifier for confirmation replies). The NLU prompt is built dynamically with the current Chile date/weekday context (`buildDateContext`).
- **`calendar.js`** — Google Calendar API wrapper via service account (`GOOGLE_SERVICE_ACCOUNT_JSON`): `checkAvailability`, `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent`, `listEvents`, `getBusyEvent`, `findNextFreeSlots`.
- **`supabase.js`** — all DB access (Supabase service-role client). Users table (onboarding/active/disabled status, per-user prefs), `conversations` table (pending conversational state, TTL 30 min), `event_log` (history), `reminders` (dedup), `magic_links` (one-time dashboard tokens).
- **`dateUtils.js`** — all date formatting/parsing is hardcoded to `America/Santiago` (Chile, UTC-4). Functions for converting between ISO strings, Chile-local date/time strings, and human-readable Spanish formats.
- **`logger.js`** — structured logger.

### Access control model

A user's access is determined **solely by their row in Supabase `users`** (status: `onboarding` | `active` | `disabled`, or no row at all = needs onboarding). The legacy `USER_CALENDARS` env var (`chatId:calendarId,...`) is now only used to:
1. Pre-fill `calendar_id` during onboarding for pre-existing users (skips the "share your calendar" step — "fast onboarding", only asks for name).
2. Auto-register a `USER_CALENDARS` entry as an active Supabase user when they hit `/mipanel`.

Deleting a user from the admin panel wipes their Supabase row entirely (profile, conversations, event_log, magic_links, reminders) — they go through onboarding again on next contact, even if still listed in `USER_CALENDARS`.

### Conversational state machine

`telegram-bot.js` is built around a state machine persisted in Supabase's `conversations` table (`getConversation`/`saveConversation`/`clearConversation`, 30-min TTL). When a user has a pending state, the next message is routed to `handlePendingState` instead of fresh intent detection. States:

- `ONBOARDING_NAME`, `ONBOARDING_WAITING_SHARE`, `ONBOARDING_EMAIL` — full 3-step onboarding (name → share calendar with service account → verify calendar email)
- `ONBOARDING_NAME_FAST` — for `USER_CALENDARS` users (calendar already shared), just asks name
- `AWAITING_DATE` / `AWAITING_TIME` / `AWAITING_DATETIME` — event details partially specified, bot is asking for the missing piece(s)
- `AWAITING_CONFIRMATION` — full event parsed, waiting for yes/no before creating
- `AWAITING_SLOT_CHOICE` — requested slot is busy; bot offered 2 alternative free slots + "overwrite" + "force" (double-book) options
- `AWAITING_CANCEL_CONFIRM`, `AWAITING_MOVE_CONFIRM`, `AWAITING_NOTE_CONFIRM`, `AWAITING_EDIT_CONFIRM` — confirmation before deleting/moving/annotating/editing an event

Voice-note intents (when no pending state): `agendar` (create), `consultar` (query day), `cancelar` (delete), `mover` (reschedule, preserves original duration if no new end given), `anotar` (append a note to an event's description), `editar` (replace an event's title and/or description via `new_summary`/`new_notes`, processed by `processEditarIntent`).

Every calendar mutation is logged to `event_log` via `logEvent` with an `action` of `created`/`cancelled`/`overwritten`/`moved`/`noted`/`edited`.

If a conversation is left in any `AWAITING_*_CONFIRM`/`AWAITING_CONFIRMATION`/`AWAITING_SLOT_CHOICE` state, `event-reminders.js` sends a one-time "¿Sigues ahí?" nudge (`sendPendingConfirmationNudges`/`getStaleConfirmations`/`markConversationNudged`, tracked via the `conversations.nudged` column) before the 30-min TTL expires the state.

### Deshacer ("↩️ Deshacer")

After a successful `agendar`/`mover`/`anotar`/`editar`/`cancelar` action (including overwrite/force-schedule), the bot attaches a one-time "↩️ Deshacer" button (`undo:<id>`) to the result message. `saveUndoAction`/`consumeUndoAction` (in `supabase.js`) store/retrieve the data needed to reverse it in the `undo_actions` table, keyed by `action_type` (`delete_event`, `restore_overwrite`, `restore_cancelled`, `restore_move`, `restore_note`, `restore_edit`). The button is valid for 5 minutes (`UNDO_TTL_MS`) and single-use; `handleUndoAction` in `telegram-bot.js` performs the reversal and logs the inverse `event_log` action.

### Event categorization

`extractEventDetails` (for `agendar` and `editar` intents) also returns a `category` (`trabajo`/`salud`/`personal`/`social`/`estudio`/`otro`), inferred from the event's nature. `createCalendarEvent` maps it to a Google Calendar `colorId` via `CATEGORY_COLOR_IDS` (and `CATEGORY_EMOJIS` for display) in `calendar.js`, and it's stored on `event_log.category`. `weekly-summary.js` reverses the mapping with `categoryFromColorId` to produce a per-category time breakdown in the weekly summary message.

### Environment variables

See `.env.example` for the full list with descriptions. Required (checked at runtime via `assertConfig`): `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Also used: `TELEGRAM_WEBHOOK_SECRET` (validates Telegram webhook origin), `OWNER_CHAT_ID`, `USER_CALENDARS` (legacy, see above), `ADMIN_PASSWORD`, `SITE_URL` (for magic link URLs, set in Netlify env vars).

### Database schema

`supabase/schema.sql` is the base schema; `migration_v2.sql` through `migration_v9.sql` are incremental migrations — apply in order for existing projects. Notably: v2 adds `reminders`/`event_log` action types (`moved`/`noted`) and the `users` table; v4 adds `users.last_event` (memory for "ese evento"/"muévelo" references); v5 adds the `edited` action and `conversations.nudged` (pending-confirmation nudges); v6 adds `event_log.category`; v7 adds the `api_usage` table (per-call OpenAI cost tracking — tokens for GPT-4o-mini, audio seconds for Whisper — surfaced in the admin panel's "Consumo IA" tab); v8 adds the `undo_actions` table for the "↩️ Deshacer" button (see "Deshacer" below); v9 adds the `title_corrections` table (pairs original→corrected title stored when the user taps "✏️ Editar título" after scheduling — fed back as Whisper vocabulary hints in future transcriptions).

### Timezone handling

The whole system assumes `America/Santiago` (Chile). The UTC offset (`-03:00` in summer DST, `-04:00` in winter) is computed dynamically per-date via `Intl.DateTimeFormat` in `dateUtils.js` (`getChileOffsetString`), and used by `toChileISO`, `buildChileISO`, `normalizeToChileISO`, `addMsToChileISO`, and `dayBoundsChileISO`. The NLU prompt (`gemini.js`) gets the current offset from `getChileOffsetString`/`buildDateContext`, and any date the model returns is re-normalized with `normalizeToChileISO` to correct for stale/wrong offsets in its output.

## Regla de trabajo
Antes de cualquier tarea no trivial, presenta un plan con:
- archivos a modificar
- cambios por archivo  
- riesgos identificados
Espera aprobación antes de ejecutar.