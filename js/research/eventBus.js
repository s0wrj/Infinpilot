// InfinPilot Deep Research - Simple Event Bus (Pub/Sub)
(function(){
  const listeners = new Map();
  function on(event, handler){
    if(!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => off(event, handler);
  }
  function off(event, handler){
    if(listeners.has(event)) listeners.get(event).delete(handler);
  }
  function emit(event, payload){
    if(listeners.has(event)){
      for(const handler of listeners.get(event)){
        try{ handler(payload); }catch(e){ console.error('[DeepResearch][eventBus] handler error', e); }
      }
    }
  }
  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.eventBus = { on, off, emit };
})();