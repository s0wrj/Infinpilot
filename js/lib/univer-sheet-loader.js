// x-spreadsheet 模块加载器 (本地文件)
window.xspreadsheet = null;

function loadXSpreadsheet() {
    return new Promise((resolve, reject) => {
        if (window.x_spreadsheet) {
            window.xspreadsheet = window.x_spreadsheet;
            resolve(window.xspreadsheet);
            return;
        }

        const script = document.createElement('script');
        script.src = '../js/lib/xspreadsheet.js';
        script.onload = () => {
            console.log('[x-spreadsheet] loaded successfully');
            window.xspreadsheet = window.x_spreadsheet;
            resolve(window.xspreadsheet);
        };
        script.onerror = (err) => {
            console.error('[x-spreadsheet] failed to load:', err);
            reject(err);
        };
        document.head.appendChild(script);
    });
}

window.loadXSpreadsheet = loadXSpreadsheet;
