const url=process.env.UPSTASH_REDIS_REST_URL,token=process.env.UPSTASH_REDIS_REST_TOKEN;
async function command(c){const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(c),signal:AbortSignal.timeout(10000)});const b=await r.json();if(b.error)throw Error('Redis error');return b.result;}
const [,keys]=await command(['SCAN','0','MATCH','evidence-preprocess:*','COUNT','1000']);
const chosen=keys.slice(0,4).sort();
const result=[];
for(const key of chosen){const value=await command(['GET',key]);result.push({key,type:typeof value,fields:value&&typeof value==='object'?Object.keys(value):undefined,length:typeof value==='string'?value.length:undefined});}
console.log(JSON.stringify(result,null,2));
