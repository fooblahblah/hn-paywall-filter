// Tests for what the Hacker News page offers someone who uses a keyboard or a screen
// reader, run under Node against a small stand-in for the page and for `chrome`.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// ---- a stand-in for the page ----

// One simple selector: a tag, classes, or both ("tr.athing", ".sitestr", "button").
function matchesSimple(node, sel) {
  const [tag, ...classes] = sel.split('.');
  return (!tag || node.tagName === tag) && classes.every((c) => node.classList.contains(c));
}

// A selector of simple ones joined by a space or " > ", matched from the right.
function matchesOne(node, sel) {
  const parts = sel.trim().split(/\s+/);
  const step = (n, i) => {
    if (!n || !matchesSimple(n, parts[i])) return false;
    if (i === 0) return true;
    if (parts[i - 1] === '>') return step(n.parentNode, i - 2);
    for (let p = n.parentNode; p; p = p.parentNode) if (step(p, i - 1)) return true;
    return false;
  };
  return step(node, parts.length - 1);
}

const matches = (node, selector) => selector.split(',').some((s) => matchesOne(node, s));

class Node {
  constructor(doc, tagName) {
    Object.assign(this, { doc, tagName, parentNode: null, childNodes: [], className: '', attrs: {}, dataset: {}, on: {} });
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (c) => names().includes(c),
      add: (c) => void (this.classList.contains(c) || (this.className = [...names(), c].join(' '))),
      remove: (c) => void (this.className = names().filter((n) => n !== c).join(' ')),
      toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
    };
  }
  get children() { return this.childNodes.filter((n) => n instanceof Node); }
  get isConnected() { return this === this.doc.documentElement || !!this.parentNode?.isConnected; }
  get textContent() { return this.childNodes.map((n) => (n instanceof Node ? n.textContent : n)).join(''); }
  set textContent(text) {
    for (const n of this.children) n.parentNode = null;
    this.childNodes = text ? [text] : [];
  }
  get nextElementSibling() { return this.#sibling(1); }
  get previousElementSibling() { return this.#sibling(-1); }
  #sibling(by) {
    const all = this.parentNode?.children || [];
    return all[all.indexOf(this) + by] || null;
  }
  #insert(at, nodes) {
    for (const n of nodes) if (n instanceof Node) (n.remove(), (n.parentNode = this));
    this.childNodes.splice(at, 0, ...nodes);
  }
  append(...nodes) { this.#insert(this.childNodes.length, nodes); }
  before(...nodes) { this.parentNode.#insert(this.parentNode.childNodes.indexOf(this), nodes); }
  after(...nodes) { this.parentNode.#insert(this.parentNode.childNodes.indexOf(this) + 1, nodes); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { this.on[type] = fn; }
  focus(options) { Object.assign(this.doc, { focused: this, focusOptions: options }); }
  // Everything is in view until the test scrolls the page away from it.
  getBoundingClientRect() { return this.doc.scrolledAway ? { top: -500, bottom: -490 } : { top: 100, bottom: 110 }; }
  matches(selector) { return matches(this, selector); }
  closest(selector) {
    for (let n = this; n; n = n.parentNode) if (matches(n, selector)) return n;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// Builds a listing the way Hacker News lays one out: a title row, a row of small print
// under it and a spacer per story, then the "More" link.
function listing(doc, urls) {
  const make = (tag, className, ...kids) => {
    const e = new Node(doc, tag);
    e.className = className;
    e.append(...kids);
    return e;
  };
  const table = make('table', '');
  for (const url of urls) {
    const link = make('a', '', `Story at ${url}`);
    link.href = url;
    const site = make('span', 'sitestr', new URL(url).hostname);
    table.append(
      make('tr', 'athing submission', make('td', 'title', make('span', 'titleline', link, site))),
      make('tr', '', make('td', 'subtext', '10 points')),
      make('tr', 'spacer'),
    );
  }
  table.append(make('tr', 'morespace'));
  return table;
}

// Loads hn.js into a fresh page at `path` listing `urls`. `sites`, `pages`, `redirects`
// and `settings` are what storage holds, which the page asks the service worker for; a
// "setSite" request is carried out the way the service worker would, and the page is told
// of the change. `loading` leaves the page arriving until `ready()`.
async function open({ urls, sites = {}, pages, redirects, settings = {}, path = '/news', prerendering = false, loading = false, refuseState = null }) {
  const on = {};
  const doc = { readyState: loading ? 'loading' : 'complete', focused: null, prerendering, addEventListener: (type, fn) => void (on[type] = fn) };
  doc.documentElement = new Node(doc, 'html');
  doc.body = new Node(doc, 'body');
  doc.documentElement.append(doc.body);
  doc.body.append(listing(doc, urls));
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused?.isConnected ? doc.focused : doc.body) });
  for (const m of ['querySelector', 'querySelectorAll']) doc[m] = (s) => doc.documentElement[m](s);
  doc.createElement = (tag) => new Node(doc, tag);

  const store = { sites: structuredClone(sites), settings, ...(pages && { pages }), ...(redirects && { redirects }) };
  const sent = [];
  // The service worker's notes to the page, and the page's answers to them.
  let listener;
  const answers = [];
  const tell = () => listener({ type: 'stateChanged' }, { id: 'hnpfextensionid' }, (res) => answers.push(structuredClone(res)));
  // What the page tried to reach of the extension's storage, which a browser denies it.
  const touched = [];
  let refusal = null;
  let stateRefusal = refuseState;
  let gone = false;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const ctx = vm.createContext({
    URL, console, setTimeout, clearTimeout,
    document: doc,
    location: { hostname: 'news.ycombinator.com', pathname: path },
    addEventListener: (type, fn) => void (on['window:' + type] = fn),
    innerHeight: 800,
    chrome: {
      get storage() {
        touched.push('storage');
        return undefined;
      },
      runtime: {
        get id() { return gone ? undefined : 'hnpfextensionid'; },
        onMessage: { addListener: (fn) => void (listener = fn) },
        // As in a browser: with the extension gone it throws, where otherwise it answers later.
        sendMessage: (message) => {
          if (gone) throw new Error('Extension context invalidated.');
          return deliver(message);
        },
      },
    },
  });
  async function deliver(message) {
    sent.push(structuredClone(message));
    if (message.type === 'getState') {
      if (stateRefusal) return { ok: false, error: stateRefusal };
      const { settings: stored, sites, pages = {}, redirects = {} } = store;
      return { ok: true, state: structuredClone({ settings: { visitDetect: false, bgCheck: false, display: 'hide', ...stored }, sites, pages, redirects }) };
    }
    if (refusal && message.type === 'setSite') return { ok: false, error: refusal };
    if (message.type === 'seenSites') for (const d of message.domains) store.sites[d].seen = true;
    else if (message.type !== 'setSite') return { ok: true };
    else for (const d of message.domains) store.sites[d] = { status: message.status, source: 'manual', at: Date.now() };
    tell();
    return { ok: true };
  }
  ctx.window = ctx;
  for (const f of ['seed.js', 'psl.js', 'shared.js', 'hn.js']) vm.runInContext(src(f), ctx, { filename: f });
  await settle();

  const controls = () => doc.querySelectorAll('button');
  return {
    doc, sent, controls, answers, touched,
    control: (label) => controls().find((b) => b.textContent === label),
    status: () => doc.querySelector('.hnpf-status'),
    // The list is changed from somewhere else: the popup, the options page, a detector.
    // `told: false` is a change the page is not told of.
    async change(entries, { told = true } = {}) {
      Object.assign(store.sites, entries);
      if (told) tell();
      await settle();
    },
    async changePages(entries) {
      Object.assign((store.pages ??= {}), entries);
      tell();
      await settle();
    },
    // The background check found where a story link leads.
    async changeRedirects(entries) {
      Object.assign((store.redirects ??= {}), entries);
      tell();
      await settle();
    },
    // From here on the service worker does not give the page the lists.
    refuseState: (error) => void (stateRefusal = error),
    // From here on the service worker turns "setSite" down.
    refuse: (error) => void (refusal = error),
    // The extension was reloaded or updated under the open page.
    reloadExtension: () => void (gone = true),
    async ready() {
      doc.readyState = 'interactive';
      on.DOMContentLoaded();
      await settle();
    },
    // The reader comes back to the page, which the browser kept for the Back button.
    async back() {
      on['window:pageshow']({ persisted: true });
      await settle();
    },
    // The reader arrives on a page the browser had loaded ahead of the visit.
    async activate() {
      on.prerenderingchange();
      await settle();
    },
    // The rows of the story that links to `url`, as [title row, small print].
    rows(url) {
      const title = doc.querySelectorAll('tr.athing').find((r) => r.querySelector('.titleline > a').href === url);
      return [title, title.nextElementSibling];
    },
    // What a click, Enter or Space on a focused control does.
    async press(control) {
      control.focus();
      await control.on.click({ preventDefault() {} });
      await settle();
    },
  };
}

const GATED = { 'gated.example': { status: 'gated', source: 'manual', at: 0 } };
// A site the detectors hid.
const FOUND = { status: 'gated', source: 'check', articles: 3, reason: '3 articles on this site looked gated', at: Date.now() };
const URLS = ['https://gated.example/a', 'https://free.example/b', 'https://other.example/c'];

test('hn: the controls are buttons, so a screen reader says so and Space works', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  assert.deepEqual(p.controls().map((b) => b.textContent).sort(), ['always show gated.example', 'edit list', 'mark gated', 'mark gated', 'show']);
  for (const b of p.controls()) assert.equal(b.type, 'button');
  // No link is left that goes nowhere.
  assert.deepEqual(p.doc.querySelectorAll('a').filter((a) => a.href === '#'), []);
});

test('hn: "show" and "hide" are announced, and focus stays on the control', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  const status = p.status();
  assert.equal(status.getAttribute('role'), 'status');
  // Nothing is said about the page as it loads.
  assert.equal(status.textContent, '');

  await p.press(p.control('show'));
  assert.equal(p.status(), status, 'the same region is kept, or nothing would be read out');
  assert.equal(status.textContent, '1 gated story shown');
  assert.equal(p.doc.activeElement, p.control('hide'));

  await p.press(p.control('hide'));
  assert.equal(status.textContent, '1 gated story hidden');
  assert.equal(p.doc.activeElement, p.control('show'));
});

test('hn: "mark gated" is announced, and focus moves to the next story left on the page', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  await p.press(p.controls().find((b) => b.textContent === 'mark gated'));
  assert.deepEqual(p.sent.find((m) => m.type === 'setSite'), { type: 'setSite', domains: ['free.example'], status: 'gated' });
  assert.equal(p.status().textContent, '2 gated stories hidden');
  assert.equal(p.doc.activeElement.href, 'https://other.example/c');
});

test('hn: with the last story marked gated, focus goes to the summary line', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  await p.press(p.controls().filter((b) => b.textContent === 'mark gated').at(-1));
  assert.equal(p.doc.activeElement, p.control('show'));
});

test('hn: in "dimmed and labelled" mode a marked story keeps the focus and is announced', async () => {
  const p = await open({ urls: URLS, sites: GATED, settings: { display: 'label' } });
  assert.equal(p.status().textContent, '');
  const mark = p.control('mark gated');
  const row = mark.closest('tr');
  await p.press(mark);
  assert.equal(p.status().textContent, '2 stories labelled gated');
  assert.equal(p.doc.activeElement, p.control('always show free.example'));
  assert.equal(p.doc.activeElement.closest('tr'), row);
});

test('hn: a refusal from the service worker is read out next to the control', async () => {
  const p = await open({ urls: URLS });
  p.refuse('not allowed');
  await p.press(p.control('mark gated'));
  const error = p.control('mark gated').nextElementSibling;
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.textContent, ' (not allowed)');
  // Refused again, it is said again: by a new element, since the same text in the old one is not.
  await p.press(p.control('mark gated'));
  const again = p.control('mark gated').nextElementSibling;
  assert.notEqual(again, error);
  assert.equal(again.textContent, ' (not allowed)');
  assert.equal(again.nextElementSibling, null);
});

test('hn: a change made elsewhere leaves the focus where it is', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  for (const find of [() => p.doc.querySelector('.titleline > a'), () => p.control('edit list')]) {
    find().focus();
    const label = find().textContent;
    await p.change({ 'other.example': { status: 'gated', source: 'manual', at: 0 } });
    assert.equal(p.doc.activeElement.textContent, label);
    await p.change({ 'other.example': { status: 'allowed', source: 'manual', at: 0 } });
  }
  assert.equal(p.status().textContent, '1 gated story hidden');
});

test('hn: a change made elsewhere does not scroll back to a control the reader has left', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  await p.press(p.control('show'));
  assert.equal(p.doc.focusOptions.preventScroll, false);
  p.doc.scrolledAway = true;
  await p.change({ 'other.example': { status: 'gated', source: 'manual', at: 0 } });
  assert.equal(p.doc.activeElement, p.control('hide'));
  assert.equal(p.doc.focusOptions.preventScroll, true);
});

test('hn: where a story is left with no control, focus goes to its title', async () => {
  // A platform many authors share: with the site set to always show, nothing is offered.
  const p = await open({ urls: [...URLS, 'https://medium.com/@someone/a'], sites: { 'medium.com': GATED['gated.example'] } });
  await p.press(p.control('show'));
  await p.press(p.control('always show medium.com'));
  assert.equal(p.doc.activeElement.href, 'https://medium.com/@someone/a');
});

test('hn: with the summary line gone, focus goes to the first story', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  p.control('show').focus();
  await p.change({ 'gated.example': { status: 'allowed', source: 'manual', at: 0 } });
  assert.equal(p.doc.activeElement.href, 'https://gated.example/a');
});

test('hn: the story at the top of its own page is labelled, and the control that replaces "mark gated" has the focus', async () => {
  const p = await open({ urls: ['https://free.example/b'] });
  p.doc.querySelector('table').className = 'fatitem';
  await p.change({});
  await p.press(p.control('mark gated'));
  assert.equal(p.status().textContent, '1 story labelled gated');
  assert.equal(p.doc.querySelector('.hnpf-summary'), null);
  assert.equal(p.doc.activeElement, p.control('always show free.example'));
});

test('hn: dismissing the note about a newly hidden site moves on to the next note, then to the list', async () => {
  const found = { status: 'gated', source: 'visit', articles: 3, reason: 'asks to subscribe', at: Date.now() };
  const p = await open({ urls: URLS, sites: { 'gated.example': found, 'other.example': { ...found } } });
  assert.equal(p.controls().filter((b) => b.textContent === 'ok').length, 2);
  // A change made elsewhere leaves the focus on the note it was on, though both say "ok".
  const second = () => p.controls().filter((b) => b.textContent === 'ok')[1];
  second().focus();
  await p.change({});
  assert.equal(p.doc.activeElement, second());
  await p.press(p.control('ok'));
  assert.equal(p.doc.activeElement, p.control('ok'));
  await p.press(p.control('ok'));
  assert.equal(p.control('ok'), undefined);
  // Not the summary line at the far end of the page.
  assert.equal(p.doc.activeElement.href, 'https://free.example/b');
});

// ---- where stories are hidden ----

const hidden = (p, url) => p.rows(url).every((r) => r.classList.contains('hnpf-gated')) && !p.doc.documentElement.classList.contains('hnpf-label');

test('hn: stories are hidden on the general listings', async () => {
  for (const path of ['/', '/news', '/newest', '/front', '/best', '/ask', '/show', '/shownew', '/active']) {
    const p = await open({ urls: URLS, sites: GATED, path });
    assert.ok(hidden(p, URLS[0]), path);
    assert.ok(p.control('show'), path);
    assert.deepEqual(p.sent.find((m) => m.type === 'hiddenCount'), { type: 'hiddenCount', count: 1 }, path);
  }
});

test('hn: on a list the reader built or asked for by name, gated stories are labelled, not hidden', async () => {
  for (const path of ['/favorites', '/upvoted', '/submitted', '/from', '/hidden', '/over', '/item', '/somethingnew']) {
    const p = await open({ urls: URLS, sites: GATED, path });
    assert.ok(!hidden(p, URLS[0]), path);
    assert.equal(p.doc.querySelector('.hnpf-tag').textContent, 'gated', path);
    assert.ok(p.control('always show gated.example'), path);
    assert.equal(p.doc.querySelector('.hnpf-summary'), null, path);
    // "mark gated" labels the story where it is.
    await p.press(p.control('mark gated'));
    assert.ok(!hidden(p, URLS[1]), path);
    assert.equal(p.status().textContent, '2 stories labelled gated', path);
  }
});

test('hn: rows are kept from view while the page loads only where stories may be hidden', async () => {
  for (const [path, pending] of [['/news', true], ['/jobs', true], ['/favorites', false], ['/from', false]]) {
    const p = await open({ urls: URLS, sites: GATED, path, loading: true });
    assert.equal(p.doc.documentElement.classList.contains('hnpf-pending'), pending, path);
    await p.ready();
    assert.equal(p.doc.documentElement.classList.contains('hnpf-pending'), false, path);
  }
});

test('hn: a change made before the page was there is drawn with it, and hides like the rest', async () => {
  const p = await open({ urls: URLS, sites: GATED, loading: true });
  await p.change({ 'free.example': { ...FOUND } });
  assert.equal(p.doc.querySelector('.hnpf-tag'), null, 'nothing is drawn before the page is there');
  await p.ready();
  assert.ok(hidden(p, URLS[1]));
  assert.equal(p.status().textContent, '');
});

// ---- what a detector finds while the page is open ----

test('hn: a story a detector finds gated after the page loaded is labelled where it is, not taken away', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  await p.change({ 'free.example': { ...FOUND } });
  assert.ok(hidden(p, URLS[0]));
  assert.ok(!hidden(p, URLS[1]), 'the row stays where the reader left it');
  const [title, small] = p.rows(URLS[1]);
  assert.ok(title.classList.contains('hnpf-late') && small.classList.contains('hnpf-late'));
  const tag = title.querySelector('.hnpf-tag');
  assert.equal(tag.textContent, 'gated');
  assert.match(tag.title, /next time/);
  assert.ok(p.control('always show free.example'));
  // The count on the summary line and the one read out say what was hidden and what was not.
  assert.match(p.doc.querySelector('.hnpf-summary').textContent, /^1 gated story hidden, 1 more labelled \| /);
  assert.equal(p.status().textContent, '1 gated story hidden, 1 more labelled');
  // The toolbar counts every gated story on the page.
  assert.deepEqual(p.sent.filter((m) => m.type === 'hiddenCount').at(-1), { type: 'hiddenCount', count: 2 });
  // It stays through later changes, and through "show" and "hide".
  await p.change({ 'other.example': { ...FOUND } });
  await p.press(p.control('show'));
  await p.press(p.control('hide'));
  assert.deepEqual([URLS[1], URLS[2]].map((u) => hidden(p, u)), [false, false]);
  assert.equal(p.status().textContent, '1 gated story hidden, 2 more labelled');
});

test('hn: a single article found gated after the page loaded is labelled too', async () => {
  const p = await open({ urls: URLS });
  await p.changePages({ 'free.example/b': { status: 'gated', source: 'check', reason: 'prompt', site: 'free.example', at: Date.now() } });
  assert.ok(!hidden(p, URLS[1]));
  assert.equal(p.rows(URLS[1])[0].querySelector('.hnpf-tag').textContent, 'gated');
  // With nothing hidden there is no summary line.
  assert.equal(p.doc.querySelector('.hnpf-summary'), null);
  assert.equal(p.status().textContent, '1 story labelled gated');
});

// A short link to an article on a site of the built-in list.
const SHORT = 'https://lnkd.in/abc123';
const LED = { 'lnkd.in/abc123': { to: 'https://www.nytimes.com/2026/a.html', at: Date.now() } };

test('hn: a story whose link leads to a gated page is hidden like that page', async () => {
  const p = await open({ urls: [...URLS, SHORT], redirects: LED });
  assert.ok(hidden(p, SHORT));
  assert.ok(p.control('always show nytimes.com'));
});

test('hn: a story found to lead to a gated page while the page is open is labelled where it is', async () => {
  const p = await open({ urls: [...URLS, SHORT] });
  assert.ok(!hidden(p, SHORT));
  await p.changeRedirects(LED);
  assert.ok(!hidden(p, SHORT), 'the row stays where the reader left it');
  assert.equal(p.rows(SHORT)[0].querySelector('.hnpf-tag').textContent, 'gated');
  assert.equal(p.status().textContent, '1 story labelled gated');
});

test('hn: a story found to lead to a page you hid yourself is labelled where it is, as the finding is new', async () => {
  const mine = { 'walled.example': { status: 'gated', source: 'manual', at: 0 } };
  const p = await open({ urls: [...URLS, SHORT], sites: mine });
  await p.changeRedirects({ 'lnkd.in/abc123': { to: 'https://walled.example/story', at: Date.now() } });
  assert.ok(!hidden(p, SHORT));
  assert.ok(p.rows(SHORT)[0].classList.contains('hnpf-late'));
});

test('hn: a story found to lead to a gated page stays labelled through later changes, until you hide that page', async () => {
  const p = await open({ urls: [...URLS, SHORT] });
  await p.changeRedirects(LED);
  await p.changePages({ 'free.example/b': { status: 'gated', source: 'check', reason: 'prompt', site: 'free.example', at: Date.now() } });
  assert.ok(!hidden(p, SHORT));
  assert.ok(p.rows(SHORT)[0].classList.contains('hnpf-late'));
  // What the reader hides goes at once.
  await p.change({ 'nytimes.com': { status: 'gated', source: 'manual', at: Date.now() } });
  assert.ok(hidden(p, SHORT));
});

test('hn: a story known to lead to a page goes at once when you hide that page', async () => {
  const redirects = { 'lnkd.in/abc123': { to: 'https://walled.example/story', at: Date.now() } };
  const p = await open({ urls: [...URLS, SHORT], redirects });
  assert.ok(!hidden(p, SHORT));
  await p.change({ 'walled.example': { status: 'gated', source: 'manual', at: Date.now() } });
  assert.ok(hidden(p, SHORT));
  assert.ok(!p.rows(SHORT)[0].classList.contains('hnpf-late'));
});

test('hn: the controls of a story act on the page its link leads to where that page decides', async () => {
  const led = (to) => ({ 'lnkd.in/abc123': { to, at: Date.now() } });
  const buttons = (p) => p.rows(SHORT)[1].querySelectorAll('button');
  // The last request sent, other than the count for the toolbar and asking for the lists.
  const last = (p) => p.sent.filter((m) => m.type !== 'hiddenCount' && m.type !== 'getState').at(-1);
  const always = (name) => ({ [name]: { status: 'allowed', source: 'manual', at: 1 } });

  // A page nothing decides on may be one the reader never sees, a consent page say:
  // "mark gated" hides the site Hacker News names next to the story.
  let p = await open({ urls: [...URLS, SHORT], redirects: led('https://blog.example/post') });
  let [mark] = buttons(p);
  assert.deepEqual([mark.textContent, mark.title], ['mark gated', 'Hide stories from lnkd.in']);

  // One that decides is the story's: "mark gated" hides its site, not the shortener.
  p = await open({ urls: [...URLS, SHORT], sites: always('blog.example'), redirects: led('https://blog.example/post') });
  [mark] = buttons(p);
  assert.deepEqual([mark.textContent, mark.title], ['mark gated', 'Hide stories from blog.example']);
  await p.press(mark);
  assert.deepEqual(last(p), { type: 'setSite', domains: ['blog.example'], status: 'gated' });

  // On a platform many authors share, the article it leads to.
  p = await open({ urls: [...URLS, SHORT], pages: always('medium.com/@someone/post'), redirects: led('https://medium.com/@someone/post') });
  [mark] = buttons(p);
  assert.equal(mark.textContent, 'hide this article');
  await p.press(mark);
  assert.deepEqual(last(p), { type: 'setPage', key: 'medium.com/@someone/post', status: 'gated' });

  // "show this article" on a site the detectors hid shows the page it leads to.
  p = await open({ urls: [...URLS, SHORT], sites: { 'walled.example': { ...FOUND } }, redirects: led('https://walled.example/story') });
  assert.deepEqual(buttons(p).map((b) => b.textContent), ['always show walled.example', 'show this article']);
  await p.press(buttons(p)[1]);
  assert.deepEqual(last(p), { type: 'setPage', key: 'walled.example/story', status: 'allowed' });
});

test('hn: what the reader hides is hidden at once, also where a detector had only labelled it', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  await p.change({ 'free.example': { ...FOUND } });
  await p.change({ 'free.example': { status: 'gated', source: 'manual', at: Date.now() } });
  assert.ok(hidden(p, URLS[1]));
  assert.equal(p.rows(URLS[1])[0].classList.contains('hnpf-late'), false);
  // And a story shown again is no longer labelled.
  await p.change({ 'free.example': { status: 'allowed', source: 'manual', at: Date.now() } });
  assert.equal(p.rows(URLS[1])[0].querySelector('.hnpf-tag'), null);
});

test('hn: a site the detectors hide while the page is open adds no line above the stories', async () => {
  const p = await open({ urls: URLS, sites: { 'gated.example': { ...FOUND } } });
  assert.equal(p.doc.querySelectorAll('.hnpf-notice').length, 1);
  await p.change({ 'free.example': { ...FOUND } });
  assert.deepEqual(p.doc.querySelectorAll('.hnpf-notice').map((n) => n.dataset.site), ['gated.example']);
});

test('hn: on a page loaded ahead of the visit, what was found before the reader arrived is hidden', async () => {
  const p = await open({ urls: URLS, sites: GATED, prerendering: true });
  await p.change({ 'free.example': { ...FOUND } });
  await p.activate();
  assert.ok(hidden(p, URLS[1]));
  assert.deepEqual(p.doc.querySelectorAll('.hnpf-notice').map((n) => n.dataset.site), ['free.example']);
  // From then on the reader is there.
  await p.change({ 'other.example': { ...FOUND } });
  assert.ok(!hidden(p, URLS[2]));
});

test('hn: on a page loaded ahead of the visit, a change it was not told of is there once the reader arrives', async () => {
  const p = await open({ urls: URLS, sites: GATED, prerendering: true });
  await p.change({ 'free.example': { status: 'gated', source: 'manual', at: Date.now() } }, { told: false });
  assert.ok(!hidden(p, URLS[1]));
  await p.activate();
  assert.ok(hidden(p, URLS[1]));
});

test('hn: a page loaded ahead of the visit that the reader reaches before it is drawn misses no change', async () => {
  const p = await open({ urls: URLS, prerendering: true, loading: true });
  await p.change({ 'free.example': { status: 'gated', source: 'manual', at: Date.now() } }, { told: false });
  await p.activate();
  await p.ready();
  assert.ok(hidden(p, URLS[1]));
});

test('hn: a page the browser kept for the Back button asks for the lists again when the reader comes back', async () => {
  const p = await open({ urls: URLS });
  await p.change({ 'free.example': { status: 'gated', source: 'manual', at: Date.now() } }, { told: false });
  const asked = p.sent.filter((m) => m.type === 'getState').length;
  await p.back();
  assert.ok(hidden(p, URLS[1]));
  // Which is also how the service worker learns that it is there to be told again.
  assert.equal(p.sent.filter((m) => m.type === 'getState').length, asked + 1);
});

// ---- where the lists come from (#28) ----

test('hn: the page asks the service worker for the lists, and reaches for no storage of its own', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  assert.equal(p.sent[0].type, 'getState');
  assert.ok(hidden(p, URLS[0]));
  await p.change({ 'free.example': { status: 'gated', source: 'manual', at: Date.now() } });
  assert.ok(hidden(p, URLS[1]));
  // It answers the note, so that the service worker knows it is still there to be told.
  assert.deepEqual(p.answers, [{ ok: true }]);
  assert.deepEqual(p.touched, []);
});

// ---- failures ----

test('hn: a page the service worker gives no lists shows its stories as they are', async () => {
  const errors = [];
  const { error } = console;
  console.error = (...args) => void errors.push(args);
  try {
    const p = await open({ urls: URLS, sites: GATED, refuseState: 'not allowed from this page' });
    assert.ok(!p.doc.documentElement.classList.contains('hnpf-pending'));
    assert.equal(p.doc.querySelector('.hnpf-tag'), null);
    assert.equal(errors.length, 1);
  } finally {
    console.error = error;
  }
});

test('hn: once the extension was reloaded, a control says so instead of doing nothing', async () => {
  const p = await open({ urls: URLS, sites: GATED });
  p.reloadExtension();
  for (const label of ['mark gated', 'edit list']) {
    await p.press(p.control(label));
    const error = p.control(label).nextElementSibling;
    assert.equal(error.getAttribute('role'), 'alert', label);
    assert.match(error.textContent, /reloaded or updated: reload this page/, label);
  }
  // "show" needs no extension.
  await p.press(p.control('show'));
  assert.equal(p.status().textContent, '1 gated story shown');
});

// ---- hn.css ----

const css = src('hn.css').replace(/\/\*[\s\S]*?\*\//g, '');
// Every rule as [selector, declarations], whatever @media block it sits in.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.replace(/\s+/g, ' ').trim(), body]);
const bodyOf = (selector) => rules.filter(([sel]) => sel.split(',').some((s) => s.trim() === selector)).map(([, b]) => b).join(';');

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const HN_BACKGROUND = '#f6f6ef';

test('hn.css: "mark gated" stays in the tab order and shows up when it has the focus', () => {
  const mark = bodyOf('.hnpf-mark');
  // A hidden element cannot be focused; a transparent one can.
  assert.doesNotMatch(mark, /visibility|display/);
  assert.match(mark, /opacity:\s*0\b/);
  const shown = rules.filter(([, body]) => /opacity:\s*1\b/.test(body)).map(([sel]) => sel).join(', ');
  // Focus counts like the pointer: on the title or anywhere in the small print under it.
  assert.match(shown, /tr\.athing:focus-within \+ tr \.hnpf-mark/);
  assert.match(shown, /tr:focus-within > td\.subtext \.hnpf-mark/);
  assert.match(shown, /:hover/);
  // Where there is no pointer to hover with, it is always there.
  // The same where a finger may tap it: it can then be pressed, so it has to be seen.
  assert.match(css, /@media\s*\(hover:\s*none\),\s*\(any-pointer:\s*coarse\)\s*\{\s*\.hnpf-mark\s*\{\s*opacity:\s*1/);
});

test('hn.css: every colour the extension sets reads at 4.5:1 or better on the HN background', () => {
  const colours = [...css.matchAll(/color:\s*(#[0-9a-f]{6})\b/gi)].map((m) => m[1]);
  assert.ok(colours.length >= 3);
  for (const c of colours) assert.ok(contrast(c, HN_BACKGROUND) >= 4.5, `${c} is ${contrast(c, HN_BACKGROUND).toFixed(2)}:1`);
});

test('hn.css: a gated title is dimmed with a colour, not with opacity, and a visited one is left alone', () => {
  const dimmed = rules.filter(([sel]) => /hnpf-gated .*titleline/.test(sel));
  assert.equal(dimmed.length, 1);
  const [selector, body] = dimmed[0];
  // A story labelled where it is looks the same.
  assert.match(selector, /tr\.hnpf-late \.titleline > a:link/);
  // Opacity would also fade the grey of a visited title, to under 2:1.
  assert.doesNotMatch(body, /opacity/);
  assert.match(body, /color:\s*#[0-9a-f]{6}/i);
  assert.match(selector, /a:link$/);
});

test('hn.css: the "gated" tag is larger than the 7pt small print', () => {
  const tag = bodyOf('.hnpf-tag');
  assert.doesNotMatch(tag, /font-size:\s*7pt/);
  assert.match(tag, /font-size:\s*0\.8em/);
});
