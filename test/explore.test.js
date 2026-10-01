// Tests de la exploración automática (armado de búsquedas y partición por precio), de los
// parámetros y del almacenamiento. No tocan la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoots, splitNode, nodeSlug, nodeUrl, slugify, totalPages, PRICE_MIN, PRICE_MAX } from '../src/explore.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { JsonlStore, readJsonl } from '../src/storage.js';
import { flatten } from '../src/export.js';
import { parseSlug } from '../src/urls.js';
import { fingerprint, changedFields } from '../src/changes.js';
import { exportCsv } from '../src/export.js';
import { Writable } from 'node:stream';

test('slugify', () => {
  assert.equal(slugify('  Villa Urquiza '), 'villa-urquiza');
  assert.equal(slugify('Córdoba'), 'cordoba');
  assert.equal(slugify('gba-norte'), 'gba-norte');
});

test('buildRoots: operación × tipo × zona, sin tipo = inmuebles, sin zona = país', () => {
  const slugs = (s) => buildRoots(s).map(nodeSlug);
  assert.deepEqual(slugs({ operaciones: ['venta', 'alquiler'] }), ['inmuebles-venta', 'inmuebles-alquiler']);
  assert.deepEqual(
    slugs({ operaciones: ['venta'], tipos: ['departamentos', 'casas'], zonas: ['Rosario', 'Villa Urquiza'] }),
    ['departamentos-venta-rosario', 'departamentos-venta-villa-urquiza', 'casas-venta-rosario', 'casas-venta-villa-urquiza'],
  );
  assert.deepEqual(slugs({ operaciones: [] }), []);
});

test('buildRoots: moneda del rango según operación; URLs a mano', () => {
  const [venta, alquiler] = buildRoots({ operaciones: ['venta', 'alquiler-temporal'] });
  assert.equal(venta.currency, 'dolar');
  assert.equal(alquiler.currency, 'pesos');

  const roots = buildRoots({
    operaciones: ['venta'],
    urls: [
      'https://www.zonaprop.com.ar/inmuebles-venta.html', // repetida con la de arriba
      'https://www.zonaprop.com.ar/ph-alquiler-palermo-pagina-3.html',
      'https://www.zonaprop.com.ar/departamentos-venta-palermo-100000-150000-dolar.html',
    ],
  });
  assert.deepEqual(roots.map(nodeSlug), ['inmuebles-venta', 'ph-alquiler-palermo', 'departamentos-venta-palermo-100000-150000-dolar']);
  assert.deepEqual(roots.map((r) => r.splittable), [true, true, false]); // la que ya trae precio no se parte
  assert.equal(roots[1].currency, 'pesos');
});

test('splitNode: dos rangos contiguos que cubren todo, hasta que no se puede más', () => {
  const [root] = buildRoots({ operaciones: ['venta'], tipos: ['departamentos'], zonas: ['capital-federal'] });
  const [a, b] = splitNode(root);
  assert.equal(a.min, PRICE_MIN);
  assert.equal(b.max, PRICE_MAX);
  assert.equal(a.max + 1, b.min);
  assert.equal(nodeSlug(a), `departamentos-venta-capital-federal-1-${a.max}-dolar`);
  assert.equal(nodeUrl(a), `https://www.zonaprop.com.ar/departamentos-venta-capital-federal-1-${a.max}-dolar.html`);

  // Partiendo siempre el pedazo que contiene 100.000 se llega a un rango de un solo precio.
  let node = root;
  for (let i = 0; i < 80; i++) {
    const kids = splitNode(node);
    if (!kids) break;
    assert.equal(kids[0].max + 1, kids[1].min);
    assert.ok(kids[0].min <= kids[0].max && kids[1].min <= kids[1].max);
    node = kids.find((k) => k.min <= 100_000 && 100_000 <= k.max);
  }
  assert.deepEqual([node.min, node.max], [100_000, 100_000]);
  assert.equal(splitNode(node), null);
  assert.equal(splitNode({ ...root, splittable: false }), null);
});

test('totalPages / parseSlug sin zona', () => {
  assert.equal(totalPages(310), 11);
  assert.equal(totalPages(30), 1);
  assert.deepEqual(parseSlug('inmuebles-venta'), { tipo: 'inmuebles', operacion: 'venta', zona: null });
});

test('sanitizeSettings: defaults y saneo de lo que llega del formulario', () => {
  assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS);
  const s = sanitizeSettings({
    operaciones: ['venta', 'robo'], tipos: 'casas\nnaves-espaciales', zonas: 'rosario\n\n rosario \npalermo',
    urls: ['https://www.zonaprop.com.ar/casas-venta-rosario.html', 'https://example.com/x.html'],
    delayMin: 0, delayMax: 0.5, maxPagesPerSearch: 9999, maxDetailsPerRun: '', headless: 1,
  });
  assert.deepEqual(s.operaciones, ['venta']);
  assert.deepEqual(s.tipos, ['casas']);
  assert.deepEqual(s.zonas, ['rosario', 'palermo']);
  assert.deepEqual(s.urls, ['https://www.zonaprop.com.ar/casas-venta-rosario.html']);
  assert.deepEqual([s.delayMin, s.delayMax], [1, 1]); // nunca por debajo de 1 s
  assert.equal(s.maxPagesPerSearch, 500);
  assert.equal(s.maxDetailsPerRun, null);
  assert.equal(s.headless, true);
});

test('JsonlStore: retoma lo guardado, ignora líneas rotas, retiene sólo lo pedido', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'zp-')), 'x.jsonl');
  writeFileSync(path, '{"id":"1","url":"a"}\n{"id":"2","url":\n\n{"id":"3","url":"c"}\n');
  const store = await new JsonlStore(path, { pick: (o) => o.url }).load();
  assert.equal(store.size, 2);
  assert.equal(store.get('3'), 'c');
  store.append({ id: '4', url: 'd', extra: 'x'.repeat(100) });
  assert.ok(store.has('4'));

  const again = await new JsonlStore(path).load();
  assert.equal(again.size, 3);
  const rows = [];
  for await (const r of readJsonl(path)) rows.push(r.id);
  assert.deepEqual(rows, ['1', '3', '4']);
});

test('flatten para CSV', () => {
  assert.deepEqual(flatten({ a: 1, b: { c: null, d: 'x' }, e: ['p', 'q'], f: [{ g: 1 }] }), {
    a: 1, 'b.c': '', 'b.d': 'x', e: 'p | q', f: '{"g":1}',
  });
});

test('historial: detecta qué campos cambiaron y el CSV puede traer sólo la versión vigente', async () => {
  const v1 = { id: '1', price_currency: 'USD', price: 100000, expensas: null, ambientes: 3, photos: ['a'] };
  const fp = fingerprint(v1);
  assert.deepEqual(changedFields(fp, { ...v1, photos: ['b'], highlight: 'Destacado' }), []); // ruido: no es cambio
  assert.deepEqual(changedFields(fp, { ...v1, price: 95000, expensas: 50000 }), ['price', 'expensas']);

  const path = join(mkdtempSync(join(tmpdir(), 'zp-')), 'l.jsonl');
  const store = await new JsonlStore(path, { pick: (o) => ({ h: fingerprint(o) }) }).load();
  store.append(v1);
  store.append({ id: '2', price: 5 });
  store.append({ ...v1, price: 95000, changed_fields: ['price'] });
  assert.equal(store.size, 2); // dos avisos, tres líneas
  assert.deepEqual(changedFields(store.get('1').h, { ...v1, price: 95000 }), []); // compara contra la última versión

  const csv = async (opts) => {
    let text = '';
    const out = new Writable({ write(c, _, cb) { text += c; cb(); } });
    const { rows } = await exportCsv(path, out, opts);
    return { rows, text };
  };
  assert.equal((await csv()).rows, 3);
  const latest = await csv({ latestBy: 'id' });
  assert.equal(latest.rows, 2);
  assert.ok(latest.text.includes('95000') && !latest.text.includes('100000'));
});
