import core from './index.js';
import { handleSearchIntelligenceBatch } from './search-intelligence-batch.js';

const CACHE_KEY = 'search-intelligence:site-health:v3';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
    },
  });
}
