// Sección "Datos" de ui/app.html: estado y control del scraper (antes ui/index.html, que sigue en /clasico).
(() => {
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('es-AR'));
const api = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
};

let status = { state: 'idle' };
let connected = false;
let wasRunning = false;

// --- Formulario ------------------------------------------------------------------------------
const CHECKS = ['scrapeDetails', 'includeDevelopments', 'trackChanges', 'headless', 'blockResources'];
const NUMBERS = ['delayMin', 'delayMax', 'maxPagesPerSearch', 'maxDetailsPerRun'];
const lines = (id) => $(id).value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const pressed = (id) => [...$(id).querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.value);

function chip(value, label, on) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.dataset.value = value; b.textContent = label;
  b.setAttribute('aria-pressed', String(on));
  return b;
}

function readForm() {
  const s = { operaciones: pressed('operaciones'), tipos: pressed('tipos'), zonas: lines('zonas'), urls: lines('urls') };
  for (const id of CHECKS) s[id] = $(id).checked;
  for (const id of NUMBERS) s[id] = $(id).value === '' ? null : Number($(id).value);
  return s;
}

function fillForm(settings, options) {
  $('operaciones').replaceChildren(...options.operaciones.map((o) => chip(o.slug, o.label, settings.operaciones.includes(o.slug))));
  $('tipos').replaceChildren(...options.tipos.map((t) => chip(t.slug, t.label, settings.tipos.includes(t.slug))));
  $('zonas-sugeridas').replaceChildren(...options.zonas.map((z) => chip(z, z, false)));
  $('zonas').value = settings.zonas.join('\n');
  $('urls').value = settings.urls.join('\n');
  for (const id of CHECKS) $(id).checked = settings[id];
  for (const id of NUMBERS) $(id).value = settings[id] ?? '';
  syncZoneChips();
  showPlan();
}

function syncZoneChips() {
  const current = new Set(lines('zonas'));
  for (const b of $('zonas-sugeridas').children) b.setAttribute('aria-pressed', String(current.has(b.dataset.value)));
}

function showPlan() {
  const s = readForm();
  const n = s.operaciones.length * Math.max(1, s.tipos.length) * Math.max(1, s.zonas.length) + s.urls.length;
  $('plan').textContent = n === 0 ? 'Elegí al menos una operación.'
    : `${n} ${n === 1 ? 'búsqueda' : 'búsquedas'} de partida${s.zonas.length ? '' : ' · todo el país'}`;
}

let saveTimer;
function formChanged() {
  showPlan();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/api/settings', readForm()).catch(() => {}), 600);
}

for (const id of ['operaciones', 'tipos']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.disabled) return;
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    formChanged();
  });
}
$('zonas-sugeridas').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b || b.disabled) return;
  const current = lines('zonas');
  const next = current.includes(b.dataset.value) ? current.filter((z) => z !== b.dataset.value) : [...current, b.dataset.value];
  $('zonas').value = next.join('\n');
  syncZoneChips();
  formChanged();
});
$('form').addEventListener('input', () => { syncZoneChips(); formChanged(); });
$('form').addEventListener('submit', (e) => e.preventDefault());

// --- Estado ----------------------------------------------------------------------------------
function render() {
  if (!$('scr-pill')) return; // el programa ya se cerró
  const s = status;
  const running = s.state !== 'idle';
  const pill = $('scr-pill');
  const results = { terminado: 'Terminado', detenido: 'Detenido', error: 'Terminó con error' };
  pill.className = 'pill' + (!connected || s.attention ? ' warn' : running ? ' running' : '');
  pill.textContent = !connected ? 'Sin conexión'
    : s.state === 'stopping' ? 'Deteniendo…'
    : s.attention === 'verificacion' ? 'Esperando verificación'
    : s.attention === 'pausa' ? 'En pausa'
    : running ? (s.phase === 'fichas' ? 'Visitando fichas' : 'Recorriendo listados')
    : results[s.result] || 'Listo para iniciar';

  const banner = $('banner');
  const text = !connected ? 'Se perdió la conexión con el programa. Si cerraste la ventana negra, volvé a abrir "Iniciar ZonaProp Scraper".'
    : s.attention === 'verificacion' ? 'ZonaProp pide una verificación de seguridad. Andá a la ventana de Chrome que abrió el scraper y tildá el casillero; sigue solo.'
    : s.attention === 'pausa' ? 'En pausa por un problema (verificación sin resolver o fallas de conexión). Reintenta solo en unos minutos.'
    : '';
  banner.textContent = text;
  banner.classList.toggle('show', Boolean(text));
  document.title = (s.attention === 'verificacion' ? '⚠ Verificación · ' : '') + 'ZonaProp CABA · Precios de departamentos';
  if (running && !wasRunning) $('log-box').open = true;
  wasRunning = running;
  window.dispatchEvent(new CustomEvent('scraper-status', { detail: { ...s, connected, label: pill.textContent, cls: pill.className } }));

  const c = s.current;
  $('now').textContent = !running || !c ? ''
    : c.slug ? `${c.slug} · página ${c.page}${c.pages ? ' de ' + fmt(c.pages) : ''}${c.total ? ' · ' + fmt(c.total) + ' avisos en esta búsqueda' : ''}${s.queue ? ' · ' + s.queue + ' en cola' : ''}`
    : `Ficha del aviso ${c.id}`;

  $('s-listings').textContent = fmt(s.listings);
  $('s-details').textContent = fmt(s.details);
  $('s-pending').textContent = fmt(s.detailsPending);
  $('s-searches').textContent = fmt(s.searchesDone);
  $('s-failures').textContent = fmt(s.failures);
  $('s-new-listings').textContent = [s.newListings ? `+${fmt(s.newListings)}` : '', s.changedListings ? `${fmt(s.changedListings)} con cambios` : ''].filter(Boolean).join(' · ');
  $('s-new-details').textContent = s.newDetails ? `+${fmt(s.newDetails)}` : '';

  const hours = s.startedAt ? ((s.finishedAt ? new Date(s.finishedAt) : new Date()) - new Date(s.startedAt)) / 3.6e6 : 0;
  const fichas = s.phase === 'fichas';
  const count = fichas ? s.newDetails : s.newListings;
  $('s-rate').textContent = hours > 0.01 && count ? fmt(Math.round(count / hours)) : '–';
  $('s-rate-label').textContent = fichas ? 'fichas por hora' : 'avisos nuevos por hora';

  $('start').disabled = running || !connected;
  $('stop').disabled = s.state !== 'running';
  $('reset').disabled = running;
  for (const el of $('form').querySelectorAll('input, textarea, button')) el.disabled = running;
}

const logEl = $('log');
function addLog(lines) {
  const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  logEl.append(lines.join('\n') + '\n');
  while (logEl.childNodes.length > 1500) logEl.firstChild.remove();
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

// --- Acciones --------------------------------------------------------------------------------
const act = (fn) => async () => { try { await fn(); } catch (e) { addLog([`✖ ${e.message}`]); } };

$('start').addEventListener('click', act(async () => {
  clearTimeout(saveTimer);
  status = (await api('/api/start', readForm())).status;
  render();
}));
$('stop').addEventListener('click', act(async () => { status = (await api('/api/stop')).status; render(); }));
$('open-data').addEventListener('click', act(() => api('/api/open-data')));
$('reset').addEventListener('click', act(async () => {
  if (!confirm('La próxima corrida va a recorrer de nuevo todas las búsquedas. Los avisos ya guardados no se borran. ¿Seguir?')) return;
  status = (await api('/api/reset-exploration')).status;
  render();
}));
$('shutdown').addEventListener('click', act(async () => {
  if (status.state !== 'idle' && !confirm('Hay una corrida en curso. ¿Detenerla y cerrar el programa?')) return;
  await api('/api/shutdown');
  document.body.innerHTML = '<p style="padding:40px;text-align:center">El programa se cerró. Ya podés cerrar esta pestaña.</p>';
}));

// --- Arranque --------------------------------------------------------------------------------
async function boot() {
  const state = await (await fetch('/api/state')).json();
  fillForm(state.settings, state.options);
  $('data-dir').textContent = `Carpeta: ${state.dataDir}`;
  logEl.textContent = '';
  addLog(state.log);
  status = state.status;
  connected = true;
  render();

  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => { connected = true; status = JSON.parse(e.data); render(); });
  es.addEventListener('log', (e) => addLog([JSON.parse(e.data)]));
  es.onopen = () => { connected = true; render(); };
  es.onerror = () => { connected = false; render(); };
}
boot().catch(() => { connected = false; render(); });
setInterval(render, 5000); // el ritmo por hora avanza aunque no lleguen eventos
})();
