'use strict';
// Small streaming JSON validator. Only metadata tokens are retained; large
// project strings are checked byte by byte without building a JS string.
class JsonReader {
    constructor(onValue,onBoundary){this.stack=[];this.mode='value';this.offset=0;this.onValue=onValue;this.onBoundary=onBoundary;this.rootDone=false;}
    valuePath(){const p=this.stack.at(-1);return p?p.path.concat(p.type==='array'?p.index:p.key):[];}
    wanted(path){const p=path[0]==='templates'?path.slice(2):path;return !['projectData','templates'].includes(p[0]);}
    begin(type,pos){if(this.stack.length>1000)throw Error('JSON 嵌套过深');const path=this.valuePath();this.onBoundary('begin',path,pos,type);this.onValue(path,type);this.stack.push({type,path,state:type==='object'?'keyOrEnd':'valueOrEnd',index:0});this.mode='container';}
    complete(path,end){this.onBoundary('end',path,end);const p=this.stack.at(-1);if(p){p.state='commaOrEnd';if(p.type==='array')p.index++;this.mode='container';}else{this.rootDone=true;this.mode='done';}}
    primitive(value,end){const path=this.valuePath();this.onValue(path,'primitive',value);this.complete(path,end);}
    write(buffer){for(let i=0;i<buffer.length;i++,this.offset++){
        const b=buffer[i],c=String.fromCharCode(b),pos=this.offset;
        if(this.mode==='string'){
            if(this.unicode){if(!/[0-9a-f]/i.test(c))throw Error('无效 Unicode 转义');this.unicode--;}
            else if(this.escape){if(!'"\\/bfnrtu'.includes(c))throw Error('无效 JSON 转义');this.escape=false;if(c==='u')this.unicode=4;}
            else if(c==='\\')this.escape=true;
            else if(c==='"'){
                if(this.capture){this.token+='"';const value=JSON.parse(Buffer.from(this.token,'latin1').toString('utf8'));if(this.isKey){this.stack.at(-1).key=value;this.stack.at(-1).state='colon';this.mode='container';}else this.primitive(value,pos+1);}
                else this.primitive(undefined,pos+1);
                continue;
            }else if(b<32)throw Error('JSON 字符串含控制字符');
            if(this.capture){this.token+=c;if(this.token.length>8*1024*1024)throw Error('工程元数据过大');}continue;
        }
        if(this.mode==='atom'){
            if(!/[\s,}\]]/.test(c)){this.token+=c;if(this.token.length>128)throw Error('JSON 数值无效');continue;}
            if(!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.token))throw Error('JSON 值无效');
            this.primitive(JSON.parse(this.token),pos);i--;this.offset--;continue;
        }
        if(/\s/.test(c))continue;
        if(this.mode==='done')throw Error('JSON 尾部有多余内容');
        const p=this.stack.at(-1);
        if(this.mode==='container'){
            if(p.state==='colon'){if(c!==':')throw Error('JSON 缺少冒号');p.state='value';continue;}
            if(p.state==='commaOrEnd'){
                if(c===','){p.state=p.type==='object'?'key':'value';continue;}
                if(c!==(p.type==='object'?'}':']'))throw Error('JSON 缺少逗号或结束符');
            }
            if(c===(p.type==='object'?'}':']') && ['keyOrEnd','valueOrEnd','commaOrEnd'].includes(p.state)){
                this.stack.pop();this.complete(p.path,pos+1);continue;
            }
            if(p.type==='object' && ['key','keyOrEnd'].includes(p.state)){
                if(c!=='"')throw Error('JSON 字段名称无效');this.mode='string';this.token='"';this.capture=true;this.isKey=true;this.escape=false;continue;
            }
            if(!['value','valueOrEnd'].includes(p.state))throw Error('JSON 结构无效');
        }
        if(c==='{')this.begin('object',pos);
        else if(c==='[')this.begin('array',pos);
        else if(c==='"'){this.mode='string';this.isKey=false;this.escape=false;this.token='"';const path=this.valuePath();this.capture=this.wanted(path) && !['projectData','templates'].includes(path.at(-1));}
        else if(/[tfn0-9-]/.test(c)){this.mode='atom';this.token=c;}
        else throw Error('JSON 值无效');
    }}
    end(){this.write(Buffer.from(' '));if(!this.rootDone || this.stack.length)throw Error('JSON 文件不完整');}
}
module.exports=JsonReader;
