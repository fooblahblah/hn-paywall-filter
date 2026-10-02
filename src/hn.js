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

  // A button that runs `onClick`. When that sends a request the service worker refuses,
  // the reason is shown next to the button and read out.
  function action(label, title, onClick) {
    const b = el('button', 'hnpf-btn', label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const res = await onClick();
      if (res?.ok !== false || !b.isConnected) return;
      // A new element each time, text and all, so that the same refusal is read out again.
      if (b.nextElementSibling?.classList.contains('hnpf-error')) b.nextElementSibling.remove();
      const error = el('span', 'hnpf-error', ` (${res.error})`);
      error.setAttribute('role', 'alert');
      b.after(error);
    });
    return b;
  }

  // What changed is read out from here. The summary line cannot do it: it is taken out
  // and built again, and a screen reader says nothing about a region that is new.
  const status = el('div', 'hnpf-status');
  status.setAttribute('role', 'status');
  let said = null;
  function announce(message) {
    if (!status.isConnected) document.body.append(status);
    // The page as it loads is not news.
    if (said !== null && said !== message) status.textContent = message;
    said = message;
  }

  const plural = (count) => (count === 1 ? 'story' : 'stories');

  // The control the keyboard is on is about to be taken out with the rest. This notes
  // where it was and returns a function that puts the focus back once they are rebuilt.
  function keepFocus() {
    const control = document.activeElement;
    if (!control?.classList?.contains('hnpf-btn')) return () => {};
    const row = control.closest('tr');
    const label = control.textContent;
    const labelled = (buttons) => buttons.find((b) => b.textContent === label) || buttons[0];
    const shown = (r) => !r.classList.contains('hnpf-gated') || root.classList.contains('hnpf-label') || expanded;
    // The first story left on the page from `from` on, or failing that the summary line.
    const story = (from) => {
      for (let r = from; r; r = r.nextElementSibling) {
        if (r.classList.contains('athing') && shown(r)) return r.querySelector('.titleline > a');
      }
      return document.querySelector('.hnpf-summary .hnpf-btn');
    };
    return () => {
      let target;
      if (row.isConnected) target = shown(row) ? labelled([...row.querySelectorAll('.hnpf-btn')]) : story(row);
      else if (row.classList.contains('hnpf-summary')) target = labelled([...document.querySelectorAll('.hnpf-summary .hnpf-btn')]);
      // A note about a newly hidden site: on to the next such note, or to the list under it.
      else target = labelled([...document.querySelectorAll('.hnpf-notice .hnpf-btn')]) || story(document.querySelector('tr.athing'));
      target?.focus();
    };
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
        // The site "mark gated" hides, or null where only the article can be hidden.
        own: HNPF.hideableSite(link.href, row.querySelector('.sitestr')?.textContent),
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
    // Taking back the user's own "hide this article" leaves no entry behind.
    const undo = c.page
      ? action('show this article', 'Stop hiding this article', () => send({ type: 'setPage', key: c.key, status: c.source === 'manual' ? null : 'allowed' }))
      : action(`always show ${c.key}`, `Never hide stories from ${c.key}`, () => send({ type: 'setSite', domains: [c.key], status: 'allowed' }));
    note.append(' | ', why, ' | ', undo);
    // A site the detectors hid can be overruled for one story.
    if (!c.page && (c.source === 'visit' || c.source === 'check')) {
      const key = HNPF.pageKey(url);
      note.append(' | ', action('show this article', 'Stop hiding this article', () => send({ type: 'setPage', key, status: 'allowed' })));
    }
    return note;
  }

  // The story's site is hidden where it has one of its own. On a platform that many
  // authors share, and on a host that cannot go on the site list, the article is.
  function markNote({ own, url }, c) {
    const note = el('span', 'hnpf-note hnpf-mark');
    if (own) note.append(' | ', action('mark gated', `Hide stories from ${own}`, () => send({ type: 'setSite', domains: [own], status: 'gated' })));
    else if (HNPF.canHideArticle(c)) note.append(' | ', action('hide this article', 'Hide this story only', () => send({ type: 'setPage', key: HNPF.pageKey(url), status: 'gated' })));
    return note;
  }

  const summaryText = (count) => `${count} gated ${plural(count)} ${expanded ? 'shown' : 'hidden'}`;

  function summaryRow(count) {
    const tr = el('tr', 'hnpf-summary');
    const pad = el('td');
    pad.colSpan = 2;
    const td = el('td', 'subtext');
    td.append(
      `${summaryText(count)} | `,
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
      `HN Paywall Filter now treats ${site} as gated: ${entry.reason} | `,
      action(`always show ${site}`, `Never hide stories from ${site}`, () => send({ type: 'setSite', domains: [site], status: 'allowed' })),
      ' | ',
      action('ok', 'Keep it that way and dismiss this note', () => send({ type: 'seenSites', domains: [site] })),
    );
    tr.append(pad, td);
    return tr;
  }

  function apply() {
    const restoreFocus = keepFocus();
    for (const n of document.querySelectorAll('.hnpf-tag, .hnpf-note, .hnpf-summary, .hnpf-notice')) n.remove();
    for (const n of document.querySelectorAll('.hnpf-gated')) n.classList.remove('hnpf-gated');
    const label = state.settings.display === 'label';
    root.classList.toggle('hnpf-label', label);
    root.classList.toggle('hnpf-expanded', expanded);

    const all = stories();
    let hidden = 0;
    let gated = 0;
    for (const s of all) {
      const c = HNPF.classify(s.url, state);
      if (!c.gated) {
        s.subtext?.append(markNote(s, c));
        continue;
      }
      gated++;
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
      announce(summaryText(hidden));
    } else {
      announce(gated ? `${gated} ${plural(gated)} labelled gated` : 'No gated stories');
    }
    restoreFocus();
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

  // A page the browser loaded ahead of the visit had no tab of its own to put the count on,
  // and one it kept for the Back button (below) comes back to a tab that lost it.
  if (document.prerendering) document.addEventListener('prerenderingchange', () => state && apply(), { once: true });

  function reload() {
    if (!state) return;
    HNPF.loadState().then((loaded) => {
      state = loaded;
      apply();
    });
  }
  // The list may have changed while the page was kept aside.
  window.addEventListener('pageshow', (ev) => ev.persisted && reload());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sites || changes.pages || changes.settings) reload();
  });
})();
