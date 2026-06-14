/**
 * Netlify Function: admin-api
 *
 * API REST protegida por contraseña para el panel de administración.
 * Header requerido: x-admin-password
 *
 * Acciones:
 *   GET  ?action=stats          — Resumen general
 *   GET  ?action=users          — Lista todos los usuarios
 *   POST ?action=toggle-user    — Activa/desactiva un usuario { telegramId, status }
 *   POST ?action=update-prefs   — Actualiza preferencias { telegramId, ...prefs }
 *   GET  ?action=history        — Historial de eventos (con filtros opcionales)
 *   GET  ?action=usage          — Consumo de APIs de IA (costos estimados)
 */

import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';
import { logger } from '../../src/utils/logger.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function getClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function unauthorized() {
  return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No autorizado' }) };
}

function ok(data) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(data) };
}

function error(msg, code = 500) {
  return { statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  // Autenticación
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || event.headers['x-admin-password'] !== adminPassword) {
    return unauthorized();
  }

  const action = event.queryStringParameters?.action;
  const sb     = getClient();

  try {
    // ── GET stats ────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'stats') {
      const [usersRes, historyRes, todayRes] = await Promise.all([
        sb.from('users').select('status', { count: 'exact' }),
        sb.from('event_log').select('id', { count: 'exact' }),
        sb.from('event_log')
          .select('id', { count: 'exact' })
          .gte('created_at', new Date().toISOString().slice(0, 10)),
      ]);

      const byStatus = {};
      for (const u of usersRes.data ?? []) {
        byStatus[u.status] = (byStatus[u.status] ?? 0) + 1;
      }

      return ok({
        totalUsers:    usersRes.count ?? 0,
        activeUsers:   byStatus.active ?? 0,
        onboarding:    byStatus.onboarding ?? 0,
        disabled:      byStatus.disabled ?? 0,
        totalEvents:   historyRes.count ?? 0,
        todayEvents:   todayRes.count ?? 0,
      });
    }

    // ── GET users ─────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'users') {
      const { data, error: err } = await sb
        .from('users')
        .select('*')
        .order('created_at', { ascending: false });

      if (err) return error(err.message);
      return ok(data ?? []);
    }

    // ── POST toggle-user ──────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'toggle-user') {
      const { telegramId, status } = JSON.parse(event.body ?? '{}');
      if (!telegramId || !['active', 'disabled', 'onboarding'].includes(status)) {
        return error('Datos inválidos', 400);
      }
      await sb.from('users')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('telegram_id', String(telegramId));
      return ok({ success: true });
    }

    // ── POST update-prefs ─────────────────────────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'update-prefs') {
      const { telegramId, ...prefs } = JSON.parse(event.body ?? '{}');
      if (!telegramId) return error('telegramId requerido', 400);

      const allowed = ['name', 'calendar_id', 'reminder_minutes', 'morning_summary',
                       'morning_hour', 'evening_preview', 'weekly_summary'];
      const updates = {};
      for (const k of allowed) {
        if (prefs[k] !== undefined) updates[k] = prefs[k];
      }
      updates.updated_at = new Date().toISOString();

      await sb.from('users').update(updates).eq('telegram_id', String(telegramId));
      return ok({ success: true });
    }

    // ── POST delete-user ──────────────────────────────────────────────────────
    // Elimina TODOS los registros del usuario para que vuelva al onboarding.
    if (event.httpMethod === 'POST' && action === 'delete-user') {
      const { telegramId } = JSON.parse(event.body ?? '{}');
      if (!telegramId) return error('telegramId requerido', 400);

      const id = String(telegramId);
      await Promise.all([
        sb.from('users').delete().eq('telegram_id', id),
        sb.from('conversations').delete().eq('telegram_id', id),
        sb.from('magic_links').delete().eq('telegram_id', id),
        sb.from('reminders').delete().eq('telegram_id', id),
        sb.from('event_log').delete().eq('telegram_id', id),
      ]);

      logger.info('Usuario eliminado completamente', { telegramId: id });
      return ok({ success: true });
    }

    // ── GET history ───────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'history') {
      const params = event.queryStringParameters ?? {};
      let query = sb
        .from('event_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Number(params.limit ?? 100));

      if (params.telegramId) query = query.eq('telegram_id', params.telegramId);
      if (params.action)     query = query.eq('action', params.action);

      const { data, error: err } = await query;
      if (err) return error(err.message);
      return ok(data ?? []);
    }

    // ── GET usage ─────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'usage') {
      const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const todayStr = new Date().toISOString().slice(0, 10);
      const monthStr = todayStr.slice(0, 7);

      const { data, error: err } = await sb
        .from('api_usage')
        .select('telegram_id, kind, tokens_in, tokens_out, audio_seconds, cost_usd, created_at')
        .gte('created_at', since30)
        .order('created_at', { ascending: false });

      if (err) return error(err.message);
      const rows = data ?? [];

      let costToday = 0, costMonth = 0, totalTokens = 0, totalAudioSeconds = 0;
      const byUser = {};
      const byDay  = {};

      for (const row of rows) {
        const day = row.created_at.slice(0, 10);
        const cost = Number(row.cost_usd ?? 0);

        if (day === todayStr) costToday += cost;
        if (day.slice(0, 7) === monthStr) costMonth += cost;
        totalTokens       += (row.tokens_in ?? 0) + (row.tokens_out ?? 0);
        totalAudioSeconds += Number(row.audio_seconds ?? 0);

        const userKey = row.telegram_id ?? 'desconocido';
        byUser[userKey] = (byUser[userKey] ?? 0) + cost;
        byDay[day]      = (byDay[day] ?? 0) + cost;
      }

      const topUsers = Object.entries(byUser)
        .map(([telegramId, costUsd]) => ({ telegramId, costUsd }))
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, 20);

      const dailyCosts = Object.entries(byDay)
        .map(([day, costUsd]) => ({ day, costUsd }))
        .sort((a, b) => a.day.localeCompare(b.day));

      return ok({
        costToday,
        costMonth,
        totalTokens,
        totalAudioMinutes: totalAudioSeconds / 60,
        topUsers,
        dailyCosts,
      });
    }

    return error('Acción no reconocida', 400);

  } catch (err) {
    logger.error('Error en admin-api', err);
    return error(err.message);
  }
};
