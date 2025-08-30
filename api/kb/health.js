const fs = require('fs').promises;
const path = require('path');

module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    const docsDir = path.join(process.cwd(), 'docs');
    const [rS, sS, xS] = await Promise.all([
      fs.readFile(path.join(docsDir, 'registry.json'), 'utf8'),
      fs.readFile(path.join(docsDir, 'search.json'), 'utf8'),
      fs.readFile(path.join(docsDir, 'cross_links.json'), 'utf8')
    ]);
    const reg = JSON.parse(rS), sea = JSON.parse(sS), xln = JSON.parse(xS);

    const regArr = Array.isArray(reg) ? reg : Array.isArray(reg?.items) ? reg.items : Array.isArray(reg?.registry) ? reg.registry : [];
    const seaArr = Array.isArray(sea) ? sea : Array.isArray(sea?.docs) ? sea.docs : Array.isArray(sea?.items) ? sea.items : [];
    let edges = [];
    if (Array.isArray(xln?.edges)) edges = xln.edges;
    else if (Array.isArray(xln?.graph?.edges)) edges = xln.graph.edges;

    const uniqueTags = new Set();
    for (const d of seaArr) if (Array.isArray(d?.tags)) for (const t of d.tags) uniqueTags.add(String(t).toLowerCase());

    const unresolved = edges.filter(e => !e?.source || !e?.target).length;

    const out = {
      ok: true,
      ts: new Date().toISOString(),
      counts: {
        registry_items: regArr.length,
        search_docs: seaArr.length,
        edges: edges.length,
        unique_tags: uniqueTags.size,
        unresolved_edges: unresolved
      },
      sizes_kb: {
        registry_kb: Math.round(Buffer.byteLength(rS) / 1024),
        search_kb:   Math.round(Buffer.byteLength(sS) / 1024),
        cross_kb:    Math.round(Buffer.byteLength(xS) / 1024)
      },
      health: {
        size_ok: Math.round(Buffer.byteLength(sS)/1024) <= 5000 &&
                 Math.round(Buffer.byteLength(rS)/1024) <= 2000 &&
                 Math.round(Buffer.byteLength(xS)/1024) <= 5000,
        graph_ok: unresolved <= 250
      },
      elapsed_ms: Date.now() - t0
    };

    console.log(JSON.stringify({ event: 'kb.health', ...out }));
    return res.status(200).json(out);
  } catch (e) {
    console.error(JSON.stringify({ event: 'kb.health.error', error: String(e?.message || e) }));
    return res.status(500).json({ ok: false, error: 'health_failed', detail: String(e?.message || e) });
  }
};
