import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
let git=null;try{git=execSync('git rev-parse HEAD',{encoding:'utf8'}).trim();}catch{}
const meta={commit:process.env.WORKERS_CI_COMMIT_SHA||git||null,branch:process.env.WORKERS_CI_BRANCH||null,buildUuid:process.env.WORKERS_CI_BUILD_UUID||null,source:process.env.WORKERS_CI_COMMIT_SHA?'cloudflare-workers-build':'git-checkout'};
await mkdir('generated',{recursive:true});
await writeFile('generated/build-meta.js',`export const BUILD_META=${JSON.stringify(meta)};\n`);
console.log('Stamped build metadata',meta.commit?.slice(0,8)||'unknown');
