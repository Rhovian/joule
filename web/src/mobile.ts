export function createMobile(actions: { state: (id: number, state: string) => Promise<void>; error: (error: unknown) => void; refresh: () => void }) {
  const phone = matchMedia('(max-width: 740px)'), root = document.getElementById('dashboard')!;
  const dialog = document.getElementById('mobile-filters') as HTMLDialogElement;
  const controls = document.querySelector<HTMLElement>('.controls')!, parent = controls.parentElement!;
  const menu = document.getElementById('sources-menu')!, opener = document.getElementById('mobile-filter-open')!;
  function openFilters() { if (phone.matches && !dialog.open) { dialog.showModal(); document.body.classList.add('filters-open'); actions.refresh(); } }
  function layout() {
    if (dialog.open) dialog.close();
    if (menu.matches(':popover-open')) menu.hidePopover();
    if (phone.matches) {
      document.getElementById('source-search')!.removeAttribute('autofocus');
      menu.removeAttribute('popover'); menu.setAttribute('role', 'group');
      document.getElementById('mobile-filter-content')!.append(controls);
    } else if (controls.parentElement !== parent) {
      parent.append(controls); document.getElementById('source-search')!.setAttribute('autofocus', ''); menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'dialog');
      (parent as HTMLDetailsElement).open = !root.classList.contains('split');
    }
    const scanFilters = document.querySelector<HTMLDetailsElement>('.scan-filter-panel');
    if (scanFilters) scanFilters.open = !phone.matches;
  }
  opener.addEventListener('click', openFilters);
  dialog.addEventListener('close', () => { document.body.classList.remove('filters-open'); if (phone.matches && !root.classList.contains('split')) opener.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if ((event.target as HTMLElement).closest('[data-mobile-close]') || event.target === dialog && (event.clientY < box.top || event.clientX < box.left || event.clientX > box.right)) dialog.close();
  });
  phone.addEventListener('change', layout); layout();
  // astro@7.3.8/dist/runtime/client/load.js only hydrates; native Pointer Events provide card swipes.
  let drag: { row: HTMLElement; id: number; x: number; y: number; dx: number; active: boolean } | null = null;
  let swiped: HTMLElement | null = null, swipeTime = 0;
  function reset() { if (drag) { drag.row.style.removeProperty('--swipe'); delete drag.row.dataset.swipe; } drag = null; }
  root.addEventListener('pointerdown', event => {
    if (!phone.matches || !event.isPrimary || event.button !== 0 || dialog.open || root.classList.contains('split')) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-job]');
    if (row) drag = { row, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false };
  });
  root.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.active && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { reset(); return; }
    if (!drag.active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) { drag.active = true; drag.row.setPointerCapture(event.pointerId); }
    if (drag.active) { event.preventDefault(); drag.dx = dx; drag.row.style.setProperty('--swipe', `${Math.max(-140, Math.min(140, dx))}px`); drag.row.dataset.swipe = dx < 0 ? 'dismissed' : 'applied'; }
  });
  root.addEventListener('pointercancel', reset);
  root.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const { row, dx, active } = drag;
    if (active) { swiped = row; swipeTime = performance.now(); event.preventDefault(); }
    reset();
    if (active && Math.abs(dx) >= 80) void actions.state(Number(row.dataset.job), dx < 0 ? 'dismissed' : 'applied').catch(actions.error);
  });
  root.addEventListener('click', event => {
    if (swiped?.contains(event.target as Node) && performance.now() - swipeTime < 400) { event.preventDefault(); event.stopImmediatePropagation(); swiped = null; }
  }, true);
  return { openFilters, update(count: number, summary: string) {
    opener.textContent = summary;
    document.getElementById('mobile-show-jobs')!.textContent = `Show ${count} Jobs`;
    if (dialog.open && document.getElementById('triage')!.hidden) dialog.close();
  } };
}
