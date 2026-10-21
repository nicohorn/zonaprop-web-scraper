// Capturas de la interfaz (debug/ux/, ignorado por git):  node scripts/ux-screenshots.js [url]
// Necesita el servidor corriendo (node src/server.js). Usa el Chrome de Puppeteer, sin ventana.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3210/';
const OUT = 'debug/ux';
mkdirSync(OUT, { recursive: true });
const shots = [
  ['01-inicio', '#inicio'],
  ['02-datos', '#datos'],
  ['03-predecir', '#predecir', async (p) => { await p.waitForSelector('#pform:not([hidden])', { timeout: 20000 }); await p.click('#pbtn'); await p.waitForSelector('.price-big', { timeout: 60000 }); }],
  ['04-modelos', '#modelos'],
  ['05-modelo-A-seleccionado', '#modelos&modelo=A'],
  ['06-experimentos', '#experimentos'],
  ['07-experimentos-variantes', '#experimentos&t=variantes'],
  ['08-docs-historial', '#docs&t=historial'],
  ['09-modelo-C-seleccionado', '#modelos&modelo=C'],
  ['10-experimentos-modelo-C', '#experimentos&modelo=C'],
  ['11-predecir-con-modelo-B', '#predecir&modelo=B'],
  ['12-docs-modelo-C', '#docs&modelo=C'],
  ['13-inicio-modelo-B', '#inicio&modelo=B'],
];
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
for (const [name, hash, act] of shots) {
  await page.goto('about:blank');
  await page.goto(BASE + hash, { waitUntil: 'load' }); // /api/events (SSE) queda abierto: no usar networkidle
  await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
  if (act) await act(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${OUT}/${name}.png`);
}
// Móvil
await page.setViewport({ width: 390, height: 844, isMobile: true });
await page.goto('about:blank');
await page.goto(BASE + '#predecir', { waitUntil: 'load' });
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
await page.screenshot({ path: `${OUT}/14-movil-predecir.png`, fullPage: true });
console.log(`${OUT}/14-movil-predecir.png`);
await browser.close();
console.log(errors.length ? `Errores en la página:\n${errors.join('\n')}` : 'Sin errores de JavaScript.');
