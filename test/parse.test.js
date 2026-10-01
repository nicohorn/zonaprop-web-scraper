// Tests de los parsers contra capturas reales de ZonaProp (septiembre 2026).
// Si el sitio cambia el front, esto es lo primero que tiene que fallar.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseListing, parseFeatures } from '../src/parse/listing.js';
import { parseDetail, looksLikeDetail } from '../src/parse/detail.js';
import { num, parsePrice, publishedDays, jsKey, extractBalanced } from '../src/parse/util.js';
import { pageUrl, searchSlug, parseSlug, listingUrl } from '../src/urls.js';

const fixture = (name) => gunzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).toString('utf8');
const listadoHtml = fixture('listado-villa-urquiza-2amb-2026-09.html.gz');
const detalleHtml = fixture('detalle-51264287-2026-09.html.gz');

test('util.num interpreta formato es-AR', () => {
  assert.equal(num('$ 880.000'), 880000);
  assert.equal(num('USD 1.100'), 1100);
  assert.equal(num('45,5 m²'), 45.5);
  assert.equal(num('50 m² tot.'), 50);
  assert.equal(num('Consultar'), null);
  assert.equal(num(''), null);
});

test('util.parsePrice', () => {
  assert.deepEqual(parsePrice('USD 120.000'), { currency: 'USD', amount: 120000 });
  assert.deepEqual(parsePrice('$ 650.000'), { currency: 'ARS', amount: 650000 });
  assert.deepEqual(parsePrice('Consultar precio'), { currency: null, amount: null });
});

test('util.publishedDays', () => {
  assert.equal(publishedDays('Publicado hace 19 días'), 19);
  assert.equal(publishedDays('Publicado hoy'), 0);
  assert.equal(publishedDays('Publicado ayer'), 1);
  assert.equal(publishedDays('Publicado hace más de un año'), 365);
  assert.equal(publishedDays(''), null);
});

test('util.jsKey / extractBalanced sobre literales JS con comillas mezcladas', () => {
  const src = `{ "a": 'x', 'expenses':'195000', 'flag': false, 'n': 3, 'nested': { 'q': "}" } }`;
  assert.equal(jsKey(src, 'expenses'), '195000');
  assert.equal(jsKey(src, 'flag'), false);
  assert.equal(jsKey(src, 'n'), 3);
  assert.equal(extractBalanced(src, 0), src);
});

test('urls', () => {
  assert.equal(pageUrl('https://www.zonaprop.com.ar/departamentos-venta-rosario.html', 1), 'https://www.zonaprop.com.ar/departamentos-venta-rosario.html');
  assert.equal(pageUrl('https://www.zonaprop.com.ar/departamentos-venta-rosario.html', 3), 'https://www.zonaprop.com.ar/departamentos-venta-rosario-pagina-3.html');
  assert.equal(pageUrl('https://www.zonaprop.com.ar/departamentos-venta-rosario-pagina-7.html', 2), 'https://www.zonaprop.com.ar/departamentos-venta-rosario-pagina-2.html');
  assert.equal(searchSlug('https://www.zonaprop.com.ar/casas-alquiler-parana-pagina-2.html'), 'casas-alquiler-parana');
  assert.deepEqual(parseSlug('departamentos-ph-alquiler-temporal-villa-urquiza-2-ambientes'), { tipo: 'departamentos-ph', operacion: 'alquiler-temporal', zona: 'villa-urquiza-2-ambientes' });
  assert.equal(listingUrl('/propiedades/clasificado/x-60142640.html?n_src=Listado&n_pos=1'), 'https://www.zonaprop.com.ar/propiedades/clasificado/x-60142640.html');
});

test('parseFeatures', () => {
  assert.deepEqual(parseFeatures('120 m² tot. 95 m² cub. 3 amb. 2 dorm. 2 baños 1 coch.'), {
    superficie_total: 120, superficie_cubierta: 95, ambientes: 3, dormitorios: 2, banos: 2, cocheras: 1,
  });
});

test('parseListing: 30 tarjetas de la captura real', () => {
  const { h1, total_results, items } = parseListing(listadoHtml, { search_slug: 'test', page: 1 });
  assert.match(h1, /Villa Urquiza/);
  assert.equal(total_results, 310);
  assert.equal(items.length, 30);

  const first = items[0];
  assert.equal(first.id, '60142640');
  assert.equal(first.url, 'https://www.zonaprop.com.ar/propiedades/clasificado/alclapin-alqjuiler-2-ambientes-amoblado-sempiso-villa-urquiza-60142640.html');
  assert.deepEqual([first.price_currency, first.price], ['USD', 1100]);
  assert.equal(first.expensas, null); // no informa
  assert.equal(first.superficie_total, 50);
  assert.equal(first.ambientes, 2);
  assert.equal(first.dormitorios, 1);
  assert.equal(first.banos, 1);
  assert.equal(first.address, 'Andonaegui al 2000');
  assert.equal(first.location, 'Villa Urquiza, Capital Federal');
  assert.equal(first.publisher, 'Lilian E. Kreimer Propiedades'); // viene del JSON-LD
  assert.equal(first.date_posted, '2026-09-13');
  assert.equal(first.highlight, 'Super destacado');
  assert.ok(first.pills.includes('Aire acondicionado'));
  assert.ok(first.photos.length >= 5);
  assert.equal(first.search_slug, 'test');

  // Todos con id, url y precio parseado; la mayoría con expensas y publisher
  assert.ok(items.every((i) => i.id && i.url && i.price > 0));
  assert.ok(items.filter((i) => i.expensas > 0).length >= 20);
  assert.ok(items.filter((i) => i.publisher).length >= 25);
  assert.equal(new Set(items.map((i) => i.id)).size, 30);
});

test('parseDetail: ficha real', () => {
  assert.ok(looksLikeDetail(detalleHtml));
  const d = parseDetail(detalleHtml, { id: '51264287', url: 'x', search_slug: 'test' });
  assert.equal(d.id, '51264287');
  assert.equal(d.title, 'Depto. 3 Amb C/patio Enorme! Caballito Norte');
  assert.equal(d.operacion, 'alquiler');
  assert.equal(d.tipo_propiedad, 'Departamento');
  assert.deepEqual([d.price_currency, d.price], ['ARS', 880000]);
  assert.equal(d.expensas, 195000);
  assert.equal(d.status, 'ONLINE');
  assert.equal(d.reserved, false);
  assert.equal(d.posting_code, '238K9H');
  assert.equal(d.superficie_total, 123);
  assert.equal(d.superficie_cubierta, 60);
  assert.equal(d.ambientes, 3);
  assert.equal(d.dormitorios, 2);
  assert.equal(d.banos, 1);
  assert.equal(d.antiguedad, 40);
  assert.equal(d.disposicion, 'Contrafrente');
  assert.equal(d.orientacion, 'N');
  assert.equal(d.luminosidad, 'Muy luminoso');
  assert.equal(d.address, 'AV GAONA 2000');
  assert.equal(d.neighborhood, 'Caballito Norte');
  assert.equal(d.city, 'Caballito');
  assert.equal(d.province, 'Capital Federal');
  assert.equal(d.location_ids.city_id, '1003693');
  assert.ok(d.amenities.Servicios.includes('Ascensor'));
  assert.ok(d.amenities.Ambientes.includes('Patio'));
  assert.ok(d.amenities_flat.length >= 3);
  assert.match(d.description, /RESERVADO/);
  assert.ok(d.description.length > 500);
  assert.equal(d.published_days, 19);
  assert.equal(d.publisher, 'RUSCIO propiedades');
  assert.equal(d.publisher_id, '30028938');
  assert.ok(d.photos.length >= 10);
  assert.ok(d.photos.every((p) => p.startsWith('https://')));
  assert.equal(d.search_slug, 'test');
});
