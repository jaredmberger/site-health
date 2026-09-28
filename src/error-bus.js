const INCIDENT_PREFIX='incident:';
const HEARTBEAT_PREFIX='heartbeat:';
const EVENT_PREFIX='event:';
const FAILURE_STATE_PREFIX='quiet-failure:';
const RECOVERY_STATE_PREFIX='quiet-recovery:';
const STATE_TTL=60*60*24*14;
const RECOVERED_TTL=60*60*24*180;

export async function reportSystemError(env,{source,component,error,severity='p1',type='runtime-error',context={},confirmAfter=null}){
  if(!env.CURATOR_ERROR_RECORDS)return null;

  const message=error instanceof Error?error.message:String(error||'Unknown error');
  const now=new Date().toISOString();
  const threshold=resolveConfirmAfter(confirmAfter,type,component);
  const failureKey=quietKey(FAILURE_STATE_PREFIX,source,component);
  const recoveryKey=quietKey(RECOVERY_STATE_PREFIX,source,component);

  await env.CURATOR_ERROR_RECORDS.delete(recoveryKey);

  let confirmation=null;
  if(threshold>1){
    const prior=await env.CURATOR_ERROR_RECORDS.get(failureKey,'json');
    confirmation={
      source,
      component,
      type,
      failureStreak:Number(prior?.failureStreak||0)+1,
      confirmAfter:threshold,
      firstFailureAt:prior?.firstFailureAt||now,
      lastFailureAt:now,
      lastMessage:message
    };
    await env.CURATOR_ERROR_RECORDS.put(failureKey,JSON.stringify(confirmation),{expirationTtl:STATE_TTL});

    if(confirmation.failureStreak<threshold){
      return {status:'observing',...confirmation};
    }
  }

  const fingerprint=await fingerprintFor(source,component,type,message);
  const key=INCIDENT_PREFIX+fingerprint;
  const previous=await env.CURATOR_ERROR_RECORDS.get(key,'json');
  const incident={
    id:previous?.id||`incident_${fingerprint.slice(0,20)}`,
    fingerprint,
    source,
    component,
    severity:normalizeSeverity(severity),
    type,
    message,
    context:sanitize(context),
    confirmation:confirmation?{failureStreak:confirmation.failureStreak,confirmAfter:threshold}:null,
    firstSeenAt:previous?.firstSeenAt||now,
    lastSeenAt:now,
    occurrences:Number(previous?.occurrences||0)+1,
    status:'active',
    recoveredAt:null,
    recoveryMessage:null
  };

  await env.CURATOR_ERROR_RECORDS.put(key,JSON.stringify(incident));
  await writeEvent(env,'incident',incident);
  return incident;
}

export async function reportSystemSuccess(env,{source,component,message='Component completed successfully.',maxAgeMinutes=180,context={},recoverAfter=null}){
  if(!env.CURATOR_ERROR_RECORDS)return;

  const now=new Date().toISOString();
  const failureKey=quietKey(FAILURE_STATE_PREFIX,source,component);
  const recoveryKey=quietKey(RECOVERY_STATE_PREFIX,source,component);

  await env.CURATOR_ERROR_RECORDS.put(
    `${HEARTBEAT_PREFIX}${slug(source)}:${slug(component)}`,
    JSON.stringify({source,component,status:'ok',message,at:now,maxAgeMinutes,context:sanitize(context)})
  );
  await env.CURATOR_ERROR_RECORDS.delete(failureKey);

  const listed=await env.CURATOR_ERROR_RECORDS.list({prefix:INCIDENT_PREFIX,limit:1000});
  const active=[];
  for(const key of listed.keys){
    const incident=await env.CURATOR_ERROR_RECORDS.get(key.name,'json');
    if(!incident||incident.status!=='active'||incident.source!==source||incident.component!==component)continue;
    active.push([key.name,incident]);
  }

  if(!active.length){
    await env.CURATOR_ERROR_RECORDS.delete(recoveryKey);
    return;
  }

  const threshold=resolveRecoverAfter(recoverAfter,component,maxAgeMinutes);
  if(threshold>1){
    const prior=await env.CURATOR_ERROR_RECORDS.get(recoveryKey,'json');
    const recovery={
      source,
      component,
      cleanStreak:Number(prior?.cleanStreak||0)+1,
      recoverAfter:threshold,
      firstCleanAt:prior?.firstCleanAt||now,
      lastCleanAt:now
    };
    await env.CURATOR_ERROR_RECORDS.put(recoveryKey,JSON.stringify(recovery),{expirationTtl:STATE_TTL});
    if(recovery.cleanStreak<threshold)return;
  }

  for(const [key,incident] of active){
    const recovered={...incident,status:'recovered',recoveredAt:now,lastSuccessfulAt:now,recoveryMessage:message};
    await env.CURATOR_ERROR_RECORDS.put(key,JSON.stringify(recovered),{expirationTtl:RECOVERED_TTL});
    await writeEvent(env,'recovery',recovered);
  }
  await env.CURATOR_ERROR_RECORDS.delete(recoveryKey);
}

async function writeEvent(env,kind,incident){
  const stamp=new Date().toISOString();
  await env.CURATOR_ERROR_RECORDS.put(
    `${EVENT_PREFIX}${stamp}:${Math.random().toString(36).slice(2,8)}`,
    JSON.stringify({
      kind,
      at:stamp,
      incidentId:incident.id,
      fingerprint:incident.fingerprint,
      source:incident.source,
      component:incident.component,
      severity:incident.severity,
      status:incident.status,
      message:incident.message
    }),
    {expirationTtl:RECOVERED_TTL}
  );
}

async function fingerprintFor(source,component,type,message){
  const normalized=`${source}|${component}|${type}|${message}`
    .toLowerCase()
    .replace(/\d{4}-\d\d-\d\d[t ][\d:.z+-]+/g,'<timestamp>')
    .replace(/\b\d{6,}\b/g,'<number>');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized));
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,40);
}

function quietKey(prefix,source,component){
  return `${prefix}${slug(source)}:${slug(component)}`;
}

function resolveConfirmAfter(value,type,component){
  if(value!=null)return boundedInt(value,1,20,1);
  const scheduled=String(type||'').startsWith('scheduled-')||String(component||'').includes('scheduled')||String(component||'').includes('watchtower');
  return scheduled?3:1;
}

function resolveRecoverAfter(value,component,maxAgeMinutes){
  if(value!=null)return boundedInt(value,1,20,1);
  const scheduled=String(component||'').includes('scheduled')||String(component||'').includes('watchtower');
  if(!scheduled)return 1;
  return Number(maxAgeMinutes||0)<=360?2:1;
}

function boundedInt(value,min,max,fallback){
  const n=Number.parseInt(value,10);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}

function normalizeSeverity(value){
  const v=String(value||'').toLowerCase();
  if(['p0','critical'].includes(v))return'p0';
  if(['p1','high'].includes(v))return'p1';
  return'p2';
}

function slug(value){
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown';
}

function sanitize(value){
  const out={};
  if(!value||typeof value!=='object')return out;
  for(const [key,item] of Object.entries(value).slice(0,30)){
    if(/token|secret|password|authorization|cookie/i.test(key))continue;
    if(item==null||['string','number','boolean'].includes(typeof item)){
      out[String(key).slice(0,80)]=typeof item==='string'?item.slice(0,1000):item;
    }
  }
  return out;
}
