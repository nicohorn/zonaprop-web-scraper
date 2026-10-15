# zonaprop-scraper

Scraper de avisos de [ZonaProp](https://www.zonaprop.com.ar) (Node.js + Puppeteer) con interfaz
web local. Arma un dataset de propiedades en JSONL y CSV.

## Uso

Doble clic en `Iniciar ZonaProp Scraper.bat`. La primera vez instala lo que falte; después abre
la interfaz en <http://localhost:3210>. Cerrar la ventana negra detiene todo.

Requiere Windows 10/11 y conexión residencial (Cloudflare bloquea IPs de datacenter y VPN).
Conviene tener Google Chrome instalado.

## Qué hace

**1. Arma las búsquedas.** Una por cada combinación de operación × tipo × zona elegida en la
interfaz. Sin tipo = todos; sin zona = todo el país.

**2. Recorre los listados.** Abre cada búsqueda en Chrome, lee cuántos avisos declara y pagina
guardando cada tarjeta. ZonaProp deja de paginar pasada la página ~500, así que una búsqueda
que no entra en el tope configurado (300 páginas) se parte en dos rangos de precio, y así
sucesivamente hasta que cada parte entra.

**3. Visita las fichas** (opcional). Entra a cada aviso guardado y agrega descripción completa,
amenities, antigüedad, orientación y todas las fotos.

**4. Guarda sobre la marcha.** Cada aviso se escribe apenas se lee y se deduplica por `id`. Al
detener y volver a iniciar retoma en la misma búsqueda y página.

Mientras corre:

- Espera entre 2 y 4,5 s entre páginas, con un solo navegador.
- Si Cloudflare pide verificación, avisa en la interfaz y espera a que se tilde el casillero en
  la ventana de Chrome.
- Ante una verificación sin resolver, un navegador cerrado o internet caído, pausa y reintenta.
- Evita que Windows suspenda la PC.
- Saltea las zonas mal escritas (el sitio las redirige a otra búsqueda) y lo anota en el registro.

Ritmo aproximado: una página de listado (30 avisos) o una ficha cada 5 s. Todo el país en venta
son unas 20.000 páginas.

## Qué guarda

En `data/`:

| Archivo | Contenido |
| --- | --- |
| `listings.jsonl` | un aviso por línea, tomado del listado |
| `details.jsonl` | una ficha por línea |
| `failures.jsonl` | búsquedas inválidas, páginas que no cargaron, avisos dados de baja |
| `frontier.json` | avance de la exploración |
| `settings.json` | parámetros elegidos en la interfaz |
| `log.txt` | registro de todas las corridas |

Los CSV se descargan desde la interfaz o con `npm run csv`.

**Avisos:** `id`, `posting_type` (`PROPERTY` o `DEVELOPMENT` = emprendimiento), `url`, `title`,
`price_currency`, `price`, `expensas`, `superficie_total`, `superficie_cubierta`, `ambientes`,
`dormitorios`, `banos`, `cocheras`, `address`, `location`, `description_short`, `publisher`,
`date_posted`, `highlight`, `pills`, `photos`, `search_slug`, `tipo`, `operacion`, `zona`,
`page`, `search_url`, `scraped_at`.

**Fichas** (lo anterior más): `tipo_propiedad`, `status`, `reserved`, `posting_code`,
`antiguedad`, `antiguedad_texto`, `disposicion`, `orientacion`, `luminosidad`, `toilettes`,
`features_extra`, `address_locality`, `address_region`, `neighborhood`, `city`, `province`,
`location_ids`, `amenities`, `amenities_flat`, `description`, `published_text`,
`published_days`, `publisher_id`, `publisher_url`, `publisher_premium`.

Para el análisis:

- `price: null` = "Consultar precio". `expensas: null` = no informa (no es cero).
- `price` está en la moneda de `price_currency` (USD o ARS), sin convertir.
- No hay coordenadas: el sitio no las publica.
- `published_days` es relativo a `scraped_at`.
- Un aviso que aparece en varias búsquedas queda con la etiqueta de la primera que lo encontró.

## Sólo CABA

Por defecto `soloCaba: true` (`src/settings.js`, `src/caba.js`): la zona se fuerza a `capital-federal`, las URLs pegadas a mano sólo se aceptan si apuntan a CABA o a uno de sus barrios, y cada aviso se guarda sólo si su `location` termina en `Capital Federal` o en un barrio porteño (el sitio rellena con otras zonas). La fase de fichas también saltea avisos fuera de CABA ya guardados. Para volver a todo el país: `"soloCaba": false` en `data/settings.json`.

## Modelos (CABA)

Sección de la interfaz en <http://localhost:3210/modelos> (botón **Modelos** arriba). Entrena con lo que haya en `data/` y deja cada corrida en `data/ml/runs/<fecha>-<tarea>/` (params, result.json, CSV y gráficos).

Instalación de Python (una vez; Python 3.11–3.13, por ejemplo el de Anaconda):

```powershell
python -m venv ml\.venv
ml\.venv\Scripts\python.exe -m pip install -r ml\requirements.txt
```

La interfaz usa `ml/.venv` sola (o la variable `ZP_PYTHON`). Cada modelo trae parámetros por defecto: elegir, **Entrenar** y mirar la barra de avance; **Cancelar** corta el proceso. Resultados (métricas, tablas, gráficos, CSV descargables) aparecen a la derecha; las corridas anteriores quedan listadas.

| Modelo | Qué hace | Datos mínimos |
| --- | --- | --- |
| A · Precio | Ridge + LightGBM sobre log(precio) o USD/m²; métricas en USD, importancia, SHAP | 60 avisos del tipo elegido |
| B · Oportunidades | residuos fuera de muestra + IsolationForest vs. mediana del barrio; ranking de baratos | 60 |
| C · Renta vs. venta | alquiler (pesos → USD con el MEP indicado) / venta USD/m², por barrio | avisos de venta **y** alquiler |
| D · Segmentos | k-means o HDBSCAN, perfil por segmento y PCA | 50 |
| E · Texto | TF-IDF: términos que suben/bajan el USD/m² y mejora del modelo al sumar texto | 80 |
| F · Supervivencia | Kaplan-Meier/Cox del tiempo hasta la baja; hoy avisa que faltan datos (requiere re-scrapes con historial y fichas) | 30 bajas |

Notebook: `notebooks/01_price_prediction.ipynb` (kernel de `ml/.venv`; abrir con `ml\.venv\Scripts\jupyter lab`). Código común en `ml/zpml.py`, entrenamientos en `ml/run.py`, parámetros y defaults en `ml/tasks.json`, orquestación desde Node en `src/ml.js`.

## Historial de cambios

Opción de la interfaz, apagada por defecto. Sin ella, un aviso ya guardado no se vuelve a
escribir. Con ella, si reaparece con otro precio, expensas, superficie o ambientes se agrega una
línea nueva con `changed_fields`. *Descargar avisos* trae la última versión de cada uno;
*Descargar historial*, todas. Sólo se detecta al volver a recorrer una búsqueda (*Volver a
explorar desde cero*), y las fichas ya visitadas no se actualizan.

## Límites

- Quedan afuera los avisos sin precio de las búsquedas que hubo que partir (~0,4%).
- Los avisos dados de baja no se borran del dataset.
- Una búsqueda con menos de 30 resultados viene rellenada con avisos de otras zonas, que se
  guardan igual.
- Es scraping de páginas públicas a ritmo humano con fines académicos. Antes de correrlo revisá
  <https://www.zonaprop.com.ar/robots.txt> y los términos de uso; no lo aceleres ni lo
  paralelices.
- `description` y `publisher` pueden traer datos de particulares: anonimizá antes de publicar.

## Por consola

Requiere Node 22.12+.

```bash
npm install
npm start                       # la interfaz (igual que el .bat)
npm run scrape                  # corrida sin interfaz, con los parámetros guardados
npm run csv                     # exporta data/*.jsonl a CSV
npm test                        # parsers contra capturas reales + lógica de exploración
node scripts/inspect.js <url>   # diagnóstico de una URL: HTML y captura en debug/
```

Flags de `scrape`: `--solo-listado`, `--solo-detalle`, `--limite N` (tope de fichas),
`--headless` (sin ventana; sólo después de una corrida con ventana que haya pasado la
verificación).

## Código

```
Iniciar ZonaProp Scraper.bat   lanzador
config.js              configuración técnica (puerto, navegador, tiempos de espera)
ui/index.html          interfaz
src/server.js          servidor local y descarga de CSV
src/crawler.js         orquestación de la corrida, pausas y reintentos
src/explore.js         búsquedas de partida y partición por precio
src/browser.js         navegador y espera de la verificación
src/parse/             lectura de tarjetas y fichas
src/changes.js         detección de cambios para el historial
src/storage.js         archivos JSONL
src/export.js          JSONL a CSV
test/                  tests
```

## Si falla

1. Mirá `data/log.txt`.
2. `npm test`: si falla, cambió el sitio y hay que ajustar `src/parse/`.
3. `node scripts/inspect.js <url>` y revisá `debug/`: una página de Cloudflare se resuelve
   corriendo con ventana; una página real sin tarjetas indica que cambiaron los selectores.
4. Si la verificación salta en cada página: subí la pausa, destildá "No cargar imágenes" y no
   borres `.perfil-chrome/`.
