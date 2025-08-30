const fs = require('fs').promises;
const path = require('path');

module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    const docsDir = path.join(process.cwd(), 'docs');
    const [regS, seaS, xlnS] = await Promise.all([
      fs.readFile(path.join(docsDir, 'registry.json'), 'utf8'),
      fs.readFile(path.join(docsDir, 'search.json'), 'utf8'),
      fs.readFile(path.join(docsDir, 'cross_links.json'), 'utf8')
    ]);

    const registry = JSON.parse(regS);
    const search   = JSON.parse(seaS);
    const cross    = JSON.parse(xlnS);

    // Normalize shapes (we tolerate arrays vs {items/docs})
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

    // Metrics
    const uniqueTags = new Set();
    for (const d of searchArr) {
      if (Array.isArray(d.tags)) for (const t of d.tags) uniqueTags.add(String(t).toLowerCase());
    }
    const unresolved = edges.filter(e => !e.target || !e.source);
    const orphanCandidates = new Set(
      searchArr.map(d => d.id).filter(Boolean)
    );
    for (const e of edges) {
      if (e.source) orphanCandidates.delete(e.source);
      if (e.target) orphanCandidates.delete(e.target);
    }

    const sizes = {
      registry_kb: Math.round(Buffer.byteLength(regS, 'utf8') / 1024),
      search_kb:   Math.round(Buffer.byteLength(seaS, 'utf8') / 1024),
      cross_kb:    Math.round(Buffer.byteLength(xlnS, 'utf8') / 1024)
    };

    const updatedAt = search?.updated_at || registry?.updated_at || cross?.updated_at || null;

    const out = {
      ok: true,
      ts: new Date().toISOString(),
      updated_at: updatedAt,
      counts: {
        registry_items: registryArr.length,
        search_docs: searchArr.length,
        edges: edges.length,
        nodes: nodes.length,
        unique_tags: uniqueTags.size,
        unresolved_edges: unresolved.length,
        orphans_est: orphanCandidates.size
      },
      sizes_kb: sizes,
      thresholds: {
        search_max_kb: 5000,   // adjust if needed
        registry_max_kb: 2000,
        cross_max_kb: 5000,
        unresolved_max: 250,
        orphans_max: 250
      },
      elapsed_ms: Date.now() - t0
    };

    // Simple health flags
    out.health = {
      size_ok: sizes.search_kb <= out.thresholds.search_max_kb
            && sizes.registry_kb <= out.thresholds.registry_max_kb
            && sizes.cross_kb <= out.thresholds.cross_max_kb,
      graph_ok: unresolved.length <= out.thresholds.unresolved_max
            && orphanCandidates.size <= out.thresholds.orphans_max
    };

    console.log(JSON.stringify({ event: 'kb.health', ...out }));
    res.status(200).json(out);
  } catch (e) {
    console.error(JSON.stringify({ event: 'kb.health.error', error: String(e?.message || e) }));
    res.status(500).json({ ok: false, error: 'health_failed', detail: String(e?.message || e) });
  }
};
