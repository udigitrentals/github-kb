// app/layout.tsx (excerpt)
import Link from "next/link";
export default function RootLayout({ children }) {
  return (
    <html lang="en"><body>
      <header style={{padding:12,borderBottom:"1px solid #eee"}}>
        <nav style={{display:"flex", gap:16}}>
          {/* other links ... */}
          <Link href="/kb-ingest">KB → Ingest & Merge</Link>
        </nav>
      </header>
      {children}
    </body></html>
  );
}
