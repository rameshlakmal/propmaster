// The local web app: a small HTTP server that serves the UI and a JSON API over the same engine as the CLI.
// Security (it can reach your test databases): it listens on 127.0.0.1 only, every API call must carry the
// random token minted at start-up, the Host header must be this server (blocks DNS rebinding), and calls
// from other web pages are refused (Origin check).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDatabase, withDb, type Db } from '../core/db.js';
import { explainError, UserError } from '../core/errors.js';
import { diagnose } from '../recorder/doctor.js';
import { toHtml } from '../recorder/export/html.js';
import { toMarkdown } from '../recorder/export/markdown.js';
import { toSql } from '../recorder/export/sql.js';
import { createMasker, maskRecording } from '../recorder/mask.js';
import { checkRules, parseRules } from '../recorder/rules.js';
import * as sessions from '../recorder/sessions.js';
import * as claims from '../finder/claims.js';
import { checkRecipes, claimFound, find } from '../finder/find.js';
import { loadRecipes, type Recipe } from '../finder/recipes.js';
import * as trigger from '../recorder/trigger.js';
import * as profiles from './profiles.js';
import { toView } from './view.js';

const WEB_ROOT = fileURLToPath(new URL('../../dist/web/', import.meta.url));
const MAX_BODY = 1_000_000;

/**
 * The web app build this server started with. Rebuilding while the server runs puts a newer app in front
 * of older server code; the app compares ids and asks for a restart instead of misreading responses.
 */
const STARTED_WITH_BUILD = (() => {
  try {
    return readFileSync(resolve(WEB_ROOT, 'build-id.txt'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
})();
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
}
type Handler = (req: Request) => Promise<unknown>;

/** Runs fn with a connection to the active profile's database. */
async function withActive<T>(fn: (db: Db, identity: string, profile: profiles.Profile) => Promise<T>): Promise<T> {
  const profile = await profiles.activeProfile();
  return withDb(profile.url, (db) => fn(db, describeDatabase(profile.url), profile));
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new UserError(`"${field}" is required.`);
  return v.trim();
};

/** Windows' "Copy as path" wraps the path in quotes: accept it as pasted. */
const pastedPath = (v: unknown, field: string): string => resolve(str(v, field).replace(/^(["'])(.*)\1$/, '$2').trim());

/** Parameter values from the browser: an object of strings. Empty fields mean "use the default". */
function paramValues(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new UserError('"params" must be an object.');
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value !== 'string') throw new UserError(`Parameter "${k}" must be text.`);
    if (value.trim() !== '') out[k] = value;
  }
  return out;
}

/** The active profile's recipes, and the one with this id. */
async function profileRecipe(profile: profiles.Profile, id: unknown): Promise<Recipe> {
  if (!profile.recipesPath) throw new UserError('Choose a recipe folder first.');
  const recipe = (await loadRecipes(profile.recipesPath)).find((r) => r.id === id);
  if (!recipe) throw new UserError(`There is no recipe "${String(id)}" in ${profile.recipesPath}.`, 'It may have been renamed: reload the list.');
  return recipe;
}

const durationOf = (v: unknown): number => claims.parseDuration(typeof v === 'string' && v.trim() ? v : '2h');
const limitOf = (v: unknown): number => (typeof v === 'number' ? v : 25);

// ---------- API ----------

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/config$/, async () => {
    const config = await profiles.readConfig();
    return { active: config.active ?? config.profiles[0]?.name ?? null, profiles: config.profiles.map(profiles.publicProfile) };
  }],

  // Checks a connection without saving it: can we connect, and what may this user do?
  ['POST', /^\/api\/connections\/test$/, async (req) => {
    const { url } = await req.body();
    return withDb(str(url, 'url'), async (db) => ({ doctor: await diagnose(db), installed: await trigger.isInstalled(db) }));
  }],
  ['POST', /^\/api\/profiles$/, async (req) => {
    const { name, url } = await req.body();
    await withDb(str(url, 'url'), (db) => db.query('SELECT 1')); // only save connections that work
    await profiles.saveProfile({ name: str(name, 'name'), url: str(url, 'url') });
    return { ok: true };
  }],
  ['DELETE', /^\/api\/profiles\/(.+)$/, async (req) => {
    await profiles.removeProfile(decodeURIComponent(req.params[0]!));
    return { ok: true };
  }],
  ['POST', /^\/api\/profiles\/(.+)\/activate$/, async (req) => {
    await profiles.activateProfile(decodeURIComponent(req.params[0]!));
    return { ok: true };
  }],

  ['GET', /^\/api\/doctor$/, () => withActive(async (db) => diagnose(db))],
  ['POST', /^\/api\/install$/, () => withActive(async (db) => ({ attached: await trigger.install(db) }))],
  ['POST', /^\/api\/tables\/exclude$/, async (req) => {
    const { table } = await req.body();
    return withActive(async (db) => { await trigger.excludeTable(db, str(table, 'table')); return { ok: true }; });
  }],
  ['POST', /^\/api\/tables\/include$/, async (req) => {
    const { table } = await req.body();
    return withActive(async (db) => { await trigger.includeTable(db, str(table, 'table')); return { ok: true }; });
  }],

  ['GET', /^\/api\/status$/, () => withActive(async (db, identity, profile) => ({
    profile: profiles.publicProfile(profile),
    ...(await sessions.status(db, identity)),
  }))],
  ['POST', /^\/api\/record\/start$/, async (req) => {
    const { name, snapshot, autoSteps } = await req.body();
    if (autoSteps !== undefined && typeof autoSteps !== 'boolean' && typeof autoSteps !== 'number') throw new UserError('"autoSteps" must be true, false or the gap in seconds.');
    const gap = typeof autoSteps === 'number' ? Math.round(autoSteps * 1000) : autoSteps === true;
    return withActive((db, identity) => sessions.start(db, identity, str(name, 'name'), { snapshot: snapshot === true, autoSteps: gap }));
  }],
  ['POST', /^\/api\/record\/step$/, async (req) => {
    const { name } = await req.body();
    return withActive(async (db, identity) => ({ seq: await sessions.step(db, identity, str(name, 'name')) }));
  }],
  ['POST', /^\/api\/record\/pause$/, () => withActive(async (db, identity) => { await sessions.pause(db, identity); return { ok: true }; })],
  ['POST', /^\/api\/record\/resume$/, () => withActive(async (db, identity) => { await sessions.resume(db, identity); return { ok: true }; })],
  ['POST', /^\/api\/record\/flag$/, async (req) => {
    const { note } = await req.body();
    if (note !== undefined && typeof note !== 'string') throw new UserError('"note" must be text.');
    return withActive(async (db, identity) => { await sessions.flag(db, identity, note ?? ''); return { ok: true }; });
  }],
  ['POST', /^\/api\/record\/stop$/, () => withActive(async (db, identity) => toView(await sessions.stop(db, identity)))],

  ['GET', /^\/api\/sessions$/, (req) => {
    const page = Math.max(1, Math.floor(Number(req.query.get('page') ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.get('pageSize') ?? 20)) || 20));
    return withActive(async (db, identity) => ({ ...(await sessions.page(db, identity, (page - 1) * pageSize, pageSize)), page, pageSize }));
  }],
  ['GET', /^\/api\/sessions\/([^/]+)$/, (req) => withActive(async (db, identity) => toView(await sessions.load(db, identity, req.params[0])))],
  ['PUT', /^\/api\/sessions\/([^/]+)\/steps\/(\d+)$/, async (req) => {
    const { name } = await req.body();
    return withActive(async (db) => { await sessions.renameStep(db, req.params[0]!, Number(req.params[1]), str(name, 'name')); return { ok: true }; });
  }],
  ['DELETE', /^\/api\/sessions\/([^/]+)$/, (req) => withActive(async (db) => { await sessions.remove(db, req.params[0]!); return { ok: true }; })],

  ['GET', /^\/api\/rules$/, () => withActive(async (_db, _identity, profile) => {
    const path = profile.rulesFile ?? '';
    if (!path || !existsSync(path)) return { path, content: '', rules: [], error: path ? `Can't find ${path}` : null };
    const content = await readFile(path, 'utf8');
    try {
      return { path, content, rules: parseRules(content, path).map((r) => ({ name: r.name, line: r.line })), error: null };
    } catch (err) {
      return { path, content, rules: [], error: err instanceof Error ? err.message : String(err) };
    }
  })],
  ['PUT', /^\/api\/rules$/, async (req) => {
    const { path, content } = await req.body();
    const file = pastedPath(path, 'path');
    if (extname(file).toLowerCase() !== '.sql') throw new UserError(`Rules files must end in .sql, and this one doesn't: ${file}`);
    if (typeof content === 'string') {
      parseRules(content, file); // refuse to save a file the checker can't read
      await writeFile(file, content, 'utf8');
    } else if (!existsSync(file)) {
      throw new UserError(`Can't find ${file}.`);
    }
    const profile = await profiles.activeProfile();
    await profiles.setRulesFile(profile.name, file);
    return { ok: true, path: file };
  }],
  // ---------- Test Data Finder ----------

  ['GET', /^\/api\/recipes$/, async () => {
    const profile = await profiles.activeProfile();
    const path = profile.recipesPath ?? '';
    if (!path) return { path, recipes: [], error: null };
    try {
      return { path, recipes: await loadRecipes(path), error: null };
    } catch (err) {
      return { path, recipes: [], error: err instanceof Error ? err.message : String(err) };
    }
  }],
  ['PUT', /^\/api\/recipes$/, async (req) => {
    const { path } = await req.body();
    const target = pastedPath(path, 'path');
    if (!existsSync(target)) throw new UserError(`Can't find ${target}.`, 'Give a folder of .sql recipe files, or one .sql file.');
    const profile = await profiles.activeProfile();
    await profiles.setRecipesPath(profile.name, target);
    return { ok: true, path: target };
  }],
  ['POST', /^\/api\/recipes\/check$/, () => withActive(async (db, _identity, profile) => {
    if (!profile.recipesPath) throw new UserError('Choose a recipe folder first.');
    return { results: await checkRecipes(db, await loadRecipes(profile.recipesPath)) };
  })],
  ['POST', /^\/api\/find$/, async (req) => {
    const { recipe, params, limit } = await req.body();
    return withActive(async (db, _identity, profile) => ({
      me: claims.defaultClaimer(),
      result: await find(db, await profileRecipe(profile, recipe), { params: paramValues(params), limit: limitOf(limit) }),
    }));
  }],
  // Claims one row the tester picked (key), or the first free one. The recipe runs again first, so the
  // row is checked against the current data and claims.
  ['POST', /^\/api\/find\/claim$/, async (req) => {
    const { recipe, params, limit, key, duration, note } = await req.body();
    if (key !== undefined && typeof key !== 'string') throw new UserError('"key" must be text.');
    if (note !== undefined && typeof note !== 'string') throw new UserError('"note" must be text.');
    return withActive(async (db, _identity, profile) => {
      const r = await profileRecipe(profile, recipe);
      const options = { params: paramValues(params), limit: limitOf(limit) };
      const before = await find(db, r, options);
      const opts = { by: claims.defaultClaimer(), note: note?.trim() || undefined, seconds: durationOf(duration) };
      let got: claims.ClaimRow[];
      if (key === undefined) {
        got = await claimFound(db, before, opts);
      } else {
        const row = before.rows.find((x) => x.key === key);
        if (!row) throw new UserError('That row no longer matches the recipe.', 'Run it again to see the current rows.');
        if (row.claimedBy) {
          const who = row.claimedBy.claimedBy === opts.by ? 'you' : row.claimedBy.claimedBy;
          throw new UserError(`${before.claim!.table.replace(/^public\./, '')} ${key} is already claimed by ${who} (claim #${row.claimedBy.id}).`);
        }
        got = await claimFound(db, { ...before, rows: [row] }, opts);
      }
      return { me: opts.by, claims: got, result: await find(db, r, options) };
    });
  }],
  ['GET', /^\/api\/claims$/, (req) => withActive(async (db) => ({
    me: claims.defaultClaimer(),
    claims: await claims.list(db, { includeExpired: req.query.get('all') === '1' }),
  }))],
  ['POST', /^\/api\/claims\/(\d+)\/release$/, (req) => withActive(async (db) => ({ released: await claims.release(db, [req.params[0]!]) }))],
  ['POST', /^\/api\/claims\/(\d+)\/extend$/, async (req) => {
    const { duration } = await req.body();
    return withActive(async (db) => ({ claim: await claims.extend(db, req.params[0]!, durationOf(duration)) }));
  }],
  ['POST', /^\/api\/claims\/release-mine$/, () => withActive(async (db) => ({ released: await claims.releaseAllBy(db, claims.defaultClaimer()) }))],

  ['POST', /^\/api\/rules\/check$/, async (req) => {
    const { sessionId, allRows } = await req.body();
    return withActive(async (db, identity, profile) => {
      if (!profile.rulesFile) throw new UserError('Choose a rules file first.');
      const rules = parseRules(await readFile(profile.rulesFile, 'utf8'), profile.rulesFile);
      const rec = allRows === true ? null : await sessions.load(db, identity, typeof sessionId === 'string' ? sessionId : undefined);
      return { sessionId: rec?.id ?? null, results: await checkRules(db, rec, rules, { allRows: allRows === true, limit: 20 }) };
    });
  }],
];

/** Exports are file downloads, so they are handled outside the JSON routes. */
async function exportSession(res: ServerResponse, id: string, query: URLSearchParams): Promise<void> {
  const format = query.get('format') ?? 'html';
  if (!['html', 'md', 'sql'].includes(format)) throw new UserError(`Unknown format "${format}".`);
  const masked = query.get('mask') !== '0';
  const content = await withActive(async (db, identity) => {
    const rec = await sessions.load(db, identity, id);
    const masker = createMasker();
    const shown = masked ? maskRecording(rec, masker) : rec;
    return format === 'html' ? toHtml(shown, { masked })
      : format === 'md' ? toMarkdown(shown, { masked })
      : toSql(rec, { masker: masked ? masker : undefined, ignoreColumns: query.get('ignore')?.split(',').filter(Boolean) });
  });
  res.writeHead(200, {
    'Content-Type': format === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="propmaster-session-${id}.${format}"`,
  });
  res.end(content);
}

// ---------- plumbing ----------

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Propmaster-Build': STARTED_WITH_BUILD });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { fail(new UserError('Request too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return ok({});
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); } catch { fail(new UserError('The request body is not valid JSON.')); }
    });
    req.on('error', fail);
  });
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const file = resolve(WEB_ROOT, `.${decodeURIComponent(path)}`);
  const inside = file.startsWith(resolve(WEB_ROOT));
  const target = inside && existsSync(file) && extname(file) ? file : resolve(WEB_ROOT, 'index.html'); // the app handles its own routes
  if (!existsSync(target)) {
    send(res, 500, { error: { message: 'The web app is not built yet.', hint: 'Run: npm run build' } });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'Cache-Control': target.includes(`${resolve(WEB_ROOT, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(await readFile(target));
}

export interface UiServer {
  server: Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Starts the web app server on 127.0.0.1. Port 0 picks a free port (used by tests). */
export async function startUiServer(port = 4400): Promise<UiServer> {
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  let allowedHosts = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!allowedHosts.has(host)) { send(res, 403, { error: { message: 'Unknown host.' } }); return; }
      const url = new URL(req.url ?? '/', `http://${host}`);

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') { send(res, 405, { error: { message: 'Method not allowed.' } }); return; }
        await serveStatic(res, url.pathname);
        return;
      }

      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) { send(res, 403, { error: { message: 'Cross-site request refused.' } }); return; }
      const given = Buffer.from(String(req.headers['x-propmaster-token'] ?? '')); // header only, never in a URL
      if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) { send(res, 401, { error: { message: 'Missing or wrong token.', hint: 'Open the link printed by `propmaster ui`.' } }); return; }

      const exportMatch = /^\/api\/sessions\/([^/]+)\/export$/.exec(url.pathname);
      if (exportMatch && req.method === 'GET') { await exportSession(res, exportMatch[1]!, url.searchParams); return; }

      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m || method !== req.method) continue;
        const data = await handler({ method, path: url.pathname, query: url.searchParams, params: m.slice(1), body: () => readBody(req) });
        send(res, 200, data);
        return;
      }
      send(res, 404, { error: { message: `No API route for ${req.method} ${url.pathname}.` } });
    } catch (err) {
      const e = explainError(err);
      if (e instanceof UserError) send(res, 400, { error: { message: e.message, hint: e.hint } });
      else send(res, 500, { error: { message: e instanceof Error ? e.message : String(e) } });
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const actual = (server.address() as { port: number }).port;
  allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);

  return {
    server,
    token,
    url: `http://127.0.0.1:${actual}/?token=${token}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
