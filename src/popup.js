// Toolbar popup: shows how the current tab's site is treated and lets you change it.
const $ = (id) => document.getElementById(id);

let tabUrl = null;

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const setSite = (domain, status) => HNPF.send({ type: 'setSite', domains: [domain], status });
const setPage = (key, status) => HNPF.send({ type: 'setPage', key, status });

async function render() {
  const state = await HNPF.loadState();
  const domain = HNPF.normalizeDomain($('domain').value);
  const acts = [];
  let status = 'Not a site name.';
  let reason = '';

  if (domain) {
    // Judge the open article itself while the field still names its site, so that a
    // verdict on this one article shows up too.
    const host = HNPF.hostOf(tabUrl);
    const onTab = host === domain || host.endsWith('.' + domain);
    const c = HNPF.classify(onTab ? tabUrl : `https://${domain}/`, state);
    reason = c.reason;

    if (c.gated) status = `Hidden on Hacker News: ${HNPF.sourceLabel(c.source)}.`;
    else if (c.source === 'allowed') status = 'Always shown on Hacker News.';
    else status = 'Not hidden on Hacker News.';

    if (!c.gated || c.page) acts.push(button('Hide this site', () => setSite(domain, 'gated')));
    if (c.gated && c.page) acts.push(button('Show this article', () => setPage(c.key, 'allowed')));
    if (c.gated && !c.page) acts.push(button('Always show', () => setSite(c.key, 'allowed')));
    if (Object.hasOwn(state.sites, domain)) acts.push(button('Remove from list', () => setSite(domain, null)));
  }

  $('status').textContent = status;
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
  $('domain').value = HNPF.siteFor(tabUrl, stories[HNPF.pageKey(tabUrl)]?.site);
  $('site').hidden = false;

  $('domain').addEventListener('input', render);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') render();
  });
  await render();
}

init();
