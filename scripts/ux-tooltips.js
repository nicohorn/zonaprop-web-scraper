// Prueba de los "?" (tooltips) con Puppeteer: hover, clic, teclado, Esc y clic afuera, en varias
// secciones y en tema claro/oscuro. Capturas en debug/ux/tooltip-*.png.
//   node scripts/ux-tooltips.js [url]      (con el servidor andando)
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3210/';
const OUT = 'debug/ux';
mkdirSync(OUT, { recursive: true });
const wait = (p, ms) => p.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
const tipState = (p) => p.evaluate(() => {
  const t = document.getElementById('tooltip'); const r = t.getBoundingClientRect();
  return { visible: !t.hidden && r.width > 0, text: t.textContent, inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
});
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'OK  ' : 'FALLA'} ${name}${extra ? ' · ' + extra : ''}`); };

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const open = async (hash, scheme = 'dark') => {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.goto('about:blank');
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await wait(page, 2500);
};

// 1. Inicio: hover sobre el "?" del error mediano
await open('#inicio');
let el = await page.$('#home-kpis .kpi.accent .tip');
await el.hover(); await wait(page, 200);
let s = await tipState(page);
check('Inicio · hover muestra el globo', s.visible && /mitad de las predicciones/.test(s.text), s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-1-inicio-hover.png` });
await page.mouse.move(5, 5); await wait(page, 200);
check('Inicio · sale el mouse y se cierra', !(await tipState(page)).visible);

// 2. Resultados por modelo: clic en un "?" dentro de una tarjeta (no debe navegar)
await open('#modelos');
el = await page.$('.mcard .mnum .tip');
await el.click(); await wait(page, 300);
s = await tipState(page);
check('Modelos · clic muestra el globo sin abrir la tarjeta', s.visible && (await page.evaluate(() => location.hash)) === '#modelos', s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-2-modelos-clic.png` });
await page.mouse.click(700, 60); await wait(page, 200);
check('Modelos · clic afuera lo cierra', !(await tipState(page)).visible);

// 3. Detalle de A: "?" en el encabezado de una tabla con overflow (no se recorta)
await open('#modelos&modelo=A');
el = await page.$('#m-last .tablewrap th .tip');
await el.evaluate((n) => n.scrollIntoView({ block: 'center' })); await wait(page, 200);
await el.click(); await wait(page, 300);
s = await tipState(page);
check('Tabla de métricas · clic en encabezado, globo entero en pantalla', s.visible && s.inViewport, s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-3-tabla-metricas.png` });
await page.keyboard.press('Escape'); await wait(page, 200);
check('Tabla de métricas · Esc lo cierra', !(await tipState(page)).visible);

// 4. Predecir: teclado (Tab hasta el "?") y resultado
await open('#predecir');
await page.waitForSelector('#pform:not([hidden])', { timeout: 20000 });
await page.click('#pbtn'); await page.waitForSelector('.price-big', { timeout: 60000 }); await wait(page, 300);
await page.focus('#p-dir'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await wait(page, 200);
s = await tipState(page);
check('Predecir · foco con teclado muestra el globo', s.visible && /dirección/i.test(s.text), s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-4-predecir-teclado.png` });
el = await page.$('#pout .compare .kpi .tip');
await el.click(); await wait(page, 300);
s = await tipState(page);
check('Predecir · clic en "?" del resultado', s.visible, s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-5-predecir-resultado.png` });

// 5. Modelo C (rendimiento bruto) y tema claro
await open('#modelos&modelo=C', 'light');
el = await page.$('#m-last .kpi .tip');
await el.hover(); await wait(page, 300);
s = await tipState(page);
check('Modelo C · tema claro, rendimiento bruto', s.visible && /alquiler/.test(s.text), s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-6-modelo-C-claro.png` });

// 6. Experimentos: tabla de variantes, clic y luego re-render (cambio de vista) cierra el globo
await open('#experimentos&t=variantes');
el = await page.$('#v-table th .tip');
await el.click(); await wait(page, 300);
s = await tipState(page);
check('Experimentos · "?" en tabla de variantes', s.visible, s.text.slice(0, 60));
await page.screenshot({ path: `${OUT}/tooltip-7-experimentos.png` });
await page.click('#v-full'); await wait(page, 800);
check('Experimentos · al re-renderizar la tabla se cierra', !(await tipState(page)).visible);
el = await page.$('#v-table th .tip');
await el.hover(); await wait(page, 200);
check('Experimentos · funciona en contenido nuevo (delegación)', (await tipState(page)).visible);

// Todos los "?" tienen texto
const empty = await page.evaluate(async () => [...document.querySelectorAll('.tip')].filter((t) => !t.dataset.tip?.trim()).length);
check('Ningún "?" vacío en la vista actual', empty === 0);

await browser.close();
console.log(results.join('\n'));
console.log(errors.length ? `Errores JS:\n${errors.join('\n')}` : 'Sin errores de JavaScript.');
process.exit(results.some((r) => r.startsWith('FALLA')) ? 1 : 0);
