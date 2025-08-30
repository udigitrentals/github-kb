const PRIMARY = /^\s*##\s*Block\s+(\d+)\b[^\n]*$/gmi;
const FALLBACKS = [/^\s*##\s+/gmi, /^\s*#\s+/gmi];

function segmentIntoBlocks(raw) {
  const indices = [];
  let m;
  PRIMARY.lastIndex = 0;
  while ((m = PRIMARY.exec(raw))) indices.push({ idx: m.index, header: m[0], num: Number(m[1]) });

  // if none found, try fallbacks
  if (!indices.length) {
    for (const re of FALLBACKS) {
      re.lastIndex = 0;
      let fm;
      while ((fm = re.exec(raw))) indices.push({ idx: fm.index, header: fm[0], num: null });
      if (indices.length) break;
    }
  }
  if (!indices.length) return [{ blockNumber: 1, headerLine: "Block 1 — (implicit)", rawBlock: raw }];

  indices.sort((a,b)=>a.idx-b.idx);
  const out = [];
  for (let i=0;i<indices.length;i++){
    const start = indices[i].idx;
    const end = i+1<indices.length ? indices[i+1].idx : raw.length;
    out.push({
      blockNumber: indices[i].num || (i+1),
      headerLine: indices[i].header.trim(),
      rawBlock: raw.slice(start, end)
    });
  }
  return out;
}
module.exports = { segmentIntoBlocks };
