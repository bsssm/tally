/* Tally landing page. No dependencies.
   Patterns adapted in vanilla form: beui animated toast and spring tab indicator,
   transitions.dev icon swap and number pop-in, as in ~/dashboard/public/ui-enhance.js. */
(function () {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const raf = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

  /* ---------- toast ---------- */
  const wrap = document.createElement('div');
  wrap.className = 'toast-wrap';
  document.body.appendChild(wrap);
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    wrap.appendChild(t);
    raf(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
  }

  /* ---------- copy the command ---------- */
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
      if (!ok) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
        document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        ta.remove();
      }
      btn.classList.add('is-done');
      btn.querySelector('.cmd__label').textContent = ok ? 'Copied' : 'Copy';
      toast(ok ? 'Copied. Paste it in a terminal.' : 'Could not copy. Select the command and copy it.');
      setTimeout(() => { btn.classList.remove('is-done'); btn.querySelector('.cmd__label').textContent = 'Copy'; }, 1800);
    });
  });

  /* ---------- the pinned reel: the wallet screen passes through the sentence ---------- */
  const hero = document.querySelector('.hero');
  const strip = document.getElementById('strip');
  const stage = document.querySelector('.hero__stage');
  const wide = window.matchMedia('(min-width: 60.01em)');
  let frames = [];
  function layoutReel() {
    if (!strip || !wide.matches || reduce) { if (strip) strip.style.transform = ''; return; }
    frames = Array.from(strip.children);
    placeReel();
  }
  function placeReel() {
    if (!wide.matches || reduce || !frames.length) return;
    const rect = hero.getBoundingClientRect();
    const travel = hero.offsetHeight - stage.offsetHeight;
    const p = Math.min(1, Math.max(0, -rect.top / travel)); // 0 at the top of the hero, 1 when the stage releases
    const steps = frames.length - 1;
    const pos = p * steps;                                  // continuous, locked to the scrollbar
    const i = Math.min(steps, Math.floor(pos));
    const f = pos - i;
    const a = frames[i], b = frames[Math.min(steps, i + 1)];
    const ca = a.offsetTop + a.offsetHeight / 2;
    const cb = b.offsetTop + b.offsetHeight / 2;
    const centre = ca + (cb - ca) * f;
    strip.style.transform = 'translateY(' + (-centre) + 'px)';
  }
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { placeReel(); ticking = false; });
  }
  if (strip) {
    layoutReel();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', layoutReel);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutReel);
    wide.addEventListener('change', layoutReel);
  }

  /* ---------- the verdict calculator (mirrors packages/core/src/wallet.ts) ---------- */
  const PLANS = {
    api:   { label: 'API (pay per token)', monthly: 0,   credits: 0 },
    pro:   { label: 'Claude Pro',          monthly: 20,  credits: 0 },
    max5:  { label: 'Claude Max 5x',       monthly: 100, credits: 100 },
    max20: { label: 'Claude Max 20x',      monthly: 200, credits: 200 },
  };
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function wrapText(text, width, indent) {
    const out = []; let line = '';
    for (const w of text.split(/\s+/)) {
      if (line && (line.length + 1 + w.length) > width) { out.push(line); line = indent + w; } else line = line ? line + ' ' + w : w;
    }
    if (line) out.push(line);
    return out.join('\n');
  }
  function verdict(api, plan) {
    const p = PLANS[plan];
    const levers = [];
    let headline;
    if (plan === 'api') {
      headline = api > 250
        ? `You paid about $${api.toFixed(0)} at API rates. Max 20x is $200 flat for the same Claude Code usage.`
        : api > 120
          ? `You paid about $${api.toFixed(0)} at API rates. Max 5x is $100 flat for this.`
          : `About $${api.toFixed(0)} at API rates. Pay-as-you-go is right at this volume.`;
    } else if (api < p.monthly * 0.8) {
      const cheaper = plan === 'max20' ? 'Max 5x' : plan === 'max5' ? 'Pro' : 'pay-as-you-go API';
      headline = `You used $${api.toFixed(0)} of API-equivalent on a $${p.monthly} plan. ${cheaper} would cover this.`;
    } else {
      const multiple = api / p.monthly;
      headline = `You used $${api.toFixed(0)} API-equivalent on a $${p.monthly} plan: ${multiple.toFixed(1)}x. Keep it.`;
      if (plan === 'max5' && multiple > 12) levers.push('At this volume you are probably hitting 5x limits; Max 20x doubles the window for $100 more.');
    }
    if (p.credits) levers.push(`Your plan includes $${p.credits}/month of Claude Platform API credits.\n    They expire monthly. Claim once in claude.ai → settings.`);
    return { headline, levers, label: p.label };
  }
  const calc = document.getElementById('calc');
  if (calc) {
    const seg = calc.querySelector('.seg');
    const range = calc.querySelector('#usage');
    const outVal = calc.querySelector('#usage-out');
    const out = calc.querySelector('#calc-out');
    let plan = 'max20';
    function render() {
      const api = Number(range.value);
      outVal.value = '$' + api.toLocaleString('en-US');
      outVal.textContent = outVal.value;
      const v = verdict(api, plan);
      const width = window.matchMedia('(max-width: 36em)').matches ? 34 : 54;
      let html = `<b>VERDICT</b>  <span class="dim">(${esc(v.label)})</span>\n  ${esc(wrapText(v.headline, width - 2, '  '))}`;
      for (const l of v.levers) html += `\n  <span class="warn">→</span> ${esc(wrapText(l.replace(/\s+/g, ' '), width - 4, '    '))}`;
      out.innerHTML = html;
    }
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-plan]');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      plan = b.dataset.plan;
      render();
    });
    range.addEventListener('input', render);
    render();
    window.matchMedia('(max-width: 36em)').addEventListener('change', render);
  }

  /* ---------- faq: question index, one answer ---------- */
  const list = document.getElementById('faq-list');
  const pane = document.getElementById('faq-pane');
  if (list && pane) {
    const qs = Array.from(list.querySelectorAll('.faq__q'));
    const phone = window.matchMedia('(max-width: 60em)');
    function select(q, toggle) {
      const open = q.getAttribute('aria-expanded') === 'true';
      if (toggle && phone.matches && open) { q.setAttribute('aria-expanded', 'false'); return; }
      qs.forEach((x) => x.setAttribute('aria-expanded', String(x === q)));
      const a = document.getElementById(q.getAttribute('aria-controls'));
      if (!a) return;
      if (reduce) { pane.innerHTML = a.innerHTML; return; }
      pane.classList.add('is-swapping');
      setTimeout(() => { pane.innerHTML = a.innerHTML; pane.classList.remove('is-swapping'); }, 150);
    }
    qs.forEach((q) => {
      q.addEventListener('click', () => select(q, true));
      q.addEventListener('mouseenter', () => { if (!phone.matches) select(q, false); });
      q.addEventListener('focus', () => { if (!phone.matches) select(q, false); });
    });
  }

  /* entrances are CSS scroll-driven animations (style.css .in); nothing here hides content */
})();
