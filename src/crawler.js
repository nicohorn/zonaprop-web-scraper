// Orquestación de una corrida, pensada para dejarla horas sin mirar.
//
// Fase 1 (listado): recorre las búsquedas raíz (operación × tipo × zona). Si una búsqueda
//   declara más avisos de los que se pueden paginar, la parte por rango de precio y sigue con
//   los pedazos (ver explore.js). El avance queda en data/frontier.json: al volver a iniciar
//   retoma en la página donde quedó y no repite búsquedas terminadas.
// Fase 2 (fichas): visita la ficha de cada aviso que todavía no esté en details.jsonl.
//
// Nada aborta la corrida salvo el botón Detener: una verificación que nadie resuelve, un
// navegador que se cierra o internet caído se manejan con pausas y reintentos.

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { config } from '../config.js';
import { Session, StopError, ChallengeTimeout } from './browser.js';
import { pageUrl, searchSlug, parseSlug } from './urls.js';
import { parseListing, CARD_SELECTOR } from './parse/listing.js';
import { parseDetail, looksLikeDetail } from './parse/detail.js';
import { JsonlStore, readJsonl, readJson, writeJson, saveDebugHtml } from './storage.js';
import { buildRoots, splitNode, nodeSlug, nodeUrl, totalPages, PAGE_SIZE } from './explore.js';
import { sanitizeSettings } from './settings.js';
import { keepAwake } from './keepawake.js';
import { fingerprint, changedFields } from './changes.js';

const DETAIL_SELECTOR = '#longDescription, .price-value, h1';
const DETAIL_CHUNK = 500;

const out = (f) => join(config.out.dir, f);
const now = () => new Date().toISOString();
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
const stripUrl = (u) => u.split(/[?#]/)[0];
const isProperty = (url) => Boolean(url?.includes('/clasificado/'));

export class Crawler extends EventEmitter {
  constructor() {
    super();
    // De cada aviso del listado sólo se recuerda si tiene ficha visitable (p) y la huella de su
    // última versión (h), para detectar cambios. Con historial, un id puede tener varias líneas.
    this.listings = new JsonlStore(out(config.out.listings), { pick: (o) => ({ p: isProperty(o.url), h: fingerprint(o) }) });
    this.details = new JsonlStore(out(config.out.details));
    this.failures = new JsonlStore(out(config.out.failures), { key: 'key' });
    this.frontierPath = out(config.out.frontier);
    this.frontier = { nodes: {} };
    this.state = 'idle'; // idle | running | stopping
    this.session = null;
    this.stopRequested = false;
    this.run_ = this.freshRun();
  }

  async init() {
    await Promise.all([this.listings.load(), this.details.load(), this.failures.load()]);
    this.frontier = readJson(this.frontierPath, { nodes: {} });
    this.frontier.nodes ??= {};
    return this;
  }

  freshRun() {
    return {
      phase: null, // listado | fichas
      attention: null, // verificacion | pausa
      current: null, // { slug, page, pages, total } | { id }
      queue: 0,
      startedAt: null,
      finishedAt: null,
      result: null, // terminado | detenido | error
      newListings: 0,
      changedListings: 0,
      newDetails: 0,
      pagesFetched: 0,
      detailsPending: null,
      consecutiveFailures: 0,
      debugFiles: 0,
    };
  }

  get running() { return this.state !== 'idle'; }

  status() {
    const { consecutiveFailures, debugFiles, ...run } = this.run_;
    return {
      state: this.state,
      ...run,
      listings: this.listings.size,
      details: this.details.size,
      failures: this.failures.size,
      searchesDone: Object.values(this.frontier.nodes).filter((n) => n.s === 'done').length,
    };
  }

  log(msg = '') { this.emit('log', msg); }
  changed() { this.emit('status', this.status()); }
  saveFrontier() { writeJson(this.frontierPath, this.frontier); }

  /** Olvida qué búsquedas ya se recorrieron (los avisos guardados no se tocan). */
  resetFrontier() {
    if (this.running) throw new Error('Detené la corrida antes de reiniciar la exploración.');
    this.frontier = { nodes: {} };
    this.saveFrontier();
    this.changed();
  }

  stop() {
    if (this.state !== 'running') return;
    this.stopRequested = true;
    this.state = 'stopping';
    this.log('Deteniendo...');
    this.changed();
    // Cerrar el navegador corta cualquier navegación en curso; lo guardado ya está en disco.
    this.session?.close();
  }

  async run(rawSettings, { soloListado = false, soloDetalle = false } = {}) {
    if (this.running) throw new Error('Ya hay una corrida en curso.');
    const settings = this.settings = sanitizeSettings(rawSettings);
    this.state = 'running';
    this.stopRequested = false;
    this.run_ = { ...this.freshRun(), startedAt: now() };
    this.changed();

    this.session = new Session({
      headless: settings.headless,
      blockResources: settings.blockResources,
      delayMs: { min: settings.delayMin * 1000, max: settings.delayMax * 1000 },
      log: (m) => this.log(m),
      shouldStop: () => this.stopRequested,
      onAttention: (a) => { this.run_.attention = a; this.changed(); },
    });
    const awake = keepAwake();
    try {
      await this.session.launch();
      if (!soloDetalle) await this.explore();
      if (!soloListado && settings.scrapeDetails) await this.scrapeDetails();
      this.run_.result = 'terminado';
      this.log(`\nListo. Avisos: ${this.listings.size} · fichas: ${this.details.size} · fallos: ${this.failures.size}`);
    } catch (e) {
      if (e instanceof StopError || this.stopRequested) {
        this.run_.result = 'detenido';
        this.log('Detenido. Lo guardado queda en data/ y la próxima corrida retoma desde acá.');
      } else {
        this.run_.result = 'error';
        this.log(`ABORTADO: ${e.stack || e.message}`);
      }
    } finally {
      awake.stop();
      await this.session.close();
      this.session = null;
      this.state = 'idle';
      Object.assign(this.run_, { phase: null, attention: null, current: null, finishedAt: now() });
      this.changed();
    }
    return this.run_.result;
  }

  // ---------------------------------------------------------------------------------------
  async pause(ms) {
    this.run_.attention = 'pausa';
    this.changed();
    try { await this.session.sleep(ms); } finally { this.run_.attention = null; this.changed(); }
  }

  /**
   * Carga una URL aguantando lo que pueda pasar en una corrida larga. Sólo tira error si la
   * página no cargó ni relanzando el navegador (o StopError si se pidió frenar).
   */
  async load(url, contentSelector) {
    let relaunched = false;
    for (;;) {
      if (this.stopRequested) throw new StopError();
      try {
        if (!this.session.alive) await this.session.launch();
        const html = await this.session.goto(url, { contentSelector });
        this.run_.consecutiveFailures = 0;
        return html;
      } catch (e) {
        if (e instanceof StopError || this.stopRequested) throw new StopError();
        if (e instanceof ChallengeTimeout) {
          const min = Math.round(config.challengeCooldownMs / 60_000);
          this.log(`  Nadie resolvió la verificación de seguridad. Descanso ${min} min y vuelvo a probar.`);
          await this.pause(config.challengeCooldownMs);
          continue;
        }
        if (relaunched) {
          if (++this.run_.consecutiveFailures >= config.maxConsecutiveFailures) {
            const min = Math.round(config.failurePauseMs / 60_000);
            this.log(`  ${this.run_.consecutiveFailures} cargas fallidas seguidas (¿se cayó internet?). Pausa de ${min} min.`);
            this.run_.consecutiveFailures = 0;
            await this.pause(config.failurePauseMs);
          }
          throw e;
        }
        relaunched = true;
        this.log(`  ${firstLine(e)}. Reinicio el navegador y reintento.`);
        await this.session.close();
        await this.session.sleep(10_000);
      }
    }
  }

  debugHtml(name, html, isError) {
    const wanted = config.saveHtml === 'all' || (config.saveHtml === 'errors' && isError);
    if (!wanted || this.run_.debugFiles >= config.maxDebugFiles) return '';
    this.run_.debugFiles++;
    return saveDebugHtml(name, html);
  }

  fail(key, phase, url, error) {
    this.failures.append({ key, phase, url, error, at: now() });
  }

  // ---------------------------------------------------------------------------------------
  // Fase 1
  async explore() {
    const { settings } = this;
    this.run_.phase = 'listado';
    const roots = buildRoots(settings);
    if (!roots.length) { this.log('No hay búsquedas configuradas: elegí al menos una operación o pegá una URL.'); return; }
    this.log(`Fase 1: ${roots.length} búsquedas raíz, hasta ${settings.maxPagesPerSearch} páginas por búsqueda antes de partir por precio. Ya guardados: ${this.listings.size} avisos.`);

    // Pila (DFS): los pedazos de una búsqueda partida se recorren antes de pasar a la siguiente raíz.
    const stack = roots.reverse();
    while (stack.length) {
      if (this.stopRequested) throw new StopError();
      const node = stack.pop();
      this.run_.queue = stack.length;
      const st = this.frontier.nodes[nodeSlug(node)];
      if (st?.s === 'done' || st?.s === 'invalid') continue;
      if (st?.s === 'split') { this.pushChildren(stack, node); continue; }
      await this.crawlSearch(node, stack);
    }
    this.run_.queue = 0;
  }

  pushChildren(stack, node) {
    const children = splitNode(node);
    for (const c of children.reverse()) stack.push({ ...c, parent: node });
  }

  async crawlSearch(node, stack) {
    const { settings } = this;
    const maxPages = settings.maxPagesPerSearch;
    const slug = nodeSlug(node);
    const url = nodeUrl(node);
    const st = this.frontier.nodes[slug] ??= {};
    const ctx = { search_slug: slug, ...parseSlug(node.base) };
    const seen = new Set(); // huella de cada página, para detectar la página de relleno
    let total = st.total ?? null;
    let page = (st.page ?? 0) + 1;
    this.log(`\n▶ ${slug}${page > 1 ? ` (retomo en la página ${page})` : ''}`);

    for (; page <= maxPages; page++) {
      const pUrl = pageUrl(url, page);
      this.run_.current = { slug, page, pages: total ? Math.min(maxPages, totalPages(total)) : null, total };
      this.changed();

      let html;
      try {
        html = await this.load(pUrl, CARD_SELECTOR);
        await this.session.scroll(3);
        html = await this.session.page.content(); // después del scroll hay más imágenes cargadas
      } catch (e) {
        if (e instanceof StopError || this.stopRequested) throw new StopError();
        // Queda a medias a propósito: la próxima corrida retoma esta búsqueda en esta página.
        this.log(`  p${page}: ERROR ${firstLine(e)}. Sigo con la próxima búsqueda.`);
        this.fail(pUrl, 'listing', pUrl, firstLine(e));
        return;
      }
      this.run_.pagesFetched++;

      // ZonaProp no tira 404: un slug que no entiende lo redirige a una búsqueda más amplia, y
      // una página pasada del final a la última que existe.
      const finalUrl = stripUrl(this.session.page.url());
      if (finalUrl !== pUrl) {
        if (page > 1 && searchSlug(finalUrl) === slug) { this.log(`  p${page}: no existe (redirige a la última). Fin.`); break; }
        if (page > 1) { this.log(`  p${page}: redirige a otra búsqueda. Fin.`); break; }
        this.invalidSearch(node, stack, finalUrl);
        return;
      }

      const parsed = parseListing(html, { ...ctx, page, search_url: pUrl });
      if (parsed.total_results != null) total = st.total = parsed.total_results;
      this.run_.current = { slug, page, pages: total ? Math.min(maxPages, totalPages(total)) : null, total };

      const items = settings.includeDevelopments ? parsed.items : parsed.items.filter((i) => i.posting_type !== 'DEVELOPMENT');
      let nuevos = 0;
      let cambios = 0;
      for (const it of items) {
        const saved = this.listings.get(it.id);
        if (!saved) { this.listings.append(it); nuevos++; continue; }
        if (!settings.trackChanges) continue;
        const changed = changedFields(saved.h, it);
        if (changed.length) { this.listings.append({ ...it, changed_fields: changed }); cambios++; }
      }
      this.run_.newListings += nuevos;
      this.run_.changedListings += cambios;

      // Demasiados resultados para paginar: partir por precio. (Lo de esta página ya se guardó.)
      if (page === 1 && total > maxPages * PAGE_SIZE) {
        if (node.splittable && !st.nosplit && splitNode(node)) {
          st.s = 'split';
          this.saveFrontier();
          this.pushChildren(stack, node);
          this.log(`  ${total.toLocaleString('es-AR')} avisos: no entran en ${maxPages} páginas, parto la búsqueda en dos rangos de precio.`);
          await this.session.humanDelay();
          return;
        }
        this.log(`  ${total.toLocaleString('es-AR')} avisos y no se puede partir más: pagino hasta el tope de ${maxPages} páginas (cobertura parcial).`);
      }

      if (parsed.items.length === 0) {
        if (page === 1 && total == null) this.log('  Sin resultados.');
        else this.log(`  p${page}: 0 avisos (fin de resultados o cambió el front). ${this.debugHtml(`sin-avisos-${slug}-p${page}`, html, true)}`);
        break;
      }
      this.debugHtml(`listado-${slug}-p${page}`, html, false);

      const fingerprint = parsed.items.map((i) => i.id).join(',');
      if (seen.has(fingerprint)) { this.log(`  p${page}: repite una página anterior (el sitio dejó de paginar). Fin.`); break; }
      seen.add(fingerprint);

      st.page = page;
      this.saveFrontier();
      const pages = total ? Math.min(maxPages, totalPages(total)) : null;
      this.log(`  p${page}/${pages ?? '?'}: ${items.length} avisos, ${nuevos} nuevos${cambios ? `, ${cambios} con cambios` : ''} (búsqueda: ${total?.toLocaleString('es-AR') ?? '?'}, guardados: ${this.listings.size.toLocaleString('es-AR')})`);
      this.changed();

      if (total != null && page >= totalPages(total)) break;
      await this.session.humanDelay();
    }

    st.s = 'done';
    st.at = now();
    this.saveFrontier();
    await this.session.humanDelay();
  }

  invalidSearch(node, stack, finalUrl) {
    const slug = nodeSlug(node);
    if (node.parent) {
      // El sitio no aceptó el rango de precio sobre esta búsqueda (pasa con URLs pegadas a mano
      // que ya traen otros filtros). Se vuelve a la búsqueda madre, sin partirla.
      const parentSlug = nodeSlug(node.parent);
      this.log(`  El sitio no aceptó el filtro de precio (redirige a ${searchSlug(finalUrl)}). Recorro ${parentSlug} sin partir.`);
      delete this.frontier.nodes[slug];
      this.frontier.nodes[parentSlug] = { ...this.frontier.nodes[parentSlug], s: undefined, nosplit: true };
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].parent === node.parent) stack.splice(i, 1);
      stack.push(node.parent);
    } else {
      this.log(`  Búsqueda inválida: el sitio redirige a "${searchSlug(finalUrl)}". Revisá cómo está escrita la zona. La salteo.`);
      this.frontier.nodes[slug] = { s: 'invalid', at: now() };
      this.fail(nodeUrl(node), 'listing', nodeUrl(node), `slug inválido: redirige a ${finalUrl}`);
    }
    this.saveFrontier();
  }

  // ---------------------------------------------------------------------------------------
  // Fase 2
  detailPending(id, url, skip) {
    return isProperty(url) && !this.details.has(id) && !this.failures.has(`detail:${id}`) && !skip.has(id);
  }

  /** Próximos avisos sin ficha, con su registro completo del listado (se relee de disco). */
  async nextDetailChunk(skip) {
    const chunk = [];
    for await (const l of readJsonl(this.listings.path)) {
      if (!this.detailPending(l.id, l.url, skip)) continue;
      chunk.push(l);
      skip.add(l.id); // una línea repetida no entra dos veces
      if (chunk.length >= DETAIL_CHUNK) break;
    }
    for (const l of chunk) skip.delete(l.id);
    return chunk;
  }

  async scrapeDetails() {
    const limit = this.settings.maxDetailsPerRun ?? Infinity;
    const skip = new Set(); // fichas que fallaron al cargar en esta corrida: se reintentan en la próxima
    let pending = 0;
    for (const [id, saved] of this.listings.entries()) if (saved.p && !this.details.has(id) && !this.failures.has(`detail:${id}`)) pending++;
    this.run_.phase = 'fichas';
    this.run_.detailsPending = pending;
    this.log(`\nFase 2: ${pending.toLocaleString('es-AR')} fichas pendientes${limit < pending ? `, visito ${limit} en esta corrida` : ''} (ya guardadas: ${this.details.size.toLocaleString('es-AR')}).`);

    let visited = 0;
    while (visited < limit) {
      const chunk = await this.nextDetailChunk(skip);
      if (!chunk.length) break;
      for (const l of chunk) {
        if (visited >= limit) break;
        if (this.stopRequested) throw new StopError();
        visited++;
        this.run_.current = { id: l.id };
        this.changed();
        try {
          let html = await this.load(l.url, DETAIL_SELECTOR);
          // La descripción la dibuja React un instante después del resto de la ficha.
          if (looksLikeDetail(html) && !html.includes('id="longDescription"')) {
            await this.session.page.waitForSelector('#longDescription', { timeout: 8000 }).catch(() => {});
            html = await this.session.page.content();
          }
          if (!looksLikeDetail(html)) {
            this.log(`[${visited}] ${l.id}: no parece una ficha (¿aviso dado de baja?). ${this.debugHtml(`ficha-rara-${l.id}`, html, true)}`);
            this.fail(`detail:${l.id}`, 'detail', l.url, 'no parece ficha');
          } else {
            this.debugHtml(`ficha-${l.id}`, html, false);
            const d = parseDetail(html, l);
            this.details.append(d);
            this.run_.newDetails++;
            this.log(`[${visited}] ${l.id}: ${d.tipo_propiedad ?? '?'} ${d.price_currency ?? ''} ${d.price ?? '?'} · ${d.superficie_total ?? '?'} m² · ${d.neighborhood ?? d.location ?? ''}`);
          }
        } catch (e) {
          if (e instanceof StopError || this.stopRequested) throw new StopError();
          this.log(`[${visited}] ${l.id}: ERROR ${firstLine(e)}`);
          this.fail(`error:${l.id}`, 'detail', l.url, firstLine(e));
          skip.add(l.id);
        }
        this.run_.detailsPending = Math.max(0, this.run_.detailsPending - 1);
        await this.session.humanDelay();
      }
    }
  }
}
