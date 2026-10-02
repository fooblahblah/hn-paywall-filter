// Service worker: owns every write to storage, runs the optional background check and
// starts on-visit detection on pages opened from Hacker News. What happens in an incognito
// window leaves no record, other than what the reader sets there by hand.
importScripts('seed.js', 'psl.js', 'shared.js', 'signals.js', 'analyze.js');

const MAX_STORIES = 400;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;
const MAX_URL = 4096;
const MAX_REASON = 200;
const MAX_COUNT = 999;
const NON_ARTICLE_RE = /\.(?:pdf|png|jpe?g|gif|webp|svg|mp4|webm|mp3|zip|gz|txt|json|xml)$/i;

// ---- storage -------------------------------------------------------------------------

// Runs read-modify-write updates one after another, whichever storage area they are on.
let chain = Promise.resolve();
function inTurn(fn) {
  const run = chain.then(fn);
  chain = run.catch((e) => console.error('hnpf: storage update failed', e));
  return run;
}

// `fn` edits the state in place and returns the keys to save, or nothing.
function mutate(fn) {
  return inTurn(async () => {
    const state = await HNPF.loadState();
    const patch = await fn(state);
    if (patch) await chrome.storage.local.set(patch);
  });
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

// Whether this page sits on a site known to carry both free and gated articles, in a
// personal "~user" corner of a shared host, or on a host that is no site at all (an IP
// address, a bare machine name), so that the site is never hidden as a whole.
function isMixedSite(url, site, host, state, now) {
  if (HNPF.isMixed(host) || new URL(url).pathname.startsWith('/~') || HNPF.siteProblem(site)) return true;
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
  for (const [k, e] of Object.entries(state.pages)) if (HNPF.pageExpired(e, now)) delete state.pages[k];
  for (const [k, e] of Object.entries(state.sites)) {
    if (HNPF.siteExpired(e, now)) delete state.sites[k];
  }
  return { sites: state.sites, pages: state.pages, checks: state.checks };
}

// ---- background check ----------------------------------------------------------------

const queue = [];
const queued = new Set();
let running = 0;
// Counts the times the reader had the detectors' records forgotten. A check or a report
// that was under way when that happened records nothing.
let forgotten = 0;

// Drops the checks that have not started yet.
function dropQueue() {
  for (const job of queue.splice(0)) queued.delete(job.key);
}

// Whether the background check may fetch this address. Anyone can submit a link, and the
// request leaves from inside the reader's network, where a plain GET can reach a router or
// a dev server. So only a public name is fetched, over https on its default port: a name
// someone pointed at a private address fails there, unless the machine behind it holds a
// certificate for that name.
function fetchable(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && HNPF.isPublicHost(u.hostname);
  } catch {
    return false;
  }
}

// The cache key to check this story under, or null when no check is needed.
function checkKeyFor({ url }, state, now) {
  const c = HNPF.classify(url, state, now);
  if (!c.host || c.gated || c.source === 'allowed') return null;
  if (!fetchable(url)) return null;
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
  const started = forgotten;
  const result = await fetchVerdict(url);
  await mutate((state) => {
    // Nor does one that ended after the check was switched off, or lost its access: by
    // then its request may have failed for that reason alone.
    if (started !== forgotten || !state.settings.bgCheck) return;
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
    // A chunk can be of any size, so the one that goes over the limit is cut to fit.
    const room = limit - size;
    if (value.length > room) {
      chunks.push(value.subarray(0, room));
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { html: await new Blob(chunks).text(), truncated };
}

// Fetches the page without cookies, so the verdict reflects what a signed-out reader gets.
// A redirect is not followed: where it leads cannot be seen before the request is made.
// Nor is an answer that came from another address judged, should one arrive all the same:
// it would be filed under the link as posted, and say nothing about the page behind it.
// Judging such a story means filing it under the address that answered (#20).
async function fetchVerdict(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    if (!fetchable(url)) throw new Error('not a public https address');
    const res = await fetch(url, {
      credentials: 'omit',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (res.type === 'opaqueredirect' || res.redirected) return { verdict: 'unknown', reason: 'could not be checked (redirects elsewhere)' };
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

// Every message is checked as if a stranger wrote it. The on-visit detector runs inside
// story pages, next to content nobody vouches for, and a page that breaks out of its
// sandbox can send whatever that script could. So what a message may do depends on where
// it comes from, which the browser reports and the message has no say in, and each
// handler takes only values of the kind it stores.

const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
const HN_ORIGIN = 'https://news.ycombinator.com';

// Where a message comes from: 'page' for the extension's own popup and options page, 'hn'
// for the script on a Hacker News page, 'tab' for anything else shown in a tab, or null.
// The origin decides, and a sender without one is nobody: an address says less (a
// sandboxed frame keeps its address and loses its origin). The frame is not asked for: a
// page the browser loads ahead of a visit is no frame, and is numbered like one.
function senderKind(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  if (sender.origin === OWN_ORIGIN) return 'page';
  if (!sender.tab || typeof sender.origin !== 'string') return null;
  return sender.origin === HN_ORIGIN ? 'hn' : 'tab';
}

// Who may send each kind of message: the pages that do, and no others.
const SENDERS = {
  setSite: ['page', 'hn'],
  setPage: ['page', 'hn'],
  setSettings: ['page'],
  forgetDetected: ['page'],
  seenSites: ['hn'],
  stories: ['hn'],
  hiddenCount: ['hn'],
  openOptions: ['hn'],
  visitVerdict: ['tab'],
};

// Each setting and the values it can have.
const SETTINGS = { visitDetect: [true, false], bgCheck: [true, false], display: ['hide', 'label'] };

function fits(from, name) {
  return Object.hasOwn(from, name) && SETTINGS[name].includes(from[name]);
}

// The known settings and nothing else, each as the patch has it, or else as stored.
function settingsWith(settings, patch) {
  const next = {};
  for (const name of Object.keys(SETTINGS)) {
    next[name] = fits(patch, name) ? patch[name] : fits(settings, name) ? settings[name] : HNPF.DEFAULT_SETTINGS[name];
  }
  return next;
}

function checkStatus(status) {
  if (status !== 'gated' && status !== 'allowed' && status !== null) throw new Error('not a status');
}

function checkNames(domains) {
  if (!Array.isArray(domains) || !domains.every((d) => typeof d === 'string')) throw new Error('not a list of site names');
}

// Whether a string is what HNPF.pageKey makes of some address. That drops one "www.", so
// the key of a page on "www.www.example.com" still starts with one, and it writes a
// character of the query as up to three. "__proto__" names no entry of a table.
function isPageKey(key) {
  if (typeof key !== 'string' || !key || key === '__proto__' || key.length > 3 * MAX_URL) return false;
  return ['', 'www.'].some((www) => HNPF.pageKey(`https://${www}${key}`) === key && HNPF.hostOf(`https://${www}${key}`));
}

// The stories of a listing that have a web address, each filed under a site that fits it.
function cleanStories(items) {
  if (!Array.isArray(items)) throw new Error('not a list of stories');
  const list = [];
  for (const s of items.slice(0, MAX_STORIES)) {
    const url = s?.url;
    if (typeof url !== 'string' || url.length > MAX_URL || !HNPF.hostOf(url) || !isPageKey(HNPF.pageKey(url))) continue;
    list.push({ url, site: HNPF.siteFor(url, typeof s.site === 'string' ? s.site : null) });
  }
  return list;
}

async function onStories(items, sender) {
  const now = Date.now();
  const list = cleanStories(items);
  // A listing read in an incognito window is neither remembered nor checked: the verdicts
  // would tell which stories were on it, and when.
  if (sender.tab?.incognito) return;

  const started = forgotten;
  // In turn, or two listings loading side by side would each write back the stories they
  // read, without the other's.
  await inTurn(async () => {
    const stories = await loadStories();
    if (started !== forgotten) return;
    for (const s of list) stories[HNPF.pageKey(s.url)] = { site: s.site, url: s.url, at: now };
    const keys = Object.keys(stories);
    if (keys.length > MAX_STORIES) {
      keys.sort((a, b) => stories[a].at - stories[b].at);
      for (const k of keys.slice(0, keys.length - MAX_STORIES)) delete stories[k];
    }
    await chrome.storage.session.set({ stories });
  });

  const state = await HNPF.loadState();
  if (!state.settings.bgCheck || !(await chrome.permissions.contains(HNPF.ALL_SITES))) return;
  if (started !== forgotten) return;
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
  // The detector runs in the page itself, never in a frame, and says one of two things.
  if (sender.frameId || (verdict !== 'gated' && verdict !== 'free')) return;
  // It is not started in an incognito window, where a visit must leave nothing on disk.
  if (sender.tab?.incognito) return;
  reason = typeof reason === 'string' ? reason.slice(0, MAX_REASON) : '';
  platform = platform === true;
  const tabUrl = sender.tab?.url || sender.url;
  if (typeof page !== 'string' || !HNPF.hostOf(page) || !HNPF.hostOf(tabUrl) || HNPF.pageKey(page) !== HNPF.pageKey(tabUrl)) return;
  const started = forgotten;
  const story = HNPF.storyFor(await loadStories(), page);
  if (!story) return;
  // File the verdict under the link as posted, which is what the listing will show again.
  const url = story.url || page;
  const site = HNPF.siteFor(url, story.site);
  let recorded = false;
  await mutate((state) => {
    // A report counts only where detection would have been started.
    if (!state.settings.visitDetect || HNPF.findSuffix(HNPF.hostOf(url), HNPF.SKIP_CHECK)) return;
    if (started !== forgotten) return;
    recorded = recordVerdict(state, { url, site, verdict, reason, platform, source: 'visit' });
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
// always shown. Tab URLs are only visible while access to all sites is held, which is
// while a detector is on.
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
  // status: 'gated' | 'allowed', or null to drop the user's entry. A name that cannot go
  // on the list fails the whole request, with the reason. One that is on it already (older
  // versions took any) can still be changed and removed.
  async setSite({ domains, status }) {
    checkNames(domains);
    checkStatus(status);
    let problem = '';
    await mutate(({ sites, pages }) => {
      const names = [];
      for (const raw of domains) {
        // An entry kept under a name that is written otherwise now is removed by that name.
        const d = !status && Object.hasOwn(sites, raw) ? raw : HNPF.normalizeDomain(raw) ?? raw;
        if (Object.hasOwn(sites, d)) names.push(d);
        else if (!status) continue;
        else if ((problem = HNPF.siteProblem(raw))) return;
        else names.push(d);
      }
      for (const d of names) {
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
    if (problem) throw new Error(problem);
  },
  // The user has read the notice that the detectors hid these sites.
  seenSites({ domains }) {
    checkNames(domains);
    return mutate(({ sites }) => {
      for (const d of domains) if (Object.hasOwn(sites, d) && HNPF.isPromoted(sites[d])) sites[d].seen = true;
      return { sites };
    });
  },
  // An article that is on the list already (older versions took any key) can still be
  // changed and removed.
  async setPage({ key, status }) {
    checkStatus(status);
    let known = true;
    await mutate(({ pages }) => {
      known = (typeof key === 'string' && Object.hasOwn(pages, key)) || isPageKey(key);
      if (!known) return;
      if (status) pages[key] = { status, source: 'manual', at: Date.now() };
      else delete pages[key];
      return { pages };
    });
    if (!known) throw new Error('not an article');
  },
  // Stores the known settings and nothing else, so that what an older version let in goes.
  async setSettings({ patch }) {
    const plain = !!patch && typeof patch === 'object' && !Array.isArray(patch);
    if (!plain || !Object.keys(patch).every((name) => Object.hasOwn(SETTINGS, name) && fits(patch, name))) throw new Error('not a setting');
    await mutate(({ settings }) => ({ settings: settingsWith(settings, patch) }));
    await syncAccess();
  },
  // Forgets all the detectors recorded: the articles and sites they hid, the pages they
  // found free and the stories seen on listings. The user's own entries stay.
  async forgetDetected() {
    forgotten++;
    dropQueue();
    await chrome.storage.session.set({ stories: {} });
    await mutate(({ sites, pages }) => {
      for (const table of [sites, pages]) {
        for (const [k, e] of Object.entries(table)) if (e.source !== 'manual') delete table[k];
      }
      return { sites, pages, checks: {} };
    });
  },
  stories: ({ items }, sender) => onStories(items, sender),
  visitVerdict: onVisitVerdict,
  openOptions: () => chrome.runtime.openOptionsPage(),
  // From an HN listing: how many stories it is hiding. Not from one loaded ahead of the
  // visit, whose tab still shows another page; it says so again once the reader is there.
  hiddenCount({ count }, sender) {
    if (!sender.tab || sender.frameId || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) return;
    const title = `${count} gated ${count === 1 ? 'story' : 'stories'} on this page`;
    setBadge(sender.tab.id, count ? String(count) : '', BADGE_COUNT, count ? title : '');
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (typeof type !== 'string' || !Object.hasOwn(handlers, type)) return;
  if (!SENDERS[type]?.includes(senderKind(sender))) {
    sendResponse({ ok: false, error: 'not allowed from this page' });
    return;
  }
  new Promise((resolve) => resolve(handlers[type](message, sender))).then(
    () => sendResponse({ ok: true }),
    // A refusal quotes the name it is about, which may be of any length.
    (e) => sendResponse({ ok: false, error: String(e?.message || e).slice(0, MAX_REASON) }),
  );
  return true;
});

// ---- on-visit detection --------------------------------------------------------------

// Looks at a freshly loaded tab if it is a story from an HN listing we have not judged yet.
// tab.url is only visible while access to all sites is held.
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
  if (info.status === 'complete' && !tab.incognito) maybeDetect(tabId, tab.url).catch(() => {});
});

// ---- access to all sites -------------------------------------------------------------

// Only the detectors need access to all sites; the badge on article tabs merely uses it
// while it is there. So the access is held exactly while a detector is on. It is given
// back when the last one is switched off. And when it is taken away (on chrome://extensions,
// say), both are switched off: a setting left on would bring its detector back, unasked,
// the day the access is granted again for the other.
// All of it happens in one storage update, so that no change of settings falls between
// looking and acting.
function syncAccess() {
  return mutate(async ({ settings }) => {
    const granted = await chrome.permissions.contains(HNPF.ALL_SITES);
    const wanted = settings.visitDetect === true || settings.bgCheck === true;
    // Checks still waiting would fail without the access, and be filed as failed.
    if (!granted || settings.bgCheck !== true) dropQueue();
    if (granted && !wanted) {
      await clearPageBadges();
      await chrome.permissions.remove(HNPF.ALL_SITES);
    }
    if (granted || !wanted) return;
    return { settings: settingsWith(settings, { visitDetect: false, bgCheck: false }) };
  });
}

// Takes the marks off the article tabs while their addresses can still be seen: once the
// access is gone they could not be kept up to date. The count on a listing stays.
async function clearPageBadges() {
  for (const tab of await chrome.tabs.query({})) {
    const host = HNPF.hostOf(tab.url || '');
    if (host && host !== 'news.ycombinator.com') setBadge(tab.id, '', null, '');
  }
}

function keepAccessInStep() {
  return syncAccess().catch((e) => console.error('hnpf: access to all sites not put in step', e));
}

chrome.permissions.onRemoved.addListener(keepAccessInStep);

// ---- lifecycle -----------------------------------------------------------------------

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

// Up to 0.1.5 the background check followed redirects and filed what it found under the
// link as posted, so a short link could stand for the page it led to. Which verdicts were
// reached that way is not recorded: forget all the check found (those articles are simply
// checked again) and the sites hidden for such articles.
function dropRedirectedVerdicts(state) {
  for (const [k, e] of Object.entries(state.pages)) {
    if (e.source === 'check') delete state.pages[k];
  }
  for (const [k, e] of Object.entries(state.checks)) {
    if (k.startsWith('p:') && e.source === 'check') delete state.checks[k];
  }
  for (const [k, e] of Object.entries(state.sites)) {
    if (HNPF.isPromoted(e)) delete state.sites[k];
  }
}

// Up to 0.1.9 the site of a story was guessed from a short list of suffixes, so stories
// from unrelated sites (apps on herokuapp.com, ministries under go.jp) were filed under the
// name they share, and ones on an IP address under its last two numbers. File what the
// detectors found under the site as it is worked out now, and forget the sites they hid
// under such a name. The user's own entries stay, whatever they name.
function refileSites(state) {
  const misfiled = new Set();
  for (const [table, prefix] of [[state.pages, ''], [state.checks, 'p:']]) {
    for (const [k, e] of Object.entries(table)) {
      if (!e.site || !k.startsWith(prefix)) continue;
      const site = HNPF.siteFor('https://' + k.slice(prefix.length), e.site);
      if (site === e.site && !HNPF.siteProblem(site)) continue;
      misfiled.add(e.site);
      if (site && !HNPF.siteProblem(site)) e.site = site;
      else delete e.site;
    }
  }
  for (const [k, e] of Object.entries(state.sites)) {
    if (e.source !== 'manual' && (misfiled.has(k) || HNPF.siteProblem(k))) delete state.sites[k];
  }
  for (const k of Object.keys(state.checks)) {
    if (k.startsWith('d:') && (misfiled.has(k.slice(2)) || HNPF.siteProblem(k.slice(2)))) delete state.checks[k];
  }
}

// Up to 0.1.10 a visit took any Piano modal for a wall, including a donation appeal or a
// newsletter offer the reader can close, over an article that is there in full. Forget
// the articles a visit found gated that way (they are looked at again on the next visit)
// and the sites that were hidden with such an article among those counted.
function dropPianoVerdicts(state) {
  const sites = new Set();
  for (const [k, e] of Object.entries(state.pages)) {
    if (e.reason !== 'subscription overlay blocks the page') continue;
    sites.add(e.site);
    delete state.pages[k];
  }
  for (const [k, e] of Object.entries(state.sites)) {
    if (HNPF.isPromoted(e) && sites.has(k)) delete state.sites[k];
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
    // Each of these cleans up after the versions before the one named, so it runs on the
    // update from one of those and never again. 0.1.2 is the first version published.
    const before = (version) => reason === 'update' && previousVersion && olderThan(previousVersion, version);
    if (before('0.1.3')) dropSinglePageVerdicts(state);
    if (before('0.1.4')) dropWordingVerdicts(state);
    if (before('0.1.5')) dropLooseVisitVerdicts(state);
    // 0.1.6 stopped following redirects but kept what had been filed until then.
    if (before('0.1.8')) dropRedirectedVerdicts(state);
    if (before('0.1.10')) refileSites(state);
    if (before('0.1.11')) dropPianoVerdicts(state);
    return pruneExpired(state);
  });
  // Up to 0.1.12 the access stayed when the detectors were switched off, and the settings
  // stayed on when it was taken away. It was also asked for as "<all_urls>": if Chromium
  // does not keep it for the narrower request, the detectors are off until asked for again.
  return keepAccessInStep();
});

chrome.runtime.onStartup.addListener(() => {
  mutate(pruneExpired);
  return keepAccessInStep();
});
