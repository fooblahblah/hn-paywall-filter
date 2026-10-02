// Content script for news.ycombinator.com: hides (or labels) stories that link to gated
// sites and adds the per-story controls. Runs at document_start so nothing flashes.
(() => {
  const root = document.documentElement;

  // Story rows stay invisible (see hn.css) until the lists are loaded. The timer makes
  // sure the page shows up even if that never happens.
  root.classList.add('hnpf-pending');
  const failsafe = setTimeout(reveal, 800);
  function reveal() {
    clearTimeout(failsafe);
    root.classList.remove('hnpf-pending');
  }

  let state = null;
  let expanded = false;

  // sendMessage throws once the extension has been reloaded under an open page.
  function send(message) {
    try {
      return HNPF.send(message).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  function action(label, title, onClick) {
    const a = el('a', '', label);
    a.href = '#';
    if (title) a.title = title;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      onClick();
    });
    return a;
  }

  // Every story with an external link, with the table rows that make it up.
  function stories() {
    const out = [];
    for (const row of document.querySelectorAll('tr.athing')) {
      const link = row.querySelector('.titleline > a');
      const host = link && HNPF.hostOf(link.href);
      if (!host || host === location.hostname) continue;
      const sub = row.nextElementSibling;
      const subtext = sub?.querySelector('td.subtext') || null;
      const spacer = subtext && sub.nextElementSibling;
      out.push({
        link,
        subtext,
        url: link.href,
        site: HNPF.siteFor(link.href, row.querySelector('.sitestr')?.textContent),
        group: [row, subtext && sub, spacer?.classList.contains('spacer') && spacer].filter(Boolean),
        // The story at the top of its own comments page is labelled, never hidden.
        single: !!row.closest('.fatitem'),
      });
    }
    return out;
  }

  function gatedNote(c, url) {
    const note = el('span', 'hnpf-note');
    const why = el('span', '', HNPF.sourceLabel(c.source));
    if (c.reason) why.title = c.reason;
    const undo = c.page
      ? action('show this article', 'Stop hiding this article', () => send({ type: 'setPage', key: c.key, status: 'allowed' }))
      : action(`always show ${c.key}`, `Never hide stories from ${c.key}`, () => send({ type: 'setSite', domains: [c.key], status: 'allowed' }));
    note.append(' | ', why, ' | ', undo);
    // A site the detectors hid can be overruled for one story.
    if (!c.page && (c.source === 'visit' || c.source === 'check')) {
      const key = HNPF.pageKey(url);
      note.append(' | ', action('show this article', 'Stop hiding this article', () => send({ type: 'setPage', key, status: 'allowed' })));
    }
    return note;
  }

  function markNote(site) {
    const note = el('span', 'hnpf-note hnpf-mark');
    note.append(' | ', action('mark gated', `Hide stories from ${site}`, () => send({ type: 'setSite', domains: [site], status: 'gated' })));
    return note;
  }

  function summaryRow(count) {
    const tr = el('tr', 'hnpf-summary');
    const pad = el('td');
    pad.colSpan = 2;
    const td = el('td', 'subtext');
    td.append(
      `${count} gated ${count === 1 ? 'story' : 'stories'} ${expanded ? 'shown' : 'hidden'} | `,
      action(expanded ? 'hide' : 'show', '', () => {
        expanded = !expanded;
        apply();
      }),
      ' | ',
      action('edit list', 'Open the HN Paywall Filter site list', () => send({ type: 'openOptions' })),
    );
    tr.append(pad, td);
    return tr;
  }

  // Sites the detectors hid as a whole since the user last acknowledged one.
  function newlyHidden() {
    const now = Date.now();
    return Object.entries(state.sites).filter(([, e]) => HNPF.isPromoted(e) && !e.seen && !HNPF.siteExpired(e, now));
  }

  // Says that a site was added without the user asking, with a way to take it back.
  function noticeRow(site, entry) {
    const tr = el('tr', 'hnpf-notice');
    const pad = el('td');
    pad.colSpan = 2;
    const td = el('td', 'subtext');
    td.append(
      `HN Paywall Filter now hides ${site}: ${entry.reason} | `,
      action(`always show ${site}`, `Never hide stories from ${site}`, () => send({ type: 'setSite', domains: [site], status: 'allowed' })),
      ' | ',
      action('ok', 'Keep hiding it and dismiss this note', () => send({ type: 'seenSites', domains: [site] })),
    );
    tr.append(pad, td);
    return tr;
  }

  function apply() {
    for (const n of document.querySelectorAll('.hnpf-tag, .hnpf-note, .hnpf-summary, .hnpf-notice')) n.remove();
    for (const n of document.querySelectorAll('.hnpf-gated')) n.classList.remove('hnpf-gated');
    const label = state.settings.display === 'label';
    root.classList.toggle('hnpf-label', label);
    root.classList.toggle('hnpf-expanded', expanded);

    const all = stories();
    let hidden = 0;
    for (const s of all) {
      const c = HNPF.classify(s.url, state);
      if (!c.gated) {
        s.subtext?.append(markNote(s.site));
        continue;
      }
      s.link.after(el('span', 'hnpf-tag', 'gated'));
      s.subtext?.append(gatedNote(c, s.url));
      if (s.single) continue;
      for (const g of s.group) g.classList.add('hnpf-gated');
      hidden++;
    }

    const first = all.find((s) => !s.single)?.group[0];
    if (first) for (const [site, entry] of newlyHidden()) first.before(noticeRow(site, entry));

    send({ type: 'hiddenCount', count: hidden });
    if (hidden && !label) {
      const more = document.querySelector('tr.morespace');
      if (more) more.before(summaryRow(hidden));
      else all.at(-1).group.at(-1).after(summaryRow(hidden));
    }
    return all;
  }

  const domReady = new Promise((resolve) => {
    if (document.readyState !== 'loading') resolve();
    else document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });

  Promise.all([HNPF.loadState(), domReady])
    .then(([loaded]) => {
      state = loaded;
      const all = apply();
      if (all.length) send({ type: 'stories', items: all.map(({ url, site }) => ({ url, site })) });
    })
    .catch((e) => console.error('hnpf: could not filter this page', e))
    .finally(reveal);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !state) return;
    if (!changes.sites && !changes.pages && !changes.settings) return;
    HNPF.loadState().then((loaded) => {
      state = loaded;
      apply();
    });
  });
})();
