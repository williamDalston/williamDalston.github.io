# williamdalston.github.io

The apps page at <https://williamdalston.github.io/>.

## It updates itself

`index.html` is generated, not hand-written. A GitHub Action runs every morning,
asks the App Store which apps are live under developer id `1681395170`, and
rebuilds the page if anything changed. An app that gets approved appears on its
own, with its real icon, within a day. **Do not edit `index.html`.**

## The one file you edit

`data/curation.json` holds the things the App Store cannot tell us: which group
an app belongs in, and the short line under its name.

An app that is not listed there still shows up. It gets its name from the store
listing (anything after a colon is dropped, since the subtitle says it), its
subtitle from the first line of its store description, and its group from its
App Store category. So the page is never wrong, just less polished, until you
write it a better line.

Other things worth knowing:

- `comingSoon` entries vanish from that section the day the app goes live, and
  reappear in their real group. Give an unreleased app an entry under `apps` too
  and it will land in the right place with the right words on day one.
- `exclude` takes app ids you never want listed.
- Prices come from the store. Only paid apps show a price.
- Em dashes are stripped from anything Apple wrote. The build fails if one
  reaches the output.

## Running it by hand

```bash
node scripts/build-site.mjs           # rebuild (also fetches any new icons)
node scripts/build-site.mjs --check   # exit 1 if out of date, write nothing
```

Styling lives in `scripts/page.css` and is inlined into the page at build time.
`data/manifest.json` records which icon artwork has been downloaded; it is
generated. Icons are committed so the page stays self-contained and fast.
