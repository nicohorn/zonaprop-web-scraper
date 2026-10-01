// Parseo de una página de resultados.
//
// Dos fuentes, ambas del mismo HTML:
//   1. Las tarjetas <div data-qa="posting PROPERTY" data-id=...>. Los data-qa los usa ZonaProp
//      para sus propios tests, por eso son bastante estables.
//   2. Un bloque JSON-LD @type=RealEstateListing cuyo mainEntity[] tiene, por aviso, el nombre
//      de la inmobiliaria y la fecha de publicación (que en la tarjeta no aparecen).
//
// Verificado contra una captura real de septiembre 2026 (test/fixtures).

import * as cheerio from 'cheerio';
import { cleanText, num, int, parsePrice, jsonLd, usDateToIso } from './util.js';
import { listingUrl, idFromUrl } from '../urls.js';

// PROPERTY = aviso común; DEVELOPMENT = emprendimiento (hasta 5 de las 30 tarjetas por página).
export const CARD_SELECTOR = '[data-qa="posting PROPERTY"], [data-qa="posting DEVELOPMENT"]';

/** '50 m² tot. 2 amb. 1 dorm. 1 baño 1 coch.' -> campos numéricos */
export function parseFeatures(text) {
  const grab = (re) => { const m = text.match(re); return m ? num(m[1]) : null; };
  return {
    superficie_total: grab(/([\d.,]+)\s*m²\s*tot/i),
    superficie_cubierta: grab(/([\d.,]+)\s*m²\s*cub/i),
    ambientes: int(grab(/([\d.,]+)\s*amb/i)),
    dormitorios: int(grab(/([\d.,]+)\s*dorm/i)),
    banos: int(grab(/([\d.,]+)\s*baño/i)),
    cocheras: int(grab(/([\d.,]+)\s*coch/i)),
  };
}

/** Metadata por id de aviso que sólo está en el JSON-LD: { publisher, date_posted }. */
function listingMetaFromJsonLd($) {
  const meta = new Map();
  for (const block of jsonLd($)) {
    if (block['@type'] !== 'RealEstateListing') continue;
    for (const e of block.mainEntity || []) {
      const id = idFromUrl(e.url);
      if (id) meta.set(id, { publisher: cleanText(e.name) || null, date_posted: usDateToIso(e.datePosted) });
    }
  }
  return meta;
}

/**
 * @param {string} html  HTML completo de la página de resultados
 * @param {object} ctx   campos que se copian a cada aviso (search_slug, page, tipo, operacion, zona)
 * @returns {{ h1: string, total_results: number|null, items: object[] }}
 */
export function parseListing(html, ctx = {}) {
  const $ = cheerio.load(html);
  const h1 = cleanText($('h1').first().text());
  const total = h1.match(/^([\d.]+)/);
  const meta = listingMetaFromJsonLd($);
  const scraped_at = new Date().toISOString();
  const items = [];

  $(CARD_SELECTOR).each((_, el) => {
    const card = $(el);
    const id = card.attr('data-id');
    if (!id) return;

    const qa = (name) => cleanText(card.find(`[data-qa="${name}"]`).first().text());
    const href = card.attr('data-to-posting') || card.find('a[href]').first().attr('href');
    const price = parsePrice(qa('POSTING_CARD_PRICE'));
    const featuresText = card.find('[data-qa="POSTING_CARD_FEATURES"] span')
      .map((_, s) => cleanText($(s).text())).get().join(' ');

    // El título "de verdad" está sólo en la ficha; en la tarjeta lo más parecido es el alt de
    // la primera foto: 'Departamento · 46m² · 2 Ambientes · <título del aviso>'
    const alt = card.find('[data-qa="POSTING_CARD_GALLERY"] img').first().attr('alt') || '';
    const altParts = alt.split(' · ');
    const title = altParts.length > 1 ? cleanText(altParts[altParts.length - 1]) : cleanText(alt) || null;

    const photos = card.find('[data-qa="POSTING_CARD_GALLERY"] img')
      .map((_, img) => $(img).attr('src') || $(img).attr('data-flickity-lazyload') || $(img).attr('data-src'))
      .get()
      .filter((u) => u && u.startsWith('http'))
      .map((u) => u.split('?')[0]);

    const m = meta.get(id) || {};

    items.push({
      id,
      posting_type: card.attr('data-posting-type') || (card.attr('data-qa') || '').replace('posting ', '') || null,
      url: listingUrl(href),
      title,
      price_currency: price.currency,
      price: price.amount, // null = "Consultar precio"
      expensas: num(qa('expensas')), // null = no informa (NO es cero)
      ...parseFeatures(featuresText),
      address: cleanText(card.find('[class*="location-address"]').first().text()) || null,
      location: qa('POSTING_CARD_LOCATION') || null,
      description_short: qa('POSTING_CARD_DESCRIPTION') || null,
      publisher: m.publisher ?? null,
      date_posted: m.date_posted ?? null,
      highlight: cleanText(card.find('[class*="__highlight"]').first().text()) || null, // 'Super destacado', ...
      pills: card.find('[class*="pill-item-span"]').map((_, s) => cleanText($(s).text())).get(),
      photos: [...new Set(photos)],
      ...ctx,
      scraped_at,
    });
  });

  return { h1, total_results: total ? num(total[1]) : null, items };
}
