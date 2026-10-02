# HN Paywall Filter

A Chromium extension that hides Hacker News stories linking to sites which make you pay
or sign up before you can read.

## Screenshots

Gated stories are removed from the listing (note the gaps in the numbering), and a line
at the bottom says how many:

![Hacker News listing with gated stories hidden](docs/hn-hidden.png)

![Summary line under the listing](docs/hn-summary.png)

**show** brings them back in place, dimmed, with the reason and an undo link:

![Hidden stories shown in place with a gated label](docs/hn-shown.png)

The pinned toolbar icon counts the gated stories on the current listing:

![Toolbar icon with a badge showing 3](docs/toolbar.png)

The options page holds the detection settings and the editable site list:

![Options page](docs/options.png)

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.

After editing the code, press the reload arrow on the extension's card.

## Use

- **On Hacker News** gated stories disappear. A line at the bottom of the list says how
  many were hidden; **show** brings them back in place with the reason and an
  **always show** link. Hovering a visible story reveals **mark gated**.
- **Toolbar button** on any page: hide that page's site, or stop hiding it. Its badge
  shows the number of gated stories on an HN listing; on other pages it shows **!** if
  the site is hidden on HN and **✓** if it is always shown (needs access to all sites,
  which turning on either detector grants).
- **Options page** (opens on install, or **edit list** on HN): search, add and remove
  sites, switch any site between hidden and always shown, and turn detection on.

## How a story is judged

In this order:

1. **Your entries.** Sites you hid or set to always show. These win over everything, so
   set a site you subscribe to as always shown.
2. **Single articles.** What the detectors find applies to the article they looked at,
   not to its domain.
3. **Built-in list** in `src/seed.js`.

Two optional detectors add to the list. Both are off until you enable them on the options
page, and both need access to all sites.

- **On visit.** When you open a story from HN, the rendered page is checked for gate
  wording ("subscribe to continue reading") and sign-in overlays that block the page and
  cannot be dismissed. A hit adds the article.
- **Background check.** Stories not yet judged are fetched without cookies and the page
  source is checked for a gate prompt, either on an article that is cut short or on a
  page that declares a paywall. Verdicts are cached per article: gated for 30 days, free
  for 14, failed for 3.

One page says little about the rest of its site, and anyone can submit a link, so a
detector's verdict hides only that article. The whole site is hidden once three different
articles on it looked gated and none looked free. Sites that mix free and paid posts or
are shared by many authors (Medium, Substack, dev.to, Reddit, X and the like) are never
hidden as a whole this way; use **mark gated** if you want that.

Paywall metadata alone is not treated as proof: metered sites set it on articles they
still show in full. Such a site is only hidden once it actually shows a wall, or when you
use **mark gated**. The background check also cannot see walls added by script.

## Layout

| File | Purpose |
| --- | --- |
| `src/seed.js` | Built-in site list |
| `src/shared.js` | Domain handling, classification, storage access |
| `src/signals.js` | Gate wording and metadata checks |
| `src/analyze.js` | Verdict from page source (background check) |
| `src/detect.js` | Verdict from the rendered page (on visit) |
| `src/background.js` | Service worker: all storage writes, both detectors |
| `src/hn.js`, `src/hn.css` | Hacker News page |
| `src/options.*`, `src/popup.*` | Site list editor and toolbar popup |

## Tests

    node --test

Covers the list, classification, gate wording, page-source analysis and how the service
worker records verdicts. No dependencies.

## License

MIT. See `LICENSE`. The built-in site list started from the MIT-licensed list in
[hn-anti-paywall](https://github.com/MostlyEmre/hn-anti-paywall).
