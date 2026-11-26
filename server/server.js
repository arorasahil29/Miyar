#!/usr/bin/env node
/*
 * Basira server
 *  - Serves the Basira web app.
 *  - Signs people in with any OpenID Connect provider (Microsoft Entra ID, Google, Okta, Keycloak, Auth0, ...).
 *  - Stores shared reports and datasets: metadata in PostgreSQL, dataset rows as gzip files on disk or in S3.
 *  - Enforces roles (admin, editor, viewer) and keeps an audit log.
 *  - Forwards data-source queries to Basira Gateway, so users never see the gateway's access key.
 *
 * Built for one organisation per installation, with org_id on every row so it can host several later.
 */
'use strict';
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const {promisify} = require('node:util');
const {Pool} = require('pg');

const gzip = promisify(zlib.gzip);
const list = k => String(process.env[k] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const PUBLIC_URL = env('PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, '');
const BASE = new URL(PUBLIC_URL + '/').pathname.replace(/\/$/, '');
const CFG = {
  port: Number(env('PORT', 8080)),
  authMode: env('AUTH_MODE', 'oidc'),
  sessionSecret: env('SESSION_SECRET', ''),
  sessionHours: Number(env('SESSION_HOURS', 12)),
  secureCookies: PUBLIC_URL.startsWith('https://'),
  oidc: {
    issuer: env('OIDC_ISSUER', ''), clientId: env('OIDC_CLIENT_ID', ''), clientSecret: env('OIDC_CLIENT_SECRET', ''),
    scopes: env('OIDC_SCOPES', 'openid email profile'), roleClaim: env('OIDC_ROLE_CLAIM', 'groups'),
    logout: env('OIDC_LOGOUT', 'true') !== 'false', providerName: env('OIDC_PROVIDER_NAME', 'your company account'),
  },
  adminEmails: list('ADMIN_EMAILS'), adminGroups: list('ADMIN_GROUPS'), editorGroups: list('EDITOR_GROUPS'),
  defaultRole: env('DEFAULT_ROLE', 'viewer'), allowedDomains: list('ALLOWED_EMAIL_DOMAINS'),
  firstUserAdmin: env('FIRST_USER_ADMIN', 'true') !== 'false',
  orgName: env('ORG_NAME', 'My organisation'), orgSlug: env('ORG_SLUG', 'default'),
  storage: env('STORAGE_DRIVER', 'local'), dataDir: path.resolve(env('DATA_DIR', '/data')),
  s3: {bucket: env('S3_BUCKET', ''), region: env('S3_REGION', 'us-east-1'), endpoint: env('S3_ENDPOINT', ''),
    accessKeyId: env('S3_ACCESS_KEY_ID', ''), secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
    forcePathStyle: env('S3_FORCE_PATH_STYLE', 'false') === 'true', sse: env('S3_SSE', ''), prefix: env('S3_PREFIX', '')},
  gatewayUrl: env('GATEWAY_URL', '').replace(/\/+$/, ''), gatewayKey: env('GATEWAY_KEY', ''),
  appFile: env('APP_FILE', path.join(__dirname, 'public', 'index.html')),
  maxUpload: env('MAX_UPLOAD', '200mb'),
};

function fail(msg){ console.error(`\n[config] ${msg}\n`); process.exit(1); }
if (!process.env.DATABASE_URL) fail('Set DATABASE_URL, e.g. postgres://basira:secret@db:5432/basira');
if (CFG.sessionSecret.length < 32) fail('Set SESSION_SECRET to at least 32 random characters (for example: openssl rand -hex 32).');
if (!['oidc', 'dev'].includes(CFG.authMode)) fail('AUTH_MODE must be "oidc" or "dev".');
if (CFG.authMode === 'oidc' && (!CFG.oidc.issuer || !CFG.oidc.clientId)) fail('Set OIDC_ISSUER and OIDC_CLIENT_ID (and OIDC_CLIENT_SECRET for confidential clients).');
if (!['admin', 'editor', 'viewer'].includes(CFG.defaultRole)) fail('DEFAULT_ROLE must be admin, editor or viewer.');
if (CFG.authMode === 'dev') console.warn('\n*** AUTH_MODE=dev: anyone who can reach this server is signed in as an administrator. Use only for local trials. ***\n');

class HttpError extends Error { constructor(status, message, extra){ super(message); this.status = status; this.extra = extra; } }
const ROLE_RANK = {viewer: 1, editor: 2, admin: 3};

/* ============================== database ============================== */
const pool = new Pool({connectionString: process.env.DATABASE_URL, max: Number(env('DB_POOL_SIZE', 10)),
  ssl: env('DATABASE_SSL', '') === 'true' ? {rejectUnauthorized: env('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false'} : undefined});
const db = (text, params) => pool.query(text, params);
let ORG;

async function migrate(){
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const {rows} = await c.query('SELECT max(version) AS v FROM schema_version');
    if (!rows[0].v){
      await c.query('BEGIN');
      await c.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      await c.query('INSERT INTO schema_version (version) VALUES (1)');
      await c.query('COMMIT');
      console.log('[db] schema created (version 1)');
    }
    const org = await c.query('SELECT * FROM orgs WHERE slug = $1', [CFG.orgSlug]);
    if (org.rows.length){
      ORG = org.rows[0];
      if (ORG.name !== CFG.orgName){ await c.query('UPDATE orgs SET name = $1 WHERE id = $2', [CFG.orgName, ORG.id]); ORG.name = CFG.orgName; }
    } else {
      ORG = (await c.query('INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $3) RETURNING *', [crypto.randomUUID(), CFG.orgSlug, CFG.orgName])).rows[0];
      console.log(`[db] created organisation "${ORG.name}"`);
    }
  } catch (e){ await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {}); c.release(); }
}

async function audit(req, action, target = {}, detail = null){
  const u = req.user || {};
  try {
    // Repeated saves of the same thing by the same person within 10 minutes are folded into one entry.
    if (/\.update$/.test(action)){
      const r = await db(`UPDATE audit_log SET at = now(), count = count + 1 WHERE id = (
          SELECT id FROM audit_log WHERE org_id = $1 AND user_id = $2 AND action = $3 AND target_id = $4 AND at > now() - interval '10 minutes'
          ORDER BY id DESC LIMIT 1) RETURNING id`, [req.org?.id || ORG.id, u.id || null, action, target.id || null]);
      if (r.rowCount) return;
    }
    await db(`INSERT INTO audit_log (org_id, user_id, user_email, action, target_type, target_id, target_name, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.org?.id || ORG.id, u.id || null, u.email || null, action, target.type || null, target.id || null, target.name || null, detail]);
  } catch (e){ console.error('[audit]', e.message); }
}

/* ============================== storage ============================== */
function makeStorage(){
  if (CFG.storage === 's3'){
    if (!CFG.s3.bucket) fail('Set S3_BUCKET when STORAGE_DRIVER=s3.');
    let s3mod;
    try { s3mod = require('@aws-sdk/client-s3'); } catch { fail('STORAGE_DRIVER=s3 needs the @aws-sdk/client-s3 package (npm install @aws-sdk/client-s3).'); }
    const {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand} = s3mod;
    const client = new S3Client({region: CFG.s3.region, endpoint: CFG.s3.endpoint || undefined, forcePathStyle: CFG.s3.forcePathStyle,
      credentials: CFG.s3.accessKeyId ? {accessKeyId: CFG.s3.accessKeyId, secretAccessKey: CFG.s3.secretAccessKey} : undefined});
    const K = key => CFG.s3.prefix + key;
    return {
      name: `S3 bucket ${CFG.s3.bucket}`,
      put: (key, buf) => client.send(new PutObjectCommand({Bucket: CFG.s3.bucket, Key: K(key), Body: buf, ContentType: 'application/json', ContentEncoding: 'gzip', ServerSideEncryption: CFG.s3.sse || undefined})),
      get: async key => (await client.send(new GetObjectCommand({Bucket: CFG.s3.bucket, Key: K(key)}))).Body,
      del: key => client.send(new DeleteObjectCommand({Bucket: CFG.s3.bucket, Key: K(key)})).catch(() => {}),
    };
  }
  const file = key => {
    const p = path.resolve(CFG.dataDir, key);
    if (!p.startsWith(CFG.dataDir + path.sep)) throw new Error('Bad storage key.');
    return p;
  };
  return {
    name: `folder ${CFG.dataDir}`,
    async put(key, buf){ const p = file(key); await fsp.mkdir(path.dirname(p), {recursive: true}); await fsp.writeFile(p + '.tmp', buf); await fsp.rename(p + '.tmp', p); },
    async get(key){ return fs.createReadStream(file(key)); },
    del: key => fsp.unlink(file(key)).catch(() => {}),
  };
}
const storage = makeStorage();

/* ============================== sessions & sign-in ============================== */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sign = s => crypto.createHmac('sha256', CFG.sessionSecret).update(s).digest('base64url');
function cookies(req){ return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
function setCookie(res, name, value, maxAgeSec){
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${BASE || '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (CFG.secureCookies) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function sealed(obj){ const v = Buffer.from(JSON.stringify(obj)).toString('base64url'); return v + '.' + sign(v); }
function unseal(s){
  const [v, mac] = String(s || '').split('.');
  if (!v || !mac) return null;
  const a = Buffer.from(sign(v)), b = Buffer.from(mac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(v, 'base64url').toString()); } catch { return null; }
}

let oidcClient = null;
async function oidc(){
  if (oidcClient) return oidcClient;
  const {Issuer} = require('openid-client');
  const issuer = await Issuer.discover(CFG.oidc.issuer);
  oidcClient = new issuer.Client({client_id: CFG.oidc.clientId, client_secret: CFG.oidc.clientSecret || undefined,
    redirect_uris: [PUBLIC_URL + '/auth/callback'], response_types: ['code'],
    token_endpoint_auth_method: CFG.oidc.clientSecret ? 'client_secret_basic' : 'none'});
  return oidcClient;
}

function claimList(claims, name){
  const v = name.split('.').reduce((o, k) => (o == null ? o : o[k]), claims);
  return (Array.isArray(v) ? v : v == null ? [] : String(v).split(/[ ,]+/)).map(x => String(x).toLowerCase());
}
async function resolveRole(existing, email, claims){
  if (CFG.authMode === 'dev') return 'admin';
  const e = String(email || '').toLowerCase();
  if (e && CFG.adminEmails.includes(e)) return 'admin';
  if (CFG.adminGroups.length || CFG.editorGroups.length){   // groups from the identity provider decide
    const g = claimList(claims, CFG.oidc.roleClaim);
    if (g.some(x => CFG.adminGroups.includes(x))) return 'admin';
    if (g.some(x => CFG.editorGroups.includes(x))) return 'editor';
    return existing?.role === 'admin' && !CFG.adminGroups.length ? 'admin' : CFG.defaultRole;
  }
  if (existing) return existing.role;                       // roles managed in Basira
  if (CFG.firstUserAdmin && !CFG.adminEmails.length){
    const {rows} = await db("SELECT 1 FROM users WHERE org_id = $1 AND role = 'admin' LIMIT 1", [ORG.id]);
    if (!rows.length) return 'admin';
  }
  return CFG.defaultRole;
}
async function signIn(req, res, {issuer, subject, email, name, claims, idToken}){
  if (CFG.allowedDomains.length){
    const domain = String(email || '').toLowerCase().split('@')[1];
    if (!domain || !CFG.allowedDomains.includes(domain)) throw new HttpError(403, 'Your account is not allowed to use this Basira installation.');
  }
  const existing = (await db('SELECT * FROM users WHERE org_id = $1 AND issuer = $2 AND subject = $3', [ORG.id, issuer, subject])).rows[0];
  const role = await resolveRole(existing, email, claims || {});
  const user = existing
    ? (await db('UPDATE users SET email = $1, name = $2, role = $3, last_login_at = now() WHERE id = $4 RETURNING *', [email, name, role, existing.id])).rows[0]
    : (await db('INSERT INTO users (id, org_id, issuer, subject, email, name, role, last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *',
        [crypto.randomUUID(), ORG.id, issuer, subject, email, name, role])).rows[0];
  const sid = crypto.randomBytes(32).toString('base64url');
  await db(`INSERT INTO sessions (id_hash, user_id, org_id, id_token, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)`,
    [sha(sid), user.id, ORG.id, idToken || null, String(CFG.sessionHours)]);
  setCookie(res, 'basira_sid', sid, CFG.sessionHours * 3600);
  req.user = user; req.org = ORG;
  await audit(req, 'user.sign_in', {type: 'user', id: user.id, name: user.email}, existing ? null : {first_sign_in: true, role});
  return user;
}

async function authenticate(req, _res, next){
  try {
    const sid = cookies(req).basira_sid;
    if (sid){
      const {rows} = await db(`SELECT u.*, s.expires_at, s.id_token FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.expires_at > now()`, [sha(sid)]);
      if (rows[0]){ req.user = rows[0]; req.org = ORG; req.sidHash = sha(sid); }
    }
    next();
  } catch (e){ next(e); }
}
const need = role => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) return next(new HttpError(403, `This needs the ${role} role. Ask an administrator for access.`));
  next();
};
// Requests that change data must come from the app itself: a custom header that other sites cannot send without CORS.
function csrf(req, _res, next){
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-basira'] !== '1') return next(new HttpError(403, 'Missing request header.'));
  const origin = req.headers.origin;
  if (origin && origin !== new URL(PUBLIC_URL).origin) return next(new HttpError(403, 'Request from another site.'));
  next();
}

/* ============================== app ============================== */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env('TRUST_PROXY', 'loopback, linklocal, uniquelocal'));
const router = express.Router();
app.use(BASE || '/', router);

router.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (CFG.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
router.use(authenticate);

/* --- the web app --- */
let appHtml = null;
function serveApp(_req, res){
  try { appHtml ||= fs.readFileSync(CFG.appFile); } catch { return res.status(500).send('The Basira app file is missing. Set APP_FILE.'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  // 'unsafe-eval' is needed for calculated-field formulas, which the app validates before compiling.
  res.setHeader('Content-Security-Policy', ["default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:",
    "connect-src 'self' https:", "worker-src 'self' blob:", "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'"].join('; '));
  res.send(appHtml);
}
router.get(['/', '/index.html'], serveApp);
router.get('/healthz', async (_req, res) => { try { await db('SELECT 1'); res.json({ok: true}); } catch { res.status(503).json({ok: false}); } });

/* --- sign-in --- */
router.get('/auth/login', async (req, res, next) => {
  try {
    const nextUrl = String(req.query.next || '').startsWith('/') && !String(req.query.next).startsWith('//') ? String(req.query.next) : (BASE || '/');
    if (CFG.authMode === 'dev'){
      await signIn(req, res, {issuer: 'dev', subject: 'local-admin', email: 'admin@localhost', name: 'Local administrator'});
      return res.redirect(nextUrl);
    }
    const {generators} = require('openid-client');
    const client = await oidc();
    const verifier = generators.codeVerifier(), state = generators.state(), nonce = generators.nonce();
    setCookie(res, 'basira_auth', sealed({verifier, state, nonce, next: nextUrl, exp: Date.now() + 10 * 60e3}), 600);
    res.redirect(client.authorizationUrl({scope: CFG.oidc.scopes, code_challenge: generators.codeChallenge(verifier), code_challenge_method: 'S256', state, nonce}));
  } catch (e){ next(e); }
});
router.get('/auth/callback', async (req, res, next) => {
  try {
    const flow = unseal(cookies(req).basira_auth);
    setCookie(res, 'basira_auth', '', 0);
    if (!flow || flow.exp < Date.now()) throw new HttpError(400, 'The sign-in took too long or was started in another browser. Please try again.');
    const client = await oidc();
    const params = client.callbackParams(req);
    if (params.error) throw new HttpError(401, `Sign-in was not completed: ${params.error_description || params.error}`);
    const tokens = await client.callback(PUBLIC_URL + '/auth/callback', params, {code_verifier: flow.verifier, state: flow.state, nonce: flow.nonce});
    let claims = tokens.claims();
    if ((!claims.email || !claims.name) && tokens.access_token){
      try { claims = {...(await client.userinfo(tokens.access_token)), ...claims}; } catch {}
    }
    const email = claims.email || claims.preferred_username || claims.upn || null;
    const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email || 'User';
    await signIn(req, res, {issuer: claims.iss, subject: claims.sub, email, name, claims, idToken: tokens.id_token});
    res.redirect(flow.next || BASE || '/');
  } catch (e){
    if (e.status) return next(e);
    console.error('[auth] callback failed:', e.message);
    next(new HttpError(401, 'Sign-in failed. Please try again, or ask your administrator to check the OpenID Connect settings.'));
  }
});
router.post('/auth/logout', csrf, async (req, res, next) => {
  try {
    let redirect = BASE || '/';
    if (req.sidHash){
      await audit(req, 'user.sign_out', {type: 'user', id: req.user.id, name: req.user.email});
      await db('DELETE FROM sessions WHERE id_hash = $1', [req.sidHash]);
      if (CFG.authMode === 'oidc' && CFG.oidc.logout){
        try {
          const client = await oidc();
          if (client.issuer.metadata.end_session_endpoint)
            redirect = client.endSessionUrl({id_token_hint: req.user.id_token || undefined, post_logout_redirect_uri: PUBLIC_URL + '/'});
        } catch {}
      }
    }
    setCookie(res, 'basira_sid', '', 0);
    res.json({redirect});
  } catch (e){ next(e); }
});

/* --- API --- */
const api = express.Router();
router.use('/api', csrf, api);
const small = express.json({limit: '20mb'});
const large = express.json({limit: CFG.maxUpload, inflate: true});

api.get('/config', (_req, res) => res.json({app: 'basira-server', version: '1.0.0', authMode: CFG.authMode, org: ORG.name,
  provider: CFG.oidc.providerName, gateway: !!CFG.gatewayUrl}));
api.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({error: 'Sign in to continue.', login: (BASE || '') + '/auth/login'});
  res.json({user: {id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role}, org: {id: ORG.id, name: ORG.name}});
});

/* datasets */
const dsOut = d => ({id: d.id, name: d.name, columns: d.columns, row_count: d.row_count, source: d.source, calcs: d.calcs, fmt: d.fmt,
  version: d.version, updated_at: d.updated_at});
const okName = n => { const s = String(n || '').trim(); if (!s || s.length > 120) throw new HttpError(400, 'Give the dataset a name of 1 to 120 characters.'); return s; };
function checkRows(body){
  if (!Array.isArray(body.columns) || !body.columns.length) throw new HttpError(400, 'The dataset needs columns.');
  if (!Array.isArray(body.rows)) throw new HttpError(400, 'The dataset needs rows.');
}
async function writeRows(orgId, id, version, rows){
  const key = `${orgId}/datasets/${id}-v${version}.json.gz`;
  await storage.put(key, await gzip(JSON.stringify(rows)));
  return key;
}
api.get('/datasets', need('viewer'), async (req, res, next) => {
  try { res.json({datasets: (await db('SELECT * FROM datasets WHERE org_id = $1 ORDER BY name', [ORG.id])).rows.map(dsOut)}); } catch (e){ next(e); }
});
api.get('/datasets/:id/rows', need('viewer'), async (req, res, next) => {
  try {
    const d = (await db('SELECT storage_key FROM datasets WHERE org_id = $1 AND id = $2', [ORG.id, req.params.id])).rows[0];
    if (!d) throw new HttpError(404, 'Dataset not found.');
    const body = await storage.get(d.storage_key);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Cache-Control', 'private, no-store');
    body.on('error', e => { console.error('[storage]', e.message); res.destroy(e); });
    body.pipe(res);
  } catch (e){ next(e); }
});
api.post('/datasets', need('editor'), large, async (req, res, next) => {
  try {
    checkRows(req.body);
    const id = crypto.randomUUID(), name = okName(req.body.name);
    const key = await writeRows(ORG.id, id, 1, req.body.rows);
    let row;
    try {
      row = (await db(`INSERT INTO datasets (id, org_id, name, columns, row_count, storage_key, source, calcs, fmt, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [id, ORG.id, name, JSON.stringify(req.body.columns), req.body.rows.length, key, req.body.source ? JSON.stringify(req.body.source) : null,
          JSON.stringify(req.body.calcs || []), JSON.stringify(req.body.fmt || {}), req.user.id])).rows[0];
    } catch (e){ await storage.del(key); if (e.code === '23505') throw new HttpError(409, `A dataset called “${name}” already exists.`); throw e; }
    await audit(req, 'dataset.create', {type: 'dataset', id, name}, {rows: req.body.rows.length, source: req.body.source?.connection || req.body.source?.kind || 'file'});
    res.status(201).json(dsOut(row));
  } catch (e){ next(e); }
});
api.put('/datasets/:id/rows', need('editor'), large, async (req, res, next) => {
  try {
    checkRows(req.body);
    const cur = (await db('SELECT * FROM datasets WHERE org_id = $1 AND id = $2', [ORG.id, req.params.id])).rows[0];
    if (!cur) throw new HttpError(404, 'Dataset not found.');
    const key = await writeRows(ORG.id, cur.id, cur.version + 1, req.body.rows);
    const row = (await db(`UPDATE datasets SET columns = $1, row_count = $2, storage_key = $3, source = COALESCE($4, source), version = version + 1,
        updated_by = $5, updated_at = now() WHERE org_id = $6 AND id = $7 RETURNING *`,
      [JSON.stringify(req.body.columns), req.body.rows.length, key, req.body.source ? JSON.stringify(req.body.source) : null, req.user.id, ORG.id, cur.id])).rows[0];
    if (cur.storage_key && cur.storage_key !== key) await storage.del(cur.storage_key);
    await audit(req, req.body.refreshed ? 'dataset.refresh' : 'dataset.replace', {type: 'dataset', id: cur.id, name: cur.name}, {rows: req.body.rows.length});
    res.json(dsOut(row));
  } catch (e){ next(e); }
});
api.patch('/datasets/:id', need('editor'), small, async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = (await db(`UPDATE datasets SET calcs = COALESCE($1, calcs), fmt = COALESCE($2, fmt), columns = COALESCE($3, columns),
        updated_by = $4, updated_at = now() WHERE org_id = $5 AND id = $6 RETURNING *`,
      [b.calcs ? JSON.stringify(b.calcs) : null, b.fmt ? JSON.stringify(b.fmt) : null, b.columns ? JSON.stringify(b.columns) : null, req.user.id, ORG.id, req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'Dataset not found.');
    await audit(req, 'dataset.update', {type: 'dataset', id: row.id, name: row.name});
    res.json(dsOut(row));
  } catch (e){ next(e); }
});
api.delete('/datasets/:id', need('editor'), async (req, res, next) => {
  try {
    const row = (await db('DELETE FROM datasets WHERE org_id = $1 AND id = $2 RETURNING *', [ORG.id, req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'Dataset not found.');
    if (row.storage_key) await storage.del(row.storage_key);
    await audit(req, 'dataset.delete', {type: 'dataset', id: row.id, name: row.name});
    res.json({ok: true});
  } catch (e){ next(e); }
});

/* reports */
const repOut = (r, full) => ({id: r.id, name: r.name, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by_name || null, ...(full ? {content: r.content} : {})});
api.get('/reports', need('viewer'), async (req, res, next) => {
  try {
    const {rows} = await db(`SELECT r.*, u.name AS updated_by_name FROM reports r LEFT JOIN users u ON u.id = r.updated_by
      WHERE r.org_id = $1 ORDER BY r.created_at, r.id`, [ORG.id]);
    res.json({reports: rows.map(r => repOut(r, req.query.full === '1'))});
  } catch (e){ next(e); }
});
api.get('/reports/:id', need('viewer'), async (req, res, next) => {
  try {
    const r = (await db(`SELECT r.*, u.name AS updated_by_name FROM reports r LEFT JOIN users u ON u.id = r.updated_by WHERE r.org_id = $1 AND r.id = $2`, [ORG.id, req.params.id])).rows[0];
    if (!r) throw new HttpError(404, 'Report not found.');
    res.json(repOut(r, true));
  } catch (e){ next(e); }
});
// Create or update. "version" is the version the editor started from; a mismatch means someone else saved first.
api.put('/reports/:id', need('editor'), small, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, 'Bad report id.');
    const name = String(req.body?.name || '').trim().slice(0, 120) || 'Untitled report';
    const content = req.body?.content;
    if (!content || typeof content !== 'object' || !Array.isArray(content.pages)) throw new HttpError(400, 'The report content is missing its pages.');
    const cur = (await db('SELECT version FROM reports WHERE org_id = $1 AND id = $2', [ORG.id, id])).rows[0];
    let row;
    if (!cur){
      row = (await db(`INSERT INTO reports (org_id, id, name, content, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)
        ON CONFLICT (org_id, id) DO NOTHING RETURNING *`, [ORG.id, id, name, JSON.stringify(content), req.user.id])).rows[0];
      if (!row) throw new HttpError(409, 'Someone else created this report at the same moment. Reload to see it.');
      await audit(req, 'report.create', {type: 'report', id, name});
      return res.status(201).json(repOut(row));
    }
    row = (await db(`UPDATE reports SET name = $1, content = $2, version = version + 1, updated_by = $3, updated_at = now()
      WHERE org_id = $4 AND id = $5 AND version = $6 RETURNING *`, [name, JSON.stringify(content), req.user.id, ORG.id, id, Number(req.body.version)])).rows[0];
    if (!row){
      const latest = (await db(`SELECT r.*, u.name AS updated_by_name FROM reports r LEFT JOIN users u ON u.id = r.updated_by WHERE r.org_id = $1 AND r.id = $2`, [ORG.id, id])).rows[0];
      throw new HttpError(409, `${latest.updated_by_name || 'Someone'} saved a newer version of this report.`, {report: repOut(latest, true)});
    }
    await audit(req, 'report.update', {type: 'report', id, name});
    res.json(repOut(row));
  } catch (e){ next(e); }
});
api.delete('/reports/:id', need('editor'), async (req, res, next) => {
  try {
    const row = (await db('DELETE FROM reports WHERE org_id = $1 AND id = $2 RETURNING id, name', [ORG.id, req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'Report not found.');
    await audit(req, 'report.delete', {type: 'report', id: row.id, name: row.name});
    res.json({ok: true});
  } catch (e){ next(e); }
});

/* users & audit (administrators) */
api.get('/users', need('admin'), async (_req, res, next) => {
  try {
    const {rows} = await db('SELECT id, email, name, role, created_at, last_login_at FROM users WHERE org_id = $1 ORDER BY lower(coalesce(name, email))', [ORG.id]);
    res.json({users: rows, managedByGroups: !!(CFG.adminGroups.length || CFG.editorGroups.length)});
  } catch (e){ next(e); }
});
api.patch('/users/:id', need('admin'), small, async (req, res, next) => {
  try {
    const role = String(req.body?.role || '');
    if (!ROLE_RANK[role]) throw new HttpError(400, 'Role must be admin, editor or viewer.');
    const target = (await db('SELECT * FROM users WHERE org_id = $1 AND id = $2', [ORG.id, req.params.id])).rows[0];
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin' && role !== 'admin'){
      const {rows} = await db("SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'admin'", [ORG.id]);
      if (rows[0].n <= 1) throw new HttpError(400, 'There must be at least one administrator.');
    }
    await db('UPDATE users SET role = $1 WHERE id = $2', [role, target.id]);
    if (role !== target.role) await db('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [target.id, req.sidHash || '']);
    await audit(req, 'user.role', {type: 'user', id: target.id, name: target.email}, {from: target.role, to: role});
    res.json({ok: true});
  } catch (e){ next(e); }
});
api.get('/audit', need('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const {rows} = await db(`SELECT a.id, a.at, a.action, a.target_type, a.target_name, a.detail, a.count, coalesce(u.name, a.user_email) AS user_name
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = $1 ORDER BY a.at DESC LIMIT $2`, [ORG.id, limit]);
    res.json({entries: rows});
  } catch (e){ next(e); }
});

/* data sources: forwarded to Basira Gateway with the server's key */
async function gateway(pathname, init){
  if (!CFG.gatewayUrl) throw new HttpError(501, 'No gateway is configured on this server (GATEWAY_URL).');
  let r;
  try { r = await fetch(CFG.gatewayUrl + pathname, {...init, headers: {Authorization: 'Bearer ' + CFG.gatewayKey, 'Content-Type': 'application/json'}, signal: AbortSignal.timeout(180000)}); }
  catch { throw new HttpError(502, 'The data gateway could not be reached.'); }
  const j = await r.json().catch(() => ({error: `The gateway replied ${r.status}.`}));
  if (!r.ok) throw new HttpError(r.status, j.error || `The gateway replied ${r.status}.`);
  return j;
}
api.get('/gateway/health', need('editor'), async (_req, res, next) => { try { res.json(await gateway('/health')); } catch (e){ next(e); } });
api.get('/gateway/connections', need('editor'), async (_req, res, next) => { try { res.json(await gateway('/connections')); } catch (e){ next(e); } });
api.get('/gateway/tables', need('editor'), async (req, res, next) => {
  try { res.json(await gateway('/tables?connection=' + encodeURIComponent(String(req.query.connection || '')))); } catch (e){ next(e); }
});
api.post('/gateway/query', need('editor'), small, async (req, res, next) => {
  try {
    const {connection, query, table, limit} = req.body || {};
    const out = await gateway('/query', {method: 'POST', body: JSON.stringify({connection, query, table, limit})});
    await audit(req, 'source.query', {type: 'connection', id: String(connection), name: String(connection)}, {rows: out.rows?.length, query: String(out.query || '').slice(0, 2000)});
    res.json(out);
  } catch (e){ next(e); }
});

api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
  const msg = status >= 500 && !err.status ? 'Something went wrong on the server.' : err.type === 'entity.too.large' ? `That is larger than this server accepts (MAX_UPLOAD=${CFG.maxUpload}).` : err.message;
  if (req.accepts(['json', 'html']) === 'html' && req.path.includes('/auth/'))
    return res.status(status).send(`<!doctype html><meta charset="utf-8"><title>Basira</title><body style="font:15px system-ui;max-width:520px;margin:12vh auto;padding:0 16px"><h2>Sign-in problem</h2><p>${String(msg).replace(/[<>&]/g, '')}</p><p><a href="${BASE || '/'}">Back to Basira</a></p>`);
  res.status(status).json({error: msg, ...(err.extra || {})});
});

/* ============================== start ============================== */
async function start(){
  for (let i = 1; ; i++){
    try { await migrate(); break; }
    catch (e){ if (i >= 30) throw e; console.log(`[db] waiting for PostgreSQL (${e.message})`); await new Promise(r => setTimeout(r, 2000)); }
  }
  setInterval(() => db('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 3600e3).unref();
  app.listen(CFG.port, () => console.log(`Basira server listening on port ${CFG.port} for ${PUBLIC_URL} · org "${ORG.name}" · sign-in: ${CFG.authMode} · storage: ${storage.name}${CFG.gatewayUrl ? ' · gateway: ' + CFG.gatewayUrl : ''}`));
}
start().catch(e => { console.error('[fatal]', e); process.exit(1); });
