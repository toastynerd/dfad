import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { newId } from "../lib/ids.js";
import { validateUpload } from "../lib/validate.js";
import { getStorage, objectKey } from "../lib/storage.js";
import { getMetadata, type Deployment } from "../lib/metadata.js";
import { hashIp, nowSeconds } from "../lib/util.js";

/**
 * POST /api/deploy
 * Accepts a single HTML document as either:
 *   - multipart/form-data with a file field, or
 *   - application/json { html: "<!doctype html>..." }
 * Returns { id, url, expiresAt }.
 */
export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/deploy",
    {
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_MAX,
          timeWindow: config.RATE_LIMIT_WINDOW,
        },
      },
    },
    async (req, reply) => {
      let buf: Buffer | null = null;
      let filename: string | undefined;

      if (req.isMultipart()) {
        const file = await req.file({ limits: { fileSize: config.MAX_BYTES, files: 1 } });
        if (!file) {
          return reply.code(400).send({ error: "No file uploaded." });
        }
        filename = file.filename;
        try {
          buf = await file.toBuffer();
        } catch {
          // @fastify/multipart throws when fileSize limit is exceeded.
          return reply
            .code(413)
            .send({ error: `File too large. Max ${(config.MAX_BYTES / 1048576).toFixed(1)} MB.` });
        }
        if (file.file.truncated) {
          return reply
            .code(413)
            .send({ error: `File too large. Max ${(config.MAX_BYTES / 1048576).toFixed(1)} MB.` });
        }
      } else {
        const body = req.body as { html?: unknown } | undefined;
        if (!body || typeof body.html !== "string") {
          return reply.code(400).send({ error: "Provide an HTML file or { html } JSON body." });
        }
        buf = Buffer.from(body.html, "utf8");
        // No filename for pasted content; extension check is skipped.
      }

      const result = validateUpload({ buf, filename, maxBytes: config.MAX_BYTES });
      if (!result.ok) {
        return reply.code(result.status).send({ error: result.message });
      }

      const id = newId();
      const createdAt = nowSeconds();
      const expiresAt = createdAt + config.ttlSeconds;
      const s3Key = objectKey(id);

      const record: Deployment = {
        id,
        s3Key,
        createdAt,
        expiresAt,
        size: buf.length,
        ipHash: hashIp(req.ip),
      };

      const [storage, metadata] = await Promise.all([getStorage(), getMetadata()]);
      await storage.put(s3Key, buf);
      try {
        await metadata.put(record);
      } catch (err) {
        // Roll back the orphaned object if metadata write fails.
        await storage.delete(s3Key).catch(() => {});
        throw err;
      }

      return reply.code(201).send({
        id,
        url: `${config.APPS_BASE_URL.replace(/\/$/, "")}/a/${id}`,
        expiresAt,
      });
    }
  );
}
