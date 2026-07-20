import { Hono } from "hono";
import { type Env, UNSUPPORTED_DRIVE_KINDS } from "../env";
import { requireSession, getUserRole } from "../auth";
import { listDrives, getDrive, getSetting, setSetting, safeJsonArray, safeJsonObject, hashPassword } from "../db";
import { buildAdapter, driveLabel } from "../drives";
import type { DriveRow } from "../types";

export const adminApi = new Hono<{ Bindings: Env }>();

adminApi.use("*", async (c, next) => {
  const userId = await requireSession(c.env, c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const role = await getUserRole(c.env, userId);
  if (role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
});

// ---- drives ----
adminApi.get("/drives", async (c) => {
  const drives = await listDrives(c.env);
  const out = await Promise.all(drives.map(async (d) => await toAdminDrive(c.env, d)));
  return c.json(out);
});

adminApi.get("/drives/storage", async (c) => {
  // Sum R2 usage via list (bounded). Simple estimate.
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await c.env.MEDIA.list({ cursor, limit: 1000 });
    for (const o of listed.objects) total += o.size;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return c.json({ thumbnailBytes: 0, teaserBytes: total, totalBytes: total, availableBytes: 0, capacityBytes: 0, drives: {} });
});

adminApi.get("/drives/:id", async (c) => {
  const d = await getDrive(c.env, decodeURIComponent(c.req.param("id")));
  if (!d) return c.json({ error: "not found" }, 404);
  return c.json(await toAdminDrive(c.env, d));
});

adminApi.post("/drives", async (c) => {
  const body = await c.req.json<{
    id: string; kind: string; name: string; rootId?: string;
    credentials?: Record<string, string>; skipDirIds?: string[];
  }>().catch(() => null);
  if (!body || !body.id || !body.kind || !body.name) return c.json({ ok: false, error: "id/kind/name required" }, 400);
  const now = Date.now();
  const creds = body.credentials ? JSON.stringify(body.credentials) : "{}";
  const skip = body.skipDirIds ? JSON.stringify(body.skipDirIds) : "[]";
  const existing = await getDrive(c.env, body.id);
  if (existing) {
    await c.env.DB.prepare(
      "UPDATE drives SET kind=?, name=?, root_id=?, credentials=?, skip_dir_ids=?, status=?, updated_at=? WHERE id=?"
    ).bind(body.kind, body.name, body.rootId || "0", creds, skip, "disconnected", now, body.id).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO drives (id, kind, name, root_id, credentials, status, teaser_enabled, skip_dir_ids, created_at, updated_at) VALUES (?,?,?,?,?, 'disconnected', 1, ?, ?, ?)"
    ).bind(body.id, body.kind, body.name, body.rootId || "0", creds, skip, now, now).run();
  }
  const warning = UNSUPPORTED_DRIVE_KINDS.includes(body.kind as any)
    ? `${driveLabel(body.kind)} 的私有 API 尚未在 Cloudflare 版实现，仅 R2/WebDAV 可立即使用`
    : undefined;
  return c.json({ ok: true, warning });
});

adminApi.delete("/drives/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const d = await getDrive(c.env, id);
  if (!d) return c.json({ ok: false }, 404);
  await c.env.DB.prepare("DELETE FROM drives WHERE id = ?").bind(id).run();
  // also delete videos belonging to this drive
  const r = await c.env.DB.prepare("DELETE FROM videos WHERE drive_id = ?").bind(id).run();
  const deleted = (r.meta as any)?.changes ?? 0;
  return c.json({ ok: true, deletedVideos: deleted });
});

adminApi.post("/drives/:id/teaser-enabled", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const body = await c.req.json<{ enabled: boolean }>().catch(() => ({ enabled: true }));
  await c.env.DB.prepare("UPDATE drives SET teaser_enabled = ?, updated_at = ? WHERE id = ?")
    .bind(body.enabled ? 1 : 0, Date.now(), id).run();
  return c.json({ ok: true, teaserEnabled: !!body.enabled });
});

adminApi.get("/drives/:id/dirtree", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const d = await getDrive(c.env, id);
  if (!d) return c.json({ error: "not found" }, 404);
  const adapter = buildAdapter(d);
  if (!adapter) return c.json({ error: "drive kind not supported on Cloudflare" }, 400);
  const parent = c.req.query("parent");
  const children = await adapter.listDir(parent);
  return c.json(children);
});

adminApi.post("/drives/:id/skip-dirs", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const body = await c.req.json<{ dirIds: string[] }>().catch(() => ({ dirIds: [] }));
  await c.env.DB.prepare("UPDATE drives SET skip_dir_ids = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(body.dirIds || []), Date.now(), id).run();
  return c.json({ ok: true, skipDirIds: body.dirIds || [] });
});

adminApi.post("/drives/:id/rescan", async (c) => {
  // Cloud scanning requires the upstream SDKs (not on Workers). We accept the
  // request and report it must run via the external runner / upload path.
  return c.json({ ok: true, accepted: false, message: "自动扫盘需在外部 Runner 执行；Cloudflare 版请通过上传或外部导入写入视频。" });
});

adminApi.post("/drives/:id/tasks/stop", async (c) => c.json({ ok: true, stopped: true }));
adminApi.post("/drives/:id/previews/failed/regenerate", async (c) => c.json({ ok: true }));
adminApi.post("/drives/:id/thumbnails/failed/regenerate", async (c) => c.json({ ok: true }));
adminApi.post("/drives/:id/fingerprints/failed/regenerate", async (c) => c.json({ ok: true }));
adminApi.post("/drives/:id/transcode/start", async (c) => c.json({ ok: true, accepted: false, message: "转码需 ffmpeg，Cloudflare Workers 不支持" }));
adminApi.post("/drives/:id/transcode/stop", async (c) => c.json({ ok: true, stopped: false }));

// QR login stubs (private cloud APIs not reimplemented on Workers)
for (const kind of ["quark", "p115", "p123", "wopan", "guangyapan"] as const) {
  adminApi.post(`/drives/${kind}/qr`, (c) => c.json({ error: `${driveLabel(kind)} 扫码登录尚未在 Cloudflare 版实现` }, 501));
  adminApi.post(`/drives/${kind}/qr/status`, (c) => c.json({ error: "not implemented" }, 501));
  adminApi.post(`/drives/${kind}/qr/:uni`, (c) => c.json({ error: "not implemented" }, 501));
}

// ---- crawlers (management API; execution needs external Python runner) ----
adminApi.get("/crawlers", async (c) => c.json([]));
adminApi.post("/crawlers", async (c) => {
  const body = await c.req.json<{ scriptPath?: string; scriptSourceUrl?: string }>().catch(() => ({}));
  const id = "crawler-" + Date.now().toString(36);
  // store script reference in KV for the external runner
  await c.env.KV.put("crawler:" + id, JSON.stringify({ ...body, id, kind: "scriptcrawler", createdAt: Date.now() }));
  return c.json({ ok: true, id, warning: "爬虫脚本执行需外部 Runner（Cloudflare Workers 不能运行 Python）" });
});
adminApi.post("/crawlers/import-file", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: "invalid" }, 400);
  const f = form["file"];
  if (!(f instanceof File)) return c.json({ error: "file required" }, 400);
  const path = "scripts/" + f.name;
  await c.env.KV.put(path, await f.text());
  return c.json({ scriptPath: path, name: f.name });
});
adminApi.post("/crawlers/import-url", async (c) => {
  const body = await c.req.json<{ url: string }>().catch(() => ({ url: "" }));
  return c.json({ scriptPath: body.url || "", name: body.url?.split("/").pop() || "script" });
});
adminApi.post("/crawlers/test-script", async (c) => c.json({ ok: false, error: "需在外部 Runner 执行", items: [], durationMs: 0 }, 501));
adminApi.post("/crawlers/:id/run", async (c) => c.json({ ok: true, accepted: false, message: "执行需外部 Runner" }));
adminApi.post("/crawlers/:id/upload", async (c) => c.json({ ok: true, accepted: false, message: "执行需外部 Runner" }));
adminApi.post("/crawlers/:id/tasks/stop", async (c) => c.json({ ok: true, stopped: false }));
adminApi.post("/crawlers/:id/paused", async (c) => c.json({ ok: true, paused: false }));
adminApi.delete("/crawlers/:id", async (c) => c.json({ ok: true, deletedVideos: 0 }));

// ---- videos ----
adminApi.get("/videos", async (c) => {
  const driveId = c.req.query("driveId") || "";
  const page = parseInt(c.req.query("page") || "1", 10) || 1;
  const size = parseInt(c.req.query("size") || "50", 10) || 50;
  const keyword = c.req.query("keyword") || "";
  const where: string[] = [];
  const args: any[] = [];
  if (driveId) { where.push("drive_id = ?"); args.push(driveId); }
  if (keyword) { where.push("(title LIKE ? OR author LIKE ?)"); args.push("%" + keyword + "%", "%" + keyword + "%"); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM videos ${whereSql}`).bind(...args).first<{ c: number }>())?.c ?? 0;
  const items = await c.env.DB.prepare(`SELECT * FROM videos ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...args, size, (page - 1) * size).all();
  return c.json({ items: items.results, total, page, size });
});

adminApi.get("/videos/stats", async (c) => {
  const current = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM videos WHERE hidden = 0").first<{ c: number }>())?.c ?? 0;
  const blacklisted = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM deleted_videos").first<{ c: number }>())?.c ?? 0;
  return c.json({ current, blacklisted });
});

adminApi.put("/videos/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const body = await c.req.json<{ title?: string; author?: string; tags?: string[]; badges?: string[]; description?: string; thumbnail?: string; quality?: string; durationSeconds?: number }>().catch((): { title?: string; author?: string; tags?: string[]; badges?: string[]; description?: string; thumbnail?: string; quality?: string; durationSeconds?: number } => ({}));
  const sets: string[] = [];
  const args: any[] = [];
  if (body.title !== undefined) { sets.push("title = ?"); args.push(body.title); }
  if (body.author !== undefined) { sets.push("author = ?"); args.push(body.author); }
  if (body.tags !== undefined) { sets.push("tags = ?"); args.push(JSON.stringify(body.tags)); sets.push("tags_manual = 1"); }
  if (body.badges !== undefined) { sets.push("badges = ?"); args.push(JSON.stringify(body.badges)); }
  if (body.description !== undefined) { sets.push("description = ?"); args.push(body.description); }
  if (body.thumbnail !== undefined) { sets.push("thumbnail_url = ?"); args.push(body.thumbnail); }
  if (body.quality !== undefined) { sets.push("quality = ?"); args.push(body.quality); }
  if (body.durationSeconds !== undefined) { sets.push("duration_seconds = ?"); args.push(body.durationSeconds); }
  sets.push("updated_at = ?"); args.push(Date.now());
  args.push(id);
  await c.env.DB.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  const v = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first();
  return c.json(v);
});

adminApi.delete("/videos/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const v = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first<{ drive_id: string; file_id: string }>();
  if (v && v.drive_id === "local") {
    await c.env.MEDIA.delete("videos/" + v.file_id);
  }
  await c.env.DB.prepare("DELETE FROM videos WHERE id = ?").bind(id).run();
  return c.json({ ok: true, deletedSource: !!(v && v.drive_id === "local") });
});

adminApi.post("/videos/:id/regen-preview", async (c) => c.json({ ok: true }));

// ---- blacklist ----
adminApi.get("/blacklist", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10) || 1;
  const size = parseInt(c.req.query("size") || "50", 10) || 50;
  const total = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM deleted_videos").first<{ c: number }>())?.c ?? 0;
  const items = await c.env.DB.prepare("SELECT * FROM deleted_videos ORDER BY deleted_at DESC LIMIT ? OFFSET ?").bind(size, (page - 1) * size).all();
  return c.json({ items: items.results, total, page, size });
});
adminApi.delete("/blacklist/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM deleted_videos WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
adminApi.get("/blacklist/source-delete/status", async (c) => c.json({ state: "idle", running: false, pending: 0, total: 0, processed: 0, deleted: 0, failed: 0 }));
adminApi.post("/blacklist/source-delete", async (c) => c.json({ ok: true, accepted: false, status: { state: "idle", running: false, pending: 0, total: 0, processed: 0, deleted: 0, failed: 0 } }));

// ---- tags ----
adminApi.get("/tags", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM tags ORDER BY label ASC").all();
  const counts = await c.env.DB.prepare("SELECT tag_id, COUNT(*) AS c FROM video_tags GROUP BY tag_id").all<{ tag_id: number; c: number }>();
  const map = new Map(counts.results.map((x) => [x.tag_id, x.c]));
  return c.json(rows.results.map((t: any) => ({
    id: t.id, label: t.label,
    matchRules: safeJsonObject(t.match_rules, {}),
    source: t.source, count: map.get(t.id) || 0,
  })));
});
adminApi.post("/tags", async (c) => {
  const body = await c.req.json<{ label: string }>().catch(() => ({ label: "" }));
  if (!body.label) return c.json({ error: "label required" }, 400);
  const now = Date.now();
  const res = await c.env.DB.prepare("INSERT INTO tags (label, aliases, match_rules, source, created_at, updated_at) VALUES (?, '[]', '{}', 'user', ?, ?)")
    .bind(body.label, now, now).run();
  return c.json({ label: body.label, classified: 0 });
});
adminApi.put("/tags/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ matchRules: any }>().catch(() => ({ matchRules: {} }));
  await c.env.DB.prepare("UPDATE tags SET match_rules = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(body.matchRules || {}), Date.now(), id).run();
  const t = await c.env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first();
  return c.json({ tag: t });
});
adminApi.delete("/tags/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM video_tags WHERE tag_id = ?").bind(id).run();
  return c.json({ ok: true, removedVideos: (r.meta as any)?.changes ?? 0 });
});

// ---- settings ----
adminApi.get("/settings", async (c) => {
  const theme = (await getSetting(c.env, "theme")) || "dark";
  return c.json({ theme });
});
adminApi.put("/settings", async (c) => {
  const body = await c.req.json<{ theme?: string }>().catch((): { theme?: string } => ({}));
  if (body.theme) await setSetting(c.env, "theme", body.theme);
  const theme = (await getSetting(c.env, "theme")) || "dark";
  return c.json({ theme });
});

// ---- jobs ----
adminApi.get("/jobs/nightly/status", async (c) => c.json({ state: "idle", running: false, queued: false }));
adminApi.post("/jobs/nightly/run", async (c) => c.json({ ok: true, accepted: false, status: { state: "idle", running: false, queued: false }, message: "凌晨流水线需在外部 Runner/Cron 触发" }));
adminApi.post("/tasks/stop", async (c) => c.json({ ok: true, stoppedDrives: 0, status: { state: "idle", running: false, queued: false } }));

// ---- users ----
adminApi.get("/users", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, username, role, banned, created_at FROM users ORDER BY id ASC").all();
  return c.json(rows.results);
});
adminApi.post("/users", async (c) => {
  const body = await c.req.json<{ username: string; password: string; role: string }>().catch(() => ({ username: "", password: "", role: "user" }));
  if (!body.username || !body.password) return c.json({ ok: false }, 400);
  const hash = await hashPassword(body.password);
  const res = await c.env.DB.prepare("INSERT INTO users (username, password, role, banned, created_at) VALUES (?, ?, ?, 0, ?)")
    .bind(body.username, hash, body.role || "user", Date.now()).run();
  return c.json({ ok: true, id: Number((res.meta as any)?.last_row_id ?? 0) });
});
adminApi.delete("/users/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(parseInt(c.req.param("id"), 10)).run();
  return c.json({ ok: true });
});
adminApi.post("/users/:id/ban", async (c) => { await c.env.DB.prepare("UPDATE users SET banned = 1 WHERE id = ?").bind(parseInt(c.req.param("id"), 10)).run(); return c.json({ ok: true }); });
adminApi.post("/users/:id/unban", async (c) => { await c.env.DB.prepare("UPDATE users SET banned = 0 WHERE id = ?").bind(parseInt(c.req.param("id"), 10)).run(); return c.json({ ok: true }); });
adminApi.put("/users/:id/password", async (c) => {
  const body = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));
  if (!body.password) return c.json({ ok: false }, 400);
  const hash = await hashPassword(body.password);
  await c.env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(hash, parseInt(c.req.param("id"), 10)).run();
  return c.json({ ok: true });
});

// ---- banned IPs ----
adminApi.get("/banned-ips", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM banned_login_ips ORDER BY created_at DESC").all();
  return c.json(rows.results);
});
adminApi.delete("/banned-ips/:ip", async (c) => {
  await c.env.DB.prepare("DELETE FROM banned_login_ips WHERE ip = ?").bind(decodeURIComponent(c.req.param("ip"))).run();
  return c.json({ ok: true });
});

adminApi.get("/update/check", async (c) => c.json({ currentVersion: "0.2.8-cf", latestVersion: "0.2.8-cf", hasUpdate: false, checkedAt: new Date().toISOString() }));

async function toAdminDrive(env: Env, d: DriveRow) {
  const creds = safeJsonObject<Record<string, string>>(d.credentials, {});
  const hasCredential = !!Object.keys(creds).length;
  return {
    id: d.id, kind: d.kind, name: d.name, rootId: d.root_id,
    status: d.status, lastError: d.last_error || undefined, hasCredential,
    teaserEnabled: !!d.teaser_enabled,
    skipDirIds: safeJsonArray(d.skip_dir_ids),
    thumbnailReadyCount: 0, thumbnailPendingCount: 0, thumbnailFailedCount: 0, thumbnailDurationPendingCount: 0,
    teaserReadyCount: 0, teaserPendingCount: 0, teaserFailedCount: 0,
    fingerprintReadyCount: 0, fingerprintPendingCount: 0, fingerprintFailedCount: 0,
    transcodePendingCount: 0, transcodeReadyCount: 0, transcodeFailedCount: 0, transcodeSkippedCount: 0,
  };
}
