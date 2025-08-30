// api/kb/commit.js — CommonJS (Node 18+ on Vercel)
const fs = require("fs").promises;
const path = require("path");

// Optional: inline Ajv validation; disabled if schemas missing
let Ajv;
try { Ajv = require("ajv"); } catch { Ajv = null; }

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","content-type,x-kb-key,x-roi-rate,x-correlation-id");
    res.setHeader("Access-Control-Max-Age","86400");
    return res.status(204).end();
  }
  // ...rest of handler
};


    // --- Security: key-based protection ---
    const key = req.headers["x-kb-key"];
    if (process.env.KB_PROTECT_KEY && key !== process.env.KB_PROTECT_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    // --- Optional origin allowlist (safe host match, not substring) ---
    const allowed = (process.env.KB_ALLOWED_ORIGIN || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const origin = (req.headers.origin || "").trim();
    if (allowed.length && origin) {
      try {
        const host = new URL(origin).host.toLowerCase();
        const ok = allowed.some(a => host === a || host.endsWith(`.${a}`));
        if (!ok) return res.status(403).json({ ok: false, error: "origin_forbidden", origin, allowed });
      } catch {
        return res.status(403).json({ ok: false, error: "origin_invalid", origin });
      }
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
      return res.status(500).json({ ok: false, error: "missing_env", need: ["GH_OWNER", "GH_REPO", "GH_TOKEN"] });
    }

    // --- Optional Ajv validation (skip if schemas missing) ---
    let schemaOk = true, schemaErrors = [];
    try {
      if (Ajv) {
        const schemasDir = path.join(process.cwd(), "schemas");
        const ajv = new Ajv({ allErrors: true, strict: false });

        // Load schemas if present; otherwise skip
        const loadIf = async (p) => {
          try { return JSON.parse(await fs.readFile(p, "utf8")); }
          catch { return null; }
        };

        const regSchema  = await loadIf(path.join(schemasDir, "registry.schema.json"));
        const seaSchema  = await loadIf(path.join(schemasDir, "search.schema.json"));
        const crossSchema= await loadIf(path.join(schemasDir, "cross_links.schema.json"));

        // Validate registry if schema found
        if (regSchema && registry !== undefined) {
          const ok = ajv.validate(regSchema, registry);
          if (!ok) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); }
        }
        // Validate search (single or shards)
        if (seaSchema) {
          if (search) {
            const ok = ajv.validate(seaSchema, search);
            if (!ok) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); }
          } else if (searchManifest && Array.isArray(searchShards)) {
            for (const s of searchShards) {
              const ok = ajv.validate(seaSchema, s.data);
              if (!ok) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); break; }
            }
          }
        }
        // Validate cross-links if schema found
        if (crossSchema && cross !== undefined) {
          const ok = ajv.validate(crossSchema, cross);
          if (!ok) { schemaOk = false; schemaErrors.push(...(ajv.errors || [])); }
        }
      }
    } catch (e) {
      // Do not hard-fail on validator exceptions; just report
      schemaOk = false;
      schemaErrors.push({ message: "validator_exception", detail: String(e?.message || e) });
    }
    if (!schemaOk) {
      return res.status(422).json({ ok: false, error: "schema_validation_failed", errors: top3(schemaErrors) });
    }

    // --- Read CURRENT deployed canonicals from /docs (for deltas & shape baselines) ---
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
    } catch {
      // first run or missing files; OK
    }
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

    // --- Metrics, ROI, thresholds (warn-only) ---
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
    const savedMinutes = blocksAdded * 15; // default
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
      roi: {
        blocks_added: blocksAdded,
        saved_minutes_est: savedMinutes,
        rate_usd_per_hour: rateUsd,
        value_usd_est: valueUsd
      },
      health: { size_ok, graph_ok },
      notes: (size_ok && graph_ok) ? null : "warn: size or graph thresholds exceeded"
    };

    const cid = req.headers["x-correlation-id"] || Math.random().toString(36).slice(2);

    // Structured log
    console.log(JSON.stringify({
      event: "kb.commit",
      ts,
      correlationId: cid,
      repo: `${OWNER}/${REPO}`,
      branch: BRANCH,
      ok: true,
      counts: next.counts,
      delta: deltaCounts,
      roi: stats.roi
    }));

    // --- Commit set build (preserve shapes) ---
    const commitMsg = message || "KB: update canonicals";

    // 1) registry.json
    const regStr = JSON.stringify(nextRegistry, null, 2);
    // 2) cross_links.json
    const crossStr = JSON.stringify(nextCross, null, 2);

    // 3) search payload: single vs sharded
    let writes = [
      putFile(`docs/registry.json`, regStr, commitMsg),
      putFile(`docs/cross_links.json`, crossStr, commitMsg)
    ];

    if (nextManifest && Array.isArray(searchShards) && !nextSearch) {
      // Sharded path: write manifest + shards, prune single file and stale shards
      const manStr = JSON.stringify(nextManifest, null, 2);
      writes.push(putFile(`docs/search/index.json`, manStr, commitMsg));

      const shardNames = new Set();
      for (const s of searchShards) {
        if (!s || !s.file || !s.data) continue;
        const shardPath = `docs/search/${s.file}`;
        shardNames.add(s.file);
        writes.push(putFile(shardPath, JSON.stringify(s.data, null, 2), commitMsg));
      }
      // Prune single file if present
      writes.push(deleteIfExists(`docs/search.json`, commitMsg));
      // Prune stale shards not in current set
      writes.push(pruneOtherShards(shardNames, commitMsg));
    } else if (nextSearch) {
      // Single file search.json, prune manifest + shards
      const seaStr = JSON.stringify(nextSearch, null, 2);
      writes.push(putFile(`docs/search.json`, seaStr, commitMsg));
      writes.push(deleteIfExists(`docs/search/index.json`, commitMsg));
      writes.push(pruneOtherShards(new Set(), commitMsg)); // delete all search-*.json
    } else {
      return res.status(400).json({ ok: false, error: "missing_search_payload", hint: "Provide either `search` or (`searchManifest` + `searchShards`)." });
    }

    // 4) kb_stats.json
    writes.push(putFile(`docs/kb_stats.json`, JSON.stringify(stats, null, 2), commitMsg));

    // 5) kb_health_history.json (append; keep last 365)
    const history = await readRemoteJson(`docs/kb_health_history.json`).catch(() => []);
    const compact = {
      ts: stats.ts,
      counts: stats.counts,
      delta: stats.delta,
      roi: stats.roi,
      size_kb: stats.sizes_kb
    };
    const nextHistory = Array.isArray(history) ? [...history, compact].slice(-365) : [compact];
    writes.push(putFile(`docs/kb_health_history.json`, JSON.stringify(nextHistory, null, 2), commitMsg));

    const results = await Promise.all(writes);

    res.setHeader("x-correlation-id", cid);
    return res.status(200).json({ ok: true, correlationId: cid, results, stats });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "commit_failed", detail: String(e?.message || e) });
  }

  // --------------- helpers ----------------

  function top3(arr) { return (arr || []).slice(0, 3); }

  function pickSearch(single, manifest) {
    // For metrics size calculation and counts:
    // prefer single if present, else manifest (we can't include shards here)
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
    // Normalize registry/search (arrays or envelopes)
    const regArr = Array.isArray(registryObj) ? registryObj
                 : Array.isArray(registryObj?.items) ? registryObj.items
                 : Array.isArray(registryObj?.docs) ? registryObj.docs
                 : Array.isArray(registryObj?.registry) ? registryObj.registry : [];

    // For search: if manifest, estimate from manifest, else read docs/items
    let seaArr = [];
    if (Array.isArray(searchObj?.docs)) seaArr = searchObj.docs;
    else if (Array.isArray(searchObj?.items)) seaArr = searchObj.items;
    else if (Array.isArray(searchObj)) seaArr = searchObj;
    else if (searchObj && searchObj.total && Array.isArray(searchObj.shards)) {
      // manifest; we only know total count, not doc details
      seaArr = new Array(Number(searchObj.total) || 0).fill(0);
    }

    // Cross-links: graph {nodes,edges} or neighbor map
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

    // Counts
    const counts = {
      registry_items: regArr.length,
      search_docs: seaArr.length,
      nodes: mapNeighbors ? Object.keys(mapNeighbors).length : nodes.length,
      edges: mapNeighbors ? Object.values(mapNeighbors).reduce((a, v) => a + (v.neighbors?.length || 0), 0) : edges.length,
      unique_tags: 0,
      unresolved_edges: 0
    };

    // Unique tags (only possible if we have doc objects)
    const tagSet = new Set();
    for (const d of seaArr) {
      if (d && typeof d === "object" && Array.isArray(d.tags)) {
        for (const t of d.tags) tagSet.add(String(t).toLowerCase());
      }
    }
    counts.unique_tags = tagSet.size;

    // Unresolved edges: prefer status:"pending" if present; else missing endpoints
    if (!mapNeighbors && Array.isArray(edges)) {
      counts.unresolved_edges =
        edges.filter(e => (e && e.status === "pending") || !e?.source || !e?.target).length;
    }

    // Sizes (KB) – prefer provided raw JSON strings if present (avoid double-stringify)
    const sizes_kb = {
      registry_kb: kbSize(raw.regStr ?? safeStringify(registryObj)),
      search_kb:   kbSize(raw.seaStr ?? safeStringify(searchObj)),
      cross_kb:    kbSize(raw.xlnStr ?? safeStringify(crossObj))
    };

    // Quality – only if we have doc objects
    const docsTotal = seaArr.filter(d => d && typeof d === "object").length || 1;
    const withContent   = seaArr.filter(d => d && typeof d === "object" && typeof d.content === "string" && d.content.length > 0).length;
    const withAttachRaw = seaArr.filter(d => d && typeof d === "object" && d.attachments && d.attachments.raw_markdown).length;
    const withTags      = seaArr.filter(d => d && typeof d === "object" && Array.isArray(d.tags) && d.tags.length > 0).length;

    const quality = {
      pct_docs_with_content: withContent / docsTotal,
      pct_docs_with_attachments: withAttachRaw / docsTotal,
      pct_docs_with_tags: withTags / docsTotal,
      pct_docs_with_crosslinks: null, // cannot compute reliably without full edges+id->path map
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

  // ---- GitHub helper calls ----
  async function putFile(pathname, content, msg) {
    const sha = await getSha(pathname);
    const body = {
      message: msg,
      content: Buffer.from(content).toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {})
    };
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`PUT ${pathname}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async function deleteIfExists(pathname, msg) {
    const sha = await getSha(pathname);
    if (!sha) return { skipped: true, path: pathname };
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({ message: msg || `KB: delete ${pathname}`, sha, branch: BRANCH })
    });
    if (!r.ok && r.status !== 404) throw new Error(`DELETE ${pathname}: ${r.status} ${await r.text()}`);
    return { deleted: true, path: pathname };
  }

  async function getSha(pathname) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`GET sha ${pathname}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return j.sha;
  }

  async function listDir(pathname) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${pathname}?ref=${BRANCH}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`LIST ${pathname}: ${r.status} ${await r.text()}`);
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  }

  async function pruneOtherShards(keepSet, msg) {
    // delete docs/search/search-*.json not in keepSet
    const entries = await listDir(`docs/search`).catch(() => []);
    const tasks = [];
    for (const e of entries) {
      if (e && e.type === "file" && /^search-\d+\.json$/i.test(e.name)) {
        if (!keepSet.has(e.name)) {
          tasks.push(deleteIfExists(`docs/search/${e.name}`, msg));
        }
      }
    }
    return Promise.all(tasks);
  }
};

// ---- shared body reader ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
