/* global QB */
'use strict';

QB.createAnalyticsActivity = function createAnalyticsActivity(pick) {
  let _hourClockResizeObserver = null;
  const { _activityHeatColor } = QB.analyticsHelpers;
  function _buildHourHeatmap(data) {
    const el = document.getElementById('an-hour-heatmap');
    if (!el) return;
    const buckets = pick(data.hourHeatmap, []);
    if (!buckets.length || buckets.every(b => b.count === 0)) {
      el.innerHTML = '<div style="color:var(--t400);font-size:10px;padding:4px 0">No data</div>';
      return;
    }

    // Auf volle 0..23-Skala normalisieren (fehlende Stunden ⇒ 0).
    const byHour = Array.from({ length: 24 }, (_, h) => {
      const b = buckets.find(x => x.hour === h);
      return { hour: h, count: b ? b.count : 0, pct: b ? b.pct : 0 };
    });
    const peak = byHour.reduce((m, b) => (b.count > m.count ? b : m), byHour[0]);
    const totalCount = byHour.reduce((s, b) => s + b.count, 0);

    el.innerHTML = `
    <div class="an-clock">
      <canvas class="an-clock-canvas"></canvas>
      <div class="an-clock-tip"></div>
      <div class="an-clock-cap">Peak hour <b>${String(peak.hour).padStart(2, '0')}:00</b> · Σ ${totalCount} activities</div>
    </div>`;

    _initHourClock(
      el.querySelector('.an-clock'),
      el.querySelector('.an-clock-canvas'),
      el.querySelector('.an-clock-tip'),
      byHour,
      totalCount,
    );
  }

  function _initHourClock(wrap, canvas, tip, byHour, totalCount) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const seg = (Math.PI * 2) / 24;
    const gap = seg * 0.16;
    let size = 0, cx = 0, cy = 0, innerR = 0, outerR = 0;
    let progress = 0;
    let hoverHour = -1;

    function layout() {
      const w = wrap.clientWidth || canvas.clientWidth || 240;
      size = Math.max(180, Math.min(280, Math.floor(w)));
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      cx = cy = size / 2;
      outerR = size / 2 - 4;
      innerR = outerR * 0.34;
    }

    function wedge(r0, r1, a0, a1) {
      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // Feiner Innenring um die Stundenlabels.
      ctx.beginPath();
      ctx.arc(cx, cy, innerR - 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.lineJoin = 'round';
      for (let h = 0;h < 24;h++) {
        const b = byHour[h];
        const center = -Math.PI / 2 + h * seg;   // 0 = oben, im Uhrzeigersinn
        const a0 = center - seg / 2 + gap / 2;
        const a1 = center + seg / 2 - gap / 2;
        const hovered = h === hoverHour;

        // Track (volle Länge, dezent).
        wedge(innerR, outerR, a0, a1);
        ctx.fillStyle = hovered ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.045)';
        ctx.fill();

        // Wert-Balken.
        const r1 = innerR + b.pct * progress * (outerR - innerR);
        if (r1 > innerR + 0.5) {
          wedge(innerR, r1, a0, a1);
          ctx.fillStyle = _activityHeatColor(b.pct, hovered ? 0.18 : 0);
          ctx.fill();
          if (hovered) {
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      // Stundenlabels an den Kardinalpunkten.
      ctx.fillStyle = '#7e92a4';
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rl = innerR * 0.6;
      [[0, 0, -1], [6, 1, 0], [12, 0, 1], [18, -1, 0]].forEach(([hr, dx, dy]) => {
        ctx.fillText(String(hr).padStart(2, '0'), cx + dx * rl, cy + dy * rl);
      });
    }

    function animate() {
      const step = () => {
        progress += (1 - progress) * 0.16;          // ease-out
        if (progress > 0.995) progress = 1;
        draw();
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    canvas.addEventListener('mousemove', (e) => {
      const cRect = canvas.getBoundingClientRect();
      const x = e.clientX - cRect.left - cx;
      const y = e.clientY - cRect.top - cy;
      const dist = Math.hypot(x, y);
      if (dist < innerR - 2 || dist > outerR + 4) {
        if (hoverHour !== -1) { hoverHour = -1; draw(); }
        tip.classList.remove('show');
        return;
      }
      let ang = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2); // 0 = oben
      const h = Math.floor(ang / seg + 0.5) % 24;
      if (h !== hoverHour) { hoverHour = h; draw(); }

      const b = byHour[h];
      const share = totalCount > 0 ? (b.count / totalCount) * 100 : 0;
      tip.innerHTML = `<b>${String(h).padStart(2, '0')}:00</b> · ${b.count} act.`
        + `<br><span class="an-clock-tip-sub">${share.toFixed(0)}% of activity</span>`;
      tip.classList.add('show');

      // Tooltip relativ zum .an-clock-Wrap positionieren.
      const wRect = wrap.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let px = e.clientX - wRect.left + 12;
      let py = e.clientY - wRect.top - th - 8;
      if (px + tw > wrap.clientWidth) px = e.clientX - wRect.left - tw - 12;
      if (py < 0) py = e.clientY - wRect.top + 14;
      tip.style.left = px + 'px';
      tip.style.top = py + 'px';
    });

    canvas.addEventListener('mouseleave', () => {
      hoverHour = -1; draw();
      tip.classList.remove('show');
    });

    layout();
    draw();
    animate();

    if (typeof ResizeObserver !== 'undefined') {
      if (_hourClockResizeObserver) _hourClockResizeObserver.disconnect();
      const ro = new ResizeObserver(() => { layout(); draw(); });
      ro.observe(wrap);
      _hourClockResizeObserver = ro;
    }
  }
  return { _buildHourHeatmap };
};
