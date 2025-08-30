const fs = require('fs');
const path = require('path');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function compute(registry, search, cross) {
  const registryArr = Array.isArray(registry) ? registry
                    : Array.isArray(registry?.items) ? registry.items
                    : Array.isArray(registry?.registry) ? registry.registry : [];
  const searchArr   = Array.isArray(search) ? search
                    : Array.isArray(search?.docs) ? search.docs
                    : Array.isArray(search?.items) ? search.items : [];
  const edges       = Array.isArray(cross?.edges) ? cross.edges
                    : Array.isArray(cross?.graph?.edges) ? cross.graph.edges : [];
  const nodes       = Array.isArray(cross?.nodes) ? cross.nodes
                    : Array.isArray(cross?.graph?.nodes) ? cross.graph.nodes : [];
  const uniqueTags  = new Set();
  for (const d of searchArr) if (Array.isArray(d.tags)) for (const t of d.tags) uniqueTags.add(String(t).toLowerCase());

  return {
    ts: new Date().toISOString(),
    counts: {
      registry_items: registryArr.length,
      search_docs: searchArr.length,
      nodes: nodes.length,
      edges: edges.length,
      unique_tags: uniqueTags.size
    }
  };
}

(function main() {
  const root = process.cwd();
  const docsDir = path.join(root, 'docs');
  const reg = readJson(path.join(docsDir, 'registry.json'));
  const sea = readJson(path.join(docsDir, 'search.json'));
  const xln = readJson(path.join(docsDir, 'cross_links.json'));

  const stats = compute(reg, sea, xln);

  const histPath = path.join(docsDir, 'kb_health_history.json');
  let hist = [];
  if (fs.existsSync(histPath)) {
    hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  }
  hist.push(stats);
  if (hist.length > 365) hist = hist.slice(-365);
  fs.writeFileSync(histPath, JSON.stringify(hist, null, 2));
  fs.writeFileSync(path.join(docsDir, 'kb_stats.json'), JSON.stringify(stats, null, 2));

  console.log('Health updated', stats);
})();
