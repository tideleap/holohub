import type { Env } from "./env";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./env";
import { verifyPassword, hashPassword } from "./db";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SessionInfo {
  token: string;
  userId: number;
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(token, userId, now, expires).run();
  return token;
}

export async function getSession(env: Env, token: string): Promise<{ userId: number; expiresAt: number } | null> {
  const r = await env.DB.prepare("SELECT user_id, expires_at FROM admin_sessions WHERE token = ?").bind(token).first<{ user_id: number; expires_at: number }>();
  if (!r) return null;
  return { userId: r.user_id, expiresAt: r.expires_at };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
}

export async function renewSession(env: Env, token: string): Promise<void> {
  const expires = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare("UPDATE admin_sessions SET expires_at = ? WHERE token = ?").bind(expires, token).run();
}

export async function login(env: Env, username: string, password: string): Promise<{ ok: boolean; role?: string; userId?: number }> {
  const u = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").bind(username).first<{ id: number; password: string; role: string; banned: number }>();
  if (u) {
    if (u.banned) return { ok: false };
    if (await verifyPassword(password, u.password)) {
      return { ok: true, role: u.role, userId: u.id };
    }
    return { ok: false };
  }
  // fallback to config (env) credentials, only when no users exist yet AND a
  // secret was provided. We intentionally never accept a built-in default.
  const count = (await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>())?.c ?? 0;
  const cfgUser = env.ADMIN_USERNAME || "admin";
  const cfgPass = env.ADMIN_PASSWORD;
  if (cfgPass && count === 0 && username === cfgUser && password === cfgPass) {
    const hash = await hashPassword(cfgPass);
    const now = Date.now();
    const res = await env.DB.prepare("INSERT INTO users (username, password, role, banned, created_at) VALUES (?, ?, 'admin', 0, ?)").bind(cfgUser, hash, now).run();
    const userId = Number((res.meta as any)?.last_row_id ?? 0);
    return { ok: true, role: "admin", userId };
  }
  return { ok: false };
}

export function sessionCookieOptions(expiresAt: number) {
  return {
    name: SESSION_COOKIE,
    value: "",
    path: "/",
    httpOnly: true as const,
    sameSite: "Lax" as const,
    expires: new Date(expiresAt),
  };
}

export function setSessionCookie(c: { header: (name: string, value: string, opts?: any) => void }, token: string, expiresAt: number) {
  c.header("Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`);
}

export function clearSessionCookie(c: { header: (name: string, value: string) => void }) {
  c.header("Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(0).toUTCString()}`);
}

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Validate the admin session cookie; returns userId (>0) or 0 if invalid. Renews when near expiry. */
export async function requireSession(env: Env, c: { req: { header: (k: string) => string | undefined }; header: (n: string, v: string) => void }): Promise<number> {
  const token = getCookieValue(c.req.header("Cookie"), SESSION_COOKIE);
  if (!token) return 0;
  const s = await getSession(env, token);
  if (!s) return 0;
  if (Date.now() >= s.expiresAt) {
    await deleteSession(env, token);
    return 0;
  }
  if (s.expiresAt - Date.now() < SESSION_TTL_MS / 2) {
    await renewSession(env, token);
    setSessionCookie(c, token, Date.now() + SESSION_TTL_MS);
  }
  return s.userId;
}

export async function getUserRole(env: Env, userId: number): Promise<string | null> {
  const u = await env.DB.prepare("SELECT role, banned FROM users WHERE id = ?").bind(userId).first<{ role: string; banned: number }>();
  if (!u || u.banned) return null;
  return u.role;
}
