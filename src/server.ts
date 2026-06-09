import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { homeRoutes } from "./routes/home.js";
import { deployRoutes } from "./routes/deploy.js";
import { serveRoutes } from "./routes/serve.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
    bodyLimit: config.MAX_BYTES + 1024, // headroom for JSON envelope around pasted HTML
  });

  await app.register(rateLimit, {
    global: false, // opt-in per route (only uploads are limited)
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
  });

  await app.register(multipart, {
    limits: { fileSize: config.MAX_BYTES, files: 1 },
  });

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(homeRoutes);
  await app.register(deployRoutes);
  await app.register(serveRoutes);

  return app;
}

// Start only when run directly (not when imported by tests). Compare paths with the
// extension stripped, since tsx maps a requested ".js" entry onto this ".ts" source.
const stripExt = (p: string) => p.replace(/\.[tj]s$/, "");
const isMain =
  !!process.argv[1] &&
  stripExt(fileURLToPath(import.meta.url)) === stripExt(path.resolve(process.argv[1]));
if (isMain) {
  buildApp()
    .then((app) => app.listen({ port: config.PORT, host: config.HOST }))
    .then((addr) => {
      console.log(`dfad listening on ${addr} (storage=${config.STORAGE_DRIVER})`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
