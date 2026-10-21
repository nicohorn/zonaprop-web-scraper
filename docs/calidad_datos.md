# Calidad de datos del scraper (EDA de control)

Control de calidad de los datos que entrenan el modelo A (precio de departamentos en venta, CABA). Se corre:

- en la interfaz: <http://localhost:3210/calidad> → **Generar reporte** (corre la tarea `quality` de `ml/run.py`;
  cada reporte queda en `data/ml/runs/<fecha>-quality/` con `result.json`, gráficos PNG y tablas CSV);
- en el notebook `notebooks/00_calidad_datos.ipynb`, paso a paso.

El código está en `ml/calidad.py` y usa la limpieza de `ml/precio.py` (`limpiar(..., traza=...)` anota qué paso quitó
cada aviso), así que audita exactamente los datos con los que se entrena. Con `ZP_DATA_DIR` se puede apuntar a otra
carpeta de datos (la interfaz también lo respeta).

## Cómo leer el reporte

Cada chequeo tiene un **estado** que mide el problema *en los datos* (OK / Atención / Crítico), los **hallazgos** con
cifras, una nota **«Qué implica para el modelo»** (si el pipeline ya lo mitiga o qué habría que cambiar), gráficos y
tablas descargables. El estado general es el peor de los seis.

| # | Chequeo | Qué mide | Atención / Crítico cuando |
|---|---|---|---|
| 0 | Controles básicos del scraper | Sobre **todos** los avisos (todas las operaciones, última versión de cada id): completitud por campo y operación (separando lo que falta por diseño del sitio de lo que falta por el parser), formato (id, URL que termina en el id, fechas ISO, moneda, operación, enteros, precio y moneda juntos), unicidad (líneas repetidas, misma URL con otro id), rangos de plausibilidad por operación y moneda, consistencia (dormitorios ≤ ambientes, operación = la de la búsqueda, ubicación en CABA) y concordancia con la URL (código ve/al/te y «N-ambientes» del título, ±1) | una regla crítica con > 1 % de fallas o un campo obligatorio < 99 % (Crítico); otra regla con > 2 % de fallas o un campo que nunca se extrae (Atención) |
| 1 | Embudo de limpieza | Filas que quita cada regla; % descartado por barrio y motivo; cambio de peso de cada barrio (peso final / peso base); χ² y V de Cramér barrio × descarte | algún barrio con ≥ `min_barrio` avisos cambia su peso más de ×0,8 / ×1,25 |
| 2 | Duplicados y fuga | Grupos de duplicados (regla v2 vs. huella v1), cuántos son de varias inmobiliarias, % del test con un gemelo en train según el protocolo (aleatorio con/sin duplicados, agrupado) | fuga del split aleatorio > 3 % (Atención) o > 10 % (Crítico). El modelo A ya la evita con el split agrupado: el estado muestra el tamaño del problema que se mitiga |
| 3 | Faltantes | % faltante por campo y USD/m² relativo a la mediana del barrio con vs. sin el dato (Mann-Whitney); correlación entre faltantes | algún campo que usa el modelo es MNAR probable (diferencia ≥ 5 % y p < 0,001) |
| 4 | Representatividad | Avisos por barrio, concentración en los barrios más grandes e IC95 bootstrap de la mediana de USD/m² (la referencia de precio del barrio que usa el modelo) | hay barrios con < `min_barrio` avisos; Crítico si son > 25 % de los barrios |
| 5 | Robustez del scraper | % de campos vacíos por franja de `scraped_at` (hora / 6 h / día); franjas que se alejan ≥ `umbral_deriva_pp` de la mediana; campos que quedaron siempre vacíos al final; ritmo y cargas fallidas (`failures.jsonl`); cobertura guardados / anunciados por búsqueda (`frontier.json`); validez de moneda, ubicación, barrio y tipo | deriva en algún campo (Atención) o en precio, moneda, superficie, ambientes o ubicación, o un campo roto al final (Crítico); búsquedas a medias, que superan el tope de páginas o cobertura < 80 % |

## Parámetros

Los de `ml/tasks.json` → `quality`: operación, tipo, regla de duplicados y pozo (los mismos defaults que el modelo A),
mínimo de avisos por barrio (30), umbral de deriva (15 puntos porcentuales), franja de tiempo (`auto`: 1 h si el scrape
dura ≤ 2 días, 6 h si dura ≤ 14, si no 1 día) y semilla (split y bootstrap). El recorte de USD/m² y la proporción de
test son los del modelo A (p1–p99 sobre train, 20 %).

## Limitaciones

- El reporte mide sólo los datos: no lee corridas del modelo, así que funciona igual en un clon sin `data/ml/`.

- La **cobertura** cuenta cada aviso en la búsqueda donde se vio por primera vez; los avisos fuera de CABA y los
  emprendimientos descartados a propósito también bajan el porcentaje. Sirve para encontrar búsquedas incompletas, no
  como estimación exacta del universo.
- La **deriva** compara contra la mediana del propio scrape: si el parser estuvo roto todo el tiempo, no se ve como
  deriva (aparece como un campo con muchos faltantes en la sección 3 o en la tabla de validez).
- MNAR se evalúa contra el precio observado: muestra asociación, no causalidad.
