/**
 * POST /api/telegram/pair-callback
 *
 * Telegram Bot API webhook target for the `/start <token>` pairing flow.
 * Stage 3 of the Convex/Clerk -> Supabase migration: replaces Convex's
 * `/api/telegram-pair-callback` HTTP action, which is no longer viable once
 * `telegramPairingTokens` moves off Convex — this endpoint claims the token
 * directly against `worldmonitor.telegram_pairing_tokens` (Postgres) via
 * `server/_shared/telegram-pairing.ts`.
 *
 * Manual step after deploy: re-point Telegram's webhook —
 *   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<domain>/api/telegram/pair-callback&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 *
 * Always returns 200 — a non-200 triggers a Telegram retry storm. Fails
 * closed: requests without the secret header set at webhook-registration
 * time are dropped (still 200'd) rather than processed.
 */

export const config = { runtime: 'edge' };

import { claimPairingToken } from '../../server/_shared/telegram-pairing';

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', keyMaterial, enc.encode(a)),
    crypto.subtle.sign('HMAC', keyMaterial, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i]! ^ bArr[i]!;
  return diff === 0;
}

interface TelegramUpdate {
  message?: {
    chat?: { type?: string; id?: number };
    text?: string;
    date?: number;
  };
}

const OK = new Response('OK', { status: 200 });

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!secret) {
    console.error('[telegram-pair-callback] TELEGRAM_WEBHOOK_SECRET not configured — rejecting all requests');
    return OK;
  }
  const provided = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!provided) {
    // Helps ops spot webhook re-registration drift (Telegram dropped the
    // header) without re-enabling the bypass.
    console.warn('[telegram-pair-callback] secret header absent — rejecting request');
    return OK;
  }
  if (!(await timingSafeEqualStrings(provided, secret))) return OK;

  let update: TelegramUpdate | null;
  try {
    const body = (await req.json()) as unknown;
    update = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as TelegramUpdate : null;
  } catch {
    update = null;
  }
  if (!update) return OK;

  const msg = update.message;
  if (!msg) return OK;
  if (msg.chat?.type !== 'private') return OK;
  if (!msg.date || Math.abs(Date.now() / 1000 - msg.date) > 900) return OK;

  const text = msg.text?.trim() ?? '';
  const chatId = String(msg.chat.id);

  const match = text.match(/^\/start\s+([A-Za-z0-9_-]{40,50})$/);
  if (!match) return OK;

  let claimed: { ok: boolean };
  try {
    claimed = await claimPairingToken(match[1]!, chatId);
  } catch (err) {
    console.error('[telegram-pair-callback] claimPairingToken failed:', (err as Error).message);
    return OK;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (claimed.ok && botToken) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-edge/1.0' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ WorldMonitor connected! You\'ll receive breaking news alerts here.',
      }),
      signal: AbortSignal.timeout(8000),
    }).catch((err: unknown) => {
      console.error('[telegram-pair-callback] sendMessage failed:', err);
    });
  }

  return OK;
}
