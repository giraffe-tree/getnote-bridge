import type { GetNote, GetNoteDetail, NoteType } from './types';
import { AUDIO_NOTE_TYPES } from './types';

/** 需要单独拉取详情的笔记类型（列表接口不含转写/原文） */
export function needsDetail(note: GetNote): boolean {
  return AUDIO_NOTE_TYPES.includes(note.note_type) || note.note_type === 'link';
}

/**
 * 生成文件名（不含 .md）
 * 格式：{YYYY-MM-DD}_{firstTag}_{titleSlug}_{note_id}
 */
export function generateFilename(note: GetNote): string {
  const date = note.created_at.slice(0, 10);
  const parts: string[] = [date];

  const firstManualTag = note.tags.find(t => t.type === 'manual');
  if (firstManualTag) parts.push(slugify(firstManualTag.name, 10));

  if (note.title) parts.push(slugify(note.title, 20));

  parts.push(note.note_id);
  return parts.join('_');
}

/**
 * 附件本地相对路径（相对于笔记所在目录）
 * {targetDir}/{YYYY}/{MM}/attachments/{noteId}_{index}.{ext}
 * 相对于笔记（同在 {YYYY}/{MM}/ 下），引用路径为 attachments/{noteId}_{index}.{ext}
 */
export function attachmentFilename(noteId: string, index: number, ext: string): string {
  return `${noteId}_${index}.${ext}`;
}

/** 将笔记转换为完整 Markdown（frontmatter + 正文） */
export function noteToMarkdown(note: GetNoteDetail): string {
  return `${buildFrontmatter(note)}\n${buildBody(note)}`;
}

function buildFrontmatter(note: GetNoteDetail): string {
  const tagNames = note.tags.map(t => t.name);
  const tagsYaml = tagNames.length > 0
    ? `tags:\n${tagNames.map(t => `  - "${escapeYaml(t)}"`).join('\n')}`
    : 'tags: []';

  return [
    '---',
    `note_id: "${note.note_id}"`,
    `note_type: ${note.note_type}`,
    `title: "${escapeYaml(note.title || '')}"`,
    tagsYaml,
    `created_at: "${note.created_at}"`,
    `updated_at: "${note.updated_at}"`,
    `source: "${note.source || ''}"`,
    '---',
  ].join('\n');
}

function buildBody(note: GetNoteDetail): string {
  if (AUDIO_NOTE_TYPES.includes(note.note_type)) return buildAudioBody(note);
  if (note.note_type === 'link') return buildLinkBody(note);
  if (note.note_type === 'img_text') return buildImgBody(note);
  return note.content || '';
}

function buildAudioBody(note: GetNoteDetail): string {
  const parts: string[] = [];

  if (note.audio) {
    const dur = formatDuration(note.audio.duration);
    parts.push(`> 🎙️ 录音时长：${dur} | ${note.created_at} ~ ${note.updated_at}`);
    parts.push('');
  }

  if (note.content) {
    parts.push('### 智能总结', '', note.content, '');
  }

  const transcript = note.audio?.transcript || note.audio?.original;
  if (transcript) {
    parts.push('---', '', '### 转写原文', '', transcript);
  }

  return parts.join('\n');
}

function buildLinkBody(note: GetNoteDetail): string {
  const parts: string[] = [];

  if (note.web_page) {
    const { url, excerpt } = note.web_page;
    const title = note.title || url;
    parts.push(`> 🔗 [${title}](${url})`);
    if (excerpt) parts.push(`> 📝 AI 摘要：${excerpt}`);
    parts.push('');
  }

  if (note.content) parts.push(note.content);
  return parts.join('\n');
}

function buildImgBody(note: GetNoteDetail): string {
  const parts: string[] = [];
  if (note.content) { parts.push(note.content); parts.push(''); }
  // 附件 URL 占位，由 syncEngine 替换为本地路径
  for (const att of note.attachments ?? []) {
    if (att.type === 'image') parts.push(`![image](${att.url})`);
  }
  return parts.join('\n');
}

function formatDuration(seconds: number): string {
  if (!seconds) return '未知时长';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function slugify(text: string, maxLen: number): string {
  return text
    .replace(/[<>:"/\\|?*\x00-\x1f#[\]]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLen);
}

function escapeYaml(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function getExtFromUrl(url: string): string {
  const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1].toLowerCase() : 'jpg';
}

export { AUDIO_NOTE_TYPES };
export type { NoteType };
