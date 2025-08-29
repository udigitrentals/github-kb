# U-Dig It KB — Cloudflare Pages Starter

This starter lets you deploy your KB JSONs with clean headers and instant, cache-safe delivery.

## Files
- `kb/registry.json` — replace with your merged registry
- `kb/cross_links.json` — replace with your cross-link graph
- `kb/search.json` — replace with your search index
- `kb/index.html` — human viewer to eyeball live JSONs
- `_headers` — serves `/kb/*` as JSON with `no-store` caching
- `.github/workflows/validate-kb.yml` — CI check that JSON is valid

## Deploy (Cloudflare Pages)
1. Push this folder to a GitHub repo (e.g., `udigit-kb`).
2. In Cloudflare: Pages → **Create Project** → Connect GitHub → select repo.
3. Build: **None**. Output directory: `/` (root).
4. Deploy. You get `https://<project>.pages.dev`.
5. In Cloudflare DNS: add CNAME `kb` → `<project>.pages.dev` (orange cloud ON).
6. Verify:
   - `https://kb.udigit.ca/kb/registry.json`
   - `https://kb.udigit.ca/kb/cross_links.json`
   - `https://kb.udigit.ca/kb/search.json`

## Netlify/Vercel (alternative)
- Same repo. No build step. Ensure `_headers` is at repo root.
- Verify the 3 JSON URLs return `200` and valid JSON.

## Local sanity check
```bash
jq . kb/registry.json
jq . kb/cross_links.json
jq . kb/search.json
```

## Curl verification
```bash
curl -I https://kb.udigit.ca/kb/registry.json
curl -s https://kb.udigit.ca/kb/registry.json | head -c 300 && echo
```

## Next steps
- Replace placeholder JSON contents with your real merged KB outputs.
- Commit and push. Cloudflare Pages redeploys automatically.
