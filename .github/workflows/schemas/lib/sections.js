const SEC_NAMES = [
  "Context","Insights","Offer Applications","Benefits","Risks","Mitigations",
  "Cross-links","Cross links","Crosslinks","Tags","ROI Takeaway","ROI"
];

function extractSections(block) {
  const text = block;
  const fenceRE = /```[\s\S]*?```/gm; // ignore fenced code for section recognition
  const scan = text.replace(fenceRE, "");
  const lines = scan.split(/\r?\n/);

  const idx = {};
  const patterns = [
    (n)=>new RegExp("^###\\s+"+n+"\\s*$","i"),
    (n)=>new RegExp("^\\*\\*"+n+"\\:\\*\\*\\s*$","i"),
    (n)=>new RegExp("^"+n+"\\:\\s*$","i"),
  ];

  const marks = [];
  for (let i=0;i<lines.length;i++){
    for (const name of SEC_NAMES){
      for (const mk of patterns){
        if (mk(name).test(lines[i])) { marks.push({ name, line:i }); break; }
      }
    }
  }
  marks.sort((a,b)=>a.line-b.line);
  const sec = {};
  for (let i=0;i<marks.length;i++){
    const s = marks[i], e = marks[i+1]?.line ?? lines.length;
    sec[s.name.toLowerCase().replace(/[\s-]/g,"_")] = lines.slice(s.line+1, e).join("\n").trim();
  }

  const tags_raw = (sec["tags"] || sec["tags_"] || "").split(/[,\s;|/]+/).map(t=>t.toLowerCase().trim()).filter(Boolean);
  const cross_links_raw = Array.from((sec["cross-links"]||sec["cross_links"]||sec["crosslinks"]||"").matchAll(/\S+/g)).map(m=>m[0]);

  // ROI parse (defaults applied later)
  const roi_raw = sec["roi_takeaway"] || sec["roi"] || "";
  return { sections: sec, tags_raw, cross_links_raw, roi_raw };
}
module.exports = { extractSections };
