// Cloudflare Pages Function bindings — env seam for the D1 migration.
//
// The Vercel handlers read env via process.env and build deps() from
// SUPABASE_URL/SERVICE_ROLE_KEY in lib/http.ts. On Cloudflare Pages Functions,
// bindings arrive as context.env (D1 binding + secrets), not process.env.
//
// This module holds the current invocation's bindings so lib/http.ts env() and
// deps() can route to the D1 client when running on Cloudflare, and fall back
// to the PostgREST path otherwise (Vercel prod + node tests).
//
// Imported by the Pages Functions adapter; NOT part of the Vercel build path.

export interface CfEnv {
  DB: unknown; // D1Database binding
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  CRON_SECRET: string;
  SESSION_SECRET: string;
  [key: string]: unknown;
}

let current: CfEnv | null = null;

export function setCfEnv(e: CfEnv | null): void {
  current = e;
}

export function getCfEnv(): CfEnv | null {
  return current;
}
