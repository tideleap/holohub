import { Hono } from "hono";
import type { Env } from "./env";
import { ensureSeeded } from "./db";
import { publicApi } from "./routes/public";
import { authApi } from "./routes/auth";
import { adminApi } from "./routes/admin";
import { requireSession, getUserRole } from "./auth";

const app = new Hono<{ Bindings: Env }>();

// health
app.get("/healthz", (c) => c.text("ok"));

// mount API groups
// publicApi 同时挂在 /api 与 /p：前者承载 JSON API（home/list/video/...），
// 后者承载媒体直链（/p/stream、/p/upload、/p/thumb、/p/preview、/p/share/*），
// 因为前端直接以 /p/* 路径请求媒体资源。
app.route("/api", publicApi); // /api/home, /api/list, /api/video/:id, /api/tags, /api/shorts/next, /api/share/*, /api/upload, /api/settings/theme
app.route("/p", publicApi);   // /p/stream/:driveID/*, /p/upload/:videoID, /p/thumb/:videoID, /p/preview/:videoID, /p/share/:shareID/{stream,preview,thumb}
app.route("/admin/api", authApi); // /login, /setup, /logout, /me, /upload
app.route("/admin/api", adminApi); // everything else (admin-guarded)

// SPA fallback: serve the built React frontend for all non-API GET requests.
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/admin/api") || url.pathname.startsWith("/p/")) {
    return c.json({ error: "not found" }, 404);
  }
  // Delegate to Workers Assets (built frontend/dist). SPA fallback handled by
  // not_found_handling = "single-page-application" in wrangler.toml.
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

// Ensure an admin user exists (env fallback) on first request.
let seeded = false;
app.use("*", async (c, next) => {
  if (!seeded) {
    await ensureSeeded(c.env);
    seeded = true;
  }
  await next();
});

export default app;
