(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_VIEWBOX = { x: 0, y: 0, width: 1200, height: 800 };
  const DRAWABLE_SELECTOR = 'rect,ellipse,circle,line,path,polygon,polyline,text';

  let stage = document.getElementById('stage');
  const statusEl = document.getElementById('status');
  const fillInput = document.getElementById('fill-color');
  const strokeInput = document.getElementById('stroke-color');
  const strokeWidthInput = document.getElementById('stroke-width');
  const fontSizeInput = document.getElementById('font-size');
  const opacityInput = document.getElementById('opacity');
  const strokeWidthValue = document.getElementById('stroke-width-value');
  const fontSizeValue = document.getElementById('font-size-value');
  const opacityValue = document.getElementById('opacity-value');
  const zoomLevel = document.getElementById('zoom-level');
  const toolButtons = {
    select: document.getElementById('tool-select'),
    rect: document.getElementById('tool-rect'),
    ellipse: document.getElementById('tool-ellipse'),
    diamond: document.getElementById('tool-diamond'),
    line: document.getElementById('tool-line'),
    text: document.getElementById('tool-text')
  };

  let currentTool = 'select';
  let selectedElement = null;
  let dragState = null;
  let changeTimer = null;
  let nextElementId = 1;

  function setStatus(text) {
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  function notifyParent(type, payload) {
    window.parent.postMessage({ source: 'infinpilot-svg-editor', type, ...payload }, '*');
  }

  function updateRangeReadouts() {
    strokeWidthValue.textContent = strokeWidthInput.value;
    fontSizeValue.textContent = fontSizeInput.value;
    opacityValue.textContent = opacityInput.value + '%';
  }

  function parseViewBox() {
    const baseVal = stage.viewBox && stage.viewBox.baseVal;
    if (baseVal && baseVal.width && baseVal.height) {
      return {
        x: baseVal.x,
        y: baseVal.y,
        width: baseVal.width,
        height: baseVal.height
      };
    }

    const attr = stage.getAttribute('viewBox');
    if (!attr) {
      return { ...DEFAULT_VIEWBOX };
    }

    const parts = attr.split(/\s+/).map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      return { ...DEFAULT_VIEWBOX };
    }

    return {
      x: parts[0],
      y: parts[1],
      width: parts[2],
      height: parts[3]
    };
  }

  function setViewBox(viewBox) {
    stage.setAttribute(
      'viewBox',
      [viewBox.x, viewBox.y, viewBox.width, viewBox.height].join(' ')
    );
    updateZoomIndicator();
  }

  function resetViewBox() {
    setViewBox({ ...DEFAULT_VIEWBOX });
  }

  function updateZoomIndicator() {
    const viewBox = parseViewBox();
    const zoom = Math.round((DEFAULT_VIEWBOX.width / viewBox.width) * 100);
    zoomLevel.textContent = zoom + '%';
  }

  function eventToSvgPoint(evt) {
    const rect = stage.getBoundingClientRect();
    const viewBox = parseViewBox();
    return {
      x: viewBox.x + ((evt.clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((evt.clientY - rect.top) / rect.height) * viewBox.height
    };
  }

  function isDrawableElement(element) {
    return element instanceof SVGElement &&
      element.matches(DRAWABLE_SELECTOR) &&
      !element.closest('defs');
  }

  function ensureEditorDefs(svgElement) {
    let defs = svgElement.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      svgElement.insertBefore(defs, svgElement.firstChild);
    }

    if (!defs.querySelector('#svg-editor-arrow')) {
      const marker = document.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', 'svg-editor-arrow');
      marker.setAttribute('markerWidth', '10');
      marker.setAttribute('markerHeight', '10');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '5');
      marker.setAttribute('orient', 'auto');

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      path.setAttribute('fill', '#1c1917');
      marker.appendChild(path);
      defs.appendChild(marker);
    }
  }

  function ensureElementId(element) {
    if (!element.dataset.elementId) {
      element.dataset.elementId = 'svg-node-' + nextElementId++;
    }
  }

  function markEditableElements(root) {
    root.querySelectorAll(DRAWABLE_SELECTOR).forEach((element) => {
      if (!element.closest('defs')) {
        ensureElementId(element);
        element.dataset.editable = 'true';
      }
    });
  }

  function normalizeColor(value, fallback) {
    if (!value || value === 'none') {
      return fallback;
    }

    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();

    const match = resolved.match(/\d+/g);
    if (!match || match.length < 3) {
      return fallback;
    }

    return '#' + match.slice(0, 3).map((part) => Number(part).toString(16).padStart(2, '0')).join('');
  }

  function setTool(tool) {
    currentTool = tool;
    stage.classList.toggle('select-mode', tool === 'select');

    Object.entries(toolButtons).forEach(([key, button]) => {
      if (button) {
        button.classList.toggle('active', key === tool);
      }
    });

    setStatus(tool === 'select' ? '已切换到选择模式' : ('当前工具：' + getToolLabel(tool)));
  }

  function getToolLabel(tool) {
    const labels = {
      select: '选择',
      rect: '矩形',
      ellipse: '椭圆',
      diamond: '菱形',
      line: '箭头',
      text: '文字'
    };
    return labels[tool] || tool;
  }

  function getElementLabel(tagName) {
    const labels = {
      rect: '矩形',
      ellipse: '椭圆',
      circle: '圆形',
      line: '线条',
      path: '路径',
      polygon: '多边形',
      polyline: '折线',
      text: '文字'
    };
    return labels[tagName] || tagName;
  }

  function scheduleChange() {
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      notifyParent('svg-editor-change', { svg: serializeSvg() });
    }, 120);
  }

  function getOwnedLabels(element) {
    if (!element || !element.dataset.elementId) {
      return [];
    }
    return Array.from(stage.querySelectorAll('text[data-owner="' + element.dataset.elementId + '"]'));
  }

  function selectElement(element) {
    if (selectedElement === element) {
      return;
    }

    if (selectedElement) {
      selectedElement.classList.remove('selected-shape');
    }

    selectedElement = element;

    if (!selectedElement) {
      setStatus('就绪');
      return;
    }

    selectedElement.classList.add('selected-shape');

    if (selectedElement.hasAttribute('fill')) {
      fillInput.value = normalizeColor(selectedElement.getAttribute('fill'), fillInput.value);
    }

    if (selectedElement.tagName === 'text') {
      strokeInput.value = normalizeColor(selectedElement.getAttribute('fill'), strokeInput.value);
      fontSizeInput.value = String(Math.round(parseFloat(selectedElement.getAttribute('font-size')) || 28));
    } else {
      if (selectedElement.hasAttribute('stroke')) {
        strokeInput.value = normalizeColor(selectedElement.getAttribute('stroke'), strokeInput.value);
      }
      if (selectedElement.hasAttribute('stroke-width')) {
        strokeWidthInput.value = String(Math.round(parseFloat(selectedElement.getAttribute('stroke-width')) || 3));
      }
    }

    if (selectedElement.hasAttribute('opacity')) {
      opacityInput.value = String(Math.round((parseFloat(selectedElement.getAttribute('opacity')) || 1) * 100));
    }

    updateRangeReadouts();
    setStatus('已选中：' + getElementLabel(selectedElement.tagName.toLowerCase()));
  }

  function createSvgElement(tagName) {
    return document.createElementNS(SVG_NS, tagName);
  }

  function createElementAt(point) {
    let element = null;

    if (currentTool === 'rect') {
      element = createSvgElement('rect');
      element.setAttribute('x', point.x - 88);
      element.setAttribute('y', point.y - 50);
      element.setAttribute('width', 176);
      element.setAttribute('height', 100);
      element.setAttribute('rx', 18);
      element.setAttribute('fill', fillInput.value);
      element.setAttribute('stroke', strokeInput.value);
      element.setAttribute('stroke-width', strokeWidthInput.value);
    } else if (currentTool === 'ellipse') {
      element = createSvgElement('ellipse');
      element.setAttribute('cx', point.x);
      element.setAttribute('cy', point.y);
      element.setAttribute('rx', 90);
      element.setAttribute('ry', 54);
      element.setAttribute('fill', fillInput.value);
      element.setAttribute('stroke', strokeInput.value);
      element.setAttribute('stroke-width', strokeWidthInput.value);
    } else if (currentTool === 'diamond') {
      element = createSvgElement('polygon');
      element.setAttribute(
        'points',
        [
          point.x + ',' + (point.y - 70),
          (point.x + 110) + ',' + point.y,
          point.x + ',' + (point.y + 70),
          (point.x - 110) + ',' + point.y
        ].join(' ')
      );
      element.setAttribute('fill', fillInput.value);
      element.setAttribute('stroke', strokeInput.value);
      element.setAttribute('stroke-width', strokeWidthInput.value);
    } else if (currentTool === 'line') {
      element = createSvgElement('line');
      element.setAttribute('x1', point.x - 90);
      element.setAttribute('y1', point.y - 24);
      element.setAttribute('x2', point.x + 90);
      element.setAttribute('y2', point.y + 24);
      element.setAttribute('stroke', strokeInput.value);
      element.setAttribute('stroke-width', strokeWidthInput.value);
      element.setAttribute('marker-end', 'url(#svg-editor-arrow)');
    } else if (currentTool === 'text') {
      element = createSvgElement('text');
      element.setAttribute('x', point.x);
      element.setAttribute('y', point.y);
      element.setAttribute('fill', strokeInput.value);
      element.setAttribute('font-size', fontSizeInput.value);
      element.setAttribute('font-family', 'Segoe UI, Helvetica Neue, sans-serif');
      element.setAttribute('font-weight', '600');
      element.setAttribute('text-anchor', 'middle');
      element.textContent = '文本';
    }

    if (!element) {
      return null;
    }

    ensureElementId(element);
    element.dataset.editable = 'true';
    element.setAttribute('opacity', String((Number(opacityInput.value) || 100) / 100));
    stage.appendChild(element);
    selectElement(element);
    scheduleChange();
    return element;
  }

  function parsePoints(pointsText) {
    return String(pointsText || '')
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number))
      .filter((pair) => pair.length === 2 && pair.every((value) => !Number.isNaN(value)));
  }

  function serializePoints(points) {
    return points.map((pair) => pair.join(',')).join(' ');
  }

  function applyFallbackTranslation(element, dx, dy) {
    const baseTransform = element.dataset.editorBaseTransform !== undefined
      ? element.dataset.editorBaseTransform
      : (element.getAttribute('transform') || '');

    if (element.dataset.editorBaseTransform === undefined) {
      element.dataset.editorBaseTransform = baseTransform;
    }

    const nextX = (parseFloat(element.dataset.editorTranslateX || '0') || 0) + dx;
    const nextY = (parseFloat(element.dataset.editorTranslateY || '0') || 0) + dy;
    element.dataset.editorTranslateX = String(nextX);
    element.dataset.editorTranslateY = String(nextY);

    const translate = 'translate(' + nextX + ' ' + nextY + ')';
    element.setAttribute('transform', baseTransform ? (baseTransform + ' ' + translate) : translate);
  }

  function moveElement(element, dx, dy, options = {}) {
    const includeLabels = options.includeLabels === true;

    if (element.tagName === 'rect') {
      element.setAttribute('x', parseFloat(element.getAttribute('x')) + dx);
      element.setAttribute('y', parseFloat(element.getAttribute('y')) + dy);
    } else if (element.tagName === 'ellipse' || element.tagName === 'circle') {
      element.setAttribute('cx', parseFloat(element.getAttribute('cx')) + dx);
      element.setAttribute('cy', parseFloat(element.getAttribute('cy')) + dy);
    } else if (element.tagName === 'line') {
      element.setAttribute('x1', parseFloat(element.getAttribute('x1')) + dx);
      element.setAttribute('y1', parseFloat(element.getAttribute('y1')) + dy);
      element.setAttribute('x2', parseFloat(element.getAttribute('x2')) + dx);
      element.setAttribute('y2', parseFloat(element.getAttribute('y2')) + dy);
    } else if (element.tagName === 'text') {
      element.setAttribute('x', parseFloat(element.getAttribute('x')) + dx);
      element.setAttribute('y', parseFloat(element.getAttribute('y')) + dy);
    } else if (element.tagName === 'polygon' || element.tagName === 'polyline') {
      const nextPoints = parsePoints(element.getAttribute('points')).map(([x, y]) => [x + dx, y + dy]);
      element.setAttribute('points', serializePoints(nextPoints));
    } else {
      applyFallbackTranslation(element, dx, dy);
    }

    if (includeLabels) {
      getOwnedLabels(element).forEach((label) => moveElement(label, dx, dy));
    }
  }

  function moveSelection(dx, dy) {
    if (!selectedElement) {
      return;
    }

    moveElement(selectedElement, dx, dy, { includeLabels: !selectedElement.dataset.owner });
    scheduleChange();
  }

  function getElementVisualBox(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return null;
    }

    const stageRect = stage.getBoundingClientRect();
    const viewBox = parseViewBox();
    const scaleX = viewBox.width / stageRect.width;
    const scaleY = viewBox.height / stageRect.height;

    return {
      x: viewBox.x + (rect.left - stageRect.left) * scaleX,
      y: viewBox.y + (rect.top - stageRect.top) * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    };
  }

  function getEditableElements() {
    return Array.from(stage.querySelectorAll('[data-editable="true"]')).filter(isDrawableElement);
  }

  function getContentBounds() {
    const elements = getEditableElements();
    if (elements.length === 0) {
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    elements.forEach((element) => {
      const box = getElementVisualBox(element);
      if (!box) {
        return;
      }

      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    });

    if (!Number.isFinite(minX)) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  function centerContentOnCanvas() {
    const bounds = getContentBounds();
    if (!bounds) {
      resetViewBox();
      return;
    }

    const currentCenterX = bounds.x + bounds.width / 2;
    const currentCenterY = bounds.y + bounds.height / 2;
    const targetCenterX = DEFAULT_VIEWBOX.x + DEFAULT_VIEWBOX.width / 2;
    const targetCenterY = DEFAULT_VIEWBOX.y + DEFAULT_VIEWBOX.height / 2;
    const dx = targetCenterX - currentCenterX;
    const dy = targetCenterY - currentCenterY;

    getEditableElements().forEach((element) => moveElement(element, dx, dy));
    resetViewBox();
    setStatus('内容已居中');
  }

  function fitStageToContent() {
    const bounds = getContentBounds();
    if (!bounds) {
      resetViewBox();
      return;
    }

    const padding = 96;
    const width = Math.max(320, bounds.width + padding * 2);
    const height = Math.max(240, bounds.height + padding * 2);
    setViewBox({
      x: bounds.x - padding,
      y: bounds.y - padding,
      width,
      height
    });
    setStatus('已适配画布');
  }

  function zoomBy(factor) {
    const viewBox = parseViewBox();
    const centerX = viewBox.x + viewBox.width / 2;
    const centerY = viewBox.y + viewBox.height / 2;
    const nextWidth = Math.max(160, Math.min(DEFAULT_VIEWBOX.width * 4, viewBox.width * factor));
    const nextHeight = Math.max(120, Math.min(DEFAULT_VIEWBOX.height * 4, viewBox.height * factor));

    setViewBox({
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight
    });
    setStatus('缩放：' + zoomLevel.textContent);
  }

  function serializeSvg() {
    const clone = stage.cloneNode(true);
    clone.classList.remove('select-mode');
    clone.querySelectorAll('.selected-shape').forEach((node) => node.classList.remove('selected-shape'));
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('version', '1.1');

    markEditableElements(clone);
    return new XMLSerializer().serializeToString(clone);
  }

  function loadSvg(svgText, options = {}) {
    if (!svgText) {
      return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const loadedSvg = doc.documentElement;
    if (!loadedSvg || loadedSvg.tagName.toLowerCase() !== 'svg') {
      return;
    }

    const replacement = stage.cloneNode(false);
    replacement.innerHTML = loadedSvg.innerHTML;
    Array.from(loadedSvg.attributes).forEach((attr) => {
      if (attr.name !== 'xmlns') {
        replacement.setAttribute(attr.name, attr.value);
      }
    });
    replacement.id = 'stage';
    replacement.className.baseVal = currentTool === 'select' ? 'select-mode' : '';
    stage.replaceWith(replacement);
    stage = replacement;

    ensureEditorDefs(stage);
    markEditableElements(stage);
    bindStage(stage);
    selectElement(null);

    if (options.centerContent === true) {
      centerContentOnCanvas();
    } else {
      fitStageToContent();
    }

    setStatus(options.centerContent === true ? '已居中到画布' : 'SVG 已加载');
  }

  function upsertLabel(target, label) {
    ensureElementId(target);
    target.dataset.label = label;

    let textNode = stage.querySelector('text[data-owner="' + target.dataset.elementId + '"]');
    if (!label) {
      if (textNode) {
        textNode.remove();
      }
      return;
    }

    if (!textNode) {
      textNode = createSvgElement('text');
      textNode.dataset.owner = target.dataset.elementId;
      textNode.setAttribute('fill', '#1c1917');
      textNode.setAttribute('font-size', '24');
      textNode.setAttribute('font-family', 'Segoe UI, Helvetica Neue, sans-serif');
      textNode.setAttribute('font-weight', '600');
      textNode.setAttribute('text-anchor', 'middle');
      ensureElementId(textNode);
      textNode.dataset.editable = 'true';
      stage.appendChild(textNode);
    }

    const box = getElementVisualBox(target);
    if (!box) {
      return;
    }

    textNode.setAttribute('x', box.x + box.width / 2);
    textNode.setAttribute('y', box.y + box.height / 2 + 8);
    textNode.textContent = label;
  }

  function bringSelectionToFront() {
    if (!selectedElement) {
      return;
    }

    const nodes = selectedElement.dataset.owner ? [selectedElement] : [selectedElement, ...getOwnedLabels(selectedElement)];
    nodes.forEach((node) => stage.appendChild(node));
    scheduleChange();
    setStatus('已置于顶层');
  }

  function sendSelectionToBack() {
    if (!selectedElement) {
      return;
    }

    const anchor = stage.querySelector(':scope > defs')?.nextSibling || stage.firstChild;
    const nodes = selectedElement.dataset.owner ? [selectedElement] : [selectedElement, ...getOwnedLabels(selectedElement)];
    nodes.slice().reverse().forEach((node) => stage.insertBefore(node, anchor));
    scheduleChange();
    setStatus('已置于底层');
  }

  function duplicateSelection() {
    if (!selectedElement) {
      return;
    }

    const clone = selectedElement.cloneNode(true);
    clone.classList.remove('selected-shape');
    clone.dataset.owner = '';
    ensureElementId(clone);
    clone.dataset.editable = 'true';
    stage.appendChild(clone);
    moveElement(clone, 36, 36);

    if (!selectedElement.dataset.owner && selectedElement.dataset.label) {
      upsertLabel(clone, selectedElement.dataset.label);
      getOwnedLabels(clone).forEach((labelNode) => moveElement(labelNode, 36, 36));
    }

    selectElement(clone);
    scheduleChange();
    setStatus('已复制');
  }

  function deleteSelection() {
    if (!selectedElement) {
      return;
    }

    const nodes = selectedElement.dataset.owner ? [selectedElement] : [selectedElement, ...getOwnedLabels(selectedElement)];
    nodes.forEach((node) => node.remove());
    selectedElement = null;
    setStatus('已删除');
    scheduleChange();
  }

  function applyCurrentStyleToSelection() {
    if (!selectedElement) {
      return;
    }

    const opacity = (Number(opacityInput.value) || 100) / 100;
    selectedElement.setAttribute('opacity', String(opacity));

    if (selectedElement.tagName === 'text') {
      selectedElement.setAttribute('fill', strokeInput.value);
      selectedElement.setAttribute('font-size', fontSizeInput.value);
    } else {
      if (selectedElement.hasAttribute('fill')) {
        selectedElement.setAttribute('fill', fillInput.value);
      }
      if (selectedElement.hasAttribute('stroke')) {
        selectedElement.setAttribute('stroke', strokeInput.value);
      }
      if (selectedElement.hasAttribute('stroke-width')) {
        selectedElement.setAttribute('stroke-width', strokeWidthInput.value);
      }
    }

    scheduleChange();
  }

  function bindStage(svgElement) {
    svgElement.addEventListener('click', (event) => {
      const target = event.target.closest('[data-editable="true"]');
      if (target && isDrawableElement(target)) {
        selectElement(target);
        if (currentTool !== 'select') {
          return;
        }
        return;
      }

      if (currentTool === 'select') {
        selectElement(null);
        return;
      }

      const created = createElementAt(eventToSvgPoint(event));
      if (created && currentTool === 'text') {
        const nextText = window.prompt('输入文字', created.textContent || '文本');
        if (nextText !== null) {
          created.textContent = nextText || '文本';
          scheduleChange();
        }
      }
    });

    svgElement.addEventListener('mousedown', (event) => {
      if (currentTool !== 'select') {
        return;
      }

      const target = event.target.closest('[data-editable="true"]');
      if (!target || !isDrawableElement(target)) {
        return;
      }

      selectElement(target);
      dragState = eventToSvgPoint(event);
      event.preventDefault();
    });

    svgElement.addEventListener('mousemove', (event) => {
      if (!dragState || !selectedElement) {
        return;
      }

      const point = eventToSvgPoint(event);
      const dx = point.x - dragState.x;
      const dy = point.y - dragState.y;
      dragState = point;
      moveElement(selectedElement, dx, dy, { includeLabels: !selectedElement.dataset.owner });
      scheduleChange();
    });

    svgElement.addEventListener('mouseup', () => {
      dragState = null;
    });

    svgElement.addEventListener('mouseleave', () => {
      dragState = null;
    });

    svgElement.addEventListener('dblclick', (event) => {
      const target = event.target.closest('[data-editable="true"]');
      if (!target || !isDrawableElement(target)) {
        return;
      }

      if (target.tagName === 'text' && !target.dataset.owner) {
        const nextText = window.prompt('输入文字', target.textContent || '');
        if (nextText !== null) {
          target.textContent = nextText || '文本';
          scheduleChange();
        }
        return;
      }

      const label = window.prompt('输入图形标签', target.dataset.label || '');
      if (label !== null) {
        upsertLabel(target, label);
        scheduleChange();
      }
    });
  }

  document.getElementById('duplicate-btn').addEventListener('click', duplicateSelection);
  document.getElementById('bring-front-btn').addEventListener('click', bringSelectionToFront);
  document.getElementById('send-back-btn').addEventListener('click', sendSelectionToBack);
  document.getElementById('delete-btn').addEventListener('click', deleteSelection);
  document.getElementById('center-btn').addEventListener('click', () => {
    centerContentOnCanvas();
    scheduleChange();
  });
  document.getElementById('fit-btn').addEventListener('click', fitStageToContent);
  document.getElementById('zoom-in-btn').addEventListener('click', () => zoomBy(0.85));
  document.getElementById('zoom-out-btn').addEventListener('click', () => zoomBy(1.18));
  document.getElementById('zoom-reset-btn').addEventListener('click', () => {
    resetViewBox();
    setStatus('缩放已重置');
  });

  Object.entries(toolButtons).forEach(([tool, button]) => {
    if (button) {
      button.addEventListener('click', () => setTool(tool));
    }
  });

  [fillInput, strokeInput, strokeWidthInput, fontSizeInput, opacityInput].forEach((input) => {
    input.addEventListener('input', () => {
      updateRangeReadouts();
      applyCurrentStyleToSelection();
    });
  });

  window.addEventListener('keydown', (event) => {
    if (event.target && /input|textarea/i.test(event.target.tagName)) {
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelection();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
      return;
    }

    const step = event.shiftKey ? 20 : 6;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(-step, 0);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(step, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(0, -step);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(0, step);
    }
  });

  window.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'load-svg') {
      loadSvg(data.svg || '', { centerContent: data.centerContent === true });
      return;
    }

    if (data.type === 'request-svg') {
      notifyParent('svg-editor-response', { requestId: data.requestId, svg: serializeSvg() });
      return;
    }

    if (data.type === 'set-tool' && toolButtons[data.tool]) {
      setTool(data.tool);
    }
  });

  updateRangeReadouts();
  markEditableElements(stage);
  ensureEditorDefs(stage);
  bindStage(stage);
  resetViewBox();
  setTool('select');
  notifyParent('svg-editor-ready', { svg: serializeSvg() });
}());
