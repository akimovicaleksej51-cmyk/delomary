/* fx3d — объёмные эффекты поверх страницы квеста (только визуал).
   - hero: 3D-пыль на WebGL, глубина слоёв за мышью, плёнка 1960-х и штамп архива;
   - галерея: 3D-лента с поворотом кадров;
   - карточки: наклон с бликом (только мышь);
   - метки секций: расшифровка текста при появлении.
   Ничего не делает при «уменьшить движение». */
(function(){
  'use strict';
  var RM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- «Улики»: стопка кадров из квеста в hero ----------
     Кадры берутся из галереи ниже; нажатие открывает тот же просмотрщик. */
  var EVID = [
    { f: 'photo-under-light', t: 'Мэри под лампой' },
    { f: 'photo-piano', t: 'Мэри играет на пианино' },
    { f: 'photo-actor-grab', t: 'Актёр в образе пациентки' },
    { f: 'photo-armchair', t: 'Мэри в кресле' }
  ];
  var heroMark = document.querySelector('.hero .hero-mark');
  var stack = null;
  if (heroMark){
    stack = document.createElement('div'); stack.className = 'fx3d-evidence';
    stack.innerHTML = EVID.map(function(e, i){
      return '<button type="button" class="ev-card" data-i="' + i + '" aria-label="Открыть кадр: ' + e.t + '">' +
        '<span class="ev-tape" aria-hidden="true"></span>' +
        '<img src="assets/' + e.f + '.webp" alt="" loading="eager" decoding="async">' +
        '</button>';
    }).join('');
    heroMark.insertAdjacentElement('afterend', stack);
    stack.addEventListener('click', function(ev){
      var b = ev.target.closest('.ev-card'); if (!b) return;
      var name = EVID[+b.getAttribute('data-i')].f;
      var img = document.querySelector('.gallery-grid img[src*="' + name + '"]');
      if (img) img.click();
    });
  }
  if (RM) return;
  var FINE = window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  var SMALL = window.matchMedia && window.matchMedia('(max-width:860px)').matches;
  var $ = function(s, r){ return (r || document).querySelector(s); };
  var $$ = function(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  document.documentElement.classList.add('fx3d-on');

  var hero = $('.hero'), heroWrap = hero && $('.wrap', hero);
  var heroVisible = true;
  if (hero && 'IntersectionObserver' in window){
    new IntersectionObserver(function(e){ heroVisible = e[0].isIntersecting; }, { threshold: 0 }).observe(hero);
  }

  /* ---------- плёнка 1960-х: зерно, засветка, края кадра, штамп архива ---------- */
  if (hero){
    var g = document.createElement('canvas'); g.width = g.height = 128;
    var gx = g.getContext('2d'), id = gx.createImageData(128, 128);
    for (var k = 0; k < id.data.length; k += 4){ var v = Math.random() * 255 | 0; id.data[k] = id.data[k+1] = id.data[k+2] = v; id.data[k+3] = 255; }
    gx.putImageData(id, 0, 0);
    var film = document.createElement('div'); film.className = 'fx3d-film'; film.setAttribute('aria-hidden', 'true');
    film.style.setProperty('--fx3d-grain', 'url(' + g.toDataURL() + ')');
    film.innerHTML = '<div class="cone"></div><div class="leak"></div><div class="grain"></div><div class="frame"></div>';
    hero.appendChild(film);
    var stamp = document.createElement('div'); stamp.className = 'fx3d-stamp'; stamp.setAttribute('aria-hidden', 'true');
    stamp.innerHTML = '<span class="ln"></span><span class="caret"></span><br><span class="sec">СЕКРЕТНО</span>';
    hero.appendChild(stamp);
    var line = 'АРХИВ «ДРЕДВУД» · ДЕЛО № 0417', ln = $('.ln', stamp), ci = 0;
    setTimeout(function type(){
      ln.textContent = line.slice(0, ++ci);
      if (ci < line.length) setTimeout(type, 45 + Math.random() * 70);
      else setTimeout(function(){ $('.sec', stamp).classList.add('on'); }, 350);
    }, 900);
  }

  /* ---------- WebGL: пыль и искры в объёме ---------- */
  function startParticles(){
    if (!hero) return;
    var cv = document.createElement('canvas'); cv.className = 'fx3d-canvas'; cv.setAttribute('aria-hidden', 'true');
    var gl = cv.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) return;
    hero.insertBefore(cv, hero.children[1] || null);
    var VS = [
      'attribute vec4 a;',            // xyz позиция, w — случайное число
      'uniform float t; uniform vec2 m; uniform float asp; uniform float dpr; uniform float sc;',
      'varying float v_a; varying float v_k; varying float v_f;',
      'void main(){',
      '  vec3 p = a.xyz;',
      '  float r = a.w;',
      '  p.y = mod(p.y + t * (0.025 + r * 0.05) + 1.0, 2.0) - 1.0;',                     // медленный подъём
      '  p.x += sin(t * (0.2 + r * 0.3) + r * 40.0) * 0.06;',
      '  p.z += cos(t * (0.15 + r * 0.2) + r * 20.0) * 0.05;',
      '  float z = p.z * 1.6 + 2.3;',                                                     // глубина 0.7..3.9
      '  vec2 cam = m * vec2(0.22, 0.14) * (1.0 / z) * 2.0;',
      '  vec2 s = (p.xy * vec2(1.6, 1.0)) / z + cam;',
      '  s.x /= asp;',
      '  gl_Position = vec4(s * 1.9, 0.0, 1.0);',
      '  gl_PointSize = (sc * (r > 0.93 ? 2.6 : 1.0) / z) * dpr;',
      '  v_a = clamp(1.6 / z, 0.15, 1.0) * (0.35 + 0.65 * fract(r * 13.7));',
      '  v_k = step(0.93, r);',
      '  v_f = v_k > 0.5 ? 0.6 + 0.4 * sin(t * 3.0 + r * 50.0) : 1.0;',
      '}'].join('\n');
    var FS = [
      'precision mediump float; varying float v_a; varying float v_k; varying float v_f;',
      'void main(){',
      '  vec2 c = gl_PointCoord - 0.5; float d = length(c);',
      '  float a = smoothstep(0.5, 0.0, d);',
      '  vec3 cold = vec3(0.55, 0.72, 0.95); vec3 warm = vec3(1.0, 0.78, 0.28);',
      '  vec3 col = mix(cold, warm, v_k);',
      '  float fl = v_f;',
      '  gl_FragColor = vec4(col * a * v_a * fl, a * v_a * fl);',
      '}'].join('\n');
    function sh(type, src){ var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { cv.remove(); return; }
    gl.useProgram(pr);
    var N = SMALL ? 420 : 1100, data = new Float32Array(N * 4);
    for (var i = 0; i < N; i++){ data[i*4] = Math.random()*2-1; data[i*4+1] = Math.random()*2-1; data[i*4+2] = Math.random()*2-1; data[i*4+3] = Math.random(); }
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
    var U = {}; ['t','m','asp','dpr','sc'].forEach(function(n){ U[n] = gl.getUniformLocation(pr, n); });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    function size(){
      var w = hero.clientWidth, h = hero.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      gl.viewport(0, 0, cv.width, cv.height);
      gl.uniform1f(U.asp, w / h); gl.uniform1f(U.dpr, dpr); gl.uniform1f(U.sc, SMALL ? 5 : 6.5);
    }
    size(); window.addEventListener('resize', size, { passive: true });
    var start = performance.now();
    function frame(now){
      requestAnimationFrame(frame);
      if (!heroVisible || document.hidden) return;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(U.t, (now - start) / 1000);
      gl.uniform2f(U.m, M.x, M.y);
      gl.drawArrays(gl.POINTS, 0, N);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- мышь / наклон телефона → плавная «камера» ---------- */
  var M = { x: 0, y: 0 }, T = { x: 0, y: 0 };
  if (FINE){
    window.addEventListener('pointermove', function(e){
      T.x = e.clientX / window.innerWidth * 2 - 1; T.y = -(e.clientY / window.innerHeight * 2 - 1);
    }, { passive: true });
  }
  (function loop(){
    requestAnimationFrame(loop);
    if (!FINE){ var tt = performance.now() / 1000; T.x = Math.sin(tt * 0.35) * 0.5; T.y = Math.cos(tt * 0.27) * 0.35; }
    M.x += (T.x - M.x) * 0.06; M.y += (T.y - M.y) * 0.06;
    if (heroWrap && heroVisible && !SMALL){
      heroWrap.style.transform = 'rotateY(' + (M.x * 5).toFixed(2) + 'deg) rotateX(' + (M.y * 3.5).toFixed(2) + 'deg)';
    }
  })();
  startParticles();

  /* стопка улик: верхний кадр каждые 4 с уходит назад; стопка следует за мышью */
  if (stack){
    var cards = $$('.ev-card', stack), order = cards.map(function(_, i){ return i; });
    var place = function(){ order.forEach(function(ci, pos){ cards[ci].setAttribute('data-pos', pos); }); };
    place();
    var hoverStack = false;
    stack.addEventListener('pointerenter', function(){ hoverStack = true; });
    stack.addEventListener('pointerleave', function(){ hoverStack = false; });
    setInterval(function(){
      if (!heroVisible || document.hidden || hoverStack) return;
      var top = cards[order[0]];
      top.classList.add('ev-out');
      setTimeout(function(){ order.push(order.shift()); place(); top.classList.remove('ev-out'); }, 380);
    }, 4000);
    (function tilt(){
      requestAnimationFrame(tilt);
      if (!heroVisible) return;
      stack.style.setProperty('--sx', (M.x * 10).toFixed(2) + 'deg');
      stack.style.setProperty('--sy', (M.y * 8).toFixed(2) + 'deg');
    })();
  }

  /* ---------- прожектор за курсором ---------- */
  if (FINE){
    var spot = document.createElement('div'); spot.className = 'fx3d-spot'; spot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(spot);
    window.addEventListener('pointermove', function(e){
      spot.style.setProperty('--mx', e.clientX + 'px'); spot.style.setProperty('--my', e.clientY + 'px'); spot.classList.add('on');
    }, { passive: true });
    document.addEventListener('pointerleave', function(){ spot.classList.remove('on'); });
  }

  /* ---------- наклон карточек с бликом ---------- */
  if (FINE){
    $$('.stat, .review, .rating-hero, .room-promo, .room-feats > div, .about-photo, .price-panel').forEach(function(el){
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.classList.add('fx3d-tilt');
      var g = document.createElement('span'); g.className = 'fx3d-glare'; g.setAttribute('aria-hidden', 'true'); el.appendChild(g);
      var big = el.offsetWidth > 420, k = big ? 6 : 12;
      el.addEventListener('pointermove', function(e){
        var r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        el.classList.add('is-tilting');
        el.style.transform = 'perspective(900px) rotateX(' + ((0.5 - py) * k).toFixed(2) + 'deg) rotateY(' + ((px - 0.5) * k).toFixed(2) + 'deg) translateZ(' + (big ? 6 : 14) + 'px)';
        el.style.boxShadow = ((0.5 - px) * 30).toFixed(0) + 'px ' + (24 + (0.5 - py) * 20).toFixed(0) + 'px 50px -24px rgba(0,0,0,.85)';
        g.style.setProperty('--gx', (px * 100).toFixed(1) + '%'); g.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
      });
      el.addEventListener('pointerleave', function(){ el.classList.remove('is-tilting'); el.style.transform = ''; el.style.boxShadow = ''; });
    });
  }

  /* ---------- галерея: 3D-лента ---------- */
  var gal = $('.gallery-grid');
  if (gal){
    var figs = $$('figure', gal), centers = [];
    var measure = function(){ centers = figs.map(function(f){ return f.offsetLeft + f.offsetWidth / 2; }); };
    var paint = function(){
      var mid = gal.scrollLeft + gal.clientWidth / 2, w = figs[0] ? figs[0].offsetWidth : 300;
      figs.forEach(function(f, i){
        var d = (centers[i] - mid) / (w * 1.15);              // −1 … 1 — соседние кадры
        var c = Math.max(-2.2, Math.min(2.2, d)), ad = Math.abs(c);
        f.style.transform = 'translateZ(' + (-ad * 140).toFixed(1) + 'px) rotateY(' + (-c * 28).toFixed(2) + 'deg) scale(' + (1 - Math.min(ad, 1.5) * 0.06).toFixed(3) + ')';
        f.style.setProperty('--shadeL', c < 0 ? Math.min(.65, ad * .4).toFixed(2) : 0);
        f.style.setProperty('--shadeR', c > 0 ? Math.min(.65, ad * .4).toFixed(2) : 0);
        f.style.zIndex = String(100 - Math.round(ad * 10));
      });
    };
    var ticking = false;
    gal.addEventListener('scroll', function(){ if (ticking) return; ticking = true; requestAnimationFrame(function(){ paint(); ticking = false; }); }, { passive: true });
    window.addEventListener('resize', function(){ measure(); paint(); }, { passive: true });
    window.addEventListener('load', function(){ measure(); paint(); });
    measure(); paint();
  }

  /* ---------- метки секций: «расшифровка» при появлении ---------- */
  var GLYPHS = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ0123456789#%/';
  function decode(el){
    var fin = el.textContent, n = fin.length, t0 = performance.now(), dur = 900;
    (function step(now){
      var p = Math.min(1, (now - t0) / dur), out = '';
      for (var i = 0; i < n; i++){
        var ch = fin[i];
        out += (ch === ' ' || i < p * n) ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(step); else el.textContent = fin;
    })(t0);
  }
  if ('IntersectionObserver' in window){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if (e.isIntersecting){ decode(e.target); io.unobserve(e.target); } });
    }, { threshold: 0.8 });
    $$('section .eyebrow').forEach(function(el){ io.observe(el); });
  }
})();
