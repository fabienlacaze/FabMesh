/* MyFabmesh.AI — hero slideshow.
   Cycles the .ss-slide elements with a 4s interval. Pauses on hover.
   Manual control via the .ss-dot buttons.

   Each slide has a data-img attribute pointing to a real PNG inside
   docs/screenshots/. If the file exists, the slide swaps the CSS
   mockup for a real <img>. If it 404s, the mockup stays.
*/
(function () {
  'use strict';

  var slides   = Array.prototype.slice.call(document.querySelectorAll('.ss-slide'));
  var dots     = Array.prototype.slice.call(document.querySelectorAll('.ss-dot'));
  var captionEl= document.getElementById('ss-caption');
  if (!slides.length) return;

  var idx = 0;
  var INTERVAL_MS = 4000;
  var timer = null;
  var paused = false;

  // Try to load each slide's real screenshot. If 404, keep the mock.
  slides.forEach(function (slide) {
    var url = slide.getAttribute('data-img');
    if (!url) return;
    var img = new Image();
    img.onload = function () {
      // Clear the CSS mockup, swap in the real image.
      slide.innerHTML = '';
      var el = new Image();
      el.src = url;
      el.alt = slide.getAttribute('data-caption') || '';
      slide.appendChild(el);
    };
    // onerror = do nothing (mockup stays). Quiet 404 in console is fine.
    img.src = url;
  });

  function show(i) {
    slides.forEach(function (s, k) { s.classList.toggle('active', k === i); });
    dots.forEach(function (d, k)   { d.classList.toggle('active', k === i); });
    if (captionEl) captionEl.textContent =
      slides[i].getAttribute('data-caption') || '';
    idx = i;
  }

  function next() { show((idx + 1) % slides.length); }

  function start() {
    stop();
    timer = setInterval(function () { if (!paused) next(); }, INTERVAL_MS);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // Dot click jumps to that slide and resets the timer.
  dots.forEach(function (d) {
    d.addEventListener('click', function () {
      var i = parseInt(d.getAttribute('data-i'), 10) || 0;
      show(i);
      start();
    });
  });

  // Pause on hover so the user can read a slide they're interested in.
  var frame = document.querySelector('.ss-frame');
  if (frame) {
    frame.addEventListener('mouseenter', function () { paused = true; });
    frame.addEventListener('mouseleave', function () { paused = false; });
  }

  // Kick off
  show(0);
  start();
})();
