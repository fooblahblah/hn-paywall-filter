// Content script for news.ycombinator.com: hides (or labels) stories that link to gated
// sites and adds the per-story controls. Runs at document_start so nothing flashes.
(() => {
  const root = document.documentElement;

  // The lists Hacker News puts together for everyone. Stories are hidden on these alone.
  // On any other page they are labelled: the reader chose what is on it (favorites,
  // upvoted, submitted, hidden) or asked for it by name ("from?site=nytimes.com"), and
  // hiding there would take away the very thing they came for.
  const LISTINGS = new Set([
    '/', '/news', '/newest', '/front', '/best', '/ask', '/show',
    '/shownew', '/asknew', '/active', '/classic', '/noobstories', '/pool', '/launches', '/jobs',
  ]);
  const listing = LISTINGS.has(location.pathname);

  // Where stories may be hidden, their rows stay invisible (see hn.css) until the lists
  // are loaded. The timer makes sure the page shows up even if that never happens.
  if (listing) root.classList.add('hnpf-pending');
  const failsafe = setTimeout(reveal, 800);
  function reveal() {
    clearTimeout(failsafe);
    root.classList.remove('hnpf-pending');
  }

  let state = null;
  let expanded = false;
  const send = HNPF.send;

  // Nothing moves under the reader. A story a detector finds gated once the page is drawn
  // is labelled where it is, and hidden the next time the page loads; `late` holds the
  // addresses of those. What the reader hides goes at once: that was asked for.
  // `drawn` is null until the page is first drawn, then the addresses of its gated stories.
  const late = new Set();
  let drawn = null;
  // Where each story's link was known to lead when the page was last drawn. A story newly
  // found to lead to a gated page is a detector's finding, whatever list that page is on.
  const pointed = new Map();
  // The sites a note is shown for: those the detectors had hidden when the page was drawn.
  // One hidden since would put a line above the stories and push them all down.
  let noted = null;
  const LATE_TITLE = 'Found gated while this page was open: hidden the next time it loads';

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  // A button that runs `onClick`. When that sends a request the service worker refuses,
  // or one that never reaches it, the reason is shown next to the button and read out.
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
    // Off screen, it is not where the reader is looking: the page must not jump back to it.
    const box = control.getBoundingClientRect();
    const preventScroll = box.bottom <= 0 || box.top >= window.innerHeight;
    // The control that does the same within `within`, or its first.
    const again = (within) => {
      const buttons = within ? [...within.querySelectorAll('.hnpf-btn')] : [];
      return buttons.find((b) => b.textContent === label) || buttons[0];
    };
    // A story labelled where it is has no "hnpf-gated" on its rows.
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
      if (row.isConnected) {
        // A story that is still there may have no control left: then its title.
        target = shown(row) ? again(row) || row.previousElementSibling?.querySelector('.titleline > a') : story(row);
      } else if (row.classList.contains('hnpf-summary')) {
        target = again(document.querySelector('.hnpf-summary'));
      } else {
        // A note about a newly hidden site: the same site's, or with that gone the next.
        const notes = [...document.querySelectorAll('.hnpf-notice')];
        target = again(notes.find((n) => n.dataset.site === row.dataset.site) || notes[0]);
      }
      (target || story(document.querySelector('tr.athing')))?.focus({ preventScroll });
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
    // A site the detectors hid can be overruled for one story: for the page its link leads
    // to, where that page decided.
    if (!c.page && (c.source === 'visit' || c.source === 'check')) {
      const key = HNPF.pageKey(c.led || url);
      note.append(' | ', action('show this article', 'Stop hiding this article', () => send({ type: 'setPage', key, status: 'allowed' })));
    }
    return note;
  }

  // The story's site is hidden where it has one of its own. On a platform that many
  // authors share, and on a host that cannot go on the site list, the article is. A story
  // whose link was found to lead to another page is that page's, never the shortener's.
  function markNote({ own, url }, c) {
    const to = c.led || (c.source !== 'allowed' && HNPF.leadsTo(url, state, Date.now()));
    if (to) [own, url] = [HNPF.hideableSite(to), to];
    const note = el('span', 'hnpf-note hnpf-mark');
    if (own) note.append(' | ', action('mark gated', `Hide stories from ${own}`, () => send({ type: 'setSite', domains: [own], status: 'gated' })));
    else if (HNPF.canHideArticle(c)) note.append(' | ', action('hide this article', 'Hide this story only', () => send({ type: 'setPage', key: HNPF.pageKey(url), status: 'gated' })));
    return note;
  }

  // `more` counts the stories labelled where they are, which "show" and "hide" leave alone.
  const summaryText = (count, more) => `${count} gated ${plural(count)} ${expanded ? 'shown' : 'hidden'}${more ? `, ${more} more labelled` : ''}`;

  function summaryRow(count, more) {
    const tr = el('tr', 'hnpf-summary');
    const pad = el('td');
    pad.colSpan = 2;
    const td = el('td', 'subtext');
    td.append(
      `${summaryText(count, more)} | `,
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

  // Sites the detectors hid as a whole since the user last acknowledged one, as far as
  // the page had a note for them when it was drawn.
  function newlyHidden() {
    const now = Date.now();
    const all = Object.entries(state.sites).filter(([, e]) => HNPF.isPromoted(e) && !e.seen && !HNPF.siteExpired(e, now));
    noted ??= new Set(all.map(([site]) => site));
    return all.filter(([site]) => noted.has(site));
  }

  // Says that a site was added without the user asking, with a way to take it back.
  function noticeRow(site, entry) {
    const tr = el('tr', 'hnpf-notice');
    tr.dataset.site = site;
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
    for (const name of ['hnpf-gated', 'hnpf-late']) {
      for (const n of document.querySelectorAll(`.${name}`)) n.classList.remove(name);
    }
    const label = !listing || state.settings.display === 'label';
    root.classList.toggle('hnpf-label', label);
    root.classList.toggle('hnpf-expanded', expanded);

    const all = stories();
    const now = new Set();
    let hidden = 0;
    let kept = 0;
    let gated = 0;
    for (const s of all) {
      const c = HNPF.classify(s.url, state);
      const found = drawn && c.led && c.led !== pointed.get(s.url);
      pointed.set(s.url, HNPF.leadsTo(s.url, state, Date.now()));
      if (!c.gated) {
        late.delete(s.url);
        s.subtext?.append(markNote(s, c));
        continue;
      }
      gated++;
      now.add(s.url);
      // The built-in list does not change under an open page, and the reader's own
      // entries are the reader's doing. Where the link was just found to lead is neither.
      if (!found && (c.source === 'manual' || c.source === 'seed')) late.delete(s.url);
      else if (drawn && !drawn.has(s.url)) late.add(s.url);
      const keep = !label && !s.single && late.has(s.url);
      const tag = el('span', 'hnpf-tag', 'gated');
      if (keep) tag.title = LATE_TITLE;
      s.link.after(tag);
      s.subtext?.append(gatedNote(c, s.url));
      if (s.single) continue;
      for (const g of s.group) g.classList.add(keep ? 'hnpf-late' : 'hnpf-gated');
      if (keep) kept++;
      else hidden++;
    }
    drawn = now;

    const first = all.find((s) => !s.single)?.group[0];
    const notes = newlyHidden();
    if (first) for (const [site, entry] of notes) first.before(noticeRow(site, entry));

    // The toolbar counts every gated story of the list, hidden or labelled.
    send({ type: 'hiddenCount', count: hidden + kept });
    if (hidden && !label) {
      const more = document.querySelector('tr.morespace');
      if (more) more.before(summaryRow(hidden, kept));
      else all.at(-1).group.at(-1).after(summaryRow(hidden, kept));
      announce(summaryText(hidden, kept));
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

  // Whether the lists changed before the page was there to be drawn.
  let stale = false;

  Promise.all([HNPF.loadState(), domReady])
    .then(async ([loaded]) => {
      while (stale) {
        stale = false;
        loaded = await HNPF.loadState();
      }
      state = loaded;
      const all = apply();
      if (all.length) send({ type: 'stories', items: all.map(({ url, site }) => ({ url, site })) });
    })
    .catch((e) => console.error('hnpf: could not filter this page', e))
    .finally(reveal);

  // A page the browser loaded ahead of the visit had no tab of its own to put the count on,
  // and one it kept for the Back button (below) comes back to a tab that lost it.
  // Nobody was reading it until now, so what was found in the meantime is hidden like the rest.
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', () => {
      if (!state) return;
      late.clear();
      drawn = noted = null;
      apply();
    }, { once: true });
  }

  function reload() {
    if (!state) return void (stale = true);
    // Nothing to load from once the extension was reloaded: the page stays as it is.
    HNPF.loadState().then(
      (loaded) => {
        state = loaded;
        apply();
      },
      () => {},
    );
  }
  // The list may have changed while the page was kept aside.
  window.addEventListener('pageshow', (ev) => ev.persisted && reload());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // A story found to lead to a page on the built-in list changes `redirects` alone.
    if (changes.sites || changes.pages || changes.redirects || changes.settings) reload();
  });
})();
