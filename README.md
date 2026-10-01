# zonaprop-scraper

Scraper de avisos de [ZonaProp](https://www.zonaprop.com.ar) en Node.js + Puppeteer. Recorre
búsquedas (listado) y después visita la ficha de cada aviso (detalle). Pensado para armar un
dataset de propiedades para análisis: sale JSONL y CSV listos para pandas.

Los parsers están verificados contra capturas reales del sitio de septiembre 2026
(`test/fixtures/`, tomadas del repo [Foquitos/zonaprop](https://github.com/Foquitos/zonaprop)).

## Uso rápido (interfaz web)

**Doble clic en `Iniciar ZonaProp Scraper.bat`.** La primera vez prepara lo que falte (si la PC
no tiene Node.js baja uno portable a `.runtime/`, e instala los componentes); después abre la
interfaz en el navegador (<http://localhost:3210>). La ventana negra tiene que quedar abierta:
cerrarla detiene todo.

En la interfaz:

1. **Elegí qué buscar**: operación, tipos de propiedad y zonas. Sin tipos = todos; sin zonas =
   todo el país. Los parámetros se guardan solos.
2. **Iniciar.** Se abre una ventana de Chrome que navega sola. Si ZonaProp pide la verificación
   de seguridad, la interfaz avisa: tildás el casillero en esa ventana y sigue.
3. **Dejalo corriendo.** Se puede dejar toda la noche: no deja que la PC se suspenda, y si se
   cae internet, se cierra el navegador o nadie resuelve una verificación, espera y reintenta.
4. **Descargá el CSV** de avisos o de fichas cuando quieras, incluso con la corrida en marcha.

*Detener* corta en el momento; la corrida siguiente retoma donde quedó (misma búsqueda, misma
página) y no repite búsquedas ya terminadas. *Volver a explorar desde cero* las recorre de nuevo
para sumar avisos publicados después, sin borrar lo guardado.

Requisitos: Windows 10/11, conexión residencial (ZonaProp está detrás de Cloudflare y bloquea
IPs de datacenter/VPN, así que **no corre desde la nube**) y, recomendado, Google Chrome
instalado (si no está, se usa el Chromium que baja Puppeteer).

## Cómo explora

ZonaProp declara, por ejemplo, 600.000 inmuebles en venta, pero **una búsqueda sola no entrega
más de ~15.000**: hasta la página ~500 pagina de verdad y después devuelve siempre la misma
página de relleno, sin error (verificado en octubre 2026). Para llegar a todo, el scraper:

1. Arma las búsquedas de partida: operación × tipo × zona (más las URLs que pegues a mano).
2. Abre la primera página de cada una y lee del `<h1>` cuántos avisos declara.
3. Si no entran en *Páginas por búsqueda* (300 por defecto = 9.000 avisos), **la parte en dos
   rangos de precio** (`…-1-31622-dolar`, `…-31623-999999999-dolar`) y repite con cada mitad,
   hasta que cada pedazo entra. El filtro de precio del sitio convierte monedas, así que un
   rango en dólares también trae los avisos en pesos; sólo quedan afuera los "Consultar precio"
   (~0,4%).
4. Pagina cada pedazo y deduplica por `id`.

Un slug mal escrito no da 404: el sitio redirige a una búsqueda más amplia. Eso se detecta
comparando la URL final con la pedida; la búsqueda se saltea y queda anotada en el registro.

Cuánto tarda, con la pausa por defecto: del orden de 500 páginas de listado por hora (unos
15.000 avisos) y otras tantas fichas por hora. Todo el país en venta son ~20.000 páginas: más de
un día de listado. Las fichas de 600.000 avisos llevarían más de un mes; para fichas conviene
acotar por zona o tipo.

## Por consola

Requiere Node 22.12+.

```bash
npm install          # baja Chromium (~150 MB). Si vas a usar tu Chrome: PUPPETEER_SKIP_DOWNLOAD=1 npm install
npm test             # parsers contra capturas reales + lógica de exploración
npm start            # la interfaz web (lo mismo que el .bat)
npm run scrape       # una corrida sin interfaz, con los parámetros guardados en data/settings.json
npm run csv          # data/listings.csv y data/details.csv
node scripts/inspect.js <url>   # diagnóstico de una URL: guarda HTML + captura en debug/
```

Flags de `scrape`:

| Flag | Qué hace |
| --- | --- |
| `--solo-listado` | sólo fase 1 |
| `--solo-detalle` | sólo fase 2, sobre lo que haya en `data/listings.jsonl` |
| `--limite N` | tope de fichas a visitar en esta corrida (para probar: `--limite 10`) |
| `--headless` | sin ventana; recién cuando ya tengas la cookie guardada |

**Primera corrida siempre con ventana.** Si Cloudflare tira el challenge hay que tildar el
casillero a mano. La cookie queda en `.perfil-chrome/`; las corridas siguientes no la vuelven a
pedir por un buen rato y ahí sí se puede ocultar el navegador.

Todo se guarda línea a línea en `data/`:

| Archivo | Qué es |
| --- | --- |
| `listings.jsonl` | un aviso por línea, del listado |
| `details.jsonl` | una ficha por línea |
| `failures.jsonl` | búsquedas inválidas, páginas que no cargaron, avisos dados de baja |
| `frontier.json` | estado de la exploración: qué búsquedas se terminaron, se partieron o quedaron a medias |
| `settings.json` | parámetros elegidos en la interfaz |
| `log.txt` | el registro de todas las corridas |

## Qué sale

**`listings.jsonl`** (una línea por tarjeta del listado): `id`, `posting_type` (`PROPERTY` o
`DEVELOPMENT` = emprendimiento), `url`, `title`,
`price_currency`, `price`, `expensas`, `superficie_total`, `superficie_cubierta`, `ambientes`,
`dormitorios`, `banos`, `cocheras`, `address`, `location`, `description_short`, `publisher`,
`date_posted`, `highlight`, `pills`, `photos`, `search_slug`, `tipo`, `operacion`, `zona`,
`page`, `search_url`, `scraped_at`.

**`details.jsonl`** (una línea por ficha, incluye todo lo anterior más): `tipo_propiedad`,
`status`, `reserved`, `posting_code`, `antiguedad`, `antiguedad_texto` (`A estrenar`, `En pozo`),
`disposicion`, `orientacion`, `luminosidad`, `features_extra`, `address_locality`,
`address_region`, `neighborhood`, `city`, `province`, `location_ids`, `amenities` (por
categoría), `amenities_flat`, `description` (completa), `published_text`, `published_days`,
`publisher_id`, `publisher_url`, `publisher_premium`, `photos` (galería completa en 1200px).

Convenciones que importan para el análisis:

- `price: null` = "Consultar precio". `expensas: null` = **no informa**, que no es lo mismo que
  cero. Si querés detectar "sin expensas" declarado, buscalo en `description`.
- `price` viene en la moneda de `price_currency` (USD o ARS). No se convierte.
- **No hay coordenadas.** La ficha no las trae (verificado en septiembre 2026). Si las
  necesitás, geocodificá `address + city + province` con Nominatim o la API de Georef de
  Argentina. Los `location_ids` internos sirven para agrupar por barrio sin geocodificar.
- `published_days` es relativo a `scraped_at`.

## Cómo funciona por dentro

```
Iniciar ZonaProp Scraper.bat   lanzador: prepara Node/dependencias, levanta la interfaz
config.js              configuración técnica (puerto, navegador, timeouts, salida)
ui/index.html          la interfaz (una sola página, sin dependencias)
src/server.js          servidor local: API + eventos en vivo + descarga de CSV
src/crawler.js         orquestación: fase 1 (listado, con partición) → fase 2 (fichas); pausas y reintentos
src/explore.js         búsquedas de partida y partición por rango de precio
src/settings.js        parámetros de la interfaz: defaults y saneo
src/browser.js         Puppeteer + stealth, perfil persistente, detección y espera del challenge
src/urls.js            paginación y slugs
src/parse/listing.js   tarjetas [data-qa="posting PROPERTY|DEVELOPMENT"] + JSON-LD (inmobiliaria, fecha)
src/parse/detail.js    objetos JS inline de la ficha (mainFeatures, publisher, avisoInfo, ...)
src/parse/util.js      números es-AR, precios, extracción de literales JS, JSON-LD
src/storage.js         JSONL append-only en streaming, con índice para dedup/resume
src/export.js          JSONL → CSV plano, en streaming
src/keepawake.js       evita que Windows suspenda la PC durante una corrida
src/scrape.js          corrida por consola
scripts/inspect.js     diagnóstico de una URL
scripts/to-csv.js      JSONL → CSV por consola
test/                  parsers contra capturas reales + exploración
```

**Listado.** Cada aviso es un `<div data-qa="posting PROPERTY" data-id="…" data-to-posting="…">`
con hijos `data-qa="POSTING_CARD_PRICE"`, `expensas`, `POSTING_CARD_FEATURES`,
`POSTING_CARD_LOCATION`, `POSTING_CARD_DESCRIPTION`, `POSTING_CARD_GALLERY`. Los `data-qa` los
usa ZonaProp para sus propios tests, por eso son estables. El nombre de la inmobiliaria y la
fecha de publicación no están en la tarjeta: salen de un bloque JSON-LD
(`@type: RealEstateListing`, `mainEntity[]`) que se cruza por id.

**Ficha.** Viene server-rendered con objetos JS inline que son más limpios que el DOM:
`const mainFeatures = {…}` (superficie, ambientes, antigüedad, orientación…),
`const publisher = {…}`, `const avisoInfo = {…}` (precio estructurado, expensas, estado,
amenities por categoría), `const dataLayerInfo = {…}` (operación, tipo, barrio/ciudad/provincia).
`avisoInfo` y `dataLayerInfo` son literales JS con comillas mezcladas, no JSON, así que se
leen claves sueltas (`jsKey`, `jsKeyJson`) en vez de parsearlos enteros.

**Cloudflare.** Un challenge se detecta por marcas en el HTML/título *sólo si la página no
tiene el contenido esperado* (las páginas normales también cargan scripts de Cloudflare).
Cuando se detecta, el script no navega, no recarga ni reintenta: espera hasta
`challengeTimeoutMs` chequeando cada segundo, porque cualquier `goto` recargaba justo cuando
ibas a tildar el casillero. Si pasa ese tiempo y nadie lo resolvió (corrida de noche), descansa
`challengeCooldownMs` y vuelve a probar; no aborta.

## Límites, ética y qué contar en el informe

- **Cobertura.** Quedan afuera los avisos sin precio de las búsquedas que hubo que partir, y lo
  que se publique o cambie de página mientras se pagina. Dedup por `id` cubre los solapamientos.
  Por defecto un aviso ya guardado no se vuelve a escribir, así que los precios no se actualizan.
- **Historial de cambios** (opción de la interfaz, apagada por defecto). Con la opción marcada,
  si un aviso ya guardado reaparece en el listado con otro precio, expensas, superficie o
  ambientes, se agrega una línea nueva a `listings.jsonl` con `scraped_at` nuevo y
  `changed_fields` (qué cambió). La versión vigente de un aviso es su última línea: *Descargar
  avisos* trae sólo esa y *Descargar historial* todas. Sólo se detecta al volver a pasar por la
  búsqueda (*Volver a explorar desde cero*); las fichas ya visitadas no se actualizan.
- **robots.txt.** Leé <https://www.zonaprop.com.ar/robots.txt> antes de correr y decidí
  conscientemente qué vas a respetar; scrapers comerciales reportan que el sitio pide un tope de
  páginas por búsqueda. Mencionarlo en el informe suma.
- **Términos de uso.** Esto es scraping de páginas públicas con fines académicos, a ritmo
  humano (2–4,5 s entre requests, un solo navegador). No lo aceleres ni lo paralelices: además
  de ser lo correcto, es lo que hace que no te frene Cloudflare.
- **Datos personales.** Las inmobiliarias son empresas, pero la descripción puede traer nombres
  y matrículas de particulares. Para el TP, considerá anonimizar `publisher` y no publicar
  `description` cruda.
- **Reproducibilidad.** Guardá `scraped_at`, el `search_slug` y la versión del front (aparece en
  las URLs de assets, ej. `RPLISv8.321.2`) para explicar por qué un scraper de hoy puede no
  andar en seis meses.

## Cuando se rompe

0. Mirá `data/log.txt`: ahí queda el registro completo de cada corrida.
1. `npm test`. Si falla, cambió el front y hay que ajustar selectores en `src/parse/`.
   Si pasa, el problema es de navegación.
2. `node scripts/inspect.js <url>` y mirá `debug/`. Si el HTML es una página de Cloudflare,
   corré con ventana y resolvé el challenge; si es una página real con 0 tarjetas, cambiaron
   el `data-qa` (abrí el HTML y buscá `data-id=`).
3. Si el challenge salta en cada página: usá el Chrome instalado (`chromeChannel: 'chrome'`),
   destildá "No cargar imágenes", subí la pausa entre páginas, y no borres `.perfil-chrome/`.
4. Si ni con ventana pasa el casillero: hay reportes de que las IPs argentinas reciben más
   challenges que otras. Probá desde otra red antes de tocar código.
