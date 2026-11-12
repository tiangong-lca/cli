/** Fixed enhancement; report text is never evaluated as code. */
export const REPORT_BROWSER = String.raw`(() => {
  const language = document.querySelector('#report-language');
  language.addEventListener('change', () => {
    document.documentElement.dataset.language = language.value;
    document.documentElement.lang = language.value === 'zh' ? 'zh' : 'en';
  });
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
  for (const link of document.querySelectorAll('[data-graph-link]')) {
    link.addEventListener('click', () => {
      for (const selected of document.querySelectorAll('.selected')) selected.classList.remove('selected');
      link.classList.add('selected');
      const detail = document.getElementById(link.dataset.graphLink);
      detail.classList.add('selected');
      detail.focus({preventScroll:true});
    });
  }
  const zoom = document.querySelector('#graph-zoom');
  if (zoom) {
    const graph = document.querySelector('#model-svg');
    zoom.addEventListener('input', () => graph.style.width = zoom.value + '%');
    document.querySelector('#graph-fit').addEventListener('click', () => {
      zoom.value = '100'; graph.style.width = '100%';
      document.querySelector('.graph-scroll').scrollTo(0, 0);
    });
  }
  document.documentElement.dataset.interactive = 'ready';
})();`;
