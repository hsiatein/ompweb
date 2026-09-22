export const MIN_TEXT_SCRIPT_BUDGET_MS = 1;

type TextUpdate = { update(time: number, now: number, budgetMs: number): void };

export class SceneTextScheduler {
  private next = 0;

  update(layers: readonly TextUpdate[], time: number, now: number, budgetMs = 8) {
    if (!layers.length || !Number.isFinite(budgetMs)) return;
    const deadline = performance.now() + Math.min(8, Math.max(0, budgetMs));
    for (let visited = 0; visited < layers.length; visited++) {
      const remaining = deadline - performance.now();
      if (remaining < MIN_TEXT_SCRIPT_BUDGET_MS) break;
      const index = this.next % layers.length;
      // Resume with the deferred layer next frame, even if an earlier draw was slow.
      this.next = (index + 1) % layers.length;
      layers[index].update(time, now, remaining);
    }
  }
}
