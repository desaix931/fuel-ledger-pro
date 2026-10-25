/* Fill-form session guard.
 *
 * The failure this prevents: a driver's login session dies while the fill
 * form sits open (page left in a tab, account signed out elsewhere, session
 * aged out). Tapping "Save fill" then posted the form to a dead session —
 * the server bounced it to a plain login screen BEFORE reading it, and the
 * whole fill, photos included, was silently discarded.
 *
 * The guard:
 *  1. Keeps a draft of the form — every field plus the BOL photos — in the
 *     phone's own storage (IndexedDB), updated as the driver types.
 *  2. Intercepts Save BEFORE the form is posted and checks the session with
 *     the server. Still signed in → the normal submit flow runs untouched.
 *     Signed out → nothing is posted; a clear "your login expired" banner
 *     appears and the draft stays put.
 *  3. After the driver signs back in and returns to the form, the draft is
 *     restored — fields, notes, and photos — ready to send with one tap.
 *
 * New fills only; the edit form renders its values from the saved fill.
 */
(function () {
  'use strict';

  var form = document.getElementById('fillform');
  if (!form) return;

  var DB_NAME = 'fuel-ledger';
  var STORE = 'fillDrafts';
  var KEY = 'new-fill';
  var LS_KEY = 'flpFillDraft';
  var SUBMITTED_FLAG = 'flpSubmitted';

  var expiredBanner = document.getElementById('session-expired-banner');
  var offlineBanner = document.getElementById('offline-banner');
  var restoredBanner = document.getElementById('restored-banner');
  var restoredText = document.getElementById('restored-text');
  var photosNote = document.getElementById('restoredphotos');
  var signinLink = document.getElementById('expired-signin');
  var discardBtn = document.getElementById('discard-draft');

  var dbPromise = null;
  var saveTimer = null;
  var approved = false; // set once the session check passes, so the real submit can flow

  // ---------- storage ----------

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!('indexedDB' in window)) return resolve(null);
      var rq;
      try { rq = indexedDB.open(DB_NAME, 1); } catch (e) { return resolve(null); }
      rq.onupgradeneeded = function () {
        if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE);
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { resolve(null); };
      rq.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  function idbOp(mode, fn) {
    return openDb().then(function (db) {
      if (!db) return { ok: false, result: null };
      return new Promise(function (resolve) {
        var out = null;
        var tx;
        try { tx = db.transaction(STORE, mode); } catch (e) { return resolve({ ok: false, result: null }); }
        var store = tx.objectStore(STORE);
        var rq = fn(store);
        if (rq) {
          rq.onsuccess = function () { out = rq.result; };
          rq.onerror = function () { out = null; };
        }
        tx.oncomplete = function () { resolve({ ok: true, result: out }); };
        tx.onerror = function () { resolve({ ok: false, result: null }); };
        tx.onabort = function () { resolve({ ok: false, result: null }); };
      });
    }).catch(function () { return { ok: false, result: null }; });
  }

  function idbPut(draft) {
    return idbOp('readwrite', function (store) { store.put(draft, KEY); return null; })
      .then(function (r) { return r.ok; });
  }

  function loadDraft() {
    return idbOp('readonly', function (store) { return store.get(KEY); }).then(function (r) {
      if (r.ok && r.result) return r.result;
      // Fallback store (fields only) for browsers without IndexedDB.
      try {
        var raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    });
  }

  // Resolves true only when the full draft (photos included) is safely in
  // IndexedDB. Otherwise keeps what it can in the fields-only fallback and
  // flags any photos it had to drop.
  function storeDraft(draft) {
    return idbPut(draft).then(function (ok) {
      if (ok) {
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
        return true;
      }
      if (draft.photos && draft.photos.length) {
        // Possibly a quota problem with the photo blobs — retry fields-only.
        var slim = Object.assign({}, draft, { photos: [], photoMeta: [], photosDropped: true });
        return idbPut(slim).then(function (ok2) {
          if (ok2) {
            try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
            return false;
          }
          return storeFallback(draft, true);
        });
      }
      return storeFallback(draft, false);
    });
  }

  function storeFallback(draft, dropped) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        v: 1, ts: draft.ts, expired: draft.expired,
        photosDropped: dropped || draft.photosDropped || false,
        fields: draft.fields, photos: [], photoMeta: [],
      }));
    } catch (e) { /* storage full/blocked — the on-screen form still holds the fill */ }
    return false;
  }

  function clearDraft() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    return idbOp('readwrite', function (store) { store.delete(KEY); return null; });
  }

  // ---------- draft capture ----------

  function collectFields() {
    var fields = {};
    var els = form.querySelectorAll('input[name], select[name], textarea[name]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.name === '_csrf') continue;
      if (el.type === 'file' || el.type === 'submit' || el.type === 'button') continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      fields[el.name] = el.value;
    }
    return fields;
  }

  function collectPhotos() {
    var input = form.querySelector('input[name="bol_photos"]');
    var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (!files.length) return Promise.resolve([]);
    var prep = window.compressPhotoFile || function (f) { return Promise.resolve(f); };
    return Promise.all(files.map(function (f) {
      return prep(f).catch(function () { return f; });
    }));
  }

  // A draft only counts if the driver actually entered something — the
  // auto-filled date/time and a GPS fix alone are not a fill worth restoring.
  var MEANINGFUL = ['customer_id', 'site_id', 'equipment_label', 'bol_number',
    'gallons', 'notes', 'fuel_type_custom'];
  function hasContent(draft) {
    if (!draft) return false;
    if (draft.photos && draft.photos.length) return true;
    var f = draft.fields || {};
    return MEANINGFUL.some(function (k) { return String(f[k] || '').trim() !== ''; });
  }

  function saveDraftNow(opts) {
    opts = opts || {};
    var fields = collectFields();
    return collectPhotos().then(function (photos) {
      var draft = {
        v: 1,
        ts: Date.now(),
        expired: !!opts.expired,
        photosDropped: false,
        fields: fields,
        photos: photos,
        photoMeta: photos.map(function (p) {
          return { name: p.name || 'bol.jpg', type: p.type || 'image/jpeg' };
        }),
      };
      if (!hasContent(draft) && !opts.expired) return clearDraft();
      if (opts.keepExpired) {
        return loadDraft().then(function (prev) {
          draft.expired = !!(prev && prev.expired);
          return storeDraft(draft);
        });
      }
      return storeDraft(draft);
    }).catch(function () { /* never let draft saving break the form */ });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveDraftNow({ keepExpired: true }); }, 400);
  }

  // ---------- session check ----------

  function checkSession() {
    return fetch('/session-status', {
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401) return 'expired';
      if (!r.ok) return 'unknown';
      return r.json().then(function (j) {
        if (j && j.csrf) {
          var tok = form.querySelector('input[name="_csrf"]');
          if (tok && tok.value !== j.csrf) tok.value = j.csrf;
        }
        return j && j.loggedIn ? 'ok' : 'expired';
      }).catch(function () { return 'unknown'; });
    }).catch(function () { return 'unknown'; });
  }

  // ---------- banners ----------

  function show(el) {
    if (!el) return;
    el.style.display = '';
    try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* older WebView — banner still shows */ }
  }
  function hide(el) { if (el) el.style.display = 'none'; }

  function showExpired() { hide(restoredBanner); hide(offlineBanner); show(expiredBanner); }
  function showOffline() { hide(restoredBanner); hide(expiredBanner); show(offlineBanner); }

  function showRestored(draft) {
    if (!restoredBanner) return;
    var msg = draft.expired
      ? 'Welcome back — your fill is restored exactly as you left it, photos and notes included. Check it over and tap Save fill to send it.'
      : 'You have an unsent fill saved on this phone — it\u2019s filled in below. Check it over and tap Save fill to send it, or discard it.';
    if (draft.photosDropped) {
      msg += ' Note: your photos couldn\u2019t be kept on this phone — please re-attach them below.';
    }
    if (restoredText) restoredText.textContent = msg;
    show(restoredBanner);
  }

  function showPhotosNote(draft) {
    if (!photosNote || !draft.photos || !draft.photos.length) return;
    var parts = draft.photos.map(function (p, i) {
      var meta = (draft.photoMeta && draft.photoMeta[i]) || {};
      var kb = p.size ? Math.max(1, Math.round(p.size / 1024)) : '?';
      return (meta.name || 'photo') + ' (' + kb + ' KB)';
    });
    photosNote.textContent = '\uD83D\uDCF7 ' + draft.photos.length +
      ' photo(s) attached: ' + parts.join(', ');
    photosNote.style.display = '';
  }

  // ---------- restore ----------

  function setField(name, value) {
    var el = form.querySelector('[name="' + name + '"]');
    if (!el || el.type === 'file') return null;
    el.value = value;
    return el;
  }

  function fireChange(el) {
    if (!el) return;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyDraft(draft) {
    var f = draft.fields || {};
    // Customer first: its change handler filters the site list (and may
    // clear a mismatched site), so the site is set after it has run.
    if (f.customer_id != null) fireChange(setField('customer_id', f.customer_id));
    Object.keys(f).forEach(function (name) {
      if (name === 'customer_id' || name === 'site_id' || name === 'fuel_type') return;
      setField(name, f[name]);
    });
    if (f.site_id != null) setField('site_id', f.site_id);
    if (f.fuel_type != null) fireChange(setField('fuel_type', f.fuel_type));
  }

  function restorePhotos(draft) {
    if (!draft.photos || !draft.photos.length) return;
    var input = form.querySelector('input[name="bol_photos"]');
    if (!input) return;
    try {
      var dt = new DataTransfer();
      draft.photos.forEach(function (blob, i) {
        var meta = (draft.photoMeta && draft.photoMeta[i]) || {};
        var file = blob instanceof File
          ? blob
          : new File([blob], meta.name || ('bol-' + (i + 1) + '.jpg'),
              { type: meta.type || blob.type || 'image/jpeg' });
        dt.items.add(file);
      });
      input.files = dt.files;
    } catch (e) {
      draft.photosDropped = true;
      return;
    }
    showPhotosNote(draft);
  }

  // ---------- submit interception ----------
  // Capture on document: the photo helper listens on the form itself, and a
  // capture-phase listener on an ancestor runs first — so the session check
  // can hold the submit before any photo work or posting happens. When the
  // check passes we re-submit and let the normal flow run untouched.

  document.addEventListener('submit', function (e) {
    if (e.target !== form) return;
    if (approved) return; // session verified — let the normal flow run
    e.preventDefault();
    e.stopPropagation();
    if (!form.checkValidity()) { form.reportValidity(); return; }

    var btn = form.querySelector('button[type=submit]');
    var origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking your login\u2026'; }

    saveDraftNow({ keepExpired: true }).then(checkSession).then(function (status) {
      if (btn) { btn.disabled = false; btn.textContent = origText; }
      if (status === 'ok') {
        approved = true;
        try { sessionStorage.setItem(SUBMITTED_FLAG, '1'); } catch (err) { /* ignore */ }
        if (form.requestSubmit) form.requestSubmit();
        else if (btn) btn.click();
      } else if (status === 'expired') {
        saveDraftNow({ expired: true }).then(showExpired);
      } else {
        showOffline();
      }
    });
  }, true);

  // ---------- wiring ----------

  form.addEventListener('input', scheduleSave);
  form.addEventListener('change', scheduleSave);
  form.addEventListener('click', scheduleSave); // gallon pad buttons set values without input events
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveDraftNow({ keepExpired: true });
    if (document.visibilityState === 'visible') {
      checkSession().then(function (s) { if (s === 'expired') showExpired(); });
    }
  });
  window.addEventListener('pagehide', function () { saveDraftNow({ keepExpired: true }); });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      checkSession().then(function (s) { if (s === 'expired') showExpired(); });
    }
  });

  if (signinLink) {
    signinLink.addEventListener('click', function (e) {
      e.preventDefault();
      var href = signinLink.href;
      var saved = saveDraftNow({ expired: true });
      var waited = new Promise(function (res) { setTimeout(res, 1200); });
      Promise.race([saved, waited]).then(function () { window.location.href = href; });
    });
  }

  if (discardBtn) {
    discardBtn.addEventListener('click', function () {
      clearDraft().then(function () {
        form.reset();
        fireChange(form.querySelector('[name="customer_id"]'));
        fireChange(form.querySelector('[name="fuel_type"]'));
        hide(restoredBanner);
        hide(expiredBanner);
        hide(offlineBanner);
        if (photosNote) { photosNote.style.display = 'none'; photosNote.textContent = ''; }
      });
    });
  }

  // ---------- on load: restore any saved draft, then sanity-check the session ----------

  loadDraft().then(function (draft) {
    if (draft && hasContent(draft)) {
      if (!window.__FLP_HAS_ERRORS__) applyDraft(draft); // on a validation re-render the server's values win
      restorePhotos(draft);
      if (!window.__FLP_HAS_ERRORS__) showRestored(draft);
      else showPhotosNote(draft);
    }
    checkSession().then(function (s) { if (s === 'expired') showExpired(); });
  });
})();
