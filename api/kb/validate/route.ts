// app/api/kb/validate/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import Ajv from "ajv";

// import your repo's schemas
// If TypeScript complains, add "resolveJsonModule": true to tsconfig.
import regSchema from "@/schemas/registry.schema.json";
import searchSchema from "@/schemas/search.schema.json";
import xSchema from "@/schemas/cross_links.schema.json";

const ajv = new Ajv({ allErrors: true, strict: false });
const vReg = ajv.compile(regSchema as any);
const vSearch = ajv.compile(searchSchema as any);
const vCross = ajv.compile(xSchema as any);

export async function POST(req: NextRequest) {
  const { registry, search, cross } = await req.json();
  const okR = vReg(registry);
  const okS = vSearch(search);
  const okC = vCross(cross);
  const ok = !!(okR && okS && okC);
  return NextResponse.json({
    ok,
    errors: {
      registry: vReg.errors || [],
      search: vSearch.errors || [],
      cross: vCross.errors || []
    }
  });
}
