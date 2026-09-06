/**
 * Family Health Records application shell.
 *
 * Authentication, routing, responsive navigation, family switching and shared
 * UI helpers live here. The health module declares screens; this shell renders
 * them without owning medical-domain behaviour.
 */

/* ---------- shared helpers ---------- */

export const $ = (id) => document.getElementById(id);
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export const fmt = (iso) => {
  const match = String(iso ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}-${MONTHS[Number(match[2]) - 1]}-${match[1]}` : String(iso || '');
};

export const fmtShort = (iso) => {
  const match = String(iso ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]} ${MONTHS[Number(match[2]) - 1]} '${match[1].slice(2)}` : String(iso || '');
};

export const rel = (iso) => {
  const value = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const today = state.account?.today || new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(value) - Date.parse(today)) / 864e5);
  if (days === 0) return 'today';
  const n = Math.abs(days);
  const unit = n === 1 ? '1 day' : n < 31 ? `${n} days`
    : n < 365 ? `${Math.round(n / 30)} months` : `${(n / 365).toFixed(1)} years`;
  return days > 0 ? `in ${unit}` : `${unit} ago`;
};

const API_TIMEOUT_MS = 30000;

export async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      signal: options.signal || controller.signal,
    });
    const contentType = response.headers.get('Content-Type') || '';
    let body;
    if (contentType.includes('json')) body = await response.json().catch(() => ({}));
    else body = await response.text();

    if (!response.ok) {
      const message = body && typeof body === 'object' ? body.error : body;
      throw new Error(message || `Request failed (${response.status}).`);
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('The server took too long to respond. Check the connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body ?? {}),
});
export const put = (path, body) => api(path, {
  method: 'PUT', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body ?? {}),
});
export const del = (path) => api(path, { method:'DELETE' });

const cache = new Map();
const warmed = new Set();

export async function cachedGet(path) {
  const hit = cache.get(path);
  const fresh = api(path).then((data) => {
    cache.set(path, data);
    return data;
  });
  if (hit !== undefined) {
    fresh.catch(() => {});
    return hit;
  }
  return fresh;
}

export const bust = (part) => {
  for (const key of cache.keys()) if (key.includes(part)) cache.delete(key);
};
export const clearCache = () => {
  cache.clear();
  warmed.clear();
};

export const setStatus = (id, text, className) => {
  const node = $(id);
  if (!node) return;
  node.className = `status${className ? ` ${className}` : ''}`;
  node.textContent = text || '';
};

export const skeleton = (count = 3) => '<div class="sk">' +
  Array.from({ length: count }, () => '<div></div><div></div><div></div>').join('') + '</div>';

let restoreFocus = null;

export function sheet(html) {
  restoreFocus = document.activeElement;
  $('sheetHost').innerHTML =
    '<div class="veil" id="veil" role="presentation"><div class="modal" role="dialog" aria-modal="true">' +
    '<div class="grab" aria-hidden="true"></div>' + html + '</div></div>';
  $('veil').onclick = (event) => {
    if (event.target.id === 'veil') closeSheet();
  };
  const close = $('closeSheet');
  if (close) close.onclick = closeSheet;
  const first = $('sheetHost').querySelector('input,select,textarea,button');
  if (first && window.innerWidth > 600) first.focus();
}

export function closeSheet() {
  $('sheetHost').innerHTML = '';
  if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
  restoreFocus = null;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('sheetHost').innerHTML) closeSheet();
});

export function actions(buttons) {
  return '<div class="actions">' + buttons.map((button) =>
    '<button type="button" class="' + (button.kind || 'ghost') + (button.danger ? ' danger' : '') + '"' +
    (button.id ? ` id="${esc(button.id)}"` : '') + (button.right ? ' style="margin-left:auto"' : '') + '>' +
    esc(button.label) + '</button>').join('') + '</div>';
}

export async function download(path, button, statusId) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const response = await fetch(path, { credentials:'same-origin' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Export failed.');
    }
    const match = (response.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const name = match ? match[1] : 'export';
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const included = response.headers.get('X-Documents-Included');
    setStatus(statusId, included
      ? `Saved ${name} — ${included} of ${response.headers.get('X-Documents-Total')} documents.`
      : `Saved ${name}.`, 'ok');
  } catch (error) {
    setStatus(statusId, error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------- state and app registry ---------- */

export const state = { account:null, people:[], current:null, app:null };
export const person = () => state.people.find((item) => item.person_id === state.current) || {};

// This is intentionally unversioned. health.js imports this exact same module;
// adding a query string here creates a second shell module and breaks the cycle.
import health from './apps/health.js';

const APPS = { health };

const ICONS = {
  heart: 'M12 20s-7-4.6-7-9.4A4 4 0 0112 8a4 4 0 017 2.6C19 15.4 12 20 12 20z',
};

/* ---------- routing ---------- */

export function go(screen, params, replace = false) {
  const app = state.app || APPS.health;
  const query = new URLSearchParams(params || {}).toString();
  const url = `#/${app.id}/${screen}${query ? `?${query}` : ''}`;
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  route();
}

function parseHash() {
  const raw = location.hash.slice(1);
  const [path, query] = raw.split('?');
  const [, appId, screen] = path.split('/');
  return { appId, screen, params: Object.fromEntries(new URLSearchParams(query || '')) };
}

function setReady() {
  const main = $('main');
  if (!main) return;
  main.dataset.ready = 'true';
  main.setAttribute('aria-busy', 'false');
  if (window.__FMR_BOOT_TIMER__) clearTimeout(window.__FMR_BOOT_TIMER__);
}

function routeError(error) {
  const message = esc(error?.message || 'This screen could not be opened.');
  $('main').innerHTML = '<div class="boot-error"><div class="boot-error-icon">!</div>' +
    '<h2>This screen could not be opened</h2><p>' + message + '</p>' +
    '<button type="button" id="retryScreen">Try again</button></div>';
  const retry = $('retryScreen');
  if (retry) retry.onclick = () => { clearCache(); route(); };
  setReady();
}

export async function refresh() {
  return route();
}

async function route() {
  if (!state.account) return;
  const { appId, screen, params } = parseHash();
  const remembered = localStorage.getItem('lastApp');
  const app = APPS[appId] || APPS[remembered] || APPS.health;

  if (!state.app || state.app.id !== app.id) {
    state.app = app;
    localStorage.setItem('lastApp', app.id);
    paintNav();
  }

  const screenId = app.screens[screen] ? screen : app.home;
  const definition = app.screens[screenId];
  document.body.dataset.screen = definition.layout || definition.tab || screenId;
  $('htitle').textContent = definition.title;
  $('back').hidden = !definition.deep;
  $('people').hidden = definition.hidePeople === true || !state.people.length;
  for (const button of $('nav').children) {
    button.setAttribute('aria-selected', String(button.dataset.tab === definition.tab));
  }
  window.scrollTo(0, 0);

  const key = `${app.id}/${screenId}`;
  $('main').dataset.ready = 'false';
  $('main').setAttribute('aria-busy', 'true');
  if (!warmed.has(key)) {
    $('main').innerHTML = skeleton(4);
    warmed.add(key);
  }

  try {
    await definition.render(params);
    setReady();
  } catch (error) {
    console.error('screen render failed', error);
    routeError(error);
  }
}

function paintNav() {
  $('nav').innerHTML = state.app.tabs.map(([id, label, path]) =>
    `<button type="button" data-tab="${id}" data-screen="${id}" aria-selected="false">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg><span>${esc(label)}</span></button>`
  ).join('');
  $('nav').onclick = (event) => {
    const button = event.target.closest('[data-screen]');
    if (button) go(button.dataset.screen);
  };
}

window.addEventListener('popstate', route);

/* ---------- family switching ---------- */

export function paintPeople() {
  const canAdd = state.account?.role === 'owner';
  $('people').innerHTML = state.people.map((item) =>
    `<button type="button" data-id="${item.person_id}" aria-pressed="${item.person_id === state.current}">${esc(item.name)}</button>`
  ).join('') + (canAdd ? '<button type="button" class="new" data-add="1">+ Add person</button>' : '');

  $('people').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.add) return addPerson();
    if (button.dataset.id === state.current) return personSheet(button.dataset.id);
    state.current = button.dataset.id;
    localStorage.setItem('lastPerson', state.current);
    for (const item of $('people').children) {
      item.setAttribute('aria-pressed', String(item.dataset.id === state.current));
    }
    clearCache();
    route();
  };
}

async function addPerson() {
  sheet('<h3>Add a family member</h3>' + actions([
    { id:'addPersonSave', label:'Add person', kind:'go' },
    { id:'closeSheet', label:'Cancel' },
  ]) + '<div class="field"><label for="addPersonName">Name</label>' +
  '<input type="text" id="addPersonName" autocomplete="name" placeholder="Full name"></div>' +
  '<div class="status" id="addPersonStatus"></div>');

  $('addPersonSave').onclick = async () => {
    try {
      const result = await post('/api/core/people', { name:$('addPersonName').value });
      state.current = result.personId;
      localStorage.setItem('lastPerson', state.current);
      await refreshPeople();
      closeSheet();
    } catch (error) {
      setStatus('addPersonStatus', error.message, 'err');
    }
  };
}

export function personSheet(id) {
  const selected = state.people.find((item) => item.person_id === id) || {};
  const others = state.people.filter((item) => item.person_id !== id);
  sheet('<h3>' + esc(selected.name) + '</h3>' + actions([
    { id:'pnSave', label:'Save name', kind:'go' },
    { id:'closeSheet', label:'Close' },
  ]) + '<div class="field"><label for="pnName">Name</label>' +
    `<input type="text" id="pnName" value="${esc(selected.name)}"></div>` +
    (state.account?.role === 'owner' && others.length
      ? '<details class="review-section"><summary>Merge a duplicate person</summary><div class="review-rows">' +
        '<p class="sub">Use only when both entries are the same person.</p>' +
        '<div class="field"><label for="pnMerge">Merge into</label><select id="pnMerge">' +
        '<option value="">Choose…</option>' + others.map((item) =>
          `<option value="${item.person_id}">${esc(item.name)}</option>`).join('') + '</select></div>' +
        '<button type="button" class="ghost danger" id="pnMergeGo">Merge records</button></div></details>' : '') +
    '<div class="status" id="pnStatus"></div>');

  $('pnSave').onclick = async () => {
    try {
      await put(`/api/core/people/${id}`, { name:$('pnName').value });
      await refreshPeople();
      closeSheet();
    } catch (error) {
      setStatus('pnStatus', error.message, 'err');
    }
  };

  if ($('pnMergeGo')) $('pnMergeGo').onclick = async () => {
    const into = $('pnMerge').value;
    if (!into) return setStatus('pnStatus', 'Choose the person to keep.', 'err');
    const target = state.people.find((item) => item.person_id === into)?.name || 'the selected person';
    if (!confirm(`Move all records from ${selected.name} into ${target}?`)) return;
    try {
      await post(`/api/core/people/${id}/merge`, { into });
      state.current = into;
      localStorage.setItem('lastPerson', into);
      await refreshPeople();
      closeSheet();
    } catch (error) {
      setStatus('pnStatus', error.message, 'err');
    }
  };
}

export async function refreshPeople() {
  clearCache();
  state.account = await api('/api/core/bootstrap');
  state.people = state.account.people || [];
  if (!state.people.some((item) => item.person_id === state.current)) {
    state.current = state.people[0]?.person_id || null;
  }
  paintPeople();
  await route();
}

/* ---------- account panel ---------- */

function launcher() {
  const app = state.account.apps?.[0] || {
    app_id:'health', name:'Family Health Records', tagline:'Reports, medicines, trends', icon:'heart',
  };
  $('sheetHost').innerHTML = '<div class="launcher" id="veil"><div class="sheet">' +
    '<h3>Family Health Records</h3><p class="who">' + esc(state.account.email) +
    ' · ' + esc(state.account.role) + '</p>' +
    '<button type="button" class="appcard" data-app="health"><span class="ic">' +
      `<svg viewBox="0 0 24 24"><path d="${ICONS[app.icon] || ICONS.heart}"/></svg></span>` +
      '<span><b>' + esc(app.name) + '</b><span>' + esc(app.tagline || '') + '</span></span></button>' +
    '<div class="field" style="margin-top:14px"><button type="button" class="ghost" id="closeSheet">Close</button></div>' +
    '</div></div>';
  $('veil').onclick = (event) => { if (event.target.id === 'veil') closeSheet(); };
  $('closeSheet').onclick = closeSheet;
  $('sheetHost').querySelector('[data-app]').onclick = () => {
    closeSheet();
    location.hash = '#/health/overview';
  };
}

/* ---------- boot ---------- */

async function boot() {
  try {
    state.account = await api('/api/core/bootstrap');
    state.people = state.account.people || [];
    state.current = localStorage.getItem('lastPerson');
    if (!state.people.some((item) => item.person_id === state.current)) {
      state.current = state.people[0]?.person_id || null;
    }

    $('avatar').textContent = (state.account.email?.[0] || '?').toUpperCase();
    $('avatar').onclick = launcher;
    $('back').onclick = () => history.back();
    paintPeople();

    if (!location.hash) history.replaceState({}, '', '#/health/overview');
    await route();
  } catch (error) {
    console.error('app boot failed', error);
    const message = error?.message || 'The app could not connect.';
    if (window.__showFmrBootError) window.__showFmrBootError(message);
    else routeError(error);
  }
}

boot();
