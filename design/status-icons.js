(function () {
  const R = typeof React !== 'undefined' ? React : window.React;
  const e = R.createElement;
  if (typeof document !== 'undefined' && !document.getElementById('dal-kf')) {
    const s = document.createElement('style');
    s.id = 'dal-kf';
    s.textContent = '@keyframes dal-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.dal-spin{animation:none!important}}';
    document.head.appendChild(s);
  }
  const PAL = {
    dark: { run: '#63a4f4', att: '#f0b043', fail: '#f2706a', pass: '#4fc48a', merge: '#a98bf5', mute: '#8a8e97', ink: '#0e0f11' },
    light: { run: '#1d6fd6', att: '#9a5c00', fail: '#c9302c', pass: '#1a7f4e', merge: '#7146d6', mute: '#6b6f78', ink: '#ffffff' }
  };
  const spin = { transformOrigin: '8px 8px', animation: 'dal-spin 1.1s linear infinite' };
  function shapes(status, c, animate) {
    const st = (col, w) => ({ fill: 'none', stroke: col, strokeWidth: w || 1.5 });
    const glyphCheck = e('path', { d: 'M4.9 8.3 L7.1 10.4 L11.2 6', ...st(c.ink, 1.7), strokeLinecap: 'round', strokeLinejoin: 'round' });
    const bang = (y1, y2) => [e('rect', { key: 'b', x: 7.2, y: y1, width: 1.6, height: y2 - y1, rx: 0.8, fill: c.ink }), e('circle', { key: 'd', cx: 8, cy: y2 + 2.2, r: 0.95, fill: c.ink })];
    switch (status) {
      case 'not_started': return [e('circle', { key: 1, cx: 8, cy: 8, r: 6, ...st(c.mute) })];
      case 'queued': return [e('circle', { key: 1, cx: 8, cy: 8, r: 6, ...st(c.mute), strokeDasharray: '2.4 2.1' }), e('circle', { key: 2, cx: 8, cy: 8, r: 1.4, fill: c.mute })];
      case 'running': return [
        e('circle', { key: 1, cx: 8, cy: 8, r: 6, ...st(c.run), opacity: 0.3 }),
        e('path', { key: 2, d: 'M8 2 A6 6 0 0 1 14 8', ...st(c.run, 1.8), strokeLinecap: 'round', className: 'dal-spin', style: animate ? spin : null }),
        e('circle', { key: 3, cx: 8, cy: 8, r: 2, fill: c.run })];
      case 'needs_input': return [e('polygon', { key: 1, points: '8,0.8 15.2,8 8,15.2 0.8,8', fill: c.att }), ...bang(4.2, 8.8)];
      case 'pending': return [e('circle', { key: 1, cx: 8, cy: 8, r: 3, ...st(c.mute, 1.4) })];
      case 'done': case 'passed': return [e('circle', { key: 1, cx: 8, cy: 8, r: 7, fill: c.pass }), glyphCheck];
      case 'failed': case 'pr_failed': return [e('rect', { key: 1, x: 1.5, y: 1.5, width: 13, height: 13, rx: 2.5, fill: c.fail }), e('path', { key: 2, d: 'M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4', ...st(c.ink, 1.7), strokeLinecap: 'round' })];
      case 'fixing': return [
        e('rect', { key: 1, x: 1.75, y: 1.75, width: 12.5, height: 12.5, rx: 2.5, ...st(c.run) }),
        e('path', { key: 2, d: 'M8 4.6 A3.4 3.4 0 0 1 11.4 8', ...st(c.run, 1.8), strokeLinecap: 'round', className: 'dal-spin', style: animate ? spin : null }),
        e('circle', { key: 3, cx: 8, cy: 8, r: 1.3, fill: c.run })];
      case 'pr_checks': return [e('circle', { key: 1, cx: 8, cy: 8, r: 6, ...st(c.run) }), e('path', { key: 2, d: 'M8 2 A6 6 0 0 1 8 14 Z', fill: c.run })];
      case 'ready': return [e('circle', { key: 1, cx: 8, cy: 8, r: 6.4, ...st(c.pass, 1.6) }), e('circle', { key: 2, cx: 8, cy: 8, r: 3.4, fill: c.pass })];
      case 'merged': return [e('polygon', { key: 1, points: '8,0.8 14.4,4.4 14.4,11.6 8,15.2 1.6,11.6 1.6,4.4', fill: c.merge }), glyphCheck];
      case 'skipped': case 'cancelled': return [e('circle', { key: 1, cx: 8, cy: 8, r: 6, ...st(c.mute) }), e('path', { key: 2, d: 'M3.9 12.1 L12.1 3.9', ...st(c.mute) })];
      case 'stuck': return [e('polygon', { key: 1, points: '8,1 15.3,14.4 0.7,14.4', fill: c.fail, strokeLinejoin: 'round' }), ...bang(5.6, 9.6)];
      default: return [e('circle', { key: 1, cx: 8, cy: 8, r: 6, ...st(c.mute) })];
    }
  }
  function StatusIcon(p) {
    const c = PAL[p.theme] || PAL.dark;
    const size = Number(p.size) || 14;
    return e('svg', { width: size, height: size, viewBox: '0 0 16 16', style: { display: 'block', flex: 'none' }, role: 'img', 'aria-label': p.label || p.status }, shapes(p.status, c, p.animate !== false && p.animate !== 'false'));
  }
  function TypeIcon(p) {
    const col = p.color || ((p.theme === 'light') ? '#6b6f78' : '#8a8e97');
    const size = Number(p.size) || 14;
    const st = { fill: 'none', stroke: col, strokeWidth: 1.4, strokeLinejoin: 'round' };
    let kids;
    if (p.type === 'bug') kids = [e('circle', { key: 1, cx: 8, cy: 8, r: 5.5, ...st }), e('circle', { key: 2, cx: 8, cy: 8, r: 2, fill: col })];
    else if (p.type === 'story') kids = [e('path', { key: 1, d: 'M4 2.5 H12 V13.8 L8 11 L4 13.8 Z', ...st })];
    else kids = [e('rect', { key: 1, x: 2.5, y: 2.5, width: 11, height: 11, rx: 2, ...st }), e('path', { key: 2, d: 'M5.4 8.2 L7.2 10 L10.8 6.2', ...st })];
    return e('svg', { width: size, height: size, viewBox: '0 0 16 16', style: { display: 'block', flex: 'none' }, role: 'img', 'aria-label': p.type }, kids);
  }
  const api = { StatusIcon, TypeIcon };
  if (typeof module !== 'undefined') module.exports = api;
  window.StatusIcon = StatusIcon; window.TypeIcon = TypeIcon;
})();
