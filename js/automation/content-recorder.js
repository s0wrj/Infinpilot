(() => {
  if (window.InfinPilotContentRecorder) {
    return;
  }

  class ContentRecorder {
    constructor() {
      this.isRecording = false;
      this.scrollTimer = null;
      this.navigationTimer = null;
      this.lastKnownUrl = window.location.href;
      this.lastKnownTitle = document.title;
      this.boundHandlers = {
        click: this.handleClick.bind(this),
        change: this.handleChange.bind(this),
        keydown: this.handleKeydown.bind(this),
        scroll: this.handleScroll.bind(this),
        contextmenu: this.handleContextMenu.bind(this),
        popstate: this.handleNavigationSignal.bind(this),
        hashchange: this.handleNavigationSignal.bind(this)
      };
    }

    init() {
      browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action === 'automationRecorderStart') {
          this.start();
          sendResponse({ success: true });
          return true;
        }
        if (message?.action === 'automationRecorderStop') {
          this.stop();
          sendResponse({ success: true });
          return true;
        }
        if (message?.action === 'automationRecorderReplay') {
          this.replay(message.steps || [])
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, error: error.message || String(error) }));
          return true;
        }
        return false;
      });
    }

    start() {
      if (this.isRecording) {
        return;
      }
      this.isRecording = true;
      this.lastKnownUrl = window.location.href;
      this.lastKnownTitle = document.title;
      document.addEventListener('click', this.boundHandlers.click, true);
      document.addEventListener('change', this.boundHandlers.change, true);
      document.addEventListener('keydown', this.boundHandlers.keydown, true);
      document.addEventListener('contextmenu', this.boundHandlers.contextmenu, true);
      window.addEventListener('scroll', this.boundHandlers.scroll, true);
      window.addEventListener('popstate', this.boundHandlers.popstate, true);
      window.addEventListener('hashchange', this.boundHandlers.hashchange, true);
      this.startNavigationObserver();
    }

    stop() {
      if (!this.isRecording) {
        return;
      }
      this.isRecording = false;
      document.removeEventListener('click', this.boundHandlers.click, true);
      document.removeEventListener('change', this.boundHandlers.change, true);
      document.removeEventListener('keydown', this.boundHandlers.keydown, true);
      document.removeEventListener('contextmenu', this.boundHandlers.contextmenu, true);
      window.removeEventListener('scroll', this.boundHandlers.scroll, true);
      window.removeEventListener('popstate', this.boundHandlers.popstate, true);
      window.removeEventListener('hashchange', this.boundHandlers.hashchange, true);
      if (this.scrollTimer) {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
      }
      this.stopNavigationObserver();
    }

    async replay(steps) {
      for (const step of steps) {
        if (!step?.type) {
          continue;
        }

        if (step.type === 'wait') {
          await this.sleep(step.durationMs || 500);
          continue;
        }

        if (step.type === 'scroll') {
          window.scrollTo(step.x || 0, step.y || 0);
          await this.sleep(200);
          continue;
        }

        if (step.type === 'manual_action') {
          throw new Error(step.instructions || '此步骤需要人工操作后再继续。');
        }

        const element = step.selector ? document.querySelector(step.selector) : document.activeElement;
        if (!element) {
          throw new Error(`未找到录制元素: ${step.selector || step.type}`);
        }

        element.scrollIntoView({ block: 'center', behavior: 'auto' });

        if (step.type === 'click') {
          element.click();
          await this.sleep(180);
          continue;
        }

        if (step.type === 'contextmenu') {
          element.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            buttons: 2,
            clientX: 0,
            clientY: 0
          }));
          await this.sleep(180);
          continue;
        }

        if (step.type === 'input') {
          element.focus();
          if (element.isContentEditable) {
            element.textContent = step.value || '';
          } else {
            element.value = step.value || '';
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          await this.sleep(120);
          continue;
        }

        if (step.type === 'select') {
          element.value = step.value || '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          await this.sleep(120);
          continue;
        }

        if (step.type === 'keydown') {
          const options = {
            key: step.key,
            code: step.code || step.key,
            bubbles: true,
            cancelable: true
          };
          element.dispatchEvent(new KeyboardEvent('keydown', options));
          element.dispatchEvent(new KeyboardEvent('keyup', options));
          await this.sleep(100);
        }
      }
    }

    handleClick(event) {
      if (!this.isRecording) {
        return;
      }

      const target = event.target?.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"], summary, label') || event.target;
      if (!target || this.isInjectedUi(target)) {
        return;
      }

      this.emitStep({
        type: 'click',
        selector: this.buildSelector(target),
        text: this.getShortText(target)
      });
    }

    handleContextMenu(event) {
      if (!this.isRecording) {
        return;
      }

      const target = event.target;
      if (!target || this.isInjectedUi(target)) {
        return;
      }

      this.emitStep({
        type: 'contextmenu',
        selector: this.buildSelector(target),
        text: this.getShortText(target)
      });
    }

    handleChange(event) {
      if (!this.isRecording) {
        return;
      }

      const target = event.target;
      if (!target || this.isInjectedUi(target)) {
        return;
      }

      const selector = this.buildSelector(target);
      if (target.tagName === 'SELECT') {
        this.emitStep({
          type: 'select',
          selector,
          value: target.value
        });
        return;
      }

      if (target.matches('input[type="file"]')) {
        const description = this.describeElement(target) || '选择上传文件';
        this.emitStep({
          type: 'manual_action',
          selector,
          actionKind: 'file_upload',
          promptLabel: description,
          instructions: `请在页面中完成文件选择: ${description}`,
          accept: target.accept || '',
          multiple: target.multiple === true
        });
        return;
      }

      if (target.matches('input, textarea, [contenteditable="true"]')) {
        const inputType = String(target.type || '').toLowerCase();
        const promptMode = this.getRuntimePromptMode(target, inputType);
        if (promptMode) {
          this.emitStep({
            type: 'prompt_input',
            selector,
            promptMode,
            promptLabel: this.describeElement(target) || '运行时输入',
            secret: promptMode === 'password',
            required: true
          });
          return;
        }

        this.emitStep({
          type: 'input',
          selector,
          value: target.isContentEditable ? target.textContent || '' : target.value || ''
        });
      }
    }

    handleKeydown(event) {
      if (!this.isRecording || this.isInjectedUi(event.target)) {
        return;
      }

      const ignoreTextTyping = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (ignoreTextTyping) {
        return;
      }

      this.emitStep({
        type: 'keydown',
        selector: this.buildSelector(event.target),
        key: event.key,
        code: event.code
      });
    }

    handleScroll() {
      if (!this.isRecording) {
        return;
      }

      if (this.scrollTimer) {
        clearTimeout(this.scrollTimer);
      }

      this.scrollTimer = setTimeout(() => {
        this.emitStep({
          type: 'scroll',
          x: window.scrollX,
          y: window.scrollY
        });
      }, 250);
    }

    handleNavigationSignal() {
      if (!this.isRecording) {
        return;
      }

      setTimeout(() => {
        this.emitNavigationIfChanged();
      }, 0);
    }

    startNavigationObserver() {
      this.stopNavigationObserver();
      this.navigationTimer = setInterval(() => {
        this.emitNavigationIfChanged();
      }, 400);
    }

    stopNavigationObserver() {
      if (this.navigationTimer) {
        clearInterval(this.navigationTimer);
        this.navigationTimer = null;
      }
    }

    emitNavigationIfChanged() {
      if (!this.isRecording) {
        return;
      }

      const nextUrl = window.location.href;
      const nextTitle = document.title;
      if (nextUrl === this.lastKnownUrl && nextTitle === this.lastKnownTitle) {
        return;
      }

      this.lastKnownUrl = nextUrl;
      this.lastKnownTitle = nextTitle;
      this.emitStep({
        type: 'navigate',
        url: nextUrl,
        title: nextTitle
      });
    }

    emitStep(step) {
      browser.runtime.sendMessage({
        action: 'recorder.event',
        step: {
          ...step,
          url: window.location.href,
          title: document.title,
          timestamp: Date.now()
        }
      }).catch(() => {});
    }

    isInjectedUi(target) {
      return Boolean(target?.closest?.('#infinpilot-panel-container'));
    }

    getShortText(target) {
      const text = (target?.innerText || target?.textContent || '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 80);
    }

    getRuntimePromptMode(target, inputType) {
      if (inputType === 'password') {
        return 'password';
      }
      const autocomplete = String(target.getAttribute?.('autocomplete') || '').toLowerCase();
      if (autocomplete.includes('one-time-code') || autocomplete.includes('otp')) {
        return 'otp';
      }
      return '';
    }

    describeElement(element) {
      const labelText = element.labels?.[0]?.innerText || element.labels?.[0]?.textContent || '';
      const placeholder = element.getAttribute?.('placeholder') || '';
      const ariaLabel = element.getAttribute?.('aria-label') || '';
      const name = element.getAttribute?.('name') || '';
      const text = [labelText, placeholder, ariaLabel, name].find((value) => String(value || '').trim());
      return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    buildSelector(element) {
      if (!element || element === document.body) {
        return 'body';
      }

      const preferredAttributes = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label'];
      for (const attribute of preferredAttributes) {
        const value = element.getAttribute?.(attribute);
        if (value) {
          return `${element.tagName.toLowerCase()}[${attribute}="${this.escapeSelectorValue(value)}"]`;
        }
      }

      if (element.id) {
        return `#${this.escapeCssIdentifier(element.id)}`;
      }

      const path = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        const className = (current.className || '')
          .split(/\s+/)
          .filter(Boolean)
          .find((value) => /^[a-zA-Z][\w-]{1,30}$/.test(value));
        if (className) {
          selector += `.${this.escapeCssIdentifier(className)}`;
        }

        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
          : [];
        if (siblings.length > 1) {
          selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }

        path.unshift(selector);
        const candidate = path.join(' > ');
        try {
          if (document.querySelectorAll(candidate).length === 1) {
            return candidate;
          }
        } catch (_) {}

        current = current.parentElement;
      }

      return path.join(' > ');
    }

    escapeSelectorValue(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    escapeCssIdentifier(value) {
      return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    }

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  const recorder = new ContentRecorder();
  recorder.init();
  window.InfinPilotContentRecorder = recorder;
})();
