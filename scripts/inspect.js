// Diagnóstico de una URL: abre el navegador, resuelve el challenge si salta, guarda el HTML y
// una captura en ./debug, e imprime qué ve el parser. Es lo primero a correr cuando algo
// devuelve 0 avisos o cuando querés validar el slug de una zona nueva.
//
//   node scripts/inspect.js https://www.zonaprop.com.ar/departamentos-venta-rosario.html
//   node scripts/inspect.js https://www.zonaprop.com.ar/propiedades/clasificado/...-51264287.html

import * as cheerio from 'cheerio';
import { Session } from '../src/browser.js';
import { parseListing, CARD_SELECTOR } from '../src/parse/listing.js';
import { parseDetail, looksLikeDetail } from '../src/parse/detail.js';
import { saveDebugHtml } from '../src/storage.js';

const url = process.argv[2];
if (!url) { console.error('Uso: node scripts/inspect.js <url>'); process.exit(1); }

const isDetail = url.includes('/propiedades/');
const session = new Session({ headless: false });

try {
  await session.launch();
  const html = await session.goto(url, { contentSelector: isDetail ? '#longDescription, h1' : CARD_SELECTOR });
  await session.scroll(3);
  const full = await session.page.content();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const htmlPath = saveDebugHtml(`inspect-${stamp}`, full);
  await session.screenshot(`debug/inspect-${stamp}.png`);

  const $ = cheerio.load(full);
  console.log('\ntitle :', $('title').text().trim());
  console.log('h1    :', $('h1').first().text().trim());
  console.log('HTML  :', htmlPath, `(${(full.length / 1024).toFixed(0)} KB)`);

  const qa = {};
  $('[data-qa]').each((_, el) => { const v = $(el).attr('data-qa'); qa[v] = (qa[v] || 0) + 1; });
  console.log('data-qa:', Object.entries(qa).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}×${n}`).join(', '));

  const jsVars = ['mainFeatures', 'publisher', 'avisoInfo', 'dataLayerInfo', 'doubleClick'].filter((v) => new RegExp(`\\bconst\\s+${v}\\s*=`).test(full));
  console.log('vars JS inline:', jsVars.join(', ') || '(ninguna)');
  console.log('ld+json types :', $('script[type="application/ld+json"]').map((_, s) => { try { return JSON.parse($(s).text())['@type']; } catch { return '?'; } }).get().join(', '));

  if (isDetail) {
    console.log('\nlooksLikeDetail:', looksLikeDetail(full));
    const d = parseDetail(full, { url });
    console.log(JSON.stringify({ ...d, description: (d.description || '').slice(0, 120) + '…', photos: `${d.photos.length} fotos` }, null, 1));
  } else {
    const { h1, total_results, items } = parseListing(full, { search_url: url });
    console.log(`\n${items.length} tarjetas parseadas · total declarado: ${total_results} · h1: "${h1}"`);
    if (items[0]) console.log(JSON.stringify({ ...items[0], photos: `${items[0].photos.length} fotos` }, null, 1));
  }
} finally {
  await session.close();
}
