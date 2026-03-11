class ContentAutomation {
    constructor() {
        this.elementRefRegistry = new Map();
        this.nextElementRefId = 0;
    }

    init() {
        browser.runtime.onMessage.addListener(this.handleMessage.bind(this));
        // Reset registry on page navigation to prevent stale references
        window.addEventListener('beforeunload', this.resetRegistry.bind(this));
        window.addEventListener('pageshow', this.resetRegistry.bind(this));
    }

    resetRegistry() {
        if (this.elementRefRegistry.size > 0) {
            console.log(`[ContentAutomation] Resetting element reference registry (${this.elementRefRegistry.size} items) due to navigation.`);
            this.elementRefRegistry.clear();
            this.nextElementRefId = 0;
        }
    }

    // +++ NEW HELPER METHODS FOR SHADOW DOM +++
    _querySelectorAllDeep(selector, root = document) {
        let results = [];
        try {
            results.push(...root.querySelectorAll(selector));
        } catch (e) {
            console.warn(`[ContentAutomation] Invalid selector "${selector}" for root`, root);
        }

        const allElements = root.querySelectorAll('*');
        for (const element of allElements) {
            if (element.shadowRoot) {
                const nestedResults = this._querySelectorAllDeep(selector, element.shadowRoot);
                results.push(...nestedResults);
            }
        }
        return results;
    }

    _querySelectorDeep(selector, root = document) {
        try {
            const found = root.querySelector(selector);
            if (found) return found;
        } catch (e) {
            console.warn(`[ContentAutomation] Invalid selector "${selector}" for root`, root);
        }

        const allElements = root.querySelectorAll('*');
        for (const element of allElements) {
            if (element.shadowRoot) {
                const foundInShadow = this._querySelectorDeep(selector, element.shadowRoot);
                if (foundInShadow) {
                    return foundInShadow;
                }
            }
        }
        return null;
    }

    handleMessage(message, sender, sendResponse) {
        if (!message.action || !message.action.startsWith('dom.')) {
            return;
        }

        const rawTool = message.action.substring(4);
        const args = message.args || {};
        const nameMap = {
            'get_interactive_elements': 'getInteractiveElements',
            'get_page_text': 'getPageText',
            'get_value': 'getValue',
            'scroll_into_view': 'scrollIntoView',
            'find_element': 'findElement',
            'search_page_text': 'searchPageText',
            'get_page_links': 'getPageLinks',
            'get_page_images': 'getPageImages',
            'go_back': 'goBack',
            'go_forward': 'goForward',
            'select_option': 'selectOption',
            'wait_for_selector': 'waitForSelector',
            'wait_for_network_idle': 'waitForNetworkIdle',
            'sleep': 'sleep',
            // 新增：智能搜索功能
            'find_similar': 'findSimilar',
            'find_by_text': 'findByText',
            'find_by_regex': 'findByRegex',
            'find_by_filter': 'findByFilter'
        };
        const tool = nameMap[rawTool] || rawTool;

        let promise;
        switch (tool) {
            case 'getInteractiveElements':
                promise = this.getInteractiveElements();
                break;
            case 'getPageText':
                promise = this.getPageText();
                break;
            case 'click':
                promise = this.click(args);
                break;
            case 'fill':
                promise = this.fill(args);
                break;
            case 'clear':
                promise = this.clear(args);
                break;
            case 'getValue':
                promise = this.getValue(args);
                break;
            case 'scrollIntoView':
                promise = this.scrollIntoView(args);
                break;
            case 'highlight':
                promise = this.highlight(args);
                break;
            case 'hover':
                promise = this.hover(args);
                break;
            case 'search_page_text':
                promise = this.searchPageText(args);
                break;
            case 'get_page_links':
                promise = this.getPageLinks();
                break;
            case 'get_page_images':
                promise = this.getPageImages();
                break;
            case 'find_element':
                promise = this.findElement(args);
                break;
            case 'submit':
                promise = this.submit(args);
                break;
            case 'goBack':
                promise = this.goBack();
                break;
            case 'goForward':
                promise = this.goForward();
                break;
            case 'selectOption':
                promise = this.selectOption(args);
                break;
            case 'waitForSelector':
                promise = this.waitForSelector(args);
                break;
            case 'waitForNetworkIdle':
                promise = this.waitForNetworkIdle(args);
                break;
            case 'sleep':
                promise = this.sleep(args);
                break;
            case 'findSimilar':
                promise = this.findSimilar(args);
                break;
            case 'findByText':
                promise = this.findByText(args);
                break;
            case 'findByRegex':
                promise = this.findByRegex(args);
                break;
            case 'findByFilter':
                promise = this.findByFilter(args);
                break;
            case 'screenshot':
                promise = this.screenshot(args);
                break;
            default:
                promise = Promise.reject(new Error(`Unknown DOM tool: ${tool}`));
        }

        promise.then(result => {
            sendResponse({ success: true, data: result });
        }).catch(error => {
            sendResponse({ success: false, message: error.message });
        });

        return true; // Indicates that the response is sent asynchronously
    }

    waitForNetworkIdle(args) {
        const { idleMs = 500, timeoutMs = 10000 } = args || {};

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                clearInterval(interval);
                resolve({ completed: false, reason: 'timeout' });
            }, timeoutMs);

            let lastResourceCount = performance.getEntriesByType('resource').length;
            let idleTime = 0;
            const checkInterval = 100; // Check every 100ms

            const interval = setInterval(() => {
                const currentResourceCount = performance.getEntriesByType('resource').length;

                if (currentResourceCount === lastResourceCount) {
                    idleTime += checkInterval;
                } else {
                    idleTime = 0; // Reset idle timer
                    lastResourceCount = currentResourceCount;
                }

                if (idleTime >= idleMs) {
                    clearInterval(interval);
                    clearTimeout(timeout);
                    resolve({ completed: true, reason: 'idle' });
                }
            }, checkInterval);
        });
    }

    getElement(args) {
        if (args.elementRef) {
            const element = this.elementRefRegistry.get(args.elementRef);
            if (!element) {
                throw new Error(`Element with ref ${args.elementRef} not found`);
            }
            return element;
        }
        if (args.selector) {
            const element = this._querySelectorDeep(args.selector);
            if (!element) {
                throw new Error(`Element with selector "${args.selector}" not found (searched in Shadow DOM)`);
            }
            return element;
        }
        throw new Error('Either elementRef or selector must be provided');
    }

    getPageText() {
        return Promise.resolve(document.body.innerText);
    }

    // More robust click: synthesizes pointer/mouse sequence with center coords
    click(args) {
        return new Promise((resolve) => {
            const element = this.getElement(args);
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const rect = element.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const seq = ['pointerover','mouseover','mouseenter','pointerdown','mousedown','pointerup','mouseup','click'];
            for (const type of seq) {
                const evt = new MouseEvent(type, {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy
                });
                element.dispatchEvent(evt);
            }
            resolve();
        });
    }

    // Enhanced fill: supports input/textarea and contenteditable with events
    fill(args) {
        return new Promise((resolve) => {
            const element = this.getElement(args);
            const text = args.text != null ? String(args.text) : '';
            const isEditable = element.isContentEditable;
            if (isEditable) {
                element.focus();
                // Clear existing content
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(element);
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('insertText', false, '');
                document.execCommand('insertText', false, text);
            } else {
                // Prefer typing simulation for React/Vue synthetic events compatibility
                element.focus();
                element.value = '';
                element.dispatchEvent(new Event('input', { bubbles: true }));
                for (const ch of text) {
                    element.value += ch;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                }
                element.dispatchEvent(new Event('change', { bubbles: true }));
            }
            resolve();
        });
    }

    clear(args) {
        return new Promise((resolve) => {
            const element = this.getElement(args);
            element.value = '';
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            resolve();
        });
    }

    getValue(args) {
        return new Promise((resolve) => {
            const element = this.getElement(args);
            resolve(element.value);
        });
    }

    scrollIntoView(args) {
        return new Promise((resolve) => {
            const element = this.getElement(args);
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            resolve();
        });
    }

    highlight(args) {
        return new Promise((resolve) => {
            const element = this.getElement(args);
            element.style.border = '2px solid red';
            setTimeout(() => {
                element.style.border = '';
            }, 3000);
            resolve();
        });
    }

   hover(args) {
       return new Promise((resolve) => {
           const element = this.getElement(args);
           element.scrollIntoView({ behavior: 'smooth', block: 'center' });
           const rect = element.getBoundingClientRect();
           const centerX = rect.left + rect.width / 2;
           const centerY = rect.top + rect.height / 2;
           ['mousemove','mouseover','mouseenter'].forEach(type => {
               const evt = new MouseEvent(type, {
                   view: window,
                   bubbles: true,
                   cancelable: true,
                   clientX: centerX,
                   clientY: centerY
               });
               element.dispatchEvent(evt);
           });
           resolve();
       });
   }

    isVisible(element) {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null;
    }

    searchPageText(args) {
        return new Promise((resolve) => {
            const query = args.query.toLowerCase();
            const text = document.body.innerText.toLowerCase();
            const snippets = [];
            let lastIndex = -1;
            while ((lastIndex = text.indexOf(query, lastIndex + 1)) !== -1) {
                const start = Math.max(0, lastIndex - 50);
                const end = Math.min(text.length, lastIndex + query.length + 50);
                snippets.push(`...${text.substring(start, end)}...`);
            }
            resolve(snippets.slice(0, 10)); // Limit to 10 snippets
        });
    }

    _summarizeLinks(list) {
        // Group by origin and take top 5 per origin, prioritize links with text
        const byOrigin = new Map();
        list.forEach(({ href, text }) => {
            try {
                const origin = new URL(href, window.location.href).origin;
                if (!byOrigin.has(origin)) byOrigin.set(origin, []);
                byOrigin.get(origin).push({ href, text });
            } catch (_) {
                // ignore
            }
        });
        const groups = [];
        for (const [origin, items] of byOrigin.entries()) {
            const top = items
                .map(x => ({ ...x, _score: (x.text && x.text.trim() ? Math.min(2, x.text.trim().length / 10) : 0) }))
                .sort((a,b) => b._score - a._score)
                .slice(0, 5)
                .map(({ href, text }) => ({ href, text }));
            groups.push({ origin, count: items.length, top });
        }
        return { total: list.length, groups };
    }

    getPageLinks() {
        return new Promise((resolve) => {
            const links = this._querySelectorAllDeep('a')
                .filter(a => this.isVisible(a) && a.href)
                .map(a => ({ href: a.href, text: a.innerText.trim() }));
            const limited = links.slice(0, 100);
            resolve({ summary: this._summarizeLinks(limited), items: limited }); // Summary + raw items
        });
    }

    getPageImages() {
        return new Promise((resolve) => {
            const images = this._querySelectorAllDeep('img')
                .filter(img => this.isVisible(img) && img.src)
                .map(img => ({ src: img.src, alt: img.alt.trim() }));
            resolve(images.slice(0, 100)); // Limit to 100 images
        });
    }

    findElement(args) {
        return new Promise((resolve, reject) => {
            let element = null;
            const { by, selectorOrText } = args;

            if (by === 'css') {
                element = this._querySelectorDeep(selectorOrText);
            } else if (by === 'text') {
                // This XPath does not pierce Shadow DOM. This is a known limitation.
                const xpath = `//*[contains(text(), "${selectorOrText}")]`;
                element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            } else if (by === 'role') {
                element = this._querySelectorDeep(`[role="${selectorOrText}"]`);
            } else if (by === 'best') {
                const selectors = [
                    `[data-testid="${selectorOrText}"]`,
                    `[aria-label="${selectorOrText}"]`,
                    `[name="${selectorOrText}"]`,
                    `[title="${selectorOrText}"]`,
                    `[placeholder="${selectorOrText}"]`,
                    `[alt="${selectorOrText}"]`
                ];

                for (const selector of selectors) {
                    const foundEl = this._querySelectorDeep(selector);
                    if (foundEl && this.isVisible(foundEl)) {
                        element = foundEl;
                        break;
                    }
                }

                if (!element) {
                    try {
                        // Fallback to text search (will not pierce shadow DOM)
                        const xpath = `//*[contains(text(), "${selectorOrText}")]`;
                        const textElement = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        if (textElement && this.isVisible(textElement)) {
                            element = textElement;
                        }
                    } catch(e) { /* ignore fallback error */ }
                }
            }

            if (element && this.isVisible(element)) { // Final visibility check
                const refId = `ref-${this.nextElementRefId++}`;
                this.elementRefRegistry.set(refId, element);
                resolve({
                    elementRef: refId,
                    tagName: element.tagName.toLowerCase(),
                    text: element.innerText || element.value,
                    selector: this.getSelector(element)
                });
            } else {
                reject(new Error(`Element not found or not visible with ${by}: "${selectorOrText}"`));
            }
        });
    }

    submit(args) {
        return new Promise((resolve, reject) => {
            const element = this.getElement(args); // Can take elementRef or selector
            const form = element.closest('form');
            if (form) {
                form.submit();
                resolve();
            } else {
                reject(new Error('No parent form found for the specified element'));
            }
        });
    }

    // Observation Summary helper
    _summarizeInteractiveElements(list) {
        if (!Array.isArray(list)) return { total: 0, top: [] };
        // Simple heuristic: prioritize buttons/links with text, cap to top 15
        const scored = list.map(item => {
            let score = 0;
            if (item.tagName === 'button' || item.tagName === 'a' || /button/i.test(item.selector)) score += 2;
            if (item.text && item.text.trim().length) score += Math.min(2, item.text.trim().length / 10);
            return { ...item, _score: score };
        }).sort((a,b) => b._score - a._score).slice(0, 15);
        return {
            total: list.length,
            top: scored.map(({ elementRef, tagName, text, selector }) => ({ elementRef, tagName, text, selector }))
        };
    }

    getInteractiveElements() {
        return new Promise((resolve) => {
            const selector = 'a, button, input, select, textarea, [role="button"], [onclick], [tabindex]';
            const elements = this._querySelectorAllDeep(selector);
            const interactiveElements = [];

            elements.forEach(element => {
                if (this.isVisible(element)) {
                    const refId = `ref-${this.nextElementRefId++}`;
                    this.elementRefRegistry.set(refId, element);

                    interactiveElements.push({
                        elementRef: refId,
                        tagName: element.tagName.toLowerCase(),
                        text: element.innerText || element.value || element.placeholder,
                        selector: this.getSelector(element)
                    });
                }
            });

            const limited = interactiveElements.slice(0, 50);
            resolve({ summary: this._summarizeInteractiveElements(limited), items: limited }); // Summary + raw items
        });
    }

    getSelector(element) {
        if (element.id) {
            return `#${element.id}`;
        }
        // Cannot generate reliable path for elements inside shadow DOM, return simple tag selector
        if (element.getRootNode() instanceof ShadowRoot) {
            return element.tagName.toLowerCase();
        }

        let path = '';
        while (element && element.parentElement) {
            let part = element.tagName.toLowerCase();
            const parent = element.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(child => child.tagName === element.tagName);
                if (siblings.length > 1) {
                    const index = siblings.indexOf(element) + 1;
                    part += `:nth-of-type(${index})`;
                }
            }
            path = part + (path ? ' > ' + path : '');
            element = parent;
        }
        return path;
    }

    // New tools
    goBack() {
        window.history.back();
        return Promise.resolve({ navigated: 'back' });
    }

    goForward() {
        window.history.forward();
        return Promise.resolve({ navigated: 'forward' });
    }

    selectOption(args) {
        return new Promise((resolve, reject) => {
            const selectEl = this.getElement(args);
            if (!(selectEl instanceof HTMLSelectElement)) {
                reject(new Error('Target is not a <select> element'));
                return;
            }
            const { value } = args;
            let option = null;
            if (typeof value === 'string') {
                option = Array.from(selectEl.options).find(opt => opt.value === value || opt.text === value);
            }
            if (!option) {
                reject(new Error('Option not found'));
                return;
            }
            selectEl.value = option.value;
            selectEl.dispatchEvent(new Event('input', { bubbles: true }));
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            resolve({ value: option.value, text: option.text });
        });
    }

    // Enhanced waitForSelector: supports appear, disappear, visible states
    waitForSelector(args) {
        return new Promise((resolve, reject) => {
            const { selector, timeoutMs = 5000, state = 'appear', visibility = 'any' } = args;
            if (!selector) return reject(new Error('selector is required'));
            const isVisible = (el) => {
                if (!el) return false;
                if (visibility === 'visible') {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                }
                return true;
            };

            const check = () => {
                const el = this._querySelectorDeep(selector);
                if (state === 'appear') {
                    return !!el && isVisible(el);
                } else if (state === 'disappear') {
                    return !el || !isVisible(el);
                }
                return !!el; // default
            };

            if (check()) {
                resolve({ found: true, selector, state });
                return;
            }

            const obs = new MutationObserver(() => {
                if (check()) {
                    obs.disconnect();
                    resolve({ found: true, selector, state });
                }
            });
            obs.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true });
            setTimeout(() => {
                obs.disconnect();
                resolve({ found: false, selector, state, timeout: true });
            }, timeoutMs);
        });
    }

    // Sleep utility
    sleep(args) {
        return new Promise((resolve) => {
            const ms = (args && typeof args.ms === 'number') ? args.ms : 1000;
            setTimeout(() => resolve({ slept: true, ms }), ms);
        });
    }

    screenshot(args) {
        return new Promise((resolve, reject) => {
            try {
                // Trigger background capture flow; user will select an area, then background returns dataUrl and meta
                browser.runtime.sendMessage({ action: 'captureScreenshot' })
                    .then((resp) => {
                        if (resp && resp.success) {
                            resolve(resp); // { success:true, dataUrl, url, title, capturedAt }
                        } else {
                            reject(new Error(resp?.error || 'Screenshot failed'));
                        }
                    })
                    .catch((err) => reject(err));
            } catch (e) {
                reject(e);
            }
        });
    }

    // ========== 智能搜索功能 ==========

    /**
     * 查找与给定元素相似的元素
     * 参考 Scrapling 的 find_similar 实现
     */
    findSimilar(args) {
        return new Promise((resolve, reject) => {
            const element = this.getElement(args);
            const {
                similarityThreshold = 0.2,
                ignoreAttributes = ['href', 'src', 'action', 'method', 'data-', 'aria-'],
                matchText = false,
                limit = 20
            } = args;

            const similarElements = this._findSimilarElements(
                element,
                similarityThreshold,
                ignoreAttributes,
                matchText,
                limit
            );

            const results = similarElements.map((el) => {
                const refId = `ref-sim-${this.nextElementRefId++}`;
                this.elementRefRegistry.set(refId, el);
                return {
                    elementRef: refId,
                    tagName: el.tagName?.toLowerCase(),
                    text: el.innerText?.trim() || '',
                    selector: this.getSelector(el),
                    similarity: Math.round((el._similarityScore || 0) * 100) / 100
                };
            });

            resolve({
                original: {
                    tagName: element.tagName?.toLowerCase(),
                    text: element.innerText?.trim() || '',
                    selector: this.getSelector(element),
                    attributes: this._getElementAttributes(element)
                },
                count: results.length,
                elements: results
            });
        });
    }

    _findSimilarElements(element, threshold, ignoreAttrs, matchText, limit) {
        const similar = [];
        const root = document.body;

        // 获取当前元素的特征 - 参考 Scrapling 实现
        const currentDepth = this._getDepth(element);
        const tagName = element.tagName;
        const parent = element.parentElement;
        const parentTag = parent?.tagName;
        const grandparent = parent?.parentElement;
        const grandparentTag = grandparent?.tagName;

        // 构建忽略属性前缀列表
        const ignorePrefixes = ignoreAttrs.filter(a => a.endsWith('-'));

        // 获取当前元素的属性
        const currentAttrs = {};
        for (const attr of element.attributes) {
            // 跳过忽略的属性
            if (ignoreAttrs.includes(attr.name)) continue;
            if (ignorePrefixes.some(p => attr.name.startsWith(p))) continue;
            currentAttrs[attr.name] = attr.value;
        }

        // 使用 XPath 高效查找相同深度的相同标签元素
        const xpath = `//${tagName}[count(ancestor::*) = ${currentDepth}]`;
        const iterator = document.evaluate(
            xpath,
            root,
            null,
            XPathResult.ORDERED_NODE_ITERATOR_TYPE,
            null
        );

        let node;
        while ((node = iterator.iterateNext())) {
            if (node === element) continue;

            // 检查父级标签
            const candParent = node.parentElement;
            if (!candParent || candParent.tagName !== parentTag) continue;

            // 检查祖父级标签
            const candGrandparent = candParent?.parentElement;
            if (grandparentTag && candGrandparent?.tagName !== grandparentTag) continue;

            // 计算相似度
            const similarity = this._calculateSimilarity(
                currentAttrs,
                node,
                ignoreAttrs,
                ignorePrefixes,
                matchText ? element.innerText : null
            );

            if (similarity >= threshold) {
                node._similarityScore = similarity;
                similar.push(node);
            }

            if (similar.length >= limit * 2) break; // 获取更多以便排序
        }

        return similar
            .sort((a, b) => (b._similarityScore || 0) - (a._similarityScore || 0))
            .slice(0, limit);
    }

    _getDepth(element) {
        let depth = 0;
        let current = element;
        while (current.parentElement) {
            depth++;
            current = current.parentElement;
        }
        return depth;
    }

    _calculateSimilarity(attrs, element, ignoreAttrs, ignorePrefixes, text) {
        const elAttrs = {};
        for (const attr of element.attributes) {
            if (ignoreAttrs.includes(attr.name)) continue;
            if (ignorePrefixes.some(p => attr.name.startsWith(p))) continue;
            elAttrs[attr.name] = attr.value;
        }

        // 计算属性匹配比例 - 参考 Scrapling
        const allKeys = new Set([...Object.keys(attrs), ...Object.keys(elAttrs)]);
        if (allKeys.size === 0) return 1;

        let matchCount = 0;
        for (const key of allKeys) {
            if (attrs[key] === elAttrs[key]) {
                matchCount++;
            }
        }

        let similarity = matchCount / allKeys.size;

        // 如果需要匹配文本
        if (text && element.innerText) {
            const textSim = this._textSimilarity(text.trim(), element.innerText.trim());
            similarity = (similarity + textSim) / 2;
        }

        return similarity;
    }

    _textSimilarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;

        // 简单的词级别相似度 (Jaccard)
        const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
        const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

        if (wordsA.size === 0 || wordsB.size === 0) return 0;

        const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
        const union = new Set([...wordsA, ...wordsB]);

        return intersection.size / union.size;
    }

    /**
     * 通过文本内容查找元素 - 优化版
     * 参考 Scrapling 的 find_by_text 实现
     */
    findByText(args) {
        return new Promise((resolve) => {
            const {
                text,
                partial = true,
                caseSensitive = false,
                tagName = null,
                limit = 20,
                cleanMatch = true
            } = args;

            if (!text) {
                resolve({ error: 'text parameter is required' });
                return;
            }

            const results = [];
            let count = 0;

            // 使用 XPath 高效查找有文本内容的元素
            const xpath = cleanMatch
                ? `.//*[normalize-space(text())]`
                : `.//*`;

            const iterator = document.evaluate(
                xpath,
                document.body,
                null,
                XPathResult.ORDERED_NODE_ITERATOR_TYPE,
                null
            );

            let node;
            while ((node = iterator.iterateNext()) && count < limit * 3) {
                // 标签过滤
                if (tagName && node.tagName?.toLowerCase() !== tagName.toLowerCase()) {
                    continue;
                }

                // 获取清理后的文本
                const nodeText = cleanMatch
                    ? node.innerText?.replace(/\s+/g, ' ').trim()
                    : node.innerText;

                if (!nodeText) continue;

                // 文本匹配
                let matched = false;
                if (caseSensitive) {
                    matched = partial ? nodeText.includes(text) : nodeText === text;
                } else {
                    const lowerText = text.toLowerCase();
                    const lowerNodeText = nodeText.toLowerCase();
                    matched = partial ? lowerNodeText.includes(lowerText) : lowerNodeText === lowerText;
                }

                if (matched && this.isVisible(node)) {
                    const refId = `ref-text-${this.nextElementRefId++}`;
                    this.elementRefRegistry.set(refId, node);

                    results.push({
                        elementRef: refId,
                        tagName: node.tagName?.toLowerCase(),
                        text: nodeText,
                        selector: this.getSelector(node)
                    });
                    count++;
                }
            }

            resolve({
                query: text,
                partial,
                caseSensitive,
                count: results.length,
                elements: results.slice(0, limit)
            });
        });
    }

    /**
     * 通过正则表达式查找元素 - 优化版
     */
    findByRegex(args) {
        return new Promise((resolve) => {
            const {
                pattern,
                flags = '',
                target = 'text',
                tagName = null,
                limit = 20,
                cleanMatch = true
            } = args;

            if (!pattern) {
                resolve({ error: 'pattern parameter is required' });
                return;
            }

            let regex;
            try {
                regex = new RegExp(pattern, flags);
            } catch (e) {
                resolve({ error: 'Invalid regex pattern: ' + e.message });
                return;
            }

            const results = [];
            const selector = tagName ? tagName : '*';

            // 使用 XPath 高效查找
            const xpath = `.//${selector}[normalize-space(text())]`;
            const iterator = document.evaluate(
                xpath,
                document.body,
                null,
                XPathResult.ORDERED_NODE_ITERATOR_TYPE,
                null
            );

            let node;
            let count = 0;
            while ((node = iterator.iterateNext()) && count < limit * 3) {
                if (!this.isVisible(node)) continue;

                let matched = false;
                let matchedText = '';

                const checkMatch = (text) => {
                    if (cleanMatch) {
                        text = text.replace(/\s+/g, ' ').trim();
                    }
                    return regex.test(text);
                };

                switch (target) {
                    case 'text':
                        if (node.innerText) {
                            matched = checkMatch(node.innerText);
                            if (matched) matchedText = node.innerText;
                        }
                        break;
                    case 'html':
                        if (node.outerHTML) {
                            matched = checkMatch(node.outerHTML);
                            if (matched) matchedText = node.innerText;
                        }
                        break;
                    case 'href':
                        if (node.href) {
                            matched = regex.test(node.href);
                            if (matched) matchedText = node.href;
                        }
                        break;
                    case 'src':
                        if (node.src) {
                            matched = regex.test(node.src);
                            if (matched) matchedText = node.src;
                        }
                        break;
                }

                if (matched) {
                    const refId = `ref-regex-${this.nextElementRefId++}`;
                    this.elementRefRegistry.set(refId, node);

                    results.push({
                        elementRef: refId,
                        tagName: node.tagName?.toLowerCase(),
                        text: node.innerText?.trim() || '',
                        matchedText: matchedText?.trim() || '',
                        selector: this.getSelector(node)
                    });
                    count++;
                }
            }

            resolve({
                pattern: pattern,
                flags: flags,
                target: target,
                count: results.length,
                elements: results.slice(0, limit)
            });
        });
    }

    /**
     * 通过自定义过滤条件查找元素
     */
    findByFilter(args) {
        return new Promise((resolve) => {
            const {
                selector = '*',
                filterType, // text-contains, has-class, has-attribute, visible
                filterValue,
                limit = 20
            } = args;

            if (!filterType) {
                resolve({ error: 'filterType parameter is required' });
                return;
            }

            const elements = this._querySelectorAllDeep(selector);
            const results = [];

            for (const element of elements) {
                if (results.length >= limit) break;
                if (!this.isVisible(element)) continue;

                let matched = false;

                switch (filterType) {
                    case 'text-contains':
                        if (filterValue && element.innerText?.toLowerCase().includes(filterValue.toLowerCase())) {
                            matched = true;
                        }
                        break;
                    case 'has-class':
                        if (filterValue) {
                            matched = element.classList.contains(filterValue);
                        }
                        break;
                    case 'has-attribute':
                        if (filterValue) {
                            const [attrName, attrValue] = filterValue.split('=');
                            if (attrName && element.hasAttribute(attrName)) {
                                matched = !attrValue || element.getAttribute(attrName) === attrValue;
                            }
                        }
                        break;
                    case 'visible':
                        matched = true; // Already filtered by isVisible
                        break;
                    case 'enabled':
                        matched = !element.disabled && (element.tagName === 'INPUT' || element.tagName === 'BUTTON' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA');
                        break;
                    case 'checked':
                        matched = element.checked === true;
                        break;
                }

                if (matched) {
                    const refId = `ref-filter-${this.nextElementRefId++}`;
                    this.elementRefRegistry.set(refId, element);

                    results.push({
                        elementRef: refId,
                        tagName: element.tagName?.toLowerCase(),
                        text: element.innerText?.trim() || '',
                        selector: this.getSelector(element),
                        attributes: this._getElementAttributes(element)
                    });
                }
            }

            resolve({
                filterType: filterType,
                filterValue: filterValue,
                count: results.length,
                elements: results
            });
        });
    }

    _getElementAttributes(element) {
        const attrs = {};
        for (const attr of element.attributes) {
            attrs[attr.name] = attr.value;
        }
        return attrs;
    }
}

const contentAutomation = new ContentAutomation();
contentAutomation.init();
