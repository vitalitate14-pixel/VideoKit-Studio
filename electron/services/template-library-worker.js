// Index parsing and full-project search must never block Electron's main thread.
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (!isMainThread) {
    const templates = require('./templates');
    parentPort.on('message', ({id, action, data}) => {
        try {
            let result;
            if (action === 'list') result = templates.listTemplates(data);
            else if (action === 'search') result = templates.getTemplateSearch(data.ids);
            else if (action === 'thumbnail') result = templates.getTemplateThumbnail(data.id);
            else throw new Error('未知模板库查询');
            parentPort.postMessage({id, result});
        } catch (error) {
            parentPort.postMessage({id, error: error.message});
        }
    });
} else {
    let worker, directory, sequence = 0;
    const pending = new Map();
    exports.query = (templatesDirectory, action, data = {}) => {
        if (!worker) {
            directory = templatesDirectory;
            const current = worker = new Worker(__filename, {workerData: {templatesDirectory}});
            const fail = error => {
                if (worker !== current) return;
                worker = null;
                for (const request of pending.values()) request.reject(error);
                pending.clear();
            };
            current.on('message', ({id, result, error}) => {
                const request = pending.get(id);
                if (!request) return;
                pending.delete(id);
                if (error) request.reject(new Error(error));
                else request.resolve(result);
                if (!pending.size) current.unref();
            });
            current.on('error', fail);
            current.on('exit', code => fail(new Error(`模板库后台线程已退出 (${code})`)));
            current.unref();
        }
        if (directory !== templatesDirectory) return Promise.reject(new Error('模板库目录已改变，请重启应用'));
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, {resolve, reject});
            worker.ref();
            worker.postMessage({id, action, data});
        });
    };
}
