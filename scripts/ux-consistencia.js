// Capturas de consistencia visual (antes/después): node scripts/ux-consistencia.js <prefijo> [url]
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';
const PRE = process.argv[2] || 'consistencia';
const BASE = process.argv[3] || 'http://localhost:3210';
mkdirSync('debug/ux', { recursive: true });
const shots = [
  ['calidad-oscuro', '/calidad', 'dark'], ['calidad-claro', '/calidad', 'light'],
  ['datos-oscuro', '/#datos', 'dark'], ['inicio-claro', '/#inicio', 'light'],
  ['calidad-seccion', '/#datos&t=calidad&s=embudo', 'dark'], ['calidad-seccion-claro', '/#datos&t=calidad&s=duplicados', 'light'],
  ['calidad-modelo-C', '/#datos&t=calidad&modelo=C', 'light'], ['experimentos-claro', '/#experimentos', 'light'],
  ['calidad-clasico', '/clasico/calidad', 'dark'],
];
const b = await puppeteer.launch({ headless: true });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (const [name, path, scheme] of shots) {
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await p.goto('about:blank'); await p.goto(BASE + path, { waitUntil: 'load' });
  await p.evaluate(() => new Promise((r) => setTimeout(r, 3000)));
  await p.screenshot({ path: `debug/ux/${PRE}-${name}.png`, fullPage: true });
  console.log(`debug/ux/${PRE}-${name}.png`);
}
await b.close();
console.log(errors.length ? 'Errores JS:\n' + errors.join('\n') : 'Sin errores de JavaScript.');
