/* Shared client-side photo compression.
 * Used by the CDL application form and the driver fill form.
 * Before submit, every file input's photos are resized to a max of 1600px on
 * the long edge and re-encoded as JPEG (~0.8 quality) via canvas, so a
 * multi-megapixel camera shot doesn't balloon the upload. No libraries.
 *
 * Usage: compressPhotosOnSubmit('myformid') — the form must exist in the DOM.
 */
(function () {
  'use strict';

  function processFile(file) {
    return new Promise(function (resolve) {
      if (!file.type.match(/^image\//)) return resolve(file); // let the server reject non-images
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, 1600 / Math.max(w, h));
        var alreadySmallJpeg = scale >= 1 && file.type === 'image/jpeg';
        if (alreadySmallJpeg) { URL.revokeObjectURL(url); return resolve(file); }
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (!blob) return resolve(file);
          var name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          resolve(new File([blob], name, { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.8);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function compressInput(input) {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return Promise.resolve();
    return Promise.all(files.map(processFile)).then(function (out) {
      var dt = new DataTransfer();
      out.forEach(function (f) { if (f) dt.items.add(f); });
      input.files = dt.files;
    });
  }

  window.compressPhotosOnSubmit = function (formId) {
    var form = document.getElementById(formId);
    if (!form) return;
    var submitBtn = form.querySelector('button[type=submit]');
    var origBtnText = submitBtn ? submitBtn.textContent : '';
    form.addEventListener('submit', function (e) {
      // Let the browser run its native validation (required fields, email
      // format) first — programmatic form.submit() below would bypass it.
      if (!form.checkValidity()) return;
      e.preventDefault(); // we'll submit programmatically after compression
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Preparing photos…';
      }
      var inputs = Array.prototype.slice.call(form.querySelectorAll('input[type=file]'));
      var chain = Promise.resolve();
      inputs.forEach(function (input) {
        chain = chain.then(function () { return compressInput(input); });
      });
      chain.then(function () { form.submit(); }).catch(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = origBtnText;
        }
        alert('Could not prepare one of your photos. Please try a smaller image.');
      });
    });
  };
})();
