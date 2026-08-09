const SITE_ORIGIN = 'https://oceanliners.net';
const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
const STATE_KEY = 'site-health:state:v1';
const SNAPSHOT_KEY = 'site-health:snapshot:v1';
const PAGE_PREFIX = 'site-health:page:';
const BATCH_SIZE = 30;
const CONCURRENCY = 5;
const USER_AGENT = 'CuratorOS-Site-Health-Monitor/1.0 (+https://oceanliners.net/)';

export async function runSiteHealthMonitor(env) {
  if (!env.SITE_HEALTH_INTEGRATION_CACHE) throw new Error('SITE_HEALTH_INTEGRATION_CACHE is not configured.');
  const urls = await discoverPages();
  if (!urls.length) throw new Error('No sitemap pages discovered.');

  const state = await env.SITE_HEALTH_INTEGRATION_CACHE.get(STATE_KEY, 'json') || { cursor: 0, cycle: 1 };
  const start = Math.max(0, Number(state.cursor || 0)) % urls.length;
  const batch = rotatingBatch(urls, start, Math.min(BATCH_SIZE, urls.length));
  const results = new Array(batch.length);
  const changes = [];
  let cursor = 0;

  async function worker() {
    while (cursor < batch.length) {
      const index = cursor++;
      const url = batch[index];
      const path = toPath(url);
      const key = PAGE_PREFIX + encodeURIComponent(path);
      const previous = await env.SITE_HEALTH_INTEGRATION_CACHE.get(key, 'json');
      const current = await inspect(url);
      results[index] = current;
      changes.push(...compareHealth(previous, current));
      await env.SITE_HEALTH_INTEGRATION_CACHE.put(key, JSON.stringify(current));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()));

  const nextCursor = (start + batch.length) % urls.length;
  const nextCycle = nextCursor === 0 && batch.length ? Number(state.cycle || 1) + 1 : Number(state.cycle || 1);
  await env.SITE_HEALTH_INTEGRATION_CACHE.put(STATE_KEY, JSON.stringify({ cursor: nextCursor, cycle: nextCycle, pageCount: urls.length, updatedAt: new Date().toISOString() }));

  const snapshot = await buildSnapshot(env, urls.length, nextCycle, results, changes);
  await env.SITE_HEALTH_INTEGRATION_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function readSiteHealthSnapshot(env) {
  if (!env.SITE_HEALTH_INTEGRATION_CACHE) return null;
  return env.SITE_HEALTH_INTEGRATION_CACHE.get(SNAPSHOT_KEY, 'json');
}

async function discoverPages() {
  const response = await fetch(SITEMAP_URL, { headers: { accept: 'application/xml,text/xml,*/*', 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Sitemap returned HTTP ${response.status}`);
  const xml = await response.text();
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map(match => decodeXml(match[1]))
    .filter(isSiteHtmlPage)
    .map(normalizeUrl);
  return [...new Set(urls)].sort();
}

function rotatingBatch(items, start, count) {
  const output = [];
  for (let i = 0; i < count; i++) output.push(items[(start + i) % items.length]);
  return output;
}

async function inspect(url) {
  const path = toPath(url);
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
      redirect: 'follow',
    }, 10000);
    const contentType = response.headers.get('content-type') || '';
    const record = {
      path,
      url: normalizeUrl(response.url || url),
      checkedAt,
      ok: response.ok,
      httpStatus: response.status,
      canonicalOk: true,
      indexable: response.ok,
      redirected: normalizeUrl(response.url || url) !== normalizeUrl(url),
      issues: [],
    };
    if (!response.ok) record.issues.push(`HTTP ${response.status}`);
    if (contentType.toLowerCase().includes('text/html')) {
      const html = await response.text();
      const canonical = extractCanonical(html);
      const noindex = extractNoindex(html);
      record.canonicalOk = !canonical || equivalentPageUrl(canonical, response.url || url);
      record.indexable = response.ok && !noindex;
      if (!record.canonicalOk) record.issues.push('Canonical does not match the fetched page.');
      if (noindex) record.issues.push('Page contains a noindex directive.');
    }
    record.ok = record.ok && record.canonicalOk && record.indexable;
    return record;
  } catch (error) {
    return { path, url, checkedAt, ok: false, httpStatus: null, canonicalOk: false, indexable: false, redirected: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

function compareHealth(previous, current) {
  if (!previous) return [];
  const out = [];
  if (previous.ok && !current.ok) out.push(change('regressed', current.path, 'Technical health regressed', describe(current)));
  if (!previous.ok && current.ok) out.push(change('recovered', current.path, 'Technical health recovered', 'The page now passes the retained Site Health checks.'));
  if (previous.httpStatus !== current.httpStatus) out.push(change(current.httpStatus === 200 ? 'recovered' : 'changed', current.path, 'HTTP status changed', `${previous.httpStatus ?? 'unknown'} → ${current.httpStatus ?? 'unknown'}.`));
  if (previous.canonicalOk !== current.canonicalOk) out.push(change(current.canonicalOk ? 'recovered' : 'regressed', current.path, current.canonicalOk ? 'Canonical issue resolved' : 'Canonical issue detected', current.canonicalOk ? 'Canonical equivalence is now valid.' : 'Canonical no longer matches the fetched page.'));
  if (previous.indexable !== current.indexable) out.push(change(current.indexable ? 'recovered' : 'regressed', current.path, current.indexable ? 'Indexability recovered' : 'Page became non-indexable', current.indexable ? 'No noindex blocker is currently detected.' : 'The page is not currently indexable by the retained Site Health checks.'));
  return dedupeChanges(out);
}

async function buildSnapshot(env, discoveredPageCount, cycle, latestBatch, changes) {
  const list = await env.SITE_HEALTH_INTEGRATION_CACHE.list({ prefix: PAGE_PREFIX, limit: 1000 });
  const pages = [];
  for (const key of list.keys) {
    const row = await env.SITE_HEALTH_INTEGRATION_CACHE.get(key.name, 'json');
    if (row) pages.push(row);
  }
  const problems = pages.filter(page => !page.ok);
  const non200 = pages.filter(page => page.httpStatus !== 200);
  const canonical = pages.filter(page => page.canonicalOk === false);
  const nonIndexable = pages.filter(page => page.indexable === false);
  const counts = changes.reduce((acc, item) => (acc[item.type] = (acc[item.type] || 0) + 1, acc), {});
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    cycle,
    discoveredPageCount,
    checkedPageCount: pages.length,
    coveragePct: discoveredPageCount ? Math.round((pages.length / discoveredPageCount) * 1000) / 10 : 0,
    healthyPageCount: pages.length - problems.length,
    problemPageCount: problems.length,
    non200PageCount: non200.length,
    canonicalIssuePageCount: canonical.length,
    nonIndexablePageCount: nonIndexable.length,
    changes: { total: changes.length, counts, items: changes.slice(0, 50), note: 'Site Health changes compare retained HTTP, canonical, and indexability state with the prior observation.' },
    latestBatch: { checked: latestBatch.length, problems: latestBatch.filter(row => !row.ok).length },
    problemPages: problems.slice(0, 25).map(row => ({ path: row.path, httpStatus: row.httpStatus, canonicalOk: row.canonicalOk, indexable: row.indexable, issues: row.issues || [], checkedAt: row.checkedAt })),
  };
}

function describe(row) {
  const parts = [];
  if (row.httpStatus !== 200) parts.push(`HTTP ${row.httpStatus ?? 'failure'}`);
  if (row.canonicalOk === false) parts.push('canonical mismatch');
  if (row.indexable === false) parts.push('non-indexable');
  if (Array.isArray(row.issues)) parts.push(...row.issues.slice(0, 2));
  return [...new Set(parts)].join(', ') || 'A retained technical check failed.';
}
function change(type, path, title, summary) { return { type, path, title, summary, detectedAt: new Date().toISOString() }; }
function dedupeChanges(items) { const seen = new Set(); return items.filter(item => { const key = `${item.type}|${item.path}|${item.title}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function isSiteHtmlPage(value) { try { const url = new URL(value, SITE_ORIGIN); return url.hostname.replace(/^www\./i, '') === 'oceanliners.net' && !/\.(?:xml|json|js|css|jpg|jpeg|png|webp|gif|svg|pdf|zip)$/i.test(url.pathname); } catch { return false; } }
function normalizeUrl(value) { const url = new URL(value, SITE_ORIGIN); url.protocol = 'https:'; url.hostname = 'oceanliners.net'; url.hash = ''; url.search = ''; return url.href; }
function toPath(value) { try { let path = new URL(value, SITE_ORIGIN).pathname || '/'; path = path.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, ''); return path.length > 1 ? path.replace(/\/$/, '') : path; } catch { return String(value || ''); } }
function extractCanonical(html) { const tags = String(html || '').match(/<link\b[^>]*>/gi) || []; for (const tag of tags) { const rel = attr(tag, 'rel').toLowerCase().split(/\s+/); if (!rel.includes('canonical')) continue; const href = attr(tag, 'href'); if (!href) continue; try { return new URL(href, SITE_ORIGIN).href; } catch { return href; } } return ''; }
function extractNoindex(html) { const tags = String(html || '').match(/<meta\b[^>]*>/gi) || []; return tags.some(tag => { const name = attr(tag, 'name').toLowerCase(); if (name !== 'robots' && name !== 'googlebot') return false; return /(^|[,\s])noindex([,\s]|$)/.test(attr(tag, 'content').toLowerCase()); }); }
function attr(tag, name) { const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim(); }
function equivalentPageUrl(a, b) { try { const normalize = value => { const url = new URL(value, SITE_ORIGIN); return (url.pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '').replace(/\/$/, '') || '/').toLowerCase(); }; return normalize(a) === normalize(b); } catch { return false; } }
function fetchWithTimeout(url, options, timeoutMs) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer)); }
function decodeXml(value) { return String(value || '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'"); }
