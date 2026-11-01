// Object storage client (MinIO / any S3-compatible service).
//
// Stores and serves the original reference files behind the knowledge base —
// guideline PDFs, book chapters, position stands, and any uploaded documents.
// The vector index (`@fa/db_qdrant`) holds the *derived* text + embeddings; the
// authoritative *binary* lives here, addressed by a stable object key, and is
// served to users for citations.
//
// Mirrors the other db_* packages: a lazily-built singleton, env-driven config,
// small read/write helpers. Nothing is created at import time.

import { Client as MinioClient } from "minio";
import { logger } from "@fa/logger";

const log = logger.child({ mod: "storage" });

// Env config (compose sets the internal host; .env sets credentials):
//   S3_ENDPOINT  (default "localhost")   S3_PORT (default 9000)
//   S3_USE_SSL   (default "false")
//   S3_ACCESS_KEY / S3_SECRET_KEY
//   S3_BUCKET    (default "fa-knowledge")
//   S3_PUBLIC_BASE_URL  optional — when MinIO is reachable directly from the
//                       browser (CDN / public bucket), build URLs against it;
//                       otherwise files are served through the app (/files/*).
export function bucketName(): string {
  return process.env.S3_BUCKET || "fa-knowledge";
}

let _client: MinioClient | null = null;
export function storage(): MinioClient {
  if (!_client) {
    _client = new MinioClient({
      endPoint: process.env.S3_ENDPOINT || "localhost",
      port: Number(process.env.S3_PORT || 9000),
      useSSL: (process.env.S3_USE_SSL || "false") === "true",
      accessKey: process.env.S3_ACCESS_KEY || "minioadmin",
      secretKey: process.env.S3_SECRET_KEY || "minioadmin",
    });
  }
  return _client;
}

// Create the bucket if missing. Cached per-process. Safe to call on any write.
let _ensured = false;
export async function ensureBucket(): Promise<void> {
  if (_ensured) return;
  const client = storage();
  const bucket = bucketName();
  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucket);
    log.info("bucket created", { bucket });
  }
  _ensured = true;
}

// Upload bytes under `key` with a content type. Returns the key. Re-uploading
// the same key overwrites in place.
export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<string> {
  await ensureBucket();
  const buf = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  await storage().putObject(bucketName(), key, buf, buf.length, {
    "Content-Type": contentType,
  });
  log.debug("put object", { key, bytes: buf.length, contentType });
  return key;
}

export type StoredObject = { bytes: Uint8Array; contentType: string; size: number };

// Read an object fully into memory along with its content type. Throws if the
// key doesn't exist (caller maps to a 404).
export async function getObject(key: string): Promise<StoredObject> {
  const client = storage();
  const bucket = bucketName();
  const stat = await client.statObject(bucket, key);
  const stream = await client.getObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    contentType: (stat.metaData?.["content-type"] as string) || "application/octet-stream",
    size: stat.size,
  };
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await storage().statObject(bucketName(), key);
    return true;
  } catch {
    return false;
  }
}

export async function removeObject(key: string): Promise<void> {
  await storage().removeObject(bucketName(), key);
}

// A time-limited direct URL to the object (default 1h). Only useful when the
// MinIO endpoint is reachable by the client; for app-proxied serving use
// publicUrl() instead.
export async function presignGet(key: string, expirySeconds = 3600): Promise<string> {
  return storage().presignedGetObject(bucketName(), key, expirySeconds);
}

// The URL to put in a citation. Prefer a configured public base (CDN / public
// bucket); otherwise serve through the app's /files route.
export function publicUrl(key: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/+$/, "")}/${key}`;
  const app = (process.env.PUBLIC_BASE_URL || process.env.FRONTEND_ORIGIN || "").replace(
    /\/+$/,
    "",
  );
  return `${app}/files/${key}`;
}
