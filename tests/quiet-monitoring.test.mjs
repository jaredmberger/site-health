import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('scheduled monitor errors are quiet until persistence is confirmed',async()=>{
  const source=await readFile(new URL('../src/error-bus.js',import.meta.url),'utf8');
  assert.match(source,/resolveConfirmAfter/);
  assert.match(source,/scheduled\?3:1/);
  assert.match(source,/status:'observing'/);
  assert.match(source,/failureStreak/);
});

test('recovery is cadence-aware',async()=>{
  const source=await readFile(new URL('../src/error-bus.js',import.meta.url),'utf8');
  assert.match(source,/resolveRecoverAfter/);
  assert.match(source,/Number\(maxAgeMinutes\|\|0\)<=360\?2:1/);
  assert.match(source,/cleanStreak/);
});

test('ordinary errors remain immediate by default',async()=>{
  const source=await readFile(new URL('../src/error-bus.js',import.meta.url),'utf8');
  assert.match(source,/return scheduled\?3:1/);
  assert.match(source,/if\(threshold>1\)/);
});
