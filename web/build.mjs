// Builds one self-contained page: dist/index.html (artifact content) and dist/preview.html (full document for tests).
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const prod = { "process.env.NODE_ENV": '"production"' };
const worker = await esbuild.build({
  entryPoints: ["src/worker.ts"], bundle: true, minify: true, format: "iife", write: false, target: "es2020",
  loader: { ".json": "json" }, define: prod, legalComments: "none",
  banner: { js: "(function(self){" }, footer: { js: "})(typeof WorkerGlobalScope!=='undefined'?self:window.__engineShim);" },
});
const qa = existsSync("build/qa-summary.json") ? readFileSync("build/qa-summary.json", "utf8") : "null";
const main = await esbuild.build({
  entryPoints: ["src/ui/main.tsx"], bundle: true, minify: true, format: "iife", write: false, target: "es2020",
  jsx: "automatic", define: { ...prod, __QA__: qa }, legalComments: "none",
});
const safe = (js) => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const workerJs = safe(worker.outputFiles[0].text), mainJs = safe(main.outputFiles[0].text);
const css = readFileSync("src/ui/styles.css", "utf8").replace(/\n\s*/g, "\n");
const body = `<title>Structures DST</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Highway structures decision support: SAMPT/SAVI-compatible valuation, 5-year programme and long-term plan with grounded AI">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:wght@400;600;700&display=swap">
<style>${css}</style>
<div id="root"></div>
<noscript><p style="padding:24px">This decision support tool needs JavaScript.</p></noscript>
<script type="text/plain" id="engine-src">${workerJs}</script>
<script>${mainJs}</script>
`;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", body);
// What the artifact host wraps the page in (doctype, charset, viewport, reset) - used by the Playwright tests.
writeFileSync("dist/preview.html", `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`);
// Hosted build (deploy/public): same page as a full document, with the AI endpoint served by deploy/api/claude.js.
const doc = (extraHead) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${extraHead}<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
mkdirSync("../deploy/public", { recursive: true });
writeFileSync("../deploy/public/index.html", doc('<meta name="dst-ai-endpoint" content="/api/claude">'));
const mb = (s) => (Buffer.byteLength(s) / 1e6).toFixed(2);
console.log(`worker ${mb(workerJs)} MB · page ${mb(mainJs)} MB · css ${mb(css)} MB · total ${mb(body)} MB`);
