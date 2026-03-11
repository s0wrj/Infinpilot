// InfinPilot Deep Research - Crawl tool
(function(){
  async function crawl(url){
    try{
      // Try to ask content script to extract readable content for arbitrary URL via background fetch
      const result = await new Promise((resolve, reject)=>{
        try{
          browser.runtime.sendMessage({ action: 'deepResearch.crawl', url }, (resp)=>{
            if(browser.runtime.lastError){ reject(new Error(browser.runtime.lastError.message)); return; }
            resolve(resp);
          });
        }catch(e){ reject(e); }
      });
      if(result && result.success && result.content){
        return { url, content: result.content, title: result.title || '' };
      }
    }catch(e){
      console.warn('[DeepResearch][crawl] background fallback failed:', e);
    }

    // Fallback 1: direct fetch + Readability (if available in this context)
    try{
      const res = await fetch(url, { method:'GET' });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      let title = doc.querySelector('title')?.textContent?.trim() || '';
      let content = '';
      if(window.Readability){
        const article = new Readability(doc).parse();
        title = article?.title || title;
        content = article?.textContent || doc.body?.innerText || '';
      }else{
        content = doc.body?.innerText || '';
      }
      return { url, content, title };
    }catch(e){
      console.warn('[DeepResearch][crawl] direct fetch failed:', e);
    }

    // Fallback 2: if current tab is same URL, try DOM extraction
    try{
      if(location.href.startsWith(url)){
        const title = document.title;
        const content = document.body?.innerText || '';
        return { url, content, title };
      }
    }catch(e){ /* ignore */ }

    return { url, content: '', title: '' };
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.tools = window.DeepResearch.tools || {};
  window.DeepResearch.tools.crawl = crawl;
})();