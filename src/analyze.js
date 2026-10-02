// Judges a fetched page from its HTML source alone (the service worker has no DOM).
// Catches locked articles and ones that show a gate prompt; overlay and metered walls that
// let the reader through are left to on-visit detection.
globalThis.HNPF_ANALYZE = (() => {
  const S = HNPF_SIGNALS;

  const CHALLENGE_RE = /<title[^>]*>\s*(?:just a moment|attention required|access denied|are you a robot|verif(?:y|ying) (?:you are|you're) (?:a )?human|pardon our interruption|security check)/i;
  const PLATFORM_RE = /substackcdn\.com|cdn-client\.medium\.com/i;
  const LD_BLOCK_RE = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  const TIER_RE = /<meta[^>]+article:content_tier[^>]*>/gi;
  const DROP_RE = /<!--[\s\S]*?-->|<(script|style|noscript|template|svg|nav|footer)\b[\s\S]*?<\/\1\s*>/gi;
  const PARAGRAPH_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lsquo: "'", rsquo: "'", '#39': "'", '#x27': "'", '#8216': "'", '#8217': "'" };

  // Below this many words of paragraph text, a page with a gate phrase counts as cut short.
  const SHORT_WORDS = 350;
  // Below this, the article is probably rendered by script and the source says nothing.
  const EMPTY_WORDS = 40;

  function toText(html) {
    const plain = html.replace(/<[^>]+>/g, ' ').replace(/&(#?\w+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? ' ');
    return S.normalizeText(plain);
  }

  function countWords(text) {
    return text ? text.split(' ').length : 0;
  }

  // Returns { verdict: 'gated' | 'free' | 'unknown', reason, platform }.
  // `truncated` means the download was cut off, so a short text proves nothing.
  function analyzeHtml(html, { truncated = false } = {}) {
    const platform = PLATFORM_RE.test(html);

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
    let words = 0;
    for (const m of body.matchAll(PARAGRAPH_RE)) words += countWords(toText(m[1]));
    const phrase = S.gatePhrase(toText(body));

    if (phrase && declared) {
      return { verdict: 'gated', reason: `page declares a paywall and shows a prompt: “${phrase}”`, platform };
    }
    if (phrase && words < SHORT_WORDS && !truncated) {
      return { verdict: 'gated', reason: `page is cut short with a prompt: “${phrase}”`, platform };
    }
    if (!phrase && words < EMPTY_WORDS) return { verdict: 'unknown', reason: 'page text is loaded by script', platform };
    return { verdict: 'free', reason: '', platform };
  }

  return { analyzeHtml };
})();
