// Helpers de parseo compartidos por listado y ficha.

export function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** Normaliza para comparar: sin tildes, minúsculas. 'Paraná' -> 'parana' */
export function normalize(s) {
  return (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Primer número del texto, interpretando el formato es-AR.
 *   '$ 880.000' -> 880000 ; '1.100' -> 1100 ; '45,5 m²' -> 45.5 ; '50 m² tot.' -> 50
 * Devuelve null si no hay número.
 */
export function num(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, '.').match(/\d[\d.]*/);
  if (!m) return null;
  let raw = m[0];
  // Miles con punto: si el último bloque tiene 3 dígitos, los puntos son separadores de miles.
  const parts = raw.split('.');
  if (parts.length > 1 && parts[parts.length - 1].length === 3) raw = raw.replace(/\./g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function int(v) {
  return v == null ? null : Math.trunc(v);
}

/** 'USD 120.000' -> { currency: 'USD', amount: 120000 } ; 'Consultar precio' -> { null, null } */
export function parsePrice(text) {
  const t = cleanText(text);
  if (!t) return { currency: null, amount: null };
  const currency = /USD|U\$S|U\$D/i.test(t) ? 'USD' : t.includes('$') ? 'ARS' : null;
  const amount = currency ? num(t.replace(/USD|U\$S|U\$D/i, '')) : null;
  return { currency, amount };
}

/**
 * Devuelve el texto del objeto/array balanceado que empieza en src[openIdx] ('{' o '[').
 * Respeta strings (comillas simples, dobles y backticks) y escapes. null si no cierra.
 */
export function extractBalanced(src, openIdx) {
  const open = src[openIdx];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** Texto crudo de `const NAME = {...}` / `[...]` en el HTML, o null. */
export function jsVarText(html, name) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`);
  const m = html.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (html[start] !== '{' && html[start] !== '[') return null;
  return extractBalanced(html, start);
}

/** `const NAME = {json}` parseado, o null si no está o no es JSON válido. */
export function jsVarJson(html, name) {
  const text = jsVarText(html, name);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Valor escalar de una clave dentro de un objeto JS literal (comillas simples o dobles).
 *   jsKey("{ 'status': 'ONLINE', \"expenses\":'195000' }", 'expenses') -> '195000'
 */
export function jsKey(objText, key) {
  if (!objText) return null;
  const re = new RegExp(`['"]${key}['"]\\s*:\\s*(?:(['"])((?:\\\\.|(?!\\1).)*)\\1|(true|false|null|-?[\\d.]+))`);
  const m = objText.match(re);
  if (!m) return null;
  if (m[2] != null) return m[2];
  const v = m[3];
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  return Number(v);
}

/** Sub-objeto JSON de una clave dentro de un objeto JS literal: `'pricesData': [ {...} ]`. */
export function jsKeyJson(objText, key) {
  if (!objText) return null;
  const re = new RegExp(`['"]${key}['"]\\s*:\\s*`);
  const m = objText.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  const text = extractBalanced(objText, start);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Todos los bloques <script type="application/ld+json"> parseados. */
export function jsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { out.push(JSON.parse($(el).text())); } catch { /* bloque roto, lo ignoramos */ }
  });
  return out;
}

/** '9/13/26' (M/D/YY, como lo escribe ZonaProp en el JSON-LD) -> '2026-09-13'. Si no parsea, devuelve el original. */
export function usDateToIso(s) {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return s || null;
  const [, mm, dd, yy] = m;
  const yyyy = yy.length === 2 ? `20${yy}` : yy;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/**
 * 'Publicado hace 19 días' -> 19 ; 'Publicado hoy' -> 0 ; 'ayer' -> 1 ; 'hace más de un año' -> 365.
 * null si no parsea (nunca 0, que significaría "hoy").
 */
export function publishedDays(text) {
  const t = normalize(text);
  if (!t) return null;
  if (/mas de (?:un|1) a(?:n|ni)os?/.test(t)) return 365;
  const years = t.match(/mas de (\d+) a(?:n|ni)os?/);
  if (years) return Number(years[1]) * 365;
  if (/\bhoy\b/.test(t)) return 0;
  if (/\bayer\b/.test(t)) return 1;
  const days = t.match(/(\d+)\s+dias?/);
  if (days) return Number(days[1]);
  if (/hace un dia/.test(t)) return 1;
  const months = t.match(/(\d+)\s+mes(?:es)?/);
  if (months) return Number(months[1]) * 30;
  if (/hace un mes/.test(t)) return 30;
  return null;
}
