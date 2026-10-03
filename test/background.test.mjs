// Tests for the service worker, run under Node with a stubbed `chrome` and `fetch`.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const DAY = 24 * 60 * 60 * 1000;
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// Who a message is from, as the browser reports it: the extension's own options page or
// popup, the script on a Hacker News listing, and a tab showing any other page.
const ID = 'hnpfextensionid';
const PAGE = { id: ID, origin: `chrome-extension://${ID}`, url: `chrome-extension://${ID}/src/options.html` };
const POPUP = { ...PAGE, url: `chrome-extension://${ID}/src/popup.html` };
const HN = { id: ID, origin: 'https://news.ycombinator.com', url: 'https://news.ycombinator.com/news', frameId: 0, tab: { id: 1, url: 'https://news.ycombinator.com/news' } };
const tabAt = (url, frameId = 0) => ({ id: ID, origin: new URL(url).origin, url, frameId, tab: { id: 2, url } });
const incognito = (sender) => ({ ...sender, tab: { ...sender.tab, incognito: true } });
const ALL_SITES = { origins: ['https://*/*', 'http://*/*'] };

const WALL = '<body><p>The start of the story.</p><div class="wall">Subscribe to continue reading</div></body>';
const FREE = `<body><p>${'word '.repeat(900)}</p></body>`;

// The conditions of a session rule that `lets` below knows how to weigh.
const RULE_CONDITIONS = ['regexFilter', 'excludedRequestDomains', 'initiatorDomains', 'tabIds', 'resourceTypes'];

// Loads background.js into a fresh context. `pages` maps a URL to its HTML source, to
// { type, body } for a response that is not a web page, to { redirect } for a page that
// sends the reader on to another address, or to { hang: true } for one that answers only
// once its request is called off. `granted` says whether the extension holds access to
// all sites, which `access` keeps track of. `guard: false` makes installing the session
// rules fail; `enforce: false` stands for a browser that lets every request through
// whatever the rules say. `session` is what session storage holds as the worker starts,
// say after it was suspended; `lock: false` makes restricting local storage fail.
function boot({ local = {}, session = {}, pages = {}, granted = true, guard = true, enforce = true, lock = true } = {}) {
  const access = { granted, removed: [] };
  const tabs = [];
  const store = { local: structuredClone(local), session: structuredClone(session) };
  // The access levels set on a storage area, the messages sent to a document in a tab as
  // [tabId, message, options], and the documents such a message no longer reaches.
  const levels = [];
  const told = [];
  const left = new Set();
  const rules = [];
  // Whether the session rules let a request of the service worker's own through, as
  // Chromium decides it before the request and before each redirect: the matching rule of
  // the highest priority wins. A rule is matched against the address as the browser
  // writes it, and a domain covers its subdomains, a full stop at the end or not. The
  // rules apply only to a host the extension has access to.
  // This is how Chromium does it: url_pattern_index strips a trailing full stop from the
  // host before it weighs the excluded domains, and a regex rule is matched without regard
  // to case against the address in its canonical form. The WHATWG URL gives that form, and
  // agrees with it for the addresses the tests use.
  const lets = (url) => {
    if (!access.granted || !enforce) return true;
    const u = new URL(url);
    const host = u.hostname.replace(/\.$/, '');
    const matches = ({ condition: c }) =>
      (!c.regexFilter || new RegExp(c.regexFilter, 'i').test(u.href)) &&
      !(c.excludedRequestDomains || []).some((d) => host === d || host.endsWith('.' + d)) &&
      (!c.initiatorDomains || c.initiatorDomains.includes(ID)) &&
      (!c.tabIds || c.tabIds.includes(-1)) &&
      (!c.resourceTypes || c.resourceTypes.includes('xmlhttprequest'));
    const winner = rules.filter(matches).sort((a, b) => b.priority - a.priority)[0];
    return winner?.action.type !== 'block';
  };
  // As in a browser, a write is reported for the keys whose value it changed.
  const area = (data, name) => ({
    get: async (keys) => {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    set: async (patch) => {
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        if (JSON.stringify(data[k]) !== JSON.stringify(v)) changes[k] = { newValue: structuredClone(v) };
      }
      Object.assign(data, structuredClone(patch));
      if (Object.keys(changes).length) listeners.changed?.(changes, name);
    },
    setAccessLevel: async ({ accessLevel }) => {
      if (!lock) throw new Error('access level not set');
      levels.push({ area: name, accessLevel });
    },
  });
  const listeners = {};
  const event = (name) => ({ addListener: (fn) => void (listeners[name] = fn) });
  // The addresses requested, the ones the session rules stopped, the requests called off,
  // and how each request asked for redirects to be handled.
  const fetched = [];
  const blocked = [];
  const aborted = [];
  const modes = [];

  const ctx = vm.createContext({
    console, URL, Blob, AbortController, setTimeout, clearTimeout,
    importScripts: (...files) => {
      for (const f of files) vm.runInContext(src(f), ctx, { filename: f });
    },
    fetch: async function get(url, init = {}, redirected = false) {
      if (!redirected) modes.push(init.redirect);
      if (!lets(url)) {
        blocked.push(url);
        throw new TypeError('Failed to fetch');
      }
      fetched.push(url);
      const page = pages[url];
      const answer = (body, init) => {
        const res = new Response(body, init);
        // The answer names the address it came from, which is the last one in a chain.
        Object.defineProperties(res, { url: { value: url }, redirected: { value: redirected } });
        return res;
      };
      if (page === undefined) return answer('', { status: 404 });
      if (page.redirect) {
        // As in a browser: followed unless asked not to, and then the target stays hidden.
        if (init.redirect === 'manual') return { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() };
        if (init.redirect === 'error') throw new TypeError('redirected');
        return get(page.redirect, init, true);
      }
      if (page.hang) {
        return new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => {
            aborted.push(url);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }),
        );
      }
      const { type = 'text/html', body = page } = typeof page === 'string' ? {} : page;
      return answer(body, { headers: { 'content-type': type } });
    },
    chrome: {
      storage: { local: area(store.local, 'local'), session: area(store.session, 'session'), onChanged: event('changed') },
      permissions: {
        contains: async () => access.granted,
        // As in a browser: giving the access back is reported to whoever listens for it.
        remove: async (what) => {
          access.removed.push(JSON.parse(JSON.stringify(what)));
          if (!access.granted) return false;
          access.granted = false;
          listeners.removed?.(what);
          return true;
        },
        onRemoved: event('removed'),
      },
      runtime: {
        id: ID,
        onMessage: event('message'),
        onInstalled: event('installed'),
        onStartup: event('startup'),
        openOptionsPage() {},
      },
      tabs: {
        onUpdated: event('updated'),
        query: async () => tabs,
        // As in a browser: a document that is gone, or no longer the one its tab shows, is
        // not reached. The Hacker News page answers.
        sendMessage: async (tabId, message, options) => {
          if (left.has(options?.documentId)) throw new Error('Could not establish connection. Receiving end does not exist.');
          told.push(structuredClone([tabId, message, options]));
          return { ok: true };
        },
      },
      action: {},
      scripting: {},
      declarativeNetRequest: {
        updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
          if (!guard) throw new Error('rules not installed');
          for (const rule of addRules) {
            const unknown = Object.keys(rule.condition).filter((c) => !RULE_CONDITIONS.includes(c));
            if (unknown.length) throw new Error(`the stub does not weigh ${unknown}`);
          }
          const kept = rules.filter((r) => !removeRuleIds.includes(r.id));
          if (addRules.some((r) => kept.some((k) => k.id === r.id))) throw new Error('a rule with that id is there already');
          rules.splice(0, rules.length, ...kept, ...structuredClone(addRules));
        },
        getSessionRules: async () => structuredClone(rules),
      },
    },
  });
  vm.runInContext(src('background.js'), ctx, { filename: 'background.js' });

  // Answers are copied out of the worker's context, so that they compare as plain objects.
  const send = (message, sender = PAGE) =>
    new Promise((resolve) => listeners.message(message, sender, (res) => resolve(structuredClone(res))));
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
    await send({ type: 'stories', items: urls.map((url) => ({ url, site: ctx.HNPF.siteFor(url) })) }, HN);
    await idle();
  };
  // What on-visit detection reports for a story opened from a listing. `tab` is where the
  // tab is when the report arrives, `listed: false` a page that no listing linked to.
  // Detection is on while the report is taken, whatever the settings say otherwise.
  const visit = async (url, verdict = 'gated', { tab = url, listed = true, platform = false } = {}) => {
    if (listed) {
      const stories = (store.session.stories ??= {});
      stories[ctx.HNPF.pageKey(url)] ??= { url, site: ctx.HNPF.siteFor(url), at: Date.now() };
    }
    const { settings } = store.local;
    store.local.settings = { ...settings, visitDetect: true };
    try {
      return await send({ type: 'visitVerdict', url, verdict, reason: 'prompt on page', platform }, tabAt(tab));
    } finally {
      if (settings) store.local.settings = settings;
      else delete store.local.settings;
    }
  };
  const classify = (url) => ctx.HNPF.classify(url, { sites: {}, pages: {}, checks: {}, ...store.local });
  return { ctx, store, listeners, fetched, blocked, aborted, modes, rules, lets, access, tabs, levels, told, left, send, idle, list, visit, classify };
}

const bootWith = boot;
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

// A response body that arrives in pieces of the given sizes, then whatever is left.
function chunked(html, ...sizes) {
  const bytes = new TextEncoder().encode(html);
  return {
    body: new ReadableStream({
      start(controller) {
        let at = 0;
        for (const size of [...sizes, bytes.length]) {
          if (at < bytes.length) controller.enqueue(bytes.subarray(at, (at += size)));
        }
        controller.close();
      },
    }),
  };
}

test('background check: a long page is read up to a limit and no further', async () => {
  const LIMIT = 1_500_000;
  const declared = '<script type="application/ld+json">{"isAccessibleForFree": false}</script>';
  const prompt = '<div>Subscribe to continue reading.</div>';
  const padding = `<!--${'x'.repeat(LIMIT + 100_000)}-->`;
  const short = `<body><p>The start of the story.</p>${prompt}`;
  const fill = (html, length) => html + ' '.repeat(length - html.length);
  const b = boot({
    local: bgOn,
    pages: {
      'https://example.com/early': `<body>${declared}${prompt}${padding}${FREE}</body>`,
      'https://example.com/late': `<body>${FREE}${padding}${declared}${prompt}</body>`,
      'https://example.com/pieces': chunked(`<body>${FREE}${padding}${declared}${prompt}</body>`, 400_000, 400_000, 400_000),
      // Cut off before the article ends, so a short text proves nothing: also when a
      // piece ends right at the limit.
      'https://example.com/cut': `${short}${padding}${FREE}</body>`,
      'https://example.com/cut-at-limit': chunked(fill(short, LIMIT) + FREE, 500_000, 1_000_000),
      // A page that ends right at the limit was not cut off.
      'https://example.com/whole': chunked(fill(short, LIMIT), 500_000, 1_000_000),
    },
  });
  const verdict = async (name) => {
    await b.list(`https://example.com/${name}`);
    return b.classify(`https://example.com/${name}`).gated;
  };

  assert.equal(await verdict('early'), true);
  assert.equal(await verdict('late'), false);
  assert.equal(await verdict('pieces'), false);
  assert.equal(await verdict('cut'), false);
  assert.equal(await verdict('cut-at-limit'), false);
  assert.equal(await verdict('whole'), true);
});

test('background check: the site a story claims must fit its URL', async () => {
  const urls = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.send({ type: 'stories', items: urls.map((url) => ({ url, site: 'victim.org' })) }, HN);
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

// ---- redirects (#20) -----------------------------------------------------------------

const ELSEWHERE = 'could not be checked (redirects elsewhere)';

test('background check: the browser lets it request exactly the addresses it may fetch', async () => {
  const b = boot({ local: bgOn });
  assert.equal(await vm.runInContext('guarded', b.ctx), true);
  const urls = [
    // As in "only public https addresses on the default port are fetched".
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
    // Other spellings of a private address.
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[::ffff:192.168.1.1]/x',
    'https://0x7f.1/x',
    'https://2130706433/x',
    'https://user@example.com/x',
    'https://:secret@example.com/x',
    'https://example.com:80/x',
    'https://localhost./x',
    'https://nas.local./x',
    'https://NAS.Local/x',
    'https://printer.home/x',
    'https://deep.sub.router.lan/x',
    'https://example.onion/x',
    'https://example.1a/x',
    'https://a..example.com/x',
    'ftp://example.com/x',
    // Public names, also as a reader might type them.
    'https://example.com/x',
    'https://example.com:443/x',
    'https://example.com./x',
    'HTTPS://WWW.Example.COM/X?Y=1#top',
    'https://news.example.co.uk/a/b?c=d',
    'https://xn--bcher-kva.example/a',
    'https://bücher.example/a',
    'https://localhost.example.com/x',
    'https://example.local.com/x',
    'https://a_b.example.com/x',
    'https://example.com?q=1',
  ];
  for (const url of urls) assert.equal(b.lets(url), b.ctx.fetchable(url), url);
  assert.ok(urls.some((url) => b.lets(url)) && urls.some((url) => !b.lets(url)));

  // Only the service worker's own requests are held to them, not a page the reader opens.
  for (const { condition } of b.rules) {
    assert.deepEqual([condition.initiatorDomains, condition.tabIds, condition.resourceTypes], [[ID], [-1], ['xmlhttprequest']]);
  }
  // Chromium reads the pattern as RE2, which knows no lookaround and no backreference.
  const { regexFilter } = b.rules.find((r) => r.action.type === 'allow').condition;
  assert.doesNotMatch(regexFilter, /\(\?[=!<]|\\[1-9]/);
  // A service worker starting again in the same browser session puts the same rules in place.
  assert.equal(await vm.runInContext('installGuard()', b.ctx), true);
  assert.deepEqual(b.rules.map((r) => r.id).sort(), [1, 2]);
});

test('background check: a redirect to an address it may not fetch is never requested', async () => {
  const url = 'https://example.com/a';
  const targets = [
    'http://192.168.1.1/apply.cgi?action=reboot',
    'https://localhost/x',
    'https://nas.local/x',
    'https://10.0.0.5:8443/x',
    'http://example.com/x',
    'https://[::1]/x',
    'https://router/x',
  ];
  for (const target of targets) {
    // Straight there, or by way of a public name.
    for (const hops of [[], ['https://short.example/b']]) {
      const chain = [url, ...hops, target];
      const pages = { [target]: WALL };
      for (let i = 0; i < chain.length - 1; i++) pages[chain[i]] = { redirect: chain[i + 1] };
      const b = boot({ local: bgOn, pages });
      await b.list(url);

      assert.deepEqual([b.modes, b.fetched, b.blocked], [['follow'], chain.slice(0, -1), [target]], target);
      const { verdict, reason } = b.store.local.checks['p:example.com/a'];
      assert.deepEqual([verdict, reason], ['unknown', 'could not be fetched'], target);
      assert.equal(b.classify(url).gated, false, target);
    }
  }
});

test('background check: an answer from an address it may not fetch is not judged, should the browser let it through', async () => {
  const url = 'https://example.com/a';
  const target = 'https://nas.local/a';
  const b = boot({ local: bgOn, enforce: false, pages: { [url]: { redirect: target }, [target]: WALL } });
  // Nor does it say where it came from: no verdict is to be filed under such an address.
  assert.deepEqual(structuredClone(await b.ctx.fetchVerdict(url)), { verdict: 'unknown', reason: ELSEWHERE });
  await b.list(url);

  assert.deepEqual(b.fetched, [url, target, url, target]);
  assert.deepEqual([b.store.local.sites ?? {}, b.store.local.pages ?? {}], [{}, {}]);
  const entry = b.store.local.checks['p:example.com/a'];
  assert.deepEqual([entry.verdict, entry.reason, Object.hasOwn(entry, 'landed')], ['unknown', ELSEWHERE, false]);
});

test('background check: a redirect that only tidies the address is judged as the link posted', async () => {
  const pages = {
    'https://example.com/a?utm_source=hn': { redirect: 'https://www.example.com/a/' },
    'https://www.example.com/a/': WALL,
    'https://example.com/b': { redirect: 'https://example.com/b/' },
    'https://example.com/b/': FREE,
  };
  const b = boot({ local: bgOn, pages });
  await b.list('https://example.com/a?utm_source=hn', 'https://example.com/b');

  assert.deepEqual(b.fetched, Object.keys(pages));
  assert.deepEqual(Object.keys(b.store.local.pages), ['example.com/a']);
  assert.equal(b.classify('https://example.com/a?utm_source=hn').gated, true);
  assert.equal(b.store.local.checks['p:example.com/b'].verdict, 'free');
});

test('background check: a link that leads to another page is judged by that page, filed under it and its site', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://www.paywalled-news.example/2026/article/?utm_source=linkedin&id=7';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: target }, [target]: WALL } });
  await b.list(url);

  assert.deepEqual(b.fetched, [url, target]);
  const key = 'paywalled-news.example/2026/article?id=7';
  const page = b.store.local.pages[key];
  assert.deepEqual([page.status, page.source, page.site], ['gated', 'check', 'paywalled-news.example']);
  assert.deepEqual(Object.keys(b.store.local.pages), [key]);
  // Where it led is kept as the page, without what tracks the reader.
  const to = 'https://' + key;
  assert.deepEqual(b.store.local.redirects, { 'lnkd.in/abc123': { to, at: b.store.local.redirects['lnkd.in/abc123'].at } });
  assert.deepEqual(b.store.session.stories[key], { url: to, site: 'paywalled-news.example', at: b.store.session.stories[key].at });
  assert.ok(b.ctx.isPageKey(key));
  // The link stands for nothing itself.
  assert.deepEqual([b.store.local.sites, b.store.local.checks], [{}, {}]);
  const c = b.classify(url);
  assert.deepEqual([c.gated, c.source, c.key], [true, 'page', key]);
  assert.equal(b.classify('https://lnkd.in/other').gated, false);
  assert.equal(b.ctx.HNPF.storyFor(b.store.session.stories, target).url, to);
});

test('background check: links that lead to walled articles hide their site, never the links', async () => {
  const links = ['abc123', 'def456', 'ghi789'].map((id) => `https://lnkd.in/${id}`);
  const targets = [1, 2, 3].map((n) => `https://paywalled-news.example/article/${n}`);
  const pages = {};
  links.forEach((url, i) => Object.assign(pages, { [url]: { redirect: targets[i] }, [targets[i]]: WALL }));
  const b = boot({ local: bgOn, pages });
  await b.list(...links);

  assert.deepEqual([...b.fetched].sort(), [...links, ...targets].sort());
  assert.deepEqual(Object.keys(b.store.local.sites), ['paywalled-news.example']);
  assert.equal(b.store.local.sites['paywalled-news.example'].articles, 3);
  for (const url of links) assert.equal(b.classify(url).gated, true, url);
  assert.equal(b.classify('https://paywalled-news.example/article/4').gated, true);
  assert.equal(b.classify('https://lnkd.in/other').gated, false);
});

test('background check: links that all lead to one article count as that one article', async () => {
  const links = ['abc123', 'def456', 'ghi789'].map((id) => `https://lnkd.in/${id}`);
  const target = 'https://paywalled-news.example/article';
  const pages = { [target]: WALL };
  for (const url of links) pages[url] = { redirect: target };
  const b = boot({ local: bgOn, pages });
  await b.list(...links);

  // Enough links to hide a site, had each been counted as an article of its own.
  assert.deepEqual([b.store.local.sites, Object.keys(b.store.local.pages)], [{}, ['paywalled-news.example/article']]);
  for (const url of links) assert.equal(b.classify(url).gated, true, url);
  assert.equal(b.classify('https://paywalled-news.example/other').gated, false);
  assert.equal(b.classify('https://lnkd.in/other').gated, false);
});

test('background check: a link that leads to a site on the list, or one you always show, files nothing for that page', async () => {
  const url = 'https://lnkd.in/abc123';
  for (const [target, sites, gated] of [
    ['https://www.nytimes.com/2026/a.html', {}, true],
    ['https://shown.example/a', { 'shown.example': { status: 'allowed', source: 'manual', at: 1 } }, false],
  ]) {
    const b = boot({ local: { ...bgOn, sites }, pages: { [url]: { redirect: target }, [target]: WALL } });
    await b.list(url);

    assert.deepEqual([b.store.local.sites, b.store.local.pages, b.store.local.checks], [sites, {}, {}], target);
    assert.equal(b.store.local.redirects['lnkd.in/abc123'].to, 'https://' + b.ctx.HNPF.pageKey(target));
    const c = b.classify(url);
    assert.deepEqual([c.gated, c.source], [gated, gated ? 'seed' : 'allowed'], target);
  }
});

test('background check: a link that leads to a free article leaves the story shown', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://blog.example/post';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: target }, [target]: FREE } });
  await b.list(url);

  assert.deepEqual(Object.keys(b.store.local.checks), ['p:blog.example/post']);
  const { verdict, source, site } = b.store.local.checks['p:blog.example/post'];
  // A page a link leads to counts as no article of its site, should it be free.
  assert.deepEqual([verdict, source, site], ['free', 'check', undefined]);
  assert.equal(b.classify(url).gated, false);
});

test('background check: a link is checked again once the page it leads to wants checking', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: target }, [target]: WALL } });
  await b.list(url);
  await b.list(url);
  assert.deepEqual(b.fetched, [url, target]);

  // The verdict on the page went out of use. Where the link leads is kept as long as the
  // new one, as the two go together.
  b.store.local.pages['paywalled-news.example/article'].at -= 31 * DAY;
  b.store.local.redirects['lnkd.in/abc123'].at -= 15 * DAY;
  await b.list(url);
  assert.deepEqual(b.fetched, [url, target, url, target]);
  assert.equal(b.classify(url).gated, true);
  assert.ok(Date.now() - b.store.local.redirects['lnkd.in/abc123'].at < DAY);

  // A check that files nothing new leaves it as it was: an open HN page draws again for
  // every change to it.
  const { at } = b.store.local.redirects['lnkd.in/abc123'];
  const writes = [];
  const { set } = b.ctx.chrome.storage.local;
  b.ctx.chrome.storage.local.set = async (patch) => (writes.push(Object.keys(patch)), set(patch));
  await new Promise((r) => setTimeout(r, 5));
  await b.ctx.check({ url, site: 'lnkd.in' });
  b.ctx.chrome.storage.local.set = set;
  assert.equal(b.store.local.redirects['lnkd.in/abc123'].at, at);
  assert.ok(writes.length && writes.every((keys) => !keys.includes('redirects')), JSON.stringify(writes));

  // Or what the link leads to did.
  b.store.local.redirects['lnkd.in/abc123'].at -= 31 * DAY;
  await b.list(url);
  assert.equal(b.fetched.length, 8);
  assert.ok(Date.now() - b.store.local.redirects['lnkd.in/abc123'].at < DAY);
});

test('background check: a verdict that goes out of use before where the link leads leaves that alone', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://open-news.example/article';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: target }, [target]: FREE } });
  await b.list(url);
  b.store.local.checks['p:open-news.example/article'].at -= 15 * DAY;
  b.store.local.redirects['lnkd.in/abc123'].at -= 5 * DAY;
  const { at } = b.store.local.redirects['lnkd.in/abc123'];

  const writes = [];
  const { set } = b.ctx.chrome.storage.local;
  b.ctx.chrome.storage.local.set = async (patch) => (writes.push(Object.keys(patch)), set(patch));
  await b.list(url);
  b.ctx.chrome.storage.local.set = set;
  assert.deepEqual(b.fetched, [url, target, url, target]);
  assert.ok(Date.now() - b.store.local.checks['p:open-news.example/article'].at < DAY);
  // The free verdict lasts 14 days, where the link leads 25 more: an open HN page has
  // nothing to draw again for.
  assert.equal(b.store.local.redirects['lnkd.in/abc123'].at, at);
  assert.ok(writes.length && writes.every((keys) => !keys.includes('redirects')), JSON.stringify(writes));
});

test('background check: a page a reader is only sent to on the way is not taken for the article', async () => {
  const pages = {
    // A consent, sign-in or paywall page that names the article to come back to.
    'https://news.example/a': { redirect: 'https://consent.news.example/?return=https%3A%2F%2Fnews.example%2Fa' },
    'https://news.example/b/': { redirect: 'https://news.example/login?next=%2Fb%3Fx%3D1' },
    'https://news.example/c': { redirect: 'https://accounts.example/signin?continue=https://WWW.news.example/c/' },
    // A page at the root that its query names, which only the address in full can tell.
    'https://forum.example/?p=5': { redirect: 'https://login.example/?next=https%3A%2F%2Fforum.example%2F%3Fp%3D5' },
    // A missing article, sent to the front page, tracking parameters or not.
    'https://news.example/d': { redirect: 'https://news.example/' },
    'https://news.example/e': { redirect: 'https://news.example/?utm_source=moved' },
    'https://consent.news.example/?return=https%3A%2F%2Fnews.example%2Fa': WALL,
    'https://news.example/login?next=%2Fb%3Fx%3D1': WALL,
    'https://accounts.example/signin?continue=https://WWW.news.example/c/': WALL,
    'https://login.example/?next=https%3A%2F%2Fforum.example%2F%3Fp%3D5': WALL,
    'https://news.example/': WALL,
    'https://news.example/?utm_source=moved': WALL,
  };
  const posted = ['https://news.example/a', 'https://news.example/b/', 'https://news.example/c', 'https://news.example/d', 'https://news.example/e', 'https://forum.example/?p=5'];
  const b = boot({ local: bgOn, pages });
  await b.list(...posted);

  assert.deepEqual([b.store.local.redirects ?? {}, b.store.local.pages, b.store.local.sites], [{}, {}, {}]);
  for (const url of posted) {
    assert.equal(b.store.local.checks['p:' + b.ctx.HNPF.pageKey(url)].reason, ELSEWHERE, url);
    assert.equal(b.classify(url).gated, false, url);
  }
  assert.deepEqual(Object.keys(b.store.session.stories).sort(), posted.map((u) => b.ctx.HNPF.pageKey(u)).sort());

  // A page whose query merely shares a word with the link is the article all the same,
  // and so is a front page that a link to a front page leads to, and an article at the
  // root that its query names.
  const more = {
    'https://lnkd.in/a': { redirect: 'https://other.example/story?id=a&from=/ab' },
    'https://other.example/story?id=a&from=/ab': WALL,
    'https://short.example/': { redirect: 'https://other.example/' },
    'https://other.example/': WALL,
    'https://short.example/p5': { redirect: 'https://forum.example/?p=5' },
    'https://forum.example/?p=5': WALL,
  };
  const c = boot({ local: bgOn, pages: more });
  await c.list('https://lnkd.in/a', 'https://short.example/', 'https://short.example/p5');
  assert.deepEqual(Object.keys(c.store.local.redirects).sort(), ['lnkd.in/a', 'short.example', 'short.example/p5']);
});

test('background check: a free page a link leads to does not count as a free article on its site', async () => {
  const link = 'https://lnkd.in/abc123';
  const free = 'https://example.com/news/open';
  const urls = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: { [link]: { redirect: free }, [free]: FREE, ...Object.fromEntries(urls.map((u) => [u, WALL])) } });
  await b.list(link);
  const entry = b.store.local.checks['p:example.com/news/open'];
  assert.deepEqual([entry.verdict, Object.hasOwn(entry, 'site')], ['free', false]);
  await b.list(...urls);
  assert.equal(b.store.local.sites['example.com'].articles, 3);
});

test('background check: a free page a link leads to on its own site counts as a free article there', async () => {
  // An article that moved to another address on the same site.
  const moved = 'https://example.com/news/old-slug';
  const free = 'https://example.com/news/new-slug';
  const urls = [1, 2, 3].map((n) => `https://example.com/news/${n}`);
  const b = boot({ local: bgOn, pages: { [moved]: { redirect: free }, [free]: FREE, ...Object.fromEntries(urls.map((u) => [u, WALL])) } });
  await b.list(moved);
  const entry = b.store.local.checks['p:example.com/news/new-slug'];
  assert.deepEqual([entry.verdict, entry.site], ['free', 'example.com']);
  await b.list(...urls);
  assert.equal(b.store.local.sites['example.com'], undefined);
});

test('background check: a page a link leads to is judged as itself, not by where it once led', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://moved.example/article';
  const now = Date.now();
  // The page once led on to a site on the list; now it answers for itself. The link was
  // found to lead to it before, and nothing is known of the page itself any more.
  const redirects = {
    'lnkd.in/abc123': { to: target, at: now },
    'moved.example/article': { to: 'https://www.nytimes.com/2026/a.html', at: now },
  };
  const b = boot({ local: { ...bgOn, redirects }, pages: { [url]: { redirect: target }, [target]: WALL } });
  await b.list(url);

  assert.deepEqual(b.fetched, [url, target]);
  assert.deepEqual(Object.keys(b.store.local.pages), ['moved.example/article']);
  assert.deepEqual(Object.keys(b.store.local.redirects), ['lnkd.in/abc123']);
  const c = b.classify(url);
  assert.deepEqual([c.gated, c.source, c.key], [true, 'page', 'moved.example/article']);
});

test('background check: a link that could not be checked again waits like any other', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const pages = { [url]: { redirect: target }, [target]: WALL };
  const b = boot({ local: bgOn, pages });
  await b.list(url);
  b.store.local.pages['paywalled-news.example/article'].at -= 31 * DAY;

  delete pages[url];
  await b.list(url);
  await b.list(url);
  assert.deepEqual(b.fetched, [url, target, url]);
  assert.equal(b.store.local.checks['p:lnkd.in/abc123'].verdict, 'unknown');
});

test('background check: a link that no longer leads elsewhere is judged as itself again', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const pages = { [url]: { redirect: target }, [target]: WALL };
  const b = boot({ local: bgOn, pages });
  await b.list(url);
  b.store.local.pages['paywalled-news.example/article'].at -= 31 * DAY;

  pages[url] = FREE;
  await b.list(url);
  assert.deepEqual(b.store.local.redirects, {});
  assert.equal(b.store.local.checks['p:lnkd.in/abc123'].verdict, 'free');
  assert.equal(b.classify(url).gated, false);
});

test('background check: an answer from another page is judged, and says where it came from', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const long = `https://paywalled-news.example/${'a'.repeat(5000)}`;
  const b = boot({ pages: { [url]: { redirect: target }, [target]: WALL, 'https://lnkd.in/long': { redirect: long }, [long]: WALL } });
  const { verdict, landed } = await b.ctx.fetchVerdict(url);
  assert.deepEqual([verdict, landed], ['gated', target]);
  // An address too long to keep is not kept as where the link led.
  assert.deepEqual(structuredClone(await b.ctx.fetchVerdict('https://lnkd.in/long')), { verdict: 'unknown', reason: ELSEWHERE });
});

test('background check: a redirect is not followed without the rules in place, or without the access they need', async () => {
  const url = 'https://example.com/a';
  const pages = { [url]: { redirect: 'https://www.example.com/a/' }, 'https://www.example.com/a/': WALL };

  // The rules could not be installed, which the worker reports.
  const logged = [];
  const { error } = console;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  let failed;
  try {
    failed = boot({ local: bgOn, guard: false, pages });
    assert.equal(await vm.runInContext('guarded', failed.ctx), false);
  } finally {
    console.error = error;
  }
  assert.deepEqual(logged, ['hnpf: redirect guard not installed Error: rules not installed']);
  await failed.list(url);
  assert.deepEqual([failed.modes, failed.fetched], [['manual'], [url]]);
  assert.equal(failed.store.local.checks['p:example.com/a'].reason, ELSEWHERE);

  // Without the access they do nothing. No listing is checked then, so the check is
  // asked directly, as one under way when the access went would be.
  const bare = boot({ granted: false, pages });
  assert.deepEqual(structuredClone(await bare.ctx.fetchVerdict(url)), { verdict: 'unknown', reason: ELSEWHERE });
  assert.deepEqual([bare.modes, bare.fetched], [['manual'], [url]]);
});

test('background check: a fetch under way is called off once the check is switched off or loses its access', async () => {
  const url = 'https://example.com/slow';
  for (const stop of [
    (b) => b.send({ type: 'setSettings', patch: { bgCheck: false } }),
    (b) => ((b.access.granted = false), b.listeners.removed(ALL_SITES)),
  ]) {
    const b = boot({ local: bgOn, pages: { [url]: { hang: true } } });
    await b.send({ type: 'stories', items: [{ url, site: null }] }, HN);
    for (let i = 0; i < 100 && !b.fetched.length; i++) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(b.fetched, [url]);

    await stop(b);
    await b.idle();
    assert.deepEqual(b.aborted, [url]);
    assert.deepEqual([b.store.local.pages, b.store.local.checks], [undefined, undefined]);
  }
});

test('background check: a fetch under way is called off at once when the access goes, whatever waits in the storage queue', async () => {
  const url = 'https://example.com/slow';
  const b = boot({ local: bgOn, pages: { [url]: { hang: true } } });
  await b.send({ type: 'stories', items: [{ url, site: null }] }, HN);
  for (let i = 0; i < 100 && !b.fetched.length; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(b.fetched, [url]);

  // A write already queued keeps syncAccess() waiting, while the guard no longer holds.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const busy = b.ctx.inTurn(() => held);
  b.access.granted = false;
  const synced = b.listeners.removed(ALL_SITES);
  assert.deepEqual(b.aborted, [url]);

  release();
  await busy;
  await synced;
  await b.idle();
  assert.deepEqual([b.store.local.pages, b.store.local.checks], [undefined, undefined]);
});

test('background check: a link that leads to a free page is not fetched again on the next listing', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://blog.example/post';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: target }, [target]: FREE } });
  await b.list(url);
  await b.list(url);
  await b.list(url);
  assert.deepEqual(b.fetched, [url, target]);
});

test('background check: what the link itself was found to be gives way once it leads elsewhere', async () => {
  const url = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  // An earlier check of the link failed, long enough ago to be tried again.
  const checks = { 'p:lnkd.in/abc123': { verdict: 'unknown', reason: 'could not be fetched', source: 'check', site: 'lnkd.in', at: Date.now() - 4 * DAY } };
  const b = boot({ local: { ...bgOn, checks }, pages: { [url]: { redirect: target }, [target]: WALL } });
  await b.list(url);
  assert.equal(b.store.local.checks['p:lnkd.in/abc123'], undefined);
  assert.equal(b.classify(url).gated, true);
});

test('background check: same page with parameters a site adds of its own is judged as the link posted', async () => {
  const pages = {
    'https://blog.example/post': { redirect: 'https://blog.example/post?gi=abc123' },
    'https://blog.example/post?gi=abc123': WALL,
    'https://forum.example/item?id=5': { redirect: 'https://forum.example/item?id=5&sid=x' },
    'https://forum.example/item?id=5&sid=x': FREE,
    // A parameter the link carried itself, though it names a path, is no address to return to.
    'https://example.org/read?u=/read/2': { redirect: 'https://www.example.org/read?u=/read/2' },
    'https://www.example.org/read?u=/read/2': WALL,
    // At the root of a site the query names the page, so this one is another.
    'https://example.net/': { redirect: 'https://example.net/?p=7' },
    'https://example.net/?p=7': WALL,
  };
  const b = boot({ local: bgOn, pages });
  await b.list('https://blog.example/post', 'https://forum.example/item?id=5', 'https://example.net/', 'https://example.org/read?u=/read/2');

  assert.deepEqual(Object.keys(b.store.local.redirects), ['example.net']);
  assert.deepEqual(Object.keys(b.store.local.pages).sort(), ['blog.example/post', 'example.net?p=7', 'example.org/read?u=%2Fread%2F2']);
  assert.equal(b.store.local.checks['p:forum.example/item?id=5'].verdict, 'free');
});

test('background check: a sign-in page on the link\'s own address is not taken for the article', async () => {
  const url = 'https://example.com/index.php';
  const login = 'https://example.com/index.php?login=1&return=%2Findex.php';
  const b = boot({ local: bgOn, pages: { [url]: { redirect: login }, [login]: WALL } });
  await b.list(url);

  assert.deepEqual([b.store.local.pages ?? {}, b.store.local.redirects ?? {}], [{}, {}]);
  const { verdict, reason } = b.store.local.checks['p:example.com/index.php'];
  assert.deepEqual([verdict, reason], ['unknown', 'could not be checked (redirects elsewhere)']);
  assert.equal(b.classify(url).gated, false);
});

test('the redirect guard asks for no permission that warns on install', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  // The plain "declarativeNetRequest" warns that the extension can block content on any page.
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.ok(!manifest.permissions.includes('declarativeNetRequest'));
});

test('on-visit detection: a story link that led to another site is not judged by that site', async () => {
  const story = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const b = boot();
  await b.visit(story, 'gated', { tab: target });
  await b.visit(target, 'gated', { listed: false });

  assert.deepEqual(b.store.local, {});
  assert.equal(b.ctx.HNPF.storyFor(b.store.session.stories, target), null);
});

test('on-visit detection: once the check found where a story link leads, a visit to that page is judged as that page', async () => {
  const story = 'https://lnkd.in/abc123';
  const target = 'https://blog.example/post';
  const b = boot({ local: { settings: { bgCheck: true, visitDetect: true } }, pages: { [story]: { redirect: target }, [target]: FREE } });
  const injected = [];
  b.ctx.chrome.scripting.executeScript = async ({ target: { tabId } }) => void injected.push(tabId);
  await b.list(story);
  assert.equal(b.classify(story).gated, false);

  await b.ctx.maybeDetect(7, target + '?ref=hn');
  assert.deepEqual(injected, [7]);
  await b.visit(target, 'gated', { listed: false });
  const page = b.store.local.pages['blog.example/post'];
  assert.deepEqual([page.status, page.source, page.site], ['gated', 'visit', 'blog.example']);
  assert.equal(b.classify(story).gated, true);
  assert.equal(b.store.local.pages['lnkd.in/abc123'], undefined);
});

test('stories: a page a link leads to that was listed itself keeps the site Hacker News gave it', async () => {
  const link = 'https://lnkd.in/abc123';
  const target = 'https://www.news.example.co.uk/a/';
  const b = boot({ local: bgOn, pages: { [link]: { redirect: target }, [target]: WALL } });
  // Listed while the check was off, so that it is judged by way of the link alone.
  const at = Date.now() - DAY;
  b.store.session.stories = { 'news.example.co.uk/a': { url: target, site: 'news.example.co.uk', at } };
  await b.list(link);
  assert.deepEqual(b.fetched, [link, target]);
  assert.deepEqual(Object.keys(b.store.session.stories).sort(), ['lnkd.in/abc123', 'news.example.co.uk/a']);
  // The story stays as the listing gave it, kept as long as the link's.
  const story = b.store.session.stories['news.example.co.uk/a'];
  assert.deepEqual([story.url, story.site], [target, 'news.example.co.uk']);
  assert.ok(story.at > at);
  // The check files the article under the same name as a visit to it would.
  assert.equal(b.store.local.pages['news.example.co.uk/a'].site, 'news.example.co.uk');
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

test('on-visit detection: a wall found after the page was reported free replaces that report', async () => {
  const b = boot();
  const url = 'https://example.com/a';
  await b.visit(url, 'free');
  assert.equal(b.store.local.checks['p:example.com/a'].verdict, 'free');

  await b.visit(url, 'gated');
  assert.equal(b.classify(url).gated, true);
  assert.equal(b.store.local.checks['p:example.com/a'], undefined);
  // The article no longer counts as a free one on its site.
  for (const path of ['b', 'c']) await b.visit(`https://example.com/${path}`, 'gated');
  assert.equal(b.store.local.sites['example.com'].status, 'gated');
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
  await b.send({ type: 'visitVerdict', verdict: 'gated', reason: 'r' }, tabAt(story));

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

  await b.send({ type: 'seenSites', domains: ['example.com', 'unknown.example'] }, HN);
  assert.equal(site().seen, true);
  assert.deepEqual(Object.keys(b.store.local.sites), ['example.com']);

  // The user's own entries carry no such mark.
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await b.send({ type: 'seenSites', domains: ['example.com'] }, HN);
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

test('a free visit to a link that leads to a page on a hidden site does not open that site', async () => {
  const now = Date.now();
  const link = 'https://news.example/a';
  const found = (n) => [`walled.example/${n}`, { status: 'gated', source: 'check', reason: 'r', site: 'walled.example', at: now }];
  const local = {
    sites: { 'walled.example': { status: 'gated', source: 'check', reason: '3 articles on this site looked gated', articles: 3, at: now } },
    pages: Object.fromEntries([1, 2, 3].map(found)),
    redirects: { 'news.example/a': { to: 'https://walled.example/story', at: now } },
  };
  // The tab stayed on the link: what it showed is the link's, not that page's.
  const b = boot({ local });
  await b.visit(link, 'free');
  assert.ok(b.store.local.sites['walled.example']);
  assert.equal(b.classify('https://walled.example/4').gated, true);
  assert.equal(b.store.local.checks['p:news.example/a'].verdict, 'free');
});

test('the toolbar badge follows where a story link leads once the check found it', async () => {
  const b = boot();
  const badges = [];
  b.ctx.chrome.action = new Proxy({}, { get: (_, name) => async (arg) => void (name === 'setBadgeText' && badges.push(arg.text)) });
  b.tabs.push({ id: 4, url: 'https://lnkd.in/abc123' });
  b.store.local.redirects = { 'lnkd.in/abc123': { to: 'https://www.nytimes.com/2026/a.html', at: Date.now() } };
  b.listeners.changed({ redirects: {} }, 'local');
  for (let i = 0; i < 20 && !badges.length; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(badges, ['!']);
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

test('startup: expired verdicts are dropped, your own entries are kept', async () => {
  const old = Date.now() - 31 * DAY;
  const b = boot({
    local: {
      sites: {
        'mine.example': { status: 'gated', source: 'manual', at: old },
        'promoted.example': { status: 'gated', source: 'check', reason: 'r', articles: 3, at: old },
      },
      pages: {
        'example.com/shown': { status: 'allowed', source: 'manual', at: old },
        'example.com/found': { status: 'gated', source: 'check', reason: 'r', site: 'example.com', at: old },
        'example.com/visited': { status: 'gated', source: 'visit', reason: 'r', site: 'example.com', at: old },
      },
      redirects: {
        'lnkd.in/old': { to: 'https://example.com/found', at: old },
        'lnkd.in/new': { to: 'https://example.com/shown', at: Date.now() - DAY },
      },
    },
  });
  b.listeners.startup();
  await vm.runInContext('chain', b.ctx);

  assert.deepEqual(Object.keys(b.store.local.sites), ['mine.example']);
  assert.deepEqual(Object.keys(b.store.local.pages), ['example.com/shown']);
  assert.deepEqual(Object.keys(b.store.local.redirects), ['lnkd.in/new']);
});

test('background check: an article you chose to show long ago is still left alone', async () => {
  const url = 'https://example.com/shown';
  const pages = { 'example.com/shown': { status: 'allowed', source: 'manual', at: Date.now() - 31 * DAY } };
  const b = boot({ local: { ...bgOn, pages }, pages: { [url]: WALL } });
  await b.list(url);

  assert.deepEqual(b.fetched, []);
  assert.equal(b.classify(url).source, 'allowed');
  await b.visit(url);
  assert.equal(b.classify(url).source, 'allowed');
});

test('background check: an expired verdict on a subdomain does not open a site you decided on', async () => {
  const urls = ['https://blog.example.com/a', 'https://blog.example.org/a'];
  const old = { status: 'gated', source: 'check', reason: 'r', articles: 3, at: Date.now() - 31 * DAY };
  const sites = {
    'example.com': { status: 'gated', source: 'manual', at: 1 },
    'blog.example.com': old,
    'example.org': { status: 'allowed', source: 'manual', at: 1 },
    'blog.example.org': old,
  };
  const b = boot({ local: { ...bgOn, sites }, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  await b.list(...urls);
  for (const url of urls) await b.visit(url);

  assert.deepEqual(b.fetched, []);
  assert.deepEqual(b.store.local.pages ?? {}, {});
  assert.equal(b.classify(urls[0]).gated, true);
  assert.equal(b.classify(urls[1]).source, 'allowed');
});

test('update from 0.1.2: site verdicts reached from a single page are forgotten', async () => {
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
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.2' });
  await vm.runInContext('chain', b.ctx);

  // The site hidden for several articles and the platform mark go as well: they are what
  // the update from 0.1.3 forgets, and 0.1.2 is older than that too.
  assert.deepEqual(Object.keys(b.store.local.sites).sort(), ['mine.example', 'shown.example']);
  assert.deepEqual(Object.keys(b.store.local.checks).sort(), ['p:example.com/a']);
});

test('update: what an older version got wrong is forgotten once, on the update from that version', async () => {
  const now = Date.now();
  // What 0.1.2 and the versions before the first one published would have left behind.
  const local = () => ({
    pages: {
      'example.com/metered': { status: 'gated', source: 'visit', reason: 'page metadata says it is not free to read', site: 'example.com', at: now },
    },
    sites: {
      'single.example': { status: 'gated', source: 'check', reason: 'page metadata marks it "metered"', at: now },
    },
    checks: {
      'd:free.example': { verdict: 'free', reason: '', at: now },
    },
  });
  for (const details of [
    // 0.1.3 is the first version that left none of this behind.
    { reason: 'update', previousVersion: '0.1.3' },
    { reason: 'update', previousVersion: '0.1.11' },
    { reason: 'update', previousVersion: '0.1.14' },
    { reason: 'update' },
    { reason: 'install' },
    { reason: 'chrome_update' },
  ]) {
    const b = boot({ local: local() });
    b.listeners.installed(details);
    await vm.runInContext('chain', b.ctx);
    // The table of where links led is written back as well, empty.
    assert.deepEqual(b.store.local, { ...local(), redirects: {} }, JSON.stringify(details));
  }
});

test('update: nothing cleans up after a version that was never published', async () => {
  const now = Date.now();
  // The first version published is 0.1.2: there is nothing older to clean up after.
  const local = () => ({
    pages: {
      'example.com/a': { status: 'gated', source: 'visit', reason: 'page metadata says it is not free to read', site: 'example.com', at: now },
      'example.com/b': { status: 'gated', source: 'visit', reason: 'page metadata marks it "metered"', site: 'example.com', at: now },
    },
  });
  const b = boot({ local: local() });
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.2' });
  await vm.runInContext('chain', b.ctx);
  assert.deepEqual(b.store.local.pages, local().pages);
});

test('update from 0.1.3: verdicts that rest on gate wording are forgotten', async () => {
  const now = Date.now();
  const local = () => ({
    pages: {
      'example.com/a': { status: 'gated', source: 'check', reason: 'page is cut short with a prompt: “hit the limit”', site: 'example.com', at: now },
      'example.com/b': { status: 'gated', source: 'visit', reason: 'prompt on page: “Log in to view this”', site: 'example.com', at: now },
      'example.com/c': { status: 'gated', source: 'visit', reason: 'overlay on page: “reached the limit”', site: 'example.com', at: now },
      'example.com/locked': { status: 'gated', source: 'visit', reason: 'page metadata marks it "locked"', site: 'example.com', at: now },
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
  later.listeners.installed({ reason: 'update', previousVersion: '0.1.8' });
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
        'example.com/d': gated('visit', 'page is cut short with a prompt: “Subscribe to continue reading”'),
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

test('update from 0.1.10: what a visit took for a wall because a Piano modal was up is forgotten', async () => {
  const now = Date.now();
  const gated = (source, reason) => ({ status: 'gated', source, reason, site: 'example.com', at: now });
  const local = {
    pages: {
      'example.com/a': gated('visit', 'subscription overlay blocks the page'),
      'example.com/b': gated('visit', 'sign-in or subscribe overlay blocks the page'),
      'example.com/c': gated('visit', 'an offer that cannot be closed covers the page'),
      'example.com/d': gated('check', 'page is cut short with a prompt: “Subscribe to continue reading”'),
      'example.com/mine': { status: 'gated', source: 'manual', at: now },
      'mine.example/a': { ...gated('visit', 'subscription overlay blocks the page'), site: 'mine.example' },
    },
    sites: {
      'example.com': { status: 'gated', source: 'visit', reason: '3 articles on this site looked gated', articles: 3, at: now },
      'other.example': { status: 'gated', source: 'check', reason: '3 articles on this site looked gated', articles: 3, at: now },
      'mine.example': { status: 'gated', source: 'manual', at: now },
    },
  };
  const b = boot({ local });
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.10' });
  await vm.runInContext('chain', b.ctx);

  assert.deepEqual(Object.keys(b.store.local.pages).sort(), ['example.com/b', 'example.com/c', 'example.com/d', 'example.com/mine']);
  // A site hidden for articles that were judged some other way stays hidden, and so does
  // one the user hid.
  assert.deepEqual(Object.keys(b.store.local.sites), ['other.example', 'mine.example']);

  // Later versions keep what they found.
  const later = boot({ local });
  later.listeners.installed({ reason: 'update', previousVersion: '0.1.11' });
  await vm.runInContext('chain', later.ctx);
  assert.ok(later.store.local.pages['example.com/a']);
  assert.ok(later.store.local.sites['example.com']);
});

test('update from 0.1.7: what the background check filed while it followed redirects is forgotten', async () => {
  const now = Date.now();
  const gated = (source, extra = {}) => ({ status: 'gated', source, reason: 'r', at: now, ...extra });
  const local = () => ({
    pages: {
      'lnkd.in/abc123': gated('check', { site: 'lnkd.in' }),
      'example.com/seen': gated('visit', { site: 'example.com' }),
      'example.com/mine': gated('manual'),
    },
    sites: {
      'lnkd.in': gated('check', { articles: 3 }),
      'mine.example': gated('manual'),
    },
    checks: {
      'd:blog.example': { verdict: 'mixed', at: now },
      'p:lnkd.in/free': { verdict: 'free', reason: '', source: 'check', site: 'lnkd.in', at: now },
      'p:example.com/open': { verdict: 'free', reason: '', source: 'visit', site: 'example.com', at: now },
    },
  });
  for (const previousVersion of ['0.1.5', '0.1.7']) {
    const b = boot({ local: local() });
    b.listeners.installed({ reason: 'update', previousVersion });
    await vm.runInContext('chain', b.ctx);
    assert.deepEqual(Object.keys(b.store.local.pages).sort(), ['example.com/mine', 'example.com/seen'], previousVersion);
    assert.deepEqual(Object.keys(b.store.local.sites), ['mine.example'], previousVersion);
    assert.deepEqual(Object.keys(b.store.local.checks).sort(), ['d:blog.example', 'p:example.com/open'], previousVersion);
    assert.equal(b.classify('https://lnkd.in/other').gated, false, previousVersion);
  }

  // Later updates leave what the check has found since alone.
  const later = boot({ local: local() });
  later.listeners.installed({ reason: 'update', previousVersion: '0.1.8' });
  await vm.runInContext('chain', later.ctx);
  assert.deepEqual(later.store.local, { ...local(), redirects: {} });
});

test('update from 0.1.16: the links that could not be checked because they redirect are checked again', async () => {
  const now = Date.now();
  const unknown = (reason) => ({ verdict: 'unknown', reason, source: 'check', site: 'lnkd.in', at: now });
  const local = () => ({
    checks: {
      'p:lnkd.in/abc123': unknown('could not be checked (redirects elsewhere)'),
      'p:lnkd.in/def456': unknown('could not be fetched'),
      'p:example.com/free': { verdict: 'free', reason: '', source: 'check', site: 'example.com', at: now },
    },
  });
  const url = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const b = boot({ local: { ...bgOn, ...local() }, pages: { [url]: { redirect: target }, [target]: WALL } });
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.16' });
  await vm.runInContext('chain', b.ctx);
  assert.deepEqual(Object.keys(b.store.local.checks).sort(), ['p:example.com/free', 'p:lnkd.in/def456']);
  await b.list(url);
  assert.equal(b.classify(url).gated, true);

  // From 0.1.17 on, such a record says what a check found without the redirect guard.
  const later = boot({ local: local() });
  later.listeners.installed({ reason: 'update', previousVersion: '0.1.17' });
  await vm.runInContext('chain', later.ctx);
  assert.deepEqual(later.store.local.checks, local().checks);
});

test('setSite refuses a name that is no site, says why and changes nothing', async () => {
  const b = boot();
  const refused = {
    '192.168.1.10': '"192.168.1.10" is not a site name',
    localhost: '"localhost" is not a site name',
    'co.uk': 'co.uk is shared by many unrelated sites',
    'https://www.herokuapp.com/': 'herokuapp.com is shared by many unrelated sites',
  };
  for (const [name, error] of Object.entries(refused)) {
    for (const status of ['gated', 'allowed']) {
      assert.deepEqual(await b.send({ type: 'setSite', domains: [name], status }), { ok: false, error }, name);
    }
  }
  // One bad name stops the request as a whole.
  const res = await b.send({ type: 'setSite', domains: ['example.com', 'github.io'], status: 'gated' });
  assert.deepEqual(res, { ok: false, error: 'github.io is shared by many unrelated sites' });
  assert.deepEqual(b.store.local.sites ?? {}, {});

  assert.deepEqual(await b.send({ type: 'setSite', domains: ['example.com', 'someone.github.io'], status: 'gated' }), { ok: true });
  assert.deepEqual(Object.keys(b.store.local.sites).sort(), ['example.com', 'someone.github.io']);
  // Dropping a name that is not on the list is no error.
  assert.deepEqual(await b.send({ type: 'setSite', domains: ['co.uk', 'localhost'], status: null }), { ok: true });
});

test('setSite: an entry an older version accepted can still be changed and removed', async () => {
  const at = Date.now();
  const b = boot({
    local: {
      sites: {
        'co.uk': { status: 'gated', source: 'manual', at },
        '1.10': { status: 'gated', source: 'manual', at },
        // Names as an older version kept them, which are written otherwise now.
        'www.example.com': { status: 'gated', source: 'manual', at },
        'Example.ORG': { status: 'gated', source: 'manual', at },
      },
    },
  });
  assert.deepEqual(await b.send({ type: 'setSite', domains: ['co.uk'], status: 'allowed' }), { ok: true });
  assert.equal(b.store.local.sites['co.uk'].status, 'allowed');
  // Hiding such a site again files it under the name as written now.
  assert.deepEqual(await b.send({ type: 'setSite', domains: ['www.example.com'], status: 'allowed' }), { ok: true });
  assert.equal(b.store.local.sites['example.com'].status, 'allowed');
  assert.equal(b.store.local.sites['www.example.com'].status, 'gated');
  assert.deepEqual(await b.send({ type: 'setSite', domains: ['co.uk', '1.10', 'www.example.com', 'example.com', 'Example.ORG'], status: null }), { ok: true });
  assert.deepEqual(b.store.local.sites, {});
});

test('setPage: an article the user hid is hidden as theirs', async () => {
  const b = boot();
  const url = 'http://192.168.1.10/post?id=1';
  await b.send({ type: 'setPage', key: b.ctx.HNPF.pageKey(url), status: 'gated' });
  const c = b.classify(url);
  assert.deepEqual([c.gated, c.source, c.page], [true, 'manual', true]);
  assert.equal(b.classify('http://192.168.1.10/post?id=2').gated, false);
  // A detector that finds it free leaves the user's entry alone.
  await b.visit(url, 'free');
  assert.equal(b.classify(url).gated, true);
});

test('gated articles on a host that is no site never add up to hiding anything', async () => {
  for (const host of ['192.168.1.10', 'localhost:3000', 'github.io']) {
    const b = boot();
    for (const n of [1, 2, 3, 4]) await b.visit(`https://${host}/news/${n}`);
    assert.deepEqual(b.store.local.sites ?? {}, {}, host);
    assert.equal(b.classify(`https://${host}/news/1`).gated, true, host);
    assert.equal(b.classify(`https://${host}/news/5`).gated, false, host);
  }
});

test('a listing cannot file stories from unrelated sites under the name they share', async () => {
  const urls = ['a', 'b', 'c'].map((app) => `https://${app}.herokuapp.com/post`);
  const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((u) => [u, WALL])) });
  for (const site of ['herokuapp.com', 'com']) {
    await b.send({ type: 'stories', items: urls.map((url) => ({ url, site })) }, HN);
    await b.idle();
  }
  assert.deepEqual(b.store.local.sites ?? {}, {});
  assert.deepEqual(Object.values(b.store.local.pages).map((e) => e.site).sort(), urls.map((u) => new URL(u).hostname));
  assert.equal(b.classify('https://d.herokuapp.com/post').gated, false);
});

test('update from 0.1.9: verdicts filed under a name shared by unrelated sites are filed anew', async () => {
  const now = Date.now();
  const promoted = (n) => ({ status: 'gated', source: 'check', reason: `${n} articles on this site looked gated`, articles: n, at: now });
  const gated = (site) => ({ status: 'gated', source: 'check', reason: 'r', site, at: now });
  const local = () => ({
    sites: {
      'herokuapp.com': promoted(3),
      'amazonaws.com': promoted(3),
      '1.10': promoted(3),
      'github.io': promoted(3),
      'example.com': promoted(3),
      'co.uk': { status: 'gated', source: 'manual', at: now },
    },
    pages: {
      'a.herokuapp.com/x': gated('herokuapp.com'),
      'b.herokuapp.com/x': gated('herokuapp.com'),
      'bucket.s3.amazonaws.com/x': gated('amazonaws.com'),
      '192.168.1.10/x': gated('1.10'),
      'example.com/1': gated('example.com'),
      'blog.example.com/2': gated('blog.example.com'),
      'medium.com/@someone/x': { status: 'gated', source: 'check', reason: 'r', at: now },
    },
    checks: {
      'd:herokuapp.com': { verdict: 'mixed', at: now },
      'd:1.10': { verdict: 'mixed', at: now },
      'd:web.app': { verdict: 'mixed', at: now },
      'd:blog.example': { verdict: 'mixed', at: now },
      'p:www2.soumu.go.jp/free': { verdict: 'free', reason: '', source: 'check', site: 'go.jp', at: now },
      'p:192.168.1.10/free': { verdict: 'free', reason: '', source: 'visit', site: '1.10', at: now },
      'p:example.com/free': { verdict: 'free', reason: '', source: 'check', site: 'example.com', at: now },
      'p:example.com/failed': { verdict: 'unknown', reason: '', source: 'check', at: now },
    },
  });
  const b = boot({ local: local() });
  b.listeners.installed({ reason: 'update', previousVersion: '0.1.9' });
  await vm.runInContext('chain', b.ctx);

  assert.deepEqual(Object.keys(b.store.local.sites).sort(), ['co.uk', 'example.com']);
  const sites = (table) => Object.fromEntries(Object.entries(table).map(([k, e]) => [k, e.site]));
  assert.deepEqual(sites(b.store.local.pages), {
    'a.herokuapp.com/x': 'a.herokuapp.com',
    'b.herokuapp.com/x': 'b.herokuapp.com',
    'bucket.s3.amazonaws.com/x': 'bucket.s3.amazonaws.com',
    '192.168.1.10/x': undefined,
    'example.com/1': 'example.com',
    'blog.example.com/2': 'blog.example.com',
    'medium.com/@someone/x': undefined,
  });
  assert.deepEqual(sites(b.store.local.checks), {
    'd:blog.example': undefined,
    'p:www2.soumu.go.jp/free': 'soumu.go.jp',
    'p:192.168.1.10/free': undefined,
    'p:example.com/free': 'example.com',
    'p:example.com/failed': undefined,
  });

  // Later updates leave the list alone.
  const later = boot({ local: local() });
  later.listeners.installed({ reason: 'update', previousVersion: '0.1.10' });
  await vm.runInContext('chain', later.ctx);
  assert.deepEqual(later.store.local, { ...local(), redirects: {} });
});

// ---- who may send what (#8) ----------------------------------------------------------

const REFUSED = { ok: false, error: 'not allowed from this page' };

test('messages: a page that is neither the extension nor Hacker News cannot change anything', async () => {
  const story = 'https://blog.example/post';
  const b = boot({ local: { sites: { 'example.org': { status: 'gated', source: 'manual', at: 1 } } } });
  const before = structuredClone(b.store.local);
  let opened = 0;
  b.ctx.chrome.runtime.openOptionsPage = () => void opened++;
  const writes = [
    { type: 'setSettings', patch: { bgCheck: true } },
    { type: 'setSite', domains: ['example.com'], status: 'gated' },
    { type: 'setSite', domains: ['example.org'], status: null },
    { type: 'setPage', key: 'blog.example/post', status: 'allowed' },
    { type: 'seenSites', domains: ['example.org'] },
    { type: 'stories', items: [{ url: story, site: 'blog.example' }] },
    { type: 'hiddenCount', count: 3 },
    { type: 'openOptions' },
  ];
  const strangers = {
    'a story page': tabAt(story),
    'a frame inside a Hacker News page': tabAt('https://ads.example/frame', 3),
    'a page with a look-alike address': tabAt('https://news.ycombinator.com.evil.example/news'),
    'another extension': { ...PAGE, id: 'someoneelse' },
    'a page of another extension': { id: ID, origin: 'chrome-extension://someoneelse', url: 'chrome-extension://someoneelse/src/options.html' },
    'a sandboxed frame': { id: ID, origin: 'null', url: PAGE.url },
    'a sandboxed Hacker News page': { ...HN, origin: 'null' },
    'a page that names no origin': { id: ID, url: PAGE.url },
    'a Hacker News page that names no origin': { ...HN, origin: undefined },
    'Hacker News over http': tabAt('http://news.ycombinator.com/news'),
    'nobody in particular': {},
  };
  for (const [who, sender] of Object.entries(strangers)) {
    for (const message of writes) assert.deepEqual(await b.send(message, sender), REFUSED, `${message.type} from ${who}`);
  }
  assert.deepEqual(b.store.local, before);
  assert.deepEqual(b.store.session, {});
  assert.equal(opened, 0);

  // A report on a visit comes from a tab, whoever else may ask.
  await b.list(story);
  const report = { type: 'visitVerdict', url: story, verdict: 'gated', reason: 'r' };
  const { tab, ...tabless } = tabAt(story);
  for (const sender of [tabless, { ...tabAt(story), id: 'someoneelse' }, { ...tabAt(story), origin: undefined }, {}, null, 'tab']) {
    assert.deepEqual(await b.send(report, sender), REFUSED);
  }
  assert.deepEqual(b.store.local, before);
});

test('messages: every kind of message names who may send it', () => {
  const b = boot();
  const keys = (name) => structuredClone(vm.runInContext(`Object.keys(${name}).sort()`, b.ctx));
  assert.deepEqual(keys('SENDERS'), keys('handlers'));
  assert.equal(keys('handlers').length, 10);
});

test('messages: each kind is taken only from the pages that send it', async () => {
  const b = boot();
  const story = 'https://blog.example/post';
  const tab = tabAt(story);
  b.ctx.chrome.action = new Proxy({}, { get: () => async () => {} });
  const cases = [
    [{ type: 'setSettings', patch: { display: 'label' } }, [PAGE, POPUP]],
    [{ type: 'forgetDetected' }, [PAGE, POPUP]],
    [{ type: 'setSite', domains: ['example.com'], status: 'gated' }, [PAGE, POPUP, HN]],
    [{ type: 'setPage', key: 'blog.example/post', status: 'gated' }, [PAGE, POPUP, HN]],
    [{ type: 'seenSites', domains: ['example.com'] }, [HN]],
    [{ type: 'stories', items: [{ url: story, site: 'blog.example' }] }, [HN]],
    [{ type: 'hiddenCount', count: 2 }, [HN]],
    [{ type: 'openOptions' }, [HN]],
    [{ type: 'visitVerdict', url: story, verdict: 'free' }, [tab]],
  ];
  for (const [message, allowed] of cases) {
    for (const sender of [PAGE, POPUP, HN, tab]) {
      const expected = allowed.includes(sender) ? { ok: true } : REFUSED;
      assert.deepEqual(await b.send(message, sender), expected, `${message.type} from ${sender.url}`);
    }
  }
});

test('messages: a Hacker News page loaded ahead of the visit is taken like any other', async () => {
  // The browser numbers such a page like a frame until the reader gets to it, in a tab
  // that still shows the page they are on.
  const early = { ...HN, frameId: 1234, documentLifecycle: 'prerender', tab: { id: 2, url: 'https://other.example/reading' } };
  const story = 'https://blog.example/post';
  const b = boot();
  const badges = [];
  b.ctx.chrome.action = new Proxy({}, { get: (_, name) => async (arg) => void (name === 'setBadgeText' && badges.push(arg.text)) });
  assert.deepEqual(await b.send({ type: 'stories', items: [{ url: story }] }, early), { ok: true });
  assert.deepEqual(await b.send({ type: 'hiddenCount', count: 2 }, early), { ok: true });
  assert.deepEqual(await b.send({ type: 'setPage', key: 'blog.example/post', status: 'gated' }, early), { ok: true });
  assert.equal(b.ctx.HNPF.storyFor(b.store.session.stories, story).url, story);
  assert.equal(b.classify(story).gated, true);
  // The count is not put on the page still showing; it comes again once the reader is there.
  assert.deepEqual(badges, []);
  assert.deepEqual(await b.send({ type: 'hiddenCount', count: 2 }, HN), { ok: true });
  assert.deepEqual(badges, ['2']);
});

test('messages: a name every object has is no kind of message', () => {
  const b = boot();
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 7, null, ['setSite']]) {
    let answered = false;
    const kept = b.listeners.message({ type, domains: ['example.com'], status: 'gated' }, PAGE, () => void (answered = true));
    assert.deepEqual([kept, answered], [undefined, false], String(type));
  }
  assert.equal(b.listeners.message(null, PAGE, () => {}), undefined);
  assert.equal(b.listeners.message('setSite', PAGE, () => {}), undefined);
});

test('setSite and setPage take only "gated", "allowed" or null for a status', async () => {
  const at = Date.now();
  const local = { sites: { 'example.org': { status: 'gated', source: 'manual', at } }, pages: { 'example.org/a': { status: 'gated', source: 'manual', at } } };
  const b = boot({ local });
  for (const status of ['banana', '', 0, 1, true, false, undefined, {}, ['gated'], 'Gated']) {
    const error = 'not a status';
    for (const sender of [PAGE, HN]) {
      assert.deepEqual(await b.send({ type: 'setSite', domains: ['example.com'], status }, sender), { ok: false, error }, `site: ${status}`);
      assert.deepEqual(await b.send({ type: 'setSite', domains: ['example.org'], status }, sender), { ok: false, error }, `site: ${status}`);
      assert.deepEqual(await b.send({ type: 'setPage', key: 'example.com/a', status }, sender), { ok: false, error }, `page: ${status}`);
      assert.deepEqual(await b.send({ type: 'setPage', key: 'example.org/a', status }, sender), { ok: false, error }, `page: ${status}`);
    }
  }
  assert.deepEqual(b.store.local, local);
  assert.equal(b.classify('https://example.com/a').gated, false);
});

test('setSite and seenSites take only a list of names', async () => {
  const b = boot();
  for (const domains of [undefined, null, 'example.com', { 0: 'example.com', length: 1 }, [['example.com']], [null], [7], [{}]]) {
    const error = 'not a list of site names';
    assert.deepEqual(await b.send({ type: 'setSite', domains, status: 'gated' }), { ok: false, error }, JSON.stringify(domains));
    assert.deepEqual(await b.send({ type: 'setSite', domains, status: null }), { ok: false, error }, JSON.stringify(domains));
    assert.deepEqual(await b.send({ type: 'seenSites', domains }, HN), { ok: false, error }, JSON.stringify(domains));
  }
  assert.deepEqual(b.store.local, {});
  // A refusal quotes the name, but not at any length.
  const res = await b.send({ type: 'setSite', domains: ['a'.repeat(5000)], status: 'gated' });
  assert.deepEqual(res, { ok: false, error: `"${'a'.repeat(199)}` });
});

test('setPage takes only the key of an article, or one that is on the list already', async () => {
  const at = Date.now();
  const odd = 'not a page key <b>';
  const b = boot({ local: { pages: { [odd]: { status: 'allowed', source: 'manual', at } } } });
  const refused = [
    odd + '!', '', 'https://example.com/a', 'example.com/a/', 'Example.com/a', 'example.com/a?utm_source=hn', 'example.com/a?b=2&a=1',
    'example.com/a#top', 'example.com:8080/a', 'user@example.com/a', 'example.com/a b', '/a', '?a=1', 'www.', '__proto__', undefined, null, 7, {}, ['example.com/a'],
    `example.com/${'a'.repeat(13000)}`,
  ];
  for (const key of refused) {
    for (const status of ['gated', 'allowed', null]) {
      assert.deepEqual(await b.send({ type: 'setPage', key, status }), { ok: false, error: 'not an article' }, String(key));
    }
  }
  assert.deepEqual(Object.keys(b.store.local.pages), [odd]);

  // Whatever HNPF.pageKey makes of an address is taken.
  const urls = [
    'https://www.example.com/a/b/?utm_source=hn&z=1&a=two%20words', 'http://192.168.1.10/post?id=1', 'http://localhost:3000/', 'http://[::1]/x',
    'https://www.www.example.com/a', 'https://example.com/caf%C3%A9?q=a%2Bb&empty', 'https://xn--bcher-kva.example/a',
    // The key of a long address is longer still: the query is written out in full.
    `https://example.com/a?d=${'/:,;'.repeat(1000)}`,
  ];
  for (const url of urls) {
    const key = b.ctx.HNPF.pageKey(url);
    assert.deepEqual(await b.send({ type: 'setPage', key, status: 'gated' }, HN), { ok: true }, key);
    assert.equal(b.classify(url).gated, true, key);
    assert.deepEqual(await b.send({ type: 'setPage', key, status: null }, HN), { ok: true }, key);
  }
  // An entry an older version accepted can still be changed and removed.
  assert.deepEqual(await b.send({ type: 'setPage', key: odd, status: 'gated' }), { ok: true });
  assert.equal(b.store.local.pages[odd].status, 'gated');
  assert.deepEqual(await b.send({ type: 'setPage', key: odd, status: null }), { ok: true });
  assert.deepEqual(b.store.local.pages, {});
});

test('setSettings takes only known settings with values they can have', async () => {
  const b = boot();
  const refused = [
    { bgCheck: true, junk: { a: 1 } }, { display: 42 }, { display: 'banana' }, { bgCheck: 'yes' }, { visitDetect: 1 }, { bgCheck: null },
    { constructor: true }, { toString: 'hide' }, JSON.parse('{"__proto__": true}'),
    undefined, null, 'display', 7, [['display', 'label']],
  ];
  for (const patch of refused) {
    assert.deepEqual(await b.send({ type: 'setSettings', patch }), { ok: false, error: 'not a setting' }, JSON.stringify(patch));
  }
  assert.deepEqual(b.store.local, {});

  assert.deepEqual(await b.send({ type: 'setSettings', patch: { visitDetect: true } }), { ok: true });
  assert.deepEqual(await b.send({ type: 'setSettings', patch: { display: 'label' } }), { ok: true });
  assert.deepEqual(await b.send({ type: 'setSettings', patch: { visitDetect: true, bgCheck: true } }), { ok: true });
  assert.deepEqual(b.store.local.settings, { visitDetect: true, bgCheck: true, display: 'label' });
  assert.deepEqual(await b.send({ type: 'setSettings', patch: {} }), { ok: true });
  assert.deepEqual(b.store.local.settings, { visitDetect: true, bgCheck: true, display: 'label' });
});

test('setSettings: what an older version stored that is no setting is dropped on the next change', async () => {
  const b = boot({ local: { settings: { bgCheck: true, junk: { a: 1 }, display: 42, visitDetect: 'yes' } } });
  assert.deepEqual(await b.send({ type: 'setSettings', patch: { bgCheck: false } }), { ok: true });
  assert.deepEqual(b.store.local.settings, { visitDetect: false, bgCheck: false, display: 'hide' });
});

test('stories: a listing is taken item by item, and only what is a story', async () => {
  const b = boot();
  for (const items of [undefined, null, 'https://example.com/a', { length: 1, 0: { url: 'https://example.com/a' } }]) {
    assert.deepEqual(await b.send({ type: 'stories', items }, HN), { ok: false, error: 'not a list of stories' });
  }
  assert.deepEqual(b.store.session, {});

  const long = `https://example.com/${'a'.repeat(5000)}`;
  const items = [
    null, 7, 'https://example.com/a', {}, { url: 7 }, { url: ['https://example.com/a'] }, { url: 'javascript:alert(1)' }, { url: long },
    { url: 'https://example.com/b', site: { toString: () => 'example.com' } },
    { url: 'https://blog.example.com/c', site: 'blog.example.com' },
    { url: 'http://__proto__/', site: '__proto__' },
  ];
  assert.deepEqual(await b.send({ type: 'stories', items }, HN), { ok: true });
  const stored = Object.values(b.store.session.stories).map(({ url, site }) => [url, site]);
  assert.deepEqual(stored, [['https://example.com/b', 'example.com'], ['https://blog.example.com/c', 'blog.example.com']]);

  // No listing is longer than what is kept.
  const many = Array.from({ length: 1000 }, (_, n) => ({ url: `https://example.com/n/${n}` }));
  assert.deepEqual(await b.send({ type: 'stories', items: many }, HN), { ok: true });
  assert.equal(Object.keys(b.store.session.stories).length, 400);
});

test('stories: two listings taken in at the same time both stay recognised', async () => {
  const b = boot();
  const urls = ['https://one.example/a', 'https://two.example/b', 'https://three.example/c'];
  const other = { ...HN, tab: { id: 3, url: 'https://news.ycombinator.com/newest' } };
  await Promise.all(urls.map((url, i) => b.send({ type: 'stories', items: [{ url, site: null }] }, i % 2 ? other : HN)));
  assert.deepEqual(Object.values(b.store.session.stories).map((s) => s.url).sort(), [...urls].sort());
});

test('on-visit detection: a page that shares its name with something every object has is no story', async () => {
  const b = boot({ local: { settings: { visitDetect: true } } });
  const injected = [];
  b.ctx.chrome.scripting.executeScript = async ({ target }) => void injected.push(target.tabId);
  await b.list('https://example.com/a');
  for (const host of ['constructor', 'toString', '__proto__', 'hasownproperty']) {
    assert.equal(b.ctx.HNPF.storyFor(b.store.session.stories, `http://${host}/`), null, host);
    await b.ctx.maybeDetect(7, `http://${host}/`);
    await b.send({ type: 'visitVerdict', url: `http://${host}/`, verdict: 'gated', reason: 'r' }, tabAt(`http://${host}/`));
  }
  assert.deepEqual(injected, []);
  assert.deepEqual(b.store.local.pages ?? {}, {});
  await b.ctx.maybeDetect(8, 'https://example.com/a');
  assert.deepEqual(injected, [8]);
});

test('on-visit detection: a report says "gated" or "free", with a short reason, from the page itself', async () => {
  const story = 'https://blog.example/post';
  const key = 'blog.example/post';
  const report = (b, extra, sender = tabAt(story)) => b.send({ type: 'visitVerdict', url: story, verdict: 'gated', reason: 'prompt on page', ...extra }, sender);

  const on = { settings: { visitDetect: true } };
  const boot = () => bootWith({ local: on });
  for (const verdict of ['banana', 'unknown', 'mixed', '', undefined, null, true, 1, {}, ['gated']]) {
    const b = boot();
    await b.list(story);
    assert.deepEqual(await report(b, { verdict }), { ok: true });
    assert.deepEqual(b.store.local, on, String(verdict));
  }

  for (const [reason, stored] of [['x'.repeat(5000), 'x'.repeat(200)], [{ html: '<b>' }, ''], [42, ''], [['a'], ''], [undefined, ''], ['prompt on page', 'prompt on page']]) {
    for (const verdict of ['gated', 'free']) {
      const b = boot();
      await b.list(story);
      await report(b, { verdict, reason });
      const entry = verdict === 'gated' ? b.store.local.pages[key] : b.store.local.checks['p:' + key];
      assert.equal(entry.reason, stored, String(reason).slice(0, 20));
    }
  }

  // Only a real `true` marks the site as a platform with free and gated posts side by side.
  for (const [platform, mixed] of [[true, true], ['yes', false], [1, false], [{}, false]]) {
    const b = boot();
    await b.list(story);
    await report(b, { platform });
    assert.equal(b.store.local.checks?.['d:blog.example']?.verdict === 'mixed', mixed, String(platform));
  }

  // A frame inside the story's tab is not the story.
  const b = boot();
  await b.list(story);
  await report(b, {}, { ...tabAt(story), frameId: 4, url: 'https://ads.example/frame', origin: 'https://ads.example' });
  await report(b, {}, { ...tabAt(story), frameId: 4 });
  assert.deepEqual(b.store.local, on);
  await report(b, {});
  assert.equal(b.classify(story).gated, true);
});

test('on-visit detection: a report counts only where detection would have been started', async () => {
  const report = (b, url) => b.send({ type: 'visitVerdict', url, verdict: 'gated', reason: 'prompt on page' }, tabAt(url));
  // Not while detection is off, which it is until the reader turns it on.
  for (const local of [{}, { settings: { visitDetect: false } }]) {
    const b = bootWith({ local });
    await b.list('https://blog.example/post');
    assert.deepEqual(await report(b, 'https://blog.example/post'), { ok: true });
    assert.deepEqual(b.store.local, local);
  }
  // Nor on a site that is never looked at, however many of its pages say so.
  const b = bootWith({ local: { settings: { visitDetect: true } } });
  const urls = [1, 2, 3, 4].map((n) => `https://web.archive.org/web/${n}/https://example.com/`);
  await b.list(...urls, 'https://blog.example/post');
  for (const url of urls) await report(b, url);
  assert.deepEqual([b.store.local.sites, b.store.local.pages], [undefined, undefined]);
  await report(b, 'https://blog.example/post');
  assert.deepEqual(Object.keys(b.store.local.pages), ['blog.example/post']);
});

test('hiddenCount: only a count goes on the badge', async () => {
  const b = boot();
  const calls = [];
  b.ctx.chrome.action = new Proxy({}, { get: (_, name) => async (arg) => void calls.push([name, arg.text ?? arg.title]) });
  for (const count of ['<b>', -1, 1.5, NaN, null, undefined, {}, [3], '3', 1e9]) {
    assert.deepEqual(await b.send({ type: 'hiddenCount', count }, HN), { ok: true });
  }
  assert.deepEqual(calls, []);
  await b.send({ type: 'hiddenCount', count: 3 }, HN);
  assert.deepEqual(calls.slice(0, 2), [['setBadgeText', '3'], ['setTitle', 'HN Paywall Filter: 3 gated stories on this page']]);
});

test('access to all sites is given back when the last detector is switched off', async () => {
  const b = boot({ local: { settings: { visitDetect: true, bgCheck: true } } });
  await b.send({ type: 'setSettings', patch: { visitDetect: false } });
  assert.deepEqual([b.access.granted, b.access.removed], [true, []]);
  await b.send({ type: 'setSettings', patch: { display: 'label' } });
  assert.equal(b.access.granted, true);

  await b.send({ type: 'setSettings', patch: { bgCheck: false } });
  assert.deepEqual([b.access.granted, b.access.removed], [false, [ALL_SITES]]);
  assert.deepEqual(b.store.local.settings, { visitDetect: false, bgCheck: false, display: 'label' });
});

test('access that is taken away switches both detectors off, so neither comes back by itself', async () => {
  const b = boot({ local: { settings: { visitDetect: true, bgCheck: true, display: 'label' } } });
  // Revoked on chrome://extensions.
  b.access.granted = false;
  await b.listeners.removed(ALL_SITES);
  assert.deepEqual(b.store.local.settings, { visitDetect: false, bgCheck: false, display: 'label' });

  // The options page asks for the access again and turns one detector on.
  b.access.granted = true;
  await b.send({ type: 'setSettings', patch: { visitDetect: true } });
  assert.deepEqual(b.store.local.settings, { visitDetect: true, bgCheck: false, display: 'label' });
  assert.deepEqual([b.access.granted, b.access.removed], [true, []]);
});

test('a detector cannot be on without access to all sites', async () => {
  const b = boot({ granted: false });
  assert.deepEqual(await b.send({ type: 'setSettings', patch: { bgCheck: true } }), { ok: true });
  assert.deepEqual(b.store.local.settings, { visitDetect: false, bgCheck: false, display: 'hide' });
});

test('startup and update: settings and access left out of step by an older version are put right', async () => {
  for (const event of [(b) => b.listeners.startup(), (b) => b.listeners.installed({ reason: 'update', previousVersion: '0.1.12' })]) {
    // Both detectors were switched off, and the access stayed.
    const kept = boot({ local: { settings: { visitDetect: false, bgCheck: false } } });
    await event(kept);
    await kept.idle();
    assert.deepEqual([kept.access.granted, kept.access.removed], [false, [ALL_SITES]]);

    // The access was taken away, and the settings stayed on.
    const stale = boot({ granted: false, local: { settings: { visitDetect: true, bgCheck: true } } });
    await event(stale);
    await stale.idle();
    assert.deepEqual(stale.store.local.settings, { visitDetect: false, bgCheck: false, display: 'hide' });

    const fine = boot({ local: { settings: { bgCheck: true } } });
    await event(fine);
    await fine.idle();
    assert.deepEqual([fine.access.granted, fine.store.local.settings], [true, { bgCheck: true }]);
  }
});

test('the access asked for covers web pages and nothing else', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const b = boot();
  assert.deepEqual(manifest.optional_host_permissions, ALL_SITES.origins);
  assert.deepEqual(structuredClone(b.ctx.HNPF.ALL_SITES), ALL_SITES);
  assert.equal(manifest.host_permissions, undefined);
});

test('incognito: a visit is neither looked at nor recorded', async () => {
  const story = 'https://blog.example/post';
  const b = boot({ local: { settings: { visitDetect: true } } });
  await b.list(story);
  const injected = [];
  b.ctx.chrome.action = new Proxy({}, { get: () => async () => {} });
  b.ctx.chrome.scripting.executeScript = async ({ target }) => void injected.push(target.tabId);
  const loaded = async (tabId, tab) => {
    b.listeners.updated(tabId, { status: 'complete' }, tab);
    await new Promise((r) => setTimeout(r, 10));
  };
  await loaded(7, { url: story, incognito: true });
  assert.deepEqual(injected, []);
  await loaded(8, { url: story, incognito: false });
  assert.deepEqual(injected, [8]);

  const report = { type: 'visitVerdict', url: story, verdict: 'gated', reason: 'prompt on page' };
  assert.deepEqual(await b.send(report, incognito(tabAt(story))), { ok: true });
  assert.equal(b.store.local.pages, undefined);
  assert.deepEqual(await b.send(report, tabAt(story)), { ok: true });
  assert.deepEqual(Object.keys(b.store.local.pages), ['blog.example/post']);
});

test('incognito: a listing is neither remembered nor checked', async () => {
  const url = 'https://example.com/blog/paywall-demo';
  const link = 'https://lnkd.in/abc123';
  const target = 'https://paywalled-news.example/article';
  const b = boot({ local: bgOn, pages: { [url]: WALL, [link]: { redirect: target }, [target]: WALL } });
  const items = [{ url, site: 'example.com' }, { url: link, site: 'lnkd.in' }];
  assert.deepEqual(await b.send({ type: 'stories', items }, incognito(HN)), { ok: true });
  await b.idle();
  assert.deepEqual([b.fetched, b.store.session, b.store.local], [[], {}, bgOn]);

  await b.send({ type: 'stories', items }, HN);
  await b.idle();
  assert.deepEqual(b.fetched, [url, link, target]);
});

test('forgetDetected: all the detectors recorded goes, your own entries stay', async () => {
  const at = Date.now();
  const mine = {
    sites: { 'mine.example': { status: 'gated', source: 'manual', at }, 'shown.example': { status: 'allowed', source: 'manual', at } },
    pages: { 'blog.example/kept': { status: 'allowed', source: 'manual', at } },
  };
  const b = boot({
    local: {
      settings: { visitDetect: true },
      sites: { ...mine.sites, 'walled.example': { status: 'gated', source: 'visit', reason: '3 articles on this site looked gated', articles: 3, at } },
      pages: {
        ...mine.pages,
        'walled.example/a': { status: 'gated', source: 'visit', site: 'walled.example', at },
        'other.example/b': { status: 'gated', source: 'check', site: 'other.example', at },
      },
      checks: { 'p:free.example/read': { verdict: 'free', source: 'visit', site: 'free.example', at }, 'd:medium.example': { verdict: 'mixed', at } },
      redirects: { 'lnkd.in/abc123': { to: 'https://walled.example/a', at } },
    },
  });
  await b.list('https://seen.example/story');
  assert.deepEqual(await b.send({ type: 'forgetDetected' }), { ok: true });
  assert.deepEqual(b.store.local, { settings: { visitDetect: true }, ...mine, checks: {}, redirects: {} });
  assert.deepEqual(b.store.session.stories, {});
});

test('forgetDetected: a check that was under way records nothing afterwards', async () => {
  const url = 'https://example.com/blog/paywall-demo';
  const b = boot({ local: bgOn, pages: { [url]: WALL } });
  await b.send({ type: 'stories', items: [{ url, site: 'example.com' }] }, HN);
  await b.send({ type: 'forgetDetected' });
  await b.idle();
  assert.deepEqual([b.store.local.pages, b.store.local.checks], [{}, {}]);

  // Nor where a link led, as a record or as a story to recognise.
  const link = 'https://lnkd.in/abc123';
  const led = boot({ local: bgOn, pages: { [link]: { redirect: url }, [url]: WALL } });
  await led.send({ type: 'stories', items: [{ url: link, site: 'lnkd.in' }] }, HN);
  await led.send({ type: 'forgetDetected' });
  await led.idle();
  assert.deepEqual([led.store.local.pages, led.store.local.redirects, led.store.session.stories], [{}, {}, {}]);
});

test('giving the access back takes the marks off the article tabs, not the count off a listing', async () => {
  const b = boot({ local: { settings: { visitDetect: true } } });
  b.tabs.push({ id: 1, url: 'https://news.ycombinator.com/news' }, { id: 2, url: 'https://www.wsj.com/articles/x' }, { id: 3 });
  const cleared = [];
  b.ctx.chrome.action = new Proxy({}, { get: (_, name) => async (arg) => void (name === 'setBadgeText' && cleared.push([arg.tabId, arg.text])) });
  await b.send({ type: 'setSettings', patch: { visitDetect: false } });
  assert.deepEqual([b.access.granted, cleared], [false, [[2, '']]]);
});

test('background check: switched off while on-visit detection keeps the access, a fetch under way is called off', async () => {
  const url = 'https://example.com/slow';
  const b = boot({ local: { settings: { bgCheck: true, visitDetect: true } }, pages: { [url]: { hang: true } } });
  await b.send({ type: 'stories', items: [{ url, site: null }] }, HN);
  for (let i = 0; i < 100 && !b.fetched.length; i++) await new Promise((r) => setTimeout(r, 1));
  await b.send({ type: 'setSettings', patch: { bgCheck: false } });
  await b.idle();
  assert.deepEqual([b.aborted, b.access.granted], [[url], true]);
  assert.deepEqual([b.store.local.pages, b.store.local.checks], [undefined, undefined]);
});

test('background check: stories still waiting are dropped once the check is switched off or loses its access', async () => {
  const urls = Array.from({ length: 20 }, (_, n) => `https://example${n}.com/story`);
  for (const stop of [
    (b) => b.send({ type: 'setSettings', patch: { bgCheck: false } }),
    (b) => ((b.access.granted = false), b.listeners.removed(ALL_SITES)),
  ]) {
    const b = boot({ local: bgOn, pages: Object.fromEntries(urls.map((url) => [url, WALL])) });
    await b.send({ type: 'stories', items: urls.map((url) => ({ url, site: null })) }, HN);
    await stop(b);
    await b.idle();
    // Only the few that were under way went out, and none of them is on record.
    assert.ok(b.fetched.length <= 8, `${b.fetched.length} fetched`);
    assert.deepEqual([b.store.local.pages, b.store.local.checks, b.store.local.settings.bgCheck], [undefined, undefined, false]);
  }
});

test('forgetDetected: a report or a listing that was under way leaves nothing behind', async () => {
  const story = 'https://blog.example/post';
  const b = boot({ local: { settings: { visitDetect: true } } });
  await b.list(story);
  const report = b.send({ type: 'visitVerdict', url: story, verdict: 'gated', reason: 'prompt on page' }, tabAt(story));
  const listing = b.send({ type: 'stories', items: [{ url: 'https://other.example/a', site: 'other.example' }] }, HN);
  await b.send({ type: 'forgetDetected' });
  await Promise.all([report, listing]);
  await b.idle();
  assert.deepEqual([b.store.local.pages, b.store.session.stories], [{}, {}]);
});

test('forgetDetected: stories still waiting to be checked are dropped, as is a listing being taken in', async () => {
  const urls = Array.from({ length: 20 }, (_, n) => `https://example${n}.com/story`);
  const items = urls.map((url) => ({ url, site: null }));
  const pages = Object.fromEntries(urls.map((url) => [url, WALL]));

  const queued = boot({ local: bgOn, pages });
  await queued.send({ type: 'stories', items }, HN);
  await queued.send({ type: 'forgetDetected' });
  await queued.idle();
  assert.ok(queued.fetched.length <= 8, `${queued.fetched.length} fetched`);
  assert.deepEqual([queued.store.local.pages, queued.store.local.checks], [{}, {}]);

  // Forgotten at each point of taking the listing in.
  for (let ticks = 0; ticks < 12; ticks++) {
    const b = boot({ local: bgOn, pages });
    const listing = b.send({ type: 'stories', items }, HN);
    for (let i = 0; i < ticks; i++) await null;
    const before = b.fetched.length;
    await b.send({ type: 'forgetDetected' });
    await listing;
    await b.idle();
    if (!before) assert.deepEqual(b.fetched, [], `after ${ticks} ticks`);
    assert.deepEqual([b.store.local.pages, b.store.local.checks], [{}, {}], `after ${ticks} ticks`);
  }
});

// ---- what a story page can reach (#28) -----------------------------------------------

// Lets whatever the worker started run to its end.
const settle = () => new Promise((r) => setTimeout(r, 10));

test('storage: the stored lists are out of reach of every script in a web page, from the start', async () => {
  const b = boot();
  await settle();
  // The on-visit detector runs inside story pages; with this, a page that breaks into it
  // can neither read the lists nor write them. Session storage is out of its reach anyway.
  assert.deepEqual(b.levels, [{ area: 'local', accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test('on-visit detection: the detector is put in a page only once the stored lists are out of its reach', async () => {
  const story = 'https://blog.example/post';
  for (const lock of [true, false]) {
    const b = boot({ local: { settings: { visitDetect: true } }, lock });
    await b.list(story);
    const injected = [];
    b.ctx.chrome.scripting.executeScript = async ({ target }) => void injected.push(target.tabId);
    await b.ctx.maybeDetect(7, story);
    assert.deepEqual(injected, lock ? [7] : [], `restricted: ${lock}`);
  }
});

test('getState: a Hacker News page is given the lists it hides stories by, and no other page is', async () => {
  const sites = { 'example.com': { status: 'gated', source: 'manual', at: 1 } };
  const pages = { 'blog.example/post': { status: 'gated', source: 'visit', reason: 'r', site: 'blog.example', at: 2 } };
  const redirects = { 'lnkd.in/abc': { to: 'https://blog.example/post', at: 3 } };
  const checks = { 'p:free.example/a': { verdict: 'free', reason: 'r', source: 'check', at: 4 } };
  const b = boot({ local: { settings: { display: 'label' }, sites, pages, redirects, checks } });
  // The pages found free say which stories the reader opened, and decide nothing on a listing.
  const state = { settings: { visitDetect: false, bgCheck: false, display: 'label' }, sites, pages, redirects };
  assert.deepEqual(await b.send({ type: 'getState' }, HN), { ok: true, state });
  assert.deepEqual(await b.send({ type: 'getState' }, incognito(HN)), { ok: true, state });
  for (const sender of [tabAt('https://blog.example/post'), tabAt('https://ads.example/frame', 3), { ...HN, origin: 'null' }, PAGE, POPUP, {}]) {
    assert.deepEqual(await b.send({ type: 'getState' }, sender), REFUSED, sender.url);
  }
});

test('getState: an open Hacker News page is told when the lists change, by its document alone', async () => {
  const b = boot();
  const changed = [1, { type: 'stateChanged' }, { documentId: 'doc-1' }];
  await b.send({ type: 'getState' }, { ...HN, documentId: 'doc-1' });
  // Asking again, as the page does after each change, adds no second note.
  await b.send({ type: 'getState' }, { ...HN, documentId: 'doc-1' });
  // A page the browser gives no document to cannot be told apart from what its tab shows next.
  await b.send({ type: 'getState' }, { ...HN, tab: { ...HN.tab, id: 5 } });
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await settle();
  assert.deepEqual(b.told, [changed]);

  // Nor for what decides nothing on a listing.
  await b.ctx.mutate(() => ({ checks: { 'p:free.example/a': { verdict: 'free', at: Date.now() } } }));
  await settle();
  assert.deepEqual(b.told, [changed]);
  for (const patch of [{ type: 'setPage', key: 'blog.example/post', status: 'gated' }, { type: 'setSettings', patch: { display: 'label' } }]) {
    b.told.length = 0;
    await b.send(patch);
    await settle();
    assert.deepEqual(b.told, [changed], patch.type);
  }
});

test('getState: a page that is gone, or that its tab has moved on from, is told nothing more', async () => {
  const b = boot();
  await b.send({ type: 'getState' }, { ...HN, documentId: 'doc-1' });
  await b.send({ type: 'getState' }, { ...HN, documentId: 'doc-2', tab: { ...HN.tab, id: 2 } });
  b.left.add('doc-1');
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await settle();
  assert.deepEqual(b.told, [[2, { type: 'stateChanged' }, { documentId: 'doc-2' }]]);
  assert.deepEqual(Object.keys(b.store.session.listings), ['doc-2']);
});

test('getState: a page that does not answer the note is told nothing more', async () => {
  const b = boot();
  await b.send({ type: 'getState' }, { ...HN, documentId: 'doc-1' });
  // As when the document has no listener: there is nothing left of hn.js to answer.
  b.ctx.chrome.tabs.sendMessage = async () => undefined;
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await settle();
  assert.deepEqual(b.store.session.listings, {});
});

test('getState: a page that asks again while a note to it fails is still told', async () => {
  const b = boot();
  const page = { ...HN, documentId: 'doc-1' };
  await b.send({ type: 'getState' }, page);
  // Back from the Back button's cache, which no note reaches, the page asks again.
  b.ctx.chrome.tabs.sendMessage = async () => {
    await b.send({ type: 'getState' }, page);
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await settle();
  assert.deepEqual(Object.keys(b.store.session.listings), ['doc-1']);
});

test('getState: open Hacker News pages are still told once the worker was suspended and started again', async () => {
  const first = boot();
  await first.send({ type: 'getState' }, { ...HN, documentId: 'doc-1' });
  const b = boot({ local: first.store.local, session: first.store.session });
  await b.send({ type: 'setSite', domains: ['example.com'], status: 'gated' });
  await settle();
  assert.deepEqual(b.told, [[1, { type: 'stateChanged' }, { documentId: 'doc-1' }]]);
});

test('getState: only so many open Hacker News pages are kept track of, the latest', async () => {
  const b = boot();
  const most = vm.runInContext('MAX_LISTINGS', b.ctx);
  for (let i = 0; i < most + 3; i++) await b.send({ type: 'getState' }, { ...HN, documentId: `doc-${i}` });
  const kept = Object.keys(b.store.session.listings);
  assert.equal(kept.length, most);
  assert.ok(!kept.includes('doc-0') && kept.includes(`doc-${most + 2}`));
});

test('getState: of too many pages, those whose tab has moved on go first', async () => {
  const b = boot();
  const most = vm.runInContext('MAX_LISTINGS', b.ctx);
  // A listing left open in one tab, while the reader goes from page to page in another.
  await b.send({ type: 'getState' }, { ...HN, documentId: 'listing' });
  for (let i = 0; i < most + 3; i++) await b.send({ type: 'getState' }, { ...HN, documentId: `doc-${i}`, tab: { ...HN.tab, id: 2 } });
  const kept = Object.keys(b.store.session.listings);
  assert.equal(kept.length, most);
  assert.ok(kept.includes('listing') && !kept.includes('doc-0') && !kept.includes('doc-3') && kept.includes('doc-4'));
});

test('on-visit detection does not come on in a browser that cannot keep story pages away from the stored lists', async () => {
  const b = boot({ local: { settings: { visitDetect: true, bgCheck: true } }, lock: false });
  // Left on by an earlier start, it goes off; the background check stays on with its access.
  await b.listeners.startup();
  assert.deepEqual([b.store.local.settings.visitDetect, b.store.local.settings.bgCheck, b.access.granted], [false, true, true]);
  const res = await b.send({ type: 'setSettings', patch: { visitDetect: true } });
  assert.equal(res.ok, false);
  assert.match(res.error, /newer version of Chrome/);
  assert.equal(b.store.local.settings.visitDetect, false);
  assert.deepEqual(await b.send({ type: 'setSettings', patch: { display: 'label' } }), { ok: true });

  // Without the check either, the access goes back.
  const alone = boot({ local: { settings: { visitDetect: true } }, lock: false });
  await alone.listeners.startup();
  assert.deepEqual([alone.store.local.settings.visitDetect, alone.access.granted], [false, false]);
});
