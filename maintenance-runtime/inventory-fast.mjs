import fs from 'node:fs';
import {createHash} from 'node:crypto';
const url=process.env.UPSTASH_REDIS_REST_URL, token=process.env.UPSTASH_REDIS_REST_TOKEN;
async function request(route,body) {
 const response=await fetch(url.replace(/\/$/,'')+route,{method:'POST',
   headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('Redis HTTP '+response.status);
 return response.json();
}
async function command(c){const j=await request('',c);if(j.error)throw Error('Redis command error');return j.result;}
const dbsize=await command(['DBSIZE']);
console.error(JSON.stringify({dbsize,stage:'scan'}));
const keys=new Set();let cursor='0',iterations=0;
do{
 const r=await command(['SCAN',cursor,'COUNT','1000']);
 if(!Array.isArray(r)||!Array.isArray(r[1]))throw Error('Invalid scan response');
 cursor=String(r[0]);for(const k of r[1])keys.add(k);
 if(++iterations>10000||keys.size>20000)throw Error('Inventory exceeds bound');
}while(cursor!=='0');
console.error(JSON.stringify({scanned:keys.size,stage:'metadata'}));
const prefixes=['admin-runs:v1','admin-lab-records:v1','rag-query-audit:v1','rag-public-answer-latency:v1','rag-budget','ocg-admin:v1','admin-final-budget:v1','rag-public-offtopic-risk-control:v1'];
const groups={},list=[...keys];let measured=0,unknown=0;
for(let offset=0;offset<list.length;offset+=50){
 const batch=list.slice(offset,offset+50),commands=batch.flatMap(k=>[['TYPE',k],['MEMORY','USAGE',k],['PTTL',k]]);
 const results=await request('/pipeline',commands);
 if(!Array.isArray(results)||results.length!==commands.length)throw Error('Invalid pipeline response');
 for(let i=0;i<batch.length;i++){
   const k=batch[i],normalized=k.replace(/^\{([^}]+)\}/,'$1');
   const prefix=prefixes.find(p=>normalized.startsWith(p));
   const bucket=prefix||'other-prefix-sha256:'+createHash('sha256').update(normalized.split(':')[0]).digest('hex').slice(0,12);
   const g=groups[bucket]||={keys:0,bytes:0,persistent:0,expiring:0,unknownBytes:0,types:{}};
   const [type,size,ttl]=results.slice(i*3,i*3+3);
   if(type.error||ttl.error)throw Error('Metadata command failed');
   g.keys++;g.types[type.result]=(g.types[type.result]||0)+1;
   if(size.error||!Number.isFinite(size.result)){unknown++;g.unknownBytes++;}
   else {g.bytes+=size.result;measured++;}
   if(ttl.result===-1)g.persistent++;else if(ttl.result>=0)g.expiring++;
 }
 fs.writeFileSync('inventory.json',JSON.stringify({at:new Date().toISOString(),dbsize,scanned:keys.size,inspected:Math.min(offset+50,list.length),
   totalBytes:Object.values(groups).reduce((s,g)=>s+g.bytes,0),measured,unknown,groups,valuesRead:false,complete:offset+50>=list.length},null,2));
}
console.log(fs.readFileSync('inventory.json','utf8'));
