const Ajv = require('ajv');
const fs = require('fs').promises;
const path = require('path');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const payload = await readBody(req);
    const { registry, search, cross } = payload || {};

    const ajv = new Ajv({ allErrors: true, strict: false });

    const regSchema  = JSON.parse(await fs.readFile(path.join(process.cwd(), 'schemas/registry.schema.json'), 'utf8'));
    const seaSchema  = JSON.parse(await fs.readFile(path.join(process.cwd(), 'schemas/search.schema.json'), 'utf8'));
    const xlnSchema  = JSON.parse(await fs.readFile(path.join(process.cwd(), 'schemas/cross_links.schema.json'), 'utf8'));

    const okR = ajv.validate(regSchema, registry);
    const okS = ajv.validate(seaSchema,  search);
    const okX = ajv.validate(xlnSchema,  cross);
    const ok  = okR && okS && okX;

    const warns = [];
    if (Array.isArray(search?.docs)) {
      const missing = search.docs.filter(d => !d.content).map(d => d.id).slice(0, 10);
      if (missing.length) warns.push({ code: 'doc_missing_content', sample: missing });
    }

    return res.status(200).json({ ok, errors: ajv.errors || [], warns });
  } catch (e) {
    return res.status(400).json({ error: 'bad_request', detail: String(e?.message || e) });
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
