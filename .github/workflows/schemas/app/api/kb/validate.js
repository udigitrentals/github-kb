// Vercel Serverless Function (ESM, Node 18+)
import Ajv from "ajv";
import fs from "node:fs/promises";
import path from "node:path";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const { registry, search, cross } = await readBody(req);
    const ajv = new Ajv({ allErrors: true, strict: false });

    const regSchema  = JSON.parse(await fs.readFile(path.join(process.cwd(), "schemas/registry.schema.json"), "utf8"));
    const srchSchema = JSON.parse(await fs.readFile(path.join(process.cwd(), "schemas/search.schema.json"), "utf8"));
    const xSchema    = JSON.parse(await fs.readFile(path.join(process.cwd(), "schemas/cross_links.schema.json"), "utf8"));

    const okR = ajv.validate(regSchema,  registry);
    const okS = ajv.validate(srchSchema, search);
    const okX = ajv.validate(xSchema,    cross);

    const ok = okR && okS && okX;

    // Soft audit (warn if content not present)
    const warns = [];
    if (Array.isArray(search?.docs)) {
      const missing = search.docs.filter(d => !d.content).map(d => d.id);
      if (missing.length) warns.push({ code: "search_doc_missing_content", count: missing.length, sample: missing.slice(0,5) });
    }

    return res.status(200).json({ ok, errors: { registry: ajv.errors || [] }, warns });
  } catch (e) {
    return res.status(400).json({ error: "bad_request", detail: String(e?.message || e) });
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
