/* tour.js — first-run guided tour: five stops that mirror the "5 zones" map.
 * Starts once, right after the FIRST PDF opens (that's when every zone is
 * alive and meaningful); re-runnable any time from the help dialog. Skippable
 * at every step; Esc skips too.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const STEPS = [
    { sel: '.tb-left', title: '1 · פעולות ראשיות', text: 'פתיחת קובץ, "מלא הכל" בקליק — ובסוף: ייצוא PDF עם תצוגה מקדימה של הקובץ הסופי.' },
    { sel: '#rail', title: '2 · סרגל הכלים', text: 'מה ששמים על הטופס: טקסט, וי, תאריך, חתימה וחותמת — וקבוצת "מחיקה והחלפה" לתיקון נתון קיים בגרירה אחת.' },
    { sel: '.viewport', title: '3 · הטופס', text: 'כתמים כתומים = שדות שזוהו וממתינים למילוי. מה שרואים כאן הוא בדיוק מה שיוצא בקובץ.' },
    { sel: '#rightpanel', title: '4 · פאנל העבודה', text: 'לשונית "מילוי": מקלידים בשורות — וזה נכתב במקום הנכון על הטופס. כאן גם נספחים מקושרים, נכסים (חתימות/חותמות) והגדרות.' },
    { sel: '#helpBtn', title: '5 · עזרה', text: 'קיצורי מקלדת ומדריך מלא — ומכאן אפשר להריץ את הסיור הזה שוב בכל רגע. בהצלחה! 🎉' }
  ];

  let ui = null, idx = 0, active = false;

  function build() {
    if (ui) return ui;
    const dim = document.createElement('div');
    dim.className = 'tour-dim';
    const hole = document.createElement('div');
    hole.className = 'tour-hole';
    const bub = document.createElement('div');
    bub.className = 'tour-bubble';
    bub.innerHTML =
      '<div class="tour-title"></div><div class="tour-text"></div>' +
      '<div class="tour-foot"><button class="btn sm ghost tour-skip">דלג</button>' +
      '<span class="tour-dots"></span>' +
      '<button class="btn sm primary tour-next">הבא</button></div>';
    dim.append(hole);
    document.body.append(dim, bub);
    bub.querySelector('.tour-next').addEventListener('click', () => step(idx + 1));
    bub.querySelector('.tour-skip').addEventListener('click', end);
    dim.addEventListener('pointerdown', (e) => { if (e.target === dim) end(); });
    ui = { dim, hole, bub };
    return ui;
  }

  function place(target) {
    const { hole, bub } = ui;
    const r = target.getBoundingClientRect();
    const pad = 6;
    hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`;
    // bubble: try below → side toward the free space → clamped
    const bw = Math.min(360, innerWidth - 24), bh = 170;
    bub.style.maxWidth = bw + 'px';
    let x, y;
    if (r.bottom + bh + 16 < innerHeight) { y = r.bottom + 14; x = r.left + r.width / 2 - bw / 2; }
    else if (r.left > bw + 24) { x = r.left - bw - 14; y = r.top + r.height / 2 - bh / 2; }
    else if (innerWidth - r.right > bw + 24) { x = r.right + 14; y = r.top + r.height / 2 - bh / 2; }
    else { y = Math.max(12, r.top - bh - 14); x = r.left + r.width / 2 - bw / 2; }
    bub.style.left = Math.max(12, Math.min(innerWidth - bw - 12, x)) + 'px';
    bub.style.top = Math.max(12, Math.min(innerHeight - bh - 12, y)) + 'px';
  }

  function step(i) {
    idx = i;
    if (idx >= STEPS.length) { end(true); return; }
    const st = STEPS[idx];
    const target = document.querySelector(st.sel);
    if (!target) { step(idx + 1); return; }
    build();
    ui.dim.classList.add('show'); ui.bub.classList.add('show');
    ui.bub.querySelector('.tour-title').textContent = st.title;
    ui.bub.querySelector('.tour-text').textContent = st.text;
    ui.bub.querySelector('.tour-next').textContent = idx === STEPS.length - 1 ? 'סיום ✓' : 'הבא';
    ui.bub.querySelector('.tour-dots').textContent = (idx + 1) + ' / ' + STEPS.length;
    place(target);
  }

  function end(completed) {
    active = false;
    if (ui) { ui.dim.classList.remove('show'); ui.bub.classList.remove('show'); }
    PFS.store.set('tour_done', 1);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  }
  function onKey(e) { if (e.key === 'Escape' && active) { e.stopPropagation(); end(); } }
  function onResize() { if (!active) return; const st = STEPS[idx]; const t = st && document.querySelector(st.sel); if (t) place(t); }

  function start() {
    if (active) return;
    active = true;
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    step(0);
  }
  // fire once after the first form opens — unless the user has already toured
  function maybeStart() {
    if (PFS.store.get('tour_done', 0)) return;
    setTimeout(() => { if (!PFS.store.get('tour_done', 0)) start(); }, 1200);
  }

  PFS.tour = { start, maybeStart, isActive: () => active };
})(window);
