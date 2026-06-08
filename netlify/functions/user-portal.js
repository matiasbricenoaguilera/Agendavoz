/**
 * Netlify Function: user-portal
 *
 * API para el dashboard personal de cada usuario.
 * Autenticación: magic link token en header x-user-token o query ?token=
 *
 * Acciones:
 *   GET  ?action=validate&token=  — Valida el token y retorna perfil del usuario
 *   GET  ?action=history          — Historial de eventos del usuario
 *   POST ?action=preferences      — Actualiza preferencias del usuario
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../src/utils/logger.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-user-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function getClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function ok(data)          { return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(data) }; }
function unauthorized()    { return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Token inválido o expirado' }) }; }
function badRequest(msg)   { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) }; }
function serverError(msg)  { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) }; }

async function resolveUser(sb, token) {
  if (!token) return null;
  const { data: link } = await sb
    .from('magic_links')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!link) return null;
  const { data: user } = await sb
    .from('users')
    .select('*')
    .eq('telegram_id', link.telegram_id)
    .maybeSingle();
  return user ?? null;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const sb     = getClient();
  const params = event.queryStringParameters ?? {};
  const action = params.action;
  const token  = params.token ?? event.headers['x-user-token'] ?? '';

  try {
    // ── validate: único endpoint que devuelve el perfil y NO consume el token ─
    if (action === 'validate') {
      if (!token) return unauthorized();

      const { data: link } = await sb
        .from('magic_links')
        .select('telegram_id, expires_at, used')
        .eq('token', token)
        .maybeSingle();

      if (!link || link.used || new Date(link.expires_at) < new Date()) return unauthorized();

      const { data: user } = await sb
        .from('users')
        .select('telegram_id, name, calendar_id, status, reminder_minutes, morning_summary, morning_hour, evening_preview, weekly_summary, created_at')
        .eq('telegram_id', link.telegram_id)
        .maybeSingle();

      if (!user || user.status !== 'active') return unauthorized();
      return ok({ user, token });
    }

    // Para el resto de acciones, autenticamos con el token
    const user = await resolveUser(sb, token);
    if (!user) return unauthorized();

    // ── history ───────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'history') {
      const { data } = await sb
        .from('event_log')
        .select('*')
        .eq('telegram_id', user.telegram_id)
        .order('created_at', { ascending: false })
        .limit(50);
      return ok(data ?? []);
    }

    // ── preferences ───────────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'preferences') {
      const body    = JSON.parse(event.body ?? '{}');
      const allowed = ['reminder_minutes', 'morning_summary', 'morning_hour', 'evening_preview', 'weekly_summary'];
      const updates = {};
      for (const k of allowed) {
        if (body[k] !== undefined) updates[k] = body[k];
      }
      updates.updated_at = new Date().toISOString();

      await sb.from('users').update(updates).eq('telegram_id', user.telegram_id);
      return ok({ success: true });
    }

    return badRequest('Acción no reconocida');

  } catch (err) {
    logger.error('Error en user-portal', err);
    return serverError(err.message);
  }
};
