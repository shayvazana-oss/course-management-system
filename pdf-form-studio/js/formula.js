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
    // sum(a,b,c) → (a+b+c), innermost first
    let guard = 0;
    while (/sum\s*\(/i.test(s) && guard++ < 30) {
      s = s.replace(/sum\s*\(([^()]*)\)/i, (_m, args) => '(' + args.split(',').map((x) => (x.trim() || '0')).join('+') + ')');
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

  PFS.formula = { isFormula, evaluate, format };
})(window);
