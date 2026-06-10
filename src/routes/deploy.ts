import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createDeployment, finalizeDeployment, ServiceError } from "../lib/service.js";
import { getStorage } from "../lib/storage.js";

/**
 * The deploy API (shared shape with the Lambda handler, via lib/service):
 *   POST /api/deploy   -> { id, upload: { url, fields, method } }
 *   POST /api/finalize -> { id, url, expiresAt }
 *   POST /api/upload   -> local-only receiver mirroring an S3 presigned POST
 */
export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/deploy", async (req, reply) => {
    try {
      return reply.code(201).send(await createDeployment(req.ip));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { id?: unknown } }>("/api/finalize", async (req, reply) => {
    try {
      const id = req.body?.id;
      if (typeof id !== "string") throw new ServiceError(400, "Missing id.");
      return reply.code(201).send(await finalizeDeployment(id, req.ip));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Local driver only: receive the direct upload and write it to disk under `key`.
  if (config.STORAGE_DRIVER === "local") {
    app.post("/api/upload", async (req, reply) => {
      let key: string | undefined;
      let buf: Buffer | undefined;
      for await (const part of req.parts()) {
        if (part.type === "file") {
          buf = await part.toBuffer();
        } else if (part.fieldname === "key") {
          key = String(part.value);
        }
      }
      if (!key || !buf) return reply.code(400).send({ error: "Missing key or file." });
      const storage = await getStorage();
      await storage.put(key, buf);
      return reply.code(204).send();
    });
  }
}

function sendError(reply: any, err: unknown) {
  if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.message });
  reply.log.error(err);
  return reply.code(500).send({ error: "Internal error." });
}
