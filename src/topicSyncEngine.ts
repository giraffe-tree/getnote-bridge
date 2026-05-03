import { App, TFile, normalizePath, Notice } from 'obsidian';
import { GetNoteClient, GetNoteApiError } from './getnoteClient';
import { generateFilename, noteToMarkdown, needsDetail, attachmentFilenameFromUrl, extractInlineImageUrls } from './formatter';
import type { GetBridgeSettings, TopicSyncStats, SyncProgress, KnowledgeTopic, GetNote, GetNoteDetail } from './types';

interface TopicFileEntry {
  filePath: string;
  updated_at: string;
}

export class TopicSyncEngine {
  private client: GetNoteClient;
  private settings: GetBridgeSettings;
  private app: App;
  private onProgress?: (p: SyncProgress) => void;

  constructor(
    client: GetNoteClient,
    settings: GetBridgeSettings,
    app: App,
    onProgress?: (p: SyncProgress) => void
  ) {
    this.client = client;
    this.settings = settings;
    this.app = app;
    this.onProgress = onProgress;
  }

  async syncTopics(personalTopicIds: string[], subscribedTopicIds: string[]): Promise<TopicSyncStats> {
    const startTime = Date.now();
    const stats: TopicSyncStats = { created: 0, updated: 0, skipped: 0, failed: 0, total: 0, duration: 0, timestamp: 0 };

    const allSelectedIds = [...personalTopicIds, ...subscribedTopicIds];
    if (allSelectedIds.length === 0) {
      new Notice('请先选择要同步的知识库');
      return { ...stats, duration: 0, timestamp: Date.now() };
    }

    this.emit({ status: 'fetching', message: '正在获取知识库信息...' });

    let personalTopics: KnowledgeTopic[] = [];
    let subscribedTopics: KnowledgeTopic[] = [];
    try {
      personalTopics = await this.client.listTopics();
      if (subscribedTopicIds.length > 0) {
        subscribedTopics = await this.client.listSubscribedTopics();
      }
    } catch (e) {
      const err = e as Error;
      this.emit({ status: 'error', message: err.message, error: err });
      throw e;
    }

    const allTopics = [...personalTopics, ...subscribedTopics];
    const selectedTopics = allTopics.filter(t => allSelectedIds.includes(t.id));
    if (selectedTopics.length === 0) {
      new Notice('选中的知识库在服务端不存在，请重新获取列表');
      return { ...stats, duration: 0, timestamp: Date.now() };
    }

    // 为每个知识库建立索引：note_id -> 本地文件信息
    const topicIndices = new Map<string, Map<string, TopicFileEntry>>();
    for (const topic of selectedTopics) {
      topicIndices.set(topic.id, await this.buildTopicNoteIndex(topic.name));
    }

    this.emit({ status: 'fetching', message: '正在拉取笔记列表...' });

    // 获取所有笔记，筛选出属于选中知识库的
    let cursor = '0';
    let hasMore = true;
    let processedCount = 0;

    while (hasMore) {
      let page: { notes: GetNote[]; hasMore: boolean; cursor: string };
      try {
        page = await this.client.listNotes(cursor);
      } catch (e) {
        const err = e as Error;
        this.emit({ status: 'error', message: err.message, error: err });
        throw e;
      }

      hasMore = page.hasMore;
      cursor = page.cursor;

      for (const note of page.notes) {
        // 筛选：只处理属于选中知识库的笔记
        const noteTopicIds = note.topics?.map(t => t.id) ?? [];
        const matchingTopicIds = noteTopicIds.filter(id => allSelectedIds.includes(id));
        if (matchingTopicIds.length === 0) continue;

        stats.total++;
        processedCount++;

        try {
          const result = await this.processNoteForTopics(note, matchingTopicIds, selectedTopics, topicIndices);
          if (result === 'created') stats.created++;
          else if (result === 'updated') stats.updated++;
          else stats.skipped++;
        } catch (e) {
          if (e instanceof GetNoteApiError && e.rateLimited) {
            this.emit({ status: 'error', message: e.message, error: e });
            throw e;
          }
          stats.failed++;
        }

        this.emit({ status: 'processing', processedCount, stats: { created: stats.created, updated: stats.updated, skipped: stats.skipped, failed: stats.failed } });
      }
    }

    // 为每个知识库生成/更新索引文件
    for (const topic of selectedTopics) {
      await this.writeTopicIndex(topic, topicIndices.get(topic.id) ?? new Map());
    }

    stats.duration = Math.round((Date.now() - startTime) / 1000);
    stats.timestamp = Date.now();

    this.emit({ status: 'completed', message: this.completionMsg(stats), stats: { ...stats } });
    return stats;
  }

  private async processNoteForTopics(
    note: GetNote,
    matchingTopicIds: string[],
    allTopics: KnowledgeTopic[],
    topicIndices: Map<string, Map<string, TopicFileEntry>>
  ): Promise<'created' | 'updated' | 'skipped'> {
    // 按需拉取详情
    let detail: GetNoteDetail;
    if (needsDetail(note)) {
      try {
        detail = await this.client.getNoteDetail(note.note_id);
      } catch (e) {
        if (e instanceof GetNoteApiError && e.rateLimited) throw e;
        detail = { ...note, attachments: [], children_ids: [] };
      }
    } else {
      detail = { ...note, attachments: [], children_ids: [] };
    }

    let content = noteToMarkdown(detail);

    // 下载附件（图片）
    if (this.settings.downloadAttachments) {
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const att of (detail.attachments ?? [])) {
        if (att.type === 'image' && !seen.has(att.url)) { seen.add(att.url); urls.push(att.url); }
      }
      for (const url of extractInlineImageUrls(content)) {
        if (!seen.has(url)) { seen.add(url); urls.push(url); }
      }

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const filename = attachmentFilenameFromUrl(url, `${note.note_id}_${i}`);
        content = content.replaceAll(url, `attachments/${filename}`);
      }
    }

    // 为每个匹配的知识库写入/更新文件
    let overallResult: 'created' | 'updated' | 'skipped' = 'skipped';

    for (const topicId of matchingTopicIds) {
      const topic = allTopics.find(t => t.id === topicId);
      if (!topic) continue;

      const topicIndex = topicIndices.get(topicId)!;
      const existing = topicIndex.get(note.note_id);

      if (existing && existing.updated_at === note.updated_at) {
        continue;
      }

      const baseDir = normalizePath(`${this.settings.knowledgeBaseDir}/${this.sanitizeDirName(topic.name)}`);
      const targetFilePath = existing?.filePath
        ?? normalizePath(`${baseDir}/${generateFilename(note)}.md`);
      const targetDir = targetFilePath.substring(0, targetFilePath.lastIndexOf('/'));

      // 下载附件到知识库目录
      if (this.settings.downloadAttachments) {
        const urls: string[] = [];
        const seen = new Set<string>();
        for (const att of (detail.attachments ?? [])) {
          if (att.type === 'image' && !seen.has(att.url)) { seen.add(att.url); urls.push(att.url); }
        }
        for (const url of extractInlineImageUrls(content)) {
          if (!seen.has(url)) { seen.add(url); urls.push(url); }
        }

        const attDir = normalizePath(`${targetDir}/attachments`);
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          const filename = attachmentFilenameFromUrl(url, `${note.note_id}_${i}`);
          const absPath = normalizePath(`${attDir}/${filename}`);
          await this.downloadAttachment(url, absPath);
        }
      }

      await this.ensureDir(targetDir);

      if (existing) {
        const file = this.app.vault.getAbstractFileByPath(existing.filePath);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
          topicIndex.set(note.note_id, { filePath: existing.filePath, updated_at: note.updated_at });
          overallResult = 'updated';
          continue;
        }
      }

      await this.app.vault.create(targetFilePath, content);
      topicIndex.set(note.note_id, { filePath: targetFilePath, updated_at: note.updated_at });
      overallResult = 'created';
    }

    return overallResult;
  }

  /** 扫描知识库目录，从 frontmatter 提取 note_id 和 updated_at 建索引 */
  private async buildTopicNoteIndex(topicName: string): Promise<Map<string, TopicFileEntry>> {
    const index = new Map<string, TopicFileEntry>();
    const baseDir = normalizePath(`${this.settings.knowledgeBaseDir}/${this.sanitizeDirName(topicName)}`);

    const files = this.app.vault.getMarkdownFiles().filter(
      f => f.path.startsWith(baseDir + '/') && !f.path.includes('/attachments/') && !f.path.endsWith('/_topic.md')
    );

    const entries = await Promise.all(
      files.map(async file => {
        const match = file.name.match(/_(\d{10,})\.md$/);
        if (!match) return null;
        try {
          const content = await this.app.vault.read(file);
          const updated_at = this.extractFrontmatterField(content, 'updated_at');
          if (updated_at) return { noteId: match[1], filePath: file.path, updated_at };
        } catch { /* ignore */ }
        return null;
      })
    );

    for (const entry of entries) {
      if (entry) index.set(entry.noteId, { filePath: entry.filePath, updated_at: entry.updated_at });
    }

    return index;
  }

  private async writeTopicIndex(topic: KnowledgeTopic, index: Map<string, TopicFileEntry>): Promise<void> {
    const baseDir = normalizePath(`${this.settings.knowledgeBaseDir}/${this.sanitizeDirName(topic.name)}`);
    const indexPath = normalizePath(`${baseDir}/_topic.md`);

    const lines: string[] = [
      '---',
      `topic_id: "${topic.id}"`,
      `name: "${this.escapeYaml(topic.name)}"`,
      `updated_at: "${topic.updated_at || ''}"`,
      '---',
      '',
      `# ${topic.name}`,
      '',
    ];

    if (topic.description) {
      lines.push(topic.description, '');
    }

    const notes = Array.from(index.values());
    if (notes.length === 0) {
      lines.push('> 该知识库暂无笔记', '');
    } else {
      lines.push(`## 笔记列表（${notes.length} 条）`, '');
      for (const entry of notes) {
        const title = entry.filePath.split('/').pop()?.replace(/\.md$/, '') ?? '未命名';
        lines.push(`- [[${entry.filePath}|${title}]]`);
      }
    }

    lines.push('');
    const content = lines.join('\n');

    const existing = this.app.vault.getAbstractFileByPath(indexPath);
    if (existing instanceof TFile) {
      const existingContent = await this.app.vault.read(existing);
      if (existingContent !== content) {
        await this.app.vault.modify(existing, content);
      }
    } else {
      await this.ensureDir(baseDir);
      await this.app.vault.create(indexPath, content);
    }
  }

  private extractFrontmatterField(content: string, field: string): string | null {
    const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, 'm'));
    return m ? m[1].trim() : null;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    const parts = dirPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch { /* already exists */ }
      }
    }
  }

  private async downloadAttachment(url: string, absPath: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(absPath)) return;
    const data = await this.client.downloadFile(url);
    if (!data) return;
    const dir = absPath.split('/').slice(0, -1).join('/');
    await this.ensureDir(dir);
    await this.app.vault.createBinary(absPath, data);
  }

  private sanitizeDirName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  private escapeYaml(text: string): string {
    return text.replace(/"/g, '\\"').replace(/\n/g, ' ');
  }

  private completionMsg(stats: { created: number; updated: number; skipped: number; failed: number }): string {
    const parts: string[] = [];
    if (stats.created) parts.push(`新增 ${stats.created}`);
    if (stats.updated) parts.push(`更新 ${stats.updated}`);
    if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
    if (stats.failed) parts.push(`失败 ${stats.failed}`);
    return parts.length ? `知识库同步完成：${parts.join('，')}` : '知识库同步完成，无变化';
  }

  private emit(progress: SyncProgress): void {
    this.onProgress?.(progress);
  }
}
