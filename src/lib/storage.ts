import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Blob storage for the raw HTML documents. */
export interface Storage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

// ---- Local disk driver (dev / no AWS) ----
class LocalStorage implements Storage {
  private dir = path.resolve(config.LOCAL_DATA_DIR, "objects");

  private pathFor(key: string): string {
    // Flatten the key so "apps/<id>.html" maps to a single safe filename.
    return path.join(this.dir, key.replace(/[/\\]/g, "__"));
  }

  async put(key: string, body: Buffer): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.pathFor(key), body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
}

// ---- S3 driver ----
class S3Storage implements Storage {
  private client: import("@aws-sdk/client-s3").S3Client;
  private bucket = config.S3_BUCKET;
  private S3: typeof import("@aws-sdk/client-s3");

  constructor(
    S3: typeof import("@aws-sdk/client-s3"),
    client: import("@aws-sdk/client-s3").S3Client
  ) {
    this.S3 = S3;
    this.client = client;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new this.S3.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "text/html; charset=utf-8",
      })
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(
        new this.S3.GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const bytes = await out.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new this.S3.DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }
}

let _storage: Storage | null = null;

/** Lazily construct the configured storage driver (S3 SDK only loaded when needed). */
export async function getStorage(): Promise<Storage> {
  if (_storage) return _storage;
  if (config.STORAGE_DRIVER === "s3") {
    const S3 = await import("@aws-sdk/client-s3");
    const client = new S3.S3Client({ region: config.AWS_REGION });
    _storage = new S3Storage(S3, client);
  } else {
    _storage = new LocalStorage();
  }
  return _storage;
}

/** S3 object key for a deployment id. */
export function objectKey(id: string): string {
  return `apps/${id}.html`;
}
