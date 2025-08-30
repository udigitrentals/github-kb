const { stableId, sha256Bytes, slugifyTitle } = require("./ids");

function removeFences(s){ return s.replace(/```[\s\S]*?```/gm, ""); }

function makeTokens(md){
  const noCode = removeFences(md);
  return noCode
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLines(s, nChars=260){
  const plain = s.replace(/[`*_#>\[\]\(\)]/g, " ").replace(/\s+/g, " ").trim();
  return plain.slice(0, nChars);
}

function pickTitle(headerLine, blockNumber, rawBlock){
  // e.g., "## Block 12 — Strategic Focus"
  const line = headerLine.replace(/^#+\s*/,"").trim();
  const parts = line.split(/—|-{2,}|-/);
  const maybeShort = parts.slice(1).join("—").trim();
  return `Block ${blockNumber} — ${maybeShort || "Untitled"}`;
}

function buildDocs({ rawBlock, blockNumber, headerLine }, opts){
  const id = stableId(rawBlock);
  const title = pickTitle(headerLine, blockNumber, rawBlock);
  const slug = slugifyTitle(title);
  const path = `/docs/md/${slug}.md`;
  const now = new Date().toISOString();

  const { sections, tags_raw, cross_links_raw, roi_raw } = opts.sectionData;
  const tags = Array.from(new Set(tags_raw));

  const description = firstLines(sections.context || sections.insights || rawBlock, 200);
  const snippet = sections.benefits ? firstLines(sections.benefits, 120) : "";

  const sha256 = sha256Bytes(Buffer.from(rawBlock, "utf8"));

  const registry = {
    id, title, slug, path, tags,
    created_at: now, updated_at: now,
    summary: firstLines((sections.context || sections.insights || sections.benefits || rawBlock), 320),
    links: []
  };

  const search = {
    id, title, description, snippet, tags,
    content: rawBlock,                           // LOSSLESS
    tokens: makeTokens(rawBlock),                // search-only
    attachments: {
      raw_markdown: rawBlock,                    // LOSSLESS (must === content)
      sha256,
      sections: {
        context: sections.context || "",
        insights: sections.insights || "",
        offer_applications: sections["offer_applications"] || sections["offer applications"] || "",
        benefits: sections.benefits || "",
        risks: sections.risks || "",
        mitigations: sections.mitigations || "",
        cross_links_raw,
        tags_raw,
        roi_raw
      },
      meta: { block_number: blockNumber, header_line: headerLine }
    },
    created_at: now, updated_at: now
  };

  if (search.content !== search.attachments.raw_markdown) {
    throw new Error("Lossless breach: content !== attachments.raw_markdown");
  }

  return { id, slug, path, registry, search, cross_links_raw, roi_raw };
}

module.exports = { buildDocs };
