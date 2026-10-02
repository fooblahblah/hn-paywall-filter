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

// How many distinct articles on a site must look gated before the whole site is hidden.
const PROMOTE_AFTER = 3;

// Whether this page sits on a site known to carry both free and gated articles, or in a
// personal "~user" corner of a shared host, so that the site is never hidden as a whole.
function isMixedSite(url, site, host, state, now) {
  if (HNPF.isMixed(host) || new URL(url).pathname.startsWith('/~')) return true;
  const known = state.checks['d:' + site];
  return known?.verdict === 'mixed' && isFresh(known, now);
}

// What the articles judged lately say about a site: how many looked gated, and whether any
// looked free or was set to be shown by the user. Both kinds count for as long as a free
// verdict is trusted, so that the two are weighed over the same period.
function siteEvidence(state, site, now) {
  const recent = (e) => now - e.at <= HNPF.TTL.free;
  // Counted by path: one page posted under several query strings is still one article.
  const gated = new Set();
  let free = Object.values(state.checks).some((e) => e.site === site && e.verdict === 'free' && recent(e));
  for (const [k, e] of Object.entries(state.pages)) {
    if (!recent(e)) continue;
    if (e.status !== 'gated') free ||= HNPF.siteFor('https://' + k, site) === site;
    else if (e.site === site && e.source !== 'manual') gated.add(k.split('?')[0]);
  }
  return { gated: gated.size, free };
}

// Stores the outcome of looking at one page. Never overrides the user's own entries.
// A verdict is filed under its article: one page says too little about the rest of its
// site, least of all on a host shared by many authors. The site is hidden only once
// several of its articles looked gated and none looked free. `article: false` marks a
// response that was no article at all, which says nothing about its site either way.
function recordVerdict(state, { url, site, verdict, reason, platform, source, article = true }) {
  const now = Date.now();
  let current = HNPF.classify(url, state, now);
  // A free article on a site that was hidden on the strength of a few gated ones (checks
  // running side by side finish in any order) takes that verdict back.
  if (verdict === 'free' && article && current.gated && !current.page && HNPF.isPromoted(state.sites[current.key] ?? {})) {
    delete state.sites[current.key];
    current = HNPF.classify(url, state, now);
  }
  if (!current.host || current.gated || current.source === 'allowed') return false;

  let mixed = isMixedSite(url, site, current.host, state, now);
  if (platform && !mixed) {
    state.checks['d:' + site] = { verdict: 'mixed', at: now };
    mixed = true;
  }
  const pk = HNPF.pageKey(url);
  if (verdict !== 'gated') {
    state.checks['p:' + pk] = { verdict, reason, source, ...(article && { site }), at: now };
    return true;
  }
  // Articles on a mixed site carry no site, so they never add up to hiding it.
  state.pages[pk] = { status: 'gated', source, reason, ...(!mixed && { site }), at: now };
  delete state.checks['p:' + pk];
  if (mixed || state.sites[site]?.source === 'manual') return true;

  const { gated, free } = siteEvidence(state, site, now);
  if (gated >= PROMOTE_AFTER && !free) {
    const why = `${gated} articles on this site looked gated`;
    state.sites[site] = { status: 'gated', source, reason: why, articles: gated, at: now };
  }
  return true;
}

function pruneExpired(state) {
  const now = Date.now();
  for (const [k, e] of Object.entries(state.checks)) if (!isFresh(e, now)) delete state.checks[k];
  for (const [k, e] of Object.entries(state.pages)) if (now - e.at > HNPF.TTL.page) delete state.pages[k];
  for (const [k, e] of Object.entries(state.sites)) {
    if (HNPF.siteExpired(e, now)) delete state.sites[k];
  }
  return { sites: state.sites, pages: state.pages, checks: state.checks };
}

// ---- background check ----------------------------------------------------------------

const queue = [];
const queued = new Set();
let running = 0;

// The cache key to check this story under, or null when no check is needed.
function checkKeyFor({ url }, state, now) {
  const c = HNPF.classify(url, state, now);
  if (!c.host || c.gated || c.source === 'allowed') return null;
  if (HNPF.findSuffix(c.host, HNPF.SKIP_CHECK)) return null;
  if (NON_ARTICLE_RE.test(new URL(url).pathname)) return null;
  const key = 'p:' + HNPF.pageKey(url);
  // A visit that saw no wall may have ended before one appeared, so it does not stand in
  // for the check.
  const known = state.checks[key];
  return isFresh(known, now) && known.source !== 'visit' ? null : key;
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
    if (!/html/i.test(res.headers.get('content-type') || '')) return { verdict: 'free', reason: 'not a web page', article: false };
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
  return { url, site: HNPF.siteFor(url, site) };
}

async function onStories(items) {
  const now = Date.now();
  const list = items.filter((s) => HNPF.hostOf(s.url)).map(cleanStory);

  const stories = await loadStories();
  for (const s of list) stories[HNPF.pageKey(s.url)] = { site: s.site, url: s.url, at: now };
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

// `page` is the address detection was started on. The verdict only counts while the tab
// still shows that page, and only for a story from a listing, which is all detection is
// started for: a site that routes in the page may have moved on to its pricing or sign-in
// page since, and what is found there says nothing about the story.
async function onVisitVerdict({ url: page, verdict, reason, platform }, sender) {
  const tabUrl = sender.tab?.url || sender.url;
  if (!HNPF.hostOf(page) || !HNPF.hostOf(tabUrl) || HNPF.pageKey(page) !== HNPF.pageKey(tabUrl)) return;
  const story = HNPF.storyFor(await loadStories(), page);
  if (!story) return;
  // File the verdict under the link as posted, which is what the listing will show again.
  const url = story.url || page;
  const site = HNPF.siteFor(url, story.site);
  let recorded = false;
  await mutate((state) => {
    const seen = verdict === 'free' ? 'free' : 'gated';
    recorded = recordVerdict(state, { url, site, verdict: seen, reason, platform, source: 'visit' });
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
// A story tab is judged by the link as posted, which is what its verdicts are filed under.
function badgeForPage(tabId, url, state, stories) {
  const host = HNPF.hostOf(url);
  if (!host || host === 'news.ycombinator.com') return;
  const c = HNPF.classify(HNPF.storyFor(stories, url)?.url || url, state);
  if (c.gated) setBadge(tabId, '!', BADGE_GATED, `hidden on Hacker News (${HNPF.sourceLabel(c.source)})`);
  else if (c.source === 'allowed') setBadge(tabId, '✓', BADGE_ALLOWED, 'always shown on Hacker News');
  else setBadge(tabId, '', null, '');
}

async function refreshBadges() {
  const [state, stories, tabs] = await Promise.all([HNPF.loadState(), loadStories(), chrome.tabs.query({})]);
  for (const tab of tabs) if (tab.url) badgeForPage(tab.id, tab.url, state, stories);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.sites || changes.pages)) refreshBadges().catch(() => {});
});

const handlers = {
  // status: 'gated' | 'allowed', or null to drop the user's entry.
  setSite({ domains, status }) {
    return mutate(({ sites, pages }) => {
      for (const raw of domains) {
        const d = HNPF.normalizeDomain(raw);
        if (!d) continue;
        // Overruling a site the detectors hid also forgets the articles it rested on, or
        // the next gated one would hide it again as soon as the user's entry is gone.
        if (sites[d] && HNPF.isPromoted(sites[d])) {
          for (const [k, e] of Object.entries(pages)) if (e.site === d && e.source !== 'manual') delete pages[k];
        }
        if (status) sites[d] = { status, source: 'manual', at: Date.now() };
        else delete sites[d];
      }
      return { sites, pages };
    });
  },
  // The user has read the notice that the detectors hid these sites.
  seenSites({ domains }) {
    return mutate(({ sites }) => {
      for (const d of domains) if (Object.hasOwn(sites, d) && HNPF.isPromoted(sites[d])) sites[d].seen = true;
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
  const story = HNPF.storyFor(await loadStories(), url);
  if (!story) return;
  const state = await HNPF.loadState();
  if (!state.settings.visitDetect) return;
  const c = HNPF.classify(story.url || url, state);
  if (c.gated || c.source === 'allowed' || HNPF.findSuffix(c.host, HNPF.SKIP_CHECK)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/shared.js', 'src/signals.js', 'src/detect.js'] });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.status || !tab.url) return;
  // Navigation clears the badge, so set it again as soon as the page starts loading.
  Promise.all([HNPF.loadState(), loadStories()])
    .then(([state, stories]) => badgeForPage(tabId, tab.url, state, stories))
    .catch(() => {});
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

// Up to 0.1.2 one page decided for its whole site. Forget the site verdicts reached that
// way, in either direction; the ones recorded since say how many articles they rest on.
function dropSinglePageVerdicts(state) {
  for (const [k, e] of Object.entries(state.sites)) {
    if (e.source !== 'manual' && !e.articles) delete state.sites[k];
  }
  for (const [k, e] of Object.entries(state.checks)) {
    if (k.startsWith('d:') && e.verdict !== 'mixed') delete state.checks[k];
  }
}

// Up to 0.1.3 gate wording matched ordinary prose, long pages not written in closed <p>
// counted as cut short, and one embedded Substack image made a site a platform. Forget
// what rests on a prompt (those articles are simply checked again), the sites hidden for
// such articles, and the platform marks.
function dropWordingVerdicts(state) {
  for (const [k, e] of Object.entries(state.pages)) {
    if (e.source !== 'manual' && /\b(?:prompt|overlay on page)\b/.test(e.reason || '')) delete state.pages[k];
  }
  for (const [k, e] of Object.entries(state.sites)) {
    if (HNPF.isPromoted(e)) delete state.sites[k];
  }
  for (const [k, e] of Object.entries(state.checks)) {
    if (k.startsWith('d:') && e.verdict === 'mixed') delete state.checks[k];
  }
}

// Up to 0.1.4 a visit counted gate wording found loose on a page that showed the whole
// article, and could judge a page the tab had moved on to. Forget the articles a visit
// found gated by a prompt (they are looked at again on the next visit) and the sites
// hidden for such articles.
function dropLooseVisitVerdicts(state) {
  for (const [k, e] of Object.entries(state.pages)) {
    if (e.source === 'visit' && /^(?:prompt|overlay) on page\b/.test(e.reason || '')) delete state.pages[k];
  }
  for (const [k, e] of Object.entries(state.sites)) {
    if (HNPF.isPromoted(e)) delete state.sites[k];
  }
}

function olderThan(version, than) {
  const [a, b] = [version, than].map((v) => String(v).split('.').map(Number));
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
}

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  mutate((state) => {
    dropMetadataVerdicts(state);
    dropSinglePageVerdicts(state);
    const before = (version) => reason === 'update' && previousVersion && olderThan(previousVersion, version);
    if (before('0.1.4')) dropWordingVerdicts(state);
    if (before('0.1.5')) dropLooseVisitVerdicts(state);
    return pruneExpired(state);
  });
});

chrome.runtime.onStartup.addListener(() => mutate(pruneExpired));
