// Judges a fetched page from its HTML source alone (the service worker has no DOM).
// Catches locked articles and ones that show a gate prompt; overlay and metered walls that
// let the reader through are left to on-visit detection.
globalThis.HNPF_ANALYZE = (() => {
  const S = HNPF_SIGNALS;

  // Every pattern here is read in time proportional to the page, whatever the page holds:
  // a tag pattern stops at the next "<", so openings do not rescan each other's text, and
  // the end of a block is looked for by blocks(), not by a pattern that runs on to it.
  const CHALLENGE_RE = /<title\b[^<>]*>\s*(?:just a moment|attention required|access denied|are you a robot|verif(?:y|ying) (?:you are|you're) (?:a )?human|pardon our interruption|security check)/i;
  // Same test as on-visit detection: the page is built by the platform's own scripts and
  // styles. An embedded image or a link to one says nothing about who hosts the page.
  const PLATFORM_RE = /<(?:script|link)\b[^<>]*\s(?:src|href)\s*=\s*["']?[^"'\s<>]*(?:substackcdn\.com|cdn-client\.medium\.com)|<meta\b(?=[^<>]*\bproperty\s*=\s*["']?al:android:package\b)(?=[^<>]*\bcontent\s*=\s*["']?com\.medium\.reader\b)/i;
  // What opens a block: a comment, or an element named by the first group.
  const COMMENT_RE = /<!--/g;
  const SCRIPT_RE = /<(script)\b[^<>]*>/gi;
  // Link text is left out of the count: a list of long headlines is not an article.
  const LINK_RE = /<(a)\b[^<>]*>/gi;
  const LINK_CHARS = 2000;
  const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'title', 'nav', 'footer'];
  const DROP_RE = new RegExp(`<!--|<(${DROP.join('|')})\\b`, 'gi');
  // What ends one, by that name; a comment goes by ''.
  const END_RE = { '': /-->/g };
  for (const name of [...DROP, 'a']) END_RE[name] = new RegExp(`</${name}\\s*>`, 'gi');
  // Blocks whose inside is not markup. Cut off by the end of a download, the rest of the
  // page is their source and not text.
  const RAW = new Set(['', 'script', 'style']);
  const LD_TYPE_RE = /application\/ld\+json/i;
  const META_RE = /<meta\b[^<>]*>/gi;
  const TIER_RE = /article:content_tier/i;
  const P_TAG_RE = /<(\/?)p\b[^<>]*>/gi;
  // Tags that end a run of text; any other tag (inline, custom, unknown) sits inside one.
  const BLOCK_RE = /<\/?(?:address|article|aside|blockquote|body|button|dd|details|div|dl|dt|fieldset|figcaption|figure|form|h[1-6]|head|header|hr|html|label|li|main|ol|option|p|pre|section|select|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^<>]*>/gi;
  const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', laquo: '«' };

  // Below this, the article is probably rendered by script and the source says nothing.
  const EMPTY_WORDS = 40;
  const { SHORT_WORDS, PROSE_WORDS } = S;

  // The blocks a pattern opens, each running to the first end of its kind: { open, start,
  // bodyStart, bodyEnd, end }. An opening inside a block is part of that block, and one
  // with no end further on, or none within `within` characters, is not a block. `only`
  // picks the openings that count. On a page that was `cut` off, a block of source still
  // open at the end runs to the end.
  // The end of a kind is looked for from where the last search stopped, never again over
  // the same text, so a page of openings that never close is still read once.
  function blocks(html, openRe, { only, within = Infinity, cut = false } = {}) {
    const found = [];
    const ends = {};
    openRe.lastIndex = 0;
    for (let m; (m = openRe.exec(html)); ) {
      if (only && !only.test(m[0])) continue;
      const name = (m[1] || '').toLowerCase();
      const bodyStart = openRe.lastIndex;
      if (ends[name] === undefined || (ends[name] && ends[name].index < bodyStart)) {
        const endRe = END_RE[name];
        endRe.lastIndex = bodyStart;
        const end = endRe.exec(html);
        ends[name] = end && { index: end.index, end: endRe.lastIndex };
      }
      const end = ends[name];
      if (!end) {
        if (!cut || !RAW.has(name)) continue;
        found.push({ open: m[0], start: m.index, bodyStart, bodyEnd: html.length, end: html.length });
        break;
      }
      if (end.index - bodyStart > within) continue;
      found.push({ open: m[0], start: m.index, bodyStart, bodyEnd: end.index, end: end.end });
      openRe.lastIndex = end.end;
    }
    return found;
  }

  // The page with those blocks taken out.
  function strip(html, openRe, options) {
    const kept = [];
    let at = 0;
    for (const block of blocks(html, openRe, options)) {
      kept.push(html.slice(at, block.start));
      at = block.end;
    }
    kept.push(html.slice(at));
    return kept.join(' ');
  }

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
    for (const run of strip(body, LINK_RE, { within: LINK_CHARS }).split(BLOCK_RE)) {
      const text = toText(run);
      const n = countWords(text);
      if (n >= PROSE_WORDS && !S.COOKIE_RE.test(text)) prose += n;
    }
    return Math.max(paragraphs, prose);
  }

  // Returns { verdict: 'gated' | 'free' | 'unknown', reason, platform }.
  // `truncated` means the download was cut off, so a short text proves nothing and a
  // script or style left open is cut too.
  function analyzeHtml(html, { truncated = false } = {}) {
    const platform = PLATFORM_RE.test(strip(html, COMMENT_RE));

    // A declared paywall only counts together with a prompt: metered sites declare one on
    // articles they still show in full.
    let declared = false;
    for (const script of blocks(html, SCRIPT_RE, { only: LD_TYPE_RE })) {
      declared ||= S.ldDeclaresGated(html.slice(script.bodyStart, script.bodyEnd));
    }
    for (const [meta] of html.matchAll(META_RE)) {
      if (!TIER_RE.test(meta)) continue;
      const tier = S.tierOf(/content=["']?([^"'\s>]+)/i.exec(meta)?.[1]);
      if (tier === 'locked') return { verdict: 'gated', reason: 'page metadata marks it "locked"', platform };
      declared ||= tier === 'metered';
    }
    if (CHALLENGE_RE.test(html)) return { verdict: 'unknown', reason: 'the site answered with a bot check', platform };

    const body = strip(html, DROP_RE, { cut: truncated });
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
