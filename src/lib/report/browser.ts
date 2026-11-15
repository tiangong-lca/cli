/** Fixed enhancement; report text is never evaluated as code. */
export const REPORT_BROWSER = String.raw`(() => {
  const language = document.querySelector('#report-language');
  const updateLanguage = () => {
    document.documentElement.dataset.language = language.value;
    document.documentElement.lang = language.value;
    document.title = document.querySelector('h1').innerText;
    for (const element of document.querySelectorAll('[data-label-en]')) {
      element.setAttribute('aria-label', language.value === 'zh' ? element.dataset.labelZh : element.dataset.labelEn);
    }
  };
  language.addEventListener('change', updateLanguage);
  updateLanguage();
  document.querySelector('#report-print').addEventListener('click', () => window.print());
  for (const block of document.querySelectorAll('[data-table]')) {
    const input = block.querySelector('input');
    input.addEventListener('input', () => {
      const query = input.value.toLocaleLowerCase();
      let visible = 0;
      const rows = block.querySelectorAll('tbody tr');
      for (const row of rows) {
        row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
        if (!row.hidden) visible++;
      }
      block.querySelector('[role=status]').textContent = visible + ' / ' + rows.length;
    });
  }
  document.documentElement.dataset.interactive = 'ready';
  const panel = document.querySelector('.network-panel');
  if (!panel) return;
  const viewport = panel.querySelector('.network-viewport');
  const graph = panel.querySelector('.network-svg');
  const inspector = panel.querySelector('.network-inspector');
  const controls = panel.querySelector('.network-controls');
  const zoomLabel = panel.querySelector('.network-zoom');
  const expand = panel.querySelector('.network-expand');
  const model = document.getElementById('model');
  const dialog = document.createElement('dialog');
  const anchor = document.createComment('model viewer');
  const width = Number(graph.getAttribute('width'));
  const height = Number(graph.getAttribute('height'));
  let zoom = 1;
  let drag;
  dialog.className = 'network-dialog';
  dialog.setAttribute('aria-labelledby', 'network-title');
  panel.querySelector('.network-title').id = 'network-title';
  panel.before(anchor);
  document.body.append(dialog);

  function select(id) {
    const detail = document.getElementById(id);
    if (!detail?.classList.contains('detail') || !model.contains(detail)) return false;

    for (const selected of model.querySelectorAll('.detail.selected')) selected.classList.remove('selected');
    detail.classList.add('selected');
    const copy = detail.cloneNode(true);
    copy.classList.remove('selected');
    copy.removeAttribute('id');
    copy.removeAttribute('tabindex');
    if (copy.classList.contains('connection')) {
      for (const link of copy.querySelectorAll('a[href^="#node-"]')) {
        const node = document.getElementById(link.getAttribute('href').slice(1));
        const title = node?.querySelector('h3');
        if (title) link.replaceChildren(...[...title.childNodes].map(child => child.cloneNode(true)));
      }
    }
    inspector.replaceChildren(copy);
    for (const link of graph.querySelectorAll('a')) {
      const isSelected = link.getAttribute('href') === '#' + id;
      link.classList.toggle('network-active', isSelected);
      if (isSelected) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    return true;
  }

  function scale(next, center) {
    const available = viewport.clientWidth;
    const x = (viewport.scrollLeft + available / 2) / zoom;
    const y = (viewport.scrollTop + viewport.clientHeight / 2) / zoom;
    zoom = Math.min(2.5, Math.max(0.01, next));
    graph.style.width = width * zoom + 'px';
    graph.style.height = height * zoom + 'px';
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    if (center) viewport.scrollTo(x * zoom - available / 2, y * zoom - viewport.clientHeight / 2);
  }

  function fit() {
    scale(Math.min(1, (viewport.clientWidth - 4) / width, (viewport.clientHeight - 4) / height), false);
    viewport.scrollTo(0, 0);
  }

  function openOrClose() {
    if (dialog.open) {
      dialog.close();
      return;
    }
    dialog.append(panel);
    dialog.showModal();
    panel.querySelector('.network-open').hidden = true;
    panel.querySelector('.network-close').hidden = false;
    fit();
  }

  function restorePanel() {
    if (panel.parentElement !== dialog) return;
    anchor.after(panel);
    panel.querySelector('.network-open').hidden = false;
    panel.querySelector('.network-close').hidden = true;
    expand.focus({ preventScroll: true });
    fit();
  }
  dialog.addEventListener('close', restorePanel);
  expand.addEventListener('click', openOrClose);

  controls.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.zoom;
    if (action === 'fit') fit();
    if (action === 'in') scale(zoom * 1.25, true);
    if (action === 'out') scale(zoom / 1.25, true);
  });

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('a')) return;
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('network-dragging');
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag) return;
    viewport.scrollTo(drag.left + drag.x - event.clientX, drag.top + drag.y - event.clientY);
  });
  viewport.addEventListener('lostpointercapture', () => {
    drag = undefined;
    viewport.classList.remove('network-dragging');
  });

  // Contribution links, diagram links and detail links use the same report anchors.
  document.addEventListener('click', event => {
    const source = event.target.closest('.network-inspector a[href^="#source-"]');
    if (source && dialog.open) {
      dialog.close();
      restorePanel();
    }
    const link = event.target.closest('a[href^="#node-"], a[href^="#edge-"]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!select(link.getAttribute('href').slice(1))) return;
    event.preventDefault();
    if (!panel.contains(link)) {
      model.scrollIntoView({ block: 'start' });
      inspector.focus({ preventScroll: true });
    }
  });

  inspector.tabIndex = -1;
  inspector.setAttribute('aria-live', 'polite');
  if (!select(location.hash.slice(1))) select(graph.querySelector('.network-node').getAttribute('href').slice(1));
  inspector.hidden = false;
  controls.hidden = false;
  panel.dataset.networkReady = 'true';
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('beforeprint', () => {
    if (!dialog.open) return;
    dialog.close();
    restorePanel();
  });
})();`;
