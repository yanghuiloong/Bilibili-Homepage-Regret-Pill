// ============================================================================
// Bilibili Regret Pill V1.6.2 - Content Script (Optimized)
// Logic: Active Capture Strategy (Event-Driven + Smart Observer)
// Optimization: RAF Throttling, Selector Caching, Batch DOM, First-Load Fix
// ============================================================================

(function() {
  'use strict';

  // ========== Configuration ==========
  const CONFIG = {
    INIT_RETRY_DELAY: 300,     // Retry delay for initial discovery
    MAX_INIT_ATTEMPTS: 20,     // Maximum init attempts (6 seconds total)
    DEBOUNCE_TIME: 400,        // Debounce for observer callback
    MIN_VIDEOS: 4,
    DEBUG: false               // Set to false in production
  };

  // ========== State Management ==========
  const STATE = {
    snapshotOld: null,    // Stores DocumentFragment (Before Refresh)
    snapshotNew: null,    // Stores DocumentFragment (After Refresh)
    isViewingOld: false,
    
    // Internal flags
    isInternalNav: false,
    container: null,
    refreshBtn: null,
    observer: null,
    bodyObserver: null,
    uiContainerId: 'regret-pill-ui-group',
    debounceTimer: null,
    rafId: null,
    isListenerBound: false,
    isInitialized: false,
    initAttempts: 0,
    
    // Selector cache
    cachedBtnSelector: null,
    cachedContainerSelector: null
  };

  // ========== Logger ==========
  const Logger = {
    log: (...args) => {
      if (CONFIG.DEBUG) console.log('[Regret Pill V1.6.2]', ...args);
    }
  };

  // ========== DOM Utils ==========
  const DomUtils = {
    isValidElement(el) {
      return el && el.isConnected;
    },

    findRefreshButton() {
      // Try cached selector first
      if (STATE.cachedBtnSelector) {
        const el = document.querySelector(STATE.cachedBtnSelector);
        if (this.isValidElement(el)) return el;
        STATE.cachedBtnSelector = null; // Cache invalid, reset
      }

      const selectors = [
        '.roll-btn', 
        '.feed-roll-btn', 
        'button.primary-btn.roll-btn',
        '.bili-header__banner .roll-btn'
      ];
      
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (this.isValidElement(el)) {
          STATE.cachedBtnSelector = s; // Cache successful selector
          return el;
        }
      }

      // Fallback: Text content search
      const candidates = document.querySelectorAll('button, div[role="button"], span[role="button"]');
      for (const el of candidates) {
        if (el.innerText && el.innerText.trim() === '换一换') {
          return el;
        }
      }
      return null;
    },

    findSafeGridContainer() {
      // Try cached selector first
      if (STATE.cachedContainerSelector) {
        const el = document.querySelector(STATE.cachedContainerSelector);
        if (this.isValidElement(el) && el.querySelectorAll('a[href*="/video/BV"]').length >= CONFIG.MIN_VIDEOS) {
          return el;
        }
        STATE.cachedContainerSelector = null; // Cache invalid, reset
      }

      const btn = STATE.refreshBtn || this.findRefreshButton();
      const selectors = [
        '.feed-card', 
        '.bili-video-card__wrap', 
        '.bili-grid',
        '.recommended-container_floor-aside .container',
        '.recommended-container .container'
      ];
      
      let videoCards = [];
      let successfulSelector = null;
      
      for (const sel of selectors) {
        const cards = document.querySelectorAll(sel);
        if (cards.length >= CONFIG.MIN_VIDEOS) {
          videoCards = Array.from(cards);
          successfulSelector = sel;
          break; 
        }
      }
      
      // Fallback: Link patterns
      if (videoCards.length === 0) {
        const links = document.querySelectorAll('a[href*="/video/BV"]');
        if (links.length >= CONFIG.MIN_VIDEOS) {
          videoCards = Array.from(links);
        }
      }

      if (videoCards.length === 0) return null;

      // Find common ancestor
      let ancestor = videoCards[0].parentElement;
      while (ancestor && ancestor !== document.body) {
        const containedCards = ancestor.querySelectorAll('a[href*="/video/BV"]').length;
        if (containedCards < CONFIG.MIN_VIDEOS) {
          ancestor = ancestor.parentElement;
          continue;
        }

        if (btn && ancestor.contains(btn)) {
          // Cache the ancestor's unique selector if possible
          if (ancestor.id) {
            STATE.cachedContainerSelector = `#${ancestor.id}`;
          } else if (ancestor.className) {
            const firstClass = ancestor.className.split(' ')[0];
            if (firstClass) STATE.cachedContainerSelector = `.${firstClass}`;
          }
          return ancestor;
        }
        
        const style = window.getComputedStyle(ancestor);
        if (style.display === 'grid' || style.display === 'flex') {
          return ancestor;
        }

        ancestor = ancestor.parentElement;
      }
      return null;
    }
  };

  // ========== Snapshot Service (Optimized) ==========
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
      const className = String(node.className || '').toLowerCase();
      const id = String(node.id || '').toLowerCase();
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const ariaBusy = String(node.getAttribute('aria-busy') || '').toLowerCase();
      const dataKeys = Array.from(node.attributes || []).map(attr => attr.name.toLowerCase());
      const classHit = /(skeleton|placeholder|loading|infinite|scroll|sentinel|observer|load-more|lazy|pager|foot|bottom)/.test(className);
      const idHit = /(skeleton|placeholder|loading|infinite|scroll|sentinel|observer|load-more|lazy|pager|foot|bottom)/.test(id);
      const roleHit = role === 'status' || role === 'progressbar';
      const ariaHit = ariaBusy === 'true';
      const dataHit = dataKeys.some(key => /(observe|observer|infinite|load|scroll|sentinel|lazy|skeleton)/.test(key));
      const emptyHit = node.children.length === 0 && node.textContent.trim() === '' && (node.offsetHeight <= 8 || node.offsetWidth <= 8);
      return classHit || idHit || roleHit || ariaHit || dataHit || emptyHit;
    },
    /**
     * Captures valid content as a DocumentFragment.
     * Optimization: Batch processing, minimal DOM queries.
     */
    capture(container) {
      if (!container) return null;
      
      const fragment = document.createDocumentFragment();
      const children = Array.from(container.children);

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        
        // Skip our own UI or the refresh button
        if (child.id === STATE.uiContainerId) continue;
        if (STATE.refreshBtn && (child.contains(STATE.refreshBtn) || child === STATE.refreshBtn)) continue;

        // Heuristic: Is it a video card or grid item?
        const isVideo = this.isVideoNode(child) && !this.isSentinelNode(child);
        
        if (isVideo) {
          const clone = child.cloneNode(true);
          this.fixImages(clone);
          fragment.appendChild(clone);
        }
      }

      return fragment.childElementCount > 0 ? fragment : null;
    },

    /**
     * Fix lazy-loaded images in the cloned node.
     * Optimization: Single pass for all images.
     */
    fixImages(node) {
      const images = node.tagName === 'IMG' ? [node] : [];
      images.push(...node.querySelectorAll('img'));
      
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = img.getAttribute('data-src') || 
                    img.getAttribute('data-original-src') || 
                    img.src;
        if (src && !src.startsWith('data:')) {
          img.src = src;
          img.removeAttribute('srcset');
          img.removeAttribute('loading');
          img.style.cssText += 'opacity:1;display:block;';
        }
      }
      
      // Fix backgrounds
      const bgElements = node.querySelectorAll('[data-background]');
      for (let i = 0; i < bgElements.length; i++) {
        const el = bgElements[i];
        el.style.backgroundImage = `url(${el.getAttribute('data-background')})`;
      }
    },

    /**
     * Compares two fragments roughly to detect changes.
     */
    isDifferent(fragA, fragB) {
      if (!fragA || !fragB) return true;
      if (fragA.childElementCount !== fragB.childElementCount) return true;
      
      const linkA = fragA.querySelector('a[href*="/video/BV"]');
      const linkB = fragB.querySelector('a[href*="/video/BV"]');
      return linkA?.href !== linkB?.href;
    },

    /**
     * Restores the container state from a fragment.
     * Optimization: Batch DOM operations to minimize reflows.
     */
    restore(container, snapshotFragment, isUndo) {
      if (!container || !snapshotFragment) return;

      // 1. Identify nodes to keep (Buttons/UI)
      const nodesToKeep = new Set();
      const children = Array.from(container.children);
      
      // Keep internal refresh button
      if (STATE.refreshBtn && container.contains(STATE.refreshBtn)) {
        let curr = STATE.refreshBtn;
        while (curr && curr.parentElement !== container) curr = curr.parentElement;
        if (curr) nodesToKeep.add(curr);
      }
      
      // Keep UI Group
      const uiGroup = document.getElementById(STATE.uiContainerId);
      if (uiGroup && container.contains(uiGroup)) {
        let curr = uiGroup;
        while (curr && curr.parentElement !== container) curr = curr.parentElement;
        if (curr) nodesToKeep.add(curr);
      }

      // 2. Batch remove: Move to temp fragment (single reflow)
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!this.isVideoNode(child) || this.isSentinelNode(child)) nodesToKeep.add(child);
      }

      const toRemove = children.filter(c => !nodesToKeep.has(c));
      const tempFragment = document.createDocumentFragment();
      for (let i = 0; i < toRemove.length; i++) {
        tempFragment.appendChild(toRemove[i]);
      }

      // 3. Insert Snapshot Nodes (clone to preserve original)
      const cloneFragment = snapshotFragment.cloneNode(true);
      const referenceNode = children.find(c => nodesToKeep.has(c)) || null;
      
      if (referenceNode) {
        container.insertBefore(cloneFragment, referenceNode);
      } else {
        container.appendChild(cloneFragment);
      }

      // 4. Update State
      STATE.isViewingOld = isUndo;

      // 5. Re-bind Listener (Defensive)
      if (STATE.refreshBtn && !STATE.refreshBtn.isConnected) {
        STATE.refreshBtn = DomUtils.findRefreshButton();
      }
      Core.bindNativeListener();

      Logger.log(`Restore Complete: ${isUndo ? 'Undo' : 'Redo'}`);
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 14L4 9l5-5"></path>
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"></path>
          </svg>
        </button>
        <div class="regret-pill-divider"></div>
        <button class="regret-pill-btn" id="regret-pill-redo" title="前进">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 14l5-5-5-5"></path>
            <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"></path>
          </svg>
        </button>
      `;

      group.querySelector('#regret-pill-undo').onclick = Core.handleUndo;
      group.querySelector('#regret-pill-redo').onclick = Core.handleRedo;

      return group;
    },

    update() {
      const undoBtn = document.getElementById('regret-pill-undo');
      const redoBtn = document.getElementById('regret-pill-redo');
      
      if (undoBtn) {
        const canUndo = STATE.snapshotOld && !STATE.isViewingOld;
        undoBtn.disabled = !canUndo;
      }
      
      if (redoBtn) {
        const canRedo = STATE.snapshotNew && STATE.isViewingOld;
        redoBtn.disabled = !canRedo;
      }
    },

    showToast(msg) {
      let toast = document.getElementById('regret-pill-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'regret-pill-toast';
        toast.className = 'regret-pill-toast';
        document.body.appendChild(toast);
      }
      // Replaced Info icon with a clean Checkmark icon for better visual feedback
      toast.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ccdfa" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>${msg}</span>
      `;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  };

  // ========== Core Logic ==========
  const Core = {
    _boundClickHandler: null,

    handleNativeClick(e) {
      if (STATE.isInternalNav) return;
      
      // Ensure container is available
      if (!STATE.container) {
        STATE.container = DomUtils.findSafeGridContainer();
      }
      
      if (!STATE.container) {
        Logger.log('Warning: Container not found on click');
        return;
      }

      Logger.log('Active Capture: Native Refresh Clicked');

      // Capture OLD state before it changes
      const captured = SnapshotService.capture(STATE.container);
      if (captured && captured.childElementCount > 0) {
        STATE.snapshotOld = captured;
        Logger.log('Snapshot Old captured:', captured.childElementCount, 'items');
      }
    },

    bindNativeListener() {
      if (!STATE.refreshBtn) return;
      
      // Remove old listener to prevent duplicates
      if (this._boundClickHandler) {
        STATE.refreshBtn.removeEventListener('click', this._boundClickHandler, true);
      }
      
      // Create bound handler
      this._boundClickHandler = this.handleNativeClick.bind(this);
      
      STATE.refreshBtn.addEventListener('click', this._boundClickHandler, true);
      STATE.isListenerBound = true;
      Logger.log('Native listener bound');
    },

    /**
     * Observer callback with RAF throttling
     */
    observerCallback(mutations) {
      if (STATE.isInternalNav) return;

      // Check for significant changes
      let significant = false;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          significant = true;
          break;
        }
      }

      if (!significant) return;

      // RAF throttling: Skip if already scheduled
      if (STATE.rafId) return;
      
      STATE.rafId = requestAnimationFrame(() => {
        STATE.rafId = null;
        
        // Debounce for content stabilization
        if (STATE.debounceTimer) clearTimeout(STATE.debounceTimer);
        
        STATE.debounceTimer = setTimeout(() => {
          if (STATE.isInternalNav || !STATE.container) return;
          
          const currentFragment = SnapshotService.capture(STATE.container);
          
          // Only update if actually different
          if (!currentFragment || !SnapshotService.isDifferent(currentFragment, STATE.snapshotNew)) return;

          Logger.log('Observer: Content Stable -> Capturing snapshotNew');
          STATE.snapshotNew = currentFragment;
          STATE.isViewingOld = false;
          UIService.update();
        }, CONFIG.DEBOUNCE_TIME);
      });
    },

    handleUndo(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!STATE.snapshotOld || STATE.isViewingOld) return;

      Logger.log('Action: Undo');
      STATE.isInternalNav = true;
      SnapshotService.restore(STATE.container, STATE.snapshotOld, true);
      UIService.showToast('已返回旧页面');
      UIService.update();
      setTimeout(() => { STATE.isInternalNav = false; }, 100);
    },

    handleRedo(e) {
      e.preventDefault();
      e.stopPropagation();
      if (!STATE.snapshotNew || !STATE.isViewingOld) return;

      Logger.log('Action: Redo');
      STATE.isInternalNav = true;
      SnapshotService.restore(STATE.container, STATE.snapshotNew, false);
      UIService.showToast('已返回最新页面');
      UIService.update();
      setTimeout(() => { STATE.isInternalNav = false; }, 100);
    },

    initObserver() {
      if (STATE.observer) STATE.observer.disconnect();
      if (!STATE.container) return;

      STATE.observer = new MutationObserver(this.observerCallback.bind(this));
      STATE.observer.observe(STATE.container, {
        childList: true,
        subtree: true
      });
      Logger.log('Container Observer Started');
    }
  };

  // ========== Initialization ==========
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
        
        // Capture initial state immediately
        if (!STATE.snapshotNew) {
          STATE.snapshotNew = SnapshotService.capture(newContainer);
          Logger.log('Initial snapshot captured');
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
          // Ensure parent allows absolute positioning
          const parentStyle = window.getComputedStyle(STATE.refreshBtn.parentElement);
          if (parentStyle.position === 'static') {
            STATE.refreshBtn.parentElement.style.position = 'relative';
          }
          STATE.refreshBtn.parentElement.insertBefore(group, STATE.refreshBtn.nextSibling);
          UIService.update();
        }
      }
    }

    // 4. Check if fully initialized
    const isComplete = STATE.refreshBtn && STATE.container && STATE.isListenerBound;
    
    if (isComplete && !STATE.isInitialized) {
      STATE.isInitialized = true;
      Logger.log('Initialization Complete!');
      
      // Stop body observer once initialized
      if (STATE.bodyObserver) {
        STATE.bodyObserver.disconnect();
        STATE.bodyObserver = null;
      }
    }
    
    return isComplete;
  }

  function init() {
    Logger.log('Regret Pill V1.6.2 Starting...');
    
    // Immediate first attempt
    if (runDiscovery()) {
      Logger.log('Initialized on first attempt');
      return;
    }
    
    // Smart retry mechanism for first load
    const retryInit = () => {
      if (STATE.isInitialized) return;
      if (STATE.initAttempts >= CONFIG.MAX_INIT_ATTEMPTS) {
        Logger.log('Max init attempts reached, falling back to observer only');
        return;
      }
      
      if (!runDiscovery()) {
        setTimeout(retryInit, CONFIG.INIT_RETRY_DELAY);
      }
    };
    
    // Start retry loop
    setTimeout(retryInit, CONFIG.INIT_RETRY_DELAY);
    
    // Body observer as backup for SPA navigation
    STATE.bodyObserver = new MutationObserver(() => {
      if (!STATE.isInitialized) {
        runDiscovery();
      }
    });
    STATE.bodyObserver.observe(document.body, { childList: true, subtree: true });

    Logger.log('Regret Pill V1.6.2 Initialized');
  }

  // Start - ensure DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already loaded, but B站 content might be async
    // Use setTimeout to yield to main thread
    setTimeout(init, 0);
  }

})();
