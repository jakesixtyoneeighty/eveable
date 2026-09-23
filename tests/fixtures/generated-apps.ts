import { ImplementationSpecSchema } from "../../agent/lib/schemas.js";

// Independent examples of provider output, not runtime templates or model evals.
export const editorialSpec = ImplementationSpecSchema.parse({
  agent: "code_writer",
  status: "spec_ready",
  message: "Approved editorial site",
  brandName: "Field Notes",
  projectSlug: "field-notes",
  brief: "A French architecture journal with an archive page.",
  audience: "Architects",
  visualDirection:
    "A printed field notebook: wide margins, serif headlines, ruled captions.",
  sections: [
    {
      name: "Dossier",
      purpose: "Read the current issue",
      copy: "Habiter la ville",
    },
  ],
  palette: {
    primary: "#28352d",
    accent: "#b95836",
    background: "#f7f3e8",
    foreground: "#232923",
  },
  imageUrls: ["https://media.example.com/approved-building.jpg"],
  language: "fr",
  pages: [
    { path: "/", title: "Journal", purpose: "Current issue" },
    { path: "/archives", title: "Archives", purpose: "Browse earlier issues" },
  ],
  interactions: ["Navigate from the journal to the archives"],
  constraints: ["No invented testimonials or addresses"],
  designTokens: {
    palette: {
      primary: "#28352d",
      secondary: "#b95836",
      accent: "#b95836",
      background: "#f7f3e8",
      foreground: "#232923",
      muted: "#676b61",
    },
    typography: { heading: "Georgia", body: "Arial", scale: ["1rem", "3rem"] },
    spacing: { unit: 8, scale: [8, 16, 32, 64] },
    radius: { card: "0", button: "0", input: "0" },
  },
  handoff: {
    nextTool: "generate_next_app_from_spec",
    reason: "Approved scope",
  },
});
export const editorialOutput = {
  files: [
    {
      path: "app/layout.tsx",
      purpose: "French journal layout",
      content:
        'import type { ReactNode } from "react";\nimport "./globals.css";\nexport const metadata = { title: "Field Notes — Journal" };\nexport default function Layout({ children }: { children: ReactNode }) { return <html lang="fr"><body>{children}</body></html>; }\n',
    },
    {
      path: "app/page.tsx",
      purpose: "Issue introduction",
      content:
        'import Link from "next/link";\nexport default function Page() { return <main><p>Field Notes</p><h1>Habiter la ville</h1><p>Un journal d’architecture.</p><Link href="/archives">Lire les archives</Link></main>; }\n',
    },
    {
      path: "app/archives/page.tsx",
      purpose: "Archive page",
      content:
        'import Link from "next/link";\nexport default function Archives() { return <main><h1>Archives</h1><p>Aucun numéro précédent.</p><Link href="/">Retour au journal</Link></main>; }\n',
    },
    {
      path: "app/globals.css",
      purpose: "Editorial visual system",
      content:
        "body{margin:0;background:#f7f3e8;color:#232923;font-family:Georgia,serif}main{max-width:65rem;margin:8vh auto;padding:2rem;border-top:1px solid #28352d}h1{font-size:clamp(2rem,6vw,5rem)}a{color:#28352d}a:focus-visible{outline:3px solid #b95836}",
    },
  ],
};
export const calculatorSpec = ImplementationSpecSchema.parse({
  ...editorialSpec,
  brandName: "Beam",
  projectSlug: "beam",
  language: "en",
  imageUrls: [],
  brief: "A browser-only area calculator; no external services.",
  audience: "Fabricators",
  visualDirection:
    "An instrument panel with aligned numeric fields and a large live measurement.",
  pages: [
    { path: "/", title: "Calculator", purpose: "Calculate rectangular area" },
  ],
  sections: [
    { name: "Measurement", purpose: "Compute area", copy: "Area calculator" },
  ],
  interactions: ["Changing width or height updates the area immediately"],
});
export const calculatorOutput = {
  files: [
    {
      path: "app/layout.tsx",
      purpose: "Calculator layout",
      content:
        'import type { ReactNode } from "react";\nimport "./globals.css";\nexport const metadata = { title: "Beam — Area calculator" };\nexport default function Layout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n',
    },
    {
      path: "app/page.tsx",
      purpose: "Interactive measurement tool",
      content:
        '"use client";\nimport { useState } from "react";\nexport default function Page() { const [width,setWidth]=useState(2); const [height,setHeight]=useState(3); return <main><h1>Area calculator</h1><label>Width<input type="number" min="0" value={width} onChange={e=>setWidth(Math.max(0,Number(e.target.value)))} /></label><label>Height<input type="number" min="0" value={height} onChange={e=>setHeight(Math.max(0,Number(e.target.value)))} /></label><output aria-live="polite">{width*height} m²</output></main>; }\n',
    },
    {
      path: "app/globals.css",
      purpose: "Instrument layout",
      content:
        "body{background:#172b35;color:#f8f7ef;font:1rem monospace;margin:0}main{max-width:50rem;margin:auto;padding:4rem 1rem;display:grid;gap:2rem}label{display:flex;justify-content:space-between;gap:1rem}input{max-width:8rem;padding:.75rem;font:inherit}output{font-size:clamp(2rem,6vw,6rem);border-top:2px solid;padding-top:1rem}input:focus-visible{outline:3px solid #ffaa44}",
    },
  ],
};
