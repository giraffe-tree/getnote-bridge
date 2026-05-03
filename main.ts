import { Plugin, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, GetBridgeSettingTab } from './src/settings';
import type { GetBridgeSettings, TopicSyncStats } from './src/types';
import { GetNoteClient, GetNoteApiError } from './src/getnoteClient';
import { SyncEngine } from './src/syncEngine';
import { TopicSyncEngine } from './src/topicSyncEngine';
import { StatusBarManager } from './src/statusBar';

export default class GetBridgePlugin extends Plugin {
  settings!: GetBridgeSettings;
  isSyncing = false;
  private statusBar!: StatusBarManager;
  private syncIntervalId: number | null = null;
  settingsTab?: GetBridgeSettingTab;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (this.settings.apiKey) {
      console.log('[Get Bridge] API Key:', this.settings.apiKey);
      console.log('[Get Bridge] Client ID:', this.settings.clientId);
    }

    this.statusBar = new StatusBarManager(this);

    this.settingsTab = new GetBridgeSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({ id: 'sync-now',  name: 'Sync now',       callback: () => void this.performSync() });
    this.addCommand({ id: 'sync-full', name: 'Full sync',       callback: () => void this.performFullSync() });
    this.addCommand({ id: 'sync-topics', name: 'Sync knowledge bases', callback: () => void this.performTopicSync() });
    this.addCommand({ id: 'settings',  name: 'Open settings',   callback: () => this.openSettings() });

    this.setupAutoSync();
    this.statusBar.setIdle(this.settings.lastSyncStats?.timestamp);
  }

  onunload(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.statusBar?.unload();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  setupAutoSync(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.settings.syncInterval > 0) {
      this.syncIntervalId = window.setInterval(() => void this.performSync(), this.settings.syncInterval * 1000);
    }
  }

  async performSync(): Promise<void> {
    if (this.isSyncing) { new Notice('同步进行中...'); return; }
    if (!this.settings.apiKey) {
      new Notice('请先在设置中完成授权', 5000);
      this.openSettings();
      return;
    }
    await this.runSync(false);
  }

  async performFullSync(): Promise<void> {
    if (this.isSyncing) { new Notice('同步进行中...'); return; }
    if (!this.settings.apiKey) {
      new Notice('请先在设置中完成授权', 5000);
      this.openSettings();
      return;
    }
    await this.runSync(true);
  }

  async performTopicSync(): Promise<void> {
    if (this.isSyncing) { new Notice('同步进行中...'); return; }
    if (!this.settings.apiKey) {
      new Notice('请先在设置中完成授权', 5000);
      this.openSettings();
      return;
    }
    if (this.settings.selectedTopicIds.length === 0) {
      new Notice('请先在设置中选择要同步的知识库', 5000);
      this.openSettings();
      return;
    }

    this.isSyncing = true;
    this.statusBar.setSyncing(0);

    try {
      const client = new GetNoteClient(this.settings.apiKey, this.settings.clientId);
      const engine = new TopicSyncEngine(client, this.settings, this.app, progress => {
        if (progress.status === 'error') {
          this.statusBar.setError(progress.message ?? '同步失败');
        } else if (progress.status === 'processing' && progress.processedCount !== undefined) {
          this.statusBar.setSyncing(progress.processedCount, progress.stats);
        }
      });

      const stats = await engine.syncTopics(
        this.settings.selectedTopicIds,
        this.settings.selectedSubscribedTopicIds
      );
      this.statusBar.setIdle(stats.timestamp);
      this.settingsTab?.refresh();

      const parts: string[] = [];
      if (stats.created) parts.push(`新增 ${stats.created}`);
      if (stats.updated) parts.push(`更新 ${stats.updated}`);
      if (stats.failed)  parts.push(`失败 ${stats.failed}`);
      if (parts.length) new Notice(`知识库同步完成：${parts.join('，')}`, 3000);

    } catch (e) {
      this.handleError(e);
    } finally {
      this.isSyncing = false;
    }
  }

  private async runSync(full: boolean): Promise<void> {
    this.isSyncing = true;
    this.statusBar.setSyncing(0);

    try {
      const client = new GetNoteClient(this.settings.apiKey, this.settings.clientId);
      const engine = new SyncEngine(client, this.settings, this.app, progress => {
        if (progress.status === 'error') {
          this.statusBar.setError(progress.message ?? '同步失败');
        } else if (progress.status === 'processing' && progress.processedCount !== undefined) {
          this.statusBar.setSyncing(progress.processedCount, progress.stats);
        }
      });

      const stats = full ? await engine.fullSync() : await engine.sync();
      this.settings.lastSyncStats = stats;
      await this.saveSettings();

      this.statusBar.setIdle(stats.timestamp);
      this.settingsTab?.refresh();

      const parts: string[] = [];
      if (stats.created) parts.push(`新增 ${stats.created}`);
      if (stats.updated) parts.push(`更新 ${stats.updated}`);
      if (stats.failed)  parts.push(`失败 ${stats.failed}`);
      if (parts.length) new Notice(`同步完成：${parts.join('，')}`, 3000);

    } catch (e) {
      this.handleError(e);
    } finally {
      this.isSyncing = false;
    }
  }

  private handleError(error: unknown): void {
    if (error instanceof GetNoteApiError) {
      if (error.status === 401 || error.code === 10001) {
        new Notice('凭证无效或已过期，请重新授权', 5000);
        this.statusBar.setError('凭证过期', { code: error.code });
      } else if (error.rateLimited) {
        new Notice('API 请求频率超限，请稍后重试', 5000);
        this.statusBar.setError('频率限制');
      } else {
        new Notice(`同步失败: ${error.message}`, 5000);
        this.statusBar.setError(error.message);
      }
    } else {
      const msg = (error as Error).message;
      new Notice(`同步失败: ${msg}`, 5000);
      this.statusBar.setError(msg);
    }
  }

  openSettings(): void {
    // @ts-expect-error internal API
    this.app.setting.open();
    // @ts-expect-error internal API
    this.app.setting.openTabById(this.manifest.id);
  }
}
