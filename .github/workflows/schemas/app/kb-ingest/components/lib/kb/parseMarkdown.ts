export type SearchDoc = {
  id: string; title: string; url: string; excerpt: string;
  tags: string[]; content: string; hash: string; updated_at: string;
};
export type RegistryItem = {
  id: string; type: 'block'; title: string; path: string; version: string; description: string;
};
export type Edge = { source: string; target: string; };

const DEFAULT_DATE = new Date().toISOString().slice(0,10);

const slugify = (s: string) =>
  s.trim().toLowerCase()
   .replace(/[—–]/g,'-')
   .normalize('NFKD')
   .replace(/[^a-z0-9 \-_/]/g,'')
   .replace(/\//g,'-')
   .replace(/\s+/g,'-')
   .replace(/-+/g,'-')
   .replace(/^-|-$/g,'');

const rxAllBlocks = /^##\s*Block\s+(\d+)\s*[—–-]\s*(.+)$/mg;

function parseYaml(snippet: string): Record<string, any> {
  const m = snippet.match(/```yaml([\s\S]*?)```/);
  if (!m) return {};
  const lines = m[1].split('\n').map(l=>l.trim()).filter(Boolean);
  const out: Record<string, any> = {};
  for (const line of lines) {
    const i = line.indexOf(':'); if (i<0) continue;
    const k = line.slice(0,i).trim();
    let v = line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1,-1);
      out[k] = v ? v.split(',').map(s=>s.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean) : [];
    } else out[k] = v;
  }
  return out;
}
const pickLine = (label: string, block: string) => {
  const rx = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`,'i');
  const m = block.match(rx); return m ? m[1].trim() : '';
};

export function parseKBMarkdown(md: string): { docs: SearchDoc[], registry: RegistryItem[], edges: Edge[] } {
  const rawHeaders = [...md.matchAll(rxAllBlocks)].map(m=>({num:Number(m[1]), title:m[2].trim(), idx:m.index!}));

  // keep last instance of each block number
  const last = new Map<number, {title:string; idx:number}>();
  for (const h of rawHeaders) { const e = last.get(h.num); if (!e || h.idx>e.idx) last.set(h.num,{title:h.title, idx:h.idx}); }

  const ordered = [...last.entries()].map(([num,v])=>({num, ...v})).sort((a,b)=>a.idx-b.idx);
  const slices = ordered.map((h,i)=>({ num:h.num, title:h.title, start:h.idx, end: i+1<ordered.length? ordered[i+1].idx: md.length }));

  const docs: SearchDoc[] = [];
  const registry: RegistryItem[] = [];
  const edges: Edge[] = [];

  for (const s of slices) {
    const block = md.slice(s.start, s.end).trim();
    const yaml = parseYaml(block);
    const headerTitle = yaml.title || s.title;
    const id = (yaml.id || `block-${s.num}`).toLowerCase();
    const slug = slugify(headerTitle) || `block-${s.num}`;
    const url = `./blocks/block-${s.num}-${slug}.md`;
    const path = `blocks/block-${s.num}-${slug}.md`;
    const excerpt = pickLine('Context\\s*&\\s*Definitions', block) || block.slice(0,300);
    const tags = [
      ...(Array.isArray(yaml.tags) ? yaml.tags : []),
      ...pickLine('Tags', block).split(',')
    ].map(t=>t.trim().toLowerCase()).filter(Boolean)
     .filter((v,i,a)=>a.indexOf(v)===i);
    const updated = yaml.created_at || DEFAULT_DATE;

    docs.push({ id, title: headerTitle, url, excerpt, tags, content: block, hash: `${s.num}-${slug}`, updated_at: updated });

    const desc = [pickLine('Context\\s*&\\s*Definitions', block), pickLine('Insights', block), pickLine('Benefits', block)]
      .filter(Boolean).join(' ').slice(0,500);

    registry.push({ id, type:'block', title: headerTitle, path, version:'v1.0', description: desc });

    const yamlLinks: string[] = Array.isArray(yaml.cross_links) ? yaml.cross_links : [];
    const lineLinks = pickLine('Cross-links', block).split(/[,;]\s*/).map(s=>s.trim()).filter(Boolean);
    const allLinks = [...yamlLinks, ...lineLinks].filter((v,i,a)=>a.indexOf(v)===i);
    for (const t of allLinks) {
      const tgt = t.startsWith('/') ? t : `/${slugify(t)}`;
      edges.push({ source: `/blocks/block-${s.num}-${slug}`, target: tgt });
    }
  }
  return { docs, registry, edges };
}
