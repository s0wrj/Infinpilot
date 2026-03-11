// InfinPilot Deep Research - CodeMirror integration for report editor
(function(){
  function mountCodeMirror(textarea){
    if(!window.CodeMirror){ console.warn('[DeepResearch] CodeMirror not found, fallback to textarea'); return null; }
    const cm = CodeMirror.fromTextArea(textarea, {
      mode: 'markdown',
      theme: 'material',
      lineNumbers: true,
      lineWrapping: true,
    });
    setTimeout(()=> cm.refresh(), 50);
    return cm;
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.ui = window.DeepResearch.ui || {};
  window.DeepResearch.ui.mountCodeMirror = mountCodeMirror;
})();