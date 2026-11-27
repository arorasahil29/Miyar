#!/usr/bin/env node
/*
 * Builds the secured Miyar bundle into ../secure/:
 *   - every library and font is copied next to the page, so it never loads anything from another site
 *   - a strict Content-Security-Policy is added: the page may only load and contact its own origin
 *   - library <script>s carry SHA-384 integrity hashes, so a changed file is refused by the browser
 *   - SHA256SUMS and build.json list every file with its hash, for review and approval
 *
 *   cd tools && npm ci && npm run build:secure
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, 'secure');
const nm = p => path.join(here, 'node_modules', p);
const pkg = name => JSON.parse(fs.readFileSync(nm(name + '/package.json'), 'utf8'));

const LIBS = [
  {name: 'echarts', file: 'echarts/dist/echarts.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js', local: 'vendor/echarts-5.4.3.min.js'},
  {name: 'xlsx', file: 'xlsx/dist/xlsx.full.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', local: 'vendor/xlsx-0.18.5.full.min.js'},
  {name: 'pdfjs-dist', file: 'pdfjs-dist/build/pdf.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', local: 'vendor/pdf-3.11.174.min.js'},
  {name: 'pdfjs-dist', file: 'pdfjs-dist/build/pdf.worker.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', local: 'vendor/pdf.worker-3.11.174.min.js'},
  {name: 'jspdf', file: 'jspdf/dist/jspdf.umd.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', local: 'vendor/jspdf-2.5.1.umd.min.js'},
  {name: 'html2canvas', file: 'html2canvas/dist/html2canvas.min.js', cdn: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', local: 'vendor/html2canvas-1.4.1.min.js'},
];
const FONTS = [
  {family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', files: [400, 500, 600].map(w => [w, `ibm-plex-sans-latin-${w}-normal.woff2`, null])},
  {family: 'IBM Plex Sans Arabic', pkg: '@fontsource/ibm-plex-sans-arabic', files: [400, 500, 600].map(w => [w, `ibm-plex-sans-arabic-arabic-${w}-normal.woff2`, 'U+0600-06FF,U+0750-077F,U+0870-089F,U+08A0-08FF,U+200C-200E,U+FB50-FDFF,U+FE70-FEFF'])},
  {family: 'IBM Plex Mono', pkg: '@fontsource/ibm-plex-mono', files: [400, 500].map(w => [w, `ibm-plex-mono-latin-${w}-normal.woff2`, null])},
  {family: 'Space Grotesk', pkg: '@fontsource/space-grotesk', files: [500, 600].map(w => [w, `space-grotesk-latin-${w}-normal.woff2`, null])},
];
const sha = (alg, buf) => crypto.createHash(alg).update(buf).digest('base64');
const hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(path.join(out, 'vendor', 'licenses'), {recursive: true});
fs.mkdirSync(path.join(out, 'fonts'), {recursive: true});

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const version = (html.match(/const MIYAR_VERSION = '([^']+)'/) || [])[1];
if (!version) throw new Error('MIYAR_VERSION not found in index.html');

// 1. libraries: copy, hash, point the page at the local copies
const integrity = {};
for (const lib of LIBS){
  const buf = fs.readFileSync(nm(lib.file));
  fs.writeFileSync(path.join(out, lib.local), buf);
  lib.version = pkg(lib.name).version; lib.license = pkg(lib.name).license; lib.integrity = 'sha384-' + sha('sha384', buf);
  integrity[lib.local] = lib.integrity;
  if (!html.includes(lib.cdn)) throw new Error('Expected URL not found in index.html: ' + lib.cdn);
  html = html.split(lib.cdn).join(lib.local);
  const lic = fs.readdirSync(nm(lib.name)).find(f => /^licen[cs]e/i.test(f));
  if (lic) fs.copyFileSync(nm(`${lib.name}/${lic}`), path.join(out, 'vendor', 'licenses', `${lib.name}-LICENSE.txt`));
}
html = html.replace(/<script src="(vendor\/echarts-[^"]+)"><\/script>/, (_, src) => `<script src="${src}" integrity="${integrity[src]}"></script>`);

// 2. fonts: copy and declare locally instead of Google Fonts
let faces = '';
for (const f of FONTS){
  for (const [w, file, range] of f.files){
    fs.copyFileSync(nm(`${f.pkg}/files/${file}`), path.join(out, 'fonts', file));
    faces += `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${w};font-display:swap;src:url("fonts/${file}") format("woff2")${range ? `;unicode-range:${range}` : ''}}\n`;
  }
  const lic = fs.readdirSync(nm(f.pkg)).find(x => /^licen[cs]e/i.test(x));
  if (lic) fs.copyFileSync(nm(`${f.pkg}/${lic}`), path.join(out, 'vendor', 'licenses', `${f.pkg.split('/')[1]}-LICENSE.txt`));
}
const before = html.length;
html = html.replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n?/, '').replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">\n?/, '');
if (html.length === before) throw new Error('Google Fonts link not found');

// 3. mark the build, list library hashes for scripts loaded on demand
html = html.replace('<title>Miyar</title>', `<title>Miyar</title>\n<meta name="miyar-build" content="secure">\n<style>\n${faces}</style>\n<script type="application/json" id="miyar-integrity">${JSON.stringify(integrity)}</script>`);

// 4. Content-Security-Policy: only this origin; inline code allowed only by exact hash
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (inline.length !== 1) throw new Error('Expected exactly one inline script, found ' + inline.length);
const scriptHashes = inline.map(code => `'sha256-${sha('sha256', Buffer.from(code, 'utf8'))}'`);
const csp = [
  "default-src 'none'",
  `script-src 'self' ${scriptHashes.join(' ')} 'unsafe-eval'`,   // 'unsafe-eval': calculated-field formulas, validated by the app before compiling
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">`);
if (/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>`]*\.(js|css|woff2?)\b/i.test(html)) throw new Error('The page still refers to an external script, stylesheet or font');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'csp.txt'), csp + '\n');

// 5. manifest and checksums
const files = [];
const walk = d => { for (const f of fs.readdirSync(d).sort()){ const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!['SHA256SUMS', 'build.json'].includes(f)) files.push(p); } };
walk(out);
const list = files.map(p => { const buf = fs.readFileSync(p); return {path: path.relative(out, p).split(path.sep).join('/'), bytes: buf.length, sha256: hex(buf)}; });
fs.writeFileSync(path.join(out, 'SHA256SUMS'), list.map(f => `${f.sha256}  ${f.path}`).join('\n') + '\n');
let commit = 'unknown'; try { commit = execSync('git rev-parse --short HEAD', {cwd: root}).toString().trim(); } catch {}
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({
  name: 'Miyar', version, flavour: 'secured', sourceCommit: commit, contentSecurityPolicy: csp,
  libraries: LIBS.map(l => ({name: l.name, version: l.version, license: l.license, file: l.local, integrity: l.integrity})),
  fonts: FONTS.map(f => ({family: f.family, package: f.pkg, version: pkg(f.pkg).version, license: pkg(f.pkg).license})),
  files: list,
}, null, 2) + '\n');
console.log(`Built secured Miyar ${version} into secure/ (${list.length} files, ${(list.reduce((a, f) => a + f.bytes, 0) / 1e6).toFixed(1)} MB)`);
