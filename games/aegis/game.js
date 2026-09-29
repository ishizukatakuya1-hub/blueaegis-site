/* AEGIS — 盾でコアを守るブラウザゲーム
   依存なし。Canvas 2D と標準APIだけで動かす。
   記録は端末の localStorage にだけ置き、どこへも送らない（プライバシーポリシーと対応）。 */
(function () {
  'use strict';

  /* ---------------- 調整用の定数 ----------------
     難しさは DIFF.rampSec 秒かけて上限へ上がる。数字だけ変えれば曲線を直せる。 */
  var DIFF = {
    rampSec: 180,
    intervalStart: 1.1, intervalEnd: 0.36,   // 弾の出る間隔（秒）
    speedStart: 0.42, speedEnd: 0.95,        // 弾の速さ（画面半径／秒）
    unlockCurve: 30, unlockSplit: 60, unlockFast: 90,
    humanTurn: 5.0                           // 人が盾を回せる速さの目安（rad/秒）。出現角の飛びをこれで抑える
  };
  /* 長さは「画面の半分＝1」の単位 */
  var W = {
    core: 0.12, shield: 0.36, shieldW: 0.05, arc: 0.55,
    spawn: 1.12, bullet: 0.03, split: 0.72, splitGap: 0.3,
    maxTurn: 16, keyTurn: 4.8
  };
  var STEP = 1 / 120;   // 固定刻み。今日のチャレンジを端末の速さによらず同じ展開にするため
  var URL = 'https://blueaegis.co.jp/games/aegis/';
  var COLOR = { straight: '#FF7A66', curve: '#FFC24D', split: '#D98BFF', fast: '#FF4057' };

  /* ---------------- 言葉 ---------------- */
  var JA = (navigator.language || '').toLowerCase().indexOf('ja') === 0;
  var T = JA ? {
    sub: '盾を回して、コアを守れ', daily: '今日のチャレンジ', endless: 'エンドレス',
    todayRec: '今日の記録', best: '自己ベスト', none: 'まだありません',
    unit: 'ブロック', over: 'コアが破られた', newBest: '自己ベスト更新', again: 'もう一度',
    share: '結果を共有', menu: 'メニューへ', copied: '結果をコピーしました', copyFail: 'コピーできませんでした',
    paused: '一時停止中', resume: 'タップで再開', soundOn: '音 オン', soundOff: '音 オフ',
    hint: 'ドラッグ・マウスで盾を向ける／キーボードは ← →',
    dailyNote: '今日のチャレンジは、同じ日なら世界中の誰もが同じ攻撃を受けます。',
    line: function (mode, date, n) {
      return mode === 'daily' ? 'AEGIS 今日のチャレンジ ' + date + '｜' + n + 'ブロック'
                              : 'AEGIS エンドレス｜' + n + 'ブロック';
    }
  } : {
    sub: 'Turn the shield. Guard the core.', daily: 'Daily Challenge', endless: 'Endless',
    todayRec: "Today's best", best: 'Best', none: 'none yet',
    unit: 'blocks', over: 'The core was breached', newBest: 'New best', again: 'Play again',
    share: 'Share result', menu: 'Menu', copied: 'Result copied', copyFail: 'Could not copy',
    paused: 'Paused', resume: 'Tap to resume', soundOn: 'Sound on', soundOff: 'Sound off',
    hint: 'Drag or move the mouse to aim the shield / keys: ← →',
    dailyNote: 'Everyone in the world gets the same attack pattern on the same day.',
    line: function (mode, date, n) {
      return mode === 'daily' ? 'AEGIS Daily Challenge ' + date + ' | ' + n + ' blocks'
                              : 'AEGIS Endless | ' + n + ' blocks';
    }
  };

  /* ---------------- 小道具 ---------------- */
  var TAU = Math.PI * 2;
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrap(a) { a %= TAU; return a < 0 ? a + TAU : a; }
  function angDiff(a, b) { var d = wrap(a - b); return d > Math.PI ? d - TAU : d; }

  /* 日付は日本時間で決める（端末の時差で「今日」がずれないように） */
  function dateJst() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) {
      var d = new Date(Date.now() + 9 * 3600e3);
      return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
    }
  }
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }
  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) >>> 0;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, String(v)); } catch (e) { /* 保存できなくても遊べる */ } }
  };
  function bestOf(key) { var v = parseInt(store.get(key), 10); return isNaN(v) ? null : v; }

  /* ---------------- 画面 ---------------- */
  var root = document.getElementById('aegis');
  if (!root) return;
  var canvas = document.getElementById('aegis-canvas');
  var ui = document.getElementById('aegis-ui');
  var soundBtn = document.getElementById('aegis-sound');
  var ctx = canvas.getContext('2d');
  var size = 0, S = 0, dpr = 1, bg = null;

  function resize() {
    var r = root.getBoundingClientRect();
    size = Math.max(200, Math.floor(r.width));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = size / 2;
    bg = ctx.createRadialGradient(S, S, 0, S, S, S * 1.45);
    bg.addColorStop(0, '#12406F');
    bg.addColorStop(0.55, '#0A2A4F');
    bg.addColorStop(1, '#061A33');
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(root);
  else window.addEventListener('resize', resize);
  resize();

  /* ---------------- 音（初期はオフ） ---------------- */
  var audio = null, soundOn = store.get('aegis.sound') === '1';
  function paintSound() {
    soundBtn.textContent = soundOn ? T.soundOn : T.soundOff;
    soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  }
  function tone(freq, dur, type, vol) {
    if (!soundOn) return;
    try {
      if (!audio) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audio = new AC();
      }
      var t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* 音が出なくても遊べる */ }
  }
  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    store.set('aegis.sound', soundOn ? '1' : '0');
    paintSound();
    tone(660, 0.12, 'sine', 0.08);
  });
  paintSound();

  /* ---------------- 状態 ----------------
     menu → play ⇄ paused → dying → over */
  var state = 'menu';
  var g = null;          // 1回のプレイ
  var fx = [];           // 火花（見た目だけ。乱数は Math.random で、展開には影響しない）
  var keys = { left: false, right: false };
  var pointerAngle = null;
  var shake = 0, flash = 0;

  function progress(t) { return Math.min(t / DIFF.rampSec, 1); }
  function interval(t) { return lerp(DIFF.intervalStart, DIFF.intervalEnd, progress(t)); }

  function newGame(mode) {
    var date = dateJst();
    var seed = mode === 'daily' ? hashStr('aegis:' + date) : (Math.random() * 4294967296) >>> 0;
    g = {
      mode: mode, date: date, rng: mulberry32(seed),
      t: 0, score: 0, shield: -Math.PI / 2, lastA: -Math.PI / 2,
      next: 1.0, bullets: [], shieldGlow: 0, dieT: 0
    };
    pointerAngle = null;
    fx = [];
    state = 'play';
    hideUi();
    tone(440, 0.15, 'triangle', 0.06);
  }

  function spawn() {
    var rng = g.rng, t = g.t;
    var kinds = ['straight'], weights = [1];
    if (t >= DIFF.unlockCurve) { kinds.push('curve'); weights.push(0.7); }
    if (t >= DIFF.unlockSplit) { kinds.push('split'); weights.push(0.5); }
    if (t >= DIFF.unlockFast)  { kinds.push('fast');  weights.push(0.4); }
    var sum = 0, i;
    for (i = 0; i < weights.length; i++) sum += weights[i];
    var r = rng() * sum, kind = kinds[0];
    for (i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) { kind = kinds[i]; break; } }

    /* 直前の弾から、人が盾を回して間に合う範囲にだけ出す */
    var maxJump = Math.min(Math.PI, DIFF.humanTurn * interval(t));
    var a = wrap(g.lastA + (rng() * 2 - 1) * maxJump);
    g.lastA = a;
    var v = lerp(DIFF.speedStart, DIFF.speedEnd, progress(t)) * (kind === 'fast' ? 1.55 : 1) * (0.9 + rng() * 0.2);
    var dir = rng() < 0.5 ? -1 : 1, spin = 0.5 + rng() * 0.5;
    g.bullets.push({ a: a, d: W.spawn, v: v, w: kind === 'curve' ? dir * spin : 0, kind: kind });
  }

  function burst(a, d, color, n, speed) {
    var x = S + Math.cos(a) * d * S, y = S + Math.sin(a) * d * S;
    for (var i = 0; i < n; i++) {
      var th = Math.random() * TAU, sp = (0.3 + Math.random()) * speed;
      fx.push({ x: x, y: y, vx: Math.cos(th) * sp, vy: Math.sin(th) * sp, life: 0.5 + Math.random() * 0.3, max: 0.8, c: color });
    }
  }

  function update(h) {
    g.t += h;

    /* 盾：キーは一定速度、ポインタは向いた先へ追従（速すぎる振り回しは上限で抑える） */
    if (keys.left) g.shield -= W.keyTurn * h;
    if (keys.right) g.shield += W.keyTurn * h;
    if (pointerAngle !== null && !keys.left && !keys.right) {
      var d = angDiff(pointerAngle, g.shield), m = W.maxTurn * h;
      g.shield += Math.max(-m, Math.min(m, d));
    }
    g.shield = wrap(g.shield);
    if (g.shieldGlow > 0) g.shieldGlow = Math.max(0, g.shieldGlow - h * 4);

    g.next -= h;
    if (g.next <= 0) { spawn(); g.next += interval(g.t); }

    var list = g.bullets;
    for (var i = list.length - 1; i >= 0; i--) {
      var b = list[i], prev = b.d;
      b.d -= b.v * h;
      b.a = wrap(b.a + b.w * h);

      if (b.kind === 'split' && b.d < W.split) {
        list.splice(i, 1);
        list.push({ a: wrap(b.a - W.splitGap), d: b.d, v: b.v, w: 0, kind: 'straight', child: true });
        list.push({ a: wrap(b.a + W.splitGap), d: b.d, v: b.v, w: 0, kind: 'straight', child: true });
        burst(b.a, b.d, COLOR.split, 6, 60);
        continue;
      }

      if (prev > W.shield && b.d <= W.shield) {
        var tol = W.arc + W.bullet / W.shield;
        if (Math.abs(angDiff(b.a, g.shield)) <= tol) {
          list.splice(i, 1);
          g.score++;
          g.shieldGlow = 1;
          burst(b.a, W.shield, COLOR[b.kind], 10, 140);
          tone(520 + (g.score % 8) * 45, 0.09, 'square', 0.035);
          continue;
        }
      }

      if (b.d <= W.core + W.bullet * 0.5) {
        breach(b);
        return;
      }
    }
  }

  function breach(b) {
    state = 'dying';
    g.dieT = 0.9;
    shake = 1;
    flash = 1;
    burst(b.a, W.core, '#FFFFFF', 26, 220);
    burst(b.a, W.core, COLOR[b.kind], 20, 160);
    tone(150, 0.5, 'sawtooth', 0.09);
  }

  function finishGame() {
    state = 'over';
    var key = g.mode === 'daily' ? 'aegis.daily.' + g.date : 'aegis.best.endless';
    var prev = bestOf(key);
    var isNew = prev === null || g.score > prev;
    if (isNew) store.set(key, g.score);
    showOver(isNew && g.score > 0, isNew ? g.score : prev);
  }

  function pause() {
    if (state !== 'play') return;
    state = 'paused';
    showUi('<div class="aegis-panel aegis-panel-min"><p class="aegis-title-s">' + T.paused + '</p>' +
      '<button type="button" class="aegis-btn primary" data-act="resume">' + T.resume + '</button></div>');
  }
  function resume() {
    if (state !== 'paused') return;
    state = 'play';
    hideUi();
    last = performance.now();
  }

  /* ---------------- 重ね表示 ---------------- */
  function showUi(html) { ui.innerHTML = html; ui.hidden = false; var b = ui.querySelector('.primary'); if (b) b.focus({ preventScroll: true }); }
  function hideUi() { ui.hidden = true; ui.innerHTML = ''; canvas.focus({ preventScroll: true }); }

  function showMenu() {
    state = 'menu';
    g = null;
    var date = dateJst();
    var today = bestOf('aegis.daily.' + date), best = bestOf('aegis.best.endless');
    showUi(
      '<div class="aegis-panel">' +
        '<p class="aegis-logo">AEGIS</p>' +
        '<p class="aegis-sub">' + T.sub + '</p>' +
        '<div class="aegis-btns">' +
          '<button type="button" class="aegis-btn primary" data-act="daily">' + T.daily +
            '<small>' + date + ' · ' + T.todayRec + ' ' + (today === null ? T.none : today) + '</small></button>' +
          '<button type="button" class="aegis-btn" data-act="endless">' + T.endless +
            '<small>' + T.best + ' ' + (best === null ? T.none : best) + '</small></button>' +
        '</div>' +
        '<p class="aegis-hint">' + T.hint + '</p>' +
      '</div>');
  }

  function showOver(isNew, best) {
    showUi(
      '<div class="aegis-panel">' +
        '<p class="aegis-title-s">' + T.over + '</p>' +
        '<p class="aegis-score">' + g.score + '<span>' + T.unit + '</span></p>' +
        '<p class="aegis-best">' + (isNew ? '<strong>' + T.newBest + '</strong>' :
          (g.mode === 'daily' ? T.todayRec : T.best) + ' ' + best) +
          (g.mode === 'daily' ? ' <small>(' + g.date + ')</small>' : '') + '</p>' +
        '<div class="aegis-btns">' +
          '<button type="button" class="aegis-btn primary" data-act="again">' + T.again + '</button>' +
          '<button type="button" class="aegis-btn" data-act="share">' + T.share + '</button>' +
          '<button type="button" class="aegis-btn ghost" data-act="menu">' + T.menu + '</button>' +
        '</div>' +
        '<p class="aegis-toast" role="status" aria-live="polite"></p>' +
      '</div>');
  }

  function toast(msg) {
    var el = ui.querySelector('.aegis-toast');
    if (el) el.textContent = msg;
  }

  function share() {
    var text = T.line(g.mode, g.date, g.score);
    if (navigator.share) {
      navigator.share({ text: text, url: URL }).catch(function () { /* 取り消しは何もしない */ });
      return;
    }
    var all = text + '\n' + URL;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(all).then(function () { toast(T.copied); }, function () { toast(T.copyFail); });
    } else {
      toast(T.copyFail);
    }
  }

  ui.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'daily' || act === 'endless') newGame(act);
    else if (act === 'again') newGame(g.mode);
    else if (act === 'share') share();
    else if (act === 'menu') showMenu();
    else if (act === 'resume') resume();
  });

  /* ---------------- 入力 ---------------- */
  function aim(e) {
    var r = canvas.getBoundingClientRect();
    var x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    if (x * x + y * y < 16) return;
    pointerAngle = Math.atan2(y, x);
  }
  canvas.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'mouse' || e.buttons) aim(e);
  });
  canvas.addEventListener('pointerdown', function (e) {
    aim(e);
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* なくても動く */ } }
  });

  window.addEventListener('keydown', function (e) {
    var k = e.key;
    var playing = state === 'play';
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keys.left = true; if (playing) e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { keys.right = true; if (playing) e.preventDefault(); }
    else if ((k === 'p' || k === 'P' || k === 'Escape') && playing) pause();
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
  });
  window.addEventListener('blur', function () { keys.left = keys.right = false; pause(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); });

  /* ---------------- 描画 ---------------- */
  function pos(a, d) { return [S + Math.cos(a) * d * S, S + Math.sin(a) * d * S]; }

  function drawCore(time) {
    var r = W.core * S, pulse = 1 + Math.sin(time * 3) * 0.05;
    ctx.save();
    ctx.translate(S, S);
    ctx.shadowColor = '#4FB3D9';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#4FB3D9';
    ctx.beginPath();
    for (var i = 0; i < 6; i++) {
      var th = i / 6 * TAU + time * 0.4;
      var x = Math.cos(th) * r * pulse, y = Math.sin(th) * r * pulse;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath();
    ctx.arc(-r * 0.2, -r * 0.2, r * 0.32, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawShield(angle, glow) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = W.shieldW * S;
    ctx.shadowColor = '#4FB3D9';
    ctx.shadowBlur = 14 + glow * 22;
    ctx.strokeStyle = glow > 0 ? 'rgb(255,255,255)' : '#DDF2FB';
    ctx.beginPath();
    ctx.arc(S, S, W.shield * S, angle - W.arc, angle + W.arc);
    ctx.stroke();
    ctx.restore();
  }

  function drawBullet(b) {
    var p = pos(b.a, b.d), tail = pos(b.a - b.w * 0.08, b.d + b.v * 0.12);
    var c = COLOR[b.kind];
    ctx.strokeStyle = c;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = W.bullet * S * 1.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tail[0], tail[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(p[0], p[1], W.bullet * S * (b.kind === 'split' ? 1.35 : 1), 0, TAU);
    ctx.fill();
  }

  /* 画面の外にいる弾は、縁に小さな予告を出す */
  function drawWarnings() {
    var list = g.bullets;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var cx = Math.cos(b.a), cy = Math.sin(b.a);
      var edge = 1 / Math.max(Math.abs(cx), Math.abs(cy));   // 正方形の縁までの距離
      if (b.d <= edge) continue;
      ctx.strokeStyle = COLOR[b.kind];
      ctx.globalAlpha = 0.8;
      var rr = 0.93 * S;
      ctx.beginPath();
      ctx.arc(S, S, rr, b.a - 0.06, b.a + 0.06);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawFx(dt) {
    for (var i = fx.length - 1; i >= 0; i--) {
      var p = fx[i];
      p.life -= dt;
      if (p.life <= 0) { fx.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawHud() {
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '700 ' + Math.round(S * 0.13) + 'px system-ui, sans-serif';
    ctx.fillText(String(g.score), S, S * 0.06);
    ctx.font = '600 ' + Math.round(S * 0.045) + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(221,242,251,.7)';
    ctx.textAlign = 'left';
    ctx.fillText(g.mode === 'daily' ? T.daily : T.endless, S * 0.06, S * 0.06);
    ctx.textAlign = 'right';
    var s = Math.floor(g.t);
    ctx.fillText(Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2), S * 1.94, S * 0.06);
  }

  function draw(time, dt) {
    ctx.save();
    if (shake > 0) {
      var m = shake * S * 0.04;
      ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
    }
    ctx.fillStyle = bg;
    ctx.fillRect(-20, -20, size + 40, size + 40);

    /* 目印の輪 */
    ctx.strokeStyle = 'rgba(79,179,217,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(S, S, W.shield * S, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(S, S, 0.72 * S, 0, TAU); ctx.stroke();

    var shieldA = g ? g.shield : time * 0.6;
    if (!g || state !== 'dying') drawCore(time);
    if (g) {
      drawWarnings();
      for (var i = 0; i < g.bullets.length; i++) drawBullet(g.bullets[i]);
    }
    if (!g || state !== 'dying') drawShield(shieldA, g ? g.shieldGlow : 0);
    drawFx(dt);
    if (g && state !== 'over') drawHud();
    ctx.restore();

    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (flash * 0.6) + ')';
      ctx.fillRect(0, 0, size, size);
    }
  }

  /* ---------------- 進行 ---------------- */
  var last = performance.now(), acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;

    if (state === 'play') {
      acc += dt;
      while (acc >= STEP && state === 'play') { update(STEP); acc -= STEP; }
    } else {
      acc = 0;
    }
    if (state === 'dying') {
      g.dieT -= dt;
      if (g.dieT <= 0) finishGame();
    }
    if (shake > 0) shake = Math.max(0, shake - dt * 2.2);
    if (flash > 0) flash = Math.max(0, flash - dt * 3);

    draw(now / 1000, dt);
  }

  canvas.setAttribute('tabindex', '0');
  showMenu();
  requestAnimationFrame(frame);

  /* 動作確認用（読み取りのみ） */
  window.AEGIS = {
    state: function () { return state; },
    game: function () {
      return g && {
        mode: g.mode, date: g.date, t: g.t, score: g.score, shield: g.shield,
        bullets: g.bullets.map(function (b) { return { a: b.a, d: b.d, v: b.v, kind: b.kind }; })
      };
    }
  };
})();
