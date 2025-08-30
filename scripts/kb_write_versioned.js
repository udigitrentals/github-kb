#!/usr/bin/env node
/**
 * kb_write_versioned.js
 * Copies merged JSONs from ./kb_merged into ./docs and ./docs/v{N}/
 * Usage:
 *   node scripts/kb_write_versioned.js --version 1
 */
const fs = require('fs');
const path = require('path');
function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx+1]) return process.argv[idx+1];
  return fallback;
}
const version = arg('version', process.env.KB_VERSION || '1');
const srcDir = path.resolve(process.cwd(), 'kb_merged');
const docsDir = path.resolve(process.cwd(), 'docs');
const verDir = path.join(docsDir, `v${version}`);

if (!fs.existsSync(srcDir)) throw new Error(`Missing ${srcDir} — run merge first`);
fs.mkdirSync(docsDir, { recursive: true });
fs.mkdirSync(verDir, { recursive: true });

for (const name of ['registry.json','cross_links.json','search.json']) {
  const src = path.join(srcDir, name);
  if (!fs.existsSync(src)) throw new Error(`Missing ${src}`);
  const dstA = path.join(docsDir, name);
  const dstB = path.join(verDir, name);
  fs.copyFileSync(src, dstA);
  fs.copyFileSync(src, dstB);
  console.log('Wrote', dstA);
  console.log('Wrote', dstB);
}
console.log('Done.');
