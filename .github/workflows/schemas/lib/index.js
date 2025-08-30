const path = require("path");
const { segmentIntoBlocks } = require("./segment");
const { extractSections } = require("./sections");
const { buildDocs } = require("./normalize");
const { extractRawLinks, resolveEdges } = require("./crosslinks");
const { upsertRegistry, upsertSearch, ensureUniqueSlug } = require("./merge");
const { shardIfNeeded } = require("./shard");
const { parseROI, aggregateROI } = require("./roi");
const { computeStats } = require("./stats");
const { sha256Bytes } = require("./ids");

function toEnvelope(arr, key){ return { [key]: arr }; }
function ensureGraphShape(cross){
  if (cross && cross.nodes && cross.edges) return cross;
  return { nodes: [], edges: [] };
}

async function compose({ rawMarkdown, existing }) {
  const sourceSha = sha256Bytes(Buffer.from(rawMarkdown, "utf8"));
  const blocks = segmentIntoBlocks(rawMarkdown);

  // Build a map of known paths/slugs/titles for cross-link resolution
  const known = new Map();
  const registryExistingArr = Array.isArray(existing.registry) ? existing.registry
                           : (existing.registry?.items || existing.registry?.docs || []);
  for (const r of registryExistingArr) {
    known.set(r.path, r.path); known.set(r.slug, r.path); known.set(r.title, r.path);
  }

  let registryOut = Array.isArray(existing.registry) ? existing.registry : (existing.registry?.items || existing.registry?.docs || []);
  let searchOut   = Array.isArray(existing.search)   ? existing.search   : (existing.search?.docs || existing.search?.items || []);
  let crossOut    = ensureGraphShape(existing.cross || {});

  const takenSlugs = new Set(registryOut.map(r=>r.slug));
  const nodeByPath = new Map((crossOut.nodes||[]).map(n=>[n.path, n]));

  const roiItems = [];
  for (const b of blocks){
    const sectionData = extractSections(b.rawBlock);
    const docs = buildDocs({ rawBlock: b.rawBlock, blockNumber: b.blockNumber, headerLine: b.headerLine }, { sectionData });

    // ensure unique slug (append -2, -3…)
    const uniqueSlug = ensureUniqueSlug(docs.registry.slug, takenSlugs);
    if (uniqueSlug !== docs.registry.slug) {
      docs.registry.slug = uniqueSlug;
      docs.registry.path = `/docs/md/${uniqueSlug}.md`;
      docs.search.title = docs.registry.title; // keep title
    }

    registryOut = upsertRegistry(registryOut, docs.registry);
    searchOut   = upsertSearch(searchOut, docs.search);

    // graph nodes/edges
    if (!nodeByPath.has(docs.registry.path)) {
      const node = { id: docs.registry.id, path: docs.registry.path, title: docs.registry.title, slug: docs.registry.slug };
      crossOut.nodes.push(node); nodeByPath.set(docs.registry.path, node);
      known.set(docs.registry.path, docs.registry.path); known.set(docs.registry.slug, docs.registry.path); known.set(docs.registry.title, docs.registry.path);
    }
    const linkTargets = extractRawLinks(docs.search.content).concat(sectionData.cross_links_raw || []);
    const edges = resolveEdges(linkTargets, known).map(e=>({
      source: docs.registry.path, target: e.target, type: "ref", status: e.status
    }));
    crossOut.edges.push(...edges);

    // ROI
    roiItems.push(parseROI(docs.roi_raw));
  }

  const roiAgg = aggregateROI(roiItems);

  // Shard if needed
  const sharding = shardIfNeeded(searchOut);
  const searchPayload = sharding.single ? sharding.single : null;
  const manifest = sharding.manifest || null;
  const files = sharding.files || null;

  const stats = computeStats({
    registryArr: registryOut, searchArr: searchOut,
    nodes: crossOut.nodes || [], edges: crossOut.edges || [],
    roiAgg, sourceName: "uploaded.md", sourceSha
  });

  return { registry: registryOut, search: searchPayload, searchManifest: manifest, searchShards: files, cross: crossOut, stats };
}

module.exports = { compose };
