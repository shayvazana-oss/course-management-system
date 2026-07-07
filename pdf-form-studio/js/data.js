/* data.js — reusable data profiles ("My details").
 * Save a set of key→value details once (name, ID, phone, address, business…)
 * and one-click fill any form whose text fields are tagged with matching keys.
 * Persisted in localStorage.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // Common bureaucratic/business fields offered as ready-made keys.
  const SUGGESTED = [
    { key: 'full_name', label: 'שם מלא' },
    { key: 'id', label: 'תעודת זהות' },
    { key: 'phone', label: 'טלפון' },
    { key: 'email', label: 'דוא״ל' },
    { key: 'address', label: 'כתובת' },
    { key: 'city', label: 'עיר' },
    { key: 'business_name', label: 'שם העסק' },
    { key: 'business_id', label: 'ח.פ / עוסק' },
    { key: 'course', label: 'שם הקורס' },
    { key: 'amount', label: 'סכום' },
    { key: 'date', label: 'תאריך' }
  ];

  function createDataProfiles(opts = {}) {
    const store = PFS.store;
    const KEY = 'profiles';
    const ACTIVE = 'active_profile';
    let SEQ = 1;
    const uid = () => 'pf' + (SEQ++) + '_' + Math.floor(performance.now());

    const all = () => store.get(KEY, []);
    const persist = (arr) => store.set(KEY, arr);
    const activeId = () => store.get(ACTIVE, null);
    const setActive = (id) => store.set(ACTIVE, id);
    const active = () => all().find((p) => p.id === activeId()) || all()[0] || null;

    function saveProfile(name, values) {
      const arr = all();
      const existing = arr.find((p) => p.name === name);
      if (existing) { existing.values = values; }
      else { const p = { id: uid(), name: name || ('פרופיל ' + (arr.length + 1)), values }; arr.unshift(p); setActive(p.id); }
      persist(arr);
      return arr;
    }
    function removeProfile(id) {
      persist(all().filter((p) => p.id !== id));
      if (activeId() === id) setActive(all()[0]?.id || null);
    }
    function setValue(id, k, v) {
      const arr = all(); const p = arr.find((x) => x.id === id);
      if (!p) return; p.values = p.values || {}; p.values[k] = v; persist(arr);
    }

    return { all, active, activeId, setActive, saveProfile, removeProfile, setValue, SUGGESTED };
  }

  PFS.createDataProfiles = createDataProfiles;
  PFS.SUGGESTED_FIELDS = SUGGESTED;
})(window);
