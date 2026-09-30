// Uploads the External Dynamic Lists to S3 with a SigV4 presigned PUT. The signature travels in the
// query string because the platform proxy strips any Authorization header set by app code.

import type { AppConfig } from '../../shared/types.js';
import { hmacSha256, sha256, toHex, utf8 } from './sha256.js';

/** RFC 3986 encoding as SigV4 requires. */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp: iso, date: iso.slice(0, 8) };
}

export function presignPut(cfg: AppConfig, secretKey: string, key: string, now = new Date()): string {
  const { region, bucket, accessKeyId } = cfg.s3;
  const host = `s3.${region}.amazonaws.com`;
  const path = `/${enc(bucket)}/${key.split('/').map(enc).join('/')}`;
  const { date, stamp } = amzDate(now);
  const scope = `${date}/${region}/s3/aws4_request`;

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');

  const canonicalRequest = ['PUT', path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, toHex(sha256(utf8(canonicalRequest)))].join('\n');

  let signingKey = hmacSha256(utf8(`AWS4${secretKey}`), utf8(date));
  for (const part of [region, 's3', 'aws4_request']) signingKey = hmacSha256(signingKey, utf8(part));
  const signature = toHex(hmacSha256(signingKey, utf8(stringToSign)));

  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export async function putObject(cfg: AppConfig, secretKey: string, key: string, body: string): Promise<void> {
  const res = await fetch(presignPut(cfg, secretKey, key), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body,
  });
  if (!res.ok) throw new Error(`S3 upload of ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}
