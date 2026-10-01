// Parámetros de búsqueda: los que se editan desde la interfaz web. Se guardan en
// data/settings.json y se sanean siempre al leerlos (vienen de un formulario o de un archivo
// editado a mano).

import { join } from 'node:path';
import { config } from '../config.js';
import { OPERACIONES, TIPOS } from './explore.js';
import { readJson, writeJson } from './storage.js';

export const DEFAULT_SETTINGS = {
  operaciones: ['venta', 'alquiler'],
  tipos: [], // vacío = todos los inmuebles
  zonas: [], // vacío = todo el país
  urls: [], // búsquedas armadas a mano en el sitio (URL de la primera página)
  // Hasta qué página paginar una búsqueda antes de partirla por precio. Verificado: la 500
  // todavía es real y la 700 ya no. 300 deja margen.
  maxPagesPerSearch: 300,
  includeDevelopments: true,
  // Guardar una versión nueva de un aviso ya guardado cuando cambia (precio, expensas,
  // superficie, ambientes). Ver src/changes.js.
  trackChanges: false,
  // Fase 2: visitar la ficha de cada aviso. Una request por aviso: ~15.000 fichas por día.
  scrapeDetails: true,
  maxDetailsPerRun: null, // null = sin tope
  // Pausa aleatoria entre páginas, en segundos. Es lo que evita que salte la verificación.
  delayMin: 2,
  delayMax: 4.5,
  // Primera corrida siempre con ventana: si Cloudflare pide verificación hay que tildar el
  // casillero a mano. La cookie queda guardada y después se puede ocultar.
  headless: false,
  // Bloquear imágenes/fonts acelera pero es un patrón "raro" para Cloudflare.
  blockResources: false,
};

const settingsPath = () => join(config.out.dir, config.out.settings);

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const among = (v, allowed) => lines(v).filter((s) => allowed.some((a) => a.slug === s));

export function sanitizeSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  const delayMin = clamp(raw.delayMin, 1, 120, d.delayMin);
  const maxDetails = raw.maxDetailsPerRun === null || raw.maxDetailsPerRun === '' || raw.maxDetailsPerRun === undefined
    ? null
    : Math.trunc(clamp(raw.maxDetailsPerRun, 1, 1e9, 1));
  return {
    operaciones: raw.operaciones === undefined ? d.operaciones : among(raw.operaciones, OPERACIONES),
    tipos: among(raw.tipos, TIPOS),
    zonas: [...new Set(lines(raw.zonas))],
    urls: [...new Set(lines(raw.urls).filter((u) => /^https?:\/\/(www\.)?zonaprop\.com\.ar\/[^/]+\.html/.test(u)))],
    maxPagesPerSearch: Math.trunc(clamp(raw.maxPagesPerSearch, 1, 500, d.maxPagesPerSearch)),
    includeDevelopments: raw.includeDevelopments === undefined ? d.includeDevelopments : Boolean(raw.includeDevelopments),
    trackChanges: Boolean(raw.trackChanges),
    scrapeDetails: raw.scrapeDetails === undefined ? d.scrapeDetails : Boolean(raw.scrapeDetails),
    maxDetailsPerRun: maxDetails,
    delayMin,
    delayMax: Math.max(delayMin, clamp(raw.delayMax, 1, 300, d.delayMax)),
    headless: Boolean(raw.headless),
    blockResources: Boolean(raw.blockResources),
  };
}

export const loadSettings = () => sanitizeSettings(readJson(settingsPath(), {}));

export function saveSettings(raw) {
  const settings = sanitizeSettings(raw);
  writeJson(settingsPath(), settings);
  return settings;
}
