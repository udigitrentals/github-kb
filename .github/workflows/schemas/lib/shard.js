function byteLen(obj){ return Buffer.byteLength(JSON.stringify(obj)); }
function shardIfNeeded(searchArray, targetMB=3, softCapMB=5){
  const maxB = softCapMB*1024*1024, targetB = targetMB*1024*1024;
  const full = { docs: searchArray };
  if (byteLen(full) <= maxB) return { single: full };

  // simple greedy packer
  const shards = []; let cur = []; let curB = 2; // []
  for (const d of searchArray){
    const dB = byteLen(d);
    if (curB + dB > targetB && cur.length) { shards.push(cur); cur = []; curB = 2; }
    cur.push(d); curB += dB + 1;
  }
  if (cur.length) shards.push(cur);

  const files = shards.map((docs, i)=>({ file:`search-${i+1}.json`, data:{ docs }, count:docs.length }));
  const manifest = { total: searchArray.length, shards: files.map(f=>({ file:f.file, count:f.count })) };
  return { manifest, files };
}
module.exports = { shardIfNeeded };
