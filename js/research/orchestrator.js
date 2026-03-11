// InfinPilot Deep Research - Orchestrator (FSM)
(function(){
  const bus = window.DeepResearch.eventBus;
  const { PlanStepType } = window.DeepResearch.plan;
  const agents = window.DeepResearch.agents;

  const STATUS = {
    idle:'idle', planning:'planning', executing:'executing', reporting:'reporting', done:'done', error:'error'
  };

  class ResearchSession{
    constructor(topic, settings){
      this.id = 'dr_'+Date.now();
      this.topic = topic;
      this.settings = Object.assign({ locale:'zh-CN', reportStyle:'academic', maxPlanIterations:1, maxStepNum:3, maxSearchResults:3 }, settings||{});
      this.status = STATUS.idle;
      this.level = 'Primary'; // Default research level
      this.plan = null;
      this.steps = [];
      this.activities = [];
      this.report = '';
    }
  }

  async function updateHistory(session) {
      if (!window.historyManager) return;
      const historySession = {
          id: session.id,
          type: 'deep-research',
          timestamp: Date.now(),
          title: `Deep Research: ${session.topic}`,
          data: session
      };
      await window.historyManager.upsertSession(historySession);
    }
  
async function run(session){
    try{
      session.status = STATUS.planning;
      bus.emit('research:started', { id: session.id, topic: session.topic });

      // coordinator -> assessor -> planner
      const handoff = await agents.coordinator({ content: session.topic });
      const level = await agents.assessor({ research_topic: handoff.research_topic });
      session.level = level;
      bus.emit('research:level_assessed', { id: session.id, level });

      const plan = await agents.planner({ research_topic: handoff.research_topic, settings: session.settings, level: level });
      session.plan = plan;
      session.steps = plan.steps.map(s => ({ ...s, execution_res: null }));
      bus.emit('plan:updated', { id: session.id, plan });
      await updateHistory(session);

      // execute steps
      session.status = STATUS.executing;
      for(let i=0;i<session.steps.length;i++){
        const step = session.steps[i];
        bus.emit('step:started', { id: session.id, index:i, step });
        let res;
        const context = { settings: session.settings, stepIndex: i, level: session.level, id: session.id };
        if(step.step_type === PlanStepType.RESEARCH){
          res = await agents.researcherExecuteStep(step, context);
        }else{
          res = await agents.coderExecuteStep(step, context);
        }
        session.steps[i].execution_res = res;
        bus.emit('step:completed', { id: session.id, index:i, step: session.steps[i] });
        await updateHistory(session);
      }

      // reporter
      session.status = STATUS.reporting;
      const md = await agents.reporter({ research_topic: session.topic, steps: session.steps, settings: session.settings, level: session.level });
      session.report = md;
      bus.emit('report:completed', { id: session.id, report: md }); // Restored this line

      session.status = STATUS.done;
      bus.emit('research:completed', { id: session.id });
      await updateHistory(session); // Kept at the end
    }catch(e){
      console.error('[DeepResearch][orchestrator] error', e);
      session.status = STATUS.error;
      bus.emit('error', { id: session.id, error: String(e?.message||e) });
    }
  }
  function start(topic, settings, stateRef){
    // Set the global state reference for the agents to use
    if (stateRef) {
        window.__DeepResearch_stateRef = stateRef;
    } else if (!window.__DeepResearch_stateRef) {
        // Fallback if not provided, but log a warning.
        console.warn('[DeepResearch][orchestrator] stateRef not provided to start(). Using fallback which may have a null model.');
        window.__DeepResearch_stateRef = { model: null, chatHistory: [] };
    }
    const s = new ResearchSession(topic, settings);
    setTimeout(()=>run(s), 0);
    return s;
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.orchestrator = { start, STATUS };
})();