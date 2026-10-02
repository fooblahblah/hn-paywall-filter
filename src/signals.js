// Wording and metadata that give a gate away. Used on raw HTML by the background check
// (analyze.js) and on the rendered page by on-visit detection (detect.js).
globalThis.HNPF_SIGNALS = (() => {
  const ACT =
    '(?:subscribe|sign up|sign in|log in|login|register|join|create (?:an|a free|your) account' +
    '|become a (?:member|subscriber)|start (?:a|your) (?:free )?trial)';

  // What a gate withholds. Without it, "log in to view this page" or "register to see the
  // full agenda" would read as a prompt.
  const NOUN = '(?:articles?|story|stories|posts?|piece|essay|column|report|interview|content)';
  const TARGET = `(?:the )?(?:(?:full|entire|whole|complete) |rest of (?:this|the) |this |more )${NOUN}`;

  // Phrases that only make sense when the content is being withheld.
  const GATE_RE = new RegExp(
    [
      `\\b${ACT}\\b[^.!?]{0,60}\\bto (?:continue|keep) reading\\b`,
      `\\bto (?:continue|keep) reading\\b[^.!?]{0,60}\\b${ACT}\\b`,
      `\\b${ACT}\\b[^.!?]{0,40}\\bto (?:read|unlock|access|view|see) ${TARGET}\\b`,
      '\\bthis (?:article|story|post|content|page) is (?:only |exclusively )?(?:for|available to|reserved for|exclusive to) (?:our )?(?:paid |paying |registered |premium )?(?:subscribers|members)\\b(?! of\\b)',
      '\\b(?:subscribers?|members?)[- ]only (?:article|story|content|post)\\b',
      // A bare "hit the limit" is everyday prose; the limit has to be one on reading.
      '\\b(?:reached|hit|used up) (?:your|the) (?:monthly |free ){0,2}(?:articles? |story |stories )limit\\b',
      '\\b(?:reached|hit|used up) (?:your|the) (?:monthly )?limit (?:of|for|on) (?:free |monthly )*(?:articles|stories)\\b',
      '\\b(?:last|no more|out of|all (?:of )?your) free (?:articles?|stories|story)\\b',
      '\\bfree (?:articles?|stories|story) (?:left|remaining)\\b',
      '\\bkeep reading with a\\b[^.!?]{0,20}\\bfree trial\\b',
      '\\bunlock (?:this|the full|the rest of (?:this|the)) (?:article|story|post)\\b',
      '\\bsubscribe (?:now |today )?for (?:full|unlimited) access\\b',
      // Clubs and beta programs have members too, so those only count when they pay.
      '\\b(?:exclusive|only available|available only) (?:to|for) (?:(?:paid |paying |premium )?subscribers|(?:paid |paying |premium )members)\\b(?! of\\b)',
      `\\benter your e-?mail(?: address)? to (?:continue|keep reading|(?:read|unlock|access) ${TARGET})\\b`,
      `\\b(?:registration|a subscription|an account) is required to (?:(?:continue|keep) reading|(?:read|view|access) ${TARGET})\\b`,
    ].join('|'),
    'gi',
  );

  // Wording someone is talking about rather than being shown: it opens a quotation, or
  // carries on in lower case after "say", "told" and the like. A prompt that merely comes
  // after such a word starts a block of its own, with a capital.
  const QUOTED_RE = /(?:^|\s)"$/;
  const REPORTED_RE = /\b(?:says?|said|saying|tells?|told|telling|claim(?:s|ed|ing)?)\b,?:? "?(?:[a-z0-9][\w']* ){0,5}$/;
  const REPORTED_LOOKBACK = 80;

  // Sign-in wording that is only suspicious on a blocking overlay.
  const WEAK_RE = /\b(?:subscribe|subscription|sign in|sign up|log in|register|create (?:an |a free |your )?account|become a member)\b/i;
  const COOKIE_RE = /\b(?:cookies?|consent|gdpr|privacy (?:policy|settings|preferences|choices)|personal data|legitimate interest)\b/i;
  const DISMISS_RE = /\b(?:no,? thanks|not now|maybe later|remind me later|continue reading|continue without|skip|dismiss|close)\b/i;
  const PROMO_RE = /\b(?:newsletter|podcast)\b/i;
  const LD_RE = /"isAccessibleForFree"\s*:\s*"?false"?/i;

  function normalizeText(s) {
    return String(s || '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // The gate phrase found in already-normalized text, or null.
  function gatePhrase(text) {
    for (const m of text.matchAll(GATE_RE)) {
      if (PROMO_RE.test(m[0])) continue;
      const before = text.slice(Math.max(0, m.index - REPORTED_LOOKBACK), m.index);
      if (QUOTED_RE.test(before) || (/^[a-z0-9]/.test(m[0]) && REPORTED_RE.test(before))) continue;
      return m[0].length > 90 ? m[0].slice(0, 90) + '…' : m[0];
    }
    return null;
  }

  // schema.org structured data: publishers mark paywalled articles with isAccessibleForFree=false.
  // Metered sites set it too while still showing the whole article, so on its own it proves nothing.
  function ldDeclaresGated(json) {
    return LD_RE.test(json);
  }

  // The article:content_tier meta tag: 'locked' (never free), 'metered' (some free reads) or null.
  function tierOf(value) {
    const v = String(value || '').trim().toLowerCase();
    return v === 'locked' || v === 'metered' ? v : null;
  }

  return { WEAK_RE, COOKIE_RE, DISMISS_RE, PROMO_RE, normalizeText, gatePhrase, ldDeclaresGated, tierOf };
})();
