import type { Env } from "./env";
import { SHARE_COOKIE } from "./env";
import { sha256Hex, getCookieValue } from "./auth";

const SHARE_TTL_MS = 24 * 60 * 60 * 1000; // one-time link validity window after consume

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createShare(env: Env, videoID: string): Promise<{ id: string; url: string }> {
  const id = randomToken();
  const tokenHash = await sha256Hex(id);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO video_shares (id, token_hash, video_id, created_at) VALUES (?, ?, ?, ?)"
  ).bind(id, tokenHash, videoID, now).run();
  return { id, url: `/share?token=${id}` };
}

/** Consume a one-time share: atomically claim it and issue an HttpOnly share session.
 *  Returns the raw session token so the caller can set the share cookie. */
export async function consumeShare(env: Env, token: string): Promise<{ ok: boolean; shareID: string; sessionToken: string; error?: 404 | 410 }> {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT * FROM video_shares WHERE token_hash = ?").bind(tokenHash).first<{
    id: string; video_id: string; consumed_at: number; session_hash: string; session_expires_at: number;
  }>();
  if (!row) return { ok: false, shareID: "", sessionToken: "", error: 404 };
  if (row.consumed_at > 0) return { ok: false, shareID: "", sessionToken: "", error: 410 }; // already used

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  const expires = Date.now() + SHARE_TTL_MS;
  await env.DB.prepare(
    "UPDATE video_shares SET consumed_at = ?, session_hash = ?, session_expires_at = ? WHERE id = ?"
  ).bind(Date.now(), sessionHash, expires, row.id).run();

  return { ok: true, shareID: row.id, sessionToken };
}

export function shareCookie(sessionToken: string): string {
  const expires = new Date(Date.now() + SHARE_TTL_MS).toUTCString();
  return `${SHARE_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`;
}

/** Validate the share session cookie for a given share id. */
export async function validateShareSession(env: Env, shareID: string, cookieHeader: string | undefined): Promise<boolean> {
  const token = getCookieValue(cookieHeader, SHARE_COOKIE);
  if (!token) return false;
  const sessionHash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT session_hash, session_expires_at FROM video_shares WHERE id = ?").bind(shareID).first<{ session_hash: string; session_expires_at: number }>();
  if (!row) return false;
  if (!row.session_hash || row.session_hash !== sessionHash) return false;
  if (Date.now() >= row.session_expires_at) return false;
  return true;
}
