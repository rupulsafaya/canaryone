// Embedded JS. Vanilla, no framework.
// - Tab nav switching
// - Sortable lane-table columns (data-sort-key on <th>, data-sort-value on <td>)
// - Heatmap raw/weighted toggle
//
// Runs on DOMContentLoaded so it's safe to inline at end-of-body OR in <head>.

export const SCRIPTS = `
(function () {
  'use strict';
  var boot = function () {
    // ---------- tabs ----------
    var tabButtons = document.querySelectorAll('.tab-btn');
    var tabPanels = document.querySelectorAll('.tab-panel');
    Array.prototype.forEach.call(tabButtons, function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(tabButtons, function (b) {
          b.classList.toggle('active', b.getAttribute('data-tab') === target);
        });
        Array.prototype.forEach.call(tabPanels, function (p) {
          p.classList.toggle('active', p.id === target);
        });
      });
    });

    // ---------- sortable tables ----------
    Array.prototype.forEach.call(document.querySelectorAll('table.lb'), function (table) {
      var tbody = table.querySelector('tbody');
      if (!tbody) return;
      var headers = table.querySelectorAll('thead th.sortable');
      var direction = {};  // key -> 'asc' | 'desc'
      Array.prototype.forEach.call(headers, function (th) {
        th.addEventListener('click', function () {
          var key = th.getAttribute('data-sort-key');
          if (!key) return;
          var dir = direction[key] === 'asc' ? 'desc' : 'asc';
          direction = {}; direction[key] = dir;
          Array.prototype.forEach.call(headers, function (h) {
            h.classList.remove('sort-asc', 'sort-desc');
          });
          th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
          var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
          rows.sort(function (a, b) {
            var av = a.querySelector('td[data-sort-key="' + key + '"]');
            var bv = b.querySelector('td[data-sort-key="' + key + '"]');
            var an = av ? parseFloat(av.getAttribute('data-sort-value')) : NaN;
            var bn = bv ? parseFloat(bv.getAttribute('data-sort-value')) : NaN;
            var aIsNum = !isNaN(an);
            var bIsNum = !isNaN(bn);
            // Nulls / non-numeric sort to the end regardless of direction.
            if (!aIsNum && !bIsNum) return 0;
            if (!aIsNum) return 1;
            if (!bIsNum) return -1;
            return dir === 'asc' ? an - bn : bn - an;
          });
          rows.forEach(function (r) { tbody.appendChild(r); });
        });
      });
    });

    // ---------- heatmap raw/weighted toggle ----------
    var heatToggle = document.querySelector('.heat-toggle');
    if (heatToggle) {
      var heatButtons = heatToggle.querySelectorAll('button');
      Array.prototype.forEach.call(heatButtons, function (btn) {
        btn.addEventListener('click', function () {
          var mode = btn.getAttribute('data-mode');  // 'weighted' | 'raw'
          Array.prototype.forEach.call(heatButtons, function (b) {
            b.classList.toggle('active', b.getAttribute('data-mode') === mode);
          });
          var cells = document.querySelectorAll('.heatmap td[data-heat-weighted]');
          Array.prototype.forEach.call(cells, function (c) {
            var bucket = c.getAttribute('data-heat-' + mode);
            // strip any heat-N class then add the new one
            c.className = c.className.replace(/heat-\\d/g, '').replace(/\\s+/g, ' ').trim();
            if (bucket) c.classList.add('heat-' + bucket);
          });
        });
      });
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
`;
