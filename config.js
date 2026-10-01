// Configuración técnica del scraper. Qué buscar (operaciones, tipos, zonas, pausas, fichas...)
// se elige desde la interfaz web y queda guardado en data/settings.json; los valores por
// defecto de eso están en src/settings.js. Acá queda sólo lo que casi nunca hace falta tocar.

export const config = {
  baseUrl: 'https://www.zonaprop.com.ar',

  // Puerto de la interfaz web (http://localhost:3210).
  port: 3210,

  // --- Navegador -----------------------------------------------------------------------
  // 'chrome' usa el Chrome que tenés instalado, que recibe bastantes menos challenges que el
  // Chromium que trae Puppeteer. Si no lo encuentra, cae solo al de Puppeteer. null = Puppeteer.
  chromeChannel: 'chrome',
  userDataDir: './.perfil-chrome',
  viewport: { width: 1400, height: 950 },
  // Cuánto esperar a que se resuelva la verificación de Cloudflare antes de dar el intento por
  // perdido. En una corrida larga no se aborta: se descansa `challengeCooldownMs` y se reintenta.
  challengeTimeoutMs: 240_000,
  challengeCooldownMs: 10 * 60_000,
  navTimeoutMs: 45_000,
  contentTimeoutMs: 20_000,
  retries: 3,
  // Si fallan tantas cargas seguidas (se cayó internet, bloqueo), pausa larga antes de seguir.
  maxConsecutiveFailures: 5,
  failurePauseMs: 15 * 60_000,

  // --- Salida --------------------------------------------------------------------------
  out: {
    dir: './data',
    listings: 'listings.jsonl',
    details: 'details.jsonl',
    failures: 'failures.jsonl',
    frontier: 'frontier.json', // estado de la exploración (qué búsquedas ya se recorrieron)
    settings: 'settings.json', // parámetros elegidos en la interfaz
    log: 'log.txt',
  },
  // Guardar HTML crudo en ./debug: 'never' | 'errors' (páginas con 0 avisos, fichas que no
  // parsean; como mucho `maxDebugFiles` por corrida) | 'all'
  saveHtml: 'errors',
  maxDebugFiles: 25,
};
