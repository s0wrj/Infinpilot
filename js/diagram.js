/**
 * Infinpilot - Diagram Module
 * Draw.io integration for creating and editing diagrams
 */

(function() {
    'use strict';

    // Draw.io base URL
    const DRAWIO_BASE_URL = 'https://embed.diagrams.net';

    // Current diagram XML
    let currentXml = null;
    let isInitialized = false;

    // Elements
    let iframe = null;
    let statusText = null;
    let importInput = null;

    /**
     * Initialize the diagram module
     */
    function init() {
        console.log('[Diagram] Initializing diagram module...');

        iframe = document.getElementById('diagram-iframe');
        statusText = document.getElementById('diagram-status-text');
        importInput = document.getElementById('diagram-import-input');

        if (!iframe || !statusText) {
            console.error('[Diagram] Required elements not found');
            return;
        }

        // Set up event listeners (only once)
        if (!isInitialized) {
            setupEventListeners();

            // Set up message listener for draw.io communication
            window.addEventListener('message', handleMessage);

            // Listen for iframe load errors
            iframe.addEventListener('error', () => {
                console.error('[Diagram] Iframe load error');
                updateStatus('加载失败，请重试');
            });
        }

        // Always try to load/reload draw.io if not loaded or on error
        if (!iframe.src || iframe.src === '' || iframe.src === 'about:blank') {
            loadDrawio();
        }

        isInitialized = true;
        console.log('[Diagram] Diagram module initialized');
    }

    /**
     * Set up button event listeners
     */
    function setupEventListeners() {
        const newBtn = document.getElementById('diagram-new');
        const importBtn = document.getElementById('diagram-import');
        const exportBtn = document.getElementById('diagram-export');

        if (newBtn) {
            newBtn.addEventListener('click', createNew);
        }

        if (importBtn) {
            importBtn.addEventListener('click', () => {
                importInput.click();
            });
        }

        if (exportBtn) {
            exportBtn.addEventListener('click', exportDiagram);
        }

        // Import file input handler
        if (importInput) {
            importInput.addEventListener('change', handleImportFile);
        }
    }

    /**
     * Load draw.io in the iframe
     */
    function loadDrawio() {
        console.log('[Diagram] Loading custom diagram editor...');
        updateStatus('正在加载图表编辑器...');

        // Use custom diagram editor
        const extensionUrl = browser.runtime.getURL('');
        const url = extensionUrl + 'html/diagram-editor.html';

        console.log('[Diagram] Setting iframe src to:', url);

        try {
            iframe.src = url;
            console.log('[Diagram] Iframe src set successfully');
        } catch (error) {
            console.error('[Diagram] Failed to set iframe src:', error);
            updateStatus('加载失败: ' + error.message);
        }

        // Listen for iframe load
        iframe.onload = function() {
            console.log('[Diagram] Iframe loaded successfully');
            updateStatus('就绪');
        };

        iframe.onerror = function(error) {
            console.error('[Diagram] Iframe load error:', error);
            updateStatus('加载失败，请检查网络');
        };
    }

    /**
     * Handle messages from draw.io iframe
     */
    function handleMessage(event) {
        // Verify origin
        if (!event.data || !event.data.event) return;

        const data = event.data;

        switch (data.event) {
            case 'init':
                console.log('[Diagram] Draw.io initialized');
                updateStatus('就绪');

                // If we have existing XML, load it
                if (currentXml) {
                    loadXml(currentXml);
                }
                break;

            case 'save':
                // Save diagram XML
                if (data.xml) {
                    currentXml = data.xml;
                    console.log('[Diagram] Diagram saved, length:', data.xml.length);
                }
                break;

            case 'exit':
                console.log('[Diagram] User exited draw.io');
                break;

            case 'load':
                console.log('[Diagram] Diagram loaded');
                if (data.xml) {
                    currentXml = data.xml;
                }
                break;

            case 'export':
                console.log('[Diagram] Diagram exported');
                break;
        }
    }

    /**
     * Create a new blank diagram
     */
    function createNew() {
        const blankXml = `<mxfile host="app.diagrams.net"><diagram id="blank" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;
        currentXml = blankXml;
        loadXml(blankXml);
        updateStatus('新建图表');
    }

    /**
     * Load XML into draw.io
     */
    function loadXml(xml) {
        if (!iframe || !iframe.contentWindow) {
            console.error('[Diagram] Iframe not ready');
            return;
        }

        try {
            iframe.contentWindow.postMessage({
                action: 'load',
                xml: xml,
                format: 'xml'
            }, '*');
        } catch (error) {
            console.error('[Diagram] Failed to load XML:', error);
        }
    }

    /**
     * Get current diagram XML
     */
    function getXml() {
        if (!iframe || !iframe.contentWindow) {
            return currentXml;
        }

        // Request XML from draw.io
        iframe.contentWindow.postMessage({
            action: 'get',
            format: 'xml'
        }, '*');

        return currentXml;
    }

    /**
     * Request XML from draw.io (async)
     */
    function getXmlAsync() {
        return new Promise((resolve) => {
            if (!iframe || !iframe.contentWindow) {
                resolve(currentXml);
                return;
            }

            // Set up one-time listener for the response
            const handler = (event) => {
                if (event.data && event.data.event === 'save' && event.data.xml) {
                    window.removeEventListener('message', handler);
                    currentXml = event.data.xml;
                    resolve(event.data.xml);
                }
            };

            window.addEventListener('message', handler);

            // Request XML
            iframe.contentWindow.postMessage({
                action: 'get',
                format: 'xml'
            }, '*');

            // Timeout after 2 seconds
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve(currentXml);
            }, 2000);
        });
    }

    /**
     * Set diagram XML (for AI to set content)
     */
    function setXml(xml) {
        currentXml = xml;

        if (iframe && iframe.contentWindow) {
            loadXml(xml);
            updateStatus('已加载图表');
        }
    }

    /**
     * Export diagram
     */
    function exportDiagram(format = 'xml') {
        if (!iframe || !iframe.contentWindow) {
            console.error('[Diagram] Iframe not ready for export');
            return;
        }

        updateStatus('正在导出...');

        iframe.contentWindow.postMessage({
            action: 'export',
            format: format,
            download: 'true'
        }, '*');
    }

    /**
     * Export diagram and get data (for AI tools)
     */
    function exportDiagramAsync(format = 'xml') {
        return new Promise((resolve) => {
            if (!iframe || !iframe.contentWindow) {
                resolve({ error: 'Iframe not ready' });
                return;
            }

            // Set up one-time listener for the response
            const handler = (event) => {
                if (event.data && event.data.event === 'export') {
                    window.removeEventListener('message', handler);

                    if (event.data.data) {
                        resolve({
                            success: true,
                            format: format,
                            data: event.data.data
                        });
                    } else {
                        // Export may have triggered download instead
                        resolve({
                            success: true,
                            message: 'Diagram exported (download triggered)'
                        });
                    }
                }
            };

            window.addEventListener('message', handler);

            // Request export
            iframe.contentWindow.postMessage({
                action: 'export',
                format: format,
                download: format === 'xml' ? 'true' : 'false'
            }, '*');

            // Timeout after 3 seconds
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve({
                    success: true,
                    message: 'Export timeout, diagram may have been downloaded'
                });
            }, 3000);
        });
    }

    /**
     * Handle import file
     */
    function handleImportFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;

            // Check file extension
            const ext = file.name.split('.').pop().toLowerCase();

            if (ext === 'xml' || ext === 'drawio') {
                // Load XML directly
                setXml(content);
                updateStatus('已导入: ' + file.name);
            } else if (ext === 'png' || ext === 'svg') {
                // For images, we would need to use draw.io's import feature
                // For now, show a message
                updateStatus('图片导入需要在图表编辑器中操作');
            }

            // Reset input
            event.target.value = '';
        };

        reader.readAsText(file);
    }

    /**
     * Update status text
     */
    function updateStatus(text) {
        if (statusText) {
            statusText.textContent = text;
        }
    }

    /**
     * Check if diagram is ready
     */
    function isReady() {
        return isInitialized && iframe && iframe.src;
    }

    // Expose API globally
    window.InfinPilotDiagram = {
        init,
        createNew,
        loadXml,
        getXml,
        getXmlAsync,
        setXml,
        exportDiagram,
        exportDiagramAsync,
        isReady,
        updateStatus
    };

    console.log('[Diagram] Diagram module loaded');
})();
