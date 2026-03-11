/**
 * Scraping Tools
 * Focus on extraction quality and reliability. This module intentionally does
 * not implement stealth, anti-detection or traffic camouflage features.
 */

const REQUEST_PROFILES = {
    chrome: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
    },
    firefox: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
    },
    safari: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
    },
    edge: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
    }
};

const NOISE_SELECTOR = [
    'script',
    'style',
    'noscript',
    'iframe',
    'form',
    'nav',
    'footer',
    'aside',
    '.advertisement',
    '.ads',
    '.ad',
    '[aria-hidden="true"]'
].join(', ');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function getMetaContent(doc, selectors = []) {
    for (const selector of selectors) {
        const node = doc.querySelector(selector);
        const value = node?.getAttribute('content') || node?.textContent || '';
        const normalized = cleanText(value);
        if (normalized) {
            return normalized;
        }
    }
    return '';
}

function xpathSelect(root, xpathExpr) {
    const evaluator = new XPathEvaluator();
    try {
        const result = evaluator.evaluate(
            xpathExpr,
            root,
            null,
            XPathResult.ORDERED_NODE_ITERATOR_TYPE,
            null
        );
        const elements = [];
        let node;
        while ((node = result.iterateNext())) {
            elements.push(node);
        }
        return elements;
    } catch (error) {
        console.warn('[Scraping] XPath error:', error.message);
        return [];
    }
}

function removeNoise(root) {
    if (!root?.querySelectorAll) {
        return root;
    }
    root.querySelectorAll(NOISE_SELECTOR).forEach((node) => node.remove());
    return root;
}

function cloneWithoutNoise(element) {
    const clone = element.cloneNode(true);
    return removeNoise(clone);
}

function extractMetadata(doc, url) {
    const canonicalUrl = getMetaContent(doc, [
        'link[rel="canonical"]',
        'meta[property="og:url"]',
        'meta[name="twitter:url"]'
    ]) || url;

    return {
        title: getMetaContent(doc, [
            'meta[property="og:title"]',
            'meta[name="twitter:title"]'
        ]) || cleanText(doc.querySelector('title')?.textContent || ''),
        description: getMetaContent(doc, [
            'meta[name="description"]',
            'meta[property="og:description"]',
            'meta[name="twitter:description"]'
        ]),
        byline: getMetaContent(doc, [
            'meta[name="author"]',
            'meta[property="article:author"]',
            '[itemprop="author"]'
        ]),
        publishedTime: getMetaContent(doc, [
            'meta[property="article:published_time"]',
            'meta[name="article:published_time"]',
            'time[datetime]'
        ]),
        siteName: getMetaContent(doc, [
            'meta[property="og:site_name"]',
            'meta[name="application-name"]'
        ]),
        canonicalUrl
    };
}

function findMainContentRoot(doc) {
    const candidates = [
        'main',
        'article',
        '[role="main"]',
        '#main',
        '.main',
        '#content',
        '.content',
        '.post',
        '.article',
        '.entry-content'
    ];
    for (const selector of candidates) {
        const node = doc.querySelector(selector);
        if (node && cleanText(node.textContent).length > 80) {
            return node;
        }
    }
    return doc.body || doc.documentElement;
}

function resolveTargets(rootElement, cssSelector, xpathSelector) {
    if (xpathSelector) {
        return xpathSelect(rootElement, xpathSelector);
    }
    if (cssSelector) {
        try {
            return Array.from(rootElement.querySelectorAll(cssSelector));
        } catch (error) {
            console.warn('[Scraping] Invalid selector:', cssSelector, error.message);
            return [];
        }
    }
    return [];
}

function resolveUrl(value, baseUrl) {
    if (!value) {
        return '';
    }
    try {
        return new URL(value, baseUrl).href;
    } catch (_) {
        return value;
    }
}

function nodeToMarkdown(node, baseUrl, depth = 0) {
    if (!node) {
        return '';
    }
    if (node.nodeType === Node.TEXT_NODE) {
        return cleanText(node.textContent);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    const tag = node.tagName.toLowerCase();
    const childMarkdown = Array.from(node.childNodes)
        .map((child) => nodeToMarkdown(child, baseUrl, depth + 1))
        .filter(Boolean)
        .join(tag === 'pre' ? '' : ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (!childMarkdown && !['img', 'br', 'hr'].includes(tag)) {
        return '';
    }

    switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
            return `${'#'.repeat(Number(tag.slice(1)))} ${childMarkdown}`;
        case 'p':
        case 'section':
        case 'article':
        case 'div':
            return childMarkdown;
        case 'strong':
        case 'b':
            return `**${childMarkdown}**`;
        case 'em':
        case 'i':
            return `*${childMarkdown}*`;
        case 'a': {
            const href = resolveUrl(node.getAttribute('href'), baseUrl);
            return href ? `[${childMarkdown || href}](${href})` : childMarkdown;
        }
        case 'img': {
            const src = resolveUrl(node.getAttribute('src') || node.getAttribute('data-src'), baseUrl);
            const alt = cleanText(node.getAttribute('alt') || '');
            return src ? `![${alt}](${src})` : '';
        }
        case 'li':
            return `${'  '.repeat(Math.max(depth - 1, 0))}- ${childMarkdown}`;
        case 'ul':
        case 'ol':
            return Array.from(node.children).map((child) => nodeToMarkdown(child, baseUrl, depth + 1)).filter(Boolean).join('\n');
        case 'blockquote':
            return childMarkdown.split('\n').map((line) => `> ${line}`).join('\n');
        case 'code':
            return `\`${childMarkdown}\``;
        case 'pre':
            return `\`\`\`\n${node.textContent || ''}\n\`\`\``;
        case 'br':
            return '\n';
        case 'hr':
            return '\n---\n';
        case 'table':
            return tableToMarkdown(node);
        default:
            return childMarkdown;
    }
}

function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr'))
        .map((row) =>
            Array.from(row.querySelectorAll('th, td'))
                .map((cell) => cleanText(cell.textContent))
                .filter(Boolean)
        )
        .filter((row) => row.length > 0);

    if (rows.length === 0) {
        return '';
    }

    const header = rows[0];
    const divider = header.map(() => '---');
    const body = rows.slice(1);
    return [
        `| ${header.join(' | ')} |`,
        `| ${divider.join(' | ')} |`,
        ...body.map((row) => `| ${row.join(' | ')} |`)
    ].join('\n');
}

function extractElementContent(element, baseUrl, extractionType) {
    const clone = cloneWithoutNoise(element);
    if (extractionType === 'html') {
        return clone.outerHTML || clone.innerHTML || '';
    }
    if (extractionType === 'text') {
        return cleanText(clone.innerText || clone.textContent || '');
    }
    return nodeToMarkdown(clone, baseUrl).replace(/\n{3,}/g, '\n\n').trim();
}

function extractWholeContent(doc, html, extractionType, mainContentOnly, finalUrl) {
    const metadata = extractMetadata(doc, finalUrl);
    const baseRoot = mainContentOnly ? findMainContentRoot(doc) : (doc.documentElement || doc.body);
    const root = cloneWithoutNoise(baseRoot);

    if (extractionType === 'html') {
        return {
            title: metadata.title,
            content: root.innerHTML || html,
            metadata,
            error: null
        };
    }

    if (extractionType === 'text') {
        return {
            title: metadata.title,
            content: cleanText(root.innerText || root.textContent || ''),
            metadata,
            error: null
        };
    }

    if (typeof Readability !== 'undefined') {
        try {
            const readableDoc = doc.cloneNode(true);
            const parsed = new Readability(readableDoc).parse();
            const readableText = cleanText(parsed?.textContent || '');
            if (readableText) {
                const description = cleanText(parsed?.excerpt || metadata.description || '');
                const preface = [
                    metadata.title || parsed?.title || '',
                    description
                ].filter(Boolean).join('\n\n');
                return {
                    title: parsed?.title || metadata.title,
                    content: [preface, readableText].filter(Boolean).join('\n\n'),
                    metadata,
                    error: null
                };
            }
        } catch (_) {
            // Fall back to structural extraction below.
        }
    }

    return {
        title: metadata.title,
        content: nodeToMarkdown(root, finalUrl).replace(/\n{3,}/g, '\n\n').trim(),
        metadata,
        error: null
    };
}

function extractContent(doc, html, options, finalUrl) {
    const {
        extractionType = 'markdown',
        cssSelector = null,
        xpathSelector = null,
        mainContentOnly = true
    } = options;

    const baseRoot = mainContentOnly ? findMainContentRoot(doc) : (doc.documentElement || doc.body);
    const targets = resolveTargets(baseRoot, cssSelector, xpathSelector);
    const metadata = extractMetadata(doc, finalUrl);

    if (targets.length > 0) {
        const content = targets
            .map((element) => extractElementContent(element, finalUrl, extractionType))
            .filter(Boolean)
            .join(extractionType === 'html' ? '\n' : '\n\n');

        return {
            title: metadata.title,
            content,
            metadata,
            selectorCount: targets.length,
            error: null
        };
    }

    if (cssSelector || xpathSelector) {
        return {
            title: metadata.title,
            content: '',
            metadata,
            selectorCount: 0,
            error: `No elements found for selector: ${xpathSelector || cssSelector}`
        };
    }

    return extractWholeContent(doc, html, extractionType, mainContentOnly, finalUrl);
}

function buildRequestHeaders(url, fingerprint, headers) {
    const parsedUrl = new URL(url);
    return {
        ...(REQUEST_PROFILES[fingerprint] || REQUEST_PROFILES.chrome),
        ...headers,
        Referer: `${parsedUrl.protocol}//${parsedUrl.hostname}/`
    };
}

async function fetchWithRetries(url, fetchOptions, retries = 1) {
    let attempt = 0;
    while (true) {
        attempt += 1;
        try {
            const response = await fetch(url, fetchOptions);
            if (response.ok || attempt > retries || ![408, 500, 502, 503, 504].includes(response.status)) {
                return response;
            }
        } catch (error) {
            if (attempt > retries) {
                throw error;
            }
        }
        await sleep(Math.min(800, attempt * 250));
    }
}

export async function scraplingGet(options = {}) {
    const {
        url,
        extractionType = 'markdown',
        cssSelector = null,
        xpathSelector = null,
        fingerprint = 'chrome',
        timeout = 30000,
        headers = {},
        mainContentOnly = true,
        retries = 1
    } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const parsedUrl = new URL(url);
        const response = await fetchWithRetries(url, {
            method: 'GET',
            headers: buildRequestHeaders(url, fingerprint, headers),
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'follow'
        }, retries);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const finalUrl = response.url || parsedUrl.href;
        const result = extractContent(doc, html, {
            extractionType,
            cssSelector,
            xpathSelector,
            mainContentOnly
        }, finalUrl);

        return {
            success: true,
            url: parsedUrl.href,
            finalUrl,
            status: response.status,
            ...result
        };
    } catch (error) {
        return {
            success: false,
            error: error.name === 'AbortError' ? '请求超时' : error.message,
            url
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function scraplingBulkGet(urls, options = {}) {
    const results = await Promise.allSettled(
        (Array.isArray(urls) ? urls : []).map((url) => scraplingGet({ ...options, url }))
    );

    return results.map((result, index) => ({
        url: urls[index],
        ...(result.status === 'fulfilled'
            ? result.value
            : { success: false, error: result.reason?.message || 'Unknown error' })
    }));
}

export async function scraplingGetLinks(options = {}) {
    const { url, limit = 50 } = options;
    const result = await scraplingGet({
        ...options,
        url,
        extractionType: 'html',
        mainContentOnly: false
    });

    if (!result.success) {
        return result;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(result.content, 'text/html');
    const links = [];
    const seen = new Set();

    doc.querySelectorAll('a[href]').forEach((anchor) => {
        const href = resolveUrl(anchor.getAttribute('href'), result.finalUrl || url);
        if (!href || href.startsWith('javascript:') || href.startsWith('#') || seen.has(href)) {
            return;
        }
        seen.add(href);
        links.push({
            href,
            text: cleanText(anchor.textContent),
            title: cleanText(anchor.getAttribute('title') || '')
        });
    });

    return {
        success: true,
        url,
        finalUrl: result.finalUrl || url,
        links: links.slice(0, limit),
        count: links.length
    };
}

export async function scraplingGetImages(options = {}) {
    const { url, limit = 30 } = options;
    const result = await scraplingGet({
        ...options,
        url,
        extractionType: 'html',
        mainContentOnly: false
    });

    if (!result.success) {
        return result;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(result.content, 'text/html');
    const images = [];
    const seen = new Set();

    doc.querySelectorAll('img[src], img[data-src], img[srcset]').forEach((img) => {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(',')[0]?.trim()?.split(/\s+/)[0];
        const src = resolveUrl(raw, result.finalUrl || url);
        if (!src || seen.has(src)) {
            return;
        }
        seen.add(src);
        images.push({
            src,
            alt: cleanText(img.getAttribute('alt') || ''),
            title: cleanText(img.getAttribute('title') || '')
        });
    });

    return {
        success: true,
        url,
        finalUrl: result.finalUrl || url,
        images: images.slice(0, limit),
        count: images.length
    };
}

function extractStructuredProductList(doc, baseUrl) {
    const extracted = [];
    const seen = new Set();
    doc.querySelectorAll('[class*="product"], .product, .item, [class*="card"], article').forEach((node) => {
        const title = cleanText(
            node.querySelector('h1, h2, h3, h4, [class*="title"], .title, a')?.textContent || ''
        );
        const price = cleanText(
            node.querySelector('[class*="price"], .price, [class*="cost"], [itemprop="price"]')?.textContent || ''
        );
        const href = resolveUrl(node.querySelector('a[href]')?.getAttribute('href') || '', baseUrl);
        if (!title || seen.has(`${title}|${href}`)) {
            return;
        }
        seen.add(`${title}|${href}`);
        extracted.push({ title, price, link: href });
    });
    return extracted;
}

function extractStructuredArticleList(doc, baseUrl) {
    const extracted = [];
    const seen = new Set();
    doc.querySelectorAll('article, .post, .entry, [class*="article"], [class*="post"]').forEach((node) => {
        const title = cleanText(node.querySelector('h1, h2, h3, [class*="title"], a')?.textContent || '');
        const excerpt = cleanText(node.querySelector('p, [class*="excerpt"], [class*="summary"], [class*="desc"]')?.textContent || '');
        const link = resolveUrl(node.querySelector('a[href]')?.getAttribute('href') || '', baseUrl);
        const date = cleanText(node.querySelector('time, [class*="date"]')?.textContent || '');
        if (!title || seen.has(`${title}|${link}`)) {
            return;
        }
        seen.add(`${title}|${link}`);
        extracted.push({ title, excerpt, link, date });
    });
    return extracted;
}

function extractStructuredTables(doc) {
    return Array.from(doc.querySelectorAll('table'))
        .map((table) => {
            const rows = Array.from(table.querySelectorAll('tr'))
                .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cleanText(cell.textContent)))
                .filter((row) => row.length > 0);
            return rows.length > 0 ? { rows } : null;
        })
        .filter(Boolean);
}

export async function scraplingExtractStructured(options = {}) {
    const { url, pattern } = options;
    if (!url) {
        return { success: false, error: 'Missing url' };
    }
    if (!pattern) {
        return { success: false, error: 'Missing pattern' };
    }

    const result = await scraplingGet({
        ...options,
        url,
        extractionType: 'html',
        mainContentOnly: false
    });

    if (!result.success) {
        return result;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(result.content, 'text/html');
    removeNoise(doc);

    let data = [];
    if (pattern === 'product-list') {
        data = extractStructuredProductList(doc, result.finalUrl || url);
    } else if (pattern === 'article-list') {
        data = extractStructuredArticleList(doc, result.finalUrl || url);
    } else if (pattern === 'table') {
        data = extractStructuredTables(doc);
    } else {
        return { success: false, error: `Unsupported pattern: ${pattern}`, url };
    }

    return {
        success: true,
        url,
        finalUrl: result.finalUrl || url,
        pattern,
        count: data.length,
        data
    };
}

const ScrapingTools = {
    scraplingGet,
    scraplingBulkGet,
    scraplingGetLinks,
    scraplingGetImages,
    scraplingExtractStructured
};

export default ScrapingTools;
