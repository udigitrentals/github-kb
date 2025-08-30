#!/usr/bin/env node
/**
 * kb_sync_merge.js
 * Append-only, safe merger for KB registry/cross_links/search JSON using delta files.
 * Usage:
 *   node kb_sync_merge.js --in ./kb_current --delta ./kb_deltas --out ./kb_merged
 * Notes:
 *   - If input files are missing, skeletons are created.
 *   - Delta files can be multiple; all JSONs in --delta will be consumed.
 *   - Dedup rules:
 *       registry.items: by id
 *       cross_links.edges: by (source,target,rel)
 *       search.docs: by id
 */
const fs = require('fs');
const path = require('path');

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function uniqBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, item);
    else {
      // Merge shallow (prefer delta item fields over existing)
      map.set(key, { ...map.get(key), ...item });
    }
  }
  return Array.from(map.values());
}

function glueEdges(edges) {
  const key = (e) => `${e.source}::${e.target}::${e.rel}`;
  return uniqBy(edges, key);
}

function nowISO() {
  return new Date().toISOString();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (!k.startsWith('--')) continue;
    const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
    if (k === '--in') out.in = v;
    if (k === '--delta') out.delta = v;
    if (k === '--out') out.out = v;
  }
  if (!out.in || !out.delta || !out.out) {
    console.error('Usage: node kb_sync_merge.js --in <dir> --delta <dir> --out <dir>');
    process.exit(1);
  }
  return out;
}

function main() {
  const { in: inDir, delta: deltaDir, out: outDir } = parseArgs();
  ensureDir(outDir);

  const registryPath = path.join(inDir, 'registry.json');
  const crossLinksPath = path.join(inDir, 'cross_links.json');
  const searchPath = path.join(inDir, 'search.json');

  const registry = readJSON(registryPath, { schema_version: 1, updated_at: nowISO(), items: [] });
  const crossLinks = readJSON(crossLinksPath, { schema_version: 1, updated_at: nowISO(), edges: [] });
  const search = readJSON(searchPath, { schema_version: 1, updated_at: nowISO(), docs: [] });

  // Load deltas
  const deltaFiles = fs.readdirSync(deltaDir).filter(f => f.endsWith('.json'));
  let applied = [];
  for (const file of deltaFiles) {
    const p = path.join(deltaDir, file);
    let delta;
    try { delta = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.warn(`Skipping invalid JSON: ${file}`); continue; }

    if (delta.schema === 'registry' && Array.isArray(delta.items)) {
      registry.items = uniqBy([...(registry.items || []), ...delta.items], x => x.id);
      applied.push({ file, type: 'registry', count: delta.items.length });
    }
    if (delta.schema === 'cross_links' && Array.isArray(delta.edges)) {
      crossLinks.edges = glueEdges([...(crossLinks.edges || []), ...delta.edges]);
      applied.push({ file, type: 'cross_links', count: delta.edges.length });
    }
    if (delta.schema === 'search' && Array.isArray(delta.docs)) {
      search.docs = uniqBy([...(search.docs || []), ...delta.docs], x => x.id);
      applied.push({ file, type: 'search', count: delta.docs.length });
    }
  }

  const outRegistry = path.join(outDir, 'registry.json');
  const outCrossLinks = path.join(outDir, 'cross_links.json');
  const outSearch = path.join(outDir, 'search.json');

  registry.updated_at = nowISO();
  crossLinks.updated_at = nowISO();
  search.updated_at = nowISO();

  fs.writeFileSync(outRegistry, JSON.stringify(registry, null, 2));
  fs.writeFileSync(outCrossLinks, JSON.stringify(crossLinks, null, 2));
  fs.writeFileSync(outSearch, JSON.stringify(search, null, 2));

  console.log('Merge completed.');
  console.table(applied);
  console.log('Outputs:', { outRegistry, outCrossLinks, outSearch });
}

main();
