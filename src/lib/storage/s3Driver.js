import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "stream";

/**
 * Factory instead of a module-level singleton — the app can now have
 * several S3-compatible providers configured at once (e.g. mid-migration
 * from S3 to R2), each needing its own client/credentials/bucket. `config`
 * covers both real AWS S3 (leave endpoint/forcePathStyle unset) and any
 * S3-compatible provider like Cloudflare R2 or MinIO (set endpoint,
 * usually with forcePathStyle: true).
 *
 * @param {{ region?: string, endpoint?: string, forcePathStyle?: boolean, accessKeyId: string, secretAccessKey: string, bucket: string }} config
 */
export function createS3Driver(config) {
  const client = new S3Client({
    region: config.region || "auto",
    endpoint: config.endpoint || undefined,
    forcePathStyle: Boolean(config.forcePathStyle),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const bucket = config.bucket;

  async function write(key, buffer) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer }));
  }

  /** Streams an upload without buffering the whole file in memory — used by storage migrations moving large videos between providers. */
  async function writeStream(key, readable) {
    const upload = new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: readable },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
  }

  async function read(key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async function exists(key) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function stat(key) {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: head.ContentLength };
  }

  async function remove(key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * @param {string} key
   * @param {{ start: number, end: number } | null} range
   */
  async function createReadStream(key, range = null) {
    const { size } = await stat(key);

    // See localDriver.js's identical guard — an empty object has no valid
    // byte range, and S3 rejects a "bytes=0--1" Range header outright.
    if (size === 0) {
      return { stream: Readable.from([]), size: 0, start: 0, end: 0 };
    }

    const start = range ? range.start : 0;
    const end = range ? Math.min(range.end, size - 1) : size - 1;

    const res = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
      })
    );

    return { stream: res.Body, size, start, end };
  }

  /**
   * Paginated listing for migrations/orphan scans — a bucket with hundreds
   * of thousands of objects can't be listed in one call, so this returns
   * one page (default 1000, S3's own max) plus a cursor to pass back in for
   * the next page.
   * @param {{ cursor?: string | null, limit?: number }} options
   * @returns {Promise<{ items: { key: string, size: number }[], cursor: string | null }>}
   */
  async function list({ cursor = null, limit = 1000 } = {}) {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: limit,
        ContinuationToken: cursor || undefined,
      })
    );
    const items = (res.Contents || []).map((obj) => ({ key: obj.Key, size: obj.Size || 0 }));
    return { items, cursor: res.IsTruncated ? res.NextContinuationToken : null };
  }

  return { write, writeStream, read, exists, remove, stat, createReadStream, list };
}
