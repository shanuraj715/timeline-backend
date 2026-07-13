import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

let client;
function getClient() {
  if (client) return client;
  client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

function bucket() {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("Missing S3_BUCKET environment variable for STORAGE_DRIVER=s3");
  return b;
}

async function write(key, buffer) {
  await getClient().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer })
  );
}

async function read(key) {
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function exists(key) {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function stat(key) {
  const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  return { size: head.ContentLength };
}

async function remove(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/**
 * @param {string} key
 * @param {{ start: number, end: number } | null} range
 */
async function createReadStream(key, range = null) {
  const { size } = await stat(key);

  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, size - 1) : size - 1;

  const res = await getClient().send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      Range: `bytes=${start}-${end}`,
    })
  );

  return { stream: res.Body, size, start, end };
}

export const s3Driver = { write, read, exists, remove, stat, createReadStream };
