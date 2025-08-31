#!/usr/bin/env node
/**
 * scripts/ingest-and-commit.cjs
 * Usage:
 *   node scripts/ingest-and-commit.cjs --md ./Block1-2215_KBReady_Master_FULL_AllBlocks_MERGED.md
 *   node scripts/ingest-and-commit.cjs --md ./file.md --commit --base https://your-app.vercel.app --key YOUR_KB_KEY --origin https://your-site
 *
 * What it does:
 *  1) Loads existing /docs/* (handles search.json OR search/index.json + shards).
 *  2) Runs your ingestion lib (lib/ingest/index.js -> compose) to build registry/search/cross + stats.
 *  3) Writes outputs back into /docs locally (so you can inspect).
 *  4) Saves a commit payload at ./kb-payload.json (single or sharded).
 *  5) If --commit is provided, POSTs the payload to /api/kb/commit.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

// --- Config / Args ---
const args = require("node:process").argv.slice(2);
function arg(name, def) {
  const i = args.findIndex(a => a === `--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return true; // flags
  return v;
}
const MD_FILE = arg("md", null);
const DO_COMMIT = !!arg("commit", false);
const BASE = arg("base", "http://localhost:3000"); // your app base (for commit)
const KB_KEY = arg("key", process.env.KB_PROTECT_KEY || "");
const ORIGIN = arg("origin", "");
const OUT_PAYLOAD = path.join(process.cwd(), "kb-payload.json");

// --- Load compose() from your ingestion library ---
let compose;
try {
  // lib/ingest/index.js must export { compose }
  ({ compose } = require("../lib/ingest"));
} catch (e) {
  console.error("❌ Unable to load lib/ingest/index.js compose(). Error:", e);
  process.exit(1);
}

(async () => {
  try {
    if (!MD_FILE) {
      console.error("❌ Missing --md <markdown-file>");
      process.exit(1);
    }
    const absMd = path.resolve(MD_FILE);
    if (!fs.existsSync(absMd)) {
      console.error(`❌ Markdown file not found: ${absMd}`);
      process.exit(1);
    }
    const rawMarkdown = await fsp.readFile(absMd, "utf8");

    // --- Load existing docs (tolerant shapes) ---
    const docsDir = path.join(process.cwd(), "docs");
    const existing = await loadExisting(docsDir);

    // --- Run ingestion pipeline ---
    const result = await compose({ rawMarkdown, existing });
    // result: { registry, search (or null), searchManifest (maybe), searchShards (maybe), cross, stats }

    // --- Write to /docs locally (inspect before committing) ---
    await writeOutputs(docsDir, result);

    // --- Build commit payload (single OR sharded) ---
    const payload = buildPayloadForCommit(result);
    await fsp.writeFile(OUT_PAYLOAD, JSON.stringify(payload, null, 2), "utf8");
    logOk(`Wrote payload → ${OUT_PAYLOAD}`);

    if (!DO_COMMIT) {
      console.log("\n✅ Ingest complete. Open the /docs folder and kb-payload.json to review.");
      console.log("ℹ️ To commit to your API, re-run with --commit --base https://<your-app> --key <KB_PROTECT_KEY> [--origin https://yoursite]");
      process.exit(0);
    }

    // --- Commit to /api/kb/commit ---
    if (!global.fetch) {
      try { global.fetch = (await import("node-fetch")).default; } catch {}
    }
    const commitUrl = new URL("/api/kb/commit", BASE).toString();
    const res = await fetch(commitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KB_KEY ? { "x-kb-key": KB_KEY } : {}),
        ...(ORIGIN ? { "Origin": ORIGIN } : {})
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      console.error("❌ Commit failed", res.status, data);
      process.exit(1);
    }
    logOk(`Committed canonicals to ${commitUrl}`);
    console.log(JSON.stringify(data.stats || {}, null, 2));
  } catch (e) {
    console.error("❌ Error:", e);
    process.exit(1);
  }
})();

// ----------------- helpers -----------------
async function loadJSON(p) {
  try { return JSON.parse(await fsp.readFile(p, "utf8")); }
  catch { return null; }
}

async function loadExisting(docsDir) {
  await fsp.mkdir(docsDir, { recursive: true });
  const reg = await loadJSON(path.join(docsDir, "registry.json"));
  const cross = await loadJSON(path.join(docsDir, "cross_links.json"));
  // Either single search.json OR sharded manifest
  const singleSearch = await loadJSON(path.join(docsDir, "search.json"));
  const man = await loadJSON(path.join(docsDir, "search", "index.json"));

  let searchExisting = null;
  if (singleSearch) searchExisting = singleSearch;
  else if (man) searchExisting = man;
  // Tolerant shape: pass through what we have
  return { registry: reg || [], search: searchExisting || [], cross: cross || { nodes: [], edges: [] } };
}

async function writeOutputs(docsDir, result) {
  // 1) registry.json (preserve shape: array or envelope)
  const regOut = Array.isArray(result.registry) ? result.registry : result.registry.items ? { items: result.registry.items } : result.registry;
  await fsp.writeFile(path.join(docsDir, "registry.json"), JSON.stringify(regOut, null, 2), "utf8");
  logOk("registry.json written");

  // 2) search: single or sharded
  if (result.searchManifest && Array.isArray(result.searchShards) && !result.search) {
    const searchDir = path.join(docsDir, "search");
    await fsp.mkdir(searchDir, { recursive: true });
    await fsp.writeFile(path.join(searchDir, "index.json"), JSON.stringify(result.searchManifest, null, 2), "utf8");
    for (const s of result.searchShards) {
      await fsp.writeFile(path.join(searchDir, s.file), JSON.stringify(s.data, null, 2), "utf8");
    }
    // remove single if it exists
    try { await fsp.unlink(path.join(docsDir, "search.json")); } catch {}
    logOk("search manifest + shards written");
  } else {
    // single
    await fsp.writeFile(path.join(docsDir, "search.json"), JSON.stringify(result.search, null, 2), "utf8");
    // remove manifest/shards directory if any
    try { await fsp.unlink(path.join(docsDir, "search", "index.json")); } catch {}
    try {
      const files = await fsp.readdir(path.join(docsDir, "search"));
      await Promise.all(
        files.filter(f => /^search-\d+\.json$/i.test(f)).map(f => fsp.unlink(path.join(docsDir, "search", f)))
      );
    } catch {}
    logOk("search.json written");
  }

  // 3) cross_links.json
  await fsp.writeFile(path.join(docsDir, "cross_links.json"), JSON.stringify(result.cross, null, 2), "utf8");
  logOk("cross_links.json written");

  // 4) kb_stats.json (always)
  await fsp.writeFile(path.join(docsDir, "kb_stats.json"), JSON.stringify(result.stats, null, 2), "utf8");

  // 5) kb_health_history.json (append last 365)
  const histPath = path.join(docsDir, "kb_health_history.json");
  let history = [];
  try { history = JSON.parse(await fsp.readFile(histPath, "utf8")); } catch {}
  const compact = { ts: result.stats.ts, counts: result.stats.counts, delta: result.stats.delta, roi: result.stats.roi, size_kb: result.stats.sizes_kb };
  const nextHistory = Array.isArray(history) ? [...history, compact].slice(-365) : [compact];
  await fsp.writeFile(histPath, JSON.stringify(nextHistory, null, 2), "utf8");
  logOk("kb_stats.json + kb_health_history.json written");
}

function buildPayloadForCommit(result) {
  // Preserve shapes; support single or sharded post
  if (result.searchManifest && Array.isArray(result.searchShards) && !result.search) {
    return {
      registry: result.registry,
      cross: result.cross,
      searchManifest: result.searchManifest,
      searchShards: result.searchShards,
      message: "KB: ingest (sharded)"
    };
  }
  return {
    registry: result.registry,
    search: result.search,
    cross: result.cross,
    message: "KB: ingest (single)"
  };
}

function logOk(msg) {
  console.log(`✅ ${msg}`);
}
