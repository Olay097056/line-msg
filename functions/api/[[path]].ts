// Cloudflare Pages Functions catchall — /api/* →
// adapts Cloudflare's onRequest context into the Vercel-style (req, res) the
// existing handlers in api/*.ts expect, then calls the matched handler.
//
// This keeps the handler logic 100% unchanged; only the transport wrapper
// differs. Route name → file in api/. Set the CF bindings on the env seam so
// lib/http.ts deps()/env() route to D1 instead of PostgREST.
//
// Pages Functions route: FILE functions/api/[[path]].ts  → matches /api/<segments>

import { setCfEnv, getCfEnv, type CfEnv } from '../../lib/cf-env.js';
import { deps } from '../../lib/http.js';
import { runTick } from '../../lib/send.js';

// Map of route → default handler from api/*.ts (transpiled to .js in dist, but
// Pages Functions bundles TS natively, so import the .ts source).
import loginHandler from '../../api/login.js';
import stateHandler from '../../api/state.js';
import sendHandler from '../../api/send.js';
import schedulesHandler from '../../api/schedules.js';
import groupsHandler from '../../api/groups.js';
import messageHandler from '../../api/message.js';
import logsHandler from '../../api/logs.js';
import tickHandler from '../../api/tick.js';
import webhookHandler from '../../api/webhook.js';

const ROUTES: Record<string, { handler: any; rawBody?: boolean }> = {
  login: { handler: loginHandler },
  state: { handler: stateHandler },
  send: { handler: sendHandler },
  schedules: { handler: schedulesHandler },
  groups: { handler: groupsHandler },
  message: { handler: messageHandler },
  logs: { handler: logsHandler },
  tick: { handler: tickHandler },
  webhook: { handler: webhookHandler, rawBody: true },
};

type CfRequest = Request;
type CfContext = {
  request: CfRequest;
  env: CfEnv & Record<string, unknown>;
  params: { path?: string[] };
};

/** Build a Vercel-style response target that collects status/headers/body. */
function makeRes() {
  let _status = 200;
  let _last: Response | null = null;
  const headers: Record<string, string> = {};
  return {
    status(n: number) {
      _status = n;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
      return this;
    },
    json(body: unknown) {
      // Vercel's res.json() sends immediately and the api handlers call
      // json() without returning it, so we must capture the Response here
      // and let the adapter emit it.
      _last = new Response(JSON.stringify(body), {
        status: _status,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
      return _last;
    },
    get statusCode() {
      return _status;
    },
    get last() {
      return _last;
    },
  };
}

/** Headers -> plain object (works across DOM/Node Headers variants). */
function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof h.forEach === 'function') h.forEach((v, k) => (out[k] = v));
  return out;
}

async function readRawBody(request: CfRequest): Promise<string> {
  return await request.text();
}

export async function onRequest(context: CfContext): Promise<Response> {
  setCfEnv({ ...context.env });
  try {
    return await handle(context);
  } finally {
    setCfEnv(null);
  }
}

async function handle(context: CfContext): Promise<Response> {
    const { request } = context;
    const route = (context.params?.path ?? []).join('/');
    const entry = ROUTES[route];
    if (!entry) return new Response(JSON.stringify({ error: `no route ${route}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    const url = new URL(request.url);
    const method = request.method;

    // req shim in Vercel shape
    const req = {
      method,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: headersToObject(request.headers),
      body: undefined as unknown,
    };

    if (method !== 'GET' && method !== 'DELETE') {
      const raw = await readRawBody(request);
      if (entry.rawBody) {
        // webhook handler streams raw bytes via req.on('data'/'end'); emulate
        // that with a tiny event emitter so the handler reads the raw body.
        const listeners: Record<string, Array<(x?: unknown) => void>> = {};
        (req as any).on = (ev: string, fn: (x?: unknown) => void) => {
          (listeners[ev] ??= []).push(fn);
          return req;
        };
        (req as any)._emit = (ev: string, val?: unknown) => {
          for (const fn of listeners[ev] ?? []) fn(val);
        };
        queueMicrotask(() => {
          (req as any)._emit('data', Buffer.from(raw));
          (req as any)._emit('end');
        });
        (req as any).rawBody = raw;
      } else {
        req.body = raw ? JSON.parse(raw) : {};
      }
    } else if (entry.rawBody) {
      (req as any).rawBody = await readRawBody(request);
    }

    const res = makeRes();
    let handlerRes: unknown;
    try {
      handlerRes = await entry.handler(req, res);
    } catch (e) {
      // Log the real error server-side; return a clean 500 to the client.
      console.error('api handler error:', e);
      return new Response(JSON.stringify({ error: 'internal' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // api handlers call json() WITHOUT returning it (Vercel res.json sends
    // immediately), so prefer the captured response; fall back to handlerRes.
    if (res.last instanceof Response) return res.last;
    if (handlerRes instanceof Response) return handlerRes;
    // Last resort: 200 empty (shouldn't happen — every handler writes a json).
    return new Response(JSON.stringify({}), { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
}
