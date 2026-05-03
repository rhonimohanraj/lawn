/**
 * Shared content-type → assetKind classifier. Used by upload paths
 * (`assetActions`, lawn-migrate HTTP endpoints) so every entry point
 * agrees on what counts as a video, image, audio, doc, or "other".
 *
 * Convex won't let us import the schema validator union at runtime, so
 * the kind set is duplicated as a literal-typed array. Keep in sync
 * with `assetKindValidator` in `schema.ts`.
 */

export type AssetKind = "video" | "image" | "audio" | "doc" | "other";

const VIDEO_PREFIXES = ["video/"] as const;
const IMAGE_PREFIXES = ["image/"] as const;
const AUDIO_PREFIXES = ["audio/"] as const;

const DOC_EXACT = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
]);

const VIDEO_EXTS = new Set([
  "mp4", "mov", "m4v", "webm", "mkv", "avi", "wmv", "flv", "mts", "m2ts", "mpg", "mpeg",
]);
const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "tiff", "tif", "bmp", "heic", "heif", "svg", "avif", "raw", "cr2", "nef", "arw", "dng",
]);
const AUDIO_EXTS = new Set([
  "mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "aiff", "aif",
]);
const DOC_EXTS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "txt", "md", "csv", "html", "htm",
]);

export function normalizeContentType(contentType: string | null | undefined): string {
  if (!contentType) return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Best-effort classification. Falls back through:
 *   1. Strong content-type match (video/* / image/* / audio/* / known doc mime)
 *   2. Filename extension fallback (Frame.io often sends application/octet-stream)
 *   3. "other"
 */
export function classifyAssetKind(args: {
  contentType?: string | null;
  filename?: string | null;
}): AssetKind {
  const ct = normalizeContentType(args.contentType);

  if (VIDEO_PREFIXES.some((p) => ct.startsWith(p))) return "video";
  if (IMAGE_PREFIXES.some((p) => ct.startsWith(p))) return "image";
  if (AUDIO_PREFIXES.some((p) => ct.startsWith(p))) return "audio";
  if (DOC_EXACT.has(ct)) return "doc";

  const ext = args.filename ? extOf(args.filename) : "";
  if (ext) {
    if (VIDEO_EXTS.has(ext)) return "video";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (DOC_EXTS.has(ext)) return "doc";
  }

  return "other";
}

/** Convenience predicate used to gate the Mux pipeline. */
export function shouldRunMux(kind: AssetKind): boolean {
  return kind === "video";
}
