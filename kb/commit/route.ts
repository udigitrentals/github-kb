// app/api/kb/commit/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

const OWNER  = process.env.GH_OWNER!;
const REPO   = process.env.GH_REPO!;
const BRANCH = process.env.GH_BRANCH || "main";
const TOKEN  = process.env.GH_TOKEN!;         // GitHub PAT with "contents:write"
const PROTECT_KEY = process.env.KB_PROTECT_KEY; // simple shared secret

async function getSha(path: string) {
  const r = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" } }
  );
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`getSha ${path}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.sha as string | undefined;
}
async function putFile(path: string, content: string, message: string) {
  const sha = await getSha(path);
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch: BRANCH,
    ...(sha ? { sha } : {})
  };
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`putFile ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function POST(req: NextRequest) {
  if (PROTECT_KEY) {
    const key = req.headers.get("x-kb-key");
    if (key !== PROTECT_KEY) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { registry, search, cross, message } = await req.json();

  // ensure top-level timestamps (canonical index convention)
  const ts = new Date().toISOString();
  if (registry) registry.updated_at = ts;
  if (search)   search.updated_at   = ts;

  const results = await Promise.all([
    putFile("docs/registry.json", JSON.stringify(registry, null, 2), message || "KB: update registry.json"),
    putFile("docs/search.json",   JSON.stringify(search,   null, 2), message || "KB: update search.json"),
    putFile("docs/cross_links.json", JSON.stringify(cross, null, 2), message || "KB: update cross_links.json")
  ]);

  return NextResponse.json({ ok: true, results });
}
