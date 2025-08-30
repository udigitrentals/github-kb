#!/usr/bin/env node
/**
 * kb_fetch_current.js
 * Fetches the three canonical KB JSONs from RAW GitHub into ./kb_current
 * Usage:
 *   node scripts/kb_fetch_current.js --base https://raw.githubusercontent.com/udigitrentals/github-kb/main/docs
 */
const fs = require('fs');
const path = require('path');
const { argv } = require('process');

function arg(name, fallback) {
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx+1]) return argv[idx+1];
  return fallback;
}

const base = arg('base', 'https://raw.githubusercontent.com/udigitrentals/github-kb/main/docs');
const outDir = path.resolve(process.cwd(), 'kb_current');
fs.mkdirSync(outDir, { recursive: true });

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

(async () => {
  const files = ['registry.json','cross_links.json','search.json'];
  for (const f of files) {
    const url = `${base}/${f}`;
    const txt = await fetchText(url);
    const p = path.join(outDir, f);
    fs.writeFileSync(p, txt, 'utf8');
    console.log('Saved', p);
  }
  console.log('Done. Current KB saved in', outDir);
})().catch(err => { console.error(err); process.exit(1); });
