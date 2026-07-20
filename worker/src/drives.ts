import type { Env } from "./env";
import { LOCAL_UPLOAD_DRIVE_ID } from "./env";
import { getDrive } from "./db";
import type { DriveRow } from "./types";

/**
 * Unified drive abstraction (ported from the Go `drives.Drive` interface).
 * Cloudflare Workers cannot run the upstream Go SDKs, so we ship two working
 * adapters — R2-backed storage (the default) and WebDAV — plus a registry that
 * reports unsupported kinds gracefully so the admin UI degrades cleanly.
 */
export interface StreamResult {
  // When serveFromR2 is set, the proxy handler streams the R2 object directly.
  serveFromR2?: boolean;
  r2Key?: string;
  // Otherwise relay the upstream URL (302 when redirect=true, else proxy bytes).
  url?: string;
  headers?: Record<string, string>;
  redirect?: boolean;
}

export interface DriveAdapter {
  kind: string;
  id: string;
  stream(fileID: string): Promise<StreamResult>;
  listDir(parentId?: string): Promise<{ id: string; name: string }[]>;
}

export function r2VideoKey(fileID: string): string {
  return `videos/${fileID}`;
}
export function r2ThumbKey(videoID: string): string {
  return `thumbs/${videoID}.jpg`;
}
export function r2PreviewKey(videoID: string): string {
  return `previews/${videoID}.mp4`;
}

class R2Drive implements DriveAdapter {
  kind = "localstorage";
  constructor(public id: string) {}
  async stream(fileID: string): Promise<StreamResult> {
    return { serveFromR2: true, r2Key: r2VideoKey(fileID) };
  }
  async listDir(): Promise<{ id: string; name: string }[]> {
    return [];
  }
}

class WebDavDrive implements DriveAdapter {
  kind = "webdav";
  constructor(public id: string, private baseURL: string, private user: string, private pass: string) {}
  private fileURL(fileID: string): string {
    const base = this.baseURL.replace(/\/+$/, "");
    const path = fileID.startsWith("/") ? fileID : "/" + fileID;
    return base + path;
  }
  async stream(fileID: string): Promise<StreamResult> {
    const auth = "Basic " + btoa(`${this.user}:${this.pass}`);
    return {
      url: this.fileURL(fileID),
      headers: { Authorization: auth },
      redirect: false, // follow upstream; relay 3xx, proxy 200/206
    };
  }
  async listDir(parentId?: string): Promise<{ id: string; name: string }[]> {
    // Minimal PROPFIND-based directory listing for the admin dirtree.
    const url = this.fileURL(parentId && parentId !== "0" ? parentId : "/");
    const auth = "Basic " + btoa(`${this.user}:${this.pass}`);
    try {
      const res = await fetch(url, {
        method: "PROPFIND",
        headers: { Authorization: auth, Depth: "1", Accept: "application/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`,
      });
      if (!res.ok) return [];
      const text = await res.text();
      return parseWebDavDirs(text);
    } catch {
      return [];
    }
  }
}

function parseWebDavDirs(xml: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const hrefRe = /<d:href>([^<]+)<\/d:href>/gi;
  const collectionRe = /<d:resourcetype>([\s\S]*?)<\/d:resourcetype>/gi;
  const matches = [...xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/gi)];
  for (const m of matches) {
    const block = m[1];
    const href = /<d:href>([^<]+)<\/d:href>/i.exec(block)?.[1];
    if (!href) continue;
    const isCollection = /<d:collection\s*\/>/.test(block);
    if (!isCollection) continue;
    const name = decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() || href);
    out.push({ id: href, name });
  }
  void hrefRe; void collectionRe;
  return out;
}

/** Build an adapter for a drive row, or null if the kind is unsupported on Workers. */
export function buildAdapter(drive: DriveRow): DriveAdapter | null {
  const creds = drive.credentials ? safeParse(drive.credentials) : {};
  switch (drive.kind) {
    case "localstorage":
      return new R2Drive(drive.id);
    case "webdav": {
      const base = creds.base_url || creds.baseUrl || "";
      const user = creds.username || "";
      const pass = creds.password || "";
      if (!base) return null;
      return new WebDavDrive(drive.id, base, user, pass);
    }
    default:
      return null;
  }
}

export function safeParse(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}

/** The default R2-backed drive used for uploads. */
export function defaultUploadDriveID(): string {
  return LOCAL_UPLOAD_DRIVE_ID;
}

export async function adapterFor(env: Env, driveID: string): Promise<DriveAdapter | null> {
  if (driveID === LOCAL_UPLOAD_DRIVE_ID) return new R2Drive(driveID);
  const d = await getDrive(env, driveID);
  if (!d) return null;
  return buildAdapter(d);
}

export const DRIVE_LABELS: Record<string, string> = {
  localstorage: "本地存储 (R2)",
  webdav: "WebDAV",
  quark: "夸克网盘",
  p115: "115 网盘",
  p123: "123网盘",
  pikpak: "PikPak",
  wopan: "联通网盘",
  guangyapan: "光鸭网盘",
  onedrive: "OneDrive",
  googledrive: "Google Drive",
};

export function driveLabel(kind: string): string {
  return DRIVE_LABELS[kind] || kind;
}
