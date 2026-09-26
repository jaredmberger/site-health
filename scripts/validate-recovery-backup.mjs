import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file=process.argv[2];
if(!file){console.error('Usage: node scripts/validate-recovery-backup.mjs <backup.json>');process.exit(2);}
let backup;
try{backup=JSON.parse(await readFile(file,'utf8'));}catch(error){fail(`Could not read valid JSON: ${error.message}`);}
if(backup.format!=='site-health-kv-recovery')fail('Unexpected backup format.');
if(backup.schemaVersion!==1)fail(`Unsupported schemaVersion: ${backup.schemaVersion}`);
if(!backup.data||!Array.isArray(backup.data.entries))fail('entries array is missing.');
if(!backup.integrity||backup.integrity.algorithm!=='SHA-256'||!backup.integrity.dataSha256)fail('SHA-256 integrity metadata is missing.');
const seen=new Set();
for(const entry of backup.data.entries){
  if(!entry||typeof entry.key!=='string'||!entry.key)fail('Backup contains an invalid KV key.');
  if(seen.has(entry.key))fail(`Duplicate KV key: ${entry.key}`);
  seen.add(entry.key);
  if(typeof entry.value!=='string')fail(`KV value is not a string for ${entry.key}`);
}
if(Number(backup.summary?.keyCount)!==backup.data.entries.length)fail('Summary keyCount does not match entries length.');
const actual=createHash('sha256').update(JSON.stringify(backup.data)).digest('hex');
if(actual!==backup.integrity.dataSha256)fail('SHA-256 integrity check failed.');
console.log('Site Health recovery backup is valid.');
console.log(`Exported: ${backup.exportedAt||'unknown'}`);
console.log(`KV keys: ${backup.data.entries.length}`);
console.log(`SHA-256: ${actual}`);
function fail(message){console.error(`Invalid Site Health recovery backup: ${message}`);process.exit(1);}
