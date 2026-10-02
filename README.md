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
  **always show** link. Hovering a visible story reveals **mark gated**, which hides its
  site. Where the story has no site of its own the link reads **hide this article** and
  hides that story alone: on a platform many authors share (`medium.com/@someone`, but
  not `someone.medium.com`), on a host that is no domain name (an IP address,
  `localhost`) and on one that is itself a shared name (`www.gov.uk`). Not where the
  site is set to always show, which would win.
- **Toolbar button** on any page: hide that page's site or the one article, or stop
  hiding it. Its badge
  shows the number of gated stories on an HN listing; on other pages it shows **!** if
  the site is hidden on HN and **✓** if it is always shown (needs access to all sites,
  which turning on either detector grants).
- **Options page** (opens on install, or **edit list** on HN): search, add and remove
  sites, switch any site between hidden and always shown, and turn detection on.

A site is a registrable domain or a name below it. Where it starts is read off the
[public suffix list](https://publicsuffix.org/) in `src/psl.js`: a story on
`myapp.herokuapp.com` or `www.soumu.go.jp` belongs to that app or ministry, not to
`herokuapp.com` or `go.jp`. Such a shared name cannot be put on the list at all, nor can
an IP address or a bare machine name; a refused name is reported with the reason.

## How a story is judged

In this order:

1. **Your entries.** Sites you hid or set to always show. These win over everything, so
   set a site you subscribe to as always shown. They never expire: an entry of yours stays
   until you remove it. An entry covers the subdomains of its site, and the one nearest
   to the story decides, ahead of anything a detector found on a subdomain. An article
   you hid yourself stays hidden the same way, unless its site is set to always show.
2. **Sites the detectors hid**, unless you chose **show this article** for the story.
   That choice is yours too and does not expire: it stays until you remove it on the
   options page. It does not show an article on a site you hid yourself.
3. **Single articles.** What the detectors find applies to the article they looked at,
   not to its domain.
4. **Built-in list** in `src/seed.js`.

Two optional detectors add to the list. Both are off until you enable them on the options
page, and both need access to all sites.

- **On visit.** When you open a story from HN, the rendered page is checked for gate
  wording ("subscribe to continue reading") and sign-in overlays that block the page and
  cannot be dismissed. An offer shown by Piano, whose wording cannot be read, counts only
  when Piano says it has no close button: the same box carries donation appeals and
  newsletter offers over an article that is there in full. Wording in a paywall box or
  an overlay counts as it stands; anywhere else on the page it only counts when the
  article is withheld: the page is covered, cannot be scrolled, or has little text. A
  count of free articles left never counts on its own. A hit hides the article for 30
  days; a page that showed no wall counts as a free article on its site, unless it
  carried such wording, in which case nothing is recorded. Nor is anything recorded for a
  Piano offer that shows no close button without saying that it has none (which is most
  of those built from a template, walls included), or for one that can be closed over a
  page with little text. A wall that only appears once you scroll further replaces that
  record. Only the page you opened is judged: if the site moves on to another address
  without a reload, nothing is recorded either.
- **Background check.** Stories not yet judged are fetched without cookies and the page
  source is checked for a gate prompt, either on an article that is cut short or on a
  page that declares a paywall. Verdicts are cached per article: gated for 30 days, free
  for 14, failed for 3.
  Only the first 1.5 MB of a page are read, and judging them takes time in proportion to
  their length whatever the page holds: a fraction of a second at most. A page cut off
  at that limit is never judged gated for being short.
  Since anyone can submit a link and the request leaves from your own network, only
  `https` links to a public host name on the default port are fetched: never an IP
  address, `localhost`, a bare machine name or a name such as `.local`, `.lan` or
  `.internal`. Redirects are not followed: a link that only gains `www.` or a
  trailing slash is still judged when you open it, one that leads to another address
  is judged by neither detector. What the name cannot tell is where it resolves: a
  machine inside your network that holds a trusted certificate for a public name (an
  intranet host under a company domain, say) can still receive the request.

One page says little about the rest of its site, and anyone can submit a link, so a
detector's verdict hides only that article. The whole site is hidden, for 30 days, once
three articles at different paths on it looked gated within two weeks and none looked free (or was
set to **show this article**) in that time. When that happens, a line at the top of the
HN listing names the site and offers **always show**. A fixed list of platforms that mix free and
paid posts or are shared by many authors (`MIXED` in `src/shared.js`: Medium, Substack,
dev.to, Reddit, X and others) and personal `/~user` pages are never hidden as a whole this
way, and neither is a host that is no domain name. To hide a whole platform all the same,
add it on the options page or with the toolbar button (which works for `medium.com`, not
for a platform that is a public suffix, such as `notion.site`). Removing a site the detectors hid
from the list also forgets the articles it rested on.

Paywall metadata alone is not treated as proof: metered sites set it on articles they
still show in full. Such a site is only hidden once it actually shows a wall, or when you
use **mark gated**. The background check also cannot see walls added by script.

## Layout

| File | Purpose |
| --- | --- |
| `src/seed.js` | Built-in site list |
| `src/psl.js` | Public suffix list, rebuilt by `node tools/update-psl.mjs` |
| `src/shared.js` | Domain handling, classification, storage access |
| `src/signals.js` | Gate wording and metadata checks |
| `src/analyze.js` | Verdict from page source (background check) |
| `src/detect.js` | Verdict from the rendered page (on visit) |
| `src/background.js` | Service worker: all storage writes, both detectors |
| `src/hn.js`, `src/hn.css` | Hacker News page |
| `src/options.*`, `src/popup.*` | Site list editor and toolbar popup |

## Tests

    node --test

Covers the list, classification, gate wording, page-source analysis, on-visit detection
(against a stand-in for the page) and how the service worker records verdicts. No
dependencies.

## License

MIT. See `LICENSE`. The built-in site list started from the MIT-licensed list in
[hn-anti-paywall](https://github.com/MostlyEmre/hn-anti-paywall), itself taken from
Bypass Paywalls, which was MIT-licensed until 2020. `src/psl.js` holds the
[public suffix list](https://publicsuffix.org/), which is under the
[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/). `THIRD_PARTY_NOTICES` has the
notices of the two lists and says where the public suffix list's is.
