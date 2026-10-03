// Toolbar popup: shows how the current tab's site is treated and lets you change it.
const $ = (id) => document.getElementById(id);

let tabUrl = null;
// The link as posted on Hacker News when the tab is a story from a listing, else the tab's.
let articleUrl = null;
// The site the tab's page is filed under, which the field starts out with.
let tabSite = null;

// A button that sends a request to the service worker, and shows the reason if it is refused.
function button(label, request) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', async () => {
    const res = await request();
    if (res?.ok !== false) return;
    $('status').textContent = `Not changed: ${res.error}.`;
    $('status').classList.add('error');
  });
  return b;
}

const setSite = (domain, status) => HNPF.send({ type: 'setSite', domains: [domain], status });
const setPage = (key, status) => HNPF.send({ type: 'setPage', key, status });

async function render() {
  const state = await HNPF.loadState();
  const name = $('domain').value.trim();
  const domain = HNPF.normalizeDomain(name);
  const problem = HNPF.siteProblem(name);
  // Whether the field still names the site of the open page, so that the page itself is
  // judged and a verdict on this one article shows up too. A page on an IP address or a
  // bare machine name has no site name, and counts for as long as the field is left alone.
  const host = HNPF.hostOf(tabUrl);
  const onTab = domain ? host === domain || host.endsWith('.' + domain) : name === tabSite;
  const acts = [];
  let status = !name ? 'Not a site name.' : problem ? `${problem}.` : '';
  let reason = '';

  if (domain || onTab) {
    const c = HNPF.classify(onTab ? articleUrl : `https://${domain}/`, state);
    reason = c.reason;
    // The article a story's link was found to lead to, where that page decides, is the one
    // to hide or show.
    const page = c.led || articleUrl;

    if (c.gated) status = `Hidden on Hacker News: ${HNPF.sourceLabel(c.source)}.`;
    else if (c.source === 'allowed') status = 'Always shown on Hacker News.';
    else if (!problem) status = 'Not hidden on Hacker News.';

    // On a platform that many authors share, the article is the thing to hide; the whole
    // platform stays on offer under its name.
    const shared = onTab && !problem && HNPF.hideableSite(tabUrl, domain) !== domain;
    const hideSite = button(shared ? `Hide all of ${domain}` : 'Hide this site', () => setSite(domain, 'gated'));
    const hideArticle = button('Hide this article', () => setPage(HNPF.pageKey(page), 'gated'));
    const article = onTab && HNPF.canHideArticle(c);
    if (article && (shared || problem)) acts.push(hideArticle);
    if (!problem && (!c.gated || c.page)) acts.push(hideSite);
    if (article && !shared && !problem) acts.push(hideArticle);
    if (article && problem && name === tabSite) reason = 'Only the article can be hidden here.';

    // Taking back the user's own "Hide this article" leaves no entry behind.
    if (c.gated && c.page) acts.push(button('Show this article', () => setPage(c.key, c.source === 'manual' ? null : 'allowed')));
    if (c.gated && !c.page) acts.push(button('Always show', () => setSite(c.key, 'allowed')));
    // A site the detectors hid can be overruled for the open article alone.
    if (onTab && c.gated && !c.page && (c.source === 'visit' || c.source === 'check')) {
      acts.push(button('Show this article', () => setPage(HNPF.pageKey(page), 'allowed')));
    }
  }
  // An entry an older version accepted stays removable, whatever it names.
  const listed = domain ?? name;
  if (Object.hasOwn(state.sites, listed)) acts.push(button('Remove from list', () => setSite(listed, null)));

  $('status').textContent = status;
  $('status').classList.remove('error');
  $('reason').textContent = reason;
  $('reason').hidden = !reason;
  $('actions').replaceChildren(...acts);
}

async function init() {
  $('manage').addEventListener('click', (ev) => {
    ev.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = HNPF.hostOf(tab?.url);
  if (!host || host === 'news.ycombinator.com') {
    $('none').hidden = false;
    return;
  }
  tabUrl = tab.url;

  // Prefer the name Hacker News files this story under, when it came from a listing.
  const { stories = {} } = await chrome.storage.session.get('stories');
  const story = HNPF.storyFor(stories, tabUrl);
  articleUrl = story?.url || tabUrl;
  tabSite = HNPF.siteFor(tabUrl, story?.site);
  $('domain').value = tabSite;
  $('site').hidden = false;

  $('domain').addEventListener('input', render);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') render();
  });
  await render();
}

init();
