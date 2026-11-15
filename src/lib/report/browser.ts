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
  const catalog = model.querySelector('.process-catalog');
  const catalogToggle = catalog.querySelector('.catalog-toggle');
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

  function selection(id, rowLink) {
    const detail = document.getElementById(id);
    if (!detail?.classList.contains('detail') || !model.contains(detail)) return false;

    const { fromNode, fromExchange, toNode, toExchange } = detail.dataset;
    const current = inspector.dataset.node;
    const clickedExchange = rowLink?.closest('tr').dataset.exchangeId;
    const keepSource = current === 'node-' + fromNode && clickedExchange === fromExchange && Boolean(clickedExchange);
    const nodeId = toNode ? 'node-' + (keepSource ? fromNode : toNode) : id;
    const exchangeId = keepSource ? fromExchange : toExchange;
    const process = document.getElementById(nodeId);
    const copy = process.cloneNode(true);
    copy.removeAttribute('id');
    copy.removeAttribute('tabindex');
    inspector.dataset.node = nodeId;
    inspector.replaceChildren(copy);
    inspector.scrollTop = 0;

    for (const link of graph.querySelectorAll('a')) {
      const href = link.getAttribute('href');
      const selected = href === '#' + id || (toNode && href === '#' + nodeId);
      const connected = toNode && !selected && href === '#node-' + (keepSource ? toNode : fromNode);
      link.classList.toggle('network-active', Boolean(selected));
      link.classList.toggle('network-related', Boolean(connected));
      if (selected) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    if (exchangeId) {
      const row = copy.querySelector('[data-exchange-id="' + exchangeId + '"]');
      const active = row.querySelector('a[href="#' + id + '"]');
      row.classList.add('exchange-current');
      active.setAttribute('aria-current', 'true');
      const connection = detail.cloneNode(true);
      connection.removeAttribute('id');
      connection.removeAttribute('tabindex');
      inspector.append(connection);
      if (rowLink) active.focus({ preventScroll: true });
      const lowerEdge = row.getBoundingClientRect().bottom - inspector.getBoundingClientRect().bottom;
      if (lowerEdge > 0) inspector.scrollTop += lowerEdge + 12;
    }
    return true;
  }

  function revealConnection(id) {
    const edge = graph.querySelector('a[href="#' + id + '"] foreignObject');
    const position = edge.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    if (position.left < view.left || position.right > view.right || position.top < view.top || position.bottom > view.bottom) {
      viewport.scrollBy(position.left - view.left - view.width / 2, position.top - view.top - view.height / 2);
    }
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
    const id = link.getAttribute('href').slice(1);
    const insidePanel = panel.contains(link);
    const rowLink = link.classList.contains('exchange-link') && inspector.contains(link) ? link : undefined;
    if (!selection(id, rowLink)) return;
    event.preventDefault();
    if (link.classList.contains('exchange-link')) revealConnection(id);
    if (!insidePanel) {
      model.scrollIntoView({ block: 'start' });
      inspector.focus({ preventScroll: true });
    }
  });

  inspector.tabIndex = -1;
  inspector.setAttribute('aria-live', 'polite');
  catalogToggle.addEventListener('click', () => {
    catalogToggle.setAttribute('aria-expanded', String(catalogToggle.getAttribute('aria-expanded') !== 'true'));
  });
  catalogToggle.setAttribute('aria-expanded', 'false');
  catalogToggle.hidden = false;
  inspector.hidden = false;
  controls.hidden = false;
  panel.dataset.networkReady = 'true';
  if (!selection(location.hash.slice(1))) selection(catalog.dataset.defaultProcess);
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('beforeprint', () => {
    if (!dialog.open) return;
    dialog.close();
    restorePanel();
  });
})();`;
