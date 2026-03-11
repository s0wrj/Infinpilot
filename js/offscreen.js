import ScrapingTools from './scraping-tools.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'offscreen') {
        return false;
    }

    void handleOffscreenMessage(message, sendResponse);
    return true;
});

async function handleOffscreenMessage(message, sendResponse) {
    try {
        switch (message.action) {
            case 'parseReadableContent':
                sendResponse(parseReadableContent(message.html));
                return;
            case 'parseDuckDuckGoResults':
                sendResponse(parseDuckDuckGoResults(message.html));
                return;
            case 'scrapling.get':
                sendResponse(await ScrapingTools.scraplingGet(message.options));
                return;
            case 'scrapling.bulkGet':
                sendResponse({ success: true, results: await ScrapingTools.scraplingBulkGet(message.urls, message.options) });
                return;
            case 'scrapling.getLinks':
                sendResponse(await ScrapingTools.scraplingGetLinks(message.options));
                return;
            case 'scrapling.getImages':
                sendResponse(await ScrapingTools.scraplingGetImages(message.options));
                return;
            case 'scrapling.extractStructured':
                sendResponse(await ScrapingTools.scraplingExtractStructured(message.options));
                return;
            default:
                sendResponse({ success: false, error: `Unknown offscreen action: ${message.action}` });
                return;
        }
    } catch (error) {
        sendResponse({ success: false, error: error?.message || String(error) });
    }
}

function parseReadableContent(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html || '', 'text/html');
    const fallbackTitle = doc.querySelector('title')?.textContent?.trim() || '';

    try {
        if (typeof Readability !== 'undefined') {
            const article = new Readability(doc).parse();
            return {
                success: true,
                title: article?.title || fallbackTitle,
                content: article?.textContent || doc.body?.innerText || ''
            };
        }
    } catch (_) {
        // Fall back to plain text extraction.
    }

    return {
        success: true,
        title: fallbackTitle,
        content: doc.body?.innerText || ''
    };
}

function parseDuckDuckGoResults(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const results = [];
    const candidates = doc.querySelectorAll('.result, .results_links_deep, .results_links, .web-result');

    for (const node of candidates) {
        const anchor = node.querySelector('a.result__a, a[href]');
        if (!anchor) {
            continue;
        }

        let href = anchor.getAttribute('href') || '';
        if (!href) {
            continue;
        }

        try {
            const parsed = new URL(href, 'https://duckduckgo.com');
            if (parsed.hostname.includes('duckduckgo.com')) {
                const uddg = parsed.searchParams.get('uddg');
                href = uddg ? decodeURIComponent(uddg) : parsed.toString();
            }
        } catch (_) {
            continue;
        }

        if (!/^https?:\/\//.test(href)) {
            continue;
        }

        results.push({
            title: anchor.textContent?.trim() || href,
            url: href,
            snippet: node.querySelector('.result__snippet, .result__snippet.js-result-snippet, .snippet')?.textContent?.trim() || ''
        });
    }

    let nextPageUrl = null;
    const nextForm = doc.querySelector('form.results-nav, form[name="x"]');
    if (nextForm) {
        const params = new URLSearchParams();
        nextForm.querySelectorAll('input[type="hidden"]').forEach((input) => {
            if (input.name && input.value) {
                params.append(input.name, input.value);
            }
        });
        if (params.toString()) {
            nextPageUrl = `https://duckduckgo.com/html/?${params.toString()}`;
        }
    }

    return { success: true, results, nextPageUrl };
}
