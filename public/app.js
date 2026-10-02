// Small progressive enhancements. Every page works without JavaScript.
(function () {
  'use strict';

  // Confirm destructive actions.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var msg = form.getAttribute && form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Auto-submit the PayFast hand-off form.
  var auto = document.querySelector('form[data-autosubmit]');
  if (auto) setTimeout(function () { auto.submit(); }, 600);

  // Show the free-text municipality field when "Other" is chosen.
  document.querySelectorAll('select[data-other-toggle]').forEach(function (sel) {
    var target = document.getElementById(sel.getAttribute('data-other-toggle'));
    var sync = function () { if (target) target.hidden = sel.value !== 'other'; };
    sel.addEventListener('change', sync);
    sync();
  });

  // Copy-to-clipboard buttons.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = document.querySelector(btn.getAttribute('data-copy'));
      if (!src) return;
      var text = src.value || src.textContent;
      var done = function () {
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1800);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done);
      else { src.select(); document.execCommand('copy'); done(); }
    });
  });

  // Preview a chosen meter photo before upload.
  var photo = document.getElementById('photo');
  if (photo) {
    photo.addEventListener('change', function () {
      var old = document.getElementById('photo-preview');
      if (old) old.remove();
      if (!photo.files || !photo.files[0] || !/^image\/(jpeg|png|webp)/.test(photo.files[0].type)) return;
      var img = document.createElement('img');
      img.id = 'photo-preview';
      img.alt = 'Selected meter photo';
      img.style.cssText = 'margin-top:10px;max-height:220px;border-radius:10px;display:block';
      img.src = URL.createObjectURL(photo.files[0]);
      photo.parentNode.appendChild(img);
    });
  }
})();
