// Exploración automática: qué búsquedas recorrer y cómo partirlas.
//
// Lo que se verificó contra el sitio (octubre 2026) y motiva este diseño:
//   - La paginación profunda no es confiable: hasta la página ~500 devuelve resultados reales;
//     más allá devuelve siempre la misma página de relleno, con 200 y sin avisar. O sea que una
//     búsqueda sola nunca entrega más de ~15.000 avisos aunque declare 600.000.
//   - El filtro de precio va en el slug (`-100000-150000-dolar`, `-1-500000-pesos`) y convierte
//     monedas: un rango en dólares también trae los avisos publicados en pesos. Sólo quedan
//     afuera los "Consultar precio" (~0,4%).
//   - Un slug inválido no da 404: redirige a una búsqueda más amplia. Se detecta comparando la
//     URL final con la pedida.
//
// Entonces: cada búsqueda que declara más avisos de los que se pueden paginar se parte en dos
// rangos de precio, y así recursivamente hasta que cada pedazo entra. Es independiente de la
// zona y del tipo, y no necesita conocer la lista de barrios.

import { BASE, searchSlug, parseSlug } from './urls.js';
import { normalize } from './parse/util.js';

export const PAGE_SIZE = 30;
export const PRICE_MIN = 1;
export const PRICE_MAX = 999_999_999;

export const OPERACIONES = [
  { slug: 'venta', label: 'Venta' },
  { slug: 'alquiler', label: 'Alquiler' },
  { slug: 'alquiler-temporal', label: 'Alquiler temporal' },
];

// Slugs tomados de los links de filtros del propio sitio.
export const TIPOS = [
  { slug: 'departamentos', label: 'Departamentos' },
  { slug: 'casas', label: 'Casas' },
  { slug: 'ph', label: 'PH' },
  { slug: 'terrenos', label: 'Terrenos' },
  { slug: 'locales-comerciales', label: 'Locales comerciales' },
  { slug: 'oficinas-comerciales', label: 'Oficinas' },
  { slug: 'cocheras', label: 'Cocheras' },
  { slug: 'bodegas-galpones', label: 'Galpones' },
  { slug: 'depositos', label: 'Depósitos' },
  { slug: 'campos', label: 'Campos' },
  { slug: 'edificios', label: 'Edificios' },
  { slug: 'fondos-de-comercio', label: 'Fondos de comercio' },
  { slug: 'hoteles', label: 'Hoteles' },
  { slug: 'consultorios', label: 'Consultorios' },
];
export const TIPO_TODOS = 'inmuebles';

export const ZONAS_SUGERIDAS = [
  'capital-federal', 'gba-norte', 'gba-sur', 'gba-oeste', 'buenos-aires-costa-atlantica',
  'buenos-aires-fuera-de-gba', 'cordoba', 'santa-fe', 'rosario', 'mendoza', 'neuquen', 'rio-negro',
  'tucuman', 'salta', 'entre-rios', 'misiones', 'corrientes', 'chubut', 'chaco', 'san-luis', 'jujuy',
];

/** 'Villa Urquiza' -> 'villa-urquiza' */
export function slugify(s) {
  return normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const currencyFor = (operacion) => (operacion === 'venta' ? 'dolar' : 'pesos');

/** Slug completo de un nodo: la búsqueda base más su rango de precio, si tiene. */
export function nodeSlug(node) {
  return node.min == null ? node.base : `${node.base}-${node.min}-${node.max}-${node.currency}`;
}
export const nodeUrl = (node) => `${BASE}/${nodeSlug(node)}.html`;

function makeRoot(base, operacion) {
  // Un slug que ya trae filtro de precio u orden no se puede volver a partir por precio.
  const splittable = Boolean(operacion) && !/-(dolar|pesos)(-|$)|-orden-/.test(base);
  return { base, currency: currencyFor(operacion), min: null, max: null, splittable };
}

/**
 * Búsquedas raíz: operación × tipo × zona, más las URLs pegadas a mano.
 * Sin tipos = todos los inmuebles; sin zonas = todo el país.
 */
export function buildRoots({ operaciones = [], tipos = [], zonas = [], urls = [] }) {
  const roots = new Map();
  const add = (root) => { if (!roots.has(root.base)) roots.set(root.base, root); };

  const tipoList = tipos.length ? tipos : [TIPO_TODOS];
  const zonaList = zonas.map(slugify).filter(Boolean);
  for (const op of operaciones) {
    for (const tipo of tipoList) {
      for (const zona of zonaList.length ? zonaList : [null]) {
        add(makeRoot([tipo, op, zona].filter(Boolean).join('-'), op));
      }
    }
  }
  for (const url of urls) {
    let base;
    try { base = searchSlug(url); } catch { continue; }
    if (base) add(makeRoot(base, parseSlug(base).operacion ?? base.match(/-(alquiler-temporal|alquiler|venta)$/)?.[1]));
  }
  return [...roots.values()];
}

/**
 * Parte un nodo en dos rangos de precio contiguos, cortando en la media geométrica (los precios
 * se distribuyen en órdenes de magnitud). null si ya no se puede partir más.
 */
export function splitNode(node) {
  if (!node.splittable) return null;
  const lo = node.min ?? PRICE_MIN;
  const hi = node.max ?? PRICE_MAX;
  if (lo >= hi) return null;
  const mid = Math.min(hi - 1, Math.max(lo, Math.floor(Math.sqrt(lo * hi))));
  return [
    { ...node, min: lo, max: mid },
    { ...node, min: mid + 1, max: hi },
  ];
}

export const totalPages = (totalResults) => Math.ceil(totalResults / PAGE_SIZE);
