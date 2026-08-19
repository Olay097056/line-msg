// Shared plumbing for the Vercel API routes: env access, auth gates, and the
// two response shapes.
//
// Two independent gates exist on purpose (ticket 03 หมวด C):
//   * requireSession — the human control panel, password-backed
//   * requireCronSecret — the pg_cron tick, shared-secret-backed
// The Vercel deployment is public (ticket 02 found Deployment Protection blocks
// pg_net), so these gates are the only protection.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import { Db, type DbLike } from './db.js';
import { Db as D1Db, type D1Binding } from './d1.js';
import { LineClient } from './line.js';
import { getCfEnv } from './cf-env.js';

export const SESSION_COOKIE = 'lmv2_session';

export function env(name: string): string {
  // Cloudflare Pages Functions: bindings come from context.env (set via the
  // adapter into cf-env). Fall back to process.env (Vercel + node tests).
  const cf = getCfEnv();
  if (cf) {
    const v = cf[name];
    if (v != null && v !== '') return String(v);
    throw new Error(`missing env ${name}`);
  }
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export function deps(): { db: DbLike; line: LineClient } {
  const cf = getCfEnv();
  if (cf) {
    // D1 migration path: use the D1 client bound to the Cloudflare database.
    return {
      db: new D1Db(cf.DB as D1Binding),
      line: new LineClient(env('LINE_CHANNEL_ACCESS_TOKEN')),
    };
  }
  return {
    db: new Db(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY')),
    line: new LineClient(env('LINE_CHANNEL_ACCESS_TOKEN')),
  };
}

export function json(res: any, status: number, body: unknown) {
  res.status(status).json(body);
}

/** Constant-time compare that also tolerates length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------------ session
// The cookie carries an HMAC of the stored password hash. Changing the password
// therefore invalidates every existing session for free. No Max-Age/Expires is
// set, so the browser drops it on close (ticket 03 หมวด C).

function sign(payload: string): string {
  return crypto.createHmac('sha256', env('SESSION_SECRET')).update(payload).digest('hex');
}

export function sessionValue(passwordHash: string): string {
  return sign(`v1:${passwordHash}`);
}

export function setSessionCookie(res: any, value: string) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`,
  );
}

export function clearSessionCookie(res: any) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

function readCookie(req: any, name: string): string | null {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function storedPasswordHash(db: DbLike): Promise<string | null> {
  const rows = await db.select('app_settings', 'select=value&key=eq.admin_password_hash');
  return rows[0]?.value ?? null;
}

export async function verifyPassword(db: DbLike, password: string): Promise<string | null> {
  const hash = await storedPasswordHash(db);
  if (!hash) return null;
  return (await bcrypt.compare(password, hash)) ? hash : null;
}

/** Returns true when the request carries a valid session cookie. */
export async function hasSession(req: any, db: DbLike): Promise<boolean> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return false;
  const hash = await storedPasswordHash(db);
  if (!hash) return false;
  return safeEqual(cookie, sessionValue(hash));
}

/** Gate for control-panel routes. Writes the 401 itself and returns false. */
export async function requireSession(req: any, res: any, db: DbLike): Promise<boolean> {
  if (await hasSession(req, db)) return true;
  json(res, 401, { error: 'ต้องเข้าสู่ระบบก่อน' });
  return false;
}

/** Gate for the pg_cron tick. Accepts the secret as a header or bearer token. */
export function requireCronSecret(req: any, res: any): boolean {
  const expected = env('CRON_SECRET');
  const header = String(req.headers?.['x-cron-secret'] ?? '');
  const auth = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
  if ((header && safeEqual(header, expected)) || (auth && safeEqual(auth, expected))) return true;
  json(res, 401, { error: 'bad cron secret' });
  return false;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
