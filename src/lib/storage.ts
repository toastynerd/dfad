import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** A target the browser uploads the file to directly (S3 presigned POST, or a local endpoint). */
export interface UploadTarget {
  url: string;
  fields: Record<string, string>;
  method: "POST";
}

/** Blob storage for the raw HTML documents. */
export interface Storage {
  /** Create a direct-upload target for `key`, size-capped at `maxBytes`. */
  createUploadTarget(key: string, maxBytes: number): Promise<UploadTarget>;
  /** Object size in bytes, or null if it does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  /** First `n` bytes of the object (for content sniffing), or null if missing. */
  readRange(key: string, n: number): Promise<Buffer | null>;
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

  async createUploadTarget(key: string): Promise<UploadTarget> {
    // The browser POSTs the file (plus a "key" field) to the local upload endpoint,
    // mirroring the shape of an S3 presigned POST.
    return { url: "/api/upload", method: "POST", fields: { key } };
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const st = await fs.stat(this.pathFor(key));
      return { size: st.size };
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async readRange(key: string, n: number): Promise<Buffer | null> {
    const buf = await this.get(key);
    return buf ? buf.subarray(0, n) : null;
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
  private bucket = config.S3_BUCKET;
  constructor(
    private S3: typeof import("@aws-sdk/client-s3"),
    private client: import("@aws-sdk/client-s3").S3Client,
    private presign: typeof import("@aws-sdk/s3-presigned-post")
  ) {}

  async createUploadTarget(key: string, maxBytes: number): Promise<UploadTarget> {
    const { url, fields } = await this.presign.createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", "text/html"],
      ],
      Fields: { "Content-Type": "text/html" },
      Expires: 300,
    });
    return { url, fields, method: "POST" };
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const out = await this.client.send(
        new this.S3.HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return { size: out.ContentLength ?? 0 };
    } catch (err: any) {
      if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async readRange(key: string, n: number): Promise<Buffer | null> {
    try {
      const out = await this.client.send(
        new this.S3.GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` })
      );
      return Buffer.from(await out.Body!.transformToByteArray());
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
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
      return Buffer.from(await out.Body!.transformToByteArray());
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
    const presign = await import("@aws-sdk/s3-presigned-post");
    const client = new S3.S3Client({ region: config.AWS_REGION });
    _storage = new S3Storage(S3, client, presign);
  } else {
    _storage = new LocalStorage();
  }
  return _storage;
}

/** S3 object key for a deployment id. */
export function objectKey(id: string): string {
  return `apps/${id}.html`;
}
