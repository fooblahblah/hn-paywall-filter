// Service worker: owns every write to storage, runs the optional background check and
// starts on-visit detection on pages opened from Hacker News.
importScripts('seed.js', 'shared.js', 'signals.js', 'analyze.js');

const ALL_SITES = { origins: ['<all_urls>'] };
const MAX_STORIES = 400;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;
const NON_ARTICLE_RE = /\.(?:pdf|png|jpe?g|gif|webp|svg|mp4|webm|mp3|zip|gz|txt|json|xml)$/i;

// ---- storage -------------------------------------------------------------------------

// Runs read-modify-write updates one after another. `fn` edits the state in place and
// returns the keys to save, or nothing.
let chain = Promise.resolve();
function mutate(fn) {
  const run = chain.then(async () => {
    const state = await HNPF.loadState();
    const patch = await fn(state);
    if (patch) await chrome.storage.local.set(patch);
  });
  chain = run.catch((e) => console.error('hnpf: storage update failed', e));
  return run;
}

// Stories recently listed on HN, keyed by page, so a visited tab can be recognised.
async function loadStories() {
  return (await chrome.storage.session.get('stories')).stories || {};
}

function isFresh(entry, now) {
  return !!entry && now - entry.at < (HNPF.TTL[entry.verdict] ?? 0);
}

// Whether verdicts for this site apply per article rather than to the whole domain.
function isPerPage(site, host, state, now) {
  if (HNPF.isMixed(host)) return true;
  const known = state.checks['d:' + site];
  return known?.verdict === 'mixed' && isFresh(known, now);
}

// Stores the outcome of looking at one page. Never overrides the user's own entries.
function recordVerdict(state, { url, site, verdict, reason, platform, source }) {
  const now = Date.now();
  const current = HNPF.classify(url, state, now);
  if (!current.host || current.gated || current.source === 'allowed') return false;

  let perPage = isPerPage(site, current.host, state, now);
  if (platform && !perPage) {
    state.checks['d:' + site] = { verdict: 'mixed', at: now };
    perPage = true;
  }
  const pk = HNPF.pageKey(url);
  if (verdict !== 'gated') {
    state.checks[perPage ? 'p:' + pk : 'd:' + site] = { verdict, reason, at: now };
  } else if (perPage) {
    state.pages[pk] = { status: 'gated', source, reason, at: now };
  } else {
    state.sites[site] = { status: 'gated', source, reason, at: now };
  }
  return true;
}

function pruneExpired(state) {
  const now = Date.now();
  for (const [k, e] of Object.entries(state.checks)) if (!isFresh(e, now)) delete state.checks[k];
  for (const [k, e] of Object.entries(state.pages)) if (now - e.at > HNPF.TTL.page) delete state.pages[k];
  for (const [k, e] of Object.entries(state.sites)) {
    if (e.source === 'check' && now - e.at > HNPF.TTL.check) delete state.sites[k];
  }
  return { sites: state.sites, pages: state.pages, checks: state.checks };
}

// ---- background check ----------------------------------------------------------------

const queue = [];
const queued = new Set();
let running = 0;

// The cache key to check this story under, or null when no check is needed.
function checkKeyFor({ url, site }, state, now) {
  const c = HNPF.classify(url, state, now);
  if (!c.host || c.gated || c.source === 'allowed') return null;
  if (HNPF.findSuffix(c.host, HNPF.SKIP_CHECK)) return null;
  if (NON_ARTICLE_RE.test(new URL(url).pathname)) return null;
  const key = isPerPage(site, c.host, state, now) ? 'p:' + HNPF.pageKey(url) : 'd:' + site;
  return isFresh(state.checks[key], now) ? null : key;
}

function enqueue(key, story) {
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ key, ...story });
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    check(job).finally(() => {
      running--;
      queued.delete(job.key);
      pump();
    });
  }
}

async function check({ url, site }) {
  const result = await fetchVerdict(url);
  await mutate((state) => {
    recordVerdict(state, { url, site, source: 'check', ...result });
    return { sites: state.sites, pages: state.pages, checks: state.checks };
  });
}

async function readText(res, limit) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) {
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
  }
  return { html: await new Blob(chunks).text(), truncated };
}

// Fetches the page without cookies, so the verdict reflects what a signed-out reader gets.
async function fetchVerdict(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (res.status === 402) return { verdict: 'gated', reason: 'the site answered "payment required"' };
    if (!res.ok) return { verdict: 'unknown', reason: `could not be checked (HTTP ${res.status})` };
    if (!/html/i.test(res.headers.get('content-type') || '')) return { verdict: 'free', reason: 'not a web page' };
    const { html, truncated } = await readText(res, MAX_BYTES);
    return HNPF_ANALYZE.analyzeHtml(html, { truncated });
  } catch {
    return { verdict: 'unknown', reason: 'could not be fetched' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- messages ------------------------------------------------------------------------

function cleanStory({ url, site }) {
  return { url, site: HNPF.normalizeDomain(site) || HNPF.siteFor(url) };
}

async function onStories(items) {
  const now = Date.now();
  const list = items.filter((s) => HNPF.hostOf(s.url)).map(cleanStory);

  const stories = await loadStories();
  for (const s of list) stories[HNPF.pageKey(s.url)] = { site: s.site, at: now };
  const keys = Object.keys(stories);
  if (keys.length > MAX_STORIES) {
    keys.sort((a, b) => stories[a].at - stories[b].at);
    for (const k of keys.slice(0, keys.length - MAX_STORIES)) delete stories[k];
  }
  await chrome.storage.session.set({ stories });

  const state = await HNPF.loadState();
  if (!state.settings.bgCheck || !(await chrome.permissions.contains(ALL_SITES))) return;
  for (const s of list) {
    const key = checkKeyFor(s, state, now);
    if (key) enqueue(key, s);
  }
}

async function onVisitVerdict({ reason, platform }, sender) {
  const url = sender.tab?.url || sender.url;
  if (!HNPF.hostOf(url)) return;
  const story = (await loadStories())[HNPF.pageKey(url)];
  const site = HNPF.siteFor(url, story?.site);
  let recorded = false;
  await mutate((state) => {
    recorded = recordVerdict(state, { url, site, verdict: 'gated', reason, platform, source: 'visit' });
    return recorded && { sites: state.sites, pages: state.pages, checks: state.checks };
  });
}

// ---- toolbar badge -------------------------------------------------------------------

const BADGE_GATED = '#b91c1c';
const BADGE_ALLOWED = '#15803d';
const BADGE_COUNT = '#c2410c';

function setBadge(tabId, text, color, title) {
  // The tab may be gone by the time this runs.
  const quiet = () => {};
  chrome.action.setBadgeText({ tabId, text }).catch(quiet);
  chrome.action.setTitle({ tabId, title: title ? `HN Paywall Filter: ${title}` : 'HN Paywall Filter' }).catch(quiet);
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(quiet);
    chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(quiet);
  }
}

// Marks the icon on an article tab: "!" if its site is hidden on HN, a check mark if it is
// always shown. Tab URLs are only visible once access to all sites has been granted.
function badgeForPage(tabId, url, state) {
  const host = HNPF.hostOf(url);
  if (!host || host === 'news.ycombinator.com') return;
  const c = HNPF.classify(url, state);
  if (c.gated) setBadge(tabId, '!', BADGE_GATED, `hidden on Hacker News (${HNPF.sourceLabel(c.source)})`);
  else if (c.source === 'allowed') setBadge(tabId, '✓', BADGE_ALLOWED, 'always shown on Hacker News');
  else setBadge(tabId, '', null, '');
}

async function refreshBadges() {
  const [state, tabs] = await Promise.all([HNPF.loadState(), chrome.tabs.query({})]);
  for (const tab of tabs) if (tab.url) badgeForPage(tab.id, tab.url, state);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.sites || changes.pages)) refreshBadges().catch(() => {});
});

const handlers = {
  // status: 'gated' | 'allowed', or null to drop the user's entry.
  setSite({ domains, status }) {
    return mutate(({ sites }) => {
      for (const raw of domains) {
        const d = HNPF.normalizeDomain(raw);
        if (!d) continue;
        if (status) sites[d] = { status, source: 'manual', at: Date.now() };
        else delete sites[d];
      }
      return { sites };
    });
  },
  setPage({ key, status }) {
    return mutate(({ pages }) => {
      if (status) pages[key] = { status, source: 'manual', at: Date.now() };
      else delete pages[key];
      return { pages };
    });
  },
  setSettings({ patch }) {
    return mutate(({ settings }) => ({ settings: { ...settings, ...patch } }));
  },
  stories: ({ items }) => onStories(items),
  visitVerdict: onVisitVerdict,
  openOptions: () => chrome.runtime.openOptionsPage(),
  // From an HN listing: how many stories it is hiding.
  hiddenCount({ count }, sender) {
    if (!sender.tab) return;
    const title = `${count} gated ${count === 1 ? 'story' : 'stories'} on this page`;
    setBadge(sender.tab.id, count ? String(count) : '', BADGE_COUNT, count ? title : '');
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return;
  Promise.resolve(handler(message, sender)).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true;
});

// ---- on-visit detection --------------------------------------------------------------

// Looks at a freshly loaded tab if it is a story from an HN listing we have not judged yet.
// tab.url is only visible once the user has granted access to all sites.
async function maybeDetect(tabId, url) {
  if (!HNPF.hostOf(url)) return;
  if (!(await loadStories())[HNPF.pageKey(url)]) return;
  const state = await HNPF.loadState();
  if (!state.settings.visitDetect) return;
  const c = HNPF.classify(url, state);
  if (c.gated || c.source === 'allowed' || HNPF.findSuffix(c.host, HNPF.SKIP_CHECK)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/signals.js', 'src/detect.js'] });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.status || !tab.url) return;
  // Navigation clears the badge, so set it again as soon as the page starts loading.
  HNPF.loadState().then((state) => badgeForPage(tabId, tab.url, state)).catch(() => {});
  if (info.status === 'complete') maybeDetect(tabId, tab.url).catch(() => {});
});

// ---- lifecycle -----------------------------------------------------------------------

// 0.1.0 treated paywall metadata alone as proof, which flagged metered sites that still
// show the article. Forget the verdicts it reached that way.
function dropMetadataVerdicts(state) {
  for (const table of [state.sites, state.pages]) {
    for (const [k, e] of Object.entries(table)) {
      if (e.source !== 'manual' && /^page metadata (?:says|marks it "metered")/.test(e.reason || '')) delete table[k];
    }
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  mutate((state) => {
    dropMetadataVerdicts(state);
    return pruneExpired(state);
  });
});

chrome.runtime.onStartup.addListener(() => mutate(pruneExpired));
