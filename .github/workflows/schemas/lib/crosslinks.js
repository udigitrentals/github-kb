function stripFences(s){ return s.replace(/```[\s\S]*?```/gm, ""); }

function extractRawLinks(md) {
  const src = stripFences(md);
  const out = [];
  const mdLinkRE = /\[([^\]]+)\]\(([^)]+)\)/g;
  const wikiRE = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = mdLinkRE.exec(src))) out.push(m[2]);
  while ((m = wikiRE.exec(src)))  out.push(m[1]);
  return out;
}

function resolveEdges(rawTargets, knownByPathOrSlug) {
  // knownByPathOrSlug: Map<string /*path|slug|title*/, canonicalPath>
  return rawTargets.map(t=>{
    let target = null;
    if (knownByPathOrSlug.has(t)) target = knownByPathOrSlug.get(t);
    else {
      // title substring heuristic
      const hit = Array.from(knownByPathOrSlug.keys()).find(k => k.toLowerCase().includes(String(t).toLowerCase()));
      if (hit) target = knownByPathOrSlug.get(hit);
    }
    return { target: target || t, status: target ? "ok" : "pending" };
  });
}
module.exports = { extractRawLinks, resolveEdges };
