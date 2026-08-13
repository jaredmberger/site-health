import base from './entry-v2.js';
import { BUILD_META } from '../generated/build-meta.js';

const SERVICE='Site Health';
const REPOSITORY='jaredmberger/site-health';
const HEARTBEAT_KEY='heartbeat:site-health:scheduled-monitor';

export default {
  async fetch(request, env, ctx){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/api/runtime') return json(runtimePayload(env));
    if(request.method==='GET'&&url.pathname==='/api/ops-health') return json(await opsHealth(env));
    return base.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx){ return base.scheduled(controller, env, ctx); }
};

function runtimePayload(env){const meta=env.CF_VERSION_METADATA||{};return{ok:true,service:SERVICE,version:'2.1.0',repository:REPOSITORY,runtime:'cloudflare-workers',cloudflareVersion:{id:meta.id||null,tag:meta.tag||null,timestamp:meta.timestamp||null},build:BUILD_META,observedAt:new Date().toISOString()};}
async function opsHealth(env){const hb=env.CURATOR_ERROR_RECORDS?await env.CURATOR_ERROR_RECORDS.get(HEARTBEAT_KEY,'json'):null;return freshness(hb,'hourly',27);}
function freshness(hb,schedule,minute){const at=hb?.at||null,maxAgeMinutes=Number(hb?.maxAgeMinutes||180),ageMinutes=at?Math.floor((Date.now()-Date.parse(at))/60000):null,stale=ageMinutes==null?null:ageMinutes>maxAgeMinutes;return{ok:stale!==true,service:SERVICE,schedule:{cadence:schedule,minute},lastSuccessAt:at,ageMinutes,maxAgeMinutes,stale,status:stale===true?'stale':at?'healthy':'unknown',heartbeat:hb?{component:hb.component||null,message:hb.message||null}:null,checkedAt:new Date().toISOString()};}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
