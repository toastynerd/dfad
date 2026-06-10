import type { FastifyInstance } from "fastify";
import { getApp } from "../lib/service.js";

/**
 * GET /a/:id — serve a deployed app. Expiry is enforced exactly at read time
 * (410 once past expiresAt) regardless of TTL/lifecycle deletion lag.
 */
export async function serveRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/a/:id", async (req, reply) => {
    const res = await getApp(req.params.id);
    for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
    return reply.code(res.statusCode).send(res.body ?? res.text ?? "");
  });
}
