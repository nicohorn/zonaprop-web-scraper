// JSONL -> CSV plano, listo para pandas.
//   npm run csv                              exporta data/listings.jsonl y data/details.jsonl
//   node scripts/to-csv.js data/details.jsonl salida.csv
// Si se guardó historial de cambios, listings.csv trae la versión vigente de cada aviso y
// listings-historial.csv todas las versiones.
// Objetos anidados se aplanan con punto (location_ids.city_id); arrays se unen con ' | '.

import { createWriteStream, existsSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { exportCsv } from '../src/export.js';

async function convert(inPath, outPath, opts) {
  if (!existsSync(inPath)) { console.log(`(no existe ${inPath})`); return; }
  const out = createWriteStream(outPath);
  const { rows, columns } = await exportCsv(inPath, out, opts);
  out.end();
  await finished(out);
  console.log(`${inPath} -> ${outPath}: ${rows} filas, ${columns} columnas`);
}

const [inArg, outArg] = process.argv.slice(2);
if (inArg) await convert(inArg, outArg || inArg.replace(/\.jsonl$/, '.csv'));
else {
  await convert('data/listings.jsonl', 'data/listings.csv', { latestBy: 'id' });
  await convert('data/listings.jsonl', 'data/listings-historial.csv');
  await convert('data/details.jsonl', 'data/details.csv');
}
