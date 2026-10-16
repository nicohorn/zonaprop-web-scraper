// Tests del cableado de "Modelos": parámetros, rutas de artefactos y (si hay Python con las
// dependencias en ml/.venv) una corrida real sobre datos sintéticos. No tocan la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS, sanitizeParams, MlRunner, pythonPath, ROOT } from '../src/ml.js';

test('tasks.json: las 7 tareas con defaults válidos', () => {
  assert.deepEqual(Object.keys(TASKS).sort(), ['anomaly', 'price', 'price_ablation', 'segments', 'survival', 'text', 'yields']);
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
  for (const [task, params] of [['price_ablation', { variantes: ['v1', 'v3_ppm2_huber'], cv_folds: 3 }], ['price', { shap: false, tune: false }], ['yields', { min_n: 3 }], ['segments', {}]]) {
    const dir = join(data, 'ml', 'runs', 'run-' + task);
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dir)},{recursive:true});require('fs').writeFileSync(${JSON.stringify(join(dir, 'params.json'))},${JSON.stringify(JSON.stringify(params))})`]);
    const r = spawnSync(py, [join(ROOT, 'ml', 'run.py'), task, '--run-dir', dir], { encoding: 'utf8', env: { ...process.env, ZP_DATA_DIR: data, PYTHONUTF8: '1' } });
    const res = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(res.status, 'ok', `${task}: ${res.error}\n${r.stderr}`);
    assert.ok(res.artifacts.every((a) => existsSync(join(dir, a))));
  }
  // modelo guardado + predicción
  const env = { ...process.env, ZP_DATA_DIR: data, PYTHONUTF8: '1' };
  assert.equal(JSON.parse(readFileSync(join(data, 'ml', 'latest_price.json'), 'utf8')).run, 'run-price');
  const meta = JSON.parse(readFileSync(join(data, 'ml', 'runs', 'run-price', 'model.json'), 'utf8'));
  assert.ok(meta.n_train > meta.n_test && meta.n_test > 0);
  const p = spawnSync(py, [join(ROOT, 'ml', 'predict.py')], { input: JSON.stringify({ inputs: { barrio: 'Palermo', tipo: 'departamento', superficie_cubierta: 50 } }), encoding: 'utf8', env });
  const out = JSON.parse(p.stdout.trim().split(/\r?\n/).pop());
  assert.equal(out.ok, true, p.stderr + p.stdout);
  assert.ok(out.precio > 50 * 1000 && out.precio < 50 * 6000, `precio ${out.precio}`);
  assert.ok(out.rango_80[0] <= out.precio && out.precio <= out.rango_80[1]);
  const none = spawnSync(py, [join(ROOT, 'ml', 'predict.py')], { input: JSON.stringify({ run: 'no-existe' }), encoding: 'utf8', env });
  assert.match(none.stdout, /entrená el modelo A/);
});

test('split temporal: el test son los avisos más nuevos', { skip: !hasDeps && 'sin Python' }, () => {
  const code = "import sys;sys.path.insert(0,'ml');import pandas as pd,run;d=pd.DataFrame({'date_posted':['2026-01-0%d'%i for i in range(1,10)]+['2026-02-01']});tr,te=run.split_idx(d,{'split':'temporal','test_size':0.2});print(sorted(te.tolist()))";
  const r = spawnSync(py, ['-c', code], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '[8, 9]', r.stderr);
});

test('zpml/precio: montos fuera del texto, columnas faltantes, pozo y test agrupado', { skip: !hasDeps && 'sin Python' }, () => {
  const code = [
    "import sys;sys.path.insert(0,'ml');import pandas as pd,numpy as np,zpml,precio",
    "print(zpml.strip_amounts('Depto USD 120.000 luminoso u$s 95 mil').split())",
    "X,n,c=zpml.build_features(pd.DataFrame({'barrio':['Palermo'],'superficie_total':[50]}));print(int(X['superficie'].iloc[0]))",
    "print(zpml.es_pozo(pd.DataFrame({'title':['Venta de pozo','Depto'],'description_short':[None,'a estrenar']})).tolist())",
    "d=pd.DataFrame({'grupo':[str(i//3) for i in range(300)],'date_posted':['2026-01-01']*300});tr,te=precio.separar(d,'agrupado',0.2,1)",
    "print(len(set(d.grupo.iloc[tr])&set(d.grupo.iloc[te])))",
  ].join('\n');
  const r = spawnSync(py, ['-c', code], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), ["['Depto', 'luminoso']", '50', '[True, False]', '0'], r.stderr);
});
