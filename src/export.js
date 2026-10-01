// JSONL -> CSV plano, listo para pandas / Excel. En streaming: dos pasadas sobre el archivo
// (una para juntar las columnas, otra para escribir), sin cargarlo entero en memoria.
// Objetos anidados se aplanan con punto (location_ids.city_id); arrays se unen con ' | '.

import { once } from 'node:events';
import { stringify } from 'csv-stringify/sync';
import { readJsonl } from './storage.js';

export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) out[key] = v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)).join(' | ');
    else if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = v ?? '';
  }
  return out;
}

/**
 * @param {string} inPath  archivo .jsonl
 * @param {import('node:stream').Writable} out
 * @param {{ latestBy?: string }} opts  `latestBy: 'id'` deja sólo la última línea de cada id
 *        (la versión vigente, cuando hay historial de cambios).
 * @returns {Promise<{ rows: number, columns: number }>}
 */
export async function exportCsv(inPath, out, { latestBy = null } = {}) {
  const columns = new Set();
  const lastLine = new Map(); // clave -> nº de la última línea que la trae
  let n = 0;
  for await (const r of readJsonl(inPath)) {
    for (const k of Object.keys(flatten(r))) columns.add(k);
    if (latestBy) lastLine.set(r[latestBy], n);
    n++;
  }
  const cols = [...columns];

  const write = async (chunk) => { if (!out.write(chunk)) await once(out, 'drain'); };
  await write('﻿' + stringify([cols])); // BOM: Excel abre bien los acentos
  let rows = 0;
  n = 0;
  for await (const r of readJsonl(inPath)) {
    if (latestBy && lastLine.get(r[latestBy]) !== n++) continue;
    await write(stringify([flatten(r)], { columns: cols }));
    rows++;
  }
  return { rows, columns: cols.length };
}
