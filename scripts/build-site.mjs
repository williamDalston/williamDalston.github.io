// Rebuilds index.html from whatever is actually live on the App Store.
//
//   node scripts/build-site.mjs          write index.html (and fetch any new icons)
//   node scripts/build-site.mjs --check  exit 1 if the page is out of date, write nothing
//
// The only hand-edited inputs are data/curation.json and scripts/page.css.
// A newly approved app shows up on its own; an app listed under comingSoon
// drops out of that section the day it goes live.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const curation = JSON.parse(readFileSync(join(ROOT, 'data/curation.json'), 'utf8'));
const css = readFileSync(join(ROOT, 'scripts/page.css'), 'utf8');

const MANIFEST_PATH = join(ROOT, 'data/manifest.json');
const manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : {};

// ── text helpers ──────────────────────────────────────────────────────────

/** House style: no em dashes, anywhere, including in copy Apple wrote. */
function deDash(s) {
  return String(s)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',');
}

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];

/** Spelled-out numbers read better than digits in a sentence. */
function spell(n) {
  if (n < 20) return ONES[n];
  if (n > 99) return String(n);
  const t = TENS[Math.floor(n / 10)];
  const o = n % 10;
  const word = o ? `${t}-${ONES[o]}` : t;
  return word;
}

const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Soapbox: Daily Speech Coach" -> "Soapbox". The subtitle carries the rest. */
function autoName(trackName) {
  const cut = trackName.split(':')[0].trim();
  return cut.length >= 3 ? cut : trackName.trim();
}

/** Fall back to the opening line of the store description. */
function autoSub(desc) {
  if (!desc) return '';
  let first = desc.split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (first.length > 78) {
    const sentence = first.split(/(?<=[.!?])\s/)[0];
    first = sentence.length <= 78
      ? sentence
      : first.slice(0, 75).replace(/\s+\S*$/, '') + '...';
  }
  return deDash(first).replace(/\.$/, '');
}

// ── fetch what is live ────────────────────────────────────────────────────

async function fetchApps() {
  // SITE_FIXTURE lets the tests run the real pipeline without the network.
  if (process.env.SITE_FIXTURE) {
    const fx = JSON.parse(readFileSync(process.env.SITE_FIXTURE, 'utf8'));
    return (fx.results || []).filter((r) => r.wrapperType === 'software');
  }
  const url = `https://itunes.apple.com/lookup?id=${curation.artistId}` +
              `&entity=software&limit=200&country=us`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes lookup failed: HTTP ${res.status}`);
  const body = await res.json();
  const apps = (body.results || []).filter((r) => r.wrapperType === 'software');

  // Refuse to publish a gutted page because the API had a bad minute.
  if (apps.length < 5) {
    throw new Error(`only ${apps.length} apps returned, refusing to rebuild`);
  }
  return apps;
}

async function ensureIcon(app) {
  const id = String(app.trackId);
  const src = (app.artworkUrl512 || app.artworkUrl100 || '')
    .replace(/\/\d+x\d+bb\.(jpg|png)$/, '/256x256bb.png');
  const file = join(ROOT, 'icons', `${id}.png`);

  if (existsSync(file) && manifest[id] === src) return;
  if (CHECK) return; // --check never writes

  const res = await fetch(src);
  if (!res.ok) throw new Error(`icon fetch failed for ${id}: HTTP ${res.status}`);
  mkdirSync(join(ROOT, 'icons'), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  manifest[id] = src;
  console.log(`icon updated: ${id}`);
}

// ── shape the data ────────────────────────────────────────────────────────

function organise(apps) {
  const order = Object.keys(curation.apps);
  const excluded = new Set((curation.exclude || []).map(String));

  const items = apps
    .filter((a) => !excluded.has(String(a.trackId)))
    .map((a) => {
      const id = String(a.trackId);
      const over = curation.apps[id] || {};
      const rank = order.indexOf(id);
      return {
        id,
        group: over.group || curation.genreToGroup[a.primaryGenreName] || curation.fallbackGroup,
        name: deDash(over.name || autoName(a.trackName)),
        sub: deDash(over.sub || autoSub(a.description)),
        price: a.formattedPrice && a.formattedPrice !== 'Free' ? a.formattedPrice : null,
        // curated apps keep their hand-set order; anything new sorts in after
        rank: rank === -1 ? 9999 : rank,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const live = new Set(items.map((i) => i.id));

  const groups = curation.groups
    .map((g) => ({ ...g, apps: items.filter((i) => i.group === g.id) }))
    .filter((g) => g.apps.length > 0);

  // An app that shipped is no longer coming soon.
  const soon = (curation.comingSoon || []).filter((s) => !live.has(String(s.id)));

  return { items, groups, soon };
}

// ── render ────────────────────────────────────────────────────────────────

// Icons above the fold load eagerly; everything below waits.
let painted = 0;

function card(app, i) {
  const lazy = painted++ < 6 ? '' : ' loading="lazy"';
  return `    <a class="card" style="--i:${i}" href="https://apps.apple.com/app/id${app.id}">
      <div class="iconwrap"><img class="icon" src="/icons/${app.id}.png" alt="${esc(app.name)} app icon" width="58" height="58"${lazy}></div>
      <div class="text">
        <div class="name">${esc(app.name)}</div>
        <div class="sub">${esc(app.sub)}</div>${
    app.price ? `\n        <span class="price">${esc(app.price)}</span>` : ''
  }
      </div>
    </a>`;
}

function soonCard(app, i) {
  return `    <div class="card soon" style="--i:${i}">
      <div class="iconwrap"><div class="icon placeholder" aria-hidden="true">${esc(app.name.trim()[0])}</div></div>
      <div class="text">
        <div class="name">${esc(app.name)}</div>
        <div class="sub">${esc(deDash(app.sub))}</div>
      </div>
    </div>`;
}

function render({ items, groups, soon }) {
  const n = items.length;
  const count = sentenceCase(spell(n));
  const fill = (s) => deDash(String(s).replace(/\{N\}/g, count));

  const headline = fill(curation.headline);
  const intro = fill(curation.intro);
  const desc = fill(curation.description);
  const ogIcon = items[0] ? items[0].id : '';

  const sections = groups.map((g) => `
<section>
  <div class="head"><h2>${esc(g.title)}</h2><div class="rule"></div></div>${
    g.note ? `\n  <p class="note">${esc(deDash(g.note))}</p>` : ''
  }
  <div class="grid">
${g.apps.map(card).join('\n')}
  </div>
</section>`).join('\n');

  const soonSection = soon.length ? `
<section>
  <div class="head"><h2>Coming soon</h2><div class="rule"></div></div>
  <div class="grid">
${soon.map(soonCard).join('\n')}
  </div>
</section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>William Alston Apps</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://williamdalston.github.io/">
<meta property="og:type" content="website">
<meta property="og:title" content="William Alston Apps">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://williamdalston.github.io/">
<meta property="og:image" content="https://williamdalston.github.io/icons/${ogIcon}.png">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%237d9478'/%3E%3C/svg%3E">
<link rel="apple-touch-icon" href="/icons/${ogIcon}.png">
<!-- Generated by scripts/build-site.mjs. Edit data/curation.json, not this file. -->
<style>
${css.trim().split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>${esc(headline)}</h1>
  <p class="intro">${esc(intro)}</p>
  <div class="metarow">
    <span class="count">${n} on the App Store</span>${
    curation.contactEmail
      ? `\n    <a class="contact" href="mailto:${esc(curation.contactEmail)}">` +
        `<span class="label">${esc(curation.contactLabel || 'Get in touch')}:</span> ` +
        `${esc(curation.contactEmail)}</a>`
      : ''
  }
  </div>
</header>
${sections}
${soonSection}

<footer>
  <span>&copy; ${new Date().getUTCFullYear()} William Alston</span>${
    curation.contactEmail
      ? `\n  <span class="sep">&middot;</span>\n  ` +
        `<a href="mailto:${esc(curation.contactEmail)}">${esc(curation.contactEmail)}</a>`
      : ''
  }
  <span class="sep">&middot;</span>
  <a href="/app-policies/support.html">Support</a>
  <span class="sep">&middot;</span>
  <a href="/app-policies/privacy.html">Privacy</a>
</footer>

</div>
</body>
</html>
`;
}

// ── go ────────────────────────────────────────────────────────────────────

const apps = await fetchApps();
for (const a of apps) await ensureIcon(a);

const html = render(organise(apps));
const target = join(ROOT, 'index.html');
const current = existsSync(target) ? readFileSync(target, 'utf8') : '';

if (html.includes('—') || html.includes('–')) {
  throw new Error('em or en dash reached the output, refusing to write');
}

if (CHECK) {
  if (html !== current) {
    console.error('index.html is out of date. Run: node scripts/build-site.mjs');
    process.exit(1);
  }
  console.log(`up to date (${apps.length} apps live)`);
} else {
  writeFileSync(target, html);
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + '\n');
  console.log(
    html === current
      ? `no change (${apps.length} apps live)`
      : `index.html rebuilt (${apps.length} apps live)`
  );
}
