// On-visit detection. Injected (after signals.js) into a story page opened from Hacker News;
// looks at the rendered page a few times and reports once if the content is gated, or
// that it was not after the last timed look. Says nothing once the tab shows another page.
(() => {
  if (window.__hnpfDetect) return;
  window.__hnpfDetect = true;

  const S = HNPF_SIGNALS;

  // The page detection was started for. A site that routes in the page can swap in another
  // one (pricing, sign-in) without a reload, and a wall there says nothing about the story.
  const here = () => location.origin + location.pathname + location.search;
  const started = here();

  const WALL_SELECTOR = [
    '[class*="paywall" i]', '[id*="paywall" i]', '[data-testid*="paywall" i]', '[class*="pay-wall" i]',
    '[class*="regwall" i]', '[id*="regwall" i]', '[data-testid*="regwall" i]', '[class*="reg-wall" i]',
    '[class*="registration-wall" i]', '[class*="login-wall" i]', '[class*="subscriber-wall" i]',
    '[class*="premium-wall" i]', '[class*="content-gate" i]', '[class*="article-gate" i]',
    '[class*="gateway" i]', '[id*="gateway" i]',
  ].join(',');
  const DISMISS_SELECTOR = '[aria-label*="close" i], [title*="close" i], [class*="close" i], [class*="dismiss" i], [data-dismiss]';
  const PLATFORM_SELECTOR = [
    'script[src*="substackcdn.com"]', 'link[href*="substackcdn.com"]',
    'script[src*="cdn-client.medium.com"]', 'meta[property="al:android:package"][content="com.medium.reader"]',
  ].join(',');
  // Cheap filter before running the full phrase match on a text node's surroundings.
  const HINT_RE = /reading|subscri|member|account|unlock|limit|free (?:article|stor)|trial|e-?mail|required|\bto (?:read|access|view|see)\b/i;

  const WALL_TEXT_MAX = 2500;
  const PROMPT_TEXT_MAX = 800;
  const MAX_TEXT_NODES = 20000;

  function isVisible(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function textOf(el, max) {
    const raw = el.innerText || '';
    return raw.length > max * 2 ? '' : S.normalizeText(raw);
  }

  // Only "locked" is decisive. Other paywall metadata is also set on articles a metered site
  // still shows in full, so those are judged by what is actually on screen.
  function locked() {
    const tier = document.querySelector('meta[property="article:content_tier"], meta[name="article:content_tier"]')?.content;
    return S.tierOf(tier) === 'locked' ? 'page metadata marks it "locked"' : null;
  }

  // Piano shows its offers in a cross-origin iframe, so there is no wording to read.
  function pianoModal() {
    const modal = document.querySelector('.tp-modal');
    return modal && isVisible(modal) && document.body.classList.contains('tp-modal-open')
      ? 'subscription overlay blocks the page'
      : null;
  }

  function wallBlock() {
    for (const el of document.querySelectorAll(WALL_SELECTOR)) {
      if (!isVisible(el)) continue;
      const phrase = phraseIn(textOf(el, WALL_TEXT_MAX));
      if (phrase) return `prompt on page: “${phrase}”`;
    }
    return null;
  }

  // The gate phrase in a block of text. A count of free articles left needs a sign that
  // the article is withheld, and with `inline` (wording found loose on the page) so does
  // every other phrase.
  function phraseIn(text, inline = false) {
    const firm = S.gatePhrase(text, { meter: false });
    if (firm && !inline) return firm;
    const phrase = firm || S.gatePhrase(text);
    return phrase && withheld() ? phrase : null;
  }

  function scrollLocked() {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const locked = (v) => v === 'hidden' || v === 'clip';
    return locked(html.overflowY) || locked(body.overflowY) || body.position === 'fixed';
  }

  // Fixed or sticky boxes sitting on top of the page around the middle and bottom of the viewport.
  function overlayRoots() {
    const roots = new Set();
    for (const y of [0.3, 0.5, 0.8, 0.93]) {
      const stack = document.elementsFromPoint(innerWidth / 2, innerHeight * y).slice(0, 3);
      for (let el of stack) {
        for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
          const pos = getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') {
            roots.add(el);
            break;
          }
        }
      }
    }
    return roots;
  }

  // Whether an overlay takes up much of the viewport and cannot be waved away.
  function covers(el, text) {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 0.25 * innerWidth * innerHeight) return false;
    return !S.DISMISS_RE.test(text) && !el.querySelector(DISMISS_SELECTOR);
  }

  const isNotice = (text) => S.COOKIE_RE.test(text) || S.PROMO_RE.test(text);

  function overlay() {
    for (const el of overlayRoots()) {
      const text = textOf(el, WALL_TEXT_MAX);
      if (!text) continue;
      const phrase = phraseIn(text);
      if (phrase) return `overlay on page: “${phrase}”`;

      // Sign-in wording alone only counts when the overlay cannot be waved away.
      if (covers(el, text) && scrollLocked() && S.WEAK_RE.test(text) && !isNotice(text)) {
        return 'sign-in or subscribe overlay blocks the page';
      }
    }
    return null;
  }

  // Whether the reader is kept from the article: an overlay covers the page, the page
  // cannot be scrolled, or there is little to read on it. A cookie or newsletter box locks
  // the page as well, so with one of those up the lock proves nothing.
  function blocked() {
    let lock = scrollLocked();
    for (const el of overlayRoots()) {
      const text = S.normalizeText((el.innerText || '').slice(0, WALL_TEXT_MAX * 2));
      if (!text) continue;
      if (isNotice(text)) lock = false;
      else if (covers(el, text)) return true;
    }
    return lock;
  }

  // Gate wording also turns up next to an article that is shown in full: a card for some
  // other, members-only post, or a count of the free articles left. Worked out once a look.
  let held = null;
  function withheld() {
    return (held ??= blocked() || S.proseWords(document.body.innerText) < S.SHORT_WORDS);
  }

  // A gate phrase in a short, visible block of the page itself (inline prompts, cut-off
  // articles), where the article is withheld.
  function inlinePrompt() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n, i = 0; (n = walker.nextNode()) && i < MAX_TEXT_NODES; i++) {
      if (n.nodeValue.length < 8 || !HINT_RE.test(n.nodeValue)) continue;
      let el = n.parentElement;
      if (!el || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !isVisible(el)) continue;
      if (el.closest('nav, footer, aside')) continue;
      for (let up = 0; el && up < 4 && !seen.has(el); up++, el = el.parentElement) {
        seen.add(el);
        const text = textOf(el, PROMPT_TEXT_MAX);
        if (!text || text.length > PROMPT_TEXT_MAX) break;
        const phrase = phraseIn(text, true);
        if (phrase) return `prompt on page: “${phrase}”`;
        // Wording is there but nothing is withheld; other blocks will not change that.
        if (held === false && S.gatePhrase(text)) return null;
      }
    }
    return null;
  }

  const onPlatform = () => !!document.querySelector(PLATFORM_SELECTOR);

  let done = false;
  let scrollChecks = 4;

  function report(verdict, reason) {
    chrome.runtime.sendMessage({ type: 'visitVerdict', url: started, verdict, reason, platform: onPlatform() }).catch(() => {});
  }

  function run() {
    if (done || !document.body) return;
    if (here() !== started) {
      done = true;
      return;
    }
    held = null;
    const reason = locked() || pianoModal() || wallBlock() || overlay() || inlinePrompt();
    if (!reason) return;
    done = true;
    report('gated', reason);
  }

  // Walls often appear a few seconds in, or only once the reader scrolls.
  const DELAYS = [1500, 4000, 9000];
  for (const delay of DELAYS) setTimeout(run, delay);
  // An article that showed no wall counts against hiding its whole site.
  setTimeout(() => {
    if (!done && here() === started) report('free');
  }, DELAYS.at(-1) + 100);
  let scrollTimer;
  addEventListener('scroll', () => {
    if (done || scrollChecks <= 0) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollChecks--;
      run();
    }, 1200);
  }, { passive: true });
})();
