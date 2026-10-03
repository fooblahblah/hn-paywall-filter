// Tests for the logic that does not need a browser. Run with: node --test
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

for (const file of ['seed.js', 'psl.js', 'shared.js', 'signals.js', 'analyze.js']) {
  vm.runInThisContext(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { filename: file });
}
const { HNPF, HNPF_SIGNALS: S, HNPF_ANALYZE: A, HNPF_SEED } = globalThis;

const DAY = 24 * 60 * 60 * 1000;
const state = (over = {}) => ({ sites: {}, pages: {}, checks: {}, ...over });
const article = (words) => `<p>${'word '.repeat(words)}</p>`;

test('the built-in list is clean', () => {
  assert.ok(HNPF_SEED.length > 200);
  assert.equal(new Set(HNPF_SEED).size, HNPF_SEED.length);
  for (const d of HNPF_SEED) assert.equal(HNPF.normalizeDomain(d), d);
  for (const d of HNPF.MIXED) assert.ok(!HNPF_SEED.includes(d), `${d} is judged per article`);
  for (const d of HNPF_SEED) assert.equal(HNPF.siteProblem(d), '', d);
});

test('the notices of the lists the built-in list came from are kept', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  // MIT asks for the copyright line and the permission notice, whole, with every copy.
  const terms = read('LICENSE').slice(read('LICENSE').indexOf('Permission is hereby granted'));
  const notices = read('THIRD_PARTY_NOTICES');
  for (const owner of ['Copyright (c) 2022 Emre', 'Copyright (c) 2019 Adam']) {
    assert.ok(notices.includes(`MIT License\n\n${owner}\n\n${terms}`), owner);
  }
  assert.match(read('src/seed.js').split('globalThis')[0], /THIRD_PARTY_NOTICES/);
  assert.match(notices, /Mozilla Public License 2\.0/);
  assert.match(read('src/psl.js').slice(0, 1000), /Mozilla Public\s+\/\/ License, v\. 2\.0/);
});

test('normalizeDomain accepts domains, URLs and wildcards', () => {
  assert.equal(HNPF.normalizeDomain(' https://www.NYTimes.com/2026/a.html?x=1 '), 'nytimes.com');
  assert.equal(HNPF.normalizeDomain('*.ft.com'), 'ft.com');
  assert.equal(HNPF.normalizeDomain('github.com/user'), 'github.com');
  assert.equal(HNPF.normalizeDomain('bbc.co.uk.'), 'bbc.co.uk');
  for (const bad of ['', 'localhost', 'not a domain', 'a..b', '-x.com', '127.0.0.1']) {
    assert.equal(HNPF.normalizeDomain(bad), null, bad);
  }
});

test('isPublicHost refuses addresses and names that only resolve inside a network', () => {
  const host = (url) => new URL(url).hostname;
  for (const ok of ['example.com', 'www.nytimes.com', 'blog.example', 'news.bbc.co.uk', 'xn--bcher-kva.example', 'example.com.']) {
    assert.equal(HNPF.isPublicHost(ok), true, ok);
  }
  const bad = [
    'localhost', 'localhost.', 'app.localhost', 'intranet', 'router.lan', 'nas.local', 'printer.local.',
    'build.internal', 'box.home.arpa', '1.168.192.in-addr.arpa', 'pc.localdomain', 'wiki.corp', 'tv.home',
    'x.test', 'x.invalid', 'abc.onion', 'pc.localdomain6', '',
    'router', 'nas', 'router.', '.router', 'a..com',
    // Addresses, in every spelling the URL parser accepts.
    host('http://192.168.1.1/'), host('http://127.1/'), host('http://2130706433/'), host('http://0x7f.0.0.1/'),
    host('http://8.8.8.8/'), host('http://[::1]/'), host('http://[::ffff:10.0.0.1]/'), host('http://[fe80::1]/'),
  ];
  for (const h of bad) assert.equal(HNPF.isPublicHost(h), false, h);
});

test('siteFor prefers the HN label and otherwise takes the registrable domain', () => {
  assert.equal(HNPF.siteFor('https://www.nytimes.com/a', 'nytimes.com'), 'nytimes.com');
  assert.equal(HNPF.siteFor('https://github.com/u/r', 'github.com/u'), 'github.com');
  assert.equal(HNPF.siteFor('https://blog.cloudflare.com/x', 'cloudflare.com'), 'cloudflare.com');
  assert.equal(HNPF.siteFor('https://edition.cnn.com/x'), 'cnn.com');
  assert.equal(HNPF.siteFor('https://news.bbc.co.uk/x'), 'bbc.co.uk');
  assert.equal(HNPF.siteFor('https://foo.substack.com/p/x'), 'foo.substack.com');
  assert.equal(HNPF.siteFor('https://example.com/x', 'unrelated.org'), 'example.com');
  assert.equal(HNPF.siteFor('mailto:a@b.com'), null);
});

test('siteFor never files a story under a name that many unrelated sites share', () => {
  const sites = {
    'https://www.soumu.go.jp/x': 'soumu.go.jp',
    'https://www.economie.gouv.fr/x': 'economie.gouv.fr',
    'https://blog.example.me.uk/x': 'example.me.uk',
    'https://myapp.herokuapp.com/': 'myapp.herokuapp.com',
    'https://foo.workers.dev/': 'foo.workers.dev',
    'https://foo.web.app/': 'foo.web.app',
    'https://user.gitbook.io/x': 'user.gitbook.io',
    'https://foo.readthedocs.io/x': 'foo.readthedocs.io',
    'https://bucket.s3.amazonaws.com/x': 'bucket.s3.amazonaws.com',
    'https://docs.aws.amazon.com/x': 'amazon.com',
    'https://a.b.someone.github.io/x': 'someone.github.io',
    'https://someone.medium.com/x': 'someone.medium.com',
    // Rules for every name one level below, and the exceptions to them.
    'https://www.example.com.ck/x': 'example.com.ck',
    'https://shop.www.ck/x': 'www.ck',
    'https://www.city.kawasaki.jp/x': 'city.kawasaki.jp',
    'https://a.b.c.kawasaki.jp/x': 'b.c.kawasaki.jp',
    // A name the list does not know ends in a suffix of one label.
    'https://a.b.example/x': 'b.example',
    // Names outside ASCII are compared in the form the URL parser gives them.
    'https://www.食狮.公司.cn/x': 'xn--85x722f.xn--55qx5d.cn',
  };
  for (const [url, site] of Object.entries(sites)) assert.equal(HNPF.siteFor(url), site, url);
});

test('siteFor ignores an HN label that names a public suffix', () => {
  assert.equal(HNPF.siteFor('https://www.economie.gouv.fr/x', 'gouv.fr'), 'economie.gouv.fr');
  assert.equal(HNPF.siteFor('https://myapp.herokuapp.com/x', 'herokuapp.com'), 'myapp.herokuapp.com');
  assert.equal(HNPF.siteFor('https://www.soumu.go.jp/x', 'soumu.go.jp'), 'soumu.go.jp');
  // Nor one that names a host shared by many sites, when the story is on one of them.
  assert.equal(HNPF.siteFor('https://bucket.s3.amazonaws.com/x', 'amazonaws.com'), 'bucket.s3.amazonaws.com');
  assert.equal(HNPF.siteFor('https://someone.substack.com/p/x', 'substack.com'), 'someone.substack.com');
  assert.equal(HNPF.siteFor('https://substack.com/home/post/p-1', 'substack.com'), 'substack.com');
});

test('siteFor: a host that is no domain name is its own site, whole', () => {
  assert.equal(HNPF.siteFor('http://192.168.1.10/x'), '192.168.1.10');
  assert.equal(HNPF.siteFor('http://localhost:3000/x'), 'localhost');
  assert.equal(HNPF.siteFor('http://[::1]/x'), '[::1]');
  assert.equal(HNPF.siteFor('https://github.io/'), 'github.io');
});

test('siteFor: a full stop after the name and an odd label below the site change nothing', () => {
  assert.equal(HNPF.siteFor('https://www.example.com./x'), 'example.com');
  assert.equal(HNPF.pageKey('https://www.example.com./x/'), 'example.com/x');
  assert.equal(HNPF.hostOf('https://Example.COM./x'), 'example.com');
  assert.equal(HNPF.siteFor('https://my_app.example.com/x'), 'example.com');
  assert.equal(HNPF.siteFor('https://my_app.example.com/x', 'example.com'), 'example.com');
  assert.equal(HNPF.hideableSite('https://my_app.example.com/x'), 'example.com');
  // A site whose own name is no domain name still cannot be listed.
  assert.equal(HNPF.hideableSite('https://www.my_app.com/x'), null);
});

test('canHideArticle: not one that is hidden already, nor one on a site set to always show', () => {
  const url = 'https://medium.com/@someone/a-post';
  const can = (over) => HNPF.canHideArticle(HNPF.classify(url, state(over)));
  const mine = (status) => ({ status, source: 'manual', at: Date.now() });
  assert.equal(can({}), true);
  assert.equal(can({ pages: { 'medium.com/@someone/a-post': mine('allowed') } }), true);
  assert.equal(can({ pages: { 'medium.com/@someone/a-post': mine('gated') } }), false);
  assert.equal(can({ sites: { 'medium.com': mine('gated') } }), false);
  // The site's entry would win over one for the article, so hiding it would do nothing.
  assert.equal(can({ sites: { 'medium.com': mine('allowed') } }), false);
});

test('the public suffix list is loaded ahead of shared.js wherever sites are worked out', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const inOrder = (text) => assert.match(text, /psl\.js[^]*shared\.js/);
  inOrder(JSON.stringify(JSON.parse(read('manifest.json')).content_scripts[0].js));
  inOrder(read('src/background.js').match(/importScripts\(.*\)/)[0]);
  for (const page of ['src/popup.html', 'src/options.html']) inOrder(read(page));
  assert.ok(globalThis.HNPF_PSL.split(/\s+/).length > 9000);
});

test('siteProblem says why a name cannot go on the site list', () => {
  for (const ok of ['nytimes.com', 'bbc.co.uk', 'someone.github.io', 'substack.com', 'medium.com', 'https://www.ft.com/x', 'nas.local']) {
    assert.equal(HNPF.siteProblem(ok), '', ok);
  }
  for (const bad of ['192.168.1.10', 'localhost', '[::1]', 'not a domain', '']) {
    assert.match(HNPF.siteProblem(bad), /is not a site name$/, bad);
  }
  assert.equal(HNPF.siteProblem('localhost'), '"localhost" is not a site name');
  for (const shared of ['co.uk', 'com.au', 'github.io', 'herokuapp.com', 'go.jp', 'https://www.gouv.fr/', 'web.app', 's3.amazonaws.com', 'anything.ck']) {
    assert.match(HNPF.siteProblem(shared), /is shared by many unrelated sites$/, shared);
  }
  assert.equal(HNPF.siteProblem('*.co.uk'), 'co.uk is shared by many unrelated sites');
});

test('hideableSite: the site a story can be hidden with, if it has one of its own', () => {
  const own = {
    'https://www.nytimes.com/a': 'nytimes.com',
    'https://someone.substack.com/p/x': 'someone.substack.com',
    'https://someone.medium.com/x': 'someone.medium.com',
    'https://someone.hashnode.dev/x': 'someone.hashnode.dev',
    'https://someone.notion.site/x': 'someone.notion.site',
    'https://myapp.herokuapp.com/x': 'myapp.herokuapp.com',
    'https://cs.example.edu/~someone/x': 'example.edu',
  };
  for (const [url, site] of Object.entries(own)) assert.equal(HNPF.hideableSite(url), site, url);
  assert.equal(HNPF.hideableSite('https://blog.cloudflare.com/x', 'cloudflare.com'), 'cloudflare.com');

  // On a platform shared by many authors only the article can be hidden from a story.
  assert.equal(HNPF.hideableSite('https://medium.com/@someone/a-post', 'medium.com/@someone'), null);
  for (const url of [
    'https://medium.com/@someone/a-post', 'https://substack.com/home/post/p-1', 'https://dev.to/someone/x',
    'https://old.reddit.com/r/x', 'https://www.reddit.com/r/x', 'https://x.com/someone/status/1',
    'https://sites.google.com/view/x', 'https://www.linkedin.com/pulse/x',
  ]) {
    assert.equal(HNPF.hideableSite(url), null, url);
  }
  assert.equal(HNPF.hideableSite('https://old.reddit.com/r/x', 'old.reddit.com'), null);
  // Nor does a host that cannot be put on the site list have a site to hide.
  for (const url of ['http://192.168.1.10/x', 'http://localhost:3000/x', 'http://[::1]/x', 'https://github.io/', 'mailto:a@b.com']) {
    assert.equal(HNPF.hideableSite(url), null, url);
  }
});

test('pageKey ignores scheme, www, tracking parameters and trailing slash', () => {
  assert.equal(HNPF.pageKey('http://www.example.com/a/b/?utm_source=hn&ref=x#top'), 'example.com/a/b');
  assert.equal(HNPF.pageKey('https://example.com/a/b'), 'example.com/a/b');
});

test('pageKey keeps the query that names the article', () => {
  assert.equal(HNPF.pageKey('https://example.com/story.php?id=1'), 'example.com/story.php?id=1');
  assert.notEqual(HNPF.pageKey('https://example.com/story.php?id=1'), HNPF.pageKey('https://example.com/story.php?id=2'));
  assert.equal(HNPF.pageKey('https://marc.info/?m=1&l=a&utm_medium=x'), HNPF.pageKey('https://marc.info/?l=a&m=1'));
  assert.notEqual(HNPF.pageKey('https://marc.info/?l=a&m=1'), HNPF.pageKey('https://marc.info/'));
});

test('classify: "show this article" outranks a site the detectors hid, not one you hid', () => {
  const now = 10 * DAY;
  const pages = { 'example.com/a': { status: 'allowed', source: 'manual', at: now } };
  const auto = state({ pages, sites: { 'example.com': { status: 'gated', source: 'visit', articles: 3, at: now } } });
  assert.equal(HNPF.classify('https://example.com/a', auto, now).source, 'allowed');
  assert.equal(HNPF.classify('https://example.com/b', auto, now).gated, true);
  // Unlike other on-visit verdicts, a site hidden for its articles is looked at again.
  assert.equal(HNPF.classify('https://example.com/b', auto, now + 31 * DAY).gated, false);

  const mine = state({ pages, sites: { 'example.com': { status: 'gated', source: 'manual', at: now } } });
  assert.equal(HNPF.classify('https://example.com/a', mine, now).gated, true);
});

test('classify: built-in list covers subdomains', () => {
  const c = HNPF.classify('https://cooking.nytimes.com/recipe', state());
  assert.deepEqual([c.gated, c.source, c.key], [true, 'seed', 'nytimes.com']);
  assert.equal(HNPF.classify('https://notnytimes.com/', state()).gated, false);
  assert.equal(HNPF.classify('item?id=1', state()).gated, false);
});

test('classify: the user list overrides the built-in list', () => {
  const s = state({ sites: { 'nytimes.com': { status: 'allowed', source: 'manual', at: 1 } } });
  const c = HNPF.classify('https://www.nytimes.com/a', s);
  assert.deepEqual([c.gated, c.source], [false, 'allowed']);
});

test('classify: the most specific entry wins', () => {
  const s = state({
    sites: {
      'example.com': { status: 'gated', source: 'manual', at: 1 },
      'blog.example.com': { status: 'allowed', source: 'manual', at: 1 },
    },
  });
  assert.equal(HNPF.classify('https://blog.example.com/a', s).gated, false);
  assert.equal(HNPF.classify('https://shop.example.com/a', s).gated, true);
});

test('classify: background-check verdicts expire, the others do not', () => {
  const now = 100 * DAY;
  const old = now - 31 * DAY;
  const check = state({ sites: { 'example.com': { status: 'gated', source: 'check', at: old } } });
  const visit = state({ sites: { 'example.com': { status: 'gated', source: 'visit', at: old } } });
  assert.equal(HNPF.classify('https://example.com/a', check, now).gated, false);
  assert.equal(HNPF.classify('https://example.com/a', check, old + DAY).gated, true);
  assert.equal(HNPF.classify('https://example.com/a', visit, now).gated, true);
});

test('classify: your choice for one article does not expire, a detected one does', () => {
  const now = Date.now();
  const old = now - 31 * DAY;
  const s = state({
    pages: {
      'example.com/shown': { status: 'allowed', source: 'manual', at: old },
      'example.com/found': { status: 'gated', source: 'check', reason: 'r', at: old },
      'nytimes.com/shown': { status: 'allowed', source: 'manual', at: old },
    },
  });
  assert.equal(HNPF.classify('https://example.com/shown', s, now).source, 'allowed');
  assert.equal(HNPF.classify('https://example.com/found', s, now).gated, false);
  assert.equal(HNPF.classify('https://example.com/found', s, old + DAY).gated, true);
  // Still shown where only the built-in list hides the site.
  assert.equal(HNPF.classify('https://www.nytimes.com/shown', s, now).source, 'allowed');
});

test('classify: an expired entry on a subdomain gives way to the entry above it', () => {
  const now = Date.now();
  const old = { status: 'gated', source: 'check', articles: 3, at: now - 31 * DAY };
  const s = state({
    sites: {
      'example.com': { status: 'gated', source: 'manual', at: 1 },
      'blog.example.com': old,
      'nytimes.com': { status: 'allowed', source: 'manual', at: 1 },
      'cooking.nytimes.com': old,
      'a.news.example.org': old,
      'news.example.org': { status: 'gated', source: 'check', reason: 'r', articles: 3, at: now },
    },
  });
  const blog = HNPF.classify('https://blog.example.com/a', s, now);
  assert.deepEqual([blog.gated, blog.source, blog.key], [true, 'manual', 'example.com']);
  assert.equal(HNPF.classify('https://other.example.com/a', s, now).gated, true);
  const shown = HNPF.classify('https://cooking.nytimes.com/recipe', s, now);
  assert.deepEqual([shown.gated, shown.source, shown.key], [false, 'allowed', 'nytimes.com']);
  const news = HNPF.classify('https://a.news.example.org/x', s, now);
  assert.deepEqual([news.gated, news.source, news.key], [true, 'check', 'news.example.org']);
  // "Show this article" still outranks the detected site that decides in the end.
  s.pages = { 'a.news.example.org/x': { status: 'allowed', source: 'manual', at: now } };
  assert.equal(HNPF.classify('https://a.news.example.org/x', s, now).source, 'allowed');
});

test('classify: your entry on a site outranks what a detector found on a subdomain of it', () => {
  const now = Date.now();
  const found = { status: 'gated', source: 'check', reason: 'r', articles: 3, at: now };
  const s = state({
    sites: {
      'example.com': { status: 'allowed', source: 'manual', at: 1 },
      'blog.example.com': found,
      'example.org': { status: 'gated', source: 'manual', at: 1 },
      'blog.example.org': found,
      'example.net': found,
      'blog.example.net': { status: 'allowed', source: 'manual', at: 1 },
    },
    pages: { 'blog.example.org/a': { status: 'allowed', source: 'manual', at: now } },
  });
  const shown = HNPF.classify('https://blog.example.com/a', s, now);
  assert.deepEqual([shown.gated, shown.source, shown.key], [false, 'allowed', 'example.com']);
  // A site you hid stays hidden, "show this article" on a subdomain or not.
  const mine = HNPF.classify('https://blog.example.org/a', s, now);
  assert.deepEqual([mine.gated, mine.source, mine.key], [true, 'manual', 'example.org']);
  // Your entry on the subdomain decides there, the detector's on the rest of the site.
  assert.equal(HNPF.classify('https://blog.example.net/a', s, now).source, 'allowed');
  assert.equal(HNPF.classify('https://shop.example.net/a', s, now).source, 'check');
});

test('classify: a host named like a built-in property is not an entry', () => {
  for (const url of ['http://constructor/', 'http://__proto__/', 'https://constructor.example/']) {
    assert.equal(HNPF.classify(url, state()).gated, false, url);
  }
});

test('classify: an article you hid yourself is yours, and does not expire', () => {
  const s = state({ pages: { 'medium.com/@someone/a-post': { status: 'gated', source: 'manual', at: 0 } } });
  const c = HNPF.classify('https://medium.com/@someone/a-post?utm_source=hn', s, 400 * DAY);
  assert.deepEqual([c.gated, c.source, c.page, c.key], [true, 'manual', true, 'medium.com/@someone/a-post']);
  assert.equal(HNPF.classify('https://medium.com/@someone/another', s, 400 * DAY).gated, false);
});

test('classify: a verdict on one article leaves the rest of the site alone', () => {
  const now = 10 * DAY;
  const s = state({ pages: { 'foo.substack.com/p/paid': { status: 'gated', source: 'check', reason: 'r', at: now } } });
  const paid = HNPF.classify('https://foo.substack.com/p/paid?utm_source=x', s, now);
  assert.deepEqual([paid.gated, paid.source, paid.page], [true, 'page', true]);
  assert.equal(HNPF.classify('https://foo.substack.com/p/free', s, now).gated, false);

  s.pages['foo.substack.com/p/paid'].status = 'allowed';
  assert.equal(HNPF.classify('https://foo.substack.com/p/paid', s, now).source, 'allowed');
});

test('classify: a link found to lead to another page is judged by that page', () => {
  const now = 100 * DAY;
  const led = (to) => ({ 'lnkd.in/abc123': { to, at: now } });
  const s = state({
    sites: {
      'walled.example': { status: 'gated', source: 'check', reason: '3 articles on this site looked gated', articles: 3, at: now },
      'shown.example': { status: 'allowed', source: 'manual', at: now },
    },
    pages: { 'news.example/paid': { status: 'gated', source: 'check', reason: 'r', site: 'news.example', at: now } },
  });
  const by = (to) => HNPF.classify('https://lnkd.in/abc123?utm_source=hn', { ...s, redirects: led(to) }, now);

  const seed = by('https://www.nytimes.com/2026/a.html');
  assert.deepEqual([seed.gated, seed.source, seed.key], [true, 'seed', 'nytimes.com']);
  const page = by('https://news.example/paid');
  assert.deepEqual([page.gated, page.source, page.key, page.page, page.host], [true, 'page', 'news.example/paid', true, 'news.example']);
  const site = by('https://walled.example/story');
  assert.deepEqual([site.gated, site.source, site.key, site.page], [true, 'check', 'walled.example', false]);
  const shown = by('https://shown.example/story');
  assert.deepEqual([shown.gated, shown.source, shown.key], [false, 'allowed', 'shown.example']);
  // A page that nothing decides on leaves the link as it is.
  const open = by('https://free.example/story');
  assert.deepEqual([open.gated, open.source, open.host], [false, null, 'lnkd.in']);
});

test("classify: the link's own entries decide before the page it leads to", () => {
  const now = 100 * DAY;
  const redirects = { 'lnkd.in/abc123': { to: 'https://www.nytimes.com/2026/a.html', at: now } };
  const mine = (over) => HNPF.classify('https://lnkd.in/abc123', state({ redirects, ...over }), now);

  assert.equal(mine({}).gated, true);
  assert.equal(mine({ sites: { 'lnkd.in': { status: 'allowed', source: 'manual', at: 1 } } }).source, 'allowed');
  assert.equal(mine({ pages: { 'lnkd.in/abc123': { status: 'allowed', source: 'manual', at: 1 } } }).source, 'allowed');
  const hid = mine({ sites: { 'lnkd.in': { status: 'gated', source: 'manual', at: 1 } } });
  assert.deepEqual([hid.gated, hid.source, hid.key], [true, 'manual', 'lnkd.in']);
  const page = mine({ pages: { 'lnkd.in/abc123': { status: 'gated', source: 'manual', at: 1 } } });
  assert.deepEqual([page.gated, page.source, page.key], [true, 'manual', 'lnkd.in/abc123']);
});

test('classify: where a link leads counts for a while, and only one step', () => {
  const now = 100 * DAY;
  const to = 'https://www.nytimes.com/2026/a.html';
  const at = (when) => state({ redirects: { 'lnkd.in/abc123': { to, at: when } } });
  assert.equal(HNPF.classify('https://lnkd.in/abc123', at(now - 29 * DAY), now).gated, true);
  assert.equal(HNPF.classify('https://lnkd.in/abc123', at(now - 31 * DAY), now).gated, false);

  // A page that leads on again is judged as itself.
  const chain = state({
    redirects: {
      'lnkd.in/abc123': { to: 'https://bit.ly/xyz', at: now },
      'bit.ly/xyz': { to, at: now },
    },
  });
  assert.equal(HNPF.classify('https://bit.ly/xyz', chain, now).gated, true);
  assert.equal(HNPF.classify('https://lnkd.in/abc123', chain, now).gated, false);
  // Nor is anything followed for a link nobody recorded, or under a key every object has.
  for (const url of ['https://lnkd.in/other', 'http://__proto__/', 'http://constructor/']) {
    assert.equal(HNPF.classify(url, chain, now).gated, false, url);
  }
});

test('classify: a state with no record of where links lead is judged as before', () => {
  const s = { sites: {}, pages: {}, checks: {} };
  assert.equal(HNPF.classify('https://lnkd.in/abc123', s).gated, false);
  assert.equal(HNPF.classify('https://www.nytimes.com/a', s).gated, true);
});

test('gatePhrase recognises wording that withholds content', () => {
  for (const text of [
    'Subscribe to continue reading',
    'Create a free account to continue reading this article',
    'To continue reading, please log in or subscribe',
    'Sign up to read the full story',
    'This post is for paid subscribers',
    'This article is exclusively for subscribers',
    'Member-only story',
    "You've reached your monthly article limit",
    'You have 2 free articles remaining',
    'Keep reading with a 7-day free trial',
    'Unlock this article',
    'Enter your email to continue',
    'Registration is required to read this article',
    'You have reached your limit of free articles this month',
    'Subscribe to read the rest of this article',
    'Log in to view this story',
    'An account is required to continue reading',
    'Only available to paid members',
    "You've reached your limit of 3 free articles this month",
    'Subscribe to read this premium article',
    'Sign up to read the full news story',
    'This story is available only to members',
    'What the minister said Subscribe to continue reading',
    'Officials say the budget will pass Subscribe to continue reading',
    '"It was never going to work," she said. Subscribe to continue reading',
    'I hate sites that say you have 2 free articles remaining. Subscribe to continue reading',
  ]) {
    assert.ok(S.gatePhrase(S.normalizeText(text)), text);
  }
});

test('gatePhrase ignores ordinary prose and newsletter promos', () => {
  for (const text of [
    'Subscribe to our newsletter for weekly updates',
    'Sign up for our newsletter to keep reading stories like this',
    'Continue reading below',
    'Already have an account? Sign in',
    'Members of the committee met on Tuesday. The limit was reached quickly.',
    'You can register for the conference here',
    'Subscribe Continue reading',
    'We quickly hit the limit of what a single Postgres instance can do.',
    'Once you have reached the limit, requests return 429.',
    'Join us to see how this works in practice.',
    'Log in to view this page.',
    'Sign up to access this API from your own app.',
    'Register to see the full agenda and speaker list.',
    'Join our Discord to see the full roadmap.',
    'This feature is only available to members of the beta program.',
    'This page is only available to members of the beta program.',
    'An account is required to access the admin console.',
    'Enter your email to access the beta.',
    // Wording that is reported or quoted rather than shown as a prompt.
    'I hate sites that say you have 2 free articles remaining.',
    'The banner said "Subscribe to continue reading" and I closed the tab.',
    'They told me to subscribe to continue reading, so I left.',
    'I hate sites that say "You have 2 free articles remaining".',
    "The banner said 'Subscribe to continue reading'.",
    'The NYT asks you to log in to continue reading.',
    'Subscribe to see more posts like this.',
    'Subscribe to read more posts by email.',
    'Join our Slack to read the full post-mortem.',
    "Log in to see this article's comments.",
    'Sign up to view the full report on GitHub Security.',
  ]) {
    assert.equal(S.gatePhrase(S.normalizeText(text)), null, text);
  }
});

test('gatePhrase: a count of free articles left can be left out', () => {
  for (const text of ['You have 2 free articles remaining this month.', 'This is your last free article.']) {
    assert.ok(S.gatePhrase(text), text);
    assert.equal(S.gatePhrase(text, { meter: false }), null, text);
  }
  // Wording that says the reads are used up, or any other prompt after the count, stays.
  assert.ok(S.gatePhrase('You have no more free articles.', { meter: false }));
  assert.match(S.gatePhrase('1 free article left. Subscribe to continue reading.', { meter: false }), /^Subscribe/);
  assert.ok(S.gatePhrase('Subscribe now, 2 free articles left, to continue reading', { meter: false }));
});

test('proseWords counts paragraphs of a rendered page, not menus or cookie notices', () => {
  const para = 'word '.repeat(50);
  assert.equal(S.proseWords(`Home\nAbout us\n${para}\n\n${para}\nShare this`), 100);
  assert.equal(S.proseWords(`We use cookies ${'and similar things '.repeat(10)}`), 0);
  assert.equal(S.proseWords(''), 0);
});

test('analyzeHtml: a metered article shown in full with a count of free reads is free', () => {
  const ld = '<script type="application/ld+json">{"isAccessibleForFree": false}</script>';
  const counter = '<div>You have 2 free articles remaining.</div>';
  assert.equal(A.analyzeHtml(ld + article(900) + counter).verdict, 'free');
  assert.equal(A.analyzeHtml(ld + article(100) + counter).verdict, 'gated');
  assert.equal(A.analyzeHtml(ld + article(900) + counter + '<div>Subscribe to continue reading.</div>').verdict, 'gated');
});

test('analyzeHtml: a declared paywall needs a prompt to count', () => {
  const ld = '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script>';
  const metered = '<meta property="article:content_tier" content="metered">';
  const prompt = '<div><h3>Subscribe to continue reading</h3></div>';
  for (const head of [ld, metered]) {
    // Metered sites declare a paywall on articles they still show, sometimes loading the
    // rest by script (short source, no prompt).
    assert.equal(A.analyzeHtml(`<head>${head}</head><body>${article(900)}</body>`).verdict, 'free');
    assert.equal(A.analyzeHtml(`<head>${head}</head><body>${article(200)}</body>`).verdict, 'free');
    assert.equal(A.analyzeHtml(`<head>${head}</head><body>${article(900)}${prompt}</body>`).verdict, 'gated');
  }
});

test('analyzeHtml: "locked" metadata is decisive', () => {
  const tier = '<meta property="article:content_tier" content="locked">';
  assert.equal(A.analyzeHtml(`<head>${tier}</head><body>${article(900)}</body>`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`${tier.replace('locked', 'free')}${article(900)}`).verdict, 'free');
});

test('analyzeHtml: an article cut short by a prompt is gated, a full one is not', () => {
  const prompt = '<div class="wall"><h3>Subscribe to continue reading</h3></div>';
  assert.equal(A.analyzeHtml(`<body>${article(120)}${prompt}</body>`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`<body>${article(900)}${prompt}</body>`).verdict, 'free');
  assert.equal(A.analyzeHtml(`<body>${article(120)}${prompt}</body>`, { truncated: true }).verdict, 'free');
});

test('analyzeHtml: text counts however the page marks it up', () => {
  const prompt = '<div class="wall"><h3>Subscribe to continue reading</h3></div>';
  const sentence = 'word '.repeat(30);
  const unclosed = `<p>${sentence}\n`.repeat(40);
  const divs = `<div class="para">${sentence}</div>`.repeat(50);
  const inline = `<div>${'<a href="/x">word</a> <em>word</em> <code>word</code><br>'.repeat(400)}</div>`;
  for (const text of [unclosed, divs, inline]) {
    assert.equal(A.analyzeHtml(`<body>${text}${prompt}</body>`).verdict, 'free');
    assert.equal(A.analyzeHtml(`<body>${text}</body>`).verdict, 'free');
  }
  assert.equal(A.analyzeHtml(`<body><div>${'word '.repeat(120)}</div>${prompt}</body>`).verdict, 'gated');
});

test('analyzeHtml: short paragraphs and unusual inline tags still count', () => {
  const prompt = '<div class="wall"><h3>Subscribe to continue reading</h3></div>';
  const terse = `<p>${'word '.repeat(10)}</p>`.repeat(60);
  const tt = `<p>${'word word word word word <tt>x</tt> word word word word <x-ref>1</x-ref> '.repeat(90)}</p>`;
  const custom = `<div>${'word word word word word word word <x-ref>1</x-ref> '.repeat(100)}</div>`;
  for (const text of [terse, tt, custom]) {
    assert.equal(A.analyzeHtml(`<body>${text}${prompt}</body>`).verdict, 'free');
    assert.equal(A.analyzeHtml(`<body>${text}</body>`).verdict, 'free');
  }
});

test('analyzeHtml: quoted wording is recognised through HTML entities', () => {
  for (const [open, close] of [['&#8220;', '&#8221;'], ['&ldquo;', '&rdquo;'], ['&#x201C;', '&#x201D;'], ['&quot;', '&quot;'], ['“', '”']]) {
    const html = `<body>${article(300)}<p>The banner said ${open}Subscribe to continue reading${close} and I closed the tab.</p></body>`;
    assert.equal(A.analyzeHtml(html).verdict, 'free', open);
  }
});

test('analyzeHtml: menus and link lists are not article text', () => {
  const prompt = '<div class="wall"><h3>Subscribe to continue reading</h3></div>';
  const links = '<ul>' + '<li><a href="/x">Another headline from the front page</a></li>'.repeat(100) + '</ul>';
  assert.equal(A.analyzeHtml(`<body>${article(120)}${prompt}<div>${links}</div></body>`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`<body><div id="root"></div>${links}</body>`).verdict, 'unknown');

  const long = '<ul>' + '<li><a href="/x">Another rather long headline from the front page that runs to fourteen words here</a></li>'.repeat(60) + '</ul>';
  assert.equal(A.analyzeHtml(`<body>${article(120)}${prompt}${long}</body>`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`<body><div id="root"></div>${long}</body>`).verdict, 'unknown');
  const notice = `<div>We use cookies ${'and similar things '.repeat(16)}</div>`;
  assert.equal(A.analyzeHtml(`<head><title>${'word '.repeat(45)}</title></head><body><div id="root"></div>${notice}</body>`).verdict, 'unknown');
});

test('analyzeHtml: prose that merely mentions a limit or a login is free', () => {
  const div = (words) => `<div>${'word '.repeat(words)}</div>`;
  assert.equal(A.analyzeHtml(`<body>${div(800)}<div>Log in to view this page.</div></body>`).verdict, 'free');
  assert.equal(
    A.analyzeHtml(`<body>${article(300)}<div class="comment">I reached the limit on that site ages ago</div></body>`).verdict,
    'free',
  );
});

test('analyzeHtml: wording inside scripts and navigation does not count', () => {
  const html = `<body><nav>Subscribe to continue reading</nav><script>var t = "Subscribe to continue reading"</script>${article(120)}</body>`;
  assert.equal(A.analyzeHtml(html).verdict, 'free');
});

test('analyzeHtml: malformed markup does not stall the check', () => {
  // Several of these, repeated and never closed, once cost time quadratic in the page:
  // tens of seconds to minutes at this size. Now each takes a fraction of a second.
  const SIZE = 1_500_000;
  const junk = [
    '< ', '<a ', '<a>', '<a x>', '<a>x</a ', '<div ', '<p> ', '<p>word ', '&', '&amp',
    '<script x ', '<script> ', '<script type="application/ld+json"> ', '</script ',
    '<meta x ', '<meta article:content_tier ', '<meta property= ', '<link href= ',
    '<title x ', '<title> ', '<!-- ', '<nav> ', '<nav>x</nav ', '<svg> ', '<style> ', '<footer x ',
  ];
  const tests = junk.map((piece) => piece.repeat(Math.ceil(SIZE / piece.length)));
  // One opening tag with a long run inside it, rather than many openings.
  for (const piece of ['article:content_tier ', 'application/ld+json ', ' src=', ' property=al:android:package']) {
    for (const tag of ['<meta ', '<script ', '<link ']) tests.push(tag + piece.repeat(Math.ceil(SIZE / piece.length)));
  }
  for (const html of tests) {
    const start = performance.now();
    A.analyzeHtml(html);
    const took = performance.now() - start;
    assert.ok(took < 5000, `${JSON.stringify(html.slice(0, 40))}… took ${Math.round(took)} ms`);
  }
});

test('analyzeHtml: blocks that are never closed keep the text after them', () => {
  const prompt = '<div>Subscribe to continue reading.</div>';
  for (const open of ['<nav>', '<script>', '<style>', '<!-- ', '<svg>', '<footer>']) {
    assert.equal(A.analyzeHtml(`<body>${open}${article(120)}${prompt}</body>`).verdict, 'gated', open);
    assert.equal(A.analyzeHtml(`<body>${open}${article(900)}</body>`).verdict, 'free', open);
  }
  // One block left open does not keep the closed ones before or after it.
  const hidden = '<script>var t = "Subscribe to continue reading"</script><!-- Subscribe to continue reading -->';
  assert.equal(A.analyzeHtml(`<body>${hidden}<nav>${article(900)}${hidden}<script>${hidden}</body>`).verdict, 'free');
});

test('analyzeHtml: tags are read in any case and with space before the closing bracket', () => {
  const html = `<body><NAV>Subscribe to continue reading</NAV ><SCRIPT>var t = "Subscribe to continue reading"</Script\n><Style>p::after { content: "Subscribe to continue reading" }</sTYLE>${article(120)}</body>`;
  assert.equal(A.analyzeHtml(html).verdict, 'free');
  const ld = '<SCRIPT data-x="1" TYPE="application/LD+JSON">{"isAccessibleForFree": false}</SCRIPT >';
  const prompt = '<div>Subscribe to continue reading.</div>';
  assert.equal(A.analyzeHtml(`${ld}<body>${article(900)}${prompt}</body>`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`<META CONTENT="locked" PROPERTY="article:content_tier">${article(900)}`).verdict, 'gated');
});

test('analyzeHtml: a declared paywall is read from its own script, wherever that sits', () => {
  const prompt = '<div>Subscribe to continue reading.</div>';
  const ld = '<script type="application/ld+json">{"isAccessibleForFree": false}</script>';
  const body = `<body>${article(900)}${prompt}</body>`;
  assert.equal(A.analyzeHtml(`<script>var a = 1;</script>${ld}${body}`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`${body}${ld}<script>never closed`).verdict, 'gated');
  // Another script saying the same thing is not a declaration.
  assert.equal(A.analyzeHtml(`<script>var d = {"isAccessibleForFree": false}</script>${body}`).verdict, 'free');
  assert.equal(A.analyzeHtml(`<script type="application/ld+json">{"isAccessibleForFree": true}</script>${body}`).verdict, 'free');
  // Script tags that are not closed, or not tags at all, do not swallow the declaration.
  assert.equal(A.analyzeHtml(`<script src="/a.js"/>${ld}${body}`).verdict, 'gated');
  assert.equal(A.analyzeHtml(`<!-- paste the <script> tag below -->${ld}${body}`).verdict, 'gated');
});

test('analyzeHtml: on a page that was cut off, a script or style left open is not text', () => {
  const ld = '<script type="application/ld+json">{"isAccessibleForFree": false}</script>';
  const state = `<script>window.STATE = {"title": "Subscribe to continue reading", "body": "${'word '.repeat(900)}`;
  assert.equal(A.analyzeHtml(`${ld}<body>${article(900)}${state}`, { truncated: true }).verdict, 'free');
  for (const open of ['<script>', '<style>', '<!-- ']) {
    const html = `<body><div id="root"></div>${open}${'word '.repeat(900)}`;
    assert.equal(A.analyzeHtml(html, { truncated: true }).verdict, 'unknown', open);
  }
  // Navigation left open may hold the article, and a closed script is dropped as ever.
  assert.equal(A.analyzeHtml(`<body><nav>${article(900)}<script>var a;</script>`, { truncated: true }).verdict, 'free');
});

test('analyzeHtml: only short links are left out of the count', () => {
  const prompt = '<div>Subscribe to continue reading.</div>';
  const words = (n) => 'word '.repeat(n);
  assert.equal(A.analyzeHtml(`<body><div><a href="/x">${words(380)}</a></div>${prompt}</body>`).verdict, 'gated');
  // A link that is never closed, or closed far on, is not one.
  assert.equal(A.analyzeHtml(`<body><div><a href="/x">${words(450)}</a></div>${prompt}</body>`).verdict, 'free');
  assert.equal(A.analyzeHtml(`<body><div><a name="top">${words(450)}</div>${prompt}</body>`).verdict, 'free');
  assert.equal(A.analyzeHtml(`<body><div><a name="top">${words(450)}<a href="/x">${words(20)}</a></div>${prompt}</body>`).verdict, 'free');
});

test('analyzeHtml: a bot check is told by its title', () => {
  assert.equal(A.analyzeHtml(`<title data-x="1">\n Attention Required! | Cloudflare</title>${article(900)}`).verdict, 'unknown');
  assert.equal(A.analyzeHtml(`<title>How we passed the security check</title>${article(900)}`).verdict, 'free');
});

test('analyzeHtml: pages it cannot judge are unknown', () => {
  assert.equal(A.analyzeHtml('<html><head><title>Just a moment...</title></head><body></body></html>').verdict, 'unknown');
  assert.equal(A.analyzeHtml('<html><body><div id="root"></div><script src="app.js"></script></body></html>').verdict, 'unknown');
});

test('analyzeHtml: flags platforms that mix free and paid posts', () => {
  const html = `<link href="https://substackcdn.com/x.css">${article(900)}`;
  assert.equal(A.analyzeHtml(html).platform, true);
  assert.equal(A.analyzeHtml(`<script async src="//substackcdn.com/b.js"></script>${article(900)}`).platform, true);
  assert.equal(A.analyzeHtml(`<meta property="al:android:package" content="com.medium.reader">${article(900)}`).platform, true);
  assert.equal(A.analyzeHtml(`<meta content="com.medium.reader" property="al:android:package">${article(900)}`).platform, true);
  assert.equal(A.analyzeHtml(`<!-- <link href="https://substackcdn.com/x.css"> -->${article(900)}`).platform, false);
  assert.equal(A.analyzeHtml(article(900)).platform, false);
  // One embedded image or a link in the text does not make the site a platform.
  for (const embed of ['<img src="https://substackcdn.com/image/a.png">', '<a href="https://substackcdn.com/a.png">chart</a>', '<p>served from substackcdn.com</p>']) {
    assert.equal(A.analyzeHtml(embed + article(900)).platform, false, embed);
  }
});
