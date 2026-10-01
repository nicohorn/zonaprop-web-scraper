// Interfaz web local: http://localhost:3210
//   node src/server.js          levanta el servidor
//   node src/server.js --open   además abre el navegador (lo que hace el .bat)
//
// Un solo proceso: sirve la página (ui/index.html), guarda los parámetros y maneja la corrida.
// Sólo escucha en 127.0.0.1.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { Crawler } from './crawler.js';
import { exportCsv } from './export.js';
import { loadSettings, saveSettings } from './settings.js';
import { OPERACIONES, TIPOS, ZONAS_SUGERIDAS } from './explore.js';

// Las rutas de config.js (data/, .perfil-chrome/) son relativas a la carpeta del proyecto.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const PORT = Number(process.env.PORT) || config.port;
const URL_ = `http://localhost:${PORT}`;
const LOG_LINES = 800;

const openInBrowser = (url) => {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* se abre a mano */ }
};

// --- Corrida, log y eventos -----------------------------------------------------------------
const crawler = new Crawler();
const clients = new Set(); // respuestas SSE abiertas
const logBuf = [];
const logPath = join(config.out.dir, config.out.log);
mkdirSync(config.out.dir, { recursive: true });

const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
};

crawler.on('log', (text) => {
  const d = new Date();
  const time = d.toLocaleTimeString('es-AR', { hour12: false });
  for (const raw of String(text).split('\n')) {
    const line = raw.trim() ? `${time} ${raw}` : '';
    logBuf.push(line);
    if (logBuf.length > LOG_LINES) logBuf.shift();
    console.log(line);
    try { appendFileSync(logPath, `${d.toISOString().slice(0, 10)} ${line}\n`); } catch { /* disco lleno: seguir */ }
    broadcast('log', line);
  }
});
crawler.on('status', (s) => broadcast('status', s));

// --- HTTP -----------------------------------------------------------------------------------
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw new Error('Cuerpo demasiado grande');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Sólo se aceptan pedidos hechos desde la propia página (no desde otro sitio abierto en el navegador). */
function sameOrigin(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try { return new URL(origin).host === host; } catch { return false; }
}

async function sendCsv(res, file, name, opts) {
  const path = join(config.out.dir, file);
  if (!existsSync(path)) return json(res, 404, { error: 'Todavía no hay datos para exportar.' });
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="zonaprop-${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  await exportCsv(path, res, opts);
  res.end();
}

async function shutdown() {
  crawler.stop();
  while (crawler.running) await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

const routes = {
  'GET /': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(join(ROOT, 'ui', 'index.html')));
  },
  'GET /api/state': (req, res) => json(res, 200, {
    settings: loadSettings(),
    status: crawler.status(),
    log: logBuf,
    options: { operaciones: OPERACIONES, tipos: TIPOS, zonas: ZONAS_SUGERIDAS },
    dataDir: resolve(config.out.dir),
  }),
  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(crawler.status())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },
  // Con historial de cambios un aviso tiene varias líneas: "avisos" trae la vigente de cada uno.
  'GET /api/export/listings.csv': (req, res) => sendCsv(res, config.out.listings, 'avisos', { latestBy: 'id' }),
  'GET /api/export/history.csv': (req, res) => sendCsv(res, config.out.listings, 'historial'),
  'GET /api/export/details.csv': (req, res) => sendCsv(res, config.out.details, 'fichas'),
  'POST /api/settings': async (req, res) => json(res, 200, { settings: saveSettings(await readBody(req)) }),
  'POST /api/start': async (req, res) => {
    if (crawler.running) return json(res, 409, { error: 'Ya hay una corrida en curso.' });
    const settings = saveSettings(await readBody(req));
    crawler.run(settings); // no se espera: avisa por eventos
    json(res, 200, { settings, status: crawler.status() });
  },
  'POST /api/stop': (req, res) => { crawler.stop(); json(res, 200, { status: crawler.status() }); },
  'POST /api/reset-exploration': (req, res) => {
    if (crawler.running) return json(res, 409, { error: 'Detené la corrida antes de reiniciar la exploración.' });
    crawler.resetFrontier();
    crawler.log('Exploración reiniciada: la próxima corrida vuelve a recorrer todas las búsquedas (los avisos guardados se conservan).');
    json(res, 200, { status: crawler.status() });
  },
  'POST /api/open-data': (req, res) => {
    const dir = resolve(config.out.dir);
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { spawn(cmd, [dir], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* nada */ }
    json(res, 200, { dir });
  },
  'POST /api/shutdown': (req, res) => { json(res, 200, { ok: true }); shutdown(); },
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, URL_).pathname;
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return json(res, 404, { error: 'No existe' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Origen no permitido' });
  try {
    await ready;
    await handler(req, res);
  } catch (e) {
    if (res.headersSent) res.end();
    else json(res, 400, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`El scraper ya está abierto en ${URL_}. Abro esa ventana.`);
    openInBrowser(URL_);
    process.exit(0);
  }
  throw e;
});

let ready; // carga de los datos ya guardados; recién se hace si el puerto estaba libre
server.listen(PORT, '127.0.0.1', () => {
  ready = crawler.init();
  console.log(`\n  ZonaProp Scraper listo en ${URL_}`);
  console.log('  Dejá esta ventana abierta mientras lo uses. Cerrarla detiene todo.\n');
  if (process.argv.includes('--open')) openInBrowser(URL_);
});
setInterval(() => broadcast('ping', 1), 25_000).unref();

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
