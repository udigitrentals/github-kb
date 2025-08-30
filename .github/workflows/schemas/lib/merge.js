function asArrayOrEnvelope(input){ return Array.isArray(input) ? { type:"array", data:input } : { type:"envelope", data:input }; }

function upsertRegistry(existing, item){
  const env = asArrayOrEnvelope(existing);
  const arr = env.type==="array" ? env.data : (existing.items || existing.docs || existing.registry || []);
  const idx = arr.findIndex(x=>x.id===item.id);
  if (idx>=0) { arr[idx] = { ...arr[idx], ...item, updated_at: item.updated_at }; }
  else arr.push(item);
  return env.type==="array" ? arr : { ...(existing.items?{items:arr}:existing.docs?{docs:arr}:{registry:arr}) };
}

function ensureUniqueSlug(slug, taken){
  let s=slug, i=2;
  while (taken.has(s)) s = `${slug}-${i++}`;
  taken.add(s);
  return s;
}

function upsertSearch(existing, doc){
  const env = asArrayOrEnvelope(existing);
  const arr = env.type==="array" ? env.data : (existing.docs || existing.items || []);
  const idx = arr.findIndex(x=>x.id===doc.id);
  if (idx>=0) { arr[idx] = { ...arr[idx], ...doc, updated_at: doc.updated_at }; }
  else arr.push(doc);
  return env.type==="array" ? arr : { ...(existing.docs?{docs:arr}:{items:arr}) };
}

module.exports = { upsertRegistry, upsertSearch, ensureUniqueSlug };
