// Synthetic 150 x 3 usage persistence benchmark. Does not measure Electron video/GPU memory.
'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {createService}=require('../electron/services/media-library');
async function run(mode,base){
    global.gc?.();
    const root=path.join(base,mode);await fs.mkdir(root);
    const files=await Promise.all(Array.from({length:450},async(_,i)=>{
        const file=path.join(root,`${i}.png`);await fs.writeFile(file,`synthetic-media-${i}`);return file;
    }));
    const api=createService({cacheDir:path.join(base,`${mode}-cache`)});
    await api.handle({action:'track',root,paths:files});
    global.gc?.();
    const started=performance.now(),samples=[],replacements=[];
    const sample=()=>samples.push({elapsedMs:performance.now()-started,...process.memoryUsage()});
    sample();const timer=setInterval(sample,5);let serviceCalls=0;
    try{
        const records=[];
        for(let i=0;i<450;i++){
            const tick=performance.now(),record={eventId:`task-${Math.floor(i/3)}-slot-${i%3}`,taskName:`task-${Math.floor(i/3)}`,paths:[files[i]],used:true};
            if(mode==='serial'){serviceCalls++;await api.handle({action:'adoption',root,...record});}
            else records.push(record);
            replacements.push({task:Math.floor(i/3),slot:i%3,elapsedMs:performance.now()-started,operationMs:performance.now()-tick});
        }
        if(mode==='batch'){serviceCalls++;await api.handle({action:'adoption-batch',root,records});}
        sample();
        const totalMs=performance.now()-started;
        const history=(await api.handle({action:'read',root})).history;
        if(files.some(file=>history[file]?.count!==1))throw new Error(`${mode} usage count mismatch: ${JSON.stringify(files.filter(file=>history[file]?.count!==1).slice(0,3).map(file=>({file,history:history[file]})))}`);
        return {mode,totalMs,serviceCalls,peakRss:Math.max(...samples.map(s=>s.rss)),peakHeapUsed:Math.max(...samples.map(s=>s.heapUsed)),samples,replacements};
    }finally{clearInterval(timer);}
}
(async()=>{
    const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'videokit-stress-')));
    try{
        const results=[];for(const mode of ['serial','batch'])results.push(await run(mode,base));
        const directory=path.resolve('output/performance');await fs.mkdir(directory,{recursive:true});
        const file=path.join(directory,'reels-replacement-stress.json');
        await fs.writeFile(file,JSON.stringify({scope:'Synthetic usage persistence only; serial reference versus batched implementation. No video decoding or UI.',tasks:150,slotsPerTask:3,at:new Date().toISOString(),results},null,2));
        console.log(JSON.stringify({report:file,results:results.map(({mode,totalMs,serviceCalls,peakRss,peakHeapUsed})=>({mode,totalMs,serviceCalls,peakRss,peakHeapUsed}))},null,2));
    }finally{await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
