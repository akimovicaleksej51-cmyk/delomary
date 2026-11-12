/* fx3d — объёмные эффекты поверх страницы квеста (только визуал).
   Интерактив (работает всегда, в т.ч. при «уменьшить движение»):
   - «улики» в первом экране: колода кадров, листается свайпом/стрелками, нажатие — просмотр;
   - галерея и (на телефоне) отзывы: 3D-лента, кадры поворачиваются при листании пальцем.
   Атмосфера (только если в системе НЕ включено «уменьшить движение»):
   - плёнка 1960-х, штамп архива, 3D-пыль на WebGL, наклон за мышью, расшифровка подписей,
     автолистание колоды. */
(function(){
  'use strict';
  var mm = function(q){ return !!(window.matchMedia && window.matchMedia(q).matches); };
  var RM = mm('(prefers-reduced-motion: reduce)');
  var FINE = mm('(hover:hover) and (pointer:fine)');
  var SMALL = mm('(max-width:860px)');
  var $ = function(s, r){ return (r || document).querySelector(s); };
  var $$ = function(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;
  root.classList.add('fx3d-ui');
  if (!RM) root.classList.add('fx3d-on');

  var hero = $('.hero'), heroWrap = hero && $('.wrap', hero);
  var heroVisible = true;
  if (hero && 'IntersectionObserver' in window){
    new IntersectionObserver(function(e){ heroVisible = e[0].isIntersecting; }, { threshold: 0 }).observe(hero);
  }

  /* =====================================================================
     «Улики»: колода кадров из квеста
     ===================================================================== */
  var EVID = [
    { f: 'photo-under-light', t: 'Мэри под лампой' },
    { f: 'photo-piano', t: 'Мэри играет на пианино' },
    { f: 'photo-actor-grab', t: 'Актёр в образе пациентки' },
    { f: 'photo-armchair', t: 'Мэри в кресле' }
  ];
  var heroMark = $('.hero .hero-mark');
  var deck = null;
  if (heroMark){
    var stack = document.createElement('div'); stack.className = 'fx3d-evidence';
    stack.innerHTML = EVID.map(function(e, i){
      return '<button type="button" class="ev-card" data-i="' + i + '" aria-label="Открыть кадр: ' + e.t + '">' +
        '<span class="ev-tape" aria-hidden="true"></span>' +
        '<img src="assets/' + e.f + '.webp" alt="" loading="eager" decoding="async" draggable="false">' +
        '</button>';
    }).join('') +
    '<div class="ev-dots" aria-hidden="true">' + EVID.map(function(){ return '<i></i>'; }).join('') + '</div>';
    heroMark.insertAdjacentElement('afterend', stack);

    var cards = $$('.ev-card', stack), dots = $$('.ev-dots i', stack);
    var order = cards.map(function(_, i){ return i; });
    var lastTouch = 0, hoverMouse = false, dragged = false;
    var place = function(){
      order.forEach(function(ci, pos){ cards[ci].setAttribute('data-pos', pos); cards[ci].tabIndex = pos === 0 ? 0 : -1; });
      dots.forEach(function(d, i){ d.classList.toggle('on', i === order[0]); });
    };
    place();
    cards.forEach(function(c){ c.style.willChange = 'transform, opacity'; });

    // Листание без блокировки: новый свайп можно делать сразу, предыдущий кадр
    // мгновенно «доезжает» в конец стопки. Кадр улетает в сторону свайпа и всё.
    var flying = null; // { el, timer }
    var settle = function(f){
      clearTimeout(f.timer);
      var el = f.el;
      el.style.transition = 'none'; el.style.opacity = '0'; el.style.transform = ''; el.style.zIndex = '';
      place();
      void el.offsetWidth;
      el.style.transition = 'opacity .18s ease-out'; el.style.opacity = '';
      setTimeout(function(){ if (el.style.transition.indexOf('opacity') === 0) el.style.transition = ''; }, 200);
    };
    // положение верхнего кадра, сдвинутого на dx: тот же набор преобразований, что у него в покое
    // (на компьютере — с глубиной и поворотом), чтобы при старте движения ничего не «прыгало»
    var held = function(dx, dy, rz){
      return SMALL
        ? 'translate3d(' + dx + 'px,' + dy + 'px,0) rotateZ(' + rz + 'deg)'
        : 'translate3d(' + dx + 'px,' + dy + 'px,60px) rotateY(' + (-10 + (parseFloat(stack.style.getPropertyValue('--sx')) || 0)).toFixed(2) + 'deg) rotateX(' + (parseFloat(stack.style.getPropertyValue('--sy')) || 0).toFixed(2) + 'deg) rotateZ(' + rz + 'deg)';
    };
    var go = function(dir, flyX, fromX){
      if (flying){ settle(flying); flying = null; }
      if (dir < 0){ order.unshift(order.pop()); place(); return; }
      var top = cards[order[0]], sign = (flyX || -1) > 0 ? 1 : -1;
      var dragged0 = typeof fromX === 'number';
      if (!dragged0){
        // мягкий уход (автолистание, клик, клавиатура): с текущего места, без рывка
        var cs = getComputedStyle(top).transform;
        top.style.transition = 'none'; top.style.transform = cs === 'none' ? '' : cs;
      }
      order.push(order.shift()); place();            // точки и следующий кадр — сразу
      top.setAttribute('data-pos', 'fly');
      top.style.zIndex = '6';
      if (RM){ var f0 = { el: top }; settle(f0); top.style.zIndex = ''; top.setAttribute('data-pos', '3'); place(); return; }
      var dur;
      if (dragged0){
        // после свайпа — продолжает движение пальца и улетает за край стопки
        var w = stack.offsetWidth, x1 = sign * (w + 220);
        top.style.transition = 'none';
        top.style.transform = held(fromX, Math.abs(fromX) * -0.08, fromX * 0.06 - 2);
        void top.offsetWidth;
        dur = SMALL ? 260 : 380;
        top.style.transition = 'transform ' + dur + 'ms cubic-bezier(.2,.6,.4,1), opacity ' + dur + 'ms ease-in';
        top.style.transform = held(x1, -40, sign * 22);
      } else {
        void top.offsetWidth;
        dur = 560;
        top.style.transition = 'transform ' + dur + 'ms cubic-bezier(.3,0,.2,1), opacity ' + (dur - 60) + 'ms ease-in';
        top.style.transform = held(sign * (SMALL ? 150 : 190), -30, sign * 12);
      }
      top.style.opacity = '0';
      // завершаем по реальному окончанию анимации (а не по таймеру), чтобы кадр не обрывался на полпути
      var land = function(){ top.removeEventListener('transitionend', onEnd); if (!flying || flying.el !== top) return; var f = flying; flying = null; f.el.style.zIndex = ''; place(); settle(f); };
      var onEnd = function(e){ if (e.target === top && e.propertyName === 'transform') land(); };
      top.addEventListener('transitionend', onEnd);
      flying = { el: top, timer: setTimeout(land, dur + 400) };
    };
    deck = { go: go, get dragging(){ return active || !!flying; } };

    // нажатие — открыть этот кадр в просмотре галереи (если это было не перелистывание)
    stack.addEventListener('click', function(ev){
      var b = ev.target.closest('.ev-card'); if (!b) return;
      if (dragged){ dragged = false; ev.preventDefault(); return; }
      if (b.getAttribute('data-pos') !== '0'){ go(1); return; }
      var img = document.querySelector('.gallery-grid img[src*="' + EVID[+b.getAttribute('data-i')].f + '"]');
      if (img) img.click();
    });
    // клавиатура: стрелки листают
    stack.addEventListener('keydown', function(e){
      if (e.key === 'ArrowRight'){ e.preventDefault(); go(1); cards[order[0]].focus(); }
      if (e.key === 'ArrowLeft'){ e.preventDefault(); go(-1); cards[order[0]].focus(); }
    });
    // свайп: кадр идёт за пальцем (через requestAnimationFrame), резкий взмах тоже листает
    var sx = 0, sy = 0, dx = 0, active = false, horiz = null, topEl = null, raf = 0, lastX = 0, lastT = 0, vel = 0;
    var paintDrag = function(){
      raf = 0; if (!active || !topEl) return;
      topEl.style.transform = held(dx, Math.abs(dx) * -0.08, dx * 0.06 - 2);
    };
    stack.addEventListener('pointerdown', function(e){
      if (e.button > 0) return;
      if (flying){ var f = flying; flying = null; f.el.style.zIndex = ''; place(); settle(f); }
      topEl = cards[order[0]];
      if (!topEl.contains(e.target)) { topEl = null; return; }
      active = true; horiz = null; dx = 0; vel = 0; sx = lastX = e.clientX; sy = e.clientY; lastT = e.timeStamp; lastTouch = Date.now();
    });
    window.addEventListener('pointermove', function(e){
      if (!active) return;
      var mx = e.clientX - sx, my = e.clientY - sy;
      if (horiz === null && (Math.abs(mx) > 6 || Math.abs(my) > 6)){
        horiz = Math.abs(mx) > Math.abs(my);
        if (horiz) topEl.style.transition = 'none';
      }
      if (!horiz) return;
      var dt = Math.max(1, e.timeStamp - lastT);
      vel = vel * 0.6 + ((e.clientX - lastX) / dt) * 0.4; lastX = e.clientX; lastT = e.timeStamp;
      dx = mx;
      if (!raf) raf = requestAnimationFrame(paintDrag);
    }, { passive: true });
    var end = function(){
      if (!active) return; active = false; lastTouch = Date.now();
      if (raf){ cancelAnimationFrame(raf); raf = 0; }
      if (!horiz){ return; }
      dragged = Math.abs(dx) > 6;
      var fling = Math.abs(vel) > 0.35 && Math.abs(dx) > 20;
      if (Math.abs(dx) > 60 || fling) go(1, fling ? vel : dx, dx);
      else { topEl.style.transition = 'transform .22s cubic-bezier(.2,0,0,1)'; topEl.style.transform = '';
             setTimeout(function(){ if (topEl && !active) topEl.style.transition = ''; }, 240); }
    };
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    stack.addEventListener('pointerenter', function(e){ if (e.pointerType === 'mouse') hoverMouse = true; });
    stack.addEventListener('pointerleave', function(e){ if (e.pointerType === 'mouse') hoverMouse = false; });

    // автолистание: только без «уменьшить движение», пауза при наведении мышью и 8 с после касания
    if (!RM){
      setInterval(function(){
        if (!heroVisible || document.hidden || hoverMouse || active || flying || Date.now() - lastTouch < 8000) return;
        if (stack.contains(document.activeElement)) return;
        go(1);
      }, 4000);
    }
  }

  /* =====================================================================
     3D-лента для горизонтальных лент (галерея; отзывы на телефоне)
     ===================================================================== */
  function coverflow(track, items, o){
    var centers = [];
    var measure = function(){ centers = items.map(function(f){ return f.offsetLeft + f.offsetWidth / 2; }); };
    var paint = function(){
      var mid = track.scrollLeft + track.clientWidth / 2, w = items[0] ? items[0].offsetWidth : 300;
      items.forEach(function(f, i){
        var c = Math.max(-2.2, Math.min(2.2, (centers[i] - mid) / (w * o.spread))), ad = Math.abs(c);
        f.style.transform = 'translateZ(' + (-ad * o.depth).toFixed(1) + 'px) rotateY(' + (-c * o.rot).toFixed(2) + 'deg) scale(' + (1 - Math.min(ad, 1.5) * o.shrink).toFixed(3) + ')';
        f.style.setProperty('--shadeL', c < 0 ? Math.min(.65, ad * .45).toFixed(2) : 0);
        f.style.setProperty('--shadeR', c > 0 ? Math.min(.65, ad * .45).toFixed(2) : 0);
        f.style.zIndex = String(100 - Math.round(ad * 10));
        f.classList.toggle('cf-center', ad < 0.5);
      });
    };
    var ticking = false;
    track.addEventListener('scroll', function(){ if (ticking) return; ticking = true; requestAnimationFrame(function(){ paint(); ticking = false; }); }, { passive: true });
    window.addEventListener('resize', function(){ measure(); paint(); }, { passive: true });
    window.addEventListener('load', function(){ measure(); paint(); });
    measure(); paint();
  }
  var gal = $('.gallery-grid');
  if (gal) coverflow(gal, $$('figure', gal), SMALL ? { spread: 1.0, depth: 70, rot: 22, shrink: 0.08 } : { spread: 1.15, depth: 140, rot: 28, shrink: 0.06 });
  var revs = $('.reviews-grid');
  if (revs && SMALL){
    revs.classList.add('fx3d-swipe');
    var rv = $$('.review', revs);
    coverflow(revs, rv, { spread: 1.0, depth: 60, rot: 18, shrink: 0.06 });
    var rdots = document.createElement('div'); rdots.className = 'fx3d-rdots'; rdots.setAttribute('aria-hidden', 'true');
    rdots.innerHTML = rv.map(function(){ return '<i></i>'; }).join('');
    revs.insertAdjacentElement('afterend', rdots);
    var rd = $$('i', rdots);
    var rpaint = function(){ var w = rv[0].offsetWidth + 14, k = Math.round(revs.scrollLeft / w); rd.forEach(function(d, i){ d.classList.toggle('on', i === k); }); };
    revs.addEventListener('scroll', rpaint, { passive: true }); rpaint();
  }

  /* =====================================================================
     Дальше — только атмосфера: без «уменьшить движение»
     ===================================================================== */
  if (RM) return;

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

  /* ---------- мышь → плавная «камера» (на телефоне — медленное покачивание) ---------- */
  var M = { x: 0, y: 0 }, T = { x: 0, y: 0 };
  if (FINE){
    window.addEventListener('pointermove', function(e){
      T.x = e.clientX / window.innerWidth * 2 - 1; T.y = -(e.clientY / window.innerHeight * 2 - 1);
    }, { passive: true });
  }
  var stackEl = $('.fx3d-evidence');
  var lastHW = '', lastSX = '', lastSY = '';
  (function loop(){
    requestAnimationFrame(loop);
    if (!heroVisible) return;
    // пока кадр стопки летит или его тянут — первый экран не двигаем: любое изменение 3D-сцены
    // перезапускает анимацию кадра, и он «застывает», а потом резко исчезает
    if (deck && deck.dragging) return;
    if (!FINE){ var tt = performance.now() / 1000; T.x = Math.sin(tt * 0.35) * 0.5; T.y = Math.cos(tt * 0.27) * 0.35; }
    M.x += (T.x - M.x) * 0.06; M.y += (T.y - M.y) * 0.06;
    if (SMALL) return;
    var hw = 'rotateY(' + (M.x * 5).toFixed(2) + 'deg) rotateX(' + (M.y * 3.5).toFixed(2) + 'deg)';
    if (heroWrap && hw !== lastHW){ heroWrap.style.transform = lastHW = hw; }
    if (stackEl){
      var sxv = (M.x * 10).toFixed(1) + 'deg', syv = (M.y * 8).toFixed(1) + 'deg';
      if (sxv !== lastSX){ stackEl.style.setProperty('--sx', lastSX = sxv); }
      if (syv !== lastSY){ stackEl.style.setProperty('--sy', lastSY = syv); }
    }
  })();

  /* ---------- WebGL: пыль и искры в объёме ---------- */
  (function startParticles(){
    if (!hero) return;
    var cv = document.createElement('canvas'); cv.className = 'fx3d-canvas'; cv.setAttribute('aria-hidden', 'true');
    var gl = cv.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) return;
    hero.insertBefore(cv, hero.children[1] || null);
    var VS = [
      'attribute vec4 a;',
      'uniform float t; uniform vec2 m; uniform float asp; uniform float dpr; uniform float sc;',
      'varying float v_a; varying float v_k; varying float v_f;',
      'void main(){',
      '  vec3 p = a.xyz; float r = a.w;',
      '  p.y = mod(p.y + t * (0.025 + r * 0.05) + 1.0, 2.0) - 1.0;',
      '  p.x += sin(t * (0.2 + r * 0.3) + r * 40.0) * 0.06;',
      '  p.z += cos(t * (0.15 + r * 0.2) + r * 20.0) * 0.05;',
      '  float z = p.z * 1.6 + 2.3;',
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
      '  float d = length(gl_PointCoord - 0.5);',
      '  float a = smoothstep(0.5, 0.0, d);',
      '  vec3 col = mix(vec3(0.55, 0.72, 0.95), vec3(1.0, 0.78, 0.28), v_k);',
      '  gl_FragColor = vec4(col * a * v_a * v_f, a * v_a * v_f);',
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
    var lw = 0, lh = 0;
    function size(){
      var w = hero.clientWidth, h = hero.clientHeight;
      // на телефоне resize прилетает при каждом появлении/скрытии адресной строки — не пересоздаём холст зря
      if (w === lw && Math.abs(h - lh) < 120) return;
      lw = w; lh = h;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      gl.viewport(0, 0, cv.width, cv.height);
      gl.uniform1f(U.asp, w / h); gl.uniform1f(U.dpr, dpr); gl.uniform1f(U.sc, SMALL ? 5 : 6.5);
    }
    size(); window.addEventListener('resize', size, { passive: true });
    var start = performance.now();
    (function frame(now){
      requestAnimationFrame(frame);
      if (!heroVisible || document.hidden || !now) return;
      if (SMALL && deck && deck.dragging) return;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(U.t, (now - start) / 1000);
      gl.uniform2f(U.m, M.x, M.y);
      gl.drawArrays(gl.POINTS, 0, N);
    })();
  })();

  /* ---------- прожектор за курсором и наклон карточек (только мышь) ---------- */
  if (FINE){
    var spot = document.createElement('div'); spot.className = 'fx3d-spot'; spot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(spot);
    window.addEventListener('pointermove', function(e){
      spot.style.setProperty('--mx', e.clientX + 'px'); spot.style.setProperty('--my', e.clientY + 'px'); spot.classList.add('on');
    }, { passive: true });
    document.addEventListener('pointerleave', function(){ spot.classList.remove('on'); });

    $$('.stat, .review, .rating-hero, .room-promo, .room-feats > div, .about-photo, .price-panel').forEach(function(el){
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.classList.add('fx3d-tilt');
      var gl = document.createElement('span'); gl.className = 'fx3d-glare'; gl.setAttribute('aria-hidden', 'true'); el.appendChild(gl);
      var big = el.offsetWidth > 420, kk = big ? 6 : 12;
      el.addEventListener('pointermove', function(e){
        var r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        el.classList.add('is-tilting');
        el.style.transform = 'perspective(900px) rotateX(' + ((0.5 - py) * kk).toFixed(2) + 'deg) rotateY(' + ((px - 0.5) * kk).toFixed(2) + 'deg) translateZ(' + (big ? 6 : 14) + 'px)';
        el.style.boxShadow = ((0.5 - px) * 30).toFixed(0) + 'px ' + (24 + (0.5 - py) * 20).toFixed(0) + 'px 50px -24px rgba(0,0,0,.85)';
        gl.style.setProperty('--gx', (px * 100).toFixed(1) + '%'); gl.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
      });
      el.addEventListener('pointerleave', function(){ el.classList.remove('is-tilting'); el.style.transform = ''; el.style.boxShadow = ''; });
    });
  }

  /* ---------- метки секций: «расшифровка» при появлении ---------- */
  var GLYPHS = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ0123456789#%/';
  function decode(el){
    var fin = el.textContent, n = fin.length, t0 = performance.now(), dur = 900;
    (function step(now){
      var p = Math.min(1, ((now || t0) - t0) / dur), out = '';
      for (var i = 0; i < n; i++){
        var ch = fin[i];
        out += (ch === ' ' || i < p * n) ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(step); else el.textContent = fin;
    })(t0);
  }
  if (!SMALL && 'IntersectionObserver' in window){   // на телефоне без «расшифровки»: перенос строк скакал бы
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if (e.isIntersecting){ decode(e.target); io.unobserve(e.target); } });
    }, { threshold: 0.8 });
    $$('section .eyebrow').forEach(function(el){ io.observe(el); });
  }
})();
