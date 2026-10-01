// Sesión de navegador para ZonaProp.
//
// ZonaProp está detrás de Cloudflare (desde ~agosto 2026; antes era DataDome). Lo que se
// aprendió a los golpes y está codificado acá:
//   - Perfil persistente (userDataDir): la cookie cf_clearance sobrevive entre corridas.
//   - Chrome instalado > Chromium de Puppeteer: recibe muchos menos challenges.
//   - Pasar por la home antes de la primera búsqueda. Entrar directo a una URL de resultados
//     sin cookies ni referer es de las cosas que más dispara el challenge.
//   - Cuando salta el challenge, NO TOCAR LA PÁGINA. Ni reload ni goto ni reintento: eso
//     recargaba justo cuando ibas a tildar el casillero. Se espera, se chequea 1 vez por
//     segundo, y se sigue solo cuando pasó.
//   - Pausas aleatorias entre páginas.
//
// Para corridas largas sin nadie mirando: las esperas se pueden cortar (`shouldStop`), quien
// maneja la sesión se entera de que hay una verificación pendiente (`onAttention`), y una
// verificación que nadie resolvió tira ChallengeTimeout para que el que llama decida (descansar
// y reintentar) en vez de abortar todo.

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from '../config.js';
import { CARD_SELECTOR } from './parse/listing.js';

puppeteer.use(StealthPlugin());

const CHALLENGE_MARKERS = [
  'challenges.cloudflare.com',
  'cf_chl_opt',
  '__cf_chl',
  'cf-turnstile',
  'verificación de seguridad en curso',
  'verifique que es un ser humano',
  'checking your browser',
  'captcha-delivery.com', // DataDome, por si vuelven
];
const CHALLENGE_TITLES = ['un momento', 'just a moment', 'attention required', 'acceso denegado', 'access denied'];

// Dominios del challenge: jamás bloquearles un recurso.
const NEVER_BLOCK = ['challenges.cloudflare.com', '/cdn-cgi/', 'captcha-delivery.com', 'hcaptcha.com', 'recaptcha.net'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Se pidió frenar (botón Detener, Ctrl+C). No es un error del scraping. */
export class StopError extends Error {
  constructor() { super('Detenido'); this.name = 'StopError'; }
}
/** Pasó `challengeTimeoutMs` y la verificación de seguridad seguía ahí. */
export class ChallengeTimeout extends Error {
  constructor(seconds) { super(`Pasaron ${seconds}s y la verificación seguía sin resolverse.`); this.name = 'ChallengeTimeout'; }
}

/**
 * ¿Es un challenge? Si la página ya tiene el contenido que esperamos, no lo es, aunque haya
 * scripts de Cloudflare dando vueltas (las páginas normales también los cargan).
 */
export function detectChallenge(html, title = '', hasContent = false) {
  if (hasContent) return null;
  const low = html.slice(0, 300_000).toLowerCase();
  const t = (title || '').trim().toLowerCase();
  if (CHALLENGE_MARKERS.some((m) => low.includes(m))) return 'Cloudflare';
  if (CHALLENGE_TITLES.some((x) => t.startsWith(x))) return 'verificación';
  return null;
}

export class Session {
  constructor(opts = {}) {
    this.opts = { delayMs: { min: 2000, max: 4500 }, headless: false, blockResources: false, ...config, ...opts };
    this.browser = null;
    this.page = null;
    this.warmedUp = false;
    this.log = opts.log || ((...a) => console.log(...a));
    this.shouldStop = opts.shouldStop || (() => false);
    this.onAttention = opts.onAttention || (() => {}); // 'verificacion' | null
  }

  /** sleep que se corta (con StopError) si se pidió frenar. */
  async sleep(ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (this.shouldStop()) throw new StopError();
      const left = end - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(250, left));
    }
  }

  /** Pausa aleatoria entre páginas. */
  humanDelay() {
    const { min, max } = this.opts.delayMs;
    return this.sleep(min + Math.random() * (max - min));
  }

  get alive() {
    return Boolean(this.browser?.connected && this.page && !this.page.isClosed());
  }

  async launch() {
    this.browser = null;
    this.page = null;
    this.warmedUp = false;
    const base = {
      headless: this.opts.headless,
      userDataDir: this.opts.userDataDir,
      defaultViewport: this.opts.viewport,
      args: ['--lang=es-AR', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    };
    if (this.opts.chromeChannel) {
      try {
        this.browser = await puppeteer.launch({ ...base, channel: this.opts.chromeChannel });
        this.log(`Navegador: Chrome instalado (channel=${this.opts.chromeChannel})`);
      } catch (e) {
        this.log(`No pude usar Chrome instalado (${e.message.split('\n')[0]}). Uso el Chromium de Puppeteer.`);
      }
    }
    if (!this.browser) {
      this.browser = await puppeteer.launch(base);
      this.log('Navegador: Chromium de Puppeteer');
    }

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8' });

    if (this.opts.blockResources) {
      await this.page.setRequestInterception(true);
      this.page.on('request', (req) => {
        const url = req.url();
        const type = req.resourceType();
        const blockable = ['image', 'media', 'font'].includes(type) && !NEVER_BLOCK.some((h) => url.includes(h));
        blockable ? req.abort() : req.continue();
      });
    }
    return this;
  }

  async close() {
    try { await this.browser?.close(); } catch { /* ya cerrado */ }
  }

  /** Pasar por la home primero. Si la home falla no es crítico. */
  async warmUp() {
    if (this.warmedUp) return;
    this.warmedUp = true;
    try {
      await this.page.goto(`${this.opts.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs });
      await this.sleep(1200);
      if (await this.currentChallenge()) await this.resolveChallenge();
    } catch (e) {
      if (e instanceof StopError || e instanceof ChallengeTimeout) throw e;
      this.log(`(home no cargó: ${e.message.split('\n')[0]}; sigo igual)`);
    }
  }

  async hasContent(contentSelector) {
    if (!contentSelector) return false;
    try { return (await this.page.$(contentSelector)) !== null; } catch { return false; }
  }

  async currentChallenge(contentSelector = CARD_SELECTOR) {
    try {
      const [html, title, has] = await Promise.all([this.page.content(), this.page.title(), this.hasContent(contentSelector)]);
      return detectChallenge(html, title, has);
    } catch {
      return null; // la página está navegando
    }
  }

  /** Espera a que el humano resuelva la verificación. No toca la página. */
  async resolveChallenge(contentSelector = CARD_SELECTOR) {
    this.onAttention('verificacion');
    try {
      return await this.waitChallenge(contentSelector);
    } finally {
      this.onAttention(null);
    }
  }

  async waitChallenge(contentSelector) {
    const kind = (await this.currentChallenge(contentSelector)) || 'verificación';
    try { await this.page.bringToFront(); } catch { /* headless */ }

    if (this.opts.headless) {
      this.log(`\n  VERIFICACIÓN DE SEGURIDAD (${kind}) con el navegador oculto: no hay forma de tildar el casillero.`);
      this.log('  Corré con la ventana visible la primera vez para dejar la cookie guardada.\n');
    } else {
      this.log('\n  ' + '='.repeat(66));
      this.log(`  VERIFICACIÓN DE SEGURIDAD (${kind}). Te toca a vos.`);
      this.log('  Tildá el casillero en la ventana del navegador. No cierres ni recargues:');
      this.log(`  espero hasta ${Math.round(this.opts.challengeTimeoutMs / 1000)}s y sigo solo cuando pase.`);
      this.log('  ' + '='.repeat(66) + '\n');
    }

    const deadline = Date.now() + this.opts.challengeTimeoutMs;
    let lastNotice = Date.now();
    while (Date.now() < deadline) {
      await this.sleep(1000);
      if (!(await this.currentChallenge(contentSelector))) {
        this.log('  Verificación pasada, sigo.\n');
        await this.sleep(1500);
        return true;
      }
      if (Date.now() - lastNotice >= 30_000) {
        lastNotice = Date.now();
        this.log(`  ...esperando (quedan ${Math.round((deadline - Date.now()) / 1000)}s)`);
      }
    }
    throw new ChallengeTimeout(Math.round(this.opts.challengeTimeoutMs / 1000));
  }

  /**
   * Navega a `url` y devuelve el HTML una vez que apareció `contentSelector` (o se agotó el
   * tiempo sin challenge: puede ser una página con 0 resultados). Si salta el challenge,
   * espera a que lo resuelvas y NO reintenta hasta que pase.
   */
  async goto(url, { contentSelector = CARD_SELECTOR, retries = this.opts.retries } = {}) {
    await this.warmUp();
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs });
      } catch (e) {
        lastErr = e;
        this.log(`  goto falló (intento ${attempt}/${retries}): ${e.message.split('\n')[0]}`);
        if (!this.alive) break; // se cerró el navegador: reintentar acá no sirve, que relance el que llama
        await this.sleep(3000 + 4000 * attempt);
        continue;
      }

      let deadline = Date.now() + this.opts.contentTimeoutMs;
      while (Date.now() < deadline) {
        if (await this.hasContent(contentSelector)) return this.page.content();
        const challenge = await this.currentChallenge(contentSelector);
        if (challenge) {
          await this.resolveChallenge(contentSelector);
          // Cloudflare recarga solo la página original al pasar; volvemos a esperar el contenido.
          deadline = Date.now() + this.opts.contentTimeoutMs;
          continue;
        }
        await this.sleep(500);
      }
      // Sin challenge y sin contenido: probablemente una página vacía (0 resultados / aviso dado
      // de baja). Devolvemos lo que hay y que el parser decida.
      return this.page.content();
    }
    throw new Error(`No pude cargar ${url}: ${lastErr?.message}`);
  }

  /** Scroll suave: materializa imágenes lazy y parece más humano. */
  async scroll(steps = 4) {
    for (let i = 0; i < steps; i++) {
      try { await this.page.mouse.wheel({ deltaY: 900 }); } catch { break; }
      await this.sleep(200 + Math.random() * 300);
    }
  }

  async screenshot(path) {
    try { await this.page.screenshot({ path, fullPage: false }); } catch { /* no crítico */ }
  }
}
