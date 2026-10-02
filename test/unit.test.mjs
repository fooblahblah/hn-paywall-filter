// Tests for the logic that does not need a browser. Run with: node --test
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

for (const file of ['seed.js', 'shared.js', 'signals.js', 'analyze.js']) {
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

test('siteFor prefers the HN label and otherwise guesses the base domain', () => {
  assert.equal(HNPF.siteFor('https://www.nytimes.com/a', 'nytimes.com'), 'nytimes.com');
  assert.equal(HNPF.siteFor('https://github.com/u/r', 'github.com/u'), 'github.com');
  assert.equal(HNPF.siteFor('https://blog.cloudflare.com/x', 'cloudflare.com'), 'cloudflare.com');
  assert.equal(HNPF.siteFor('https://edition.cnn.com/x'), 'cnn.com');
  assert.equal(HNPF.siteFor('https://news.bbc.co.uk/x'), 'bbc.co.uk');
  assert.equal(HNPF.siteFor('https://foo.substack.com/p/x'), 'foo.substack.com');
  assert.equal(HNPF.siteFor('https://example.com/x', 'unrelated.org'), 'example.com');
  assert.equal(HNPF.siteFor('mailto:a@b.com'), null);
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

test('classify: a verdict on one article leaves the rest of the site alone', () => {
  const now = 10 * DAY;
  const s = state({ pages: { 'foo.substack.com/p/paid': { status: 'gated', source: 'check', reason: 'r', at: now } } });
  const paid = HNPF.classify('https://foo.substack.com/p/paid?utm_source=x', s, now);
  assert.deepEqual([paid.gated, paid.source, paid.page], [true, 'page', true]);
  assert.equal(HNPF.classify('https://foo.substack.com/p/free', s, now).gated, false);

  s.pages['foo.substack.com/p/paid'].status = 'allowed';
  assert.equal(HNPF.classify('https://foo.substack.com/p/paid', s, now).source, 'allowed');
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
  ]) {
    assert.equal(S.gatePhrase(S.normalizeText(text)), null, text);
  }
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

test('analyzeHtml: wording inside scripts and navigation does not count', () => {
  const html = `<body><nav>Subscribe to continue reading</nav><script>var t = "Subscribe to continue reading"</script>${article(120)}</body>`;
  assert.equal(A.analyzeHtml(html).verdict, 'free');
});

test('analyzeHtml: pages it cannot judge are unknown', () => {
  assert.equal(A.analyzeHtml('<html><head><title>Just a moment...</title></head><body></body></html>').verdict, 'unknown');
  assert.equal(A.analyzeHtml('<html><body><div id="root"></div><script src="app.js"></script></body></html>').verdict, 'unknown');
});

test('analyzeHtml: flags platforms that mix free and paid posts', () => {
  const html = `<link href="https://substackcdn.com/x.css">${article(900)}`;
  assert.equal(A.analyzeHtml(html).platform, true);
  assert.equal(A.analyzeHtml(article(900)).platform, false);
});
