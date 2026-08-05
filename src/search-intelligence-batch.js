const SITE_ORIGIN = 'https://oceanliners.net';
const USER_AGENT = 'CuratorOS-Site-Health-Batch/1.0 (+https://oceanliners.net/)';
const MAX_PAGES = 20;

export async function handleSearchIntelligenceBatch(request) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed. Use POST.' }, 405);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Request body must be valid JSON.' }, 400); }

  const rawPages = Array.isArray(body?.pages) ? body.pages : [];
  const urls = [...new Set(rawPages.map(absoluteSiteUrl).filter(Boolean))].slice(0, MAX_PAGES);
  if (!urls.length) return json({ ok: true, checkedPageCount: 0, pages: [] });

  // Keep concurrency deliberately modest. This endpoint is designed for the
  // Search Intelligence action queue, not for whole-site crawling.
  const results = new Array(urls.length);
  let cursor = 0;
  const concurrency = Math.min(5, urls.length);

  async function worker() {
    while (cursor < urls.length) {
      const index = cursor++;
      results[index] = await inspect(urls[index]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return json({
    ok: true,
    source: 'CuratorOS Site Health',
    mode: 'bounded-batch',
    generatedAt: new Date().toISOString(),
    checkedPageCount: results.length,
    problemPageCount: results.filter(x => !x.ok).length,
    pages: results,
  });
}

async function inspect(url) {
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
    if (contentType.toLowerCase().includes('text/html')) {
      const html = await response.text();
      const canonical = extractCanonical(html);
      const noindex = extractNoindex(html);
      result.canonicalOk = !canonical || equivalentPageUrl(canonical, response.url || url);
      result.indexable = response.ok && !noindex;
      if (!result.canonicalOk) result.issues.push('Canonical does not match the fetched page.');
      if (noindex) result.issues.push('Page contains a noindex directive.');
    }

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

function absoluteSiteUrl(value) {
  try {
    const url = new URL(String(value || ''), SITE_ORIGIN);
    if (!['oceanliners.net', 'www.oceanliners.net'].includes(url.hostname.toLowerCase())) return '';
    url.protocol = 'https:';
    url.host = 'oceanliners.net';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function extractCanonical(html) {
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try { return new URL(href, SITE_ORIGIN).href; } catch { return href; }
  }
  return '';
}

function extractNoindex(html) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  return tags.some(tag => {
    const name = attr(tag, 'name').toLowerCase();
    if (name !== 'robots' && name !== 'googlebot') return false;
    return /(^|[,\s])noindex([,\s]|$)/.test(attr(tag, 'content').toLowerCase());
  });
}

function attr(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function equivalentPageUrl(a, b) {
  try {
    const normalize = value => {
      const url = new URL(value, SITE_ORIGIN);
      return (url.pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '').replace(/\/$/, '') || '/').toLowerCase();
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
