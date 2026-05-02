export class TooltipManager {
  private tooltipEl: HTMLDivElement | null = null;
  private showTimer: number | null = null;
  private activeTarget: HTMLElement | null = null;

  show(target: HTMLElement, text: string, delayMs = 100): void {
    this.clearTimer();
    this.activeTarget = target;
    this.showTimer = window.setTimeout(() => {
      if (this.activeTarget !== target) return;
      this.ensureEl();
      if (!this.tooltipEl) return;
      this.tooltipEl.textContent = text;
      this.tooltipEl.classList.add('is-visible');
      this.position(target);
    }, delayMs);
  }

  hide(): void {
    this.clearTimer();
    this.activeTarget = null;
    this.tooltipEl?.classList.remove('is-visible');
  }

  private ensureEl(): void {
    if (this.tooltipEl) return;
    const el = document.createElement('div');
    el.className = 'flomo-tooltip';
    document.body.appendChild(el);
    this.tooltipEl = el;
  }

  private position(target: HTMLElement): void {
    if (!this.tooltipEl) return;
    const tr = target.getBoundingClientRect();
    const tt = this.tooltipEl.getBoundingClientRect();
    const gap = 8, pad = 8;
    let top = tr.top - tt.height - gap;
    if (top < pad) top = tr.bottom + gap;
    let left = tr.left + tr.width / 2 - tt.width / 2;
    const maxLeft = window.innerWidth - tt.width - pad;
    left = Math.max(pad, Math.min(left, maxLeft));
    this.tooltipEl.style.top = `${Math.round(top)}px`;
    this.tooltipEl.style.left = `${Math.round(left)}px`;
  }

  private clearTimer(): void {
    if (this.showTimer !== null) {
      window.clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }
}

let shared: TooltipManager | null = null;

export function getTooltipManager(): TooltipManager {
  if (!shared) shared = new TooltipManager();
  return shared;
}
