// ==UserScript==
// @name         1in8b Recorder
// @namespace    local.1in8b.recorder
// @version      1.6.0
// @description  Record settings, decisions, all options, focus picks, timeline, text snapshots and structured state on 1in8b.life, with per-life history viewer and deletion
// @match        https://1in8b.life/*
// @match        https://www.1in8b.life/*
// @grant        none
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__rec1in8bLoaded) return;
  window.__rec1in8bLoaded = true;

  const VERSION = 2;
  const DB_NAME = 'rec1in8b';
  const DB_VERSION = 2;
  const STORE_STATE = 'state';
  const STORE_SNAP = 'snapshots';
  const STORE_TIME = 'timelines';
  const STORE_STATES = 'states';
  const STORE_COUNTRIES = 'countries';
  const PREF_KEY = 'one8b.prefs.v1';
  const LEGACY_KEY = 'rec.1in8b.v1';
  const META_KEY = 'rec.1in8b.meta';
  const SAVE_KEY_RE = /^one8b\.(?:[a-z]+(?:-[a-z]+)?\.)?save\.v\d+$/;
  const LIMITS = {
    stateVisibleMax: 12000,
    recentStates: 100,
    fallbackSnapBytes: 3 * 1024 * 1024,
    livesMax: 200,
    decisionsPerLife: 3000,
    focusPerLife: 3000,
    timelinePerLife: 1500,
    settingsEvents: 300,
    warnings: 60,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const nowISO = () => new Date().toISOString();
  const clone = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } };
  const byteLen = (s) => { try { return new TextEncoder().encode(String(s)).length; } catch (_) { return String(s).length * 2; } };
  const hashText = (s) => {
    let h = 2166136261 >>> 0;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  };
  const textOf = (el) => {
    if (!el) return '';
    let t = '';
    try { t = el.innerText || el.textContent || ''; } catch (_) { t = el.textContent || ''; }
    return String(t).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);
  const selectedText = (el) => {
    if (!el || !el.options) return '';
    const o = el.options[el.selectedIndex];
    return o ? String(o.textContent || o.text || '').trim() : '';
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sumDone = (done) => {
    if (!done || typeof done !== 'object') return 0;
    let n = 0;
    for (const k of Object.keys(done)) { const v = +done[k]; if (Number.isFinite(v)) n += v; }
    return n;
  };
  const diffDone = (cur, base) => {
    const out = {};
    cur = cur && typeof cur === 'object' ? cur : {};
    base = base && typeof base === 'object' ? base : {};
    for (const k of Object.keys(cur)) {
      const d = (+cur[k] || 0) - (+base[k] || 0);
      if (d > 0) out[k] = d;
    }
    return out;
  };
  const asNum = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  const nameOf = (n) => {
    if (typeof n === 'string') return n;
    if (!n || typeof n !== 'object') return '';
    return String(n.full || [n.first, n.last].filter(Boolean).join(' ') || n.g || n.ko || n.en || '');
  };
  const truncateText = (s, max) => {
    const t = String(s == null ? '' : s);
    return t.length > max ? t.slice(0, max) : t;
  };
  const pickText = (selectors) => {
    for (const sel of selectors) {
      const el = $(sel);
      const t = textOf(el);
      if (t) return t;
    }
    return '';
  };
  const stripHistory = (S) => {
    const o = clone(S);
    if (!o || typeof o !== 'object') return null;
    for (const k of ['log', 'years', 'journal', 'queue', 'pending', 'recent', 'done']) delete o[k];
    if (o.flags && typeof o.flags === 'object') {
      delete o.flags.way;
      delete o.flags.tl;
    }
    return o;
  };

  let state = null;
  let dbPromise = null;
  let dbFailed = false;
  let saveTimer = 0;
  let saveChain = Promise.resolve();
  let persisting = false;
  let timelineChain = Promise.resolve();
  let stateChain = Promise.resolve();
  let uiTimer = 0;
  const pendingWarnings = [];

  const live = {
    lifeId: null,
    currentDecision: null,
    finalizeTimer: 0,
    lastAge: null,
    lastFocus: null,
    lastFocusClickAt: 0,
    lastSettingsHash: '',
    lastSnapHash: {},
    sheetOpen: false,
    sheetTimer: 0,
    deadSeen: false,
    baselineDone: null,
    attributedIds: new Set(),
    pendingBirthText: '',
    announcedLifeId: null,
    hookInstalled: false,
    hookSeq: 0,
    lastHookSig: '',
    lastHookAt: 0,
    lastTrustedChoice: null,
    lastHookContext: null,
    lastModalOpenAt: 0,
    lastAutoCount: null,
    saveHookInstalled: false,
    lastSaveRaw: '',
    lastSaveKey: '',
    pendingSaveWrites: [],
    stateSeq: 0,
    lastState: null,
    recentStates: [],
    countryCache: Object.create(null),
    pendingAfter: [],
    initCaptureQueued: false,
    deletedCurrentId: null,
    warned: new Set(),
  };

  const ui = {
    host: null, shadow: null, fab: null, fabText: null, fabDot: null,
    panel: null, status: null, body: null, banner: null, toasts: null, busy: false,
    back: null, title: null, importFile: null,
    view: 'life', viewLifeId: null, tab: 'decisions', filter: 'all',
    limit: 50, timelineLimit: 100,
    timelineCache: Object.create(null), timelineLoading: Object.create(null),
    openDetails: new Set(), pendingScrollTop: null,
  };

  const saveCache = new Map();
  installSaveHook();

  function defaultState() {
    return {
      version: VERSION,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      site: location.origin,
      introText: '',
      settings: null,
      settingsCatalog: null,
      settingsEvents: [],
      hookCaptures: [],
      lives: {},
      diagnostics: {
        bundle: null,
        lastBundleHash: null,
        anchors: null,
        warnings: [],
        missedDecisions: 0,
        bannerDismissed: '',
        lastCheckAt: null,
      },
      snapshotsFallback: [],
      snapBytesTotal: 0,
      statesTotal: 0,
      stateBytesTotal: 0,
      countryCount: 0,
      lastStateAt: null,
      deletedLifeIds: [],
    };
  }

  function isLifeDeleted(lifeId) {
    return !!(state && Array.isArray(state.deletedLifeIds) && state.deletedLifeIds.indexOf(String(lifeId)) >= 0);
  }

  function inferSelectionMode(d) {
    if (!d) return 'unknown';
    if (d.selectionMode) return d.selectionMode;
    if (d.source === 'auto-hook' || d.source === 'auto-quiet') return 'auto-quiet';
    if (d.source === 'save-diff') return d.auto === false ? 'manual' : 'auto-quiet';
    if (d.source === 'backfill') return 'backfill';
    if (d.source === 'live') return d.auto === false ? 'manual' : (d.auto === true ? 'auto' : 'unknown');
    return 'unknown';
  }

  function normalizeState(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    const out = Object.assign(d, s);
    out.version = VERSION;
    out.lives = out.lives && typeof out.lives === 'object' ? out.lives : {};
    out.settingsEvents = Array.isArray(out.settingsEvents) ? out.settingsEvents : [];
    out.hookCaptures = Array.isArray(out.hookCaptures) ? out.hookCaptures : [];
    out.diagnostics = Object.assign(defaultState().diagnostics, out.diagnostics || {});
    out.diagnostics.warnings = Array.isArray(out.diagnostics.warnings) ? out.diagnostics.warnings : [];
    out.snapshotsFallback = Array.isArray(out.snapshotsFallback) ? out.snapshotsFallback : [];
    out.snapBytesTotal = 0;
    out.statesTotal = +out.statesTotal || 0;
    out.stateBytesTotal = +out.stateBytesTotal || 0;
    out.countryCount = +out.countryCount || 0;
    out.lastStateAt = out.lastStateAt || null;
    out.deletedLifeIds = Array.isArray(out.deletedLifeIds)
      ? Array.from(new Set(out.deletedLifeIds.map(String).filter(Boolean))).slice(-1000)
      : [];
    for (const e of out.settingsEvents) {
      if (!e || typeof e !== 'object') continue;
      if (!e.selectionMode) e.selectionMode = 'manual';
      if (!e.optionsSource) e.optionsSource = 'catalog';
    }
    for (const c of out.hookCaptures) {
      if (!c || typeof c !== 'object') continue;
      c.options = Array.isArray(c.options) ? c.options : [];
      c.used = !!c.used;
      c.matched = !!c.matched;
    }
    for (const id of Object.keys(out.lives)) {
      const l = out.lives[id];
      l.meta = l.meta && typeof l.meta === 'object' ? l.meta : {};
      l.decisions = Array.isArray(l.decisions) ? l.decisions : [];
      l.focusPicks = Array.isArray(l.focusPicks) ? l.focusPicks : [];
      l.timeline = Array.isArray(l.timeline) ? l.timeline : [];
      l.notes = Array.isArray(l.notes) ? l.notes : [];
      l.warnings = Array.isArray(l.warnings) ? l.warnings : [];
      l.backfilledIds = Array.isArray(l.backfilledIds) ? l.backfilledIds : [];
      for (const d of l.decisions) {
        if (!d || typeof d !== 'object') continue;
        if (d.auto === undefined) d.auto = null;
        d.type = d.type || (d.question ? 'question' : 'choice');
        d.selectionMode = inferSelectionMode(d);
        d.autoEvidence = d.autoEvidence || (d.source === 'backfill' ? 'backfill' : (d.source === 'save-diff' ? 'saveDiff' : (d.auto === true ? 'legacyAuto' : (d.auto === false ? 'legacyManual' : 'none'))));
        d.optionsSource = d.optionsSource || ((d.options && d.options.length) ? (d.source === 'auto-hook' ? 'hook' : 'dom') : (d.outcomeText ? 'log' : 'none'));
        d.captureConfidence = d.captureConfidence || ((d.options && d.options.length) ? 'high' : (d.source === 'live' ? 'medium' : 'low'));
        d.outcomeText = d.outcomeText || '';
      }
      for (const f of l.focusPicks) {
        if (!f || typeof f !== 'object') continue;
        if (!f.selectionMode) f.selectionMode = f.auto ? 'auto' : 'manual';
        if (!f.autoEvidence) f.autoEvidence = f.auto ? 'ageChange' : 'trustedClick';
      }
      l.snapCount = +l.snapCount || 0;
      l.snapBytes = +l.snapBytes || 0;
      l.stateCount = +l.stateCount || 0;
      l.stateBytes = +l.stateBytes || 0;
      l.lastStateAt = l.lastStateAt || null;
      for (const d of l.decisions) {
        if (!d || typeof d !== 'object') continue;
        d.beforeStateId = d.beforeStateId || null;
        d.afterStateId = d.afterStateId || null;
      }
      l.timelineCount = +l.timelineCount || (l.timeline ? l.timeline.length : 0);
      out.snapBytesTotal += l.snapBytes;
    }
    if (out.hookCaptures.length > 600) out.hookCaptures = out.hookCaptures.slice(-600);
    return out;
  }

  function addWarningToState(w) {
    if (!state) return false;
    if (state.diagnostics.warnings.some((x) => x.code === w.code && x.msg === w.msg)) return false;
    state.diagnostics.warnings.push(w);
    if (state.diagnostics.warnings.length > LIMITS.warnings) {
      state.diagnostics.warnings = state.diagnostics.warnings.slice(-LIMITS.warnings);
    }
    return true;
  }

  function warn(code, msg, severity) {
    const w = { code, msg, severity: severity || 'low', at: nowISO() };
    if (!state) {
      pendingWarnings.push(w);
      console.warn('[1in8b-rec]', code, msg);
      return;
    }
    if (!addWarningToState(w)) return;
    console.warn('[1in8b-rec]', code, msg);
    if (!persisting) saveState();
    updateUI();
  }

  function warnOnce(code, msg, severity) {
    const key = code + '|' + msg;
    if (live.warned.has(key)) return;
    live.warned.add(key);
    warn(code, msg, severity);
  }

  function clearWarn(code) {
    if (!state) return;
    const before = state.diagnostics.warnings.length;
    state.diagnostics.warnings = state.diagnostics.warnings.filter((w) => w.code !== code);
    for (const k of Array.from(live.warned)) {
      if (k === code || k.indexOf(code + '|') === 0) live.warned.delete(k);
    }
    if (state.diagnostics.warnings.length !== before) {
      saveState();
      updateUI();
    }
  }

  function safe(fn, label) {
    try { return fn(); }
    catch (e) { warn('error', (label || 'error') + ': ' + (e && e.message ? e.message : e)); }
  }

  function openDB() {
    if (dbFailed) return Promise.reject(new Error('indexeddb unavailable'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { dbFailed = true; reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_STATE)) db.createObjectStore(STORE_STATE, { keyPath: 'k' });
        if (!db.objectStoreNames.contains(STORE_SNAP)) {
          const s = db.createObjectStore(STORE_SNAP, { keyPath: 'id', autoIncrement: true });
          s.createIndex('lifeId', 'lifeId', { unique: false });
          s.createIndex('at', 'at', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_TIME)) db.createObjectStore(STORE_TIME, { keyPath: 'lifeId' });
        if (!db.objectStoreNames.contains(STORE_STATES)) {
          const st = db.createObjectStore(STORE_STATES, { keyPath: 'id' });
          st.createIndex('lifeId', 'lifeId', { unique: false });
          st.createIndex('at', 'at', { unique: false });
          st.createIndex('saveAt', 'saveAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_COUNTRIES)) db.createObjectStore(STORE_COUNTRIES, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbFailed = true; reject(req.error || new Error('indexeddb open failed')); };
      req.onblocked = () => { dbFailed = true; reject(new Error('indexeddb blocked')); };
    }).catch((e) => {
      dbFailed = true;
      warn('idb', 'IndexedDB 不可用，记录会退回 localStorage，容量较小。', 'medium');
      throw e;
    });
    return dbPromise;
  }

  async function idbGetState() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATE, 'readonly');
      const req = tx.objectStore(STORE_STATE).get('main');
      req.onsuccess = () => resolve(req.result ? req.result.v : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutState(v) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATE, 'readwrite');
      tx.objectStore(STORE_STATE).put({ k: 'main', v });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('indexeddb abort'));
    });
  }

  async function idbClearData() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_SNAP, STORE_TIME, STORE_STATES, STORE_COUNTRIES], 'readwrite');
      tx.objectStore(STORE_SNAP).clear();
      tx.objectStore(STORE_TIME).clear();
      tx.objectStore(STORE_STATES).clear();
      tx.objectStore(STORE_COUNTRIES).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbAddSnapshot(snap) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAP, 'readwrite');
      const req = tx.objectStore(STORE_SNAP).add(snap);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbAllSnapshots() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAP, 'readonly');
      const req = tx.objectStore(STORE_SNAP).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutTimeline(lifeId, entries) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TIME, 'readwrite');
      tx.objectStore(STORE_TIME).put({ lifeId, entries, updatedAt: nowISO() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetTimeline(lifeId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TIME, 'readonly');
      const req = tx.objectStore(STORE_TIME).get(lifeId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDeleteTimeline(lifeId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TIME, 'readwrite');
      tx.objectStore(STORE_TIME).delete(lifeId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDeleteByLifeIndex(storeName, lifeId) {
    const db = await openDB();
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).index('lifeId').getAllKeys(IDBKeyRange.only(lifeId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (!keys.length) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const key of keys) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('indexeddb abort'));
    });
  }

  function idbDeleteSnapshotsForLife(lifeId) {
    return idbDeleteByLifeIndex(STORE_SNAP, lifeId);
  }

  function idbDeleteStatesForLife(lifeId) {
    return idbDeleteByLifeIndex(STORE_STATES, lifeId);
  }

  async function idbAllTimelines() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TIME, 'readonly');
      const req = tx.objectStore(STORE_TIME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbAddState(snap) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATES, 'readwrite');
      tx.objectStore(STORE_STATES).put(snap);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('indexeddb abort'));
    });
  }

  async function idbGetStateSnap(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATES, 'readonly');
      const req = tx.objectStore(STORE_STATES).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutStateSnap(snap) {
    return idbAddState(snap);
  }

  async function idbAllStates() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATES, 'readonly');
      const req = tx.objectStore(STORE_STATES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPutCountry(row) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_COUNTRIES, 'readwrite');
      tx.objectStore(STORE_COUNTRIES).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbAllCountries() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_COUNTRIES, 'readonly');
      const req = tx.objectStore(STORE_COUNTRIES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbClearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_STATE, STORE_SNAP, STORE_TIME, STORE_STATES, STORE_COUNTRIES], 'readwrite');
      tx.objectStore(STORE_STATE).clear();
      tx.objectStore(STORE_SNAP).clear();
      tx.objectStore(STORE_TIME).clear();
      tx.objectStore(STORE_STATES).clear();
      tx.objectStore(STORE_COUNTRIES).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function addSnapshot(lifeId, type, rawText, ref) {
    try {
      if (!lifeId || !state) return;
      const life = state.lives[lifeId];
      if (!life) return;
      const t = String(rawText || '');
      if (!t.trim()) return;
      const h = hashText(t);
      const dedupeKey = type + '|' + (ref || '');
      if (live.lastSnapHash[dedupeKey] === h) return;
      live.lastSnapHash[dedupeKey] = h;
      const bytes = byteLen(t);
      const snap = {
        lifeId,
        type,
        ref: ref || null,
        at: nowISO(),
        age: readAge(),
        year: readYear(),
        hash: h,
        bytes,
        truncated: false,
        text: t,
        bundle: state.diagnostics.bundle ? state.diagnostics.bundle.hash : null,
      };
      try {
        await idbAddSnapshot(snap);
      } catch (_) {
        state.snapshotsFallback.push(snap);
        let total = 0;
        for (const s of state.snapshotsFallback) total += +s.bytes || 0;
        while (state.snapshotsFallback.length > 200 || total > LIMITS.fallbackSnapBytes) {
          const rm = state.snapshotsFallback.shift();
          total -= rm ? (+rm.bytes || 0) : 0;
        }
      }
      life.snapCount = (+life.snapCount || 0) + 1;
      life.snapBytes = (+life.snapBytes || 0) + bytes;
      state.snapBytesTotal = (+state.snapBytesTotal || 0) + bytes;
      saveState();
      updateUI();
    } catch (e) {
      warn('error', '快照失败：' + (e && e.message ? e.message : e));
    }
  }

  function totalDecisions() {
    if (!state) return 0;
    let n = 0;
    for (const id of Object.keys(state.lives)) n += (state.lives[id].decisions || []).length;
    return n;
  }

  function totalSnapshots() {
    if (!state) return 0;
    let n = 0;
    for (const id of Object.keys(state.lives)) n += (+state.lives[id].snapCount || 0);
    return n;
  }

  function updateMetaLS() {
    if (!state) return;
    try {
      localStorage.setItem(META_KEY, JSON.stringify({
        version: VERSION,
        updatedAt: state.updatedAt,
        lives: Object.keys(state.lives).length,
        decisions: totalDecisions(),
        snapshots: totalSnapshots(),
        states: totalStates(),
      }));
    } catch (_) {}
  }

  function slimStateForLS(st) {
    const o = clone(st) || {};
    o.lives = {};
    for (const id of Object.keys(st.lives || {})) {
      const l = st.lives[id];
      o.lives[id] = Object.assign({}, l, {
        decisions: (l.decisions || []).slice(-200),
        focusPicks: (l.focusPicks || []).slice(-200),
        timeline: [],
        notes: (l.notes || []).slice(-100),
        result: l.result ? Object.assign({}, l.result, { years: null }) : l.result,
      });
    }
    o.settingsEvents = (o.settingsEvents || []).slice(-30);
    o.hookCaptures = (o.hookCaptures || []).slice(-50).map((c) => {
      const x = Object.assign({}, c);
      x.preDone = null;
      x.logBaseline = null;
      return x;
    });
    o.snapshotsFallback = [];
    return o;
  }

  async function persistState() {
    persisting = true;
    try {
      try {
        await idbPutState(state);
        try { localStorage.removeItem(LEGACY_KEY); } catch (_) {}
        return;
      } catch (_) {}
      const slim = slimStateForLS(state);
      if (lsSet(LEGACY_KEY, slim)) {
        warnOnce('lsfallback', 'IndexedDB 不可用，已退回 localStorage，记录容量受限。', 'medium');
      } else {
        warnOnce('quota', '写入失败：浏览器存储空间不足，请立即导出。', 'high');
      }
    } finally {
      persisting = false;
    }
  }

  function saveState(immediate) {
    if (!state) return saveChain;
    state.updatedAt = nowISO();
    updateMetaLS();
    clearTimeout(saveTimer);
    const run = () => {
      saveChain = saveChain.then(() => persistState()).catch(() => {});
      return saveChain;
    };
    if (immediate) return run();
    saveTimer = setTimeout(run, 300);
    return saveChain;
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveChain = saveChain.then(() => persistState()).catch(() => {});
    await saveChain;
  }

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (_) { return fallback; }
  }

  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (_) { return false; }
  }

  function readPrefs() {
    const o = lsGet(PREF_KEY, null);
    return o && typeof o === 'object' ? o : {};
  }

  function detectLang() {
    const wl = typeof window.LANG === 'string' ? window.LANG : '';
    if (wl) return wl;
    const seg = (location.pathname.split('/')[1] || '').toLowerCase();
    if (seg === 'zh-hans' || seg === 'zh-hant' || seg === 'zh') return 'zh';
    return seg || 'ko';
  }

  function listKeys() {
    const out = { save: [], past: [], lives: [] };
    let keys = [];
    try { keys = Object.keys(localStorage); } catch (_) {}
    for (const k of keys) {
      if (/^one8b\.(?:[a-z]+(?:-[a-z]+)?\.)?save\.v\d+$/.test(k)) out.save.push(k);
      else if (/^one8b\.(?:[a-z]+(?:-[a-z]+)?\.)?past\.v\d+$/.test(k)) out.past.push(k);
      else if (/^one8b\.(?:[a-z]+(?:-[a-z]+)?\.)?lives\.v\d+$/.test(k)) out.lives.push(k);
    }
    return out;
  }

  function readSaveKey(key) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch (_) { return null; }
    if (!raw) return null;
    const hit = saveCache.get(key);
    if (hit && hit.raw === raw) return hit.value;
    let value = null;
    try {
      const o = JSON.parse(raw);
      if (o && o.S && typeof o.S === 'object') value = { S: o.S, at: +o.at || null, key, raw };
      else if (o && o.phase && typeof o === 'object') value = { S: o, at: null, key, raw };
    } catch (_) { value = null; }
    saveCache.set(key, { raw, value });
    return value;
  }

  function readActiveSave() {
    const cands = [];
    for (const k of listKeys().save) {
      const o = readSaveKey(k);
      if (o && o.S && !o.S.isComp) cands.push(o);
    }
    if (!cands.length) return null;
    const lang = detectLang();
    cands.sort((a, b) => {
      const aLang = a.key.indexOf('.' + lang + '.') >= 0 ? 1 : 0;
      const bLang = b.key.indexOf('.' + lang + '.') >= 0 ? 1 : 0;
      if (aLang !== bLang) return bLang - aLang;
      const as = +(a.S.startedAt || 0);
      const bs = +(b.S.startedAt || 0);
      if (as !== bs) return bs - as;
      return (b.at || 0) - (a.at || 0);
    });
    return cands[0];
  }

  function lifeIdFromS(S) {
    if (!S || typeof S !== 'object') return null;
    if (S.startedAt) return 's' + S.startedAt;
    if (S.lifeAt) return 'd' + S.lifeAt;
    return null;
  }

  function metaFromS(S) {
    let name = '';
    if (typeof S.name === 'string') name = S.name;
    else if (S.name && typeof S.name === 'object') {
      name = S.name.full || [S.name.first, S.name.last].filter(Boolean).join(' ') || '';
    }
    return {
      name,
      born: S.born || '',
      sex: S.sex || '',
      era: S.era || '',
      by: S.by || '',
      age: S.age == null ? null : S.age,
      phase: S.phase || '',
      startedAt: S.startedAt || null,
      lifeAt: S.lifeAt || null,
    };
  }

  function normalizeLog(log) {
    if (!Array.isArray(log)) return [];
    return log.slice(-LIMITS.timelinePerLife).map((e) => {
      if (!e || typeof e !== 'object') return { a: null, kind: null, q: '', text: String(e == null ? '' : e), fact: '', fx: null, fa: '', star: false, dk: null };
      return {
        a: Number.isFinite(+e.a) ? +e.a : null,
        kind: e.kind || null,
        q: e.q || '',
        text: e.text || '',
        fact: e.fact || '',
        fx: e.fx || null,
        fa: e.fa || '',
        star: !!e.star,
        dk: e.dk || e.d || null,
      };
    });
  }

  function normalizeJournal(j) {
    if (!Array.isArray(j)) return [];
    return j.map((n) => ({ a: Number.isFinite(+n.a) ? +n.a : null, q: n.q || '', t: n.t || '', own: !!n.own }));
  }

  function newLifeRecord(lifeId, source, meta) {
    return {
      lifeId,
      source: source || 'live',
      captureStatus: source === 'live' ? 'live' : (source === 'backfill-summary' ? 'summary' : 'backfill'),
      startedAt: meta && meta.startedAt ? meta.startedAt : null,
      endedAt: null,
      meta: meta || {},
      decisions: [],
      focusPicks: [],
      timeline: [],
      timelineCount: 0,
      timelineHash: '',
      notes: [],
      result: null,
      warnings: [],
      backfilledIds: [],
      snapCount: 0,
      snapBytes: 0,
      stateCount: 0,
      stateBytes: 0,
      lastStateAt: null,
      baselineDone: null,
    };
  }

  function trimLives() {
    const ids = Object.keys(state.lives);
    if (ids.length <= LIMITS.livesMax) return;
    ids.sort((a, b) => (+state.lives[a].startedAt || +state.lives[a].endedAt || 0) - (+state.lives[b].startedAt || +state.lives[b].endedAt || 0));
    const drop = ids.length - LIMITS.livesMax;
    for (let i = 0; i < drop; i++) delete state.lives[ids[i]];
  }

  function ensureLife(lifeId, source, meta) {
    if (!lifeId || isLifeDeleted(lifeId)) return null;
    if (!state.lives[lifeId]) {
      state.lives[lifeId] = newLifeRecord(lifeId, source, meta);
      trimLives();
    } else {
      const l = state.lives[lifeId];
      if (source === 'live' && l.source !== 'live') {
        l.source = 'live';
        l.captureStatus = 'live';
      }
      l.meta = Object.assign({}, l.meta, meta || {});
    }
    return state.lives[lifeId];
  }

  function countUnattributedLive(life) {
    let n = 0;
    for (const d of life.decisions || []) {
      if (d.source === 'live' && !d.decisionId) n++;
    }
    return n;
  }

  function rebuildAttributedIds(life) {
    live.attributedIds = new Set();
    for (const d of life.decisions || []) {
      if (d.source === 'live' && d.decisionId) live.attributedIds.add(d.decisionId);
    }
  }

  function queueTimeline(life, entries) {
    life.timelineCount = entries.length;
    const h = hashText(JSON.stringify(entries));
    if (life.timelineHash === h) return;
    life.timelineHash = h;
    delete ui.timelineCache[life.lifeId];
    if (ui.view === 'life' && ui.viewLifeId === life.lifeId && ui.tab === 'timeline' && ui.panel && !ui.panel.hidden) updateUI();
    if (dbFailed) {
      life.timeline = entries.slice(-400);
      return;
    }
    timelineChain = timelineChain.then(() => idbPutTimeline(life.lifeId, entries)).catch(() => {
      life.timeline = entries.slice(-400);
    });
  }

  function applySaveToLife(life, S, opts) {
    opts = opts || {};
    if (!life || !S) return;
    const meta = metaFromS(S);
    life.meta = Object.assign({}, life.meta, meta);
    if (meta.startedAt && !life.startedAt) life.startedAt = meta.startedAt;
    if (meta.lifeAt) life.endedAt = meta.lifeAt;
    queueTimeline(life, normalizeLog(S.log));
    life.notes = normalizeJournal(S.journal);
    life.result = {
      stats: S.stats || null,
      years: S.years || null,
      deathAt: S.deathAt || null,
      lifeAt: S.lifeAt || null,
      born: S.born || null,
      era: S.era || null,
      by: S.by || null,
      flagsWay: (S.flags && S.flags.way) || null,
      flagsAu: !!(S.flags && S.flags.au),
      flagsFocusOwn: !!(S.flags && S.flags.focusOwn),
      done: S.done || null,
      journalCount: Array.isArray(S.journal) ? S.journal.length : 0,
    };

    const attributed = opts.attributedIds instanceof Set ? opts.attributedIds : new Set();
    const diffs = diffDone(S.done || {}, opts.baselineDone || {});
    const ids = Object.keys(diffs);
    let addCount = ids.length;
    if (opts.unattributedLiveCount > 0) addCount = Math.max(0, addCount - opts.unattributedLiveCount);
    for (let i = 0; i < addCount; i++) {
      const id = ids[i];
      if (!id || attributed.has(id) || (life.backfilledIds || []).indexOf(id) >= 0) continue;
      life.decisions.push({
        id: 'bf-' + id + '-' + Date.now().toString(36) + '-' + i,
        seq: null,
        source: 'backfill',
        type: 'choice',
        decisionId: id,
        at: null,
        age: null,
        year: null,
        title: null,
        body: null,
        question: null,
        options: null,
        optionsKnown: false,
        selectedK: (S.flags && S.flags.way && S.flags.way[id] != null) ? S.flags.way[id] : null,
        selectedLabel: null,
        selectedSub: null,
        auto: null,
        autoEvidence: 'backfill',
        selectionMode: 'backfill',
        optionsSource: 'none',
        captureConfidence: 'low',
        outcomeText: '',
        decideMs: null,
        note: '',
        resolved: true,
        count: diffs[id],
        possibleDuplicate: false,
      });
      life.backfilledIds.push(id);
    }
    for (const d of life.decisions) {
      if (d && (d.source === 'backfill' || d.source === 'save-diff' || d.source === 'auto-hook' || d.source === 'hook')) {
        enrichDecisionFromLog(d, S.log);
        matchHookCaptureForDecision(life, d);
      }
    }
    mergeHookCapturesForLife(life, S);
  }


  function stateYear(S) {
    if (S && S.by != null && S.age != null) return String(+S.by + +S.age) + '年';
    return readYear();
  }

  function readCountryData() {
    const dl = $('#ctyDl');
    if (!dl) return null;
    const pairs = [];
    const dts = $$('dt', dl);
    const dds = $$('dd', dl);
    for (let i = 0; i < Math.max(dts.length, dds.length); i++) {
      const label = textOf(dts[i]);
      const value = textOf(dds[i]);
      if (label || value) pairs.push({ label, value });
    }
    const text = textOf(dl);
    if (!pairs.length && !text) return null;
    const title = pickText(['#ctyTitle', '#ctyDl h2', '#ctyDl h3', '#ctyDl .title', '#ctyDl .hd']) || '';
    return { title, text, pairs };
  }

  function readSurvivalData() {
    const el = $('#chart');
    if (!el) return null;
    const text = textOf(el);
    const labels = $$('text', el).map((n) => textOf(n)).filter(Boolean).slice(0, 200);
    const paths = $$('path', el).map((n) => n.getAttribute('d')).filter(Boolean).slice(0, 100);
    const title = pickText(['#chart h2', '#chart h3', '#chart .title', '#chart .hd']) || '';
    const legend = pickText(['#chartLegend']);
    if (!text && !labels.length && !paths.length && !legend) return null;
    return { title, text: text || legend, labels, paths, legend };
  }

  function readVisibleState() {
    const lv = $('#lifeview');
    const focusOptions = [];
    const seen = new Set();
    for (const b of $$('#focusChips [data-focus], #mbPick [data-focus]')) {
      const k = b.getAttribute('data-focus');
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const lines = textOf(b).split('\n');
      focusOptions.push({ k, label: (lines[0] || '').trim(), desc: textOf(b.querySelector('small')) });
    }
    return {
      idCard: pickText(['.panel.idcard', '#idCard', '#idcard', '.idcard', '#sheet .idcard', '#cert']),
      mrz: pickText(['#mrz', '.mrz', '#cert .mrz', '#idCard .mrz']),
      statBars: pickText(['#statBars', '.statBars', '#stBars', '#stats']),
      money: pickText(['#money', '#moneyBox', '.money', '.moneyBox']),
      family: pickText(['#fam', '#family', '.p-fam', '#famList', '#sheet .fam']),
      focus: pickText(['#focusChips', '#mbPick']),
      focusOptions,
      focusSelected: attr($('[data-focus][aria-pressed="true"]'), 'data-focus'),
      comps: pickText(['#compList', '.p-comps']),
      lifeMap: pickText(['#grid', '.p-grid']),
      countryText: pickText(['#ctyDl']),
      countryTitle: pickText(['#ctyTitle']),
      survival: readSurvivalData(),
      pageText: truncateText(textOf(lv), LIMITS.stateVisibleMax),
    };
  }

  function countryRefFor(S) {
    return S && S.cur ? String(S.cur) + '|' + detectLang() : null;
  }

  async function ensureCountry(S, visible) {
    const ref = countryRefFor(S);
    if (!ref) return null;
    const old = live.countryCache[ref];
    const data = readCountryData();
    const surv = (visible && visible.survival) || readSurvivalData();
    if (old && (old.stats || old.survival)) {
      if (!old.stats && data) old.stats = data;
      if (!old.survival && surv) old.survival = surv;
      return ref;
    }
    if (!data && !surv) return ref;
    const row = {
      key: ref,
      countryCode: S.cur,
      countryName: (data && data.title) || '',
      lang: detectLang(),
      era: S.era || '',
      capturedAt: nowISO(),
      stats: data,
      survival: surv,
      source: 'page',
    };
    live.countryCache[ref] = row;
    state.countryCount = Object.keys(live.countryCache).length;
    try {
      await idbPutCountry(row);
    } catch (e) {
      warnOnce('country', '国家资料写入失败：' + (e && e.message ? e.message : e), 'medium');
    }
    saveState();
    return ref;
  }

  function buildStateSnapshot(S, opts) {
    opts = opts || {};
    const visible = opts.visible || readVisibleState();
    const currentYear = Array.isArray(S.years) && S.years.length ? clone(S.years[S.years.length - 1]) : null;
    const money = asNum(S.money);
    const house = asNum(S.house);
    const debt = asNum(S.debt);
    const netFromYear = currentYear && currentYear.nw != null ? asNum(currentYear.nw) : null;
    const netWorth = netFromYear != null ? netFromYear : (money != null || house != null || debt != null ? (money || 0) + (house || 0) - (debt || 0) : null);
    const fam = S.fam && typeof S.fam === 'object' ? S.fam : {};
    const person = (p) => {
      if (!p || typeof p !== 'object') return null;
      return {
        name: nameOf(p.name) || (typeof p.name === 'string' ? p.name : ''),
        sex: p.sex || '',
        age: asNum(p.age),
        alive: p.alive == null ? null : !!p.alive,
        absent: !!p.absent,
        job: p.job || '',
        divorced: !!p.divorced,
        bornAt: asNum(p.bornAt),
      };
    };
    const countryRef = countryRefFor(S);
    const country = live.countryCache[countryRef] || null;
    const st = {
      schema: 1,
      id: 'st-' + Date.now().toString(36) + '-' + (++live.stateSeq),
      lifeId: lifeIdFromS(S),
      at: nowISO(),
      saveAt: opts.saveAt == null ? null : +opts.saveAt,
      saveAtISO: opts.saveAt ? new Date(+opts.saveAt).toISOString() : null,
      saveKey: opts.saveKey || null,
      reason: opts.reason || 'save',
      phase: opts.phase || null,
      decisionRef: opts.decisionRef || null,
      hookRef: opts.hookRef || null,
      age: S.age == null ? readAge() : +S.age,
      year: stateYear(S),
      identity: {
        name: nameOf(S.name),
        nameRaw: S.name && typeof S.name === 'object' ? S.name : null,
        sex: S.sex || '',
        sexLabel: S.sex === 'F' ? '女' : S.sex === 'M' ? '男' : '',
        born: S.born || '',
        cur: S.cur || '',
        urban: !!S.urban,
        city: S.city || '',
        bornUrban: !!S.bornUrban,
        bornCity: S.bornCity || '',
        rel: S.rel || '',
        cl: S.cl || '',
        eth: S.eth || null,
        caste: S.caste || null,
        tal: S.tal || null,
        trait: S.trait || null,
        birthYear: asNum(S.by),
        birthMonth: asNum(S.bm),
        isComp: !!S.isComp,
        idCard: visible.idCard || '',
        mrz: visible.mrz || '',
      },
      stats: {
        health: S.st ? asNum(S.st.h) : null,
        happiness: S.st ? asNum(S.st.hl) : null,
        knowledge: S.st ? asNum(S.st.sm) : null,
        relationships: S.st ? asNum(S.st.so) : null,
        raw: S.st || null,
      },
      money: {
        cash: money,
        house,
        debt,
        income: asNum(S.income),
        pct: asNum(S.pct),
        netWorth,
        netWorthSource: netFromYear != null ? 'year' : 'derived',
      },
      family: {
        mother: person(fam.mom),
        father: person(fam.dad),
        partner: person(fam.partner),
        dating: person(fam.dating),
        married: !!fam.married,
        kids: Array.isArray(fam.kids) ? fam.kids.map(person) : [],
        grandparents: Array.isArray(fam.gp) ? fam.gp.map(person) : [],
        siblings: {
          older: asNum(fam.older),
          younger: asNum(fam.younger),
          born: asNum(fam.sibBorn),
          at: fam.sibAt || null,
          list: Array.isArray(fam.sibs) ? fam.sibs.map(person) : null,
        },
        raw: fam,
      },
      educationWork: {
        edu: S.edu == null ? null : +S.edu,
        school: S.school == null ? null : S.school,
        schoolY: S.schoolY == null ? null : +S.schoolY,
        exp: S.exp || null,
        job: S.job || '',
        jobY: S.jobY == null ? null : +S.jobY,
        formal: !!S.formal,
        formalY: S.formalY == null ? null : +S.formalY,
      },
      focus: {
        key: S.focus == null ? null : S.focus,
        traits: S.fT || null,
        selected: visible.focusSelected || (S.focus == null ? null : S.focus),
        options: visible.focusOptions || [],
      },
      comps: Array.isArray(S.comps) ? S.comps.map((c) => ({
        name: nameOf(c && c.name) || (c && typeof c.name === 'string' ? c.name : ''),
        iso: c && c.iso || '',
        sex: c && c.sex || '',
        q: c && c.q == null ? null : +c.q,
        urban: !!(c && c.urban),
        city: c && c.city || '',
      })) : [],
      currentYear,
      countryRef,
      country: { ref: countryRef, code: S.cur || '', name: country ? country.countryName : '' },
      survival: visible.survival ? {
        currentAge: S.age == null ? readAge() : +S.age,
        text: truncateText(visible.survival.text, 2000),
        labels: (visible.survival.labels || []).slice(0, 40),
      } : null,
      visible: {
        idCard: visible.idCard || '',
        mrz: visible.mrz || '',
        statBars: visible.statBars || '',
        money: visible.money || '',
        family: visible.family || '',
        focus: visible.focus || '',
        comps: visible.comps || '',
        lifeMap: visible.lifeMap || '',
        countryText: visible.countryText || '',
        countryTitle: visible.countryTitle || '',
        pageText: visible.pageText || '',
      },
      backend: stripHistory(S),
      confidence: opts.confidence || 'high',
      source: 'save+page',
      bytes: 0,
    };
    try { st.bytes = byteLen(JSON.stringify(st)); } catch (_) { st.bytes = 0; }
    return st;
  }

  async function captureStateSnapshot(S, opts) {
    if (!state || !S || typeof S !== 'object' || S.isComp) return null;
    if (isLifeDeleted(lifeIdFromS(S))) return null;
    const st = buildStateSnapshot(S, opts);
    if (!st || !st.lifeId || isLifeDeleted(st.lifeId)) return null;
    try {
      await ensureCountry(S, opts && opts.visible);
    } catch (_) {}
    const country = live.countryCache[st.countryRef];
    if (country) st.country.name = country.countryName || st.country.name;
    const refs = [];
    const remain = [];
    const stMs = Date.parse(st.at) || Date.now();
    for (const p of live.pendingAfter) {
      if (!p || !p.rec || p.lifeId !== st.lifeId || st.reason === 'decision-before' || p.at > stMs + 1500) {
        remain.push(p);
        continue;
      }
      if (!p.rec.afterStateId) {
        p.rec.afterStateId = st.id;
        p.rec.afterStateAt = st.at;
        refs.push({ id: p.rec.id, phase: 'after' });
      }
    }
    live.pendingAfter = remain;
    if (refs.length) st.decisionRefs = (st.decisionRefs || []).concat(refs);
    try {
      await idbAddState(st);
    } catch (e) {
      warnOnce('states', '状态照片写入失败：' + (e && e.message ? e.message : e), 'high');
      return null;
    }
    const life = ensureLife(st.lifeId, 'live', metaFromS(S));
    if (life) {
      life.stateCount = (+life.stateCount || 0) + 1;
      life.stateBytes = (+life.stateBytes || 0) + (+st.bytes || 0);
      life.lastStateAt = st.at;
    }
    state.statesTotal = (+state.statesTotal || 0) + 1;
    state.stateBytesTotal = (+state.stateBytesTotal || 0) + (+st.bytes || 0);
    state.lastStateAt = st.at;
    live.lastState = { id: st.id, lifeId: st.lifeId, at: st.at, atMs: stMs, saveAt: st.saveAt, reason: st.reason, phase: st.phase, bytes: st.bytes };
    live.recentStates.push(live.lastState);
    if (live.recentStates.length > LIMITS.recentStates) live.recentStates = live.recentStates.slice(-LIMITS.recentStates);
    saveState();
    updateUI();
    return st;
  }

  function queueStateCapture(fn) {
    stateChain = stateChain.then(fn).catch((e) => {
      warnOnce('states', '状态记录失败：' + (e && e.message ? e.message : e), 'high');
      return null;
    });
    return stateChain;
  }

  function captureStateFromSave(S, saveAt, saveKey, reason) {
    return queueStateCapture(() => captureStateSnapshot(S, {
      saveAt,
      saveKey,
      reason: reason || 'save',
      confidence: 'high',
    }));
  }

  function onSaveWrite(key, raw) {
    if (!SAVE_KEY_RE.test(String(key))) return;
    let o = null;
    try { o = JSON.parse(String(raw)); } catch (_) { return; }
    if (!o || !o.S || typeof o.S !== 'object' || o.S.isComp) return;
    const at = +o.at || Date.now();
    live.lastSaveRaw = String(raw);
    live.lastSaveKey = String(key);
    if (state && isLifeDeleted(lifeIdFromS(o.S))) return;
    if (!state) {
      live.pendingSaveWrites.push({ S: o.S, at, key: String(key), raw: String(raw) });
      if (live.pendingSaveWrites.length > 200) live.pendingSaveWrites.shift();
      return;
    }
    captureStateFromSave(o.S, at, String(key), 'save');
  }

  function installSaveHook() {
    if (live.saveHookInstalled) return;
    try {
      const proto = Storage.prototype;
      const orig = proto.setItem;
      if (typeof orig !== 'function') return;
      proto.setItem = function (key, value) {
        const r = orig.apply(this, arguments);
        try {
          if (this === window.localStorage) onSaveWrite(key, value);
        } catch (_) {}
        return r;
      };
      live.saveHookInstalled = true;
      console.info('[1in8b-rec] save hook installed');
    } catch (e) {
      warnOnce('savehook', '每次保存监听未能启用：' + (e && e.message ? e.message : e), 'medium');
    }
  }

  function findRecentAfterState(lifeId, sinceMs, excludeId) {
    for (const s of live.recentStates) {
      if (!s || s.lifeId !== lifeId) continue;
      if (excludeId && s.id === excludeId) continue;
      if (s.reason === 'decision-before') continue;
      if ((+s.atMs || 0) < sinceMs) continue;
      return s;
    }
    return null;
  }

  async function patchStateDecisionRef(stateId, recId, phase) {
    if (!stateId || !recId) return;
    try {
      const st = await idbGetStateSnap(stateId);
      if (!st) return;
      const refs = Array.isArray(st.decisionRefs) ? st.decisionRefs : [];
      if (!refs.some((r) => r && String(r.id) === String(recId) && r.phase === phase)) {
        refs.push({ id: recId, phase });
        st.decisionRefs = refs;
        if (!st.decisionRef) st.decisionRef = recId;
        await idbPutStateSnap(st);
      }
    } catch (_) {}
  }

  function attachStateToDecision(rec, st, phase) {
    if (!rec || !st || !st.id) return;
    if (phase === 'before') {
      if (!rec.beforeStateId) {
        rec.beforeStateId = st.id;
        rec.beforeStateAt = st.at || null;
      }
    } else if (phase === 'after') {
      if (!rec.afterStateId) {
        rec.afterStateId = st.id;
        rec.afterStateAt = st.at || null;
      }
    }
    patchStateDecisionRef(st.id, rec.id, phase);
    saveState();
  }

  function captureDecisionBefore(rec, S) {
    if (!rec || rec.beforeStateId) return;
    if (!S) {
      const a = readActiveSave();
      S = a && a.S;
    }
    if (!S) return;
    const visible = readVisibleState();
    queueStateCapture(() => captureStateSnapshot(S, {
      reason: 'decision-before',
      phase: 'before',
      decisionRef: rec.id,
      confidence: 'high',
      visible,
    })).then((st) => {
      if (st) attachStateToDecision(rec, st, 'before');
    });
  }

  function captureAfterNow(rec) {
    if (!rec || rec.afterStateId) return;
    const a = readActiveSave();
    if (!a || !a.S) return;
    const visible = readVisibleState();
    queueStateCapture(() => captureStateSnapshot(a.S, {
      reason: 'decision-after',
      phase: 'after',
      decisionRef: rec.id,
      confidence: 'medium',
      saveAt: a.at,
      saveKey: a.key,
      visible,
    })).then((st) => {
      if (st) attachStateToDecision(rec, st, 'after');
    });
  }

  function scheduleAfterLink(rec, lifeId, since, excludeId, fallbackSince) {
    if (!rec || !lifeId) return;
    const attempt = () => {
      if (rec.afterStateId) return;
      let st = findRecentAfterState(lifeId, since, excludeId);
      if (!st && fallbackSince != null) st = findRecentAfterState(lifeId, fallbackSince, excludeId);
      if (st) attachStateToDecision(rec, st, 'after');
    };
    attempt();
    setTimeout(attempt, 500);
    setTimeout(attempt, 1600);
    setTimeout(attempt, 3500);
    setTimeout(() => {
      if (rec.afterStateId) return;
      const st = findRecentAfterState(lifeId, since, excludeId)
        || (fallbackSince != null ? findRecentAfterState(lifeId, fallbackSince, excludeId) : null);
      if (st) attachStateToDecision(rec, st, 'after');
      else captureAfterNow(rec);
    }, 1200);
  }

  function markDecisionAfter(rec) {
    if (!rec || !rec.lifeId) return;
    const since = Date.parse(rec.decidedAt || rec.at) || Date.now();
    const opened = Date.parse(rec.at) || since;
    const st = findRecentAfterState(rec.lifeId, since, rec.beforeStateId)
      || (rec.type === 'question' ? findRecentAfterState(rec.lifeId, opened, rec.beforeStateId) : null);
    if (st) attachStateToDecision(rec, st, 'after');
    scheduleAfterLink(rec, rec.lifeId, since, rec.beforeStateId, rec.type === 'question' ? opened : null);
    if (!rec.afterStateId && !live.pendingAfter.some((p) => p && p.rec === rec)) {
      live.pendingAfter.push({ rec, lifeId: rec.lifeId, at: since });
    }
  }

  function attachHookStates(rec, c) {
    if (!rec || !c) return;
    if (c.preStateId) {
      attachStateToDecision(rec, { id: c.preStateId, at: c.preStateAt || c.at }, 'before');
    }
    const since = Date.parse(c.at) || Date.now();
    scheduleAfterLink(rec, c.lifeId, since, c.preStateId);
    if (!live.pendingAfter.some((p) => p && p.rec === rec)) {
      live.pendingAfter.push({ rec, lifeId: c.lifeId, at: since });
    }
  }

  function captureAutoBefore(c, S) {
    if (!c || !S) return;
    const visible = readVisibleState();
    queueStateCapture(() => captureStateSnapshot(S, {
      reason: 'decision-before',
      phase: 'before',
      hookRef: c.id,
      confidence: 'high',
      visible,
    })).then((st) => {
      if (st) {
        c.preStateId = st.id;
        c.preStateAt = st.at;
        const life = state && state.lives ? state.lives[c.lifeId] : null;
        const d = life && (life.decisions || []).find((x) => x && (x.hookId === c.id || (c.decisionId != null && x.decisionId != null && String(x.decisionId) === String(c.decisionId))));
        if (d) attachStateToDecision(d, st, 'before');
        saveState();
      }
    });
  }

  async function loadCountries() {
    if (!state) return;
    try {
      const list = await idbAllCountries();
      for (const row of list) {
        if (row && row.key) live.countryCache[row.key] = row;
      }
      state.countryCount = Object.keys(live.countryCache).length;
    } catch (_) {}
  }

  function totalStates() {
    return state ? (+state.statesTotal || 0) : 0;
  }

  function captureCountryNow() {
    const a = readActiveSave();
    if (!a || !a.S) return;
    ensureCountry(a.S, readVisibleState());
  }

  function installChoiceHook() {
    if (live.hookInstalled) return;
    live.hookInstalled = true;
    try {
      const orig = Array.prototype.find;
      if (typeof orig !== 'function') return;
      Array.prototype.find = function (cb, thisArg) {
        let result;
        try {
          result = orig.call(this, cb, thisArg);
        } catch (e) {
          throw e;
        }
        try { maybeCaptureChoices(this, result); } catch (_) {}
        return result;
      };
      live.origFind = orig;
      try { window.__rec1in8bHook = true; } catch (_) {}
      console.info('[1in8b-rec] choice hook installed');
    } catch (e) {
      warn('hook', '后台捕获未能启用：' + (e && e.message ? e.message : e), 'medium');
    }
  }

  function isChoiceList(a) {
    if (!Array.isArray(a) || !a.length) return false;
    const o = a[0];
    return !!(o && typeof o === 'object' && o.k != null && (o.label != null || o.sub != null));
  }

  function maybeCaptureChoices(arr, selected) {
    if (!state || !isChoiceList(arr)) return;
    const lv = $('#lifeview');
    if (!lv || lv.hidden) return;
    if (!selected || selected.k == null) return;
    if (arr.indexOf(selected) < 0) return;
    let count = 0;
    const options = [];
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (!o || typeof o !== 'object' || o.k == null) continue;
      count++;
      options.push({ k: String(o.k), label: o.label == null ? '' : String(o.label), sub: o.sub == null ? '' : String(o.sub) });
    }
    if (!count) return;
    const selectedK = String(selected.k);
    const sig = hashText(options.map((o) => o.k).join('|'));
    const now = Date.now();
    const dedupe = sig + '|' + selectedK;
    if (live.lastHookSig === dedupe && now - (+live.lastHookAt || 0) < 1200) return;
    live.lastHookSig = dedupe;
    live.lastHookAt = now;
    const active = readActiveSave();
    const S = active && active.S;
    const lifeId = (S && lifeIdFromS(S)) || live.lifeId;
    if (!lifeId || isLifeDeleted(lifeId)) return;
    const ctx = live.lastHookContext && (now - (+live.lastHookContext.at || 0) < 1200) && (!live.lastHookContext.key || String(live.lastHookContext.key) === selectedK);
    const recentModal = !!(live.lastModalOpenAt && now - live.lastModalOpenAt < 1500);
    const activeDecision = !!(live.currentDecision && !live.currentDecision.record.resolved);
    const hadModal = !!ctx || activeDecision || recentModal;
    const trusted = !!ctx || (!!hadModal && !!live.lastTrustedChoice && (now - (+live.lastTrustedChoice.at || 0) < 1200) && (!live.lastTrustedChoice.key || String(live.lastTrustedChoice.key) === selectedK));
    const autoBtn = document.querySelector('#modal button.auto[data-k]');
    const capture = {
      id: 'hc-' + now.toString(36) + '-' + (++live.hookSeq),
      lifeId,
      at: nowISO(),
      age: readAge(),
      year: readYear(),
      options,
      selectedK,
      selectedLabel: selected.label == null ? '' : String(selected.label),
      selectedSub: selected.sub == null ? '' : String(selected.sub),
      sig,
      decisionId: null,
      title: null,
      outcomeText: null,
      auto: null,
      autoEvidence: '',
      selectionMode: 'unknown',
      hadModal,
      trusted,
      autoClass: !!(autoBtn && String(autoBtn.getAttribute('data-k')) === selectedK),
      preDid: null,
      preDone: S ? clone(S.done || {}) : null,
      preAuto: S && S.stats ? (+S.stats.auto || 0) : null,
      logBaseline: S && Array.isArray(S.log) ? S.log.length : 0,
      enriched: false,
      matched: false,
      used: false,
    };
    state.hookCaptures.push(capture);
    live.lastHookContext = null;
    live.lastTrustedChoice = null;
    if (state.hookCaptures.length > 600) state.hookCaptures = state.hookCaptures.slice(-600);
    if (!activeDecision) captureAutoBefore(capture, S);
    setTimeout(() => enrichHookCapture(capture), 100);
    setTimeout(() => enrichHookCapture(capture), 400);
    setTimeout(() => enrichHookCapture(capture), 1000);
    saveState();
  }

  function enrichHookCapture(c) {
    if (!c || c.enriched) return;
    const life = state && state.lives ? state.lives[c.lifeId] : null;
    if (!life) return;
    const active = readActiveSave();
    const S = active && active.S;
    if (!S) return;
    const log = Array.isArray(S.log) ? S.log : [];
    let entry = null;
    const start = Math.max(0, (+c.logBaseline || 0) - 2);
    for (let i = log.length - 1; i >= start; i--) {
      const e = log[i];
      if (!e || e.kind !== 'dec') continue;
      if (c.selectedLabel && e.text && String(e.text).indexOf(String(c.selectedLabel)) >= 0) {
        entry = e;
        break;
      }
      if (!entry) entry = e;
    }
    const diffs = diffDone(S.done || {}, c.preDone || {});
    let id = entry && entry.dk != null ? String(entry.dk) : null;
    if (!id) {
      const ids = Object.keys(diffs).filter((x) => !(live.attributedIds && live.attributedIds.has(x)));
      if (ids.length) id = ids[0];
    }
    if (id) c.decisionId = id;
    if (entry) {
      if (!c.title && entry.q) c.title = String(entry.q);
      if (!c.outcomeText && entry.text) c.outcomeText = String(entry.text);
      if (c.age == null && entry.a != null) c.age = +entry.a;
    }
    const autoNow = S.stats ? (+S.stats.auto || 0) : 0;
    const preAuto = c.preAuto == null ? null : +c.preAuto;
    const trusted = !!c.hadModal && !!c.trusted;
    if (trusted) {
      c.auto = false;
      c.autoEvidence = 'trustedClick';
    } else if (preAuto != null && autoNow > preAuto) {
      c.auto = true;
      c.autoEvidence = 'statsAutoDelta';
    } else if (c.autoClass) {
      c.auto = true;
      c.autoEvidence = 'autoClass';
    } else if (!c.hadModal) {
      c.auto = true;
      c.autoEvidence = 'noModal';
    } else {
      c.auto = null;
      c.autoEvidence = 'none';
    }
    c.selectionMode = c.auto === true ? (c.hadModal ? 'auto' : 'auto-quiet') : (c.auto === false ? 'manual' : 'unknown');
    c.enriched = true;
    c.preDone = null;
    if (c.used) {
      const d = (life.decisions || []).find((x) => x && (x.hookId === c.id || (c.decisionId && x.decisionId != null && String(x.decisionId) === String(c.decisionId))));
      if (d) applyCaptureToDecision(d, c);
      saveState();
      updateUI();
      return;
    }
    mergeHookCapture(c);
  }

  function decisionMatchesCapture(d, c) {
    if (!d || !c) return false;
    if (d.hookId && d.hookId === c.id) return true;
    if (d.decisionId != null && c.decisionId != null && String(d.decisionId) === String(c.decisionId)) return true;
    const dk = (d.options || []).map((o) => String(o.k)).join('|');
    const ck = (c.options || []).map((o) => String(o.k)).join('|');
    if (d.age != null && c.age != null && +d.age !== +c.age) return false;
    if (d.selectedK != null && c.selectedK != null && String(d.selectedK) !== String(c.selectedK)) return false;
    if (dk && ck && dk === ck) {
      if (!d.at || !c.at) return true;
      const dt = Math.abs((Date.parse(d.at) || 0) - (Date.parse(c.at) || 0));
      return !isFinite(dt) || dt < 20000;
    }
    if (d.selectedK != null && c.selectedK != null && d.age != null && c.age != null && +d.age === +c.age) return true;
    return false;
  }

  function applyCaptureToDecision(d, c) {
    if (!d || !c) return;
    if (c.auto == null && d.auto === false) {
      c.auto = false;
      c.autoEvidence = 'trustedClick';
      c.selectionMode = 'manual';
    }
    if (!d.options || !d.options.length) {
      if (c.options && c.options.length) {
        d.options = c.options.slice();
        d.optionsKnown = true;
        d.optionsSource = 'hook';
      }
    } else if (c.options && c.options.length) {
      const seen = new Set((d.options || []).map((o) => String(o.k)));
      for (const o of c.options) {
        if (o && o.k != null && !seen.has(String(o.k))) {
          d.options.push({ k: o.k, label: o.label, sub: o.sub });
          seen.add(String(o.k));
        }
      }
      if (d.optionsSource === 'dom') d.optionsSource = 'dom+hook';
    }
    if (d.selectedK == null) d.selectedK = c.selectedK;
    if (d.selectedLabel == null) d.selectedLabel = c.selectedLabel;
    if (d.selectedSub == null) d.selectedSub = c.selectedSub;
    if (!d.title && c.title) d.title = c.title;
    if (!d.outcomeText && c.outcomeText) d.outcomeText = c.outcomeText;
    if (d.age == null && c.age != null) d.age = c.age;
    if (d.year == null && c.year) d.year = c.year;
    if (d.decisionId == null && c.decisionId != null) d.decisionId = c.decisionId;
    if (c.auto != null && (d.auto == null || d.source === 'backfill' || d.source === 'save-diff' || d.source === 'auto-hook' || d.source === 'hook')) {
      d.auto = c.auto;
      d.autoEvidence = c.autoEvidence || d.autoEvidence;
      d.selectionMode = c.auto === true ? (c.hadModal ? 'auto' : 'auto-quiet') : (c.auto === false ? 'manual' : d.selectionMode);
    }
    if (c.autoEvidence && (!d.autoEvidence || d.autoEvidence === 'none')) d.autoEvidence = c.autoEvidence;
    if (d.auto === true && d.selectionMode === 'backfill') d.selectionMode = 'auto-quiet';
    if (d.auto === false && d.selectionMode === 'backfill') d.selectionMode = 'manual';
    if (d.options && d.options.length) {
      d.captureConfidence = 'high';
      if (d.source === 'backfill' || d.source === 'save-diff') d.source = d.auto === false ? 'hook' : 'auto-hook';
      if (!d.optionsSource || d.optionsSource === 'none' || d.optionsSource === 'log') d.optionsSource = 'hook';
    } else if (d.captureConfidence === 'low' && (d.title || d.outcomeText)) {
      d.captureConfidence = 'medium';
      if (!d.optionsSource || d.optionsSource === 'none') d.optionsSource = 'log';
    }
    d.hookId = d.hookId || c.id;
    d.type = d.type || 'choice';
    d.possibleDuplicate = false;
    d.resolved = true;
  }

  function mergeHookCapture(c) {
    if (!c || c.used || !state) return;
    const life = state.lives[c.lifeId];
    if (!life) return;
    let target = null;
    let priority = -1;
    for (const d of life.decisions || []) {
      if (!decisionMatchesCapture(d, c)) continue;
      const p = d.source === 'live' ? 3 : (d.source === 'auto-hook' || d.source === 'hook' ? 2 : 1);
      if (p > priority) { target = d; priority = p; }
    }
    if (!target && c.decisionId != null) {
      target = (life.decisions || []).find((d) => d && d.decisionId != null && String(d.decisionId) === String(c.decisionId)) || null;
    }
    if (target) {
      applyCaptureToDecision(target, c);
      target.lifeId = target.lifeId || c.lifeId;
      attachHookStates(target, c);
      c.used = true;
      c.matched = true;
      if (target.decisionId != null && live.lifeId === c.lifeId) live.attributedIds.add(String(target.decisionId));
      saveState();
      updateUI();
      return;
    }
    if (c.decisionId == null) return;
    const rec = {
      id: 'hk-' + c.id,
      seq: (life.decisions || []).length + 1,
      source: c.auto === false ? 'hook' : 'auto-hook',
      type: 'choice',
      lifeId: c.lifeId,
      decisionId: c.decisionId,
      beforeStateId: null,
      afterStateId: null,
      at: c.at || nowISO(),
      age: c.age == null ? null : c.age,
      year: c.year || '',
      title: c.title || null,
      body: null,
      question: null,
      options: c.options,
      optionsKnown: c.options.length > 0,
      selectedK: c.selectedK,
      selectedLabel: c.selectedLabel || null,
      selectedSub: c.selectedSub || null,
      auto: c.auto,
      autoEvidence: c.autoEvidence || 'hook',
      selectionMode: c.selectionMode || (c.auto ? 'auto-quiet' : 'unknown'),
      optionsSource: 'hook',
      captureConfidence: c.auto == null ? 'medium' : 'high',
      outcomeText: c.outcomeText || '',
      decideMs: null,
      note: '',
      resolved: true,
      minimized: false,
      hookId: c.id,
      count: 1,
      possibleDuplicate: false,
    };
    life.decisions.push(rec);
    if (life.decisions.length > LIMITS.decisionsPerLife) life.decisions = life.decisions.slice(-LIMITS.decisionsPerLife);
    life.backfilledIds.push(String(c.decisionId));
    if (live.lifeId === c.lifeId) live.attributedIds.add(String(c.decisionId));
    attachHookStates(rec, c);
    c.used = true;
    c.matched = true;
    const label = String(c.selectedLabel || c.selectedK || '').slice(0, 60);
    showToast(c.auto === false ? 'choice' : 'auto', '已记录', (c.auto === false ? '选择了：' : '自动选择：') + label + (c.age != null ? ' · ' + c.age + '岁' : ''));
    saveState();
    updateUI();
  }

  function mergeHookCapturesForLife(life, S) {
    if (!state || !life) return;
    for (const c of state.hookCaptures) {
      if (!c || c.lifeId !== life.lifeId || c.used) continue;
      if (!c.enriched) enrichHookCapture(c);
      if (c.enriched || c.decisionId != null) mergeHookCapture(c);
    }
  }

  function matchHookCaptureForDecision(life, d) {
    if (!state || !life || !d) return;
    for (const c of state.hookCaptures) {
      if (!c || c.lifeId !== life.lifeId || c.used) continue;
      if (!decisionMatchesCapture(d, c)) continue;
      if (!c.enriched) enrichHookCapture(c);
      applyCaptureToDecision(d, c);
      d.lifeId = d.lifeId || life.lifeId;
      attachHookStates(d, c);
      c.used = true;
      c.matched = true;
      if (d.decisionId != null && live.lifeId === life.lifeId) live.attributedIds.add(String(d.decisionId));
      return;
    }
  }

  function attachHookCaptureToDecision(d) {
    if (!state || !live.lifeId || !d) return;
    const life = state.lives[live.lifeId];
    if (!life) return;
    for (const c of state.hookCaptures) {
      if (!c || c.lifeId !== life.lifeId || c.used) continue;
      if (!decisionMatchesCapture(d, c)) continue;
      applyCaptureToDecision(d, c);
      d.lifeId = d.lifeId || life.lifeId;
      attachHookStates(d, c);
      c.used = true;
      c.matched = true;
      return;
    }
  }

  function cleanOutcomeText(text) {
    const s = String(text == null ? '' : text);
    const i = Math.max(s.lastIndexOf('：'), s.lastIndexOf(':'));
    return i >= 0 ? s.slice(i + 1).trim() : s.trim();
  }

  function enrichDecisionFromLog(d, log) {
    if (!d || !Array.isArray(log)) return;
    let entry = null;
    if (d.decisionId != null) {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (e && e.kind === 'dec' && e.dk != null && String(e.dk) === String(d.decisionId)) { entry = e; break; }
      }
    }
    if (!entry && d.selectedLabel) {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (e && e.kind === 'dec' && e.text && String(e.text).indexOf(String(d.selectedLabel)) >= 0) { entry = e; break; }
      }
    }
    if (!entry && d.age != null) {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (e && e.kind === 'dec' && e.a != null && +e.a === +d.age) { entry = e; break; }
      }
    }
    if (!entry) return;
    if (!d.title && entry.q) d.title = String(entry.q);
    if (!d.outcomeText && entry.text) d.outcomeText = String(entry.text);
    if (d.age == null && entry.a != null) d.age = +entry.a;
    if (!d.selectedLabel && entry.text) d.selectedLabel = cleanOutcomeText(entry.text);
    if (!d.optionsSource || d.optionsSource === 'none') d.optionsSource = 'log';
    if (!d.captureConfidence || d.captureConfidence === 'low') d.captureConfidence = 'medium';
    d.type = d.type || 'choice';
  }

  function importSave(S, at, source, key) {
    const lifeId = lifeIdFromS(S);
    if (!lifeId || isLifeDeleted(lifeId)) return false;
    const existing = !!state.lives[lifeId];
    const meta = metaFromS(S);
    const life = ensureLife(lifeId, source, meta);
    if (!life) return false;
    life.meta = Object.assign({}, life.meta, meta, { saveKey: key || null, saveAt: at || null });
    if (source === 'live') {
      life.source = 'live';
      life.captureStatus = 'live';
    }
    const isNew = !existing;
    const baselineForApply = isNew ? {} : (life.baselineDone || {});
    let attributed;
    if (source === 'live' && live.lifeId === lifeId) {
      attributed = live.attributedIds;
    } else {
      attributed = new Set((life.decisions || []).filter((d) => d.source === 'live' && d.decisionId).map((d) => d.decisionId));
    }
    const unattributedLiveCount = countUnattributedLive(life);
    applySaveToLife(life, S, { baselineDone: baselineForApply, attributedIds: attributed, unattributedLiveCount });
    if (source === 'live' && (isNew || !life.baselineDone)) life.baselineDone = clone(S.done || {}) || {};
    if (S.lifeAt) {
      for (const id of Object.keys(state.lives)) {
        if (id !== lifeId && state.lives[id].source === 'backfill-summary' && String(state.lives[id].endedAt) === String(S.lifeAt)) delete state.lives[id];
      }
    }
    return !existing;
  }

  function backfillAll() {
    if (!state) return 0;
    const keys = listKeys();
    let imported = 0;
    const active = readActiveSave();
    if (active && active.S) {
      if (importSave(active.S, active.at, 'live', active.key)) imported++;
    }
    for (const k of keys.past) {
      const arr = lsGet(k, []);
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        if (row && row.S && importSave(row.S, row.at, 'backfill', k)) imported++;
      }
    }
    for (const k of keys.lives) {
      const arr = lsGet(k, []);
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        if (!row || row.at == null) continue;
        const exists = Object.keys(state.lives).some((id) => {
          const l = state.lives[id];
          return l && (String(l.endedAt) === String(row.at) || (l.result && String(l.result.lifeAt) === String(row.at)));
        });
        if (exists) continue;
        const id = 'l' + row.at;
        if (state.lives[id] || isLifeDeleted(id)) continue;
        const created = ensureLife(id, 'backfill-summary', {
          name: row.name || '',
          born: row.iso || '',
          sex: row.sex || '',
          era: '',
          by: row.y || '',
          age: row.age == null ? null : row.age,
          cause: row.cause || '',
          job: row.job || '',
        });
        if (!created) continue;
        const l = state.lives[id];
        l.endedAt = row.at;
        l.result = { summary: row, cause: row.cause || null, lifeAt: row.at };
        imported++;
      }
    }
    if (imported) {
      saveState(true);
      updateUI();
    }
    return imported;
  }

  function startLifeFromSave(S, source) {
    const lifeId = lifeIdFromS(S);
    if (!lifeId || isLifeDeleted(lifeId)) return null;
    if (live.deletedCurrentId && live.deletedCurrentId !== lifeId) live.deletedCurrentId = null;
    const meta = metaFromS(S);
    const existing = !!state.lives[lifeId];
    const life = ensureLife(lifeId, source || 'live', meta);
    if (!life) return null;
    if ((source || 'live') === 'live') {
      life.source = 'live';
      life.captureStatus = 'live';
    }
    const fresh = !!S.startedAt && (Date.now() - (+S.startedAt) < 120000);
    if (fresh && live.announcedLifeId !== lifeId) {
      live.announcedLifeId = lifeId;
      const sub = [meta.name, meta.born].filter(Boolean).join(' · ');
      showToast('start', '开始记录', sub || '新人生');
    }
    if (live.lifeId !== lifeId) {
      live.lifeId = lifeId;
      live.currentDecision = null;
      live.lastAge = null;
      live.lastFocus = null;
      live.lastFocusClickAt = 0;
      live.lastSnapHash = {};
      live.sheetOpen = false;
      live.deadSeen = false;
      live.baselineDone = life.baselineDone || clone(S.done || {}) || {};
      rebuildAttributedIds(life);
    }
    const isNew = !existing;
    const baselineForApply = isNew ? {} : (life.baselineDone || {});
    applySaveToLife(life, S, {
      baselineDone: baselineForApply,
      attributedIds: live.attributedIds,
      unattributedLiveCount: countUnattributedLive(life),
    });
    if ((source || 'live') === 'live' && (isNew || !life.baselineDone)) life.baselineDone = clone(S.done || {}) || {};
    clearWarn('nolife');
    if (live.pendingBirthText) {
      addSnapshot(lifeId, 'birth', live.pendingBirthText, 'birth');
      live.pendingBirthText = '';
    }
    saveState(true);
    updateUI();
    return life;
  }

  function readAge() {
    const el = $('#ageNum');
    if (!el) return null;
    const m = String(el.textContent || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  function readYear() {
    return textOf($('#ageYear'));
  }

  function findOptionButton(k) {
    for (const b of $$('#modal button[data-k]')) {
      if (b.getAttribute('data-k') === String(k)) return b;
    }
    return null;
  }

  function collectOptions(modal) {
    const out = [];
    const seen = new Set();
    for (const b of $$('button[data-k]', modal)) {
      const k = b.getAttribute('data-k');
      if (k == null || seen.has(k)) continue;
      seen.add(k);
      out.push({
        k,
        label: textOf(b.querySelector('b')) || textOf(b),
        sub: b.getAttribute('title') || '',
      });
    }
    return out;
  }

  function readNote() {
    const el = $('#decNote') || $('#modal textarea') || $('#modal input[type="text"]');
    return el && typeof el.value === 'string' ? el.value.trim().slice(0, 500) : '';
  }

  function scheduleFinalize() {
    if (!live.currentDecision || live.currentDecision.record.resolved) return;
    if (live.finalizeTimer) return;
    live.finalizeTimer = setTimeout(() => {
      live.finalizeTimer = 0;
      const modal = $('#modal');
      const peek = $('#decPeek');
      if (modal && !modal.hidden) return;
      if (peek && !peek.hidden) {
        if (live.currentDecision) live.currentDecision.minimized = true;
        return;
      }
      finalizeDecision('hidden');
    }, 350);
  }

  function checkModal(force) {
    const modal = $('#modal');
    if (!modal) return;
    const visible = !modal.hidden;
    if (visible) live.lastModalOpenAt = Date.now();
    if (!visible && !force) {
      if (live.currentDecision && !live.currentDecision.record.resolved) {
        const peek = $('#decPeek');
        if (peek && !peek.hidden) live.currentDecision.minimized = true;
        else scheduleFinalize();
      }
      return;
    }
    if (live.finalizeTimer) { clearTimeout(live.finalizeTimer); live.finalizeTimer = 0; }
    const dec = modal.querySelector('.dec');
    if (!dec) {
      if (visible) warnOnce('modalunparsed', '抉择弹窗结构无法识别，可能网站已改版。', 'high');
      return;
    }
    const options = collectOptions(modal);
    const title = textOf(modal.querySelector('.hd > span:first-child')) || textOf(modal.querySelector('.hd'));
    const age = readAge();
    const year = readYear();
    const question = textOf(modal.querySelector('.q'));
    const body = textOf(modal.querySelector('.bd')) || textOf(dec);
    const autoBtn = modal.querySelector('button.auto[data-k]');
    const autoK = autoBtn ? autoBtn.getAttribute('data-k') : null;
    if (!title && !options.length && !question) return;
    const isQuestion = !options.length && !!question;
    const sig = hashText([title, age, options.map((o) => o.k).join(','), question].join('|'));

    const cur = live.currentDecision;
    if (cur && !cur.record.resolved) {
      if (cur.sig === sig || (cur.record.title === title && cur.record.age === age && cur.record.question === question)) {
        cur.minimized = false;
        cur.autoK = autoK || cur.autoK;
        if (options.length > (cur.record.options || []).length) {
          cur.record.options = options;
          cur.record.optionsKnown = true;
        }
        if (isQuestion) {
          cur.record.type = 'question';
          cur.record.auto = false;
          cur.record.selectionMode = 'manual';
          cur.record.autoEvidence = 'question';
        }
        cur.sig = sig;
        clearWarn('modalunparsed');
        return;
      }
      finalizeDecision('replaced');
    }

    if (!live.lifeId) {
      const active = readActiveSave();
      if (active && active.S) {
        const id = lifeIdFromS(active.S);
        if (isLifeDeleted(id)) {
          live.deletedCurrentId = id;
          return;
        }
        if (active.S.phase === 'life' || active.S.phase === 'birth') startLifeFromSave(active.S, 'live');
      }
    }
    if (!live.lifeId) {
      warnOnce('nolife', '抉择出现但尚未识别到人生存档，暂未记录。', 'medium');
      return;
    }
    const life = ensureLife(live.lifeId, 'live', {});
    if (!life) return;

    const optionKeys = JSON.stringify(options.map((o) => o.k));
    for (let i = life.decisions.length - 1; i >= 0; i--) {
      const cand = life.decisions[i];
      if (!cand || cand.source !== 'live') continue;
      if (cand.resolved) break;
      if (cand.title === title && cand.age === age && JSON.stringify((cand.options || []).map((o) => o.k)) === optionKeys) {
        if (cand.preAuto == null) {
          const a = readActiveSave();
          cand.preAuto = a && a.S && a.S.stats ? (+a.S.stats.auto || 0) : null;
        }
        live.currentDecision = { sig, record: cand, openedAt: Date.now(), autoK, minimized: false };
        clearWarn('bundle');
        clearWarn('modalunparsed');
        return;
      }
    }

    const activeAtOpen = readActiveSave();
    const rec = {
      id: 'd' + (life.decisions.length + 1) + '-' + Date.now().toString(36),
      seq: life.decisions.length + 1,
      source: 'live',
      type: isQuestion ? 'question' : 'choice',
      lifeId: live.lifeId,
      decisionId: null,
      beforeStateId: null,
      afterStateId: null,
      at: nowISO(),
      age,
      year,
      title,
      body,
      question,
      options,
      optionsKnown: options.length > 0,
      selectedK: null,
      selectedLabel: null,
      selectedSub: null,
      auto: isQuestion ? false : null,
      autoEvidence: isQuestion ? 'question' : 'none',
      selectionMode: isQuestion ? 'manual' : null,
      optionsSource: options.length ? 'dom' : 'none',
      captureConfidence: options.length || isQuestion ? 'high' : 'medium',
      outcomeText: '',
      decidedAt: null,
      decideMs: null,
      note: '',
      resolved: false,
      minimized: false,
      hadModal: true,
      preDone: activeAtOpen && activeAtOpen.S ? clone(activeAtOpen.S.done || {}) : null,
      preAuto: activeAtOpen && activeAtOpen.S && activeAtOpen.S.stats ? (+activeAtOpen.S.stats.auto || 0) : null,
      possibleDuplicate: false,
    };
    life.decisions.push(rec);
    if (life.decisions.length > LIMITS.decisionsPerLife) life.decisions = life.decisions.slice(-LIMITS.decisionsPerLife);
    live.currentDecision = { sig, record: rec, openedAt: Date.now(), autoK, minimized: false };
    attachHookCaptureToDecision(rec);
    captureDecisionBefore(rec, activeAtOpen && activeAtOpen.S);
    addSnapshot(live.lifeId, 'decision', modal.innerText, rec.id);
    clearWarn('bundle');
    clearWarn('modalunparsed');
    saveState(true);
    updateUI();
  }

  function finalizeDecision(reason) {
    const cur = live.currentDecision;
    if (!cur) return;
    const rec = cur.record;
    if (rec.resolved) { live.currentDecision = null; return; }
    const isQuestion = rec.type === 'question' || (!rec.optionsKnown && !!rec.question);
    if (cur.autoK) {
      rec.selectedK = cur.autoK;
      const btn = findOptionButton(cur.autoK);
      if (btn) {
        rec.selectedLabel = textOf(btn.querySelector('b')) || textOf(btn);
        rec.selectedSub = btn.getAttribute('title') || '';
      }
    }
    if (isQuestion) {
      rec.auto = false;
      rec.selectionMode = 'manual';
      rec.autoEvidence = 'question';
    } else if (cur.autoK) {
      rec.auto = true;
      rec.selectionMode = 'auto';
      rec.autoEvidence = 'autoClass';
    } else {
      rec.auto = null;
      rec.selectionMode = 'unknown';
      rec.autoEvidence = 'none';
    }
    rec.resolved = true;
    rec.lifeId = rec.lifeId || live.lifeId;
    rec.decidedAt = nowISO();
    rec.decideMs = Math.max(0, Date.now() - cur.openedAt);
    rec.resolveReason = reason || 'hidden';
    rec.note = rec.note || readNote();
    markDecisionAfter(rec);
    attachHookCaptureToDecision(rec);
    if (!rec.preDone) {
      const a = readActiveSave();
      rec.preDone = a && a.S ? clone(a.S.done || {}) : null;
    }
    const pre = rec.preDone;
    rec.preDone = null;
    live.currentDecision = null;
    if (reason !== 'replaced') {
      if (isQuestion) {
        showToast('choice', '已记录', '问题/文字回答已记录' + (rec.age != null ? ' · ' + rec.age + '岁' : ''));
      } else if (rec.auto === true) {
        const label = String(rec.selectedLabel || rec.selectedK || '').slice(0, 60);
        showToast('auto', '已记录', (label ? '自动选择：' + label : '自动/未点击') + (rec.age != null ? ' · ' + rec.age + '岁' : ''));
      } else {
        showToast('choice', '已记录', '未捕获点击' + (rec.age != null ? ' · ' + rec.age + '岁' : ''));
      }
    }
    saveState(true);
    attributeDecision(rec, pre);
    updateUI();
  }

  function attributeDecision(rec, preDone) {
    if (!rec || !live.lifeId) return;
    if (!preDone) { rec.attributionFailed = true; return; }
    const delays = [120, 300, 700, 1500, 3000];
    let i = 0;
    const attempt = () => {
      const active = readActiveSave();
      const S = active && active.S;
      if (S) {
        const diffs = diffDone(S.done || {}, preDone);
        const ids = Object.keys(diffs);
        if (ids.length) {
          ids.sort((a, b) => (diffs[b] || 0) - (diffs[a] || 0));
          const id = ids[0];
          rec.decisionId = id;
          rec.saveSelectedK = (S.flags && S.flags.way && S.flags.way[id] != null) ? S.flags.way[id] : null;
          if (rec.saveSelectedK != null) {
            if (rec.selectedK != null && String(rec.selectedK) !== String(rec.saveSelectedK)) {
              rec.selectedLabel = null;
              rec.selectedSub = null;
            }
            rec.selectedK = rec.saveSelectedK;
          }
          attachHookCaptureToDecision(rec);
          if (rec.type === 'question' || (!rec.optionsKnown && !!rec.question)) {
            rec.auto = false;
            rec.selectionMode = 'manual';
            rec.autoEvidence = 'question';
          } else if (rec.selectionMode === 'manual' || rec.auto === false) {
            rec.auto = false;
            rec.selectionMode = 'manual';
            if (!rec.autoEvidence || rec.autoEvidence === 'none') rec.autoEvidence = 'click';
          } else if (rec.preAuto != null && S.stats) {
            const autoNow = +S.stats.auto || 0;
            if (autoNow > (+rec.preAuto || 0)) {
              rec.auto = true;
              rec.selectionMode = 'auto';
              rec.autoEvidence = 'statsAutoDelta';
            } else if (rec.auto == null) {
              rec.auto = null;
              rec.selectionMode = 'unknown';
              rec.autoEvidence = 'none';
            }
          }
          if (rec.options && rec.options.length) {
            rec.captureConfidence = 'high';
            if (!rec.optionsSource || rec.optionsSource === 'none') rec.optionsSource = 'dom';
          } else if (rec.type === 'question') {
            rec.captureConfidence = 'high';
          } else if (rec.captureConfidence !== 'high') {
            rec.captureConfidence = rec.source === 'live' ? 'medium' : 'low';
          }
          live.attributedIds.add(id);
          clearWarn('attrfail');
          saveState(true);
          updateUI();
          return;
        }
      }
      if (i < delays.length) {
        const d = delays[i++];
        setTimeout(attempt, d);
      } else {
        rec.attributionFailed = true;
        warnOnce('attrfail', '有抉择未能对应到存档 id（记录仍保留，可能与补录条目重复）。');
        saveState();
      }
    };
    setTimeout(attempt, 150);
  }

  function onChoice(e) {
    const btn = e.target && e.target.closest ? e.target.closest('#modal button[data-k]') : null;
    if (!btn) return;
    if (!live.currentDecision) checkModal(true);
    const cur = live.currentDecision;
    if (!cur || cur.record.resolved) return;
    const rec = cur.record;
    const k = btn.getAttribute('data-k');
    const trusted = !!(e && e.isTrusted);
    if (trusted) {
      live.lastTrustedChoice = { at: Date.now(), key: String(k), sig: cur.sig, age: rec.age, kind: 'decision' };
      live.lastHookContext = { at: Date.now(), key: String(k), sig: cur.sig, age: rec.age, hadModal: true };
    }
    rec.selectedK = k;
    rec.selectedLabel = textOf(btn.querySelector('b')) || textOf(btn);
    rec.selectedSub = btn.getAttribute('title') || '';
    rec.type = rec.type || 'choice';
    rec.auto = false;
    rec.selectionMode = 'manual';
    rec.autoEvidence = trusted ? 'trustedClick' : 'click';
    rec.optionsSource = rec.optionsSource || 'dom';
    rec.captureConfidence = rec.options && rec.options.length ? 'high' : 'medium';
    rec.resolved = true;
    rec.lifeId = rec.lifeId || live.lifeId;
    rec.decidedAt = nowISO();
    rec.decideMs = Math.max(0, Date.now() - cur.openedAt);
    rec.note = readNote() || rec.note || '';
    markDecisionAfter(rec);
    attachHookCaptureToDecision(rec);
    if (!rec.preDone) {
      const a = readActiveSave();
      rec.preDone = a && a.S ? clone(a.S.done || {}) : null;
    }
    const pre = rec.preDone;
    rec.preDone = null;
    live.currentDecision = null;
    const label = String(rec.selectedLabel || k || '').slice(0, 60);
    showToast(rec.auto === true ? 'auto' : 'choice', '已记录', (rec.auto === true ? '自动选择：' : '选择了：') + label + (rec.age != null ? ' · ' + rec.age + '岁' : ''));
    saveState(true);
    attributeDecision(rec, pre);
    updateUI();
  }

  function onInput(e) {
    const t = e.target;
    if (!t || t.id !== 'decNote') return;
    if (live.currentDecision && !live.currentDecision.record.resolved) {
      live.currentDecision.record.note = String(t.value || '').slice(0, 500);
    }
  }

  function collectFocusOptions(container) {
    const roots = [];
    if (container) roots.push(container);
    const fc = $('#focusChips');
    if (fc) roots.push(fc);
    const mb = $('#mbPick');
    if (mb) roots.push(mb);
    const out = [];
    const seen = new Set();
    for (const r of roots) {
      for (const b of $$('button[data-focus]', r)) {
        const k = b.getAttribute('data-focus');
        if (!k || seen.has(k)) continue;
        seen.add(k);
        const lines = textOf(b).split('\n');
        out.push({ k, label: (lines[0] || '').trim(), desc: textOf(b.querySelector('small')) });
      }
    }
    return out;
  }

  function currentFocusKey() {
    const b = $('[data-focus][aria-pressed="true"]');
    return b ? b.getAttribute('data-focus') : null;
  }

  function recordFocus(k, auto, source) {
    if (!live.lifeId || !k) return false;
    const life = state.lives[live.lifeId];
    if (!life) return false;
    const rec = {
      at: nowISO(),
      age: readAge(),
      year: readYear(),
      options: collectFocusOptions(),
      selectedK: k,
      auto: !!auto,
      autoEvidence: auto ? (source === 'age' ? 'ageChange' : 'statsAuto') : 'trustedClick',
      selectionMode: auto ? 'auto' : 'manual',
      source: source || 'click',
    };
    const last = life.focusPicks[life.focusPicks.length - 1];
    if (last && last.selectedK === k && last.age === rec.age && (last.options || []).length === rec.options.length) return false;
    life.focusPicks.push(rec);
    if (life.focusPicks.length > LIMITS.focusPerLife) life.focusPicks = life.focusPicks.slice(-LIMITS.focusPerLife);
    live.lastFocus = k;
    saveState();
    updateUI();
    return true;
  }

  function onFocusClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-focus]') : null;
    if (!b) return;
    const k = b.getAttribute('data-focus');
    if (!k) return;
    live.lastFocusClickAt = Date.now();
    if (e && e.isTrusted) live.lastTrustedChoice = { at: Date.now(), key: String(k), kind: 'focus' };
    if (recordFocus(k, false, 'click')) {
      const label = String((textOf(b).split('\n')[0] || k)).slice(0, 40);
      showToast('choice', '已记录', '重心：' + label);
    }
  }

  function checkFocusAtAge() {
    const k = currentFocusKey();
    if (!k || k === live.lastFocus) return;
    const active = readActiveSave();
    const S = active && active.S;
    const auto = (Date.now() - live.lastFocusClickAt > 1500) || !!(S && S.flags && S.flags.au && !S.flags.focusOwn);
    recordFocus(k, auto, 'age');
  }

  function checkAge() {
    const age = readAge();
    const lv = $('#lifeview');
    if (age == null || !lv || lv.hidden) return;
    if (age === live.lastAge) return;
    live.lastAge = age;
    if (live.lifeId) {
      addSnapshot(live.lifeId, 'year', lv.innerText, 'age-' + age);
      checkFocusAtAge();
    }
  }

  function checkSheet() {
    const sh = $('#sheet');
    if (!sh) return;
    const open = !sh.hidden;
    if (open && !live.sheetOpen) {
      live.sheetOpen = true;
      if (live.sheetTimer) clearTimeout(live.sheetTimer);
      live.sheetTimer = setTimeout(() => {
        const el = $('#sheet');
        if (live.lifeId && el && !el.hidden) addSnapshot(live.lifeId, 'sheet', el.innerText, 'sheet');
      }, 150);
    } else if (!open && live.sheetOpen) {
      live.sheetOpen = false;
    }
  }

  function checkDead() {
    const d = $('#dead');
    if (!d || d.hidden) { live.deadSeen = false; return; }
    if (live.deadSeen) return;
    const txt = textOf(d);
    if (!txt) return;
    live.deadSeen = true;
    const active = readActiveSave();
    if (active && active.S && isLifeDeleted(lifeIdFromS(active.S))) return;
    if (active && active.S && (active.S.phase === 'life' || active.S.phase === 'dead' || active.S.phase === 'birth')) {
      const life = startLifeFromSave(active.S, 'live');
      if (life) {
        life.endedAt = active.S.lifeAt || life.endedAt;
        captureStateFromSave(active.S, active.at, active.key, 'death');
        addSnapshot(life.lifeId, 'death', d.innerText, 'death');
        saveState(true);
      }
    } else if (live.lifeId) {
      addSnapshot(live.lifeId, 'death', d.innerText, 'death');
    }
    const lifeRec = live.lifeId && state.lives[live.lifeId] ? state.lives[live.lifeId] : null;
    const age = active && active.S && active.S.age != null ? active.S.age : (lifeRec && lifeRec.meta ? lifeRec.meta.age : null);
    const name = lifeRec && lifeRec.meta ? lifeRec.meta.name : '';
    showToast('death', '完成此人生记录', [name, age != null ? '活到 ' + age + ' 岁' : ''].filter(Boolean).join(' · ') || '这一生已存档');
    updateUI();
  }

  function checkLifeview() {
    const lv = $('#lifeview');
    if (!lv) return;
    if (lv.hidden) return;
    if (!live.lifeId) {
      const active = readActiveSave();
      if (active && active.S && (active.S.phase === 'life' || active.S.phase === 'birth')) startLifeFromSave(active.S, 'live');
    }
    if (live.lifeId && live.lastAge == null) checkAge();
  }

  function snapshotSettings() {
    const prefs = readPrefs();
    const compactPrefs = {};
    for (const k of ['era', 'eraAny', 'eraYr', 'mode', 'pace', 'home', 'homeHand', 'edu', 'soft', 'speed', 'auto', 'lean', 'reflect', 'music', 'a2hs']) {
      if (prefs[k] !== undefined) compactPrefs[k] = prefs[k];
    }
    return {
      dom: {
        era: attr($('[data-era][aria-pressed="true"]'), 'data-era'),
        eraYear: $('#eraYr') ? $('#eraYr').value : null,
        eraYearText: selectedText($('#eraYr')),
        mode: attr($('[data-mode][aria-pressed="true"]'), 'data-mode'),
        pace: attr($('[data-pace][aria-pressed="true"]'), 'data-pace'),
        home: $('#homeSel') ? $('#homeSel').value : null,
        homeText: selectedText($('#homeSel')),
        music: attr($('[data-music][aria-pressed="true"]'), 'data-music'),
        soft: attr($('#softBtn2'), 'aria-pressed') === 'true' || attr($('#softBtn'), 'aria-pressed') === 'true',
        auto: attr($('#autoBtn'), 'aria-pressed') === 'true',
        lean: attr($('#leanBtn'), 'aria-pressed') === 'true',
        speed: attr($('[data-speed][aria-pressed="true"]'), 'data-speed'),
      },
      prefs: compactPrefs,
    };
  }

  function buildSettingsCatalog() {
    const list = (sel, name) => $$(sel).map((b) => ({ k: b.getAttribute(name), label: textOf(b) })).filter((x) => x.k != null);
    const optionsOf = (sel) => {
      const el = $(sel);
      if (!el || !el.options) return [];
      return Array.from(el.options).map((o) => ({ k: o.value, label: String(o.textContent || o.text || '').trim() }));
    };
    return {
      era: list('[data-era]', 'data-era'),
      mode: list('[data-mode]', 'data-mode'),
      pace: list('[data-pace]', 'data-pace'),
      home: optionsOf('#homeSel'),
      eraYear: optionsOf('#eraYr'),
      music: list('[data-music]', 'data-music'),
    };
  }

  function refreshSettingsCatalog() {
    if (!state) return;
    const c = buildSettingsCatalog();
    if (JSON.stringify(state.settingsCatalog) !== JSON.stringify(c)) {
      state.settingsCatalog = c;
      saveState();
    }
  }

  function recordSettings(reason, force) {
    refreshSettingsCatalog();
    const snap = snapshotSettings();
    const h = hashText(JSON.stringify(snap));
    if (!force && h === live.lastSettingsHash) return;
    live.lastSettingsHash = h;
    state.settings = snap;
    state.settingsEvents.push({ at: nowISO(), reason: reason || 'change', selectionMode: 'manual', optionsSource: 'catalog', settings: snap });
    if (state.settingsEvents.length > LIMITS.settingsEvents) state.settingsEvents = state.settingsEvents.slice(-LIMITS.settingsEvents);
    saveState(true);
    updateUI();
  }

  function ensureSettingsBaseline() {
    if (!state) return;
    try {
      const snap = snapshotSettings();
      if (!state.settings) state.settings = snap;
      if (!state.settingsEvents.some((e) => e && e.reason === 'baseline')) {
        state.settingsEvents.push({ at: nowISO(), reason: 'baseline', selectionMode: 'manual', optionsSource: 'catalog', settings: snap });
        if (state.settingsEvents.length > LIMITS.settingsEvents) state.settingsEvents = state.settingsEvents.slice(-LIMITS.settingsEvents);
        saveState(true);
      }
    } catch (_) {}
  }

  function reclassifyHistoryWarning() {
    if (!state) return;
    let history = 0;
    for (const id of Object.keys(state.lives || {})) {
      for (const d of (state.lives[id].decisions || [])) {
        if (d && (d.source === 'backfill' || d.source === 'save-diff') && !(d.options && d.options.length)) history++;
      }
    }
    state.diagnostics.warnings = (state.diagnostics.warnings || []).filter((w) => w && w.code !== 'missed' && w.code !== 'history-backfill');
    state.diagnostics.missedDecisions = 0;
    if (history > 0) {
      state.diagnostics.warnings.push({
        code: 'history-backfill',
        msg: '历史补录 ' + history + ' 条：只保留结果/题目，候选项无法还原。',
        severity: 'low',
        at: nowISO(),
      });
      if (state.diagnostics.warnings.length > LIMITS.warnings) state.diagnostics.warnings = state.diagnostics.warnings.slice(-LIMITS.warnings);
    }
    saveState();
    updateUI();
  }

  function onSettingClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#startBtn') || t.closest('#startBtn2')) {
      state.introText = textOf($('#intro .opts')) || state.introText || '';
      setTimeout(() => recordSettings('start', true), 30);
      return;
    }
    let reason = null;
    if (t.closest('[data-era]')) reason = 'era';
    else if (t.closest('[data-mode]')) reason = 'mode';
    else if (t.closest('[data-pace]')) reason = 'pace';
    else if (t.closest('[data-music]')) reason = 'music';
    else if (t.closest('#softBtn') || t.closest('#softBtn2')) reason = 'soft';
    else if (t.closest('#autoBtn')) reason = 'auto';
    else if (t.closest('#leanBtn')) reason = 'lean';
    else if (t.closest('[data-speed]')) reason = 'speed';
    if (reason) setTimeout(() => recordSettings(reason), 30);
  }

  function onChangeCapture(e) {
    const t = e.target;
    if (!t) return;
    if (t.id === 'homeSel') setTimeout(() => recordSettings('home'), 40);
    else if (t.id === 'eraYr') setTimeout(() => recordSettings('eraYear'), 40);
  }

  function readAndStart() {
    const active = readActiveSave();
    if (active && active.S && (active.S.phase === 'life' || active.S.phase === 'birth')) startLifeFromSave(active.S, 'live');
  }

  function onBeginClick(e) {
    const t = e.target;
    if (!t || !t.closest || !t.closest('#beginBtn')) return;
    const cert = $('#cert');
    const txt = cert ? cert.innerText : '';
    if (txt) live.pendingBirthText = txt;
    setTimeout(readAndStart, 0);
    setTimeout(readAndStart, 250);
    setTimeout(readAndStart, 900);
    setTimeout(readAndStart, 2500);
    setTimeout(() => recordSettings('birth', true), 30);
  }

  function detectBundle() {
    let src = '';
    for (const s of $$('script[src]')) {
      if (/\/a\/[^/]+\.js/.test(s.src)) { src = s.src; break; }
    }
    if (!src) return null;
    const m = src.match(/\/a\/([^/]+?)\.([0-9a-f]{6,})\.js/);
    const info = { src, lang: m ? m[1] : null, hash: m ? m[2] : null };
    const prev = state.diagnostics.bundle;
    state.diagnostics.bundle = info;
    if (prev && prev.hash && info.hash && prev.hash !== info.hash) {
      warn('bundle', '网站前端已更新（' + prev.hash + ' → ' + info.hash + '），请验证提取器是否正常。', 'medium');
    }
    state.diagnostics.lastBundleHash = info.hash || state.diagnostics.lastBundleHash;
    return info;
  }

  function checkAnchors() {
    if (!state) return;
    const anchors = { app: !!$('#app'), modal: !!$('#modal'), focus: !!$('#focusChips') };
    state.diagnostics.anchors = anchors;
    const missing = Object.keys(anchors).filter((k) => !anchors[k]);
    if (missing.length) warnOnce('anchors', '提取器关键元素缺失：' + missing.join(', ') + '。可能网站已改版。', 'high');
    else clearWarn('anchors');
    const lv = $('#lifeview');
    if (lv && !lv.hidden && !listKeys().save.length) {
      warnOnce('savekey', '未找到游戏存档 key，补录可能不可用。', 'medium');
    } else {
      clearWarn('savekey');
    }
    state.diagnostics.lastCheckAt = nowISO();
  }

  function checkMissed(life, S) {
    if (!life || !life.baselineDone) return;
    mergeHookCapturesForLife(life, S);
    const diffs = diffDone(S.done || {}, life.baselineDone);
    const ids = Object.keys(diffs);
    if (!ids.length) {
      if (+state.diagnostics.missedDecisions || 0) {
        state.diagnostics.missedDecisions = 0;
        clearWarn('missed');
        saveState(true);
        updateUI();
      }
      return;
    }
    const accounted = new Set();
    for (const d of life.decisions || []) {
      if (d && d.decisionId != null) accounted.add(String(d.decisionId));
    }
    for (const c of state.hookCaptures) {
      if (c && c.lifeId === life.lifeId && c.decisionId != null && c.used) accounted.add(String(c.decisionId));
    }
    let added = 0;
    let trueMissed = 0;
    let pendingLive = (life.decisions || []).filter((d) => d && d.source === 'live' && d.decisionId == null).length;
    for (const id of ids) {
      if (accounted.has(String(id))) continue;
      if ((life.backfilledIds || []).indexOf(id) >= 0) { accounted.add(String(id)); continue; }
      if (pendingLive > 0) { pendingLive--; continue; }
      const way = S.flags && S.flags.way && S.flags.way[id] != null ? S.flags.way[id] : null;
      const entry = {
        id: 'sd-' + id + '-' + Date.now().toString(36) + '-' + added,
        seq: null,
        source: 'save-diff',
        type: 'choice',
        decisionId: id,
        at: null,
        age: null,
        year: null,
        title: null,
        body: null,
        question: null,
        options: null,
        optionsKnown: false,
        selectedK: way,
        selectedLabel: null,
        selectedSub: null,
        auto: null,
        autoEvidence: 'backfill',
        selectionMode: 'backfill',
        optionsSource: 'none',
        captureConfidence: 'low',
        outcomeText: '',
        decideMs: null,
        note: '',
        resolved: true,
        count: diffs[id],
        possibleDuplicate: false,
      };
      enrichDecisionFromLog(entry, S.log);
      matchHookCaptureForDecision(life, entry);
      if (!(entry.options && entry.options.length)) {
        const cap = state.hookCaptures.find((c) => c && c.lifeId === life.lifeId && !c.used && c.decisionId != null && String(c.decisionId) === String(id));
        if (cap) {
          mergeHookCapture(cap);
          if (life.decisions.some((d) => d && d.decisionId != null && String(d.decisionId) === String(id))) {
            accounted.add(String(id));
            continue;
          }
        }
      }
      if (entry.options && entry.options.length) {
        entry.source = entry.auto === false ? 'hook' : 'auto-hook';
        entry.selectionMode = entry.auto === false ? 'manual' : (entry.auto === true ? (entry.hadModal ? 'auto' : 'auto-quiet') : 'unknown');
        entry.captureConfidence = 'high';
      } else {
        trueMissed++;
      }
      life.decisions.push(entry);
      life.backfilledIds.push(id);
      accounted.add(String(id));
      added++;
    }
    if (trueMissed > 0) {
      state.diagnostics.missedDecisions = trueMissed;
      warn('missed', '检测到 ' + trueMissed + ' 条实时未捕获且无法补全选项的抉择；已标为历史补录。', 'medium');
      saveState(true);
      updateUI();
    } else {
      state.diagnostics.missedDecisions = 0;
      clearWarn('missed');
      if (added) {
        saveState(true);
        updateUI();
      }
    }
  }

  function poll() {
    safe(checkModal, 'checkModal');
    safe(checkSheet, 'checkSheet');
    safe(checkAge, 'checkAge');
    safe(checkLifeview, 'checkLifeview');
    safe(checkDead, 'checkDead');
  }

  function pollSave() {
    safe(() => {
      const active = readActiveSave();
      if (!active || !active.S) { checkAnchors(); return; }
      if (active.raw && active.raw !== live.lastSaveRaw) onSaveWrite(active.key, active.raw);
      const S = active.S;
      const activeLifeId = lifeIdFromS(S);
      if (isLifeDeleted(activeLifeId)) {
        if (live.lifeId === activeLifeId) {
          live.lifeId = null;
          live.currentDecision = null;
          live.attributedIds = new Set();
          live.pendingAfter = [];
        }
        live.deletedCurrentId = activeLifeId;
        checkAnchors();
        detectBundle();
        return;
      }
      if (S.stats) live.lastAutoCount = +S.stats.auto || 0;
      captureCountryNow();
      if (S.startedAt && live.lifeId !== lifeIdFromS(S) && (S.phase === 'life' || S.phase === 'birth')) {
        startLifeFromSave(S, 'live');
      }
      if (live.lifeId) {
        const life = state.lives[live.lifeId];
        if (life) {
          life.meta.age = S.age == null ? life.meta.age : S.age;
          if (S.lifeAt) life.endedAt = S.lifeAt;
          checkMissed(life, S);
        }
      }
      checkAnchors();
      detectBundle();
    }, 'pollSave');
  }

  const UI_CSS = [
    '.banner{position:fixed;top:8px;left:50%;transform:translateX(-50%);max-width:min(720px,92vw);background:#fff8e1;color:#5a4300;border:1px solid #e6c86e;border-radius:10px;padding:8px 34px 8px 12px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:auto;z-index:2147483647;word-break:break-word}',
    '.banner.high{background:#fdecea;color:#7a1c1c;border-color:#e6a1a1}',
    '.banner .icon{position:absolute;right:6px;top:4px}',
    '.toasts{position:fixed;top:12px;right:12px;display:flex;flex-direction:column;gap:8px;max-width:min(340px,92vw);pointer-events:none;z-index:2147483647}',
    '.toast{pointer-events:auto;background:#13212a;color:#fff;border-left:4px solid #2ecc71;border-radius:10px;padding:8px 12px;box-shadow:0 10px 30px rgba(0,0,0,.28);font:12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease;cursor:pointer;word-break:break-word}',
    '.toast.show{opacity:1;transform:none}',
    '.toast.start{border-left-color:#3498db}',
    '.toast.choice{border-left-color:#2ecc71}',
    '.toast.auto{border-left-color:#f1c40f}',
    '.toast.death{border-left-color:#e74c3c}',
    '.toast .t{font-weight:700;font-size:13px}',
    '.toast .s{opacity:.85;font-size:12px;margin-top:2px}',
    '.fab{position:fixed;right:16px;bottom:96px;display:flex;align-items:center;gap:6px;border:1px solid rgba(0,0,0,.15);background:#13212a;color:#fff;border-radius:999px;padding:7px 12px;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;pointer-events:auto;z-index:2147483647}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#2ecc71;display:inline-block}',
    '.dot.med{background:#f1c40f}.dot.high{background:#e74c3c}',
    '.panel{position:fixed;right:16px;bottom:150px;width:min(480px,94vw);max-height:76vh;overflow:auto;background:#fff;color:#17222b;border:1px solid rgba(0,0,0,.15);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.28);font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto;z-index:2147483647;padding:12px}',
    '.ph{display:flex;align-items:center;gap:6px;margin-bottom:8px}',
    '.ph b{font-size:13.5px}',
    '.ph .back{flex:0 0 auto}',
    '.backlink{border:0;background:transparent;color:#2b5c88;padding:2px 0;font:12px/1.3 inherit;cursor:pointer;text-align:left}',
    '.backlink:hover{text-decoration:underline}',
    '.status{margin-left:auto}',
    '.status{margin-left:auto;padding:2px 8px;border-radius:999px;background:#eef7ee;color:#1e6b2f;font-size:11.5px}',
    '.status.med{background:#fff6d8;color:#7a5a00}.status.high{background:#fdecea;color:#8a1f1f}',
    '.icon{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}',
    '.icon:hover{background:rgba(0,0,0,.06)}',
    '.body{display:flex;flex-direction:column;gap:8px}',
    '.row{display:flex;gap:6px;flex-wrap:wrap}',
    '.row button{flex:1 1 auto;border:1px solid rgba(0,0,0,.14);background:#f6f7f8;color:inherit;border-radius:8px;padding:7px 8px;font:12px/1.2 inherit;cursor:pointer}',
    '.row button:hover{background:#eceef0}',
    '.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px}',
    '.kv span:nth-child(odd){color:#66727c}',
    '.warn{border-left:3px solid #f1c40f;background:#fffaf0;padding:6px 8px;border-radius:6px;margin-top:4px;white-space:pre-wrap;word-break:break-word}',
    '.warn.high{border-color:#e74c3c;background:#fff5f5}',
    '.muted{color:#66727c}',
    '.sep{height:1px;background:rgba(0,0,0,.08);margin:4px 0}',
    '.life-list{display:flex;flex-direction:column;gap:6px}',
    '.life-item{display:block;width:100%;text-align:left;border:1px solid rgba(0,0,0,.14);background:#f7f8f9;color:inherit;border-radius:9px;padding:8px 9px;font:12px/1.4 inherit;cursor:pointer;word-break:break-word}',
    '.life-item:hover{background:#eef2f5}',
    '.life-item.current{border-color:#5b9bd5;background:#f1f7fd}',
    '.li-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.li-name{font-weight:700;font-size:13px}',
    '.li-sub,.li-counts{color:#66727c;font-size:11.5px;margin-top:2px}',
    '.badge{padding:1px 6px;border-radius:999px;background:#e8f3e9;color:#25652f;font-size:10.5px;font-weight:600}',
    '.badge.old{background:#f1f1f1;color:#666}',
    '.tabs,.filters{display:flex;gap:5px;flex-wrap:wrap}',
    '.tab,.filter{border:1px solid rgba(0,0,0,.14);background:#f6f7f8;color:inherit;border-radius:999px;padding:4px 9px;font:11.5px/1.2 inherit;cursor:pointer}',
    '.tab.active,.filter.active{background:#13212a;color:#fff;border-color:#13212a}',
    '.dec-list,.tl-list,.focus-list{display:flex;flex-direction:column;gap:6px}',
    '.dec-item{border:1px solid rgba(0,0,0,.12);border-radius:9px;background:#fbfbfc;padding:6px 8px}',
    '.dec-item[open]{background:#fff}',
    '.dec-item summary{cursor:pointer;list-style:none;outline:none}',
    '.dec-item summary::-webkit-details-marker{display:none}',
    '.dec-item summary:before{content:"▸";display:inline-block;width:12px;color:#77838d}',
    '.dec-item[open] summary:before{content:"▾"}',
    '.dec-title{font-weight:600;word-break:break-word}',
    '.dec-meta{display:block;color:#66727c;font-size:11px;margin:2px 0 0 12px;word-break:break-word}',
    '.dec-body{margin:7px 0 1px 12px;font-size:11.5px}',
    '.dec-line{margin:2px 0;word-break:break-word}',
    '.opts{display:flex;flex-direction:column;gap:3px;margin:5px 0 0}',
    '.opt{display:flex;align-items:flex-start;gap:6px;border:1px solid rgba(0,0,0,.09);border-radius:6px;padding:4px 6px;background:#fff}',
    '.opt.sel{border-color:#78b887;background:#f1faf3}',
    '.opt-k{color:#66727c;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;flex:0 0 auto}',
    '.opt-label{font-weight:600;word-break:break-word}',
    '.opt-sub{color:#66727c;font-size:10.5px;margin-left:auto;text-align:right;word-break:break-word}',
    '.dnote{border-left:3px solid #f1c40f;background:#fffaf0;padding:4px 6px;border-radius:4px;margin-top:5px}',
    '.tl-item{display:flex;gap:7px;border-bottom:1px solid rgba(0,0,0,.07);padding:5px 0}',
    '.tl-age{flex:0 0 42px;color:#66727c;font-size:11px;text-align:right}',
    '.tl-main{min-width:0;flex:1}',
    '.tl-text{word-break:break-word}',
    '.tl-meta{color:#66727c;font-size:10.5px;margin-top:2px;word-break:break-word}',
    '.focus-item{border:1px solid rgba(0,0,0,.12);border-radius:9px;background:#fbfbfc;padding:6px 8px}',
    '.focus-item summary{cursor:pointer;list-style:none;outline:none}',
    '.focus-item summary::-webkit-details-marker{display:none}',
    '.focus-item summary:before{content:"▸";display:inline-block;width:12px;color:#77838d}',
    '.focus-item[open] summary:before{content:"▾"}',
    '.empty{border:1px dashed rgba(0,0,0,.18);border-radius:8px;padding:10px;color:#66727c;text-align:center}',
    '.pager{display:flex;justify-content:center;padding:4px 0}',
    '.pager button{border:1px solid rgba(0,0,0,.14);background:#f6f7f8;border-radius:8px;padding:5px 10px;font:12px/1.2 inherit;cursor:pointer}',
    '.sumline{font-size:11.5px;color:#66727c;word-break:break-word}',
    '.section{border:1px solid rgba(0,0,0,.12);border-radius:8px;background:#fafbfc;padding:0 8px 8px}',
    '.section>summary{cursor:pointer;list-style:none;outline:none;padding:7px 2px;font-weight:600}',
    '.section>summary::-webkit-details-marker{display:none}',
    '.section>summary:before{content:"▸";display:inline-block;width:12px;color:#77838d}',
    '.section[open]>summary:before{content:"▾"}',
    '.section-sub{color:#66727c;font-size:11px;margin:7px 0 4px}',
    '.danger{border:1px solid #e6a1a1;background:#fff7f7;border-radius:8px;padding:8px}',
    '.danger-note{color:#8a1f1f;font-size:11.5px;margin:3px 0 7px}',
    '.danger-btn{border:1px solid #c94a4a;background:#fff;color:#a11f1f;border-radius:8px;padding:6px 10px;font:12px/1.2 inherit;font-weight:600;cursor:pointer}',
    '.danger-btn:hover{background:#fdeaea}',
  ].join('\n');

  function bannerWarn() {
    const ws = state && state.diagnostics ? state.diagnostics.warnings : [];
    for (let i = ws.length - 1; i >= 0; i--) if (ws[i].severity === 'high') return ws[i];
    for (let i = ws.length - 1; i >= 0; i--) if (ws[i].severity === 'medium') return ws[i];
    return null;
  }

  function bannerKey() {
    const w = bannerWarn();
    return w ? w.code + '|' + w.msg : '';
  }

  function positionToasts() {
    if (!ui.toasts) return;
    const b = ui.banner;
    let top = 12;
    if (b && !b.hidden) {
      try { top = Math.max(12, Math.round(b.getBoundingClientRect().bottom + 8)); }
      catch (_) { top = 12; }
    }
    ui.toasts.style.top = top + 'px';
  }

  function showToast(kind, title, sub) {
    if (!ui.toasts) return;
    try {
      const el = document.createElement('div');
      el.className = 'toast ' + (kind || 'choice');
      el.setAttribute('role', 'status');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = title;
      el.appendChild(t);
      if (sub) {
        const s = document.createElement('div');
        s.className = 's';
        s.textContent = sub;
        el.appendChild(s);
      }
      ui.toasts.appendChild(el);
      while (ui.toasts.children.length > 4) ui.toasts.removeChild(ui.toasts.firstChild);
      positionToasts();
      try { void el.offsetWidth; el.classList.add('show'); } catch (_) {}
      const hide = () => {
        try { el.classList.remove('show'); } catch (_) {}
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 220);
      };
      el.addEventListener('click', hide);
      setTimeout(hide, 2800);
    } catch (_) {}
  }

  function decisionStats() {
    const out = { total: 0, manual: 0, auto: 0, autoQuiet: 0, backfill: 0, unknown: 0, missing: 0 };
    if (!state) return out;
    for (const id of Object.keys(state.lives || {})) {
      for (const d of (state.lives[id].decisions || [])) {
        if (!d) continue;
        out.total++;
        const mode = d.selectionMode || inferSelectionMode(d);
        if (mode === 'manual') out.manual++;
        else if (mode === 'auto') out.auto++;
        else if (mode === 'auto-quiet') out.autoQuiet++;
        else if (mode === 'backfill') out.backfill++;
        else out.unknown++;
        if (d.type !== 'question' && !(d.options && d.options.length)) out.missing++;
      }
    }
    return out;
  }

  function lifeById(id) {
    return state && state.lives && id ? state.lives[id] || null : null;
  }

  function currentLifeDecisions() {
    const life = lifeById(live.lifeId);
    return life ? (life.decisions || []).length : 0;
  }

  function lifeName(life) {
    return (life && life.meta && life.meta.name) || (life && life.lifeId) || '（无名）';
  }

  function lifeMeta(life) {
    return (life && life.meta) || {};
  }

  function sexLabel(s) {
    return s === 'F' ? '女' : s === 'M' ? '男' : '';
  }

  function lifeAge(life) {
    if (!life) return null;
    const d = life.result && life.result.deathAt && life.result.deathAt.age != null ? life.result.deathAt.age : null;
    if (d != null) return d;
    return life.meta && life.meta.age != null ? life.meta.age : null;
  }

  function lifeEnded(life) {
    return !!(life && (life.endedAt || (life.result && (life.result.lifeAt || life.result.deathAt))));
  }

  function lifeMode(life) {
    if (!life) return '';
    if (life.lifeId === live.lifeId) return '本局';
    return lifeEnded(life) ? '已结束' : '';
  }

  function lifeCounts(life) {
    const d = (life && life.decisions) || [];
    return {
      decisions: d.length,
      focus: ((life && life.focusPicks) || []).length,
      snapshots: +(life && life.snapCount) || 0,
      states: +(life && life.stateCount) || 0,
    };
  }

  function sortedLives() {
    return Object.keys(state.lives || {}).sort((a, b) => {
      if (a === live.lifeId) return -1;
      if (b === live.lifeId) return 1;
      const la = state.lives[a] || {};
      const lb = state.lives[b] || {};
      return (+lb.startedAt || +lb.endedAt || 0) - (+la.startedAt || +la.endedAt || 0);
    });
  }

  function decisionMode(d) {
    return (d && (d.selectionMode || inferSelectionMode(d))) || 'unknown';
  }

  function modeLabel(m) {
    return m === 'manual' ? '手动' : m === 'auto' ? '自动' : m === 'auto-quiet' ? '静默自动' : m === 'backfill' ? '历史' : '未确认';
  }

  function isHistoryDecision(d) {
    return !!d && (decisionMode(d) === 'backfill' || d.source === 'backfill' || d.source === 'save-diff');
  }

  function lifeDecisionStats(life) {
    const out = { all: 0, manual: 0, auto: 0, quiet: 0, backfill: 0, unknown: 0, missing: 0 };
    for (const d of ((life && life.decisions) || [])) {
      if (!d) continue;
      out.all++;
      const m = decisionMode(d);
      if (isHistoryDecision(d)) out.backfill++;
      else if (m === 'manual') out.manual++;
      else if (m === 'auto') out.auto++;
      else if (m === 'auto-quiet') out.quiet++;
      else out.unknown++;
      if (d.type !== 'question' && !(d.options && d.options.length)) out.missing++;
    }
    return out;
  }

  function filterDecision(d, filter) {
    if (!filter || filter === 'all') return true;
    if (filter === 'backfill') return isHistoryDecision(d);
    if (filter === 'quiet') return !isHistoryDecision(d) && decisionMode(d) === 'auto-quiet';
    if (filter === 'auto') return !isHistoryDecision(d) && decisionMode(d) === 'auto';
    if (filter === 'manual') return !isHistoryDecision(d) && decisionMode(d) === 'manual';
    return true;
  }

  function sortDecisions(decisions) {
    return (decisions || []).slice().sort((a, b) => {
      const ta = Date.parse(a && a.at) || 0;
      const tb = Date.parse(b && b.at) || 0;
      if (ta !== tb) return tb - ta;
      return (+b.seq || 0) - (+a.seq || 0);
    });
  }

  function sortFocus(picks) {
    return (picks || []).slice().sort((a, b) => {
      const ta = Date.parse(a && a.at) || 0;
      const tb = Date.parse(b && b.at) || 0;
      if (ta !== tb) return tb - ta;
      return (+b.age || 0) - (+a.age || 0);
    });
  }

  function timelineEntries(life) {
    if (!life) return null;
    if (Object.prototype.hasOwnProperty.call(ui.timelineCache, life.lifeId)) return ui.timelineCache[life.lifeId];
    if (Array.isArray(life.timeline) && life.timeline.length) return life.timeline;
    return null;
  }

  function ensureTimeline(lifeId) {
    if (!lifeId || Object.prototype.hasOwnProperty.call(ui.timelineCache, lifeId) || ui.timelineLoading[lifeId]) return;
    const life = lifeById(lifeId);
    ui.timelineLoading[lifeId] = true;
    idbGetTimeline(lifeId).then((row) => {
      const entries = row && Array.isArray(row.entries) ? row.entries : ((life && life.timeline) || []);
      ui.timelineCache[lifeId] = entries;
    }).catch(() => {
      ui.timelineCache[lifeId] = (life && life.timeline) || [];
    }).finally(() => {
      delete ui.timelineLoading[lifeId];
      updateUI();
    });
  }

  function lifeTimelineCount(life) {
    if (!life) return 0;
    const cached = ui.timelineCache[life.lifeId];
    return Math.max(+life.timelineCount || 0, (life.timeline || []).length, Array.isArray(cached) ? cached.length : 0);
  }

  function timelineKindLabel(kind) {
    const map = { dec: '抉择', big: '大事', ev: '事件', bad: '坏事', warm: '温暖', note: '注记', death: '离世', loss: '失去', birth: '出生' };
    return map[kind] || kind || '记录';
  }

  function renderOptionRow(op, selected) {
    return '<div class="opt' + (selected ? ' sel' : '') + '">' +
      '<span class="opt-k">' + (selected ? '✓' : '○') + '</span>' +
      '<span><span class="opt-label">' + esc(op.label || op.k) + '</span>' + (op.sub ? '<span class="opt-sub">' + esc(op.sub) + '</span>' : '') + '</span>' +
      '</div>';
  }

  function renderDecision(d) {
    if (!d) return '';
    const key = 'dec:' + String(ui.viewLifeId || '') + ':' + String(d.id || d.decisionId || d.at || Math.random());
    const open = ui.openDetails.has(key);
    const m = decisionMode(d);
    const title = d.title || d.question || (d.type === 'question' ? '问题 / 记录' : '抉择');
    const meta = [
      d.age == null ? '' : d.age + '岁',
      d.year || '',
      modeLabel(m),
      d.type === 'question' ? '问题' : '',
      d.count > 1 ? '×' + d.count : '',
    ].filter(Boolean).join(' · ');
    const selected = d.selectedLabel || (d.selectedK != null ? '选项 ' + d.selectedK : '');
    const lines = [];
    lines.push('<details class="dec-item" data-key="' + esc(key) + '"' + (open ? ' open' : '') + '>');
    lines.push('<summary><span class="dec-title">' + esc(title) + '</span><span class="dec-meta">' + esc(meta) + (selected ? ' · ' + esc(selected) : '') + '</span></summary>');
    lines.push('<div class="dec-body">');
    if (d.question && d.question !== title) lines.push('<div class="dec-line">问题：' + esc(d.question) + '</div>');
    if (d.options && d.options.length) {
      lines.push('<div class="opts">');
      for (const op of d.options) {
        if (!op) continue;
        lines.push(renderOptionRow(op, String(op.k) === String(d.selectedK)));
      }
      lines.push('</div>');
    } else if (d.type === 'question') {
      lines.push('<div class="dec-line">回答/备注：' + esc(d.note || d.outcomeText || '（未填写）') + '</div>');
    } else {
      lines.push('<div class="dnote">' + (isHistoryDecision(d) ? '旧记录：选项未保存在旧存档里。' : '选项未捕获。') + '</div>');
    }
    if (d.outcomeText && d.outcomeText !== selected) lines.push('<div class="dec-line">结果：' + esc(d.outcomeText) + '</div>');
    if (d.note && d.type !== 'question') lines.push('<div class="dec-line">备注：' + esc(d.note) + '</div>');
    if (d.beforeStateId || d.afterStateId) {
      lines.push('<div class="dec-line muted">状态照片：' + esc(d.beforeStateId || '无') + ' → ' + esc(d.afterStateId || '无') + '</div>');
    }
    if (d.decisionId != null) lines.push('<div class="dec-line muted">存档抉择 ID：' + esc(d.decisionId) + '</div>');
    lines.push('</div></details>');
    return lines.join('');
  }

  function renderTimelineItem(e) {
    if (!e) return '';
    const text = e.text || e.q || '（无文字）';
    const meta = [
      timelineKindLabel(e.kind),
      e.a == null ? '' : e.a + '岁',
      e.q && e.q !== text ? e.q : '',
      e.star ? '★' : '',
    ].filter(Boolean).join(' · ');
    return '<div class="tl-item"><div class="tl-age">' + esc(e.a == null ? '' : e.a + '岁') + '</div><div class="tl-main"><div class="tl-text">' + esc(text) + '</div>' +
      (e.fact ? '<div class="tl-meta">资料：' + esc(truncateText(e.fact, 500)) + '</div>' : '') +
      '<div class="tl-meta">' + esc(meta) + '</div></div></div>';
  }

  function renderFocusItem(f) {
    if (!f) return '';
    const key = 'focus:' + String(ui.viewLifeId || '') + ':' + String(f.at || f.age || '') + ':' + String(f.selectedK || '');
    const open = ui.openDetails.has(key);
    const m = f.selectionMode || (f.auto ? 'auto' : 'manual');
    const meta = [f.age == null ? '' : f.age + '岁', f.year || '', modeLabel(m)].filter(Boolean).join(' · ');
    const lines = [];
    lines.push('<details class="focus-item" data-key="' + esc(key) + '"' + (open ? ' open' : '') + '>');
    lines.push('<summary><span class="dec-title">' + esc(f.selectedLabel || f.selectedK || '重心') + '</span><span class="dec-meta">' + esc(meta) + '</span></summary>');
    lines.push('<div class="dec-body"><div class="opts">');
    for (const op of (f.options || [])) {
      if (!op) continue;
      lines.push('<div class="opt' + (String(op.k) === String(f.selectedK) ? ' sel' : '') + '"><span class="opt-k">' + (String(op.k) === String(f.selectedK) ? '✓' : '○') + '</span><span><span class="opt-label">' + esc(op.label || op.k) + '</span>' + (op.desc ? '<span class="opt-sub">' + esc(op.desc) + '</span>' : '') + '</span></div>');
    }
    lines.push('</div></div></details>');
    return lines.join('');
  }

  function detailsOpen(key) {
    return ui.openDetails.has(key) ? ' open' : '';
  }

  function renderAllView() {
    const ids = sortedLives();
    let totalFocus = 0;
    const totalModes = { manual: 0, auto: 0, quiet: 0, backfill: 0, unknown: 0, missing: 0 };
    for (const id of ids) {
      const l = state.lives[id];
      if (!l) continue;
      totalFocus += (l.focusPicks || []).length;
      const ds = lifeDecisionStats(l);
      totalModes.manual += ds.manual;
      totalModes.auto += ds.auto;
      totalModes.quiet += ds.quiet;
      totalModes.backfill += ds.backfill;
      totalModes.unknown += ds.unknown;
      totalModes.missing += ds.missing;
    }
    const lines = [];
    lines.push('<div class="sumline">全部 ' + ids.length + ' 个人生 · ' + totalDecisions() + ' 抉择 · ' + totalFocus + ' 重心 · ' + totalSnapshots() + ' 文本快照 · ' + totalStates() + ' 状态照片</div>');
    lines.push('<div class="sumline">全部选择方式：手动 ' + totalModes.manual + ' · 自动 ' + totalModes.auto + ' · 静默 ' + totalModes.quiet + ' · 历史 ' + totalModes.backfill + ' · 未确认 ' + totalModes.unknown + ' · 选项缺失 ' + totalModes.missing + '</div>');
    lines.push('<div class="sep"></div>');
    if (!ids.length) {
      lines.push('<div class="empty">还没有人生记录。</div>');
    } else {
      lines.push('<div class="life-list">');
      for (const id of ids) {
        const l = state.lives[id];
        if (!l) continue;
        const c = lifeCounts(l);
        const isCurrent = id === live.lifeId;
        const name = lifeName(l);
        const lm = lifeMeta(l);
        const sub = [
          lm.born || '',
          sexLabel(lm.sex),
          lifeAge(l) == null ? '' : lifeAge(l) + '岁',
          lifeMode(l),
        ].filter(Boolean).join(' · ');
        lines.push('<button type="button" class="life-item' + (isCurrent ? ' current' : '') + '" data-act="open-life" data-life="' + esc(id) + '">' +
          '<span class="li-top"><span class="li-name">' + esc(name) + '</span>' +
          (isCurrent ? '<span class="badge">本局</span>' : '') +
          (l.captureStatus && l.captureStatus !== 'live' ? '<span class="badge old">历史</span>' : '') +
          '</span>' +
          '<span class="li-sub">' + esc(sub) + '</span>' +
          '<span class="li-counts">' + c.decisions + ' 抉择 · ' + c.focus + ' 重心 · ' + c.snapshots + ' 快照 · ' + c.states + ' 状态</span>' +
          '</button>');
      }
      lines.push('</div>');
    }
    lines.push('<div class="sep"></div>');
    lines.push('<details class="section" data-key="export-maintenance"' + detailsOpen('export-maintenance') + '>');
    lines.push('<summary>导出 / 维护</summary>');
    lines.push('<div class="section-sub">常用导出</div>');
    lines.push('<div class="row"><button type="button" data-act="json">全部 JSON</button><button type="button" data-act="decisions">全部抉择 CSV</button><button type="button" data-act="states-jsonl">状态 JSONL</button></div>');
    lines.push('<div class="section-sub">更多导出</div>');
    lines.push('<div class="row"><button type="button" data-act="jsonl">快照 JSONL</button><button type="button" data-act="states-csv">状态 CSV</button><button type="button" data-act="countries-csv">国家 CSV</button></div>');
    lines.push('<div class="row"><button type="button" data-act="focus">全部重心 CSV</button><button type="button" data-act="timeline">全部时间线 CSV</button></div>');
    lines.push('<div class="section-sub">维护</div>');
    lines.push('<div class="row"><button type="button" data-act="import">导入 JSON</button><button type="button" data-act="refresh">刷新补录</button><button type="button" class="danger-btn" data-act="clear">清空全部</button></div>');
    if (ui.busy) lines.push('<div class="muted">导出中…</div>');
    lines.push('</details>');
    const warns = state.diagnostics.warnings || [];
    if (warns.length) {
      lines.push('<details class="section" data-key="diagnostics"' + detailsOpen('diagnostics') + '>');
      lines.push('<summary>提示与诊断（' + warns.length + '）</summary>');
      for (const w of warns.slice(-10).reverse()) {
        lines.push('<div class="warn ' + (w.severity === 'high' ? 'high' : '') + '">' + esc('[' + (w.severity || 'low') + '] ' + w.msg) + '</div>');
      }
      lines.push('</details>');
    }
    return lines.join('');
  }

  function renderLifeView(lifeId) {
    const life = lifeById(lifeId);
    if (!life) return renderAllView();
    const ds = lifeDecisionStats(life);
    const counts = lifeCounts(life);
    const age = lifeAge(life);
    const isCurrent = lifeId === live.lifeId;
    const lm = lifeMeta(life);
    const lines = [];
    lines.push('<button type="button" class="backlink" data-act="back">← 所有人生</button>');
    lines.push('<div class="li-top"><span class="li-name">' + esc(lifeName(life)) + '</span>' + (isCurrent ? '<span class="badge">本局</span>' : '<span class="badge old">' + esc(lifeEnded(life) ? '已结束' : '历史') + '</span>') + '</div>');
    lines.push('<div class="li-sub">' + esc([lm.born || '', sexLabel(lm.sex), age == null ? '' : age + '岁', lifeMode(life)].filter(Boolean).join(' · ')) + '</div>');
    lines.push('<div class="kv" style="margin-top:6px">');
    lines.push('<span>抉择</span><span>' + ds.all + ' 条</span>');
    lines.push('<span>选择方式</span><span>手动 ' + ds.manual + ' · 自动 ' + ds.auto + ' · 静默 ' + ds.quiet + ' · 历史 ' + ds.backfill + ' · 未确认 ' + ds.unknown + '</span>');
    lines.push('<span>选项缺失</span><span>' + ds.missing + ' 条</span>');
    lines.push('<span>文本快照</span><span>' + counts.snapshots + ' 张</span>');
    lines.push('<span>状态照片</span><span>' + counts.states + ' 张</span>');
    lines.push('<span>重心</span><span>' + counts.focus + ' 条</span>');
    lines.push('</div>');
    lines.push('<div class="sep"></div>');
    lines.push('<div class="tabs">');
    const tabs = [
      ['decisions', '抉择 ' + ds.all],
      ['timeline', '时间线 ' + lifeTimelineCount(life)],
      ['focus', '重心 ' + counts.focus],
    ];
    for (const [tab, label] of tabs) {
      lines.push('<button type="button" class="tab' + (ui.tab === tab ? ' active' : '') + '" data-act="tab" data-tab="' + tab + '">' + esc(label) + '</button>');
    }
    lines.push('</div>');
    if (ui.tab === 'decisions') {
      const filters = [
        ['all', '全部', ds.all],
        ['manual', '手动', ds.manual],
        ['auto', '自动', ds.auto],
        ['quiet', '静默', ds.quiet],
        ['backfill', '历史', ds.backfill],
      ];
      lines.push('<div class="filters">');
      for (const [f, label, n] of filters) {
        lines.push('<button type="button" class="filter' + (ui.filter === f ? ' active' : '') + '" data-act="filter" data-filter="' + f + '">' + esc(label + ' ' + n) + '</button>');
      }
      lines.push('</div>');
      const list = sortDecisions(life.decisions).filter((d) => filterDecision(d, ui.filter));
      if (!list.length) {
        lines.push('<div class="empty">' + (ui.filter === 'all' ? '这一生还没有抉择记录。' : '这个筛选下没有记录。') + '</div>');
      } else {
        const shown = list.slice(0, ui.limit);
        lines.push('<div class="dec-list">');
        for (const d of shown) lines.push(renderDecision(d));
        lines.push('</div>');
        if (list.length > ui.limit) {
          lines.push('<div class="pager"><button type="button" data-act="more">显示更多（' + shown.length + ' / ' + list.length + '）</button></div>');
        }
      }
    } else if (ui.tab === 'timeline') {
      const entries = timelineEntries(life);
      if (entries == null) {
        ensureTimeline(lifeId);
        lines.push('<div class="empty">时间线加载中…</div>');
      } else {
        const list = entries.slice().reverse();
        if (!list.length) {
          lines.push('<div class="empty">这一生还没有时间线记录。</div>');
        } else {
          const shown = list.slice(0, ui.timelineLimit);
          lines.push('<div class="tl-list">');
          for (const e of shown) lines.push(renderTimelineItem(e));
          lines.push('</div>');
          if (list.length > ui.timelineLimit) {
            lines.push('<div class="pager"><button type="button" data-act="more">显示更多（' + shown.length + ' / ' + list.length + '）</button></div>');
          }
        }
      }
    } else {
      const list = sortFocus(life.focusPicks);
      if (!list.length) {
        lines.push('<div class="empty">这一生还没有重心记录。</div>');
      } else {
        const shown = list.slice(0, ui.limit);
        lines.push('<div class="focus-list">');
        for (const f of shown) lines.push(renderFocusItem(f));
        lines.push('</div>');
        if (list.length > ui.limit) {
          lines.push('<div class="pager"><button type="button" data-act="more">显示更多（' + shown.length + ' / ' + list.length + '）</button></div>');
        }
      }
    }
    lines.push('<div class="sep"></div>');
    lines.push('<div class="danger">');
    lines.push('<div class="muted">删除此人生会移除全部抉择、时间线、重心、文本快照和状态照片。</div>');
    lines.push('<div class="danger-note">' + (isCurrent ? '当前本局会停止记录，下一世重新开始。' : '删除后不可恢复，建议先导出。') + '</div>');
    lines.push('<button type="button" class="danger-btn" data-act="delete-life" data-life="' + esc(lifeId) + '">删除此人生</button>');
    lines.push('</div>');
    return lines.join('');
  }

  function renderUI() {
    if (!ui.shadow || !state) return;
    if (ui.host && !ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
    const warns = state.diagnostics.warnings || [];
    const high = warns.some((w) => w.severity === 'high');
    const med = warns.some((w) => w.severity === 'medium');
    const statusText = high ? '失效' : med ? '待验证' : '正常';
    ui.status.textContent = statusText;
    ui.status.className = 'status' + (high ? ' high' : med ? ' med' : '');
    ui.fabText.textContent = '1in8b 本局 ' + currentLifeDecisions();
    ui.fab.title = '本局抉择 ' + currentLifeDecisions() + ' 条；点击查看本局与所有人生';
    ui.fabDot.hidden = !(high || med);
    ui.fabDot.className = 'dot' + (high ? ' high' : med ? ' med' : '');

    if (ui.view === 'life' && !lifeById(ui.viewLifeId)) {
      ui.view = 'all';
      ui.viewLifeId = null;
    }
    if (ui.view === 'life' && !ui.viewLifeId) ui.view = 'all';

    if (ui.back) ui.back.hidden = ui.view !== 'life';
    if (ui.title) ui.title.textContent = ui.view === 'all' ? '1in8b 所有人生' : (ui.viewLifeId === live.lifeId ? '1in8b 本局' : '1in8b 历史人生');

    if (!ui.panel.hidden) {
      const prevScroll = ui.body.scrollTop;
      const html = ui.view === 'all' ? renderAllView() : renderLifeView(ui.viewLifeId);
      ui.body.innerHTML = html;
      const target = ui.pendingScrollTop != null ? ui.pendingScrollTop : prevScroll;
      ui.pendingScrollTop = null;
      try { ui.body.scrollTop = target; } catch (_) {}
      if (ui.view === 'life' && ui.tab === 'timeline') {
        const l = lifeById(ui.viewLifeId);
        if (l && !Object.prototype.hasOwnProperty.call(ui.timelineCache, l.lifeId)) ensureTimeline(l.lifeId);
      }
    }

    const latest = bannerWarn();
    const key = bannerKey();
    if (latest && state.diagnostics.bannerDismissed !== key) {
      ui.banner.hidden = false;
      ui.banner.className = 'banner' + (latest.severity === 'high' ? ' high' : '');
      ui.banner.querySelector('#bannerText').textContent = latest.msg;
      ui.banner.dataset.key = key;
    } else {
      ui.banner.hidden = true;
    }
    positionToasts();
  }

  function updateUI() {
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      try { renderUI(); }
      catch (e) { console.warn('[1in8b-rec] render failed', e); }
    }, 120);
  }

  function initUI() {
    if (ui.host || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'rec1in8b-host';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + UI_CSS + '</style>' +
      '<div id="banner" class="banner" hidden><span id="bannerText"></span><button id="bannerClose" class="icon" type="button" aria-label="关闭">×</button></div>' +
      '<div id="toasts" class="toasts" aria-live="polite"></div>' +
      '<button id="fab" class="fab" type="button"><span id="fabDot" class="dot" hidden></span><span id="fabText">1in8b 本局 0</span></button>' +
      '<div id="panel" class="panel" hidden><div class="ph"><button id="back" class="icon back" type="button" aria-label="返回所有人生" hidden>←</button><b id="title">1in8b 所有人生</b><span id="status" class="status">初始化</span><button id="close" class="icon" type="button" aria-label="关闭">×</button></div><div id="body" class="body"></div></div>' +
      '<input id="importFile" type="file" accept=".json,application/json" hidden>';
    ui.host = host;
    ui.shadow = shadow;
    ui.banner = shadow.getElementById('banner');
    ui.toasts = shadow.getElementById('toasts');
    ui.fab = shadow.getElementById('fab');
    ui.fabText = shadow.getElementById('fabText');
    ui.fabDot = shadow.getElementById('fabDot');
    ui.panel = shadow.getElementById('panel');
    ui.back = shadow.getElementById('back');
    ui.title = shadow.getElementById('title');
    ui.status = shadow.getElementById('status');
    ui.body = shadow.getElementById('body');
    ui.importFile = shadow.getElementById('importFile');
    ui.view = live.lifeId && state.lives[live.lifeId] ? 'life' : 'all';
    ui.viewLifeId = ui.view === 'life' ? live.lifeId : null;
    shadow.addEventListener('click', onUIAction, true);
    shadow.addEventListener('toggle', onDetailsToggle, true);
    shadow.addEventListener('change', onImportFile, true);
    updateUI();
  }

  function onImportFile(e) {
    const input = e.target;
    if (!input || input.id !== 'importFile') return;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    runAsync(() => importRecorderFile(file));
  }

  function onDetailsToggle(e) {
    const el = e.target;
    if (!el || el.tagName !== 'DETAILS' || !el.dataset || !el.dataset.key) return;
    if (el.open) ui.openDetails.add(el.dataset.key);
    else ui.openDetails.delete(el.dataset.key);
  }

  function runAsync(fn) {
    ui.busy = true;
    updateUI();
    Promise.resolve().then(fn).catch((e) => {
      warn('error', '操作失败：' + (e && e.message ? e.message : e), 'high');
    }).finally(() => {
      ui.busy = false;
      updateUI();
    });
  }

  function onUIAction(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const b = t.closest('[data-act], #fab, #close, #bannerClose, #back');
    if (!b) return;
    let act = b.getAttribute('data-act');
    if (b.id === 'fab') act = 'toggle';
    else if (b.id === 'close') act = 'close';
    else if (b.id === 'bannerClose') act = 'dismiss';
    else if (b.id === 'back') act = 'back';
    if (!act) return;
    e.stopPropagation();
    if (act === 'toggle') {
      if (ui.panel.hidden) {
        ui.panel.hidden = false;
        const cur = live.lifeId && state.lives[live.lifeId] ? live.lifeId : null;
        ui.view = cur ? 'life' : 'all';
        ui.viewLifeId = cur;
        ui.tab = 'decisions';
        ui.filter = 'all';
        ui.limit = 50;
        ui.timelineLimit = 100;
        ui.pendingScrollTop = 0;
      } else {
        ui.panel.hidden = true;
      }
      updateUI();
    } else if (act === 'back') {
      ui.view = 'all';
      ui.viewLifeId = null;
      ui.tab = 'decisions';
      ui.filter = 'all';
      ui.limit = 50;
      ui.timelineLimit = 100;
      ui.pendingScrollTop = 0;
      updateUI();
    } else if (act === 'open-life') {
      const id = b.getAttribute('data-life');
      if (id && state.lives[id]) {
        ui.view = 'life';
        ui.viewLifeId = id;
        ui.tab = 'decisions';
        ui.filter = 'all';
        ui.limit = 50;
        ui.timelineLimit = 100;
        ui.pendingScrollTop = 0;
        updateUI();
      }
    } else if (act === 'tab') {
      const tab = b.getAttribute('data-tab');
      if (tab === 'decisions' || tab === 'timeline' || tab === 'focus') {
        ui.tab = tab;
        ui.pendingScrollTop = 0;
        if (tab === 'timeline' && ui.viewLifeId) ensureTimeline(ui.viewLifeId);
        updateUI();
      }
    } else if (act === 'filter') {
      const f = b.getAttribute('data-filter');
      if (f) {
        ui.filter = f;
        ui.limit = 50;
        ui.pendingScrollTop = 0;
        updateUI();
      }
    } else if (act === 'more') {
      if (ui.tab === 'timeline') ui.timelineLimit += 100;
      else ui.limit += 50;
      updateUI();
    } else if (act === 'delete-life') {
      const id = b.getAttribute('data-life');
      if (id) runAsync(() => deleteLife(id));
    } else if (act === 'close') {
      ui.panel.hidden = true;
    } else if (act === 'dismiss') {
      state.diagnostics.bannerDismissed = bannerKey();
      saveState();
      updateUI();
    } else if (act === 'json') runAsync(exportJSON);
    else if (act === 'jsonl') runAsync(exportJSONL);
    else if (act === 'states-jsonl') runAsync(exportStatesJSONL);
    else if (act === 'states-csv') runAsync(exportStatesCSV);
    else if (act === 'countries-csv') runAsync(exportCountriesCSV);
    else if (act === 'decisions') runAsync(exportDecisionsCSV);
    else if (act === 'focus') runAsync(exportFocusCSV);
    else if (act === 'timeline') runAsync(exportTimelineCSV);
    else if (act === 'import') {
      if (ui.importFile) ui.importFile.click();
    }
    else if (act === 'refresh') { backfillAll(); updateUI(); }
    else if (act === 'clear') runAsync(clearAll);
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (_) {}
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s.trimStart())) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCSV(headers, rows) {
    return '\ufeff' + [headers.map(csvCell).join(',')].concat(rows.map((r) => r.map(csvCell).join(','))).join('\r\n');
  }

  async function refreshAll() {
    backfillAll();
    const active = readActiveSave();
    if (active && active.S) {
      const id = lifeIdFromS(active.S);
      const life = state.lives[id];
      if (life) {
        const attributed = live.lifeId === id
          ? live.attributedIds
          : new Set((life.decisions || []).filter((d) => d.source === 'live' && d.decisionId).map((d) => d.decisionId));
        applySaveToLife(life, active.S, {
          baselineDone: life.baselineDone || {},
          attributedIds: attributed,
          unattributedLiveCount: countUnattributedLive(life),
        });
      }
    }
    await flushSave();
    await timelineChain;
    try { await stateChain; } catch (_) {}
  }

  async function collectSnapshots() {
    let snaps = [];
    try { snaps = await idbAllSnapshots(); } catch (_) { snaps = []; }
    if (state.snapshotsFallback && state.snapshotsFallback.length) snaps = snaps.concat(state.snapshotsFallback);
    return snaps.filter((s) => s && !isLifeDeleted(s.lifeId));
  }

  async function collectTimelines() {
    let list = [];
    try { list = await idbAllTimelines(); } catch (_) { list = []; }
    const map = {};
    for (const t of list) {
      if (t && t.lifeId && !isLifeDeleted(t.lifeId)) map[t.lifeId] = t.entries || [];
    }
    return map;
  }

  async function collectStates() {
    try {
      const list = await idbAllStates();
      return list.filter((s) => s && !isLifeDeleted(s.lifeId));
    } catch (_) { return []; }
  }

  async function collectCountries() {
    try { return await idbAllCountries(); } catch (_) { return []; }
  }

  async function buildExport() {
    await refreshAll();
    const snaps = await collectSnapshots();
    const timelines = await collectTimelines();
    const states = await collectStates();
    const countries = await collectCountries();
    const byLife = {};
    for (const s of snaps) {
      const k = s.lifeId || 'unassigned';
      (byLife[k] = byLife[k] || []).push(s);
    }
    const ids = Object.keys(state.lives).sort((a, b) => {
      const la = state.lives[a];
      const lb = state.lives[b];
      return (+la.startedAt || +la.endedAt || 0) - (+lb.startedAt || +lb.endedAt || 0);
    });
    const lives = ids.map((id) => {
      const l = state.lives[id];
      const out = clone(l) || {};
      out.timeline = timelines[id] || (l.timeline || []);
      out.timelineCount = out.timeline.length;
      out.snapshots = (byLife[id] || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
      out.snapshotCount = out.snapshots.length;
      out.snapshotBytes = out.snapshots.reduce((n, s) => n + (+s.bytes || 0), 0);
      return out;
    });
    return {
      format: '1in8b-recorder',
      version: VERSION,
      exportedAt: nowISO(),
      site: location.origin,
      bundle: state.diagnostics.bundle,
      diagnostics: state.diagnostics,
      introText: state.introText,
      pendingBirth: live.pendingBirthText || null,
      settings: state.settings,
      settingsCatalog: state.settingsCatalog,
      settingsEvents: state.settingsEvents,
      deletedLifeIds: (state.deletedLifeIds || []).slice(),
      lives,
      states: states.sort((a, b) => String(a.at).localeCompare(String(b.at))),
      countries: countries.sort((a, b) => String(a.key).localeCompare(String(b.key))),
      unassignedSnapshots: byLife.unassigned || [],
    };
  }

  async function exportJSON() {
    const o = await buildExport();
    download('1in8b-recording-' + stamp() + '.json', JSON.stringify(o, null, 2), 'application/json');
  }

  async function exportJSONL() {
    const o = await buildExport();
    const lines = [];
    for (const l of o.lives) for (const s of (l.snapshots || [])) lines.push(JSON.stringify(s));
    for (const s of (o.unassignedSnapshots || [])) lines.push(JSON.stringify(s));
    download('1in8b-snapshots-' + stamp() + '.jsonl', lines.join('\n'), 'application/x-ndjson');
  }

  async function exportStatesJSONL() {
    await refreshAll();
    const states = (await collectStates()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    download('1in8b-states-' + stamp() + '.jsonl', states.map((s) => JSON.stringify(s)).join('\n'), 'application/x-ndjson');
  }

  async function exportStatesCSV() {
    await refreshAll();
    const states = (await collectStates()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const headers = ['id', 'lifeId', 'at', 'saveAt', 'saveAtISO', 'reason', 'phase', 'decisionRef', 'age', 'year', 'name', 'sex', 'born', 'cur', 'urban', 'city', 'health', 'happiness', 'knowledge', 'relationships', 'cash', 'house', 'debt', 'income', 'pct', 'netWorth', 'job', 'edu', 'school', 'focus', 'partner', 'kids', 'countryRef', 'countryName', 'decisionRefs', 'confidence', 'bytes', 'familyJson', 'compsJson'];
    const rows = [];
    for (const s of states) {
      const idn = s.identity || {};
      const sta = s.stats || {};
      const mon = s.money || {};
      const fam = s.family || {};
      const ew = s.educationWork || {};
      const kids = (fam.kids || []).map((k) => k && k.name).filter(Boolean).join('、');
      const partner = fam.partner ? (fam.partner.name || '') : '';
      const refs = (s.decisionRefs || []).map((r) => r.id + ':' + r.phase).join('|');
      rows.push([
        s.id, s.lifeId, s.at, s.saveAt, s.saveAtISO, s.reason, s.phase, s.decisionRef,
        s.age, s.year, idn.name, idn.sex, idn.born, idn.cur, idn.urban ? 1 : 0, idn.city,
        sta.health, sta.happiness, sta.knowledge, sta.relationships,
        mon.cash, mon.house, mon.debt, mon.income, mon.pct, mon.netWorth,
        ew.job, ew.edu, ew.school, s.focus && s.focus.key, partner, kids,
        s.countryRef, s.country && s.country.name, refs, s.confidence, s.bytes,
        JSON.stringify(fam), JSON.stringify(s.comps || []),
      ]);
    }
    download('1in8b-states-' + stamp() + '.csv', toCSV(headers, rows), 'text/csv;charset=utf-8');
  }

  async function exportCountriesCSV() {
    await refreshAll();
    const countries = await collectCountries();
    const headers = ['key', 'countryCode', 'countryName', 'lang', 'era', 'capturedAt', 'label', 'value', 'survivalText', 'survivalLabels'];
    const rows = [];
    for (const c of countries) {
      const pairs = c.stats && Array.isArray(c.stats.pairs) ? c.stats.pairs : [];
      const labels = c.survival && Array.isArray(c.survival.labels) ? c.survival.labels.join('|') : '';
      const text = c.survival && c.survival.text ? c.survival.text : '';
      if (!pairs.length) {
        rows.push([c.key, c.countryCode, c.countryName, c.lang, c.era, c.capturedAt, '', '', text, labels]);
      } else {
        for (const p of pairs) {
          rows.push([c.key, c.countryCode, c.countryName, c.lang, c.era, c.capturedAt, p.label, p.value, text, labels]);
        }
      }
    }
    download('1in8b-countries-' + stamp() + '.csv', toCSV(headers, rows), 'text/csv;charset=utf-8');
  }

  async function exportDecisionsCSV() {
    const o = await buildExport();
    const headers = ['lifeId', 'source', 'captureStatus', 'type', 'selectionMode', 'seq', 'at', 'age', 'year', 'decisionId', 'title', 'question', 'optionsKnown', 'optionsSource', 'captureConfidence', 'optionK', 'optionLabel', 'optionSub', 'selected', 'selectedK', 'auto', 'autoEvidence', 'decideMs', 'note', 'outcomeText', 'count', 'possibleDuplicate', 'beforeStateId', 'afterStateId'];
    const rows = [];
    for (const l of o.lives) {
      for (const d of (l.decisions || [])) {
        const opts = d.options && d.options.length ? d.options : [null];
        for (const op of opts) {
          rows.push([
            l.lifeId, l.source, l.captureStatus, d.type || '', d.selectionMode || '', d.seq, d.at, d.age, d.year, d.decisionId, d.title, d.question,
            d.optionsKnown ? 1 : 0, d.optionsSource || '', d.captureConfidence || '',
            op ? op.k : '', op ? op.label : '', op ? op.sub : '',
            op ? (String(op.k) === String(d.selectedK) ? 1 : 0) : '',
            d.selectedK, d.auto == null ? '' : (d.auto ? 1 : 0), d.autoEvidence || '', d.decideMs, d.note, d.outcomeText || '', d.count, d.possibleDuplicate ? 1 : 0,
            d.beforeStateId || '', d.afterStateId || '',
          ]);
        }
      }
    }
    download('1in8b-decisions-' + stamp() + '.csv', toCSV(headers, rows), 'text/csv;charset=utf-8');
  }

  async function exportFocusCSV() {
    const o = await buildExport();
    const headers = ['lifeId', 'source', 'at', 'age', 'year', 'optionK', 'optionLabel', 'optionDesc', 'selected', 'selectedK', 'auto', 'selectionMode', 'autoEvidence'];
    const rows = [];
    for (const l of o.lives) {
      for (const f of (l.focusPicks || [])) {
        const opts = f.options && f.options.length ? f.options : [null];
        for (const op of opts) {
          rows.push([
            l.lifeId, l.source, f.at, f.age, f.year,
            op ? op.k : '', op ? op.label : '', op ? op.desc : '',
            op ? (String(op.k) === String(f.selectedK) ? 1 : 0) : '',
            f.selectedK, f.auto == null ? '' : (f.auto ? 1 : 0), f.selectionMode || '', f.autoEvidence || '',
          ]);
        }
      }
    }
    download('1in8b-focus-' + stamp() + '.csv', toCSV(headers, rows), 'text/csv;charset=utf-8');
  }

  async function exportTimelineCSV() {
    const o = await buildExport();
    const headers = ['lifeId', 'source', 'age', 'kind', 'decisionId', 'question', 'text', 'fact', 'fx', 'star'];
    const rows = [];
    for (const l of o.lives) {
      for (const e of (l.timeline || [])) {
        const fx = e.fx == null ? '' : (typeof e.fx === 'object' ? JSON.stringify(e.fx) : e.fx);
        rows.push([l.lifeId, l.source, e.a, e.kind, e.dk || '', e.q, e.text, e.fact, fx, e.star ? 1 : 0]);
      }
    }
    download('1in8b-timeline-' + stamp() + '.csv', toCSV(headers, rows), 'text/csv;charset=utf-8');
  }

  function mergeImportedLife(local, incoming) {
    if (!local || !incoming) return;
    local.meta = Object.assign({}, incoming.meta || {}, local.meta || {});
    local.source = local.source || incoming.source;
    local.captureStatus = local.captureStatus || incoming.captureStatus;
    local.startedAt = local.startedAt || incoming.startedAt || null;
    local.endedAt = local.endedAt || incoming.endedAt || null;
    if (!local.result && incoming.result) local.result = clone(incoming.result);
    const seenDec = new Set((local.decisions || []).map((d) => d && (d.id || d.decisionId)).filter((x) => x != null).map(String));
    for (const d of (incoming.decisions || [])) {
      const k = d && (d.id || d.decisionId);
      if (k != null && seenDec.has(String(k))) continue;
      (local.decisions = local.decisions || []).push(clone(d));
      if (k != null) seenDec.add(String(k));
    }
    if (local.decisions.length > LIMITS.decisionsPerLife) local.decisions = local.decisions.slice(-LIMITS.decisionsPerLife);
    const seenFocus = new Set((local.focusPicks || []).map((f) => [f.at, f.age, f.selectedK].join('|')));
    for (const f of (incoming.focusPicks || [])) {
      const k = [f.at, f.age, f.selectedK].join('|');
      if (seenFocus.has(k)) continue;
      (local.focusPicks = local.focusPicks || []).push(clone(f));
      seenFocus.add(k);
    }
    if (local.focusPicks.length > LIMITS.focusPerLife) local.focusPicks = local.focusPicks.slice(-LIMITS.focusPerLife);
    const seenNote = new Set((local.notes || []).map((n) => [n.at, n.q, n.t].join('|')));
    for (const n of (incoming.notes || [])) {
      const k = [n.at, n.q, n.t].join('|');
      if (seenNote.has(k)) continue;
      (local.notes = local.notes || []).push(clone(n));
      seenNote.add(k);
    }
    if (!local.timeline || !local.timeline.length) local.timeline = clone(incoming.timeline || []);
    local.timelineCount = Math.max(+local.timelineCount || 0, +incoming.timelineCount || 0);
    local.warnings = Array.from(new Set([...(local.warnings || []), ...(incoming.warnings || [])]));
  }

  async function importRecorderData(raw) {
    if (!state) throw new Error('记录器状态未加载');
    const payload = raw && raw.data && raw.data.state ? raw.data : raw;
    const mainRow = payload && Array.isArray(payload.state) ? (payload.state.find((r) => r && r.k === 'main') || payload.state[0]) : null;
    const incomingMain = mainRow && mainRow.v;
    if (!incomingMain || !incomingMain.lives || typeof incomingMain.lives !== 'object') {
      throw new Error('文件格式不识别：请选择 raw-indexeddb.json 或包含 data.state 的导出文件');
    }
    const incoming = normalizeState(incomingMain);
    const incomingIds = new Set(Object.keys(incoming.lives));
    if (!incomingIds.size) throw new Error('导入文件里没有人生数据');
    await flushSave();
    const added = { lives: 0, states: 0, snapshots: 0, timelines: 0, countries: 0 };
    for (const id of incomingIds) {
      const src = incoming.lives[id];
      if (!state.lives[id]) {
        state.lives[id] = clone(src);
        state.lives[id].stateCount = 0;
        state.lives[id].stateBytes = 0;
        state.lives[id].snapCount = 0;
        state.lives[id].snapBytes = 0;
        added.lives++;
      } else {
        mergeImportedLife(state.lives[id], src);
      }
    }
    state.deletedLifeIds = Array.from(new Set([...(state.deletedLifeIds || []), ...(incoming.deletedLifeIds || [])]));
    if (!state.settings && incoming.settings) state.settings = clone(incoming.settings);
    if (!state.settingsCatalog && incoming.settingsCatalog) state.settingsCatalog = clone(incoming.settingsCatalog);
    if (!state.introText && incoming.introText) state.introText = incoming.introText;
    if (!state.hookCaptures || !state.hookCaptures.length) state.hookCaptures = clone(incoming.hookCaptures || []);
    else {
      const seenHook = new Set(state.hookCaptures.map((c) => c && c.id).filter(Boolean));
      for (const c of (incoming.hookCaptures || [])) {
        if (c && c.id && !seenHook.has(c.id)) state.hookCaptures.push(clone(c));
      }
    }
    const importedLifeIds = new Set(incomingIds);
    const existingStates = await idbAllStates();
    const seenState = new Set(existingStates.map((s) => s && s.id).filter(Boolean));
    for (const st of (payload.states || [])) {
      if (!st || !st.id || !importedLifeIds.has(st.lifeId) || seenState.has(st.id)) continue;
      await idbAddState(st);
      seenState.add(st.id);
      const life = state.lives[st.lifeId];
      if (life) {
        life.stateCount = (+life.stateCount || 0) + 1;
        life.stateBytes = (+life.stateBytes || 0) + (+st.bytes || 0);
        life.lastStateAt = st.at || life.lastStateAt;
      }
      state.statesTotal = (+state.statesTotal || 0) + 1;
      state.stateBytesTotal = (+state.stateBytesTotal || 0) + (+st.bytes || 0);
      state.lastStateAt = st.at && (!state.lastStateAt || String(st.at) > String(state.lastStateAt)) ? st.at : state.lastStateAt;
      added.states++;
    }
    const existingSnaps = await idbAllSnapshots();
    const seenSnap = new Set(existingSnaps.map((s) => [s.lifeId, s.type, s.ref, s.hash, s.at].join('|')));
    for (const sn of (payload.snapshots || [])) {
      if (!sn || !importedLifeIds.has(sn.lifeId)) continue;
      const key = [sn.lifeId, sn.type, sn.ref, sn.hash, sn.at].join('|');
      if (seenSnap.has(key)) continue;
      const row = clone(sn);
      delete row.id;
      await idbAddSnapshot(row);
      seenSnap.add(key);
      const bytes = +row.bytes || byteLen(row.text || '');
      const life = state.lives[sn.lifeId];
      if (life) {
        life.snapCount = (+life.snapCount || 0) + 1;
        life.snapBytes = (+life.snapBytes || 0) + bytes;
      }
      state.snapBytesTotal = (+state.snapBytesTotal || 0) + bytes;
      added.snapshots++;
    }
    const existingTimelines = await idbAllTimelines();
    const timelineMap = new Map(existingTimelines.map((t) => [t.lifeId, t]));
    for (const t of (payload.timelines || [])) {
      if (!t || !importedLifeIds.has(t.lifeId) || timelineMap.has(t.lifeId)) continue;
      await idbPutTimeline(t.lifeId, t.entries || []);
      timelineMap.set(t.lifeId, t);
      delete ui.timelineCache[t.lifeId];
      added.timelines++;
    }
    const existingCountries = await idbAllCountries();
    const countryMap = new Map(existingCountries.map((c) => [c.key, c]));
    for (const c of (payload.countries || [])) {
      if (!c || !c.key || countryMap.has(c.key)) continue;
      await idbPutCountry(c);
      countryMap.set(c.key, c);
      live.countryCache[c.key] = c;
      added.countries++;
    }
    state.countryCount = Object.keys(live.countryCache).length;
    const firstImported = Array.from(incomingIds)[0];
    if (!live.lifeId && firstImported && state.lives[firstImported]) {
      ui.view = 'life';
      ui.viewLifeId = firstImported;
      ui.tab = 'decisions';
      ui.filter = 'all';
      ui.pendingScrollTop = 0;
    }
    saveState(true);
    updateUI();
    showToast('start', '导入完成', '新增 ' + added.states + ' 状态 · ' + added.snapshots + ' 快照 · ' + added.lives + ' 人生');
    return added;
  }

  async function importRecorderFile(file) {
    if (!confirm('导入会合并到现有记录，不会清空。建议先导出现有 JSON。继续吗？')) return;
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch (e) {
      throw new Error('JSON 解析失败：' + (e && e.message ? e.message : e));
    }
    return importRecorderData(raw);
  }

  async function deleteLife(lifeId) {
    if (!state || !lifeId) return false;
    const life = state.lives[lifeId];
    if (!life) return false;
    const isCurrent = live.lifeId === lifeId;
    const name = lifeName(life);
    const counts = lifeCounts(life);
    const msg = '删除「' + name + '」？\n\n会删除这一生的 ' + counts.decisions + ' 条抉择、' + counts.focus + ' 条重心、' + counts.snapshots + ' 张文本快照、' + counts.states + ' 张状态照片。\n\n删除后不可恢复，建议先导出。' + (isCurrent ? '\n\n这是当前正在玩的人生，删除后本局停止记录，下一世重新开始。' : '');
    if (!confirm(msg)) return false;
    if (!confirm('最后确认：永久删除「' + name + '」，无法恢复。')) return false;
    if (state.deletedLifeIds.indexOf(String(lifeId)) < 0) state.deletedLifeIds.push(String(lifeId));
    const endedAt = life.endedAt || (life.result && (life.result.lifeAt || (life.result.deathAt && life.result.deathAt.lifeAt)));
    if (endedAt != null) {
      const endId = 'l' + endedAt;
      if (state.deletedLifeIds.indexOf(endId) < 0) state.deletedLifeIds.push(endId);
    }
    state.statesTotal = Math.max(0, (+state.statesTotal || 0) - counts.states);
    state.stateBytesTotal = Math.max(0, (+state.stateBytesTotal || 0) - (+life.stateBytes || 0));
    state.snapBytesTotal = Math.max(0, (+state.snapBytesTotal || 0) - (+life.snapBytes || 0));
    delete state.lives[lifeId];
    state.hookCaptures = (state.hookCaptures || []).filter((c) => !c || c.lifeId !== lifeId);
    state.snapshotsFallback = (state.snapshotsFallback || []).filter((s) => !s || s.lifeId !== lifeId);
    const leftStateTimes = Object.keys(state.lives).map((id) => state.lives[id].lastStateAt).filter(Boolean).sort();
    state.lastStateAt = leftStateTimes.length ? leftStateTimes[leftStateTimes.length - 1] : null;
    live.recentStates = (live.recentStates || []).filter((s) => s && s.lifeId !== lifeId);
    live.pendingAfter = (live.pendingAfter || []).filter((p) => !p || p.lifeId !== lifeId);
    delete ui.timelineCache[lifeId];
    if (isCurrent) {
      live.lifeId = null;
      live.deletedCurrentId = lifeId;
      live.currentDecision = null;
      live.lastAge = null;
      live.lastFocus = null;
      live.lastFocusClickAt = 0;
      live.lastSnapHash = {};
      live.sheetOpen = false;
      live.deadSeen = false;
      live.baselineDone = null;
      live.attributedIds = new Set();
      live.pendingBirthText = '';
      live.lastState = null;
    }
    if (ui.viewLifeId === lifeId || isCurrent) {
      ui.view = 'all';
      ui.viewLifeId = null;
      ui.tab = 'decisions';
      ui.filter = 'all';
      ui.limit = 50;
      ui.timelineLimit = 100;
      ui.pendingScrollTop = 0;
    }
    saveState(true);
    updateUI();
    showToast('death', '已删除', name + (isCurrent ? ' · 本局已停止记录' : ''));
    Promise.resolve().then(async () => {
      try {
        await idbDeleteSnapshotsForLife(lifeId);
        await idbDeleteStatesForLife(lifeId);
        await idbDeleteTimeline(lifeId);
      } catch (e) {
        warnOnce('delete', '部分记录删除失败：' + (e && e.message ? e.message : e), 'high');
      }
      saveState(true);
    }).catch(() => {});
    return true;
  }

  async function clearAll() {
    if (!confirm('清空全部记录？建议先导出备份。')) return;
    if (!confirm('最后确认：永久删除所有人生，无法恢复。')) return;
    const ids = Object.keys(state.lives || {});
    const deleted = new Set(state.deletedLifeIds || []);
    for (const id of ids) {
      deleted.add(String(id));
      const l = state.lives[id];
      const endedAt = l && (l.endedAt || (l.result && (l.result.lifeAt || (l.result.deathAt && l.result.deathAt.lifeAt))));
      if (endedAt != null) deleted.add('l' + endedAt);
    }
    const currentId = live.lifeId;
    try {
      localStorage.removeItem(LEGACY_KEY);
      localStorage.removeItem(META_KEY);
    } catch (_) {}
    state = defaultState();
    state.deletedLifeIds = Array.from(deleted);
    live.lifeId = null;
    live.deletedCurrentId = currentId || null;
    live.currentDecision = null;
    live.attributedIds = new Set();
    live.lastSnapHash = {};
    live.lastFocus = null;
    live.lastFocusClickAt = 0;
    live.lastSettingsHash = '';
    live.lastAge = null;
    live.baselineDone = null;
    live.deadSeen = false;
    live.recentStates = [];
    live.countryCache = Object.create(null);
    live.pendingAfter = [];
    live.lastState = null;
    live.stateSeq = 0;
    live.pendingSaveWrites = [];
    live.warned.clear();
    ui.view = 'all';
    ui.viewLifeId = null;
    ui.tab = 'decisions';
    ui.filter = 'all';
    ui.limit = 50;
    ui.timelineLimit = 100;
    ui.timelineCache = Object.create(null);
    ui.timelineLoading = Object.create(null);
    ui.openDetails.clear();
    ui.pendingScrollTop = 0;
    try {
      const a = readActiveSave();
      live.lastSaveRaw = a && a.raw ? a.raw : '';
    } catch (_) { live.lastSaveRaw = ''; }
    saveState(true);
    updateUI();
    showToast('death', '已清空', currentId ? '全部记录已删除；本局停止记录' : '全部记录已删除');
    Promise.resolve().then(async () => {
      try { await idbClearData(); } catch (_) {}
      saveState(true);
    }).catch(() => {});
  }

  function startObservers() {
    const obs = (el, cb) => {
      if (!el) return;
      try {
        const mo = new MutationObserver(() => safe(cb, 'observer'));
        mo.observe(el, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true, characterData: true });
      } catch (_) {}
    };
    obs($('#modal'), checkModal);
    obs($('#sheet'), checkSheet);
    obs($('#dead'), checkDead);
    obs($('#ageNum'), checkAge);
    obs($('#lifeview'), checkLifeview);
  }

  function onDocClick(e) {
    safe(() => {
      onChoice(e);
      onFocusClick(e);
      onSettingClick(e);
      onBeginClick(e);
    }, 'docClick');
  }

  function onTrustedKey(e) {
    if (!e || !e.isTrusted) return;
    const m = $('#modal');
    if (!m || m.hidden || !live.currentDecision || live.currentDecision.record.resolved) return;
    live.lastTrustedChoice = { at: Date.now(), key: null, sig: live.currentDecision.sig, age: live.currentDecision.record.age, kind: 'keyboard' };
  }

  function wireEvents() {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChangeCapture, true);
    document.addEventListener('keydown', onTrustedKey, true);
  }

  async function loadState() {
    let loaded = null;
    try { loaded = await idbGetState(); } catch (_) { loaded = null; }
    if (!loaded) {
      const old = lsGet(LEGACY_KEY, null);
      if (old && typeof old === 'object') loaded = old;
    }
    state = normalizeState(loaded || defaultState());
    state.diagnostics.warnings = (state.diagnostics.warnings || []).filter((w) => !w || w.code !== 'snapcap');
    for (const k of Array.from(live.warned)) {
      if (k === 'snapcap' || k.indexOf('snapcap|') === 0) live.warned.delete(k);
    }
    if (pendingWarnings.length) {
      for (const w of pendingWarnings) addWarningToState(w);
      pendingWarnings.length = 0;
    }
    updateMetaLS();
  }

  async function init() {
    if (!$('#app') || !$('#lifeview')) return;
    try {
      await loadState();
    } catch (e) {
      state = normalizeState(defaultState());
      for (const w of pendingWarnings) addWarningToState(w);
      pendingWarnings.length = 0;
      warn('error', '读取本地记录失败：' + (e && e.message ? e.message : e), 'high');
    }
    await loadCountries();
    const pendingSaves = live.pendingSaveWrites.splice(0);
    for (const item of pendingSaves) {
      captureStateFromSave(item.S, item.at, item.key, 'save');
    }
    installChoiceHook();
    detectBundle();
    backfillAll();
    refreshSettingsCatalog();
    ensureSettingsBaseline();
    let activeNow = null;
    try {
      activeNow = readActiveSave();
      if (activeNow && activeNow.S && activeNow.S.stats) live.lastAutoCount = +activeNow.S.stats.auto || 0;
    } catch (_) {}
    if (activeNow && activeNow.S && !live.lastState && !live.lastSaveKey && !pendingSaves.length) {
      live.lastSaveRaw = activeNow.raw || '';
      captureStateFromSave(activeNow.S, activeNow.at, activeNow.key, 'start');
    }
    saveState(true);
    initUI();
    wireEvents();
    startObservers();
    checkAnchors();
    reclassifyHistoryWarning();
    checkLifeview();
    checkAge();
    updateUI();
    setInterval(poll, 280);
    setInterval(pollSave, 2000);
    setInterval(() => {
      safe(checkAnchors, 'checkAnchors');
      safe(detectBundle, 'detectBundle');
    }, 10000);
    console.info('[1in8b-rec] recorder ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
