/**
 * Cloudflare R2 helper for storing GLBs.
 *
 * Replicate's signed URLs expire after 24 h, so we copy the GLB into our R2
 * bucket on success. R2 is S3-compatible — we use the AWS SDK style endpoint
 * but only the lightweight fetch-based subset (no boto3 / aws-sdk).
 *
 * Bucket needs public access (or a Worker proxy) for direct GLB URLs.
 */

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID!;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const BUCKET = process.env.R2_BUCKET ?? 'myfabmesh-meshes';
const PUBLIC_URL = process.env.R2_PUBLIC_URL ?? '';

/**
 * Stream a remote GLB into R2 and return the public URL.
 * Skips if env vars are missing (returns the source URL).
 */
export async function uploadGlbToR2(sourceUrl: string, key: string): Promise<string> {
  if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY || !PUBLIC_URL) {
    return sourceUrl;
  }

  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
  const body = await res.arrayBuffer();

  const endpoint = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${key}`;
  const date = new Date().toUTCString();
  const auth = await signRequest('PUT', endpoint, body, date);

  const put = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Authorization': auth,
      'Date': date,
      'Content-Type': 'model/gltf-binary',
      'Content-Length': String(body.byteLength),
    },
    body,
  });
  if (!put.ok) throw new Error(`R2 upload failed: ${put.status} ${await put.text()}`);
  return `${PUBLIC_URL}/${key}`;
}

/**
 * AWS Signature V4 for R2. R2 expects `us-east-1` region and `s3` service.
 * Inlined here so we don't pull in @aws-sdk (15 MB).
 */
async function signRequest(method: string, url: string, body: ArrayBuffer, date: string): Promise<string> {
  const u = new URL(url);
  const region = 'auto';
  const service = 's3';
  const amzDate = new Date(date).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(body);
  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `${method}\n${u.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = 'AWS4-HMAC-SHA256';
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credScope}\n${await sha256Hex(new TextEncoder().encode(canonical))}`;

  const kDate = await hmac(`AWS4${SECRET_KEY}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = bufferToHex(await hmac(kSigning, stringToSign));

  return `${algorithm} Credential=${ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function sha256Hex(input: ArrayBuffer | Uint8Array): Promise<string> {
  const data: ArrayBuffer = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
    : input;
  const h = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(h);
}

async function hmac(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
