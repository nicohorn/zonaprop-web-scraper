// ui/app.html: aplicación única con rutas por #hash.
//   #inicio · #datos · #predecir · #modelos · #experimentos · #docs · #corrida=<id>
// Modelo seleccionado: se suma "&modelo=A" (A, A2, B…F). Mientras hay uno elegido, todas las
// secciones muestran sólo ese modelo (métricas, corridas, experimentos, docs, predicción).
// Usa los mismos endpoints de siempre (/api/ml/*); nada de lo anterior se quitó.
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TZ = 'America/Argentina/Buenos_Aires';

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// --- Formato es-AR ---------------------------------------------------------------------
const nf = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null ? '–' : `${nf(v, d)} %`);
const usd = (v, cur = 'USD') => (v == null ? '–' : `${cur} ${nf(Math.round(v))}`);
function fmt(v, col = '') {
  if (v == null || v === '') return '<span class="muted">–</span>';
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (typeof v !== 'number') {
    const s = String(v);
    if (/^[-\d.\s±%]+$/.test(s)) return esc(s.replace(/(\d)\.(\d)/g, '$1,$2')); // "18.65 ± 0.36"
    return esc(s);
  }
  if (/%/.test(col)) return nf(v, 1);
  const a = Math.abs(v);
  if (Number.isInteger(v) || a >= 1000) return nf(v, 0);
  return nf(v, a < 1 ? 3 : 2);
}
const fdate = (iso) => { if (!iso) return '–'; const d = new Date(iso); return isNaN(d) ? esc(iso) : d.toLocaleString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const fsec = (s) => (s == null ? '–' : s < 90 ? `${nf(s, 0)} s` : `${nf(s / 60, 1)} min`);

// Etiquetas en lenguaje simple para columnas y campos (el nombre técnico queda en el tooltip).
const LABELS = {
  'MAPE_mediana_%': 'Error mediano (%)', 'dentro_10%_%': 'A ±10 % del real (%)', R2_log: 'R² (log)', R2: 'R²', MAE: 'Error medio (USD)',
  'sesgo_mediano_%': 'Sesgo mediano (%)', n: 'Avisos', price_x: 'Precio', sup: 'Superficie (m²)', ppm2: 'USD/m²', ppm2_mediana_barrio: 'Mediana USD/m² del barrio',
  'ppm2_vs_barrio_%': 'vs. barrio (%)', pred: 'Precio esperado', 'residuo_%': 'Diferencia con lo esperado (%)', score_oportunidad: 'Puntaje oportunidad', score_anomalia: 'Puntaje anomalía',
  anomalia: 'Anomalía', motivo_error: 'Motivo', tipo_prop: 'Tipo', ambientes: 'Ambientes', url: 'Aviso', barrio: 'Barrio', variante: 'Variante', modelo: 'Modelo', segmento: 'Segmento',
  venta_usd_m2: 'Venta USD/m²', n_venta: 'Avisos venta', alquiler_usd_m2_mes: 'Alquiler USD/m² por mes', n_alquiler: 'Avisos alquiler', 'rentabilidad_bruta_%': 'Rentabilidad bruta anual (%)',
  'años_para_recuperar': 'Años para recuperar', 'MAPE_mediana_%_media': 'Error mediano CV (%)', 'dentro_10%_%_media': 'A ±10 % CV (%)', R2_log_media: 'R² log CV', MAE_media: 'Error medio CV (USD)',
  'MAPE_mediana_%_std': 'Desvío del error CV', paso: 'Paso', filas: 'Quedan', quitadas: 'Se quitan', variable: 'Variable', importancia_gain: 'Importancia',
  suben_precio: 'Suben el precio', coef_sube: 'Efecto', bajan_precio: 'Bajan el precio', coef_baja: 'Efecto', usd_m2: 'USD/m²', superficie: 'Superficie', banos: 'Baños', expensas_m2: 'Expensas/m²', barrios_top: 'Barrios principales',
  n_train: 'Avisos de entrenamiento', n_test: 'Avisos de test', split: 'Separación train/test', as_of: 'Fecha de corte', fx_mep: 'Dólar MEP', anomalias: 'Anomalías', umbral_barrio: 'Umbral de error de datos',
  posibles_errores_de_datos: 'Posibles errores de datos', anomalias_error_datos: 'Anomalías que son errores de datos', anomalias_oportunidad: 'Posibles oportunidades', segmentos: 'Segmentos', ruido: 'Ruido',
  vocabulario: 'Vocabulario', fuente_texto: 'Texto usado', estado: 'Estado', bajas_observadas: 'Bajas observadas', avisos: 'Avisos', dias_de_historial: 'Días de historial', nota: 'Nota',
  mejor_variante_cv: 'Mejor variante (CV)', fecha: 'Fecha', corrida: 'Corrida', duplicados: 'Regla de duplicados', 'cobertura 80 %': 'Cobertura rango 80 (%)',
  'cobertura_intervalos_test_%': 'Cobertura de los rangos en test (%)', hiperparametros: 'Hiperparámetros elegidos', protocolo_anterior: 'Protocolo anterior (split aleatorio con duplicados)',
  mezcla: 'Mezcla con CatBoost', errores_por_motivo: 'Errores de datos por motivo', fx_mep_info: 'Fuente del dólar MEP', modelo_guardado: 'Modelo guardado', grupos_en_train_y_test: 'Propiedades en train y test', peso_catboost: 'Peso CatBoost', 'MAPE_OOF_%': 'Error mediano OOF (%)',
};
const lab = (k) => LABELS[k] || String(k).replace(/_/g, ' ');

// Glosario de métricas: el texto de cada "?" (en lenguaje simple).
const EM = 'Error mediano: la diferencia típica entre el precio predicho y el publicado, en %. La mitad de las predicciones se equivoca por menos que este valor y la otra mitad por más. Se usa la mediana (y no el promedio) para que unos pocos avisos atípicos no distorsionen el número.';
const GLOSS = {
  'MAPE_mediana_%': EM,
  'dentro_10%_%': 'Porcentaje de avisos en los que la predicción quedó a menos de 10 % del precio publicado (para arriba o para abajo). Más alto es mejor.',
  R2_log: 'R² sobre el logaritmo del precio: qué parte de las diferencias de precio entre avisos explica el modelo, contando igual a un depto. barato que a uno caro. 1 = perfecto; 0 = no mejor que dar siempre el mismo precio.',
  R2: 'R² en dólares: qué parte de las diferencias de precio entre avisos explica el modelo (1 = perfecto; 0 = no mejor que dar siempre el mismo precio). Lo dominan los departamentos caros, por eso se mira también el R² (log).',
  MAE: 'Error absoluto medio: cuántos dólares se equivoca el modelo en promedio, sin importar si de más o de menos. Los departamentos caros lo inflan mucho, por eso se mira junto con el error mediano.',
  'sesgo_mediano_%': 'Sesgo mediano: si el modelo tiende a pasarse (positivo) o a quedarse corto (negativo) en ese grupo, en % del precio. Cerca de 0 es lo ideal.',
  'cobertura 80 %': 'Cobertura del rango 80 %: porcentaje de avisos de test cuyo precio real cayó dentro del rango probable del 80 %. Bien calibrado da cerca de 80 %; menos significa rangos demasiado angostos y más, demasiado anchos.',
  'cobertura_intervalos_test_%': 'Porcentaje de precios reales del test que cayeron dentro de los rangos del 80 % y del 50 %. Si los rangos están bien calibrados, dan cerca de 80 % y 50 %.',
  'rentabilidad_bruta_%': 'Rendimiento bruto anual: 12 meses de alquiler divididos por el precio de compra (ambos en USD por m²). No descuenta expensas, impuestos, comisiones ni meses sin inquilino.',
  'años_para_recuperar': 'Años de alquiler bruto necesarios para pagar el precio de compra (100 ÷ rendimiento bruto). Es un techo optimista: no descuenta gastos ni vacancia.',
  venta_usd_m2: 'Mediana del precio de venta por m² (USD) de los departamentos del barrio.',
  alquiler_usd_m2_mes: 'Mediana del alquiler mensual por m², pasado a USD con el dólar MEP.',
  'MAPE_mediana_%_media': 'Error mediano promedio de los 5 folds de validación cruzada sobre train (el test no se usa). La mitad de las predicciones se equivoca por menos que este valor.',
  'MAPE_mediana_%_std': 'Cuánto varía el error mediano entre los folds de la validación cruzada. Diferencias entre variantes más chicas que esto pueden ser puro azar.',
  'dentro_10%_%_media': 'Porcentaje de predicciones a menos de 10 % del precio publicado, promedio de los folds de validación cruzada.',
  R2_log_media: 'R² (log) promedio de los folds de validación cruzada.', MAE_media: 'Error absoluto medio en USD, promedio de los folds de validación cruzada.',
  'MAPE_OOF_%': 'Error mediano de las predicciones fuera de muestra (cada aviso predicho por un modelo que no lo vio al entrenar).',
  'residuo_%': 'Cuánto más barato (negativo) o más caro (positivo) está el aviso respecto del precio que el modelo esperaba para él.',
  'ppm2_vs_barrio_%': 'USD/m² del aviso comparado con la mediana de su barrio: −40 % significa 40 % más barato por m² que el aviso típico del barrio.',
  score_oportunidad: 'Puntaje que combina cuánto más barato está que lo esperado y que la mediana del barrio. Más alto = oportunidad más clara (revisar igual el aviso).',
  score_anomalia: 'Qué tan raro es el aviso para el IsolationForest (combinación poco común de precio, m² y ambientes). Más alto = más raro.',
  umbral_barrio: 'Avisos con USD/m² por debajo de esta fracción de la mediana del barrio se tratan como posibles errores de datos, no como oportunidades.',
  fx_mep: 'Dólar MEP (bolsa) en pesos por dólar, usado para pasar alquileres en ARS a USD. Se toma de dolarapi.com el día de la corrida; si falla, 1.450.',
  n_train: 'Avisos usados para entrenar el modelo.', n_test: 'Avisos que el modelo nunca vio, usados una sola vez para medir el error.',
  split: 'Cómo se separaron train y test. "agrupado" = la misma propiedad (o su duplicado) nunca está en los dos; es la evaluación honesta.',
  grupos_en_train_y_test: 'Propiedades que aparecen a la vez en train y en test. Debe ser 0 para que el error no salga optimista.',
};
const MODEL_GLOSS = [
  [/^Mediana global/, 'Referencia mínima: predice siempre la mediana de precio de todos los avisos.'],
  [/^Mediana USD\/m² del barrio/, 'Referencia simple: mediana del USD/m² del barrio multiplicada por la superficie. Es lo que haría una tasación rápida.'],
  [/^Ridge/, 'Regresión lineal con regularización: un modelo simple para comparar.'],
  [/^LightGBM v1/, 'La primera versión del modelo (iteración 1), entrenada en este mismo test para comparar de forma justa.'],
  [/^LightGBM sin dirección/, 'Modelo de respaldo sin calle ni dirección: se usa en el formulario cuando no se carga dirección.'],
  [/protocolo anterior/, 'El mismo modelo evaluado como al principio (split aleatorio, con duplicados). Sale optimista porque el test comparte propiedades con train.'],
  [/^LightGBM \(test\)/, 'El modelo que se usa para predecir (gradient boosting), medido en el test.'],
];
const tip = (text) => (text ? `<span class="tip" role="button" tabindex="0" aria-label="Más información" aria-expanded="false" data-tip="${esc(text)}">?</span>` : '');

// Variantes del modelo A, en palabras.
const VARIANTS = {
  v1: 'Iteración 1. Variables básicas (barrio, m², ambientes, baños, cocheras…); predice log(precio). 13,7 % en su test.',
  v2_texto: 'v1 + variables sacadas del texto (piso, antigüedad, "a reciclar", vista…).',
  v2_texto_calle: 'v2_texto + la calle del aviso.',
  v2_ppm2: 'Texto + calle, pero predice log(USD/m²) y lo multiplica por la superficie.',
  v2_pesos: 'Texto + calle con pesos balanceados por rango de precio (más peso a extremos).',
  v2_huber: 'Texto + calle con pérdida Huber (menos sensible a avisos atípicos).',
  v2_l1: 'Texto + calle con pérdida L1 (apunta a la mediana).',
  v2_segmentos: 'Texto + calle con modelos separados por segmento de precio.',
  v3_ppm2_huber: 'Iteración 2: USD/m² + Huber. 10,8 % en test.',
  v3_ppm2_pesos: 'USD/m² + pesos balanceados.',
  v3_ppm2_huber_pesos: 'USD/m² + Huber + pesos balanceados.',
  v4_calle_norm: 'v3_ppm2_huber con nombres de calle normalizados (Av., abreviaturas, tildes).',
  v4_texto3: 'v4_calle_norm + el set ampliado de palabras clave del texto.',
  v4_te: 'v4_calle_norm + promedios de ubicación calculados fuera de muestra (sin mirar el precio del propio aviso).',
  v4_tfidf: 'v4_calle_norm + TF-IDF del texto resumido.',
  v4_iso: 'v3_ppm2_huber + calibración isotónica para corregir el sesgo en los extremos.',
  v4_todo: 'Todo lo de la iteración 3 junto, con calibración isotónica.',
  v4_todo_sin_iso: 'Iteración 3 (por defecto): calle normalizada + texto ampliado + promedios de ubicación + TF-IDF. 9,9 % en test.',
  v5_catboost: 'Iteración 4: CatBoost con las mismas variables que v4_todo_sin_iso.',
  v5_pesos: 'Iteración 4: v4_todo_sin_iso con pesos balanceados por rango de precio.',
  v5_sin_direccion: 'Iteración 4: sin calle ni dirección. Es el respaldo del formulario cuando no se carga dirección (10,9 %).',
};

// --- Estado ------------------------------------------------------------------------------
const ORDER = ['price', 'anomaly', 'yields', 'segments', 'text', 'survival', 'price_ablation'];
const LETTER = { price: 'A', price_ablation: 'A2', anomaly: 'B', yields: 'C', segments: 'D', text: 'E', survival: 'F' };
const TASK_OF = Object.fromEntries(Object.entries(LETTER).map(([t, l]) => [l, t]));
let ml = null, cmp = null, pmodels = null, scraper = null;
const runCache = new Map();
const saved = JSON.parse(localStorage.getItem('mlParams') || '{}');
let route = { view: 'inicio', p: {} };

const tasks = () => (ml ? ORDER.filter((t) => ml.tasks[t]).concat(Object.keys(ml.tasks).filter((t) => !ORDER.includes(t))) : []);
const letterOf = (t) => LETTER[t] || t;
const nameOf = (t) => { const l = ml?.tasks[t]?.label || t; return l.includes(' · ') ? l.split(' · ').slice(1).join(' · ') : l; };
const ctxTask = () => (route.p.modelo ? TASK_OF[route.p.modelo] || (ml?.tasks[route.p.modelo] ? route.p.modelo : null) : null);
const getRun = async (id) => { if (!runCache.has(id)) runCache.set(id, api(`/api/ml/run?id=${encodeURIComponent(id)}`)); try { return await runCache.get(id); } catch (e) { runCache.delete(id); throw e; } };
const runsOf = (task) => (cmp?.runs || []).filter((r) => r.task === task).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
function latestOk(task) {
  const ok = runsOf(task).filter((r) => r.status === 'ok');
  if (task === 'price' && pmodels?.latest) return ok.find((r) => r.id === pmodels.latest) || ok[0] || null;
  return ok[0] || null;
}
const mainLgbm = (metricas) => metricas?.['LightGBM (test)'] || Object.entries(metricas || {}).find(([k]) => /^LightGBM/.test(k))?.[1] || null;

// --- Rutas -------------------------------------------------------------------------------
function parseHash() {
  const parts = decodeURIComponent(location.hash.slice(1)).split('&').filter(Boolean);
  const p = {}; let view = null;
  for (const x of parts) { const i = x.indexOf('='); if (i < 0) view = view || x; else p[x.slice(0, i)] = x.slice(i + 1); }
  if (p.corrida) view = 'corrida';
  if (!view) view = p.modelo ? 'modelos' : (location.pathname === '/modelos' ? 'modelos' : 'inicio');
  return { view, p };
}
function href(view, p = {}) {
  const q = { ...p }; const m = q.modelo === undefined ? route.p.modelo : q.modelo; delete q.modelo;
  const parts = [view];
  for (const [k, v] of Object.entries(q)) if (v != null && v !== '') parts.push(`${k}=${encodeURIComponent(v)}`);
  if (m) parts.push(`modelo=${encodeURIComponent(m)}`);
  return '#' + parts.join('&');
}
const go = (view, p) => { location.hash = href(view, p).slice(1); };

async function render() {
  route = parseHash();
  const task = ctxTask();
  if (route.p.modelo && !task && ml) { go(route.view, { ...route.p, modelo: '' }); return; }
  const view = route.view === 'corrida' ? 'corrida' : (route.view === 'modelos' && task ? 'modelo' : route.view);
  const el = $(`#view-${view}`) || $('#view-inicio');
  for (const v of $$('.view')) v.hidden = v !== el;
  const navKey = el.dataset.parent || el.dataset.view;
  for (const a of $$('#nav a')) { a.classList.toggle('active', a.dataset.nav === navKey); a.href = href(a.dataset.nav, {}); }
  document.body.classList.toggle('has-model', Boolean(task));
  renderCtx(task);
  const fn = { inicio: viewInicio, datos: viewDatos, predecir: viewPredecir, modelos: viewModelos, modelo: viewModelo, corrida: viewCorrida, experimentos: viewExperimentos, docs: viewDocs }[view];
  try { await fn?.(task); } catch (e) { el.insertAdjacentHTML('beforeend', `<div class="errbox">No se pudo cargar esta sección: ${esc(e.message)}</div>`); }
  renderTop();
}

function renderCtx(task) {
  const sel = $('#model-select');
  if (ml && sel.options.length <= 1) sel.insertAdjacentHTML('beforeend', tasks().map((t) => `<option value="${letterOf(t)}">${esc(letterOf(t))} · ${esc(nameOf(t))}</option>`).join(''));
  sel.value = task ? letterOf(task) : '';
  const bar = $('#ctxbar');
  bar.hidden = !task;
  if (!task) { bar.innerHTML = ''; return; }
  const t = ml.tasks[task];
  bar.innerHTML = `<div class="in"><span class="letter">${esc(letterOf(task))}</span>
    <div class="t"><b>${esc(nameOf(task))}</b><span>${esc(t.question || '')}</span></div>
    <span class="scope">Toda la interfaz muestra sólo este modelo</span>
    <a class="btn small" href="${href('modelos', { modelo: letterOf(task) })}">Ficha del modelo</a>
    <a class="btn small" href="${href(route.view === 'corrida' ? 'experimentos' : route.view === 'modelo' ? 'modelos' : route.view, { ...route.p, corrida: '', modelo: '' })}" id="ctx-clear">✕ Ver todos los modelos</a></div>`;
}
$('#model-select').onchange = (e) => {
  const v = e.target.value;
  const view = route.view === 'corrida' ? 'modelos' : route.view;
  go(view, { ...route.p, corrida: '', t: '', modelo: v });
};

// --- Barra superior: entrenamiento / scraper -----------------------------------------------
function renderTop() {
  const task = ctxTask(); const out = [];
  if (ml?.running && ml.job && (!task || ml.job.task === task)) out.push(`<a class="pill running" href="${href('modelos', { modelo: letterOf(ml.job.task) })}"><span class="dot"></span>Entrenando ${esc(letterOf(ml.job.task))} · ${ml.job.pct} %</a>`);
  if (scraper && scraper.state !== 'idle') out.push(`<a class="pill ${scraper.attention ? 'warn' : 'running'}" href="${href('datos')}"><span class="dot"></span>Scraper: ${esc(scraper.label)}</a>`);
  if (ml && !ml.python.ok) out.push('<span class="pill err" title="Instalá ml/requirements.txt (ver README)">Python no disponible</span>');
  $('#top-status').innerHTML = out.join('');
  if (ml) $('#py').innerHTML = ml.python.ok ? `Python ${esc(ml.python.version)} · ${esc(ml.python.modules.join(', '))}` : '<span class="err">Python no disponible: instalá ml/requirements.txt (ver README)</span>';
}
window.addEventListener('scraper-status', (e) => {
  const first = !scraper; scraper = e.detail; renderTop();
  if (route.view === 'inicio' && ml && !ctxTask()) { if (first) viewInicio(null); else homeData(null); }
});

// --- Tablas --------------------------------------------------------------------------------
function tableHtml(t, { hl, click, cap, cellTip } = {}) {
  const numCol = t.columns.map((c, i) => t.rows.some((r) => typeof r[i] === 'number'));
  const rows = cap ? t.rows.slice(0, cap) : t.rows;
  return `<div class="tablewrap"><table><thead><tr>${t.columns.map((c, i) => `<th class="${numCol[i] ? 'n' : ''}" ${GLOSS[c] ? '' : `title="${esc(c)}"`}>${esc(lab(c))}${tip(GLOSS[c])}</th>`).join('')}</tr></thead><tbody>${rows.map((r, ri) => `<tr class="${hl?.(r) ? 'hl' : ''} ${click ? 'click' : ''}" ${click ? `data-i="${ri}"` : ''}>${r.map((v, i) => {
    if (typeof v === 'string' && /^https?:/.test(v)) return `<td><a href="${esc(v)}" target="_blank" rel="noopener">abrir ↗</a></td>`;
    return `<td class="${typeof v === 'number' ? 'n' : typeof v === 'string' && v.length < 30 ? 'nw' : ''}">${fmt(v, t.columns[i])}${typeof v === 'string' && cellTip ? tip(cellTip(v, i)) : ''}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div>${cap && t.rows.length > cap ? `<p class="hint">Mostrando ${cap} de ${nf(t.rows.length)} filas (el CSV completo está en "Archivos").</p>` : ''}`;
}
const loading = (msg = 'Cargando…') => `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;
const kpi = (v, l, t = '', cls = '') => `<div class="kpi ${cls}"><b>${v}</b><span>${esc(l)}${t ? ' ' + tip(t) : ''}</span></div>`;
const modelTip = (name, i) => (i === 0 ? MODEL_GLOSS.find(([re]) => re.test(name))?.[1] || '' : '');

// --- Números clave por modelo ------------------------------------------------------------
function keyNumbers(task, r) {
  if (!r) return [];
  if (r.status && r.status !== 'ok') return [{ v: 'Error', l: 'la última corrida falló' }];
  const m = r.metricas || {};
  switch (task) {
    case 'price': { const g = mainLgbm(m) || {}; const cob = r['cobertura_intervalos_test_%'] || r.cobertura;
      return [{ v: pct(g['MAPE_mediana_%']), l: 'error mediano en test', t: EM + ' Medido en avisos que el modelo nunca vio (test agrupado).' },
        { v: pct(g['dentro_10%_%'], 0), l: 'predicciones a ±10 % del precio real', t: GLOSS['dentro_10%_%'] },
        { v: cob ? pct(cob['80%'], 0) : nf((r.n_train || 0) + (r.n_test || 0)), l: cob ? 'precios reales dentro del rango 80 %' : 'avisos usados', t: cob ? GLOSS['cobertura 80 %'] : '' }]; }
    case 'price_ablation': { const t = Object.entries(r.tablas || {}).find(([k]) => k.startsWith('Ablación'))?.[1]; const best = t?.rows.find((x) => x[0] === r.mejor_variante_cv) || t?.rows[0];
      return [{ v: esc(r.mejor_variante_cv || '–'), l: 'mejor variante por CV', t: 'La variante con menor error mediano en la validación cruzada de 5 folds sobre train (sin tocar el test).' }, { v: best ? pct(best[1]) : '–', l: 'su error mediano en CV', t: GLOSS['MAPE_mediana_%_media'] }, { v: nf(t?.rows.length), l: 'variantes comparadas' }]; }
    case 'anomaly': return [{ v: nf(r.anomalias_oportunidad), l: 'posibles oportunidades', t: 'Avisos con datos limpios que están bastante más baratos que lo que el modelo esperaba para su barrio, m² y características. Conviene revisarlos uno por uno.' }, { v: nf(r.posibles_errores_de_datos), l: 'posibles errores de datos', t: `USD/m² por debajo de ${nf(r.umbral_barrio, 2)} × la mediana del barrio, m² implausibles o pesos cargados como dólares: casi seguro no son gangas sino errores del aviso.` }, { v: nf(r.n), l: 'avisos analizados' }];
    case 'yields': { const t = r.tablas?.['Rentabilidad por barrio']; const top = t?.rows[0]; const ci = t?.columns.indexOf('rentabilidad_bruta_%');
      return [{ v: pct(m.CABA?.['mediana_%']), l: `rentabilidad bruta mediana (${nf(m.CABA?.barrios)} barrios)`, t: GLOSS['rentabilidad_bruta_%'] + ' Es la mediana entre los barrios con suficientes avisos.' }, { v: top ? esc(top[0]) : '–', l: top ? `mejor barrio · ${pct(top[ci])}` : 'mejor barrio', t: 'El barrio con mayor rendimiento bruto. Si tiene pocos avisos de alquiler, tomalo con cautela.' }, { v: `$ ${nf(r.fx_mep, 1)}`, l: 'dólar MEP usado', t: GLOSS.fx_mep + (r.fx_mep_info?.fuente ? ` Fuente: ${r.fx_mep_info.fuente}.` : '') }]; }
    case 'segments': return [{ v: nf(r.segmentos), l: 'segmentos encontrados', t: 'Grupos de avisos parecidos entre sí (precio por m², superficie, ambientes, expensas…), armados por el algoritmo sin una pregunta previa.' }, { v: nf(r.n), l: 'avisos agrupados' }, { v: esc(r.params?.method || '–'), l: 'método' }];
    case 'text': { const a = m['LightGBM sin texto (test)'], b = m['LightGBM + texto (test)']; const top = r.tablas?.['Términos que mueven el USD/m²']?.rows[0];
      return [{ v: top ? `«${esc(top[0])}»` : '–', l: 'término que más sube el precio' }, { v: top ? `«${esc(top[2])}»` : '–', l: 'término que más lo baja' }, { v: a && b ? `${nf(a['MAPE_mediana_%'] - b['MAPE_mediana_%'], 2)} pp` : '–', l: 'mejora del error al sumar texto', t: 'Cuántos puntos porcentuales baja el error mediano cuando el modelo además lee el título y la descripción del aviso.' }]; }
    case 'survival': return r.estado === 'faltan_datos'
      ? [{ v: 'Faltan datos', l: 'necesita re-scrapes con historial', t: 'Para medir cuánto tarda un aviso en darse de baja hay que volver a recorrer las búsquedas varias semanas con "Guardar historial de cambios" activado.' }, { v: nf(r.bajas_observadas), l: 'bajas observadas' }, { v: nf(r.dias_de_historial), l: 'días de historial' }]
      : [{ v: nf(r.bajas_observadas), l: 'bajas observadas' }, { v: nf(r.avisos), l: 'avisos' }, { v: nf(r.dias_de_historial), l: 'días de historial' }];
    default: return Object.entries(r).filter(([, v]) => typeof v === 'number').slice(0, 3).map(([k, v]) => ({ v: nf(v, 2), l: lab(k) }));
  }
}
function mainMetric(r) {
  if (r.status !== 'ok') return r.error ? `<span class="err">${esc(String(r.error).slice(0, 90))}</span>` : esc(r.status);
  if (r.task === 'price') { const g = mainLgbm(r.metricas); return g ? `error mediano <b>${pct(g['MAPE_mediana_%'])}</b> · ${esc(r.variante)} · ${esc(r.split)}` : ''; }
  if (r.task === 'price_ablation') return `mejor: <b>${esc(r.resumen?.mejor_variante_cv || '–')}</b>`;
  if (r.task === 'anomaly') return `<b>${nf(r.resumen?.anomalias_oportunidad ?? r.resumen?.anomalias)}</b> oportunidades · ${nf(r.resumen?.posibles_errores_de_datos)} errores de datos`;
  if (r.task === 'yields') return `mediana <b>${pct(r.metricas?.CABA?.['mediana_%'])}</b> · MEP ${nf(r.resumen?.fx_mep, 1)}`;
  if (r.task === 'segments') return `<b>${nf(r.resumen?.segmentos)}</b> segmentos · ${nf(r.resumen?.n)} avisos`;
  if (r.task === 'text') { const b = r.metricas?.['LightGBM + texto (test)']; return b ? `error con texto <b>${pct(b['MAPE_mediana_%'])}</b>` : ''; }
  if (r.task === 'survival') return esc(r.resumen?.estado === 'faltan_datos' ? 'faltan datos' : `${nf(r.resumen?.bajas_observadas)} bajas`);
  return Object.entries(r.resumen || {}).slice(0, 3).map(([k, v]) => `${esc(lab(k))}: ${fmt(v)}`).join(' · ');
}

// --- Resultado de una corrida --------------------------------------------------------------
async function renderRun(id, el, { compact = false } = {}) {
  el.innerHTML = loading('Cargando la corrida…');
  let run; try { run = await getRun(id); } catch (e) { el.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; return; }
  const r = run.result || {}; const task = r.task || id.split('-').slice(2).join('-');
  let h = `<div class="card-head"><h3>${compact ? 'Último resultado' : 'Resultado'} <span class="muted small">· ${esc(id)}</span></h3>${!run.result ? '<span class="pill warn">Sin resultado (cancelada o en curso)</span>' : r.status === 'ok' ? `<span class="pill ok">OK · ${fdate(r.started_at)} · ${fsec(r.seconds)}</span>` : '<span class="pill err">Con error</span>'}</div>`;
  if (r.status && r.status !== 'ok') h += `<div class="errbox">${esc(r.error)}</div>`;
  const kn = keyNumbers(task, r);
  if (kn.length) h += `<div class="kpi-row">${kn.map((k) => kpi(k.v, k.l, k.t)).join('')}</div>`;
  if (r.nota) h += `<p class="note info">${esc(r.nota)}</p>`;
  const skip = new Set(['task', 'params', 'started_at', 'status', 'error', 'traceback', 'seconds', 'artifacts', 'metricas', 'tablas', 'nota']);
  const flat = Object.entries(r).filter(([k, v]) => !skip.has(k) && (typeof v !== 'object' || v === null || Array.isArray(v)));
  const objs = Object.entries(r).filter(([k, v]) => !skip.has(k) && v && typeof v === 'object' && !Array.isArray(v));
  if (flat.length) h += `<dl class="dl">${flat.map(([k, v]) => `<dt ${GLOSS[k] ? '' : `title="${esc(k)}"`}>${esc(lab(k))}${GLOSS[k] ? ' ' + tip(GLOSS[k]) : ''}</dt>` + `<dd>${Array.isArray(v) ? esc(v.join(', ')) : fmt(v, k)}</dd>`).join('')}</dl>`;
  if (r.metricas) {
    const models = Object.keys(r.metricas), cols = [...new Set(models.flatMap((m) => Object.keys(r.metricas[m])))];
    h += `<h3 style="margin-top:20px">Métricas</h3>` + tableHtml({ columns: ['modelo', ...cols], rows: models.map((m) => [m, ...cols.map((c) => r.metricas[m][c] ?? null)]) }, { hl: (row) => row[0] === 'LightGBM (test)', cellTip: modelTip });
    if (task.startsWith('price')) h += '<p class="hint">Error mediano = mitad de los avisos con error menor. "A ±10 %" = porcentaje de predicciones a menos de 10 % del precio real. Resaltado: el modelo que se usa para predecir.</p>';
  }
  const imgs = (r.artifacts || []).filter((a) => a.endsWith('.png'));
  const fileUrl = (a) => `/api/ml/file?id=${encodeURIComponent(id)}&name=${encodeURIComponent(a)}`;
  if (imgs.length) h += `<details class="block" open><summary>Gráficos <span class="count">${imgs.length}</span></summary><div class="gallery">${imgs.map((a) => `<figure><a href="${fileUrl(a)}" target="_blank" rel="noopener"><img loading="lazy" src="${fileUrl(a)}" alt="${esc(a)}"></a><figcaption>${esc(a)}</figcaption></figure>`).join('')}</div></details>`;
  const tabs = Object.entries(r.tablas || {}).filter(([, t]) => t);
  tabs.forEach(([name, t], i) => { h += `<details class="block" ${i === 0 && !compact ? 'open' : ''}><summary>${esc(name)} <span class="count">${nf(t.rows.length)} filas</span></summary>${tableHtml(t, { cap: 200 })}</details>`; });
  for (const [k, v] of objs) h += `<details class="block"><summary>${esc(lab(k))}</summary><pre class="log">${esc(JSON.stringify(v, null, 1))}</pre></details>`;
  const files = (r.artifacts || []).filter((a) => !a.endsWith('.png'));
  if (files.length) h += `<details class="block"><summary>Archivos <span class="count">${files.length}</span></summary><div class="files">${files.map((a) => `<a class="btn small" href="${fileUrl(a)}">${esc(a)}</a>`).join('')}</div></details>`;
  h += `<details class="block"><summary>Parámetros usados</summary><pre class="log">${esc(JSON.stringify(run.params, null, 1))}</pre></details>`;
  if (r.traceback) h += `<details class="block"><summary>Detalle técnico del error</summary><pre class="log">${esc(r.traceback)}</pre></details>`;
  el.innerHTML = h;
}

// --- 1 · Inicio ---------------------------------------------------------------------------
async function viewInicio(task) {
  for (const a of $$('.flow a')) a.href = href(a.getAttribute('href').replace(/^#([a-z]+).*/, '$1'));
  const A = !task || task === 'price';
  const t = task && ml.tasks[task];
  $('#home-eyebrow').textContent = task ? `Modelo ${letterOf(task)} seleccionado` : 'Proyecto de ciencia de datos · Ciudad de Buenos Aires';
  $('#home-title').textContent = task ? t.question || nameOf(task) : '¿Cuánto vale un departamento en CABA?';
  $('#home-lead').textContent = task ? `${nameOf(task)}. ${t.use || ''}` : 'Juntamos los avisos publicados en ZonaProp, los limpiamos y entrenamos modelos que estiman el precio de venta de un departamento, detectan avisos raros y comparan barrios.';
  $('#home-actions').innerHTML = task
    ? `${task === 'price' ? `<a class="btn primary big" href="${href('predecir')}">Estimar un precio</a>` : ''}<a class="btn ${task === 'price' ? '' : 'primary'} big" href="${href('modelos')}">Ver el resultado completo</a><a class="btn big" href="${href('experimentos')}">Sus corridas</a>`
    : `<a class="btn primary big" href="#predecir">Estimar un precio</a><a class="btn big" href="#modelos">Ver resultados</a>`;
  const lr = task ? latestOk(task) : latestOk('price');
  const res = lr ? (await getRun(lr.id)).result : null;
  if (task) {
    const kn = keyNumbers(task, res);
    $('#home-kpis').innerHTML = kn.length ? kn.map((k, i) => kpi(k.v, k.l, k.t, i === 0 ? 'accent' : '')).join('') + kpi(nf(runsOf(task).length), 'corridas guardadas') : '<div class="empty"><p class="muted">Este modelo todavía no tiene corridas.</p></div>';
  } else {
    const g = mainLgbm(res?.metricas) || {};
    const y = latestOk('yields'); const yr = y ? (await getRun(y.id)).result : null;
    $('#home-kpis').innerHTML = kpi(nf(scraper?.listings), 'avisos scrapeados en CABA') + kpi(nf((res?.n_train || 0) + (res?.n_test || 0)), 'deptos. en venta usados por el modelo', 'Departamentos en venta en USD que quedan después de limpiar duplicados, pozo / en construcción, errores de carga y valores imposibles. Ver el embudo en Datos.')
      + kpi(pct(g['MAPE_mediana_%']), 'error mediano del modelo de precio', EM + ' Medido en avisos que el modelo nunca vio (test agrupado).', 'accent') + kpi(yr ? `$ ${nf(yr.fx_mep, 1)}` : '–', 'dólar MEP del último modelo C', GLOSS.fx_mep);
  }
  // Evolución
  $('#home-evol-title').textContent = A ? 'Evolución del error del modelo de precio (A)' : `Corridas de ${letterOf(task)} · ${nameOf(task)}`;
  $('#home-evol-hint').textContent = A ? 'Error mediano en el test de cada corrida con test agrupado: cuánto se equivoca el modelo con un departamento típico. Más bajo es mejor.' : 'Cada corrida guardada de este modelo, la más nueva primero.';
  if (A) {
    const pr = runsOf('price').filter((r) => r.status === 'ok' && r.split === 'agrupado' && mainLgbm(r.metricas)).reverse();
    const max = Math.max(...pr.map((r) => mainLgbm(r.metricas)['MAPE_mediana_%']), 1);
    $('#home-evol').innerHTML = pr.length ? `<div class="bars">${pr.map((r) => { const v = mainLgbm(r.metricas)['MAPE_mediana_%']; return `<a class="barrow" href="${href('', { corrida: r.id })}" style="color:inherit;text-decoration:none"><span class="lbl">${esc(iterName(r))} ${tip(iterTip(r))}</span><span class="track"><span class="fill" style="display:block;width:${(v / max) * 100}%"></span></span><span class="val">${pct(v)}</span></a>`; }).join('')}</div><p class="hint">Las primeras corridas usaban otra regla de duplicados (otro test); la comparación justa está en <a href="${href('docs', { t: 'historial' })}">Historial</a>.</p>` : '<p class="muted">Todavía no hay corridas del modelo A.</p>';
  } else {
    const rs = runsOf(task);
    $('#home-evol').innerHTML = rs.length ? `<div class="tablewrap"><table><tbody>${rs.map((r) => `<tr class="click" data-id="${esc(r.id)}"><td>${fdate(r.started_at)}</td><td>${mainMetric(r)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sin corridas.</p>';
    $$('#home-evol tr[data-id]').forEach((tr) => tr.onclick = () => go('', { corrida: tr.dataset.id }));
  }
  homeData(task, res);
}
function homeData(task = ctxTask(), res) {
  const box = $('#home-data'); if (!box) return;
  if (task && task !== 'price') {
    $('#home-data-title').textContent = 'Datos que usa este modelo';
    if (!res) { box.innerHTML = '<p class="muted">Sin corridas todavía.</p>'; return; }
    const keys = ['n', 'n_train', 'n_test', 'avisos', 'as_of', 'fx_mep', 'split', 'fuente_texto'].filter((k) => res[k] != null);
    const p = res.params || {};
    box.innerHTML = `<dl class="dl">${keys.map((k) => `<dt>${esc(lab(k))}</dt><dd>${fmt(res[k], k)}</dd>`).join('')}${p.operacion ? `<dt>Operación</dt><dd>${esc(p.operacion)}</dd>` : ''}${p.tipo ? `<dt>Tipo</dt><dd>${esc(p.tipo)}</dd>` : ''}</dl>`;
    return;
  }
  $('#home-data-title').textContent = 'Los datos en una línea';
  const s = scraper;
  box.innerHTML = `<dl class="dl">
    <dt>Fuente</dt><dd>ZonaProp, avisos de CABA (venta, alquiler y temporario)</dd>
    <dt>Avisos guardados</dt><dd>${nf(s?.listings)}</dd>
    <dt>Búsquedas completas</dt><dd>${nf(s?.searchesDone)}</dd>
    <dt>Fichas visitadas</dt><dd>${nf(s?.details)}</dd>
    <dt>Estado del scraper</dt><dd>${esc(s?.label || '–')}</dd></dl>
    <div class="actions"><a class="btn small" href="${href('datos')}">Ver datos y limpieza →</a></div>`;
}

// Nombre legible de cada corrida principal de A (las iteraciones de docs/historial_modelo_precio.md).
const ITER = { '20261016-122915-price': 1, '20261016-143053-price': 2, '20261016-171812-price': 3, '20261016-193214-price': 4 };
const iterName = (r) => (ITER[r.id] ? `Iteración ${ITER[r.id]}` : `Corrida ${fdate(r.started_at).slice(0, 10)}`);
const iterTip = (r) => `Corrida ${r.id} · variante ${r.variante} · regla de duplicados ${r.duplicados} · ${fdate(r.started_at)}.`
  + (ITER[r.id] === 1 ? ' Usaba la regla de duplicados anterior, así que su test es otro: en el test actual, esa versión da 13,3 %.' : '')
  + (ITER[r.id] === 4 ? ' Misma variante que la iteración 3 con hiperparámetros de Optuna y modelo de respaldo sin dirección.' : '');

// --- 2 · Datos -------------------------------------------------------------------------------
async function viewDatos(task) {
  const t = task || 'price';
  const lr = latestOk(t);
  const res = lr ? (await getRun(lr.id)).result : null;
  const lim = Object.entries(res?.tablas || {}).find(([k]) => k.startsWith('Limpieza'))?.[1];
  $('#funnel-hint').textContent = task ? `Pasos de limpieza de la última corrida de ${letterOf(t)} · ${nameOf(t)}.` : 'Cuántos avisos quedan después de cada filtro de limpieza del modelo de precio (última corrida de A).';
  if (!lim) { $('#funnel').innerHTML = `<p class="muted">${task ? 'Este modelo no publica pasos de limpieza: usa los avisos del dataset filtrados por sus parámetros' + (res?.params?.operacion ? ` (operación ${esc(res.params.operacion)}${res.params.tipo ? `, tipo ${esc(res.params.tipo)}` : ''})` : '') + '.' : 'Todavía no hay corridas del modelo A.'}</p>`; return; }
  const max = lim.rows[0][1];
  $('#funnel').innerHTML = `<div class="bars">${lim.rows.map((r) => `<div class="barrow" tabindex="0" data-tip="${esc(`${r[0]}: quedan ${nf(r[1])}${r[2] ? `, se quitan ${nf(r[2])}` : ''}.`)}"><span class="lbl">${esc(r[0])}</span><span class="track"><span class="fill" style="display:block;width:${(r[1] / max) * 100}%"></span></span><span class="val">${nf(r[1])}</span></div>`).join('')}</div>
    <details class="sub"><summary>Ver la tabla de limpieza</summary>${tableHtml(lim)}</details>`;
}

// --- 3 · Predecir -------------------------------------------------------------------------
let barrioErr = null, dormTouched = false;
async function viewPredecir(task) {
  const f = $('#pform');
  if (task && task !== 'price') {
    f.hidden = true;
    $('#pmsg').innerHTML = `<div class="scoped-note"><b>La predicción de precio es del modelo A.</b><br>Estás viendo ${esc(letterOf(task))} · ${esc(nameOf(task))}, que no estima precios de un departamento puntual.</div>
      <div class="actions"><a class="btn primary" href="${href('predecir', { modelo: 'A' })}">Cambiar al modelo A</a><a class="btn" href="${href('modelos')}">Ver el resultado de ${esc(letterOf(task))}</a></div>`;
    $('#pout').innerHTML = `<div class="empty"><p class="muted">Sin predicción para este modelo.</p></div>`;
    return;
  }
  if (!pmodels) $('#pmsg').innerHTML = loading('Cargando modelos…');
  await loadPriceModels();
}
async function loadPriceModels() {
  try { pmodels = await api('/api/ml/price-models'); } catch (e) { $('#pmsg').innerHTML = `<div class="errbox">${esc(e.message)}</div>`; return; }
  const f = $('#pform');
  const usable = pmodels.models.filter((m) => m.predictable);
  if (!usable.length) { f.hidden = true; $('#pmsg').innerHTML = `<div class="empty"><p><b>Todavía no hay un modelo de precio guardado.</b></p><p class="muted">Entrená el modelo A primero.</p><a class="btn primary" href="#modelos&modelo=A">Ir al modelo A</a></div>`; return; }
  pmodels.models = usable;
  const cur = f.run.value || pmodels.latest || usable[0].run;
  f.run.innerHTML = usable.map((m) => { const g = m.metricas_test?.LightGBM || {}; return `<option value="${esc(m.run)}" ${m.run === cur ? 'selected' : ''}>${esc(m.run)} · ${esc(m.variante)} · ${pct(g['MAPE_mediana_%'])}${m.run === pmodels.latest ? ' (recomendado)' : ''}</option>`; }).join('');
  f.hidden = false; $('#pmsg').innerHTML = '';
  fillPredict();
}
async function fillPredict() {
  const f = $('#pform');
  const m = pmodels.models.find((x) => x.run === f.run.value) || pmodels.models[0];
  const prevB = f.barrio.value || 'Palermo', prevT = f.tipo.value || 'departamento';
  const barrios = [...m.barrios].sort((a, b) => a.localeCompare(b, 'es'));
  f.barrio.innerHTML = barrios.map((b) => `<option ${b === prevB ? 'selected' : ''}>${esc(b)}</option>`).join('');
  if (!barrios.includes(prevB) && barrios.length) f.barrio.value = barrios.includes('Palermo') ? 'Palermo' : barrios[0];
  f.tipo.innerHTML = m.tipos.map((t) => `<option ${t === prevT ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const g = m.metricas_test?.LightGBM || {};
  $('#p-model-info').innerHTML = `${esc(m.modelo)} ${esc(m.variante)} · duplicados ${esc(m.duplicados)} · ${esc(m.operacion)} ${esc(m.currency)} · tipo ${esc(m.tipo)} · test ${esc(m.split)} (train ${nf(m.n_train)}, test ${nf(m.n_test)}) · error mediano ${pct(g['MAPE_mediana_%'])}`;
  barrioErr = null;
  try { const t = Object.entries((await getRun(m.run)).result?.tablas || {}).find(([k]) => k.startsWith('Error por barrio'))?.[1]; if (t) barrioErr = Object.fromEntries(t.rows.map((r) => [r[0], { n: r[1], mape: r[2] }])); } catch { /* opcional */ }
}
$('#pform').run.onchange = () => fillPredict();
$('#pform').dormitorios.oninput = () => { dormTouched = true; };
$('#pform').ambientes.oninput = (e) => { if (!dormTouched) $('#pform').dormitorios.value = Math.max(0, Number(e.target.value || 1) - 1); };
$('#pform').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = $('#pform'), inputs = {};
  for (const k of ['barrio', 'tipo', 'superficie_total', 'superficie_cubierta', 'ambientes', 'dormitorios', 'banos', 'cocheras', 'expensas', 'piso', 'antiguedad', 'direccion', 'descripcion']) inputs[k] = f[k].value;
  for (const k of ['a_estrenar', 'balcon_terraza', 'amenities', 'apto_credito']) inputs[k] = f[k].checked;
  $('#pbtn').disabled = true;
  $('#pout').innerHTML = `<div class="empty"><div class="spinner"></div><p class="muted">Calculando… (tarda unos segundos)</p></div>`;
  try {
    const r = await api('/api/ml/predict', { run: f.run.value, inputs });
    if (r.ok === false) throw new Error(r.error || 'No se pudo predecir');
    $('#pout').innerHTML = predictionHtml(r, inputs);
  } catch (e) { $('#pout').innerHTML = `<div class="errbox"><b>No se pudo estimar el precio.</b>\n${esc(e.message)}</div>`; }
  $('#pbtn').disabled = false;
};
function predictionHtml(r, inputs) {
  const cur = r.moneda; const [lo, hi] = r.rango_80; const [lo5, hi5] = r.rango_50;
  const span = hi - lo; const a = lo - span * 0.15, b = hi + span * 0.15; const pos = (v) => Math.min(100, Math.max(0, ((v - a) / (b - a)) * 100));
  const bm2 = r.baseline_barrio_precio && r.superficie_usada ? r.baseline_barrio_precio / r.superficie_usada : null;
  const diff = bm2 ? (r.precio_m2 / bm2 - 1) * 100 : null;
  const be = barrioErr?.[inputs.barrio];
  const g = r.error_test || {};
  return `<div class="price-label">Precio estimado · ${esc(inputs.barrio)} · ${nf(r.superficie_usada)} m²</div>
    <div class="price-big">${usd(r.precio, cur)}</div>
    <div class="price-sub">${usd(r.precio_m2, cur)} por m²</div>
    <div class="range">
      <div class="range-track">
        <div class="range-80" style="left:${pos(lo)}%;width:${pos(hi) - pos(lo)}%"></div>
        <div class="range-50" style="left:${pos(lo5)}%;width:${pos(hi5) - pos(lo5)}%"></div>
        <div class="range-mark" style="left:${pos(r.precio)}%"><span>estimado</span></div>
        ${r.baseline_barrio_precio && r.baseline_barrio_precio > a && r.baseline_barrio_precio < b ? `<div class="range-mark barrio" style="left:${pos(r.baseline_barrio_precio)}%" title="Mediana del barrio × m²"></div>` : ''}
      </div>
      <div class="range-ends"><span>${usd(lo, cur)}</span><b>Rango probable (80 %) ${tip('Rango donde debería caer el precio publicado con un 80 % de probabilidad: en el test, 8 de cada 10 precios reales quedaron adentro de rangos así. La franja más oscura es el rango del 50 %.')}</b><span>${usd(hi, cur)}</span></div>
      <p class="hint">En avisos que el modelo no vio, el ${pct(r.cobertura_test?.['80%'], 0)} de los precios reales cayó dentro de un rango así. La franja más oscura es el rango del 50 %: ${usd(lo5, cur)} – ${usd(hi5, cur)}.</p>
    </div>
    <div class="compare">
      ${bm2 ? kpi(`${usd(bm2, cur)}/m²`, `mediana de ${inputs.barrio}`, 'Mediana del precio por m² de los departamentos en venta del barrio (avisos de entrenamiento). Sirve como tasación rápida para comparar.') : ''}
      ${diff != null ? kpi(`<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${nf(diff, 0)} %</span>`, diff > 0 ? 'por encima de su barrio' : 'por debajo de su barrio', 'Diferencia entre el USD/m² estimado para este departamento y la mediana de su barrio. Las características (m², ambientes, ubicación, texto) explican por qué se aparta.') : ''}
      ${be ? kpi(pct(be.mape), `error típico del modelo en ${inputs.barrio}`, `${EM} Calculado sólo con los ${nf(be.n)} avisos de test de este barrio.`) : kpi(pct(g['MAPE_mediana_%']), 'error típico del modelo', EM)}
    </div>
    <div class="notes">${(r.avisos || []).map((w) => `<div class="note">${esc(w)}</div>`).join('')}</div>
    <details class="sub"><summary>Detalles técnicos</summary>
      <dl class="dl" style="margin-top:10px">
        <dt>Modelo usado</dt><dd>${esc(r.modelo)}${r.modelo_usado ? ` · ${esc(r.modelo_usado)}` : ''}</dd>
        <dt>Corrida</dt><dd><a href="${href('', { corrida: r.run, modelo: 'A' })}">${esc(r.run)}</a></dd>
        <dt>Ridge (modelo lineal)</dt><dd>${usd(r.ridge_precio, cur)}</dd>
        <dt>Mediana del barrio × m²</dt><dd>${usd(r.baseline_barrio_precio, cur)}</dd>
        <dt>Error en test (${nf(r.n_test)} avisos, ${esc(r.split)})</dt><dd>mediana ${pct(g['MAPE_mediana_%'])} · a ±10 %: ${pct(g['dentro_10%_%'], 0)}</dd>
      </dl></details>`;
}

// --- 4 · Modelos ------------------------------------------------------------------------------
async function viewModelos() {
  const grid = $('#model-grid');
  const cards = await Promise.all(tasks().map(async (t) => {
    const lr = latestOk(t); const res = lr ? (await getRun(lr.id).catch(() => null))?.result : null;
    const kn = keyNumbers(t, res); const n = runsOf(t).length;
    const status = !lr ? '<span class="pill">Sin corridas</span>' : t === 'survival' && res?.estado === 'faltan_datos' ? '<span class="pill warn">Faltan datos</span>' : t === 'price_ablation' ? '<span class="pill accent">Experimento</span>' : '<span class="pill ok">Con resultado</span>';
    return `<a class="mcard" href="${href('modelos', { modelo: letterOf(t) })}">
      <div class="mtop"><span class="letter">${esc(letterOf(t))}</span><h3>${esc(nameOf(t))}</h3><span style="margin-left:auto">${status}</span></div>
      <p class="q">${esc(ml.tasks[t].question || '')}</p>
      ${kn.length ? `<div class="mnums">${kn.map((k) => `<div class="mnum"><b>${k.v}</b><span>${esc(k.l)}${k.t ? ' ' + tip(k.t) : ''}</span></div>`).join('')}</div>` : '<p class="muted small">Entrenalo para ver resultados.</p>'}
      <div class="mfoot"><span>${lr ? `Última: ${fdate(lr.started_at)} · ${n} corridas` : 'Todavía no se entrenó'}</span><span class="go">Ver detalle →</span></div></a>`;
  }));
  grid.innerHTML = cards.join('');
}

async function viewModelo(task) {
  const el = $('#view-modelo'); const t = ml.tasks[task]; const L = letterOf(task);
  const lr = latestOk(task); const rs = runsOf(task);
  el.innerHTML = `<div class="crumbs"><a href="${href('modelos', { modelo: '' })}">Resultados por modelo</a> › ${esc(L)} · ${esc(nameOf(task))}</div>
    <div class="page-head"><h1><span class="letter" style="vertical-align:4px">${esc(L)}</span> ${esc(nameOf(task))}</h1><p class="lead"><b>${esc(t.question || '')}</b> ${esc(t.use || '')}</p>
    ${task === 'price' ? `<div class="actions"><a class="btn primary" href="${href('predecir')}">Probar el modelo: estimar un precio</a><a class="btn" href="${href('experimentos', { t: 'variantes' })}">Comparar variantes</a><a class="btn" href="${href('docs', { t: 'doc' })}">Leer la documentación</a></div>` : ''}</div>
    <div class="grid-detail">
      <div class="card" id="m-last">${lr ? loading() : `<div class="empty"><p><b>Este modelo todavía no tiene resultados.</b></p><p class="muted">Usá "Entrenar" a la derecha (con los valores por defecto alcanza).</p></div>`}</div>
      <div>
        <div class="card" id="m-train"></div>
        <div class="card"><div class="card-head"><h3>Corridas de este modelo</h3><span class="muted small">${rs.length}</span></div>
          ${rs.length ? `<div class="tablewrap" style="max-height:360px"><table><tbody>${rs.map((r) => `<tr class="click" data-id="${esc(r.id)}"><td><b>${fdate(r.started_at)}</b><br><span class="muted small">${mainMetric(r)}</span></td><td class="n">${r.status === 'ok' ? '<span class="pill ok">ok</span>' : `<span class="pill err">${esc(r.status)}</span>`}</td></tr>`).join('')}</tbody></table></div>
          <div class="actions"><a class="btn small" href="${href('experimentos', { t: 'corridas' })}">Ver y comparar en Experimentos →</a></div>` : '<p class="muted">Sin corridas.</p>'}</div>
        <details class="card sub"><summary>Cómo funciona</summary><p class="muted small">${esc(t.desc || '')}</p></details>
      </div>
    </div>`;
  $$('#view-modelo tr[data-id]').forEach((tr) => tr.onclick = () => go('', { corrida: tr.dataset.id }));
  renderTrain(task);
  if (lr) await renderRun(lr.id, $('#m-last'), { compact: true });
}

function renderTrain(task) {
  const box = $('#m-train'); if (!box) return;
  const t = ml.tasks[task]; const vals = saved[task] || {};
  box.innerHTML = `<h3>Entrenar de nuevo</h3>
    <p class="muted small">Con los valores por defecto se reproduce el resultado documentado. Cambialos sólo si querés experimentar.</p>
    <div class="actions" style="margin-top:8px"><button class="btn primary" id="m-run">Entrenar</button><button class="btn" id="m-cancel" disabled>Cancelar</button></div>
    <div id="m-prog" hidden><div class="bar"><div id="m-bar"></div></div><div id="m-step" class="hint"></div></div>
    <div id="m-msg"></div>
    <details class="sub"><summary>Opciones avanzadas <span class="opt">${Object.keys(t.params).length} parámetros</span></summary>
      <form id="m-form">${paramFields(t, vals)}</form>
      <div class="actions"><button class="btn small" id="m-def" type="button">Volver a los valores por defecto</button></div>
    </details>`;
  $('#m-run').onclick = async () => {
    const params = readParams(t); saved[task] = params; localStorage.setItem('mlParams', JSON.stringify(saved));
    $('#m-msg').innerHTML = '';
    try { await api('/api/ml/start', { task, params }); await refreshMl(); } catch (e) { $('#m-msg').innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  };
  $('#m-cancel').onclick = () => api('/api/ml/cancel', {}).then(refreshMl);
  $('#m-def').onclick = () => { delete saved[task]; localStorage.setItem('mlParams', JSON.stringify(saved)); $('#m-form').innerHTML = paramFields(t, {}); };
  trainStatus(task);
}
function paramFields(t, vals) {
  return Object.entries(t.params).map(([k, s]) => {
    const v = vals[k] ?? s.default; const def = s.type === 'multi' ? '' : ` <span class="opt">(por defecto: ${esc(String(s.default === '' ? 'vacío' : typeof s.default === 'boolean' ? (s.default ? 'sí' : 'no') : s.default))})</span>`;
    if (s.type === 'bool') return `<label class="chk"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${esc(s.label)}</label>`;
    if (s.type === 'select') return `<label class="field">${esc(s.label)}${def}</label><select name="${k}">${s.options.map((o) => `<option ${o === v ? 'selected' : ''} ${VARIANTS[o] ? `title="${esc(VARIANTS[o])}"` : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (s.type === 'multi') return `<label class="field">${esc(s.label)}</label><div class="multi">${s.options.map((o) => `<label ${VARIANTS[o] ? `title="${esc(VARIANTS[o])}"` : ''}><input type="checkbox" name="${k}" value="${o}" ${v.includes(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</div>`;
    if (s.type === 'date') return `<label class="field">${esc(s.label)}</label><input type="date" name="${k}" value="${esc(v)}">`;
    return `<label class="field">${esc(s.label)}${def}</label><input type="number" name="${k}" value="${v}" min="${s.min ?? ''}" max="${s.max ?? ''}" step="${s.step ?? 'any'}">`;
  }).join('');
}
function readParams(t) {
  const out = {}, form = $('#m-form');
  for (const [k, s] of Object.entries(t.params)) {
    const els = $$(`[name="${k}"]`, form);
    if (s.type === 'bool') out[k] = els[0].checked;
    else if (s.type === 'multi') out[k] = els.filter((e) => e.checked).map((e) => e.value);
    else if (s.type === 'number') out[k] = els[0].value === '' ? s.default : Number(els[0].value);
    else out[k] = els[0].value;
  }
  return out;
}
function trainStatus(task) {
  if (!$('#m-run')) return;
  const j = ml.job; const mine = j && j.task === task;
  $('#m-run').disabled = ml.running || !ml.python.ok;
  $('#m-cancel').disabled = !mine;
  $('#m-prog').hidden = !mine;
  if (mine) { $('#m-bar').style.width = `${j.pct}%`; $('#m-step').textContent = `${j.pct} % · ${j.step}`; }
  else if (ml.running) $('#m-msg').innerHTML = '<p class="hint">Hay otro entrenamiento en curso; se puede entrenar uno a la vez.</p>';
  else if (!ml.python.ok) $('#m-msg').innerHTML = '<div class="errbox">Python no disponible: instalá ml/requirements.txt (ver README).</div>';
  else if (ml.last?.task === task && $('#m-msg').dataset.shown !== ml.last.id) {
    $('#m-msg').innerHTML = ml.last.status === 'ok' ? `<p class="ok">Última corrida OK: <a href="${href('', { corrida: ml.last.id })}">${esc(ml.last.id)}</a></p>` : `<div class="errbox">Última corrida: ${esc(ml.last.status)} — ${esc(ml.last.error || '')}</div>`;
  }
}

// --- Corrida ------------------------------------------------------------------------------
async function viewCorrida() {
  const el = $('#view-corrida'); const id = route.p.corrida;
  const meta = (cmp?.runs || []).find((r) => r.id === id) || (ml?.runs || []).find((r) => r.id === id);
  const task = meta?.task || id.split('-').slice(2).join('-');
  if (ml?.tasks[task] && route.p.modelo !== letterOf(task)) { history.replaceState(null, '', href('', { corrida: id, modelo: letterOf(task) })); route.p.modelo = letterOf(task); renderCtx(task); document.body.classList.add('has-model'); for (const a of $$('#nav a')) a.href = href(a.dataset.nav, {}); }
  el.innerHTML = `<div class="crumbs"><a href="${href('experimentos')}">Experimentos</a> › <a href="${href('modelos')}">${esc(letterOf(task))} · ${esc(nameOf(task))}</a> › ${esc(id)}</div><div class="card" id="run-body"></div>`;
  await renderRun(id, $('#run-body'));
}

// --- 5 · Experimentos ------------------------------------------------------------------------
async function viewExperimentos(task) {
  $('#view-experimentos .lead').textContent = !task || task === 'price' || task === 'price_ablation' ? 'Todo lo que se probó: cada corrida guardada, la comparación de variantes del modelo de precio y las ablaciones con validación cruzada.' : `Todas las corridas guardadas de ${letterOf(task)} · ${nameOf(task)}, para comparar resultados entre corridas.`;
  const allowed = !task ? ['corridas', 'variantes', 'ablacion', 'glosario'] : task === 'price' ? ['corridas', 'variantes', 'ablacion', 'glosario'] : task === 'price_ablation' ? ['corridas', 'ablacion', 'glosario'] : ['corridas'];
  const names = { corridas: task ? `Corridas de ${letterOf(task)}` : 'Todas las corridas', variantes: 'Comparar variantes de A', ablacion: task === 'price' ? 'Ablaciones de A (A2)' : 'Ablaciones (A2)', glosario: 'Qué es cada variante' };
  const cur = allowed.includes(route.p.t) ? route.p.t : 'corridas';
  $('#exp-tabs').innerHTML = allowed.map((k) => `<button role="tab" data-t="${k}" aria-selected="${k === cur}">${esc(names[k])}</button>`).join('');
  $$('#exp-tabs button').forEach((b) => b.onclick = () => go('experimentos', { t: b.dataset.t }));
  const body = $('#exp-body'); body.innerHTML = loading();
  if (cur === 'corridas') expCorridas(body, task);
  if (cur === 'variantes') expVariantes(body);
  if (cur === 'ablacion') await expAblacion(body);
  if (cur === 'glosario') expGlosario(body, task);
}
function expCorridas(body, task) {
  const all = [...(cmp?.runs || [])];
  for (const r of ml.runs) if (!all.find((x) => x.id === r.id)) all.push({ ...r, started_at: null });
  const draw = () => {
    const ft = task || $('#f-task')?.value || '', fs = $('#f-status')?.value || '';
    const rows = all.filter((r) => (!ft || r.task === ft) && (!fs || (fs === 'ok' ? r.status === 'ok' : r.status !== 'ok'))).sort((a, b) => String(b.started_at || b.id).localeCompare(String(a.started_at || a.id)));
    $('#runs-table').innerHTML = rows.length ? `<div class="tablewrap"><table><thead><tr><th>Fecha</th>${task ? '' : '<th>Modelo</th>'}<th>Resultado principal</th><th>Estado</th><th class="n">Duración</th><th>Corrida</th></tr></thead><tbody>${rows.map((r) => `<tr class="click" data-id="${esc(r.id)}"><td>${fdate(r.started_at)}</td>${task ? '' : `<td><span class="letter" style="min-width:30px;height:26px;font-size:12px">${esc(letterOf(r.task))}</span> ${esc(nameOf(r.task))}</td>`}<td>${mainMetric(r)}</td><td>${r.status === 'ok' ? '<span class="pill ok">ok</span>' : `<span class="pill err">${esc(r.status)}</span>`}</td><td class="n">${fsec(r.seconds)}</td><td class="muted small">${esc(r.id)}</td></tr>`).join('')}</tbody></table></div><p class="hint">${rows.length} corridas. Tocá una fila para ver su resultado completo.</p>` : '<p class="muted">No hay corridas con ese filtro.</p>';
    $$('#runs-table tr[data-id]').forEach((tr) => tr.onclick = () => go('', { corrida: tr.dataset.id }));
  };
  body.innerHTML = `<div class="card">${task ? '' : `<div class="table-tools"><label>Modelo <select id="f-task"><option value="">Todos</option>${tasks().map((t) => `<option value="${t}">${esc(letterOf(t))} · ${esc(nameOf(t))}</option>`).join('')}</select></label>`}
    ${task ? '<div class="table-tools">' : ''}<label>Estado <select id="f-status"><option value="">Todos</option><option value="ok">OK</option><option value="bad">Con error / incompletas</option></select></label></div><div id="runs-table"></div></div>`;
  $$('#f-task, #f-status').forEach((s) => s.onchange = draw);
  draw();
}
function expVariantes(body) {
  const price = runsOf('price').filter((r) => r.status === 'ok');
  const compact = { columns: ['fecha', 'corrida', 'variante', 'duplicados', 'split', 'n_train', 'n_test', 'MAPE_mediana_%', 'dentro_10%_%', 'R2_log', 'cobertura 80 %'],
    rows: price.map((r) => { const g = mainLgbm(r.metricas) || {}; return [fdate(r.started_at), r.id, r.variante, r.duplicados, r.split, r.n_train, r.n_test, g['MAPE_mediana_%'] ?? null, g['dentro_10%_%'] ?? null, g.R2_log ?? null, r.cobertura?.['80%'] ?? null]; }) };
  const full = { columns: ['corrida', 'variante', 'duplicados', 'split', 'n_train', 'n_test', 'modelo', 'MAE', 'MAPE_mediana_%', 'dentro_10%_%', 'R2_log', 'R2', 'cobertura 80 %'], rows: [] };
  for (const r of price) for (const [m, v] of Object.entries(r.metricas || {})) full.rows.push([r.id, r.variante, r.duplicados, r.split, r.n_train, r.n_test, m, v.MAE ?? null, v['MAPE_mediana_%'] ?? null, v['dentro_10%_%'] ?? null, v.R2_log ?? null, v.R2 ?? null, /LightGBM \(test\)/.test(m) && r.cobertura ? r.cobertura['80%'] : null]);
  body.innerHTML = `<div class="card"><h3>Modelo A: una fila por corrida</h3>
    <p class="muted small">Error del LightGBM principal en el test de cada corrida. Ojo: cambiar la regla de duplicados o el split cambia el test, así que compará variantes dentro de una misma corrida (fila «v1 (referencia)» en la vista completa) o con la ablación.</p>
    <div class="table-tools"><label class="chk" style="margin:0"><input type="checkbox" id="v-full"> Mostrar todos los modelos de cada corrida (baselines, Ridge, v1 de referencia, respaldo sin dirección, protocolo anterior)</label></div>
    <div id="v-table"></div></div>`;
  const draw = () => {
    const isFull = $('#v-full').checked;
    $('#v-table').innerHTML = tableHtml(isFull ? full : compact, { click: true, hl: (row) => row[isFull ? 0 : 1] === pmodels?.latest && (!isFull || row[6] === 'LightGBM (test)') });
    const rows = isFull ? full.rows : compact.rows;
    $$('#v-table tr[data-i]').forEach((tr) => tr.onclick = () => go('', { corrida: rows[tr.dataset.i][isFull ? 0 : 1] }));
  };
  $('#v-full').onchange = draw; draw();
  body.insertAdjacentHTML('beforeend', '<p class="hint">Resaltado: el modelo que usa hoy «Predecir precio». Tocá una fila para abrir la corrida.</p>');
}
async function expAblacion(body) {
  const abl = runsOf('price_ablation').filter((r) => r.status === 'ok');
  if (!abl.length) { body.innerHTML = '<div class="card"><p class="muted">Todavía no hay ablaciones.</p></div>'; return; }
  const parts = await Promise.all(abl.map(async (r, i) => {
    const res = (await getRun(r.id)).result || {};
    const t = Object.entries(res.tablas || {}).find(([k]) => k.startsWith('Ablación'))?.[1];
    return `<details class="block" ${i === 0 ? 'open' : ''}><summary>${fdate(r.started_at)} · mejor: ${esc(res.mejor_variante_cv || '–')} <span class="count">${t ? `${t.rows.length} variantes` : ''} · ${esc(r.id)}</span></summary>
      ${t ? tableHtml(t, { hl: (row) => row[0] === res.mejor_variante_cv }) : '<p class="muted">Sin tabla de ablación.</p>'}
      <div class="actions"><a class="btn small" href="${href('', { corrida: r.id, modelo: 'A2' })}">Ver la corrida completa →</a></div></details>`;
  }));
  body.innerHTML = `<p class="muted small">Validación cruzada de 5 folds agrupados sólo sobre train (el test no se toca). Resaltada: la mejor variante de cada ablación. Las columnas de segmento muestran dónde ayuda cada cambio.</p>` + parts.join('');
}
function expGlosario(body, task) {
  const opts = ml.tasks.price.params.variante.options; const def = ml.tasks.price.params.variante.default;
  body.innerHTML = `<div class="card"><h3>Variantes del modelo de precio</h3><p class="muted small">Todas siguen seleccionables en ${task === 'price_ablation' ? 'la ablación (A2)' : 'A → Entrenar → Opciones avanzadas'}.</p>
    <div class="tablewrap"><table><thead><tr><th>Variante</th><th>Qué cambia</th></tr></thead><tbody>${opts.map((o) => `<tr class="${o === def ? 'hl' : ''}"><td><code>${esc(o)}</code>${o === def ? ' <span class="pill accent">por defecto</span>' : ''}</td><td>${esc(VARIANTS[o] || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
}

// --- 6 · Historial y docs -----------------------------------------------------------------
async function viewDocs(task) {
  const isA = !task || task === 'price' || task === 'price_ablation';
  const allowed = isA ? (task ? ['historial', 'doc'] : ['historial', 'doc', 'anterior']) : ['notas'];
  const names = { historial: 'Historial del modelo A', doc: 'Documentación del modelo A', anterior: 'Vista anterior', notas: `Notas e historial de ${task ? letterOf(task) : ''}` };
  const cur = allowed.includes(route.p.t) ? route.p.t : allowed[0];
  $('#doc-tabs').innerHTML = allowed.map((k) => `<button role="tab" data-t="${k}" aria-selected="${k === cur}">${esc(names[k])}</button>`).join('');
  $$('#doc-tabs button').forEach((b) => b.onclick = () => go('docs', { t: b.dataset.t }));
  const body = $('#doc-body'); body.innerHTML = loading();
  if (cur === 'anterior') {
    body.innerHTML = `<div class="card"><h3>Pantallas anteriores</h3><p class="muted">Las dos pantallas originales siguen funcionando tal cual, con todos sus controles.</p><div class="actions"><a class="btn" href="/clasico">Scraper (vista anterior)</a><a class="btn" href="/clasico/modelos">Modelos (vista anterior)</a></div></div>`;
    return;
  }
  if (cur === 'notas') {
    const t = ml.tasks[task]; const rs = runsOf(task);
    body.innerHTML = `<div class="card md"><h2 style="border:0;margin-top:0;padding:0">${esc(letterOf(task))} · ${esc(nameOf(task))}</h2><p><b>${esc(t.question || '')}</b> ${esc(t.use || '')}</p><p>${esc(t.desc || '')}</p>
      <p class="muted small">La documentación escrita (docs/modelo_precio.md y docs/historial_modelo_precio.md) es del modelo A; para verla elegí A o «Todos los modelos».</p>
      <h3>Historial de corridas</h3>${rs.length ? `<div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Resultado</th><th>Estado</th><th>Corrida</th></tr></thead><tbody>${rs.slice().reverse().map((r) => `<tr class="click" data-id="${esc(r.id)}"><td>${fdate(r.started_at)}</td><td>${mainMetric(r)}</td><td>${esc(r.status)}</td><td class="muted small">${esc(r.id)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sin corridas.</p>'}</div>`;
    $$('#doc-body tr[data-id]').forEach((tr) => tr.onclick = () => go('', { corrida: tr.dataset.id }));
    return;
  }
  const d = await api(cur === 'historial' ? '/api/ml/historial' : '/api/ml/doc');
  if (!d.markdown) { body.innerHTML = `<div class="errbox">No se encontró ${esc(d.name)}</div>`; return; }
  const { html, toc } = md(d.markdown);
  body.innerHTML = `<div class="${toc.length > 1 ? 'doc-layout' : ''}">${toc.length > 1 ? `<nav class="toc card"><b>En este documento</b>${toc.map((x) => `<a href="javascript:void 0" data-id="${x.id}" style="padding-left:${(x.level - 2) * 12 + 8}px">${x.text}</a>`).join('')}</nav>` : ''}
    <article class="card md"><p class="muted small">${esc(d.name)}${cur === 'historial' ? ' · orden cronológico; cada corrida sigue disponible en Experimentos' : ''}</p>${html}</article></div>`;
  $$('#doc-body .toc a').forEach((a) => a.onclick = () => document.getElementById(a.dataset.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function md(src) {
  const inl = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, a, u) => /^https?:/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${a}</a>` : a);
  const lines = src.replace(/\r/g, '').split('\n'); let h = '', i = 0; const toc = []; let hn = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) { const b = []; i++; while (i < lines.length && !lines[i].startsWith('```')) b.push(lines[i++]); i++; h += `<pre>${esc(b.join('\n'))}</pre>`; continue; }
    const m = l.match(/^(#{1,4}) (.*)/);
    if (m) { const lv = m[1].length, id = `h-${++hn}`; if (lv >= 2 && lv <= 3) toc.push({ id, level: lv, text: inl(m[2]) }); h += `<h${lv} id="${id}" style="scroll-margin-top:130px">${inl(m[2])}</h${lv}>`; i++; continue; }
    if (l.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      h += `<div class="tablewrap"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${inl(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map(cells).map((r) => `<tr>${r.map((c) => `<td class="${/^[-+]?[\d.,\s%±]+$/.test(c) ? 'n' : ''}">${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(l)) {
      const ord = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) { let it = lines[i++].replace(/^\s*([-*]|\d+\.) /, ''); while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.) /.test(lines[i])) it += ' ' + lines[i++].trim(); items.push(it); }
      h += `<${ord ? 'ol' : 'ul'}>${items.map((x) => `<li>${inl(x)}</li>`).join('')}</${ord ? 'ol' : 'ul'}>`; continue;
    }
    if (!l.trim()) { i++; continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(#|\||```|\s*([-*]|\d+\.) )/.test(lines[i])) p.push(lines[i++]);
    h += `<p>${inl(p.join(' '))}</p>`;
  }
  return { html: h, toc };
}

// --- Arranque y sondeo -------------------------------------------------------------------
let wasRunning = false;
async function refreshMl() {
  try { ml = await api('/api/ml/state'); } catch { $('#top-status').innerHTML = '<span class="pill err">Sin conexión con el servidor</span>'; return; }
  const task = ctxTask();
  if (route.view === 'modelos' && task) trainStatus(task);
  if (wasRunning && !ml.running) { // terminó un entrenamiento: refrescar datos y la vista
    runCache.clear(); cmp = await api('/api/ml/compare').catch(() => cmp); pmodels = null;
    if (ml.last?.task === 'price') await loadPriceModels().catch(() => {});
    wasRunning = false; render(); return;
  }
  wasRunning = ml.running;
  renderTop();
}
(async () => {
  try {
    [ml, cmp, pmodels] = await Promise.all([api('/api/ml/state'), api('/api/ml/compare'), api('/api/ml/price-models')]);
  } catch (e) { $('#main').insertAdjacentHTML('afterbegin', `<div class="errbox">No se pudo conectar con el servidor: ${esc(e.message)}</div>`); }
  wasRunning = Boolean(ml?.running);
  window.addEventListener('hashchange', render);
  await render();
  (async function loop() { await new Promise((r) => setTimeout(r, ml?.running ? 1000 : 4000)); await refreshMl(); loop(); })();
})();

// --- Tooltips ("?"): hover, clic/tap y teclado; un único globo position:fixed en <body> -----------
// Delegación sobre document: funciona con todo lo que se re-renderiza. Clic fuera o Esc lo cierran.
const tipBox = Object.assign(document.createElement('div'), { id: 'tooltip', className: 'tooltip', hidden: true });
tipBox.setAttribute('role', 'tooltip');
document.body.append(tipBox);
let tipAt = null, tipPinned = false;
function placeTip() {
  if (!tipAt) return;
  if (!tipAt.isConnected) { hideTip(); return; }
  const r = tipAt.getBoundingClientRect();
  tipBox.style.left = '0px'; tipBox.style.top = '0px';
  const w = tipBox.offsetWidth, h = tipBox.offsetHeight;
  const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
  let y = r.top - h - 10, pos = 'above';
  if (y < 8) { y = r.bottom + 10; pos = 'below'; }
  tipBox.style.left = `${x}px`; tipBox.style.top = `${y}px`; tipBox.dataset.pos = pos;
  tipBox.style.setProperty('--arrow-x', `${Math.max(12, Math.min(w - 12, r.left + r.width / 2 - x))}px`);
}
function showTip(el, pinned) {
  if (tipAt && tipAt !== el) hideTip();
  tipAt = el; tipPinned = pinned;
  tipBox.textContent = el.dataset.tip;
  tipBox.hidden = false;
  el.setAttribute('aria-describedby', 'tooltip'); el.setAttribute('aria-expanded', String(pinned)); el.classList.add('on');
  placeTip();
}
function hideTip() {
  if (tipAt) { tipAt.removeAttribute('aria-describedby'); tipAt.setAttribute('aria-expanded', 'false'); tipAt.classList.remove('on'); }
  tipAt = null; tipPinned = false; tipBox.hidden = true;
}
const tipOf = (e) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
document.addEventListener('mouseover', (e) => { const el = tipOf(e); if (el && !tipPinned && el !== tipAt) showTip(el, false); });
document.addEventListener('mouseout', (e) => { const el = tipOf(e); if (el && el === tipAt && !tipPinned && !el.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('focusin', (e) => { const el = tipOf(e); if (el && el !== tipAt) showTip(el, false); });
document.addEventListener('focusout', (e) => { if (tipAt && e.target === tipAt && !tipPinned) hideTip(); });
// En captura: el "?" no dispara el clic de la tarjeta, fila o label que lo contiene.
document.addEventListener('click', (e) => {
  const el = tipOf(e);
  if (el) { e.preventDefault(); e.stopPropagation(); if (el === tipAt && tipPinned) hideTip(); else showTip(el, true); return; }
  if (tipAt && !tipBox.contains(e.target)) hideTip();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tipAt) { const el = tipAt; hideTip(); el.focus?.(); return; }
  const el = tipOf(e);
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (el === tipAt && tipPinned) hideTip(); else showTip(el, true); }
});
addEventListener('scroll', placeTip, true);
addEventListener('resize', placeTip);
addEventListener('hashchange', hideTip);
setInterval(() => { if (tipAt && !tipAt.isConnected) hideTip(); }, 500);
