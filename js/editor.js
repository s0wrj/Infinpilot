// js/editor.js - Markdown 编辑器
import projectService from './projectService.js';

// js/editor.js - Markdown 编辑器
(function(){
  const $ = (id) => document.getElementById(id);

  function throttle(func, limit) {
      let inThrottle;
      return function() {
          const args = arguments;
          const context = this;
          if (!inThrottle) {
              func.apply(context, args);
              inThrottle = true;
              setTimeout(() => inThrottle = false, limit);
          }
      }
  }

  const el = {
    insertUrlBtn: document.getElementById('md-insert-current-url'),
    insertAllTabsBtn: document.getElementById('md-insert-open-tabs'),
    insertScreenshotBtn: document.getElementById('md-insert-screenshot'),
    section: document.querySelector('#editor.tab-content'),
    editor: $('md-editor'),
    preview: $('md-preview'),
    viewEdit: $('md-view-edit'),
    viewPreview: $('md-view-preview'),
    viewSplit: $('md-view-split'),
    viewSplitVertical: $('md-view-split-vertical'),
    exportBtn: $('md-export'),
    // runBtn 已移除
    importBtn: $('md-import'),
    importInput: $('md-import-input'),
    newBtn: $('md-new'),
    status: $('md-status-text'),
    stats: $('md-stats'),
    aiCustomPromptContainer: document.getElementById('md-ai-custom-prompt-container'),
    aiCustomPromptInput: document.getElementById('md-ai-custom-prompt-input'),
    aiCustomPromptSubmit: document.getElementById('md-ai-custom-prompt-submit'),
    aiIncludePageContent: document.getElementById('md-ai-include-page-content'),
    mdBold: document.getElementById('md-bold'),
    mdItalic: document.getElementById('md-italic'),
    mdStrikethrough: document.getElementById('md-strikethrough'),
    mdCode: document.getElementById('md-code'),
    mdLink: document.getElementById('md-link'),
    mdListUl: document.getElementById('md-list-ul'),
    mdListOl: document.getElementById('md-list-ol'),
  };

  if (!el.section) return;

  let cmEditor = null;
  let isInitializing = true;

  // Markdown state
  const mdState = window.InfinpilotMarkdownState || {
    content: '',
    title: '',
    sourceUrls: [],
    viewMode: 'split',
    splitOrientation: 'horizontal',
    lastSavedAt: null,
    imageMap: {},
  };
  window.InfinpilotMarkdownState = mdState;

  const LARGE_STORAGE_KEYS = new Set([
    'infinpilot-editor-files',
    'infinpilot-docx-files',
    'infinpilot-sheet-files',
    'infinpilot_md_draft'
  ]);
  const EDITOR_IDB_NAME = 'infinpilot-editor-storage';
  const EDITOR_IDB_STORE = 'kv';
  let editorDbPromise = null;

  function openEditorDb() {
    if (editorDbPromise) return editorDbPromise;
    editorDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(EDITOR_IDB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EDITOR_IDB_STORE)) {
          db.createObjectStore(EDITOR_IDB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open editor IndexedDB'));
    });
    return editorDbPromise;
  }

  async function idbGetValue(key) {
    const db = await openEditorDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(EDITOR_IDB_STORE, 'readonly');
      const store = transaction.objectStore(EDITOR_IDB_STORE);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error(`Failed to read ${key} from IndexedDB`));
    });
  }

  async function idbSetValue(key, value) {
    const db = await openEditorDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(EDITOR_IDB_STORE, 'readwrite');
      const store = transaction.objectStore(EDITOR_IDB_STORE);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Failed to write ${key} to IndexedDB`));
    });
  }

  async function idbDeleteValue(key) {
    const db = await openEditorDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(EDITOR_IDB_STORE, 'readwrite');
      const store = transaction.objectStore(EDITOR_IDB_STORE);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Failed to delete ${key} from IndexedDB`));
    });
  }

  async function readLargeStorageValue(key) {
    try {
      const idbValue = await idbGetValue(key);
      if (idbValue !== null && idbValue !== undefined) {
        return idbValue;
      }
    } catch (e) {
      console.warn(`[Editor] Failed to read ${key} from IndexedDB:`, e);
    }

    const localValue = (await browser.storage.local.get(key))[key];
    if (localValue !== undefined) {
      try {
        await idbSetValue(key, localValue);
        await browser.storage.local.remove(key);
      } catch (_) {}
      return localValue;
    }
    return null;
  }

  async function writeLargeStorageValue(key, value) {
    if (!LARGE_STORAGE_KEYS.has(key)) {
      await browser.storage.local.set({ [key]: value });
      return;
    }
    await idbSetValue(key, value);
    try {
      await browser.storage.local.remove(key);
    } catch (_) {}
  }

  async function removeLargeStorageValue(key) {
    if (!LARGE_STORAGE_KEYS.has(key)) {
      await browser.storage.local.remove(key);
      return;
    }
    try {
      await idbDeleteValue(key);
    } catch (_) {}
    try {
      await browser.storage.local.remove(key);
    } catch (_) {}
  }

  const OPENABLE_FILE_TYPES = new Set(['file', 'docx', 'sheet', 'svg']);
  const ROOT_FOLDER_NAME = 'Root';

  function createId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function isFolderItem(item) {
    return !!item && item.type === 'folder';
  }

  function isOpenableFile(item) {
    return !!item && OPENABLE_FILE_TYPES.has(item.type);
  }

  function createRootFolder() {
    return {
      id: createId('folder'),
      name: ROOT_FOLDER_NAME,
      type: 'folder',
      parentId: null,
      expanded: true
    };
  }

  function getOpenableFiles() {
    return files.filter(isOpenableFile);
  }

  function getRootFolder() {
    return files.find(item => isFolderItem(item) && item.parentId === null) || null;
  }

  function getValidParentFolderId(parentId) {
    if (parentId && files.some(item => isFolderItem(item) && item.id === parentId)) {
      return parentId;
    }
    return getRootFolder()?.id || null;
  }

  function getNextMarkdownFileName(items = files) {
    const existingNames = new Set(items.filter(item => item.type === 'file').map(item => item.name));
    let index = 1;
    let candidate = 'untitled.md';

    while (existingNames.has(candidate)) {
      index += 1;
      candidate = `untitled-${index}.md`;
    }

    return candidate;
  }

  function syncFileGlobals() {
    window.InfinpilotEditorFiles = files;
    window.InfinpilotCurrentFileId = currentFileId;
  }

  function dispatchCurrentFileChangedEvent() {
    const currentFile = getCurrentFile();
    window.dispatchEvent(new CustomEvent('infinpilot:editor-current-file-changed', {
      detail: {
        currentFileId,
        file: currentFile
          ? { id: currentFile.id, name: currentFile.name, type: currentFile.type, parentId: currentFile.parentId ?? null }
          : null
      }
    }));
  }

  async function syncProjectReferenceForFile(file) {
    if (!file?.id) {
      return;
    }
    try {
      await projectService.syncEditorFileReference({
        id: file.id,
        name: file.name,
        type: file.type,
        parentId: file.parentId ?? null
      });
    } catch (error) {
      console.warn('[Editor] Failed to sync project reference for file:', file.id, error);
    }
  }

  async function removeProjectReferencesForFileIds(fileIds) {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return;
    }
    try {
      await projectService.removeEditorFileReferences(fileIds);
    } catch (error) {
      console.warn('[Editor] Failed to remove project references for files:', fileIds, error);
    }
  }

  function setSelectedTreeItemId(itemId) {
    selectedTreeItemId = itemId || getRootFolder()?.id || null;
  }

  function getSelectedTreeItem() {
    return files.find(item => item.id === selectedTreeItemId) || null;
  }

  function getPreferredCreationFolderId() {
    const selectedItem = getSelectedTreeItem();
    if (selectedItem) {
      if (selectedItem.type === 'folder') {
        return selectedItem.id;
      }
      if (selectedItem.parentId) {
        return getValidParentFolderId(selectedItem.parentId);
      }
    }

    const currentFile = getCurrentFile();
    if (currentFile?.parentId) {
      return getValidParentFolderId(currentFile.parentId);
    }

    return getRootFolder()?.id || null;
  }

  function isDescendantFolder(folderId, potentialAncestorId) {
    let cursor = files.find(item => item.id === folderId);
    while (cursor && cursor.parentId) {
      if (cursor.parentId === potentialAncestorId) {
        return true;
      }
      cursor = files.find(item => item.id === cursor.parentId);
    }
    return false;
  }

  function expandFolderPathForItem(itemOrId) {
    const item = typeof itemOrId === 'string'
      ? files.find(entry => entry.id === itemOrId)
      : itemOrId;
    if (!item) {
      return false;
    }

    let changed = false;
    let folderId = item.type === 'folder' ? item.id : item.parentId;

    while (folderId) {
      const folder = files.find(entry => entry.id === folderId && entry.type === 'folder');
      if (!folder) {
        break;
      }
      if (folder.expanded === false) {
        folder.expanded = true;
        changed = true;
      }
      folderId = folder.parentId;
    }

    return changed;
  }

  function moveTreeItem(itemId, targetFolderId) {
    const item = files.find(entry => entry.id === itemId);
    const targetFolder = files.find(entry => entry.id === targetFolderId && entry.type === 'folder');

    if (!item || !targetFolder) {
      return { success: false, error: 'Invalid move target' };
    }

    const rootFolder = getRootFolder();
    if (rootFolder && item.id === rootFolder.id) {
      return { success: false, error: 'Cannot move the root folder' };
    }

    if (item.id === targetFolder.id) {
      return { success: false, error: 'Cannot move an item into itself' };
    }

    if (item.type === 'folder' && isDescendantFolder(targetFolder.id, item.id)) {
      return { success: false, error: 'Cannot move a folder into its child folder' };
    }

    if (item.parentId === targetFolder.id) {
      return { success: true, unchanged: true };
    }

    item.parentId = targetFolder.id;
    expandFolderPathForItem(item);
    syncFileGlobals();
    void saveFilesToStorage();
    renderFileTabs();
    renderFileTree();
    return { success: true };
  }

  function normalizeFiles(rawFiles, preferredCurrentFileId = null) {
    const sourceItems = Array.isArray(rawFiles) ? rawFiles : [];
    const normalized = [];
    const seenIds = new Set();

    sourceItems.forEach(rawItem => {
      if (!rawItem || typeof rawItem !== 'object') {
        return;
      }

      const type = isFolderItem(rawItem) ? 'folder' : (OPENABLE_FILE_TYPES.has(rawItem.type) ? rawItem.type : 'file');
      let id = typeof rawItem.id === 'string' && rawItem.id.trim() ? rawItem.id.trim() : createId(type === 'folder' ? 'folder' : 'file');
      if (seenIds.has(id)) {
        id = createId(type === 'folder' ? 'folder' : 'file');
      }
      seenIds.add(id);

      const item = {
        ...rawItem,
        id,
        type
      };

      if (type === 'folder') {
        item.name = typeof item.name === 'string' && item.name.trim() ? item.name : 'New Folder';
        item.expanded = item.expanded !== false;
      } else {
        item.name = typeof item.name === 'string' && item.name.trim()
          ? item.name
          : (type === 'docx'
            ? 'untitled.docx'
            : (type === 'sheet'
              ? 'untitled.xlsx'
              : (type === 'svg' ? 'untitled.svg' : getNextMarkdownFileName(normalized))));
        item.content = typeof item.content === 'string' ? item.content : '';
        item.imageMap = item.imageMap && typeof item.imageMap === 'object' ? item.imageMap : {};
      }

      normalized.push(item);
    });

    let rootFolder = normalized.find(item => isFolderItem(item) && (item.parentId === null || item.parentId === ''));
    if (!rootFolder) {
      rootFolder = createRootFolder();
      normalized.unshift(rootFolder);
    }

    rootFolder.parentId = null;
    rootFolder.name = rootFolder.name || ROOT_FOLDER_NAME;
    rootFolder.expanded = rootFolder.expanded !== false;

    const folderIds = new Set(normalized.filter(isFolderItem).map(item => item.id));
    folderIds.add(rootFolder.id);

    normalized.forEach(item => {
      if (item.id === rootFolder.id) {
        return;
      }

      if (isFolderItem(item)) {
        if (!folderIds.has(item.parentId) || item.parentId === item.id) {
          item.parentId = rootFolder.id;
        }
        item.expanded = item.expanded !== false;
        return;
      }

      if (!folderIds.has(item.parentId)) {
        item.parentId = rootFolder.id;
      }
    });

    const nextCurrentFileId = normalized.some(item => isOpenableFile(item) && item.id === preferredCurrentFileId)
      ? preferredCurrentFileId
      : (normalized.find(isOpenableFile)?.id || null);

    return { files: normalized, currentFileId: nextCurrentFileId };
  }

  function clearEditorWhenNoFileSelected() {
    if (typeof isSvgMode !== 'undefined' && isSvgMode) {
      stopSvgAutosave();
      isSvgMode = false;
      svgPendingContent = null;

      const svgToolbar = $('svg-toolbar');
      const svgEditor = $('svg-editor');
      const mdToolbar = document.querySelector('#editor .editor-toolbar');
      const editorMain = document.querySelector('#editor .editor-main');
      if (svgToolbar) svgToolbar.style.display = 'none';
      if (svgEditor) svgEditor.style.display = 'none';
      if (mdToolbar) mdToolbar.style.display = '';
      if (editorMain) editorMain.style.display = '';
      if ($('md-svg-toggle')) $('md-svg-toggle').classList.remove('active');
    }

    currentFileId = null;
    setSelectedTreeItemId(getRootFolder()?.id || null);
    mdState.content = '';
    mdState.title = '';
    mdState.sourceUrls = [];
    mdState.imageMap = {};

    if (cmEditor && cmEditor.getValue() !== '') {
      cmEditor.setValue('');
    }

    renderPreview();
    updateStats();
    syncFileGlobals();
    dispatchCurrentFileChangedEvent();
    void saveFilesToStorage();
    if (el.status) {
      el.status.textContent = 'No file selected';
    }
  }

  function handleEditorChange(instance) {
    if (isInitializing || !instance) return;
    mdState.content = instance.getValue();
    
    // Only save to MD files, not DOCX files
    const currentFile = getCurrentFile();
    if (currentFile && currentFile.type === 'file') {
      currentFile.content = instance.getValue();
    }
    
    renderPreview();
    scheduleAutosave();
    updateStats();
  }

  // Multi-file/folder support structure
  // Each item: { id, name, type: 'file'|'folder', content, imageMap, parentId }
  
  // 从 browser.storage.local 加载文件
  async function loadFilesFromStorage() {
    try {
      console.log('[Editor] Loading files from storage...');
      
      // 加载 MD 文件
      const mdData = await browser.storage.local.get(['infinpilot-current-file-id']);
      const savedMdFiles = await readLargeStorageValue('infinpilot-editor-files');
      const savedCurrentFileId = mdData['infinpilot-current-file-id'];
      
      let mdFiles = [];
      if (savedMdFiles) {
        mdFiles = JSON.parse(savedMdFiles);
      }
      
      // 加载 DOCX 文件（从单独的存储key）
      let docxFiles = [];
      try {
        const savedDocxFiles = await readLargeStorageValue('infinpilot-docx-files');
        if (savedDocxFiles) {
          docxFiles = JSON.parse(savedDocxFiles);
        }
      } catch(e) { /* ignore */ }
      
      // 合并 MD 和 DOCX 文件
      const allFiles = [...mdFiles, ...docxFiles];
      
      console.log('[Editor] Parsed files, count:', allFiles.length);
      console.log('[Editor] MD files:', mdFiles.length, 'DOCX files:', docxFiles.length);
      
      allFiles.forEach((f, i) => {
        console.log('[Editor] File', i, ':', f.name, 'type:', f.type, 'content length:', f.content ? f.content.length : 0);
      });
      
      if (Array.isArray(allFiles) && allFiles.length > 0) {
        return { files: allFiles, currentFileId: savedCurrentFileId };
      }
      console.log('[Editor] No saved files found');
    } catch (e) {
      console.warn('[Editor] Failed to load files from storage:', e);
    }
    return null;
  }
  
  // 保存 MD 文件到 storage（不包含 DOCX 文件）
  async function saveMdFilesToStorage() {
    try {
      const mdFiles = files.filter(f => f.type === 'file' || f.type === 'folder' || f.type === 'svg');
      await writeLargeStorageValue('infinpilot-editor-files', JSON.stringify(mdFiles));
      await browser.storage.local.set({
        'infinpilot-current-file-id': currentFileId || ''
      });
    } catch (e) {
      console.warn('[Editor] Failed to save MD files:', e);
    }
  }
  
  // 保存 DOCX 文件到 storage（不包含 MD 文件）
  async function saveDocxFilesToStorage() {
    try {
      const docxFiles = files.filter(f => f.type === 'docx');
      if (docxFiles.length > 0) {
        await writeLargeStorageValue('infinpilot-docx-files', JSON.stringify(docxFiles));
      } else {
        await removeLargeStorageValue('infinpilot-docx-files');
      }
    } catch (e) {
      console.warn('[Editor] Failed to save DOCX files:', e);
    }
  }
  
  // 保存文件到 browser.storage.local（分开保存 MD 和 DOCX）
  async function saveFilesToStorage() {
    if (isSavingFiles) {
      return;
    }
    isSavingFiles = true;
    try {
      const mdFiles = files.filter(f => f.type === 'file' || f.type === 'folder' || f.type === 'svg');
      const docxFiles = files.filter(f => f.type === 'docx');
      const sheetFiles = files.filter(f => f.type === 'sheet');
      
      await writeLargeStorageValue('infinpilot-editor-files', JSON.stringify(mdFiles));
      await browser.storage.local.set({
        'infinpilot-current-file-id': currentFileId || ''
      });
      
      if (docxFiles.length > 0) {
        await writeLargeStorageValue('infinpilot-docx-files', JSON.stringify(docxFiles));
      } else {
        await removeLargeStorageValue('infinpilot-docx-files');
      }

      if (sheetFiles.length > 0) {
        await writeLargeStorageValue('infinpilot-sheet-files', JSON.stringify(sheetFiles));
      } else {
        await removeLargeStorageValue('infinpilot-sheet-files');
      }
    } catch (e) {
      console.warn('[Editor] Failed to save files:', e);
    } finally {
      isSavingFiles = false;
    }
  }
  
  // 更新文件并保存到存储
  function updateFiles(newFiles, newCurrentFileId = null) {
    files = newFiles;
    if (newCurrentFileId !== null) {
      currentFileId = newCurrentFileId;
    }
    syncFileGlobals();
    saveFilesToStorage();
  }
  
  // Variable placeholders for initialization
  let files = [];
  let currentFileId = null;
  let isSavingFiles = false;
  let selectedTreeItemId = null;
  
  // Initialize files - will be called after loadFilesFromStorage
  function initializeFilesLegacy(savedData, sheetFiles = []) {
    console.log('[Editor] initializeFiles called with savedData:', savedData ? 'has data' : 'null', 'sheetFiles:', sheetFiles ? sheetFiles.length : 0);
    files = savedData ? savedData.files : (window.InfinpilotEditorFiles || []);
    currentFileId = savedData ? savedData.currentFileId : (window.InfinpilotCurrentFileId || null);
    
    // Merge sheet files if any
    if (sheetFiles && sheetFiles.length > 0) {
      const rootFolder = files.find(f => f.type === 'folder' && !f.parentId);
      const rootId = rootFolder?.id || (files[0] ? files[0].id : null);
      
      sheetFiles.forEach(sheetFile => {
        // Check if file already exists (by name and type)
        const existing = files.find(f => f.name === sheetFile.name && f.type === 'sheet');
        if (!existing) {
          files.push({
            ...sheetFile,
            parentId: sheetFile.parentId || rootId
          });
          console.log('[Editor] Merged Sheet file:', sheetFile.name);
        }
      });
    }
    
    // Debug: check if loaded files have content
    if (savedData && savedData.files) {
      console.log('[Editor] Loaded files from storage:');
      savedData.files.forEach((f, i) => {
        console.log('[Editor] File', i, ':', f.name, 'type:', f.type, 'content length:', f.content ? f.content.length : 0);
      });
    }

    // If loaded from storage, ensure it's saved to keep variables in sync
    if (savedData) {
      window.InfinpilotEditorFiles = files;
      window.InfinpilotCurrentFileId = currentFileId;
    }

    // Initialize with default file if empty
    if (files.length === 0) {
      const defaultFileId = 'file-' + Date.now();
      const folderId = 'folder-' + Date.now();
      files = [
        {
          id: folderId,
          name: '根目录',
          type: 'folder',
          parentId: null,
          expanded: true
        },
        {
          id: defaultFileId,
          name: '未命名.md',
          type: 'file',
          content: '',
          imageMap: {},
          parentId: folderId
        }
      ];
      currentFileId = defaultFileId;
    } else {
      // Ensure there's a root folder for existing files
      let rootFolder = files.find(f => f.type === 'folder' && !f.parentId);
      if (!rootFolder) {
        // Create a root folder and assign it to files without parent
        rootFolder = {
          id: 'folder-' + Date.now(),
          name: '根目录',
          type: 'folder',
          parentId: null,
          expanded: true
        };
        files.unshift(rootFolder);
      }

      // Ensure all items have type and parentId
      files.forEach(item => {
        if (!item.type) item.type = 'file';
        // Only set parentId if it's undefined (not set), not if it's explicitly null
        if (item.parentId === undefined) item.parentId = rootFolder.id;
      });

      // Ensure currentFileId is set to a valid file
      if (!currentFileId) {
        const firstFile = files.find(f => f.type === 'file' || f.type === 'docx' || f.type === 'sheet');
        currentFileId = firstFile?.id || null;
      }
    }

    window.InfinpilotEditorFiles = files;
    window.InfinpilotCurrentFileId = currentFileId;
    
    // Only save if new default files were created, not if loaded from storage
    if (!savedData || savedData.files.length === 0) {
      saveFilesToStorage(); // Save newly created default files
    }
  }
  
  function initializeFiles(savedData, sheetFiles = []) {
    console.log('[Editor] initializeFiles called with savedData:', savedData ? 'has data' : 'null', 'sheetFiles:', sheetFiles ? sheetFiles.length : 0);
    const baseFiles = savedData ? savedData.files : (window.InfinpilotEditorFiles || []);
    const preferredCurrentFileId = savedData ? savedData.currentFileId : (window.InfinpilotCurrentFileId || null);
    const mergedFiles = Array.isArray(baseFiles) ? baseFiles.map(item => ({ ...item })) : [];

    if (sheetFiles && sheetFiles.length > 0) {
      sheetFiles.forEach(sheetFile => {
        const existing = mergedFiles.find(item => item.id === sheetFile.id || (item.name === sheetFile.name && item.type === 'sheet'));
        if (!existing) {
          mergedFiles.push({ ...sheetFile });
          console.log('[Editor] Merged Sheet file:', sheetFile.name);
        }
      });
    }

    if (savedData && savedData.files) {
      console.log('[Editor] Loaded files from storage:');
      savedData.files.forEach((f, i) => {
        console.log('[Editor] File', i, ':', f.name, 'type:', f.type, 'content length:', f.content ? f.content.length : 0);
      });
    }

    let normalized = normalizeFiles(mergedFiles, preferredCurrentFileId);

    if (mergedFiles.length === 0 && !savedData) {
      const rootFolder = normalized.files.find(isFolderItem) || createRootFolder();
      const defaultFile = {
        id: createId('file'),
        name: getNextMarkdownFileName(normalized.files),
        type: 'file',
        content: '',
        imageMap: {},
        parentId: rootFolder.id
      };
      normalized = normalizeFiles([rootFolder, defaultFile], defaultFile.id);
    }

    files = normalized.files;
    currentFileId = normalized.currentFileId;
    setSelectedTreeItemId(currentFileId || getRootFolder()?.id || null);
    syncFileGlobals();

    if (!savedData || mergedFiles.length === 0) {
      saveFilesToStorage();
    }
  }

  // Async initialization
  let editorFilesReady = false;
  
  (async function initEditorFiles() {
    try {
      console.log('[Editor] Starting file initialization...');
      const savedData = await loadFilesFromStorage();
      const sheetFiles = await loadSheetFilesFromStorage();
      initializeFiles(savedData, sheetFiles);
      console.log('[Editor] File initialization complete, files:', files);
    } catch (e) {
      console.error('[Editor] Error initializing files:', e);
      // Initialize with defaults on error
      initializeFiles(null, []);
    }
    editorFilesReady = true;
  })();

  // Get current file - based on currentFileId only
  function getCurrentFile() {
    return files.find(f => f.id === currentFileId);
  }

  // Render file tabs
  function renderFileTabsLegacy() {
    var tabsContainer = document.getElementById('editor-files-tabs');
    var newFileBtn = document.getElementById('editor-new-file-btn');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = '';

    // Only render files, not folders
    var fileItems = files.filter(function(f) { return f.type === 'file'; });

    fileItems.forEach(function(file) {
      var tab = document.createElement('div');
      tab.className = 'editor-file-tab' + (file.id === currentFileId ? ' active' : '');
      tab.innerHTML = '<span class="file-name">' + file.name + '</span><span class="file-close" data-id="' + file.id + '">&times;</span>';

      tab.addEventListener('click', function(e) {
        if (e.target.classList.contains('file-close')) {
          e.stopPropagation();
          closeFile(file.id);
        } else {
          switchToFile(file.id);
        }
      });

      // Double-click to rename
      tab.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        renameFileWithPrompt(file.id);
      });

      tabsContainer.appendChild(tab);
    });

    if (newFileBtn) {
      newFileBtn.onclick = function() { createNewFile(); };
    }
  }

  // Render file tree with folder support - vertical structure
  function renderFileTreeLegacy() {
    var treeContent = document.getElementById('file-tree-content');
    if (!treeContent) {
      console.warn('[Editor] file-tree-content element not found');
      return;
    }

    console.log('[Editor] renderFileTree called, files:', files);
    treeContent.innerHTML = '';
    
    // Check if files array is valid
    if (!files || !Array.isArray(files) || files.length === 0) {
      console.warn('[Editor] No files to render');
      treeContent.innerHTML = '<div style="padding: 10px; color: #888;">没有文件</div>';
      return;
    }

    // Build tree recursively and render as flat list with indentation
    var renderItem = function(item, depth) {
      var elements = [];

      // Create the item element
      var itemEl = createTreeItemElement(item, depth);
      elements.push(itemEl);

      // If folder is expanded, render children
      if (item.type === 'folder' && item.expanded) {
        var children = files.filter(function(f) { return f.parentId === item.id; });
        var sortedChildren = children.slice().sort(function(a, b) {
          if (a.type === 'folder' && b.type !== 'folder') return -1;
          if (a.type !== 'folder' && b.type === 'folder') return 1;
          return a.name.localeCompare(b.name);
        });

        sortedChildren.forEach(function(child) {
          var childElements = renderItem(child, depth + 1);
          elements = elements.concat(childElements);
        });
      }

      return elements;
    };

    // Render root items - handle both null and undefined parentId
    var rootItems = files.filter(function(f) { return !f.parentId || f.parentId === ''; });
    console.log('[Editor] Root items:', rootItems);
    console.log('[Editor] Files parentIds:', files.map(f => f.id + ':' + f.parentId));
    var sortedRoots = rootItems.slice().sort(function(a, b) {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      return a.name.localeCompare(b.name);
    });

    console.log('[Editor] Sorted roots:', sortedRoots);
    
    sortedRoots.forEach(function(item) {
      var elements = renderItem(item, 0);
      console.log('[Editor] Item:', item.name, 'Elements:', elements.length);
      elements.forEach(function(el) {
        treeContent.appendChild(el);
      });
    });
    
    console.log('[Editor] treeContent children after render:', treeContent.children.length);
  }

  // Create a single tree item element (not recursive)
  function createTreeItemElementLegacy0(item, depth) {
    var isFolder = item.type === 'folder';
    var isExpanded = item.expanded;
    var isActive = item.id === currentFileId;

    var el = document.createElement('div');
    el.className = 'file-tree-item' + (isActive ? ' active' : '');
    el.style.paddingLeft = (depth * 20 + 12) + 'px';

    var icon = isFolder ? (isExpanded ? '📂' : '📁') : '📄';
    if (!isFolder) {
      var ext = item.name.split('.').pop().toLowerCase();
      if (ext === 'md' || ext === 'markdown') icon = '📝';
      else if (ext === 'txt') icon = '📃';
      else if (ext === 'json') icon = '📋';
      else if (ext === 'js') icon = '📜';
      else if (ext === 'html') icon = '🌐';
      else if (ext === 'docx' || item.type === 'docx') icon = '📄📝';
      else if (ext === 'xlsx' || ext === 'xls' || item.type === 'sheet') icon = '📊';
    }

    el.innerHTML = '<span class="file-tree-expand" data-id="' + item.id + '" style="display: ' + (isFolder ? 'inline' : 'none') + '">' + (isFolder ? (isExpanded ? '▼' : '▶') : '') + '</span>' +
      '<span class="file-icon">' + icon + '</span>' +
      '<span class="file-name">' + item.name + '</span>' +
      (isFolder ?
        '<button class="folder-rename" data-id="' + item.id + '" title="重命名">✏️</button><button class="folder-add" data-id="' + item.id + '" title="新建子文件夹">+</button><button class="folder-delete" data-id="' + item.id + '">&times;</button>' :
        '<button class="file-export" data-id="' + item.id + '" data-type="' + item.type + '" title="导出">📥</button><button class="file-rename" data-id="' + item.id + '" title="重命名">✏️</button><button class="file-delete" data-id="' + item.id + '">&times;</button>');

    // Click handler
    el.addEventListener('click', function(e) {
      if (e.target.classList.contains('file-tree-expand')) {
        e.stopPropagation();
        toggleFolder(item.id);
      } else if (e.target.classList.contains('file-delete')) {
        e.stopPropagation();
        const editorApi = window.InfinPilotEditor || window.InfinpilotEditor;
        if (editorApi && editorApi.deleteFile) {
          editorApi.deleteFile(item.id);
        }
      } else if (e.target.classList.contains('file-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
      } else if (e.target.classList.contains('file-export')) {
        e.stopPropagation();
        const fileType = e.target.dataset.type;
        if (fileType === 'docx') {
          exportDocxFileById(item.id);
        } else if (fileType === 'sheet') {
          exportSheetFileById(item.id);
        } else {
          exportMdFileById(item.id);
        }
      } else if (e.target.classList.contains('folder-delete')) {
        e.stopPropagation();
        deleteFolder(item.id);
      } else if (e.target.classList.contains('folder-rename')) {
        e.stopPropagation();
        var newName = prompt('请输入新文件夹名称:', item.name);
        if (newName && newName !== item.name) {
          item.name = newName;
          window.InfinpilotEditorFiles = files;
          renderFileTree();
        }
      } else if (e.target.classList.contains('folder-add')) {
        e.stopPropagation();
        createNewFolder(null, item.id);
      } else if (isFolder) {
        toggleFolder(item.id);
      } else {
        switchToFile(item.id);
      }
    });

    // Double-click to rename
    if (!isFolder) {
      el.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
      });
    } else {
      el.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        var newName = prompt('请输入新文件夹名称:', item.name);
        if (newName && newName !== item.name) {
          item.name = newName;
          window.InfinpilotEditorFiles = files;
          renderFileTree();
        }
      });
    }

    return el;
  }

  // Rename file with prompt
  function createTreeItemElementLegacy1(item, depth) {
    const isFolder = item.type === 'folder';
    const isRoot = isFolder && item.id === getRootFolder()?.id;
    const isExpanded = item.expanded;
    const isActive = item.id === currentFileId;
    const isSelected = item.id === selectedTreeItemId;

    const row = document.createElement('div');
    row.className = 'file-tree-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
    row.style.paddingLeft = (depth * 20 + 12) + 'px';
    row.dataset.itemId = item.id;
    row.dataset.itemType = item.type;
    row.draggable = !isRoot;

    let icon = isFolder ? '[D]' : '[F]';
    if (!isFolder) {
      const ext = item.name.split('.').pop().toLowerCase();
      if (ext === 'md' || ext === 'markdown') icon = '[M]';
      else if (ext === 'json') icon = '[J]';
      else if (ext === 'js') icon = '[JS]';
      else if (ext === 'html') icon = '[H]';
      else if (ext === 'docx' || item.type === 'docx') icon = '[W]';
      else if (ext === 'xlsx' || ext === 'xls' || item.type === 'sheet') icon = '[X]';
      else if (ext === 'txt') icon = '[T]';
    }

    const folderControls = isRoot
      ? '<button class="folder-add-file" data-id="' + item.id + '" title="New file">F</button><button class="folder-add" data-id="' + item.id + '" title="New folder">D</button>'
      : '<button class="folder-rename" data-id="' + item.id + '" title="Rename">R</button><button class="folder-add-file" data-id="' + item.id + '" title="New file">F</button><button class="folder-add" data-id="' + item.id + '" title="New folder">D</button><button class="folder-delete" data-id="' + item.id + '">&times;</button>';
    const fileControls = '<button class="file-export" data-id="' + item.id + '" data-type="' + item.type + '" title="Export">E</button><button class="file-rename" data-id="' + item.id + '" title="Rename">R</button><button class="file-delete" data-id="' + item.id + '">&times;</button>';

    row.innerHTML = '<span class="file-tree-expand" data-id="' + item.id + '" style="display: ' + (isFolder ? 'inline-flex' : 'none') + '">' + (isFolder ? (isExpanded ? '-' : '+') : '') + '</span>' +
      '<span class="file-icon">' + icon + '</span>' +
      '<span class="file-name">' + item.name + '</span>' +
      (isFolder ? folderControls : fileControls);

    row.addEventListener('click', function(e) {
      setSelectedTreeItemId(item.id);
      if (e.target.classList.contains('file-tree-expand')) {
        e.stopPropagation();
        toggleFolder(item.id);
        return;
      }

      if (e.target.classList.contains('file-delete')) {
        e.stopPropagation();
        void closeFile(item.id);
        return;
      }

      if (e.target.classList.contains('file-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('file-export')) {
        e.stopPropagation();
        const fileType = e.target.dataset.type;
        if (fileType === 'docx') {
          void exportDocxFileById(item.id);
        } else if (fileType === 'sheet') {
          void exportSheetFileById(item.id);
        } else {
          exportMdFileById(item.id);
        }
        return;
      }

      if (e.target.classList.contains('folder-delete')) {
        e.stopPropagation();
        void deleteFolder(item.id);
        return;
      }

      if (e.target.classList.contains('folder-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('folder-add-file')) {
        e.stopPropagation();
        createNewFile(null, item.id);
        return;
      }

      if (e.target.classList.contains('folder-add')) {
        e.stopPropagation();
        createNewFolder(null, item.id);
        return;
      }

      if (isFolder) {
        toggleFolder(item.id);
      } else {
        void switchToFile(item.id);
      }
    });

    row.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      if (isRoot) {
        return;
      }
      renameFileWithPrompt(item.id);
    });

    row.addEventListener('dragstart', function(e) {
      if (isRoot) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      setSelectedTreeItemId(item.id);
    });

    row.addEventListener('dragend', function() {
      row.classList.remove('dragging');
      row.classList.remove('drag-over');
    });

    if (isFolder) {
      row.addEventListener('dragover', function(e) {
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === item.id) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', function() {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', function(e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId) {
          return;
        }
        const result = moveTreeItem(draggedId, item.id);
        if (result?.success) {
          setSelectedTreeItemId(draggedId);
        }
      });
    }

    return row;
  }

  function createTreeItemElementLegacy2(item, depth) {
    const isFolder = item.type === 'folder';
    const isRoot = isFolder && item.id === getRootFolder()?.id;
    const isExpanded = item.expanded;
    const isActive = item.id === currentFileId;
    const isSelected = item.id === selectedTreeItemId;

    const row = document.createElement('div');
    row.className = 'file-tree-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
    row.style.paddingLeft = (depth * 20 + 12) + 'px';
    row.dataset.itemId = item.id;
    row.dataset.itemType = item.type;
    row.draggable = !isRoot;

    let icon = isFolder ? '[D]' : '[F]';
    if (!isFolder) {
      const ext = item.name.split('.').pop().toLowerCase();
      if (ext === 'md' || ext === 'markdown') icon = '[M]';
      else if (ext === 'json') icon = '[J]';
      else if (ext === 'js') icon = '[JS]';
      else if (ext === 'html') icon = '[H]';
      else if (ext === 'docx' || item.type === 'docx') icon = '[W]';
      else if (ext === 'xlsx' || ext === 'xls' || item.type === 'sheet') icon = '[X]';
      else if (ext === 'txt') icon = '[T]';
    }

    const folderControls = isRoot
      ? '<button class="folder-add-file" data-id="' + item.id + '" title="New file">F</button><button class="folder-add" data-id="' + item.id + '" title="New folder">D</button>'
      : '<button class="folder-rename" data-id="' + item.id + '" title="Rename">R</button><button class="folder-add-file" data-id="' + item.id + '" title="New file">F</button><button class="folder-add" data-id="' + item.id + '" title="New folder">D</button><button class="folder-delete" data-id="' + item.id + '">&times;</button>';
    const fileControls = '<button class="file-export" data-id="' + item.id + '" data-type="' + item.type + '" title="Export">E</button><button class="file-rename" data-id="' + item.id + '" title="Rename">R</button><button class="file-delete" data-id="' + item.id + '">&times;</button>';

    row.innerHTML = '<span class="file-tree-expand" data-id="' + item.id + '" style="display: ' + (isFolder ? 'inline-flex' : 'none') + '">' + (isFolder ? (isExpanded ? '-' : '+') : '') + '</span>' +
      '<span class="file-icon">' + icon + '</span>' +
      '<span class="file-name">' + item.name + '</span>' +
      (isFolder ? folderControls : fileControls);

    row.addEventListener('click', function(e) {
      setSelectedTreeItemId(item.id);
      if (e.target.classList.contains('file-tree-expand')) {
        e.stopPropagation();
        toggleFolder(item.id);
        return;
      }

      if (e.target.classList.contains('file-delete')) {
        e.stopPropagation();
        void closeFile(item.id);
        return;
      }

      if (e.target.classList.contains('file-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('file-export')) {
        e.stopPropagation();
        const fileType = e.target.dataset.type;
        if (fileType === 'docx') {
          void exportDocxFileById(item.id);
        } else if (fileType === 'sheet') {
          void exportSheetFileById(item.id);
        } else {
          exportMdFileById(item.id);
        }
        return;
      }

      if (e.target.classList.contains('folder-delete')) {
        e.stopPropagation();
        void deleteFolder(item.id);
        return;
      }

      if (e.target.classList.contains('folder-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('folder-add-file')) {
        e.stopPropagation();
        createNewFile(null, item.id);
        return;
      }

      if (e.target.classList.contains('folder-add')) {
        e.stopPropagation();
        createNewFolder(null, item.id);
        return;
      }

      if (isFolder) {
        toggleFolder(item.id);
      } else {
        void switchToFile(item.id);
      }
    });

    row.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      if (isRoot) {
        return;
      }
      renameFileWithPrompt(item.id);
    });

    row.addEventListener('dragstart', function(e) {
      if (isRoot) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      setSelectedTreeItemId(item.id);
    });

    row.addEventListener('dragend', function() {
      row.classList.remove('dragging');
      row.classList.remove('drag-over');
    });

    if (isFolder) {
      row.addEventListener('dragover', function(e) {
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === item.id) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', function() {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', function(e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId) {
          return;
        }
        const result = moveTreeItem(draggedId, item.id);
        if (result?.success) {
          setSelectedTreeItemId(draggedId);
        }
      });
    }

    return row;
  }

  function renameFileWithPromptLegacy(fileId) {
    var file = files.find(function(f) { return f.id === fileId; });
    if (!file) return;

    var newName = prompt('请输入新名称:', file.name);
    if (newName && newName !== file.name) {
      file.name = newName;
      window.InfinpilotEditorFiles = files;
      renderFileTabs();
      renderFileTree();
    }
  }

  // Toggle folder expand/collapse
  function toggleFolderLegacy(folderId) {
    const folder = files.find(f => f.id === folderId);
    if (folder && folder.type === 'folder') {
      folder.expanded = !folder.expanded;
      renderFileTree();
    }
  }

  // Delete folder
  function deleteFolderLegacy(folderId) {
    // Delete folder and all its contents
    const idsToDelete = [folderId];
    const findChildren = (parentId) => {
      files.filter(f => f.parentId === parentId).forEach(child => {
        idsToDelete.push(child.id);
        if (child.type === 'folder') findChildren(child.id);
      });
    };
    findChildren(folderId);

    // Remove all items
    files = files.filter(f => !idsToDelete.includes(f.id));

    // If current file was deleted, switch to another
    if (idsToDelete.includes(currentFileId)) {
      const remaining = files.find(f => f.type === 'file' || f.type === 'docx' || f.type === 'sheet');
      currentFileId = remaining?.id || null;
      if (currentFileId) {
        switchToFile(currentFileId);
      }
    }

    renderFileTree();
    renderFileTabs();
    window.InfinpilotEditorFiles = files;
    window.InfinpilotCurrentFileId = currentFileId;
    saveFilesToStorage();
  }

  // Create new folder
  function createNewFolderLegacy(name, parentId) {
    console.log('[Editor] createNewFolder called, current files:', files);
    // If no name provided, prompt user
    var folderName = name;
    if (!folderName) {
      folderName = prompt('请输入文件夹名称:', '新文件夹');
    }
    if (!folderName) return null;

    // If no parentId, use root folder
    if (!parentId) {
      var rootFolder = files.find(function(f) { return f.type === 'folder' && !f.parentId; });
      parentId = rootFolder ? rootFolder.id : (files[0] ? files[0].id : null);
    }

    var folderId = 'folder-' + Date.now();
    files.push({
      id: folderId,
      name: folderName,
      type: 'folder',
      parentId: parentId,
      expanded: true
    });

    console.log('[Editor] Folder added, files now:', files);
    
    window.InfinpilotEditorFiles = files;
    saveFilesToStorage(); // Save to storage
    renderFileTree();

    return { id: folderId, name: folderName, parentId: parentId };
  }

  // Toggle file tree
  function toggleFileTree() {
    var tree = document.getElementById('editor-file-tree');
    if (tree) {
      if (tree.classList.contains('show')) {
        tree.classList.remove('show');
      } else {
        tree.classList.add('show');
      }
    }
  }

  // Close file tree when clicking outside
  function initFileTreeCloseOnClickOutside() {
    document.addEventListener('click', function(e) {
      var tree = document.getElementById('editor-file-tree');
      var toggle = document.getElementById('editor-tree-toggle');
      if (tree && tree.classList.contains('show')) {
        if (!tree.contains(e.target) && !toggle.contains(e.target)) {
          tree.classList.remove('show');
        }
      }
    });
  }

  // Export all files - download each in its original format
  async function exportAllFiles() {
    if (typeof isSvgMode !== 'undefined' && isSvgMode) {
      await saveCurrentSvgContent();
      await saveFilesToStorage();
    }

    // Get all files
    var allFiles = getOpenableFiles();

    if (allFiles.length === 0) {
      return { success: false, error: '没有文件可导出' };
    }

    // Download each file one by one
    allFiles.forEach(function(file, index) {
      // Delay each download slightly to avoid browser blocking
      setTimeout(function() {
        if (file.type === 'docx') {
          void exportDocxFileById(file.id);
          return;
        }
        if (file.type === 'sheet') {
          void exportSheetFileById(file.id);
          return;
        }
        if (file.type === 'svg') {
          void exportSvgFileById(file.id);
          return;
        }
        exportMdFileById(file.id);
      }, index * 220);
    });

    return { success: true, message: '正在导出 ' + allFiles.length + ' 个文件...' };
  }

  // Initialize file tree events
  function initFileTree() {
    var treeToggle = document.getElementById('editor-tree-toggle');
    var treeAdd = document.getElementById('file-tree-add');
    var treeAddFolder = document.getElementById('file-tree-add-folder');
    var treeExport = document.getElementById('file-tree-export-all');

    console.log('[Editor] initFileTree called');
    console.log('[Editor] treeToggle:', treeToggle);
    console.log('[Editor] treeAdd:', treeAdd);
    console.log('[Editor] treeAddFolder:', treeAddFolder);

    if (treeToggle) {
      treeToggle.addEventListener('click', toggleFileTree);
    }
    if (treeAdd) {
      treeAdd.addEventListener('click', function(e) {
        e.stopPropagation();
        console.log('[Editor] Add file button clicked');
        createNewFile(null, getPreferredCreationFolderId());
      });
    }
    if (treeAddFolder) {
      treeAddFolder.addEventListener('click', function(e) {
        e.stopPropagation();
        console.log('[Editor] Add folder button clicked');
        createNewFolder(null, getPreferredCreationFolderId());
      });
    }
    if (treeExport) {
      treeExport.addEventListener('click', function(e) {
        e.stopPropagation();
        exportAllFiles();
      });
    }

    // Initialize close on click outside
    initFileTreeCloseOnClickOutside();

    // Auto-show file tree on init
    var tree = document.getElementById('editor-file-tree');
    console.log('[Editor] file-tree element:', tree);
    if (tree) {
      tree.classList.add('show');
      console.log('[Editor] Added .show class, classes:', tree.className);
    }
    
    renderFileTree();
  }

  // Switch to file
  async function switchToFileLegacy(fileId) {
    // If current is DOCX mode, save DOCX content first
    if (isDocxMode) {
      await saveCurrentDocxContent();
      await saveDocxFilesToStorage();
    }
    
    // If current is Sheet mode, save Sheet content first
    if (isSheetMode) {
      await saveCurrentSheetContent();
      await saveSheetFilesToStorage();
    }
    
    // 先查找文件
    var file = files.find(function(f) { return f.id === fileId; });
    
    if (!file) return;

    // 如果是 DOCX 文件，切换到 DOCX 模式
    if (file.type === 'docx') {
      switchToDocxFile(fileId);
      return;
    }
    
    // 如果是 Sheet 文件，切换到 Sheet 模式
    if (file.type === 'sheet') {
      await switchToSheetFile(fileId);
      return;
    }
    
    // 如果是普通文件，切换到 Markdown 模式
    // 如果当前在 DOCX 模式，先切换回 MD 模式
    if (isDocxMode) {
      await switchToMarkdownMode();
    }
    
    // 如果当前在 Sheet 模式，先切换回 MD 模式
    if (isSheetMode) {
      await switchToMarkdownModeFromSheet();
    }

    currentFileId = fileId;
    window.InfinpilotCurrentFileId = currentFileId;

    // Update editor content
    setContent(file.content, 'file-switch');
    renderFileTabs();
    renderFileTree();
  }

  // Create new file
  function createNewFileLegacy(name = null, parentId = null) {
    console.log('[Editor] createNewFile called, current files:', files);
    const fileId = 'file-' + Date.now();
    const fileName = name || `未命名${files.length + 1}.md`;

    // Find parent folder (default to root folder if not specified)
    if (!parentId) {
      const rootFolder = files.find(f => f.type === 'folder' && !f.parentId);
      console.log('[Editor] Root folder:', rootFolder);
      parentId = rootFolder?.id || files[0]?.id;
    }

    files.push({
      id: fileId,
      name: fileName,
      type: 'file',
      content: '',
      imageMap: {},
      parentId: parentId
    });

    console.log('[Editor] File added, files now:', files);
    
    switchToFile(fileId);
    renderFileTabs();
    renderFileTree();
    window.InfinpilotEditorFiles = files;
    saveFilesToStorage();
    return { id: fileId, name: fileName, parentId };
  }

  // Close file (including DOCX)
  async function closeFileLegacy(fileId) {
    // If closing current DOCX file, save content first
    if (currentFileId === fileId && isDocxMode) {
      await saveCurrentDocxContent();
      await saveDocxFilesToStorage();
    }

    if (currentFileId === fileId && isSheetMode) {
      await saveCurrentSheetContent();
      await saveSheetFilesToStorage();
    }
    
    // Get only files, not folders (including DOCX and Sheet)
    var fileItems = files.filter(function(f) { return f.type === 'file' || f.type === 'docx' || f.type === 'sheet'; });

    if (fileItems.length <= 1) {
      // Don't close the last file, just clear it
      var file = files.find(function(f) { return f.id === fileId && (f.type === 'file' || f.type === 'docx' || f.type === 'sheet'); });
      if (file) {
        if (file.type === 'docx') {
          // For DOCX files, just clear the content
          file.content = '';
        } else if (file.type === 'sheet') {
          file.content = '';
          loadedSheetData = null;
        } else {
          file.content = '';
          file.imageMap = {};
        }
        setContent('', 'close-file');
      }
      renderFileTabs();
      renderFileTree();
      return;
    }

    var index = files.findIndex(function(f) { return f.id === fileId; });
    if (index === -1) return;

    var deletingCurrentFile = currentFileId === fileId;
    var nextFileAfterDelete = files.find(function(f, fileIndex) {
      return fileIndex !== index && (f.type === 'file' || f.type === 'docx' || f.type === 'sheet');
    });

    if (deletingCurrentFile && isDocxMode && nextFileAfterDelete && nextFileAfterDelete.type !== 'docx') {
      await switchToMarkdownMode();
    }

    if (deletingCurrentFile && isSheetMode && nextFileAfterDelete && nextFileAfterDelete.type !== 'sheet') {
      await switchToMarkdownModeFromSheet();
    }

    files.splice(index, 1);

    // If closing current file, switch to another
    if (deletingCurrentFile) {
      var nextFile = files.find(function(f) { return f.type === 'file' || f.type === 'docx' || f.type === 'sheet'; });
      if (nextFile) {
        currentFileId = nextFile.id;
        window.InfinpilotCurrentFileId = currentFileId;
        if (nextFile.type === 'sheet') {
          await switchToSheetFile(nextFile.id);
        } else if (nextFile.type === 'docx') {
          await switchToDocxFile(nextFile.id);
        } else {
          setContent(nextFile.content, 'file-switch');
        }
      }
    }

    window.InfinpilotEditorFiles = files;
    await saveFilesToStorage();
    renderFileTabs();
    renderFileTree();
  }

  function renderFileTabs() {
    const tabsContainer = document.getElementById('editor-files-tabs');
    const newFileBtn = document.getElementById('editor-new-file-btn');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = '';

    getOpenableFiles().forEach(file => {
      const tab = document.createElement('div');
      tab.className = 'editor-file-tab' + (file.id === currentFileId ? ' active' : '');
      tab.innerHTML = '<span class="file-name">' + file.name + '</span><span class="file-close" data-id="' + file.id + '">&times;</span>';

      tab.addEventListener('click', function(e) {
        if (e.target.classList.contains('file-close')) {
          e.stopPropagation();
          void closeFile(file.id);
          return;
        }
        void switchToFile(file.id);
      });

      tab.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        renameFileWithPrompt(file.id);
      });

      tabsContainer.appendChild(tab);
    });

    if (newFileBtn) {
      newFileBtn.onclick = function() {
        createNewFile(null, getPreferredCreationFolderId());
      };
    }
  }

  function renderFileTree() {
    const treeContent = document.getElementById('file-tree-content');
    if (!treeContent) {
      console.warn('[Editor] file-tree-content element not found');
      return;
    }

    treeContent.innerHTML = '';

    const rootFolder = getRootFolder();
    if (!rootFolder) {
      treeContent.innerHTML = '<div style="padding: 10px; color: #888;">No folders</div>';
      return;
    }

    const renderItem = function(item, depth) {
      const elements = [createTreeItemElement(item, depth)];
      if (item.type === 'folder' && item.expanded) {
        const children = files
          .filter(child => child.parentId === item.id)
          .slice()
          .sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name);
          });

        children.forEach(child => {
          elements.push(...renderItem(child, depth + 1));
        });
      }
      return elements;
    };

    renderItem(rootFolder, 0).forEach(node => treeContent.appendChild(node));

    treeContent.onclick = function(e) {
      if (e.target === treeContent) {
        setSelectedTreeItemId(rootFolder.id);
        renderFileTree();
      }
    };
    treeContent.ondragover = function(e) {
      const draggedId = e.dataTransfer?.getData('text/plain');
      if (!draggedId) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    };
    treeContent.ondrop = function(e) {
      const draggedId = e.dataTransfer?.getData('text/plain');
      if (!draggedId || e.target.closest('.file-tree-item')) {
        return;
      }
      e.preventDefault();
      const result = moveTreeItem(draggedId, rootFolder.id);
      if (result?.success) {
        setSelectedTreeItemId(draggedId);
      }
    };
  }

  function createTreeItemElementLegacy3(item, depth) {
    const isFolder = item.type === 'folder';
    const isRoot = isFolder && item.id === getRootFolder()?.id;
    const isExpanded = item.expanded;
    const isActive = item.id === currentFileId;
    const isSelected = item.id === selectedTreeItemId;

    const row = document.createElement('div');
    row.className = 'file-tree-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
    row.style.paddingLeft = (depth * 20 + 12) + 'px';
    row.dataset.itemId = item.id;
    row.dataset.itemType = item.type;
    row.draggable = !isRoot;

    let icon = isFolder ? (isExpanded ? '📂' : '📁') : '📄';
    if (!isFolder) {
      const ext = item.name.split('.').pop().toLowerCase();
      if (ext === 'md' || ext === 'markdown') icon = '📝';
      else if (ext === 'txt') icon = '📄';
      else if (ext === 'json') icon = '🧩';
      else if (ext === 'js') icon = '📜';
      else if (ext === 'html') icon = '🌐';
      else if (ext === 'docx' || item.type === 'docx') icon = '📘';
      else if (ext === 'xlsx' || ext === 'xls' || item.type === 'sheet') icon = '📊';
    }

    const folderControls = isRoot
      ? '<button class="folder-add" data-id="' + item.id + '" title="New folder">+</button>'
      : '<button class="folder-rename" data-id="' + item.id + '" title="Rename">✎</button><button class="folder-add" data-id="' + item.id + '" title="New folder">+</button><button class="folder-delete" data-id="' + item.id + '">&times;</button>';
    const fileControls = '<button class="file-export" data-id="' + item.id + '" data-type="' + item.type + '" title="Export">⭳</button><button class="file-rename" data-id="' + item.id + '" title="Rename">✎</button><button class="file-delete" data-id="' + item.id + '">&times;</button>';

    row.innerHTML = '<span class="file-tree-expand" data-id="' + item.id + '" style="display: ' + (isFolder ? 'inline-flex' : 'none') + '">' + (isFolder ? (isExpanded ? '▾' : '▸') : '') + '</span>' +
      '<span class="file-icon">' + icon + '</span>' +
      '<span class="file-name">' + item.name + '</span>' +
      (isFolder ? folderControls : fileControls);

    row.addEventListener('click', function(e) {
      setSelectedTreeItemId(item.id);
      if (e.target.classList.contains('file-tree-expand')) {
        e.stopPropagation();
        toggleFolder(item.id);
        return;
      }

      if (e.target.classList.contains('file-delete')) {
        e.stopPropagation();
        void closeFile(item.id);
        return;
      }

      if (e.target.classList.contains('file-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('file-export')) {
        e.stopPropagation();
        const fileType = e.target.dataset.type;
        if (fileType === 'docx') {
          void exportDocxFileById(item.id);
        } else if (fileType === 'sheet') {
          void exportSheetFileById(item.id);
        } else {
          exportMdFileById(item.id);
        }
        return;
      }

      if (e.target.classList.contains('folder-delete')) {
        e.stopPropagation();
        void deleteFolder(item.id);
        return;
      }

      if (e.target.classList.contains('folder-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('folder-add')) {
        e.stopPropagation();
        createNewFolder(null, item.id);
        return;
      }

      if (isFolder) {
        toggleFolder(item.id);
      } else {
        void switchToFile(item.id);
      }
    });

    row.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      if (isRoot) {
        return;
      }
      renameFileWithPrompt(item.id);
    });

    row.addEventListener('dragstart', function(e) {
      if (isRoot) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      setSelectedTreeItemId(item.id);
    });

    row.addEventListener('dragend', function() {
      row.classList.remove('dragging');
      row.classList.remove('drag-over');
    });

    if (isFolder) {
      row.addEventListener('dragover', function(e) {
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === item.id) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', function() {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', function(e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId) {
          return;
        }
        const result = moveTreeItem(draggedId, item.id);
        if (result?.success) {
          setSelectedTreeItemId(draggedId);
        }
      });
    }

    return row;
  }

  function renameFileWithPrompt(fileId) {
    const item = files.find(file => file.id === fileId);
    if (!item) return;

    if (item.type === 'folder' && item.id === getRootFolder()?.id) {
      return;
    }

    const newName = prompt('请输入新名称:', item.name);
    if (!newName || newName === item.name) {
      return;
    }

    item.name = newName;
    setSelectedTreeItemId(item.id);
    syncFileGlobals();
    void syncProjectReferenceForFile(item);
    void saveFilesToStorage();
    renderFileTabs();
    renderFileTree();
  }

  function toggleFolder(folderId) {
    const folder = files.find(item => item.id === folderId && item.type === 'folder');
    if (!folder) return;

    folder.expanded = !folder.expanded;
    syncFileGlobals();
    void saveFilesToStorage();
    renderFileTree();
  }

  async function deleteFolder(folderId) {
    const rootFolder = getRootFolder();
    if (!folderId || !rootFolder || folderId === rootFolder.id) {
      return { success: false, error: 'Cannot delete the root folder' };
    }
    const folder = files.find(item => item.id === folderId && item.type === 'folder');
    if (!folder) {
      return { success: false, error: 'Folder not found' };
    }

    const idsToDelete = new Set([folderId]);
    const collectChildren = parentId => {
      files.filter(item => item.parentId === parentId).forEach(child => {
        if (!idsToDelete.has(child.id)) {
          idsToDelete.add(child.id);
          if (child.type === 'folder') {
            collectChildren(child.id);
          }
        }
      });
    };
    collectChildren(folderId);

    const removedOpenableFileIds = files
      .filter(item => idsToDelete.has(item.id) && isOpenableFile(item))
      .map(item => item.id);
    const nextFile = getOpenableFiles().find(item => !idsToDelete.has(item.id)) || null;
    const deletingCurrentFile = currentFileId && idsToDelete.has(currentFileId);

    if (deletingCurrentFile && isDocxMode && (!nextFile || nextFile.type !== 'docx')) {
      await switchToMarkdownMode();
    }
    if (deletingCurrentFile && isSheetMode && (!nextFile || nextFile.type !== 'sheet')) {
      await switchToMarkdownModeFromSheet();
    }
    if (deletingCurrentFile && typeof isSvgMode !== 'undefined' && isSvgMode && (!nextFile || nextFile.type !== 'svg')) {
      await switchToMarkdownModeFromSvg();
    }

    files = files.filter(item => !idsToDelete.has(item.id));
    syncFileGlobals();
    await removeProjectReferencesForFileIds(removedOpenableFileIds);
    await saveFilesToStorage();

    if (deletingCurrentFile) {
      if (nextFile) {
        await switchToFile(nextFile.id);
      } else {
        clearEditorWhenNoFileSelected();
        renderFileTabs();
        renderFileTree();
      }
    } else {
      if (selectedTreeItemId && idsToDelete.has(selectedTreeItemId)) {
        setSelectedTreeItemId(folder.parentId || getRootFolder()?.id || null);
      }
      renderFileTabs();
      renderFileTree();
    }

    return { success: true };
  }

  function createNewFolder(name, parentId) {
    const folderName = name || prompt('请输入文件夹名称:', 'New Folder');
    if (!folderName) return null;

    const targetParentId = getValidParentFolderId(parentId || getPreferredCreationFolderId());
    const folder = {
      id: createId('folder'),
      name: folderName,
      type: 'folder',
      parentId: targetParentId,
      expanded: true
    };

    files.push(folder);
    setSelectedTreeItemId(folder.id);
    expandFolderPathForItem(folder);
    syncFileGlobals();
    void saveFilesToStorage();
    renderFileTabs();
    renderFileTree();
    return { id: folder.id, name: folder.name, parentId: folder.parentId };
  }

  async function switchToFile(fileId) {
    const file = files.find(item => item.id === fileId && isOpenableFile(item));
    if (!file) return;

    if (isDocxMode) {
      await saveCurrentDocxContent();
      await saveDocxFilesToStorage();
    }
    if (isSheetMode) {
      await saveCurrentSheetContent();
      await saveSheetFilesToStorage();
    }
    if (typeof isSvgMode !== 'undefined' && isSvgMode) {
      await saveCurrentSvgContent();
    }

    if (file.type === 'docx') {
      if (typeof isSvgMode !== 'undefined' && isSvgMode) {
        await switchToMarkdownModeFromSvg();
      }
      await switchToDocxFile(fileId);
      return;
    }

    if (file.type === 'sheet') {
      if (typeof isSvgMode !== 'undefined' && isSvgMode) {
        await switchToMarkdownModeFromSvg();
      }
      await switchToSheetFile(fileId);
      return;
    }

    if (file.type === 'svg') {
      await switchToSvgFile(fileId);
      return;
    }

    if (isDocxMode) {
      await switchToMarkdownMode();
    }
    if (isSheetMode) {
      await switchToMarkdownModeFromSheet();
    }
    if (typeof isSvgMode !== 'undefined' && isSvgMode) {
      await switchToMarkdownModeFromSvg();
    }

    currentFileId = fileId;
    setSelectedTreeItemId(fileId);
    const expandedPath = expandFolderPathForItem(file);
    syncFileGlobals();
    dispatchCurrentFileChangedEvent();
    if (expandedPath) {
      void saveFilesToStorage();
    }
    setContent(file.content || '', 'file-switch');
    renderFileTabs();
    renderFileTree();
  }

  function createNewFile(name = null, parentId = null) {
    const file = {
      id: createId('file'),
      name: name || getNextMarkdownFileName(),
      type: 'file',
      content: '',
      imageMap: {},
      parentId: getValidParentFolderId(parentId || getPreferredCreationFolderId())
    };

    files.push(file);
    setSelectedTreeItemId(file.id);
    expandFolderPathForItem(file);
    syncFileGlobals();
    void saveFilesToStorage();
    void switchToFile(file.id);
    renderFileTabs();
    renderFileTree();
    return { id: file.id, name: file.name, parentId: file.parentId };
  }

  async function closeFile(fileId) {
    const file = files.find(item => item.id === fileId && isOpenableFile(item));
    if (!file) {
      return;
    }

    const deletingCurrentFile = currentFileId === fileId;
    const nextFile = getOpenableFiles().find(item => item.id !== fileId) || null;

    if (deletingCurrentFile) {
      if (isDocxMode) {
        if (nextFile && nextFile.type === 'docx') {
          await saveCurrentDocxContent();
          await saveDocxFilesToStorage();
        } else {
          await switchToMarkdownMode();
        }
      }

      if (isSheetMode) {
        if (nextFile && nextFile.type === 'sheet') {
          await saveCurrentSheetContent();
          await saveSheetFilesToStorage();
        } else {
          await switchToMarkdownModeFromSheet();
        }
      }

      if (typeof isSvgMode !== 'undefined' && isSvgMode) {
        if (nextFile && nextFile.type === 'svg') {
          await saveCurrentSvgContent();
        } else {
          await switchToMarkdownModeFromSvg();
        }
      }
    }

    files = files.filter(item => item.id !== fileId);
    syncFileGlobals();
    await removeProjectReferencesForFileIds([fileId]);
    await saveFilesToStorage();

    if (deletingCurrentFile) {
      if (nextFile) {
        await switchToFile(nextFile.id);
      } else {
        clearEditorWhenNoFileSelected();
        renderFileTabs();
        renderFileTree();
      }
      return;
    }

    if (selectedTreeItemId === fileId) {
      setSelectedTreeItemId(getPreferredCreationFolderId());
    }
    renderFileTabs();
    renderFileTree();
  }

  function initFileBar() {
    renderFileTabs();
    const file = getCurrentFile();
    if (file) {
      setContent(file.content || '', 'init');
      dispatchCurrentFileChangedEvent();
      return;
    }

    mdState.content = '';
    if (cmEditor && cmEditor.getValue() !== '') {
      cmEditor.setValue('');
    }
    renderPreview();
    updateStats();
    dispatchCurrentFileChangedEvent();
  }

  function createTreeItemElement(item, depth) {
    const isFolder = item.type === 'folder';
    const isRoot = isFolder && item.id === getRootFolder()?.id;
    const isExpanded = item.expanded;
    const isActive = item.id === currentFileId;
    const isSelected = item.id === selectedTreeItemId;

    const row = document.createElement('div');
    row.className = 'file-tree-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
    row.style.paddingLeft = (depth * 20 + 12) + 'px';
    row.dataset.itemId = item.id;
    row.dataset.itemType = item.type;
    row.draggable = !isRoot;

    let icon = isFolder ? '[D]' : '[F]';
    if (!isFolder) {
      const ext = item.name.split('.').pop().toLowerCase();
      if (ext === 'md' || ext === 'markdown') icon = '[M]';
      else if (ext === 'txt') icon = '[T]';
      else if (ext === 'json') icon = '[J]';
      else if (ext === 'js') icon = '[JS]';
      else if (ext === 'html') icon = '[H]';
      else if (ext === 'docx' || item.type === 'docx') icon = '[W]';
      else if (ext === 'xlsx' || ext === 'xls' || item.type === 'sheet') icon = '[X]';
      else if (ext === 'svg' || item.type === 'svg') icon = '[S]';
    }

    const folderControls = isRoot
      ? '<button class="folder-add-file" data-id="' + item.id + '" title="New file">F</button><button class="folder-add" data-id="' + item.id + '" title="New folder">D</button>'
      : '<button class="folder-rename" data-id="' + item.id + '" title="Rename">R</button><button class="folder-add-file" data-id="' + item.id + '" title="New file">F</button><button class="folder-add" data-id="' + item.id + '" title="New folder">D</button><button class="folder-delete" data-id="' + item.id + '">&times;</button>';
    const fileControls = '<button class="file-export" data-id="' + item.id + '" data-type="' + item.type + '" title="Export">E</button><button class="file-rename" data-id="' + item.id + '" title="Rename">R</button><button class="file-delete" data-id="' + item.id + '">&times;</button>';

    row.innerHTML = '<span class="file-tree-expand" data-id="' + item.id + '" style="display: ' + (isFolder ? 'inline-flex' : 'none') + '">' + (isFolder ? (isExpanded ? '-' : '+') : '') + '</span>' +
      '<span class="file-icon">' + icon + '</span>' +
      '<span class="file-name">' + item.name + '</span>' +
      (isFolder ? folderControls : fileControls);

    row.addEventListener('click', function(e) {
      setSelectedTreeItemId(item.id);
      if (e.target.classList.contains('file-tree-expand')) {
        e.stopPropagation();
        toggleFolder(item.id);
        return;
      }

      if (e.target.classList.contains('file-delete')) {
        e.stopPropagation();
        void closeFile(item.id);
        return;
      }

      if (e.target.classList.contains('file-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('file-export')) {
        e.stopPropagation();
        const fileType = e.target.dataset.type;
        if (fileType === 'docx') {
          void exportDocxFileById(item.id);
        } else if (fileType === 'sheet') {
          void exportSheetFileById(item.id);
        } else if (fileType === 'svg') {
          void exportSvgFileById(item.id);
        } else {
          exportMdFileById(item.id);
        }
        return;
      }

      if (e.target.classList.contains('folder-delete')) {
        e.stopPropagation();
        void deleteFolder(item.id);
        return;
      }

      if (e.target.classList.contains('folder-rename')) {
        e.stopPropagation();
        renameFileWithPrompt(item.id);
        return;
      }

      if (e.target.classList.contains('folder-add-file')) {
        e.stopPropagation();
        createNewFile(null, item.id);
        return;
      }

      if (e.target.classList.contains('folder-add')) {
        e.stopPropagation();
        createNewFolder(null, item.id);
        return;
      }

      if (isFolder) {
        toggleFolder(item.id);
      } else {
        void switchToFile(item.id);
      }
    });

    row.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      if (isRoot) {
        return;
      }
      renameFileWithPrompt(item.id);
    });

    row.addEventListener('dragstart', function(e) {
      if (isRoot) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      setSelectedTreeItemId(item.id);
    });

    row.addEventListener('dragend', function() {
      row.classList.remove('dragging');
      row.classList.remove('drag-over');
    });

    if (isFolder) {
      row.addEventListener('dragover', function(e) {
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === item.id) {
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', function() {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', function(e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId) {
          return;
        }
        const result = moveTreeItem(draggedId, item.id);
        if (result?.success) {
          setSelectedTreeItemId(draggedId);
        }
      });
    }

    return row;
  }

  // Save current file content
  function saveCurrentFileContent() {
    const file = getCurrentFile();
    if (file && cmEditor) {
      file.content = cmEditor.getValue();
      file.imageMap = file.imageMap || {};
      // Copy imageMap from main mdState if exists
      if (mdState.imageMap) {
        Object.assign(file.imageMap, mdState.imageMap);
      }
    }
  }

  // Large content threshold (100KB)
  const LARGE_CONTENT_THRESHOLD = 100 * 1024;

  // Hook into setContent for autosave scheduling
  const originalSetContent = setContent;
  setContent = function(next, from = 'program') {
    mdState.content = next;

    // Check if content is too large - skip expensive operations for large content
    const isLargeContent = next.length > LARGE_CONTENT_THRESHOLD;

    if (from !== 'cm' && cmEditor && cmEditor.getValue() !== next) {
        cmEditor.setValue(next);
    }

    // Skip preview rendering and stats for large content to prevent browser freeze
    if (!isLargeContent) {
      renderPreview();
      updateStats();
    } else {
      // For large content, just update the preview container placeholder
      if (el.preview) {
        el.preview.innerHTML = '<div style="padding: 20px; color: #888; text-align: center;">文件较大，预览已跳过<br>请查看编辑器内容</div>';
      }
      // Use setTimeout to defer stats calculation for large content
      setTimeout(() => {
        updateStats();
      }, 100);
    }
    // Skip autosave during file switch - switchToFile already handles saving
    if (from !== 'file-switch') {
      scheduleAutosave();
    }

    // Note: Don't update file content here - switchToFile already handles saving
    // Updating content here causes issues when switching between DOCX and MD files
    // because currentFileId is not yet updated when setContent is called
  }

  // 解析带格式的文本为 ProseMirror 节点数组（内联格式）
  // 支持：**粗体**、*斜体*、~~删除线~~、`行内代码`
  function parseTextWithFormattingInline(text, schema) {
    if (!text || !schema) return null;
    
    // 检查 schema 是否有效
    if (!schema.text || !schema.marks) {
      console.warn('[parseTextWithFormatting] Schema missing text or marks');
      return null;
    }
    
    const nodes = [];
    let remaining = text;
    
    // 格式匹配正则（按优先级排序：先匹配更长的）
    // 注意：SuperDoc 使用 bold 而不是 strong，使用 italic 而不是 em
    const formats = [
      { pattern: /^\*\*\*(.+?)\*\*\*/g, marks: ['bold', 'italic'] },  // ***粗斜体***
      { pattern: /^\*\*(.+?)\*\*/g, marks: ['bold'] },             // **粗体**
      { pattern: /^\*(.+?)\*/g, marks: ['italic'] },             // *斜体*
      { pattern: /^~~(.+?)~~/g, marks: ['strike'] },             // ~~删除线~~
      { pattern: /^`(.+?)`/g, marks: ['code'] },               // `代码`
    ];
    
    // 检查是否有可用的 mark - 同时支持 strong/bold 和 em/italic
    const availableMarks = {};
    if (schema.marks.strong || schema.marks.bold) {
      availableMarks.bold = schema.marks.bold || schema.marks.strong;
      availableMarks.strong = availableMarks.bold;
    }
    if (schema.marks.em || schema.marks.italic) {
      availableMarks.italic = schema.marks.italic || schema.marks.em;
      availableMarks.em = availableMarks.italic;
    }
    if (schema.marks.strike) availableMarks.strike = 'strike';
    if (schema.marks.code) availableMarks.code = 'code';
    
    console.log('[parseTextWithFormatting] Available marks:', Object.keys(availableMarks));
    console.log('[parseTextWithFormatting] Checking schema.marks:', schema.marks);
    
    while (remaining.length > 0) {
      let matched = false;
      
      // 尝试匹配各种格式
      for (const fmt of formats) {
        fmt.pattern.lastIndex = 0; // 重置正则
        const match = remaining.match(fmt.pattern);
        if (match) {
          const content = match[1];
          
          // 创建文本节点
          let textNode = schema.text(content);
          if (!textNode) {
            console.warn('[parseTextWithFormatting] Failed to create text node');
            continue;
          }
          
          // 应用所有可用的 marks
          const marksToApply = fmt.marks.filter(m => availableMarks[m]);
          if (marksToApply.length > 0) {
            try {
              const marks = marksToApply.map(m => availableMarks[m].create());
              textNode = textNode.mark(marks);
            } catch (e) {
              console.warn('[parseTextWithFormatting] Failed to apply marks:', e);
            }
          }
          
          nodes.push(textNode);
          remaining = remaining.slice(match[0].length);
          matched = true;
          break;
        }
      }
      
      // 没有匹配到格式，作为普通文本
      if (!matched) {
        // 找到下一个可能的格式标记位置
        let nextPos = remaining.length;
        
        for (const fmt of formats) {
          fmt.pattern.lastIndex = 0;
          const match = remaining.match(fmt.pattern);
          if (match) {
            const pos = remaining.indexOf(match[0]);
            if (pos >= 0 && pos < nextPos) {
              nextPos = pos;
            }
          }
        }
        
        // 取到下一个格式之前的文本作为普通文本
        const plainText = remaining.slice(0, nextPos);
        if (plainText) {
          const textNode = schema.text(plainText);
          if (textNode) {
            nodes.push(textNode);
          }
        }
        remaining = remaining.slice(nextPos);
      }
    }
    
    if (nodes.length === 0) {
      return null;
    }
    
    console.log('[parseTextWithFormatting] Created', nodes.length, 'nodes');
    return nodes;
  }

  function refreshEditor() {
    if (cmEditor) {
        setTimeout(() => { // Use a small timeout to ensure the tab is visible
            cmEditor.refresh();
            cmEditor.focus();
        }, 50);
    }
  }

  window.InfinPilotEditor = {
      refresh: refreshEditor,
      setContent: setContent,
      insertAtCursor: insertAtCursor,
      replaceSelection: replaceSelection,
      getSelectionText: getSelectionText,
      wrapSelection: wrapSelection,
      prefixLines: prefixLines,
      getContent: function() {
        return cmEditor ? cmEditor.getValue() : '';
      },
      getState: function() {
        return mdState;
      },
      // Agent可用的扩展功能
      insertCurrentUrl: async function() {
        try {
          const res = await browser.runtime.sendMessage({ action: 'getActiveTabInfo' });
          if (res?.success) {
            const { url, title } = res;
            if (url && !mdState.sourceUrls.includes(url)) mdState.sourceUrls.push(url);
            insertAtCursor(`\n- [${title || url}](${url})\n`);
            return { success: true, message: '已插入当前网址' };
          }
          return { success: false, error: res?.error || '获取网址失败' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      insertAllTabs: async function() {
        try {
          const res = await browser.runtime.sendMessage({ action: 'getAllOpenTabs' });
          if (res?.success && Array.isArray(res.tabs)) {
            const lines = res.tabs.map(t => `- [${t.title || t.url}](${t.url})`).join('\n');
            insertAtCursor(`\n##参考链接\n${lines}\n`);
            res.tabs.forEach(t => {
              if (t.url && !mdState.sourceUrls.includes(t.url)) mdState.sourceUrls.push(t.url);
            });
            return { success: true, message: `已插入${res.tabs.length}个标签页` };
          }
          return { success: false, error: res?.error || '获取标签页失败' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      captureAndInsertScreenshot: async function() {
        try {
          const capturedAt = new Date().toLocaleString('zh-CN');

          // 通过background脚本截图（sidepanel中tabs API可能有权限限制）
          const screenshotRes = await browser.runtime.sendMessage({
            action: 'captureScreenshotDirect'
          });

          if (!screenshotRes?.success) {
            return { success: false, error: screenshotRes?.error || '截图失败' };
          }

          const { dataUrl, url, title } = screenshotRes;

          // 保存到imageMap
          if (url && !mdState.sourceUrls.includes(url)) mdState.sourceUrls.push(url);

          const imageId = `infinpilot-img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          if (!mdState.imageMap) mdState.imageMap = {};
          mdState.imageMap[imageId] = dataUrl;

          insertAtCursor(`\n![Screenshot](${imageId})\n\n> Captured from: [${title || url}](${url}) at ${capturedAt}\n`);

          return { success: true, message: '已插入截图', imageId: imageId };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      // 文件管理功能
      getFiles: function() {
        return files.filter(function(f) { return f.type === 'file'; }).map(function(f) { return { id: f.id, name: f.name, parentId: f.parentId }; });
      },
      // 获取所有文件（包括 DOCX）
      getAllFiles: function() {
        return files.filter(function(f) { return f.type === 'file' || f.type === 'docx' || f.type === 'sheet' || f.type === 'svg'; }).map(function(f) { return { id: f.id, name: f.name, type: f.type, parentId: f.parentId }; });
      },
      getFolders: function() {
        return files.filter(function(f) { return f.type === 'folder'; }).map(function(f) { return { id: f.id, name: f.name, parentId: f.parentId }; });
      },
      getCurrentFileId: function() {
        return currentFileId;
      },
      createFile: function(name) {
        const result = createNewFile(name);
        return { success: true, id: result.id, name: result.name };
      },
      switchFile: function(fileId) {
        const file = files.find(f => f.id === fileId);
        if (!file) {
          return { success: false, error: '文件不存在' };
        }
        switchToFile(fileId);
        return { success: true, id: fileId, name: file.name };
      },
      deleteFile: function(fileId) {
        var fileItems = files.filter(function(f) { return f.type === 'file' || f.type === 'docx' || f.type === 'sheet'; });
        if (fileItems.length <= 1) {
          return { success: false, error: '不能删除最后一个文件' };
        }
        var file = files.find(function(f) { return f.id === fileId && (f.type === 'file' || f.type === 'docx' || f.type === 'sheet'); });
        if (!file) {
          return { success: false, error: '文件不存在或不能删除文件夹' };
        }
        // 实际删除文件
        void closeFile(fileId);
        // 切换到其他文件
        const remaining = files.find(f => f.type === 'file' || f.type === 'docx');
        return { success: true };
      },
      renameFile: function(fileId, newName) {
        const file = files.find(f => f.id === fileId);
        if (!file) {
          return { success: false, error: '文件不存在' };
        }
        file.name = newName;
        renderFileTabs();
        renderFileTree();
        return { success: true, name: newName };
      },
      createNewFolder: function(name, parentId) {
        var result = createNewFolder(name, parentId);
        return result || { success: false, error: '创建文件夹失败' };
      },
      getFileContent: function(fileId) {
        const file = files.find(f => f.id === fileId);
        if (!file) {
          return { success: false, error: '文件不存在' };
        }
        return { success: true, content: file.content, name: file.name };
      },
      // 流式写入配置
      // 流式写入阈值：每次最多写入 50000 字符
      STREAM_CHUNK_SIZE: 50000,

      setFileContent: function(fileId, content, append) {
        const file = files.find(f => f.id === fileId);
        if (!file) {
          return { success: false, error: '文件不存在' };
        }

        // Log content length for debugging
        console.log('[setFileContent] Received content length:', content ? content.length : 0);

        // 如果是 DOCX 文件
        if (file.type === 'docx') {
          // 如果当前在 DOCX 模式且是当前文件，保存到 markdownSource
          if (fileId === currentFileId && isDocxMode) {
            // 保存为 Markdown 源，供后续转换使用
            file.markdownSource = content;
            return { 
              success: true, 
              message: '已在 DOCX 模式下保存内容。如需导出为 DOCX 格式，请调用 export_docx。SuperDoc 编辑器中的内容将作为 DOCX 导出。' 
            };
          }
          // 如果不在 DOCX 模式，保存到 content（作为 Markdown 源）
          if (append) {
            file.markdownSource = (file.markdownSource || '') + content;
          } else {
            file.markdownSource = content;
          }
          return { success: true, message: '已保存 DOCX 文件的 Markdown 源内容' };
        }

        // 如果是追加模式且不是 DOCX，直接追加内容
        if (append) {
          file.content = (file.content || '') + content;
        } else {
          // 检测内容是否超过阈值，需要流式写入
          if (content && content.length > this.STREAM_CHUNK_SIZE) {
            // 流式写入：将内容分割成多块
            const chunk = content.substring(0, this.STREAM_CHUNK_SIZE);
            const remaining = content.substring(this.STREAM_CHUNK_SIZE);

            file.content = chunk;

            // 返回特殊结果，告知 Agent 还有内容需要写入
            return {
              success: true,
              streaming: true,
              remainingLength: remaining.length,
              remaining: remaining,
              message: `已写入 ${chunk.length} 字符，还需写入 ${remaining.length} 字符。请继续调用 set_file_content 写入剩余内容，使用 append: true 参数。`
            };
          } else {
            // 普通写入
            file.content = content;
          }
        }

        if (fileId === currentFileId) {
          setContent(file.content, 'agent-set');
        }
        return { success: true };
      },

      // 追加写入内容（用于流式写入的后续调用）
      appendFileContent: function(fileId, content) {
        return this.setFileContent(fileId, content, true);
      },
      // 初始化文件栏
      initFileBar: function() {
        initFileBar();
      },
      // 导出所有文件
      exportAllFiles: function() {
        return exportAllFiles();
      },
      // 注意：运行HTML功能已移除 - 浏览器扩展CSP限制导致无法执行JavaScript
      // 切换文件树显示
      toggleFileTree: function() {
        toggleFileTree();
      },
      // ========== DOCX Editor 支持 ==========
      // 获取当前 DOCX 模式状态
      isDocxMode: function() {
        return isDocxMode;
      },
      // 获取所有 DOCX 文件
      getDocxFiles: function() {
        return files.filter(function(f) { return f.type === 'docx'; }).map(function(f) { 
          return { id: f.id, name: f.name, parentId: f.parentId }; 
        });
      },
      // 导入 DOCX 文件
      importDocx: async function(fileData, fileName) {
        // fileData 可以是 ArrayBuffer, Blob, Base64 字符串, 或空字符串/undefined（表示创建空文档）
        let arrayBuffer = null;
        
        if (fileData && typeof fileData === 'string' && fileData.length > 0) {
          // Base64 字符串 - 尝试解码
          try {
            arrayBuffer = base64ToArrayBuffer(fileData);
          } catch (e) {
            console.warn('[importDocx] Invalid base64, creating empty document:', e.message);
            arrayBuffer = null;
          }
        }
        
        // 创建文件对象
        const fileNameStr = fileName || '新文档.docx';
        
        if (arrayBuffer) {
          const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
          const file = new File([blob], fileNameStr, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
          await importDocxFile(file);
        } else {
          // 没有有效内容，创建空文档
          // 创建一个最小的空 DOCX 文件
          await importDocxFile(null, fileNameStr);
        }
        
        return { success: true };
      },
      // 导出当前 DOCX 文件
      exportDocx: async function() {
        if (!isDocxMode || !superdocInstance) {
          return { success: false, error: '当前不在 DOCX 模式' };
        }
        
        try {
          const blob = await superdocInstance.activeEditor.exportDocx();
          const arrayBuffer = await blob.arrayBuffer();
          // 返回 Base64 编码
          const base64 = arrayBufferToBase64(arrayBuffer);
          
          const currentFile = files.find(f => f.id === currentFileId && f.type === 'docx');
          return { 
            success: true, 
            data: base64, 
            fileName: currentFile?.name || 'document.docx' 
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      // 切换到 DOCX 文件
      switchToDocxFile: async function(fileId) {
        await switchToDocxFile(fileId);
        return { success: true };
      },
      // 获取当前 DOCX 文件内容
      getCurrentDocxContent: async function() {
        if (!isDocxMode || !superdocInstance) {
          return { success: false, error: '当前不在 DOCX 模式' };
        }
        
        try {
          const blob = await superdocInstance.activeEditor.exportDocx();
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = arrayBufferToBase64(arrayBuffer);
          
          const currentFile = files.find(f => f.id === currentFileId && f.type === 'docx');
          return { 
            success: true, 
            data: base64, 
            fileName: currentFile?.name || 'document.docx' 
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      // 在 DOCX 编辑器中插入文本
      insertTextToDocx: function(text) {
        if (!isDocxMode || !superdocInstance) {
          return { success: false, error: '当前不在 DOCX 模式或编辑器未初始化' };
        }
        
        try {
          const editor = superdocInstance.activeEditor;
          if (!editor || !editor.commands) {
            return { success: false, error: '编辑器命令不可用' };
          }
          
          // 使用 SuperDoc 的 insertContent 命令插入带格式的文本
          // contentType: 'markdown' 会让 SuperDoc 自动解析 Markdown 格式
          const result = editor.commands.insertContent(text, { contentType: 'markdown' });
          
          if (result) {
            return { success: true, message: '已插入带格式的文本到 DOCX 编辑器' };
          } else {
            return { success: false, error: '插入文本失败' };
          }
        } catch (error) {
          console.error('[insertTextToDocx] Error:', error);
          return { success: false, error: error.message };
        }
      },
      // 设置 DOCX 编辑器内容（替换全部内容）
      setDocxContent: function(text) {
        if (!isDocxMode || !superdocInstance) {
          return { success: false, error: '当前不在 DOCX 模式或编辑器未初始化' };
        }
        
        console.log('[setDocxContent] Input text length:', text ? text.length : 0);
        
        try {
          const editor = superdocInstance.activeEditor;
          if (!editor || !editor.commands) {
            return { success: false, error: '编辑器命令不可用' };
          }
          
          // 使用 SuperDoc 的 insertContent 命令，并指定 contentType 为 markdown
          // 这样 SuperDoc 会自动解析 Markdown 格式
          const result = editor.commands.insertContent(text, { contentType: 'markdown' });
          
          console.log('[setDocxContent] Insert result:', result);
          return { success: true, message: '已设置 DOCX 编辑器内容' };
        } catch (error) {
          console.error('[setDocxContent] Error:', error);
          return { success: false, error: error.message };
        }
      },
      
      // ========== Sheet (XLSX) Editor Tools ==========
      // 获取当前 Sheet 模式状态
      isSheetMode: function() {
        return isSheetMode;
      },
      // 获取所有 Sheet 文件
      getSheetFiles: function() {
        return files.filter(function(f) { return f.type === 'sheet'; }).map(function(f) { 
          return { id: f.id, name: f.name, parentId: f.parentId }; 
        });
      },
      // 创建新 Sheet 文件
      createSheet: async function(fileName) {
        await createNewSheetFile();
        const currentFile = getCurrentFile();
        if (currentFile && fileName) {
          currentFile.name = fileName;
          renderFileTree();
          saveFilesToStorage();
        }
        return { success: true, id: currentFileId, name: currentFile?.name };
      },
      // 切换到 Sheet 文件
      switchToSheetFile: async function(fileId) {
        await switchToSheetFile(fileId);
        return { success: true };
      },
      // 获取当前 Sheet 内容
      getSheetContent: function() {
        if (!isSheetMode || !loadedSheetData) {
          return { success: false, error: '当前不在 Sheet 模式或未加载数据' };
        }
        return { success: true, data: loadedSheetData };
      },
      // 获取 Sheet 数据（返回 JSON 格式）
      getSheetData: function() {
        const file = files.find(f => f.id === currentFileId && f.type === 'sheet');
        if (!file || !file.content) {
          return { success: false, error: '文件不存在或内容为空' };
        }
        try {
          const data = JSON.parse(file.content);
          return { success: true, data: data };
        } catch (e) {
          return { success: false, error: '解析失败: ' + e.message };
        }
      },
      // 导出当前 Sheet 为 xlsx（返回 Base64）
      exportSheet: async function() {
        if (!isSheetMode || !xspreadsheetInstance) {
          return { success: false, error: '当前不在 Sheet 模式' };
        }
        
        try {
          await saveCurrentSheetContent();
          const file = files.find(f => f.id === currentFileId && f.type === 'sheet');
          if (!file || !file.content) {
            return { success: false, error: '没有可导出的数据' };
          }
          
          const sheetData = JSON.parse(file.content);
          const xlsxData = convertToXLSX(sheetData);
          const xlsxBuffer = XLSX.write(xlsxData, { bookType: 'xlsx', type: 'array' });
          const base64 = arrayBufferToBase64(xlsxBuffer);
          
          return { 
            success: true, 
            data: base64, 
            fileName: file.name || 'document.xlsx' 
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      // 导入 xlsx 文件（Base64 格式）
      importSheet: async function(base64Data, fileName) {
        try {
          let arrayBuffer = null;
          if (base64Data && typeof base64Data === 'string' && base64Data.length > 0) {
            arrayBuffer = base64ToArrayBuffer(base64Data);
          }
          
          const name = fileName || '新表格.xlsx';
          const fileId = 'file-' + Date.now();
          const parentId = getValidParentFolderId(getPreferredCreationFolderId());
          
          let content = '';
          if (arrayBuffer) {
            // 解析 xlsx 文件
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            const sheets = [];
            workbook.SheetNames.forEach(sheetName => {
              const sheet = workbook.Sheets[sheetName];
              const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
              sheets.push({
                name: sheetName,
                data: data
              });
            });
            content = JSON.stringify(sheets);
          }
          
          files.push({
            id: fileId,
            name: name,
            type: 'sheet',
            content: content,
            imageMap: {},
            parentId: parentId
          });
          
          renderFileTree();
          setSelectedTreeItemId(fileId);
          syncFileGlobals();
          await switchToSheetFile(fileId);
          
          return { success: true, id: fileId, name: name };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      // 在当前 Sheet 中插入数据（2D 数组）
      insertSheetData: function(data, sheetIndex = 0) {
        if (!isSheetMode || !xspreadsheetInstance) {
          return { success: false, error: '当前不在 Sheet 模式' };
        }
        
        try {
          // 首先尝试从 x-spreadsheet 获取当前数据（这是 rows 格式）
          let currentData = null;
          
          if (xspreadsheetInstance && typeof xspreadsheetInstance.getData === 'function') {
            const sheetData = xspreadsheetInstance.getData();
            if (Array.isArray(sheetData)) {
              currentData = sheetData[sheetIndex] || sheetData[0];
            } else {
              currentData = sheetData;
            }
          }
          
          // 如果获取失败，尝试从 loadedSheetData 获取
          if (!currentData) {
            currentData = loadedSheetData;
            if (Array.isArray(currentData)) {
              currentData = currentData[sheetIndex] || currentData[0];
            }
          }
          
          // 如果仍然没有数据，创建一个新的 sheet
          if (!currentData || (!currentData.rows && !currentData.data)) {
            currentData = { name: 'Sheet' + (sheetIndex + 1), rows: {}, data: [] };
          }
          
          // 确保 currentData 有 rows 结构
          if (!currentData.rows) {
            currentData.rows = {};
          }
          if (!currentData.data) {
            currentData.data = [];
          }
          
          // 将新数据插入到 rows 格式中
          if (Array.isArray(data)) {
            // 从0行开始插入新数据
            data.forEach((row, rowIndex) => {
              if (!currentData.rows[rowIndex]) {
                currentData.rows[rowIndex] = { cells: {} };
              }
              if (Array.isArray(row)) {
                row.forEach((cell, colIndex) => {
                  currentData.rows[rowIndex].cells[colIndex] = { text: String(cell) };
                });
              }
            });
            
            // 同步更新 data 格式（保持两种格式一致）
            currentData.data = [];
            Object.keys(currentData.rows).forEach(rowKey => {
              if (rowKey === 'len') return;
              const row = currentData.rows[rowKey];
              const rowData = [];
              Object.keys(row.cells).forEach(colKey => {
                rowData[parseInt(colKey)] = row.cells[colKey].text || '';
              });
              currentData.data[parseInt(rowKey)] = rowData;
            });
            
            // 重新加载数据到表格 - 直接使用 x-spreadsheet 的 getData 返回的数据
            const allSheetsData = xspreadsheetInstance.getData();
            if (Array.isArray(allSheetsData)) {
              allSheetsData[sheetIndex] = currentData;
              loadedSheetData = allSheetsData;
            } else {
              loadedSheetData = [currentData];
            }
            
            // 使用 loadData 重新加载
            xspreadsheetInstance.loadData(loadedSheetData);
            
            // 强制刷新视图
            if (xspreadsheetInstance.refresh) {
              xspreadsheetInstance.refresh();
            }
            
            return { success: true, message: '已插入 ' + data.length + ' 行数据' };
          }
          
          return { success: false, error: '数据格式错误，需要 2D 数组' };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      // 读取 Sheet 单元格数据
      getCellValue: function(row, col, sheetIndex = 0) {
        if (!loadedSheetData) {
          return { success: false, error: '未加载数据' };
        }
        
        const sheet = Array.isArray(loadedSheetData) ? loadedSheetData[sheetIndex] : loadedSheetData;
        if (!sheet || !sheet.rows || !sheet.rows[row]) {
          return { success: true, value: null };
        }
        
        const cell = sheet.rows[row].cells && sheet.rows[row].cells[col];
        return { success: true, value: cell ? cell.text : null };
      },
      // 写入 Sheet 单元格数据
      setCellValue: function(row, col, value, sheetIndex = 0) {
        if (!isSheetMode || !xspreadsheetInstance) {
          return { success: false, error: '当前不在 Sheet 模式' };
        }
        
        try {
          const sheet = Array.isArray(loadedSheetData) ? loadedSheetData[sheetIndex] : loadedSheetData;
          if (!sheet) {
            return { success: false, error: 'Sheet 不存在' };
          }
          
          if (!sheet.rows) sheet.rows = {};
          if (!sheet.rows[row]) sheet.rows[row] = { cells: {} };
          if (!sheet.rows[row].cells) sheet.rows[row].cells = {};
          
          sheet.rows[row].cells[col] = { text: String(value) };
          
          xspreadsheetInstance.loadData(Array.isArray(loadedSheetData) ? loadedSheetData : [loadedSheetData]);
          
          return { success: true };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
  };

  window.InfinPilotEditor.deleteFile = function(fileId) {
    const file = files.find(item => item.id === fileId && isOpenableFile(item));
    if (!file) {
      return { success: false, error: 'File not found' };
    }

    void closeFile(fileId);
    return { success: true };
  };

  window.InfinPilotEditor.renameFile = function(fileId, newName) {
    const file = files.find(item => item.id === fileId || (item.type === 'folder' && item.id === fileId));
    if (!file) {
      return { success: false, error: 'File not found' };
    }

    if (file.type === 'folder' && file.id === getRootFolder()?.id) {
      return { success: false, error: 'Cannot rename the root folder' };
    }

    file.name = newName;
    syncFileGlobals();
    void syncProjectReferenceForFile(file);
    void saveFilesToStorage();
    renderFileTabs();
    renderFileTree();
    return { success: true, name: newName };
  };

  window.InfinPilotEditor.getAllFiles = function() {
    return files
      .filter(item => isOpenableFile(item))
      .map(item => ({ id: item.id, name: item.name, type: item.type, parentId: item.parentId ?? null }));
  };

  const originalSetFileContentApi = window.InfinPilotEditor.setFileContent;
  window.InfinPilotEditor.setFileContent = function(fileId, content, append) {
    const file = files.find(item => item.id === fileId);
    if (file?.type === 'svg') {
      const nextContent = append
        ? sanitizeSvgContent((file.content || '') + String(content || ''))
        : sanitizeSvgContent(String(content || ''));

      file.content = nextContent;
      file.pendingCenterOnLoad = true;
      syncFileGlobals();
      void saveFilesToStorage();

      if (currentFileId === fileId && isSvgMode) {
        loadSvgIntoEditor(nextContent, { centerContent: true });
        file.pendingCenterOnLoad = false;
        syncFileGlobals();
        void saveFilesToStorage();
      }

      return { success: true };
    }

    const result = originalSetFileContentApi.call(this, fileId, content, append);
    if (result?.success) {
      syncFileGlobals();
      void saveFilesToStorage();
    }
    return result;
  };

  window.InfinPilotEditor.updateTheme = function(isDarkMode) {
    if (!cmEditor) {
      return;
    }
    cmEditor.setOption('theme', isDarkMode ? 'material-darker' : 'material');
    setTimeout(() => cmEditor.refresh(), 0);
  };

  window.InfinPilotEditor.moveTreeItem = function(itemId, targetFolderId) {
    return moveTreeItem(itemId, targetFolderId);
  };

  window.InfinPilotEditor.getSelectedTreeItem = function() {
    const item = getSelectedTreeItem();
    if (!item) {
      return null;
    }
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      parentId: item.parentId ?? null
    };
  };

  window.InfinPilotEditor.createFile = function(name, parentId) {
    const result = createNewFile(name, parentId);
    return result
      ? { success: true, id: result.id, name: result.name, parentId: result.parentId }
      : { success: false, error: 'Failed to create file' };
  };

  window.InfinPilotEditor.createSvg = async function(name, parentId) {
    const result = await createNewSvgFile(name, parentId);
    return result
      ? { success: true, id: result.id, name: result.name, parentId: result.parentId }
      : { success: false, error: 'Failed to create SVG file' };
  };

  window.InfinPilotEditor.isSvgMode = function() {
    return isSvgMode;
  };

  window.InfinPilotEditor.switchToSvgFile = async function(fileId) {
    const file = files.find(item => item.id === fileId && item.type === 'svg');
    if (!file) {
      return { success: false, error: 'SVG file not found' };
    }
    await switchToSvgFile(fileId);
    return { success: true, id: fileId, name: file.name };
  };

  window.InfinPilotEditor.getSvgContent = async function(fileId = null) {
    const targetId = fileId || currentFileId;
    const file = files.find(item => item.id === targetId && item.type === 'svg');
    if (!file) {
      return { success: false, error: 'SVG file not found' };
    }

    if (targetId === currentFileId && isSvgMode) {
      await saveCurrentSvgContent();
    }

    return { success: true, content: file.content || createDefaultSvgContent(), name: file.name };
  };

  window.InfinPilotEditor.setSvgContent = async function(fileId, svgText) {
    const file = files.find(item => item.id === fileId && item.type === 'svg');
    if (!file) {
      return { success: false, error: 'SVG file not found' };
    }

    const nextContent = sanitizeSvgContent(svgText);
    file.content = nextContent;
    file.pendingCenterOnLoad = true;
    syncFileGlobals();
    await saveFilesToStorage();

    if (fileId === currentFileId && isSvgMode) {
      loadSvgIntoEditor(nextContent, { centerContent: true });
      file.pendingCenterOnLoad = false;
      syncFileGlobals();
      await saveFilesToStorage();
    }

    return { success: true, id: file.id, name: file.name };
  };

  window.InfinPilotEditor.importSvg = async function(svgText, fileName, parentId) {
    if (typeof svgText !== 'string') {
      return { success: false, error: 'SVG content must be a string' };
    }

    const result = await importSvgFile(svgText, fileName || 'untitled.svg', parentId, { centerContent: true });
    return result
      ? { success: true, id: result.id, name: result.name, parentId: result.parentId }
      : { success: false, error: 'Failed to import SVG file' };
  };

  window.InfinPilotEditor.exportSvg = async function(fileId = null) {
    const targetId = fileId || currentFileId;
    const file = files.find(item => item.id === targetId && item.type === 'svg');
    if (!file) {
      return { success: false, error: 'SVG file not found' };
    }

    await exportSvgFileById(targetId);
    return { success: true, id: targetId, name: file.name };
  };

  

  function updateViewButtons(activeButton) {
    [el.viewEdit, el.viewPreview, el.viewSplit, el.viewSplitVertical].forEach(btn => {
        if (btn) btn.classList.remove('active');
    });
    if (activeButton) activeButton.classList.add('active');
  }

  function setView(mode, orientation = 'horizontal') {
    mdState.viewMode = mode;
    const main = el.section.querySelector('.editor-main');
    main.classList.remove('edit', 'preview', 'split', 'split-vertical');
    if (mode === 'split') {
        main.classList.add('split');
        mdState.splitOrientation = orientation;
        if (orientation === 'vertical') {
            main.classList.add('split-vertical');
            updateViewButtons(el.viewSplitVertical);
        } else {
            updateViewButtons(el.viewSplit);
        }
    } else {
        main.classList.add(mode);
        if (mode === 'edit') updateViewButtons(el.viewEdit);
        if (mode === 'preview') updateViewButtons(el.viewPreview);
    }
    if (cmEditor) {
        setTimeout(() => cmEditor.refresh(), 10);
    }
  }

  function renderPreview(){
    let contentToRender = mdState.content || '';
    if (mdState.imageMap) {
        for (const [id, dataUrl] of Object.entries(mdState.imageMap)) {
            contentToRender = contentToRender.replace(new RegExp(id, 'g'), dataUrl);
        }
    }
    const html = window.MarkdownRenderer?.render(contentToRender) || '';
    el.preview.innerHTML = html;
    if (window.mermaid) {
        setTimeout(() => {
            try {
                const mermaidElements = el.preview.querySelectorAll('pre.mermaid');
                mermaidElements.forEach(elem => {
                    const code = elem.textContent || '';
                    if(code) {
                        elem.removeAttribute('data-processed');
                        elem.innerHTML = code;
                    }
                });
                if (mermaidElements.length > 0) {
                    mermaid.run({ nodes: mermaidElements }).catch(e => console.error('Mermaid rendering failed:', e));
                }
            } catch (e) { console.error('Error during Mermaid rendering:', e); }
        }, 100);
    }
  }

  function updateStats() {
      if (!el.stats) return;
      const text = mdState.content || '';
      const charCount = text.length;
      const wordCount = (text.match(/\S+/g) || []).length;
      el.stats.textContent = `字数: ${wordCount} | 字符: ${charCount}`;
  }

  function setContent(next, from = 'program'){
    mdState.content = next;
    if (from !== 'cm' && cmEditor && cmEditor.getValue() !== next) {
        cmEditor.setValue(next);
    }
    renderPreview();
    // Skip autosave during file switch
    if (from !== 'file-switch') {
      scheduleAutosave();
    }
    updateStats();
  }

  let saveTimer = null;
  function scheduleAutosave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (isSavingFiles) {
        return;
      }
      try {
        if (isDocxMode) {
          await saveCurrentDocxContent();
          await saveDocxFilesToStorage();
        } else {
          await writeLargeStorageValue('infinpilot_md_draft', structuredClone(mdState));
          await saveMdFilesToStorage();
        }
        mdState.lastSavedAt = Date.now();
        if (el.status) el.status.textContent = '已自动保存';
      } catch(e){ console.warn('[editor] autosave failed:', e); }
    }, 800);
  }

  function insertAtCursor(snippet){
    if (!cmEditor) return;
    cmEditor.replaceSelection(snippet);
    cmEditor.focus();
  }

  function replaceSelection(replacement){
    if (!cmEditor) return;
    cmEditor.replaceSelection(replacement);
    cmEditor.focus();
  }

  function getSelectionText(){
    if (!cmEditor) return '';
    return cmEditor.getSelection();
  }

  function wrapSelection(prefix, suffix = prefix) {
    if (!cmEditor) return;
    cmEditor.replaceSelection(prefix + cmEditor.getSelection() + suffix);
    cmEditor.focus();
  }

  function prefixLines(prefix) {
      if (!cmEditor) return;
      const selection = cmEditor.getSelection();
      const lines = selection.split('\n');
      const replacement = lines.map(line => `${prefix} ${line}`).join('\n');
      cmEditor.replaceSelection(replacement);
      cmEditor.focus();
  }

  if (el.aiCustomPromptSubmit) {
    el.aiCustomPromptSubmit.addEventListener('click', () => {
        const prompt = el.aiCustomPromptInput.value;
        if (!prompt) { el.aiCustomPromptInput.focus(); return; }
        triggerAiAction('custom-prompt-selection');
    });
  }

  if (el.insertUrlBtn){
    el.insertUrlBtn.addEventListener('click', async ()=>{
      try{
        const res = await browser.runtime.sendMessage({ action: 'getActiveTabInfo' });
        if (res?.success){
          const { url, title } = res;
          if (url && !mdState.sourceUrls.includes(url)) mdState.sourceUrls.push(url);
          insertAtCursor(`
- [${title || url}](${url})
`);
          if (el.status) el.status.textContent = '已插入网址';
        }
      }catch(e){ console.warn('[editor] getActiveTabInfo failed:', e); }
    });
  }

  if (el.insertAllTabsBtn){
    el.insertAllTabsBtn.addEventListener('click', async ()=>{
      try{
        const res = await browser.runtime.sendMessage({ action: 'getAllOpenTabs' });
        if (res?.success && Array.isArray(res.tabs)){
          const lines = res.tabs.map(t=>`- [${t.title || t.url}](${t.url})`).join('\n');
          insertAtCursor(`
##参考链接
${lines}
`);
          res.tabs.forEach(t=>{ if (t.url && !mdState.sourceUrls.includes(t.url)) mdState.sourceUrls.push(t.url); });
          if (el.status) el.status.textContent = '已插入标签页列表';
        }
      }catch(e){ console.warn('[editor] getAllOpenTabs failed:', e); }
    });
  }

  if (el.insertScreenshotBtn){
    el.insertScreenshotBtn.addEventListener('click', async ()=>{ 
      try{
        if (el.status) el.status.textContent = '正在截屏...';
        const res = await browser.runtime.sendMessage({ action: 'captureScreenshot' });
        if (res?.success){
          const { dataUrl, url, title, capturedAt } = res;
          if (url && !mdState.sourceUrls.includes(url)) mdState.sourceUrls.push(url);
          const imageId = `infinpilot-img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          if (!mdState.imageMap) mdState.imageMap = {};
          mdState.imageMap[imageId] = dataUrl;
          insertAtCursor(`
![Screenshot](${imageId})

> Captured from: [${title || url}](${url}) at ${capturedAt}

`);
          if (el.status) el.status.textContent = '已插入截图';
        } else {
          if (el.status) el.status.textContent = res.error === 'Screenshot cancelled by user.' ? '截屏已取消' : '截屏失败';
        }
      }catch(e){
        console.warn('[editor] captureScreenshot failed:', e);
        if (el.status) el.status.textContent = '截屏失败';
      }
    });
  }

  if (el.newBtn){
    el.newBtn.addEventListener('click', ()=> {
      createNewFile(null, getPreferredCreationFolderId());
      if (el.status) el.status.textContent = '新建文件';
    });
  }

  if (el.importBtn && el.importInput){
    el.importBtn.addEventListener('click', ()=> el.importInput.click());
    el.importInput.addEventListener('change', async (e)=>{
      const f = e.target.files[0];
      if (!f) return;

      if (f.name.toLowerCase().endsWith('.svg')) {
        await importSvgFile(f);
        e.target.value = '';
        return;
      }

      // 检查是否是 DOCX 文件
      if (f.name.toLowerCase().endsWith('.docx')) {
        // 调用 DOCX 导入函数
        importDocxFile(f);
        e.target.value = '';
        return;
      }

      // 普通文件作为文本读取
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        const fileName = f.name;

        // 创建新文件，保留原始扩展名
        const fileId = 'file-' + Date.now();

        // 找到根文件夹
        const parentId = getValidParentFolderId(getPreferredCreationFolderId());

        // 添加新文件到文件树
        files.push({
          id: fileId,
          name: fileName,
          type: 'file',
          content: content,
          imageMap: {},
          parentId: parentId
        });

        // 切换到新导入的文件
        setSelectedTreeItemId(fileId);
        switchToFile(fileId);
        renderFileTree();
        syncFileGlobals();

        if (el.status) el.status.textContent = '已导入: ' + fileName;
      };
      reader.readAsText(f);
      e.target.value = '';
    });
  }

  // ========== SuperDoc DOCX Editor ==========
  let superdocInstance = null;
  let isDocxMode = false;
  
  // 更新 SuperDoc 主题
  function updateSuperDocTheme() {
    const superdocEditor = $('superdoc-editor');
    if (!superdocEditor) return;
    
    const isDark = document.body.classList.contains('dark-mode');
    superdocEditor.style.backgroundColor = isDark ? '#09090b' : '#fafafa';
  }
  
  // 监听主题切换
  function setupThemeListener() {
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
      btn.addEventListener('click', () => setTimeout(updateSuperDocTheme, 300));
    }
  }
  
  // 初始化
  setTimeout(setupThemeListener, 2000);

  const docxToggleBtn = $('md-docx-toggle');
  const newDocxBtn = $('md-new-docx');
  const superdocExportBtn = $('superdoc-export');
  
  // DOCX 导出按钮事件
  if (superdocExportBtn) {
    superdocExportBtn.addEventListener('click', () => {
      exportDocxFile();
    });
  }

  // 切换到 DOCX 模式
  async function switchToDocxMode() {
    if (isDocxMode) return;
    isDocxMode = true;
    
    // 启动 DOCX 自动保存
    startDocxAutosave();
    
    // 隐藏 Markdown 编辑器工具栏
    const mdToolbar = document.querySelector('#editor .editor-toolbar');
    if (mdToolbar) mdToolbar.style.display = 'none';
    
    // 隐藏 Markdown 编辑器主容器
    const editorMain = document.querySelector('#editor .editor-main');
    if (editorMain) editorMain.style.display = 'none';
    
    // 显示 SuperDoc 编辑器和工具栏
    const superdocToolbar = $('superdoc-toolbar');
    const superdocEditor = $('superdoc-editor');
    if (superdocToolbar) {
      superdocToolbar.style.display = 'flex';
    }
    if (superdocEditor) {
      superdocEditor.style.display = 'flex';
      superdocEditor.style.height = '100%';
    }

    // 更新按钮状态
    if (docxToggleBtn) {
      docxToggleBtn.classList.add('active');
    }

    // SuperDoc 初始化现在由 switchToDocxFile 完全控制，不再在这里初始化
  }

  // 保存当前 DOCX 文件内容
  let docxSaveTimer = null;
  
  async function saveCurrentDocxContent() {
    console.log('[Editor] saveCurrentDocxContent called, isDocxMode:', isDocxMode, 'currentFileId:', currentFileId);
    if (!isDocxMode || !superdocInstance) return;
    
    try {
      const blob = await superdocInstance.activeEditor.exportDocx();
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      
      // Find the file by currentFileId in the current files array
      const fileIndex = files.findIndex(f => f.id === currentFileId && f.type === 'docx');
      console.log('[Editor] saveCurrentDocxContent: currentFileId:', currentFileId, 'fileIndex:', fileIndex, 'files.length:', files.length);
      
      if (fileIndex !== -1) {
        files[fileIndex].content = base64;
        console.log('[Editor] DOCX content saved to index:', fileIndex, 'file:', files[fileIndex].name, 'length:', base64.length);
      } else {
        console.warn('[Editor] DOCX save: file not found in files array, currentFileId:', currentFileId);
      }
    } catch (error) {
      console.error('[Editor] Failed to save DOCX content:', error);
    }
  }
  
  // 启动 DOCX 自动保存
  function startDocxAutosave() {
    stopDocxAutosave();
    docxSaveTimer = setInterval(async () => {
      if (isDocxMode && !isSavingFiles) {
        await saveCurrentDocxContent();
        await saveDocxFilesToStorage();
        if (el.status) el.status.textContent = 'DOCX 已自动保存';
      }
    }, 3000); // Every 3 seconds
  }
  
  // 停止 DOCX 自动保存
  function stopDocxAutosave() {
    if (docxSaveTimer) {
      clearInterval(docxSaveTimer);
      docxSaveTimer = null;
    }
  }

  // 切换回 Markdown 模式
  async function switchToMarkdownMode() {
    if (!isDocxMode) return;
    
    // 停止 DOCX 自动保存
    stopDocxAutosave();
    
    // 保存当前 DOCX 内容
    await saveCurrentDocxContent();
    await saveDocxFilesToStorage();
    
    isDocxMode = false;

    // 显示 Markdown 编辑器工具栏
    const mdToolbar = document.querySelector('#editor .editor-toolbar');
    if (mdToolbar) mdToolbar.style.display = '';
    
    // 显示 Markdown 编辑器主容器
    const editorMain = document.querySelector('#editor .editor-main');
    if (editorMain) editorMain.style.display = '';

    // 隐藏 SuperDoc 编辑器和工具栏
    const superdocToolbar = $('superdoc-toolbar');
    const superdocEditor = $('superdoc-editor');
    if (superdocToolbar) superdocToolbar.style.display = 'none';
    if (superdocEditor) superdocEditor.style.display = 'none';

    // 更新按钮状态
    if (docxToggleBtn) {
      docxToggleBtn.classList.remove('active');
    }

    // 如果当前文件是 DOCX 类型，不要在 Markdown 编辑器中显示内容
    // 因为 DOCX 内容是二进制 Base64，无法显示为 Markdown
    const currentFile = files.find(f => f.id === currentFileId);
    if (currentFile && currentFile.type === 'docx') {
      // 提示用户这是 DOCX 文件
      if (cmEditor) cmEditor.setValue('');
      if (el.status) el.status.textContent = '此文件为 DOCX 格式，请点击工具栏按钮进入文档编辑模式';
    }
  }

  // DOCX 切换按钮事件 - 只有当前文件是 DOCX 类型才能切换
  if (docxToggleBtn) {
    docxToggleBtn.addEventListener('click', () => {
      const currentFile = files.find(f => f.id === currentFileId);
      
      if (isDocxMode) {
        // 已经在 DOCX 模式，切换回 MD 模式
        switchToMarkdownMode();
      } else if (currentFile && currentFile.type === 'docx') {
        // 只有 DOCX 文件才能切换到 DOCX 模式
        switchToDocxFile(currentFileId);
      } else {
        // 非 DOCX 文件不能进入 DOCX 模式
        if (el.status) el.status.textContent = '只有 DOCX 文件才能进入文档编辑模式';
      }
    });
  }

  // 新建 DOCX 文件按钮事件
  if (newDocxBtn) {
    newDocxBtn.addEventListener('click', async () => {
      // 创建一个空的 DOCX 文件
      const fileId = 'file-' + Date.now();
      const parentId = getValidParentFolderId(getPreferredCreationFolderId());

      // 创建一个空的 DOCX（使用最小化的 DOCX 结构）
      const emptyDocxBase64 = createEmptyDocxBase64();

      files.push({
        id: fileId,
        name: '新文档.docx',
        type: 'docx',
        content: emptyDocxBase64,
        imageMap: {},
        parentId: parentId
      });

      renderFileTree();
      setSelectedTreeItemId(fileId);
      syncFileGlobals();

      // 切换到新创建的 DOCX 文件
      await switchToDocxFile(fileId);

      if (el.status) el.status.textContent = '已创建新 DOCX 文档';
    });
  }

  // 辅助函数：创建一个最小的空 DOCX 文件（Base64 编码）
  function createEmptyDocxBase64() {
    // 这是一个最小的 DOCX 文件的二进制内容
    // 使用 JSZip 或其他方式生成会更复杂，这里用一个预定义的空 DOCX
    // 由于浏览器无法直接创建 DOCX，我们创建一个非常简单的...
    // 实际上最好的方式是使用 SuperDoc API 来创建空文档
    
    // 返回空字符串，SuperDoc 会处理空文档的情况
    return '';
  }

  // 导入 DOCX 文件
  async function importDocxFile(file, forceFileName) {
    try {
      let base64 = '';
      let fileName = forceFileName || '新文档.docx';
      
      if (file) {
        // 读取文件内容为 ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        // 将 ArrayBuffer 转换为 Base64 用于存储
        base64 = arrayBufferToBase64(arrayBuffer);
        fileName = file.name;
      }
      
      const fileId = 'file-' + Date.now();
      const parentId = getValidParentFolderId(getPreferredCreationFolderId());

      // 添加 DOCX 文件到文件树
      files.push({
        id: fileId,
        name: fileName,
        type: 'docx',
        content: base64,  // 存储为 Base64，空字符串表示空文档
        imageMap: {},
        parentId: parentId
      });

      // 渲染文件树
      renderFileTree();
      setSelectedTreeItemId(fileId);
      syncFileGlobals();

      // 切换到该文件
      await switchToDocxFile(fileId);

      if (el.status) el.status.textContent = file ? ('已导入 DOCX: ' + fileName) : '已创建新 DOCX 文档';
    } catch (error) {
      console.error('[SuperDoc] Failed to import DOCX:', error);
      if (el.status) el.status.textContent = '导入 DOCX 失败: ' + error.message;
    }
  }

  // 切换到指定的 DOCX 文件
  async function switchToDocxFile(fileId) {
    // 如果已经是当前文件且 SuperDoc 已加载，不要重新创建
    if (isDocxMode && currentFileId === fileId && superdocInstance) {
      console.log('[SuperDoc] Already on this file, skipping re-creation');
      return;
    }
    
    // 如果当前已经是 DOCX 模式，先保存当前文件
    if (isDocxMode && currentFileId !== fileId) {
      await saveCurrentDocxContent();
      await saveDocxFilesToStorage();
    }
    
    const docxFile = files.find(f => f.id === fileId && f.type === 'docx');
    if (!docxFile) {
      console.error('[SuperDoc] File not found:', fileId);
      return;
    }

    // 先更新当前文件ID，这样按钮处理器可以正确检测文件类型
    currentFileId = fileId;
    window.InfinpilotCurrentFileId = currentFileId;
    setSelectedTreeItemId(fileId);
    const expandedPath = expandFolderPathForItem(docxFile);
    syncFileGlobals();
    dispatchCurrentFileChangedEvent();
    if (expandedPath) {
      void saveFilesToStorage();
    }
    renderFileTree();
    renderFileTabs();

    // 切换到 DOCX 模式
    await switchToDocxMode();

    // 销毁旧实例
    if (superdocInstance) {
      superdocInstance.destroy();
      superdocInstance = null;
    }

    try {
      // 如果有有效内容，则加载内容；否则创建空文档
      let arrayBuffer = null;
      console.log('[SuperDoc] Checking for existing content, docxFile:', docxFile ? docxFile.name : 'not found', 'content length:', docxFile && docxFile.content ? docxFile.content.length : 0);
      console.log('[SuperDoc] Files array length:', files.length);
      // Also check if this docxFile is in the files array
      const fileCheck = files.find(f => f.id === fileId);
      console.log('[SuperDoc] File from files array:', fileCheck ? fileCheck.name : 'not found', 'content length:', fileCheck && fileCheck.content ? fileCheck.content.length : 0);
      
      // Re-find the file to ensure we have the latest
      const freshFile = files.find(f => f.id === fileId && f.type === 'docx');
      console.log('[SuperDoc] Fresh file check:', freshFile ? freshFile.name : 'not found', 'content length:', freshFile ? freshFile.content?.length : 'N/A');
      
      if (freshFile && freshFile.content && freshFile.content.length > 0) {
        try {
          arrayBuffer = base64ToArrayBuffer(freshFile.content);
        } catch (e) {
          console.warn('[SuperDoc] Failed to decode DOCX content, creating empty document:', e.message);
          arrayBuffer = null;
        }
      }
      
      if (arrayBuffer && freshFile) {
        const docxBlob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const docxFileObj = new File([docxBlob], freshFile.name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const fileUrl = URL.createObjectURL(docxFileObj);
        const superdocFile = await window.SuperDocLibrary.getFileObject(fileUrl, freshFile.name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

        superdocInstance = new window.SuperDocLibrary.SuperDoc({
          selector: '#superdoc-editor',
          documentMode: 'editing',
          pagination: false,
          rulers: true,
          document: superdocFile,
          toolbar: '#superdoc-toolbar',
          onReady: () => console.log('[SuperDoc] Document loaded:', freshFile.name),
          onEditorCreate: () => console.log('[SuperDoc] Editor created')
        });
      } else {
        // 解码失败或内容为空，创建空文档
        superdocInstance = new window.SuperDocLibrary.SuperDoc({
          selector: '#superdoc-editor',
          documentMode: 'editing',
          pagination: false,
          rulers: true,
          document: null,
          toolbar: '#superdoc-toolbar',
          onReady: () => console.log('[SuperDoc] Empty document created'),
          onEditorCreate: () => console.log('[SuperDoc] Editor created')
        });
      }
    } catch (error) {
      console.error('[SuperDoc] Failed to load DOCX:', error);
      // 尝试创建空文档
      try {
        superdocInstance = new window.SuperDocLibrary.SuperDoc({
          selector: '#superdoc-editor',
          documentMode: 'editing',
          pagination: false,
          rulers: true,
          document: null,
          toolbar: '#superdoc-toolbar',
          onReady: () => console.log('[SuperDoc] Empty document created after error'),
          onEditorCreate: () => console.log('[SuperDoc] Editor created')
        });
      } catch (e) {
        console.error('[SuperDoc] Failed to create empty document:', e);
      }
    }
  }

  // 辅助函数：ArrayBuffer 转 Base64
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // 辅助函数：Base64 转 ArrayBuffer
  function base64ToArrayBuffer(base64) {
    if (!base64 || typeof base64 !== 'string') {
      console.warn('[SuperDoc] Invalid base64 string:', base64);
      return null;
    }
    
    // 清理 base64 字符串，移除可能的空格和换行
    base64 = base64.trim();
    
    // 检查是否包含有效字符
    const validBase64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!validBase64Regex.test(base64)) {
      console.warn('[SuperDoc] Base64 contains invalid characters');
      throw new DOMException('String contains an invalid character', 'InvalidCharacterError');
    }
    
    try {
      const binary_string = window.atob(base64);
      const len = binary_string.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
      }
      return bytes.buffer;
    } catch (error) {
      console.error('[SuperDoc] Failed to decode base64:', error);
      throw error;
    }
  }

  // 导出 DOCX 文件（可选是否保存到文件树）
  async function exportDocxFile(saveToTree = true) {
    if (!superdocInstance || !isDocxMode) {
      return;
    }

    try {
      const blob = await superdocInstance.activeEditor.exportDocx();
      
      // 如果需要保存到文件树
      if (saveToTree && currentFileId) {
        const currentFile = files.find(f => f.id === currentFileId && f.type === 'docx');
        if (currentFile) {
          // 转换为 Base64 并保存
          const arrayBuffer = await blob.arrayBuffer();
          currentFile.content = arrayBufferToBase64(arrayBuffer);
          window.InfinpilotEditorFiles = files;
        }
      }

      // 下载文件
      const currentFile = files.find(f => f.id === currentFileId && f.type === 'docx');
      const fileName = currentFile?.name || 'document.docx';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);

      if (el.status) el.status.textContent = '已导出 DOCX';
    } catch (error) {
      console.error('[SuperDoc] Failed to export DOCX:', error);
      if (el.status) el.status.textContent = '导出 DOCX 失败: ' + error.message;
    }
  }
  
  // 根据文件ID导出DOCX文件
  async function exportDocxFileById(fileId) {
    const file = files.find(f => f.id === fileId && f.type === 'docx');
    if (!file) {
      if (el.status) el.status.textContent = '文件不存在';
      return;
    }
    
    if (!file.content || file.content.length === 0) {
      if (el.status) el.status.textContent = 'DOCX文件内容为空';
      return;
    }
    
    try {
      const arrayBuffer = base64ToArrayBuffer(file.content);
      const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
      if (el.status) el.status.textContent = '已导出 ' + file.name;
    } catch (error) {
      console.error('[Editor] Failed to export DOCX:', error);
      if (el.status) el.status.textContent = '导出失败: ' + error.message;
    }
  }

  // ========== Univer Sheet Editor ==========
  let xspreadsheetInstance = null;
  let isSheetMode = false;
  let sheetSaveTimer = null;
  let loadedSheetData = null;

  const sheetToggleBtn = $('md-sheet-toggle');
  const newSheetBtn = $('md-new-sheet');

  async function switchToSheetMode() {
    if (isSheetMode) return;
    
    isSheetMode = true;
    
    startSheetAutosave();
    
    const mdToolbar = document.querySelector('#editor .editor-toolbar');
    if (mdToolbar) mdToolbar.style.display = 'none';
    
    const editorMain = document.querySelector('#editor .editor-main');
    if (editorMain) editorMain.style.display = 'none';
    
    const sheetEditor = $('sheet-editor');
    if (sheetEditor) {
      sheetEditor.style.display = 'flex';
      sheetEditor.style.height = '100%';
    }

    if (sheetToggleBtn) {
      sheetToggleBtn.classList.add('active');
    }
  }

  async function saveCurrentSheetContent() {
    if (!isSheetMode || !xspreadsheetInstance) return;
    
    try {
      let sheetData = null;
      
      const tryGetData = () => {
        try {
          // Try getData first
          if (xspreadsheetInstance && typeof xspreadsheetInstance.getData === 'function') {
            const data = xspreadsheetInstance.getData();
            // Check if data has actual content (not just default empty)
            if (data && Array.isArray(data) && data.length > 0) {
              const hasRealData = data.some(s => s && s.rows && Object.keys(s.rows).filter(k => k !== 'len').length > 0);
              if (hasRealData) {
                return data;
              }
            }
          }
          // Fallback: use loadedSheetData if available
          if (loadedSheetData) {
            return Array.isArray(loadedSheetData) ? loadedSheetData : [loadedSheetData];
          }
        } catch (e) {}
        return null;
      };
      
      const allData = tryGetData();
      console.log('[x-spreadsheet] Save - allData sheets:', allData ? allData.length : 0);
      console.log('[x-spreadsheet] Save - allData:', JSON.stringify(allData).substring(0, 300));
      
      // TryGetData already handles fallback to loadedSheetData, so just use the result
      if (allData && Array.isArray(allData) && allData.length > 0) {
        // Check if any sheets have data
        const hasData = allData.some(sheet => {
          if (!sheet) return false;
          if (sheet.rows && typeof sheet.rows === 'object') {
            const keys = Object.keys(sheet.rows).filter(k => k !== 'len');
            return keys.length > 0;
          }
          if (sheet.data && Array.isArray(sheet.data)) {
            return sheet.data.some(row => row && row.some(cell => cell && cell !== ''));
          }
          return false;
        });
        
        if (hasData) {
          sheetData = allData;
          console.log('[x-spreadsheet] Save - saving', allData.length, 'sheets');
        } else {
          // No data in current sheets, use loadedSheetData as fallback
          sheetData = loadedSheetData || allData[0];
        }
      } else if (loadedSheetData) {
        sheetData = loadedSheetData;
      } else {
        sheetData = { name: 'Sheet1', data: [], rows: { len: 100 }, cols: { len: 26 } };
      }
      
      console.log('[x-spreadsheet] Save - final sheetData:', JSON.stringify(sheetData).substring(0, 300));
      console.log('[x-spreadsheet] Save - final sheetData type:', Array.isArray(sheetData) ? 'array' : 'object');
      
      loadedSheetData = sheetData;
      const jsonStr = JSON.stringify(sheetData);
      
      const fileIndex = files.findIndex(f => f.id === currentFileId && f.type === 'sheet');
      if (fileIndex !== -1) {
        files[fileIndex].content = jsonStr;
        window.InfinpilotEditorFiles = files;
        console.log('[x-spreadsheet] Sheet content saved successfully');
      }
    } catch (error) {
      console.error('[x-spreadsheet] Failed to save Sheet content:', error);
    }
  }

  function startSheetAutosave() {
    stopSheetAutosave();
    sheetSaveTimer = setInterval(async () => {
      if (isSheetMode && !isSavingFiles) {
        await saveCurrentSheetContent();
        await saveSheetFilesToStorage();
        if (el.status) el.status.textContent = '表格已自动保存';
      }
    }, 3000);
  }

  function stopSheetAutosave() {
    if (sheetSaveTimer) {
      clearInterval(sheetSaveTimer);
      sheetSaveTimer = null;
    }
  }

  async function switchToMarkdownModeFromSheet() {
    if (!isSheetMode) return;
    
    stopSheetAutosave();
    await saveCurrentSheetContent();
    await saveSheetFilesToStorage();
    
    isSheetMode = false;
    loadedSheetData = null;

    const mdToolbar = document.querySelector('#editor .editor-toolbar');
    if (mdToolbar) mdToolbar.style.display = '';
    
    const editorMain = document.querySelector('#editor .editor-main');
    if (editorMain) editorMain.style.display = '';

    const sheetEditor = $('sheet-editor');
    if (sheetEditor) sheetEditor.style.display = 'none';

    if (sheetToggleBtn) {
      sheetToggleBtn.classList.remove('active');
    }
  }

  if (sheetToggleBtn) {
    sheetToggleBtn.addEventListener('click', async () => {
      const currentFile = files.find(f => f.id === currentFileId);
      
      if (isSheetMode) {
        await switchToMarkdownModeFromSheet();
      } else if (currentFile && currentFile.type === 'sheet') {
        await switchToSheetFile(currentFileId);
      } else {
        if (el.status) el.status.textContent = '只有表格文件才能进入表格编辑模式';
      }
    });
  }

  if (newSheetBtn) {
    newSheetBtn.addEventListener('click', async () => {
      await createNewSheetFile();
      if (el.status) el.status.textContent = '已创建新表格文档';
    });
  }

  async function createNewSheetFile() {
    try {
      await window.loadXSpreadsheet();
    } catch (e) {
      if (el.status) el.status.textContent = '表格编辑器加载失败';
      return;
    }
    
    const fileId = 'file-' + Date.now();
    const parentId = getValidParentFolderId(getPreferredCreationFolderId());

    files.push({
      id: fileId,
      name: '新表格.xlsx',
      type: 'sheet',
      content: '',
      imageMap: {},
      parentId: parentId
    });

    renderFileTree();
    setSelectedTreeItemId(fileId);
    syncFileGlobals();
    await saveFilesToStorage();
    
    await switchToSheetFile(fileId);
  }

  async function switchToSheetFile(fileId) {
    if (isSheetMode && currentFileId === fileId && xspreadsheetInstance) {
      return;
    }
    
    if (isSheetMode && currentFileId !== fileId) {
      await saveCurrentSheetContent();
      await saveSheetFilesToStorage();
    }
    
    loadedSheetData = null;
    
    if (isDocxMode) {
      await switchToMarkdownMode();
    }
    
    const sheetFile = files.find(f => f.id === fileId && f.type === 'sheet');
    if (!sheetFile) {
      console.error('[x-spreadsheet] Sheet file not found:', fileId);
      return;
    }

    currentFileId = fileId;
    window.InfinpilotCurrentFileId = currentFileId;
    setSelectedTreeItemId(fileId);
    const expandedPath = expandFolderPathForItem(sheetFile);
    syncFileGlobals();
    dispatchCurrentFileChangedEvent();
    if (expandedPath) {
      void saveFilesToStorage();
    }
    renderFileTree();
    renderFileTabs();
    
    await switchToSheetMode();
    
    const sheetEditorEl = $('sheet-editor');
    if (sheetEditorEl) {
      sheetEditorEl.innerHTML = '';
    }

    try {
      await window.loadXSpreadsheet();
      
      const isDark = document.body.classList.contains('dark-mode');
      const sheetEditorEl = $('sheet-editor');
      
      const defaultSheetData = {
        name: 'Sheet1',
        data: [
          ['', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['', '', '', '', '', '']
        ]
      };
      
      const options = {
        mode: 'edit',
        showToolbar: true,
        showGrid: true,
        showContextmenu: true,
        view: {
          height: () => sheetEditorEl ? sheetEditorEl.clientHeight : 600,
          width: () => sheetEditorEl ? sheetEditorEl.clientWidth : 800
        }
      };
      
      if (sheetFile.content && sheetFile.content.length > 0) {
        try {
          const jsonData = JSON.parse(sheetFile.content);
          console.log('[x-spreadsheet] Loaded content - type:', Array.isArray(jsonData) ? 'array' : 'object');
          
          // Handle both single sheet (object) and multiple sheets (array)
          if (Array.isArray(jsonData)) {
            // Multiple sheets saved as array - store ALL sheets
            options.data = jsonData;
            loadedSheetData = jsonData; // Store all sheets!
          } else {
            // Single sheet saved as object - wrap in array
            options.data = [jsonData];
            loadedSheetData = jsonData;
          }
          console.log('[x-spreadsheet] options.data length:', options.data.length);
          console.log('[x-spreadsheet] loadedSheetData length:', Array.isArray(loadedSheetData) ? loadedSheetData.length : 1);
        } catch (e) {
          console.warn('[x-spreadsheet] Failed to parse sheet content, using default');
          options.data = [defaultSheetData];
          loadedSheetData = defaultSheetData;
        }
      }
      
      xspreadsheetInstance = x_spreadsheet(sheetEditorEl, options);
      
      // Need to explicitly call loadData after initialization for multiple sheets
      if (sheetFile.content && sheetFile.content.length > 0) {
        try {
          const jsonData = JSON.parse(sheetFile.content);
          setTimeout(() => {
            if (xspreadsheetInstance && typeof xspreadsheetInstance.loadData === 'function') {
              // x-spreadsheet expects array of sheet data
              const dataToLoad = Array.isArray(jsonData) ? jsonData : [jsonData];
              console.log('[x-spreadsheet] Calling loadData with', dataToLoad.length, 'sheets');
              xspreadsheetInstance.loadData(dataToLoad);
            } else if (xspreadsheetInstance && typeof xspreadsheetInstance.setData === 'function') {
              const dataToLoad = Array.isArray(jsonData) ? jsonData : [jsonData];
              console.log('[x-spreadsheet] Calling setData with', dataToLoad.length, 'sheets');
              xspreadsheetInstance.setData(dataToLoad);
            }
            console.log('[x-spreadsheet] Data loaded after init');
          }, 200); // Give more time for x-spreadsheet to initialize
        } catch (e) {
          console.warn('[x-spreadsheet] Failed to parse sheet content:', e);
        }
      }
      
      const updateLoadedData = () => {
        setTimeout(() => {
          try {
            if (xspreadsheetInstance && typeof xspreadsheetInstance.getData === 'function') {
              const data = xspreadsheetInstance.getData();
              if (data && Array.isArray(data) && data.length > 0) {
                // Check if data has real content
                const hasRealData = data.some(s => s && s.rows && Object.keys(s.rows).filter(k => k !== 'len').length > 0);
                if (hasRealData) {
                  loadedSheetData = data; // Store all sheets
                  console.log('[x-spreadsheet] Updated loadedSheetData from getData, sheets:', data.length);
                }
              }
            }
          } catch (e) {
            console.warn('[x-spreadsheet] Failed to get data from instance:', e);
          }
        }, 50);
      };
      
      xspreadsheetInstance.on('cell', updateLoadedData);
      xspreadsheetInstance.on('change', updateLoadedData);
      
      console.log('[x-spreadsheet] initialized for:', sheetFile.name, 'with data:', !!sheetFile.content, 'loadedSheetData:', loadedSheetData ? 'exists' : 'null');
    } catch (error) {
      console.error('[x-spreadsheet] Failed to initialize:', error);
      if (el.status) el.status.textContent = '表格编辑器初始化失败: ' + error.message;
    }
  }

  async function exportSheetFile(saveToTree = true) {
    if (!xspreadsheetInstance || !isSheetMode) return;

    try {
      const tryGetData = () => {
        try {
          if (xspreadsheetInstance && typeof xspreadsheetInstance.getData === 'function') {
            return xspreadsheetInstance.getData();
          }
        } catch (e) {}
        return null;
      };
      
      const allData = tryGetData();
      let sheetData = null;
      
      if (allData && Array.isArray(allData) && allData.length > 0) {
        if (allData.length === 1) {
          const currentData = allData[0];
          if (currentData && currentData.rows && Object.keys(currentData.rows).filter(k => k !== 'len').length > 0) {
            sheetData = currentData;
          } else if (loadedSheetData) {
            sheetData = loadedSheetData;
          } else {
            sheetData = currentData;
          }
        } else {
          sheetData = allData;
        }
      } else if (loadedSheetData) {
        sheetData = loadedSheetData;
      }
      
      if (!sheetData) {
        if (el.status) el.status.textContent = '没有可导出的数据';
        return;
      }
      
      console.log('[x-spreadsheet] Export - sheetData:', JSON.stringify(sheetData).substring(0, 300));
      
      loadedSheetData = sheetData;
      const jsonStr = JSON.stringify(sheetData);
      
      if (saveToTree && currentFileId) {
        const currentFile = files.find(f => f.id === currentFileId && f.type === 'sheet');
        if (currentFile) {
          currentFile.content = jsonStr;
          window.InfinpilotEditorFiles = files;
        }
      }

      const currentFile = files.find(f => f.id === currentFileId && f.type === 'sheet');
      const fileName = currentFile?.name || 'document.xlsx';
      
      const xlsxData = convertToXLSX(sheetData);
      const xlsxBuffer = XLSX.write(xlsxData, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.endsWith('.xlsx') ? fileName : fileName + '.xlsx';
      a.click();
      URL.revokeObjectURL(url);

      if (el.status) el.status.textContent = '已导出 xlsx 文件';
    } catch (error) {
      console.error('[x-spreadsheet] Failed to export:', error);
      if (el.status) el.status.textContent = '导出失败: ' + error.message;
    }
  }

  function convertToXLSX(sheetData) {
    const wb = XLSX.utils.book_new();
    
    const convertSingleSheet = (sheet, index) => {
      let ws;
      if (sheet.data && Array.isArray(sheet.data)) {
        // 2D array format
        ws = XLSX.utils.aoa_to_sheet(sheet.data);
      } else if (sheet.rows && typeof sheet.rows === 'object') {
        // x-spreadsheet rows format
        const rows = sheet.rows;
        const data = [];
        Object.keys(rows).forEach(key => {
          if (key === 'len') return;
          const rowData = [];
          const row = rows[key];
          if (row.cells) {
            Object.keys(row.cells).forEach(cellKey => {
              const cellIndex = parseInt(cellKey);
              const cell = row.cells[cellKey];
              rowData[cellIndex] = cell.text || '';
            });
          }
          data[parseInt(key)] = rowData;
        });
        ws = XLSX.utils.aoa_to_sheet(data);
      } else {
        ws = XLSX.utils.aoa_to_sheet([]);
      }
      XLSX.utils.book_append_sheet(wb, ws, sheet.name || 'Sheet' + (index + 1));
    };
    
    if (Array.isArray(sheetData)) {
      sheetData.forEach((sheet, index) => {
        convertSingleSheet(sheet, index);
      });
    } else {
      convertSingleSheet(sheetData, 0);
    }
    
    return wb;
  }

  async function exportSheetFileById(fileId) {
    const file = files.find(f => f.id === fileId && f.type === 'sheet');
    if (!file) {
      if (el.status) el.status.textContent = '文件不存在';
      return;
    }
    
    console.log('[x-spreadsheet] exportSheetFileById - file.content:', file.content ? file.content.substring(0, 200) : 'empty');
    console.log('[x-spreadsheet] exportSheetFileById - file.content length:', file.content ? file.content.length : 0);
    
    if (!file.content || file.content.length === 0) {
      if (el.status) el.status.textContent = '表格文件内容为空';
      return;
    }
    
    try {
      const sheetData = JSON.parse(file.content);
      console.log('[x-spreadsheet] exportSheetFileById - parsed sheetData:', JSON.stringify(sheetData).substring(0, 300));
      console.log('[x-spreadsheet] exportSheetFileById - has rows:', !!sheetData.rows);
      console.log('[x-spreadsheet] exportSheetFileById - rows keys:', sheetData.rows ? Object.keys(sheetData.rows) : 'N/A');
      
      const xlsxData = convertToXLSX(sheetData);
      console.log('[x-spreadsheet] exportSheetFileById - xlsxData created');
      const xlsxBuffer = XLSX.write(xlsxData, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = file.name.endsWith('.xlsx') ? file.name : file.name + '.xlsx';
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      if (el.status) el.status.textContent = '已导出 ' + fileName;
    } catch (error) {
      console.error('[x-spreadsheet] Failed to export:', error);
      if (el.status) el.status.textContent = '导出失败: ' + error.message;
    }
  }

  async function saveSheetFilesToStorage() {
    try {
      const sheetFiles = files.filter(f => f.type === 'sheet');
      if (sheetFiles.length > 0) {
        await writeLargeStorageValue('infinpilot-sheet-files', JSON.stringify(sheetFiles));
      } else {
        await removeLargeStorageValue('infinpilot-sheet-files');
      }
    } catch (e) {
      console.warn('[Editor] Failed to save Sheet files:', e);
    }
  }

  async function loadSheetFilesFromStorage() {
    try {
      const raw = await readLargeStorageValue('infinpilot-sheet-files');
      console.log('[Editor] loadSheetFilesFromStorage - raw data:', raw ? 'exists' : 'null');
      if (raw) {
        const parsed = JSON.parse(raw);
        console.log('[Editor] loadSheetFilesFromStorage - parsed count:', parsed.length);
        if (parsed.length > 0) {
          console.log('[Editor] loadSheetFilesFromStorage - first file:', parsed[0].name, 'content length:', parsed[0].content ? parsed[0].content.length : 0);
        }
        return parsed;
      }
    } catch (e) {
      console.warn('[Editor] Failed to load Sheet files:', e);
    }
    return [];
  }
  
  // 根据文件ID导出MD文件
  function exportMdFileById(fileId) {
    const file = files.find(f => f.id === fileId && f.type === 'file');
    if (!file) {
      if (el.status) el.status.textContent = '文件不存在';
      return;
    }
    
    const content = file.content || '';
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
    if (el.status) el.status.textContent = '已导出 ' + file.name;
  }

  // ========== SVG Editor ==========
  let isSvgMode = false;
  let svgFrameReady = false;
  let svgAutosaveTimer = null;
  let svgPendingContent = null;
  let svgRequestId = 0;
  const svgResponseResolvers = new Map();

  const svgToggleBtn = $('md-svg-toggle');
  const newSvgBtn = $('md-new-svg');
  const svgExportBtn = $('svg-export');

  function createDefaultSvgContent() {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" version="1.1"><rect width="1200" height="800" fill="#ffffff"/><text x="600" y="400" font-size="40" text-anchor="middle" fill="#0f172a">New SVG</text></svg>';
  }

  function sanitizeSvgContent(svgText) {
    const fallback = createDefaultSvgContent();
    if (!svgText || typeof svgText !== 'string') {
      return fallback;
    }

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgText, 'image/svg+xml');
      const svg = doc.documentElement;
      if (!svg || svg.tagName.toLowerCase() !== 'svg') {
        return fallback;
      }

      svg.querySelectorAll('script, foreignObject').forEach(node => node.remove());
      svg.querySelectorAll('*').forEach(node => {
        Array.from(node.attributes).forEach(attr => {
          const name = attr.name.toLowerCase();
          const value = attr.value || '';
          if (name.startsWith('on')) {
            node.removeAttribute(attr.name);
            return;
          }
          if ((name === 'href' || name === 'xlink:href') && /^(javascript:|https?:|data:text\/html)/i.test(value.trim())) {
            node.removeAttribute(attr.name);
          }
        });
      });

      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!svg.getAttribute('viewBox')) {
        svg.setAttribute('viewBox', '0 0 1200 800');
      }
      return new XMLSerializer().serializeToString(svg);
    } catch (error) {
      console.warn('[SVG] Failed to sanitize SVG:', error);
      return fallback;
    }
  }

  function getSvgEditorFrame() {
    return $('svg-editor');
  }

  function getSvgToolbar() {
    return $('svg-toolbar');
  }

  function postSvgEditorMessage(message) {
    const frame = getSvgEditorFrame();
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(message, '*');
    }
  }

  function ensureSvgEditorLoaded() {
    const frame = getSvgEditorFrame();
    if (!frame) {
      return;
    }
    if (!frame.src) {
      frame.src = browser.runtime.getURL('html/svg-editor.html');
    }
  }

  function handleSvgEditorMessage(event) {
    const data = event.data || {};
    if (data.source !== 'infinpilot-svg-editor') {
      return;
    }

    if (data.type === 'svg-editor-ready') {
      svgFrameReady = true;
      if (svgPendingContent !== null) {
        postSvgEditorMessage(svgPendingContent);
        svgPendingContent = null;
      }
      return;
    }

    if (data.type === 'svg-editor-change') {
      const currentFile = files.find(file => file.id === currentFileId && file.type === 'svg');
      if (currentFile) {
        currentFile.content = sanitizeSvgContent(data.svg);
        syncFileGlobals();
      }
      return;
    }

    if (data.type === 'svg-editor-response' && data.requestId) {
      const resolver = svgResponseResolvers.get(data.requestId);
      if (resolver) {
        svgResponseResolvers.delete(data.requestId);
        resolver(sanitizeSvgContent(data.svg));
      }
    }
  }

  window.addEventListener('message', handleSvgEditorMessage);

  function loadSvgIntoEditor(svgText, options = {}) {
    const content = sanitizeSvgContent(svgText);
    const payload = {
      type: 'load-svg',
      svg: content,
      centerContent: options.centerContent === true
    };
    if (svgFrameReady) {
      postSvgEditorMessage(payload);
      svgPendingContent = null;
      return;
    }
    svgPendingContent = payload;
    ensureSvgEditorLoaded();
  }

  async function requestSvgContentFromEditor() {
    if (!svgFrameReady) {
      const currentFile = files.find(file => file.id === currentFileId && file.type === 'svg');
      return currentFile?.content || createDefaultSvgContent();
    }

    return new Promise(resolve => {
      const requestId = 'svg-' + (++svgRequestId);
      svgResponseResolvers.set(requestId, resolve);
      postSvgEditorMessage({ type: 'request-svg', requestId });
      setTimeout(() => {
        if (!svgResponseResolvers.has(requestId)) {
          return;
        }
        svgResponseResolvers.delete(requestId);
        const currentFile = files.find(file => file.id === currentFileId && file.type === 'svg');
        resolve(currentFile?.content || createDefaultSvgContent());
      }, 1200);
    });
  }

  async function saveCurrentSvgContent() {
    const currentFile = files.find(file => file.id === currentFileId && file.type === 'svg');
    if (!currentFile) {
      return;
    }
    currentFile.content = sanitizeSvgContent(await requestSvgContentFromEditor());
    syncFileGlobals();
  }

  function startSvgAutosave() {
    stopSvgAutosave();
    svgAutosaveTimer = setInterval(async () => {
      if (!isSvgMode || isSavingFiles) {
        return;
      }
      await saveCurrentSvgContent();
      await saveFilesToStorage();
      if (el.status) {
        el.status.textContent = 'SVG 已自动保存';
      }
    }, 2500);
  }

  function stopSvgAutosave() {
    if (svgAutosaveTimer) {
      clearInterval(svgAutosaveTimer);
      svgAutosaveTimer = null;
    }
  }

  async function switchToSvgMode() {
    if (isSvgMode) {
      ensureSvgEditorLoaded();
      return;
    }

    isSvgMode = true;
    ensureSvgEditorLoaded();
    startSvgAutosave();

    const mdToolbar = document.querySelector('#editor .editor-toolbar');
    const editorMain = document.querySelector('#editor .editor-main');
    const superdocToolbar = $('superdoc-toolbar');
    const superdocEditor = $('superdoc-editor');
    const sheetEditor = $('sheet-editor');
    const svgToolbar = getSvgToolbar();
    const svgEditor = getSvgEditorFrame();

    if (mdToolbar) mdToolbar.style.display = 'none';
    if (editorMain) editorMain.style.display = 'none';
    if (superdocToolbar) superdocToolbar.style.display = 'none';
    if (superdocEditor) superdocEditor.style.display = 'none';
    if (sheetEditor) sheetEditor.style.display = 'none';
    if (svgToolbar) svgToolbar.style.display = 'flex';
    if (svgEditor) svgEditor.style.display = 'block';
    if (svgToggleBtn) svgToggleBtn.classList.add('active');
  }

  async function switchToMarkdownModeFromSvg() {
    if (!isSvgMode) {
      return;
    }

    stopSvgAutosave();
    await saveCurrentSvgContent();
    await saveFilesToStorage();
    isSvgMode = false;

    const mdToolbar = document.querySelector('#editor .editor-toolbar');
    const editorMain = document.querySelector('#editor .editor-main');
    const svgToolbar = getSvgToolbar();
    const svgEditor = getSvgEditorFrame();

    if (mdToolbar) mdToolbar.style.display = '';
    if (editorMain) editorMain.style.display = '';
    if (svgToolbar) svgToolbar.style.display = 'none';
    if (svgEditor) svgEditor.style.display = 'none';
    if (svgToggleBtn) svgToggleBtn.classList.remove('active');
  }

  async function switchToSvgFile(fileId) {
    if (isSvgMode && currentFileId === fileId) {
      return;
    }

    if (isDocxMode) {
      await switchToMarkdownMode();
    }
    if (isSheetMode) {
      await switchToMarkdownModeFromSheet();
    }
    if (isSvgMode && currentFileId !== fileId) {
      await saveCurrentSvgContent();
      await saveFilesToStorage();
    }

    const svgFile = files.find(file => file.id === fileId && file.type === 'svg');
    if (!svgFile) {
      return;
    }

    currentFileId = fileId;
    setSelectedTreeItemId(fileId);
    const expandedPath = expandFolderPathForItem(svgFile);
    syncFileGlobals();
    dispatchCurrentFileChangedEvent();
    if (expandedPath) {
      void saveFilesToStorage();
    }
    renderFileTree();
    renderFileTabs();
    await switchToSvgMode();
    loadSvgIntoEditor(svgFile.content || createDefaultSvgContent(), {
      centerContent: svgFile.pendingCenterOnLoad === true
    });
    if (svgFile.pendingCenterOnLoad) {
      delete svgFile.pendingCenterOnLoad;
      syncFileGlobals();
      void saveFilesToStorage();
    }
    if (el.status) {
      el.status.textContent = 'SVG 编辑器已就绪';
    }
  }

  async function createNewSvgFile(name = null, parentId = null) {
    const file = {
      id: createId('file'),
      name: name || 'untitled.svg',
      type: 'svg',
      content: createDefaultSvgContent(),
      imageMap: {},
      parentId: getValidParentFolderId(parentId || getPreferredCreationFolderId())
    };

    files.push(file);
    setSelectedTreeItemId(file.id);
    expandFolderPathForItem(file);
    syncFileGlobals();
    await saveFilesToStorage();
    await switchToSvgFile(file.id);
    renderFileTabs();
    renderFileTree();
    return { id: file.id, name: file.name, parentId: file.parentId };
  }

  async function exportSvgFileById(fileId) {
    const file = files.find(item => item.id === fileId && item.type === 'svg');
    if (!file) {
      if (el.status) el.status.textContent = '文件不存在';
      return;
    }

    if (fileId === currentFileId && isSvgMode) {
      await saveCurrentSvgContent();
      await saveFilesToStorage();
    }

    const blob = new Blob([sanitizeSvgContent(file.content)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.endsWith('.svg') ? file.name : (file.name + '.svg');
    a.click();
    URL.revokeObjectURL(url);
    if (el.status) el.status.textContent = '已导出 ' + file.name;
  }

  async function importSvgFile(file, fileName = null, parentId = null, options = {}) {
    const svgText = typeof file === 'string' ? file : await file.text();
    const created = await createNewSvgFile(
      fileName || file?.name || 'untitled.svg',
      parentId || getPreferredCreationFolderId()
    );
    const target = files.find(item => item.id === created.id && item.type === 'svg');
    if (target) {
      target.content = sanitizeSvgContent(svgText);
      target.pendingCenterOnLoad = options.centerContent === true;
      syncFileGlobals();
      await saveFilesToStorage();
      await switchToSvgFile(target.id);
    }
    return created;
  }

  if (svgToggleBtn) {
    svgToggleBtn.addEventListener('click', async () => {
      const currentFile = getCurrentFile();
      if (isSvgMode) {
        await switchToMarkdownModeFromSvg();
        return;
      }
      if (currentFile && currentFile.type === 'svg') {
        await switchToSvgFile(currentFile.id);
        return;
      }
      if (el.status) {
        el.status.textContent = '只有 SVG 文件才能进入 SVG 编辑模式';
      }
    });
  }

  if (newSvgBtn) {
    newSvgBtn.addEventListener('click', async () => {
      await createNewSvgFile(null, getPreferredCreationFolderId());
      if (el.status) {
        el.status.textContent = '已创建新 SVG 文档';
      }
    });
  }

  if (svgExportBtn) {
    svgExportBtn.addEventListener('click', async () => {
      await exportSvgFileById(currentFileId);
    });
  }

  if (el.exportBtn){
    el.exportBtn.addEventListener('click', async ()=>{
      // 首先检查是否在 DOCX 模式
      if (isDocxMode) {
        exportDocxFile();
        return;
      }
      if (isSvgMode) {
        await exportSvgFileById(currentFileId);
        return;
      }

      // 检查是否有当前打开的文件
      const currentFile = getCurrentFile();

      if (currentFile && currentFile.type === 'svg') {
        await exportSvgFileById(currentFile.id);
        return;
      }
      if (currentFile && currentFile.type === 'file') {
        // 导出当前文件，使用原始文件名和格式
        const contentToExport = currentFile.content || '';
        const filename = currentFile.name;
        // 根据文件扩展名确定 MIME 类型
        let mimeType = 'text/plain;charset=utf-8';
        const ext = filename.split('.').pop().toLowerCase();
        if (ext === 'html' || ext === 'htm') mimeType = 'text/html;charset=utf-8';
        else if (ext === 'css') mimeType = 'text/css;charset=utf-8';
        else if (ext === 'js') mimeType = 'application/javascript;charset=utf-8';
        else if (ext === 'json') mimeType = 'application/json;charset=utf-8';
        else if (ext === 'md') mimeType = 'text/markdown;charset=utf-8';

        const blob = new Blob([contentToExport], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (el.status) el.status.textContent = '已导出: ' + filename;
      } else {
        // 没有打开的文件，导出编辑器内容为 markdown
        let contentToExport = mdState.content || '';
        if (mdState.imageMap) {
            for (const [id, dataUrl] of Object.entries(mdState.imageMap)) {
                contentToExport = contentToExport.replace(new RegExp(id, 'g'), dataUrl);
            }
        }
        const filename = (mdState.title?.trim() || `infinpilot_${new Date().toISOString().slice(0,10)}`) + '.md';
        const blob = new Blob([contentToExport], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (el.status) el.status.textContent = '已导出: ' + filename;
      }
    });
  }

  // 运行HTML功能已移除 - 浏览器扩展CSP限制导致无法执行JavaScript
  // if (el.runBtn) { ... }

  if (el.viewEdit) el.viewEdit.addEventListener('click', ()=> setView('edit'));
  if (el.viewPreview) el.viewPreview.addEventListener('click', ()=> setView('preview'));
  if (el.viewSplit) el.viewSplit.addEventListener('click', ()=> setView('split', 'horizontal'));
  if (el.viewSplitVertical) el.viewSplitVertical.addEventListener('click', ()=> setView('split', 'vertical'));

  if (el.mdBold) el.mdBold.addEventListener('click', () => wrapSelection('**'));
  if (el.mdItalic) el.mdItalic.addEventListener('click', () => wrapSelection('*'));
  if (el.mdStrikethrough) el.mdStrikethrough.addEventListener('click', () => wrapSelection('~~'));
  if (el.mdCode) el.mdCode.addEventListener('click', () => wrapSelection('`'));
  if (el.mdLink) el.mdLink.addEventListener('click', () => {
      const selection = getSelectionText();
      if (selection.startsWith('http')) {
          wrapSelection('[', `](${selection})`);
      } else {
          wrapSelection('[', '](url)');
      }
  });
  if (el.mdListUl) el.mdListUl.addEventListener('click', () => prefixLines('-'));
  if (el.mdListOl) el.mdListOl.addEventListener('click', () => prefixLines('1.'));

  function filterImageCode(text) {
    if (!text) return '';
    return text.replace(/!\\[[^\\]*\]\(data:image\/[^;]+;base64,[^)]+\)/g, '[图片]');
  }

  const aiMenu = document.getElementById('md-ai-menu');
  async function triggerAiAction(action) {
    try {
      if (!window.InfinPilotAPI?.callApi) {
        if (el.status) el.status.textContent = 'AI 接口不可用';
        return;
      }
      const selection = getSelectionText();
      const filteredContent = filterImageCode(mdState.content);
      const filteredSelection = filterImageCode(selection);
      if (action.includes('selection') && !selection) {
        if (el.status) el.status.textContent = '请先选中文本';
        setTimeout(() => { if (el.status.textContent === '请先选中文本') el.status.textContent = '就绪'; }, 2000);
        return;
      }
      let pageContent = '';
      if (el.aiIncludePageContent.checked && window.state?.pageContext) {
          pageContent = window.state.pageContext;
      }
      let user = buildUserPrompt(action, filteredContent, filteredSelection);
      if (pageContent) {
        user = `Here is the content of the current web page for your reference:\n\n---\n${pageContent}\n---\n\nNow, please perform the following task:\n\n${user}`;
      }
      if (el.status) el.status.textContent = 'AI 协作中...';
      let acc = '';
      const streamCb = (chunk) => { acc += chunk; };
      const settings = await browser.storage.sync.get('model');
      const modelId = settings.model || 'google::gemini-pro';
      const temperature = (window.state && typeof window.state.temperature === 'number') ? window.state.temperature : 0.7;
      await window.InfinPilotAPI.callApi(modelId, [{ role: 'system', content: 'You are a Markdown co-author...' }, { role: 'user', content: user }], streamCb, { temperature });
      applyAiResult(action, selection, acc);
      if (el.status) el.status.textContent = 'AI 已应用';
    } catch (e) {
      console.error('[editor] AI 协作失败:', e);
      if (el.status) el.status.textContent = 'AI 协作失败';
    }
  }

  if (aiMenu) {
    aiMenu.addEventListener('click', (e) => {
      const button = e.target.closest('.ai-action-button');
      if (button?.dataset.action) {
        triggerAiAction(button.dataset.action);
      }
    });
  }

  function applyAiResult(action, selection, result){
    if (action.includes('selection') && selection){
      replaceSelection(result);
    } else {
      insertAtCursor(result.endsWith('\n') ? result : (result + '\n'));
    }
  }

  function buildUserPrompt(action, fullText, sel){
    const customPrompt = el.aiCustomPromptInput.value.trim();

    switch (action) {
        case 'custom-prompt-selection':
            if (!customPrompt) return `Analyze the following text:\n\n---\n${sel}\n---`;
            return `User instruction: "${customPrompt}"\n\nApply this instruction to the following text:\n\n---\n${sel}\n---`;
        
        case 'summarize-document':
            return `Please provide a concise summary of the following document:\n\n---\n${fullText}\n---`;

        case 'fix-grammar-selection':
            return `Please correct any grammar and spelling mistakes in the following text. Only output the corrected text, without any additional commentary.:\n\n---\n${sel}\n---`;
        
        case 'continue-writing':
            return `Continue writing from the end of this text. Maintain the same style and tone. Do not repeat the original text in your response, only provide the new content.\n\n---\n${fullText}\n---`;

        default:
            // Fallback for other potential actions, including custom ones from the menu
            const button = aiMenu.querySelector(`[data-action="${action}"]`);
            const actionName = button ? button.textContent.trim() : action;
            return `Apply the action "${actionName}" to the following text:\n\n---\n${sel}\n---`;
    }
  }

  const resizer = document.getElementById('editor-resizer');
  if (resizer) {
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      resizer.classList.add('active');
      const editorPane = cmEditor ? cmEditor.getWrapperElement() : el.editor;
      const previewPane = el.preview;
      const isVertical = mdState.splitOrientation === 'vertical';
      const startX = e.pageX, startY = e.pageY;
      const startEditorW = editorPane.offsetWidth, startPreviewW = previewPane.offsetWidth;
      const startEditorH = editorPane.offsetHeight, startPreviewH = previewPane.offsetHeight;

      const handleMouseMove = (moveEvent) => {
        if (!isResizing) return;
        if (isVertical) {
            const dY = moveEvent.pageY - startY;
            if (startEditorH + dY < 50 || startPreviewH - dY < 50) return;
            const totalH = editorPane.parentElement.offsetHeight - resizer.offsetHeight;
            editorPane.style.flexBasis = `${((startEditorH + dY) / totalH) * 100}%`;
            previewPane.style.flexBasis = `${((startPreviewH - dY) / totalH) * 100}%`;
        } else {
            const dX = moveEvent.pageX - startX;
            if (startEditorW + dX < 50 || startPreviewW - dX < 50) return;
            const totalW = editorPane.parentElement.offsetWidth - resizer.offsetWidth;
            editorPane.style.flexBasis = `${((startEditorW + dX) / totalW) * 100}%`;
            previewPane.style.flexBasis = `${((startPreviewW - dX) / totalW) * 100}%`;
        }
      };
      const handleMouseUp = () => {
        isResizing = false;
        resizer.classList.remove('active');
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    });
  }

  (async function init(){
    // Wait for files to be loaded from storage
    while (!editorFilesReady) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    try {
      const data = await readLargeStorageValue('infinpilot_md_draft');
      if (data && typeof data.content === 'string') {
        Object.assign(mdState, data);
      }
    } catch (e) { /* ignore */ }

    if (el.editor && !cmEditor) {
        const isDarkMode = document.body.classList.contains('dark-mode');
        const initialTheme = isDarkMode ? 'material-darker' : 'material';

        cmEditor = CodeMirror.fromTextArea(el.editor, {
            mode: 'markdown',
            theme: initialTheme,
            lineNumbers: true,
            lineWrapping: true,
            readOnly: false, // Explicitly set to false to ensure editability
            extraKeys: {
                "Ctrl-F": "findPersistent",
                "Ctrl-H": "replace"
            }
        });

        el.editor.classList.add('codemirror-hidden');

        cmEditor.on('change', handleEditorChange);

        cmEditor.on('cursorActivity', () => {
            el.aiCustomPromptContainer.style.display = cmEditor.getSelection() ? 'flex' : 'none';
        });

        const editorScroller = cmEditor.getScrollerElement();
        const previewEl = el.preview;

        const syncPreviewScroll = throttle(() => {
            if (!editorScroller || !previewEl || mdState.viewMode !== 'split') return;
            const { scrollTop, scrollHeight, clientHeight } = editorScroller;
            if (scrollHeight <= clientHeight) return;
            const scrollRatio = scrollTop / (scrollHeight - clientHeight);
            previewEl.scrollTop = (previewEl.scrollHeight - previewEl.clientHeight) * scrollRatio;
        }, 50);

        const syncEditorScroll = throttle(() => {
            if (!editorScroller || !previewEl || mdState.viewMode !== 'split') return;
            const { scrollTop, scrollHeight, clientHeight } = previewEl;
            if (scrollHeight <= clientHeight) return;
            const scrollRatio = scrollTop / (scrollHeight - clientHeight);
            editorScroller.scrollTop = (editorScroller.scrollHeight - editorScroller.clientHeight) * scrollRatio;
        }, 50);

        editorScroller.addEventListener('scroll', syncPreviewScroll);
        previewEl.addEventListener('scroll', syncEditorScroll);
    }
    
    // 初始化文件栏
    initFileBar();
    initFileTree();

    setContent(mdState.content);

    const initialMode = mdState.viewMode || 'split';
    const initialOrientation = mdState.splitOrientation || 'horizontal';
    setView(initialMode, initialOrientation);

    renderPreview();

    isInitializing = false;
  })();
})();
