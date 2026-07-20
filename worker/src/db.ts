import type { Env } from "./env";
import type { VideoRow, TagRow, DriveRow } from "./types";

export function rowToVideo(v: VideoRow) {
  const tags: string[] = v.tags ? safeJsonArray(v.tags) : [];
  const badges: string[] = v.badges ? safeJsonArray(v.badges) : [];
  return {
    id: v.id,
    href: "/video/" + encodeURIComponent(v.id),
    title: v.title,
    thumbnail: thumbnailURL(v),
    previewSrc: "/p/preview/" + encodeURIComponent(v.id),
    previewDuration: 12,
    previewStrategy: "teaser-file",
    duration: formatDuration(v.duration_seconds),
    badges,
    quality: v.quality ?? undefined,
    author: v.author ?? "",
    views: v.views,
    favorites: v.favorites,
    comments: v.comments,
    likes: v.likes,
    dislikes: v.dislikes,
    publishedAt: new Date(v.published_at).toISOString().slice(0, 10),
    tags,
  };
}

export function thumbnailURL(v: VideoRow): string {
  if (v.thumbnail_url && v.thumbnail_url.length > 0) return v.thumbnail_url;
  return "/p/thumb/" + encodeURIComponent(v.id);
}

export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export function safeJsonObject<T = any>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export async function getVideo(env: Env, id: string): Promise<VideoRow | null> {
  const r = await env.DB.prepare("SELECT * FROM videos WHERE id = ?").bind(id).first<VideoRow>();
  return r ?? null;
}

export async function getDrive(env: Env, id: string): Promise<DriveRow | null> {
  const r = await env.DB.prepare("SELECT * FROM drives WHERE id = ?").bind(id).first<DriveRow>();
  return r ?? null;
}

export async function listDrives(env: Env): Promise<DriveRow[]> {
  const r = await env.DB.prepare("SELECT * FROM drives ORDER BY created_at ASC").all<DriveRow>();
  return r.results;
}

export interface ListParams {
  keyword?: string;
  tag?: string;
  sort?: string;
  page: number;
  pageSize: number;
  skipTotal?: boolean;
}

export async function listVideos(env: Env, p: ListParams): Promise<{ items: VideoRow[]; total: number }> {
  const where: string[] = ["hidden = 0"];
  const args: any[] = [];
  if (p.keyword && p.keyword.trim()) {
    where.push("(title LIKE ? OR author LIKE ?)");
    const kw = "%" + p.keyword.trim() + "%";
    args.push(kw, kw);
  }
  if (p.tag && p.tag.trim()) {
    // match tag via video_tags join
    const tagRow = await env.DB.prepare("SELECT id FROM tags WHERE label = ? COLLATE NOCASE").bind(p.tag.trim()).first<{ id: number }>();
    if (tagRow) {
      where.push("v.id IN (SELECT video_id FROM video_tags WHERE tag_id = ?)");
      args.push(tagRow.id);
    } else {
      // no such tag -> empty result
      return { items: [], total: 0 };
    }
  }
  const whereSql = "WHERE " + where.join(" AND ");

  let sortSql = "ORDER BY published_at DESC";
  if (p.sort === "hot" || p.sort === "views") sortSql = "ORDER BY views DESC";
  else if (p.sort === "latest") sortSql = "ORDER BY published_at DESC";
  else if (p.sort === "recent") sortSql = "ORDER BY created_at DESC";

  const page = Math.max(1, p.page);
  const size = Math.max(1, Math.min(100, p.pageSize));
  const offset = (page - 1) * size;

  const total = p.skipTotal
    ? 0
    : (await env.DB.prepare(`SELECT COUNT(*) AS c FROM videos v ${whereSql}`).bind(...args).first<{ c: number }>())?.c ?? 0;

  const items = await env.DB.prepare(`SELECT * FROM videos v ${whereSql} ${sortSql} LIMIT ? OFFSET ?`)
    .bind(...args, size, offset)
    .all<VideoRow>();
  return { items: items.results, total };
}

export async function listTagsWithCounts(env: Env): Promise<{ label: string; count: number }[]> {
  const r = await env.DB.prepare(
    `SELECT t.label AS label, COUNT(vt.video_id) AS count
     FROM tags t
     LEFT JOIN video_tags vt ON vt.tag_id = t.id
     GROUP BY t.id
     ORDER BY count DESC, t.label ASC`
  ).all<{ label: string; count: number }>();
  return r.results;
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, value, now).run();
}

export async function ensureSeeded(env: Env): Promise<void> {
  const count = (await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>())?.c ?? 0;
  if (count > 0) return;
  // Only auto-seed from the ADMIN_PASSWORD secret. If unset, the operator must
  // use the in-app setup wizard (POST /admin/api/setup) on first run — we never
  // fall back to a weak built-in default.
  const password = env.ADMIN_PASSWORD;
  if (!password) return;
  const username = (env.ADMIN_USERNAME || "admin").trim();
  const hash = await hashPassword(password);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (username, password, role, banned, created_at) VALUES (?, ?, 'admin', 0, ?)"
  ).bind(username, hash, now).run();
}

// ---- password hashing (bcryptjs, pure JS, Workers-safe) ----
import bcrypt from "bcryptjs";
export function hashPassword(p: string): Promise<string> {
  return bcrypt.hash(p, 10);
}
export function verifyPassword(p: string, hash: string): Promise<boolean> {
  return bcrypt.compare(p, hash);
}
