/** Pure planning: previews never mutate tasks or history. */
(function(root,factory){
    if(typeof module==='object' && module.exports)module.exports=factory();
    else root.ReelsCombinationPlanner=factory();
})(typeof window==='object'?window:globalThis,function(){
    const capFor=(item,maxUses,phoneMaxUses,characterMaxUses=null)=>Math.min(item._remainingRoundCapacity ?? Infinity,item.phone?(phoneMaxUses || Infinity):item.origin==='characters' && characterMaxUses!==null?(characterMaxUses || Infinity):maxUses);
    const originLabels={temporary:'临时素材',library:'固定素材',characters:'爆贴人物库',batch:'本批素材'};
    // A phone image can contain a pair of numbers. Style suffixes never identify a group.
    function phoneGroup(item){
        const name=String(item.name || item.path || item.id || '').split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
        const numbers=[...new Set((name.match(/[+＋]\s*\d[\d ()-]*\d/g) || [])
            .map(value=>'+'+value.replace(/\D/g,''))
            .filter(value=>value.length>=8 && value.length<=16))].sort();
        const fallback=name.replace(/_\d+$/,'').trim();
        return {key:numbers.length?'numbers:'+numbers.join('|'):'name:'+fallback,
            label:numbers.length?numbers.join(' / '):fallback,recognized:!!numbers.length};
    }
    const phoneQuotaKey=(keyword,item)=>'phone:'+JSON.stringify([keyword,phoneGroup(item).key]);
    function phoneHistory(materials){
        const counts=new Map();
        for(const item of new Map(materials.filter(item=>item.phone).map(item=>[item.id,item])).values()){
            const key=phoneGroup(item).key;counts.set(key,(counts.get(key)||0)+(Number(item.history)||0));
        }
        return counts;
    }
    function orderPhones(items,combinations,keyword,history=phoneHistory(items),random=Math.random){
        if(!items.some(item=>item.phone))return items;
        const counts=new Map(),groups=new Map();
        for(const combo of combinations)if(combo.keyword===keyword)for(const {item} of combo.pairs)if(item.phone){
            const key=phoneGroup(item).key;counts.set(key,(counts.get(key)||0)+1);
        }
        for(const item of items.filter(item=>item.phone)){
            const key=phoneGroup(item).key;
            if(!groups.has(key))groups.set(key,{key,rank:random(),items:[]});
            groups.get(key).items.push({item,rank:random()});
        }
        // Equal probability per number group, regardless of how many styles it contains.
        const ordered=[...groups.values()].sort((a,b)=>(counts.get(a.key)||0)-(counts.get(b.key)||0) ||
            (history.get(a.key)||0)-(history.get(b.key)||0) || a.rank-b.rank);
        return [...items.filter(item=>!item.phone),...ordered.flatMap(group=>group.items.sort((a,b)=>a.rank-b.rank).map(entry=>entry.item))];
    }
    function distributionReport(planned,materials=[]){
        const keywords=new Map();
        const entry=key=>{if(!keywords.has(key))keywords.set(key,{keyword:key,sets:0,phones:new Map()});return keywords.get(key);};
        const add=(row,item)=>{const group=phoneGroup(item);if(!row.phones.has(group.key))row.phones.set(group.key,{...group,quotaKey:phoneQuotaKey(row.keyword,item),uses:0,styles:new Set()});const phone=row.phones.get(group.key);phone.styles.add(item.id);return phone;};
        for(const item of materials)for(const key of item.keywords || [item.keyword])if(key){const row=entry(key);if(item.phone)add(row,item);}
        for(const combo of planned.combinations || []){
            const row=entry(combo.keyword);row.sets++;
            for(const {item} of combo.pairs)if(item.phone)add(row,item).uses++;
        }
        return [...keywords.values()].map(row=>({...row,phones:[...row.phones.values()].map(phone=>({...phone,styles:phone.styles.size}))}));
    }
    const archivedMaterial=item=>!!item.archiveBatchId || /(?:^|[\\/])本批已经使用[\\/]/.test(item.path || '');
    const materialFolder=item=>String(item.path || '').replace(/\\/g,'/').replace(/\/[^/]+\/?$/,'');
    function isAudienceSlot(slot){
        return /^pip_audience(?:_main|_\d+)?$/.test(String(slot?.mediaSlot || '')) || /^pip(?::|_)?audience(?:_main|_\d+)?$/.test(String(slot?.key || '')) || /画中画[（(](?:主观众|观众)[）)]/.test(String(slot?.label || ''));
    }
    function audienceGenderAllowed(pairs,total,existing=[]){
        if(total!==2)return true;
        const genders=new Set();
        for(const {slot,item} of [...pairs.filter(Boolean),...existing]){
            if(!isAudienceSlot(slot) || item?.phone)continue;
            const path=String(item?.path || '').replace(/\\/g,'/').replace(/\/+$/,'');
            const folder=(item?.folder || item?.unit?.folder) ? path.split('/').pop() : path.split('/').slice(-2,-1)[0] || '';
            const male=folder.includes('男'),female=folder.includes('女');
            if(male!==female)genders.add(male?'男':'女');
        }
        return genders.size<2;
    }
    function usageKeys(item){
        if(item.phone)return [];
        const origin=item.origin || 'other',folder=materialFolder(item);
        return ['source:'+origin,...(archivedMaterial(item)?['history:'+origin]:[]),'folder:'+origin+':'+folder];
    }
    function batchUsage(planned,materials=[]){
        const rows=new Map(),add=(key,label,unit='次')=>{if(!rows.has(key))rows.set(key,{key,label,count:0,unique:new Set(),unit});return rows.get(key);};
        for(const [origin,label] of Object.entries(originLabels)){add('source:'+origin,label+' · 合计');add('history:'+origin,label+' · 其中历史素材');}
        const folderRow=item=>add('folder:'+(item.origin || 'other')+':'+materialFolder(item),(originLabels[item.origin] || '其他来源')+' / '+materialFolder(item));
        const phoneRow=(keyword,item)=>add(phoneQuotaKey(keyword,item),keyword+' / '+phoneGroup(item).label);
        for(const item of materials){if(!item.phone)folderRow(item);for(const key of (item.keywords || [item.keyword]).filter(Boolean)){add('keyword:'+key,'关键词 / '+key,'套');if(item.phone)phoneRow(key,item);}}
        for(const combo of planned.combinations || []){
            const keyword=add('keyword:'+combo.keyword,'关键词 / '+combo.keyword,'套');keyword.count++;
            for(const {item} of combo.pairs || [])if(!item.phone){
                folderRow(item);
                for(const key of usageKeys(item)){const row=rows.get(key) || add(key,key);row.count++;row.unique.add(item.id);}
            }else{const row=phoneRow(combo.keyword,item);row.count++;row.unique.add(item.id);}
        }
        return [...rows.values()].map(row=>({...row,unique:row.unique.size}));
    }
    function validateBatchQuotas(quotas={}){
        for(const [key,value] of Object.entries(quotas))if(!/^(source|history|folder|keyword|phone):/.test(key) || !Number.isSafeInteger(value) || value<0)throw new Error('本批匹配数量请输入 0 或正整数，留空自动补齐');
        for(const origin of Object.keys(originLabels))if(quotas['history:'+origin]!==undefined && quotas['source:'+origin]!==undefined && quotas['history:'+origin]>quotas['source:'+origin])throw new Error(`${originLabels[origin]}的历史数量不能超过该来源合计`);
    }
    function quotaState(combinations){
        const counts=new Map();let positions=0,phonePositions=0;
        for(const combo of combinations){counts.set('keyword:'+combo.keyword,(counts.get('keyword:'+combo.keyword)||0)+1);for(const {item} of combo.pairs || [])if(!item.phone){positions++;for(const key of usageKeys(item))counts.set(key,(counts.get(key)||0)+1);}else{phonePositions++;const key=phoneQuotaKey(combo.keyword,item);counts.set(key,(counts.get(key)||0)+1);}}
        return {counts,positions,phonePositions,sets:combinations.length};
    }
    function batchQuotasAllowed(state,combo,quotas,expectedCount,ordinarySlots,phoneSlots=1){
        if(!Object.keys(quotas).length)return true;
        const next=combo?quotaState([combo]):{counts:new Map(),positions:0,phonePositions:0,sets:0};
        for(const [key,target] of Object.entries(quotas)){
            const actual=(state.counts.get(key)||0)+(next.counts.get(key)||0);
            const remaining=key.startsWith('keyword:')?expectedCount-state.sets-next.sets:key.startsWith('phone:')?expectedCount*phoneSlots-state.phonePositions-next.phonePositions:expectedCount*ordinarySlots-state.positions-next.positions;
            if(actual>target || target-actual>Math.max(0,remaining))return false;
        }
        return true;
    }
    function validateKeywordLimits(limits={}){
        for(const [key,limit] of Object.entries(limits))if(!Number.isSafeInteger(limit)||limit<0)throw new Error(`${key}的套数上限请输入 0 或正整数（0 不限）`);
    }
    function keywordCount(combinations,key){return combinations.filter(combo=>combo.keyword===key).length;}
    function validateSourceLimits(limits={}){
        for(const [source,rule] of Object.entries(limits)){
            if(!Number.isSafeInteger(rule.min ?? 0)||(rule.min ?? 0)<0 || !Number.isSafeInteger(rule.max ?? 0)||(rule.max ?? 0)<0 || (rule.max && (rule.min || 0)>rule.max))throw new Error(`${originLabels[source] || source}的每套来源数量设置无效（最多 0 表示不限）`);
            for(const [count,weight] of Object.entries(rule.weights || {}))if(!/^\d+$/.test(count) || !Number.isFinite(weight) || weight<0)throw new Error('来源数量权重请输入非负数字，留空为随机');
            if(rule.percentages){
                const percentages=Object.values(rule.percentages),sum=percentages.reduce((sum,n)=>sum+n,0);
                if(percentages.some(n=>!Number.isFinite(n) || n<0 || n>100))throw new Error('固定比例请输入 0–100%，留空自动分配剩余比例');
                if(sum>100+1e-8)throw new Error('手动固定比例合计超过 100%，其他固定值保持不变，请调低部分比例');
                if(rule.automaticQuantities?.length===0 && Math.abs(sum-100)>1e-8)throw new Error('请至少留一个数量为自动，或将手动固定比例补足 100%');
            }
        }
    }
    function sourcesAllowed(pairs,limits={},complete=true){
        if(Object.keys(limits).length && pairs.filter(Boolean).some(({item})=>!item.phone && !item.origin))return false;
        const counts={};for(const {item} of pairs.filter(Boolean))if(!item.phone && item.origin)counts[item.origin]=(counts[item.origin]||0)+1;
        return Object.entries(limits).every(([source,rule])=>(!rule.max || (counts[source]||0)<=rule.max) && (!complete || ((counts[source]||0)>=(rule.min||0) && rule.weights?.[counts[source]||0]!==0)));
    }
    function sourceCapacityIssue(materials,{ordinarySlotCount,sourceLimits={},basisSource=''}={}){
        if(!Number.isInteger(ordinarySlotCount) || ordinarySlotCount<1)return null;
        const limits=basisSource?{...sourceLimits,[basisSource]:{min:1,max:1}}:sourceLimits;
        const origins=new Map();
        for(const item of new Map(materials.filter(item=>!item.phone).map(item=>[item.id,item])).values())origins.set(item.origin,(origins.get(item.origin)||0)+1);
        const sources=[...origins].map(([origin,count])=>({origin,label:originLabels[origin] || origin || '其他来源',available:count,max:Math.min(count,limits[origin]?.max || Infinity)}));
        const capacity=sources.reduce((sum,source)=>sum+source.max,0);
        if(capacity>=ordinarySlotCount)return null;
        return {required:ordinarySlotCount,capacity,sources,
            message:`选中了 ${ordinarySlotCount} 个普通媒体层，但当前来源每套最多只能提供 ${capacity} 个素材（${sources.map(source=>`${source.label}最多 ${source.max} 个`).join('，') || '没有可用的普通素材'}；电话不计入）。请提高来源上限、增加来源或减少参与配对的媒体层。`};
    }
    function capacityShortage(count,issue){
        return {combinations:[],uses:{},keywordCounts:{},diagnostics:[],sourceDiagnostics:[],missing:Array.from({length:count},(_,index)=>index),requested:count,shortage:count,constraintIssue:issue};
    }
    function runSteps(iterator){
        let step;do{step=iterator.next();}while(!step.done);return step.value;
    }
    async function runStepsAsync(iterator,{yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),isCancelled=()=>false,onProgress=()=>{},sliceMs=12}={}){
        let started=Date.now();
        try{while(true){
            const cancelled=isCancelled();if(cancelled)throw new Error(typeof cancelled==='string'?cancelled:'配对预览已取消');
            const step=iterator.next();if(step.done)return step.value;
            if(step.value)onProgress(step.value);
            if(Date.now()-started>=sliceMs){await yieldControl();started=Date.now();}
        }}finally{iterator.return?.();}
    }
    function plan(materials,slots,options={}){return runSteps(planSteps(materials,slots,options));}
    function planAsync(materials,slots,options={},scheduling={}){return runStepsAsync(planSteps(materials,slots,options),scheduling);}
    // Bipartite matching rejects shortages shared by several slots before backtracking.
    function canMatchDistinct(candidates){
        const owners=new Map();
        function assign(index,seen){
            for(const item of candidates[index].items){
                if(seen.has(item.id))continue;seen.add(item.id);
                if(!owners.has(item.id) || assign(owners.get(item.id),seen)){owners.set(item.id,index);return true;}
            }
            return false;
        }
        return candidates.every((_,index)=>assign(index,new Set()));
    }
    function* planSteps(materials,slots,{count=1,maxUses=1,phoneMaxUses=0,characterMaxUses=null,totalMax=0,allowRepeated=false,random=Math.random,accept:acceptCandidate=()=>true,sourceLimits={},basisSource='',keywordLimits={},keywordBaseCounts={},includeBasisDetails=true,attempts=12,existingSignatures=[],phoneBalanceBase=[],phoneGroupHistory=phoneHistory(materials),ordinarySlotCount,includeDiagnostics=true,batchQuotas={},batchBase=[],batchExpectedCount=count,audienceCountForTarget=()=>0,audienceExistingForTarget=()=>[]}={}){
        const acceptance=new Map();
        const accept=(item,slot,index,key)=>{
            const cacheKey=`${index}\0${slot.key}\0${item.id}\0${key || ''}`;
            if(acceptance.has(cacheKey))return acceptance.get(cacheKey);
            const allowed=acceptCandidate(item,slot,index,key);
            if(acceptance.size>=25000)acceptance.clear();
            acceptance.set(cacheKey,allowed);return allowed;
        };
        validateKeywordLimits(keywordLimits);validateBatchQuotas(batchQuotas);
        if(basisSource && !originLabels[basisSource])throw new Error('请选择有效的配对依据来源');
        if(basisSource && (!Number.isSafeInteger(count)||count<1||count>500))throw new Error('组合数量请输入 1–500');
        if(!Number.isSafeInteger(count)||count<1||count>500)throw new Error('组合数量请输入 1–500');
        if(characterMaxUses!==null && (!Number.isSafeInteger(characterMaxUses)||characterMaxUses<0))throw new Error('爆贴素材本批上限请输入 0 或正整数');
        if(!Number.isSafeInteger(maxUses)||maxUses<1)throw new Error('本轮每组最多使用次数至少为 1');
        if(!Number.isSafeInteger(phoneMaxUses)||phoneMaxUses<0)throw new Error('电话本轮上限请输入 0 或正整数');
        if(!Number.isSafeInteger(totalMax)||totalMax<0)throw new Error('历史累计上限请输入 0 或正整数');
        if(!slots.length)throw new Error('请勾选要配对的媒体层');
        validateSourceLimits(sourceLimits);
        const capacityIssue=sourceCapacityIssue(materials,{ordinarySlotCount,sourceLimits,basisSource});
        if(capacityIssue)return capacityShortage(count,capacityIssue);
        if(basisSource)return yield* planBySourceSteps(materials,slots,{count,maxUses,phoneMaxUses,characterMaxUses,totalMax,allowRepeated,random,accept,sourceLimits,basisSource,keywordLimits,keywordBaseCounts,includeBasisDetails,existingSignatures,phoneBalanceBase,phoneGroupHistory,ordinarySlotCount,batchQuotas,batchBase,batchExpectedCount,audienceCountForTarget,audienceExistingForTarget});
        const unique=[...new Map(materials.filter(item=>item.keyword || item.keywords?.length).map(item=>[item.id,item])).values()],buckets=new Map();
        for(const item of unique)for(const key of new Set(item.keywords || [item.keyword])){if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(item);}
        const countWeights=new Map();
        const shuffle=items=>{items=[...items];for(let i=items.length-1;i>0;i--){const j=Math.min(i,Math.floor(random()*(i+1)));[items[i],items[j]]=[items[j],items[i]];}return items;};
        let best=[];
        for(let attempt=0;attempt<attempts && best.length<count;attempt++){
            const uses=new Map(),signatures=new Set(existingSignatures),result=[];
            for(let targetIndex=0;targetIndex<count;targetIndex++){
                yield {completed:targetIndex,total:count,attempt:attempt+1,matched:result.length};
                let found;
                // Try every eligible keyword; a duplicate draw must not masquerade as shortage.
                for(const keyword of shuffle(buckets.keys())){
                    if(keywordLimits[keyword] && (keywordBaseCounts[keyword]||0)+keywordCount(result,keyword)>=keywordLimits[keyword])continue;
                    const selected=[],usedHere=new Set();
                    const candidates=[];let scanned=0;
                    for(const [index,slot] of slots.entries()){
                        const items=[];
                        for(const item of buckets.get(keyword)){
                            if((uses.get(item.id)||0)<capFor(item,maxUses,phoneMaxUses,characterMaxUses) && (item.phone || !totalMax || (item.history||0)+(uses.get(item.id)||0)<totalMax) && accept(item,slot,targetIndex,keyword))items.push(item);
                            if(++scanned%128===0)yield;
                        }
                        candidates.push({slot,index,items:shuffle(items)});
                    }
                    candidates.sort((a,b)=>a.items.length-b.items.length);
                    if(candidates.some(entry=>!entry.items.length) || !canMatchDistinct(candidates))continue;
                    if(Object.keys(sourceLimits).length){
                        const possible=[...new Map(candidates.flatMap(entry=>entry.items).filter(item=>!item.phone).map(item=>[item.id,item])).values()];
                        const mediaSlots=candidates.filter(entry=>entry.items.some(item=>!item.phone)).length;
                        const capacity=[...new Set(possible.map(item=>item.origin))].reduce((sum,source)=>sum+Math.min(sourceLimits[source]?.max || Infinity,possible.filter(item=>item.origin===source).length),0);
                        if(capacity<mediaSlots || Object.values(sourceLimits).reduce((sum,rule)=>sum+(rule.min||0),0)>mediaSlots || Object.entries(sourceLimits).some(([source,rule])=>possible.filter(item=>item.origin===source).length<(rule.min||0)))continue;
                    }
                    // Draw source counts before files so a large library does not drown out
                    // a smaller source. Keep the original limits as a fallback for slot constraints.
                    let activeLimits=sourceLimits;
                    const ordinary=candidates.filter(entry=>entry.items.some(item=>!item.phone));
                    const origins=Object.keys(sourceLimits).length?shuffle(new Set(ordinary.flatMap(entry=>entry.items.filter(item=>!item.phone).map(item=>item.origin)).filter(Boolean))):[];
                    origins.sort((a,b)=>Number(Object.keys(sourceLimits[b]?.weights || {}).length>0)-Number(Object.keys(sourceLimits[a]?.weights || {}).length>0));
                    const bounds=origins.map(origin=>({origin,min:sourceLimits[origin]?.min || 0,
                        max:Math.min(sourceLimits[origin]?.max || ordinary.length,new Set(ordinary.flatMap(entry=>entry.items.filter(item=>!item.phone && item.origin===origin).map(item=>item.id))).size)}));
                    const preferred={...sourceLimits};let remaining=ordinary.length,quotaValid=Object.keys(sourceLimits).length>0;
                    for(let i=0;i<bounds.length && quotaValid;i++){
                        const entry=bounds[i],rest=bounds.slice(i+1);
                        const low=Math.max(entry.min,remaining-rest.reduce((sum,b)=>sum+b.max,0));
                        const high=Math.min(entry.max,remaining-rest.reduce((sum,b)=>sum+b.min,0));
                        if(low>high){quotaValid=false;break;}
                        const choices=Array.from({length:high-low+1},(_,index)=>low+index);
                        const weights=choices.map(count=>{
                            const configured=sourceLimits[entry.origin]?.weights?.[count];
                            if(configured!==undefined)return configured;
                            const key=entry.origin+':'+count;
                            if(!countWeights.has(key))countWeights.set(key,0.05+random());
                            return countWeights.get(key);
                        });
                        const total=weights.reduce((sum,weight)=>sum+weight,0);
                        if(!total){quotaValid=false;break;}
                        let draw=random()*total,count=choices[choices.length-1];
                        for(let j=0;j<choices.length;j++){draw-=weights[j];if(draw<0){count=choices[j];break;}}
                        preferred[entry.origin]={min:count,max:count};remaining-=count;
                    }
                    // A zero maximum normally means unlimited, so exact zero quotas are
                    // enforced separately during the preferred search.
                    let usePreferred=quotaValid && remaining===0;
                    const quotaPrefix=Object.keys(batchQuotas).length?quotaState([...batchBase,...result]):null;
                    const allowed=(pairs,complete=true)=>audienceGenderAllowed(pairs,audienceCountForTarget(targetIndex),audienceExistingForTarget(targetIndex)) && (!quotaPrefix || batchQuotasAllowed(quotaPrefix,{keyword,pairs},batchQuotas,batchExpectedCount,ordinarySlotCount ?? ordinary.length,slots.length-(ordinarySlotCount ?? ordinary.length))) && sourcesAllowed(pairs,sourceLimits,complete) && sourcesAllowed(pairs,activeLimits,complete) && (!usePreferred || pairs.filter(Boolean).every(({item})=>item.phone || preferred[item.origin]?.max!==0));
                    let searchSteps=0;
                    function* choose(index){
                        if(++searchSteps>10000)return false;
                        if(index===candidates.length){const signature=JSON.stringify(selected.map(pair=>pair.item.id).sort());return allowed(selected) && (allowRepeated || !signatures.has(signature));}
                        const candidate=candidates[index];
                        const ordered=orderPhones(candidate.items,[...phoneBalanceBase,...result,{keyword,pairs:selected.filter(Boolean)}],keyword,phoneGroupHistory,random);
                        for(const item of ordered){
                            if(++searchSteps>10000)return false;
                            if(searchSteps%128===0)yield;
                            if(usedHere.has(item.id))continue;
                            selected[candidate.index]={slot:candidate.slot,item};usedHere.add(item.id);
                            if(allowed(selected.slice().filter(Boolean),false) && (yield* choose(index+1)))return true;
                            usedHere.delete(item.id);selected[candidate.index]=undefined;
                        }
                        return false;
                    }
                    activeLimits=usePreferred?preferred:sourceLimits;
                    let matched=yield* choose(0);
                    if(!matched && usePreferred){usePreferred=false;activeLimits=sourceLimits;searchSteps=0;matched=yield* choose(0);}
                    if(!matched)continue;
                    const signature=JSON.stringify(selected.map(pair=>pair.item.id).sort());
                    signatures.add(signature);found={keyword,pairs:selected,signature,targetIndex};break;
                }
                if(!found)continue;
                result.push(found);for(const {item} of found.pairs)uses.set(item.id,(uses.get(item.id)||0)+1);
            }
            if(result.length>best.length)best=result;
        }
        const uses={},keywordCounts={};for(const combo of best){keywordCounts[combo.keyword]=(keywordCounts[combo.keyword]||0)+1;for(const {item} of combo.pairs)uses[item.id]=(uses[item.id]||0)+1;}
        const assigned=new Set(best.map(combo=>combo.targetIndex));
        const missing=Array.from({length:count},(_,index)=>index).filter(index=>!assigned.has(index));
        const diagnostics=[];let diagnosticSteps=0;
        if(includeDiagnostics && missing.length)for(const [keyword,items] of buckets){
            const slotReports=[];
            for(const slot of slots){
                const matching=[];
                for(const item of items){
                    let matched=false;
                    for(const index of missing){
                        if(accept(item,slot,index,keyword)){matched=true;break;}
                        if(++diagnosticSteps%128===0)yield;
                    }
                    if(matched)matching.push(item);
                    if(++diagnosticSteps%128===0)yield;
                }
                slotReports.push({key:slot.key,label:slot.label || slot.key,total:matching.length,available:matching.filter(item=>(uses[item.id]||0)<capFor(item,maxUses,phoneMaxUses,characterMaxUses) && (item.phone || !totalMax || (item.history||0)+(uses[item.id]||0)<totalMax)).length,
                    roundLimited:matching.filter(item=>(uses[item.id]||0)>=capFor(item,maxUses,phoneMaxUses,characterMaxUses)).length,historyLimited:matching.filter(item=>!item.phone && totalMax && (item.history||0)+(uses[item.id]||0)>=totalMax).length});
            }
            diagnostics.push({keyword,slots:slotReports});
        }
        return {combinations:best,uses,keywordCounts,diagnostics,missing,sourceDiagnostics:Object.entries(sourceLimits).map(([source,rule])=>({source,label:originLabels[source] || source,min:rule.min||0,max:rule.max||0,available:unique.filter(item=>!item.phone && item.origin===source && (uses[item.id]||0)<capFor(item,maxUses,phoneMaxUses,characterMaxUses) && (item.phone || !totalMax || (item.history||0)+(uses[item.id]||0)<totalMax)).length})),requested:count,shortage:count-best.length};
    }
    // One distinct basis material per existing task; the other sources complete its set.
    function* planBySourceSteps(materials,slots,options){
        const {basisSource,count=1,maxUses=1,phoneMaxUses=0,characterMaxUses=null,totalMax=0,random=Math.random,accept=()=>true}=options;
        const limits={...options.sourceLimits,[basisSource]:{min:1,max:1}};
        validateSourceLimits(limits);
        plan([],slots,{...options,basisSource:'',attempts:0});
        const unique=[...new Map(materials.map(item=>[item.id,item])).values()];
        const acceptance=new Map();
        const accepts=(item,slot,index,key)=>{
            const cacheKey=JSON.stringify([item.id,slot.key,index,key]);
            if(!acceptance.has(cacheKey)){if(acceptance.size>=25000)acceptance.clear();acceptance.set(cacheKey,accept(item,slot,index,key));}
            return acceptance.get(cacheKey);
        };
        const anchors=unique.filter(item=>!item.phone && item.origin===basisSource);
        const anchorKeys=[...new Set(anchors.flatMap(item=>item.keywords || [item.keyword]).filter(Boolean))];
        const keywordCapacity=anchorKeys.reduce((sum,key)=>sum+(options.keywordLimits?.[key] ? Math.max(0,options.keywordLimits[key]-(options.keywordBaseCounts?.[key]||0)) : anchors.length),0);
        const upperBound=Math.min(count,anchors.length,keywordCapacity);
        let best=[],bestUses={};
        const shuffle=list=>list.map(item=>({item,rank:random()})).sort((a,b)=>a.rank-b.rank).map(entry=>entry.item);
        for(let attempt=0;attempt<12;attempt++){
            const result=[],uses={},remaining=new Set(anchors.map(item=>item.id));
            const ordered=shuffle(anchors).sort((a,b)=>(a.keywords || [a.keyword]).length-(b.keywords || [b.keyword]).length);
            const keyUses={...(options.keywordBaseCounts || {})};
            for(let index=0;index<count && result.length<upperBound;index++){
                for(const anchor of ordered){
                    yield {completed:index,total:count,attempt:attempt+1,matched:result.length};
                    if(!remaining.has(anchor.id))continue;
                    const keys=anchor.keywords || [anchor.keyword];
                    if(keys.every(key=>options.keywordLimits?.[key] && (keyUses[key]||0)>=options.keywordLimits[key]))continue;
                    const eligible=unique.filter(item=>(item.keywords || [item.keyword]).some(key=>keys.includes(key)) && (item.origin!==basisSource || item.id===anchor.id) &&
                        (uses[item.id]||0)<capFor(item,maxUses,phoneMaxUses,characterMaxUses) && (item.phone || !totalMax || (item.history||0)+(uses[item.id]||0)<totalMax));
                    const one=yield* planSteps(eligible,slots,{...options,batchBase:[...(options.batchBase || []),...result],batchExpectedCount:options.batchExpectedCount ?? count,basisSource:'',sourceLimits:limits,count:1,attempts:1,includeDiagnostics:false,
                        keywordBaseCounts:Object.fromEntries([...new Set([...Object.keys(options.keywordBaseCounts || {}),...result.map(combo=>combo.keyword)])].map(key=>[key,(options.keywordBaseCounts?.[key]||0)+keywordCount(result,key)])),
                        phoneBalanceBase:[...(options.phoneBalanceBase || []),...result],
                        audienceCountForTarget:()=>options.audienceCountForTarget?.(index) ?? 0,
                        audienceExistingForTarget:()=>options.audienceExistingForTarget?.(index) || [],
                        accept:(item,slot,_index,key)=>keys.includes(key) && accepts(item,slot,index,key)});
                    if(!one.combinations.length)continue;
                    const combo={...one.combinations[0],targetIndex:index};
                    result.push(combo);remaining.delete(anchor.id);keyUses[combo.keyword]=(keyUses[combo.keyword]||0)+1;
                    for(const {item} of combo.pairs)uses[item.id]=(uses[item.id]||0)+1;
                    break;
                }
            }
            if(result.length>best.length){best=result;bestUses=uses;}
            if(best.length===upperBound)break;
        }
        const missing=Array.from({length:count},(_,index)=>index).filter(index=>!best.some(combo=>combo.targetIndex===index));
        const keywordCounts={};for(const combo of best)keywordCounts[combo.keyword]=(keywordCounts[combo.keyword]||0)+1;
        return {combinations:best,uses:bestUses,keywordCounts,missing,requested:count,shortage:count-best.length,diagnostics:[],sourceDiagnostics:[],
            basis:options.includeBasisDetails===false?null:basisDetails({combinations:best,uses:bestUses,missing},materials,slots,options)};
    }
    function basisDetails(planned,materials,slots,{basisSource,count=planned.requested,maxUses=1,phoneMaxUses=0,characterMaxUses=null,totalMax=0,accept=()=>true,keywordLimits={}}={}){
        if(!basisSource)return null;
        const unique=[...new Map(materials.map(item=>[item.id,item])).values()],anchors=unique.filter(item=>!item.phone && item.origin===basisSource);
        const best=planned.combinations,bestUses=planned.uses,missing=planned.missing || [];
        const unmatched=anchors.filter(item=>!bestUses[item.id]).map(anchor=>{
            const keys=anchor.keywords || [anchor.keyword],reasons=[];
            if(keys.length && keys.every(key=>keywordLimits[key] && keywordCount(best,key)>=keywordLimits[key]))return {id:anchor.id,name:anchor.name || anchor.id,keys,reasons:['关键词配对套数已达到上限']};
            if(totalMax && (anchor.history||0)>=totalMax)reasons.push('依据素材已达到历史使用上限');
            for(const slot of slots){
                const matching=unique.filter(item=>(item.origin!==basisSource || item.id===anchor.id) && (item.keywords || [item.keyword]).some(key=>keys.includes(key) && (missing.length?missing:best.map(c=>c.targetIndex)).some(index=>accept(item,slot,index,key))));
                if(!matching.length)reasons.push(`${slot.label || slot.key}没有相同关键词的可用素材`);
                else if(matching.every(item=>(bestUses[item.id]||0)>=capFor(item,item.origin===basisSource?1:maxUses,phoneMaxUses,item.origin===basisSource?null:characterMaxUses) || (!item.phone && totalMax && (item.history||0)+(bestUses[item.id]||0)>=totalMax)))reasons.push(`${slot.label || slot.key}的配套已达到使用上限`);
            }
            for(const key of keys){
                const others=unique.filter(item=>!item.phone && item.origin!==basisSource && (item.keywords || [item.keyword]).includes(key) &&
                    (bestUses[item.id]||0)<capFor(item,maxUses,phoneMaxUses,characterMaxUses) && (!totalMax || (item.history||0)+(bestUses[item.id]||0)<totalMax) && slots.some(slot=>(missing.length?missing:best.map(c=>c.targetIndex)).some(index=>accept(item,slot,index,key))));
                const mediaSlots=slots.filter(slot=>unique.some(item=>!item.phone && accept(item,slot,(missing[0] ?? best[0]?.targetIndex ?? 0),key))).length;
                if(others.length<Math.max(0,mediaSlots-1))reasons.push(`${key}缺少其他来源配套：剩余 ${others.length} 个，每套还需 ${mediaSlots-1} 个（${Object.keys(originLabels).filter(source=>source!==basisSource).map(source=>`${originLabels[source]} ${others.filter(item=>item.origin===source).length}`).join('、')}）`);
            }
            if(!reasons.length){
                for(const key of keys){
                    const counts=Object.keys(originLabels).map(source=>`${originLabels[source]}剩余 ${unique.filter(item=>!item.phone && item.origin===source && (item.keywords || [item.keyword]).includes(key) && (bestUses[item.id]||0)<capFor(item,source===basisSource?1:maxUses,phoneMaxUses,source===basisSource?null:characterMaxUses) && (!totalMax || (item.history||0)+(bestUses[item.id]||0)<totalMax)).length}`);
                    reasons.push(`${key}：${counts.join('、')}`);
                }
                reasons.push(best.length>=count?'现有任务数量不足，未建立新任务':'剩余来源数量或媒体层组合不满足；请查看下方来源表');
            }
            return {id:anchor.id,name:anchor.name || anchor.id,keys,reasons};
        });
        return {source:basisSource,total:anchors.length,used:anchors.length-unmatched.length,unmatched};
    }
    // Can this material participate in at least one complete set before this preview's selections?
    // Fix one eligible slot to the material, then reuse the actual planner and target-specific rules.
    function availability(materials,slots,options={},probeMaterials=materials){
        const {count=1,accept=()=>true,basisSource='',sourceLimits={}}=options;
        const limits=basisSource?{...sourceLimits,[basisSource]:{min:1,max:1}}:sourceLimits;
        return [...new Map(probeMaterials.map(item=>[item.id,item])).values()].map(item=>{
            if(!item.phone && options.totalMax && (item.history||0)>=options.totalMax)return {id:item.id,available:false,reason:'历史使用次数已达上限'};
            let eligible=false;
            for(let index=0;index<count;index++)for(const slot of slots){
                if(!(item.keywords || [item.keyword]).some(key=>accept(item,slot,index,key)))continue;
                eligible=true;
                const result=plan(materials,slots,{...options,basisSource:'',sourceLimits:limits,count:1,attempts:1,random:()=>0,
                    accept:(other,otherSlot,_index,key)=>(otherSlot.key!==slot.key || other.id===item.id) && accept(other,otherSlot,index,key)});
                if(result.combinations.length)return {id:item.id,available:true,reason:''};
            }
            return {id:item.id,available:false,reason:eligible?'缺少符合关键词、来源或次数限制的整套配套':'不符合所选媒体层或目标任务的关键词'};
        });
    }
    function replacePair(planned,materials,comboIndex,pairIndex,{maxUses=1,phoneMaxUses=0,characterMaxUses=null,totalMax=0,allowRepeated=false,accept=()=>true,random=Math.random,sourceLimits={},basisSource='',keywordLimits={},audienceCountForTarget=()=>0,audienceExistingForTarget=()=>[]}={}){
        if(basisSource)sourceLimits={...sourceLimits,[basisSource]:{min:1,max:1}};
        validateSourceLimits(sourceLimits);
        const combo=planned.combinations[comboIndex],current=combo?.pairs[pairIndex];
        if(!current)throw new Error('配对位置已改变，请重新预览');
        const others=new Set(combo.pairs.filter((_,index)=>index!==pairIndex).map(pair=>pair.item.id));
        const signatureFor=item=>JSON.stringify(combo.pairs.map((pair,index)=>index===pairIndex?item.id:pair.item.id).sort());
        const candidates=[...new Map(materials.map(item=>[item.id,item])).values()].filter(item=>
            item.id!==current.item.id && (item.keywords || [item.keyword]).includes(combo.keyword) && !others.has(item.id)
            && (planned.uses[item.id]||0)<capFor(item,item.origin===basisSource?1:maxUses,phoneMaxUses,item.origin===basisSource?null:characterMaxUses) && (item.phone || !totalMax || (item.history||0)+(planned.uses[item.id]||0)+1<=totalMax)
            && sourcesAllowed(combo.pairs.map((pair,index)=>index===pairIndex?{...pair,item}:pair),sourceLimits)
            && audienceGenderAllowed(combo.pairs.map((pair,index)=>index===pairIndex?{...pair,item}:pair),audienceCountForTarget(combo.targetIndex ?? comboIndex),audienceExistingForTarget(combo.targetIndex ?? comboIndex))
            && accept(item,current.slot,combo.targetIndex ?? comboIndex,combo.keyword)
            && (allowRepeated || !planned.combinations.some((other,index)=>index!==comboIndex && other.signature===signatureFor(item))));
        if(!candidates.length)throw new Error('没有其他符合当前关键词、次数、来源数量和组合限制的素材组，请增加素材或调整限制');
        const base=planned.combinations.map((entry,index)=>index===comboIndex?{...entry,pairs:entry.pairs.filter((_,index)=>index!==pairIndex)}:entry);
        const item=current.item.phone?orderPhones(candidates,base,combo.keyword,phoneHistory(materials),random)[0]
            :candidates[Math.min(candidates.length-1,Math.floor(random()*candidates.length))];
        const pairs=combo.pairs.map((pair,index)=>index===pairIndex?{slot:pair.slot,item}:pair);
        const combinations=planned.combinations.map((entry,index)=>index===comboIndex?{...combo,pairs,signature:signatureFor(item)}:entry);
        const uses={...planned.uses};
        if(--uses[current.item.id]<=0)delete uses[current.item.id];
        uses[item.id]=(uses[item.id]||0)+1;
        return {...planned,combinations,uses};
    }
    async function replaceCombinationAsync(planned,materials,comboIndex,options={},scheduling={},keyword=''){
        const combo=planned.combinations[comboIndex];
        if(!combo)throw new Error('配对位置已改变，请重新预览');
        const base=planned.combinations.filter((_,index)=>index!==comboIndex),uses={},keywordCounts={};
        for(const entry of base){keywordCounts[entry.keyword]=(keywordCounts[entry.keyword]||0)+1;for(const {item} of entry.pairs)uses[item.id]=(uses[item.id]||0)+1;}
        const oldIds=new Set(combo.pairs.map(pair=>pair.item.id)),byId=new Map(materials.map(item=>[item.id,item]));
        const remaining=materials.filter(item=>!oldIds.has(item.id)).map(item=>{
            const used=uses[item.id] || 0,limit=options.basisSource && item.origin===options.basisSource?1:capFor(item,options.maxUses ?? 1,options.phoneMaxUses ?? 0,options.characterMaxUses ?? null);
            return {...item,_remainingRoundCapacity:Math.max(0,limit-used),history:(item.history||0)+(item.phone?0:used)};
        }).filter(item=>item._remainingRoundCapacity>0);
        const accept=options.accept || (()=>true),targetIndex=combo.targetIndex ?? comboIndex;
        const replacement=await planAsync(remaining,combo.pairs.map(pair=>pair.slot),{...options,audienceCountForTarget:()=>options.audienceCountForTarget?.(targetIndex) ?? 0,audienceExistingForTarget:()=>options.audienceExistingForTarget?.(targetIndex) || [],count:1,batchBase:[...(options.batchBase || []),...base],batchExpectedCount:options.batchExpectedCount ?? options.count ?? planned.requested,
            existingSignatures:base.map(entry=>entry.signature),
            keywordBaseCounts:Object.fromEntries([...new Set([...Object.keys(options.keywordBaseCounts || {}),...Object.keys(keywordCounts)])].map(key=>[key,(options.keywordBaseCounts?.[key]||0)+(keywordCounts[key]||0)])),
            phoneBalanceBase:[...(options.phoneBalanceBase || []),...base],phoneGroupHistory:phoneHistory(materials),
            accept:(item,slot,_index,key)=>key!==combo.keyword && (!keyword || key===keyword) && accept(byId.get(item.id),slot,targetIndex,key)
        },scheduling);
        if(!replacement.combinations.length)throw new Error('没有符合另一关键词、次数和来源限制的全新组合，原组合已保留');
        const next={...combo,...replacement.combinations[0],targetIndex,pairs:replacement.combinations[0].pairs.map(pair=>({...pair,item:byId.get(pair.item.id)}))};
        const combinations=planned.combinations.map((entry,index)=>index===comboIndex?next:entry);
        keywordCounts[next.keyword]=(keywordCounts[next.keyword]||0)+1;
        for(const {item} of next.pairs)uses[item.id]=(uses[item.id]||0)+1;
        const result={...planned,combinations,uses,keywordCounts};
        checkLimits(result,options);return result;
    }
    function pairChoices(planned,materials,comboIndex,pairIndex,{maxUses=1,phoneMaxUses=0,characterMaxUses=null,totalMax=0,allowRepeated=false,accept=()=>true,sourceLimits={},basisSource='',keywordLimits={},audienceCountForTarget=()=>0,audienceExistingForTarget=()=>[]}={}){
        const combo=planned.combinations[comboIndex],current=combo?.pairs[pairIndex];
        if(!current)throw new Error('配对位置已改变，请重新预览');
        if(basisSource)sourceLimits={...sourceLimits,[basisSource]:{min:1,max:1}};
        validateSourceLimits(sourceLimits);
        const others=combo.pairs.filter((_,index)=>index!==pairIndex),ids=new Set(others.map(pair=>pair.item.id));
        return [...new Map(materials.map(item=>[item.id,item])).values()].flatMap(item=>{
            if(item.id===current.item.id || ids.has(item.id))return [];
            const keys=(item.keywords || [item.keyword]).filter(key=>key && others.every(pair=>(pair.item.keywords || [pair.item.keyword]).includes(key)) && accept(item,current.slot,combo.targetIndex ?? comboIndex,key));
            if(!keys.length)return [];
            const keyword=keys.includes(combo.keyword)?combo.keyword:keys[0],roundUses=planned.uses[item.id] || 0;
            const pairs=combo.pairs.map((pair,index)=>index===pairIndex?{...pair,item}:pair),signature=JSON.stringify(pairs.map(pair=>pair.item.id).sort());
            let reason='';
            if(keywordLimits[keyword] && keywordCount(planned.combinations.filter((_,index)=>index!==comboIndex),keyword)+1>keywordLimits[keyword])reason='已达到该关键词的配对套数上限';
            else if(!sourcesAllowed(pairs,sourceLimits))reason='不符合每套来源数量限制';
            else if(!audienceGenderAllowed(pairs,audienceCountForTarget(combo.targetIndex ?? comboIndex),audienceExistingForTarget(combo.targetIndex ?? comboIndex)))reason='两个观众的素材性别不一致';
            else if(roundUses>=capFor(item,item.origin===basisSource?1:maxUses,phoneMaxUses,item.origin===basisSource?null:characterMaxUses))reason=item.origin===basisSource?'依据来源本轮每个只用一次':'已达到本轮使用次数上限';
            else if(!item.phone && totalMax && (item.history||0)+roundUses+1>totalMax)reason='已达到历史累计次数上限';
            else if(!allowRepeated && planned.combinations.some((other,index)=>index!==comboIndex && other.signature===signature))reason='与本轮其他整套组合重复';
            return [{item,keyword,roundUses,history:item.history || 0,allowed:!reason,reason}];
        });
    }
    function selectPair(planned,materials,comboIndex,pairIndex,itemId,options={}){
        const choice=pairChoices(planned,materials,comboIndex,pairIndex,options).find(choice=>choice.item.id===itemId);
        if(!choice)throw new Error('此素材与同套其他素材不配套，原组合已保留');
        if(!choice.allowed)throw new Error(choice.reason+'，原组合已保留');
        const combo=planned.combinations[comboIndex],current=combo.pairs[pairIndex];
        const pairs=combo.pairs.map((pair,index)=>index===pairIndex?{slot:pair.slot,item:choice.item}:pair);
        const combinations=planned.combinations.map((other,index)=>index===comboIndex?{...combo,keyword:choice.keyword,pairs,signature:JSON.stringify(pairs.map(pair=>pair.item.id).sort())}:other);
        const uses={...planned.uses};if(--uses[current.item.id]<=0)delete uses[current.item.id];uses[itemId]=(uses[itemId]||0)+1;
        const keywordCounts={};for(const entry of combinations)keywordCounts[entry.keyword]=(keywordCounts[entry.keyword]||0)+1;
        return {...planned,combinations,uses,keywordCounts};
    }
    function fillMissing(planned,materials,slots,options={}){return runSteps(fillMissingSteps(planned,materials,slots,options));}
    function fillMissingAsync(planned,materials,slots,options={},scheduling={}){return runStepsAsync(fillMissingSteps(planned,materials,slots,options),scheduling);}
    function* fillMissingSteps(planned,materials,slots,options={}){
        checkLimits(planned,{...options,phoneSlotCount:options.ordinarySlotCount===undefined?undefined:slots.length-options.ordinarySlotCount});
        const count=options.count ?? planned.requested,assigned=new Set(planned.combinations.map((combo,index)=>combo.targetIndex ?? index));
        const accept=options.accept || (()=>true),byId=new Map(materials.map(item=>[item.id,item]));
        const remaining=materials.map(item=>{
            const used=planned.uses[item.id] || 0,limit=options.basisSource && item.origin===options.basisSource?1:capFor(item,options.maxUses ?? 1,options.phoneMaxUses ?? 0,options.characterMaxUses ?? null);
            return {...item,_remainingRoundCapacity:Math.max(0,limit-used),history:(item.history||0)+(item.phone?0:used)};
        }).filter(item=>item._remainingRoundCapacity>0);
        const additional=yield* planSteps(remaining,slots,{...options,count,batchBase:[...(options.batchBase || []),...planned.combinations],batchExpectedCount:options.batchExpectedCount ?? count,existingSignatures:planned.combinations.map(combo=>combo.signature),
            keywordBaseCounts:Object.fromEntries([...new Set([...Object.keys(options.keywordBaseCounts || {}),...planned.combinations.map(combo=>combo.keyword)])].map(key=>[key,(options.keywordBaseCounts?.[key]||0)+keywordCount(planned.combinations,key)])),
            phoneBalanceBase:[...(options.phoneBalanceBase || []),...planned.combinations],phoneGroupHistory:phoneHistory(materials),
            accept:(item,slot,index,key)=>!assigned.has(index) && accept(byId.get(item.id),slot,index,key)});
        const combinations=[...planned.combinations,...additional.combinations.map(combo=>({...combo,pairs:combo.pairs.map(pair=>({...pair,item:byId.get(pair.item.id)}))}))].sort((a,b)=>(a.targetIndex ?? 0)-(b.targetIndex ?? 0));
        const uses={},keywordCounts={};for(const combo of combinations){keywordCounts[combo.keyword]=(keywordCounts[combo.keyword]||0)+1;for(const {item} of combo.pairs)uses[item.id]=(uses[item.id]||0)+1;}
        const missing=Array.from({length:count},(_,index)=>index).filter(index=>!combinations.some(combo=>combo.targetIndex===index));
        const result={...planned,combinations,uses,keywordCounts,missing,requested:count,shortage:missing.length,diagnostics:additional.diagnostics || []};
        checkLimits(result,{...options,phoneSlotCount:options.ordinarySlotCount===undefined?undefined:slots.length-options.ordinarySlotCount});return result;
    }
    async function rebalanceBatchAsync(planned,materials,slots,options={},scheduling={}){
        validateBatchQuotas(options.batchQuotas);
        const count=options.count ?? planned.requested,ordinary=options.ordinarySlotCount ?? slots.filter(slot=>materials.some(item=>!item.phone && (options.accept || (()=>true))(item,slot,0,item.keyword))).length;
        const kept=[];
        for(const combo of planned.combinations)if(batchQuotasAllowed(quotaState(kept),combo,options.batchQuotas || {},count,ordinary,slots.length-ordinary))kept.push(combo);
        const uses={};for(const combo of kept)for(const {item} of combo.pairs)uses[item.id]=(uses[item.id]||0)+1;
        const partial={...planned,combinations:kept,uses,requested:count,shortage:count-kept.length};
        let result=await fillMissingAsync(partial,materials,slots,{...options,ordinarySlotCount:ordinary},scheduling);
        if(result.shortage){const fresh=await planAsync(materials,slots,{...options,ordinarySlotCount:ordinary},scheduling);if(fresh.combinations.length>result.combinations.length)result=fresh;}
        return result;
    }
    // Drafts contain media choices only; restore against today's slots, candidates and rules.
    function restore(draft,materials,slots,{count,accept=()=>true,audienceCountForTarget=()=>0,audienceExistingForTarget=()=>[]}={}){
        const byId=new Map(materials.map(item=>[item.id,item])),bySlot=new Map(slots.map(slot=>[slot.key,slot]));
        const combinations=[],issues=[],assigned=new Set();
        for(const [index,saved] of (draft?.combinations || []).entries()){
            const targetIndex=saved.targetIndex ?? index;
            const pairs=(saved.pairs || []).map(pair=>({slot:bySlot.get(pair.slot?.key),item:byId.get(pair.item?.id)}));
            if(targetIndex<0 || targetIndex>=count || assigned.has(targetIndex) || pairs.length!==slots.length || new Set(pairs.map(pair=>pair.slot?.key)).size!==slots.length || new Set(pairs.map(pair=>pair.item?.id)).size!==pairs.length || pairs.some(({slot,item})=>!slot || !item || !(item.keywords || [item.keyword]).includes(saved.keyword) || !accept(item,slot,targetIndex,saved.keyword)) || !audienceGenderAllowed(pairs,audienceCountForTarget(targetIndex),audienceExistingForTarget(targetIndex))){
                issues.push(`任务 ${targetIndex+1} 的草稿素材已缺失或不符合当前规则，其余组合已保留`);continue;
            }
            assigned.add(targetIndex);combinations.push({...saved,targetIndex,pairs,signature:JSON.stringify(pairs.map(pair=>pair.item.id).sort())});
        }
        const uses={},keywordCounts={};for(const combo of combinations){keywordCounts[combo.keyword]=(keywordCounts[combo.keyword]||0)+1;for(const {item} of combo.pairs)uses[item.id]=(uses[item.id]||0)+1;}
        return {combinations,uses,keywordCounts,requested:count,shortage:count-combinations.length,missing:Array.from({length:count},(_,i)=>i).filter(i=>!assigned.has(i)),diagnostics:[],issues};
    }
    function checkLimits(planned,{maxUses=1,phoneMaxUses=0,characterMaxUses=null,totalMax=0,allowRepeated=false,sourceLimits={},basisSource='',keywordLimits={},batchQuotas={},count,ordinarySlotCount,phoneSlotCount,audienceCountForTarget=()=>0,audienceExistingForTarget=()=>[]}={}){
        if(basisSource)sourceLimits={...sourceLimits,[basisSource]:{min:1,max:1}};
        if(characterMaxUses!==null && (!Number.isSafeInteger(characterMaxUses)||characterMaxUses<0))throw new Error('爆贴素材本批上限请输入 0 或正整数');
        if(!Number.isSafeInteger(maxUses)||maxUses<1)throw new Error('素材组本轮上限至少为 1');
        if(!Number.isSafeInteger(phoneMaxUses)||phoneMaxUses<0 || !Number.isSafeInteger(totalMax)||totalMax<0)throw new Error('电话和历史上限请输入 0 或正整数');
        validateBatchQuotas(batchQuotas);
        if(!batchQuotasAllowed(quotaState(planned.combinations),null,batchQuotas,count ?? planned.requested ?? planned.combinations.length,ordinarySlotCount ?? planned.combinations[0]?.pairs.filter(pair=>!pair.item.phone).length ?? 0,phoneSlotCount ?? planned.combinations[0]?.pairs.filter(pair=>pair.item.phone).length ?? 1))throw new Error('当前组合不符合指定的本批来源、历史、文件夹、关键词或电话组数量，请点击“按数量调整并补齐”');
        validateSourceLimits(sourceLimits);
        validateKeywordLimits(keywordLimits);
        for(const [key,limit] of Object.entries(keywordLimits))if(limit && keywordCount(planned.combinations,key)>limit)throw new Error(`${key}已配 ${keywordCount(planned.combinations,key)} 套，超过上限 ${limit} 套；请点击“全部重新随机”按上限生成，或提高上限`);
        const seen=new Set();
        for(const combo of planned.combinations){
            if(!audienceGenderAllowed(combo.pairs,audienceCountForTarget(combo.targetIndex ?? planned.combinations.indexOf(combo)),audienceExistingForTarget(combo.targetIndex ?? planned.combinations.indexOf(combo))))throw new Error(`任务 ${(combo.targetIndex ?? planned.combinations.indexOf(combo))+1} 的两个观众素材性别不一致，请更换素材`);
            if(!sourcesAllowed(combo.pairs,sourceLimits))throw new Error(`任务 ${(combo.targetIndex ?? planned.combinations.indexOf(combo))+1} 不符合每套来源数量限制；已调整的组合仍保留，请修改来源限制或更换对应媒体`);
            if(!allowRepeated && seen.has(combo.signature))throw new Error('当前草稿包含重复组合，请允许重复或更换对应素材；已调好的组合仍保留');
            seen.add(combo.signature);
            for(const {item} of combo.pairs){const uses=planned.uses[item.id] || 0;
                if(uses>capFor(item,item.origin===basisSource?1:maxUses,phoneMaxUses,item.origin===basisSource?null:characterMaxUses))throw new Error(`${item.name || item.id} 本轮已选 ${uses} 次，超过当前上限；请提高上限或更换该素材`);
                if(!item.phone && totalMax && (item.history||0)+uses>totalMax)throw new Error(`${item.name || item.id} 历史加本轮超过上限；请调整历史上限或更换该素材`);
            }
        }
        return true;
    }
    return {isAudienceSlot,audienceGenderAllowed,phoneQuotaKey,archivedMaterial,materialFolder,batchUsage,validateBatchQuotas,rebalanceBatchAsync,sourceCapacityIssue,plan,planAsync,fillMissingAsync,replacePair,replaceCombinationAsync,restore,checkLimits,sourcesAllowed,validateSourceLimits,basisDetails,availability,fillMissing,pairChoices,selectPair,phoneGroup,phoneHistory,orderPhones,distributionReport};
});
