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

let app: Awaited<ReturnType<typeof import("../server.js")["buildApp"]>>;

before(async () => {
  const { buildApp } = await import("../server.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const HTML = "<!DOCTYPE html><html><body><h1>hello</h1></body></html>";

test("deploy via JSON then serve", async () => {
  const dep = await app.inject({
    method: "POST",
    url: "/api/deploy",
    payload: { html: HTML },
  });
  assert.equal(dep.statusCode, 201);
  const body = dep.json();
  assert.match(body.url, /\/a\/[a-z0-9]+$/);
  assert.ok(body.expiresAt > Math.floor(Date.now() / 1000));

  const id = body.id;
  const got = await app.inject({ method: "GET", url: `/a/${id}` });
  assert.equal(got.statusCode, 200);
  assert.match(got.headers["content-type"] as string, /text\/html/);
  assert.equal(got.headers["x-content-type-options"], "nosniff");
  assert.equal(got.body, HTML);
});

test("rejects non-html JSON", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/deploy",
    payload: { html: "this is just text" },
  });
  assert.equal(res.statusCode, 400);
});

test("missing body is rejected", async () => {
  const res = await app.inject({ method: "POST", url: "/api/deploy", payload: {} });
  assert.equal(res.statusCode, 400);
});

test("expired deployment returns 410", async () => {
  const dep = await app.inject({
    method: "POST",
    url: "/api/deploy",
    payload: { html: HTML },
  });
  const { id } = dep.json();

  // Tamper with the metadata to simulate expiry (avoids waiting 24h).
  const metaFile = path.join(dataDir, "meta", `${id}.json`);
  const rec = JSON.parse(await fs.readFile(metaFile, "utf8"));
  rec.expiresAt = Math.floor(Date.now() / 1000) - 10;
  await fs.writeFile(metaFile, JSON.stringify(rec));

  const got = await app.inject({ method: "GET", url: `/a/${id}` });
  assert.equal(got.statusCode, 410);
});

test("unknown id returns 404", async () => {
  const got = await app.inject({ method: "GET", url: "/a/doesnotexist" });
  assert.equal(got.statusCode, 404);
});
