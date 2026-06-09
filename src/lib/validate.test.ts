import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUpload, looksLikeHtml, hasHtmlExtension } from "./validate.js";

const MAX = 5 * 1024 * 1024;

test("accepts a normal html file", () => {
  const buf = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>");
  assert.deepEqual(validateUpload({ buf, filename: "app.html", maxBytes: MAX }), { ok: true });
});

test("accepts pasted html with no filename", () => {
  const buf = Buffer.from("<html><head></head><body>x</body></html>");
  assert.deepEqual(validateUpload({ buf, maxBytes: MAX }), { ok: true });
});

test("rejects empty file", () => {
  const r = validateUpload({ buf: Buffer.alloc(0), filename: "a.html", maxBytes: MAX });
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 400);
});

test("rejects oversize file", () => {
  const buf = Buffer.from("<html>" + "x".repeat(20) + "</html>");
  const r = validateUpload({ buf, filename: "a.html", maxBytes: 10 });
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 413);
});

test("rejects non-html extension", () => {
  const buf = Buffer.from("<html></html>");
  const r = validateUpload({ buf, filename: "app.txt", maxBytes: MAX });
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 400);
});

test("rejects content that is not html", () => {
  const buf = Buffer.from("just some plain text, definitely not markup");
  const r = validateUpload({ buf, filename: "app.html", maxBytes: MAX });
  assert.equal(r.ok, false);
});

test("looksLikeHtml handles leading whitespace and case", () => {
  assert.ok(looksLikeHtml(Buffer.from("   \n  <!DOCTYPE HTML>")));
  assert.ok(looksLikeHtml(Buffer.from("<HTML>")));
  assert.ok(!looksLikeHtml(Buffer.from("plain text")));
});

test("hasHtmlExtension", () => {
  assert.ok(hasHtmlExtension("a.html"));
  assert.ok(hasHtmlExtension("a.HTM"));
  assert.ok(!hasHtmlExtension("a.js"));
  assert.ok(!hasHtmlExtension(undefined));
});
