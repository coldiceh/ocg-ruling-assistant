import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, createCipheriv, publicEncrypt } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const mode=process.argv[2], out=path.resolve(process.env.MIGRATION_DIR || 'preprocess-backup');
const cacheRoot=path.resolve(process.env.EVIDENCE_CACHE_DIR || '.cache/evidence-preprocess');
const url=process.env.UPSTASH_BUDGET_KV_REST_API_URL;
const token=process.env.UPSTASH_BUDGET_KV_REST_API_TOKEN;
const sha=(value, algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
async function redis(commands, pipeline=false) {
 const r=await fetch(url.replace(/\/$/,'')+(pipeline?'/pipeline':''), {method:'POST',
   headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   body:JSON.stringify(commands),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('Redis HTTP '+r.status);
 const body=await r.json();
 const rows=pipeline?body:[body];
 if(!Array.isArray(rows)||rows.some(row=>row.error))throw Error('Redis command failed');
 return pipeline?rows.map(row=>row.result):body.result;
}
const parseKey=key=>/^evidence-preprocess:(nav|dense):\{([a-f0-9]{64})\}:([A-Za-z0-9._-]{1,160}):([A-Za-z0-9._-]+)$/.exec(key);
await fs.mkdir(out,{recursive:true});
if(mode==='backup'){
 const publicKey=Buffer.from(process.env.MIGRATION_PUBLIC_KEY_BASE64 || '', 'base64').toString('utf8');
 const keys=new Set();let cursor='0',scans=0;
 do{
   const r=await redis(['SCAN',cursor,'MATCH','evidence-preprocess:*','COUNT','1000']);
   if(!Array.isArray(r)||!Array.isArray(r[1]))throw Error('Invalid SCAN response');
   cursor=String(r[0]);for(const key of r[1])keys.add(key);
   if(++scans>1000||keys.size>20000)throw Error('Backup scope exceeded');
 }while(cursor!=='0');
 const rows=[], manifest={schemaVersion:1,createdAt:new Date().toISOString(),entries:[],retainedClaims:0,namespaces:{}};
 const ordered=[...keys].sort();
 for(let offset=0;offset<ordered.length;offset+=40){
   const batch=ordered.slice(offset,offset+40);
   const values=await redis(['MGET',...batch]);
   if(!Array.isArray(values)||values.length!==batch.length)throw Error('Invalid MGET response');
   for(let i=0;i<batch.length;i++){
     const key=batch[i],value=values[i],match=parseKey(key);
     if(typeof value!=='string'||!match)throw Error('Unexpected preprocessing cache entry');
     rows.push({key,value});
     const [,kind,inputKey,namespace,suffix]=match;
     if(suffix==='claim'){manifest.retainedClaims++;continue;}
     const parsed=JSON.parse(value);
     if(parsed.key!==inputKey||typeof parsed.kind!=='string')throw Error('Cache identity mismatch');
     const dir=path.join(cacheRoot,namespace,kind);
     const file=path.join(dir,inputKey+'.'+suffix+'.json');
     await fs.mkdir(dir,{recursive:true});
     await fs.writeFile(file,value);
     if(sha(await fs.readFile(file))!==sha(value))throw Error('Disk backup mismatch');
     manifest.entries.push({key,sha256:sha(value),sha1:sha(value,'sha1'),bytes:Buffer.byteLength(value)});
     manifest.namespaces[namespace]=(manifest.namespaces[namespace]||0)+1;
   }
 }
 const compressed=gzipSync(Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(compressed),cipher.final()]);
 await fs.writeFile(path.join(out,'backup.enc'),encrypted);
 await fs.writeFile(path.join(out,'envelope.json'),JSON.stringify({algorithm:'aes-256-gcm+rsa-oaep-sha256',
   wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),
   iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),encryptedSha256:sha(encrypted)}));
 const manifestText=JSON.stringify(manifest,null,2)+'\n';
 await fs.writeFile(path.join(out,'manifest.json'),manifestText);
 const report={mode,keys:rows.length,transferable:manifest.entries.length,retainedClaims:manifest.retainedClaims,
   bytes:manifest.entries.reduce((sum,row)=>sum+row.bytes,0),manifestSha256:sha(manifestText),
   encryptedBytes:encrypted.length,namespaces:manifest.namespaces,deleted:0};
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}else if(mode==='delete'){
 const text=await fs.readFile(path.join(out,'manifest.json'),'utf8');
 if(sha(text)!==process.env.CONFIRMED_MANIFEST_SHA256)throw Error('Verified local backup hash required');
 const manifest=JSON.parse(text);
 if(manifest.schemaVersion!==1||!Array.isArray(manifest.entries)||manifest.entries.length>20000)throw Error('Invalid manifest');
 for(const row of manifest.entries){
   if(!parseKey(row.key)||row.key.endsWith(':claim')||!/^[a-f0-9]{40}$/.test(row.sha1))throw Error('Invalid deletion scope');
 }
 // Delete only this exact backed-up value. Changed values and claims survive.
 const script="local v=redis.call('GET',KEYS[1]); if not v then return 0 end; if redis.sha1hex(v) ~= ARGV[1] then return -1 end; return redis.call('DEL',KEYS[1])";
 let deleted=0,missing=0,changed=0;
 for(let offset=0;offset<manifest.entries.length;offset+=50){
   const rows=manifest.entries.slice(offset,offset+50);
   const result=await redis(rows.map(row=>['EVAL',script,'1',row.key,row.sha1]),true);
   if(result.length!==rows.length)throw Error('Invalid delete response');
   for(const n of result){if(n===1)deleted++;else if(n===0)missing++;else if(n===-1)changed++;else throw Error('Invalid delete count');}
 }
 const report={mode,deleted,missing,changed,manifestSha256:sha(text),remainingDbKeys:await redis(['DBSIZE'])};
 await fs.writeFile(path.join(out,'deletion-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}else throw Error('Use backup or delete');
