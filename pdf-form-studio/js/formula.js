/* formula.js — calculated fields. A field can hold a formula that references
 * other fields by key and updates automatically — the premium feature free
 * tools lack (auto-summed totals, quantity × price). Safe by construction:
 * references are substituted with numbers, then a tiny recursive-descent
 * arithmetic evaluator runs — no eval / Function, so nothing executes.
 *
 * Syntax:  =[qty]*[price]      · =sum([a],[b],[c])      · =([a]+[b])/2
 *   [key]  → the numeric value of the field tagged with that key (0 if empty)
 *   sum(…) → sum of its comma-separated arguments
 *   + - * / ( ) and decimals are supported.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const isFormula = (s) => typeof s === 'string' && s.trim().charAt(0) === '=';

  // safe arithmetic evaluator over a string of digits . + - * / ( ) and spaces
  function evalArith(s) {
    let i = 0;
    const skip = () => { while (s[i] === ' ') i++; };
    function expr() { let v = term(); skip(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const t = term(); v = op === '+' ? v + t : v - t; skip(); } return v; }
    function term() { let v = factor(); skip(); while (s[i] === '*' || s[i] === '/') { const op = s[i++]; const f = factor(); v = op === '*' ? v * f : (f === 0 ? 0 : v / f); skip(); } return v; }
    function factor() { skip(); if (s[i] === '(') { i++; const v = expr(); skip(); if (s[i] === ')') i++; return v; } if (s[i] === '-') { i++; return -factor(); } if (s[i] === '+') { i++; return factor(); } return num(); }
    function num() { skip(); const start = i; while (i < s.length && /[\d.]/.test(s[i])) i++; return parseFloat(s.slice(start, i)) || 0; }
    const r = expr();
    return r;
  }

  // number → tidy string (integer, else up to 2 decimals)
  function fmt(n) { if (!isFinite(n)) return ''; const r = Math.round(n * 100) / 100; return Number.isInteger(r) ? String(r) : String(r); }

  // functions available in formulas (args already reduced to numbers)
  const FUNCS = {
    sum: (a) => a.reduce((s, x) => s + x, 0),
    avg: (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0),
    min: (a) => (a.length ? Math.min.apply(null, a) : 0),
    max: (a) => (a.length ? Math.max.apply(null, a) : 0),
    round: (a) => Math.round(a[0] || 0),
    abs: (a) => Math.abs(a[0] || 0)
  };

  /* evaluate(formulaString, varsByKey) → computed value as a string, '' on error */
  function evaluate(expr, vars) {
    if (!isFormula(expr)) return '';
    vars = vars || {};
    let s = String(expr).trim().slice(1); // drop leading '='
    // [key] → numeric value of that field
    s = s.replace(/\[([^\]]+)\]/g, (_m, k) => {
      const raw = vars[k.trim()];
      const v = parseFloat(String(raw == null ? '' : raw).replace(/[^\d.\-]/g, ''));
      return isFinite(v) ? String(v) : '0';
    });
    // resolve function calls innermost-first: name(a,b,…) → its numeric result
    let guard = 0;
    while (/[A-Za-z]+\s*\([^()]*\)/.test(s) && guard++ < 40) {
      s = s.replace(/([A-Za-z]+)\s*\(([^()]*)\)/, (_m, fn, argstr) => {
        const f = FUNCS[fn.toLowerCase()];
        if (!f) return '(' + argstr + ')';                 // unknown fn → plain group
        const args = argstr.split(',').map((x) => evalArith(x.trim() || '0'));
        const r = f(args);
        return isFinite(r) ? '(' + r + ')' : '0';
      });
    }
    if (!/^[\d.+\-*/() ]*$/.test(s) || !s.trim()) return '';
    const n = evalArith(s);
    return isFinite(n) ? fmt(n) : '';
  }

  /* format(value, fmt) → display a numeric value as number / currency / percent
   * (Israeli locale). Non-numeric input is returned unchanged. */
  function format(value, fmt) {
    if (!fmt || fmt === 'none') return value;
    const n = parseFloat(String(value == null ? '' : value).replace(/[^\d.\-]/g, ''));
    if (!isFinite(n)) return value;
    if (fmt === 'number') return n.toLocaleString('he-IL', { maximumFractionDigits: 2 });
    if (fmt === 'currency') return '₪' + n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (fmt === 'percent') return n.toLocaleString('he-IL', { maximumFractionDigits: 2 }) + '%';
    return value;
  }

  /* resolve(models, onChange) — recompute every calculated field in a set of
   * element models, in place. ONE implementation shared by interactive fill and
   * mail-merge so they can't drift. Handles calc fields that reference other
   * calc fields via fixed-point iteration; the pass cap makes circular
   * references stop cleanly. `onChange(model)` fires whenever a field's text
   * changes, so a caller can update the DOM. Models need {type,fieldKey,formula,
   * format,text}; `text` is mutated to the computed (and formatted) value. */
  function resolve(models, onChange) {
    models = models || [];
    const formulaMs = models.filter((m) => m && m.type === 'text' && isFormula(m.formula));
    if (!formulaMs.length) return;
    const vars = {};
    models.forEach((m) => { if (m && m.type === 'text' && m.fieldKey) vars[m.fieldKey] = m.text; });
    const maxPasses = formulaMs.length + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      formulaMs.forEach((m) => {
        const v = evaluate(m.formula, vars);                   // raw numeric string
        if (m.fieldKey && vars[m.fieldKey] !== v) { vars[m.fieldKey] = v; changed = true; }
        const shown = (v !== '' && m.format) ? format(v, m.format) : v;
        if (m.text !== shown) { m.text = shown; if (onChange) onChange(m); }
      });
      if (!changed) break;
    }
  }

  PFS.formula = { isFormula, evaluate, format, resolve };
})(window);
