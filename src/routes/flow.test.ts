import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Configure the local driver into a throwaway dir BEFORE importing app code
// (config.ts reads process.env at import time, so use dynamic import below).
const dataDir = path.join(os.tmpdir(), `dfad-test-${process.pid}`);
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_DATA_DIR = dataDir;
process.env.APPS_BASE_URL = "http://localhost:3000";
process.env.TTL_HOURS = "24";
process.env.RATE_LIMIT_MAX = "5";

let svc: typeof import("../lib/service.js");
let storageMod: typeof import("../lib/storage.js");

const HTML = "<!DOCTYPE html><html><body><h1>hello</h1></body></html>";

// Simulate the browser uploading directly to the storage target.
async function simulateUpload(id: string, content: string) {
  const storage = await storageMod.getStorage();
  await storage.put(storageMod.objectKey(id), Buffer.from(content));
}

before(async () => {
  svc = await import("../lib/service.js");
  storageMod = await import("../lib/storage.js");
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("deploy -> upload -> finalize -> serve", async () => {
  const { id, upload } = await svc.createDeployment("1.0.0.1");
  assert.match(id, /^[a-z0-9]+$/);
  assert.equal(upload.url, "/api/upload");
  assert.equal(upload.fields.key, `apps/${id}.html`);

  await simulateUpload(id, HTML);

  const fin = await svc.finalizeDeployment(id, "1.0.0.1");
  assert.equal(fin.url, `http://localhost:3000/a/${id}`);
  assert.ok(fin.expiresAt > Math.floor(Date.now() / 1000));

  const res = await svc.getApp(id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.body?.toString(), HTML);
});

test("finalize without an uploaded file is rejected", async () => {
  const { id } = await svc.createDeployment("1.0.0.2");
  await assert.rejects(() => svc.finalizeDeployment(id, "1.0.0.2"), (e: any) => e.status === 400);
});

test("finalize rejects non-html content and deletes the object", async () => {
  const { id } = await svc.createDeployment("1.0.0.3");
  await simulateUpload(id, "just plain text, not markup");
  await assert.rejects(() => svc.finalizeDeployment(id, "1.0.0.3"), (e: any) => e.status === 400);
  const storage = await storageMod.getStorage();
  assert.equal(await storage.head(storageMod.objectKey(id)), null);
});

test("expired deployment returns 410", async () => {
  const { id } = await svc.createDeployment("1.0.0.4");
  await simulateUpload(id, HTML);
  await svc.finalizeDeployment(id, "1.0.0.4");

  // Tamper with the metadata to simulate expiry (avoids waiting 24h).
  const metaFile = path.join(dataDir, "meta", `${id}.json`);
  const rec = JSON.parse(await fs.readFile(metaFile, "utf8"));
  rec.expiresAt = Math.floor(Date.now() / 1000) - 10;
  await fs.writeFile(metaFile, JSON.stringify(rec));

  const res = await svc.getApp(id);
  assert.equal(res.statusCode, 410);
});

test("unknown id returns 404", async () => {
  const res = await svc.getApp("doesnotexist");
  assert.equal(res.statusCode, 404);
});

test("rate limit kicks in after the configured max", async () => {
  // RATE_LIMIT_MAX=5; the 6th request from the same IP should be rejected.
  for (let i = 0; i < 5; i++) await svc.createDeployment("5.5.5.5");
  await assert.rejects(() => svc.createDeployment("5.5.5.5"), (e: any) => e.status === 429);
});

test("Fastify adapter wires /api/deploy and /a/:id", async () => {
  const { buildApp } = await import("../server.js");
  const app = await buildApp();
  await app.ready();
  try {
    const dep = await app.inject({ method: "POST", url: "/api/deploy" });
    assert.equal(dep.statusCode, 201);
    const { id, upload } = dep.json();
    assert.equal(upload.url, "/api/upload");

    await simulateUpload(id, HTML);
    const fin = await app.inject({
      method: "POST",
      url: "/api/finalize",
      payload: { id },
    });
    assert.equal(fin.statusCode, 201);

    const got = await app.inject({ method: "GET", url: `/a/${id}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.body, HTML);
  } finally {
    await app.close();
  }
});
