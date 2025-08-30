'use client';
import { useState } from 'react';
import { parseKBMarkdown } from '@/lib/kb/parseMarkdown';
import { mergeRegistry, mergeSearch, mergeEdges } from '@/lib/kb/merge';

type F = File | null;

export default function KBUploader() {
  const [md, setMd] = useState<F>(null);
  const [reg, setReg] = useState<F>(null);
  const [sea, setSea] = useState<F>(null);
  const [xln, setXln] = useState<F>(null);
  const [result, setResult] = useState<any|null>(null);
  const [loading, setLoading] = useState(false);

  async function readText(f: F){ return f ? await f.text() : ''; }
  async function readJSON(f: F){ return f ? JSON.parse(await f.text()) : null; }

  async function handleGo() {
    setLoading(true);
    try {
      const mdText = await readText(md);
      if (!mdText) throw new Error('Please upload Markdown.');
      const { docs, registry, edges } = parseKBMarkdown(mdText);

      const existingRegistry = (await readJSON(reg)) ?? {items:[], updated_at:''};
      const existingSearch   = (await readJSON(sea)) ?? {docs:[], synonyms:{}, updated_at:''};
      const existingXLinks   = (await readJSON(xln)) ?? {edges:[]};

      const mergedRegistry = mergeRegistry(existingRegistry, registry);
      const mergedSearch   = mergeSearch(existingSearch, docs);
      const mergedXLinks   = mergeEdges(existingXLinks, edges);

      setResult({ fromMarkdown: {registry, docs, edges}, merged: {mergedRegistry, mergedSearch, mergedXLinks}});
    } catch (e:any) {
      alert(e?.message || String(e));
    } finally { setLoading(false); }
  }

  function download(name: string, obj: any) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }

  return (
    <div style={{display:'grid', gap:16, maxWidth:960}}>
      <h2>KB Ingest & Merge</h2>

      <div>
        <label>Upload Markdown (.md)</label><br/>
        <input type="file" accept=".md, text/markdown" onChange={e=>setMd(e.target.files?.[0] || null)} />
      </div>

      <details>
        <summary>Optional: Upload current JSONs (to merge)</summary>
        <div style={{display:'grid', gap:8, marginTop:8}}>
          <label>registry.json <input type="file" accept="application/json" onChange={e=>setReg(e.target.files?.[0]||null)}/></label>
          <label>search.json   <input type="file" accept="application/json" onChange={e=>setSea(e.target.files?.[0]||null)}/></label>
          <label>cross_links.json <input type="file" accept="application/json" onChange={e=>setXln(e.target.files?.[0]||null)}/></label>
        </div>
      </details>

      <button disabled={loading} onClick={handleGo}>{loading?'Processing…':'Parse & Merge'}</button>

      {result && (
        <div style={{display:'grid', gap:12}}>
          <h3>From Markdown</h3>
          <div>registry items: {result.fromMarkdown.registry.length} • docs: {result.fromMarkdown.docs.length} • edges: {result.fromMarkdown.edges.length}</div>
          <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
            <button onClick={()=>download('registry.json', {updated_at:new Date().toISOString(), items:result.fromMarkdown.registry})}>Download registry.json</button>
            <button onClick={()=>download('search.json', {updated_at:new Date().toISOString(), docs:result.fromMarkdown.docs, synonyms:{}})}>Download search.json</button>
            <button onClick={()=>download('cross_links.json', {edges:result.fromMarkdown.edges})}>Download cross_links.json</button>
          </div>

          <h3>Merged</h3>
          <div>registry: {result.merged.mergedRegistry.items.length} • docs: {result.merged.mergedSearch.docs.length} • edges: {result.merged.mergedXLinks.edges.length}</div>
          <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
            <button onClick={()=>download('registry.merged.json', result.merged.mergedRegistry)}>Download merged registry</button>
            <button onClick={()=>download('search.merged.json', result.merged.mergedSearch)}>Download merged search</button>
            <button onClick={()=>download('cross_links.merged.json', result.merged.mergedXLinks)}>Download merged cross_links</button>
          </div>
        </div>
      )}
    </div>
  );
}
