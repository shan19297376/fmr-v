/**
 * Vishal AI — the shell.
 *
 * Everything here is app-agnostic: who you are, which apps you may open,
 * routing and the back button, the person switcher, and the handful of helpers
 * every app needs (fetching, caching, dates, bottom sheets).
 *
 * An app is a module exporting a manifest. It never touches the header, the
 * navigation or the router directly — it declares its screens and the shell
 * draws the chrome. Adding a second app is a new file and one line in APPS.
 */

/* ---------- helpers every app uses ---------- */

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Dates are stored ISO and shown dd-mmm-yyyy. Decided here, nowhere else. */
export const fmt = (iso) => {
  const m = String(iso ?? '').slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '-' + MONTHS[+m[2]-1] + '-' + m[1] : (iso || '');
};
export const fmtShort = (iso) => {
  const m = String(iso ?? '').slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + ' ' + MONTHS[+m[2]-1] + " '" + m[1].slice(2) : (iso || '');
};
export const rel = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? '').slice(0,10))) return '';
  const d = Math.round((Date.parse(iso) - Date.parse(new Date().toISOString().slice(0,10)))/864e5);
  if (d === 0) return 'today';
  const n = Math.abs(d);
  const u = n === 1 ? '1 day' : n < 31 ? n+' days'
    : n < 365 ? Math.round(n/30)+' months' : (n/365).toFixed(1)+' years';
  return d > 0 ? 'in '+u : u+' ago';
};

export async function api(path, opts) {
  const res = await fetch(path, { credentials:'same-origin', ...opts });
  const ct = res.headers.get('Content-Type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || res.statusText);
  return body;
}
export const post = (p,b) => api(p, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b)});
export const put  = (p,b) => api(p, {method:'PUT',  headers:{'Content-Type':'application/json'}, body:JSON.stringify(b)});
export const del  = (p)   => api(p, {method:'DELETE'});

/** Paints from cache at once, refreshes behind you. Tab switching stays instant. */
const cache = new Map();
export async function cachedGet(path) {
  const hit = cache.get(path);
  const fresh = api(path).then((d) => { cache.set(path, d); return d; });
  if (hit !== undefined) { fresh.catch(() => {}); return hit; }
  return fresh;
}
export const bust = (part) => [...cache.keys()].forEach((k) => { if (k.includes(part)) cache.delete(k); });
export const clearCache = () => { cache.clear(); warmed.clear(); };

export const setStatus = (id, text, cls) => {
  const el = $(id); if (el) { el.className = 'status'+(cls?' '+cls:''); el.textContent = text; }
};
export const skeleton = (n) => '<div class="sk">' +
  Array.from({length:n||3}, () => '<div></div><div></div><div></div>').join('') + '</div>';

export function sheet(html) {
  $('sheetHost').innerHTML =
    '<div class="veil" id="veil"><div class="modal"><div class="grab"></div>' + html + '</div></div>';
  $('veil').onclick = (e) => { if (e.target.id === 'veil') closeSheet(); };
  const c = $('closeSheet'); if (c) c.onclick = closeSheet;
  const first = $('sheetHost').querySelector('input,select,textarea');
  if (first && window.innerWidth > 600) first.focus();
}
export const closeSheet = () => { $('sheetHost').innerHTML = ''; };

// Escape closes whatever is open. Registered once, not per sheet.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('sheetHost').innerHTML) closeSheet();
});

/**
 * Actions belong at the top of a sheet, where they are reachable with a thumb
 * and visible without scrolling past a long form.
 */
export function actions(buttons) {
  return '<div class="actions">' + buttons.map((b) =>
    '<button class="' + (b.kind || 'ghost') + (b.danger ? ' danger' : '') + '"' +
    (b.id ? ' id="' + b.id + '"' : '') + (b.right ? ' style="margin-left:auto"' : '') + '>' +
    esc(b.label) + '</button>').join('') + '</div>';
}

/** Downloads go through fetch so a failure arrives as a sentence. */
export async function download(path, button, statusId) {
  const original = button.textContent;
  button.disabled = true; button.textContent = 'Preparing\u2026';
  try {
    const res = await fetch(path, { credentials:'same-origin' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Export failed.'); }
    const match = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    const name = match ? match[1] : 'export';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const inc = res.headers.get('X-Documents-Included');
    setStatus(statusId, inc
      ? 'Saved '+name+' \u2014 '+inc+' of '+res.headers.get('X-Documents-Total')+' documents.'
      : 'Saved '+name+'.', 'ok');
  } catch (err) { setStatus(statusId, err.message, 'err'); }
  finally { button.disabled = false; button.textContent = original; }
}

/* ---------- shared state ---------- */

export const state = { account:null, people:[], current:null, app:null };
export const person = () => state.people.find((p) => p.person_id === state.current) || {};

/* ---------- app registry ---------- */

import health from './apps/health.js';

/** One line per app. Everything else about it lives in its own module. */
const APPS = { health };

const ICONS = {
  heart: 'M12 20s-7-4.6-7-9.4A4 4 0 0112 8a4 4 0 017 2.6C19 15.4 12 20 12 20z',
  wallet: 'M4 8h14a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-1-3.9V8zM4 8V6.5A1.5 1.5 0 015.5 5H16',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
};

/* ---------- routing ---------- */

/** URL shape: #/health/tests?parameter=HbA1c — app, screen, params. */
export function go(screen, params, replace) {
  const q = new URLSearchParams(params || {}).toString();
  const url = '#/' + state.app.id + '/' + screen + (q ? '?' + q : '');
  if (replace) history.replaceState({}, '', url); else history.pushState({}, '', url);
  route();
}

function parseHash() {
  const raw = location.hash.slice(1);
  const [path, qs] = raw.split('?');
  const [, appId, screen] = path.split('/');
  return { appId, screen, params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

const warmed = new Set();

export async function refresh() { return route(); }

async function route() {
  const { appId, screen, params } = parseHash();
  const app = APPS[appId] || APPS[localStorage.getItem('lastApp')] || APPS.health;

  if (!state.app || state.app.id !== app.id) {
    state.app = app;
    localStorage.setItem('lastApp', app.id);
    paintNav();
  }

  const def = app.screens[screen] || app.screens[app.home];
  $('htitle').textContent = def.title;
  $('back').hidden = !def.deep;
  $('people').hidden = def.hidePeople === true || !state.people.length;
  [...$('nav').children].forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === def.tab));
  window.scrollTo(0, 0);

  const key = app.id + '/' + screen;
  if (!warmed.has(key)) { $('main').innerHTML = skeleton(3); warmed.add(key); }

  try { await def.render(params); }
  catch (err) { $('main').innerHTML = '<div class="empty">' + esc(err.message) + '</div>'; }
}

function paintNav() {
  $('nav').innerHTML = state.app.tabs.map(([id, label, path]) =>
    '<button data-tab="'+id+'" data-screen="'+id+'">' +
    '<svg viewBox="0 0 24 24"><path d="'+path+'"/></svg><span>'+label+'</span></button>').join('');
  $('nav').onclick = (e) => {
    const b = e.target.closest('[data-screen]');
    if (b) go(b.dataset.screen);
  };
}

window.addEventListener('popstate', route);

/* ---------- people, shared across apps ---------- */

export function paintPeople() {
  $('people').innerHTML = state.people.map((p) =>
    '<button data-id="'+p.person_id+'" aria-pressed="'+(p.person_id===state.current)+'">'+esc(p.name)+'</button>'
  ).join('') + '<button class="new" data-add="1">+ Person</button>';

  $('people').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.add) return addPerson();
    if (b.dataset.id === state.current) return personSheet(b.dataset.id);
    state.current = b.dataset.id;
    localStorage.setItem('lastPerson', state.current);
    [...$('people').children].forEach((x) => x.setAttribute('aria-pressed', x.dataset.id === state.current));
    clearCache(); route();
  };
  $('people').oncontextmenu = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) { e.preventDefault(); personSheet(b.dataset.id); }
  };
}

async function addPerson() {
  const name = prompt('Name of the family member');
  if (!name) return;
  try {
    const r = await post('/api/core/people', { name });
    state.current = r.personId;
    await refreshPeople();
  } catch (err) { alert(err.message); }
}

/** Rename, or merge a duplicate the reader created from a misread name. */
export function personSheet(id) {
  const p = state.people.find((x) => x.person_id === id) || {};
  const others = state.people.filter((x) => x.person_id !== id);
  sheet('<h3>' + esc(p.name) + '</h3>' +
    '<div class="field"><label for="pnName">Name</label><input type="text" id="pnName" value="'+esc(p.name)+'"></div>' +
    '<div class="field"><button class="go" id="pnSave">Save name</button>' +
    '<button class="ghost" id="closeSheet">Close</button></div>' +
    (others.length
      ? '<div class="sub" style="margin-top:16px">If this is the same person as someone else, merge them. ' +
        'Everything moves across and nothing is lost.</div>' +
        '<div class="field"><label for="pnMerge">Merge into</label><select id="pnMerge">' +
        '<option value="">Choose\u2026</option>' +
        others.map((o) => '<option value="'+o.person_id+'">'+esc(o.name)+'</option>').join('') +
        '</select><button class="ghost danger" id="pnMergeGo">Merge</button></div>' : '') +
    '<div class="status" id="pnStatus"></div>');

  $('pnSave').onclick = async () => {
    try { await put('/api/core/people/' + id, { name: $('pnName').value });
      await refreshPeople(); closeSheet();
    } catch (err) { setStatus('pnStatus', err.message, 'err'); }
  };
  if ($('pnMergeGo')) $('pnMergeGo').onclick = async () => {
    const into = $('pnMerge').value;
    if (!into) return setStatus('pnStatus', 'Choose who to merge into.', 'err');
    const name = (state.people.find((x) => x.person_id === into) || {}).name;
    if (!confirm('Move everything from ' + p.name + ' into ' + name + '?')) return;
    try {
      await post('/api/core/people/' + id + '/merge', { into });
      state.current = into; await refreshPeople(); closeSheet();
    } catch (err) { setStatus('pnStatus', err.message, 'err'); }
  };
}

export async function refreshPeople() {
  clearCache();
  state.account = await api('/api/core/bootstrap');
  state.people = state.account.people;
  if (!state.people.some((p) => p.person_id === state.current)) {
    state.current = state.people[0] ? state.people[0].person_id : null;
  }
  paintPeople(); route();
}

/* ---------- launcher ---------- */

function launcher() {
  const list = (state.account.apps || []).map((a) =>
    '<button class="appcard" data-app="'+a.app_id+'">' +
    '<span class="ic"><svg viewBox="0 0 24 24"><path d="'+(ICONS[a.icon] || ICONS.heart)+
      '" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
    '<span><b>'+esc(a.name)+'</b><span>'+esc(a.tagline || '')+'</span></span></button>').join('');

  // Placeholders are deliberate: the shell is built for more than one app, and
  // showing that is the point of having a launcher at all.
  const soon = [['wallet','Meridian Desk','Trading and positions'],
                ['shield','Regulatory Monitor','Filings and deadlines']]
    .map(([icon,name,tag]) =>
      '<div class="appcard soon"><span class="ic"><svg viewBox="0 0 24 24"><path d="'+ICONS[icon]+
      '" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
      '<span><b>'+name+'</b><span>'+tag+'</span></span><span class="tag">soon</span></div>').join('');

  $('sheetHost').innerHTML =
    '<div class="launcher" id="veil"><div class="sheet">' +
    '<h3>Vishal AI</h3><p class="who">' + esc(state.account.email) + '</p>' +
    list + soon +
    '<div class="field" style="margin-top:14px"><button class="ghost" id="closeSheet">Close</button></div>' +
    '</div></div>';

  $('veil').onclick = (e) => { if (e.target.id === 'veil') closeSheet(); };
  $('closeSheet').onclick = closeSheet;
  $('sheetHost').querySelectorAll('[data-app]').forEach((b) => {
    b.onclick = () => { closeSheet(); location.hash = '#/' + b.dataset.app + '/'; };
  });
}

/* ---------- boot ---------- */

async function boot() {
  try {
    state.account = await api('/api/core/bootstrap');
    state.people = state.account.people;
    state.current = localStorage.getItem('lastPerson');
    if (!state.people.some((p) => p.person_id === state.current)) {
      state.current = state.people[0] ? state.people[0].person_id : null;
    }

    $('avatar').textContent = (state.account.email[0] || '?').toUpperCase();
    $('avatar').onclick = launcher;
    $('back').onclick = () => history.back();

    paintPeople();
    if (!location.hash) {
      const last = localStorage.getItem('lastApp') || 'health';
      history.replaceState({}, '', '#/' + last + '/');
    }
    route();
  } catch (err) {
    $('main').innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
  }
}

boot();
