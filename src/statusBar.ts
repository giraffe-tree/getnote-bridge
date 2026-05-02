import { Menu, moment, setIcon } from 'obsidian';
import type GetBridgePlugin from '../main';
import type { SyncStatus, ErrorDetails } from './types';
import { getTooltipManager } from './tooltip';

export class StatusBarManager {
  private plugin: GetBridgePlugin;
  private el: HTMLElement;
  private currentStatus: SyncStatus = 'idle';
  private statusText = 'Get: 未同步';
  private lastError?: ErrorDetails;
  private processedCount = 0;
  private currentStats?: { created: number; updated: number; skipped: number; failed: number };
  private tooltipManager = getTooltipManager();

  constructor(plugin: GetBridgePlugin) {
    this.plugin = plugin;
    this.el = plugin.addStatusBarItem();
    this.el.addClass('mod-clickable');

    this.el.addEventListener('click', () => {
      if (!this.plugin.isSyncing) void this.plugin.performSync();
    });

    this.el.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.showContextMenu(e);
    });

    this.el.addEventListener('mouseenter', () => {
      const tip = this.buildTooltip();
      if (tip) this.tooltipManager.show(this.el, tip, 100);
    });
    this.el.addEventListener('mouseleave', () => this.tooltipManager.hide());

    this.repaint();
  }

  setIdle(lastSyncTs?: number): void {
    this.currentStatus = 'idle';
    this.currentStats = undefined;
    this.el.removeClass('getnote-sync-active');

    if (lastSyncTs) {
      const m = moment(lastSyncTs);
      const diffM = moment().diff(m, 'minutes');
      const diffH = moment().diff(m, 'hours');
      const diffD = moment().diff(m, 'days');
      if (diffM < 1)       this.statusText = 'Get: 刚刚';
      else if (diffM < 60) this.statusText = `Get: ${diffM}分钟前`;
      else if (diffH < 24) this.statusText = `Get: ${diffH}小时前`;
      else                 this.statusText = `Get: ${diffD}天前`;
    } else {
      this.statusText = 'Get: 未同步';
    }
    this.repaint();
  }

  setSyncing(count: number, stats?: { created: number; updated: number; skipped: number; failed: number }): void {
    this.currentStatus = 'syncing';
    this.processedCount = count;
    this.currentStats = stats;
    this.el.addClass('getnote-sync-active');
    this.repaint();
  }

  setSuccess(message?: string): void {
    this.currentStatus = 'success';
    this.statusText = message ?? 'Get ✅';
    this.el.removeClass('getnote-sync-active');
    this.currentStats = undefined;
    this.repaint();
  }

  setError(message: string, details?: Partial<ErrorDetails>): void {
    this.currentStatus = 'error';
    this.statusText = 'Get ❌';
    this.lastError = { message, timestamp: Date.now(), ...details };
    this.el.removeClass('getnote-sync-active');
    this.currentStats = undefined;
    this.repaint();
  }

  private repaint(): void {
    this.el.empty();
    const container = this.el.createSpan({ cls: 'flomo-sync-status' });
    const iconEl = container.createSpan({ cls: 'flomo-sync-icon' });
    setIcon(iconEl, this.iconName());

    if (this.currentStatus === 'syncing' && this.currentStats) {
      container.createSpan({ cls: 'flomo-sync-count', text: String(this.processedCount) });
      const statsEl = container.createSpan({ cls: 'flomo-sync-stats' });
      if (this.currentStats.created > 0) statsEl.createSpan({ cls: 'stat-created', text: `+${this.currentStats.created}` });
      if (this.currentStats.updated > 0) statsEl.createSpan({ cls: 'stat-updated', text: `~${this.currentStats.updated}` });
      if (this.currentStats.skipped > 0) statsEl.createSpan({ cls: 'stat-skipped', text: `·${this.currentStats.skipped}` });
    } else if (this.currentStatus === 'syncing') {
      container.createSpan({ cls: 'flomo-sync-text', text: `Get ⟳ ${this.processedCount}` });
    } else {
      container.createSpan({ cls: 'flomo-sync-text', text: this.statusText });
    }
  }

  private iconName(): string {
    switch (this.currentStatus) {
      case 'syncing': return 'loader';
      case 'success': return 'check-circle';
      case 'error':   return 'alert-circle';
      default:        return 'cloud';
    }
  }

  private buildTooltip(): string {
    const stats = this.plugin.settings.lastSyncStats;
    switch (this.currentStatus) {
      case 'idle':
        return stats
          ? `上次同步: ${new Date(stats.timestamp).toLocaleString('zh-CN')}\n+${stats.created} ~${stats.updated} ·${stats.skipped} ✗${stats.failed}`
          : '点击立即同步';
      case 'syncing':
        return this.currentStats
          ? `同步中: ${this.processedCount} 条\n+${this.currentStats.created} ~${this.currentStats.updated} ·${this.currentStats.skipped}`
          : '同步中...';
      case 'error':
        return this.lastError ? `同步失败: ${this.lastError.message}` : '同步失败';
      case 'success':
        return '同步完成\n点击再次同步';
    }
  }

  private showContextMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item => item.setTitle('立即同步').setIcon('sync').onClick(() => void this.plugin.performSync()));
    menu.addItem(item => item.setTitle('全量同步').setIcon('refresh-cw').onClick(() => void this.plugin.performFullSync()));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('打开设置').setIcon('settings').onClick(() => this.plugin.openSettings()));
    menu.showAtMouseEvent(e);
  }

  unload(): void {
    this.tooltipManager.hide();
    this.el.remove();
  }
}
