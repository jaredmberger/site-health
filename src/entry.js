import core from './index.js';
import { handleSearchIntelligenceBatch } from './search-intelligence-batch.js';

const CACHE_KEY = 'search-intelligence:site-health:v3';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Curator Intelligence consumes this lightweight, read-only signal. It
    // reports integration readiness without triggering a crawl or exposing
    // audit credentials.
    if (url.pathname === '/api/curator-intelligence') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'Method not allowed.' }, 405);
      }

      const cacheConfigured = Boolean(env.SITE_HEALTH_INTEGRATION_CACHE);
      let legacySnapshotAvailable = false;
      if (cacheConfigured) {
        const cached = await env.SITE_HEALTH_INTEGRATION_CACHE.get(CACHE_KEY);
        legacySnapshotAvailable = Boolean(cached);
      }

      return json({
        ok: true,
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        system: {
          id: 'site-health',
          name: 'Site Health',
          status: 'good',
          statusLabel: 'Connected',
          value: 'Live',
          summary: 'Site Health is online and connected to the Curator Intelligence layer.',
          detail: 'Bounded technical checks available',
          url: 'https://site-health.oceanliners.net/',
        },
        capabilities: {
          boundedChecks: true,
          searchIntelligenceBatch: '/api/search-intelligence/check',
          integrationCacheConfigured: cacheConfigured,
          legacySnapshotAvailable,
        },
      });
    }

    // Search Intelligence uses this bounded endpoint for only the pages in its
    // active action queue. It intentionally bypasses the full-site audit path.
    if (url.pathname === '/api/search-intelligence/check') {
      return handleSearchIntelligenceBatch(request);
    }

    // Keep the legacy snapshot route as a lightweight compatibility/status
    // endpoint, but do not initiate another whole-site crawl from here.
    if (url.pathname === '/api/search-intelligence') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'Method not allowed.' }, 405);
      }
      if (!env.SITE_HEALTH_INTEGRATION_CACHE) {
        return json({ ok: false, pages: [], error: 'SITE_HEALTH_INTEGRATION_CACHE is not configured.' }, 503);
      }

      const cached = await env.SITE_HEALTH_INTEGRATION_CACHE.get(CACHE_KEY);
      return json({
        ok: true,
        source: 'CuratorOS Site Health',
        mode: 'on-demand-batch',
        batchEndpoint: '/api/search-intelligence/check',
        legacySnapshotAvailable: Boolean(cached),
        pages: [],
      });
    }

    return core.fetch(request, env, ctx);
  },
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,OPTIONS',
  };
}
