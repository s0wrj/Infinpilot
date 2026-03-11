// InfinPilot Deep Research - Settings load/save
(function(){
  const STORAGE_KEY = 'deepResearchSettings';
  const defaults = {
    locale: 'zh-CN',
    reportStyle: 'academic',
    enableDeepThinking: false,
    enableBackgroundInvestigation: false,
    maxPlanIterations: 1,
    maxStepNum: 3,
    maxSearchResults: 3,
  };

  let cache = { ...defaults };

  async function load(){
    try{
      const result = await browser.storage.sync.get([STORAGE_KEY]);
      const s = result?.[STORAGE_KEY] || {};
      cache = { ...defaults, ...s };
    }catch(e){ console.warn('[DeepResearch][settings] load failed', e); }
    return cache;
  }

  async function save(newSettings){
    cache = { ...cache, ...newSettings };
    try{
      await browser.storage.sync.set({ [STORAGE_KEY]: cache });
    }catch(e){ console.warn('[DeepResearch][settings] save failed', e); }
    return cache;
  }

  function get(){ return cache; }

  // init load on startup
  load();

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.settings = { get, load, save, defaults };
})();