import core from './index.js';
import { handleSearchIntelligenceBatch } from './search-intelligence-batch.js';
import { runSiteHealthMonitor, readSiteHealthSnapshot } from './site-health-monitor.js';

const CACHE_KEY = 'search-intelligence:site-health:v3';
const BOOTSTRAP_LOCK = 'site-health:baseline-bootstrap-lock:v1';
const BUILD = 'site-health-monitor-20260809-1';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/site-health-snapshot') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
      return json({ ok: true, build: BUILD, snapshot: await readSiteHealthSnapshot(env) });
    }

    if (url.pathname === '/api/site-health-monitor') {
      if (request.method === 'GET') return json({ ok: true, build: BUILD, snapshot: await readSiteHealthSnapshot(env) });
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
      try {
        return json({ ok: true, build: BUILD, snapshot: await runSiteHealthMonitor(env) });
      } catch (error) {
        return json({ ok: false, build: BUILD, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (url.pathname === '/api/curator-intelligence') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);

      const cacheConfigured = Boolean(env.SITE_HEALTH_INTEGRATION_CACHE);
      let legacySnapshotAvailable = false;
      let snapshot = null;
      if (cacheConfigured) {
        const [cached, retained] = await Promise.all([
          env.SITE_HEALTH_INTEGRATION_CACHE.get(CACHE_KEY),
          readSiteHealthSnapshot(env),
        ]);
        legacySnapshotAvailable = Boolean(cached);
        snapshot = retained;
        if (!snapshot) maybeBootstrap(env, ctx);
      }

      const payload = buildIntelligencePayload(snapshot, cacheConfigured, legacySnapshotAvailable);
      payload.build = BUILD;
      const callback = safeCallback(url.searchParams.get('callback'));
      return callback ? javascript(payload, callback) : json(payload);
    }

    if (url.pathname === '/api/search-intelligence/check') {
      return handleSearchIntelligenceBatch(request);
    }

    if (url.pathname === '/api/search-intelligence') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
      if (!env.SITE_HEALTH_INTEGRATION_CACHE) return json({ ok: false, pages: [], error: 'SITE_HEALTH_INTEGRATION_CACHE is not configured.' }, 503);
      const cached = await env.SITE_HEALTH_INTEGRATION_CACHE.get(CACHE_KEY);
      return json({ ok: true, source: 'CuratorOS Site Health', mode: 'on-demand-batch', batchEndpoint: '/api/search-intelligence/check', legacySnapshotAvailable: Boolean(cached), pages: [] });
    }

    return core.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runSiteHealthMonitor(env).catch(error => console.error('Site Health scheduled monitor failed', error)));
  },
};

function maybeBootstrap(env, ctx) {
  if (!env.SITE_HEALTH_INTEGRATION_CACHE || !ctx?.waitUntil) return;
  ctx.waitUntil((async () => {
    const lock = await env.SITE_HEALTH_INTEGRATION_CACHE.get(BOOTSTRAP_LOCK);
    if (lock) return;
    await env.SITE_HEALTH_INTEGRATION_CACHE.put(BOOTSTRAP_LOCK, new Date().toISOString(), { expirationTtl: 600 });
    try { await runSiteHealthMonitor(env); }
    catch (error) { console.error('Site Health baseline bootstrap failed', error); }
  })());
}

function buildIntelligencePayload(snapshot, cacheConfigured, legacySnapshotAvailable) {
  if (!snapshot) {
    return {
      ok: true,
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      system: {
        id: 'site-health', name: 'Site Health', status: 'good', statusLabel: 'Building baseline', value: 'Baseline starting',
        summary: 'Persistent Site Health monitoring is configured and the first bounded technical batch is pending or running.',
        detail: '30 pages per hour · HTTP · canonical · indexability', url: 'https://site-health.oceanliners.net/'
      },
      metrics: { persistentSnapshot: true, checkedPageCount: 0, discoveredPageCount: 0, changeDetection: true },
      priorities: [], opportunities: [], activity: [],
      capabilities: { boundedChecks: true, searchIntelligenceBatch: '/api/search-intelligence/check', integrationCacheConfigured: cacheConfigured, legacySnapshotAvailable, persistentSiteMonitor: true, scheduledMonitoring: true, changeDetection: true }
    };
  }

  const changes = snapshot.changes || { total: 0, counts: {}, items: [] };
  const regressions = (changes.items || []).filter(item => ['regressed','changed'].includes(item.type));
  const recoveries = (changes.items || []).filter(item => item.type === 'recovered');
  const problemCount = Number(snapshot.problemPageCount || 0);
  const status = problemCount || regressions.length ? 'warning' : 'good';
  const statusLabel = problemCount || regressions.length ? 'Attention' : 'Connected';
  const value = regressions.length ? `${regressions.length} new/regressed` : `${snapshot.checkedPageCount || 0}/${snapshot.discoveredPageCount || 0} checked`;

  const changePriorities = regressions.slice(0, 6).map((item, index) => ({
    title: item.title,
    summary: `${item.path}: ${item.summary}`,
    entity: item.path,
    severity: item.type === 'regressed' ? 'high' : 'medium',
    score: 96 - index * 3,
    sources: ['Site Health'],
    changeDetected: true,
  }));
  const standing = (snapshot.problemPages || []).slice(0, 8).map((row, index) => ({
    title: 'Technical Site Health issue on monitored page',
    summary: `${row.path}: ${describeProblem(row)}`,
    entity: row.path,
    severity: row.httpStatus !== 200 || row.indexable === false ? 'high' : 'medium',
    score: 86 - index,
    sources: ['Site Health'],
  }));
  const priorities = uniquePriorities([...changePriorities, ...standing]).slice(0, 10);

  const activity = [{
    title: changes.total ? 'Site Health change detection completed' : 'Persistent Site Health snapshot updated',
    summary: changes.total
      ? `${changes.total} technical change${changes.total === 1 ? '' : 's'} detected in the latest batch: ${regressions.length} new/regressed and ${recoveries.length} recovered.`
      : `${snapshot.checkedPageCount || 0}/${snapshot.discoveredPageCount || 0} pages have retained technical health state; no technical changes were detected in the latest batch.`,
    meta: 'Site Health · Change Detection v1'
  }, ...recoveries.slice(0, 3).map(item => ({ title: item.title, summary: `${item.path}: ${item.summary}`, meta: 'Site Health · recovered' }))];

  return {
    ok: true,
    schemaVersion: 2,
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    system: {
      id: 'site-health', name: 'Site Health', status, statusLabel, value,
      summary: `${snapshot.checkedPageCount || 0}/${snapshot.discoveredPageCount || 0} pages have retained technical checks; ${problemCount} currently have Site Health problems. Latest batch: ${regressions.length} new/regressed, ${recoveries.length} recovered.`,
      detail: `${snapshot.coveragePct || 0}% coverage · ${snapshot.non200PageCount || 0} non-200 · ${snapshot.canonicalIssuePageCount || 0} canonical · ${snapshot.nonIndexablePageCount || 0} non-indexable`,
      url: 'https://site-health.oceanliners.net/'
    },
    metrics: {
      persistentSnapshot: true,
      discoveredPageCount: Number(snapshot.discoveredPageCount || 0),
      checkedPageCount: Number(snapshot.checkedPageCount || 0),
      coveragePct: Number(snapshot.coveragePct || 0),
      healthyPageCount: Number(snapshot.healthyPageCount || 0),
      problemPageCount: problemCount,
      non200PageCount: Number(snapshot.non200PageCount || 0),
      canonicalIssuePageCount: Number(snapshot.canonicalIssuePageCount || 0),
      nonIndexablePageCount: Number(snapshot.nonIndexablePageCount || 0),
      changeCount: Number(changes.total || 0),
      regressionCount: regressions.length,
      recoveryCount: recoveries.length,
    },
    snapshot,
    priorities,
    opportunities: [],
    activity,
    capabilities: { boundedChecks: true, searchIntelligenceBatch: '/api/search-intelligence/check', integrationCacheConfigured: cacheConfigured, legacySnapshotAvailable, persistentSiteMonitor: true, scheduledMonitoring: true, changeDetection: true, batchSize: 30 }
  };
}

function describeProblem(row) {
  const parts = [];
  if (row.httpStatus !== 200) parts.push(`HTTP ${row.httpStatus ?? 'failure'}`);
  if (row.canonicalOk === false) parts.push('canonical mismatch');
  if (row.indexable === false) parts.push('non-indexable');
  if (Array.isArray(row.issues)) parts.push(...row.issues.slice(0, 2));
  return [...new Set(parts)].join(', ') || 'technical check failed';
}
function uniquePriorities(items) { const seen = new Set(); return items.filter(item => { const key = `${item.title}|${item.entity}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function safeCallback(value) { return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(String(value || '')) ? String(value) : ''; }
function javascript(value, callback) { return new Response(`${callback}(${JSON.stringify(value)});`, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex' } }); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex', ...corsHeaders() } }); }
function corsHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }; }
