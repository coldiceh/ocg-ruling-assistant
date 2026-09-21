export function createSyncProgress({enabled=false,log=console.log,intervalMs=30000,cost=()=>null}={}) {
 const start=Date.now();let state={stage:'starting'},last=0;
 function emit(force=false){
  if(!enabled||(!force&&Date.now()-last<2000))return;
  last=Date.now();const c=cost();
  log(`SYNC PROGRESS ${JSON.stringify({...state,elapsedSeconds:Math.round((Date.now()-start)/1000),...(c?{newRequests:c.requestsAttempted,knownCostUsd:c.knownCostUsd,unknownCostRequests:c.unknownCostRequests}:{})})}`);
 }
 const timer=enabled?setInterval(()=>emit(true),intervalMs):null;timer?.unref();
 return {update(p){const changed=p.stage&&p.stage!==state.stage;if(changed){delete state.completed;delete state.total;delete state.kind;}state={...state,...p};emit(Boolean(changed||p.completed===p.total));},finish(){if(timer)clearInterval(timer);emit(true);}};
}
export function memoizePreprocessCache(base){
 const nav=new Map(),rows=new Map();const out={...base};
 const nk=(key,v)=>`${key}:${v}`,rk=(kind,key,v='result')=>`${kind}:${key}:${v}`;
 async function memo(map,key,fn){if(!map.has(key))map.set(key,Promise.resolve().then(fn));const p=map.get(key);try{return await p;}catch(e){if(map.get(key)===p)map.delete(key);throw e;}}
 out.readNavigation=(key,v)=>memo(nav,nk(key,v),()=>base.readNavigation(key,v));
 out.readResult=(kind,key,v='result')=>memo(rows,rk(kind,key,v),()=>base.readResult(kind,key,v));
 out.readNavigationBatch=async(keys,v)=>{
  const missing=[...new Set(keys.filter(k=>!nav.has(nk(k,v))))];
  if(missing.length){const vals=base.readNavigationBatch?await base.readNavigationBatch(missing,v):await Promise.all(missing.map(k=>base.readNavigation(k,v)));if(!Array.isArray(vals)||vals.length!==missing.length)throw new Error('navigation_batch_invalid');missing.forEach((k,i)=>nav.set(nk(k,v),Promise.resolve(vals[i])));}
  return Promise.all(keys.map(k=>out.readNavigation(k,v)));
 };
 out.readResultBatch=async(kind,keys,v='result')=>{
  const missing=[...new Set(keys.filter(k=>!rows.has(rk(kind,k,v))))];
  if(missing.length){const vals=base.readResultBatch?await base.readResultBatch(kind,missing,v):await Promise.all(missing.map(k=>base.readResult(kind,k,v)));if(!Array.isArray(vals)||vals.length!==missing.length)throw new Error('dense_batch_invalid');missing.forEach((k,i)=>rows.set(rk(kind,k,v),Promise.resolve(vals[i])));}
  return Promise.all(keys.map(k=>out.readResult(kind,k,v)));
 };
 const invalidate=(kind,key)=>{for(const k of rows.keys())if(k.startsWith(`${kind}:${key}:`))rows.delete(k);if(kind==='nav')for(const k of nav.keys())if(k.startsWith(`${key}:`))nav.delete(k);};
 for(const name of ['writeRaw','writeResult','saveNavigationRaw','saveNavigationProviderRaw','saveNavigationNormalized','saveDense']){
  if(!base[name])continue;
  out[name]=async(...args)=>{const generic=['writeRaw','writeResult'].includes(name),kind=generic?args[0]:name==='saveDense'?'dense':'nav',key=generic?args[1]:args[0];invalidate(kind,key);try{return await base[name](...args);}finally{invalidate(kind,key);}};
 }
 return Object.freeze(out);
}
