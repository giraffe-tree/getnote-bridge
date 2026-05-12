import { PluginSettingTab, Setting, App, Notice, setIcon, normalizePath, ButtonComponent, TFolder, TFile } from 'obsidian';
import type GetBridgePlugin from '../main';
import type { GetBridgeSettings, LastSyncStats, NoteType, QuotaInfo } from './types';
import { AUDIO_NOTE_TYPES } from './types';
import { GetNoteClient, GetNoteApiError } from './getnoteClient';
import { OAuthFlow } from './oauthFlow';
import { getTooltipManager } from './tooltip';

interface LatestNoteInfo {
  title: string;
  noteType: NoteType | '';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  preview: string;
}

export const DEFAULT_SETTINGS: GetBridgeSettings = {
  apiKey: '',
  clientId: '',
  keyExpiresAt: 0,
  targetDir: 'GetNotes',
  noteTypes: ['plain_text', 'img_text', 'link', 'audio', 'meeting', 'local_audio', 'internal_record', 'class_audio', 'recorder_audio', 'recorder_flash_audio'],
  downloadAttachments: true,
  syncInterval: 300,
  debugMode: false,
  cursor: '',
  lastSyncStats: undefined,
  knowledgeBaseDir: 'GetNotes/KnowledgeBase',
  selectedTopicIds: [],
  selectedSubscribedTopicIds: [],
  topicSyncInterval: 3600,
};

interface TabDef { id: string; label: string; icon: string; }

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

    // Latest update details (sync time + latest local note preview)
    this.renderLatestUpdateCard(container, lastStats);

    this.renderHeatmap(container);
  }

  // ─── Latest update card ──────────────────────────────────────────────────────

  private renderLatestUpdateCard(container: HTMLElement, lastStats: LastSyncStats | undefined): void {
    const card = container.createDiv({ cls: 'flomo-settings-card flomo-latest-card' });
    new Setting(card).setName('最近更新详情').setHeading();

    // Sync time row
    const timeRow = card.createDiv({ cls: 'flomo-latest-sync' });
    const iconWrap = timeRow.createSpan({ cls: 'flomo-latest-sync-icon' });
    setIcon(iconWrap, 'refresh-cw');
    const textWrap = timeRow.createDiv({ cls: 'flomo-latest-sync-text' });
    textWrap.createSpan({ cls: 'flomo-latest-sync-label', text: '同步时间' });
    if (lastStats?.timestamp) {
      const ts = lastStats.timestamp;
      textWrap.createSpan({
        cls: 'flomo-latest-sync-value',
        text: this.relativeTime(Math.floor(ts / 1000)),
      });
      textWrap.createSpan({
        cls: 'flomo-latest-sync-meta',
        text: new Date(ts).toLocaleString('zh-CN'),
      });
    } else {
      textWrap.createSpan({ cls: 'flomo-latest-sync-value', text: '从未同步' });
    }

    // Latest note slot (rendered async)
    const noteSlot = card.createDiv({ cls: 'flomo-latest-note-slot' });
    const placeholder = noteSlot.createDiv({ cls: 'flomo-latest-note-empty', text: '加载中…' });

    const file = this.findLatestNoteFile();
    if (!file) {
      placeholder.setText('暂无本地笔记');
      return;
    }

    void this.fillLatestNote(noteSlot, file);
  }

  private async fillLatestNote(slot: HTMLElement, file: TFile): Promise<void> {
    let content: string;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch {
      slot.empty();
      slot.createDiv({ cls: 'flomo-latest-note-empty', text: '读取笔记失败' });
      return;
    }
    // 容器可能已被 renderCurrentTab 替换，渲染前先确认还挂在文档中
    if (!slot.isConnected) return;

    const info = this.parseLatestNoteInfo(content);
    slot.empty();
    this.renderLatestNoteCard(slot, file, info);
  }

  private renderLatestNoteCard(slot: HTMLElement, file: TFile, info: LatestNoteInfo): void {
    const note = slot.createDiv({ cls: 'flomo-latest-note' });
    note.setAttr('role', 'link');
    note.setAttr('tabindex', '0');
    note.setAttr('aria-label', `打开笔记 ${info.title || file.basename}`);

    const open = () => this.app.workspace.openLinkText(file.path, '', false);
    note.addEventListener('click', open);
    note.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(); }
    });

    // Header: type icon + title
    const header = note.createDiv({ cls: 'flomo-latest-note-header' });
    const typeIcon = header.createSpan({ cls: 'flomo-latest-note-type-icon' });
    setIcon(typeIcon, this.noteTypeIcon(info.noteType));
    header.createDiv({
      cls: 'flomo-latest-note-title',
      text: info.title || file.basename,
    });

    // Meta row: type label · tags · time
    const meta = note.createDiv({ cls: 'flomo-latest-note-meta' });
    const typeLabel = this.noteTypeLabel(info.noteType);
    if (typeLabel) {
      meta.createSpan({ cls: 'flomo-latest-note-type', text: typeLabel });
    }
    if (info.tags.length) {
      const tagWrap = meta.createSpan({ cls: 'flomo-latest-note-tags' });
      for (const t of info.tags.slice(0, 5)) {
        tagWrap.createSpan({ cls: 'flomo-latest-note-tag', text: `#${t}` });
      }
      if (info.tags.length > 5) {
        tagWrap.createSpan({ cls: 'flomo-latest-note-tag-more', text: `+${info.tags.length - 5}` });
      }
    }
    const timeText = info.createdAt || info.updatedAt;
    if (timeText) {
      meta.createSpan({ cls: 'flomo-latest-note-time', text: this.shortNoteTime(timeText) });
    }

    // Preview body
    if (info.preview) {
      note.createDiv({ cls: 'flomo-latest-note-preview', text: info.preview });
    } else {
      note.createDiv({ cls: 'flomo-latest-note-preview empty', text: '（无正文预览）' });
    }

    // Footer hint
    const footer = note.createDiv({ cls: 'flomo-latest-note-footer' });
    const arrow = footer.createSpan({ cls: 'flomo-latest-note-arrow' });
    setIcon(arrow, 'arrow-right');
    footer.createSpan({ text: '点击打开' });
  }

  private findLatestNoteFile(): TFile | null {
    const dir = normalizePath(this.plugin.settings.targetDir);
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      (f.path.startsWith(dir + '/') || f.path === dir) && !f.path.includes('/attachments/')
    );
    if (!files.length) return null;
    let latest = files[0];
    for (const f of files) if (f.stat.mtime > latest.stat.mtime) latest = f;
    return latest;
  }

  private parseLatestNoteInfo(content: string): LatestNoteInfo {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    const fm = fmMatch ? fmMatch[1] : '';
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    return {
      title: this.fmString(fm, 'title'),
      noteType: this.fmString(fm, 'note_type') as NoteType | '',
      tags: this.fmList(fm, 'tags'),
      createdAt: this.fmString(fm, 'created_at'),
      updatedAt: this.fmString(fm, 'updated_at'),
      preview: this.makePreview(body, 160),
    };
  }

  private fmString(fm: string, key: string): string {
    const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
    return m ? m[1].trim() : '';
  }

  private fmList(fm: string, key: string): string[] {
    const re = new RegExp(`^${key}:\\s*((?:\\[[^\\]]*\\])?)\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, 'm');
    const m = fm.match(re);
    if (!m) return [];
    if (m[1].trim() === '[]') return [];
    return (m[2] || '')
      .split('\n')
      .map(l => l.replace(/^\s+-\s+/, '').trim())
      .map(s => s.replace(/^"|"$/g, ''))
      .filter(Boolean);
  }

  private makePreview(body: string, maxLen: number): string {
    const text = body
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
      .replace(/^#{1,6}\s+/gm, '')             // heading marks
      .replace(/^\s*>\s?/gm, '')                // blockquote marks
      .replace(/^\s*-{3,}\s*$/gm, '')          // hr
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  }

  private shortNoteTime(s: string): string {
    // s 形如 "YYYY-MM-DD HH:MM:SS"，只展示前 16 位（精确到分钟）
    return s.length >= 16 ? s.slice(0, 16) : s;
  }

  private noteTypeIcon(type: string): string {
    if (AUDIO_NOTE_TYPES.includes(type as NoteType)) return 'mic';
    switch (type) {
      case 'link':     return 'link';
      case 'img_text': return 'image';
      case 'plain_text': return 'file-text';
      default:         return 'file-text';
    }
  }

  private noteTypeLabel(type: string): string {
    switch (type) {
      case 'plain_text':         return '文本';
      case 'img_text':           return '图文';
      case 'link':               return '链接';
      case 'audio':              return '录音';
      case 'meeting':            return '会议';
      case 'local_audio':        return '本地音频';
      case 'internal_record':    return '内录';
      case 'class_audio':        return '课堂录音';
      case 'recorder_audio':     return '录音笔';
      case 'recorder_flash_audio': return '录音笔闪存';
      default:                   return '';
    }
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
        btn.setButtonText('查看 Key').onClick(() => {
          console.log('[Get Bridge] API Key:', this.plugin.settings.apiKey);
          console.log('[Get Bridge] Client ID:', this.plugin.settings.clientId);
          new Notice('API Key 已打印到控制台，按 Cmd+Opt+I 打开开发者工具查看');
        })
      );

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

    // Knowledge base config card
    const kbCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(kbCard).setName('知识库同步').setHeading();

    const kbDirSetting = new Setting(kbCard)
      .setName('知识库存储目录')
      .setDesc('相对于 Vault 根目录的路径，知识库内容将同步到此目录下的子文件夹中')
      .addText(text =>
        text
          .setPlaceholder('GetNotes/KnowledgeBase')
          .setValue(this.plugin.settings.knowledgeBaseDir)
          .onChange(async value => {
            this.plugin.settings.knowledgeBaseDir = value.trim() || 'GetNotes/KnowledgeBase';
            await this.plugin.saveSettings();
            this.updatePathDisplay(kbPathEl, this.plugin.settings.knowledgeBaseDir);
          })
      );

    const kbPathContainer = kbDirSetting.descEl.createDiv({ cls: 'flomo-full-path-container' });
    kbPathContainer.createSpan({ text: '完整路径: ', cls: 'flomo-full-path-label' });
    const kbPathEl = kbPathContainer.createSpan({ cls: 'flomo-full-path-value' });
    this.updatePathDisplay(kbPathEl, this.plugin.settings.knowledgeBaseDir);

    new Setting(kbCard)
      .setName('自动同步间隔')
      .setDesc('设置后会按间隔自动同步选中的知识库')
      .addDropdown(dd =>
        dd
          .addOption('0',     '手动同步')
          .addOption('1800',  '30分钟')
          .addOption('3600',  '1小时')
          .addOption('7200',  '2小时')
          .addOption('21600', '6小时')
          .setValue(String(this.plugin.settings.topicSyncInterval))
          .onChange(async value => {
            this.plugin.settings.topicSyncInterval = parseInt(value, 10);
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          })
      );

    // 个人知识库选择
    const personalTopicSetting = new Setting(kbCard)
      .setName('选择要同步的个人知识库')
      .setDesc('勾选需要同步的知识库，取消勾选则跳过');

    const topicListContainer = kbCard.createDiv({ cls: 'flomo-settings-card topic-list-container' });
    topicListContainer.style.display = 'none';

    let topicList: Array<{ id: string; name: string }> = [];

    const renderTopicList = () => {
      topicListContainer.empty();
      if (topicList.length === 0) {
        topicListContainer.createDiv({ text: '暂无个人知识库', cls: 'topic-list-empty' });
        return;
      }

      for (const topic of topicList) {
        const isSelected = this.plugin.settings.selectedTopicIds.includes(topic.id);
        const row = topicListContainer.createDiv({ cls: 'topic-list-row' });

        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.checked = isSelected;
        checkbox.addEventListener('change', async () => {
          if (checkbox.checked) {
            if (!this.plugin.settings.selectedTopicIds.includes(topic.id)) {
              this.plugin.settings.selectedTopicIds.push(topic.id);
            }
          } else {
            this.plugin.settings.selectedTopicIds = this.plugin.settings.selectedTopicIds.filter(id => id !== topic.id);
          }
          await this.plugin.saveSettings();
        });

        row.createSpan({ text: topic.name, cls: 'topic-list-name' });
      }
    };

    const loadTopicList = async (btn?: ButtonComponent) => {
      if (btn) { btn.setButtonText('加载中...').setDisabled(true); }
      try {
        const client = new GetNoteClient(this.plugin.settings.apiKey, this.plugin.settings.clientId);
        topicList = await client.listTopics();
        topicListContainer.style.display = 'block';
        renderTopicList();
      } catch (e) {
        const msg = e instanceof GetNoteApiError ? e.message : (e as Error).message;
        new Notice(`获取知识库列表失败: ${msg}`, 5000);
      } finally {
        if (btn) { btn.setButtonText('获取列表').setDisabled(false); }
      }
    };

    personalTopicSetting.addButton(btn => {
      btn.setButtonText('获取列表').onClick(() => loadTopicList(btn));
    });

    personalTopicSetting.addButton(btn => {
      btn.setButtonText('同步数据').onClick(async () => {
        btn.setButtonText('同步中...').setDisabled(true);
        try { await this.plugin.performTopicSync('personal'); }
        finally {
          btn.setButtonText('同步数据').setDisabled(false);
          this.renderCurrentTab();
        }
      });
    });

    // 订阅知识库列表
    const subscribedTopicSetting = new Setting(kbCard)
      .setName('选择要同步的订阅知识库')
      .setDesc('勾选需要同步的订阅知识库，取消勾选则跳过');

    const subscribedTopicListContainer = kbCard.createDiv({ cls: 'flomo-settings-card topic-list-container' });
    subscribedTopicListContainer.style.display = 'none';

    let subscribedTopicList: Array<{ id: string; name: string }> = [];

    const renderSubscribedTopicList = () => {
      subscribedTopicListContainer.empty();
      if (subscribedTopicList.length === 0) {
        subscribedTopicListContainer.createDiv({ text: '暂无订阅知识库', cls: 'topic-list-empty' });
        return;
      }

      for (const topic of subscribedTopicList) {
        const isSelected = this.plugin.settings.selectedSubscribedTopicIds.includes(topic.id);
        const row = subscribedTopicListContainer.createDiv({ cls: 'topic-list-row' });

        const checkbox = row.createEl('input', { type: 'checkbox' });
        checkbox.checked = isSelected;
        checkbox.addEventListener('change', async () => {
          if (checkbox.checked) {
            if (!this.plugin.settings.selectedSubscribedTopicIds.includes(topic.id)) {
              this.plugin.settings.selectedSubscribedTopicIds.push(topic.id);
            }
          } else {
            this.plugin.settings.selectedSubscribedTopicIds = this.plugin.settings.selectedSubscribedTopicIds.filter(id => id !== topic.id);
          }
          await this.plugin.saveSettings();
        });

        row.createSpan({ text: topic.name, cls: 'topic-list-name' });
      }
    };

    const loadSubscribedTopicList = async (btn?: ButtonComponent) => {
      if (btn) { btn.setButtonText('加载中...').setDisabled(true); }
      try {
        const client = new GetNoteClient(this.plugin.settings.apiKey, this.plugin.settings.clientId);
        subscribedTopicList = await client.listSubscribedTopics();
        subscribedTopicListContainer.style.display = 'block';
        renderSubscribedTopicList();
      } catch (e) {
        const msg = e instanceof GetNoteApiError ? e.message : (e as Error).message;
        new Notice(`获取订阅知识库列表失败: ${msg}`, 5000);
      } finally {
        if (btn) { btn.setButtonText('获取列表').setDisabled(false); }
      }
    };

    subscribedTopicSetting.addButton(btn => {
      btn.setButtonText('获取列表').onClick(() => loadSubscribedTopicList(btn));
    });

    subscribedTopicSetting.addButton(btn => {
      btn.setButtonText('同步数据').onClick(async () => {
        btn.setButtonText('同步中...').setDisabled(true);
        try { await this.plugin.performTopicSync('subscribed'); }
        finally {
          btn.setButtonText('同步数据').setDisabled(false);
          this.renderCurrentTab();
        }
      });
    });

    // 进入配置界面时自动获取列表（已授权）
    if (this.plugin.settings.apiKey) {
      topicListContainer.style.display = 'block';
      void loadTopicList();
      void loadSubscribedTopicList();
    } else if (this.plugin.settings.selectedTopicIds.length > 0 || this.plugin.settings.selectedSubscribedTopicIds.length > 0) {
      topicListContainer.style.display = 'block';
      void loadTopicList();
      void loadSubscribedTopicList();
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

    // Knowledge base sync card
    const kbSyncCard = container.createDiv({ cls: 'flomo-settings-card' });
    new Setting(kbSyncCard).setName('知识库同步').setHeading();

    const personalCount = this.plugin.settings.selectedTopicIds.length;
    const subscribedCount = this.plugin.settings.selectedSubscribedTopicIds.length;
    const totalCount = personalCount + subscribedCount;
    const desc = totalCount > 0
      ? `已选择 ${personalCount} 个个人知识库 + ${subscribedCount} 个订阅知识库，将同步到 ${this.plugin.settings.knowledgeBaseDir}/`
      : '请先在「配置」Tab 中选择要同步的知识库';

    new Setting(kbSyncCard)
      .setName('同步选中的知识库')
      .setDesc(desc)
      .addButton(btn =>
        btn
          .setButtonText(this.plugin.isSyncing ? '同步中...' : '同步知识库')
          .setCta()
          .setDisabled(this.plugin.isSyncing || totalCount === 0)
          .onClick(async () => {
            btn.setButtonText('同步中...').setDisabled(true);
            try {
              await this.plugin.performTopicSync();
            } finally {
              btn.setButtonText('同步知识库').setDisabled(false);
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
