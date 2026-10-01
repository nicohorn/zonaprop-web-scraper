// Parseo de la ficha de un aviso.
//
// La ficha viene server-rendered con varios objetos JS inline que son la fuente más limpia:
//   const mainFeatures = {...}   superficie, ambientes, antigüedad, orientación, disposición...
//   const publisher    = {...}   inmobiliaria (id, nombre, url)
//   const avisoInfo    = {...}   precio estructurado (pricesData), expensas, estado, código,
//                                amenities por categoría (generalFeatures). Es un literal JS con
//                                comillas mezcladas, no JSON: se leen claves sueltas con jsKey /
//                                jsKeyJson en vez de parsearlo entero.
//   const dataLayerInfo = {...}  operación, tipo de propiedad, barrio / ciudad / provincia
//   const doubleClick  = {...}   ids internos de provincia / ciudad / barrio
// Más el JSON-LD (@type Apartment/House/...) con la dirección, #longDescription y la galería.
//
// IMPORTANTE: la ficha NO trae coordenadas (verificado contra captura de septiembre 2026). Si
// hacen falta lat/lng hay que geocodificar `address` + `city` aparte (Nominatim, Georef AR...).
//
// Verificado contra una captura real de septiembre 2026 (test/fixtures).

import * as cheerio from 'cheerio';
import {
  cleanText, num, int, parsePrice, jsVarJson, jsVarText, jsKey, jsKeyJson, jsonLd, publishedDays,
} from './util.js';

// icon (independiente del idioma) o label normalizado -> nombre de campo
const MAIN_FEATURES = {
  stotal: 'superficie_total', 'tot.': 'superficie_total',
  scubierta: 'superficie_cubierta', 'cub.': 'superficie_cubierta',
  ambiente: 'ambientes', 'amb.': 'ambientes',
  dormitorio: 'dormitorios', 'dorm.': 'dormitorios',
  bano: 'banos', 'baño': 'banos', 'baños': 'banos',
  cochera: 'cocheras', 'coch.': 'cocheras',
  toilette: 'toilettes', 'toil.': 'toilettes',
  antiguedad: 'antiguedad', 'antigüedad': 'antiguedad',
  disposicion: 'disposicion', 'disposición': 'disposicion',
  orientacion: 'orientacion', 'orientación': 'orientacion',
  luminosidad: 'luminosidad',
};
const NUMERIC = new Set(['superficie_total', 'superficie_cubierta', 'ambientes', 'dormitorios', 'banos', 'cocheras', 'toilettes']);

const LD_PROPERTY_TYPES = new Set(['Apartment', 'House', 'SingleFamilyResidence', 'Residence', 'Accommodation', 'RealEstateListing', 'Product']);

function parseMainFeatures(html) {
  const out = { features_extra: {} };
  const mf = jsVarJson(html, 'mainFeatures');
  if (!mf) return out;
  for (const f of Object.values(mf)) {
    const key = MAIN_FEATURES[f.icon] || MAIN_FEATURES[(f.label || '').toLowerCase()];
    const value = cleanText(f.value);
    if (!key) { out.features_extra[cleanText(f.label)] = value; continue; }
    if (NUMERIC.has(key)) out[key] = key.startsWith('superficie') ? num(value) : int(num(value));
    else if (key === 'antiguedad') { out.antiguedad = num(value); out.antiguedad_texto = value || null; } // 'A estrenar', 'En pozo'
    else out[key] = value || null;
  }
  return out;
}

function parseAmenities(avisoInfo) {
  const gf = jsKeyJson(avisoInfo, 'generalFeatures');
  if (!gf) return { amenities: {}, amenities_flat: [] };
  const amenities = {};
  for (const [category, feats] of Object.entries(gf)) {
    amenities[category] = Object.values(feats).map((f) => cleanText(f.label)).filter(Boolean);
  }
  return { amenities, amenities_flat: Object.values(amenities).flat() };
}

function parsePricesData(avisoInfo) {
  const pd = jsKeyJson(avisoInfo, 'pricesData');
  const first = pd?.[0];
  const p = first?.prices?.[0];
  return {
    operacion: first?.operationType?.name || null,
    price_currency: p?.isoCode || null,
    price: p?.amount ?? null,
  };
}

function parseAddressFromJsonLd($) {
  for (const block of jsonLd($)) {
    if (!LD_PROPERTY_TYPES.has(block['@type'])) continue;
    const a = block.address || {};
    return {
      address: cleanText(a.streetAddress) || null,
      address_locality: cleanText(a.addressLocality).replace(/,\s*$/, '') || null,
      address_region: cleanText(a.addressRegion) || null,
    };
  }
  return { address: null, address_locality: null, address_region: null };
}

function parseDescription(html, $) {
  // #longDescription usa <br> como salto de línea; los preservamos.
  const el = $('#longDescription').first();
  if (!el.length) return null;
  const withBreaks = (el.html() || '').replace(/<br\s*\/?>/gi, '\n');
  const text = cheerio.load(`<div>${withBreaks}</div>`)('div').text();
  return text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') || null;
}

function parsePhotos(html) {
  const seen = new Set();
  const photos = [];
  for (const m of html.matchAll(/"resizeUrl1200x1200":"([^"]+)"/g)) {
    let u = m[1];
    try { u = JSON.parse(`"${u}"`); } catch { /* sin escapes, queda igual */ }
    const key = u.split('?')[0];
    if (!seen.has(key)) { seen.add(key); photos.push(key); }
  }
  return photos;
}

/**
 * @param {string} html  HTML completo de la ficha
 * @param {object} base  campos del listado que se conservan (id, url, search_slug, ...)
 */
export function parseDetail(html, base = {}) {
  const $ = cheerio.load(html);
  const avisoInfo = jsVarText(html, 'avisoInfo');
  const dataLayer = jsVarText(html, 'dataLayerInfo');
  const doubleClick = jsVarText(html, 'doubleClick');
  const publisher = jsVarJson(html, 'publisher');

  const addr = parseAddressFromJsonLd($);
  const prices = parsePricesData(avisoInfo);
  // Fallback al DOM si el objeto inline no está (cambio de front): '.price-value' trae 'alquiler $ 880.000'
  const domPrice = parsePrice($('.price-value').first().text());
  const domExpenses = num($('.price-expenses').first().text());

  const publishedText = cleanText($('[class*="post-antiquity-views"]').first().text())
    || (html.match(/Publicad[oa]\s+[^<]{1,40}/i)?.[0] ?? '');

  const id = jsKey(avisoInfo, 'idAviso') || base.id || null;

  return {
    ...base,
    id,
    title: cleanText($('h1').first().text()) || null,
    operacion: prices.operacion || jsKey(dataLayer, 'operationType') || base.operacion || null,
    tipo_propiedad: jsKey(dataLayer, 'propertyType') || null,
    price_currency: prices.price_currency || domPrice.currency,
    price: prices.price ?? domPrice.amount,
    expensas: num(jsKey(avisoInfo, 'expenses')) ?? domExpenses, // null = no informa
    status: jsKey(avisoInfo, 'status') || null,          // 'ONLINE'
    reserved: String(jsKey(avisoInfo, 'reserved')) === 'true',
    posting_code: jsKey(avisoInfo, 'postingCode') || null,
    ...parseMainFeatures(html),
    ...addr,
    // La ficha no siempre trae el JSON-LD de la propiedad: no pisar la dirección del listado.
    address: addr.address ?? base.address ?? null,
    neighborhood: jsKey(dataLayer, 'neighborhood') || null,
    city: jsKey(dataLayer, 'city') || null,
    province: jsKey(dataLayer, 'province') || null,
    location_ids: {
      province_id: jsKey(doubleClick, 'provinceId') ?? null,
      city_id: jsKey(doubleClick, 'cityId') ?? null,
      neighborhood_id: jsKey(doubleClick, 'neighborhoodId') ?? null,
    },
    ...parseAmenities(avisoInfo),
    description: parseDescription(html, $),
    published_text: publishedText || null,
    published_days: publishedDays(publishedText),
    publisher_id: publisher?.publisherId ?? null,
    publisher: publisher?.name ?? base.publisher ?? null,
    publisher_url: publisher?.url ? `https://www.zonaprop.com.ar${publisher.url}` : null,
    publisher_premium: publisher?.premium ?? null,
    photos: parsePhotos(html),
    scraped_at: new Date().toISOString(),
  };
}

/** Señal de que el HTML es una ficha real y no un challenge / error. */
export function looksLikeDetail(html) {
  return html.includes('const mainFeatures') || html.includes('id="longDescription"') || html.includes('"resizeUrl1200x1200"');
}
