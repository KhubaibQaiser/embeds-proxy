import express, { NextFunction, Request, Response } from "express";
import * as dotenv from "dotenv";
import path from "path";
// Add a comment
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function getCloudfrontBase(queryInjectorUrl?: string): string {
  // Query parameter takes precedence
  if (queryInjectorUrl && queryInjectorUrl.trim()) {
    return queryInjectorUrl.trim().replace(/\/$/, "");
  }

  // Single environment variable for injector URL
  const injectorUrl = (process.env.VITE_INJECTOR_URL || "").trim();
  return injectorUrl.replace(/\/$/, "");
}

const app = express();

app.use(express.json());

// CORS and framing allowances for preview usage
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader(
    "Content-Security-Policy",
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; media-src * data: blob:; frame-ancestors *; frame-src *; connect-src *; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/live", (req: Request, res: Response) => {
  (async () => {
    try {
      const targetUrlParam = (req.query.url as string) || "";
      if (!targetUrlParam) {
        res.status(400).send("Missing url query param");
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = new URL(targetUrlParam);
      } catch {
        res.status(400).send("Invalid url query param");
        return;
      }

      const upstream = await fetch(targetUrl.toString(), {
        headers: {
          "user-agent":
            req.headers["user-agent"]?.toString() ||
            "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15",
        },
      });

      const contentType = upstream.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        res.setHeader("content-type", contentType);
        const buffer = await upstream.arrayBuffer();
        res.send(Buffer.from(buffer));
        return;
      }

      let html = await upstream.text();

      // Remove CSP/XFO meta tags if present
      html = html.replace(/<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>\s*/gi, "");
      html = html.replace(/<meta[^>]*http-equiv=["']x-frame-options["'][^>]*>\s*/gi, "");

      // Ensure a <base href> so relative resources resolve to original site
      const baseHref = `${targetUrl.origin}/`;
      if (!/<base\s/i.test(html)) {
        html = html.replace(/<head(.*?)>/i, (m) => `${m}\n<base href="${baseHref}">`);
      }

      // Config from query params
      const qp = new URLSearchParams(req.url.split("?")[1] || "");

      // Build injector script URL from query param or env
      const queryInjectorUrl = qp.get("injector_url");
      const injectorBase = getCloudfrontBase(queryInjectorUrl || undefined);
      const injectorUrl = injectorBase ? `${injectorBase}/v2/shopsense-embed-injector.min.js` : "";
      const safe = (v?: string | null | string[]) => ((Array.isArray(v) ? v[0] : v) ? String(Array.isArray(v) ? v[0] : v) : "");
      const cfg: Record<string, string> = {
        container_id: safe(qp.get("container_id")) || "shopsense-embed",
        publisher: safe(qp.get("publisher")) || "",
        template_key: safe(qp.get("template_key")),
        version: safe(qp.get("version")),
        collection_id: safe(qp.get("collection_id")),
        testing_mode: safe(qp.get("testing_mode")),
        page_url: safe(qp.get("page_url")) || targetUrl.toString(),
      };

      const cfgJs = JSON.stringify(cfg).replace(/</g, "\\u003c");

      const injection = `\n<!-- Shopsense Dev Proxy Injection -->\n<script>${
        injectorUrl
          ? "(function(){var s=document.createElement('script');s.src='" +
            injectorUrl +
            "';s.onload=function(){try{var cfg=" +
            cfgJs +
            ";cfg.testing_mode=cfg.testing_mode==='true';if(cfg.collection_id!==undefined&&cfg.collection_id!==null&&cfg.collection_id!==''){cfg.collection_id=Number(cfg.collection_id);}var qp=new URLSearchParams(location.search);var idsParam=qp.get('container_ids')||'';var countStr=qp.get('container_count')||'';var parentSel=qp.get('container_parent_selector')||'body';var providedIds=[];if(idsParam){providedIds=idsParam.split(',').map(function(x){return x.trim();}).filter(Boolean);}var insertedIds=new Set();function injectAll(){var parents=Array.prototype.slice.call(document.querySelectorAll(parentSel));if(parents.length===0){parents=[document.body];}var desiredCount=providedIds.length>0?providedIds.length:(countStr&&Number(countStr)>0?Number(countStr):parents.length);for(var i=0;i<desiredCount;i++){var id=(providedIds[i])||('shopsense-embed-'+(i+1));if(insertedIds.has(id)) continue;var parentEl=parents[i]||parents[parents.length-1]||document.body;var el=document.getElementById(id);if(!el){el=document.createElement('div');el.id=id;el.setAttribute('style','border:2px dashed #22c55e;min-height:96px;margin:16px 0;display:flex;align-items:center;justify-content:center;color:#94a3b8;');el.textContent='🛍️ '+id;try{parentEl.insertAdjacentElement('afterend', el);}catch(e){parentEl.appendChild(el);} } insertedIds.add(id); if(window.ShopsenseEmbeds&&window.ShopsenseEmbeds.EmbedInjector){var perCfg=Object.assign({},cfg,{container_id:id});window.ShopsenseEmbeds.EmbedInjector.loadIframeEmbed(perCfg);} }} injectAll(); document.addEventListener('DOMContentLoaded', injectAll, {once:false}); var obs=new MutationObserver(function(){injectAll();}); try{obs.observe(document.documentElement||document.body,{childList:true,subtree:true});}catch(e){} }catch(e){console.error('Injector failed',e);}};document.head.appendChild(s);}())"
          : "console.warn('VITE_CLOUDFRONT_URL not set; cannot load injector')"
      }</script>\n`;

      if (/(<\/head>)/i.test(html)) {
        html = html.replace(/<\/head>/i, `${injection}</head>`);
      } else if (/(<body[^>]*>)/i.test(html)) {
        html = html.replace(/<body([^>]*)>/i, `<body$1>\n${injection}`);
      } else {
        html = `${injection}\n${html}`;
      }

      res.setHeader("content-type", "text/html; charset=utf-8");
      res.send(html);
    } catch (error) {
      console.error("/live error", error);
      res.status(500).send("Proxy error");
    }
  })();
});

export default app;

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Proxy service running at http://localhost:${port}`));
