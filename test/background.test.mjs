// Tests for the service worker, run under Node with a stubbed `chrome` and `fetch`.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const DAY = 24 * 60 * 60 * 1000;
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

const WALL = '<body><p>The start of the story.</p><div class="wall">Subscribe to continue reading</div></body>';
const FREE = `<body><p>${'word '.repeat(900)}</p></body>`;

// Loads background.js into a fresh context. `pages` maps a URL to its HTML source, to
// { type, body } for a response that is not a web page, or to { redirect } for a page
// that sends the reader on to another address.
function boot({ local = {}, pages = {} } = {}) {
  const store = { local: structuredClone(local), session: {} };
  const area = (data) => ({
    get: async (keys) => {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    set: async (patch) => void Object.assign(data, structuredClone(patch)),
  });
  const listeners = {};
  const event = (name) => ({ addListener: (fn) => void (listeners[name] = fn) });
  const fetched = [];

  const ctx = vm.createContext({
    console, URL, Blob, AbortController, setTimeout, clearTimeout,
    importScripts: (...files) => {
      for (const f of files) vm.runInContext(src(f), ctx, { filename: f });
    },
    fetch: async function get(url, init = {}) {
      fetched.push(url);
      const page = pages[url];
      if (page === undefined) return new Response('', { status: 404 });
      if (page.redirect) {
        // As in a browser: followed unless asked not to, and then the target stays hidden.
        if (init.redirect === 'manual') return { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() };
        if (init.redirect === 'error') throw new TypeError('redirected');
        return get(page.redirect, init);
      }
      const { type = 'text/html', body = page } = typeof page === 'string' ? {} : page;
      return new Response(body, { headers: { 'content-type': type } });
    },
    chrome: {
      storage: { local: area(store.local), session: area(store.session), onChanged: event('changed') },
      permissions: { contains: async () => true },
      runtime: {
        onMessage: event('message'),
        onInstalled: event('installed'),
        onStartup: event('startup'),
        openOptionsPage() {},
      },
      tabs: { onUpdated: event('updated'), query: async () => [] },
      action: {},
      scripting: {},
    },
  });
  vm.runInContext(src('background.js'), ctx, { filename: 'background.js' });

  const send = (message, sender = {}) =>
    new Promise((resolve) => listeners.message(message, sender, resolve));
  // Resolves once the background check has nothing left to fetch or store.
  const idle = async () => {
    for (let i = 0; i < 500; i++) {
      await vm.runInContext('chain', ctx);
      if (vm.runInContext('running === 0 && queue.length === 0', ctx)) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('background check did not finish');
  };
  const list = async (...urls) => {
    await send({ type: 'stories', items: urls.map((url) => ({ url, site: ctx.HNPF.siteFor(url) })) });
    await idle();
  };
  // What on-visit detection reports for a story opened from a listing. `tab` is where the
  // tab is when the report arrives, `listed: false` a page that no listing linked to.
  const visit = async (url, verdict = 'gated', { tab = url, listed = true, platform = false } = {}) => {
    if (listed) {
      const stories = (store.session.stories ??= {});
      stories[ctx.HNPF.pageKey(url)] ??= { url, site: ctx.HNPF.siteFor(url), at: Date.now() };
    }
    return send({ type: 'visitVerdict', url, verdict, reason: 'prompt on page', platform }, { tab: { url: tab } });
  };
  const classify = (url) => ctx.HNPF.classify(url, { sites: {}, pages: {}, checks: {}, ...store.local });
  return { ctx, store, listeners, fetched, send, idle, list, visit, classify };
}

const bgOn = { settings: { bgCheck: true } };

test('background check: one gated page does not hide a shared host', async () => {
  const url = 'https://dev.to/someone/how-i-built-a-paywall';
  const b = boot({ local: bgOn, pages: { [url]: WALL } });
  await b.list(url);

  assert.equal(b.store.local.sites?.['dev.to'], undefined);
  const c = b.classify(url);
  assert.deepEqual([c.gated, c.page], [true, true]);
  assert.equal(b.classify('https://dev.to/other/unrelated').gated, false);
});

test('background check: one gated page does not hide an ordinary site either', async () => {
  const url = 'https://example.com/blog/paywall-demo';
  const b = boot({ local: bgOn, pages: { [url]: WALL } });
  await b.list(url);

  assert.deepEqual(b.store.local.sites ?? {}, {});
  assert.equal(b.classify(url).gated, true);
  assert.equal(b.classify('https://example.com/blog/other').gated, false);
});

test('background check: a site is hidden once several distinct articles looked gated', async () => {
  const urls = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });

  await b.list(urls[0], urls[1]);
  // The same article again, under another spelling, is not a new one.
  await b.list('https://www.example.com/news/1/?ref=hn');
  assert.equal(b.store.local.sites?.['example.com'], undefined);

  await b.list(urls[2]);
  const site = b.store.local.sites['example.com'];
  assert.deepEqual([site.status, site.source, site.articles], ['gated', 'check', 3]);
  const c = b.classify('https://example.com/news/never-seen');
  assert.deepEqual([c.gated, c.source, c.page], [true, 'check', false]);
});

test('background check: a site that also showed a free article stays per article', async () => {
  const gated = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const free = 'https://example.com/news/open';
  const b = boot({ local: bgOn, pages: { ...Object.fromEntries(gated.map((u) => [u, WALL])), [free]: FREE } });
  await b.list(free, ...gated);

  assert.equal(b.store.local.sites?.['example.com'], undefined);
  for (const u of gated) assert.equal(b.classify(u).gated, true);
  assert.equal(b.classify(free).gated, false);
});

test('background check: a free article takes back a site verdict, whatever order they finish in', async () => {
  const gated = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const free = 'https://example.com/news/open';
  const b = boot({ local: bgOn, pages: { ...Object.fromEntries(gated.map((u) => [u, WALL])), [free]: FREE } });
  await b.list(...gated, free);

  assert.equal(b.store.local.sites['example.com'], undefined);
  assert.equal(b.classify(free).gated, false);
  assert.equal(b.classify('https://example.com/news/never-seen').gated, false);
});

test('background check: articles told apart by their query are judged separately', async () => {
  const url = 'https://example.com/story.php?id=1';
  const b = boot({ local: bgOn, pages: { [url]: WALL, 'https://example.com/story.php?id=2': FREE } });
  await b.list(url);
  assert.equal(b.classify(url).gated, true);
  assert.equal(b.classify('https://example.com/story.php?id=2').gated, false);

  await b.list('https://example.com/story.php?id=2');
  assert.equal(b.fetched.length, 2);
});

test('background check: old gated articles do not add up with a recent one', async () => {
  const at = Date.now() - 20 * DAY;
  const old = (n) => [`example.com/news/${n}`, { status: 'gated', source: 'check', site: 'example.com', at }];
  const url = 'https://example.com/news/3';
  const b = boot({ local: { ...bgOn, pages: Object.fromEntries([old(1), old(2)]) }, pages: { [url]: WALL } });
  await b.list(url);

  assert.equal(b.store.local.sites?.['example.com'], undefined);
  assert.equal(b.classify(url).gated, true);
});

test('background check: an article you chose to show counts against hiding its site', async () => {
  const urls = [1, 2, 3, 4].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(urls[0]);
  await b.send({ type: 'setPage', key: 'example.com/news/1', status: 'allowed' });
  await b.list(...urls.slice(1));

  assert.equal(b.store.local.sites?.['example.com'], undefined);
  assert.equal(b.classify(urls[0]).source, 'allowed');
  assert.equal(b.classify(urls[3]).gated, true);
});

test('background check: a page built on Substack or Medium marks its site as mixed', async () => {
  const urls = [1, 2, 3].map((n) => `https://newsletter.example/p/${n}`);
  const wall = '<link href="https://substackcdn.com/x.css">' + WALL;
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, wall])) });
  await b.list(...urls);

  assert.equal(b.store.local.sites?.['newsletter.example'], undefined);
  assert.equal(b.store.local.checks['d:newsletter.example'].verdict, 'mixed');
});

test('background check: personal "~user" pages never hide their host', async () => {
  const urls = [1, 2, 3].map((n) => `https://cs.example.edu/~mallory/${n}.html`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls);

  assert.equal(b.store.local.sites?.['example.edu'], undefined);
  assert.equal(b.classify('https://cs.example.edu/~alice/').gated, false);

  // Nor do they add up with an ordinary page on the same host.
  await b.visit('https://cs.example.edu/news');
  assert.equal(b.classify('https://cs.example.edu/news').gated, true);
  assert.equal(b.store.local.sites?.['example.edu'], undefined);
});

test('removing a site the detectors hid forgets the articles it rested on', async () => {
  const urls = [1, 2, 3, 4].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls.slice(0, 3));
  assert.equal(b.store.local.sites['example.com'].articles, 3);

  await b.send({ type: 'setSite', domains: ['example.com'], status: null });
  assert.deepEqual(b.store.local.pages, {});
  await b.list(urls[3]);
  assert.equal(b.store.local.sites['example.com'], undefined);
  assert.equal(b.classify(urls[3]).gated, true);
});

test('background check: hosts shared by many authors are never hidden as a whole', async () => {
  const urls = [1, 2, 3, 4].map((n) => `https://dev.to/author${n}/post`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls);

  assert.equal(b.store.local.sites?.['dev.to'], undefined);
  assert.equal(b.classify('https://dev.to/someone/else').gated, false);
});

test('background check: a free or non-HTML page says nothing about the rest of the site', async () => {
  const b = boot({
    local: bgOn,
    pages: {
      'https://example.com/a': FREE,
      'https://example.com/data': { type: 'application/octet-stream', body: 'x' },
      'https://example.com/b': WALL,
    },
  });
  await b.list('https://example.com/a', 'https://example.com/data');
  await b.list('https://example.com/b');

  assert.deepEqual(b.fetched, ['https://example.com/a', 'https://example.com/data', 'https://example.com/b']);
  assert.equal(b.classify('https://example.com/b').gated, true);

  // Pages already judged are not fetched again while the verdict is fresh.
  await b.list('https://example.com/a', 'https://example.com/b');
  assert.equal(b.fetched.length, 3);
});

test('background check: a long page is read up to a limit and no further', async () => {
  const declared = '<script type="application/ld+json">{"isAccessibleForFree": false}</script>';
  const prompt = '<div>Subscribe to continue reading.</div>';
  const padding = `<!--${'x'.repeat(800_000)}-->`;
  const b = boot({
    local: bgOn,
    pages: {
      'https://example.com/early': `<body>${declared}${prompt}${padding}${FREE}</body>`,
      'https://example.com/late': `<body>${FREE}${padding}${declared}${prompt}</body>`,
      // Cut off before the article ends, so a short text proves nothing.
      'https://example.com/cut': `<body><p>The start of the story.</p>${prompt}${padding}</body>`,
    },
  });
  await b.list('https://example.com/early', 'https://example.com/late', 'https://example.com/cut');

  assert.equal(b.classify('https://example.com/early').gated, true);
  assert.equal(b.classify('https://example.com/late').gated, false);
  assert.equal(b.classify('https://example.com/cut').gated, false);
});

test('background check: the site a story claims must fit its URL', async () => {
  const urls = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.send({ type: 'stories', items: urls.map((url) => ({ url, site: 'victim.org' })) });
  await b.idle();

  assert.equal(b.store.local.sites['victim.org'], undefined);
  assert.equal(b.store.local.sites['example.com'].status, 'gated');
});

test('background check: only public https addresses on the default port are fetched', async () => {
  const b = boot({ local: bgOn });
  const local = [
    'http://192.168.1.1/apply.cgi?action=reboot',
    'http://localhost:8080/admin/restart',
    'http://router.lan/x',
    'http://[::1]:9000/x',
    'https://10.0.0.5:8443/x',
    'https://192.168.1.1/x',
    'https://localhost/x',
    'https://nas.local/x',
    'https://intranet/x',
    'https://router/x',
    'https://user:secret@example.com/x',
    'https://example.com:8443/x',
    'http://example.com/x',
  ];
  await b.list(...local, 'https://example.com/x');

  assert.deepEqual(b.fetched, ['https://example.com/x']);
  // Nothing is recorded for a story that was never looked at.
  assert.deepEqual(Object.keys(b.store.local.checks), ['p:example.com/x']);
  for (const url of local) assert.equal(b.ctx.fetchable(url), false, url);
  // Nor by a caller that skips the listing.
  assert.equal((await b.ctx.fetchVerdict(local[0])).verdict, 'unknown');
  assert.equal(b.fetched.length, 1);
});

test('background check: a redirect is not followed', async () => {
  const url = 'https://example.com/a';
  const target = 'http://192.168.1.1/apply.cgi?action=reboot';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: target }, [target]: WALL } });
  await b.list(url);

  assert.deepEqual(b.fetched, [url]);
  const { verdict, reason } = b.store.local.checks['p:example.com/a'];
  assert.deepEqual([verdict, reason], ['unknown', 'could not be checked (redirects elsewhere)']);
  assert.equal(b.classify(url).gated, false);
});

test('on-visit detection: a gated page hides that article, several hide the site', async () => {
  const b = boot();
  const visit = (url) => b.visit(url);

  await visit('https://example.com/a');
  assert.equal(b.store.local.sites?.['example.com'], undefined);
  assert.equal(b.classify('https://example.com/a').gated, true);
  assert.equal(b.classify('https://example.com/b').gated, false);

  await visit('https://example.com/b');
  await visit('https://example.com/c');
  assert.deepEqual(
    [b.store.local.sites['example.com'].status, b.store.local.sites['example.com'].source],
    ['gated', 'visit'],
  );
});

test('on-visit detection: an article that showed no wall counts against hiding its site', async () => {
  const b = boot();
  const visit = (path, verdict) => b.visit(`https://example.com/${path}`, verdict);

  await visit('open', 'free');
  for (const path of ['a', 'b', 'c']) await visit(path, 'gated');
  assert.equal(b.store.local.sites?.['example.com'], undefined);
  assert.equal(b.classify('https://example.com/c').gated, true);
  assert.equal(b.classify('https://example.com/open').gated, false);
});

test('a site hidden for its articles expires even when a visit completed the count', async () => {
  const urls = [1, 2].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls);
  await b.visit('https://example.com/news/3');
  const site = b.store.local.sites['example.com'];
  assert.equal(site.articles, 3);

  site.at -= 31 * DAY;
  b.listeners.startup();
  await vm.runInContext('chain', b.ctx);
  assert.equal(b.store.local.sites['example.com'], undefined);
});

test('on-visit detection: a verdict for a page the tab has left is dropped', async () => {
  const story = 'https://blog.example/free-post';
  const b = boot();
  await b.list(story);

  // The site routed to its pricing page without a reload: either the report still names
  // the story while the tab shows the other page, or it names the other page.
  await b.visit(story, 'gated', { tab: 'https://blog.example/pricing' });
  await b.visit('https://blog.example/pricing', 'gated', { listed: false });
  await b.visit(story, 'free', { tab: 'https://blog.example/pricing' });
  // A report that does not say which page it is about is not trusted either.
  await b.send({ type: 'visitVerdict', verdict: 'gated', reason: 'r' }, { tab: { url: story } });

  assert.deepEqual(b.store.local.sites ?? {}, {});
  assert.deepEqual(b.store.local.pages ?? {}, {});
  assert.deepEqual(b.store.local.checks ?? {}, {});
  assert.equal(b.classify(story).gated, false);

  // An anchor within the article is still the article.
  await b.visit(story, 'gated', { tab: story + '#footnote-1' });
  assert.equal(b.classify(story).gated, true);
});

test('a site the detectors hid is flagged as new until the user acknowledges it', async () => {
  const b = boot();
  for (const n of [1, 2, 3]) await b.visit(`https://example.com/news/${n}`);
  const site = () => b.store.local.sites['example.com'];
  assert.deepEqual([site().articles, site().seen], [3, undefined]);

  await b.send({ type: 'seenSites', domains: ['example.com', 'unknown.example'] });
  assert.equal(site().seen, true);
  assert.deepEqual(Object.keys(b.store.local.sites), ['example.com']);

  // The user's own entries carry no such mark.
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await b.send({ type: 'seenSites', domains: ['example.com'] });
  assert.equal(site().seen, undefined);
});

test('on-visit detection: a tab whose address gained a parameter is still the story', async () => {
  const posted = 'https://example.com/a';
  const b = boot();
  await b.list(posted);
  await b.visit('https://example.com/a?source=newsletter', 'gated', { listed: false });

  assert.equal(b.classify(posted).gated, true);
  assert.deepEqual(Object.keys(b.store.local.pages), ['example.com/a']);
});

test('on-visit detection: a tab showing another article on the same path is not the story', async () => {
  const b = boot();
  const visit = (url) => b.visit(url, 'gated', { listed: false });
  await b.list('https://forum.example.org/story.php?id=5', 'https://blog.example.org/?p=1', 'https://blog.example.org/?p=2', 'https://example.net/');

  await visit('https://forum.example.org/story.php?id=9');
  await visit('https://blog.example.org/?p=1&sid=x');
  await visit('https://example.net/?page=about');
  // Only the story is judged; detection is never started on the other two.
  assert.deepEqual(Object.keys(b.store.local.pages), ['blog.example.org?p=1']);
  assert.equal(b.ctx.HNPF.storyFor(b.store.session.stories, 'https://forum.example.org/story.php?id=9'), null);
  assert.equal(b.ctx.HNPF.storyFor(b.store.session.stories, 'https://example.net/?page=about'), null);
});

test('background check: one page under several query strings is one article', async () => {
  const urls = [1, 2, 3].map((n) => `https://example.com/post?x=${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls);

  assert.equal(b.store.local.sites?.['example.com'], undefined);
  assert.equal(b.classify('https://example.com/other').gated, false);
});

test('background check: a response that is no web page does not count as a free article', async () => {
  const urls = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const data = { type: 'application/pdf', body: 'x' };
  const b = boot({ local: bgOn, pages: { ...Object.fromEntries(urls.map((u) => [u, WALL])), 'https://example.com/data': data } });
  await b.list('https://example.com/data', ...urls, 'https://example.com/data2');

  assert.equal(b.store.local.sites['example.com'].articles, 3);
});

test('a late free article takes back a site verdict, a late non-page does not', () => {
  const { ctx } = boot();
  const at = Date.now();
  const promoted = () => ({
    sites: { 'example.com': { status: 'gated', source: 'check', articles: 3, at } },
    pages: {},
    checks: {},
  });
  const late = { url: 'https://example.com/x', site: 'example.com', verdict: 'free', reason: '', source: 'check' };

  const kept = promoted();
  assert.equal(ctx.recordVerdict(kept, { ...late, article: false }), false);
  assert.equal(kept.sites['example.com'].articles, 3);

  const taken = promoted();
  assert.equal(ctx.recordVerdict(taken, late), true);
  assert.equal(taken.sites['example.com'], undefined);
});

test('the toolbar badge judges a story tab by the link as posted', async () => {
  const b = boot();
  const badges = [];
  b.ctx.chrome.action = new Proxy({}, { get: (_, name) => async (arg) => void (name === 'setBadgeText' && badges.push(arg.text)) });
  await b.list('https://example.com/a?id=5');
  await b.visit('https://example.com/a?id=5&sid=x', 'gated', { listed: false });

  b.ctx.badgeForPage(1, 'https://example.com/a?id=5&sid=x', await b.ctx.HNPF.loadState(), b.store.session.stories);
  b.ctx.badgeForPage(1, 'https://example.com/a?id=6', await b.ctx.HNPF.loadState(), b.store.session.stories);
  assert.deepEqual(badges, ['!', '']);
});

test('on-visit detection: a visit that saw no wall does not stand in for the background check', async () => {
  const url = 'https://example.com/a';
  const b = boot({ local: bgOn, pages: { [url]: WALL } });
  await b.visit(url, 'free');
  assert.equal(b.store.local.checks['p:example.com/a'].verdict, 'free');

  await b.list(url);
  assert.deepEqual(b.fetched, [url]);
  assert.equal(b.classify(url).gated, true);
});

test('"always show" on a site the detectors hid forgets its articles too', async () => {
  const urls = [1, 2, 3, 4].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls.slice(0, 3));
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'allowed' });
  await b.send({ type: 'setSite', domains: ['example.com'], status: null });
  await b.list(urls[3]);

  assert.equal(b.store.local.sites['example.com'], undefined);
  assert.deepEqual(Object.keys(b.store.local.pages), ['example.com/news/4']);
});

test("automatic verdicts never replace the user's own entries", async () => {
  const urls = [1, 2, 3].map((n) => `https://blog.example.com/${n}`);
  const local = {
    ...bgOn,
    sites: { 'example.com': { status: 'allowed', source: 'manual', at: 1 } },
  };
  const b = boot({ local, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls);
  for (const url of urls) await b.visit(url);

  assert.deepEqual(Object.keys(b.store.local.sites), ['example.com']);
  assert.equal(b.store.local.sites['example.com'].status, 'allowed');
  assert.deepEqual(b.store.local.pages ?? {}, {});
});

test('a site you hid is not touched by a free verdict', async () => {
  const local = { ...bgOn, sites: { 'example.com': { status: 'gated', source: 'manual', at: 1 } } };
  const b = boot({ local });
  await b.visit('https://example.com/a', 'free');

  assert.equal(b.store.local.sites['example.com'].source, 'manual');
  assert.equal(b.classify('https://example.com/a').gated, true);
});

test('update: site verdicts reached from a single page are forgotten', async () => {
  const now = Date.now();
  const b = boot({
    local: {
      sites: {
        'dev.to': { status: 'gated', source: 'check', reason: 'r', at: now },
        'visited.example': { status: 'gated', source: 'visit', reason: 'r', at: now },
        'promoted.example': { status: 'gated', source: 'check', reason: 'r', articles: 3, at: now },
        'mine.example': { status: 'gated', source: 'manual', at: now },
        'shown.example': { status: 'allowed', source: 'manual', at: now },
      },
      checks: {
        'd:free.example': { verdict: 'free', reason: '', at: now },
        'd:mixed.example': { verdict: 'mixed', at: now },
        'p:example.com/a': { verdict: 'free', reason: '', site: 'example.com', at: now },
        'p:example.com/old': { verdict: 'free', reason: '', site: 'example.com', at: now - 15 * DAY },
      },
    },
  });
  b.listeners.installed({ reason: 'update' });
  await vm.runInContext('chain', b.ctx);

  assert.deepEqual(Object.keys(b.store.local.sites).sort(), ['mine.example', 'promoted.example', 'shown.example']);
  assert.deepEqual(Object.keys(b.store.local.checks).sort(), ['d:mixed.example', 'p:example.com/a']);
});

test('update from 0.1.3: verdicts that rest on gate wording are forgotten', async () => {
  const now = Date.now();
  const local = () => ({
    pages: {
      'example.com/a': { status: 'gated', source: 'check', reason: 'page is cut short with a prompt: “hit the limit”', site: 'example.com', at: now },
      'example.com/b': { status: 'gated', source: 'visit', reason: 'prompt on page: “Log in to view this”', site: 'example.com', at: now },
      'example.com/c': { status: 'gated', source: 'visit', reason: 'overlay on page: “reached the limit”', site: 'example.com', at: now },
      'example.com/locked': { status: 'gated', source: 'check', reason: 'page metadata marks it "locked"', site: 'example.com', at: now },
      'example.com/mine': { status: 'gated', source: 'manual', at: now },
    },
    sites: {
      'example.com': { status: 'gated', source: 'check', reason: '3 articles on this site looked gated', articles: 3, at: now },
      'mine.example': { status: 'gated', source: 'manual', at: now },
    },
    checks: {
      'd:blog.example': { verdict: 'mixed', at: now },
      'p:example.com/free': { verdict: 'free', reason: '', site: 'example.com', at: now },
    },
  });
  const b = boot({ local: local() });
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.3' });
  await vm.runInContext('chain', b.ctx);
  assert.deepEqual(Object.keys(b.store.local.pages).sort(), ['example.com/locked', 'example.com/mine']);
  assert.deepEqual(Object.keys(b.store.local.sites), ['mine.example']);
  assert.deepEqual(Object.keys(b.store.local.checks), ['p:example.com/free']);

  // Later updates leave what the fixed detectors found alone.
  const later = boot({ local: local() });
  later.listeners.installed({ reason: 'update', previousVersion: '0.1.5' });
  await vm.runInContext('chain', later.ctx);
  assert.equal(Object.keys(later.store.local.pages).length, 5);
  assert.ok(later.store.local.sites['example.com']);
  assert.ok(later.store.local.checks['d:blog.example']);
});

test('update from 0.1.4: what a visit found by wording alone is forgotten', async () => {
  const now = Date.now();
  const gated = (source, reason) => ({ status: 'gated', source, reason, site: 'example.com', at: now });
  const b = boot({
    local: {
      pages: {
        'example.com/a': gated('visit', 'prompt on page: “free articles remaining”'),
        'example.com/b': gated('visit', 'overlay on page: “last free article”'),
        'example.com/c': gated('visit', 'sign-in or subscribe overlay blocks the page'),
        'example.com/d': gated('check', 'page is cut short with a prompt: “Subscribe to continue reading”'),
        'example.com/mine': { status: 'gated', source: 'manual', at: now },
      },
      sites: {
        'example.com': { status: 'gated', source: 'visit', reason: '3 articles on this site looked gated', articles: 3, at: now },
        'mine.example': { status: 'gated', source: 'manual', at: now },
      },
    },
  });
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.4' });
  await vm.runInContext('chain', b.ctx);

  assert.deepEqual(Object.keys(b.store.local.pages).sort(), ['example.com/c', 'example.com/d', 'example.com/mine']);
  assert.deepEqual(Object.keys(b.store.local.sites), ['mine.example']);
});
