// InfinPilot Deep Research - UI mount points in sidepanel
(function(){
  const bus = window.DeepResearch.eventBus;

  function renderResearchDock(id, topic){
    let dock = document.getElementById('deep-research-dock-' + id);
    if(dock){
        dock.scrollIntoView({ behavior: 'smooth', block: 'end' });
        return;
    }
    
    dock = document.createElement('div');
    dock.id = 'deep-research-dock-' + id;
    dock.className = 'deep-research-dock in-progress'; // Start with in-progress class
    const t = window.I18n?.tr || ((k)=>k);
    
    dock.innerHTML = `
        <div class="dr-header">
            <div class="dr-title">
                ${t('deepResearch.title') || 'Deep Research'}
                <span class="dr-title-topic">${escapeHtml(topic)}</span>
            </div>
            <div class="dr-status-container">
                <div class="dr-spinner"></div>
                <div id="dr-status-${id}" class="dr-status-text">${t('deepResearch.planning') || 'planning…'}</div>
            </div>
        </div>
        <div class="dr-body">
            <div id="dr-plan-${id}" class="dr-plan"></div>
            <div id="dr-activities-${id}" class="dr-activities"></div>
            <div id="dr-sources-${id}" class="dr-sources"></div>
            <div id="dr-report-${id}" class="dr-report"></div>
            <div id="dr-slidev-${id}" class="dr-slidev" style="margin-top:12px;"></div>
        </div>
        <div id="dr-actions-${id}" class="dr-actions">
            <button id="dr-copy-md-${id}" class="dr-action-btn">${t('deepResearch.copyReport') || 'Copy Report'}</button>
            <button id="dr-download-md-${id}" class="dr-action-btn primary">${t('deepResearch.downloadMarkdown') || 'Download Markdown'}</button>
        </div>
    `;
    const messages = document.getElementById('chat-messages');
    if(messages){ 
        messages.appendChild(dock); 
        dock.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    const planUpdatedHandler = ({ plan, id: eventId }) => {
      if (eventId !== id) return;
      const el = document.getElementById(`dr-plan-${id}`);
      const statusEl = document.getElementById(`dr-status-${id}`);
      if(statusEl) statusEl.textContent = 'Executing plan...';
      if(el){
        const t = window.I18n?.tr || ((k)=>k);
        let html = '';
        if(plan.thought){
          html += `<div style="margin-bottom: 8px; padding: 8px; border-radius: 4px; background-color: var(--secondary-bg-color); opacity: 0.8;"><strong>${t('deepResearch.thought') || 'Thought'}:</strong> ${escapeHtml(plan.thought)}</div>`;
        }
        const stepsHtml = plan.steps.map((step, i) => `<li><strong>${escapeHtml(step.title)}:</strong> ${escapeHtml(step.description)}</li>`).join('');
        html += `<div class="dr-section-title">${t('deepResearch.plan') || 'Plan'}</div><ol style="margin-top: 4px; padding-left: 20px;">${stepsHtml}</ol>`;
        el.innerHTML = html;
      }
    };

    // --- Sources Panel State & Helpers ---
    const urlSet = new Set();
    function normalizeUrl(u){
      try{ return new URL(u).toString(); }catch(_){ return null; }
    }
    function updateSourcesPanel(){
      const el = document.getElementById(`dr-sources-${id}`);
      if(!el) return;
      const t = window.I18n?.tr || ((k)=>k);
      const urls = Array.from(urlSet);
      if(urls.length === 0){
        el.innerHTML = '';
        return;
      }
      const items = urls.map(u => `<div class="dr-source-item"><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a></div>`).join('');
      el.innerHTML = `<div class="dr-section-title">${t('deepResearch.sources') || 'Sources'}</div><div class="dr-sources-list">${items}</div>`;
    }
    function addUrls(urls){
      let changed = false;
      (urls||[]).forEach(u=>{ const n = normalizeUrl(u); if(n && !urlSet.has(n)){ urlSet.add(n); changed = true; }});
      if(changed) updateSourcesPanel();
    }

    const stepStartedHandler = ({ index, step, id: eventId }) => {
      if (eventId !== id) return;
      const statusEl = document.getElementById(`dr-status-${id}`);
      const t = window.I18n?.tr || ((k)=>k);
      if(statusEl) statusEl.textContent = `${t('deepResearch.step')|| 'Step'} ${index + 1}: ${step.title}`;

      const el = document.getElementById(`dr-activities-${id}`);
      if(el){
        if (index === 0) { // Add title only for the first step
            el.innerHTML = `<div class="dr-section-title">${t('deepResearch.activities') || 'Activities'}</div>`;
        }
        const item = document.createElement('div');
        item.className = 'dr-activity';
        item.id = `dr-activity-${id}-${index}`;
        item.innerHTML = `<div style="font-weight:600;">${t('deepResearch.step')||'步骤'} ${index+1}: ${escapeHtml(step.title)}</div>`;
        el.appendChild(item);
      }
    };

    const stepCompletedHandler = ({ index, step, id: eventId }) => {
      if (eventId !== id) return;
      const holder = document.getElementById(`dr-activity-${id}-${index}`) || document.getElementById(`dr-activities-${id}`);
      if(holder){
        const done = document.createElement('div');
        done.className = 'dr-activity-done';
        const t = window.I18n?.tr || ((k)=>k);
        const summaryText = `${t('deepResearch.completed')||'完成'} · 点击展开详情`;
        done.innerHTML = `<details class="dr-activity-details"><summary style="cursor:pointer;opacity:.8;">${summaryText}</summary><pre style="white-space:pre-wrap; background-color: var(--input-background); padding: 4px; border-radius: 4px;">${escapeHtml(step.execution_res||'')}</pre></details>`;
        holder.appendChild(done);
      }
    };
    
    const reportCompletedHandler = ({ report, id: eventId }) => {
      if (eventId !== id) return;
      const dockEl = document.getElementById('deep-research-dock-' + id);
      if(dockEl) {
          dockEl.classList.remove('in-progress');
          dockEl.classList.add('is-done');
      }

      const el = document.getElementById(`dr-report-${id}`);
      if(!el) return;

      const pages = report.split(/\n---\n/);
      let current = 0;

      el.innerHTML = `
        <div class="dr-section-title">Report</div>
        <div class="report-controls">
          <button id="dr-report-prev-${id}" class="report-page-btn" title="Previous Page">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <span id="dr-report-count-${id}" class="report-page-count">1/${pages.length}</span>
          <button id="dr-report-next-${id}" class="report-page-btn" title="Next Page">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>
        <div id="dr-report-view-${id}" class="report-view" style="border:1px solid var(--border-color);border-radius:6px;padding:8px;max-height:420px;overflow:auto;"></div>
      `;

      const viewEl = document.getElementById(`dr-report-view-${id}`);
      const countEl = document.getElementById(`dr-report-count-${id}`);
      const prevBtn = document.getElementById(`dr-report-prev-${id}`);
      const nextBtn = document.getElementById(`dr-report-next-${id}`);

      function renderMermaidIn(container){
        if(typeof mermaid === 'undefined') return;
        const pres = container.querySelectorAll('pre.mermaid');
        pres.forEach(async (pre, index)=>{
          if(pre.dataset.mermaidRendered === 'true') return;
          const def = pre.textContent || '';
          if(!def) return;
          const renderId = `dr-report-${id}-m-${Date.now()}-${index}`;
          try{
            const { svg } = await mermaid.render(renderId, def);
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid';
            wrapper.innerHTML = svg;
            pre.replaceWith(wrapper);
          }catch(err){
            const div = document.createElement('div');
            div.className = 'mermaid-error';
            div.textContent = 'Mermaid 渲染失败: ' + (err?.message||String(err));
            pre.replaceWith(div);
          }
        });
      }

      function renderPage(index){
        current = Math.max(0, Math.min(pages.length - 1, index));
        const md = pages[current] || '';
        try{
          const html = window.MarkdownRenderer?.render(md) || `<pre>${escapeHtml(md)}</pre>`;
          viewEl.innerHTML = html;
          renderMermaidIn(viewEl);
        }catch(e){
          viewEl.textContent = md;
        }
        if(countEl) countEl.textContent = `${current+1}/${pages.length}`;
        if(prevBtn) prevBtn.disabled = current === 0;
        if(nextBtn) nextBtn.disabled = current === pages.length - 1;
      }

      renderPage(0);

      if(prevBtn){ prevBtn.onclick = ()=> renderPage(current - 1); }
      if(nextBtn){ nextBtn.onclick = ()=> renderPage(current + 1); }

      const st = document.getElementById(`dr-status-${id}`);
      if(st) st.textContent = 'Done';
      
      const actions = document.getElementById(`dr-actions-${id}`);
      if(actions) actions.style.display = 'flex';

      const copyBtn = document.getElementById(`dr-copy-md-${id}`);
      const dlBtn = document.getElementById(`dr-download-md-${id}`);
      if(copyBtn){
        copyBtn.onclick = async ()=>{
          try{ await navigator.clipboard.writeText(report); alert('已复制'); }catch(e){ console.error(e); }
        };
      }
      if(dlBtn){
        dlBtn.onclick = ()=>{
          const blob = new Blob([report], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `research-report-${Date.now()}.md`;
          document.body.appendChild(a);
          a.click();
          setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0);
        };
      }
    };

    const errorHandler = ({ error, id: eventId }) => {
      if (eventId !== id) return;
      const dockEl = document.getElementById('deep-research-dock-' + id);
      if(dockEl) {
          dockEl.classList.remove('in-progress');
      }
      const st = document.getElementById(`dr-status-${id}`);
      if(st) st.textContent = 'Error: '+error;
    };
    
    

   const researchCompletedHandler = ({ id: eventId }) => {
        if (eventId !== id) return;
        const dockEl = document.getElementById('deep-research-dock-' + id);
        if(dockEl) {
            dockEl.classList.remove('in-progress');
            dockEl.classList.add('is-done');
        }
        bus.off('plan:updated', planUpdatedHandler);
        bus.off('step:started', stepStartedHandler);
        bus.off('step:completed', stepCompletedHandler);
        bus.off('report:completed', reportCompletedHandler);
        bus.off('activity:search', activitySearchHandler);
        bus.off('activity:crawl', activityCrawlHandler);
        
        bus.off('error', errorHandler);
        bus.off('research:completed', researchCompletedHandler);
    };

    bus.on('plan:updated', planUpdatedHandler);
    bus.on('step:started', stepStartedHandler);
    bus.on('step:completed', stepCompletedHandler);
    bus.on('report:completed', reportCompletedHandler);

    // Collect URLs for Sources panel
    const activitySearchHandler = ({ id: eventId, results }) => {
      if (eventId !== id) return;
      const urls = (results||[]).map(r=>r.url).filter(Boolean);
      addUrls(urls);
    };
    const activityCrawlHandler = ({ id: eventId, page }) => {
      if (eventId !== id) return;
      if (page?.url) addUrls([page.url]);
    };
    bus.on('activity:search', activitySearchHandler);
    bus.on('activity:crawl', activityCrawlHandler);
    
    bus.on('error', errorHandler);
    bus.on('research:completed', researchCompletedHandler);
  }

  function escapeHtml(s){
    return (s||'').replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
  }

  function renderResearchDockFromHistory(sessionData) {
    const { id, topic, plan, steps, report, status } = sessionData;
    let dock = document.getElementById('deep-research-dock-' + id);
    if(dock) return; // Already rendered

    // 1. Create main dock element
    dock = document.createElement('div');
    dock.id = 'deep-research-dock-' + id;
    dock.className = `deep-research-dock ${status === 'done' || status === 'error' ? 'is-done' : 'in-progress'}`;
    const t = window.I18n?.tr || ((k)=>k);
    
    dock.innerHTML = `
        <div class="dr-header">
            <div class="dr-title">
                ${t('deepResearch.title') || 'Deep Research'}
                <span class="dr-title-topic">${escapeHtml(topic)}</span>
            </div>
            <div class="dr-status-container">
                <div class="dr-spinner" style="display: ${status === 'done' || status === 'error' ? 'none' : 'block'};"></div>
                <div id="dr-status-${id}" class="dr-status-text">${status}</div>
            </div>
        </div>
        <div class="dr-body">
            <div id="dr-plan-${id}" class="dr-plan"></div>
            <div id="dr-activities-${id}" class="dr-activities"></div>
            <div id="dr-sources-${id}" class="dr-sources"></div>
            <div id="dr-report-${id}" class="dr-report"></div>
            <div id="dr-slidev-${id}" class="dr-slidev" style="margin-top:12px;"></div>
        </div>
        <div id="dr-actions-${id}" class="dr-actions" style="display: flex;">
            <button id="dr-copy-md-${id}" class="dr-action-btn">${t('deepResearch.copyReport') || 'Copy Report'}</button>
            <button id="dr-download-md-${id}" class="dr-action-btn primary">${t('deepResearch.downloadMarkdown') || 'Download Markdown'}</button>
        </div>
    `;
    const messages = document.getElementById('chat-messages');
    if(messages){ 
        messages.appendChild(dock); 
        dock.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    // 2. Render Plan
    if (plan) {
        const el = document.getElementById(`dr-plan-${id}`);
        if(el){
            let html = '';
            if(plan.thought){
              html += `<div style="margin-bottom: 8px; padding: 8px; border-radius: 4px; background-color: var(--secondary-bg-color); opacity: 0.8;"><strong>${t('deepResearch.thought') || 'Thought'}:</strong> ${escapeHtml(plan.thought)}</div>`;
            }
            const stepsHtml = plan.steps.map((step, i) => `<li><strong>${escapeHtml(step.title)}:</strong> ${escapeHtml(step.description)}</li>`).join('');
            html += `<div class="dr-section-title">${t('deepResearch.plan') || 'Plan'}</div><ol style="margin-top: 4px; padding-left: 20px;">${stepsHtml}</ol>`;
            el.innerHTML = html;
        }
    }

    // 3. Render Activities
    if (steps && steps.length > 0) {
        const el = document.getElementById(`dr-activities-${id}`);
        if(el){
            el.innerHTML = `<div class="dr-section-title">${t('deepResearch.activities') || 'Activities'}</div>`;
            steps.forEach((step, index) => {
                const item = document.createElement('div');
                item.className = 'dr-activity';
                item.innerHTML = `<div style="font-weight:600;">${t('deepResearch.step')||'步骤'} ${index+1}: ${escapeHtml(step.title)}</div>`;
                if (step.execution_res) {
                    const done = document.createElement('div');
                    done.className = 'dr-activity-done';
                    const summaryText = `${t('deepResearch.completed')||'完成'} · 点击展开详情`;
                    done.innerHTML = `<details class="dr-activity-details"><summary style=\"cursor:pointer;opacity:.8;\">${summaryText}</summary><pre style=\"white-space:pre-wrap; background-color: var(--input-background); padding: 4px; border-radius: 4px;\">${escapeHtml(step.execution_res||'')}</pre></details>`;
                    item.appendChild(done);
                }
                el.appendChild(item);
            });
        }
    }

    // 4. Render Sources (from history)
   if (steps && steps.length > 0) {
       const elSrc = document.getElementById(`dr-sources-${id}`);
       if (elSrc) {
         const allText = steps.map(s => s.execution_res || '').join('\n');
         const urlRegex = /https?:\/\/[^\s)>\]]+/g;
         const urls = Array.from(new Set(allText.match(urlRegex) || []));
         if (urls.length > 0) {
           const items = urls.map(u => `<div class="dr-source-item"><a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a></div>`).join('');
           const t = window.I18n?.tr || ((k)=>k);
           elSrc.innerHTML = `<div class="dr-section-title">${t('deepResearch.sources') || 'Sources'}</div><div class="dr-sources-list">${items}</div>`;
         }
       }
   }

   // 5. Render Report (with pagination)
    if (report) {
        const reportCompletedHandler = ({ report: r, id: eventId }) => {
          if (eventId !== id) return;
          const el = document.getElementById(`dr-report-${id}`);
          if(!el) return;

          const pages = r.split(/\n---\n/);
          let current = 0;

          el.innerHTML = `
            <div class="dr-section-title">Report</div>
            <div class="report-controls">
                      <button id="dr-report-prev-${id}" class="report-page-btn" title="Previous Page">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                      </button>
                      <span id="dr-report-count-${id}" class="report-page-count">1/${pages.length}</span>
                      <button id="dr-report-next-${id}" class="report-page-btn" title="Next Page">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                      </button>
                    </div>            <div id="dr-report-view-${id}" class="report-view" style="border:1px solid var(--border-color);border-radius:6px;padding:8px;max-height:420px;overflow:auto;"></div>
          `;

          const viewEl = document.getElementById(`dr-report-view-${id}`);
          const countEl = document.getElementById(`dr-report-count-${id}`);
          const prevBtn = document.getElementById(`dr-report-prev-${id}`);
          const nextBtn = document.getElementById(`dr-report-next-${id}`);

          function renderMermaidIn(container){
            if(typeof mermaid === 'undefined') return;
            const pres = container.querySelectorAll('pre.mermaid');
            pres.forEach(async (pre, index)=>{
              if(pre.dataset.mermaidRendered === 'true') return;
              const def = pre.textContent || '';
              if(!def) return;
              const renderId = `dr-report-${id}-m-${Date.now()}-${index}`;
              try{
                const { svg } = await mermaid.render(renderId, def);
                const wrapper = document.createElement('div');
                wrapper.className = 'mermaid';
                wrapper.innerHTML = svg;
                pre.replaceWith(wrapper);
              }catch(err){
                const div = document.createElement('div');
                div.className = 'mermaid-error';
                div.textContent = 'Mermaid 渲染失败: ' + (err?.message||String(err));
                pre.replaceWith(div);
              }
            });
          }

          function renderPage(index){
            current = Math.max(0, Math.min(pages.length - 1, index));
            const md = pages[current] || '';
            try{
              const html = window.MarkdownRenderer?.render(md) || `<pre>${escapeHtml(md)}</pre>`;
              viewEl.innerHTML = html;
              renderMermaidIn(viewEl);
            }catch(e){
              viewEl.textContent = md;
            }
            if(countEl) countEl.textContent = `${current+1}/${pages.length}`;
            if(prevBtn) prevBtn.disabled = current === 0;
            if(nextBtn) nextBtn.disabled = current === pages.length - 1;
          }

          renderPage(0);

          if(prevBtn){ prevBtn.onclick = ()=> renderPage(current - 1); }
          if(nextBtn){ nextBtn.onclick = ()=> renderPage(current + 1); }
        };
        // Directly call the handler logic with the loaded data
        reportCompletedHandler({ report, id });

        // Wire up copy/download for the full report
        const copyBtn = document.getElementById(`dr-copy-md-${id}`);
        const dlBtn = document.getElementById(`dr-download-md-${id}`);
        if(copyBtn){ copyBtn.onclick = async ()=> { try{ await navigator.clipboard.writeText(report); alert('已复制'); }catch(e){ console.error(e); } }; }
        if(dlBtn){
            dlBtn.onclick = ()=>{
              const blob = new Blob([report], { type: 'text/markdown' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `research-report-${Date.now()}.md`;
              document.body.appendChild(a);
              a.click();
              setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0);
            };
        }
    }
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.ui = window.DeepResearch.ui || {};
  window.DeepResearch.ui.renderResearchDock = renderResearchDock;
  window.DeepResearch.ui.renderResearchDockFromHistory = renderResearchDockFromHistory;

})();
