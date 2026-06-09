import type { FastifyInstance } from "fastify";
import { getStorage } from "../lib/storage.js";
import { getMetadata } from "../lib/metadata.js";
import { nowSeconds } from "../lib/util.js";

/**
 * GET /a/:id
 * Serves a deployed app. Enforces the 24h boundary at read time (returns 410 once
 * expired) so the cutoff is exact even though DynamoDB TTL / S3 lifecycle deletion lag.
 */
export async function serveRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/a/:id", async (req, reply) => {
    const { id } = req.params;
    if (!/^[a-z0-9]{1,32}$/.test(id)) {
      return reply.code(404).type("text/plain").send("Not found.");
    }

    const [storage, metadata] = await Promise.all([getStorage(), getMetadata()]);
    const record = await metadata.get(id);
    if (!record) {
      return reply.code(404).type("text/plain").send("This app does not exist (or has expired).");
    }

    const now = nowSeconds();
    if (record.expiresAt <= now) {
      // Best-effort cleanup; don't block the response.
      void storage.delete(record.s3Key).catch(() => {});
      void metadata.delete(id).catch(() => {});
      return reply.code(410).type("text/plain").send("This app has expired.");
    }

    const body = await storage.get(record.s3Key);
    if (!body) {
      return reply.code(404).type("text/plain").send("This app does not exist (or has expired).");
    }

    const maxAge = Math.max(0, record.expiresAt - now);
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", `public, max-age=${Math.min(maxAge, 3600)}`)
      .send(body);
  });
}
