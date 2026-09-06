import { pathToFileURL } from 'node:url';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.innerHTML = id === 'main' ? '<div class="empty">Loading…</div>' : '';
    this.textContent = '';
    this.hidden = false;
    this.children = [];
    this.dataset = {};
    this.files = [];
    this.value = '';
    this.className = '';
    this.style = {};
  }
  setAttribute(name, value) { if (name.startsWith('data-')) this.dataset[name.slice(5)] = value; }
  removeAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  insertAdjacentHTML() {}
  insertBefore() {}
  appendChild() {}
  remove() {}
  addEventListener() {}
  focus() {}
  click() {}
  closest() { return null; }
}

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
};
for (const id of ['main', 'sheetHost', 'nav', 'htitle', 'back', 'people', 'avatar']) element(id);

globalThis.document = {
  getElementById: element,
  createElement: (tag) => new FakeElement(tag),
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: new FakeElement('body'),
  activeElement: null,
};
globalThis.window = {
  innerWidth: 1024,
  addEventListener() {},
  scrollTo() {},
  open() {},
};
globalThis.history = {
  pushState(_s, _t, url) { globalThis.location.hash = String(url).split('#')[1] ? '#' + String(url).split('#')[1] : ''; },
  replaceState(_s, _t, url) { globalThis.location.hash = String(url).split('#')[1] ? '#' + String(url).split('#')[1] : ''; },
  back() {},
};
globalThis.location = { hash: '', href: 'https://example.test/' };
globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, String(value)); },
};
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.prompt = () => null;

globalThis.fetch = async (input) => {
  const path = String(input);
  let payload = {};
  if (path.includes('/api/core/bootstrap')) {
    payload = {
      email: 'owner@example.test', role: 'owner', today: '2026-09-06',
      people: [], pending: 0,
      apps: [{ app_id: 'health', name: 'Family Health Records', tagline: 'Reports, medicines, trends', icon: 'heart' }],
    };
  } else if (path.includes('/api/core/filed') || path.includes('/api/core/review')) {
    payload = [];
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const root = pathToFileURL(new URL('../public/shell.js', import.meta.url).pathname).href;
// Import the same unversioned URL that index.html uses. A query string here
// would deliberately create a second shell instance and reproduce the old bug.
await import(root);
await new Promise((resolve) => setTimeout(resolve, 50));

if (element('htitle').textContent === 'Loading') {
  throw new Error('Shell never completed routing; header is still Loading.');
}
if (element('main').innerHTML.includes('Loading')) {
  throw new Error('Shell never rendered the health screen; main is still Loading.');
}
if (element('main').dataset.ready !== 'true') {
  throw new Error('Shell rendered but did not mark the application ready.');
}
console.log('Browser module graph and application boot smoke test passed.');
