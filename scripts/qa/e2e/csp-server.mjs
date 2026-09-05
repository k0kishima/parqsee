// Serves the built frontend (frontend/dist) with the Content-Security-Policy
// from backend/tauri.conf.json, the way the release app's tauri:// protocol
// handler does — the Vite dev server sends no CSP, so a violation only shows
// up in the release build otherwise. Point the suite at it with DEV_URL.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const DIST = process.env.DIST ?? path.join(ROOT, 'frontend', 'dist');
const CSP = process.env.CSP ?? JSON.parse(readFileSync(path.join(ROOT, 'backend', 'tauri.conf.json'), 'utf8')).app.security.csp;
const PORT = Number(process.env.PORT ?? 1421);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

if (!existsSync(path.join(DIST, 'index.html'))) throw new Error(`no build at ${DIST} — run \`pnpm build\` in frontend/ first`);
if (!CSP) throw new Error('no CSP: app.security.csp in backend/tauri.conf.json is empty');

http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file);
  const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`serving ${DIST} on http://localhost:${PORT}/ with CSP: ${CSP}`));
