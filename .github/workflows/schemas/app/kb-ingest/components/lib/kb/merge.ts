import type { SearchDoc, RegistryItem, Edge } from './parseMarkdown';

export function mergeRegistry(existing: any, add: RegistryItem[]) {
  const out = {...existing};
  const items: any[] = Array.isArray(existing?.items) ? [...existing.items] : [];
  const byId = new Map(items.map((x)=>[x.id, x]));
  for (const it of add) if (!byId.has(it.id)) items.push(it);
  out.items = items;
  out.updated_at = new Date().toISOString();
  return out;
}

export function mergeSearch(existing: any, addDocs: SearchDoc[]) {
  const out = {...existing};
  const docs: any[] = Array.isArray(existing?.docs) ? [...existing.docs] : [];
  const byId = new Map(docs.map((d)=>[d.id, d]));
  for (const d of addDocs) {
    if (byId.has(d.id)) {
      const cur = byId.get(d.id)!;
      if (d.hash && d.hash !== cur.hash) Object.assign(cur, d);
    } else docs.push(d);
  }
  out.docs = docs;
  out.synonyms = existing?.synonyms ?? {};
  out.updated_at = new Date().toISOString();
  return out;
}

export function mergeEdges(existing: any, add: Edge[]) {
  const edges: Edge[] = Array.isArray(existing?.edges) ? [...existing.edges] : [];
  const seen = new Set(edges.map(e=>`${e.source}→${e.target}`));
  for (const e of add) { const k = `${e.source}→${e.target}`; if (!seen.has(k)) { seen.add(k); edges.push(e); } }
  return { edges };
}
