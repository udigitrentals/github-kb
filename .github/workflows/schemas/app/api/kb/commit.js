// api/kb/commit.js  — CommonJS (Node 18+ on Vercel)

const fs = require('fs').promises;
const path = require('path');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // --- Security: key-based protection ---
  const key = req.headers['x-kb-key'];
  if (process.env.KB_PROTECT_KEY && key !== process.env.KB_PROTECT_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // --- Optional origin allowlist ---
  const allowed = (process.env.KB_ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || '';
  if (allowed.length && !allowed.some(a => origin.includes(a))) {
    return res.status(403).json({ error: 'origin_forbidden', origin, allowed });
  }

  // --- Parse body ---
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json', detail: String(e?.message || e) });
  }
  const { registry, search, cross, message } = payload || {};

  // --- Env for GitHub Contents API ---
  const OWNER  = process.env.GH_OWNER;
  const REPO   = process.env.GH_REPO;
  const BRANCH = process.env.GH_BRANCH || 'main';
  const TOKEN  = process.env.GH_TOKEN;
  if (!OWNER || !REPO || !TOKEN) {
    return res.status(500).json({ error: 'missing_env', need: ['GH_OWNER','GH_REPO','GH_TOKEN'] });
  }

  // --- Read CURRENT deployed canonicals (for deltas & size baselines) ---
  const docsDir = path.join(process.cwd(), 'docs');
  let prevRegStr = null, prevSeaStr = null, prevXlnStr = null;
  let prevReg = null, prevSea = null, prevXln = null;
  try {
    [prevRegStr, prevSeaStr, prevXlnStr] = await Promise.all([
      fs.readFile(path.join(docsDir, 'registry.json'), 'utf8'),
      fs.readFile(path.join(docsDir, 'search.json'), 'utf8'),
      fs.readFile(path.join(docsDir, 'cross_links.json'), 'utf8')
    ]);
    prevReg = JSON.parse(prevRegStr);
    prevSea = JSON.parse(prevSeaStr);
    prevXln = JSON.parse(prevXlnStr);
  } catch {
    // first run or files missing in build output; that's OK
  }

  // --- Apply timestamps to incoming payload ---
  const ts = new Date().toISOString();
  if (registry && typeof registry === 'object') registry.updated_at = ts;
  if (search   && typeof search   === 'object') search.updated_at   = ts;
  if (cross    && typeof cross    === 'object') cross.updated_at    = ts;

  // --- Metrics (prev vs next) ---
  const prev = extractMetrics(prevReg, prevSea, prevXln, null, {
    regStr: prevRegStr, seaStr: prevSeaStr, xlnStr: prevXlnStr
  });
  const next = extractMetrics(registry, search, cross, ts);

  const delta = {
    registry_items: (next.counts.registry_items ?? 0) - (prev.counts.registry_items ?? 0),
    search_docs:    (next.counts.search_docs ?? 0)    - (prev.counts.search_docs ?? 0),
    edges:          (next.counts.edges ?? 0)          - (prev.counts.edges ?? 0)
  };

  // --- ROI (blocks_added ~= docs added) ---
  const rateUsd = Number(req.headers['x-roi-rate'] || 120);
  const blocksAdded   = Math.max(0, delta.search_docs || 0);
  const savedMinutes  = blocksAdded * 15; // v9 default
  const valueUsd      = Number(((savedMinutes / 60) * rateUsd).toFixed(2));

  // --- Threshold flags (soft checks, not blockers) ---
  const thresholds = next.thresholds || {
    search_max_kb: 5000, registry_max_kb: 2000, cross_max_kb: 5000,
    unresolved_max: 250, orphans_max: 250
  };
  const size_ok = (next.sizes_kb.search_kb   ?? 0) <= thresholds.search_max_kb
               && (next.sizes_kb.registry_kb ?? 0) <= thresholds.registry_max_kb
               && (next.sizes_kb.cross_kb    ?? 0) <= thresholds.cross_max_kb;
  const graph_ok = (next.counts.unresolved_edges ?? 0) <= thresholds.unresolved_max;

  const stats = {
    ts,
    updated_at: search?.updated_at || registry?.updated_at || cross?.updated_at || ts,
    counts: next.counts,
    sizes_kb: next.sizes_kb,
    quality: next.quality,
    graph: next.graph,
    thresholds,
    delta,
    roi: {
      blocks_added: blocksAdded,
      saved_minutes_est: savedMinutes,
      rate_usd_per_hour: rateUsd,
      value_usd_est: valueUsd
    },
    health: { size_ok, graph_ok },
    notes: (size_ok && graph_ok) ? null : 'warn: size or graph thresholds exceeded'
  };

  const cid = req.headers['x-correlation-id'] || Math.random().toString(36).slice(2);

  try {
    // Structured log (one line) for Vercel Logs
    console.log(JSON.stringify({
      event: 'kb.commit',
      ts,
      correlationId: cid,
      repo: `${OWNER}/${REPO}`,
      branch: BRANCH,
      ok: true,
      counts: next.counts,
      delta,
      roi: stats.roi
    }));

    // --- Write canonical files + stats to GitHub ---
    const results = await Promise.all([
      putFile('docs/registry.json',     JSON.stringify(registry, null, 2), message || 'KB: update registry'),
      putFile('docs/search.json',       JSON.stringify(search,   null, 2), message || 'KB: update search'),
      putFile('docs/cross_links.json',  JSON.stringify(cross,    null, 2), message || 'KB: update cross_links'),
      putFile('docs/kb_stats.json',     JSON.stringify(stats,    null, 2), message || 'KB: update stats')
    ]);

    res.setHeader('x-correlation-id', cid);
    return res.status(200).json({ ok: true, correlationId: cid, results, stats });
  } catch (e) {
    console.error(JSON.stringify({ event: 'kb.commit.error', correlationId: cid, error: String(e?.message || e) }));
    return res.status(500).json({ error: 'commit_failed', correlationId: cid, detail: String(e?.message || e) });
  }

  // ---------------- helpers ----------------

  function extractMetrics(registryObj, searchObj, crossObj, tsNow, raw = {}) {
    // Normalize list shapes
    const regArr = Array.isArray(registryObj) ? registryObj
                 : Array.isArray(registryObj?.items) ? registryObj.items
                 : Array.isArray(registryObj?.registry) ? registryObj.registry : [];
    const seaArr = Array.isArray(searchObj) ? searchObj
                 : Array.isArray(searchObj?.docs) ? searchObj.docs
                 : Array.isArray(searchObj?.items) ? searchObj.items : [];

    // Cross-links can be graph ({nodes,edges} or {graph:{}}) OR a neighbors map
    let nodes = [], edges = [];
    let mapNeighbors = null;
    if (crossObj && typeof crossObj === 'object') {
      if (Array.isArray(crossObj.nodes) || Array.isArray(crossObj.edges)) {
        nodes = Array.isArray(crossObj.nodes) ? crossObj.nodes : [];
        edges = Array.isArray(crossObj.edges) ? crossObj.edges : [];
      } else if (crossObj.graph && (Array.isArray(crossObj.graph.nodes) || Array.isArray(crossObj.graph.edges))) {
        nodes = Array.isArray(crossObj.graph.nodes) ? crossObj.graph.nodes : [];
        edges = Array.isArray(crossObj.graph.edges) ? crossObj.graph.edges : [];
      } else {
        // neighbor map heuristic: { "/path": { neighbors: [] }, ... }
        const vals = Object.values(crossObj);
        const looksLikeMap = vals.length > 0 && vals.every(v => v && typeof v === 'object' && Array.isArray(v.neighbors));
        if (looksLikeMap) {
          mapNeighbors = crossObj;
          const mapNodes = Object.keys(crossObj).length;
          const mapEdges = Object.values(crossObj).reduce((acc, v) => acc + (Array.isArray(v.neighbors) ? v.neighbors.length : 0), 0);
          nodes = new Array(mapNodes).fill(0); // counts only
          edges = new Array(mapEdges).fill(0); // counts only
        }
      }
    }

    // Counts
    const counts = {
      registry_items: regArr.length,
      search_docs: seaArr.length,
      nodes: mapNeighbors ? Object.keys(mapNeighbors).length : nodes.length,
      edges: mapNeighbors ? Object.values(mapNeighbors).reduce((a, v) => a + (v.neighbors?.length || 0), 0) : edges.length,
      unique_tags: 0,
      unresolved_edges: 0
    };

    // Unique tags
    const tagSet = new Set();
    for (const d of seaArr) {
      if (Array.isArray(d?.tags)) for (const t of d.tags) tagSet.add(String(t).toLowerCase());
    }
    counts.unique_tags = tagSet.size;

    // Unresolved edges (only for graph style)
    if (!mapNeighbors && Array.isArray(edges)) {
      counts.unresolved_edges = edges.filter(e => !e || !e.source || !e.target).length;
    }

    // Sizes (KB)
    const sizes_kb = {
      registry_kb: kbSize(raw.regStr ?? safeStringify(registryObj)),
      search_kb:   kbSize(raw.seaStr ?? safeStringify(searchObj)),
      cross_kb:    kbSize(raw.xlnStr ?? safeStringify(crossObj))
    };

    // Quality
    const docsTotal = seaArr.length || 1;
    const withContent     = seaArr.filter(d => typeof d?.content === 'string' && d.content.length > 0).length;
    const withAttachRaw   = seaArr.filter(d => d?.attachments?.raw_markdown).length;
    const withTags        = seaArr.filter(d => Array.isArray(d?.tags) && d.tags.length > 0).length;
    // Cross-link coverage (best-effort): docs appearing as edge endpoints by id
    let docIdsInEdges = new Set();
    if (!mapNeighbors && Array.isArray(edges)) {
      for (const e of edges) {
        if (e?.source) docIdsInEdges.add(e.source);
        if (e?.target) docIdsInEdges.add(e.target);
      }
    }
    const docsWithCross = seaArr.filter(d => d?.id && docIdsInEdges.has(d.id)).length;

    const quality = {
      pct_docs_with_content: withContent   / docsTotal,
      pct_docs_with_attachments: withAttachRaw / docsTotal,
      pct_docs_with_tags: withTags / docsTotal,
      pct_docs_with_crosslinks: docsWithCross / docsTotal,
      median_doc_age_days: medianAgeDays(seaArr)
    };

    // Graph metric
    const avg_degree = counts.nodes > 0 ? (2 * counts.edges) / counts.nodes : 0;

    return {
      counts,
      sizes_kb,
      quality,
      graph: { avg_degree },
      thresholds: {
        search_max_kb: 5000, registry_max_kb: 2000, cross_max_kb: 5000,
        unresolved_max: 250, orphans_max: 250
      }
    };
  }

  function kbSize(s) {
    try { return Math.round(Buffer.byteLength(String(s), 'utf8') / 1024); }
    catch { return 0; }
  }

  function safeStringify(o) {
    try { return JSON.stringify(o ?? {}); }
    catch { return '{}'; }
  }

  function medianAgeDays(docs) {
    const times = [];
    for (const d of docs || []) {
      const iso = d?.updated_at || d?.created_at;
      if (!iso) continue;
      const t = Date.parse(iso);
      if (!Number.isNaN(t)) times.push((Date.now() - t) / (1000 * 60 * 60 * 24));
    }
    if (!times.length) return null;
    times.sort((a,b)=>a-b);
    const mid = Math.floor(times.length / 2);
    return times.length % 2 ? Number(times[mid].toFixed(1))
                            : Number(((times[mid-1]+times[mid])/2).toFixed(1));
  }

  async function putFile(pathname, content, msg) {
    const sha = await getSha(pathname);
    const body = {
      message: msg,
      content: Buffer.from(content).toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {})
    };
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`PUT ${pathname}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async function getSha(pathname) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json'
      }
    });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`GET sha ${pathname}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return j.sha;
  }
};

// ---- shared body reader ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
