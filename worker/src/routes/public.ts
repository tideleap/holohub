import { Hono } from "hono";
import type { Env } from "../env";
import { LOCAL_UPLOAD_DRIVE_ID } from "../env";
import {
  getVideo, listVideos, listTagsWithCounts, rowToVideo, getDrive, getSetting,
} from "../db";
import { adapterFor, r2VideoKey, r2ThumbKey, r2PreviewKey, driveLabel } from "../drives";
import { createShare, consumeShare, shareCookie, validateShareSession } from "../shares";
import { requireSession, getUserRole } from "../auth";

export const publicApi = new Hono<{ Bindings: Env }>();

// Login guard: the whole site requires an authenticated session, except the
// public theme endpoint and the one-time share endpoints (validated separately).
publicApi.use("*", async (c, next) => {
  const p = c.req.path;
  if (p === "/api/settings/theme" || p.startsWith("/api/share/") || p.startsWith("/p/share/")) {
    return next();
  }
  const userId = await requireSession(c.env, c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  return next();
});

async function requireAdmin(c: any): Promise<boolean> {
  const userId = await requireSession(c.env, c);
  if (!userId) return false;
  return (await getUserRole(c.env, userId)) === "admin";
}

publicApi.get("/settings/theme", async (c) => {
  const theme = (await getSetting(c.env, "theme")) || "dark";
  return c.json({ theme }, 200, { "Cache-Control": "no-store" });
});

publicApi.get("/home", async (c) => {
  const raw = c.req.query("count");
  let count = 12;
  if (raw) {
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > 12) return c.json({ error: "invalid home recommendation count" }, 400);
    count = n;
  }
  const { items } = await listVideos(c.env, { page: 1, pageSize: count });
  return c.json(items.map(rowToVideo), 200, { "Cache-Control": "no-store" });
});

publicApi.get("/list", async (c) => {
  const q = c.req.query("q") || "";
  const tag = c.req.query("tag") || "";
  const sort = c.req.query("sort") || "latest";
  const page = parseInt(c.req.query("page") || "1", 10) || 1;
  const size = parseInt(c.req.query("size") || "24", 10) || 24;
  const skipTotal = c.req.query("count") === "false";
  const { items, total } = await listVideos(c.env, { keyword: q, tag, sort, page, pageSize: size, skipTotal });
  return c.json({ items: items.map(rowToVideo), total, page, size }, 200, { "Cache-Control": "no-store" });
});

publicApi.get("/tags", async (c) => {
  const stats = await listTagsWithCounts(c.env);
  const out = stats.map((s) => ({ id: s.label, label: s.label, count: s.count }));
  return c.json(out, 200, { "Cache-Control": "private, max-age=15" });
});

publicApi.get("/video/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const v = await getVideo(c.env, id);
  if (!v) return c.json({ error: "not found" }, 404);
  const dto = rowToVideo(v);
  let sourceLabel: string | undefined;
  if (v.drive_id !== LOCAL_UPLOAD_DRIVE_ID) {
    const d = await getDrive(c.env, v.drive_id);
    if (d) sourceLabel = driveLabel(d.kind);
  } else {
    sourceLabel = "本地存储 (R2)";
  }
  const related = await pickRelated(c.env, v, 6);
  const detail = {
    ...dto,
    videoSrc: videoSource(v),
    poster: v.thumbnail_url || `/p/thumb/${encodeURIComponent(v.id)}`,
    description: v.description || "",
    embedUrl: `<iframe src="/embed/${encodeURIComponent(v.id)}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`,
    authorProfile: { id: "author-" + (v.author || ""), name: v.author || "", href: "/author/" + encodeURIComponent(v.author || ""), badges: [] },
    relatedVideos: related.map(rowToVideo),
    commentsList: [],
  };
  return c.json(detail, 200, { "Cache-Control": "no-store" });
});

function videoSource(v: any): string {
  if (v.drive_id === LOCAL_UPLOAD_DRIVE_ID) return `/p/upload/${encodeURIComponent(v.id)}`;
  return `/p/stream/${encodeURIComponent(v.drive_id)}/${encodeURIComponent(v.file_id)}`;
}

async function pickRelated(env: Env, current: any, total: number): Promise<any[]> {
  const base: any[] = [];
  const seen = new Set([current.id]);
  if (current.tags) {
    const tags: string[] = JSON.parse(current.tags || "[]");
    for (const t of tags.slice(0, 3)) {
      const { items } = await listVideos(env, { tag: t, sort: "latest", page: 1, pageSize: 10 });
      for (const it of items) {
        if (!seen.has(it.id)) { seen.add(it.id); base.push(it); }
        if (base.length >= total) return base;
      }
    }
  }
  if (base.length < total) {
    const { items } = await listVideos(env, { sort: "latest", page: 1, pageSize: 50 });
    for (const it of items) {
      if (!seen.has(it.id)) { seen.add(it.id); base.push(it); }
      if (base.length >= total) break;
    }
  }
  return base.slice(0, total);
}

publicApi.get("/video/:id/subtitles", async (c) => c.json([]));

publicApi.post("/video/:id/share", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const v = await getVideo(c.env, id);
  if (!v) return c.json({ error: "not found" }, 404);
  const { id: shareId, url } = await createShare(c.env, id);
  return c.json({ url, shareId });
});

publicApi.put("/video/:id/like", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  await c.env.DB.prepare("UPDATE videos SET likes = likes + 1, last_liked_at = ? WHERE id = ?").bind(Date.now(), id).run();
  const likes = (await getVideo(c.env, id))?.likes ?? 0;
  return c.json({ likes });
});

publicApi.delete("/video/:id/like", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  await c.env.DB.prepare("UPDATE videos SET likes = MAX(0, likes - 1) WHERE id = ?").bind(id).run();
  const likes = (await getVideo(c.env, id))?.likes ?? 0;
  return c.json({ likes });
});

publicApi.post("/video/:id/view", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  await c.env.DB.prepare("UPDATE videos SET views = views + 1, last_viewed_at = ? WHERE id = ?").bind(Date.now(), id).run();
  const views = (await getVideo(c.env, id))?.views ?? 0;
  return c.json({ views });
});

// admin-only mutations under /api
publicApi.put("/video/:id/tags", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "forbidden" }, 403);
  const id = decodeURIComponent(c.req.param("id"));
  const body = await c.req.json<{ tags: string[] }>().catch(() => ({ tags: [] }));
  await c.env.DB.prepare("UPDATE videos SET tags = ?, tags_manual = 1, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(body.tags || []), Date.now(), id).run();
  const v = await getVideo(c.env, id);
  return c.json(v ? rowToVideo(v) : {});
});

publicApi.post("/video/:id/hide", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "forbidden" }, 403);
  const id = decodeURIComponent(c.req.param("id"));
  const v = await getVideo(c.env, id);
  if (!v) return c.json({ error: "not found" }, 404);
  // blacklist the source so future scans won't re-import; keep the file.
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO deleted_videos (id, drive_id, file_id, parent_id, content_hash, file_name, size_bytes, reason, source_deleted, deleted_at) VALUES (?,?,?,?,?,?,?, 'hidden', 0, ?)"
  ).bind(v.id, v.drive_id, v.file_id, v.parent_id || "", v.content_hash || "", v.file_name || "", v.size_bytes, now).run();
  await c.env.DB.prepare("UPDATE videos SET hidden = 1 WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

publicApi.post("/upload", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "forbidden" }, 403);
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: "invalid form" }, 400);
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "video file is required" }, 400);
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  const allowedExt = new Set([".avi", ".mkv", ".mov", ".mp4", ".webm"]);
  if (!allowedExt.has(ext)) return c.json({ error: `unsupported video extension: ${ext}` }, 400);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ error: "uploaded video is empty" }, 400);

  const uploadID = "upload-" + Date.now() + "-" + Math.random().toString(16).slice(2, 10);
  const storedName = uploadID + ext;
  await c.env.MEDIA.put(r2VideoKey(storedName), buf, { httpMetadata: { contentType: file.type || "video/mp4" } });

  const title = (typeof form["title"] === "string" && form["title"]) || file.name.replace(/\.[^.]+$/, "");
  const now = Date.now();
  const id = LOCAL_UPLOAD_DRIVE_ID + "-" + uploadID;
  const rawTags = form["tags"];
  const tagsRaw: string[] = Array.isArray(rawTags) ? rawTags.map(String) : rawTags ? [String(rawTags)] : [];
  const tagsJson = JSON.stringify(tagsRaw);
  await c.env.DB.prepare(
    `INSERT INTO videos (id, drive_id, file_id, file_name, title, author, size_bytes, ext, preview_status, tags, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '用户上传', ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(id, LOCAL_UPLOAD_DRIVE_ID, storedName, file.name, title, buf.byteLength, ext.slice(1), tagsJson, now, now, now).run();

  const v = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first();
  return c.json(v, 201);
});

// ---- shorts feed ----
publicApi.get("/shorts/next", async (c) => {
  const cursor = parseInt(c.req.query("cursor") || "0", 10) || 0;
  const count = Math.min(20, parseInt(c.req.query("count") || "5", 10) || 5);
  const { items } = await listVideos(c.env, { sort: "latest", page: 1, pageSize: 200 });
  const start = Math.max(0, cursor);
  const slice = items.slice(start, start + count);
  const nextCursor = start + slice.length;
  const roundComplete = nextCursor >= items.length;
  return c.json({
    items: slice.map((v) => ({ ...rowToVideo(v), videoSrc: videoSource(v), poster: v.thumbnail_url || `/p/thumb/${encodeURIComponent(v.id)}`, feedCursor: start + 1 })),
    total: items.length,
    feedToken: c.req.query("feedToken") || "feed",
    nextCursor,
    roundComplete,
  });
});

// ---- one-time share ----
publicApi.post("/share/consume", async (c) => {
  const body = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));
  if (!body.token) return c.json({ error: "token required" }, 400);
  const res = await consumeShare(c.env, body.token);
  if (!res.ok) return c.json({ error: "share unavailable" }, res.error || 404);
  const share = await c.env.DB.prepare("SELECT video_id, session_expires_at FROM video_shares WHERE id = ?").bind(res.shareID).first<{ video_id: string; session_expires_at: number }>();
  if (!share) return c.json({ error: "not found" }, 404);
  const video = await getVideo(c.env, share.video_id);
  if (!video) return c.json({ error: "not found" }, 404);
  const detail = {
    ...rowToVideo(video),
    videoSrc: videoSource(video),
    poster: video.thumbnail_url || `/p/thumb/${encodeURIComponent(video.id)}`,
    description: video.description || "",
    embedUrl: "",
    authorProfile: { id: "author-" + (video.author || ""), name: video.author || "", href: "/author/" + encodeURIComponent(video.author || ""), badges: [] },
    relatedVideos: [],
    commentsList: [],
  };
  return c.json({ shareId: res.shareID, expiresAt: new Date(share.session_expires_at).toISOString(), video: detail }, 200, {
    "Cache-Control": "no-store",
    "Set-Cookie": shareCookie(res.sessionToken),
  });
});

publicApi.get("/share/:shareID/subtitles", async (c) => c.json([]));
publicApi.post("/share/:shareID/view", async (c) => {
  const shareID = c.req.param("shareID");
  const share = await c.env.DB.prepare("SELECT video_id FROM video_shares WHERE id = ?").bind(shareID).first<{ video_id: string }>();
  if (!share) return c.json({ views: 0 }, 404);
  await c.env.DB.prepare("UPDATE videos SET views = views + 1 WHERE id = ?").bind(share.video_id).run();
  const views = (await c.env.DB.prepare("SELECT views FROM videos WHERE id = ?").bind(share.video_id).first<{ views: number }>())?.views ?? 0;
  return c.json({ views });
});

// ---- proxy / media ----
publicApi.get("/stream/:driveID/*", async (c) => {
  const driveID = decodeURIComponent(c.req.param("driveID"));
  const fileID = decodeURIComponent(c.req.param("*") || "");
  return serveStream(c, driveID, fileID);
});

publicApi.get("/upload/:videoID", async (c) => {
  const videoID = decodeURIComponent(c.req.param("videoID"));
  const v = await getVideo(c.env, videoID);
  if (!v || v.drive_id !== LOCAL_UPLOAD_DRIVE_ID) return c.notFound();
  return serveR2(c, r2VideoKey(v.file_id));
});

publicApi.get("/preview/:videoID", async (c) => {
  const videoID = decodeURIComponent(c.req.param("videoID"));
  return serveR2(c, r2PreviewKey(videoID));
});

publicApi.get("/thumb/:videoID", async (c) => {
  const videoID = decodeURIComponent(c.req.param("videoID"));
  const v = await getVideo(c.env, videoID);
  if (v && v.thumbnail_url) return c.redirect(v.thumbnail_url, 302);
  return serveR2(c, r2ThumbKey(videoID));
});

// shared media
publicApi.get("/share/:shareID/stream", async (c) => {
  const shareID = c.req.param("shareID");
  if (!(await validateShareSession(c.env, shareID, c.req.header("Cookie")))) return c.json({ error: "unauthorized" }, 401);
  const share = await c.env.DB.prepare("SELECT video_id FROM video_shares WHERE id = ?").bind(shareID).first<{ video_id: string }>();
  if (!share) return c.notFound();
  const v = await getVideo(c.env, share.video_id);
  if (!v) return c.notFound();
  return serveStream(c, v.drive_id, v.file_id);
});
publicApi.get("/share/:shareID/preview", async (c) => {
  const shareID = c.req.param("shareID");
  if (!(await validateShareSession(c.env, shareID, c.req.header("Cookie")))) return c.json({ error: "unauthorized" }, 401);
  const share = await c.env.DB.prepare("SELECT video_id FROM video_shares WHERE id = ?").bind(shareID).first<{ video_id: string }>();
  if (!share) return c.notFound();
  return serveR2(c, r2PreviewKey(share.video_id));
});
publicApi.get("/share/:shareID/thumb", async (c) => {
  const shareID = c.req.param("shareID");
  if (!(await validateShareSession(c.env, shareID, c.req.header("Cookie")))) return c.json({ error: "unauthorized" }, 401);
  const share = await c.env.DB.prepare("SELECT video_id FROM video_shares WHERE id = ?").bind(shareID).first<{ video_id: string }>();
  if (!share) return c.notFound();
  const v = await getVideo(c.env, share.video_id);
  if (v && v.thumbnail_url) return c.redirect(v.thumbnail_url, 302);
  return serveR2(c, r2ThumbKey(share.video_id));
});

async function serveStream(c: any, driveID: string, fileID: string) {
  const adapter = await adapterFor(c.env, driveID);
  if (!adapter) return c.json({ code: "drive_not_found", message: "网盘未配置或不支持" }, 502);
  const result = await adapter.stream(fileID);
  if (result.serveFromR2 && result.r2Key) {
    return serveR2(c, result.r2Key);
  }
  if (!result.url) return c.json({ code: "no_url", message: "无法获取播放地址" }, 502);
  if (result.redirect) {
    return c.redirect(result.url, 302);
  }
  const headers = new Headers();
  const range = c.req.header("Range");
  if (range) headers.set("Range", range);
  if (result.headers) for (const [k, v] of Object.entries(result.headers)) headers.set(k, v);
  const upstream = await fetch(result.url, { headers, redirect: "manual" });
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("Location");
    if (loc) return c.redirect(loc, 302);
  }
  const out = new Headers();
  for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "Etag"]) {
    const val = upstream.headers.get(k);
    if (val) out.set(k, val);
  }
  out.set("Cache-Control", "private, max-age=300");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function serveR2(c: any, key: string) {
  const rangeHeader = c.req.header("Range");
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  const obj = await c.env.MEDIA.get(key, range ? { range } : undefined);
  if (!obj) return c.notFound();
  const headers = new Headers();
  headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  if (obj.range) {
    headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.end}/${obj.size}`);
    headers.set("Content-Length", String(obj.range.end - obj.range.offset + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(obj.body, { status: 200, headers });
}

function parseRange(header: string): { offset: number; length?: number } | undefined {
  const m = /bytes=(\d+)-(\d*)/.exec(header);
  if (!m) return undefined;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : undefined;
  if (end !== undefined) return { offset: start, length: end - start + 1 };
  return { offset: start };
}
