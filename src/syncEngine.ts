import { App, TFile, normalizePath } from 'obsidian';
import { GetNoteClient, GetNoteApiError } from './getnoteClient';
import { generateFilename, noteToMarkdown, needsDetail, attachmentFilename, getExtFromUrl } from './formatter';
import type { GetBridgeSettings, GetNote, GetNoteDetail, LastSyncStats, SyncProgress } from './types';

interface NoteIndexEntry {
  filePath: string;
  updated_at: string;
}

export class SyncEngine {
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

  async sync(): Promise<LastSyncStats> {
    return this.run(false);
  }

  async fullSync(): Promise<LastSyncStats> {
    return this.run(true);
  }

  private async run(full: boolean): Promise<LastSyncStats> {
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, failed: 0, total: 0 };

    this.emit({ status: 'fetching', message: '正在获取笔记列表...' });

    // 将顶层目录的日期文件迁移到年/月子目录
    await this.migrateFlatFiles();

    // 构建本地索引：note_id → { filePath, updated_at }
    const noteIndex = await this.buildNoteIndex();

    let cursor = full ? '0' : (this.settings.cursor || '0');
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
        if (!this.settings.noteTypes.includes(note.note_type)) continue;

        stats.total++;
        processedCount++;

        try {
          const result = await this.processNote(note, noteIndex);
          stats[result]++;
        } catch {
          stats.failed++;
        }

        this.emit({ status: 'processing', processedCount, stats: { ...stats } });
      }

      // 每页保存 cursor，支持断点续传
      this.settings.cursor = cursor;
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const finalStats: LastSyncStats = { ...stats, duration, timestamp: Date.now() };

    this.emit({ status: 'completed', message: this.completionMsg(stats), stats: { ...stats } });
    return finalStats;
  }

  private async processNote(
    note: GetNote,
    noteIndex: Map<string, NoteIndexEntry>
  ): Promise<'created' | 'updated' | 'skipped'> {
    const existing = noteIndex.get(note.note_id);

    if (existing && existing.updated_at === note.updated_at) {
      return 'skipped';
    }

    // 按需拉取详情（录音/链接类型含额外字段）
    let detail: GetNoteDetail;
    if (needsDetail(note)) {
      try {
        detail = await this.client.getNoteDetail(note.note_id);
      } catch {
        detail = { ...note, attachments: [], children_ids: [] };
      }
    } else {
      detail = { ...note, attachments: [], children_ids: [] };
    }

    let content = noteToMarkdown(detail);

    const dir = normalizePath(this.settings.targetDir);
    const date = note.created_at.slice(0, 10);
    const [year, month] = date.split('-');

    // 新文件写入 年/月 子目录；已有文件保持原路径
    const targetFilePath = existing?.filePath
      ?? normalizePath(`${dir}/${year}/${month}/${generateFilename(note)}.md`);
    const targetDir = targetFilePath.substring(0, targetFilePath.lastIndexOf('/'));

    // 图片附件存入同级 attachments/ 目录，引用路径为 attachments/{filename}
    if (this.settings.downloadAttachments) {
      const imageAtts = (detail.attachments ?? []).filter(a => a.type === 'image');
      const attDir = normalizePath(`${targetDir}/attachments`);
      for (let i = 0; i < imageAtts.length; i++) {
        const att = imageAtts[i];
        const ext = getExtFromUrl(att.url);
        const filename = attachmentFilename(note.note_id, i, ext);
        const absPath = normalizePath(`${attDir}/${filename}`);
        await this.downloadAttachment(att.url, absPath);
        content = content.replaceAll(att.url, `attachments/${filename}`);
      }
    }

    await this.ensureDir(targetDir);

    if (existing) {
      const file = this.app.vault.getAbstractFileByPath(existing.filePath);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, content);
        noteIndex.set(note.note_id, { filePath: existing.filePath, updated_at: note.updated_at });
        return 'updated';
      }
    }

    await this.app.vault.create(targetFilePath, content);
    noteIndex.set(note.note_id, { filePath: targetFilePath, updated_at: note.updated_at });
    return 'created';
  }

  /** 将顶层目录中日期开头的笔记文件迁移到 年/月 子目录 */
  private async migrateFlatFiles(): Promise<void> {
    const dir = normalizePath(this.settings.targetDir);
    const flat = this.app.vault.getMarkdownFiles().filter(f => {
      const parent = f.path.substring(0, f.path.lastIndexOf('/'));
      return parent === dir && /^\d{4}-\d{2}-\d{2}_/.test(f.name);
    });

    if (flat.length === 0) return;

    this.emit({ status: 'fetching', message: `迁移 ${flat.length} 个文件到年/月目录...` });

    for (const file of flat) {
      const m = file.name.match(/^(\d{4})-(\d{2})/);
      if (!m) continue;
      const [, y, mo] = m;
      const subDir = normalizePath(`${dir}/${y}/${mo}`);
      await this.ensureDir(subDir);
      const newPath = normalizePath(`${subDir}/${file.name}`);
      if (!this.app.vault.getAbstractFileByPath(newPath)) {
        try { await this.app.fileManager.renameFile(file, newPath); } catch { /* skip */ }
      }
    }
  }

  /** 扫描 targetDir，从 frontmatter 提取 note_id 和 updated_at 建索引 */
  private async buildNoteIndex(): Promise<Map<string, NoteIndexEntry>> {
    const index = new Map<string, NoteIndexEntry>();
    const dir = normalizePath(this.settings.targetDir);

    const files = this.app.vault.getMarkdownFiles().filter(
      f => f.path.startsWith(dir + '/') && !f.path.includes('/attachments/')
    );

    const entries = await Promise.all(
      files.map(async file => {
        const match = file.name.match(/_(\d{10,})\.md$/);
        if (!match) return null;
        try {
          const content = await this.app.vault.read(file);
          const updated_at = this.frontmatterField(content, 'updated_at');
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

  private frontmatterField(content: string, field: string): string | null {
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

  private completionMsg(stats: { created: number; updated: number; skipped: number; failed: number }): string {
    const parts: string[] = [];
    if (stats.created) parts.push(`新增 ${stats.created}`);
    if (stats.updated) parts.push(`更新 ${stats.updated}`);
    if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
    if (stats.failed) parts.push(`失败 ${stats.failed}`);
    return parts.length ? `同步完成：${parts.join('，')}` : '同步完成，无变化';
  }

  private emit(progress: SyncProgress): void {
    this.onProgress?.(progress);
  }
}
