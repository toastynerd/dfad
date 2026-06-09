export interface ValidationOk {
  ok: true;
}
export interface ValidationErr {
  ok: false;
  status: number;
  message: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

/** True if a filename looks like an HTML file. */
export function hasHtmlExtension(filename: string | undefined): boolean {
  if (!filename) return false;
  return /\.html?$/i.test(filename.trim());
}

/** True if the buffer's leading content sniffs as HTML. */
export function looksLikeHtml(buf: Buffer): boolean {
  // Look at a decoded prefix; ignore a leading BOM / whitespace.
  const head = buf.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html");
}

/**
 * Validate an uploaded single-page app.
 * Rules: non-empty, within size limit, filename looks like .html/.htm (when provided),
 * and content sniffs as HTML. External CDN assets are explicitly allowed.
 */
export function validateUpload(opts: {
  buf: Buffer;
  filename?: string;
  maxBytes: number;
}): ValidationResult {
  const { buf, filename, maxBytes } = opts;

  if (buf.length === 0) {
    return { ok: false, status: 400, message: "Uploaded file is empty." };
  }
  if (buf.length > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(1);
    return { ok: false, status: 413, message: `File too large. Max ${mb} MB.` };
  }
  // Filename is optional (pasted HTML has none); only enforce the extension when present.
  if (filename !== undefined && !hasHtmlExtension(filename)) {
    return { ok: false, status: 400, message: "Only .html files are accepted." };
  }
  if (!looksLikeHtml(buf)) {
    return { ok: false, status: 400, message: "File does not look like an HTML document." };
  }
  return { ok: true };
}
