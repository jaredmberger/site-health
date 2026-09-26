import base from './entry-v2.js';
import { BUILD_META } from '../generated/build-meta.js';

const SERVICE='Site Health';
const REPOSITORY='jaredmberger/site-health';
const HEARTBEAT_KEY='heartbeat:site-health:scheduled-monitor';

export default {
  async fetch(request, env, ctx){
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/api/recovery-export'){const auth=requireRecoveryExportToken(request,env);if(auth)return auth;return recoveryExport(env);}
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

function requireRecoveryExportToken(request,env){
  if(!env.RECOVERY_EXPORT_TOKEN)return json({ok:false,error:'Recovery export is disabled because RECOVERY_EXPORT_TOKEN is not configured.'},503);
  const supplied=request.headers.get('x-curator-recovery-key');
  return supplied===env.RECOVERY_EXPORT_TOKEN?null:json({ok:false,error:'Unauthorized recovery export request.'},401);
}
async function recoveryExport(env){
  if(!env.SITE_HEALTH_INTEGRATION_CACHE)return json({ok:false,error:'SITE_HEALTH_INTEGRATION_CACHE is not configured.'},500);
  try{
    const entries=[];let cursor;
    do{
      const page=await env.SITE_HEALTH_INTEGRATION_CACHE.list({limit:1000,...(cursor?{cursor}:{})});
      for(const item of page.keys){
        const raw=await env.SITE_HEALTH_INTEGRATION_CACHE.get(item.name,'text');
        if(raw===null)throw new Error(`Listed KV key disappeared during export: ${item.name}`);
        entries.push({key:item.name,value:raw});
      }
      cursor=page.list_complete?undefined:page.cursor;
    }while(cursor);
    entries.sort((a,b)=>a.key.localeCompare(b.key));
    const data={entries};
    const exportedAt=new Date().toISOString();
    const dataSha256=await sha256(JSON.stringify(data));
    const payload={format:'site-health-kv-recovery',schemaVersion:1,exportedAt,source:{service:SERVICE,binding:'SITE_HEALTH_INTEGRATION_CACHE',namespaceId:'594632c804d045b589724f48dc72c08e'},integrity:{algorithm:'SHA-256',dataSha256},summary:{keyCount:entries.length},data};
    const stamp=exportedAt.replace(/[:.]/g,'-');
    return new Response(JSON.stringify(payload,null,2),{status:200,headers:{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="site-health-recovery-${stamp}.json"`,'cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow, noarchive'}});
  }catch(error){return json({ok:false,error:'Recovery export failed.',detail:error?.message||String(error)},500);}
}
async function sha256(value){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
