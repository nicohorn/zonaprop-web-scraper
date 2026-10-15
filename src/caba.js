// Ciudad Autónoma de Buenos Aires (CABA), "Capital Federal" en ZonaProp.
//
// Cuando settings.soloCaba está activo (por defecto):
//   1. Filtro en origen: la única zona que se busca es `capital-federal` (sus 48 barrios
//      oficiales; NO incluye GBA Norte/Sur/Oeste ni el resto de la provincia de Buenos Aires).
//      Las URLs pegadas a mano sólo se aceptan si su zona es capital-federal o un barrio de CABA.
//   2. Filtro de seguridad: ZonaProp rellena las búsquedas chicas con avisos de otras zonas, así
//      que cada tarjeta se guarda sólo si su `location` termina en "Capital Federal" o en un
//      barrio de CABA. Formatos vistos: "Palermo, Capital Federal", "Las Cañitas, Palermo",
//      "Palermo Viejo, Villa Crespo".

import { normalize } from './parse/util.js';

export const CABA_ZONA = 'capital-federal';

// 48 barrios oficiales + alias que usa el sitio como "barrio padre".
export const CABA_BARRIOS = [
  'Agronomía', 'Almagro', 'Balvanera', 'Barracas', 'Belgrano', 'Boedo', 'Caballito', 'Chacarita',
  'Coghlan', 'Colegiales', 'Constitución', 'Flores', 'Floresta', 'La Boca', 'La Paternal', 'Liniers',
  'Mataderos', 'Monte Castro', 'Monserrat', 'Nueva Pompeya', 'Núñez', 'Palermo', 'Parque Avellaneda',
  'Parque Chacabuco', 'Parque Chas', 'Parque Patricios', 'Puerto Madero', 'Recoleta', 'Retiro',
  'Saavedra', 'San Cristóbal', 'San Nicolás', 'San Telmo', 'Vélez Sarsfield', 'Versalles',
  'Villa Crespo', 'Villa del Parque', 'Villa Devoto', 'Villa General Mitre', 'Villa Lugano',
  'Villa Luro', 'Villa Ortúzar', 'Villa Pueyrredón', 'Villa Real', 'Villa Riachuelo',
  'Villa Santa Rita', 'Villa Soldati', 'Villa Urquiza',
  // alias frecuentes en ZonaProp
  'Boca', 'Paternal', 'Pompeya', 'Montserrat', 'Centro / Microcentro', 'Microcentro', 'Tribunales',
  'Congreso', 'Once', 'Abasto', 'Barrio Norte', 'Villa Pueyrredon',
];

const KEYS = new Set([...CABA_BARRIOS, 'Capital Federal', 'CABA', 'Ciudad Autónoma de Buenos Aires'].map(normalize));
const SLUGS = new Set([...KEYS].map((k) => k.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')));

/** "Las Cañitas, Palermo" -> true ; "Pilar, GBA Norte" -> false. Mira el último segmento. */
export function isCabaLocation(location) {
  if (!location) return false;
  const parts = String(location).split(',').map((s) => normalize(s)).filter(Boolean);
  return parts.length > 0 && KEYS.has(parts[parts.length - 1]);
}

/** Zona de un slug de búsqueda (ver urls.parseSlug) dentro de CABA. Admite filtros detrás. */
export function isCabaZona(zona) {
  if (!zona) return false;
  const z = normalize(zona);
  return [...SLUGS].some((s) => z === s || z.startsWith(`${s}-`));
}
