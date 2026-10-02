// Judges a fetched page from its HTML source alone (the service worker has no DOM).
// Catches locked articles and ones that show a gate prompt; overlay and metered walls that
// let the reader through are left to on-visit detection.
globalThis.HNPF_ANALYZE = (() => {
  const S = HNPF_SIGNALS;

  const CHALLENGE_RE = /<title[^>]*>\s*(?:just a moment|attention required|access denied|are you a robot|verif(?:y|ying) (?:you are|you're) (?:a )?human|pardon our interruption|security check)/i;
  // Same test as on-visit detection: the page is built by the platform's own scripts and
  // styles. An embedded image or a link to one says nothing about who hosts the page.
  const PLATFORM_RE = /<(?:script|link)\b[^<>]*\s(?:src|href)\s*=\s*["']?[^"'\s<>]*(?:substackcdn\.com|cdn-client\.medium\.com)|<meta\b(?=[^<>]*\bproperty\s*=\s*["']?al:android:package\b)(?=[^<>]*\bcontent\s*=\s*["']?com\.medium\.reader\b)/i;
  const COMMENT_RE = /<!--[\s\S]*?-->/g;
  const LD_BLOCK_RE = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  const TIER_RE = /<meta[^>]+article:content_tier[^>]*>/gi;
  const DROP_RE = /<!--[\s\S]*?-->|<(script|style|noscript|template|svg|title|nav|footer)\b[\s\S]*?<\/\1\s*>/gi;
  const P_TAG_RE = /<(\/?)p\b[^<>]*>/gi;
  // Tags that end a run of text; any other tag (inline, custom, unknown) sits inside one.
  const BLOCK_RE = /<\/?(?:address|article|aside|blockquote|body|button|dd|details|div|dl|dt|fieldset|figcaption|figure|form|h[1-6]|head|header|hr|html|label|li|main|ol|option|p|pre|section|select|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^<>]*>/gi;
  // Link text is left out of the count: a list of long headlines is not an article.
  const LINK_RE = /<a\b[^<>]*>[\s\S]{0,2000}?<\/a\s*>/gi;
  const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', laquo: '«' };

  // Below this, the article is probably rendered by script and the source says nothing.
  const EMPTY_WORDS = 40;
  const { SHORT_WORDS, PROSE_WORDS } = S;

  function toText(html) {
    const plain = html.replace(/<[^<>]*>/g, ' ').replace(/&(#?\w+);/g, (m, name) => {
      const code = /^#x[\da-f]+$/i.test(name) ? parseInt(name.slice(2), 16) : /^#\d+$/.test(name) ? Number(name.slice(1)) : null;
      if (code === null) return ENTITIES[name.toLowerCase()] ?? ' ';
      return code > 32 && code <= 0x10ffff && code !== 160 ? String.fromCodePoint(code) : ' ';
    });
    return S.normalizeText(plain);
  }

  function countWords(text) {
    return text ? text.split(' ').length : 0;
  }

  // Words of article text, whatever it is wrapped in: <p> with or without a closing tag,
  // <div>, <li>, <td>… Counted two ways, taking the larger: all text in closed paragraphs,
  // and runs of prose between block tags that are not a cookie notice.
  function articleWords(body) {
    let paragraphs = 0;
    let open = -1;
    for (const m of body.matchAll(P_TAG_RE)) {
      if (!m[1]) {
        if (open < 0) open = m.index + m[0].length;
      } else if (open >= 0) {
        paragraphs += countWords(toText(body.slice(open, m.index)));
        open = -1;
      }
    }
    let prose = 0;
    for (const run of body.replace(LINK_RE, ' ').split(BLOCK_RE)) {
      const text = toText(run);
      const n = countWords(text);
      if (n >= PROSE_WORDS && !S.COOKIE_RE.test(text)) prose += n;
    }
    return Math.max(paragraphs, prose);
  }

  // Returns { verdict: 'gated' | 'free' | 'unknown', reason, platform }.
  // `truncated` means the download was cut off, so a short text proves nothing.
  function analyzeHtml(html, { truncated = false } = {}) {
    const platform = PLATFORM_RE.test(html.replace(COMMENT_RE, ' '));

    // A declared paywall only counts together with a prompt: metered sites declare one on
    // articles they still show in full.
    let declared = false;
    for (const m of html.matchAll(LD_BLOCK_RE)) declared ||= S.ldDeclaresGated(m[1]);
    for (const m of html.matchAll(TIER_RE)) {
      const tier = S.tierOf(/content=["']?([^"'\s>]+)/i.exec(m[0])?.[1]);
      if (tier === 'locked') return { verdict: 'gated', reason: 'page metadata marks it "locked"', platform };
      declared ||= tier === 'metered';
    }
    if (CHALLENGE_RE.test(html)) return { verdict: 'unknown', reason: 'the site answered with a bot check', platform };

    const body = html.replace(DROP_RE, ' ');
    const words = articleWords(body);
    const text = toText(body);
    // A count of free articles left sits on metered articles shown in full, which declare
    // a paywall as well, so it only counts on an article that is cut short.
    const firm = S.gatePhrase(text, { meter: false });
    const phrase = firm || S.gatePhrase(text);

    if (firm && declared) {
      return { verdict: 'gated', reason: `page declares a paywall and shows a prompt: “${firm}”`, platform };
    }
    if (phrase && words < SHORT_WORDS && !truncated) {
      return { verdict: 'gated', reason: `page is cut short with a prompt: “${phrase}”`, platform };
    }
    if (!phrase && words < EMPTY_WORDS) return { verdict: 'unknown', reason: 'page text is loaded by script', platform };
    return { verdict: 'free', reason: '', platform };
  }

  return { analyzeHtml };
})();
