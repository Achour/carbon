// A gallery of every chart form `chart_render` draws — stacked bar, horizontal
// bar, multi-series line, area, and a pie wide enough to fold into "Other" —
// checked for what each must carry, then captured in dark and in light.
//
// Four captures: the top and bottom of the gallery in dark, then both again
// after the probe flips the appearance to light. The probe writes the profile's own theme back to
// localStorage at once, so the demo profile wakes in the mode it had.
//
//   ./demo/shoot.sh /tmp/chart-forms 10000,13000,16000,19000 demo/e2e/chart-forms.js
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  const app = window.__app;
  const log = [];
  const check = (name, ok, detail) => log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
  const FORMS = [
    {
      kind: 'bar', stacked: true, title: 'Turns by provider', x: 'month',
      data: months.map((month, i) => ({ month, claude: 120 + i * 30, codex: 60 + i * 12, grok: 10 + i * 6 })),
      series: [{ key: 'claude', label: 'Claude' }, { key: 'codex', label: 'Codex' }, { key: 'grok', label: 'Grok' }]
    },
    {
      kind: 'line', title: 'Median turn length (s)', x: 'month', description: 'Apr – Sep',
      data: months.map((month, i) => ({ month, sonnet: 30 + (i % 3) * 6, opus: 55 - i * 3 })),
      series: [{ key: 'sonnet', label: 'Sonnet' }, { key: 'opus', label: 'Opus' }]
    },
    {
      kind: 'pie', title: 'Lines by language', x: 'lang',
      data: ['TypeScript', 'CSS', 'Markdown', 'JSON', 'Shell', 'HTML', 'YAML', 'SVG', 'Swift'].map((lang, i) => ({ lang, lines: 9000 / (i + 1) })),
      series: [{ key: 'lines', label: 'Lines' }]
    },
    {
      kind: 'bar', horizontal: true, title: 'Longest files', x: 'file',
      data: [['src/renderer/src/store.ts', 6100], ['src/main/claude.ts', 4700], ['src/renderer/src/components/ChatView.tsx', 1510], ['src/main/codex.ts', 2900]].map(([file, lines]) => ({ file, lines })),
      series: [{ key: 'lines', label: 'Lines' }]
    }
  ];

  return (async () => {
    const original = localStorage.getItem('themeMode');
    const meta = app.getState().chats.find((c) => /Nimbus landing/.test(c.title || '')) ?? app.getState().chats[0];
    await app.getState().openChat(meta.id);
    await sleep(1200);
    const chatId = app.getState().activeId;
    app.getState().setThemeMode('dark');
    app.getState().applyEvent({ type: 'message', chatId, message: { id: 'forms-user', role: 'user', ts: Date.now(), text: 'Chart the usage.' } });
    await sleep(200);
    FORMS.forEach((input, i) => {
      const id = `forms-${i}`;
      app.getState().applyEvent({ type: 'message', chatId, message: { id, role: 'assistant', ts: Date.now(), parts: [{ type: 'tool', toolUseId: `${id}-t`, name: 'mcp__carbon__chart_render', input, status: 'success', output: `Drew "${input.title}" in the conversation.` }] } });
    });
    app.getState().applyEvent({ type: 'message', chatId, message: { id: 'forms-answer', role: 'assistant', ts: Date.now(), parts: [{ type: 'text', text: 'Claude carries most of the load.' }] } });
    await sleep(2500);

    const card = (t) => [...document.querySelectorAll('[data-chart-render]')].find((c) => c.textContent.includes(t));
    check('all four forms are drawn', document.querySelectorAll('[data-chart-render]').length === 4);
    const stacked = card('Turns by provider');
    check('the stacked bar draws a segment per series per row', stacked?.querySelectorAll('.recharts-bar-rectangle').length === 18, `${stacked?.querySelectorAll('.recharts-bar-rectangle').length}`);
    check('its legend names all three series', ['Claude', 'Codex', 'Grok'].every((n) => stacked?.querySelector('.recharts-legend-wrapper')?.textContent.includes(n)));
    const line = card('Median turn length');
    check('the line chart draws two lines', line?.querySelectorAll('.recharts-line-curve').length === 2);
    const pie = card('Lines by language');
    const pieLegend = pie?.querySelector('.recharts-legend-wrapper')?.textContent ?? '';
    check('the pie folds past eight slices into "Other"', pie?.querySelectorAll('.recharts-pie-sector').length === 8, `${pie?.querySelectorAll('.recharts-pie-sector').length}`);
    check('the pie legend names its slices', pieLegend.includes('TypeScript') && pieLegend.includes('Other'), pieLegend.slice(0, 80));
    const fills = new Set([...(pie?.querySelectorAll('.recharts-pie-sector path') ?? [])].map((p) => getComputedStyle(p).fill));
    check('every slice has its own colour', fills.size === 8, `${fills.size}`);
    const horiz = card('Longest files');
    // The category axis's ticks: every tick text that is not a number.
    const names = [...(horiz?.querySelectorAll('text') ?? [])].map((t) => t.textContent).filter((t) => !/^[\d.,]+[KMB]?$/.test(t));
    check('the horizontal bar names every row, long paths cut to fit', names.length === 4 && names.every((n) => n.length <= 22) && names.some((n) => n.endsWith('…')), names.join(' | '));

    // Pie tooltip: hover a slice and read what it says.
    const sector = pie?.querySelector('.recharts-pie-sector path');
    if (sector) {
      const r = sector.getBoundingClientRect();
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        sector.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      }
      await sleep(400);
      const tip = pie.querySelector('.recharts-tooltip-wrapper')?.textContent ?? '';
      check('a pie tooltip names the slice', tip.includes('TypeScript'), tip.slice(0, 60));
      const row = pie.querySelector('.recharts-tooltip-wrapper .justify-between');
      const [name, value] = row ? [...row.querySelectorAll(':scope > *, :scope > div > *')].filter((e) => e.children.length === 0) : [];
      const gap = name && value ? value.getBoundingClientRect().left - name.getBoundingClientRect().right : -1;
      check('and keeps its value apart from the name', gap >= 8, `${gap.toFixed?.(1)}px`);
    }

    // Four captures, synchronized to the page clock (`AIGUI_CAPTURE_DELAY`
    // counts from load): dark top, dark bottom, light top, light bottom.
    const at = async (ms) => { while (performance.now() < ms) await sleep(100); };
    const top = () => stacked?.scrollIntoView({ block: 'start' });
    const bottom = () => horiz?.scrollIntoView({ block: 'end' });
    await at(8500); top();
    await at(11500); bottom();
    await at(14500); app.getState().setThemeMode('light'); top();
    // Leave the profile's own preference on disk; only the window flips.
    if (original === null) localStorage.removeItem('themeMode');
    else localStorage.setItem('themeMode', original);
    await at(17500); bottom();
    return log.join('\n');
  })();
})()
