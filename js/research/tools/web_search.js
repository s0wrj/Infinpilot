// InfinPilot Deep Research - Web Search (DuckDuckGo HTML adapter)
(function(){
  async function webSearch(query, { maxResults = 10 } = {}){
    let allResults = [];
    let nextUrl = null; // Start with no specific next URL
    let hasMore = true;

    // Keep fetching until we have enough results or there are no more pages
    while (allResults.length < maxResults && hasMore) {
      try {
        const response = await new Promise((resolve, reject) => {
          browser.runtime.sendMessage({ 
            action: 'deepResearch.webSearch', 
            query, 
            maxResults, // Pass this along for context, though the loop here controls it
            pageUrl: nextUrl // Pass the URL for the next page, or null for the first page
          }, (resp) => {
            if (browser.runtime.lastError) {
              reject(new Error(browser.runtime.lastError.message));
              return;
            }
            resolve(resp);
          });
        });

        if (response && response.success) {
          allResults = allResults.concat(response.results || []);
          nextUrl = response.nextPageUrl; // Get the URL for the next page
          hasMore = !!nextUrl; // If there's a next page URL, we can continue
        } else {
          console.warn('[DeepResearch][webSearch] Background search failed or returned no results:', response?.error);
          hasMore = false; // Stop if there was an error
        }
      } catch (e) {
        console.error('[DeepResearch][webSearch] Error calling background search:', e);
        hasMore = false; // Stop on critical error
      }
    }

    // Return the collected results, trimmed to the exact maxResults
    return allResults.slice(0, maxResults);
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.tools = window.DeepResearch.tools || {};
  window.DeepResearch.tools.webSearch = webSearch;
})();