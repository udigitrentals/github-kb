module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const body = await readBody(req);
    const cid  = req.headers['x-correlation-id'] || Math.random().toString(36).slice(2);
    console.log(JSON.stringify({ event: 'kb.telemetry', ts: new Date().toISOString(), correlationId: cid, ...body }));
    res.setHeader('x-correlation-id', cid);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: 'bad_request' });
  }
};
function readBody(req) { return new Promise((resolve,reject)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{resolve(JSON.parse(d||'{}'))}catch(e){reject(e)} }); req.on('error',reject); }); }
