module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const cid = req.headers['x-correlation-id'] || Math.random().toString(36).slice(2);
    const body = await readBody(req);
    console.log(JSON.stringify({ event: 'kb.telemetry', ts: new Date().toISOString(), correlationId: cid, ...body }));
    res.setHeader('x-correlation-id', cid);
    res.status(204).end();
  } catch (e) {
    console.error(JSON.stringify({ event: 'kb.telemetry.error', error: String(e?.message || e) }));
    res.status(400).json({ error: 'bad_request' });
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
