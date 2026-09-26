import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
test('Site Health recovery export safety boundary',async()=>{
  const source=await readFile(new URL('../src/entry-v2.1.js',import.meta.url),'utf8');
  assert.match(source,/RECOVERY_EXPORT_TOKEN/);
  assert.match(source,/x-curator-recovery-key/);
  assert.match(source,/SITE_HEALTH_INTEGRATION_CACHE/);
  assert.match(source,/594632c804d045b589724f48dc72c08e/);
  assert.match(source,/list_complete/);
  assert.match(source,/dataSha256/);
});
