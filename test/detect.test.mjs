// Tests for on-visit detection, run under Node against a minimal stand-in for the page.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const words = (n) => 'word '.repeat(n).trim();
const TEASER = 'This post is for paid subscribers';
const PROMPT = 'Subscribe to continue reading';
const COUNTER = 'You have 2 free articles remaining';

// One element. `wall` gives it a paywall class name, `overlay` puts it on top of the
// viewport as a fixed box covering the given share of it.
function block(text, { tag = 'P', wall = false, overlay = 0, inside = null } = {}) {
  return { text, tag, wall, overlay, inside };
}

// Loads detect.js into a page made of `blocks` and returns what it reported.
function visit(blocks, { scrollLock = false, leave = null } = {}) {
  const el = (b, parent) => ({
    tagName: b.tag,
    innerText: b.text,
    parentElement: parent,
    position: b.overlay ? 'fixed' : 'static',
    wall: b.wall,
    checkVisibility: () => true,
    getBoundingClientRect: () => (b.overlay ? { width: 1000, height: 800 * b.overlay } : { width: 600, height: 40 }),
    querySelector: () => null,
    closest(selector) {
      const tags = selector.split(',').map((t) => t.trim().toUpperCase());
      for (let e = this; e; e = e.parentElement) if (tags.includes(e.tagName)) return e;
      return null;
    },
  });
  const html = el({ tag: 'HTML', text: '' }, null);
  const body = el({ tag: 'BODY', text: blocks.map((b) => b.text).join('\n') }, html);
  body.overflowY = scrollLock ? 'hidden' : 'visible';
  const els = blocks.map((b) => el(b, b.inside ? el({ tag: b.inside, text: b.text }, body) : body));

  const timers = [];
  const sent = [];
  const location = { origin: 'https://blog.example', pathname: '/post', search: '?id=1' };
  const ctx = vm.createContext({
    location,
    innerWidth: 1000,
    innerHeight: 800,
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    clearTimeout() {},
    addEventListener() {},
    getComputedStyle: (e) => ({ position: e.position, overflowY: e.overflowY ?? 'visible' }),
    chrome: { runtime: { sendMessage: async (m) => void sent.push(m) } },
    document: {
      body,
      documentElement: html,
      querySelector: () => null,
      querySelectorAll: () => els.filter((e) => e.wall),
      elementsFromPoint: () => els.filter((e) => e.position === 'fixed'),
      createTreeWalker() {
        let i = 0;
        return { nextNode: () => (i < els.length ? { nodeValue: els[i].innerText, parentElement: els[i++] } : null) };
      },
    },
  });
  ctx.window = ctx;
  for (const file of ['signals.js', 'detect.js']) vm.runInContext(src(file), ctx, { filename: file });

  if (leave) Object.assign(location, leave);
  for (const t of timers.sort((a, b) => a.delay - b.delay)) t.fn();
  return sent;
}

const verdicts = (sent) => sent.map((m) => m.verdict);

test('detect: wording next to an article shown in full is not a wall', () => {
  for (const extra of [block(TEASER), block(COUNTER), block(`A reader wrote in. ${PROMPT}`)]) {
    const sent = visit([block(words(900)), extra]);
    assert.deepEqual(verdicts(sent), ['free'], extra.text);
    assert.equal(sent[0].url, 'https://blog.example/post?id=1');
  }
});

test('detect: the same wording on an article that is cut short is a wall', () => {
  for (const prompt of [TEASER, PROMPT, COUNTER]) {
    const [m, ...rest] = visit([block(words(120)), block(prompt)]);
    assert.deepEqual([m.verdict, rest.length], ['gated', 0], prompt);
    assert.match(m.reason, /^prompt on page/);
  }
});

test('detect: a card in a sidebar or footer is not the article\'s prompt', () => {
  for (const inside of ['ASIDE', 'FOOTER', 'NAV']) {
    assert.deepEqual(verdicts(visit([block(words(120)), block(TEASER, { inside })])), ['free'], inside);
  }
});

test('detect: a wall block counts on a long page, a count of free articles does not', () => {
  const long = block(words(900));
  assert.deepEqual(verdicts(visit([long, block(PROMPT, { wall: true })])), ['gated']);
  assert.deepEqual(verdicts(visit([long, block(COUNTER, { wall: true })])), ['free']);
  assert.deepEqual(verdicts(visit([long, block(COUNTER, { overlay: 0.1 })])), ['free']);
  assert.deepEqual(verdicts(visit([long, block(`${COUNTER}. ${PROMPT}.`, { overlay: 0.1 })])), ['gated']);
});

test('detect: a page that cannot be scrolled or is covered withholds the article', () => {
  const page = [block(words(900)), block(TEASER)];
  assert.deepEqual(verdicts(visit(page, { scrollLock: true })), ['gated']);
  assert.deepEqual(verdicts(visit([...page, block('Members get more. Join us today.', { overlay: 0.5 })])), ['gated']);

  // A cookie or newsletter box explains the lock, and one that can be closed covers nothing.
  const cookies = block('We use cookies. Accept all', { overlay: 0.5 });
  assert.deepEqual(verdicts(visit([...page, cookies], { scrollLock: true })), ['free']);
  assert.deepEqual(verdicts(visit([...page, block('Get our newsletter', { overlay: 0.5 })])), ['free']);
  assert.deepEqual(verdicts(visit([...page, block('Members get more. No thanks', { overlay: 0.5 })])), ['free']);
});

test('detect: nothing is reported once the tab shows another page', () => {
  const pricing = [block('Plans'), block(PROMPT, { wall: true })];
  assert.deepEqual(visit(pricing, { leave: { pathname: '/pricing' } }), []);
  assert.deepEqual(visit(pricing, { leave: { search: '?id=2' } }), []);
  assert.deepEqual(visit([block(words(900))], { leave: { pathname: '/pricing' } }), []);
});
