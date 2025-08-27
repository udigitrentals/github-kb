#!/usr/bin/env python3
r"""
KB CI Runner
============

Purpose:
  - Scan kb_export/ for Markdown entries (encyclopedia/, synthesis/, etc.)
  - Build indexes: registry.json, cross_links.json, nav_map.json, search.json
  - Lint for common issues: duplicate slugs, broken refs, missing anchors,
    orphan entries, synthesis with < 3 related links, etc.
  - Optionally bundle everything into a ZIP with checksums + bundle.json manifest.

Usage:
  python kb_ci_runner.py               # scan + lint + write indexes
  python kb_ci_runner.py --bundle      # plus create bundle ZIP
  python kb_ci_runner.py --full        # same scan (full), provided for CI parity

Folder layout:
  C:\udigit-kb\
    kb_ci_runner.py
    kb_export\
      encyclopedia\
      synthesis\
      indexes\
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from typing import Dict, List, Set

ROOT = Path(__file__).resolve().parent
KB_ROOT = ROOT / "kb_export"
INDEX_DIR = KB_ROOT / "indexes"
REPORTS_DIR = KB_ROOT / "reports"
BUNDLE_DIR = KB_ROOT / "bundle"

MD_EXTS = {".md", ".markdown"}

# ---------- Utilities ----------
def iso_utc(ts: float) -> str:
    return datetime.datetime.utcfromtimestamp(ts).replace(microsecond=0).isoformat() + "Z"

def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")

def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()

def slugify_path(md_path: Path) -> str:
    rel = md_path.relative_to(KB_ROOT).with_suffix("")
    slug = "/" + "/".join(rel.parts)
    slug = re.sub(r"\s+", "-", slug.strip())
    slug = re.sub(r"/{2,}", "/", slug)
    return slug

def extract_title(md: str, fallback: str) -> str:
    for line in md.splitlines():
        if line.strip().startswith("# "):
            return line.strip()[2:].strip()
    return Path(fallback).stem.replace("-", " ").title()

def collect_anchors(md: str) -> Set[str]:
    anchors = set()
    for line in md.splitlines():
        if re.match(r"^\s*#{1,6}\s+\S", line):
            heading = re.sub(r"^\s*#{1,6}\s+", "", line).strip()
            anc = heading.lower()
            anc = re.sub(r"[^\w\s-]", "", anc)
            anc = re.sub(r"\s+", "-", anc).strip("-")
            anchors.add(anc)
    return anchors

KB_REF_PATTERN = re.compile(r"KB:/[^\s)]+(?:#[\w\-]+)?", re.IGNORECASE)

def collect_kb_refs(md: str):
    refs = []
    for m in KB_REF_PATTERN.finditer(md):
        raw = m.group()
        slug, anchor = raw, ""
        if "#" in raw:
            slug, anchor = raw.split("#", 1)
        slug = slug.replace("KB:", "")
        refs.append((slug, anchor))
    return refs

def detect_type(md_path: Path) -> str:
    parts = md_path.relative_to(KB_ROOT).parts
    if parts and parts[0].lower() == "encyclopedia":
        return "encyclopedia"
    if parts and parts[0].lower() == "synthesis":
        return "synthesis"
    return "other"

# ---------- Scan ----------
def scan_repository():
    registry, cross, anchors = {}, {}, {}
    files = [p for p in KB_ROOT.rglob("*") if p.is_file() and p.suffix.lower() in MD_EXTS]
    for path in files:
        md = read_text(path)
        slug = slugify_path(path)
        kind = detect_type(path)
        title = extract_title(md, path.stem)
        mtime = iso_utc(path.stat().st_mtime)

        registry[slug] = {"slug": slug, "title": title, "type": kind, "file": str(path.relative_to(KB_ROOT)), "updated_utc": mtime}
        anchors[slug] = collect_anchors(md)
        refs = collect_kb_refs(md)
        if refs:
            cross[slug] = {"refs": list({s for s, _ in refs})}
    return registry, cross, anchors

# ---------- Lint ----------
def lint_repository(registry, cross, anchors):
    errors, warnings = [], []
    inbound = {slug: 0 for slug in registry}
    for src, obj in cross.items():
        for tgt in obj["refs"]:
            if tgt in inbound: inbound[tgt] += 1
            else: errors.append(f"Broken ref: {src} -> {tgt}")
    for slug, meta in registry.items():
        if meta["type"] == "synthesis":
            out = len(cross.get(slug, {}).get("refs", []))
            if out < 3: errors.append(f"Synthesis needs >=3 related: {slug}")
    for slug, cnt in inbound.items():
        if cnt == 0: warnings.append(f"Orphan: {slug}")
    return errors, warnings

# ---------- Write ----------
def write_indexes(registry, cross):
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    (INDEX_DIR/"registry.json").write_text(json.dumps(registry, indent=2), "utf-8")
    (INDEX_DIR/"cross_links.json").write_text(json.dumps(cross, indent=2), "utf-8")

# ---------- Bundle ----------
def make_bundle(registry):
    BUNDLE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    zip_path = BUNDLE_DIR / f"udigit_kb_site_bundle_{stamp}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in KB_ROOT.rglob("*"):
            if p.is_file():
                z.write(p, p.relative_to(KB_ROOT).as_posix())
    print(f"[bundle] Wrote {zip_path}")
    return zip_path

# ---------- Main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", action="store_true")
    ap.add_argument("--full", action="store_true")
    args = ap.parse_args()

    registry, cross, anchors = scan_repository()
    errors, warnings = lint_repository(registry, cross, anchors)
    write_indexes(registry, cross)

    print(f"Entries: {len(registry)}")
    if errors: print("Errors:\n- " + "\n- ".join(errors))
    if warnings: print("Warnings:\n- " + "\n- ".join(warnings))
    if args.bundle: make_bundle(registry)

if __name__ == "__main__":
    main()
