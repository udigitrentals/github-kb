function computeStats({ registryArr, searchArr, nodes, edges, roiAgg, sourceName, sourceSha }) {
  const uniqueTags = new Set();
  for (const r of registryArr) (r.tags||[]).forEach(t=>uniqueTags.add(t));
  const unresolved = edges.filter(e=>e.status==="pending").length;
  const degree = new Map();
  nodes.forEach(n=>degree.set(n.path,0));
  edges.forEach(e=>{
    if (degree.has(e.source)) degree.set(e.source, degree.get(e.source)+1);
    if (degree.has(e.target)) degree.set(e.target, degree.get(e.target)+1);
  });
  const orphans = Array.from(degree.values()).filter(d=>d===0).length;
  return {
    ts: new Date().toISOString(),
    counts: {
      registry_items: registryArr.length, search_docs: searchArr.length,
      nodes: nodes.length, edges: edges.length,
      unique_tags: uniqueTags.size, unresolved_edges: unresolved, orphans_est: orphans
    },
    delta: { registry_items: 0, search_docs: 0, edges: 0 }, // fill if you track prev
    roi: roiAgg,
    ingest: { source_markdown: sourceName, sha256: sourceSha, git_sha: "" }
  };
}
module.exports = { computeStats };
