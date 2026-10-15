// Tests del cableado de "Modelos": parámetros, rutas de artefactos y (si hay Python con las
// dependencias en ml/.venv) una corrida real sobre datos sintéticos. No tocan la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS, sanitizeParams, MlRunner, pythonPath, ROOT } from '../src/ml.js';

test('tasks.json: las 6 tareas con defaults válidos', () => {
  assert.deepEqual(Object.keys(TASKS).sort(), ['anomaly', 'price', 'segments', 'survival', 'text', 'yields']);
  for (const [task, t] of Object.entries(TASKS)) {
    assert.ok(t.label && t.params, task);
    assert.deepEqual(sanitizeParams(task, {}), Object.fromEntries(Object.entries(t.params).map(([k, s]) => [k, s.default])));
  }
});

test('sanitizeParams: recorta, valida opciones y descarta lo desconocido', () => {
  const p = sanitizeParams('price', { learning_rate: 9, target: 'nada', shap: 0, test_size: '', extra: 1 });
  assert.equal(p.learning_rate, 0.5);
  assert.equal(p.target, 'log_price');
  assert.equal(p.shap, false);
  assert.equal(p.test_size, 0.2);
  assert.ok(!('extra' in p));
  assert.deepEqual(sanitizeParams('segments', { features: ['usd_m2', 'hackeo'] }).features, ['usd_m2']);
  assert.equal(sanitizeParams('yields', { as_of: '2026-10-01' }).as_of, '2026-10-01');
  assert.equal(sanitizeParams('yields', { as_of: '../x' }).as_of, '');
  assert.throws(() => sanitizeParams('nope', {}));
});

test('artifactPath: no sale de data/ml/runs', () => {
  const ml = new MlRunner();
  assert.equal(ml.artifactPath('..', 'x.png'), null);
  assert.equal(ml.artifactPath('abc', '../../settings.json'), null);
  assert.equal(ml.getRun('../x'), null);
});

const py = pythonPath();
const hasDeps = spawnSync(py, ['-c', 'import pandas, sklearn, matplotlib'], { encoding: 'utf8' }).status === 0;

test('run.py: entrena price y yields sobre datos sintéticos', { skip: !hasDeps && 'sin Python con dependencias (ml/requirements.txt)' }, () => {
  const data = mkdtempSync(join(tmpdir(), 'zpml-'));
  const barrios = ['Palermo', 'Caballito', 'Belgrano', 'Flores'];
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const b = barrios[i % 4], sup = 30 + (i * 7) % 120, venta = i % 3 !== 0;
    const ppm2 = [3000, 2200, 2800, 1600][i % 4] * (0.9 + ((i * 13) % 20) / 100);
    lines.push(JSON.stringify({
      id: String(1000 + i), url: `https://www.zonaprop.com.ar/propiedades/clasificado/${venta ? 've' : 'al'}clapin-x-${1000 + i}.html`,
      title: 'Depto luminoso', price_currency: venta ? 'USD' : 'ARS', price: Math.round(venta ? ppm2 * sup : sup * 12000),
      expensas: 50000, superficie_total: sup + 5, superficie_cubierta: sup, ambientes: 1 + (i % 4), dormitorios: i % 4, banos: 1, cocheras: null,
      location: i % 8 === 0 ? `Las Cañitas, ${b}` : `${b}, Capital Federal`, description_short: 'a estrenar con balcon', photos: [],
      operacion: venta ? 'venta' : 'alquiler', posting_type: 'PROPERTY', scraped_at: '2026-10-15T12:00:00Z', date_posted: '2026-10-01',
    }));
  }
  lines.push(JSON.stringify({ id: '9', url: 'x', price: 1, price_currency: 'USD', location: 'Pilar, GBA Norte', operacion: 'venta' }));
  writeFileSync(join(data, 'listings.jsonl'), lines.join('\n') + '\n');
  for (const [task, params] of [['price', { shap: false, n_estimators: 50 }], ['yields', { min_n: 3 }], ['segments', {}]]) {
    const dir = join(data, 'run-' + task);
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dir)},{recursive:true});require('fs').writeFileSync(${JSON.stringify(join(dir, 'params.json'))},${JSON.stringify(JSON.stringify(params))})`]);
    const r = spawnSync(py, [join(ROOT, 'ml', 'run.py'), task, '--run-dir', dir], { encoding: 'utf8', env: { ...process.env, ZP_DATA_DIR: data, PYTHONUTF8: '1' } });
    const res = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(res.status, 'ok', `${task}: ${res.error}\n${r.stderr}`);
    assert.ok(res.artifacts.every((a) => existsSync(join(dir, a))));
  }
});
