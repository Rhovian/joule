export type Undo = ReturnType<typeof createUndo>;
export function createUndo() {
  const toast = document.getElementById('undo-toast')!;
  let last: { view: string; restore: () => Promise<boolean> } | null = null, timer: ReturnType<typeof setTimeout>;
  // astro@7.3.8/dist/runtime/client/load.js only hydrates; native Promise chains serialize state commands and undo.
  let tail: Promise<unknown> = Promise.resolve();
  function perform<T>(work: () => Promise<T>) { const next = tail.then(work); tail = next.catch(() => {}); return next; }
  function forget() { last = null; toast.hidden = true; clearTimeout(timer); }
  return {
    perform, forget,
    remember(view: string, label: string, restore: () => Promise<boolean>) {
      last = { view, restore }; toast.querySelector('span')!.textContent = label; toast.hidden = false;
      clearTimeout(timer); timer = setTimeout(() => { toast.hidden = true; }, 6000);
    },
    run(view?: string) {
      return perform(async () => {
        const saved = last;
        if (!saved || view && saved.view !== view) return;
        if (await saved.restore() && last === saved) forget();
      });
    },
  };
}
