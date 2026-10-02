// Options page: detection settings plus the editable list of sites.
const $ = (id) => document.getElementById(id);
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const FILTERS = {
  all: () => true,
  mine: (r) => r.source === 'manual' && r.status === 'gated',
  auto: (r) => r.source === 'visit' || r.source === 'check',
  builtin: (r) => r.source === 'seed',
  allowed: (r) => r.status === 'allowed',
};

let state;
// Whether Chromium grants access to all sites, as of the last look; null before the first.
let granted = null;

// One row per site or single article: the user's and detected entries first (newest on
// top), then whatever is left of the built-in list.
function buildRows() {
  const seed = HNPF.seedSet();
  const custom = [];
  for (const [name, e] of Object.entries(state.sites)) custom.push({ ...e, name, page: false, builtin: seed.has(name) });
  for (const [name, e] of Object.entries(state.pages)) custom.push({ ...e, name, page: true, builtin: false });
  custom.sort((a, b) => b.at - a.at);

  const builtin = [...seed]
    .filter((name) => !Object.hasOwn(state.sites, name))
    .sort()
    .map((name) => ({ name, status: 'gated', source: 'seed', page: false, builtin: true }));
  return [...custom, ...builtin];
}

function describe(r) {
  if (r.source === 'seed') return 'Built-in list';
  const what =
    r.status === 'allowed' ? 'Your choice' :
    r.source === 'manual' ? 'Added by you' :
    r.source === 'visit' ? 'Detected when you visited' : 'Found by background check';
  const notes = [DATE.format(r.at)];
  if (r.page) notes.push('this article only');
  if (r.status === 'allowed' && r.builtin) notes.push('overrides the built-in list');
  return `${what} · ${notes.join(' · ')}`;
}

// Shows the outcome of a change under the form: what was done, or why it was refused.
function report(res, done = '') {
  const refused = res?.ok === false;
  $('addStatus').classList.toggle('error', refused);
  $('addStatus').textContent = refused ? `Not changed: ${res.error}.` : done;
  return !refused;
}

async function setEntry(r, status) {
  const res = await (r.page
    ? HNPF.send({ type: 'setPage', key: r.name, status })
    : HNPF.send({ type: 'setSite', domains: [r.name], status }));
  report(res);
}

function button(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function actions(r) {
  const out = [];
  if (r.status === 'gated') out.push(button('Always show', `Never hide ${r.name}`, () => setEntry(r, 'allowed')));
  else out.push(button('Hide', r.page ? 'Hide this article' : `Hide stories from ${r.name}`, () => setEntry(r, 'gated')));
  if (r.source !== 'seed') {
    const title = r.builtin ? 'Go back to the built-in list, which hides this site' : 'Forget this entry';
    out.push(button('Remove', title, () => setEntry(r, null)));
  }
  return out;
}

function cell(className, ...children) {
  const td = document.createElement('td');
  td.className = className;
  td.append(...children);
  return td;
}

function renderRow(r) {
  const tr = document.createElement('tr');
  const pill = document.createElement('span');
  pill.className = `pill ${r.status}`;
  pill.textContent = r.status === 'gated' ? 'Hidden' : 'Always shown';

  const why = [describe(r)];
  if (r.reason) {
    const reason = document.createElement('small');
    reason.textContent = r.reason;
    why.push(reason);
  }
  tr.append(cell('name', r.name), cell('', pill), cell('why', ...why), cell('actions', ...actions(r)));
  return tr;
}

function renderSites() {
  const rows = buildRows();
  const query = $('search').value.trim().toLowerCase();
  const filter = FILTERS[$('filter').value];
  const shown = rows.filter((r) => filter(r) && r.name.includes(query));

  $('sites').tBodies[0].replaceChildren(...shown.map(renderRow));
  $('empty').hidden = shown.length > 0;
  const hidden = rows.filter((r) => r.status === 'gated').length;
  $('count').textContent =
    shown.length === rows.length ? `${hidden} hidden, ${rows.length - hidden} always shown` : `${shown.length} of ${rows.length}`;
}

// A detection toggle only counts while Chromium still grants access to all sites.
async function renderSettings() {
  granted = await chrome.permissions.contains(HNPF.ALL_SITES);
  for (const name of ['visitDetect', 'bgCheck']) $(name).checked = granted && state.settings[name];
  for (const radio of document.getElementsByName('display')) radio.checked = radio.value === state.settings.display;
}

async function refresh() {
  state = await HNPF.loadState();
  renderSites();
  await renderSettings();
}

for (const name of ['visitDetect', 'bgCheck']) {
  $(name).addEventListener('change', async ({ target }) => {
    // Without the access both boxes showed as off, whatever is stored: turning this one on
    // must not bring the other back with it.
    const others = granted === false ? { visitDetect: false, bgCheck: false } : {};
    // Read now: the page is drawn again, from what is stored, as soon as access is granted.
    const on = target.checked;
    // Must be requested straight from the click, before anything else is awaited.
    if (on && !(await chrome.permissions.request(HNPF.ALL_SITES))) {
      target.checked = false;
      return;
    }
    // Switching the last one off makes the service worker give the access back.
    await HNPF.send({ type: 'setSettings', patch: { ...others, [name]: on } });
  });
}

$('forget').addEventListener('click', async () => {
  const res = await HNPF.send({ type: 'forgetDetected' });
  $('forgetStatus').classList.toggle('error', res?.ok === false);
  $('forgetStatus').textContent = res?.ok === false ? `Not done: ${res.error}.` : 'Forgotten. Your own entries are kept.';
});

for (const radio of document.getElementsByName('display')) {
  radio.addEventListener('change', () => HNPF.send({ type: 'setSettings', patch: { display: radio.value } }));
}

$('addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const entries = $('addInput').value.split(/[\s,]+/).filter(Boolean);
  const problems = entries.map(HNPF.siteProblem).filter(Boolean);
  if (problems.length) {
    report({ ok: false, error: problems.join('; ') });
    return;
  }
  if (!entries.length) return;
  const domains = entries.map(HNPF.normalizeDomain);
  const done = domains.length === 1 ? `${domains[0]} will be hidden.` : `${domains.length} sites will be hidden.`;
  if (report(await HNPF.send({ type: 'setSite', domains, status: 'gated' }), done)) $('addInput').value = '';
});

$('search').addEventListener('input', renderSites);
$('filter').addEventListener('change', renderSites);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refresh();
});
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

refresh();
