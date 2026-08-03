from pathlib import Path

p = Path('src/index.js')
s = p.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    s = s.replace(old, new, 1)


def insert_before(marker, addition, label):
    global s
    count = s.count(marker)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one marker, found {count}')
    s = s.replace(marker, addition + marker, 1)


replace_once(
''' * Required secret:\n *   AUDIT_TOKEN\n */''',
''' * Required secrets:\n *   AUDIT_TOKEN\n *   GITHUB_TOKEN  (fine-grained token limited to jaredmberger/Ocean-Liner-Curator)\n */''',
'worker secret documentation',
)

replace_once(
'''const DEFAULT_STARTS = [\n  `${SITE_ORIGIN}/`,\n  `${SITE_ORIGIN}/ships/ships`,\n  `${SITE_ORIGIN}/explore`,\n  `${SITE_ORIGIN}/collections`,\n  `${SITE_ORIGIN}/reference-objects`,\n];\n''',
'''const DEFAULT_STARTS = [\n  `${SITE_ORIGIN}/`,\n  `${SITE_ORIGIN}/ships/ships`,\n  `${SITE_ORIGIN}/explore`,\n  `${SITE_ORIGIN}/collections`,\n  `${SITE_ORIGIN}/reference-objects`,\n];\nconst REPAIR_REPOSITORY = "jaredmberger/Ocean-Liner-Curator";\nconst REPAIR_BASE_BRANCH = "main";\nconst GITHUB_API = "https://api.github.com";\nconst MAX_REPAIR_ITEMS = 250;\n''',
'repair constants',
)

replace_once(
'''      if (url.pathname === "/api/suggest") return await suggestReplacement(url);\n      if (url.pathname === "/api/config") {''',
'''      if (url.pathname === "/api/suggest") return await suggestReplacement(url);\n      if (url.pathname === "/api/repair/preview" && request.method === "POST") return await previewRepairs(request, env);\n      if (url.pathname === "/api/repair/create-pr" && request.method === "POST") return await createRepairPullRequest(request, env);\n      if (url.pathname === "/api/config") {''',
'repair routes',
)

insert_before(
'async function inspectPage(requestUrl) {',
r'''async function previewRepairs(request, env) {
  const repairs = await readRepairRequest(request);
  const grouped = groupRepairsByFile(repairs);
  const files = [];
  const failures = [];

  for (const [path, items] of grouped) {
    try {
      const source = await githubGetFile(path, REPAIR_BASE_BRANCH, env);
      const result = applyRepairItems(source.content, items, path);
      files.push({ path, repairCount: items.length, changed: result.content !== source.content });
    } catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return json({
    ok: failures.length === 0,
    repairCount: repairs.length,
    fileCount: grouped.size,
    files,
    failures,
  }, failures.length ? 422 : 200);
}

async function createRepairPullRequest(request, env) {
  if (!env.GITHUB_TOKEN) {
    return json({ error: "GITHUB_TOKEN is not configured in Site Health Worker settings." }, 503);
  }

  const repairs = await readRepairRequest(request);
  const grouped = groupRepairsByFile(repairs);
  const baseRef = await githubApi(`/repos/${REPAIR_REPOSITORY}/git/ref/heads/${encodeURIComponent(REPAIR_BASE_BRANCH)}`, env);
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) throw new Error("Could not resolve the production branch SHA.");

  const baseCommit = await githubApi(`/repos/${REPAIR_REPOSITORY}/git/commits/${baseSha}`, env);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (!baseTreeSha) throw new Error("Could not resolve the production tree SHA.");

  const tree = [];
  const applied = [];
  for (const [path, items] of grouped) {
    const source = await githubGetFile(path, REPAIR_BASE_BRANCH, env);
    const result = applyRepairItems(source.content, items, path);
    if (result.content === source.content) throw new Error(`${path}: repair produced no content change.`);

    const blob = await githubApi(`/repos/${REPAIR_REPOSITORY}/git/blobs`, env, {
      method: "POST",
      body: JSON.stringify({ content: utf8ToBase64(result.content), encoding: "base64" }),
    });
    if (!blob?.sha) throw new Error(`${path}: GitHub did not return a blob SHA.`);
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    applied.push(...result.applied);
  }

  const newTree = await githubApi(`/repos/${REPAIR_REPOSITORY}/git/trees`, env, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!newTree?.sha) throw new Error("GitHub did not return the repair tree SHA.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branch = `site-health/repairs-${stamp}`;
  const commit = await githubApi(`/repos/${REPAIR_REPOSITORY}/git/commits`, env, {
    method: "POST",
    body: JSON.stringify({
      message: `Repair ${repairs.length} link finding${repairs.length === 1 ? "" : "s"} from Site Health`,
      tree: newTree.sha,
      parents: [baseSha],
    }),
  });
  if (!commit?.sha) throw new Error("GitHub did not return the repair commit SHA.");

  await githubApi(`/repos/${REPAIR_REPOSITORY}/git/refs`, env, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  });

  const replaceCount = repairs.filter(item => item.action === "replace").length;
  const removeCount = repairs.filter(item => item.action === "remove_link").length;
  const body = [
    "Created by OceanLiners.net Site Health Repair Center.",
    "",
    `- ${repairs.length} repair specifications`,
    `- ${replaceCount} URL replacements`,
    `- ${removeCount} dead hyperlinks removed while preserving visible text`,
    `- ${grouped.size} HTML files changed`,
    "",
    "Safety checks performed before commit:",
    "- each target mapped to an OceanLiners.net HTML file",
    "- each old URL was confirmed in a literal href attribute",
    "- replacement actions required an HTTP(S) destination",
    "- no direct write to main was performed",
  ].join("\n");

  const pr = await githubApi(`/repos/${REPAIR_REPOSITORY}/pulls`, env, {
    method: "POST",
    body: JSON.stringify({
      title: `Site Health link repairs — ${new Date().toISOString().slice(0, 10)}`,
      head: branch,
      base: REPAIR_BASE_BRANCH,
      body,
      draft: true,
    }),
  });

  return json({
    ok: true,
    branch,
    commitSha: commit.sha,
    pullRequestNumber: pr?.number || null,
    pullRequestUrl: pr?.html_url || null,
    repairCount: repairs.length,
    fileCount: grouped.size,
    replaceCount,
    removeCount,
    applied,
  });
}

async function readRepairRequest(request) {
  let payload;
  try { payload = await request.json(); } catch { throw new Error("Repair request must be valid JSON."); }
  const repairs = Array.isArray(payload?.repairs) ? payload.repairs : [];
  if (!repairs.length) throw new Error("Select at least one repair.");
  if (repairs.length > MAX_REPAIR_ITEMS) throw new Error(`A maximum of ${MAX_REPAIR_ITEMS} repair items can be submitted at once.`);

  return repairs.map((raw, index) => {
    const pageUrl = String(raw?.page_url || "").trim();
    const oldUrl = String(raw?.old_url || raw?.checked_url || "").trim();
    const action = String(raw?.action || "").trim();
    const newUrl = String(raw?.new_url || raw?.replacement_url || "").trim();
    if (!pageUrl || !oldUrl) throw new Error(`Repair ${index + 1}: page URL and old URL are required.`);
    const path = repoPathFromPageUrl(pageUrl);
    assertRepairHttpUrl(oldUrl, `Repair ${index + 1}: old URL`);
    if (!['replace', 'remove_link'].includes(action)) throw new Error(`Repair ${index + 1}: action must be replace or remove_link.`);
    if (action === 'replace') assertRepairHttpUrl(newUrl, `Repair ${index + 1}: replacement URL`);
    return { page_url: pageUrl, path, old_url: oldUrl, action, new_url: action === 'replace' ? newUrl : '' };
  });
}

function groupRepairsByFile(repairs) {
  const grouped = new Map();
  for (const item of repairs) {
    if (!grouped.has(item.path)) grouped.set(item.path, []);
    const items = grouped.get(item.path);
    if (!items.some(existing => existing.old_url === item.old_url && existing.action === item.action && existing.new_url === item.new_url)) items.push(item);
  }
  return grouped;
}

function repoPathFromPageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid OceanLiners.net page URL: ${value}`); }
  if (url.origin !== SITE_ORIGIN) throw new Error(`Repair pages must be on ${SITE_ORIGIN}.`);
  let path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  if (!path) return 'index.html';
  if (/\.html?$/i.test(path)) path = path.replace(/\.html?$/i, '.html');
  else path += '.html';
  if (path.includes('..') || !/^[A-Za-z0-9._\/-]+$/.test(path)) throw new Error(`Unsafe repository path derived from ${value}.`);
  return path;
}

function assertRepairHttpUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid.`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
}

function applyRepairItems(source, items, path) {
  let content = source;
  const applied = [];
  for (const item of items) {
    const oldPattern = item.old_url.endsWith('/')
      ? `${escapeRegExp(item.old_url.slice(0, -1))}/?`
      : escapeRegExp(item.old_url);

    if (item.action === 'replace') {
      const pattern = new RegExp(`(\\bhref\\s*=\\s*)(["'])${oldPattern}\\2`, 'gi');
      let count = 0;
      content = content.replace(pattern, (match, prefix, quote) => {
        count += 1;
        return `${prefix}${quote}${item.new_url}${quote}`;
      });
      if (!count) throw new Error(`${path}: literal href not found for ${item.old_url}. Manual review required.`);
      applied.push({ path, action: item.action, old_url: item.old_url, new_url: item.new_url, count });
    } else {
      const pattern = new RegExp(`<a\\b(?=[^>]*\\bhref\\s*=\\s*(["'])${oldPattern}\\1)[^>]*>([\\s\\S]*?)<\\/a\\s*>`, 'gi');
      let count = 0;
      content = content.replace(pattern, (match, quote, body) => {
        count += 1;
        return body;
      });
      if (!count) throw new Error(`${path}: literal anchor not found for ${item.old_url}. Manual review required.`);
      applied.push({ path, action: item.action, old_url: item.old_url, new_url: '', count });
    }
  }
  return { content, applied };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function githubGetFile(path, ref, env) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const data = await githubApi(`/repos/${REPAIR_REPOSITORY}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, env);
  if (!data?.content || data?.encoding !== 'base64') throw new Error(`${path}: GitHub file content was unavailable.`);
  return { content: base64ToUtf8(data.content.replace(/\s+/g, '')), sha: data.sha };
}

async function githubApi(path, env, options = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured in Site Health Worker settings.");
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${data?.message || 'request failed'}`);
  return data;
}

function base64ToUtf8(value) {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

''',
'repair server functions',
)

replace_once(
'''function extractAnchors(html, baseUrl) {\n  const results = [];\n  const regex = /<a\\b[^>]*href\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))[^>]*>([\\s\\S]*?)<\\/a>/gi;\n  let match;\n  while ((match = regex.exec(html))) {''',
'''function extractAnchors(html, baseUrl) {\n  const results = [];\n  const searchable = html.replace(/<script\\b[\\s\\S]*?<\\/script>/gi, match => ' '.repeat(match.length)).replace(/<style\\b[\\s\\S]*?<\\/style>/gi, match => ' '.repeat(match.length));\n  const regex = /<a\\b[^>]*href\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))[^>]*>([\\s\\S]*?)<\\/a>/gi;\n  let match;\n  while ((match = regex.exec(searchable))) {''',
'ignore script/style pseudo-anchors',
)

replace_once(
'''function corsHeaders() { return { \"access-control-allow-origin\": \"*\", \"access-control-allow-headers\": \"content-type,x-audit-token\", \"access-control-allow-methods\": \"GET,OPTIONS\" }; }''',
'''function corsHeaders() { return { \"access-control-allow-origin\": \"*\", \"access-control-allow-headers\": \"content-type,x-audit-token\", \"access-control-allow-methods\": \"GET,POST,OPTIONS\" }; }''',
'cors post support',
)

replace_once(
'''.small{font-size:.82rem;color:var(--muted)}.replacement{max-width:300px}.hidden{display:none}''',
'''.small{font-size:.82rem;color:var(--muted)}.replacement{max-width:300px}.repaircell{min-width:260px}.repaircell input[type=checkbox]{width:auto;margin-right:7px}.repaircell select,.repaircell input[type=url]{margin-top:6px;padding:8px}.repairbar{display:flex;gap:10px;align-items:end;margin:14px 0}.repairbar .card{flex:1}.repairbar button{width:auto;min-width:190px}.repairresult{margin-top:8px}.repairresult a{font-weight:800}.hidden{display:none}''',
'repair css',
)

replace_once(
'''<section class=\"filters\">\n<input id=\"search\" placeholder=\"Search URL, page, context…\"><select id=\"severity\"><option value=\"\">All severities</option><option value=\"broken\">Broken</option><option value=\"warning\">Warning</option><option value=\"good\">Good</option></select><select id=\"location\"><option value=\"\">All locations</option><option value=\"source\">Sources only</option><option value=\"body\">Body links only</option></select><button class=\"secondary\" id=\"exportBtn\" disabled>Export CSV for CuratorOS</button>\n</section>\n<div class=\"tablewrap\"><table><thead><tr><th>Page</th><th>Link</th><th>Location</th><th>Status</th><th>HTTP</th><th>Final URL</th><th>Context</th><th>Replacement</th></tr></thead><tbody id=\"rows\"></tbody></table></div>''',
'''<section class=\"filters\">\n<input id=\"search\" placeholder=\"Search URL, page, context…\"><select id=\"severity\"><option value=\"\">All severities</option><option value=\"broken\">Broken</option><option value=\"warning\">Warning</option><option value=\"good\">Good</option></select><select id=\"location\"><option value=\"\">All locations</option><option value=\"source\">Sources only</option><option value=\"body\">Body links only</option></select><button class=\"secondary\" id=\"exportBtn\" disabled>Export CSV for CuratorOS</button>\n</section>\n<section class=\"repairbar\"><div class=\"card\"><strong>Repair Center</strong><div class=\"small\">Select broken findings below, choose Replace or Remove link, then create a draft GitHub PR. Site Health never writes directly to main.</div><div class=\"repairresult\" id=\"repairResult\"></div></div><button id=\"repairBtn\" disabled>Create repair PR</button></section>\n<div class=\"tablewrap\"><table><thead><tr><th>Page</th><th>Link</th><th>Location</th><th>Status</th><th>HTTP</th><th>Final URL</th><th>Context</th><th>Replacement</th><th>Repair</th></tr></thead><tbody id=\"rows\"></tbody></table></div>''',
'repair center html',
)

replace_once(
'''const state={queue:[],seen:new Set(),pages:[],rows:[],running:false};\nconst $=id=>document.getElementById(id);\nconst api=async(path,params={})=>{const u=new URL(path,location.origin);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u,{headers:{'x-audit-token':$('token').value}});const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');return j};\n$('runBtn').onclick=run;$('exportBtn').onclick=exportCsv;$('search').oninput=render;$('severity').onchange=render;$('location').onchange=render;''',
'''const state={queue:[],seen:new Set(),pages:[],rows:[],running:false};\nconst $=id=>document.getElementById(id);\nconst api=async(path,params={})=>{const u=new URL(path,location.origin);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u,{headers:{'x-audit-token':$('token').value}});const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');return j};\nconst apiPost=async(path,body)=>{const r=await fetch(new URL(path,location.origin),{method:'POST',headers:{'content-type':'application/json','x-audit-token':$('token').value},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||(j.failures&&j.failures.map(x=>x.path+': '+x.error).join('; '))||'Request failed');return j};\n$('runBtn').onclick=run;$('exportBtn').onclick=exportCsv;$('repairBtn').onclick=createRepairPr;$('search').oninput=render;$('severity').onchange=render;$('location').onchange=render;''',
'client api post',
)

replace_once(
'''        state.rows.push({page_url:page.finalUrl,page_title:page.title,checked_url:link.url,anchor_text:link.label,context:link.context,in_sources:link.inSources,status:check.status??'',category:check.category,severity:check.severity,final_url:check.finalUrl||'',replacement_url:replacement});''',
'''        state.rows.push({repair_id:'r'+state.rows.length,page_url:page.finalUrl,page_title:page.title,checked_url:link.url,anchor_text:link.label,context:link.context,in_sources:link.inSources,status:check.status??'',category:check.category,severity:check.severity,final_url:check.finalUrl||'',replacement_url:replacement,repair_selected:false,repair_action:replacement?'replace':'remove_link',repair_new_url:replacement});''',
'repair row state',
)

replace_once(
'''function render(){\n  const q=$('search').value.toLowerCase();\n  const sev=$('severity').value;\n  const loc=$('location').value;\n  const rows=state.rows.filter(r=>(!q||[r.page_url,r.checked_url,r.context,r.page_title].join(' ').toLowerCase().includes(q))&&(!sev||r.severity===sev)&&(!loc||(loc==='source'?r.in_sources:!r.in_sources)));\n  $('rows').innerHTML=rows.map(r=>'<tr><td><a href=\"'+esc(r.page_url)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.page_title||r.page_url)+'</a></td><td><a href=\"'+esc(r.checked_url)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.anchor_text||r.checked_url)+'</a></td><td>'+(r.in_sources?'Source':'Body')+'</td><td><span class=\"pill '+esc(r.severity)+'\">'+esc(r.category)+'</span></td><td>'+esc(r.status)+'</td><td>'+(r.final_url?'<a href=\"'+esc(r.final_url)+'\" target=\"_blank\" rel=\"noopener\">Open</a>':'')+'</td><td class=\"small\">'+esc(r.context)+'</td><td class=\"replacement\">'+(r.replacement_url?'<a href=\"'+esc(r.replacement_url)+'\" target=\"_blank\" rel=\"noopener\">Suggested replacement</a>':'')+'</td></tr>').join('');\n  updateStats();\n}\n''',
'''function render(){\n  const q=$('search').value.toLowerCase();\n  const sev=$('severity').value;\n  const loc=$('location').value;\n  const rows=state.rows.filter(r=>(!q||[r.page_url,r.checked_url,r.context,r.page_title].join(' ').toLowerCase().includes(q))&&(!sev||r.severity===sev)&&(!loc||(loc==='source'?r.in_sources:!r.in_sources)));\n  $('rows').innerHTML=rows.map(r=>{const repair=r.severity==='broken'?'<td class=\"repaircell\"><label><input type=\"checkbox\" data-repair-select=\"'+esc(r.repair_id)+'\" '+(r.repair_selected?'checked':'')+'>Select</label><select data-repair-action=\"'+esc(r.repair_id)+'\"><option value=\"replace\" '+(r.repair_action==='replace'?'selected':'')+' '+(!r.replacement_url?'disabled':'')+'>Replace URL</option><option value=\"remove_link\" '+(r.repair_action==='remove_link'?'selected':'')+'>Remove hyperlink</option></select>'+(r.repair_action==='replace'?'<input type=\"url\" data-repair-url=\"'+esc(r.repair_id)+'\" value=\"'+esc(r.repair_new_url||'')+'\" placeholder=\"Replacement URL\">':'')+'</td>':'<td class=\"small\">—</td>';return '<tr><td><a href=\"'+esc(r.page_url)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.page_title||r.page_url)+'</a></td><td><a href=\"'+esc(r.checked_url)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.anchor_text||r.checked_url)+'</a></td><td>'+(r.in_sources?'Source':'Body')+'</td><td><span class=\"pill '+esc(r.severity)+'\">'+esc(r.category)+'</span></td><td>'+esc(r.status)+'</td><td>'+(r.final_url?'<a href=\"'+esc(r.final_url)+'\" target=\"_blank\" rel=\"noopener\">Open</a>':'')+'</td><td class=\"small\">'+esc(r.context)+'</td><td class=\"replacement\">'+(r.replacement_url?'<a href=\"'+esc(r.replacement_url)+'\" target=\"_blank\" rel=\"noopener\">Suggested replacement</a>':'')+'</td>'+repair+'</tr>'}).join('');\n  document.querySelectorAll('[data-repair-select]').forEach(el=>el.onchange=()=>{const r=state.rows.find(x=>x.repair_id===el.dataset.repairSelect);if(r)r.repair_selected=el.checked;updateRepairButton()});\n  document.querySelectorAll('[data-repair-action]').forEach(el=>el.onchange=()=>{const r=state.rows.find(x=>x.repair_id===el.dataset.repairAction);if(r){r.repair_action=el.value;render()}});\n  document.querySelectorAll('[data-repair-url]').forEach(el=>el.oninput=()=>{const r=state.rows.find(x=>x.repair_id===el.dataset.repairUrl);if(r)r.repair_new_url=el.value});\n  updateStats();updateRepairButton();\n}\nfunction updateRepairButton(){const selected=state.rows.filter(r=>r.repair_selected&&r.severity==='broken');$('repairBtn').disabled=!selected.length||state.running;$('repairBtn').textContent=selected.length?'Create repair PR ('+selected.length+')':'Create repair PR'}\nasync function createRepairPr(){const selected=state.rows.filter(r=>r.repair_selected&&r.severity==='broken');if(!selected.length)return;const repairs=selected.map(r=>({page_url:r.page_url,old_url:r.checked_url,action:r.repair_action,new_url:r.repair_action==='replace'?(r.repair_new_url||r.replacement_url):''}));if(!confirm('Create a draft GitHub pull request for '+repairs.length+' selected repair'+(repairs.length===1?'':'s')+'? No changes will be written directly to main.'))return;$('repairBtn').disabled=true;$('repairResult').textContent='Validating repairs against the repository…';try{await apiPost('/api/repair/preview',{repairs});$('repairResult').textContent='Validation passed. Creating branch, commit, and draft PR…';const result=await apiPost('/api/repair/create-pr',{repairs});$('repairResult').innerHTML='✓ '+esc(result.repairCount)+' repairs across '+esc(result.fileCount)+' files. <a href=\"'+esc(result.pullRequestUrl)+'\" target=\"_blank\" rel=\"noopener\">Open draft PR #'+esc(result.pullRequestNumber)+'</a>';selected.forEach(r=>r.repair_selected=false);render()}catch(e){$('repairResult').textContent='Repair not created: '+e.message;updateRepairButton()}}\n''',
'repair client rendering',
)

# Ensure a new scan clears any stale repair result.
replace_once(
'''  state.running=true;state.queue=[];state.seen=new Set();state.pages=[];state.rows=[];\n  $('exportBtn').disabled=true;render();''',
'''  state.running=true;state.queue=[];state.seen=new Set();state.pages=[];state.rows=[];\n  $('exportBtn').disabled=true;$('repairResult').textContent='';render();''',
'clear repair result',
)

p.write_text(s, encoding='utf-8')
print('Site Health Repair Center patch applied successfully.')
