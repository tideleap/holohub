import { Hono } from "hono";
import type { Env } from "../env";
import { login, createSession, deleteSession, requireSession, getUserRole, setSessionCookie, clearSessionCookie, getCookieValue } from "../auth";
import { getSetting, setSetting, ensureSeeded, hashPassword } from "../db";

// Auth endpoints are mounted at /admin/api and are PUBLIC (no admin guard),
// because logging in / first-time setup must be reachable before any session.
export const authApi = new Hono<{ Bindings: Env }>();

authApi.post("/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>().catch(() => ({ username: "", password: "" }));
  const res = await login(c.env, body.username || "", body.password || "");
  if (!res.ok) return c.json({ ok: false }, 401);
  const token = await createSession(c.env, res.userId || 0);
  setSessionCookie(c, token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return c.json({ ok: true, role: res.role });
});

authApi.get("/setup", async (c) => {
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>())?.c ?? 0;
  const hasAdmin = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").first<{ c: number }>())?.c ?? 0;
  return c.json({ required: count === 0 || hasAdmin === 0 });
});

authApi.post("/setup", async (c) => {
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>())?.c ?? 0;
  if (count > 0) return c.json({ ok: false, error: "already configured" }, 400);
  const body = await c.req.json<{ username: string; password: string }>().catch(() => ({ username: "", password: "" }));
  if (!body.username || !body.password) return c.json({ ok: false, error: "username and password required" }, 400);
  const hash = await hashPassword(body.password);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO users (username, password, role, banned, created_at) VALUES (?, ?, 'admin', 0, ?)")
    .bind(body.username, hash, now).run();
  return c.json({ ok: true });
});

authApi.post("/logout", async (c) => {
  const token = getCookieValue(c.req.header("Cookie"), "vs_admin");
  if (token) await deleteSession(c.env, token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authApi.get("/me", async (c) => {
  const userId = await requireSession(c.env, c);
  if (!userId) return c.json({ authenticated: false }, 200);
  const role = await getUserRole(c.env, userId);
  if (!role) return c.json({ authenticated: false }, 200);
  return c.json({ authenticated: true, role });
});

// First-request seeding of the default admin (env fallback) is done globally in index.ts.
void getSetting; void setSetting; void ensureSeeded;
