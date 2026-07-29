/**
 * OceanLiners.net Site Health & Source Link Auditor v2
 * Cloudflare Worker — single-file deployment
 *
 * Required secret:
 *   AUDIT_TOKEN
 */

const SITE_ORIGIN = "https://oceanliners.net";
const USER_AGENT = "OceanLinerCurator-SiteAuditor/2.0 (+https://oceanliners.net/)";
const DEFAULT_STARTS = [
  `${SITE_ORIGIN}/`,
  `${SITE_ORIGIN}/ships/ships`,
  `${SITE_ORIGIN}/explore`,
  `${SITE_ORIGIN}/collections`,
  `${SITE_ORIGIN}/reference-objects`,
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: {
          "content-type": "text/plain; charset=UTF-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
          ...securityHeaders(),
        },
      });
    }

    if (url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
          ...securityHeaders(),
        },
      });
    }

    if (!env.AUDIT_TOKEN) {
      return json({ error: "AUDIT_TOKEN is not configured in Worker settings." }, 500);
    }

    const supplied = request.headers.get("x-audit-token") || "";
    if (!safeEqual(supplied, env.AUDIT_TOKEN)) {
      return json({ error: "Unauthorized. Check your audit token." }, 401);
    }

    try {
      if (url.pathname === "/api/page") return await inspectPage(url);
      if (url.pathname === "/api/check") return await checkLink(url);
      if (url.pathname === "/api/suggest") return await suggestReplacement(url);
      if (url.pathname === "/api/config") {
        return json({ origin: SITE_ORIGIN, starts: DEFAULT_STARTS });
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};

async function inspectPage(requestUrl) {
  const target = parseUrlParam(requestUrl, "url");
  assertSameSitePage(target);

  const response = await fetchWithTimeout(target.href, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  }, 20000);

  const contentType = response.headers.get("content-type") || "";
  const result = {
    requestedUrl: target.href,
    finalUrl: response.url || target.href,
    status: response.status,
    redirected: Boolean(response.redirected || response.url !== target.href),
    contentType,
    title: "",
    internalLinks: [],
    auditLinks: [],
    sourcesSectionFound: false,
  };

  if (!response.ok || !contentType.toLowerCase().includes("text/html")) {
    return json(result);
  }

  const html = await response.text();
  result.title = extractTitle(html) || pathToTitle(new URL(result.finalUrl).pathname);
  const allAnchors = extractAnchors(html, result.finalUrl);
  const sourceRanges = findSourceRanges(html);
  result.sourcesSectionFound = sourceRanges.length > 0;

  const internal = new Map();
  const audit = [];

  for (const anchor of allAnchors) {
    let parsed;
    try { parsed = new URL(anchor.href); } catch { continue; }
    parsed.hash = "";

    if (parsed.origin === SITE_ORIGIN) {
      const normalized = normalizeInternalPageUrl(parsed);
      if (normalized && normalized !== normalizeInternalPageUrl(new URL(result.finalUrl))) {
        internal.set(normalized, normalized);
      }
    }

    if (!/^https?:$/.test(parsed.protocol)) continue;
    const inSources = sourceRanges.some(([start, end]) => anchor.index >= start && anchor.index < end);
    audit.push({
      url: parsed.href,
      label: cleanText(anchor.text) || parsed.href,
      inSources,
      context: cleanText(anchor.context).slice(0, 240),
    });
  }

  result.internalLinks = [...internal.values()].sort();
  result.auditLinks = dedupeAuditLinks(audit);
  return json(result);
}

async function checkLink(requestUrl) {
  const target = parseUrlParam(requestUrl, "url");
  assertHttpUrl(target);

  const started = Date.now();
  let response = null;
  let method = "HEAD";
  let error = null;

  try {
    response = await fetchWithTimeout(target.href, {
      method: "HEAD",
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" },
      redirect: "follow",
    }, 15000);

    if ([400, 403, 405, 406, 429, 500, 501].includes(response.status)) {
      method = "GET";
      response = await fetchWithTimeout(target.href, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,*/*;q=0.8",
          range: "bytes=0-4095",
        },
        redirect: "follow",
      }, 20000);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - started;
  if (!response) {
    const category = categorizeNetworkError(error);
    return json({
      url: target.href,
      finalUrl: null,
      status: null,
      category,
      severity: category === "TIMEOUT" ? "warning" : "broken",
      label: categoryLabel(category),
      method,
      durationMs,
      redirected: false,
      error,
    });
  }

  const redirected = Boolean(response.redirected || (response.url && response.url !== target.href));
  const category = categorizeResponse(response.status, redirected);
  return json({
    url: target.href,
    finalUrl: response.url || target.href,
    status: response.status,
    category,
    severity: severityFor(category),
    label: categoryLabel(category),
    method,
    durationMs,
    redirected,
    error: null,
  });
}

async function suggestReplacement(requestUrl) {
  const target = parseUrlParam(requestUrl, "url");
  assertHttpUrl(target);
  const suggestions = [];

  if (target.protocol === "http:") {
    const https = new URL(target.href);
    https.protocol = "https:";
    const check = await lightweightCheck(https.href);
    if (check.ok) {
      suggestions.push({
        type: "HTTPS_UPGRADE",
        url: check.finalUrl,
        confidence: 96,
        reason: "The same address is reachable securely over HTTPS.",
      });
    }
  }

  try {
    const api = new URL("https://archive.org/wayback/available");
    api.searchParams.set("url", target.href);
    const response = await fetchWithTimeout(api.href, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    }, 15000);
    if (response.ok) {
      const data = await response.json();
      const closest = data?.archived_snapshots?.closest;
      if (closest?.available && closest?.url) {
        suggestions.push({
          type: "WAYBACK",
          url: closest.url.replace(/^http:/, "https:"),
          confidence: 90,
          reason: closest.timestamp
            ? `Archived copy captured ${formatWaybackTimestamp(closest.timestamp)}.`
            : "An archived copy is available from the Internet Archive.",
        });
      }
    }
  } catch (_) {}

  try {
    const home = `${target.protocol}//${target.host}/`;
    if (home !== target.href) {
      const check = await lightweightCheck(home);
      if (check.ok && !suggestions.some(s => s.url === check.finalUrl)) {
        suggestions.push({
          type: "DOMAIN_HOME",
          url: check.finalUrl,
          confidence: 35,
          reason: "The original page is unavailable, but the source website itself is still reachable. Manual searching is required.",
        });
      }
    }
  } catch (_) {}

  return json({ url: target.href, suggestions });
}

async function lightweightCheck(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8", range: "bytes=0-1023" },
      redirect: "follow",
    }, 12000);
    return { ok: response.status >= 200 && response.status < 400, finalUrl: response.url || url, status: response.status };
  } catch {
    return { ok: false, finalUrl: url, status: null };
  }
}

function findSourceRanges(html) {
  const ranges = [];
  const semantic = /<(section|div)\b[^>]*(?:id|class)=["'][^"']*(?:sources|references|bibliography)[^"']*["'][^>]*>/ig;
  let match;
  while ((match = semantic.exec(html))) {
    const tag = match[1];
    const endRegex = new RegExp(`<\\/${tag}\\s*>`, "ig");
    endRegex.lastIndex = semantic.lastIndex;
    const end = endRegex.exec(html);
    if (end) ranges.push([match.index, end.index + end[0].length]);
  }

  const heading = /<h([1-6])\b[^>]*>[\s\S]*?(?:sources(?:\s*\(selected\))?|references|bibliography)[\s\S]*?<\/h\1>/ig;
  while ((match = heading.exec(html))) {
    const level = Number(match[1]);
    const rest = html.slice(heading.lastIndex);
    const stop = rest.search(new RegExp(`<h[1-${level}]\\b|<footer\\b|<\\/main\\b`, "i"));
    ranges.push([match.index, stop === -1 ? html.length : heading.lastIndex + stop]);
  }

  return mergeRanges(ranges);
}

function extractAnchors(html, baseUrl) {
  const results = [];
  const regex = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const raw = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const href = new URL(raw, baseUrl).href;
      const before = html.slice(Math.max(0, match.index - 140), match.index);
      const after = html.slice(regex.lastIndex, Math.min(html.length, regex.lastIndex + 140));
      results.push({
        href,
        text: stripTags(match[4]),
        index: match.index,
        context: stripTags(before + " " + match[4] + " " + after),
      });
    } catch {}
  }
  return results;
}

function dedupeAuditLinks(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.url}\n${item.inSources ? "1" : "0"}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function normalizeInternalPageUrl(url) {
  const parsed = new URL(url.href);
  if (parsed.origin !== SITE_ORIGIN) return null;
  if (!/^https?:$/.test(parsed.protocol)) return null;
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/index\.html?$/i, "/");
  if (/\.html?$/i.test(parsed.pathname)) parsed.pathname = parsed.pathname.replace(/\.html?$/i, "");
  if (isAssetPath(parsed.pathname) || isExcludedPath(parsed.pathname)) return null;
  return parsed.href.replace(/\/$/, parsed.pathname === "/" ? "/" : "");
}

function isAssetPath(path) {
  return /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|mov|pdf|png|pptx?|svg|tiff?|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(path);
}

function isExcludedPath(path) {
  return /^\/(?:cdn-cgi|wp-admin|wp-login|api|feed)(?:\/|$)/i.test(path);
}

function categorizeResponse(status, redirected) {
  if (status >= 200 && status < 300) return redirected ? "REDIRECT" : "GOOD";
  if (status >= 300 && status < 400) return "REDIRECT";
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403 || status === 406 || status === 451) return "BOT_BLOCKED";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404 || status === 410) return "NOT_FOUND";
  if (status >= 500) return "SERVER_ERROR";
  if (status >= 400) return "CLIENT_ERROR";
  return "UNKNOWN";
}

function categorizeNetworkError(error) {
  const text = String(error || "").toLowerCase();
  if (text.includes("timeout") || text.includes("aborted")) return "TIMEOUT";
  if (text.includes("dns")) return "DNS_ERROR";
  if (text.includes("tls") || text.includes("certificate")) return "TLS_ERROR";
  return "NETWORK_ERROR";
}

function severityFor(category) {
  if (["GOOD"].includes(category)) return "good";
  if (["REDIRECT", "AUTH_REQUIRED", "BOT_BLOCKED", "RATE_LIMITED", "TIMEOUT"].includes(category)) return "warning";
  return "broken";
}

function categoryLabel(category) {
  return category.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function parseUrlParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  const parsed = new URL(value);
  return parsed;
}

function assertHttpUrl(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) URLs are allowed.");
}

function assertSameSitePage(url) {
  assertHttpUrl(url);
  if (url.origin !== SITE_ORIGIN) throw new Error("Only OceanLiners.net pages may be inspected.");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mergeRanges(ranges) {
  return ranges.sort((a,b) => a[0]-b[0]).reduce((acc, range) => {
    const last = acc[acc.length - 1];
    if (!last || range[0] > last[1]) acc.push(range);
    else last[1] = Math.max(last[1], range[1]);
    return acc;
  }, []);
}

function extractTitle(html) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? cleanText(stripTags(title[1])).replace(/\s*[—|]\s*Ocean Liner Curator.*$/i, "") : "";
}

function pathToTitle(path) {
  if (path === "/") return "Homepage";
  return path.split("/").filter(Boolean).pop().replace(/\.html?$/i, "").split("-").map(capitalize).join(" ");
}

function formatWaybackTimestamp(value) {
  const s = String(value);
  if (s.length < 8) return s;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : value; }
function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex", ...corsHeaders(), ...securityHeaders() },
  });
}
function corsHeaders() { return { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-audit-token", "access-control-allow-methods": "GET,OPTIONS" }; }
function securityHeaders() { return { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'" }; }

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
<meta name="googlebot" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
<title>OceanLiners.net Site Health Auditor</title>
<style>
:root{color-scheme:dark;--bg:#07100e;--panel:#101a17;--panel2:#15211d;--line:#34433d;--text:#f3efe6;--muted:#b7beb8;--brass:#bfa46a;--good:#9ad0a6;--warn:#e3c478;--bad:#e49b96}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#15241f 0,#07100e 48%);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1500px;margin:auto;padding:28px}.suitebar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:rgba(8,17,15,.9)}.suitebrand{font-family:Georgia,serif;color:var(--brass);font-size:1.05rem}.suitenav{display:flex;flex-wrap:wrap;gap:8px}.suitenav a{display:inline-flex;align-items:center;min-height:36px;padding:7px 11px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--text);background:#111d19}.suitenav a[aria-current="page"]{border-color:var(--brass);color:var(--brass)}.mast{border:1px solid var(--line);background:rgba(10,17,16,.92);padding:24px;border-radius:18px;box-shadow:0 18px 50px #0008}.eyebrow{letter-spacing:.14em;text-transform:uppercase;color:var(--brass);font-size:.78rem}h1{font-family:Georgia,serif;margin:.25rem 0 .5rem;font-size:clamp(2rem,5vw,3.8rem);font-weight:500}p{color:var(--muted)}.workflow{margin-top:14px;padding:12px 14px;border-left:3px solid var(--brass);background:rgba(191,164,106,.08);color:var(--muted)}.controls,.stats,.filters{display:grid;gap:12px}.controls{grid-template-columns:2fr 1fr 1fr auto;margin-top:20px}.stats{grid-template-columns:repeat(6,1fr);margin:18px 0}.filters{grid-template-columns:2fr repeat(3,1fr);margin:14px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}.stat strong{display:block;font-size:1.7rem;color:var(--brass)}label{font-size:.8rem;color:var(--muted);display:block;margin-bottom:5px}input,select,button{width:100%;border:1px solid var(--line);background:#08110f;color:var(--text);border-radius:9px;padding:11px}button{cursor:pointer;background:linear-gradient(#c7ad73,#a98e56);color:#10110f;font-weight:800;border-color:#dbc38e}button.secondary{background:#17231f;color:var(--text)}button:disabled{opacity:.5;cursor:not-allowed}.bar{height:10px;background:#07100e;border:1px solid var(--line);border-radius:999px;overflow:hidden}.bar>span{display:block;height:100%;width:0;background:var(--brass);transition:width .2s}.status{min-height:24px;margin:10px 0;color:var(--muted)}.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:1300px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #293630}th{position:sticky;top:0;background:#17231f;color:var(--brass);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}a{color:#dcc58f}.pill{display:inline-block;border:1px solid;padding:2px 8px;border-radius:999px;white-space:nowrap}.good{color:var(--good);border-color:#476c50}.warning{color:var(--warn);border-color:#756530}.broken{color:var(--bad);border-color:#754541}.small{font-size:.82rem;color:var(--muted)}.replacement{max-width:300px}.hidden{display:none}.suitefooter{margin-top:20px;padding:16px;text-align:center;color:var(--muted);font-size:.86rem}.suitefooter a{margin:0 .35rem}@media(max-width:1000px){.controls,.filters{grid-template-columns:1fr 1fr}.stats{grid-template-columns:repeat(3,1fr)}}@media(max-width:700px){.suitebar{align-items:flex-start;flex-direction:column}.wrap{padding:14px}.controls,.filters,.stats{grid-template-columns:1fr 1fr}}@media(max-width:480px){.controls,.filters,.stats{grid-template-columns:1fr}.suitenav{width:100%}.suitenav a{flex:1;justify-content:center}}
</style>
</head>
<body><main class="wrap">
<nav class="suitebar" aria-label="CuratorOS suite">
  <div class="suitebrand">CuratorOS Suite</div>
  <div class="suitenav">
    <a href="https://curator.oceanliners.net/">CuratorOS</a>
    <a href="https://site-health.oceanliners.net/" aria-current="page">Site Health</a>
    <a href="https://curator-indexer.oceanliners.net/">Curator Indexer</a>
  </div>
</nav>
<section class="mast">
<div class="eyebrow">Ocean Liner Curator · Site Maintenance · v2</div>
<h1>Site Health Auditor</h1>
<p>Crawl OceanLiners.net, inspect internal navigation and source links, identify broken or redirected destinations, and export a work list for CuratorOS.</p>
<div class="workflow"><strong>Workflow:</strong> Run the audit, export the CSV, then open CuratorOS and choose <strong>Import Scan Results</strong>. Use Curator Indexer separately when you need a fresh canonical site index.</div>
<div class="controls">
<div><label for="startUrl">Start URL</label><input id="startUrl" value="https://oceanliners.net/"></div>
<div><label for="scope">Scope</label><select id="scope"><option value="site">Whole site</option><option value="section">Starting section</option></select></div>
<div><label for="token">Audit token</label><input id="token" type="password" autocomplete="off"></div>
<div><label>&nbsp;</label><button id="runBtn">Run audit</button></div>
</div>
<div class="status" id="status">Ready.</div><div class="bar"><span id="progress"></span></div>
</section>
<section class="stats">
<div class="card stat"><strong id="sPages">0</strong><span>Pages</span></div><div class="card stat"><strong id="sLinks">0</strong><span>Links checked</span></div><div class="card stat"><strong id="sGood">0</strong><span>Good</span></div><div class="card stat"><strong id="sWarning">0</strong><span>Warnings</span></div><div class="card stat"><strong id="sBroken">0</strong><span>Broken</span></div><div class="card stat"><strong id="sSources">0</strong><span>Source links</span></div>
</section>
<section class="filters">
<input id="search" placeholder="Search URL, page, context…"><select id="severity"><option value="">All severities</option><option value="broken">Broken</option><option value="warning">Warning</option><option value="good">Good</option></select><select id="location"><option value="">All locations</option><option value="source">Sources only</option><option value="body">Body links only</option></select><button class="secondary" id="exportBtn" disabled>Export CSV for CuratorOS</button>
</section>
<div class="tablewrap"><table><thead><tr><th>Page</th><th>Link</th><th>Location</th><th>Status</th><th>HTTP</th><th>Final URL</th><th>Context</th><th>Replacement</th></tr></thead><tbody id="rows"></tbody></table></div>
<footer class="suitefooter">CuratorOS Suite · <a href="https://curator.oceanliners.net/">Review findings</a> · <a href="https://curator-indexer.oceanliners.net/">Build site index</a> · <a href="https://oceanliners.net/">Open OceanLiners.net</a></footer>
</main><script>
const state={queue:[],seen:new Set(),pages:[],rows:[],running:false};
const $=id=>document.getElementById(id);
const api=async(path,params={})=>{const u=new URL(path,location.origin);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u,{headers:{'x-audit-token':$('token').value}});const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');return j};
$('runBtn').onclick=run;$('exportBtn').onclick=exportCsv;$('search').oninput=render;$('severity').onchange=render;$('location').onchange=render;
async function run(){if(state.running)return;state.running=true;state.queue=[];state.seen=new Set();state.pages=[];state.rows=[];$('exportBtn').disabled=true;render();const start=$('startUrl').value.trim();state.queue.push(start);try{while(state.queue.length){const pageUrl=state.queue.shift();if(state.seen.has(pageUrl))continue;state.seen.add(pageUrl);setStatus('Inspecting '+pageUrl);const page=await api('/api/page',{url:pageUrl});state.pages.push(page);if($('scope').value==='site')for(const link of page.internalLinks||[])if(!state.seen.has(link))state.queue.push(link);for(const link of page.auditLinks||[]){setStatus('Checking '+link.url);const check=await api('/api/check',{url:link.url});let replacement='';if(check.severity==='broken'){const suggestion=await api('/api/suggest',{url:link.url});replacement=suggestion.suggestions?.[0]?.url||'';}state.rows.push({page_url:page.finalUrl,page_title:page.title,checked_url:link.url,anchor_text:link.label,context:link.context,in_sources:link.inSources,status:check.status??'',category:check.category,severity:check.severity,final_url:check.finalUrl||'',replacement_url:replacement});render();}updateStats();}setStatus('Audit complete. Export the CSV and import it into CuratorOS.');$('exportBtn').disabled=!state.rows.length;}catch(e){setStatus(e.message)}finally{state.running=false;}}
function render(){
  const q=$('search').value.toLowerCase();
  const sev=$('severity').value;
  const loc=$('location').value;

  const rows=state.rows.filter(r=>
    (!q||[r.page_url,r.checked_url,r.context,r.page_title]
      .join(' ')
      .toLowerCase()
      .includes(q)) &&
    (!sev||r.severity===sev) &&
    (!loc||(loc==='source'?r.in_sources:!r.in_sources))
  );

  $('rows').innerHTML=rows.map(r=>
    '<tr>' +
      '<td><a href="' + esc(r.page_url) +
        '" target="_blank" rel="noopener">' +
        esc(r.page_title||r.page_url) +
      '</a></td>' +

      '<td><a href="' + esc(r.checked_url) +
        '" target="_blank" rel="noopener">' +
        esc(r.anchor_text||r.checked_url) +
      '</a></td>' +

      '<td>' + (r.in_sources?'Source':'Body') + '</td>' +

      '<td><span class="pill ' + esc(r.severity) + '">' +
        esc(r.category) +
      '</span></td>' +

      '<td>' + esc(r.status) + '</td>' +

      '<td>' +
        (r.final_url
          ? '<a href="' + esc(r.final_url) +
            '" target="_blank" rel="noopener">Open</a>'
          : '') +
      '</td>' +

      '<td class="small">' + esc(r.context) + '</td>' +

      '<td class="replacement">' +
        (r.replacement_url
          ? '<a href="' + esc(r.replacement_url) +
            '" target="_blank" rel="noopener">Suggested replacement</a>'
          : '') +
      '</td>' +
    '</tr>'
  ).join('');

  updateStats();
}
function updateStats(){const s=state.rows.reduce((a,r)=>(a[r.severity]=(a[r.severity]||0)+1,a),{});$('sPages').textContent=state.pages.length;$('sLinks').textContent=state.rows.length;$('sGood').textContent=s.good||0;$('sWarning').textContent=s.warning||0;$('sBroken').textContent=s.broken||0;$('sSources').textContent=state.rows.filter(r=>r.in_sources).length;const total=Math.max(1,state.seen.size+state.queue.length);$('progress').style.width=Math.min(100,state.seen.size/total*100)+'%';}
function setStatus(v){$('status').textContent=v}
function exportCsv(){const h=['page_url','page_title','checked_url','anchor_text','context','in_sources','status','category','severity','final_url','replacement_url'];const c=[h.join(','),...state.rows.map(r=>h.map(k=>'"'+String(r[k]??'').replaceAll('"','""')+'"').join(','))].join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+c],{type:'text/csv;charset=utf-8'}));a.download='oceanliners-site-health-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
</script></body></html>`;
