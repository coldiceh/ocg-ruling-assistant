import assert from 'node:assert/strict';
const origin='https://ocg-ruling-assistant.vercel.app';
const expected='0f225c274c5f716b61baed5a5ba95ee7f8e10971';
const release=await (await fetch(origin+'/data/release.json',{cache:'no-store'})).json();
assert.equal(release.commit,expected);
const login=await fetch(origin+'/api/admin-auth',{method:'POST',headers:{origin,'content-type':'application/json'},
 body:JSON.stringify({action:'login',password:process.env.ADMIN_MODEL_LAB_PASSWORD}),signal:AbortSignal.timeout(20000)});
const session=await login.json();
assert.equal(session.authenticated,true,'Admin authentication must succeed');
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
const headers={origin,cookie,'content-type':'application/json','x-csrf-token':session.csrfToken};
async function get(route){const response=await fetch(origin+route,{headers,signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);return response.json();}
try{
 const caps=await get('/api/admin-model-lab?action=capabilities');
 assert.equal(caps.data.historyOnly,true);
 assert.equal(caps.data.features.createRun,false);
 const records=await get('/api/admin-model-lab?action=list&limit=3');
 const questions=await get('/api/admin-queries?limit=1');
 const blocked=await fetch(origin+'/api/admin-model-lab',{method:'POST',headers,
   body:JSON.stringify({action:'create',question:'Local-only deployment verification. Must not execute.'}),signal:AbortSignal.timeout(20000)});
 const result=await blocked.json();
 assert.equal(blocked.status,410);assert.equal(result.error,'admin_model_lab_local_only');
 console.log(JSON.stringify({commit:expected,historyOnly:true,historyReadOk:true,
   historySampleCount:records.data.records.length,questionHistoryReadOk:true,
   questionSampleCount:questions.count,experimentCreationStatus:blocked.status,modelCalls:0,ratingsModified:false}));
}finally{
 const logout=await fetch(origin+'/api/admin-auth',{method:'POST',headers,body:JSON.stringify({action:'logout'}),signal:AbortSignal.timeout(20000)});
 assert.equal(logout.status,200);
}
