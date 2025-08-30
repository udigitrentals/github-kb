// api/kb/commit.js (CommonJS, Node 18+ on Vercel)

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Protect the endpoint
  const key = req.headers['x-kb-key'];
  if (process.env.KB_PROTECT_KEY && key !== process.env.KB_PROTECT_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Optional origin allowlist
  const allowed = (process.env.KB_ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (allowed.length && !allowed.some(a => origin.includes(a))) {
    return res.status(403).json({ error: 'origin_forbidden', origin, allowed });
  }

  // Parse body
  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json', detail: String(e?.message || e) });
  }
  const { registry, search, cross, message } = payload || {};

  // Env
  const OWNER  = process.env.GH_OWNER;
  const REPO   = process.env.GH_REPO;
  const BRANCH = process.env.GH_BRANCH || 'main';
  const TOKEN  = process.env.GH_TOKEN;
  if (!OWNER || !REPO || !TOKEN) {
    return res.status(500).json({ error: 'missing_env', need: ['GH_OWNER','GH_REPO','GH_TOKEN'] });
  }

  // Timestamps on payload
  const ts = new Date().toISOString();
  if (registry && typeof registry === 'object') registry.updated_at = ts;
  if (search   && typeof search   === 'object') search.updated_at   = ts;
  if (cross    && typeof cross    === 'object') cross.updated_at    = ts;

  // Compute stats + correlation id
  const stats = buildStats(registry, search, cross, ts);
  const cid   = req.headers['x-correlation-id'] || Math.random().toString(36).slice(2);

  try {
    // Structured log for Vercel Logs
    console.log(JSON.stringify({
      event: 'kb.commit',
      correlationId: cid,
      repo: `${OWNER}/${REPO}`,
      branch: BRANCH,
      counts: stats.counts
    }));

    // Write all four files (three canonicals + stats)
    const results = await Promise.all([
      putFile('docs/registry.json',     JSON.stringify(registry, null, 2), message || 'KB: update registry'),
      putFile('docs/search.json',       JSON.stringify(search,   null, 2), message || 'KB: update search'),
      putFile('docs/cross_links.json',  JSON.stringify(cross,    null, 2), message || 'KB: update cross_links'),
      putFile('docs/kb_stats.json',     JSON.stringify(stats,    null, 2), message || 'KB: update stats')
    ]);

    res.setHeader('x-correlation-id', cid);
    return res.status(200).json({ ok: true, correlationId: cid, results });
  } catch (e) {
    console.error(JSON.stringify({ event: 'kb.commit.error', correlationId: cid, error: String(e?.message || e) }));
    return res.status(500).json({ error: 'commit_failed', correlationId: cid, detail: String(e?.message || e) });
  }

  // ---------- helpers ----------

  function buildStats(registry, search, cross, tsNow) {
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

    const uniqueTags = new Set();
    for (const d of searchArr) {
      if (Array.isArray(d.tags)) for (const t of d.tags) uniqueTags.add(String(t).toLowerCase());
    }
    const unresolved = edges.filter(e => !e.target || !e.source);

    return {
      ts: tsNow,
      counts: {
        registry_items:   registryArr.length,
        search_docs:      searchArr.length,
        nodes:            nodes.length,
        edges:            edges.length,
        unique_tags:      uniqueTags.size,
        unresolved_edges: unresolved.length
      }
    };
  }

  async function putFile(path, content, msg) {
    const sha = await getSha(path);
    const body = { message: msg, content: Buffer.from(content).toString('base64'), branch: BRANCH, ...(sha ? { sha } : {}) };
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  async function getSha(path) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`GET sha ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return j.sha;
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
