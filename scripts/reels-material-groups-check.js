'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createService}=require('../electron/services/batch-used-media');

(async()=>{
    const sandbox={window:{}};
    vm.runInNewContext(await fs.readFile(path.join(__dirname,'../src/reels-overview-media-pool.js'),'utf8'),sandbox);
    const pool=sandbox.window.ReelsOverviewMediaPool;
    const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'videokit-groups-')));
    try{
        const parent=path.join(base,'总库'),root=path.join(parent,'爆贴合拍'),suite=path.join(root,'领会-素材组');
        await fs.mkdir(suite,{recursive:true});
        const files=[path.join(suite,'1.png'),path.join(suite,'2.mp4')];
        for(const file of files)await fs.writeFile(file,'fixture');
        const context={saved:{}};
        pool.importDirectory(context,'unclassified',root,files,'suites');
        assert.deepEqual(Array.from(context.saved.unclassified),[suite]);
        const value=pool.replacementValue(context,suite,{key:'pip:test',field:'pip'},'unclassified');
        assert.equal(value.media_folder_path,suite);
        assert.deepEqual(Array.from(value.media_folder_files),files);
        assert.equal(pool.libraryImportPaths(parent,files,[parent,root]).length,0);
        assert.equal(pool.libraryImportPaths(root,files,[parent,root]).length,2);

        const api=createService();
        const units=pool.archiveUnits([{path:suite,folder:true,files}],{roots:[parent,root]});
        assert.equal(units[0].path,suite);assert.equal(units[0].root,root);
        const moved=await api.handle({action:'move',units});
        assert.equal(moved.mappings.length,1);
        let listing=await api.handle({action:'list',roots:[{root,origin:'characters'}]});
        assert.equal(listing.warnings.length,0);assert.equal(listing.batches[0].items.length,1);
        assert.equal(listing.batches[0].items[0].folder,true);
        assert.equal(listing.batches[0].items[0].files.length,2);
        await api.handle({action:'rollback',...moved});
        for(const file of files)await fs.access(file);

        // The old writer archived the clips separately; reading must reconstruct
        // one group while leaving the manifest intact so rollback still works.
        const legacy=await api.handle({action:'move',units:files.map(file=>({root,path:file}))});
        const loose=path.join(root,'独立图片.png');await fs.writeFile(loose,'loose');
        const standalone=await api.handle({action:'move',units:[{root,path:loose}]});
        listing=await api.handle({action:'list',roots:[{root,origin:'characters'}]});
        const old=listing.batches.find(batch=>batch.transactionId===legacy.id);
        assert.equal(old.items.length,1);assert.equal(old.items[0].folder,true);
        assert.deepEqual(old.items[0].originalFiles.sort(),files.slice().sort());
        assert.equal(listing.batches.find(batch=>batch.transactionId===standalone.id).items[0].folder,false);
        // Parent folders renamed on disk must retain the same grouping.
        const renamed=path.join(base,'重命名总库');await fs.rename(parent,renamed);
        const newRoot=path.join(renamed,'爆贴合拍');
        listing=await api.handle({action:'list',roots:[{root:newRoot,origin:'characters'}]});
        assert.equal(listing.warnings.length,0);
        assert.equal(listing.batches.find(batch=>batch.transactionId===legacy.id).items[0].files.length,2);
        await fs.rename(renamed,parent);
        await api.handle({action:'rollback',...legacy});
        for(const file of files)await fs.access(file);
        await api.handle({action:'rollback',...standalone});await fs.access(loose);
        console.log('PASS: suite import/binding, overlapping libraries, whole-group archive, legacy file manifests, renamed roots, loose files and rollback');
    }finally{await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
