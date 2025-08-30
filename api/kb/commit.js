// api/kb/commit.js — CommonJS (Node 18+ on Vercel)
// Performs authenticated commits of canonical KB files to GitHub.
// Supports single search.json or sharded /docs/search/index.json + search-*.json.

const fs = require("fs").promises;
const path = require("path");

// Optional: inline Ajv validation; disabled if schemas missing
let Ajv;
try { Ajv = require("ajv"); } catch { Ajv = null; }

module.exports = async (req, res) => {
  try {
    // -------- CORS / Preflight --------
    const allowed = (process.env.KB_ALLOWED_ORIGIN || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const origin = (req.headers.origin || "").trim();

    const originAllowed = (() => {
      if (!allowed.length || !origin) return true;
      try {
        const host = new URL(origin).host.toLowerCase();
        return allowed.some(a => host === a || host.endsWith(`.${a}`));
      } catch { return false; }
    })();

    if (req.method === "OPTIONS") {
      if (!originAllowed) return res.status(403).end();
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type,x-kb-key,x-roi-rate,x-correlation-id");
      res.setHeader("Access-Control-Max-Age", "86400");
      return res.status(204).end();
    }

    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "method_not_allowed" }, origin, originAllowed);
    }

    // --- Security: key-based protection ---
    const key = req.headers["x-kb-key"];
    if (process.env.KB_PROTECT_KEY && key !== process.env.KB_PROTECT_KEY) {
      return json(res, 403, { ok: false, error: "forbidden" }, origin, originAllowed);
    }
    if (!originAllowed) {
      return json(res, 403, { ok: false, error: "origin_forbidden", origin, allowed }, origin, originAllowed);
    }

    // --- Parse JSON body ---
    const payload = await readBody(req);
    const {
      registry,            // array OR {items|docs|registry}
      search,              // array OR {items|docs} (non-sharded mode)
      cross,               // graph or neighbor map
      searchManifest,      // { total, shards:[{file,count}] }
      searchShards,        // [{ file, data: {docs:[...] or items:[...] } }, ...]
      message
    } = payload || {};

    // --- GitHub Contents API env ---
    const OWNER  = process.env.GH_OWNER;
    const REPO   = process.env.GH_REPO;
    const BRANCH = process.env.GH_BRANCH || "main";
    const TOKEN  = process.env.GH_TOKEN;
    if (!OWNER || !REPO || !TOKEN) {
      return json(res, 500, { ok: false, error: "missing_env", need: ["GH_OWNER","GH_REPO","GH_TOKEN"] }, origin, originAllowed);
    }

    // --- Optional Ajv validation (skip if schemas missing) ---
    let schemaOk = true, schemaErrors = [];
    try {
      if (Ajv) {
        const schemasDir = path.join(process.cwd(), "schemas");
        const ajv = new Ajv({ allErrors: true, strict: false });

        const loadIf = async (p) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } };
        const regSchema   = await loadIf(path.join(schemasDir, "registry.schema.json"));
        const searchSchema= await loadIf(path.join(schemasDir, "search.schema.json"));
        const crossSchema = await loadIf(path.join(schemasDir, "cross_links.schema.json"));

        if (regSchema && registry !== undefined) {
          if (!ajv.validate(regSchema, registry)) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); }
        }
        if (searchSchema) {
          if (search) {
            if (!ajv.validate(searchSchema, search)) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); }
          } else if (searchManifest && Array.isArray(searchShards)) {
            for (const s of searchShards) {
              if (!ajv.validate(searchSchema, s.data)) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); break; }
            }
          }
        }
        if (crossSchema && cross !== undefined) {
          if (!ajv.validate(crossSchema, cross)) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); }
        }
      }
    } catch (e) {
      schemaOk = false;
      schemaErrors.push({ message: "validator_exception", detail: String(e?.message || e) });
    }
    if (!schemaOk) {
      return json(res, 422, { ok: false, error: "schema_validation_failed", errors: (schemaErrors||[]).slice(0,3) }, origin, originAllowed);
    }

    // --- Read CURRENT canonicals from local /docs (for deltas & shape baselines) ---
    const docsDir = path.join(process.cwd(), "docs");
    let prevRegStr = null, prevSeaStr = null, prevXlnStr = null, prevManStr = null;
    let prevReg = null, prevSea = null, prevXln = null, prevMan = null;
    try {
      [prevRegStr, prevSeaStr, prevXlnStr] = await Promise.all([
        fs.readFile(path.join(docsDir, "registry.json"), "utf8"),
        fs.readFile(path.join(docsDir, "search.json"), "utf8").catch(() => null),
        fs.readFile(path.join(docsDir, "cross_links.json"), "utf8")
      ]);
      prevReg = JSON.parse(prevRegStr);
      if (prevSeaStr) prevSea = JSON.parse(prevSeaStr);
      prevXln = JSON.parse(prevXlnStr);
    } catch { /* first run / missing files OK */ }
    try {
      prevManStr = await fs.readFile(path.join(docsDir, "search", "index.json"), "utf8");
      prevMan = JSON.parse(prevManStr);
    } catch { /* no manifest locally */ }

    // --- Timestamps (non-destructive, do not mutate nested docs) ---
    const ts = new Date().toISOString();
    const stamp = (obj) => (obj && typeof obj === "object" ? { ...obj, updated_at: ts } : obj);
    const nextRegistry = stamp(registry);
    const nextSearch   = stamp(search);
    const nextCross    = stamp(cross);
    const nextManifest = stamp(searchManifest);

    // --- Metrics, ROI (warn-only thresholds) ---
    const prev = extractMetrics(prevReg, pickSearch(prevSea, prevMan), prevXln, {
      regStr: prevRegStr,
      seaStr: prevSeaStr || prevManStr,
      xlnStr: prevXlnStr
    });
    const next = extractMetrics(nextRegistry, pickSearch(nextSearch, nextManifest), nextCross);

    const rateUsd     = Number(req.headers["x-roi-rate"] || 120);
    const deltaCounts = {
      registry_items: (next.counts.registry_items ?? 0) - (prev.counts.registry_items ?? 0),
      search_docs:    (next.counts.search_docs ?? 0)    - (prev.counts.search_docs ?? 0),
      edges:          (next.counts.edges ?? 0)          - (prev.counts.edges ?? 0)
    };
    const blocksAdded  = Math.max(0, deltaCounts.search_docs || 0);
    const savedMinutes = blocksAdded * 15;
    const valueUsd     = Number(((savedMinutes / 60) * rateUsd).toFixed(2));

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
      updated_at: ts,
      counts: next.counts,
      sizes_kb: next.sizes_kb,
      quality: next.quality,
      graph: next.graph,
      thresholds,
      delta: deltaCounts,
      roi: { blocks_added: blocksAdded, saved_minutes_est: savedMinutes, rate_usd_per_hour: rateUsd, value_usd_est: valueUsd },
      health: { size_ok, graph_ok },
      notes: (size_ok && graph_ok) ? null : "warn: size or graph thresholds exceeded"
    };

    const cid = req.headers["x-correlation-id"] || Math.random().toString(36).slice(2);
    console.log(JSON.stringify({ event: "kb.commit", ts, correlationId: cid, repo: `${OWNER}/${REPO}`, branch: BRANCH, ok: true, counts: next.counts, delta: deltaCounts, roi: stats.roi }));

    // --- Build commit set (preserve shapes) ---
    const commitMsg = message || "KB: update canonicals";
    const regStr = JSON.stringify(nextRegistry, null, 2);
    const crossStr = JSON.stringify(nextCross, null, 2);

    const writes = [
      putFile(`docs/registry.json`, regStr, commitMsg, { OWNER, REPO, BRANCH, TOKEN }),
      putFile(`docs/cross_links.json`, crossStr, commitMsg, { OWNER, REPO, BRANCH, TOKEN })
    ];

    if (nextManifest && Array.isArray(searchShards) && !nextSearch) {
      // Sharded: manifest + shards, prune single + stale shards
      const manStr = JSON.stringify(nextManifest, null, 2);
      writes.push(putFile(`docs/search/index.json`, manStr, commitMsg, { OWNER, REPO, BRANCH, TOKEN }));

      const shardNames = new Set();
      for (const s of searchShards) {
        if (!s || !s.file || !s.data) continue;
        shardNames.add(s.file);
        writes.push(putFile(`docs/search/${s.file}`, JSON.stringify(s.data, null, 2), commitMsg, { OWNER, REPO, BRANCH, TOKEN }));
      }
      writes.push(deleteIfExists(`docs/search.json`, commitMsg, { OWNER, REPO, BRANCH, TOKEN }));
      writes.push(pruneOtherShards(shardNames, commitMsg, { OWNER, REPO, BRANCH, TOKEN }));
    } else if (nextSearch) {
      // Single file; prune manifest + shards
      const seaStr = JSON.stringify(nextSearch, null, 2);
      writes.push(putFile(`docs/search.json`, seaStr, commitMsg, { OWNER, REPO, BRANCH, TOKEN }));
      writes.push(deleteIfExists(`docs/search/index.json`, commitMsg, { OWNER, REPO, BRANCH, TOKEN }));
      writes.push(pruneOtherShards(new Set(), commitMsg, { OWNER, REPO, BRANCH, TOKEN }));
    } else {
      return json(res, 400, { ok: false, error: "missing_search_payload", hint: "Provide either `search` or (`searchManifest` + `searchShards`)." }, origin, originAllowed);
    }

    // Stats + health history
    writes.push(putFile(`docs/kb_stats.json`, JSON.stringify(stats, null, 2), commitMsg, { OWNER, REPO, BRANCH, TOKEN }));

    const history = await readRemoteJson(`docs/kb_health_history.json`, { OWNER, REPO, BRANCH, TOKEN }).catch(() => []);
    const compact = { ts: stats.ts, counts: stats.counts, delta: stats.delta, roi: stats.roi, size_kb: stats.sizes_kb };
    const nextHistory = Array.isArray(history) ? [...history, compact].slice(-365) : [compact];
    writes.push(putFile(`docs/kb_health_history.json`, JSON.stringify(nextHistory, null, 2), commitMsg, { OWNER, REPO, BRANCH, TOKEN }));

    const results = await Promise.all(writes);

    res.setHeader("x-correlation-id", cid);
    return json(res, 200, { ok: true, correlationId: cid, results, stats }, origin, originAllowed);
  } catch (e) {
    return json(res, 500, { ok: false, error: "commit_failed", detail: String(e?.message || e) });
  }
};

// --------------- helpers ----------------
function json(res, status, body, origin, originAllowed = true) {
  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Expose-Headers", "x-correlation-id");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).send(JSON.stringify(body));
}

function pickSearch(single, manifest) {
  // For metrics size calculation and counts: prefer single if present, else manifest.
  return single || manifest || null;
}

function kbSize(s) {
  try { return Math.round(Buffer.byteLength(String(s), "utf8") / 1024); }
  catch { return 0; }
}
function safeStringify(o) {
  try { return JSON.stringify(o ?? {}); }
  catch { return "{}"; }
}

function extractMetrics(registryObj, searchObj, crossObj, raw = {}) {
  const regArr = Array.isArray(registryObj) ? registryObj
               : Array.isArray(registryObj?.items) ? registryObj.items
               : Array.isArray(registryObj?.docs) ? registryObj.docs
               : Array.isArray(registryObj?.registry) ? registryObj.registry : [];

  let seaArr = [];
  if (Array.isArray(searchObj?.docs)) seaArr = searchObj.docs;
  else if (Array.isArray(searchObj?.items)) seaArr = searchObj.items;
  else if (Array.isArray(searchObj)) seaArr = searchObj;
  else if (searchObj && searchObj.total && Array.isArray(searchObj.shards)) {
    seaArr = new Array(Number(searchObj.total) || 0).fill(0);
  }

  let nodes = [], edges = [], mapNeighbors = null;
  if (crossObj && typeof crossObj === "object") {
    if (Array.isArray(crossObj.nodes) || Array.isArray(crossObj.edges)) {
      nodes = Array.isArray(crossObj.nodes) ? crossObj.nodes : [];
      edges = Array.isArray(crossObj.edges) ? crossObj.edges : [];
    } else if (crossObj.graph && (Array.isArray(crossObj.graph.nodes) || Array.isArray(crossObj.graph.edges))) {
      nodes = Array.isArray(crossObj.graph.nodes) ? crossObj.graph.nodes : [];
      edges = Array.isArray(crossObj.graph.edges) ? crossObj.graph.edges : [];
    } else {
      const vals = Object.values(crossObj);
      const looksLikeMap = vals.length > 0 && vals.every(v => v && typeof v === "object" && Array.isArray(v.neighbors));
      if (looksLikeMap) {
        mapNeighbors = crossObj;
        nodes = new Array(Object.keys(crossObj).length).fill(0);
        edges = new Array(Object.values(crossObj).reduce((acc, v) => acc + (Array.isArray(v.neighbors) ? v.neighbors.length : 0), 0)).fill(0);
      }
    }
  }

  const counts = {
    registry_items: regArr.length,
    search_docs: seaArr.length,
    nodes: mapNeighbors ? Object.keys(mapNeighbors).length : nodes.length,
    edges: mapNeighbors ? Object.values(mapNeighbors).reduce((a, v) => a + (v.neighbors?.length || 0), 0) : edges.length,
    unique_tags: 0,
    unresolved_edges: 0
  };

  const tagSet = new Set();
  for (const d of seaArr) {
    if (d && typeof d === "object" && Array.isArray(d.tags)) {
      for (const t of d.tags) tagSet.add(String(t).toLowerCase());
    }
  }
  counts.unique_tags = tagSet.size;

  if (!mapNeighbors && Array.isArray(edges)) {
    counts.unresolved_edges = edges.filter(e => (e && e.status === "pending") || !e?.source || !e?.target).length;
  }

  const sizes_kb = {
    registry_kb: kbSize(raw.regStr ?? safeStringify(registryObj)),
    search_kb:   kbSize(raw.seaStr ?? safeStringify(searchObj)),
    cross_kb:    kbSize(raw.xlnStr ?? safeStringify(crossObj))
  };

  const docsTotal = seaArr.filter(d => d && typeof d === "object").length || 1;
  const withContent   = seaArr.filter(d => d && typeof d === "object" && typeof d.content === "string" && d.content.length > 0).length;
  const withAttachRaw = seaArr.filter(d => d && typeof d === "object" && d.attachments && d.attachments.raw_markdown).length;
  const withTags      = seaArr.filter(d => d && typeof d === "object" && Array.isArray(d.tags) && d.tags.length > 0).length;

  const quality = {
    pct_docs_with_content: withContent / docsTotal,
    pct_docs_with_attachments: withAttachRaw / docsTotal,
    pct_docs_with_tags: withTags / docsTotal,
    pct_docs_with_crosslinks: null,
    median_doc_age_days: medianAgeDays(seaArr)
  };

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

function medianAgeDays(docs) {
  const times = [];
  for (const d of docs || []) {
    if (!d || typeof d !== "object") continue;
    const iso = d.updated_at || d.created_at;
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) times.push((Date.now() - t) / (1000 * 60 * 60 * 24));
  }
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? Number(times[mid].toFixed(1)) : Number(((times[mid - 1] + times[mid]) / 2).toFixed(1));
}

// ---- GitHub helpers ----
async function readRemoteJson(pathname, { OWNER, REPO, BRANCH, TOKEN }) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (r.status === 404) throw new Error("not_found");
  if (!r.ok) throw new Error(`GET ${pathname}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const buf = Buffer.from(j.content || "", "base64");
  return JSON.parse(buf.toString("utf8"));
}

async function putFile(pathname, content, msg, { OWNER, REPO, BRANCH, TOKEN }) {
  const sha = await getSha(pathname, { OWNER, REPO, BRANCH, TOKEN });
  const body = { message: msg, content: Buffer.from(content).toString("base64"), branch: BRANCH, ...(sha ? { sha } : {}) };
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`PUT ${pathname}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function deleteIfExists(pathname, msg, { OWNER, REPO, BRANCH, TOKEN }) {
  const sha = await getSha(pathname, { OWNER, REPO, BRANCH, TOKEN });
  if (!sha) return { skipped: true, path: pathname };
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ message: msg || `KB: delete ${pathname}`, sha, branch: BRANCH })
  });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${pathname}: ${r.status} ${await r.text()}`);
  return { deleted: true, path: pathname };
}

async function getSha(pathname, { OWNER, REPO, BRANCH, TOKEN }) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`GET sha ${pathname}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.sha;
}

async function listDir(pathname, { OWNER, REPO, BRANCH, TOKEN }) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`LIST ${pathname}: ${r.status} ${await r.text()}`);
  const arr = await r.json();
  return Array.isArray(arr) ? arr : [];
}

async function pruneOtherShards(keepSet, msg, ctx) {
  const entries = await listDir(`docs/search`, ctx).catch(() => []);
  const tasks = [];
  for (const e of entries) {
    if (e && e.type === "file" && /^search-\d+\.json$/i.test(e.name)) {
      if (!keepSet.has(e.name)) tasks.push(deleteIfExists(`docs/search/${e.name}`, msg, ctx));
    }
  }
  return Promise.all(tasks);
}

// ---- shared body reader ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
