export interface VideoRow {
  id: string;
  drive_id: string;
  file_id: string;
  file_name: string;
  content_hash: string;
  sampled_sha256: string;
  fingerprint_status: string;
  fingerprint_error: string;
  parent_id: string | null;
  dir_name: string;
  title: string;
  author: string | null;
  tags: string | null;
  duration_seconds: number;
  size_bytes: number;
  ext: string | null;
  quality: string | null;
  thumbnail_url: string | null;
  thumbnail_status: string;
  thumbnail_failures: number;
  preview_file_id: string | null;
  preview_local: string | null;
  preview_status: string;
  transcode_status: string;
  transcode_error: string;
  transcoded_file_id: string;
  transcoded_size: number;
  views: number;
  last_viewed_at: number;
  favorites: number;
  comments: number;
  likes: number;
  last_liked_at: number;
  dislikes: number;
  hidden: number;
  tags_manual: number;
  badges: string | null;
  description: string | null;
  published_at: number;
  created_at: number;
  updated_at: number;
}

export interface VideoDTO {
  id: string;
  href: string;
  title: string;
  thumbnail: string;
  previewSrc: string;
  previewDuration: number;
  previewStrategy: string;
  duration: string;
  badges: string[];
  quality?: string;
  sourceLabel?: string;
  author: string;
  views: number;
  favorites: number;
  comments: number;
  likes: number;
  dislikes: number;
  publishedAt: string;
  tags?: string[];
}

export interface TagRow {
  id: number;
  label: string;
  aliases: string;
  match_rules: string;
  source: string;
  origin: string;
  created_at: number;
  updated_at: number;
}

export interface DriveRow {
  id: string;
  kind: string;
  name: string;
  root_id: string;
  scan_root_id: string | null;
  credentials: string | null;
  status: string;
  last_error: string | null;
  teaser_enabled: number;
  skip_dir_ids: string;
  created_at: number;
  updated_at: number;
}

export interface VideoShareRow {
  id: string;
  token_hash: string;
  video_id: string;
  created_at: number;
  consumed_at: number;
  session_hash: string;
  session_expires_at: number;
}

export interface UserRow {
  id: number;
  username: string;
  password: string;
  role: string;
  banned: number;
  created_at: number;
}
