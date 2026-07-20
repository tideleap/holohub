export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
}

export const SESSION_COOKIE = "vs_admin";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SHARE_COOKIE = "vs_share";

/** Drive kinds shipped with working adapters on Cloudflare. */
export const SUPPORTED_DRIVE_KINDS = [
  "localstorage", // backed by R2 (the default "upload + store" drive)
  "webdav",
] as const;

export type SupportedDriveKind = (typeof SUPPORTED_DRIVE_KINDS)[number];

/** Drive kinds whose private APIs are not yet reimplemented on Workers. */
export const UNSUPPORTED_DRIVE_KINDS = [
  "quark",
  "p115",
  "p123",
  "pikpak",
  "wopan",
  "guangyapan",
  "onedrive",
  "googledrive",
] as const;

export const LOCAL_UPLOAD_DRIVE_ID = "local";

export function nowMs(): number {
  return Date.now();
}
