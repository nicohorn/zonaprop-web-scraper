// Persistencia: JSONL append-only. Cada línea es un aviso; se escribe apenas se parsea, así
// cortar a mitad de camino no pierde nada y la corrida siguiente retoma donde quedó.
//
// Pensado para corridas largas (cientos de miles de avisos): el archivo se lee en streaming y
// en memoria sólo queda la clave de cada registro más lo que devuelva `pick` (por defecto nada).

import { appendFileSync, createReadStream, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

/** Itera los registros de un JSONL sin cargarlo entero. Las líneas rotas se saltean. */
export async function* readJsonl(path) {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* línea rota (corte a mitad de escritura) */ }
  }
}

export class JsonlStore {
  /**
   * @param {string} path
   * @param {{ key?: string, pick?: (o: object) => any }} opts  `pick` elige qué se retiene en
   *        memoria por registro (ej. la url, para saber qué fichas faltan visitar).
   */
  constructor(path, { key = 'id', pick = () => true } = {}) {
    this.path = path;
    this.key = key;
    this.pick = pick;
    this.index = new Map(); // key -> pick(registro)
    mkdirSync(dirname(path), { recursive: true });
  }

  async load() {
    this.index.clear();
    for await (const o of readJsonl(this.path)) this.index.set(o[this.key], this.pick(o));
    return this;
  }

  has(k) { return this.index.has(k); }
  get(k) { return this.index.get(k); }
  get size() { return this.index.size; }
  entries() { return this.index.entries(); }

  append(obj) {
    appendFileSync(this.path, JSON.stringify(obj) + '\n');
    this.index.set(obj[this.key], this.pick(obj));
  }
}

/** JSON chico que se reescribe entero (parámetros, estado de la exploración). Escritura atómica. */
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

/** Guarda HTML crudo en ./debug para revisar selectores. Devuelve la ruta. */
export function saveDebugHtml(name, html) {
  mkdirSync('debug', { recursive: true });
  const safe = name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 120);
  const path = join('debug', `${safe}.html`);
  writeFileSync(path, html);
  return path;
}
