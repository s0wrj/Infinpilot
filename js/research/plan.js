// InfinPilot Deep Research - Plan schema & helpers
(function(){
  const PlanStepType = { RESEARCH: 'research', PROCESSING: 'processing' };

  function validatePlan(obj){
    if(!obj || typeof obj !== 'object') return { ok:false, error:'Plan is not an object' };
    if(typeof obj.locale !== 'string') return { ok:false, error:'Missing locale' };
    if(typeof obj.has_enough_context !== 'boolean') return { ok:false, error:'Missing has_enough_context' };
    if(typeof obj.title !== 'string') return { ok:false, error:'Missing title' };
    if(!Array.isArray(obj.steps)) return { ok:false, error:'Missing steps' };
    for(const [i, s] of obj.steps.entries()){
      if(typeof s.need_search !== 'boolean') return { ok:false, error:`steps[${i}].need_search missing` };
      if(typeof s.title !== 'string') return { ok:false, error:`steps[${i}].title missing` };
      if(typeof s.description !== 'string') return { ok:false, error:`steps[${i}].description missing` };
      if(![PlanStepType.RESEARCH, PlanStepType.PROCESSING].includes(s.step_type)){
        return { ok:false, error:`steps[${i}].step_type invalid` };
      }
    }
    return { ok:true };
  }

  function tryRepairPlanText(text){
    if (typeof text !== 'string') return null;

    // Find the first opening curly brace and the last closing curly brace.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
        return null;
    }

    // Extract the potential JSON string.
    const potentialJson = text.substring(firstBrace, lastBrace + 1);

    try {
        // Attempt to parse the extracted string.
        return JSON.parse(potentialJson);
    } catch (e) {
        // If parsing fails, it's not a valid plan.
        console.warn('[plan.js] Failed to parse extracted JSON:', e);
        return null;
    }
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.plan = {
    PlanStepType,
    validatePlan,
    tryRepairPlanText,
  };
})();