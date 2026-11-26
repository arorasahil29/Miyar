#!/usr/bin/env node
/*
 * Miyar Gateway: a small read-only query service between Miyar and your data sources.
 * The browser never sees database credentials. It sends a connection name and a read-only
 * query; the gateway runs it with credentials from connections.json (or environment variables)
 * and returns rows as JSON.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {promisify} = require('node:util');

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const KEY = process.env.MIYAR_GATEWAY_KEY || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const CONFIG = process.env.CONNECTIONS_FILE || path.join(__dirname, 'connections.json');
const MAX_ROWS = Number(process.env.MAX_ROWS) || 200000;
const TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS) || 120000;

if (!KEY && process.env.ALLOW_NO_KEY !== '1'){
  console.error('Set MIYAR_GATEWAY_KEY to a long random secret (for example: openssl rand -hex 24).');
  process.exit(1);
}

class HttpError extends Error { constructor(status, message){ super(message); this.status = status; } }

/* ---------- connections ---------- */
let cache = {mtime: 0, map: new Map()};
function substituteEnv(v){
  if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? '');
  if (Array.isArray(v)) return v.map(substituteEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteEnv(x)]));
  return v;
}
function connections(){
  let st;
  try { st = fs.statSync(CONFIG); } catch { throw new HttpError(500, `No connections file found at ${CONFIG}. Copy connections.example.json to connections.json.`); }
  if (st.mtimeMs !== cache.mtime){
    const parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.connections || [];
    const map = new Map();
    for (const c of list){
      if (!c.name || !c.type) throw new HttpError(500, 'Every connection needs a "name" and a "type".');
      if (!DRIVERS[c.type]) throw new HttpError(500, `Connection "${c.name}" has unknown type "${c.type}". Known types: ${Object.keys(DRIVERS).join(', ')}.`);
      map.set(c.name, substituteEnv(c));
    }
    cache = {mtime: st.mtimeMs, map};
  }
  return cache.map;
}
function getConnection(name){
  const c = connections().get(String(name || ''));
  if (!c) throw new HttpError(404, `No connection named "${name}" on this gateway.`);
  return c;
}
function need(mod){
  try { return require(mod); }
  catch (e){ if (e.code === 'MODULE_NOT_FOUND') throw new HttpError(501, `The "${mod}" package is not installed on the gateway. Run: npm install ${mod}`); throw e; }
}

/* ---------- read-only guard ---------- */
function assertReadOnly(sql){
  const s = String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (!s) throw new HttpError(400, 'The query is empty.');
  if (s.includes(';')) throw new HttpError(400, 'Only one statement is allowed per query.');
  if (!/^(select|with|show|describe|desc|explain|values)\b/i.test(s)) throw new HttpError(400, 'Only read-only queries are allowed (SELECT, WITH, SHOW, DESCRIBE).');
  if (/^with\b/i.test(s) && /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke)\b/i.test(s.replace(/'[^']*'/g, "''")))
    throw new HttpError(400, 'Only read-only queries are allowed.');
  return s;
}

/* ---------- value normalisation ---------- */
function norm(v){
  if (v == null) return null;
  if (v instanceof Date){
    if (isNaN(v)) return null;
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v)) return '(binary)';
  if (typeof v === 'object'){
    if (typeof v.value !== 'undefined' && Object.keys(v).length <= 2) return norm(v.value);   // BigQuery dates, numerics
    if (typeof v.toNumber === 'function') return v.toNumber();                                // Decimal / Long
    return JSON.stringify(v);
  }
  if (typeof v === 'string'){ const m = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(v); if (m) return norm(new Date(Number(m[1]))); }
  return v;
}
function shape(rows, limit){
  const out = [], cols = [];
  const seen = new Set();
  for (const r of rows){
    if (out.length >= limit) break;
    const o = {};
    for (const [k, v] of Object.entries(r)){
      if (k.startsWith('__') || k.startsWith('@odata')) continue;
      if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && (v.__deferred || Array.isArray(v.results))) continue;  // OData navigation links
      if (!seen.has(k)){ seen.add(k); cols.push(k); }
      o[k] = norm(v);
    }
    out.push(o);
  }
  return {columns: cols, rows: out, truncated: rows.length > limit};
}

/* ---------- drivers ---------- */
const q = (s, l = '"', r = l) => l + String(s).replace(new RegExp(r === ']' ? '\\]' : r, 'g'), r + r) + r;
const DRIVERS = {
  sqlite: {
    async query(c, sql){ const {DatabaseSync} = require('node:sqlite'); const db = new DatabaseSync(c.file, {readOnly: true}); try { return db.prepare(sql).all(); } finally { db.close(); } },
    tables: c => DRIVERS.sqlite.query(c, "SELECT '' AS schema, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"),
    sample: (t, n) => `SELECT * FROM ${q(t.name)} LIMIT ${n}`,
  },
  postgres: {
    async query(c, sql){
      const {Client} = need('pg');
      const cl = new Client({host: c.host, port: c.port || 5432, database: c.database, user: c.user, password: c.password,
        ssl: c.ssl ? (typeof c.ssl === 'object' ? c.ssl : {rejectUnauthorized: true}) : false, statement_timeout: TIMEOUT_MS});
      await cl.connect();
      try { await cl.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY').catch(() => {}); return (await cl.query(sql)).rows; } finally { await cl.end(); }
    },
    tables: c => DRIVERS.postgres.query(c, "SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2 LIMIT 1000"),
    sample: (t, n) => `SELECT * FROM ${q(t.schema)}.${q(t.name)} LIMIT ${n}`,
  },
  mysql: {
    async query(c, sql){
      const mysql = need('mysql2/promise');
      const cn = await mysql.createConnection({host: c.host, port: c.port || 3306, database: c.database, user: c.user, password: c.password, ssl: c.ssl, dateStrings: false});
      try { await cn.query('SET SESSION TRANSACTION READ ONLY').catch(() => {}); const [rows] = await cn.query({sql, timeout: TIMEOUT_MS}); return rows; } finally { await cn.end(); }
    },
    tables: c => DRIVERS.mysql.query(c, 'SELECT table_schema AS `schema`, table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 2 LIMIT 1000'),
    sample: (t, n) => `SELECT * FROM ${q(t.name, '`')} LIMIT ${n}`,
  },
  sqlserver: {
    async query(c, sql){
      const mssql = need('mssql');
      const pool = await new mssql.ConnectionPool({server: c.server || c.host, port: c.port || 1433, database: c.database, user: c.user, password: c.password,
        options: {encrypt: true, trustServerCertificate: false, ...(c.options || {})}, requestTimeout: TIMEOUT_MS}).connect();
      try { return (await pool.request().query(sql)).recordset; } finally { await pool.close(); }
    },
    tables: c => DRIVERS.sqlserver.query(c, 'SELECT TOP 1000 TABLE_SCHEMA AS [schema], TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES ORDER BY 1, 2'),
    sample: (t, n) => `SELECT TOP ${n} * FROM ${q(t.schema, '[', ']')}.${q(t.name, '[', ']')}`,
  },
  oracle: {
    async query(c, sql, limit){
      const oracledb = need('oracledb');
      const cn = await oracledb.getConnection({user: c.user, password: c.password, connectString: c.connectString});
      try { cn.callTimeout = TIMEOUT_MS; return (await cn.execute(sql, [], {outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: limit + 1})).rows; } finally { await cn.close(); }
    },
    tables: c => DRIVERS.oracle.query(c, "SELECT owner AS \"schema\", table_name AS \"name\" FROM all_tables WHERE owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','ORDSYS','OUTLN','DBSNMP','WMSYS','APPQOSSYS','GSMADMIN_INTERNAL','LBACSYS','OJVMSYS','AUDSYS','DVSYS','OLAPSYS') ORDER BY 1, 2 FETCH FIRST 1000 ROWS ONLY", 1000),
    sample: (t, n) => `SELECT * FROM ${q(t.schema)}.${q(t.name)} FETCH FIRST ${n} ROWS ONLY`,
  },
  saphana: {
    async query(c, sql){
      const hana = need('@sap/hana-client');
      const cn = hana.createConnection();
      await promisify(cn.connect.bind(cn))({serverNode: `${c.host}:${c.port || 443}`, uid: c.user, pwd: c.password, encrypt: c.encrypt ?? true,
        sslValidateCertificate: c.sslValidateCertificate ?? true, currentSchema: c.schema});
      try { return await promisify(cn.exec.bind(cn))(sql); } finally { cn.disconnect(); }
    },
    tables: c => DRIVERS.saphana.query(c, "SELECT SCHEMA_NAME AS \"schema\", TABLE_NAME AS \"name\" FROM SYS.TABLES WHERE SCHEMA_NAME NOT LIKE '_SYS%' AND SCHEMA_NAME NOT IN ('SYS','SYSTEM') ORDER BY 1, 2 LIMIT 1000"),
    sample: (t, n) => `SELECT * FROM ${q(t.schema)}.${q(t.name)} LIMIT ${n}`,
  },
  databricks: {
    async query(c, sql, limit){
      const {DBSQLClient} = need('@databricks/sql');
      const client = new DBSQLClient();
      await client.connect({host: c.host, path: c.path, token: c.token});
      try {
        const session = await client.openSession({initialCatalog: c.catalog, initialSchema: c.schema});
        try { const op = await session.executeStatement(sql, {maxRows: Math.min(limit + 1, 100000)}); try { return await op.fetchAll(); } finally { await op.close(); } }
        finally { await session.close(); }
      } finally { await client.close(); }
    },
    async tables(c){
      const rows = await DRIVERS.databricks.query(c, c.schema ? `SHOW TABLES IN ${q(c.schema, '`')}` : 'SHOW TABLES', 1000);
      return rows.map(r => ({schema: r.database || r.namespace || c.schema || '', name: r.tableName || r.table_name || r.name}));
    },
    sample: (t, n) => `SELECT * FROM ${t.schema ? q(t.schema, '`') + '.' : ''}${q(t.name, '`')} LIMIT ${n}`,
  },
  snowflake: {
    async query(c, sql){
      const sf = need('snowflake-sdk');
      sf.configure?.({logLevel: 'ERROR'});
      const cn = sf.createConnection({account: c.account, username: c.username || c.user, password: c.password, authenticator: c.authenticator,
        privateKey: c.privateKey, warehouse: c.warehouse, database: c.database, schema: c.schema, role: c.role, timeout: TIMEOUT_MS});
      await promisify(cn.connect.bind(cn))();
      try { return await new Promise((res, rej) => cn.execute({sqlText: sql, complete: (err, _s, rows) => err ? rej(err) : res(rows)})); }
      finally { cn.destroy(() => {}); }
    },
    tables: c => DRIVERS.snowflake.query(c, "SELECT table_schema AS \"schema\", table_name AS \"name\" FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA' ORDER BY 1, 2 LIMIT 1000"),
    sample: (t, n) => `SELECT * FROM ${q(t.schema)}.${q(t.name)} LIMIT ${n}`,
  },
  bigquery: {
    async query(c, sql, limit){
      const {BigQuery} = need('@google-cloud/bigquery');
      const bq = new BigQuery({projectId: c.projectId, keyFilename: c.keyFilename});
      const [rows] = await bq.query({query: sql, location: c.location, maxResults: limit + 1, jobTimeoutMs: TIMEOUT_MS});
      return rows;
    },
    async tables(c){
      const {BigQuery} = need('@google-cloud/bigquery');
      const bq = new BigQuery({projectId: c.projectId, keyFilename: c.keyFilename});
      const out = [];
      const [sets] = await bq.getDatasets();
      for (const ds of sets.slice(0, 50)){ const [tabs] = await ds.getTables(); for (const t of tabs) out.push({schema: ds.id, name: t.id}); if (out.length > 1000) break; }
      return out;
    },
    sample: (t, n) => `SELECT * FROM \`${String(t.schema).replace(/`/g, '')}.${String(t.name).replace(/`/g, '')}\` LIMIT ${n}`,
  },
  /* OData v2/v4: SAP S/4HANA and SAP BW (through SAP Gateway), Dynamics 365 and others.
     The "query" is an entity set path under the service URL, e.g. "A_SalesOrder?$top=5000". */
  odata: {
    readOnly: false,
    async query(c, pathAndQuery, limit){
      const base = new URL(c.url.replace(/\/?$/, '/'));
      let url = new URL(String(pathAndQuery || '').replace(/^\//, ''), base);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new HttpError(400, 'The path must stay inside the configured OData service.');
      const headers = {Accept: 'application/json'};
      if (c.token) headers.Authorization = `Bearer ${c.token}`;
      else if (c.user) headers.Authorization = 'Basic ' + Buffer.from(`${c.user}:${c.password || ''}`).toString('base64');
      if (c.client) url.searchParams.set('sap-client', c.client);
      const rows = [];
      for (let page = 0; page < 1000 && url && rows.length <= limit; page++){
        const r = await fetch(url, {headers, signal: AbortSignal.timeout(TIMEOUT_MS)});
        if (!r.ok) throw new HttpError(502, `The OData service replied ${r.status} ${r.statusText}.`);
        const j = await r.json();
        const batch = j.value || j.d?.results || (Array.isArray(j.d) ? j.d : null) || (j.d ? [j.d] : []);
        rows.push(...batch);
        const next = j['@odata.nextLink'] || j.d?.__next;
        url = next ? new URL(next, base) : null;
        if (url && url.origin !== base.origin) url = null;
      }
      return rows;
    },
    async tables(c){
      const rows = await (async () => {
        const headers = {Accept: 'application/json'};
        if (c.token) headers.Authorization = `Bearer ${c.token}`;
        else if (c.user) headers.Authorization = 'Basic ' + Buffer.from(`${c.user}:${c.password || ''}`).toString('base64');
        const r = await fetch(c.url.replace(/\/?$/, '/'), {headers, signal: AbortSignal.timeout(TIMEOUT_MS)});
        if (!r.ok) throw new HttpError(502, `The OData service replied ${r.status} ${r.statusText}.`);
        const j = await r.json();
        return j.value ? j.value.map(x => x.name || x.url) : (j.d?.EntitySets || []);
      })();
      return rows.map(name => ({schema: '', name}));
    },
    sample: (t, n) => `${t.name}?$top=${n}`,
  },
};
DRIVERS.redshift = DRIVERS.postgres;
DRIVERS.mariadb = DRIVERS.mysql;
DRIVERS.azuresql = DRIVERS.sqlserver;
DRIVERS.synapse = DRIVERS.sqlserver;

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new HttpError(504, `The query took longer than ${Math.round(ms / 1000)} seconds.`)), ms))]);

/* ---------- HTTP ---------- */
function cors(req, res){
  const origin = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  else if (origin && ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}
function send(res, status, body){ res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(body)); }
function authorised(req){
  if (!KEY) return true;
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6){ reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'The request body must be JSON.')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://gateway');
  const started = Date.now();
  try {
    if (url.pathname === '/health') return send(res, 200, {ok: true, name: 'miyar-gateway', version: VERSION});
    if (!authorised(req)) throw new HttpError(401, 'Wrong or missing access key.');
    if (req.method === 'GET' && url.pathname === '/connections')
      return send(res, 200, {connections: [...connections().values()].map(c => ({name: c.name, type: c.type, description: c.description || ''}))});
    if (req.method === 'GET' && url.pathname === '/tables'){
      const c = getConnection(url.searchParams.get('connection'));
      const rows = await withTimeout(DRIVERS[c.type].tables(c), TIMEOUT_MS);
      return send(res, 200, {tables: rows.map(r => ({schema: norm(r.schema ?? r.SCHEMA ?? '') || '', name: norm(r.name ?? r.NAME)}))});
    }
    if (req.method === 'POST' && url.pathname === '/query'){
      const body = await readBody(req);
      const c = getConnection(body.connection);
      const drv = DRIVERS[c.type];
      const limit = Math.max(1, Math.min(Number(body.limit) || 50000, MAX_ROWS));
      let text;
      if (body.table) text = drv.sample({schema: body.table.schema || '', name: body.table.name}, limit);
      else text = drv.readOnly === false ? String(body.query || '') : assertReadOnly(body.query);
      const rows = await withTimeout(drv.query(c, text, limit), TIMEOUT_MS);
      const out = shape(rows, limit);
      console.log(`[query] ${c.name} (${c.type}) ${out.rows.length} rows in ${Date.now() - started} ms`);
      return send(res, 200, {...out, query: text, ms: Date.now() - started});
    }
    throw new HttpError(404, 'Not found.');
  } catch (e){
    const status = e.status || 500;
    if (status >= 500) console.error(`[error] ${req.method} ${url.pathname}:`, e.message);
    send(res, status, {error: e.status ? e.message : `The data source returned an error: ${e.message}`});
  }
});
server.listen(PORT, HOST, () => console.log(`Miyar Gateway ${VERSION} listening on http://${HOST}:${PORT} (allowed origins: ${ORIGINS.join(', ')})`));
