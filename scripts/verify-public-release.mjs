import fs from 'node:fs';
const pagesUrl=process.argv[2] || 'https://coldiceh.github.io/ocg-ruling-assistant/';
const apiUrl='https://ocg-ruling-assistant.vercel.app/api/answer';
const manifest=JSON.parse(fs.readFileSync('data/rag-data-revision-manifest.json','utf8'));
const expected=process.env.EXPECTED_COMMIT;
if(!/^[a-f0-9]{40}$/.test(expected||'')) throw Error('expected_commit_required');
const until=Date.now()+8*60_000;
let last;
do {
  try {
    const [page, api]=await Promise.all([new URL('data/release.json',pagesUrl),apiUrl].map(async url=>{
      const res=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!res.ok) throw Error('release_http_'+res.status);
      return res.json();
    }));
    last={pages:page,backend:api.release};
    if([page,api.release].every(x=>x?.commit===expected && x?.dataRevision===manifest.revision)) {
      console.log(JSON.stringify({verified:true,...last}));process.exit(0);
    }
  }catch(error){last={error:error.message};}
  await new Promise(resolve=>setTimeout(resolve,15000));
}while(Date.now()<until);
console.error(JSON.stringify({verified:false,expected,...last}));process.exitCode=1;
