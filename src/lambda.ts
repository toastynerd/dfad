import { readFileSync } from "node:fs";
import path from "node:path";
import { createDeployment, finalizeDeployment, getApp, ServiceError } from "./lib/service.js";

// `awslambda` is an ambient global provided by the Lambda Node.js runtime.
declare const awslambda: {
  streamifyResponse(
    handler: (event: any, responseStream: any, context: any) => Promise<void>
  ): unknown;
  HttpResponseStream: {
    from(stream: any, metadata: { statusCode: number; headers?: Record<string, string> }): any;
  };
};

// index.html is bundled next to the handler in the deployment package.
const INDEX_HTML = readFileSync(path.join(__dirname, "index.html"), "utf8");

function clientIp(headers: Record<string, string | undefined>): string | undefined {
  const xff = headers["x-forwarded-for"];
  return xff ? xff.split(",")[0]!.trim() : undefined;
}

function write(
  responseStream: any,
  statusCode: number,
  headers: Record<string, string>,
  body: Buffer | string
): void {
  const s = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers });
  s.write(body);
  s.end();
}

function json(responseStream: any, statusCode: number, obj: unknown): void {
  write(responseStream, statusCode, { "content-type": "application/json" }, JSON.stringify(obj));
}

async function route(event: any, responseStream: any): Promise<void> {
  const method: string = event.requestContext?.http?.method ?? "GET";
  const rawPath: string = event.rawPath ?? "/";
  const headers: Record<string, string | undefined> = event.headers ?? {};
  const body: string | undefined = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : undefined;

  // Health check.
  if (method === "GET" && rawPath === "/healthz") {
    return json(responseStream, 200, { ok: true });
  }

  // Serve a deployed app.
  const appMatch = rawPath.match(/^\/a\/([^/]+)$/);
  if (method === "GET" && appMatch) {
    const res = await getApp(decodeURIComponent(appMatch[1]!));
    return write(responseStream, res.statusCode, res.headers, res.body ?? res.text ?? "");
  }

  // Step 1: mint id + upload target.
  if (method === "POST" && rawPath === "/api/deploy") {
    const out = await createDeployment(clientIp(headers));
    return json(responseStream, 201, out);
  }

  // Step 3: finalize after the browser uploaded to S3.
  if (method === "POST" && rawPath === "/api/finalize") {
    let id: unknown;
    try {
      id = JSON.parse(body ?? "{}").id;
    } catch {
      throw new ServiceError(400, "Invalid JSON body.");
    }
    if (typeof id !== "string") throw new ServiceError(400, "Missing id.");
    const out = await finalizeDeployment(id, clientIp(headers));
    return json(responseStream, 201, out);
  }

  // Upload UI (root). On the apps host, bounce root back to the main site.
  if (method === "GET" && (rawPath === "/" || rawPath === "/index.html")) {
    const host = (headers["host"] ?? "").toLowerCase();
    if (host.startsWith("apps.")) {
      return write(responseStream, 302, { location: "https://" + host.replace(/^apps\./, "") }, "");
    }
    return write(responseStream, 200, { "content-type": "text/html; charset=utf-8" }, INDEX_HTML);
  }

  return write(responseStream, 404, { "content-type": "text/plain" }, "Not found.");
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  try {
    await route(event, responseStream);
  } catch (err) {
    const status = err instanceof ServiceError ? err.status : 500;
    const message = err instanceof ServiceError ? err.message : "Internal error.";
    if (!(err instanceof ServiceError)) console.error(err);
    json(responseStream, status, { error: message });
  }
});
