// Helpers shared by every context: service worker, content scripts, options and popup pages.
// Loaded as a classic script; everything hangs off the single HNPF global.
globalThis.HNPF = (() => {
  const DAY = 24 * 60 * 60 * 1000;

  // How long each kind of automatic verdict is trusted before it is looked at again.
  const TTL = { check: 30 * DAY, page: 30 * DAY, mixed: 30 * DAY, free: 14 * DAY, unknown: 3 * DAY };

  const DEFAULT_SETTINGS = { visitDetect: false, bgCheck: false, display: 'hide' };
  // What "access to all sites" asks Chromium for: web pages, which is all the detectors
  // look at. Not "<all_urls>", which takes in local files and other schemes as well.
  const ALL_SITES = { origins: ['https://*/*', 'http://*/*'] };

  // Platforms that host both free and gated posts, and hosts that many unrelated authors
  // share by path: verdicts there apply to one article and never to the whole domain.
  const MIXED = new Set([
    'medium.com', 'substack.com', 'dev.to', 'reddit.com', 'telegra.ph', 'x.com', 'twitter.com',
    'hashnode.dev', 'notion.site', 'sites.google.com', 'docs.google.com', 'write.as', 'bsky.app',
    'linkedin.com', 'facebook.com', 'threads.net',
  ]);

  // Query parameters that track where a reader came from and do not change the article.
  const TRACKING_RE = /^(?:utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|igshid)$/i;

  // Hosts where every subdomain is a separate site, and which the public suffix list does
  // not name. Unlike a public suffix, such a host is a site of its own as well.
  const MULTI_TENANT = new Set(['substack.com', 'medium.com', 'wordpress.com', 'tumblr.com', 'neocities.org', 'hashnode.dev']);

  // Never gated, so not worth a background fetch.
  const SKIP_CHECK = new Set([
    'github.com', 'gitlab.com', 'youtube.com', 'youtu.be', 'arxiv.org', 'wikipedia.org',
    'archive.org', 'news.ycombinator.com',
  ]);

  // Top-level names that are not part of the public web: reserved ones, and the ones home
  // and office networks use for their own machines.
  const PRIVATE_TLD = new Set([
    'localhost', 'local', 'lan', 'internal', 'intranet', 'private', 'corp', 'home', 'localdomain', 'localdomain6',
    'arpa', 'test', 'invalid', 'onion',
  ]);

  const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

  let seed;
  function seedSet() {
    return (seed ??= new Set(globalThis.HNPF_SEED || []));
  }

  // The public suffix list of psl.js, by kind of rule: a name, every name one level below
  // a name ("*.ck"), and the exceptions to those ("!www.ck").
  let suffixes;
  function suffixRules() {
    if (suffixes) return suffixes;
    suffixes = { plain: new Set(), wild: new Set(), except: new Set() };
    for (const rule of (globalThis.HNPF_PSL || '').split(/\s+/).filter(Boolean)) {
      if (rule.startsWith('!')) suffixes.except.add(rule.slice(1));
      else if (rule.startsWith('*.')) suffixes.wild.add(rule.slice(2));
      else suffixes.plain.add(rule);
    }
    return suffixes;
  }

  // A parsed URL's hostname without a leading "www." or the full stop that may end a name.
  function bareHost(u) {
    return u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  }

  // Hostname of an http(s) URL without a leading "www.", or null.
  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return bareHost(u);
    } catch {
      return null;
    }
  }

  // Whether a URL's hostname looks like a site on the public internet: no IP address, no
  // bare machine name and no name kept for private networks. The URL parser writes every
  // spelling of an IPv4 address as four numbers, and an IPv6 one in brackets. A public
  // name can still resolve to a private address, which no look at the name can tell.
  function isPublicHost(hostname) {
    const labels = String(hostname).toLowerCase().replace(/\.$/, '').split('.');
    const tld = labels.at(-1);
    return labels.length > 1 && labels.every(Boolean) && /^[a-z][a-z0-9-]*$/.test(tld) && !PRIVATE_TLD.has(tld);
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
  // `skip` names the suffixes to pass over as if they were absent.
  function findSuffix(host, table, skip) {
    const has = table instanceof Set ? (k) => table.has(k) : (k) => Object.hasOwn(table, k);
    for (let h = host; h && h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
      if (has(h) && !skip?.(h)) return h;
    }
    return null;
  }

  // The public suffix of a domain name: the part under which unrelated parties register
  // names of their own ("co.uk", "github.io"). The longest rule that fits decides, an
  // exception ahead of any other; a name no rule fits ends in a suffix of one label.
  function publicSuffix(domain) {
    const { plain, wild, except } = suffixRules();
    const labels = domain.split('.');
    for (let i = 0; i < labels.length; i++) {
      const name = labels.slice(i).join('.');
      const parent = labels.slice(i + 1).join('.');
      if (except.has(name)) return parent;
      if (plain.has(name) || (parent && wild.has(parent))) return name;
    }
    return labels.at(-1);
  }

  function isPublicSuffix(domain) {
    return publicSuffix(domain) === domain;
  }

  // The registrable domain of a host: its public suffix, or the host shared by many sites
  // that it sits on, and one more label. A host that has none is returned whole: an IP
  // address, a bare machine name, or a name that is itself a public suffix.
  function baseDomain(host) {
    const parts = host.split('.');
    if (parts.length < 2 || !parts.every(Boolean) || !/^[a-z][a-z0-9-]*$/.test(parts.at(-1))) return host;
    const shared = Math.max(publicSuffix(host).split('.').length, findSuffix(host, MULTI_TENANT)?.split('.').length ?? 0);
    return parts.slice(-(shared + 1)).join('.');
  }

  // Why a name cannot go on the site list, or '' when it can.
  function siteProblem(input) {
    const d = normalizeDomain(input);
    if (!d) return `"${String(input ?? '').trim()}" is not a site name`;
    return isPublicSuffix(d) ? `${d} is shared by many unrelated sites` : '';
  }

  // The domain a story is filed under. HN's own site label is preferred when it fits the
  // URL and names the registrable domain or a part of it, never a name above that.
  function siteFor(url, hint) {
    const host = hostOf(url);
    if (!host) return null;
    const base = baseDomain(host);
    const h = hint && normalizeDomain(hint);
    const within = (name, parent) => name === parent || name.endsWith('.' + parent);
    return h && within(host, h) && within(h, base) ? h : base;
  }

  // The site a story can be hidden with, or null when only the article itself can be: its
  // host cannot go on the site list, or its site is a platform that many authors share
  // (medium.com/@someone) and not one author's corner of it (someone.medium.com).
  function hideableSite(url, hint) {
    const site = siteFor(url, hint);
    if (!site || siteProblem(site)) return null;
    const platform = findSuffix(hostOf(url), MIXED);
    if (!platform) return site;
    return site.endsWith('.' + platform) && baseDomain(site) === site ? site : null;
  }

  // Host and path of a page, ignoring scheme, "www.", query and trailing slash.
  function pathKey(url) {
    try {
      const u = new URL(url);
      return bareHost(u) + u.pathname.replace(/\/+$/, '');
    } catch {
      return null;
    }
  }

  // Identifies one article: host, path and query, ignoring scheme, "www.", trailing slash,
  // tracking parameters and the order of the others ("story.php?id=1" names the article).
  function pageKey(url) {
    const path = pathKey(url);
    if (path === null) return null;
    const query = queryOf(url).join('&');
    return query ? `${path}?${query}` : path;
  }

  // The parameters of a valid URL that are not tracking ones, as sorted "name=value" strings.
  function queryOf(url) {
    return [...new URL(url).searchParams]
      .filter(([name]) => !TRACKING_RE.test(name))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .sort();
  }

  // Whether "hide this article" would do anything for a story classified as `c`: it is not
  // hidden yet, and its site is not set to always show, which would win over the article.
  function canHideArticle(c) {
    return !c.gated && (c.page || c.source !== 'allowed');
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

  // A verdict on one article lapses; the user's choice for it stays until it is removed.
  function pageExpired(entry, now) {
    return entry.source !== 'manual' && now - entry.at > TTL.page;
  }

  // Decides whether a link is gated. `source` says which list decided it:
  // 'manual' (the user's entry for a site or, with `page` set, one article) | 'visit' | 'check'
  // (a site the detectors hid), 'page' (one article they found gated), 'seed' (built-in), 'allowed'.
  function classify(url, state, now = Date.now()) {
    const host = hostOf(url);
    const out = { gated: false, source: null, reason: '', key: null, page: false, host };
    if (!host) return out;

    const pk = pageKey(url);
    const page = Object.hasOwn(state.pages, pk) && !pageExpired(state.pages[pk], now) ? state.pages[pk] : null;
    const shown = { ...out, source: 'allowed', key: pk, page: true };

    // The user's nearest entry decides before any a detector made, so that one on a
    // subdomain does not stand in front of the user's entry above it. An expired entry
    // decides nothing: the entry for the next shorter suffix is asked instead.
    const key =
      findSuffix(host, state.sites, (h) => state.sites[h].source !== 'manual') ??
      findSuffix(host, state.sites, (h) => siteExpired(state.sites[h], now));
    if (key) {
      const e = state.sites[key];
      if (e.status === 'allowed') return { ...out, source: 'allowed', key };
      // "Show this article" outranks a site the detectors hid, not one the user hid.
      if (page?.status === 'allowed' && e.source !== 'manual') return shown;
      return { ...out, gated: true, source: e.source, reason: e.reason || '', key };
    }

    if (page) {
      if (page.status === 'allowed') return shown;
      // An article the user hid counts as theirs, like a site they hid.
      const source = page.source === 'manual' ? 'manual' : 'page';
      return { ...out, gated: true, source, reason: page.reason || '', key: pk, page: true };
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
  // of their own to the address, so a tab still counts when it only gained some. A story
  // at the root of a site is the exception: there the query alone names the page.
  function storyFor(stories, url) {
    const key = pageKey(url);
    if (key === null) return null;
    if (Object.hasOwn(stories, key)) return stories[key];
    const path = pathKey(url);
    const params = queryOf(url);
    let best = null;
    let most = -1;
    for (const story of Object.values(stories)) {
      if (!story.url || pathKey(story.url) !== path) continue;
      const own = queryOf(story.url);
      if (!own.length && !path.includes('/')) continue;
      if (own.length > most && own.every((p) => params.includes(p))) [best, most] = [story, own.length];
    }
    return best;
  }

  // All writes go through the service worker so that they cannot overwrite each other.
  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  return {
    TTL, DEFAULT_SETTINGS, ALL_SITES, MIXED, SKIP_CHECK,
    seedSet, hostOf, isPublicHost, normalizeDomain, siteProblem, findSuffix, baseDomain, siteFor, hideableSite, canHideArticle, pathKey, pageKey, storyFor, isMixed, isPromoted, siteExpired, pageExpired,
    classify, sourceLabel, loadState, send,
  };
})();
