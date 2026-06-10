import { readFileSync } from "node:fs";
import path from "node:path";
import { createDeployment, finalizeDeployment, getApp, ServiceError } from "./lib/service.js";

// index.html is bundled next to the handler in the deployment package.
const INDEX_HTML = readFileSync(path.join(__dirname, "index.html"), "utf8");

interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

function clientIp(headers: Record<string, string | undefined>): string | undefined {
  const xff = headers["x-forwarded-for"];
  return xff ? xff.split(",")[0]!.trim() : undefined;
}

function text(statusCode: number, headers: Record<string, string>, body: string): ProxyResponse {
  return { statusCode, headers, body };
}

function json(statusCode: number, obj: unknown): ProxyResponse {
  return text(statusCode, { "content-type": "application/json" }, JSON.stringify(obj));
}

async function route(event: any): Promise<ProxyResponse> {
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
    return json(200, { ok: true });
  }

  // Serve a deployed app.
  const appMatch = rawPath.match(/^\/a\/([^/]+)$/);
  if (method === "GET" && appMatch) {
    const res = await getApp(decodeURIComponent(appMatch[1]!));
    return text(res.statusCode, res.headers, res.body ? res.body.toString("utf8") : res.text ?? "");
  }

  // Step 1: mint id + upload target.
  if (method === "POST" && rawPath === "/api/deploy") {
    return json(201, await createDeployment(clientIp(headers)));
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
    return json(201, await finalizeDeployment(id, clientIp(headers)));
  }

  // Upload UI (root). On the apps host, bounce root back to the main site.
  if (method === "GET" && (rawPath === "/" || rawPath === "/index.html")) {
    const host = (headers["host"] ?? "").toLowerCase();
    if (host.startsWith("apps.")) {
      return text(302, { location: "https://" + host.replace(/^apps\./, "") }, "");
    }
    return text(200, { "content-type": "text/html; charset=utf-8" }, INDEX_HTML);
  }

  return text(404, { "content-type": "text/plain" }, "Not found.");
}

export const handler = async (event: any): Promise<ProxyResponse> => {
  try {
    return await route(event);
  } catch (err) {
    const status = err instanceof ServiceError ? err.status : 500;
    const message = err instanceof ServiceError ? err.message : "Internal error.";
    if (!(err instanceof ServiceError)) console.error(err);
    return json(status, { error: message });
  }
};
