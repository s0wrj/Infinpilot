// Agent tool catalog for browser automation.
const toolCatalog = [
    { name: 'browser_navigate', description: '在当前上下文中导航到指定 URL', category: 'tabs' },
    { name: 'browser_get_current_tab', description: '获取当前目标标签页信息', category: 'tabs' },
    { name: 'browser_list_tabs', description: '列出浏览器中的所有标签页', category: 'tabs' },
    { name: 'browser_switch_tab', description: '切换到指定标签页', category: 'tabs' },
    { name: 'browser_open_url', description: '在新标签页打开 URL', category: 'tabs' },
    { name: 'browser_close_tab', description: '关闭指定标签页或当前标签页', category: 'tabs' },
    { name: 'browser_reload_tab', description: '刷新指定标签页或当前标签页', category: 'tabs' },
    { name: 'browser_bookmarks', description: '浏览、搜索并打开书签或收藏夹中的链接', category: 'browser' },
    { name: 'browser_history', description: '搜索浏览历史并重新打开或删除历史记录', category: 'browser' },
    { name: 'browser_windows', description: '列出、聚焦、创建、关闭浏览器窗口并移动标签页', category: 'browser' },
    { name: 'browser_downloads', description: '管理下载任务并打开或显示已下载文件', category: 'browser' },

    { name: 'browser_get_dom', description: '获取当前页面或目标元素的 DOM 内容', category: 'page' },
    { name: 'browser_get_visible_text', description: '获取页面或目标元素的可见文本', category: 'page' },
    { name: 'browser_scroll', description: '滚动页面或目标滚动容器', category: 'page' },
    { name: 'browser_screenshot', description: '截取当前可见页面', category: 'page' },

    { name: 'browser_click', description: '点击页面元素', category: 'elements' },
    { name: 'browser_fill_input', description: '填写输入框、文本域或可编辑区域', category: 'elements' },
    { name: 'browser_press_key', description: '向页面或目标元素发送键盘按键', category: 'elements' },
    { name: 'browser_wait', description: '等待指定时长', category: 'elements' },

    { name: 'browser_editor', description: '操作 InfinPilot 内置 Markdown、DOCX、Sheet 与文件树', category: 'editor' },
    { name: 'browser_sheet', description: '操作 InfinPilot 内置表格编辑器', category: 'editor' },
    { name: 'browser_svg', description: '操作 InfinPilot 内置 SVG 编辑器', category: 'editor' },
    { name: 'browser_project', description: '操作项目、模板、运行记录，并将页面或任务结果沉淀到项目', category: 'project' },
    { name: 'browser_mcp', description: '列出 MCP 服务、远程工具、资源和提示词，并读取资源或提示词内容', category: 'project' },

    { name: 'jina_ai_get_content', description: '使用 Jina AI 获取网页 Markdown 内容', category: 'scraping' },
    { name: 'scraping_get', description: '通过 HTTP 抓取网页内容，可配合选择器精确提取', category: 'scraping' },
    { name: 'scraping_extract_structured', description: '从页面提取结构化数据，如商品列表、文章列表、表格', category: 'scraping' },
    { name: 'scraping_bulk_get', description: '批量抓取多个 URL', category: 'scraping' },
    { name: 'scraping_get_links', description: '提取页面链接', category: 'scraping' },
    { name: 'scraping_get_images', description: '提取页面图片', category: 'scraping' },
    { name: 'scraping_current_page', description: '提取当前活动标签页内容', category: 'scraping' },

    { name: 'dom_find_similar', description: '查找与目标元素相似的元素', category: 'smart_search' },
    { name: 'dom_find_by_text', description: '按文本查找元素', category: 'smart_search' },
    { name: 'dom_find_by_regex', description: '按正则查找元素', category: 'smart_search' },
    { name: 'dom_find_by_filter', description: '按过滤条件查找元素', category: 'smart_search' }
];

export function getCollectiveRoleToolSet(roleId, allTools = toolCatalog) {
    const rolePolicies = {
        collector: ['browser_get_current_tab', 'browser_get_visible_text', 'browser_get_dom', 'browser_scroll', 'browser_screenshot', 'browser_click', 'browser_fill_input', 'browser_press_key', 'browser_navigate', 'browser_open_url', 'browser_switch_tab', 'browser_project', 'browser_mcp'],
        verifier: ['browser_get_current_tab', 'browser_get_visible_text', 'browser_get_dom', 'browser_screenshot', 'browser_project', 'browser_mcp', 'scraping_get', 'scraping_current_page'],
        skeptic: ['browser_get_visible_text', 'browser_get_dom', 'browser_project', 'browser_mcp', 'scraping_get', 'dom_find_by_text'],
        organizer: ['browser_project', 'browser_mcp', 'browser_editor'],
        writer: ['browser_project', 'browser_mcp', 'browser_editor']
    };
    const allowed = rolePolicies[roleId];
    if (!Array.isArray(allowed)) {
        return [...allTools];
    }
    return allTools.filter((tool) => allowed.includes(tool.name));
}

export function applyCollectiveToolPolicy(role, tools = toolCatalog) {
    const visibleTools = Array.isArray(role?.visibleTools) && role.visibleTools.length > 0
        ? tools.filter((tool) => role.visibleTools.includes(tool.name))
        : getCollectiveRoleToolSet(role?.id, tools);
    const forbidden = Array.isArray(role?.forbiddenActions) ? role.forbiddenActions : [];
    return visibleTools.filter((tool) => !forbidden.includes(tool.name));
}

export default toolCatalog;
