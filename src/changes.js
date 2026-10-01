// Historial de cambios (opcional): cuando un aviso ya guardado reaparece en el listado con
// otros datos, se agrega una línea nueva a listings.jsonl en vez de ignorarlo. Así queda la
// historia de precios; la versión vigente de un aviso es su última línea.
//
// Sólo cuentan como cambio los campos de abajo. El resto de la tarjeta (fotos, destacado,
// descripción corta, inmobiliaria) cambia seguido sin que cambie la propiedad y sería ruido.

export const TRACKED_FIELDS = [
  'price_currency', 'price', 'expensas', 'superficie_total', 'superficie_cubierta',
  'ambientes', 'dormitorios', 'banos', 'cocheras',
];

/** Huella compacta de un aviso: es lo único que se retiene en memoria para comparar. */
export const fingerprint = (o) => TRACKED_FIELDS.map((k) => o[k] ?? '').join('|');

/** Campos de `item` que difieren de la huella guardada. [] = sin cambios. */
export function changedFields(savedFingerprint, item) {
  const before = savedFingerprint.split('|');
  return TRACKED_FIELDS.filter((k, i) => String(item[k] ?? '') !== before[i]);
}
