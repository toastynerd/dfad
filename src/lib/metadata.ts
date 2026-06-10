import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface Deployment {
  id: string;
  s3Key: string;
  createdAt: number; // epoch seconds
  expiresAt: number; // epoch seconds (DynamoDB TTL attribute)
  size: number; // bytes
  ipHash: string; // salted hash of uploader IP (abuse triage)
}

/** Metadata store for deployment records. */
export interface MetadataStore {
  put(d: Deployment): Promise<void>;
  get(id: string): Promise<Deployment | null>;
  delete(id: string): Promise<void>;
  /**
   * Atomically increment a per-IP counter for the current time window and return
   * the new count. Used for upload rate limiting; the item self-expires via TTL.
   */
  incrementRate(ipHash: string, windowSeconds: number): Promise<number>;
}

function rateKey(ipHash: string, windowSeconds: number, nowSec: number): string {
  return `rl#${ipHash}#${Math.floor(nowSec / windowSeconds)}`;
}

// ---- Local JSON driver (dev / no AWS) ----
class LocalMetadata implements MetadataStore {
  private dir = path.resolve(config.LOCAL_DATA_DIR, "meta");

  private pathFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async put(d: Deployment): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(d.id), JSON.stringify(d), "utf8");
  }

  async get(id: string): Promise<Deployment | null> {
    try {
      const raw = await fs.readFile(this.pathFor(id), "utf8");
      return JSON.parse(raw) as Deployment;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(id));
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  // In-memory window counter (single-process dev only).
  private rates = new Map<string, number>();
  async incrementRate(ipHash: string, windowSeconds: number): Promise<number> {
    const key = rateKey(ipHash, windowSeconds, Math.floor(Date.now() / 1000));
    const next = (this.rates.get(key) ?? 0) + 1;
    this.rates.set(key, next);
    return next;
  }
}

// ---- DynamoDB driver ----
class DynamoMetadata implements MetadataStore {
  private table = config.DYNAMODB_TABLE;
  private lib: typeof import("@aws-sdk/lib-dynamodb");
  private doc: import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

  constructor(
    lib: typeof import("@aws-sdk/lib-dynamodb"),
    doc: import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient
  ) {
    this.lib = lib;
    this.doc = doc;
  }

  async put(d: Deployment): Promise<void> {
    await this.doc.send(new this.lib.PutCommand({ TableName: this.table, Item: d }));
  }

  async get(id: string): Promise<Deployment | null> {
    const out = await this.doc.send(
      new this.lib.GetCommand({ TableName: this.table, Key: { id } })
    );
    return (out.Item as Deployment | undefined) ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.doc.send(new this.lib.DeleteCommand({ TableName: this.table, Key: { id } }));
  }

  async incrementRate(ipHash: string, windowSeconds: number): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const id = rateKey(ipHash, windowSeconds, now);
    const out = await this.doc.send(
      new this.lib.UpdateCommand({
        TableName: this.table,
        Key: { id },
        UpdateExpression: "ADD #c :one SET expiresAt = if_not_exists(expiresAt, :exp)",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":one": 1, ":exp": now + windowSeconds * 2 },
        ReturnValues: "UPDATED_NEW",
      })
    );
    return Number(out.Attributes?.count ?? 1);
  }
}

let _store: MetadataStore | null = null;

/** Lazily construct the configured metadata store. */
export async function getMetadata(): Promise<MetadataStore> {
  if (_store) return _store;
  if (config.STORAGE_DRIVER === "s3") {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const lib = await import("@aws-sdk/lib-dynamodb");
    const doc = lib.DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: config.AWS_REGION })
    );
    _store = new DynamoMetadata(lib, doc);
  } else {
    _store = new LocalMetadata();
  }
  return _store;
}
