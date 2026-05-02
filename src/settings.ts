import { PluginSettingTab, Setting, App, Notice, setIcon, normalizePath } from 'obsidian';
import type GetBridgePlugin from '../main';
import type { GetBridgeSettings, LastSyncStats, QuotaInfo } from './types';
import { AUDIO_NOTE_TYPES, type NoteType } from './types';
import { GetNoteClient, GetNoteApiError } from './getnoteClient';
import { OAuthFlow } from './oauthFlow';
import { getTooltipManager } from './tooltip';

export const DEFAULT_SETTINGS: GetBridgeSettings = {
  apiKey: '',
  clientId: '',
  keyExpiresAt: 0,
  targetDir: 'GetNotes',
  noteTypes: ['plain_text', 'img_text', 'link', ...AUDIO_NOTE_TYPES],
  downloadAttachments: true,
  syncInterval: 3600,
  debugMode: false,
  cursor: '',
  lastSyncStats: undefined,
};

interface TabDef { id: string; label: string; icon: string; }

const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  plain_text: '文字笔记',
  img_text: '图片笔记',
  link: '链接笔记',
  audio: '录音笔记',
  meeting: '会议记录',
  local_audio: '本地录音',
  internal_record: '内录',
  class_audio: '课堂录音',
  recorder_audio: '录音机',
  recorder_flash_audio: '闪记录音',
};

function formatQuotaMessage(quota: QuotaInfo): string {
  const read = quota.read;
  if (!read) return '';
  const parts: string[] = [];
  if (read.daily) parts.push(`今日剩余 ${read.daily.remaining}/${read.daily.limit}`);
  if (read.monthly) parts.push(`本月剩余 ${read.monthly.remaining}/${read.monthly.limit}`);
  if (!parts.length) return '';
  return `读取配额：${parts.join('，')}`;
}

export class GetBridgeSettingTab extends PluginSettingTab {
  plugin: GetBridgePlugin;
  private currentTab = 'overview';
  private contentContainer: HTMLElement | null = null;
  private static readonly HEATMAP_WEEKS = 53;

  private readonly tabs: TabDef[] = [
    { id: 'overview', label: '概览', icon: 'layout-dashboard' },
    { id: 'config',   label: '配置', icon: 'settings'          },
    { id: 'actions',  label: '操作', icon: 'zap'               },
  ];

  constructor(app: App, plugin: GetBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('flomo-settings-container');

    this.renderTabNav(containerEl);
    this.contentContainer = containerEl.createDiv({ cls: 'flomo-tab-content' });
    this.renderCurrentTab();
  }

  refresh(): void {
    if (!this.contentContainer) return;
    this.renderCurrentTab();
  }

  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: 'flomo-tab-nav' });
    for (const tab of this.tabs) {
      const btn = nav.createEl('button', {
        cls: `flomo-tab-button${tab.id === this.currentTab ? ' active' : ''}`,
      });
      const iconSpan = btn.createSpan({ cls: 'flomo-tab-icon' });
      setIcon(iconSpan, tab.icon);
      btn.createSpan({ text: tab.label });
      btn.addEventListener('click', () => this.switchTab(tab.id));
    }
  }

  private switchTab(tabId: string): void {
    if (tabId === this.currentTab) return;
    this.currentTab = tabId;
    const buttons = this.containerEl.querySelectorAll('.flomo-tab-button');
    buttons.forEach((btn, i) => {
      if (this.tabs[i]?.id === tabId) btn.addClass('active');
      else btn.removeClass('active');
    });
    this.renderCurrentTab();
  }

  private renderCurrentTab(): void {
    if (!this.contentContainer) return;
    this.contentContainer.empty();
    switch (this.currentTab) {
      case 'overview': this.renderOverviewTab(this.contentContainer); break;
      case 'config':   this.renderConfigTab(this.contentContainer);   break;
      case 'actions':  this.renderActionsTab(this.contentContainer);  break;
    }
  }

  // ─── Overview ────────────────────────────────────────────────────────────────

  private renderOverviewTab(container: HTMLElement): void {
    const { settings } = this.plugin;
    const lastStats = settings.lastSyncStats;

    if (!settings.apiKey) {
      const empty = container.createDiv({ cls: 'flomo-empty-state' });
      const iconEl = empty.createDiv({ cls: 'flomo-empty-state-icon' });
      setIcon(iconEl, 'cloud');
      empty.createDiv({
        cls: 'flomo-empty-state-text',
        text: '欢迎使用 Get Bridge！请先在「配置」Tab 完成授权，然后在「操作」Tab 开始同步。',
      });
      return;
    }

    // Status cards
    const statusCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(statusCard).setName('同步状态').setHeading();
    const statusGrid = statusCard.createDiv({ cls: 'flomo-status-grid' });

    // Connection
    const connCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    connCard.createDiv({ cls: 'flomo-status-card-title', text: '授权状态' });
    const connValue = connCard.createDiv({ cls: 'flomo-status-card-value' });
    const isExpired = settings.keyExpiresAt > 0 && settings.keyExpiresAt < Date.now();
    connValue.addClass(isExpired ? 'status-error' : 'status-connected');
    const connIcon = connValue.createSpan({ cls: 'status-icon' });
    setIcon(connIcon, isExpired ? 'alert-circle' : 'link');
    connValue.appendText(isExpired ? '已过期' : '已授权');

    // Sync state
    const syncCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    syncCard.createDiv({ cls: 'flomo-status-card-title', text: '同步状态' });
    const syncValue = syncCard.createDiv({ cls: 'flomo-status-card-value' });
    const isSyncing = this.plugin.isSyncing;
    const hasFailed = lastStats && lastStats.failed > 0;
    syncValue.addClass(isSyncing ? 'status-syncing' : hasFailed ? 'status-error' : 'status-connected');
    const syncIcon = syncValue.createSpan({ cls: 'status-icon' });
    setIcon(syncIcon, isSyncing ? 'loader' : hasFailed ? 'alert-circle' : 'check-circle');
    syncValue.appendText(isSyncing ? '同步中' : hasFailed ? '有错误' : '正常');

    // Local count
    const totalCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    totalCard.createDiv({ cls: 'flomo-status-card-title', text: '本地记录' });
    totalCard.createDiv({ cls: 'flomo-status-card-value', text: String(this.getLocalNoteCount()) });

    // Last sync time
    const lastSyncCard = statusGrid.createDiv({ cls: 'flomo-status-card' });
    lastSyncCard.createDiv({ cls: 'flomo-status-card-title', text: '上次同步' });
    const lastSyncText = lastStats?.timestamp
      ? this.relativeTime(Math.floor(lastStats.timestamp / 1000))
      : '从未同步';
    lastSyncCard.createDiv({ cls: 'flomo-status-card-value', text: lastSyncText });

    // Last sync stats
    if (lastStats) {
      const statsCard = container.createDiv({ cls: 'flomo-settings-card' });
      new Setting(statsCard).setName('上次同步统计').setHeading();
      const grid = statsCard.createDiv({ cls: 'flomo-stats-grid-detailed' });

      const items: Array<{ label: string; value: number; cls: string }> = [
        { label: '新增', value: lastStats.created, cls: 'created' },
        { label: '更新', value: lastStats.updated, cls: 'updated' },
        { label: '跳过', value: lastStats.skipped, cls: 'skipped' },
        { label: '失败', value: lastStats.failed,  cls: 'failed'  },
      ];
      for (const item of items) {
        const c = grid.createDiv({ cls: `flomo-stats-card ${item.cls}` });
        c.createDiv({ cls: 'flomo-stats-card-value', text: String(item.value) });
        c.createDiv({ cls: 'flomo-stats-card-label', text: item.label });
      }
      statsCard.createDiv({
        cls: 'flomo-stats-footer',
        text: `总计: ${lastStats.total} 条 | 耗时: ${lastStats.duration}秒 | ${new Date(lastStats.timestamp).toLocaleString('zh-CN')}`,
      });
    }

    this.renderHeatmap(container);
  }

  // ─── Config ──────────────────────────────────────────────────────────────────

  private renderConfigTab(container: HTMLElement): void {
    // Auth card
    const authCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(authCard).setName('授权配置').setHeading();

    const hasKey = !!this.plugin.settings.apiKey;
    const isExpired = hasKey && this.plugin.settings.keyExpiresAt > 0 && this.plugin.settings.keyExpiresAt < Date.now();

    const authSetting = new Setting(authCard)
      .setName('Get 笔记授权')
      .setDesc(hasKey
        ? isExpired
          ? '⚠️ 授权已过期，请重新授权'
          : `✅ 已授权${this.plugin.settings.keyExpiresAt > 0 ? `，有效期至 ${new Date(this.plugin.settings.keyExpiresAt).toLocaleDateString('zh-CN')}` : ''}`
        : '点击「授权」按钮，使用浏览器完成 OAuth 授权');

    authSetting.addButton(btn =>
      btn
        .setButtonText(hasKey ? (isExpired ? '重新授权' : '重新授权') : '立即授权')
        .setCta()
        .onClick(() => {
          const flow = new OAuthFlow(this.app);
          flow.launch(async (apiKey, clientId, expiresAt) => {
            this.plugin.settings.apiKey = apiKey;
            this.plugin.settings.clientId = clientId;
            this.plugin.settings.keyExpiresAt = expiresAt;
            await this.plugin.saveSettings();
            new Notice('Get 笔记授权成功！');
            this.renderCurrentTab();
          });
        })
    );

    if (hasKey) {
      authSetting.addButton(btn =>
        btn.setButtonText('验证').onClick(async () => {
          btn.setButtonText('验证中...').setDisabled(true);
          try {
            const client = new GetNoteClient(this.plugin.settings.apiKey, this.plugin.settings.clientId);
            await client.validateCredentials();

            // 验证成功：若本地误判已过期，清除过期时间避免误报
            if (this.plugin.settings.keyExpiresAt > 0 && this.plugin.settings.keyExpiresAt < Date.now()) {
              this.plugin.settings.keyExpiresAt = 0;
              await this.plugin.saveSettings();
            }
            new Notice('凭证有效 ✅');

            // 查询配额并提醒
            try {
              const quota = await client.getQuota();
              const msg = formatQuotaMessage(quota);
              if (msg) new Notice(msg, 8000);
            } catch (qe) {
              const m = qe instanceof GetNoteApiError ? qe.message : (qe as Error).message;
              new Notice(`配额查询失败: ${m}`, 5000);
            }

            this.renderCurrentTab();
          } catch (e) {
            const msg = e instanceof GetNoteApiError ? e.message : (e as Error).message;
            new Notice(`验证失败: ${msg}`, 5000);
          } finally {
            btn.setButtonText('验证').setDisabled(false);
          }
        })
      );
    }

    // Sync config card
    const syncCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(syncCard).setName('同步配置').setHeading();

    const targetDirSetting = new Setting(syncCard)
      .setName('同步目标目录')
      .setDesc('相对于 Vault 根目录的路径，Get 笔记将同步到此目录')
      .addText(text =>
        text
          .setPlaceholder('GetNotes')
          .setValue(this.plugin.settings.targetDir)
          .onChange(async value => {
            this.plugin.settings.targetDir = value.trim() || 'GetNotes';
            await this.plugin.saveSettings();
            this.updatePathDisplay(pathEl, this.plugin.settings.targetDir);
          })
      );

    const pathContainer = targetDirSetting.descEl.createDiv({ cls: 'flomo-full-path-container' });
    pathContainer.createSpan({ text: '完整路径: ', cls: 'flomo-full-path-label' });
    const pathEl = pathContainer.createSpan({ cls: 'flomo-full-path-value' });
    this.updatePathDisplay(pathEl, this.plugin.settings.targetDir);

    new Setting(syncCard)
      .setName('下载附件')
      .setDesc('是否下载图片附件到本地（推荐开启）')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.downloadAttachments)
          .onChange(async value => {
            this.plugin.settings.downloadAttachments = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(syncCard)
      .setName('自动同步间隔')
      .setDesc('设置后会按间隔自动同步')
      .addDropdown(dd =>
        dd
          .addOption('0',    '手动同步')
          .addOption('300',  '5分钟')
          .addOption('600',  '10分钟')
          .addOption('1800', '30分钟')
          .addOption('3600', '1小时')
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async value => {
            this.plugin.settings.syncInterval = parseInt(value, 10);
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          })
      );

    // Note types card
    const typeCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(typeCard).setName('同步笔记类型').setHeading();
    typeCard.createDiv({ cls: 'getnote-notetype-desc', text: '选择需要同步的笔记类型' });

    const typeGrid = typeCard.createDiv({ cls: 'getnote-notetype-grid' });
    const allTypes: NoteType[] = ['plain_text', 'img_text', 'link', ...AUDIO_NOTE_TYPES];
    for (const type of allTypes) {
      const item = typeGrid.createDiv({ cls: 'getnote-notetype-item' });
      const enabled = this.plugin.settings.noteTypes.includes(type);
      item.addClass(enabled ? 'is-enabled' : 'is-disabled');

      const label = item.createSpan({ cls: 'getnote-notetype-label', text: NOTE_TYPE_LABELS[type] });
      const toggle = item.createEl('input', { type: 'checkbox' } as never) as HTMLInputElement;
      toggle.checked = enabled;
      toggle.addEventListener('change', async () => {
        const types = new Set(this.plugin.settings.noteTypes);
        if (toggle.checked) {
          types.add(type);
          item.removeClass('is-disabled');
          item.addClass('is-enabled');
        } else {
          types.delete(type);
          item.removeClass('is-enabled');
          item.addClass('is-disabled');
        }
        this.plugin.settings.noteTypes = Array.from(types) as NoteType[];
        await this.plugin.saveSettings();
      });
      void label; // used in DOM
    }

    // Dev options
    const devCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(devCard).setName('开发者选项').setHeading();
    new Setting(devCard)
      .setName('调试模式')
      .setDesc('在控制台输出详细日志')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async value => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
          })
      );
  }

  // ─── Actions ─────────────────────────────────────────────────────────────────

  private renderActionsTab(container: HTMLElement): void {
    const syncCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(syncCard).setName('同步操作').setHeading();

    new Setting(syncCard)
      .setName('立即同步')
      .setDesc('增量同步，只获取新增和更新的笔记')
      .addButton(btn =>
        btn
          .setButtonText(this.plugin.isSyncing ? '同步中...' : '开始同步')
          .setCta()
          .setDisabled(this.plugin.isSyncing)
          .onClick(async () => {
            btn.setButtonText('同步中...').setDisabled(true);
            try { await this.plugin.performSync(); }
            finally {
              btn.setButtonText('开始同步').setDisabled(false);
              this.renderCurrentTab();
            }
          })
      );

    new Setting(syncCard)
      .setName('全量同步')
      .setDesc('从头重新同步所有笔记（会更新已有文件）')
      .addButton(btn =>
        btn
          .setButtonText(this.plugin.isSyncing ? '同步中...' : '全量同步')
          .setDisabled(this.plugin.isSyncing)
          .onClick(async () => {
            btn.setButtonText('同步中...').setDisabled(true);
            try { await this.plugin.performFullSync(); }
            finally {
              btn.setButtonText('全量同步').setDisabled(false);
              this.renderCurrentTab();
            }
          })
      );

    // Danger zone
    const dangerCard = container.createDiv({ cls: 'flomo-settings-card danger' });
    new Setting(dangerCard).setName('危险区域').setHeading();

    new Setting(dangerCard)
      .setName('重置同步游标')
      .setDesc('清除游标，下次同步将从头开始（不删除本地文件）')
      .addButton(btn =>
        btn.setButtonText('重置').setWarning().onClick(async () => {
          this.plugin.settings.cursor = '';
          await this.plugin.saveSettings();
          new Notice('游标已重置');
          this.renderCurrentTab();
        })
      );

    new Setting(dangerCard)
      .setName('清除本地数据')
      .setDesc('删除同步目录中的所有笔记文件（不可恢复）')
      .addButton(btn =>
        btn.setButtonText('清除').setWarning().onClick(async () => {
          await this.clearLocalData();
        })
      );
  }

  // ─── Heatmap ─────────────────────────────────────────────────────────────────

  private renderHeatmap(container: HTMLElement): void {
    const tooltipMgr = getTooltipManager();
    const card = container.createDiv({ cls: 'flomo-settings-card' });
    const dailyCounts = this.collectDailyCounts();
    const totalCount = this.getLocalNoteCount();
    const lastYearCount = this.calcLastYearCount(dailyCounts);

    const heading = new Setting(card).setName('记录活跃度（最近一年）').setHeading();
    const statsEl = heading.controlEl.createDiv({ cls: 'flomo-heatmap-header-stats' });
    statsEl.createSpan({ text: `最近一年: ${lastYearCount} 条`, cls: 'flomo-heatmap-stat-item' });
    statsEl.createSpan({ text: ' | ', cls: 'flomo-heatmap-stat-separator' });
    statsEl.createSpan({ text: `总计: ${totalCount} 条`, cls: 'flomo-heatmap-stat-item' });

    const heatmapEl = card.createDiv({ cls: 'flomo-heatmap-container' });
    const maxCount = Math.max(...dailyCounts.values(), 0);

    if (maxCount === 0) {
      heatmapEl.createDiv({ cls: 'flomo-heatmap-empty', text: '暂无同步数据，完成同步后会展示每日记录热力图。' });
      return;
    }

    const weeks = GetBridgeSettingTab.HEATMAP_WEEKS;
    const today = this.startOfDay(new Date());
    const currentWeekStart = this.weekStart(today);
    const startDate = new Date(currentWeekStart);
    startDate.setDate(startDate.getDate() - (weeks - 1) * 7);

    const monthsRow = heatmapEl.createDiv({ cls: 'flomo-heatmap-months' });
    const monthGrid = monthsRow.createDiv({ cls: 'flomo-heatmap-month-grid' });
    let prevMonth = -1;
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let w = 0; w < weeks; w++) {
      const ws = new Date(startDate);
      ws.setDate(startDate.getDate() + w * 7);
      const cell = monthGrid.createDiv({ cls: 'flomo-heatmap-month-cell' });
      if (ws.getMonth() !== prevMonth) cell.setText(monthNames[ws.getMonth()]);
      prevMonth = ws.getMonth();
    }

    const body = heatmapEl.createDiv({ cls: 'flomo-heatmap-body' });
    const grid = body.createDiv({ cls: 'flomo-heatmap-grid' });
    for (let w = 0; w < weeks; w++) {
      const col = grid.createDiv({ cls: 'flomo-heatmap-week' });
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + w * 7 + d);
        const key = this.dateKey(date);
        const count = dailyCounts.get(key) ?? 0;
        const level = this.heatLevel(count);
        const tip = `${key}: ${count} 条`;
        const cell = col.createDiv({ cls: `flomo-heatmap-cell flomo-heatmap-level-${level}` });
        cell.setAttr('aria-description', tip);
        cell.setAttr('tabindex', '0');
        cell.addEventListener('mouseenter', () => tooltipMgr.show(cell, tip, 100));
        cell.addEventListener('mouseleave', () => tooltipMgr.hide());
        cell.addEventListener('focus',      () => tooltipMgr.show(cell, tip, 100));
        cell.addEventListener('blur',       () => tooltipMgr.hide());
      }
    }

    const legend = heatmapEl.createDiv({ cls: 'flomo-heatmap-legend' });
    legend.createSpan({ cls: 'flomo-heatmap-legend-text', text: '少' });
    for (const l of [0,1,3,5,7,9]) legend.createDiv({ cls: `flomo-heatmap-cell flomo-heatmap-level-${l}` });
    legend.createSpan({ cls: 'flomo-heatmap-legend-text', text: '多' });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private collectDailyCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const dir = normalizePath(this.plugin.settings.targetDir);
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(dir + '/') && file.path !== dir) continue;
      if (file.path.includes('/attachments/')) continue;
      const m = file.name.match(/^(\d{4}-\d{2}-\d{2})_/);
      if (!m) continue;
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    return counts;
  }

  private getLocalNoteCount(): number {
    const dir = normalizePath(this.plugin.settings.targetDir);
    return this.app.vault.getMarkdownFiles().filter(f =>
      (f.path.startsWith(dir + '/') || f.path === dir) && !f.path.includes('/attachments/')
    ).length;
  }

  private calcLastYearCount(counts: Map<string, number>): number {
    const today = this.startOfDay(new Date());
    const yearAgo = new Date(today);
    yearAgo.setDate(yearAgo.getDate() - 365);
    let n = 0;
    for (const [key, c] of counts) {
      const d = new Date(key);
      if (d >= yearAgo && d <= today) n += c;
    }
    return n;
  }

  private updatePathDisplay(el: HTMLElement, dir: string): void {
    el.textContent = `${this.app.vault.getName()}/${dir}`;
  }

  private async clearLocalData(): Promise<void> {
    const dir = normalizePath(this.plugin.settings.targetDir);
    const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(dir + '/'));
    for (const f of files) await this.app.fileManager.trashFile(f);
    new Notice(`已清除 ${files.length} 个文件`);
  }

  private relativeTime(ts: number): string {
    const diff = Date.now() / 1000 - ts;
    if (diff < 60)     return '刚刚';
    if (diff < 3600)   return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
    return new Date(ts * 1000).toLocaleDateString('zh-CN');
  }

  private startOfDay(d: Date): Date {
    const n = new Date(d);
    n.setHours(0, 0, 0, 0);
    return n;
  }

  private weekStart(d: Date): Date {
    const s = this.startOfDay(d);
    s.setDate(s.getDate() - s.getDay());
    return s;
  }

  private dateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private heatLevel(count: number): number {
    if (count <= 0) return 0;
    const levels = [0,1,2,3,4,5,5,6,6,7,7,7,7,8,8,8,9];
    return count < levels.length ? levels[count] : 9;
  }
}
