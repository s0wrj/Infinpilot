// InfinPilot Deep Research - Agents (coordinator, planner, researcher, coder, reporter)
(function(){
  const { validatePlan, tryRepairPlanText } = window.DeepResearch.plan;

  async function callLLM(messages, options = {}){
    // Use unified API; stream suppressed for simplicity in MVP
    const stateRef = window.__DeepResearch_stateRef || { model: null, chatHistory: [] };
    const streamCallback = null;
    const streamHandler = null;
    // Merge provided options with defaults
    const callOptions = { 
        insertResponse: false, 
        targetInsertionIndex: null, 
        insertAfterElement: null, 
        signal: null,
        ...options // Pass through system prompts, etc.
    };
    return await window.InfinPilotAPI.callApi(stateRef.model, messages, streamCallback, callOptions, streamHandler, stateRef);
  }

  function buildSystemPrompt(role){
    if (role === 'assessor') {
        return `You are a research complexity assessor. Your task is to analyze the user\'s research topic and classify its complexity into one of three levels: \'Primary\', \'Intermediate\', or \'Advanced\'.

- **Primary:** Simple topics, fact-checking, or straightforward questions.
- **Intermediate:** Topics requiring comparison, analysis of multiple facets, or a broader overview.
- **Advanced:** Complex, multi-disciplinary topics, in-depth technical subjects, or topics requiring extensive synthesis of information.

Respond with a single JSON object and nothing else. The schema is:
{
  "level": "\'Primary\' or \'Intermediate\' or \'Advanced\'"
}`;
    }
    if(role==='planner'){
      return `You are a research planning agent. Your sole purpose is to create a structured research plan in JSON format. Do not include any conversational text, greetings, or explanations in your response. Your entire response must be a single, valid JSON object.

The plan must adhere to the complexity level provided.
- **Primary Level:** At least 4 steps, designed to gather at least 10 sources.
- **Intermediate Level:** At least 7 steps, potentially breaking the topic into sub-themes for discussion. Designed to gather at least 25 sources.
- **Advanced Level:** At least 10 steps, breaking the topic into multiple distinct themes for deep analysis. Designed to gather at least 40 sources.

The JSON schema is:
{
  "locale": "string",
  "has_enough_context": boolean,
  "thought": "string",
  "title": "string",
  "steps": [
    {
      "need_search": boolean,
      "title": "string",
      "description": "string",
      "step_type": "\'research\' or \'processing\'"
    }
  ]
}

Create a plan for the following topic based on the specified research level.`;
    }
    if(role==='reporter'){
      return `You are an expert researcher and analyst. Your task is to synthesize the provided findings into a comprehensive, well-structured, and visually engaging report in Markdown format.

**Report Structure:**
Your report must include the following sections, with each section separated by a single line containing only \`---\`.
1. **Title (H1):**  Provide a clear and concise title for the report.

---
2. **Abstract / Executive Summary:**  Write a brief summary introducing the research objectives, primary methods, and key findings to offer a quick overview of the report’s core contents.

---
3. **Keywords / Key Terms:**  List the most important keywords or terms using bullet points to help readers quickly grasp the central themes of the report.

---
4. **Introduction:**
-   Present background information.
-   State the research purpose.
-   Define the research questions and scope.
   Optionally include an initial diagram (e.g., a flowchart or conceptual map) embedded with Mermaid code to illustrate the research context or process.

---
5. **Literature Review / Background:**  Provide a summary of existing literature and theoretical frameworks. Compare previous findings and establish the foundation for your analysis.You may embed Mermaid diagrams here to display connections among literature sources or to map the evolution of research on this topic.

---
6. **Methodology:**
-   Describe the research design and data collection methods in detail.
-   Explain your analysis steps and the tools employed.
-   Outline the data analysis process.
   For complex processes or decision-making flowcharts, include Mermaid diagrams (e.g., flowcharts, decision trees) using correct syntax enclosed in code blocks.

---
7. **Detailed Analysis & Findings:**  
   Organize the analysis and data interpretation into multiple sub-sections using appropriate sub-headings (H2, H3) to structure your content.  
-   **Data Analysis:** Provide a comprehensive explanation of the data trends and measurements.  
-   **Results Discussion:** Offer an in-depth interpretation and argumentation of your findings.  
-   **Embedded Visuals:** Integrate Mermaid diagrams (such as sequence diagrams, pie charts, timelines) within the text to clarify complex data, relationships, or processes. Use the code block format as shown above.

---
8. **Visual Aids (Integrated):**  Although Mermaid diagrams are not confined to this section, you may include additional comprehensive visualizations here (like an overarching flowchart or global relationship map) to reinforce key concepts across the report. Ensure each diagram is enclosed within a mermaid code block.

---
9. **Discussion and Implications:**  
-   Discuss the significance and limitations of your research.  
-   Elaborate on the theoretical and practical implications, and suggest directions for future research.  
   Consider adding causal or logic diagrams (using Mermaid) to depict interactions and influences among different factors.

---
10. **Survey / Style Note:**  Provide a brief note defining the report’s stylistic approach (e.g., academic, popular science), along with guidance on how to interpret the report.

---
11. **Key Citations:**  In this section, you must list all the URLs provided in the __SOURCES__ block in the user\'s prompt. List them exactly as provided, each on a new line.

**Formatting Guidelines:**
-   **Utilize Rich Markdown:** Make full use of Markdown capabilities, including headings, bold, italics, tables, code blocks, and blockquotes to enhance readability and visual appeal.
-   **No Inline Citations:** Do not use inline citations like [1] or (source). All citations must be listed in the "Key Citations" section at the end.
-   **Clarity and Cohesion:** Ensure the report flows logically and the language is clear and professional.`;
    }
    if(role==='slidev'){
      return `You are an expert slide designer specialized in generating Slidev presentations from Markdown research reports.

Requirements:
- Output ONLY valid Markdown. Do not include any explanations.
- Start with YAML frontmatter delimited by --- at the top, including at least: title, theme: seriph, transition: slide, class: text-left.
- Separate slides with a single line containing --- (three dashes) on its own line.
- Create: cover, agenda, 3-8 content slides (group by major headings), a visualization slide (preserve Mermaid blocks verbatim), and a references slide.
- Keep slides concise (bullet points). Avoid long paragraphs. Prefer 4-6 bullets per slide.
- Use Chinese when the report is Chinese; otherwise keep the original language.
- Preserve code fences and Mermaid blocks as-is within slides.
- Do NOT use HTML tags. Use pure Markdown supported by Slidev.
- If the report contains a top-level title, use it as the Slidev title.
- Use ::: notes blocks for speaker notes when helpful.`;
    }
    return `You are ${role}.`;
  }

  async function coordinator(input){
    // Minimal: always handoff to planner in MVP
    return { action: 'handoff_to_planner', research_topic: input.content, locale: 'zh-CN' };
  }

  async function assessor(context) {
    const { research_topic } = context;
    const systemPrompt = buildSystemPrompt('assessor');
    const userMessage = { role: 'user', content: `Topic: ${research_topic}` };
    const raw = await callLLM([userMessage], { systemPrompt });
    const responseText = raw?.text || '';
    try {
        const assessment = JSON.parse(responseText);
        return assessment.level || 'Primary'; // Default to Primary if parsing fails
    } catch (e) {
        console.warn('[DeepResearch][assessor] Failed to parse assessment, defaulting to Primary.', e);
        return 'Primary';
    }
  }

  async function planner(context){
    const { research_topic, settings, level } = context; // level is new
    const systemPrompt = buildSystemPrompt('planner');
    
    const levelInstructions = {
        'Primary': 'Research Level: Primary (4+ steps, 10+ sources)',
        'Intermediate': 'Research Level: Intermediate (7+ steps, 25+ sources, multi-theme)',
        'Advanced': 'Research Level: Advanced (10+ steps, 40+ sources, deep multi-theme analysis)'
    };

    const userMessage = { role: 'user', content: `Topic: ${research_topic}\nLocale: ${settings.locale || 'zh-CN'}\n\n${levelInstructions[level]}` };
    const raw = await callLLM([userMessage], { systemPrompt });
    const responseText = raw?.text || '';
    const planObj = tryRepairPlanText(responseText);
    if(!planObj){ throw new Error('Planner returned unparsable plan'); }
    const v = validatePlan(planObj);
    if(!v.ok){ throw new Error('Invalid plan: '+v.error); }
    return planObj;
  }

  async function keywordExtractor(taskDescription) {
    const systemPrompt = `You are a search engine optimization expert. Your sole task is to extract a concise, keyword-based search query from the user's research task. The query should be short and effective for a web search. Respond with ONLY the search query and nothing else.`;
    const userMessage = { role: 'user', content: `Task: "${taskDescription}"` };
    try {
      const raw = await callLLM([userMessage], { systemPrompt, temperature: 0.1 });
      // Return the extracted keywords, or fallback to the original description if it fails
      const keywords = raw?.text?.trim();
      // Post-process to remove potential quotes
      if (keywords && keywords.startsWith('"') && keywords.endsWith('"')) {
        return keywords.substring(1, keywords.length - 1);
      }
      return keywords || taskDescription;
    } catch (e) {
      console.warn('[DeepResearch][keywordExtractor] Failed to extract keywords, using original description.', e);
      return taskDescription;
    }
  }

  async function researcherExecuteStep(step, ctx){
    const bus = window.DeepResearch?.eventBus;
    // Use web_search + optional crawl for detail
    const { tools } = window.DeepResearch;
    const pieces = [];
    
    const searchResultCounts = {
        'Primary': 10,
        'Intermediate': 25,
        'Advanced': 40
    };
    const maxResults = searchResultCounts[ctx.level] || 10;

    try{
      // First, extract a better search query from the step description
      const searchQuery = await keywordExtractor(step.description || step.title);
      bus?.emit('activity:log', { index: ctx.stepIndex, message: `Searching with keywords: "${searchQuery}"` });

      const results = await tools.webSearch(searchQuery, { maxResults });
      pieces.push(`Search results for "${searchQuery}" (top ${results.length}):`);
      // emit a structured activity for UI cards
      bus?.emit('activity:search', { id: ctx.id, index: ctx.stepIndex, results });
      for(const r of results){
        pieces.push(`- ${r.title} (${r.url})`);
      }
      // Crawl the top 3 results for detail
      const crawlPromises = results.slice(0, 3).map(r => tools.crawl(r.url));
      for (const crawlPromise of crawlPromises) {
        try {
          const page = await crawlPromise;
          if (page && page.content) {
            const excerpt = (page.content||'').trim().slice(0, 1500);
            // emit crawl activity for UI card
            bus?.emit('activity:crawl', { id: ctx.id, index: ctx.stepIndex, page });
            if(excerpt){ pieces.push(`\n\n--- Source: ${page.url} ---\n` + excerpt); }
          }
        } catch (e) {
          console.warn('[agents.js] a crawl failed:', e.message);
        }
      }
    }catch(e){ pieces.push('Search failed: '+String(e?.message||e)); }
    return pieces.join('\n');
  }

  async function coderExecuteStep(step, ctx){
    const { compute } = window.DeepResearch.tools;
    const desc = step.description.toLowerCase();
    let result;

    // Simple keyword-based routing to the right compute tool.
    if (desc.includes('summarize') || desc.includes('summary')) {
        const summary = compute.summarizeText(step.description, 3);
        result = `Summary of description: ${summary}`;
    } else if (desc.includes('extract numbers') || desc.includes('find figures')) {
        const numbers = compute.extractNumbers(step.description);
        result = `Extracted numbers: ${numbers.join(', ')}`;
    } else {
        // Default fallback if no specific processing is requested.
        result = `No specific processing instruction found for: "${step.title}".`;
    }

    return result;
  }

  async function reporter(context){
    const { research_topic, steps, settings, level } = context;
    const systemPrompt = buildSystemPrompt('reporter');

    const tokenRequirements = {
        'Primary': 'Ensure the report is at least 1500 tokens long.',
        'Intermediate': 'Discuss the topic with distinct themes. Ensure the report is at least 2500 tokens long.',
        'Advanced': 'Discuss the topic with multiple, distinct themes in depth. Ensure the report is at least 4000 tokens long.'
    };

    const findingsText = steps.map((s,i)=>`[${i+1}] ${s.title}: ${s.execution_res||'(empty)'}`).join('\n');
    // Extract URLs from findings (search results + crawls)
    const urlRegex = /https?:\/\/[^\s)>\]]+/g; // stop at whitespace or common closing delimiters
    const allUrls = findingsText.match(urlRegex) || [];
    const uniqueUrls = [...new Set(allUrls)];

    let sourcesBlock;
    if (uniqueUrls.length > 0) {
        sourcesBlock = `__SOURCES__\n${uniqueUrls.join('\n')}\n__SOURCES__`;
    } else {
        sourcesBlock = "No external sources were found or successfully processed during the research phase.";
    }

    const userMessage = { 
        role: 'user', 
        content: `Topic: ${research_topic}\nStyle: ${settings.reportStyle||'academic'}\n\n**Citations Requirement:**\nYou MUST cite the following sources in the 'Key Citations' section of your report. Do not use any other URLs.\n${sourcesBlock}\n\n**Main Task:**\nBased on the findings below, write the report as requested.\n\n**Requirement:**\n${tokenRequirements[level] || tokenRequirements['Primary']}\n\n**Findings:**\n${findingsText}`
    };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800000); // 3 minute timeout

    function appendCitationsIfMissing(mdText, urls){
      const text = mdText || '';
      if (!urls || urls.length === 0) return text;
      // Heuristics: if no url appears in the report OR there is no Key Citations section, append one.
      const hasAnyUrl = urls.some(u => text.includes(u));
      const hasKeyCitations = /\*\*Key Citations\*\*|参考文献|引用|Citations/i.test(text);
      if (hasAnyUrl && hasKeyCitations) return text; // already present
      const list = Array.from(new Set(urls)).join('\n');
      const appendix = `\n---\n11. **Key Citations:**\n${list}\n`;
      return text + appendix;
    }

    try {
        const md = await callLLM([userMessage], { 
            systemPrompt, 
            maxTokens: 8192,
            signal: controller.signal
        });
        const mdText = md?.text || '';
        // Ensure the citations are included even if the model omits them.
        return appendCitationsIfMissing(mdText, uniqueUrls);
    } finally {
        clearTimeout(timeoutId);
    }
  }

  async function generateSlidev(context){
    const { research_topic, report, settings, level } = context;
    const systemPrompt = buildSystemPrompt('slidev');
    const userMessage = {
      role: 'user',
      content: `Topic: ${research_topic}\nLevel: ${level}\nLocale: ${settings?.locale || 'zh-CN'}\n\nHere is the research report in Markdown. Convert it into a concise Slidev deck as required by the system prompt.\n\n<REPORT>\n${report}\n</REPORT>`
    };
    const res = await callLLM([userMessage], { systemPrompt });
    return res?.text || '';
  }

  window.DeepResearch = window.DeepResearch || {};
  window.DeepResearch.agents = {
    coordinator,
    assessor,
    planner,
    researcherExecuteStep,
    coderExecuteStep,
    reporter,
    generateSlidev,
  };
})();