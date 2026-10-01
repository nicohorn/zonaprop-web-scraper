// Corrida por consola, sin interfaz web. Usa los parámetros guardados desde la interfaz
// (data/settings.json) o, si no hay, los valores por defecto de src/settings.js.
//   node src/scrape.js                  listado + fichas
//   node src/scrape.js --solo-listado   sólo fase 1
//   node src/scrape.js --solo-detalle   sólo fase 2 (fichas pendientes de data/listings.jsonl)
//   node src/scrape.js --limite 20      tope de fichas a visitar en esta corrida
//   node src/scrape.js --headless       sin ventana (recién cuando ya tengas la cookie)
//
// Todo se persiste línea a línea: Ctrl+C es seguro y la corrida siguiente retoma.

import { Crawler } from './crawler.js';
import { loadSettings } from './settings.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const settings = loadSettings();
if (flag('--headless')) settings.headless = true;
if (flag('--solo-detalle')) settings.scrapeDetails = true;
if (opt('--limite')) settings.maxDetailsPerRun = opt('--limite');

const ts = () => new Date().toISOString().slice(11, 19);
const crawler = new Crawler();
crawler.on('log', (m) => console.log(ts(), m));
process.on('SIGINT', () => crawler.stop());

await crawler.init();
const result = await crawler.run(settings, { soloListado: flag('--solo-listado'), soloDetalle: flag('--solo-detalle') });
if (result === 'terminado') console.log('Exportar a CSV: npm run csv');
process.exit(result === 'error' ? 1 : 0);
