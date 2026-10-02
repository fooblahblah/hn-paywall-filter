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
    Object.assign(this, { doc, tagName, parentNode: null, childNodes: [], className: '', attrs: {}, on: {} });
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
  focus() { this.doc.focused = this; }
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

// Loads hn.js into a fresh page listing `urls`. `sites` and `settings` are what storage
// holds; a "setSite" request is carried out the way the service worker would.
async function open({ urls, sites = {}, settings = {} }) {
  const doc = { readyState: 'complete', focused: null, addEventListener() {} };
  doc.documentElement = new Node(doc, 'html');
  doc.body = new Node(doc, 'body');
  doc.documentElement.append(doc.body);
  doc.body.append(listing(doc, urls));
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused?.isConnected ? doc.focused : doc.body) });
  for (const m of ['querySelector', 'querySelectorAll']) doc[m] = (s) => doc.documentElement[m](s);
  doc.createElement = (tag) => new Node(doc, tag);

  const store = { sites: structuredClone(sites), settings };
  const sent = [];
  let changed;
  let refusal = null;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const ctx = vm.createContext({
    URL, console, setTimeout, clearTimeout,
    document: doc,
    location: { hostname: 'news.ycombinator.com' },
    addEventListener() {},
    chrome: {
      storage: {
        local: { get: async () => structuredClone(store) },
        onChanged: { addListener: (fn) => void (changed = fn) },
      },
      runtime: {
        sendMessage: async (message) => {
          sent.push(structuredClone(message));
          if (refusal && message.type === 'setSite') return { ok: false, error: refusal };
          if (message.type === 'seenSites') for (const d of message.domains) store.sites[d].seen = true;
          else if (message.type !== 'setSite') return { ok: true };
          else for (const d of message.domains) store.sites[d] = { status: message.status, source: 'manual', at: Date.now() };
          changed({ sites: {} }, 'local');
          return { ok: true };
        },
      },
    },
  });
  ctx.window = ctx;
  for (const f of ['seed.js', 'psl.js', 'shared.js', 'hn.js']) vm.runInContext(src(f), ctx, { filename: f });
  await settle();

  const controls = () => doc.querySelectorAll('button');
  return {
    doc, sent, controls,
    control: (label) => controls().find((b) => b.textContent === label),
    status: () => doc.querySelector('.hnpf-status'),
    // The list is changed from somewhere else: the popup, the options page, a detector.
    async change(entries) {
      Object.assign(store.sites, entries);
      changed({ sites: {} }, 'local');
      await settle();
    },
    // From here on the service worker turns "setSite" down.
    refuse: (error) => void (refusal = error),
    // What a click, Enter or Space on a focused control does.
    async press(control) {
      control.focus();
      await control.on.click({ preventDefault() {} });
      await settle();
    },
  };
}

const GATED = { 'gated.example': { status: 'gated', source: 'manual', at: 0 } };
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

test('hn: dismissing the note about a newly hidden site moves on to the next note, then to the list', async () => {
  const found = { status: 'gated', source: 'visit', articles: 3, reason: 'asks to subscribe', at: Date.now() };
  const p = await open({ urls: URLS, sites: { 'gated.example': found, 'other.example': { ...found } } });
  assert.equal(p.controls().filter((b) => b.textContent === 'ok').length, 2);
  await p.press(p.control('ok'));
  assert.equal(p.doc.activeElement, p.control('ok'));
  await p.press(p.control('ok'));
  assert.equal(p.control('ok'), undefined);
  // Not the summary line at the far end of the page.
  assert.equal(p.doc.activeElement.href, 'https://free.example/b');
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
  assert.match(shown, /\.hnpf-mark:focus-within/);
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
