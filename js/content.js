/**
 * Infinpilot 内容脚本
 * 用于从网页中提取内容并与面板通信
 */

console.log('[Content] content.js starting to load...');

// Note: content-automation.js is loaded via manifest and initializes itself.
// import ContentAutomation from './automation/content-automation.js';

// 防止重复初始化
if (window.contentScriptInitialized) {
    console.log('[Content] Already initialized, skipping...');
} else {
    window.contentScriptInitialized = true;
    console.log('[Content] Initializing content script...');

    // The content-automation module initializes itself upon import.

// 全局变量，跟踪面板状态
let panelActive = window.panelActive || false;
let panelWidth = 520; // 默认宽度
let minPanelWidth = 280; // 新增最小宽度限制
let maxPanelWidthPercentage = 0.8; // 最大宽度为窗口的80%
let resizing = false;
let messageShownForThisPageView = false; // 新增：跟踪当前页面视图是否已显示过提取成功消息

// 划词助手相关变量
let textSelectionHelperLoaded = false;

// 新增：封装 PDF.js 的加载和初始化
let pdfjsLibPromise = null;

async function getInitializedPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      // 确保在 try-catch 块中处理导入，以防模块加载失败
      try {
        const { getDocument, GlobalWorkerOptions } = await import(browser.runtime.getURL('js/lib/pdf.mjs'));
        // 确保 GlobalWorkerOptions 存在
        if (GlobalWorkerOptions) {
          GlobalWorkerOptions.workerSrc = browser.runtime.getURL('js/lib/pdf.worker.mjs');
          console.log('[InfinPilot] PDF.js library (our version) loaded and worker configured via getInitializedPdfjsLib.');
          return { getDocument, GlobalWorkerOptions };
        } else {
          console.error('[InfinPilot] PDF.js GlobalWorkerOptions is undefined after import.');
          return null; // 未能正确加载 PDF.js 的 GlobalWorkerOptions
        }
      } catch (error) {
        console.error('[InfinPilot] Failed to import PDF.js library:', error);
        pdfjsLibPromise = null; // 重置 promise 以便下次重试（如果适用）
        throw error; // 重新抛出错误，让调用者处理
      }
    })();
  }
  return pdfjsLibPromise;
}


// 初始化划词助手
function initTextSelectionHelper() {
  if (textSelectionHelperLoaded) return;

  // 直接初始化划词助手（现在通过 content script 加载）
  if (window.TextSelectionHelper) {
    window.TextSelectionHelper.init();
    textSelectionHelperLoaded = true;
    console.log('[InfinPilot] Text Selection Helper initialized');
  } else {
    console.warn('[InfinPilot] TextSelectionHelper not available');
  }
}

// 初始化函数 - 创建面板DOM
function initInfinpilotPanel() {
  if (document.getElementById('infinpilot-panel-container')) {
    return;
  }

  const panelContainer = document.createElement('div');
  panelContainer.id = 'infinpilot-panel-container';
  panelContainer.style.zIndex = '2147483647'; // 确保 z-index 设置正确

  // 从localStorage加载保存的宽度
  const savedWidth = localStorage.getItem('infinpilotPanelWidth');
  if (savedWidth) {
    panelWidth = parseInt(savedWidth, 10);
    const windowWidth = window.innerWidth;
    // 确保加载的宽度在允许范围内
    panelWidth = Math.max(minPanelWidth, Math.min(panelWidth, windowWidth * maxPanelWidthPercentage));
  }
  panelContainer.style.width = `${panelWidth}px`;
  panelContainer.style.overflow = 'hidden';

  const resizer = document.createElement('div');
  resizer.id = 'infinpilot-panel-resizer';

  const iframe = document.createElement('iframe');
  iframe.id = 'infinpilot-panel-iframe';
  iframe.src = browser.runtime.getURL('html/sidepanel.html');
  iframe.style.overflow = 'hidden';

  panelContainer.appendChild(resizer);
  panelContainer.appendChild(iframe);
  document.body.appendChild(panelContainer);

  setupResizeEvents(resizer, panelContainer);
}

// 设置调整大小的事件监听器
function setupResizeEvents(resizer, panel) {
  resizer.addEventListener('mousedown', function (e) {
    e.preventDefault();
    resizing = true;

    const initialX = e.clientX;
    const initialWidth = panelWidth; // 使用当前的 panelWidth
    const iframe = document.getElementById('infinpilot-panel-iframe');

    if (iframe) {
      iframe.style.pointerEvents = 'none'; // 拖动时禁用iframe的鼠标事件
    }
    document.body.classList.add('infinpilot-resizing-active'); // 添加此类以禁用页面其他元素事件

    function onMouseMove(eMove) {
      if (!resizing) return;

      const diffX = initialX - eMove.clientX;
      let newWidth = initialWidth + diffX;
      
      const windowWidth = window.innerWidth;
      // 限制新宽度的范围
      newWidth = Math.max(minPanelWidth, Math.min(newWidth, windowWidth * maxPanelWidthPercentage));

      if (panelWidth !== newWidth) {
        panelWidth = newWidth;
        panel.style.width = `${newWidth}px`;

        const currentUrl = window.location.href;
        const contentType = document.contentType;
        const isPdfPage = currentUrl.toLowerCase().endsWith('.pdf') ||
                          contentType === 'application/pdf' ||
                          document.querySelector('div#viewer.pdfViewer') !== null ||
                          document.querySelector('div#viewerContainer') !== null ||
                          document.querySelector('embed[type="application/pdf"]') !== null;

        if (isPdfPage) {
            // 尝试调整特定PDF容器
            const pdfJsViewer = document.getElementById('viewerContainer') || document.getElementById('outerContainer');
            if (pdfJsViewer && pdfJsViewer.classList.contains('infinpilot-adjusted')) {
                pdfJsViewer.style.marginRight = `${newWidth}px`;
            } else {
                const pdfEmbed = document.querySelector('embed[type="application/pdf"].infinpilot-adjusted');
                const pdfIframe = document.querySelector('iframe[src$=".pdf"].infinpilot-adjusted');
                const targetPdfElement = pdfEmbed || pdfIframe;
                if (targetPdfElement) {
                    targetPdfElement.style.width = `calc(100% - ${newWidth}px)`;
                }
            }
        } else {
            document.body.style.marginRight = `${newWidth}px`;
        }

        if (iframe && iframe.contentWindow) {
          requestAnimationFrame(() => { // 使用 rAF 优化性能
            iframe.contentWindow.postMessage({
              action: 'panelResized',
              width: panelWidth
            }, '*');
          });
        }
      }
    }

    function onMouseUp() {
      if (!resizing) return;
      resizing = false;

      if (iframe) {
        iframe.style.pointerEvents = 'auto'; // 恢复iframe的鼠标事件
      }
      document.body.classList.remove('infinpilot-resizing-active'); // 移除此类
      
      localStorage.setItem('infinpilotPanelWidth', panelWidth.toString()); // 保存宽度

      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ // 发送最终尺寸
          action: 'panelResized',
          width: panelWidth
        }, '*');
      }

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// 显示面板
function showPanel() {
  const panel = document.getElementById('infinpilot-panel-container');
  if (panel) {
    panel.style.display = 'block';
    panel.style.width = `${panelWidth}px`;

    // Defensively re-apply essential styles
    panel.style.position = 'fixed';
    panel.style.top = '0px';
    panel.style.right = '0px';
    panel.style.height = '100vh';

    document.body.classList.add('infinpilot-panel-open');

    const currentUrl = window.location.href;
    const contentType = document.contentType;
    const isPdfPage = currentUrl.toLowerCase().endsWith('.pdf') ||
                      contentType === 'application/pdf' ||
                      document.querySelector('div#viewer.pdfViewer') !== null ||
                      document.querySelector('div#viewerContainer') !== null ||
                      document.querySelector('embed[type="application/pdf"]') !== null;
    
    if (isPdfPage) {
      console.log('[InfinPilot] PDF page detected. Attempting to adjust PDF viewer.');
      let adjusted = false;
      const pdfJsViewer = document.getElementById('viewerContainer') || document.getElementById('outerContainer');
      if (pdfJsViewer) {
          // 保存原始样式，如果尚未保存
          if (!pdfJsViewer.dataset.originalMarginRight) pdfJsViewer.dataset.originalMarginRight = getComputedStyle(pdfJsViewer).marginRight;
          pdfJsViewer.style.marginRight = `${panelWidth}px`;
          pdfJsViewer.classList.add('infinpilot-adjusted');
          adjusted = true;
          console.log('[InfinPilot] Adjusted PDF.js viewer container margin-right.');
      } else {
          const pdfEmbed = document.querySelector('embed[type="application/pdf"]');
          const pdfIframe = document.querySelector('iframe[src$=".pdf"]'); // 简单匹配包含.pdf的iframe
          const targetPdfElement = pdfEmbed || pdfIframe;

          if (targetPdfElement) {
              if (!targetPdfElement.dataset.originalWidth) targetPdfElement.dataset.originalWidth = getComputedStyle(targetPdfElement).width;
              targetPdfElement.style.width = `calc(100% - ${panelWidth}px)`;
              targetPdfElement.classList.add('infinpilot-adjusted');
              adjusted = true;
              console.log('[InfinPilot] Adjusted PDF embed/iframe width.');
          }
      }
      if (!adjusted) {
          console.log('[InfinPilot] No specific PDF container found/adjusted. Panel will overlay. Body margin unchanged.');
      }
      // 在PDF页面，不修改 document.body.style.marginRight
    } else {
      document.body.style.marginRight = `${panelWidth}px`;
    }
    panelActive = true;

    setTimeout(() => {
      const iframe = document.getElementById('infinpilot-panel-iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ action: 'pageContentLoaded' }, '*');
        iframe.contentWindow.postMessage({ action: 'panelShownAndFocusInput' }, '*');
      }
    }, 100);
  
    setTimeout(detectAndSendTheme, 150);
  }
}

// 隐藏面板
function hidePanel() {
  const panel = document.getElementById('infinpilot-panel-container');
  if (panel) {
    panel.style.display = 'none';
    document.body.classList.remove('infinpilot-panel-open');
    panelActive = false;

    // 恢复PDF容器的样式
    const pdfJsViewer = document.querySelector('.infinpilot-adjusted#viewerContainer, .infinpilot-adjusted#outerContainer');
    if (pdfJsViewer) {
        if (pdfJsViewer.dataset.originalMarginRight) pdfJsViewer.style.marginRight = pdfJsViewer.dataset.originalMarginRight;
        pdfJsViewer.classList.remove('infinpilot-adjusted');
        console.log('[InfinPilot] Restored PDF.js viewer container margin-right.');
    } else {
        const targetPdfElement = document.querySelector('embed[type="application/pdf"].infinpilot-adjusted, iframe[src$=".pdf"].infinpilot-adjusted');
        if (targetPdfElement) {
            if (targetPdfElement.dataset.originalWidth) targetPdfElement.style.width = targetPdfElement.dataset.originalWidth;
            targetPdfElement.classList.remove('infinpilot-adjusted');
            console.log('[InfinPilot] Restored PDF embed/iframe width.');
        }
    }
    // 恢复普通页面的body margin
    document.body.style.marginRight = '0';
  }
}

// 切换面板显示状态
function togglePanel() {
  if (panelActive) {
    hidePanel();
  } else {
    showPanel();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isElementVisible(element) {
  if (!(element instanceof Element)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  return element.getClientRects().length > 0;
}

function isElementDisabled(element) {
  return Boolean(
    element?.disabled ||
    element?.getAttribute?.('aria-disabled') === 'true'
  );
}

function getDeepQueryRoots(root = document) {
  const roots = [];
  const visited = new Set();

  function visit(currentRoot) {
    if (!currentRoot || visited.has(currentRoot)) {
      return;
    }
    visited.add(currentRoot);
    roots.push(currentRoot);

    const rootNode = currentRoot instanceof Document
      ? (currentRoot.documentElement || currentRoot.body)
      : currentRoot;
    if (!rootNode) {
      return;
    }

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) {
        visit(node.shadowRoot);
      }
      node = walker.nextNode();
    }
  }

  visit(root);
  return roots;
}

function queryDeepAll(selector, root = document) {
  if (!selector) {
    return [];
  }
  const results = [];
  const seen = new Set();
  for (const searchRoot of getDeepQueryRoots(root)) {
    let matched = [];
    try {
      matched = Array.from(searchRoot.querySelectorAll(selector));
    } catch (error) {
      console.warn('[Content] Invalid selector:', selector, error);
      return [];
    }
    matched.forEach((element) => {
      if (!seen.has(element)) {
        seen.add(element);
        results.push(element);
      }
    });
  }
  return results;
}

function getElementLabelText(element) {
  if (!(element instanceof Element)) {
    return '';
  }
  if (element.labels && element.labels.length > 0) {
    return normalizeSpace(Array.from(element.labels).map((label) => label.innerText || label.textContent || '').join(' '));
  }
  const id = element.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) {
      return normalizeSpace(label.innerText || label.textContent || '');
    }
  }
  const wrappingLabel = element.closest('label');
  if (wrappingLabel) {
    return normalizeSpace(wrappingLabel.innerText || wrappingLabel.textContent || '');
  }
  return '';
}

function getElementAccessibleName(element) {
  if (!(element instanceof Element)) {
    return '';
  }
  return normalizeSpace(
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('alt') ||
    element.getAttribute('placeholder') ||
    element.getAttribute('name') ||
    element.innerText ||
    element.textContent ||
    getElementLabelText(element)
  );
}

function matchesText(actual, expected, exactText = false, partialText = true) {
  const normalizedActual = normalizeSpace(actual).toLowerCase();
  const normalizedExpected = normalizeSpace(expected).toLowerCase();
  if (!normalizedExpected) {
    return true;
  }
  if (exactText) {
    return normalizedActual === normalizedExpected;
  }
  if (partialText === false) {
    return normalizedActual === normalizedExpected;
  }
  return normalizedActual.includes(normalizedExpected);
}

function getCandidatePool(query = {}) {
  const tagName = normalizeSpace(query.tagName || '').toLowerCase();
  if (tagName) {
    return queryDeepAll(tagName);
  }
  return queryDeepAll('a,button,input,textarea,select,option,label,summary,[role],[aria-label],[placeholder],[name],[data-testid],[data-test],main,article,section,div,span');
}

function filterCandidates(query = {}) {
  const selector = normalizeSpace(query.selector || '');
  const text = normalizeSpace(query.text || '');
  const placeholder = normalizeSpace(query.placeholder || '');
  const ariaLabel = normalizeSpace(query.ariaLabel || '');
  const role = normalizeSpace(query.role || '').toLowerCase();
  const name = normalizeSpace(query.name || '');
  const labelText = normalizeSpace(query.labelText || '');
  const visibleOnly = query.visibleOnly !== false;
  const exactText = query.exactText === true;
  const partialText = query.partialText !== false;

  let candidates = selector ? queryDeepAll(selector) : getCandidatePool(query);

  if (placeholder) {
    candidates = candidates.filter((element) => matchesText(element.getAttribute('placeholder') || '', placeholder, exactText, partialText));
  }
  if (ariaLabel) {
    candidates = candidates.filter((element) => matchesText(element.getAttribute('aria-label') || '', ariaLabel, exactText, partialText));
  }
  if (role) {
    candidates = candidates.filter((element) => normalizeSpace(element.getAttribute('role') || '').toLowerCase() === role);
  }
  if (name) {
    candidates = candidates.filter((element) => matchesText(element.getAttribute('name') || '', name, exactText, partialText));
  }
  if (labelText) {
    candidates = candidates.filter((element) => matchesText(getElementLabelText(element), labelText, exactText, partialText));
  }
  if (text) {
    candidates = candidates.filter((element) => {
      const textSources = [
        element.innerText,
        element.textContent,
        getElementAccessibleName(element),
        getElementLabelText(element),
        element.getAttribute('value') || ''
      ];
      return textSources.some((value) => matchesText(value, text, exactText, partialText));
    });
  }
  if (visibleOnly) {
    candidates = candidates.filter(isElementVisible);
  }

  const seen = new Set();
  return candidates
    .filter((element) => {
      if (seen.has(element)) {
        return false;
      }
      seen.add(element);
      return true;
    })
    .map((element) => ({
      element,
      score: (
        (selector ? 20 : 0) +
        (text && matchesText(element.innerText || element.textContent || '', text, exactText, false) ? 12 : 0) +
        (text && matchesText(getElementAccessibleName(element), text, exactText, partialText) ? 10 : 0) +
        (placeholder && matchesText(element.getAttribute('placeholder') || '', placeholder, exactText, partialText) ? 8 : 0) +
        (labelText && matchesText(getElementLabelText(element), labelText, exactText, partialText) ? 8 : 0) +
        (ariaLabel && matchesText(element.getAttribute('aria-label') || '', ariaLabel, exactText, partialText) ? 8 : 0) +
        (role && normalizeSpace(element.getAttribute('role') || '').toLowerCase() === role ? 4 : 0) +
        (isElementVisible(element) ? 3 : 0) +
        (!isElementDisabled(element) ? 2 : 0)
      )
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.element);
}

async function waitForElements(query = {}) {
  const timeoutMs = Number.isFinite(query.timeoutMs) ? query.timeoutMs : 0;
  const pollInterval = Number.isFinite(query.pollInterval) ? query.pollInterval : 150;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    const elements = filterCandidates(query);
    if (elements.length > 0 || timeoutMs <= 0 || Date.now() >= deadline) {
      return elements;
    }
    await sleep(pollInterval);
  }
}

function describeLocator(query = {}) {
  return query.selector
    || query.text
    || query.labelText
    || query.placeholder
    || query.ariaLabel
    || query.role
    || query.name
    || query.tagName
    || '当前页面';
}

function describeLocatorSafe(query = {}) {
  return query.selector
    || query.text
    || query.labelText
    || query.placeholder
    || query.ariaLabel
    || query.role
    || query.name
    || query.tagName
    || '当前页面';
}

function serializeElement(element) {
  if (!(element instanceof Element)) {
    return null;
  }
  return {
    tagName: element.tagName,
    id: element.id || '',
    className: typeof element.className === 'string' ? element.className : '',
    text: normalizeSpace(element.innerText || element.textContent || '').slice(0, 120),
    name: element.getAttribute('name') || '',
    role: element.getAttribute('role') || '',
    ariaLabel: element.getAttribute('aria-label') || '',
    placeholder: element.getAttribute('placeholder') || ''
  };
}

function getElementContent(element, mode = 'text') {
  if (!(element instanceof Element)) {
    return '';
  }
  if (mode === 'outerHTML') {
    return element.outerHTML || '';
  }
  if (mode === 'html') {
    return element.innerHTML || '';
  }
  return normalizeSpace(element.innerText || element.textContent || '');
}

function setNativeInputValue(element, value) {
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(element, value) : (element.value = value);
    return;
  }
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter ? setter.call(element, value) : (element.value = value);
    return;
  }
  if (element instanceof HTMLSelectElement) {
    element.value = value;
    return;
  }
  if (element.isContentEditable) {
    element.textContent = value;
    return;
  }
  element.value = value;
}

async function performRobustClick(element) {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await sleep(60);
  if (typeof element.focus === 'function') {
    element.focus({ preventScroll: true });
  }

  const rect = element.getBoundingClientRect();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.max(1, Math.min(rect.width / 2, rect.width - 1)),
    clientY: rect.top + Math.max(1, Math.min(rect.height / 2, rect.height - 1))
  };

  const pointerSequence = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  pointerSequence.forEach((type) => {
    const EventCtor = type.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
    element.dispatchEvent(new EventCtor(type, eventInit));
  });

  if (typeof element.click === 'function') {
    element.click();
  }
}

// 监听来自background或面板的消息
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Content] Received message:', message.action);

  // 响应ping请求（用于检查content script是否活跃）
  if (message.action === "ping") {
    sendResponse && sendResponse({ success: true, alive: true });
    return true;
  }
  // 主动响应主题请求
  else if (message.action === "requestTheme") {
    detectAndSendTheme();
    sendResponse && sendResponse({ success: true });
    return true;
  }
  // 修改：处理来自 background.js 的内容提取请求
  else if (message.action === "getFullPageContentRequest") {
    (async () => { // 使用 IIFE 来处理异步操作
      try {
        const content = await extractPageContent(); // extractPageContent 现在是异步的
        sendResponse({ content: content });
      } catch (error) {
        console.error('[InfinPilot] Error during content extraction (getFullPageContentRequest listener):', error);
        sendResponse({ error: error.message });
      }
    })();
    return true; // 必须返回 true 来表明 sendResponse 将会异步调用
  }
  // Scraping Tools: 处理带参数的内容提取请求
  else if (message.action === "extractPageContent") {
    (async () => {
      try {
        const options = message.options || {};
        const { extractionType, cssSelector } = options;

        // 如果指定了 CSS 选择器，直接提取
        if (cssSelector) {
          const elements = await waitForElements({
            selector: cssSelector,
            visibleOnly: options.visibleOnly !== false,
            timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500
          });
          if (elements.length === 0) {
            sendResponse({ success: false, error: `No elements found for selector: ${cssSelector}` });
            return;
          }

          let content = '';
          if (extractionType === 'html') {
            content = Array.from(elements).map(el => el.outerHTML).join('\n');
          } else if (extractionType === 'text') {
            content = Array.from(elements).map(el => el.textContent?.trim()).filter(Boolean).join('\n');
          } else {
            // markdown / default
            content = Array.from(elements).map(el => el.textContent?.trim()).filter(Boolean).join('\n\n');
          }
          sendResponse({ success: true, content, count: elements.length });
          return;
        }

        // 如果指定了 links 或 images
        if (extractionType === 'links') {
          const links = [];
          document.querySelectorAll('a[href]').forEach(a => {
            links.push({ href: a.href, text: a.textContent?.trim() || '' });
          });
          sendResponse({ success: true, links: links.slice(0, 100), count: links.length });
          return;
        }

        if (extractionType === 'images') {
          const images = [];
          document.querySelectorAll('img[src]').forEach(img => {
            images.push({ src: img.src, alt: img.alt || '' });
          });
          sendResponse({ success: true, images: images.slice(0, 50), count: images.length });
          return;
        }

        // 默认提取主内容
        const content = await extractPageContent();
        sendResponse({ content, extractionType });
      } catch (error) {
        console.error('[InfinPilot] Error during extractPageContent:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  // 处理打开/关闭面板的请求
  else if (message.action === 'projectExtractStructured') {
    (async () => {
      try {
        const pattern = message.pattern || 'article';
        const result = await extractStructuredFromPage(pattern);
        sendResponse(result);
      } catch (error) {
        console.error('[InfinPilot] Error during projectExtractStructured:', error);
        sendResponse({ success: false, error: error.message || String(error) });
      }
    })();
    return true;
  }
  else if (message.action === "togglePanel") {
    // 检查必要的库是否可用
    const librariesAvailable = checkLibrariesAvailability();
    if (!librariesAvailable.allAvailable) {
      console.warn('[Content] Some libraries missing when toggling panel:', librariesAvailable.missing);
      sendResponse({
        success: false,
        error: 'Required libraries not available',
        missing: librariesAvailable.missing
      });
      return true;
    }

    // 初始化面板（如果尚未初始化）
    initInfinpilotPanel();

    // 切换面板显示
    togglePanel();
    sendResponse({ success: true, panelActive });
    return true; // 这是异步的，尽管 togglePanel 本身不是
  }
  // 处理来自background.js的流式更新消息（用于划词助手）
  else if (message.action === "streamUpdate") {
    // 直接转发给划词助手的监听器
    // 这个消息会被text-selection-helper.js中的监听器接收
    // 不需要sendResponse，因为这是单向消息
    return false; // 不需要异步响应
  }
  // 处理主面板ping请求
  else if (message.action === "pingMainPanel") {
    // 检查主面板是否存在
    const iframe = document.getElementById('infinpilot-panel-iframe');
    const hasMainPanel = iframe && iframe.contentWindow && panelActive;
    console.log('[Content] Main panel ping check:', { iframe: !!iframe, contentWindow: !!iframe?.contentWindow, panelActive, hasMainPanel });
    sendResponse({ hasMainPanel: hasMainPanel });
    return true;
  }
  // 处理来自background的API调用转发请求
  else if (message.action === "callUnifiedAPIFromBackground") {
    // 转发到主面板iframe
    const iframe = document.getElementById('infinpilot-panel-iframe');
    if (iframe && iframe.contentWindow && panelActive) {
      iframe.contentWindow.postMessage({
        action: 'callUnifiedAPIFromBackground',
        model: message.model,
        messages: message.messages,
        options: message.options
      }, '*');

      // 监听主面板的响应
      const responseHandler = (event) => {
        if (event.data && event.data.action === 'unifiedAPIResponse') {
          window.removeEventListener('message', responseHandler);
          sendResponse(event.data);
        }
      };
      window.addEventListener('message', responseHandler);

      // 设置超时
      setTimeout(() => {
        window.removeEventListener('message', responseHandler);
        sendResponse({ success: false, error: 'API call timeout' });
      }, 30000);

      return true; // 异步响应
    } else {
      sendResponse({ success: false, error: 'Main panel not available' });
      return true;
    }
  }
  // 处理代理自动清除通知
  else if (message.action === "proxyAutoCleared") {
    console.log('[Content] Proxy auto-cleared notification received:', message.failedProxy);
    // 通知主面板代理已被自动清除
    const iframe = document.getElementById('infinpilot-panel-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        action: 'proxyAutoCleared',
        failedProxy: message.failedProxy
      }, '*');
    }
    return false; // 不需要异步响应
  }
  // 实时同步机制 - 处理来自background的广播消息
  else if (message.action === 'storageChanged') {
    // 通用存储变化处理
    console.log('[Content] Storage changed:', message.changes);
    return false;
  }
  else if (message.action === 'languageChanged') {
    console.log('[Content] Language changed from', message.oldLanguage, 'to', message.newLanguage);
    handleLanguageChangeInContent(message.newLanguage);
    return false;
  }
  else if (message.action === 'textSelectionHelperSettingsChanged') {
    console.log('[Content] Text selection helper settings changed');
    handleTextSelectionHelperSettingsChange(message.newSettings);
    return false;
  }
  else if (message.action === 'extensionReloaded') {
    console.log('[Content] Extension reloaded - reinitializing');
    handleExtensionReload();
    return false;
  }
  // 处理模型更新事件
  else if (message.action === 'modelsUpdated') {
    console.log('[Content] Models updated - forwarding to main panel');
    // 转发模型更新事件到主面板
    const iframe = document.getElementById('infinpilot-panel-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        action: 'modelsUpdated'
      }, '*');
    }
    return false;
  }

  // 处理浏览器自动化工具执行请求
  else if (message.action === 'getPageContent' || message.action === 'getElement') {
    (async () => {
      try {
        if (message.selector || message.text || message.labelText || message.placeholder || message.ariaLabel || message.role || message.name || message.tagName) {
          const elements = await waitForElements({
            selector: message.selector,
            text: message.text,
            labelText: message.labelText,
            placeholder: message.placeholder,
            ariaLabel: message.ariaLabel,
            role: message.role,
            name: message.name,
            tagName: message.tagName,
            exactText: message.exactText === true,
            partialText: message.partialText !== false,
            visibleOnly: message.visibleOnly !== false,
            timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 1500
          });
          const index = Number.isFinite(message.index) ? message.index : 0;
          const element = elements[index];
          if (!element) {
            sendResponse({ error: `Element not found: ${describeLocatorSafe(message)}` });
            return;
          }
          sendResponse({
            success: true,
            content: getElementContent(element, 'text'),
            element: serializeElement(element),
            matchCount: elements.length
          });
          return;
        }

        sendResponse({
          success: true,
          content: normalizeSpace(document.body?.innerText || document.body?.textContent || ''),
          element: null,
          matchCount: 0
        });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === 'clickElement') {
    (async () => {
      try {
        const elements = await waitForElements({
          selector: message.selector,
          text: message.text,
          labelText: message.labelText,
          placeholder: message.placeholder,
          ariaLabel: message.ariaLabel,
          role: message.role,
          name: message.name,
          tagName: message.tagName,
          exactText: message.exactText === true,
          partialText: message.partialText !== false,
          visibleOnly: message.visibleOnly !== false,
          timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 2000
        });
        if (elements.length === 0) {
          sendResponse({ error: `未找到元素: ${describeLocatorSafe(message)}` });
          return;
        }
        const index = Number.isFinite(message.index) ? message.index : 0;
        const element = elements[index];
        if (!element) {
          sendResponse({ error: `索引超出范围: ${index}，共找到 ${elements.length} 个元素` });
          return;
        }
        if (isElementDisabled(element)) {
          sendResponse({ error: `元素不可交互: ${describeLocatorSafe(message)}` });
          return;
        }
        await performRobustClick(element);
        sendResponse({
          success: true,
          message: `已点击元素: ${describeLocatorSafe(message)} (索引: ${index})`,
          element: serializeElement(element),
          matchCount: elements.length
        });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === '__legacy_clickElement') {
    try {
      const elements = document.querySelectorAll(message.selector);
      if (elements.length === 0) {
        sendResponse({ error: `未找到元素: ${message.selector}` });
        return true;
      }
      // 如果有index参数，使用指定的元素
      const index = message.index || 0;
      if (index >= elements.length) {
        sendResponse({ error: `索引超出范围: ${index}，共找到 ${elements.length} 个元素` });
        return true;
      }
      const element = elements[index];
      // 尝试点击
      element.click();
      sendResponse({ success: true, message: `已点击元素: ${message.selector} (索引: ${index})`, tagName: element.tagName, text: element.innerText?.substring(0, 50) });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
  else if (message.action === 'fillInput') {
    (async () => {
      try {
        const elements = await waitForElements({
          selector: message.selector,
          text: message.text,
          labelText: message.labelText,
          placeholder: message.placeholder,
          ariaLabel: message.ariaLabel,
          role: message.role,
          name: message.name,
          tagName: message.tagName || 'input, textarea, select, [contenteditable="true"]',
          exactText: message.exactText === true,
          partialText: message.partialText !== false,
          visibleOnly: message.visibleOnly !== false,
          timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 2500
        });
        if (elements.length === 0) {
          sendResponse({ error: `未找到输入元素: ${describeLocatorSafe(message)}` });
          return;
        }
        const index = Number.isFinite(message.index) ? message.index : 0;
        const element = elements[index];
        if (!element) {
          sendResponse({ error: `索引超出范围: ${index}，共找到 ${elements.length} 个元素` });
          return;
        }
        if (isElementDisabled(element)) {
          sendResponse({ error: `输入元素不可交互: ${describeLocatorSafe(message)}` });
          return;
        }
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(40);
        if (typeof element.focus === 'function') {
          element.focus({ preventScroll: true });
        }
        const value = String(message.value ?? '');
        if (message.clearFirst !== false) {
          setNativeInputValue(element, '');
        }
        setNativeInputValue(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        sendResponse({
          success: true,
          message: `已填写输入框: ${describeLocatorSafe(message)} (索引: ${index})`,
          value,
          element: serializeElement(element),
          matchCount: elements.length
        });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === '__legacy_fillInput') {
    try {
      const elements = document.querySelectorAll(message.selector);
      if (elements.length === 0) {
        sendResponse({ error: `未找到元素: ${message.selector}` });
        return true;
      }
      const index = message.index || 0;
      const element = elements[index];

      // 填写前清空
      if (message.clearFirst) {
        element.value = '';
      }
      element.value = message.value;

      // 触发事件通知监听器
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));

      sendResponse({ success: true, message: `已填写输入框: ${message.selector} (索引: ${index})`, value: message.value });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
  else if (message.action === 'pressKey') {
    (async () => {
      try {
        let target = document.activeElement;
        if (message.selector || message.text || message.labelText || message.placeholder || message.ariaLabel || message.role || message.name || message.tagName) {
          const elements = await waitForElements({
            selector: message.selector,
            text: message.text,
            labelText: message.labelText,
            placeholder: message.placeholder,
            ariaLabel: message.ariaLabel,
            role: message.role,
            name: message.name,
            tagName: message.tagName,
            exactText: message.exactText === true,
            partialText: message.partialText !== false,
            visibleOnly: message.visibleOnly !== false,
            timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 1500
          });
          const index = Number.isFinite(message.index) ? message.index : 0;
          target = elements[index];
        }
        if (!target) {
          sendResponse({ error: `未找到按键目标: ${describeLocatorSafe(message)}` });
          return;
        }
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
        const eventOptions = {
          key: message.key,
          code: message.code || message.key,
          bubbles: true,
          cancelable: true,
          composed: true
        };
        target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
        target.dispatchEvent(new KeyboardEvent('keypress', eventOptions));
        target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
        sendResponse({
          success: true,
          message: `已按下按键: ${message.key}`,
          element: serializeElement(target)
        });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === '__legacy_pressKey') {
    try {
      // 优先处理指定元素，否则使用当前焦点元素
      let target = document.activeElement;
      if (message.selector) {
        target = document.querySelector(message.selector);
        if (!target) {
          sendResponse({ error: `Element not found: ${message.selector}` });
          return true;
        }
      }

      // 创建并触发键盘事件
      const eventOptions = { key: message.key, code: message.key, bubbles: true, cancelable: true };
      const keydownEvent = new KeyboardEvent('keydown', eventOptions);
      const keyupEvent = new KeyboardEvent('keyup', eventOptions);

      target.dispatchEvent(keydownEvent);
      target.dispatchEvent(keyupEvent);

      sendResponse({ success: true, message: `已按下按键: ${message.key}` });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
  else if (message.action === 'getPageDOM') {
    (async () => {
      try {
        let content = '';
        let element = null;
        let matchCount = 0;
        if (message.selector || message.text || message.labelText || message.placeholder || message.ariaLabel || message.role || message.name || message.tagName) {
          const elements = await waitForElements({
            selector: message.selector,
            text: message.text,
            labelText: message.labelText,
            placeholder: message.placeholder,
            ariaLabel: message.ariaLabel,
            role: message.role,
            name: message.name,
            tagName: message.tagName,
            exactText: message.exactText === true,
            partialText: message.partialText !== false,
            visibleOnly: message.visibleOnly !== false,
            timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 1500
          });
          matchCount = elements.length;
          const index = Number.isFinite(message.index) ? message.index : 0;
          element = elements[index];
          if (!element) {
            sendResponse({ error: `未找到元素: ${describeLocatorSafe(message)}` });
            return;
          }
          content = getElementContent(element, message.outerHTML ? 'outerHTML' : 'html');
        } else {
          content = document.documentElement.innerHTML || '';
        }
        if (message.maxLength && content.length > message.maxLength) {
          content = `${content.substring(0, message.maxLength)}...(内容已截断)`;
        }
        sendResponse({
          success: true,
          content,
          length: content.length,
          matchCount,
          element: serializeElement(element)
        });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === '__legacy_getPageDOM') {
    try {
      let content = '';
      if (message.selector) {
        // 获取特定元素
        const elements = document.querySelectorAll(message.selector);
        if (elements.length === 0) {
          sendResponse({ error: `未找到元素: ${message.selector}` });
          return true;
        }
        // 如果有多个元素，只返回第一个
        const el = message.index !== undefined ? elements[message.index] : elements[0];
        content = el.innerHTML || el.textContent || '';
      } else {
        // 获取整个页面
        content = document.documentElement.innerHTML || '';
      }
      // 截断内容
      if (message.maxLength && content.length > message.maxLength) {
        content = content.substring(0, message.maxLength) + '...(内容已截断)';
      }
      sendResponse({ content: content, length: content.length });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
  else if (message.action === 'getVisibleText') {
    (async () => {
      try {
        let text = '';
        let element = null;
        let matchCount = 0;
        if (message.selector || message.text || message.labelText || message.placeholder || message.ariaLabel || message.role || message.name || message.tagName) {
          const elements = await waitForElements({
            selector: message.selector,
            text: message.text,
            labelText: message.labelText,
            placeholder: message.placeholder,
            ariaLabel: message.ariaLabel,
            role: message.role,
            name: message.name,
            tagName: message.tagName,
            exactText: message.exactText === true,
            partialText: message.partialText !== false,
            visibleOnly: message.visibleOnly !== false,
            timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 1500
          });
          matchCount = elements.length;
          const index = Number.isFinite(message.index) ? message.index : 0;
          element = elements[index];
          if (!element) {
            sendResponse({ error: `未找到元素: ${describeLocatorSafe(message)}` });
            return;
          }
          text = getElementContent(element, 'text');
        } else {
          text = normalizeSpace(document.body?.innerText || document.body?.textContent || '');
        }
        sendResponse({
          success: true,
          text,
          length: text.length,
          matchCount,
          element: serializeElement(element)
        });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === '__legacy_getVisibleText') {
    try {
      let text = '';
      if (message.selector) {
        // 获取特定元素的可见文本
        const elements = document.querySelectorAll(message.selector);
        if (elements.length === 0) {
          sendResponse({ error: `未找到元素: ${message.selector}` });
          return true;
        }
        const el = message.index !== undefined ? elements[message.index] : elements[0];
        text = el.innerText || el.textContent || '';
      } else {
        // 获取整个页面的可见文本
        text = document.body.innerText || document.body.textContent || '';
      }
      // 清理空白
      text = text.replace(/\s+/g, ' ').trim();
      sendResponse({ text: text, length: text.length });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
  else if (message.action === 'scrollPage') {
    (async () => {
      try {
        const direction = message.direction || 'down';
        const amount = message.amount || 500;
        const targets = message.selector
          ? await waitForElements({
              selector: message.selector,
              visibleOnly: false,
              timeoutMs: Number.isFinite(message.timeoutMs) ? message.timeoutMs : 800
            })
          : [];
        const scrollTarget = targets[0] || window;

        if (scrollTarget !== window) {
          scrollTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          if (direction === 'top') {
            scrollTarget.scrollTop = 0;
          } else if (direction === 'bottom') {
            scrollTarget.scrollTop = scrollTarget.scrollHeight;
          } else {
            scrollTarget.scrollTop += direction === 'up' ? -amount : amount;
          }
          sendResponse({ success: true, message: `已滚动元素 ${describeLocatorSafe(message)}`, scrollTop: scrollTarget.scrollTop });
          return;
        }

        switch (direction) {
          case 'up':
            window.scrollBy(0, -amount);
            break;
          case 'down':
            window.scrollBy(0, amount);
            break;
          case 'top':
            window.scrollTo(0, 0);
            break;
          case 'bottom':
            window.scrollTo(0, document.body.scrollHeight);
            break;
          default:
            window.scrollBy(0, amount);
        }

        sendResponse({ success: true, message: `已滚动页面 ${direction}`, scrollY: window.scrollY });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    })();
    return true;
  }
  else if (message.action === '__legacy_scrollPage') {
    try {
      const direction = message.direction || 'down';
      const amount = message.amount || 500;

      switch (direction) {
        case 'up':
          window.scrollBy(0, -amount);
          break;
        case 'down':
          window.scrollBy(0, amount);
          break;
        case 'top':
          window.scrollTo(0, 0);
          break;
        case 'bottom':
          window.scrollTo(0, document.body.scrollHeight);
          break;
        default:
          window.scrollBy(0, amount);
      }

      sendResponse({ success: true, message: `已滚动页面: ${direction}`, scrollY: window.scrollY });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }

  // 确保为其他可能的消息处理器也返回 true（如果它们是异步的）
  // 如果没有其他异步处理器，可以在这里返回 false 或 undefined
  // 为了保险起见，如果这个 listener 包含任何异步操作，最好总是返回 true
  return true;
});

// 页面加载完成后初始化划词助手
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTextSelectionHelper);
} else {
  initTextSelectionHelper();
}

// 提取页面的主要内容 - 现在是异步函数
function getMetaContent(selectors = []) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const value = node?.getAttribute('content') || node?.textContent || '';
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function extractArticleStructured() {
  const documentClone = document.cloneNode(true);
  const parsed = new Readability(documentClone).parse() || {};
  const title = parsed.title || document.title || '';
  const textContent = (parsed.textContent || '').replace(/\s+/g, ' ').trim();
  const excerpt = parsed.excerpt || textContent.slice(0, 220);
  const publishedTime = getMetaContent([
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="publish-date"]',
    'meta[name="date"]',
    'time[datetime]'
  ]);

  return {
    title,
    byline: parsed.byline || '',
    excerpt,
    textContent,
    length: textContent.length,
    siteName: parsed.siteName || getMetaContent(['meta[property="og:site_name"]']),
    lang: document.documentElement.lang || '',
    publishedTime
  };
}

function extractTablesStructured() {
  const tables = [];
  document.querySelectorAll('table').forEach((table, index) => {
    const rows = Array.from(table.querySelectorAll('tr')).map(row =>
      Array.from(row.querySelectorAll('th, td')).map(cell => (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim())
    ).filter(cells => cells.some(Boolean));

    if (rows.length === 0) {
      return;
    }

    const headers = rows[0] || [];
    const caption = table.querySelector('caption')?.innerText?.trim() || '';
    tables.push({
      index,
      caption,
      headers,
      rowCount: Math.max(rows.length - 1, 0),
      rows: rows.slice(1, 51)
    });
  });
  return tables;
}

async function extractStructuredFromPageLegacy(pattern) {
  if (pattern === 'article') {
    const data = extractArticleStructured();
    if (!data.textContent) {
      return { success: false, error: '未提取到文章内容' };
    }
    return { success: true, pattern, count: 1, data };
  }

  if (pattern === 'table') {
    const tables = extractTablesStructured();
    if (tables.length === 0) {
      return { success: false, error: '当前页面未找到表格' };
    }
    return { success: true, pattern, count: tables.length, data: { tables } };
  }

  return { success: false, error: `暂不支持的提取类型: ${pattern}` };
}

function getNormalizedText(node) {
  return (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
}

function looksLikeDateLabel(text) {
  return /\b(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d{1,2}:\d{2})\b/.test(text);
}

function extractFaqStructured() {
  const faqItems = [];

  document.querySelectorAll('details').forEach((detail, index) => {
    const question = getNormalizedText(detail.querySelector('summary'));
    const answer = getNormalizedText(detail).replace(question, '').trim();
    if (question && answer) {
      faqItems.push({ index, question, answer });
    }
  });

  if (faqItems.length > 0) {
    return faqItems;
  }

  const containers = document.querySelectorAll('[class*="faq"], [id*="faq"], [class*="accordion"], [class*="question"]');
  containers.forEach((container, index) => {
    const question = getNormalizedText(container.querySelector('h2, h3, h4, button, summary, dt'));
    const answer = getNormalizedText(container.querySelector('p, div, dd'));
    if (question && answer) {
      faqItems.push({ index, question, answer });
    }
  });

  return faqItems;
}

function extractProductStructured() {
  const name = getMetaContent([
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[itemprop="name"]'
  ]) || getNormalizedText(document.querySelector('h1')) || document.title || '';
  const price = getMetaContent([
    'meta[property="product:price:amount"]',
    'meta[itemprop="price"]',
    'meta[name="price"]'
  ]) || getNormalizedText(document.querySelector('[class*="price"], [data-price], [itemprop="price"]'));
  const currency = getMetaContent([
    'meta[property="product:price:currency"]',
    'meta[itemprop="priceCurrency"]'
  ]);
  const description = getMetaContent([
    'meta[property="og:description"]',
    'meta[name="description"]'
  ]) || getNormalizedText(document.querySelector('[class*="description"], [itemprop="description"]'));
  const image = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
    || document.querySelector('img[src]')?.src
    || '';

  const specs = [];
  document.querySelectorAll('table').forEach(table => {
    table.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th, td')).map(getNormalizedText).filter(Boolean);
      if (cells.length >= 2) {
        specs.push({ name: cells[0], value: cells.slice(1).join(' | ') });
      }
    });
  });

  document.querySelectorAll('dl').forEach(list => {
    const terms = list.querySelectorAll('dt');
    terms.forEach(term => {
      const value = getNormalizedText(term.nextElementSibling);
      if (value) {
        specs.push({ name: getNormalizedText(term), value });
      }
    });
  });

  return {
    name,
    price,
    currency,
    description,
    image,
    specs: specs.slice(0, 40)
  };
}

function extractTimelineStructured() {
  const events = [];
  const candidates = document.querySelectorAll('li, article, section, .timeline-item, [class*="timeline"], [class*="event"]');

  candidates.forEach((node, index) => {
    const dateNode = node.querySelector('time')
      || Array.from(node.querySelectorAll('span, p, div, strong')).find(child => looksLikeDateLabel(getNormalizedText(child)));
    const date = getNormalizedText(dateNode);
    const title = getNormalizedText(node.querySelector('h1, h2, h3, h4, strong, b')) || getNormalizedText(node).slice(0, 80);
    const description = getNormalizedText(node);

    if (date && title && description) {
      events.push({
        index,
        date,
        title,
        description: description.slice(0, 300)
      });
    }
  });

  return events.slice(0, 50);
}

async function extractStructuredFromPage(pattern) {
  if (pattern === 'article') {
    const data = extractArticleStructured();
    if (!data.textContent) {
      return { success: false, error: '未提取到文章内容' };
    }
    return { success: true, pattern, count: 1, data };
  }

  if (pattern === 'table') {
    const tables = extractTablesStructured();
    if (tables.length === 0) {
      return { success: false, error: '当前页面未找到表格' };
    }
    return { success: true, pattern, count: tables.length, data: { tables } };
  }

  if (pattern === 'faq') {
    const items = extractFaqStructured();
    if (items.length === 0) {
      return { success: false, error: '当前页面未找到 FAQ 结构' };
    }
    return { success: true, pattern, count: items.length, data: { items } };
  }

  if (pattern === 'product') {
    const data = extractProductStructured();
    if (!data.name && !data.price && data.specs.length === 0) {
      return { success: false, error: '当前页面未找到商品信息' };
    }
    return { success: true, pattern, count: data.specs.length || 1, data };
  }

  if (pattern === 'timeline') {
    const events = extractTimelineStructured();
    if (events.length === 0) {
      return { success: false, error: '当前页面未找到时间线内容' };
    }
    return { success: true, pattern, count: events.length, data: { events } };
  }

  return { success: false, error: `暂不支持的提取类型: ${pattern}` };
}

async function extractPageContent() {
  const currentUrl = window.location.href;
  const contentType = document.contentType;
  // 检测是否为 PDF.js 渲染的页面 (例如 arXiv)
  const isPdfJsViewerDom = document.querySelector('div#viewer.pdfViewer') !== null || document.querySelector('div#viewerContainer') !== null;
  // 检测是否为直接的 PDF 链接或浏览器识别为 PDF 内容类型
  const isDirectPdf = currentUrl.toLowerCase().endsWith('.pdf') || contentType === 'application/pdf';

  console.log(`[InfinPilot] Extraction check: isDirectPdf=${isDirectPdf}, isPdfJsViewerDom=${isPdfJsViewerDom}, contentType=${contentType}, url=${currentUrl}`);

  if (isDirectPdf) {
    console.log('[InfinPilot] Direct PDF detected. Attempting fetch and PDF.js parse.');
    try {
      // 修改：使用 getInitializedPdfjsLib 获取 pdf.js
      const pdfjs = await getInitializedPdfjsLib();
      if (!pdfjs || !pdfjs.getDocument) { // 检查 pdfjs 是否成功初始化
        const currentLang = localStorage.getItem('language') || 'zh-CN';
        const errorMessage = trContent('pdfLibraryInitFailed') || 'PDF.js library failed to initialize.';
        throw new Error(errorMessage);
      }

      // 通过background.js获取PDF文件（支持代理）
      const response = await new Promise((resolve, reject) => {
        browser.runtime.sendMessage({
          action: 'fetchWithProxy',
          url: currentUrl,
          options: { method: 'GET' }
        }, (response) => {
          if (browser.runtime.lastError) {
            reject(new Error(browser.runtime.lastError.message));
          } else if (response.success) {
            resolve(response);
          } else {
            const currentLang = localStorage.getItem('language') || 'zh-CN';
            const errorMessage = trContent('pdfFetchFailed') || 'Failed to fetch PDF';
            reject(new Error(response.error || errorMessage));
          }
        });
      });

      if (!response.success) {
        const currentLang = localStorage.getItem('language') || 'zh-CN';
        const errorTemplate = trContent('pdfFetchFailedWithError') || 'Failed to fetch PDF: {error}';
        const errorMessage = errorTemplate.replace('{error}', response.error);
        throw new Error(errorMessage);
      }
      // 将base64数据转换为ArrayBuffer
      const base64Data = response.data;
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const pdfData = bytes.buffer;
      // 修改：使用 pdfjs.getDocument
      const pdf = await pdfjs.getDocument({ data: pdfData }).promise;

      // 提取 PDF 元数据和文本内容
      let fullText = `PDF Title: ${pdf.info?.Title || document.title || 'Unknown Title'}\n`;
      fullText += `Number of Pages: ${pdf.numPages}\n\n`;

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        // 简单地将所有文本项连接起来，并用空格分隔
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += `--- Page ${i} ---\n${pageText}\n\n`;
      }
      console.log('[InfinPilot] PDF text extracted via fetch, length:', fullText.length);
      const maxLength = 500000; // 限制最大长度，与 Readability 提取一致
      if (fullText.length > maxLength) {
        const truncatedSuffix = trContent('contentTruncated') || '...(Content truncated)';
        fullText = fullText.substring(0, maxLength) + truncatedSuffix;
      }
      return fullText.trim();
    } catch (pdfError) {
      console.warn('[InfinPilot] PDF fetch/parse error for direct PDF:', pdfError);
      // 如果 fetch/parse 失败，但 DOM 结构像是 PDF.js viewer，尝试从 DOM 提取
      if (isPdfJsViewerDom) {
        console.log('[InfinPilot] Falling back to DOM extraction for direct PDF (e.g. arXiv).');
        return extractFromPdfJsDom(); // 尝试从DOM中提取
      }
      // 如果 DOM 提取方式不适用或失败，最终回退到 Readability
      console.warn('[InfinPilot] Falling back to Readability for direct PDF after fetch/parse error.');
      const currentLang = localStorage.getItem('language') || 'zh-CN';
      const errorTemplate = trContent('pdfProcessingError') || 'Error processing PDF: {error}';
      const errorMessage = errorTemplate.replace('{error}', pdfError.message);
      return `${errorMessage} \n\n ${extractWithReadability()}`;
    }
  } else if (isPdfJsViewerDom) {
    // 如果不是直接的 PDF 链接，但页面 DOM 结构像是 PDF.js 渲染的
    console.log('[InfinPilot] Embedded PDF.js viewer detected. Attempting DOM extraction.');
    return extractFromPdfJsDom();
  } else {
    // 对于普通 HTML 页面，使用 Readability
    console.log('[InfinPilot] Standard HTML page. Using Readability.');
    return extractWithReadability();
  }
}

/**
 * 翻译助手函数（优先使用统一 I18n，再回退到 window.translations）
 */
function trContent(key, replacements = {}) {
  try {
    if (window.I18n && typeof window.I18n.tr === 'function') {
      return window.I18n.tr(key, replacements);
    }
  } catch (_) { /* ignore */ }
  const currentLang = localStorage.getItem('language') || 'zh-CN';
  let text = window.translations?.[currentLang]?.[key] || window.translations?.['zh-CN']?.[key] || ''; // legacy fallback inside trContent
  if (!text) return '';
  for (const ph in replacements) {
    text = text.replace(`{${ph}}`, replacements[ph]);
  }
  return text;
}

/**
 * 从 Readability.js 提取内容 (同步函数)
 * @returns {string}
 */
function extractWithReadability() {
  try {
    if (typeof Readability === 'undefined') {
      console.error('[InfinPilot] Readability library not loaded.');
      const currentLang = localStorage.getItem('language') || 'zh-CN';
      return trContent('readabilityNotLoaded') || '错误：无法加载页面内容提取库。';
    }
    const documentClone = document.cloneNode(true);
    const reader = new Readability(documentClone);
    const article = reader.parse();
    let content = '';
    if (article && article.textContent) {
      content = article.textContent;
      content = content.replace(/\s+/g, ' ').trim(); // 规范化空白字符
    } else {
      console.warn('[InfinPilot] Readability could not parse the page content. Falling back to body text.');
      content = document.body.textContent || '';
      content = content.replace(/\s+/g, ' ').trim();
      if (!content) {
        const currentLang = localStorage.getItem('language') || 'zh-CN';
        return trContent('unableToExtractContent') || 'Unable to extract page content.';
      }
      const currentLang = localStorage.getItem('language') || 'zh-CN';
      const fallbackPrefix = trContent('fallbackToBodyText') || '(Fallback to body text) ';
      content = fallbackPrefix + content; // 标记为后备提取
    }
    const maxLength = 500000; // 限制最大长度
    if (content.length > maxLength) {
      const truncatedSuffix = trContent('contentTruncated') || '...(Content truncated)';
      content = content.substring(0, maxLength) + truncatedSuffix;
    }
    return content;

  } catch (error) {
    console.error('[InfinPilot] Error extracting page content with Readability:', error);
    const currentLang = localStorage.getItem('language') || 'zh-CN';
    const errorTemplate = trContent('extractionError') || '提取页面内容时出错: {error}';
    return errorTemplate.replace('{error}', error.message);
  }
}

/**
 * 从 PDF.js 渲染的 DOM 结构中提取文本 (同步函数)
 * @returns {string}
 */
function extractFromPdfJsDom() {
  let pdfText = '';
  // 尝试常见的 PDF.js viewer 容器选择器
  const viewer = document.getElementById('viewer') ||
    document.getElementById('viewerContainer') ||
    document.querySelector('.pdfViewer'); // 尝试常见的类名

  if (viewer && typeof viewer.innerText === 'string' && viewer.innerText.trim()) {
    // 使用 innerText 通常能较好地获取屏幕阅读器可见的文本内容
    pdfText = viewer.innerText.trim();
    console.log('[InfinPilot] Extracted text from PDF.js viewer DOM using innerText, length:', pdfText.length);
  } else {
    // 如果 viewer.innerText 失败，尝试更具体地从 textLayer 提取
    const textLayers = document.querySelectorAll('.textLayer');
    if (textLayers.length > 0) {
      let combinedText = [];
      textLayers.forEach(layer => {
        // 获取该层内所有可能包含文本片段的 span 元素
        const spans = layer.querySelectorAll('span');
        let layerText = '';
        spans.forEach(span => {
          // 检查确保如果 span 有实际文本内容且不是纯粹的间隔符
          if (span.textContent && span.textContent.trim() !== '') {
            layerText += span.textContent;
          }
        });
        combinedText.push(layerText);
      });
      pdfText = combinedText.join('\n').trim(); // 用换行符连接不同层的文本
      if (pdfText) {
        console.log('[InfinPilot] Extracted text by combining .textLayer span contents, length:', pdfText.length);
      }
    }
  }

  if (pdfText) {
    const currentLang = localStorage.getItem('language') || 'zh-CN';
    const defaultTitle = trContent('embeddedPdfTitle') || 'Embedded PDF';
    const title = document.title || defaultTitle;
    // 规范化提取过程中可能产生的多余空格和换行
    pdfText = pdfText.replace(/\s\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    return `Title: ${title}\n\n${pdfText}`;
  }

  const currentLang = localStorage.getItem('language') || 'zh-CN';
  const fallbackMessage = trContent('pdfExtractionFailed') || 'Failed to extract text from PDF.js viewer DOM, falling back to Readability.';
  console.warn(`[InfinPilot] ${fallbackMessage}`);
  return extractWithReadability(); // 如果 DOM 提取没有结果，则回退
}


// --- 主题检测与发送 ---
/**
 * 检测网页当前的显式或系统颜色模式偏好，并发送给侧边栏 iframe
 */
function detectAndSendTheme() {
  const iframe = document.getElementById('infinpilot-panel-iframe');
  if (!iframe || !iframe.contentWindow) {
    // console.log('[InfinPilot] Sidepanel iframe not ready for theme update.');
    return; // 如果 iframe 不存在或未加载完成，则不发送
  }

  let detectedTheme = 'system'; // 默认为 'system'，表示未检测到明确主题或依赖系统

  // 1. 检查 HTML data-color-mode 属性 (GitHub 使用) - 最高优先级
  const dataColorMode = document.documentElement.getAttribute('data-color-mode');
  if (dataColorMode) {
    const mode = dataColorMode.toLowerCase();
    if (mode.includes('dark')) {
      detectedTheme = 'dark';
    } else if (mode.includes('light')) {
      detectedTheme = 'light';
    }
    console.log(`[InfinPilot content.js] Detected theme via data-color-mode: ${detectedTheme}`);
  }

  // 2. 如果 data-color-mode 未明确指定，检查 HTML data-theme 属性
  if (detectedTheme === 'system') {
    const dataTheme = document.documentElement.getAttribute('data-theme');
    if (dataTheme) {
      const theme = dataTheme.toLowerCase();
      if (theme.includes('dark')) {
        detectedTheme = 'dark';
      } else if (theme.includes('light')) {
        detectedTheme = 'light';
      }
      console.log(`[InfinPilot content.js] Detected theme via data-theme: ${detectedTheme}`);
    }
  }

  // 3. 如果以上属性都未明确指定，检查 body class (更灵活的匹配)
  if (detectedTheme === 'system') {
    const bodyClasses = document.body.classList;
    // 检查常见的深色模式类名
    if (bodyClasses.contains('dark-mode') || bodyClasses.contains('theme-dark') || bodyClasses.contains('dark')) {
      detectedTheme = 'dark';
      // 检查常见的浅色模式类名
    } else if (bodyClasses.contains('light-mode') || bodyClasses.contains('theme-light') || bodyClasses.contains('light')) {
      detectedTheme = 'light';
    }
    if (detectedTheme !== 'system') {
      console.log(`[InfinPilot content.js] Detected theme via body class: ${detectedTheme}`);
    }
  }

  // 4. 如果 HTML 标记和类名都未明确指定，最后回退到 prefers-color-scheme
  if (detectedTheme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    // 只有在系统偏好明确时才覆盖 'system'
    if (prefersDark.media !== 'not all') { // 检查媒体查询是否有效
      detectedTheme = prefersDark.matches ? 'dark' : 'light';
      console.log(`[InfinPilot content.js] Detected theme via prefers-color-scheme: ${detectedTheme}`);
    } else {
      console.log('[InfinPilot content.js] prefers-color-scheme media query is not valid, keeping theme as system/default.');
      // 在这种情况下，detectedTheme 为 'system' 或 'light' (取决于你的默认偏好)
      detectedTheme = 'light'; // 明确设置为浅色作为最终回退
    }
  }

  console.log(`[InfinPilot content.js] Detected theme: ${detectedTheme}. Sending to sidepanel.`); // 调试日志

  iframe.contentWindow.postMessage({
    action: 'webpageThemeDetected', // 更改 action 名称
    theme: detectedTheme // 发送检测到的主题 ('dark', 'light', 'system')
  }, '*');
}

// 监听系统/浏览器主题变化 (仅当未检测到 HTML 显式主题时，系统变化才有意义)
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
function handleSystemThemeChange(event) {
  console.log(`[InfinPilot content.js] System theme changed event detected. prefersDark: ${event.matches}`);
  // 重新运行检测逻辑，它会优先检查 HTML 属性/类，只有在没有显式设置时才会使用系统偏好
  detectAndSendTheme();
}

// 使用 addEventListener 替代旧的 addListener
if (mediaQuery.addEventListener) {
  mediaQuery.addEventListener('change', handleSystemThemeChange);
} else if (mediaQuery.addListener) { // 兼容旧版浏览器
  mediaQuery.addListener(handleSystemThemeChange);
}
// --- 结束：主题检测与发送 ---


// 监听iframe内部的消息
window.addEventListener('message', (event) => {
  // 确保消息来源是我们的iframe
  const iframeElement = document.getElementById('infinpilot-panel-iframe');
  if (!iframeElement || event.source !== iframeElement.contentWindow) {
    // console.log("Ignoring message not from infinpilot-panel-iframe", event.origin, event.source);
    return; // 仅处理来自特定iframe的消息
  }

  const iframe = iframeElement; // Use the already retrieved iframe element

  if (event.data.action === 'closePanel') {
    hidePanel();
  }
  else if (event.data.action === 'requestPageContent') {
    (async () => {
        const extractionPromise = extractPageContent();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Internal extraction timed out after 18 seconds')), 18000)
        );

        try {
            const content = await Promise.race([extractionPromise, timeoutPromise]);
            let showSuccess = false;
            if (!messageShownForThisPageView) {
                showSuccess = true;
                messageShownForThisPageView = true;
            }
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({
                    action: 'pageContentExtracted',
                    content: content,
                    showSuccessMessage: showSuccess
                }, '*');
            }
        } catch (error) {
            console.error('[InfinPilot] Content extraction failed (either by error or internal timeout):', error);
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({
                    action: 'pageContentExtracted',
                    content: `Error extracting page content: ${error.message}`,
                    showSuccessMessage: false
                }, '*');
            }
        }
    })();
  }
  // 添加复制文本的功能
  else if (event.data.action === 'copyText') {
    // 使用Clipboard API复制文本
    const text = event.data.text;

    // 创建一个临时的textarea元素
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';  // 避免滚动到底部
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);

    // 选择文本并复制
    textarea.select();
    textarea.setSelectionRange(0, 99999);  // 对于移动设备

    try {
      // 尝试使用document.execCommand进行复制 (对所有浏览器兼容)
      const success = document.execCommand('copy');
      if (success) {
        // 获取iframe元素并通知复制成功
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            action: 'copySuccess'
          }, '*');
        }
      } else {
        console.error('[InfinPilot] Copy failed via execCommand');
      }
    } catch (err) {
      console.error('[InfinPilot] Error copying text:', err);
    }

    // 移除临时元素
    document.body.removeChild(textarea);
  }
  // 处理主面板iframe请求主题检测（扩展重载后Chrome API失效时的代理）
  else if (event.data.action === 'requestThemeFromIframe') {
    console.log('[Content] Iframe requested theme detection');
    detectAndSendTheme();
  }
});

// 初始运行
// 在页面加载完成后立即发送主题更新消息
window.addEventListener('load', () => {
  // initInfinpilotPanel(); // 考虑是否在load时立即初始化，或者按需初始化
  detectAndSendTheme(); // 页面加载完成后立即发送主题
});



/**
 * 处理语言变化
 */
function handleLanguageChangeInContent(newLanguage) {
  // 更新划词助手的语言缓存
  if (window.currentLanguageCache !== undefined) {
    window.currentLanguageCache = newLanguage;
    console.log('[Content] Updated language cache to:', newLanguage);
  }

  // 通知主面板语言变化
  const iframe = document.getElementById('infinpilot-panel-iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({
      action: 'languageChanged',
      newLanguage: newLanguage
    }, '*');
  }

  // 通知划词助手语言变化
  if (window.handleTextSelectionHelperLanguageChange) {
    window.handleTextSelectionHelperLanguageChange(newLanguage);
  }
}

/**
 * 处理划词助手设置变化
 */
function handleTextSelectionHelperSettingsChange(newSettings) {
  // 通知划词助手设置变化
  if (window.handleTextSelectionHelperSettingsUpdate) {
    window.handleTextSelectionHelperSettingsUpdate(newSettings);
  }
}

/**
 * 处理扩展重载
 */
function handleExtensionReload() {
  // 重新初始化所有组件
  console.log('[Content] Reinitializing after extension reload');

  // 检查并重新初始化必要的库
  checkAndReinitializeLibraries();

  // 重新检测主题
  detectAndSendTheme();

  // 重新初始化划词助手（如果存在）
  if (window.reinitializeTextSelectionHelper) {
    window.reinitializeTextSelectionHelper();
  } else {
    // 如果划词助手函数不存在，尝试重新初始化
    console.log('[Content] TextSelectionHelper not found, attempting to reinitialize');
    if (typeof initTextSelectionHelper === 'function') {
      initTextSelectionHelper();
    }
  }

  // 通知主面板扩展已重载
  const iframe = document.getElementById('infinpilot-panel-iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({
      action: 'extensionReloaded'
    }, '*');
  }
}

/**
 * 检查库的可用性
 */
function checkLibrariesAvailability() {
  const missing = [];

  // 检查Readability库
  if (typeof Readability === 'undefined') {
    missing.push('Readability');
  }

  // 检查markdown-it库
  if (typeof markdownit === 'undefined' && typeof window.markdownit === 'undefined') {
    missing.push('markdown-it');
  }

  // 检查translations对象
  if (typeof window.translations === 'undefined') {
    missing.push('translations');
  }

  // 检查MarkdownRenderer
  if (typeof window.MarkdownRenderer === 'undefined') {
    missing.push('MarkdownRenderer');
  }

  // 检查划词助手
  if (typeof initTextSelectionHelper === 'undefined') {
    missing.push('TextSelectionHelper');
  }

  return {
    allAvailable: missing.length === 0,
    missing: missing
  };
}

/**
 * 检查并重新初始化必要的库
 */
function checkAndReinitializeLibraries() {
  console.log('[Content] Checking library availability...');

  const availability = checkLibrariesAvailability();

  if (availability.allAvailable) {
    console.log('[Content] All libraries are available');
  } else {
    console.warn('[Content] Missing libraries after extension reload:', availability.missing);
  }

  // 检查划词助手
  if (typeof initTextSelectionHelper === 'undefined') {
    console.warn('[Content] TextSelectionHelper not available after extension reload');
  } else {
    console.log('[Content] TextSelectionHelper is available');
  }
}

// 保存全局状态变量到window对象，防止重复声明
window.panelActive = panelActive;

} // 结束防重复初始化检查
