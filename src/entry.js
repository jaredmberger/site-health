import core from './index.js';

const DEFAULT_LINK_MAP_SNAPSHOT = 'https://link-map.oceanliners.net/api/search-intelligence';
const CACHE_KEY = 'search-intelligence:site-health:v2';
const REFRESH_LOCK_KEY = 'search-intelligence:site-health:refresh-lock';
const USER_AGENT = 'CuratorOS-Site-Health-Integration/1.1 (+https://oceanliners.net/)';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/search-intelligence') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed.' }, 405);
      if (!env.SITE_HEALTH_INTEGRATION_CACHE) {
        return json({ ok: false, pages: [], error: 'SITE_HEALTH_INTEGRATION_CACHE is not configured.' }, 503);
      }

      if (url.searchParams.get('refresh') === '1') {
        const lock = await env.SITE_HEALTH_INTEGRATION_CACHE.get(REFRESH_LOCK_KEY);
        if (lock && url.searchParams.get('force') !== '1') {
          return json({ ok: false, refreshing: false, error: 'A refresh was run recently. Try again later or use force=1.' }, 429);
        }
        await env.SITE_HEALTH_INTEGRATION_CACHE.put(REFRESH_LOCK_KEY, new Date().toISOString(), { expirationTtl: 300 });
        try {
          const snapshot = await buildSnapshot(env);
          const compact = compactSnapshot(snapshot);
          await env.SITE_HEALTH_INTEGRATION_CACHE.put(CACHE_KEY, JSON.stringify(compact), { expirationTtl: 60 * 60 * 24 * 14 });
          return json(compact);
        } catch (error) {
          return json({ ok: false, pages: [], error: error instanceof Error ? error.message : String(error) }, 502);
        }
      }

      const cachedText = await env.SITE_HEALTH_INTEGRATION_CACHE.get(CACHE_KEY);
      if (!cachedText) {
        return json({ ok: false, pages: [], error: 'No Site Health integration snapshot exists yet. Open /api/search-intelligence?refresh=1 once after deployment.' }, 404);
      }
      return new Response(cachedText, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=120',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    return core.fetch(request, env, ctx);
  },
};

async function buildSnapshot(env) {
  const sourceUrl = env.LINK_MAP_SNAPSHOT_URL || DEFAULT_LINK_MAP_SNAPSHOT;
  const sourceResponse = await fetchWithTimeout(sourceUrl, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 10000);
  if (!sourceResponse.ok) throw new Error(`Link Map snapshot returned HTTP ${sourceResponse.status}.`);
  const source = await sourceResponse.json();
  const pages = Array.isArray(source.pages) ? source.pages : [];
  if (!pages.length) throw new Error('Link Map snapshot contains no pages. Run Link Map once first.');

  const urls = [...new Set(pages.map(item => absoluteSiteUrl(item.path || item.url || '')).filter(Boolean))];
  const results = [];
  const concurrency = 10;
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const index = cursor++;
      results[index] = await inspectForIntegration(urls[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

  return {
    ok: true,
    source: 'CuratorOS Site Health',
    generatedAt: new Date().toISOString(),
    linkMapGeneratedAt: source.generatedAt || null,
    pageCount: results.length,
    pages: results,
  };
}

function compactSnapshot(snapshot) {
  const pages = (snapshot.pages || []).map(item => ({
    path: item.path,
    ok: item.ok !== false,
    httpStatus: item.httpStatus ?? null,
    canonicalOk: item.canonicalOk !== false,
    indexable: item.indexable !== false,
    issues: Array.isArray(item.issues) ? item.issues.slice(0, 4) : [],
  }));
  return {
    ok: true,
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
    linkMapGeneratedAt: snapshot.linkMapGeneratedAt,
    pageCount: pages.length,
    issuePageCount: pages.filter(p => !p.ok || !p.canonicalOk || !p.indexable || (p.httpStatus && p.httpStatus >= 400)).length,
    pages,
  };
}

async function inspectForIntegration(url) {
  const path = new URL(url).pathname || '/';
  try {
    const response = await fetchWithTimeout(url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
      redirect: 'follow',
    }, 10000);

    const contentType = response.headers.get('content-type') || '';
    const result = {
      path,
      ok: response.ok,
      httpStatus: response.status,
      canonicalOk: true,
      indexable: response.ok,
      issues: [],
    };

    if (!response.ok) result.issues.push(`HTTP ${response.status}`);
    if (!contentType.toLowerCase().includes('text/html')) return result;

    const html = await response.text();
    const canonical = extractCanonical(html);
    const robots = extractRobots(html);
    const finalUrl = response.url || url;
    result.canonicalOk = !canonical || equivalentPageUrl(canonical, finalUrl);
    result.indexable = response.ok && !robots.noindex;

    if (!result.canonicalOk) result.issues.push('Canonical does not match the fetched page.');
    if (robots.noindex) result.issues.push('Page contains a noindex directive.');
    result.ok = result.ok && result.canonicalOk && result.indexable;
    return result;
  } catch (error) {
    return {
      path,
      ok: false,
      httpStatus: null,
      canonicalOk: false,
      indexable: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function extractCanonical(html) {
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try { return new URL(href, 'https://oceanliners.net').href; } catch { return href; }
  }
  return '';
}

function extractRobots(html) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const directives = [];
  for (const tag of tags) {
    const name = attr(tag, 'name').toLowerCase();
    if (name === 'robots' || name === 'googlebot') directives.push(attr(tag, 'content').toLowerCase());
  }
  return { noindex: directives.some(value => /(^|[,\s])noindex([,\s]|$)/.test(value)) };
}

function attr(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function absoluteSiteUrl(value) {
  try {
    const url = new URL(value, 'https://oceanliners.net');
    if (!['oceanliners.net', 'www.oceanliners.net'].includes(url.hostname.toLowerCase())) return '';
    url.protocol = 'https:';
    url.host = 'oceanliners.net';
    url.hash = '';
    url.search = '';
    return url.href;
  } catch { return ''; }
}

function equivalentPageUrl(a, b) {
  try {
    const normalize = value => {
      const url = new URL(value, 'https://oceanliners.net');
      let path = url.pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '').replace(/\/$/, '') || '/';
      return path.toLowerCase();
    };
    return normalize(a) === normalize(b);
  } catch { return false; }
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

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
