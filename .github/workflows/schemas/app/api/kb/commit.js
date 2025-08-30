// Vercel Serverless Function to write docs/*.json via GitHub Contents API
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // Basic protection
  const key = req.headers["x-kb-key"];
  if (process.env.KB_PROTECT_KEY && key !== process.env.KB_PROTECT_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }

  // Optional origin allowlist
  const origin = req.headers.origin || "";
  const allowed = (process.env.KB_ALLOWED_ORIGIN || "").split(",").map(s=>s.trim()).filter(Boolean);
  if (allowed.length && !allowed.some(a => origin.includes(a))) {
    return res.status(403).json({ error: "origin_forbidden", origin, allowed });
  }

  const { registry, search, cross, message } = await readBody(req);
  const OWNER  = process.env.GH_OWNER;
  const REPO   = process.env.GH_REPO;
  const BRANCH = process.env.GH_BRANCH || "main";
  const TOKEN  = process.env.GH_TOKEN;

  if (!OWNER || !REPO || !TOKEN) {
    return res.status(500).json({ error: "missing_env", need: ["GH_OWNER","GH_REPO","GH_TOKEN"] });
  }

  const ts = new Date().toISOString();
  if (registry) registry.updated_at = ts;
  if (search)   search.updated_at   = ts;
  if (cross)    cross.updated_at    = ts;

  try {
    const results = await Promise.all([
      putFile("docs/registry.json", JSON.stringify(registry, null, 2), message || "KB: update registry"),
      putFile("docs/search.json",   JSON.stringify(search,   null, 2), message || "KB: update search"),
      putFile("docs/cross_links.json", JSON.stringify(cross, null, 2), message || "KB: update cross_links")
    ]);
    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: "commit_failed", detail: String(e?.message || e) });
  }

  async function putFile(path, content, msg) {
    const sha = await getSha(path);
    const body = { message: msg, content: Buffer.from(content).toString("base64"), branch: BRANCH, ...(sha ? { sha } : {}) };
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }
  async function getSha(path) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" }
    });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`GET sha ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return j.sha;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
