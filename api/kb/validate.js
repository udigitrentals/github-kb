const Ajv = require('ajv');
const fs = require('fs').promises;
const path = require('path');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const t0 = Date.now();
  let payload; try { payload = await readBody(req); } catch (e) {
    return res.status(400).json({ error: 'invalid_json', detail: String(e?.message || e) });
  }
  const { registry, search, cross } = payload || {};
  const ajv = new Ajv({ allErrors: true, strict: false });

  try {
    const [regS, seaS, xlnS] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'schemas/registry.schema.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'schemas/search.schema.json'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'schemas/cross_links.schema.json'), 'utf8')
    ]);
    const okR = ajv.validate(JSON.parse(regS), registry);
    const okS = ajv.validate(JSON.parse(seaS), search);
    const okX = ajv.validate(JSON.parse(xlnS), cross);
    const ok  = okR && okS && okX;

    const counts = {
      registry_items: Array.isArray(registry) ? registry.length :
        Array.isArray(registry?.items) ? registry.items.length :
        Array.isArray(registry?.registry) ? registry.registry.length : 0,
      search_docs: Array.isArray(search) ? search.length :
        Array.isArray(search?.docs) ? search.docs.length :
        Array.isArray(search?.items) ? search.items.length : 0
    };

    console.log(JSON.stringify({
      event: 'kb.validate',
      ts: new Date().toISOString(),
      correlationId: req.headers['x-correlation-id'] || null,
      ok, counts, elapsed_ms: Date.now() - t0
    }));

    return res.status(200).json({ ok, counts, errors: ajv.errors || [] });
  } catch (e) {
    return res.status(500).json({ error: 'validation_failed', detail: String(e?.message || e) });
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}
