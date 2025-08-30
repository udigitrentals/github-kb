#!/usr/bin/env node
/**
 * kb_build_bundle.js
 * Builds bundle.json with sha256 for registry.json, cross_links.json, search.json and extra files.
 * Usage:
 *   node scripts/kb_build_bundle.js --src ./docs --out ./bundle.json --extra ./docs/*.md
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx+1]) return process.argv[idx+1];
  return fallback;
}

const src = arg('src', './docs');
const out = arg('out', './bundle.json');

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function listFiles(dir, allow = new Set(['registry.json','cross_links.json','search.json'])) {
  const names = fs.readdirSync(dir);
  const chosen = [];
  for (const n of names) {
    if (allow.size === 0 || allow.has(n) || n.toLowerCase().endsWith('.md') || n.toLowerCase().endsWith('.pdf')) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isFile()) chosen.push({ path: n, abs: p });
    }
  }
  return chosen;
}

const files = listFiles(src, new Set(['registry.json','cross_links.json','search.json']));
const now = new Date().toISOString();
const manifest = {
  schema: "udigit.kb.bundle/1.0",
  built_utc: now,
  kb: {
    entries_total: files.length,
    encyclopedia_versions: { min: 0, max: 0 }
  },
  files: files.map(f => ({ path: f.path, sha256: sha256(f.abs) }))
};

fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log('Wrote', out);
