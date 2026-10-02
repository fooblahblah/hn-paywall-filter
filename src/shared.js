// Helpers shared by every context: service worker, content scripts, options and popup pages.
// Loaded as a classic script; everything hangs off the single HNPF global.
globalThis.HNPF = (() => {
  const DAY = 24 * 60 * 60 * 1000;

  // How long each kind of automatic verdict is trusted before it is looked at again.
  const TTL = { check: 30 * DAY, page: 30 * DAY, mixed: 30 * DAY, free: 14 * DAY, unknown: 3 * DAY };

  const DEFAULT_SETTINGS = { visitDetect: false, bgCheck: false, display: 'hide' };

  // Platforms that host both free and gated posts, and hosts that many unrelated authors
  // share by path: verdicts there apply to one article and never to the whole domain.
  const MIXED = new Set([
    'medium.com', 'substack.com', 'dev.to', 'reddit.com', 'telegra.ph', 'x.com', 'twitter.com',
    'hashnode.dev', 'notion.site', 'sites.google.com', 'docs.google.com', 'write.as', 'bsky.app',
    'linkedin.com', 'facebook.com', 'threads.net',
  ]);

  // Query parameters that track where a reader came from and do not change the article.
  const TRACKING_RE = /^(?:utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|igshid)$/i;

  // Hosts where every subdomain is a separate site.
  const MULTI_TENANT = new Set([
    'substack.com', 'medium.com', 'github.io', 'gitlab.io', 'wordpress.com', 'blogspot.com',
    'tumblr.com', 'neocities.org', 'pages.dev', 'netlify.app', 'vercel.app', 'bearblog.dev',
  ]);

  // Never gated, so not worth a background fetch.
  const SKIP_CHECK = new Set([
    'github.com', 'gitlab.com', 'youtube.com', 'youtu.be', 'arxiv.org', 'wikipedia.org',
    'archive.org', 'news.ycombinator.com',
  ]);

  const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne']);
  const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

  let seed;
  function seedSet() {
    return (seed ??= new Set(globalThis.HNPF_SEED || []));
  }

  // Hostname of an http(s) URL without a leading "www.", or null.
  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  // Turns user input ("https://www.NYTimes.com/x", "*.ft.com", "github.com/user") into a bare domain.
  function normalizeDomain(input) {
    let s = String(input ?? '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^/@]*@/, '');
    s = s.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    return DOMAIN_RE.test(s) ? s : null;
  }

  // Longest suffix of host ("a.b.com", then "b.com") present in a Set or as a key of an object.
  function findSuffix(host, table) {
    const has = table instanceof Set ? (k) => table.has(k) : (k) => Object.hasOwn(table, k);
    for (let h = host; h && h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
      if (has(h)) return h;
    }
    return null;
  }

  // Best guess at the registrable domain, without shipping the public suffix list.
  function baseDomain(host) {
    const parts = host.split('.');
    const tenant = findSuffix(host, MULTI_TENANT);
    let n = 2;
    if (tenant) n = tenant.split('.').length + 1;
    else if (parts.length > 2 && parts.at(-1).length === 2 && SECOND_LEVEL.has(parts.at(-2))) n = 3;
    return parts.slice(-n).join('.');
  }

  // The domain a story is filed under. HN's own site label is preferred when it fits the URL.
  function siteFor(url, hint) {
    const host = hostOf(url);
    if (!host) return null;
    const h = hint && normalizeDomain(hint);
    if (h && (host === h || host.endsWith('.' + h))) return h;
    return baseDomain(host);
  }

  // Host and path of a page, ignoring scheme, "www.", query and trailing slash.
  function pathKey(url) {
    try {
      const u = new URL(url);
      return u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  // Identifies one article: host, path and query, ignoring scheme, "www.", trailing slash,
  // tracking parameters and the order of the others ("story.php?id=1" names the article).
  function pageKey(url) {
    try {
      const u = new URL(url);
      const query = [...u.searchParams]
        .filter(([name]) => !TRACKING_RE.test(name))
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .sort()
        .join('&');
      return query ? `${pathKey(url)}?${query}` : pathKey(url);
    } catch {
      return null;
    }
  }

  function isMixed(host) {
    return !!host && !!findSuffix(host, MIXED);
  }

  // Whether a site entry was made by a detector once several of its articles looked gated.
  // Those expire, and give way to the user's choice for a single article.
  function isPromoted(entry) {
    return entry.source !== 'manual' && !!entry.articles;
  }

  function siteExpired(entry, now) {
    return (entry.source === 'check' || isPromoted(entry)) && now - entry.at > TTL.check;
  }

  // Decides whether a link is gated. `source` says which list decided it:
  // 'manual' | 'visit' | 'check' (a site entry), 'page' (one article), 'seed' (built-in), 'allowed'.
  function classify(url, state, now = Date.now()) {
    const host = hostOf(url);
    const out = { gated: false, source: null, reason: '', key: null, page: false, host };
    if (!host) return out;

    const pk = pageKey(url);
    const page = state.pages[pk]?.at >= now - TTL.page ? state.pages[pk] : null;
    const shown = { ...out, source: 'allowed', key: pk, page: true };

    const key = findSuffix(host, state.sites);
    if (key) {
      const e = state.sites[key];
      if (e.status === 'allowed') return { ...out, source: 'allowed', key };
      if (!siteExpired(e, now)) {
        // "Show this article" outranks a site the detectors hid, not one the user hid.
        if (page?.status === 'allowed' && e.source !== 'manual') return shown;
        return { ...out, gated: true, source: e.source, reason: e.reason || '', key };
      }
    }

    if (page) {
      if (page.status === 'allowed') return shown;
      return { ...out, gated: true, source: 'page', reason: page.reason || '', key: pk, page: true };
    }

    const builtin = findSuffix(host, seedSet());
    if (builtin) return { ...out, gated: true, source: 'seed', key: builtin };
    return out;
  }

  const SOURCE_LABELS = {
    seed: 'built-in list',
    manual: 'added by you',
    visit: 'detected when you visited',
    check: 'found by background check',
    page: 'this article looked gated',
  };

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || '';
  }

  async function loadState() {
    const s = await chrome.storage.local.get(['settings', 'sites', 'pages', 'checks']);
    return {
      settings: { ...DEFAULT_SETTINGS, ...s.settings },
      sites: s.sites || {},
      pages: s.pages || {},
      checks: s.checks || {},
    };
  }

  // The story from a recent HN listing that a tab is showing, if any. Sites add parameters
  // of their own to the address, so a link that differs only in its query still counts.
  function storyFor(stories, url) {
    return stories[pageKey(url)] || stories[pathKey(url)] || null;
  }

  // All writes go through the service worker so that they cannot overwrite each other.
  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  return {
    TTL, DEFAULT_SETTINGS, MIXED, SKIP_CHECK,
    seedSet, hostOf, normalizeDomain, findSuffix, baseDomain, siteFor, pathKey, pageKey, storyFor, isMixed, isPromoted, siteExpired,
    classify, sourceLabel, loadState, send,
  };
})();
