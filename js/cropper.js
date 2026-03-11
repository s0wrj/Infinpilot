// js/cropper.js
(() => {
  const cropper = document.createElement('div');
  cropper.style.position = 'fixed';
  cropper.style.top = '0';
  cropper.style.left = '0';
  cropper.style.width = '100vw';
  cropper.style.height = '100vh';
  cropper.style.zIndex = '2147483647';
  cropper.style.cursor = 'crosshair';

  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.background = 'rgba(0, 0, 0, 0.5)';
  cropper.appendChild(overlay);

  const selection = document.createElement('div');
  selection.style.position = 'absolute';
  selection.style.border = '2px dashed #fff';
  selection.style.background = 'rgba(255, 255, 255, 0.1)';
  selection.style.display = 'none';
  cropper.appendChild(selection);

  let startX, startY, isDrawing = false;

  cropper.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    isDrawing = true;
    selection.style.left = startX + 'px';
    selection.style.top = startY + 'px';
    selection.style.width = '0px';
    selection.style.height = '0px';
    selection.style.display = 'block';
  });

  cropper.addEventListener('mousemove', (e) => {
    e.stopPropagation();
    if (!isDrawing) return;
    const width = e.clientX - startX;
    const height = e.clientY - startY;
    selection.style.width = Math.abs(width) + 'px';
    selection.style.height = Math.abs(height) + 'px';
    selection.style.left = (width > 0 ? startX : e.clientX) + 'px';
    selection.style.top = (height > 0 ? startY : e.clientY) + 'px';
  });

  cropper.addEventListener('mouseup', (e) => {
    e.stopPropagation();
    if (!isDrawing) return;
    isDrawing = false;
    const rect = selection.getBoundingClientRect();
    document.body.removeChild(cropper);
    
    // Use devicePixelRatio for higher resolution screens
    const dpr = window.devicePixelRatio || 1;

    browser.runtime.sendMessage({
      action: 'captureArea',
      area: {
        x: rect.left * dpr,
        y: rect.top * dpr,
        width: rect.width * dpr,
        height: rect.height * dpr,
        devicePixelRatio: dpr
      }
    });
  });
  
  // Allow canceling with Escape key
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      document.body.removeChild(cropper);
      document.removeEventListener('keydown', handleKeyDown);
      browser.runtime.sendMessage({ action: 'captureCancel' });
    }
  };
  document.addEventListener('keydown', handleKeyDown);

  document.body.appendChild(cropper);
})();
