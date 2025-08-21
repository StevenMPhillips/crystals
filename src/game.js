/*
  Crystal Quest (Tiny Clone)
  - Mouse to steer (inertial toward cursor)
  - Click to shoot
  - Collect all crystals to open the gate
  - Touch gate to advance levels
  - Avoid enemies; bullets destroy them
*/

(function () {
  'use strict';

  // Canvas setup
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = Math.floor(window.innerWidth);
    canvas.height = Math.floor(window.innerHeight);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  // Utilities
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dist2 = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1; return dx * dx + dy * dy;
  };
  const lerp = (a, b, t) => a + (b - a) * t;

  function vecNorm(x, y) {
    const m = Math.hypot(x, y) || 1; return [x / m, y / m];
  }

  // Input
  const mouse = { x: canvas.width * 0.5, y: canvas.height * 0.5, down: false };
  function updateFromClientXY(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = (clientX - rect.left) * (canvas.width / rect.width);
    mouse.y = (clientY - rect.top) * (canvas.height / rect.height);
  }
  // Mouse (desktop)
  canvas.addEventListener('mousemove', (e) => updateFromClientXY(e.clientX, e.clientY));
  canvas.addEventListener('mousedown', (e) => { mouse.down = true; updateFromClientXY(e.clientX, e.clientY); });
  canvas.addEventListener('mouseup', () => (mouse.down = false));
  // Pointer/touch (mobile and fallback)
  let primaryPointerId = null;
  const resumeAudio = () => { try { ensureAudio(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch {} };
  canvas.addEventListener('pointerdown', (e) => {
    if (primaryPointerId == null) primaryPointerId = e.pointerId;
    if (e.pointerId === primaryPointerId) {
      updateFromClientXY(e.clientX, e.clientY);
      mouse.down = true;
      resumeAudio();
      if (state === 'menu' || state === 'gameover') startGame();
    }
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === primaryPointerId) updateFromClientXY(e.clientX, e.clientY);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  function endPointer(e) {
    if (e.pointerId === primaryPointerId) { mouse.down = false; primaryPointerId = null; }
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    if (e.cancelable) e.preventDefault();
  }
  canvas.addEventListener('pointerup', endPointer, { passive: false });
  canvas.addEventListener('pointercancel', endPointer, { passive: false });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  window.addEventListener('blur', () => (mouse.down = false));

  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key === 'F1' || e.key === 'f1' || e.key === '`') { toggleDebug(e); return; }
    if (e.key.toLowerCase() === 'p') togglePause();
    if (e.key.toLowerCase() === 'r') resetGame();
    if (e.key.toLowerCase() === 'm') muted = !muted;
    if (state !== 'playing' && (e.key === ' ' || e.key === 'Enter')) startGame();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // Audio (simple beeps)
  let audioCtx;
  let muted = false;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
  }
  function beep(freq = 440, dur = 0.05, type = 'sine', gain = 0.05) {
    if (muted) return;
    ensureAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(t0 + dur);
  }

  // Game state
  let state = 'menu'; // menu | playing | levelclear | gameover | paused
  let level = 1;
  let score = 0;
  let lives = 3;
  let crystals = [];
  let enemies = [];
  let bullets = [];
  let particles = [];
  let player;
  let gate = { open: false, x: 0, y: 0, r: 26, pulse: 0 };

  const COLORS = {
    bg1: '#0b0f14',
    grid: 'rgba(255,255,255,0.04)',
    player: '#8dd2ff',
    bullet: '#9df09b',
    enemy: '#ff6b6b',
    enemy2: '#ffa94d',
    crystal: '#b19fff',
    crystalCore: '#e9ddff',
    gate: '#7ef9ff',
    text: '#e6f1ff',
    shadow: 'rgba(0,0,0,0.3)'
  };

  const WORLD = {
    padding: 40, // safe padding inside canvas
    maxSpeed: 520, // clamp on velocity
    // PD controller gains (mouse feel):
    // acceleration = kp*(mouse-pos) - kd*vel
    kp: 12.0,
    kd: 7.5,
    deadZone: 4, // pixels near cursor where we ease to stop
    bulletSpeed: 720,
    bulletCooldown: 0.10,
    enemyBase: 4,
    crystalCount: 10,
  };

  // Live tuning (debug panel)
  const TUNABLES = [
    { key: 'kp', label: 'Kp (spring)', min: 0, max: 30, step: 0.1, fmt: (v)=>v.toFixed(1) },
    { key: 'kd', label: 'Kd (damper)', min: 0, max: 30, step: 0.1, fmt: (v)=>v.toFixed(1) },
    { key: 'deadZone', label: 'Deadzone (px)', min: 0, max: 20, step: 0.5, fmt: (v)=>v.toFixed(1) },
    { key: 'maxSpeed', label: 'Max speed', min: 100, max: 1200, step: 10, fmt: (v)=>v.toFixed(0) },
    { key: 'bulletSpeed', label: 'Bullet speed', min: 300, max: 1500, step: 10, fmt: (v)=>v.toFixed(0) },
    { key: 'bulletCooldown', label: 'Fire cooldown', min: 0.05, max: 0.3, step: 0.01, fmt: (v)=>v.toFixed(2) },
  ];
  const LS_KEY = 'cq_tuning_v1';
  function loadTuning() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const t of TUNABLES) if (t.key in data) WORLD[t.key] = data[t.key];
    } catch {}
  }
  function saveTuning() {
    try {
      const data = {}; for (const t of TUNABLES) data[t.key] = WORLD[t.key];
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
  }
  let debugOpen = false;
  let debugEl = null;
  function buildDebugPanel() {
    debugEl = document.getElementById('debugPanel');
    if (!debugEl) return;
    debugEl.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = 'Debug — Tuning (F1 to close)'; debugEl.appendChild(h);
    for (const t of TUNABLES) {
      const row = document.createElement('div'); row.className = 'debug-row';
      const label = document.createElement('label'); label.textContent = t.label; row.appendChild(label);
      const value = document.createElement('div'); value.textContent = t.fmt(WORLD[t.key]); value.style.textAlign = 'right'; row.appendChild(value);
      const input = document.createElement('input'); input.type = 'range'; input.min = t.min; input.max = t.max; input.step = t.step; input.value = WORLD[t.key];
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        WORLD[t.key] = v; value.textContent = t.fmt(v); saveTuning();
      });
      row.appendChild(input);
      debugEl.appendChild(row);
    }
    const footer = document.createElement('div'); footer.className = 'debug-footer';
    const reset = document.createElement('button'); reset.textContent = 'Reset';
    reset.addEventListener('click', () => { try { localStorage.removeItem(LS_KEY); } catch {} window.location.reload(); });
    const close = document.createElement('button'); close.textContent = 'Close'; close.addEventListener('click', toggleDebug);
    footer.appendChild(reset); footer.appendChild(close);
    debugEl.appendChild(footer);
  }
  function toggleDebug(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    debugOpen = !debugOpen;
    if (!debugEl) buildDebugPanel();
    if (debugEl) {
      if (debugOpen) { buildDebugPanel(); debugEl.style.display = 'block'; debugEl.setAttribute('aria-hidden', 'false'); }
      else { debugEl.style.display = 'none'; debugEl.setAttribute('aria-hidden', 'true'); }
    }
  }

  // Load any saved tuning on boot
  loadTuning();
  // Mobile/touch UX helpers
  const mobileUI = { active: false, btnPause: null, btnMute: null };
  (function setupMobileUI(){
    const isCoarse = (function(){
      try { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; } catch { return 'ontouchstart' in window; }
    })();
    const hint = document.getElementById('controlHint');
    const ctrls = document.getElementById('mobileControls');
    mobileUI.btnPause = document.getElementById('btnPause');
    const btnRestart = document.getElementById('btnRestart');
    mobileUI.btnMute = document.getElementById('btnMute');
    if (isCoarse) {
      mobileUI.active = true;
      if (hint) hint.textContent = 'Controls: drag to steer, hold to shoot. Tap ⏸ to pause, ↻ restart, 🔇 mute.';
      if (ctrls) { ctrls.style.display = 'flex'; ctrls.setAttribute('aria-hidden', 'false'); }
      if (mobileUI.btnPause) mobileUI.btnPause.addEventListener('click', () => { if (state === 'menu' || state === 'gameover') startGame(); else togglePause(); });
      if (btnRestart) btnRestart.addEventListener('click', () => { resetGame(); });
      if (mobileUI.btnMute) mobileUI.btnMute.addEventListener('click', () => { muted = !muted; });
    } else {
      if (hint) hint.textContent = 'Controls: move mouse to steer, click to shoot, P pause, R restart, M mute, F1 debug';
    }
  })();

  function resetGame() {
    level = 1; score = 0; lives = 3;
    startLevel(level);
    state = 'playing';
  }

  function startGame() {
    if (state === 'menu' || state === 'gameover') {
      resetGame();
    }
  }

  function togglePause() {
    if (state === 'playing') state = 'paused';
    else if (state === 'paused') state = 'playing';
  }

  function startLevel(n) {
    const w = canvas.width, h = canvas.height;
    player = {
      x: w * 0.5, y: h * 0.7, r: 14,
      vx: 0, vy: 0,
      fireCd: 0,
      inv: 0,
    };
    bullets = [];
    particles = [];
    crystals = [];
    enemies = [];
    // place gate near top center
    gate = { open: false, x: w * 0.5, y: Math.max(WORLD.padding + 60, h * 0.12), r: 28, pulse: 0 };
    // spawn crystals
    const count = WORLD.crystalCount + Math.floor((n - 1) * 1.2);
    for (let i = 0; i < count; i++) {
      const pos = randomPointAvoiding([gate], gate.r + 80);
      crystals.push({ x: pos.x, y: pos.y, r: 10 + Math.random() * 3, spin: Math.random() * TAU });
    }
    // spawn enemies
    const ecount = WORLD.enemyBase + Math.floor((n - 1) * 1.5);
    for (let i = 0; i < ecount; i++) enemies.push(makeEnemy(n));
  }

  function randomPointAvoiding(avoidList, minDist) {
    const w = canvas.width, h = canvas.height; const pad = WORLD.padding;
    for (let tries = 0; tries < 1200; tries++) {
      const x = rand(pad, w - pad);
      const y = rand(pad, h - pad);
      if (!avoidList || avoidList.length === 0) return { x, y };
      let ok = true;
      for (const o of avoidList) {
        if (dist2(x, y, o.x, o.y) < (minDist + (o.r || 0)) ** 2) { ok = false; break; }
      }
      if (ok) return { x, y };
    }
    return { x: w * 0.5, y: h * 0.5 };
  }

  function makeEnemy(n) {
    const type = Math.random() < 0.5 ? 'chaser' : 'wanderer';
    const speed = type === 'chaser' ? rand(90, 140) + n * 4 : rand(110, 180) + n * 6;
    const r = type === 'chaser' ? 16 : 12;
    const edge = Math.floor(rand(0, 4));
    let x, y; // spawn off edges
    if (edge === 0) { x = -30; y = rand(0, canvas.height); }
    else if (edge === 1) { x = canvas.width + 30; y = rand(0, canvas.height); }
    else if (edge === 2) { x = rand(0, canvas.width); y = -30; }
    else { x = rand(0, canvas.width); y = canvas.height + 30; }
    return {
      type, x, y, r,
      vx: rand(-1, 1) * 50, vy: rand(-1, 1) * 50,
      speed,
      turn: rand(0.6, 1.6),
      ttl: rand(10, 22),
      hue: type === 'chaser' ? COLORS.enemy : COLORS.enemy2,
      target: randomPointAvoiding([], 0)
    };
  }

  // Game Loop
  let last = performance.now();
  function loop(ts) {
    const dt = Math.min(0.033, (ts - last) / 1000);
    last = ts;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function update(dt) {
    if (state === 'paused') return;
    if (state === 'menu' || state === 'gameover' || state === 'levelclear') {
      // gentle gate pulse in menus
      gate.pulse += dt;
      return;
    }
    // Playing
    // Player steering: PD controller toward mouse (spring-damper)
    let dx = mouse.x - player.x;
    let dy = mouse.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist < WORLD.deadZone) { dx = 0; dy = 0; }
    const ax = WORLD.kp * dx - WORLD.kd * player.vx;
    const ay = WORLD.kp * dy - WORLD.kd * player.vy;
    player.vx += ax * dt;
    player.vy += ay * dt;
    // Clamp top speed for control
    const sp = Math.hypot(player.vx, player.vy);
    if (sp > WORLD.maxSpeed) {
      const s = WORLD.maxSpeed / sp; player.vx *= s; player.vy *= s;
    }
    // If very close to cursor, gently settle to avoid jitter
    if (dist < WORLD.deadZone * 0.75) { player.vx *= 0.85; player.vy *= 0.85; }
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    // bounds
    const pad = WORLD.padding;
    if (player.x < pad) { player.x = pad; player.vx *= -0.4; }
    if (player.x > canvas.width - pad) { player.x = canvas.width - pad; player.vx *= -0.4; }
    if (player.y < pad) { player.y = pad; player.vy *= -0.4; }
    if (player.y > canvas.height - pad) { player.y = canvas.height - pad; player.vy *= -0.4; }
    if (player.inv > 0) player.inv -= dt;

    // Firing
    player.fireCd -= dt;
    if (mouse.down && player.fireCd <= 0) {
      // Aim primarily at cursor; if cursor is too close, use ship velocity
      let aimx = mouse.x - player.x, aimy = mouse.y - player.y;
      let [ux, uy] = vecNorm(aimx, aimy);
      if (Math.hypot(aimx, aimy) < 1) {
        const [vxn, vyn] = vecNorm(player.vx, player.vy);
        ux = vxn; uy = vyn;
      }
      const bx = player.x + ux * (player.r + 6);
      const by = player.y + uy * (player.r + 6);
      bullets.push({ x: bx, y: by, vx: ux * WORLD.bulletSpeed, vy: uy * WORLD.bulletSpeed, r: 3.5, ttl: 0.8 });
      player.fireCd = WORLD.bulletCooldown;
      beep(880, 0.04, 'square', 0.03);
    }

    // Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt; b.ttl -= dt;
      if (b.x < -20 || b.x > canvas.width + 20 || b.y < -20 || b.y > canvas.height + 20 || b.ttl <= 0) {
        bullets.splice(i, 1);
      }
    }

    // Enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.ttl -= dt;
      if (e.type === 'chaser') {
        // seek player
        const ex = player.x - e.x; const ey = player.y - e.y;
        const [ux, uy] = vecNorm(ex, ey);
        e.vx = lerp(e.vx, ux * e.speed, clamp(e.turn * dt, 0, 1));
        e.vy = lerp(e.vy, uy * e.speed, clamp(e.turn * dt, 0, 1));
      } else {
        // wanderer toward target
        const dx = e.target.x - e.x, dy = e.target.y - e.y;
        if (dx * dx + dy * dy < 40 * 40) e.target = randomPointAvoiding([], 0);
        const [ux, uy] = vecNorm(dx, dy);
        e.vx = lerp(e.vx, ux * e.speed, clamp(e.turn * dt, 0, 1));
        e.vy = lerp(e.vy, uy * e.speed, clamp(e.turn * dt, 0, 1));
      }
      e.x += e.vx * dt; e.y += e.vy * dt;
      // wrap edges softly
      if (e.x < -40) e.x = canvas.width + 40;
      if (e.x > canvas.width + 40) e.x = -40;
      if (e.y < -40) e.y = canvas.height + 40;
      if (e.y > canvas.height + 40) e.y = -40;

      // Bullet collisions
      for (let j = bullets.length - 1; j >= 0; j--) {
        const b = bullets[j];
        if (dist2(b.x, b.y, e.x, e.y) < (b.r + e.r) * (b.r + e.r)) {
          bullets.splice(j, 1);
          enemies.splice(i, 1);
          score += 25;
          spawnBurst(e.x, e.y, e.hue);
          beep(220, 0.07, 'triangle', 0.05);
          break;
        }
      }
    }

    // Player vs enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      const rr = (player.r + e.r) * (player.r + e.r);
      if (dist2(player.x, player.y, e.x, e.y) < rr) {
        if (player.inv <= 0) {
          lives -= 1; player.inv = 1.2; spawnBurst(player.x, player.y, COLORS.player);
          beep(120, 0.12, 'sawtooth', 0.06);
          if (lives <= 0) { state = 'gameover'; return; }
        }
      }
    }

    // Crystals
    for (let i = crystals.length - 1; i >= 0; i--) {
      const c = crystals[i]; c.spin += dt * 2;
      if (dist2(player.x, player.y, c.x, c.y) < (player.r + c.r) * (player.r + c.r)) {
        crystals.splice(i, 1);
        score += 100;
        spawnBurst(c.x, c.y, COLORS.crystal);
        beep(1046, 0.06, 'sine', 0.05);
      }
    }

    // Gate
    if (!gate.open && crystals.length === 0) {
      gate.open = true; gate.pulse = 0; beep(660, 0.2, 'square', 0.05);
    }
    gate.pulse += dt;
    if (gate.open && dist2(player.x, player.y, gate.x, gate.y) < (player.r + gate.r) * (player.r + gate.r)) {
      // next level
      score += 500;
      level += 1;
      startLevel(level);
      beep(880, 0.2, 'triangle', 0.06);
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.ttl -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.98; p.vy *= 0.98;
      if (p.ttl <= 0) particles.splice(i, 1);
    }
  }

  function spawnBurst(x, y, color) {
    for (let i = 0; i < 12; i++) {
      const a = rand(0, TAU); const s = rand(40, 200);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, ttl: rand(0.2, 0.6), c: color });
    }
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    // background
    ctx.clearRect(0, 0, w, h);
    // subtle grid
    ctx.save();
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    const grid = 40; ctx.beginPath();
    for (let x = (w % grid); x < w; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = (h % grid); y < h; y += grid) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke(); ctx.restore();

    // Gate
    drawGate();

    // Crystals
    for (const c of crystals) drawCrystal(c);

    // Enemies
    for (const e of enemies) drawEnemy(e);

    // Bullets
    for (const b of bullets) drawBullet(b);

    // Particles
    for (const p of particles) drawParticle(p);

    // Player
    if (player) drawPlayer(player);

    // HUD
    drawHUD();

    // Sync mobile UI buttons
    if (mobileUI.active) {
      if (mobileUI.btnPause) mobileUI.btnPause.textContent = (state === 'playing') ? '⏸' : '▶';
      if (mobileUI.btnMute) mobileUI.btnMute.textContent = muted ? '🔊' : '🔇';
    }

    // Menus
    const startSub = mobileUI.active ? 'Tap to start' : 'Press SPACE to start';
    const pauseSub = mobileUI.active ? 'Tap ⏸ to resume' : 'Press P to resume';
    const retrySub = mobileUI.active ? 'Tap to retry' : 'Press SPACE to retry';
    if (state === 'menu') drawCenterText('Crystal Quest — Tiny Clone', startSub);
    if (state === 'paused') drawCenterText('Paused', pauseSub);
    if (state === 'gameover') drawCenterText('Game Over', retrySub);
  }

  function drawCenterText(title, subtitle) {
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 36px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(title, w * 0.5, h * 0.42);
    ctx.font = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.globalAlpha = 0.8; ctx.fillText(subtitle, w * 0.5, h * 0.48);
    ctx.restore();
  }

  function drawHUD() {
    ctx.save();
    ctx.fillStyle = COLORS.text;
    ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const left = `Level ${level}   Score ${score}`;
    const right = `Lives ${lives}   Crystals ${crystals.length}`;
    ctx.textAlign = 'left'; ctx.fillText(left, 12, 18);
    ctx.textAlign = 'right'; ctx.fillText(right, canvas.width - 12, 18);
    ctx.restore();
  }

  function drawPlayer(p) {
    const a = Math.atan2(p.vy, p.vx);
    const flicker = p.inv > 0 ? (Math.sin(performance.now() * 0.02) * 0.5 + 0.5) : 1;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(a);
    ctx.globalAlpha = 0.9 * flicker;
    // ship body
    ctx.fillStyle = COLORS.player; ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, 9);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-10, -9);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // glow
    ctx.globalAlpha = 0.25 * flicker;
    ctx.beginPath(); ctx.arc(0, 0, 18, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawBullet(b) {
    ctx.save();
    ctx.fillStyle = COLORS.bullet;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawEnemy(e) {
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.fillStyle = e.hue; ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    if (e.type === 'chaser') {
      // diamond
      ctx.moveTo(0, -e.r);
      ctx.lineTo(e.r, 0);
      ctx.lineTo(0, e.r);
      ctx.lineTo(-e.r, 0);
      ctx.closePath();
    } else {
      // rounded
      ctx.arc(0, 0, e.r, 0, TAU);
    }
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawCrystal(c) {
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate(c.spin * 0.5);
    // outer gem
    ctx.fillStyle = COLORS.crystal; ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -c.r);
    ctx.lineTo(c.r * 0.7, 0);
    ctx.lineTo(0, c.r);
    ctx.lineTo(-c.r * 0.7, 0);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // core
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = COLORS.crystalCore;
    ctx.beginPath(); ctx.arc(0, 0, c.r * 0.35, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawGate() {
    ctx.save();
    const glow = gate.open ? 1 : 0.5;
    ctx.globalAlpha = 0.6 * glow;
    ctx.strokeStyle = COLORS.gate; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(gate.x, gate.y, gate.r, 0, TAU); ctx.stroke();
    // pulsing inner ring
    const pr = gate.r * (0.7 + 0.1 * Math.sin(gate.pulse * 6));
    ctx.globalAlpha = 0.3 * glow;
    ctx.beginPath(); ctx.arc(gate.x, gate.y, pr, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  function drawParticle(p) {
    ctx.save();
    ctx.globalAlpha = clamp(p.ttl * 2, 0, 1);
    ctx.fillStyle = p.c;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // Initial
  startLevel(level);
  state = 'menu';
})();
