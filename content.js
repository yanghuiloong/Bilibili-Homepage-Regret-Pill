// ============================================================================
// Bilibili Regret Pill V2.1 - Back to Stability
// Based strictly on User's V2.0.0 Original Code
// Fixes: 
// 1. "First Click" latency (Force Capture)
// 2. "Ghost Container" after multiple refreshes (Live Container Finding)
// ============================================================================

(function() {
  'use strict';

  // ========== Configuration ==========
  const CONFIG = {
    INIT_RETRY_DELAY: 300,
    MAX_INIT_ATTEMPTS: 20,
    DEBOUNCE_TIME: 400,
    MIN_VIDEOS: 4,     
    DEBUG: false
  };

  // ========== State Management ==========
  const STATE = {
    snapshotOld: null,
    snapshotNew: null,
    isViewingOld: false,
    
    isInternalNav: false,
    container: null,
    refreshBtn: null,
    observer: null,
    uiContainerId: 'regret-pill-ui-group',
    debounceTimer: null,
    isListenerBound: false,
    isInitialized: false,
    initAttempts: 0,
    
    cachedBtnSelector: null,
    cachedContainerSelector: null
  };

  // ========== Logger ==========
  const Logger = {
    log: (...args) => {
      if (CONFIG.DEBUG) console.log('[Regret Pill]', ...args);
    }
  };

  // ========== DOM Utils (V2.0.0 Original - Proven Stability) ==========
  const DomUtils = {
    isValidElement(el) {
      return el && el.isConnected;
    },

    findRefreshButton() {
      if (STATE.cachedBtnSelector) {
        const el = document.querySelector(STATE.cachedBtnSelector);
        if (this.isValidElement(el)) return el;
        STATE.cachedBtnSelector = null;
      }

      const selectors = ['.roll-btn', '.feed-roll-btn', 'button.primary-btn.roll-btn', '.bili-header__banner .roll-btn'];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (this.isValidElement(el)) { STATE.cachedBtnSelector = s; return el; }
      }

      const candidates = document.querySelectorAll('button, div[role="button"], span[role="button"]');
      for (const el of candidates) {
        if (el.innerText && el.innerText.trim() === '换一换') return el;
      }
      return null;
    },

    findSafeGridContainer() {
      if (STATE.cachedContainerSelector) {
        const el = document.querySelector(STATE.cachedContainerSelector);
        if (this.isValidElement(el) && el.querySelectorAll('a[href*="/video/BV"]').length >= CONFIG.MIN_VIDEOS) {
          return el;
        }
        STATE.cachedContainerSelector = null;
      }

      const btn = STATE.refreshBtn || this.findRefreshButton();
      const selectors = ['.feed-card', '.bili-video-card__wrap', '.bili-grid', '.recommended-container_floor-aside .container', '.recommended-container .container'];
      
      let videoCards = [];
      for (const sel of selectors) {
        const cards = document.querySelectorAll(sel);
        if (cards.length >= CONFIG.MIN_VIDEOS) {
          videoCards = Array.from(cards);
          break; 
        }
      }
      
      if (videoCards.length === 0) {
        const links = document.querySelectorAll('a[href*="/video/BV"]');
        if (links.length >= CONFIG.MIN_VIDEOS) videoCards = Array.from(links);
      }

      if (videoCards.length === 0) return null;

      let ancestor = videoCards[0].parentElement;
      while (ancestor && ancestor !== document.body) {
        const containedCards = ancestor.querySelectorAll('a[href*="/video/BV"]').length;
        if (containedCards < CONFIG.MIN_VIDEOS) {
          ancestor = ancestor.parentElement;
          continue;
        }

        if (btn && ancestor.contains(btn)) {
          if (ancestor.id) STATE.cachedContainerSelector = `#${ancestor.id}`;
          else if (ancestor.className) STATE.cachedContainerSelector = `.${ancestor.className.split(' ')[0]}`;
          return ancestor;
        }
        
        const style = window.getComputedStyle(ancestor);
        if (style.display === 'grid' || style.display === 'flex') return ancestor;

        ancestor = ancestor.parentElement;
      }
      return null;
    }
  };

  // ========== Snapshot Service (V2.0.0 Original) ==========
  const SnapshotService = {
    isVideoNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.querySelector('a[href*="/video/BV"]')) return true;
      const className = node.className || '';
      return className.includes('card') || className.includes('video');
    },
    isSentinelNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.querySelector('a[href*="/video/BV"]')) return false;
      const html = (node.outerHTML || '').toLowerCase();
      if (html.includes('skeleton') || html.includes('loading') || html.includes('sentinel')) return true;
      if (node.innerText.trim() === '' && node.offsetHeight <= 8) return true;
      return false;
    },
    capture(container) {
      if (!container) return null;
      const fragment = document.createDocumentFragment();
      const children = Array.from(container.children);

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.id === STATE.uiContainerId) continue;
        if (STATE.refreshBtn && (child.contains(STATE.refreshBtn) || child === STATE.refreshBtn)) continue;

        if (this.isVideoNode(child) && !this.isSentinelNode(child)) {
          const clone = child.cloneNode(true);
          this.fixImages(clone);
          fragment.appendChild(clone);
        }
      }
      return fragment.childElementCount > 0 ? fragment : null;
    },
    fixImages(node) {
      const images = node.tagName === 'IMG' ? [node] : [];
      images.push(...node.querySelectorAll('img'));
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.getAttribute('data-src') || img.getAttribute('data-original-src') || img.src;
        if (src && !src.startsWith('data:')) {
          img.src = src;
          img.removeAttribute('srcset'); img.removeAttribute('loading');
          img.style.cssText += 'opacity:1;display:block;';
        }
      }
      const bgElements = node.querySelectorAll('[data-background]');
      for (let i = 0; i < bgElements.length; i++) {
        bgElements[i].style.backgroundImage = `url(${bgElements[i].getAttribute('data-background')})`;
      }
    },
    isDifferent(fragA, fragB) {
      if (!fragA || !fragB) return true;
      if (fragA.childElementCount !== fragB.childElementCount) return true;
      const linkA = fragA.querySelector('a[href*="/video/BV"]');
      const linkB = fragB.querySelector('a[href*="/video/BV"]');
      return linkA?.href !== linkB?.href;
    },
    restore(container, snapshotFragment, isUndo) {
      if (!container || !snapshotFragment) return;
      const nodesToKeep = new Set();
      const children = Array.from(container.children);
      
      if (STATE.refreshBtn && container.contains(STATE.refreshBtn)) {
        let curr = STATE.refreshBtn;
        while (curr && curr.parentElement !== container) curr = curr.parentElement;
        nodesToKeep.add(curr);
      }
      
      const uiGroup = document.getElementById(STATE.uiContainerId);
      if (uiGroup && container.contains(uiGroup)) {
        let curr = uiGroup;
        while (curr && curr.parentElement !== container) curr = curr.parentElement;
        nodesToKeep.add(curr);
      }

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!this.isVideoNode(child) || this.isSentinelNode(child)) nodesToKeep.add(child);
      }

      const toRemove = children.filter(c => !nodesToKeep.has(c));
      const cloneFragment = snapshotFragment.cloneNode(true);
      toRemove.forEach(el => el.remove());
      
      const referenceNode = children.find(c => nodesToKeep.has(c)) || null;
      if (referenceNode) container.insertBefore(cloneFragment, referenceNode);
      else container.appendChild(cloneFragment);

      STATE.isViewingOld = isUndo;
      if (STATE.refreshBtn && !STATE.refreshBtn.isConnected) STATE.refreshBtn = DomUtils.findRefreshButton();
      Core.bindNativeListener();
    }
  };

  // ========== UI Service ==========
  const UIService = {
    createButtonGroup() {
      const group = document.createElement('div');
      group.id = STATE.uiContainerId;
      group.className = 'regret-pill-group';
      group.innerHTML = `
        <button class="regret-pill-btn" id="regret-pill-undo" title="后退">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14L4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>
        </button>
        <div class="regret-pill-divider"></div>
        <button class="regret-pill-btn" id="regret-pill-redo" title="前进">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 14l5-5-5-5"></path><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"></path></svg>
        </button>
      `;
      group.querySelector('#regret-pill-undo').onclick = Core.handleUndo;
      group.querySelector('#regret-pill-redo').onclick = Core.handleRedo;
      return group;
    },
    update() {
      const undoBtn = document.getElementById('regret-pill-undo');
      const redoBtn = document.getElementById('regret-pill-redo');
      if (undoBtn) undoBtn.disabled = !STATE.snapshotOld || STATE.isViewingOld;
      if (redoBtn) redoBtn.disabled = !STATE.snapshotNew || !STATE.isViewingOld;
    },
    showToast(msg) {
      let toast = document.getElementById('regret-pill-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'regret-pill-toast';
        toast.className = 'regret-pill-toast';
        document.body.appendChild(toast);
      }
      toast.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ccdfa" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>${msg}</span>`;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  };

  // ========== Core Logic (修复重点) ==========
  const Core = {
    _boundClickHandler: null,

    // [Fix 1] 修复 "点击后无反应/延迟生效"
    handleNativeClick(e) {
      if (STATE.isInternalNav) return;
      
      // 每次点击时，强制重新寻找最新的容器！
      // (这是解决 "多次点击后失效" 的关键，因为容器可能已经被 B 站偷换了)
      const liveContainer = DomUtils.findSafeGridContainer();
      if (!liveContainer) {
        Logger.log('Warning: Container lost on click');
        return;
      }
      STATE.container = liveContainer;

      Logger.log('Active Capture: Native Refresh Clicked');

      // 尝试抓取当前页面作为 "旧快照"
      let currentContent = SnapshotService.capture(liveContainer);

      // [Hotfix] 如果抓取到的是空的（比如点太快了，页面还没加载完），
      // 尝试使用 Observer 之前缓存好的 snapshotNew 作为替补
      if ((!currentContent || currentContent.childElementCount < CONFIG.MIN_VIDEOS) && STATE.snapshotNew) {
        Logger.log('Live capture empty, using cached snapshotNew');
        currentContent = STATE.snapshotNew;
      }

      // 只有当内容有效时，才保存为 "Old"
      if (currentContent && currentContent.childElementCount >= CONFIG.MIN_VIDEOS) {
        STATE.snapshotOld = currentContent;
        Logger.log('Snapshot Old captured:', currentContent.childElementCount, 'items');
        
        // 立即刷新按钮状态，修复 "灰色不可点"
        setTimeout(() => UIService.update(), 0);
      }
    },

    bindNativeListener() {
      if (!STATE.refreshBtn) return;
      if (this._boundClickHandler) STATE.refreshBtn.removeEventListener('click', this._boundClickHandler, true);
      
      this._boundClickHandler = this.handleNativeClick.bind(this);
      STATE.refreshBtn.addEventListener('click', this._boundClickHandler, true);
      STATE.isListenerBound = true;
    },

    observerCallback(mutations) {
      if (STATE.isInternalNav) return;

      let significant = false;
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          significant = true; break;
        }
      }
      if (!significant) return;

      if (STATE.debounceTimer) clearTimeout(STATE.debounceTimer);
      STATE.debounceTimer = setTimeout(() => {
        if (STATE.isInternalNav) return;
        
        // Observer 触发时，也重新确认容器
        const liveContainer = DomUtils.findSafeGridContainer();
        if (!liveContainer) return;
        STATE.container = liveContainer;

        const currentFragment = SnapshotService.capture(liveContainer);
        // 只有内容变了，才更新 New（代表新加载出来的页面）
        if (currentFragment && SnapshotService.isDifferent(currentFragment, STATE.snapshotNew)) {
          STATE.snapshotNew = currentFragment;
          STATE.isViewingOld = false;
          UIService.update();
        }
      }, CONFIG.DEBOUNCE_TIME);
    },

    // [Fix 2] 修复 "返回的不是上一个页面"
    handleUndo(e) {
      e.preventDefault(); e.stopPropagation();
      if (!STATE.snapshotOld || STATE.isViewingOld) return;

      // 在执行 Undo 前，必须找到活着的容器！
      const liveContainer = DomUtils.findSafeGridContainer();
      if (!liveContainer) {
        UIService.showToast('无法定位内容区域');
        return;
      }
      STATE.container = liveContainer;

      Logger.log('Action: Undo');
      STATE.isInternalNav = true;
      SnapshotService.restore(liveContainer, STATE.snapshotOld, true);
      UIService.showToast('已返回旧页面');
      UIService.update();
      setTimeout(() => { STATE.isInternalNav = false; }, 100);
    },

    handleRedo(e) {
      e.preventDefault(); e.stopPropagation();
      if (!STATE.snapshotNew || !STATE.isViewingOld) return;

      const liveContainer = DomUtils.findSafeGridContainer();
      if (!liveContainer) return;
      STATE.container = liveContainer;

      Logger.log('Action: Redo');
      STATE.isInternalNav = true;
      SnapshotService.restore(liveContainer, STATE.snapshotNew, false);
      UIService.showToast('已返回最新页面');
      UIService.update();
      setTimeout(() => { STATE.isInternalNav = false; }, 100);
    },

    initObserver() {
      if (STATE.observer) STATE.observer.disconnect();
      if (!STATE.container) return;
      STATE.observer = new MutationObserver(this.observerCallback.bind(this));
      STATE.observer.observe(STATE.container, { childList: true, subtree: true });
    }
  };

  // ========== Initialization (V2.0.0 Original Logic) ==========
  function runDiscovery() {
    STATE.initAttempts++;
    
    // 1. Find Button
    if (!DomUtils.isValidElement(STATE.refreshBtn)) {
      STATE.refreshBtn = DomUtils.findRefreshButton();
      if (STATE.refreshBtn) {
        Logger.log('Button Found:', STATE.refreshBtn);
        Core.bindNativeListener();
      }
    } else if (!STATE.isListenerBound) {
      Core.bindNativeListener();
    }

    // 2. Find Container
    if (!DomUtils.isValidElement(STATE.container)) {
      const newContainer = DomUtils.findSafeGridContainer();
      if (newContainer) {
        STATE.container = newContainer;
        Logger.log('Container Found:', newContainer);
        if (!STATE.snapshotNew) {
          STATE.snapshotNew = SnapshotService.capture(newContainer);
        }
        Core.initObserver();
      }
    }

    // 3. Inject UI
    if (DomUtils.isValidElement(STATE.refreshBtn)) {
      const existingUI = document.getElementById(STATE.uiContainerId);
      if (!DomUtils.isValidElement(existingUI)) {
        const group = UIService.createButtonGroup();
        if (STATE.refreshBtn.parentElement) {
          const parentStyle = window.getComputedStyle(STATE.refreshBtn.parentElement);
          if (parentStyle.position === 'static') STATE.refreshBtn.parentElement.style.position = 'relative';
          STATE.refreshBtn.parentElement.insertBefore(group, STATE.refreshBtn.nextSibling);
          UIService.update();
        }
      }
    }

    const isComplete = STATE.refreshBtn && STATE.container && STATE.isListenerBound;
    if (isComplete && !STATE.isInitialized) {
      STATE.isInitialized = true;
      if (STATE.bodyObserver) {
        STATE.bodyObserver.disconnect();
        STATE.bodyObserver = null;
      }
    }
    return isComplete;
  }

  function init() {
    if (runDiscovery()) return;
    const retryInit = () => {
      if (STATE.isInitialized) return;
      if (STATE.initAttempts >= CONFIG.MAX_INIT_ATTEMPTS) return;
      if (!runDiscovery()) setTimeout(retryInit, CONFIG.INIT_RETRY_DELAY);
    };
    setTimeout(retryInit, CONFIG.INIT_RETRY_DELAY);
    STATE.bodyObserver = new MutationObserver(() => {
      if (!STATE.isInitialized) runDiscovery();
    });
    STATE.bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }

})();