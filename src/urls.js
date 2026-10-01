// ZonaProp usa URLs "semánticas":
//   /departamentos-venta-rosario.html
//   /departamentos-ph-alquiler-villa-urquiza-2-ambientes-pagina-3.html
// Orden de segmentos: <tipos>-<operacion>-<zona>[-<ambientes>][-<extras>][-pagina-N].html

export const BASE = 'https://www.zonaprop.com.ar';

/** URL de la página N de una búsqueda. Acepta una URL con o sin -pagina-X ya puesto. */
export function pageUrl(searchUrl, page = 1) {
  const u = new URL(searchUrl, BASE);
  let path = u.pathname.replace(/-pagina-\d+(?=\.html$)/, '');
  if (page > 1) path = path.replace(/\.html$/, `-pagina-${page}.html`);
  return `${u.origin}${path}`;
}

/** 'https://www.zonaprop.com.ar/departamentos-venta-rosario-pagina-2.html' -> 'departamentos-venta-rosario' */
export function searchSlug(searchUrl) {
  return new URL(searchUrl, BASE).pathname
    .replace(/^\//, '')
    .replace(/\.html$/, '')
    .replace(/-pagina-\d+$/, '');
}

/** Descompone el slug en tipo / operación / resto (zona + filtros). Best-effort. */
export function parseSlug(slug) {
  const m = slug.match(/^(.+?)-(alquiler-temporal|alquiler|venta)(?:-(.+))?$/);
  if (!m) return { tipo: null, operacion: null, zona: null };
  return { tipo: m[1], operacion: m[2], zona: m[3] ?? null }; // zona null = todo el país
}

/** href de una tarjeta -> URL absoluta y sin los parámetros de tracking (n_src, n_pos, ...). */
export function listingUrl(href) {
  if (!href) return null;
  const abs = href.startsWith('http') ? href : `${BASE}${href}`;
  return abs.split('?')[0];
}

/** '.../alclapin-departamento-...-60142640.html' -> '60142640' */
export function idFromUrl(url) {
  const m = (url || '').match(/-(\d+)\.html/);
  return m ? m[1] : null;
}
