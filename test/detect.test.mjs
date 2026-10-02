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
// `inside` wraps it in an element of that tag.
function block(text, { tag = 'P', wall = false, overlay = 0, inside = null } = {}) {
  return { text, tag, wall, overlay, inside };
}

// One Piano modal. `close` is whether its close button is switched on ('unseen': on, but
// hidden by the site's own stylesheet). `show` is what the publisher set for the button:
// Piano puts "showCloseButton" in the address of an offer, and leaves it out of that of a
// template. `hidden` is a modal left in the page that is not up, and `open: false` one
// whose page is not marked as showing a modal.
function offer({ close = false, show = null, hidden = false, open = true } = {}) {
  const src = show === null
    ? 'https://buy.tinypass.com/checkout/template/cacheableShow.html?aid=x&templateId=y&displayMode=modal'
    : `https://buy.tinypass.com/checkout/offer/show?aid=x&displayMode=modal&offerId=y&showCloseButton=${show}`;
  return { close, src, hidden, open };
}
const CLOSABLE = [offer({ close: true })];
const FIXED = [offer({ show: false })];

// Loads detect.js into a page made of `blocks` and returns what it reported.
// `piano` is the Piano modals on the page, see offer(). `scroll` is how the page changes
// after the timed looks, upon which the reader scrolls.
function visit(blocks, { scrollLock = false, leave = null, piano = [], scroll = null } = {}) {
  const page = { piano };
  const shown = () => page.piano.some((o) => o.open && !o.hidden);
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
  // Piano locks the page for as long as its modal is up, whatever the modal offers.
  Object.defineProperty(body, 'overflowY', { get: () => (scrollLock || shown() ? 'hidden' : 'visible') });
  body.classList = { contains: (name) => name === 'tp-modal-open' && shown() };
  // The offer itself is in a cross-origin iframe, so the modal has no text of its own.
  const modals = () =>
    page.piano.map((o) => {
      const button = el({ tag: 'BUTTON', text: '' }, body);
      button.checkVisibility = () => o.close !== 'unseen';
      const children = [
        { tag: 'iframe', classes: [], src: o.src },
        Object.assign(button, { tag: 'button', classes: ['tp-close', ...(o.close ? ['tp-active'] : [])] }),
      ];
      const modal = el({ tag: 'DIV', text: '', overlay: 1 }, body);
      modal.checkVisibility = () => !o.hidden;
      modal.querySelector = (selector) => {
        const [tag, ...classes] = selector.split('.');
        return children.find((c) => (!tag || c.tag === tag) && classes.every((name) => c.classes.includes(name))) ?? null;
      };
      return modal;
    });
  const wrappers = [];
  const els = blocks.map((b) => {
    if (!b.inside) return el(b, body);
    wrappers.push(el({ tag: b.inside, text: b.text }, body));
    return el(b, wrappers.at(-1));
  });
  const byTag = (tag) => [...wrappers, ...els].filter((e) => e.tagName === tag);

  const timers = [];
  const listeners = {};
  const sent = [];
  const location = {
    pathname: '/post', search: '?id=1', hash: '',
    get href() {
      return `https://blog.example${this.pathname}${this.search}${this.hash}`;
    },
  };
  const ctx = vm.createContext({
    location,
    URL,
    innerWidth: 1000,
    innerHeight: 800,
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    clearTimeout() {},
    addEventListener: (type, fn) => void (listeners[type] = fn),
    getComputedStyle: (e) => ({ position: e.position, overflowY: e.overflowY ?? 'visible' }),
    chrome: { runtime: { sendMessage: async (m) => void sent.push(m) } },
    document: {
      body,
      documentElement: html,
      querySelector: () => null,
      querySelectorAll: (selector) =>
        selector === '.tp-modal' ? modals()
          : selector.startsWith('main') ? byTag('MAIN') : selector === 'article' ? byTag('ARTICLE') : els.filter((e) => e.wall),
      elementsFromPoint: () => [...modals().filter((m) => m.checkVisibility()), ...els.filter((e) => e.position === 'fixed')],
      createTreeWalker() {
        let i = 0;
        return { nextNode: () => (i < els.length ? { nodeValue: els[i].innerText, parentElement: els[i++] } : null) };
      },
    },
  });
  ctx.window = ctx;
  for (const file of ['shared.js', 'signals.js', 'detect.js']) vm.runInContext(src(file), ctx, { filename: file });

  if (leave) Object.assign(location, leave);
  const elapse = () => {
    for (const t of timers.splice(0).sort((a, b) => a.delay - b.delay)) t.fn();
  };
  elapse();
  if (scroll) {
    Object.assign(page, scroll);
    listeners.scroll();
    elapse();
  }
  return sent;
}

const verdicts = (sent) => sent.map((m) => m.verdict);

test('detect: wording next to an article shown in full is not a wall', () => {
  // Nor is such a page called free: the article may be cut off in a way that does not show.
  for (const extra of [block(TEASER), block(COUNTER), block(TEASER, { inside: 'ASIDE' })]) {
    assert.deepEqual(visit([block(words(900)), extra]), [], extra.text);
  }
  const [free] = visit([block(words(900)), block(`A reader wrote in. They said "${PROMPT.toLowerCase()}" was all they saw.`)]);
  assert.deepEqual([free.verdict, free.url], ['free', 'https://blog.example/post?id=1']);
});

test('detect: the same wording on an article that is cut short is a wall', () => {
  for (const prompt of [block(TEASER), block(PROMPT), block(COUNTER), block(TEASER, { inside: 'ASIDE' })]) {
    const [m, ...rest] = visit([block(words(120)), prompt]);
    assert.deepEqual([m.verdict, rest.length], ['gated', 0], prompt.text);
    assert.match(m.reason, /^prompt on page/);
  }
});

test('detect: comments and other stories do not make a cut-off article look long', () => {
  const comments = block(words(900), { tag: 'DIV' });
  for (const tag of ['MAIN', 'ARTICLE']) {
    const page = [block(words(120), { inside: tag }), block(PROMPT), comments];
    assert.deepEqual(verdicts(visit(page)), ['gated'], tag);
  }
  // With several articles on the page there is no telling which one is the story.
  const cards = [block(words(120), { inside: 'ARTICLE' }), block(words(900), { inside: 'ARTICLE' }), block(TEASER)];
  assert.deepEqual(visit(cards), []);
});

test('detect: wording in the site menu or footer is not the article\'s prompt', () => {
  for (const inside of ['FOOTER', 'NAV']) {
    assert.deepEqual(verdicts(visit([block(words(120)), block(TEASER, { inside })])), ['free'], inside);
  }
});

test('detect: a wall block counts on a long page, a count of free articles does not', () => {
  const long = block(words(900));
  assert.deepEqual(verdicts(visit([long, block(PROMPT, { wall: true })])), ['gated']);
  assert.deepEqual(visit([long, block(COUNTER, { wall: true })]), []);
  assert.deepEqual(visit([long, block(COUNTER, { overlay: 0.1 })]), []);
  assert.deepEqual(verdicts(visit([long, block(`${COUNTER}. ${PROMPT}.`, { overlay: 0.1 })])), ['gated']);
});

test('detect: a page that cannot be scrolled or is covered withholds the article', () => {
  const page = [block(words(900)), block(TEASER)];
  assert.deepEqual(verdicts(visit(page, { scrollLock: true })), ['gated']);
  assert.deepEqual(verdicts(visit([...page, block('Members get more. Join us today.', { overlay: 0.5 })])), ['gated']);

  // A cookie or newsletter box explains the lock, and one that can be closed covers nothing.
  const cookies = block('We use cookies. Accept all', { overlay: 0.5 });
  assert.deepEqual(visit([...page, cookies], { scrollLock: true }), []);
  assert.deepEqual(visit([...page, block('Get our newsletter', { overlay: 0.5 })]), []);
  assert.deepEqual(visit([...page, block('Members get more. No thanks', { overlay: 0.5 })]), []);
});

test('detect: a Piano offer is a wall only when it cannot be closed', () => {
  const article = [block(words(900), { inside: 'MAIN' })];
  const [m, ...rest] = visit(article, { piano: FIXED });
  assert.deepEqual([m.verdict, m.reason, rest.length], ['gated', 'an offer that cannot be closed covers the page', 0]);

  // A donation appeal or a newsletter offer comes in the same modal, over an article that
  // is there in full, and goes away with one click.
  assert.deepEqual(verdicts(visit(article, { piano: CLOSABLE })), ['free']);
  assert.deepEqual(verdicts(visit(article, { scroll: { piano: CLOSABLE } })), ['free']);
  // Some templates switch the button off and draw their own inside the offer.
  assert.deepEqual(verdicts(visit(article, { piano: [offer({ show: true })] })), ['free']);
  // The button is what counts while it is on, whatever the address says.
  assert.deepEqual(verdicts(visit(article, { piano: [offer({ close: true, show: false })] })), ['free']);
});

test('detect: a Piano offer that may or may not be closable is neither a wall nor a free page', () => {
  // The button is off and the publisher's setting is not in the address.
  assert.deepEqual(visit([block(words(900))], { piano: [offer()] }), []);
  // A button the site keeps out of sight closes nothing.
  assert.deepEqual(visit([block(words(900))], { piano: [offer({ close: 'unseen' })] }), []);
  assert.deepEqual(verdicts(visit([block(words(900))], { piano: [offer({ close: 'unseen', show: false })] })), ['gated']);
  assert.deepEqual(visit([block(words(900)), block(TEASER)], { piano: [offer()] }), []);
});

test('detect: only the Piano modal that is up counts', () => {
  const article = [block(words(900))];
  const stale = offer({ show: false, hidden: true });
  assert.deepEqual(verdicts(visit(article, { piano: [stale] })), ['free']);
  assert.deepEqual(verdicts(visit(article, { piano: [stale, ...CLOSABLE] })), ['free']);
  assert.deepEqual(verdicts(visit(article, { piano: [offer({ close: true, hidden: true }), ...FIXED] })), ['gated']);
  assert.deepEqual(verdicts(visit(article, { piano: [offer({ show: false, open: false })] })), ['free']);
});

test('detect: a Piano offer that can be closed explains why the page does not scroll', () => {
  // Gate wording next to the whole article is no wall while the offer is up either.
  const page = [block(words(900)), block(TEASER)];
  assert.deepEqual(visit(page, { piano: CLOSABLE }), []);
  assert.deepEqual(verdicts(visit([block(words(120)), block(TEASER)], { piano: CLOSABLE })), ['gated']);
  // Nor is sign-in wording in a box under the offer.
  const box = block('Sign in to your account', { overlay: 0.5 });
  assert.deepEqual(verdicts(visit([block(words(900)), box], { scrollLock: true })), ['gated']);
  assert.deepEqual(visit([block(words(900)), box], { piano: CLOSABLE }), []);
  // What the offer says cannot be read, so a short page under one is not called free.
  assert.deepEqual(visit([block(words(120))], { piano: CLOSABLE }), []);
});

test('detect: a wall that only appears on scrolling replaces the earlier "free"', () => {
  const article = [block(words(900))];
  assert.deepEqual(verdicts(visit(article, { scroll: { piano: FIXED } })), ['free', 'gated']);
  assert.deepEqual(verdicts(visit(article, { scroll: {} })), ['free']);
});

test('detect: nothing is reported once the tab shows another page', () => {
  const pricing = [block('Plans'), block(PROMPT, { wall: true })];
  assert.deepEqual(visit(pricing, { leave: { pathname: '/pricing' } }), []);
  assert.deepEqual(visit(pricing, { leave: { search: '?id=2' } }), []);
  assert.deepEqual(visit(pricing, { leave: { hash: '#/pricing' } }), []);
  assert.deepEqual(visit([block(words(900))], { leave: { pathname: '/pricing' } }), []);
});

test('detect: an anchor or a tracking parameter is still the same page', () => {
  for (const leave of [{ hash: '#footnote-1' }, { search: '?id=1&utm_source=hn' }, { pathname: '/post/' }]) {
    const [m] = visit([block(words(120)), block(PROMPT)], { leave });
    assert.deepEqual([m.verdict, m.url], ['gated', 'https://blog.example/post?id=1'], JSON.stringify(leave));
  }
});
