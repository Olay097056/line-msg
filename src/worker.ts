// Cloudflare Worker entry point (replaces Pages Functions).
//
// Pages Cron Triggers have no CLI/API — only a manual dashboard step. Plain
// Workers support `[triggers] crons` in wrangler.toml, deployable with
// `wrangler deploy`, so this is the same app repackaged as a Worker with a
// static-assets binding instead of a Pages project. The route-adapter logic
// below is copied from functions/api/[[path]].ts with only the routing
// glue changed (URL path parsing instead of Pages' context.params.path);
// every api/*.ts handler is untouched.

import { setCfEnv, type CfEnv } from '../lib/cf-env.js';
import { deps } from '../lib/http.js';
import { runTick } from '../lib/send.js';

import loginHandler from '../api/login.js';
import stateHandler from '../api/state.js';
import sendHandler from '../api/send.js';
import schedulesHandler from '../api/schedules.js';
import groupsHandler from '../api/groups.js';
import messageHandler from '../api/message.js';
import logsHandler from '../api/logs.js';
import tickHandler from '../api/tick.js';
import webhookHandler from '../api/webhook.js';

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

type WorkerEnv = CfEnv & { ASSETS: { fetch(req: Request): Promise<Response> } } & Record<string, unknown>;

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

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof h.forEach === 'function') h.forEach((v, k) => (out[k] = v));
  return out;
}

async function handleApi(request: Request, route: string): Promise<Response> {
  const entry = ROUTES[route];
  if (!entry) {
    return new Response(JSON.stringify({ error: `no route ${route}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const method = request.method;

  const req = {
    method,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: headersToObject(request.headers),
    body: undefined as unknown,
  };

  if (method !== 'GET' && method !== 'DELETE') {
    const raw = await request.text();
    if (entry.rawBody) {
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
    (req as any).rawBody = await request.text();
  }

  const res = makeRes();
  let handlerRes: unknown;
  try {
    handlerRes = await entry.handler(req, res);
  } catch (e) {
    console.error('api handler error:', e);
    return new Response(JSON.stringify({ error: 'internal' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (res.last instanceof Response) return res.last;
  if (handlerRes instanceof Response) return handlerRes;
  return new Response(JSON.stringify({}), {
    status: res.statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    setCfEnv({ ...env });
    try {
      if (url.pathname.startsWith('/api/')) {
        const route = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
        return await handleApi(request, route);
      }
      // Everything else (index.html, app.js, app.css, demo.*) is served from
      // the [assets] binding — the same public/ directory Pages used.
      return await env.ASSETS.fetch(request);
    } finally {
      setCfEnv(null);
    }
  },

  async scheduled(_event: unknown, env: WorkerEnv, _ctx: unknown): Promise<void> {
    setCfEnv({ ...env });
    try {
      const { db, line } = deps();
      const result = await runTick({ db, line });
      if (result.due > 0) await db.log('info', 'tick_fired', result);
    } catch (err) {
      const { db } = deps();
      await db.log('error', 'tick_crashed', { message: String(err) }).catch(() => {});
    } finally {
      setCfEnv(null);
    }
  },
};
