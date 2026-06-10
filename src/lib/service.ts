import { config } from "../config.js";
import { newId } from "./ids.js";
import { looksLikeHtml } from "./validate.js";
import { getStorage, objectKey, type UploadTarget } from "./storage.js";
import { getMetadata, type Deployment } from "./metadata.js";
import { hashIp, nowSeconds } from "./util.js";

/** Error carrying an HTTP status for the adapters to translate. */
export class ServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ID_RE = /^[a-z0-9]{1,32}$/;

function appUrl(id: string): string {
  return `${config.APPS_BASE_URL.replace(/\/$/, "")}/a/${id}`;
}

/** Step 1: rate-limit, mint an id, and hand back a direct-upload target. */
export async function createDeployment(ip: string | undefined): Promise<{
  id: string;
  upload: UploadTarget;
}> {
  const meta = await getMetadata();
  const count = await meta.incrementRate(hashIp(ip), config.RATE_LIMIT_WINDOW_SECONDS);
  if (count > config.RATE_LIMIT_MAX) {
    throw new ServiceError(429, "Too many uploads from your network. Try again later.");
  }
  const id = newId();
  const storage = await getStorage();
  const upload = await storage.createUploadTarget(objectKey(id), config.MAX_BYTES);
  return { id, upload };
}

/** Step 3: validate the uploaded object, then record metadata. Returns the live link. */
export async function finalizeDeployment(
  id: string,
  ip: string | undefined
): Promise<{ id: string; url: string; expiresAt: number }> {
  if (!ID_RE.test(id)) throw new ServiceError(400, "Invalid id.");
  const storage = await getStorage();
  const meta = await getMetadata();
  const key = objectKey(id);

  // Idempotent: if already finalized, just return the existing link.
  const existing = await meta.get(id);
  if (existing?.s3Key) {
    return { id, url: appUrl(id), expiresAt: existing.expiresAt };
  }

  const head = await storage.head(key);
  if (!head) throw new ServiceError(400, "No uploaded file found. Upload it first.");
  if (head.size === 0) {
    await storage.delete(key).catch(() => {});
    throw new ServiceError(400, "Uploaded file is empty.");
  }
  if (head.size > config.MAX_BYTES) {
    await storage.delete(key).catch(() => {});
    throw new ServiceError(413, `File too large. Max ${(config.MAX_BYTES / 1048576).toFixed(1)} MB.`);
  }
  const prefix = await storage.readRange(key, 1024);
  if (!prefix || !looksLikeHtml(prefix)) {
    await storage.delete(key).catch(() => {});
    throw new ServiceError(400, "File does not look like an HTML document.");
  }

  const createdAt = nowSeconds();
  const record: Deployment = {
    id,
    s3Key: key,
    createdAt,
    expiresAt: createdAt + config.ttlSeconds,
    size: head.size,
    ipHash: hashIp(ip),
  };
  await meta.put(record);
  return { id, url: appUrl(id), expiresAt: record.expiresAt };
}

export interface AppResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: Buffer;
  text?: string;
}

/** Serve a deployed app, enforcing the expiry boundary exactly at read time. */
export async function getApp(id: string): Promise<AppResponse> {
  const notFound: AppResponse = {
    statusCode: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    text: "This app does not exist (or has expired).",
  };
  if (!ID_RE.test(id)) return notFound;

  const meta = await getMetadata();
  const record = await meta.get(id);
  if (!record || !record.s3Key) return notFound;

  const now = nowSeconds();
  if (record.expiresAt <= now) {
    const storage = await getStorage();
    void storage.delete(record.s3Key).catch(() => {});
    void meta.delete(id).catch(() => {});
    return {
      statusCode: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
      text: "This app has expired.",
    };
  }

  const storage = await getStorage();
  const body = await storage.get(record.s3Key);
  if (!body) return notFound;

  const maxAge = Math.min(Math.max(0, record.expiresAt - now), 3600);
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": `public, max-age=${maxAge}`,
    },
    body,
  };
}
