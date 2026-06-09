import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "../public/index.html");

/** GET / — the upload UI. */
export async function homeRoutes(app: FastifyInstance): Promise<void> {
  const html = await fs.readFile(indexPath, "utf8");
  app.get("/", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
