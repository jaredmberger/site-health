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

    if (url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "no-store",
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

  // 1. If HTTP is used, try the equivalent HTTPS URL.
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

  // 2. Ask the Wayback Machine for the newest successful archived copy.
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
  } catch (_) {
    // Suggestion lookup failure should not fail the audit.
  }

  // 3. Low-confidence fallback: reachable home page of the cited domain.
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
  if (text.includes("dns") || text.includes("resolve") || text.includes("name")) return "DNS_ERROR";
  if (text.includes("tls") || text.includes("ssl") || text.includes("certificate")) return "TLS_ERROR";
  return "NETWORK_ERROR";
}

function severityFor(category) {
  if (["GOOD"].includes(category)) return "good";
  if (["REDIRECT", "BOT_BLOCKED", "RATE_LIMITED", "AUTH_REQUIRED", "TIMEOUT", "SERVER_ERROR"].includes(category)) return "warning";
  return "broken";
}

function categoryLabel(category) {
  const labels = {
    GOOD: "Good",
    REDIRECT: "Redirect",
    BOT_BLOCKED: "Access blocked",
    RATE_LIMITED: "Rate limited",
    AUTH_REQUIRED: "Login required",
    TIMEOUT: "Timed out",
    NOT_FOUND: "Not found",
    SERVER_ERROR: "Server error",
    CLIENT_ERROR: "Client error",
    DNS_ERROR: "Domain not found",
    TLS_ERROR: "Security certificate error",
    NETWORK_ERROR: "Network error",
    UNKNOWN: "Unknown",
  };
  return labels[category] || category;
}

function assertSameSitePage(url) {
  if (url.protocol !== "https:" || url.origin !== SITE_ORIGIN || isAssetPath(url.pathname) || isExcludedPath(url.pathname)) {
    throw new Error("Only OceanLiners.net HTML pages may be crawled.");
  }
}

function assertHttpUrl(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (isPrivateHostname(url.hostname)) throw new Error("Private or local network addresses are not allowed.");
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (["localhost", "0.0.0.0", "::1"].includes(host)) return true;
  if (/^(?:10\.|127\.|169\.254\.|192\.168\.)/.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function parseUrlParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing ${name} parameter.`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${name} URL.`); }
  return parsed;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Request timed out"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mergeRanges(ranges) {
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1]) merged.push([...range]);
    else last[1] = Math.max(last[1], range[1]);
  }
  return merged;
}

function extractTitle(html) {
  const og = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (og) return cleanText(decodeEntities(og[1]));
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
    headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store", ...corsHeaders(), ...securityHeaders() },
  });
}
function corsHeaders() { return { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-audit-token", "access-control-allow-methods": "GET,OPTIONS" }; }
function securityHeaders() { return { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'" }; }

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OceanLiners.net Site Health Auditor</title>
<style>
:root{color-scheme:dark;--bg:#07100e;--panel:#101a17;--panel2:#15211d;--line:#34433d;--text:#f3efe6;--muted:#b7beb8;--brass:#bfa46a;--good:#9ad0a6;--warn:#e3c478;--bad:#e49b96}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#15241f 0,#07100e 48%);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1500px;margin:auto;padding:28px}.mast{border:1px solid var(--line);background:rgba(10,17,16,.92);padding:24px;border-radius:18px;box-shadow:0 18px 50px #0008}.eyebrow{letter-spacing:.14em;text-transform:uppercase;color:var(--brass);font-size:.78rem}h1{font-family:Georgia,serif;margin:.25rem 0 .5rem;font-size:clamp(2rem,5vw,3.8rem);font-weight:500}p{color:var(--muted)}.controls,.stats,.filters{display:grid;gap:12px}.controls{grid-template-columns:2fr 1fr 1fr auto;margin-top:20px}.stats{grid-template-columns:repeat(6,1fr);margin:18px 0}.filters{grid-template-columns:2fr repeat(3,1fr);margin:14px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}.stat strong{display:block;font-size:1.7rem;color:var(--brass)}label{font-size:.8rem;color:var(--muted);display:block;margin-bottom:5px}input,select,button{width:100%;border:1px solid var(--line);background:#08110f;color:var(--text);border-radius:9px;padding:11px}button{cursor:pointer;background:linear-gradient(#c7ad73,#a98e56);color:#10110f;font-weight:800;border-color:#dbc38e}button.secondary{background:#17231f;color:var(--text)}button:disabled{opacity:.5;cursor:not-allowed}.bar{height:10px;background:#07100e;border:1px solid var(--line);border-radius:999px;overflow:hidden}.bar>span{display:block;height:100%;width:0;background:var(--brass);transition:width .2s}.status{min-height:24px;margin:10px 0;color:var(--muted)}.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:1300px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #293630}th{position:sticky;top:0;background:#17231f;color:var(--brass);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}a{color:#dcc58f}.pill{display:inline-block;border:1px solid;padding:2px 8px;border-radius:999px;white-space:nowrap}.good{color:var(--good);border-color:#476c50}.warning{color:var(--warn);border-color:#756530}.broken{color:var(--bad);border-color:#754541}.small{font-size:.82rem;color:var(--muted)}.replacement{max-width:300px}.hidden{display:none}@media(max-width:1000px){.controls,.filters{grid-template-columns:1fr 1fr}.stats{grid-template-columns:repeat(3,1fr)}}@media(max-width:600px){.wrap{padding:14px}.controls,.filters,.stats{grid-template-columns:1fr 1fr}}
</style>
</head>
<body><main class="wrap">
<section class="mast">
<div class="eyebrow">Ocean Liner Curator — Internal Maintenance</div>
<h1>Site Health Auditor</h1>
<p>Crawl the complete public website or audit only citation links. Results identify the page, anchor text, failure type, redirects, and defensible replacement options.</p>
<div class="controls">
<div><label for="token">Private audit token</label><input id="token" type="password" autocomplete="current-password"></div>
<div><label for="scope">Audit scope</label><select id="scope"><option value="sources">Source links only</option><option value="external">All external links</option><option value="all">All links, including internal</option></select></div>
<div><label for="maxPages">Maximum pages</label><input id="maxPages" type="number" min="1" max="2000" value="1000"></div>
<div><label>&nbsp;</label><button id="start">Start audit</button></div>
</div>
<div class="controls" style="grid-template-columns:2fr 1fr 1fr auto">
<div><label for="startUrls">Starting pages, one per line</label><input id="startUrls" value="https://oceanliners.net/"></div>
<div><label for="concurrency">Concurrent checks</label><input id="concurrency" type="number" min="1" max="8" value="4"></div>
<div><label>&nbsp;</label><button id="stop" class="secondary" disabled>Stop</button></div>
<div><label>&nbsp;</label><button id="export" class="secondary" disabled>Export CSV</button></div>
</div>
<div class="status" id="status">Ready.</div><div class="bar"><span id="progress"></span></div>
</section>
<section class="stats">
<div class="card stat"><span>Pages crawled</span><strong id="pages">0</strong></div>
<div class="card stat"><span>Links checked</span><strong id="checked">0</strong></div>
<div class="card stat"><span>Good</span><strong id="good">0</strong></div>
<div class="card stat"><span>Warnings</span><strong id="warnings">0</strong></div>
<div class="card stat"><span>Broken</span><strong id="broken">0</strong></div>
<div class="card stat"><span>Suggestions</span><strong id="suggestions">0</strong></div>
</section>
<section class="filters">
<div><label for="search">Search results</label><input id="search" placeholder="Ship, page, URL, anchor text…"></div>
<div><label for="severityFilter">Severity</label><select id="severityFilter"><option value="">All</option><option value="broken">Broken</option><option value="warning">Warnings</option><option value="good">Good</option></select></div>
<div><label for="categoryFilter">Category</label><select id="categoryFilter"><option value="">All categories</option></select></div>
<div><label for="sourceFilter">Context</label><select id="sourceFilter"><option value="">All links</option><option value="source">Sources sections</option><option value="other">Elsewhere on page</option></select></div>
</section>
<div class="tablewrap"><table><thead><tr><th>Result</th><th>Page</th><th>Anchor / context</th><th>Checked URL</th><th>HTTP</th><th>Final URL</th><th>Replacement suggestion</th></tr></thead><tbody id="rows"></tbody></table></div>
</main>
<script>
const $=id=>document.getElementById(id);
const state={running:false,stop:false,pages:new Map(),queue:[],queued:new Set(),checks:new Map(),rows:[],maxPages:1000,scope:'sources'};
$('token').value=localStorage.getItem('olcAuditToken')||'';
$('start').onclick=startAudit;$('stop').onclick=()=>{state.stop=true;$('status').textContent='Stopping after current requests…'};$('export').onclick=exportCsv;
for(const id of ['search','severityFilter','categoryFilter','sourceFilter']) $(id).addEventListener('input',render);

async function api(path){
 const r=await fetch(path,{headers:{'x-audit-token':$('token').value}}); const data=await r.json().catch(()=>({error:'Invalid Worker response'}));
 if(!r.ok||data.error) throw new Error(data.error||('HTTP '+r.status)); return data;
}
function normalizePage(raw){try{const u=new URL(raw,location.origin);if(u.origin!=='https://oceanliners.net')return null;u.hash='';u.search='';u.pathname=u.pathname.replace(/\/index\.html?$/i,'/').replace(/\.html?$/i,'');return u.href.replace(/\/$/,u.pathname==='/'?'/':'')}catch{return null}}
function enqueue(url){const n=normalizePage(url);if(n&&!state.queued.has(n)&&state.queued.size<state.maxPages){state.queued.add(n);state.queue.push(n)}}
async function startAudit(){
 if(state.running)return; localStorage.setItem('olcAuditToken',$('token').value); reset(); state.running=true;state.stop=false;
 $('start').disabled=true;$('stop').disabled=false;$('export').disabled=true;state.maxPages=Math.max(1,Math.min(2000,Number($('maxPages').value)||1000));state.scope=$('scope').value;
 const starts=$('startUrls').value.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);(starts.length?starts:['https://oceanliners.net/']).forEach(enqueue);
 try{
   while(state.queue.length&&!state.stop&&state.pages.size<state.maxPages){
     const pageUrl=state.queue.shift(); $('status').textContent='Crawling '+pageUrl;
     let page;try{page=await api('/api/page?url='+encodeURIComponent(pageUrl))}catch(e){addPageFailure(pageUrl,e.message);continue}
     state.pages.set(pageUrl,page);$('pages').textContent=state.pages.size;page.internalLinks.forEach(enqueue);
     const candidates=page.auditLinks.filter(link=>state.scope==='sources'?link.inSources:state.scope==='external'?new URL(link.url).origin!=='https://oceanliners.net':true);
     await runPool(candidates,Math.max(1,Math.min(8,Number($('concurrency').value)||4)),link=>processLink(page,link));
     updateProgress();
   }
   $('status').textContent=state.stop?'Audit stopped. Existing results are preserved.':'Audit complete.';
 }catch(e){$('status').textContent='Audit error: '+e.message}
 finally{state.running=false;$('start').disabled=false;$('stop').disabled=true;$('export').disabled=state.rows.length===0;render();}
}
async function processLink(page,link){
 if(state.stop)return;
 let result=state.checks.get(link.url);
 if(!result){
   try{result=await api('/api/check?url='+encodeURIComponent(link.url))}catch(e){result={url:link.url,status:null,category:'WORKER_ERROR',severity:'broken',label:'Worker error',finalUrl:null,error:e.message}}
   state.checks.set(link.url,result);$('checked').textContent=state.checks.size;
 }
 const row={pageTitle:page.title||page.requestedUrl,pageUrl:page.finalUrl||page.requestedUrl,anchor:link.label,context:link.context,inSources:link.inSources,...result,suggestions:[]};
 state.rows.push(row);
 if(result.severity==='broken'){
   try{const suggestion=await api('/api/suggest?url='+encodeURIComponent(link.url));row.suggestions=suggestion.suggestions||[]}catch{}
 }
 updateStats();render();
}
async function runPool(items,limit,worker){let i=0;const runners=Array.from({length:Math.min(limit,items.length)},async()=>{while(i<items.length&&!state.stop){const item=items[i++];await worker(item)}});await Promise.all(runners)}
function addPageFailure(url,error){state.rows.push({pageTitle:'Page crawl failure',pageUrl:url,anchor:'',context:error,inSources:false,url,status:null,category:'PAGE_ERROR',severity:'broken',label:'Page could not be crawled',finalUrl:null,error,suggestions:[]});updateStats();render()}
function updateStats(){let good=0,warn=0,bad=0,sugg=0;for(const r of state.rows){if(r.severity==='good')good++;else if(r.severity==='warning')warn++;else bad++;sugg+=(r.suggestions||[]).length}$('good').textContent=good;$('warnings').textContent=warn;$('broken').textContent=bad;$('suggestions').textContent=sugg;refreshCategories()}
function updateProgress(){const done=state.pages.size;const known=Math.max(done+state.queue.length,1);$('progress').style.width=Math.min(100,done/known*100)+'%'}
function refreshCategories(){const current=$('categoryFilter').value;const cats=[...new Set(state.rows.map(r=>r.category).filter(Boolean))].sort();$('categoryFilter').innerHTML='<option value="">All categories</option>'+cats.map(c=>'<option>'+escapeHtml(c)+'</option>').join('');$('categoryFilter').value=current}
function render(){
 const q=$('search').value.toLowerCase(),sev=$('severityFilter').value,cat=$('categoryFilter').value,src=$('sourceFilter').value;
 const filtered=state.rows.filter(r=>(!sev||r.severity===sev)&&(!cat||r.category===cat)&&(!src||(src==='source')===!!r.inSources)&&(!q||[r.pageTitle,r.pageUrl,r.anchor,r.context,r.url,r.finalUrl,r.label].join(' ').toLowerCase().includes(q)));
 $('rows').innerHTML=filtered.map(r=>'<tr><td><span class="pill '+escapeHtml(r.severity)+'">'+escapeHtml(r.label||r.category)+'</span><div class="small">'+escapeHtml(r.category||'')+'</div></td><td><a href="'+attr(r.pageUrl)+'" target="_blank">'+escapeHtml(r.pageTitle||r.pageUrl)+'</a><div class="small">'+escapeHtml(r.inSources?'Sources section':'Elsewhere on page')+'</div></td><td><strong>'+escapeHtml(r.anchor||'(no anchor text)')+'</strong><div class="small">'+escapeHtml(r.context||'')+'</div></td><td><a href="'+attr(r.url)+'" target="_blank">'+escapeHtml(shortUrl(r.url))+'</a></td><td>'+escapeHtml(r.status==null?'—':String(r.status))+'<div class="small">'+escapeHtml(r.durationMs?Math.round(r.durationMs)+' ms':'')+'</div></td><td>'+(r.finalUrl?'<a href="'+attr(r.finalUrl)+'" target="_blank">'+escapeHtml(shortUrl(r.finalUrl))+'</a>':'—')+'</td><td class="replacement">'+renderSuggestions(r.suggestions)+'</td></tr>').join('');
}
function renderSuggestions(list){if(!list||!list.length)return '<span class="small">No automatic suggestion</span>';return list.map(s=>'<div><a href="'+attr(s.url)+'" target="_blank">'+escapeHtml(typeName(s.type))+'</a> <span class="small">('+escapeHtml(String(s.confidence))+'% confidence)</span><div class="small">'+escapeHtml(s.reason)+'</div></div>').join('<hr>')}
function typeName(t){return {HTTPS_UPGRADE:'Secure HTTPS version',WAYBACK:'Archived copy',DOMAIN_HOME:'Source website homepage'}[t]||t}
function exportCsv(){const headers=['severity','category','status','page_title','page_url','in_sources','anchor_text','context','checked_url','final_url','replacement_url','replacement_type','replacement_confidence','error'];const lines=[headers.join(',')];for(const r of state.rows){const s=(r.suggestions||[])[0]||{};lines.push(headers.map(h=>csv(({severity:r.severity,category:r.category,status:r.status,page_title:r.pageTitle,page_url:r.pageUrl,in_sources:r.inSources,anchor_text:r.anchor,context:r.context,checked_url:r.url,final_url:r.finalUrl,replacement_url:s.url,replacement_type:s.type,replacement_confidence:s.confidence,error:r.error})[h])).join(','))}const blob=new Blob([lines.join('\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='oceanliners-site-audit-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(a.href)}
function reset(){state.pages.clear();state.queue=[];state.queued.clear();state.checks.clear();state.rows=[];$('pages').textContent=$('checked').textContent=$('good').textContent=$('warnings').textContent=$('broken').textContent=$('suggestions').textContent='0';$('rows').innerHTML='';$('progress').style.width='0%'}
function shortUrl(v){try{const u=new URL(v);return u.hostname+u.pathname+(u.search||'')}catch{return v||''}}function csv(v){const s=String(v??'');return '"'+s.replace(/"/g,'""')+'"'}function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function attr(v){return escapeHtml(v||'')}
</script></body></html>`;
