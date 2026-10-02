// Wording and metadata that give a gate away. Used on raw HTML by the background check
// (analyze.js) and on the rendered page by on-visit detection (detect.js).
globalThis.HNPF_SIGNALS = (() => {
  const ACT =
    '(?:subscribe|sign up|sign in|log in|login|register|join|create (?:an|a free|your) account' +
    '|become a (?:member|subscriber)|start (?:a|your) (?:free )?trial)';

  // Phrases that only make sense when the content is being withheld.
  const GATE_RE = new RegExp(
    [
      `\\b${ACT}\\b[^.!?]{0,60}\\bto (?:continue|keep) reading\\b`,
      `\\bto (?:continue|keep) reading\\b[^.!?]{0,60}\\b${ACT}\\b`,
      `\\b${ACT}\\b[^.!?]{0,40}\\bto (?:read|unlock|access|view|see)\\b[^.!?]{0,30}\\b(?:full|rest|entire|whole|this|more)\\b`,
      '\\bthis (?:article|story|post|content|page) is (?:only |exclusively )?(?:for|available to|reserved for|exclusive to) (?:our )?(?:paid |paying |registered |premium )?(?:subscribers|members)\\b',
      '\\b(?:subscribers?|members?)[- ]only (?:article|story|content|post)\\b',
      '\\b(?:reached|hit|used up) (?:your|the) (?:monthly |free |article |story ){0,3}limit\\b',
      '\\b(?:last|no more|out of|all (?:of )?your) free (?:articles?|stories|story)\\b',
      '\\bfree (?:articles?|stories|story) (?:left|remaining)\\b',
      '\\bkeep reading with a\\b[^.!?]{0,20}\\bfree trial\\b',
      '\\bunlock (?:this|the full|the rest of (?:this|the)) (?:article|story|post)\\b',
      '\\bsubscribe (?:now |today )?for (?:full|unlimited) access\\b',
      '\\b(?:exclusive|only available|available only) (?:to|for) (?:paid |paying )?(?:subscribers|members)\\b',
      '\\benter your e-?mail(?: address)? to (?:continue|read|unlock|access|keep reading)\\b',
      '\\b(?:registration|a subscription|an account) is required to (?:read|continue|view|access)\\b',
    ].join('|'),
    'i',
  );

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
    const m = GATE_RE.exec(text);
    if (!m || PROMO_RE.test(m[0])) return null;
    return m[0].length > 90 ? m[0].slice(0, 90) + '…' : m[0];
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
