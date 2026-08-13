// POST /api/webhook — LINE calls this when the bot joins/leaves a group or
// group membership changes (ticket 09).
//
// bodyParser is OFF: signature verification needs the exact raw bytes LINE
// sent, and Vercel's automatic JSON parsing would re-serialize the body,
// producing different bytes (whitespace/key order) that break the HMAC check.

import { deps, env, json } from '../lib/http.js';
import { verifySignature, handleWebhook, type WebhookBody } from '../lib/webhook.js';

export const config = { api: { bodyParser: false } };

function readRawBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const raw = await readRawBody(req);
  const signature = req.headers['x-line-signature'];
  const { db, line } = deps();

  if (!verifySignature(raw, signature, env('LINE_CHANNEL_SECRET'))) {
    await db.log('warn', 'webhook_bad_signature', { hasSignature: !!signature });
    return json(res, 401, { error: 'bad signature' });
  }

  let body: WebhookBody;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    // Signature was valid but the body is not JSON — malformed, not malicious.
    // Still 200 so LINE does not retry a payload that will never parse.
    return json(res, 200, { handled: 0 });
  }

  // Respond 200 as soon as the signature and shape are good; processing
  // failures inside individual events are logged, never surfaced as a retry
  // trigger (ticket 09: "ตอบ 200 ให้ LINE เสมอเมื่อ signature ผ่าน").
  const result = await handleWebhook({ db, line }, body);
  return json(res, 200, result);
}
