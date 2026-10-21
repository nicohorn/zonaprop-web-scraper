// Sección "Modelos": lanza los entrenamientos de ml/run.py (Python) como procesos hijos, uno a
// la vez, y sigue su avance (líneas JSON {pct, step} por stdout). Cada corrida queda en
// data/ml/runs/<id>/ con params.json, result.json, log.txt y los CSV/PNG que genere.
//
// Python: ml/.venv (ver README, "Modelos") o la variable ZP_PYTHON; si no, `python` del PATH.

import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS = JSON.parse(readFileSync(join(ROOT, 'ml', 'tasks.json'), 'utf8'));
// ZP_DATA_DIR: otra carpeta de datos (la misma variable que lee ml/zpml.py; la heredan los procesos hijos).
export const RUNS_DIR = join(process.env.ZP_DATA_DIR ? resolve(process.env.ZP_DATA_DIR) : join(ROOT, 'data'), 'ml', 'runs');

export function pythonPath() {
  if (process.env.ZP_PYTHON) return process.env.ZP_PYTHON;
  const venv = process.platform === 'win32' ? join(ROOT, 'ml', '.venv', 'Scripts', 'python.exe') : join(ROOT, 'ml', '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python';
}

/** Parámetros de una tarea saneados contra ml/tasks.json: lo inválido vuelve al default. */
export function sanitizeParams(task, raw = {}) {
  const spec = TASKS[task]?.params;
  if (!spec) throw new Error(`Tarea desconocida: ${task}`);
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = raw[k];
    if (s.type === 'number') {
      const n = Number(v);
      out[k] = v === '' || v == null || !Number.isFinite(n) ? s.default : Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, n));
    } else if (s.type === 'select') out[k] = s.options.includes(v) ? v : s.default;
    else if (s.type === 'multi') {
      const list = (Array.isArray(v) ? v : []).filter((x) => s.options.includes(x));
      out[k] = list.length ? [...new Set(list)] : s.default;
    } else if (s.type === 'bool') out[k] = v == null ? s.default : Boolean(v);
    else if (s.type === 'date') out[k] = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : s.default;
    else out[k] = s.default;
  }
  return out;
}

const runId = (task) => `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${task}`;
const readJsonSafe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

export class MlRunner extends EventEmitter {
  constructor() {
    super();
    this.job = null; // { task, id, dir, pct, step, child, startedAt, log[] }
    this.last = null;
  }

  pythonInfo() {
    if (this._py) return this._py;
    const py = pythonPath();
    const r = spawnSync(py, ['-c', 'import sys,importlib.util as u;print(sys.version.split()[0]);print(",".join(m for m in ["pandas","sklearn","lightgbm","shap","lifelines","matplotlib"] if u.find_spec(m)))'], { encoding: 'utf8', timeout: 20_000 });
    const ok = r.status === 0;
    const [version, mods = ''] = ok ? r.stdout.trim().split(/\r?\n/) : [];
    this._py = { path: py, ok, version: version || null, modules: mods ? mods.split(',') : [], error: ok ? null : (r.error?.message || r.stderr || '').slice(0, 300) };
    if (!ok) setTimeout(() => { this._py = null; }, 10_000); // reintentar tras instalar
    return this._py;
  }

  status() {
    const j = this.job;
    return {
      running: Boolean(j),
      job: j && { task: j.task, id: j.id, pct: j.pct, step: j.step, startedAt: j.startedAt, log: j.log.slice(-15) },
      last: this.last,
    };
  }

  start(task, rawParams) {
    if (this.job) throw new Error('Ya hay un entrenamiento en curso.');
    const params = sanitizeParams(task, rawParams);
    const id = runId(task);
    const dir = join(RUNS_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'params.json'), JSON.stringify(params, null, 1));
    const child = spawn(pythonPath(), ['-u', join(ROOT, 'ml', 'run.py'), task, '--run-dir', dir], {
      cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, windowsHide: true,
    });
    const job = this.job = { task, id, dir, pct: 0, step: 'Iniciando Python', child, startedAt: new Date().toISOString(), log: [] };
    const logLine = (line) => {
      if (!line.trim()) return;
      try { appendFileSync(join(dir, 'log.txt'), line + '\n'); } catch { /* nada */ }
      if (line.startsWith('{')) {
        try { const m = JSON.parse(line); job.pct = m.pct ?? job.pct; job.step = m.step ?? job.step; this.emit('status'); return; } catch { /* texto común */ }
      }
      job.log.push(line); if (job.log.length > 200) job.log.shift();
    };
    const pipe = (stream) => { let buf = ''; stream.setEncoding('utf8'); stream.on('data', (c) => { buf += c; const parts = buf.split(/\r?\n/); buf = parts.pop(); parts.forEach(logLine); }); };
    pipe(child.stdout); pipe(child.stderr);
    child.on('error', (e) => logLine(`No se pudo iniciar Python (${pythonPath()}): ${e.message}`));
    child.on('close', (code) => {
      const result = readJsonSafe(join(dir, 'result.json'));
      this.last = { task, id, code, cancelled: Boolean(job.cancelled), status: job.cancelled ? 'cancelled' : result?.status ?? 'error', error: result?.error ?? (job.cancelled ? 'Cancelado' : job.log.slice(-5).join('\n')) };
      this.job = null;
      this.emit('status');
    });
    this.emit('status');
    return { id, params };
  }

  cancel() {
    if (!this.job) return false;
    this.job.cancelled = true;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.job.child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => {});
    else this.job.child.kill('SIGTERM');
    return true;
  }

  listRuns(limit = Infinity) {
    if (!existsSync(RUNS_DIR)) return [];
    return readdirSync(RUNS_DIR).filter((id) => /^[\w-]+$/.test(id)).sort().reverse().slice(0, limit).map((id) => {
      const r = readJsonSafe(join(RUNS_DIR, id, 'result.json'));
      return { id, task: r?.task ?? id.split('-').slice(2).join('-'), status: r?.status ?? (this.job?.id === id ? 'running' : 'incompleta'), seconds: r?.seconds ?? null };
    });
  }

  getRun(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    const dir = join(RUNS_DIR, id);
    if (!existsSync(dir)) return null;
    return { id, params: readJsonSafe(join(dir, 'params.json')), result: readJsonSafe(join(dir, 'result.json')) };
  }

  /** Modelos de precio guardados (corridas de A con model.json), el último primero. */
  priceModels() {
    const latest = readJsonSafe(join(RUNS_DIR, '..', 'latest_price.json'))?.run ?? null;
    if (!existsSync(RUNS_DIR)) return { latest, models: [] };
    const models = readdirSync(RUNS_DIR).sort().reverse().map((id) => {
      const m = readJsonSafe(join(RUNS_DIR, id, 'model.json'));
      if (!m || !existsSync(join(RUNS_DIR, id, 'model.joblib'))) return null;
      return { run: id, modelo: m.modelo, operacion: m.operacion, currency: m.currency, tipo: m.tipo, target: m.target, split: m.split,
        n_train: m.n_train, n_test: m.n_test, metricas_test: m.metricas_test, barrios: Object.keys(m.barrios || {}), tipos: m.tipos, predictable: m.predictable !== false,
        variante: m.variante || 'v1', duplicados: m.duplicados || 'v1_huella', calle: Boolean(m.opciones?.calle), features: m.opciones?.features || 1 };
    }).filter(Boolean);
    return { latest, models };
  }

  /** Todas las corridas con sus métricas principales, para compararlas lado a lado en la interfaz. */
  compare() {
    if (!existsSync(RUNS_DIR)) return { runs: [] };
    const runs = readdirSync(RUNS_DIR).filter((id) => /^[\w-]+$/.test(id)).sort().reverse().map((id) => {
      const r = readJsonSafe(join(RUNS_DIR, id, 'result.json'));
      if (!r) return null;
      const m = readJsonSafe(join(RUNS_DIR, id, 'model.json'));
      const base = { id, task: r.task, status: r.status, started_at: r.started_at, seconds: r.seconds, error: r.error || null };
      if (r.task === 'price') {
        return { ...base, variante: r.variante || m?.variante || 'v1', duplicados: m?.duplicados || r.params?.duplicados || 'v1_huella',
          split: r.split, n_train: r.n_train, n_test: r.n_test, metricas: r.metricas || {}, cobertura: r['cobertura_intervalos_test_%'] ?? m?.['cobertura_test_%'] ?? null };
      }
      const keys = Object.entries(r).filter(([k, v]) => !['task', 'params', 'started_at', 'status', 'error', 'traceback', 'seconds', 'artifacts', 'tablas', 'metricas'].includes(k) && (typeof v !== 'object' || v === null));
      return { ...base, resumen: Object.fromEntries(keys.slice(0, 8)), metricas: r.metricas || null };
    }).filter(Boolean);
    return { runs };
  }

  /** Corre ml/predict.py con {run, inputs} por stdin; devuelve su JSON. */
  predict(run, inputs) {
    return new Promise((resolveP) => {
      const child = spawn(pythonPath(), [join(ROOT, 'ml', 'predict.py')], { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, windowsHide: true });
      let out = '', err = '';
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
      child.stderr.setEncoding('utf8').on('data', (c) => { err += c; });
      child.on('error', (e) => { clearTimeout(timer); resolveP({ ok: false, error: `No se pudo iniciar Python: ${e.message}` }); });
      child.on('close', () => {
        clearTimeout(timer);
        const line = out.trim().split(/\r?\n/).pop() || '';
        try { resolveP(JSON.parse(line)); } catch { resolveP({ ok: false, error: (err || out || 'Sin respuesta de predict.py').slice(-600) }); }
      });
      child.stdin.end(JSON.stringify({ run: run || null, inputs: inputs || {} }));
    });
  }

  /** Ruta de un artefacto de una corrida, o null si el nombre no es seguro. */
  artifactPath(id, name) {
    if (!/^[\w-]+$/.test(id) || !/^[\w.%-]+\.(png|csv|json|txt)$/.test(name)) return null;
    const p = resolve(RUNS_DIR, id, name);
    return p.startsWith(resolve(RUNS_DIR)) && existsSync(p) ? p : null;
  }
}
