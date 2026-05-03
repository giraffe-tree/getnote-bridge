import type { GetNote, GetNoteDetail, NoteType, TopicPost } from './types';
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

/** 将笔记转换为完整 Markdown（frontmatter + 正文） */
export function noteToMarkdown(note: GetNoteDetail): string {
  return `${buildFrontmatter(note)}\n${buildBody(note)}`;
}

function buildFrontmatter(note: GetNoteDetail): string {
  const tagNames = note.tags.map(t => t.name);
  const tagsYaml = tagNames.length > 0
    ? `tags:\n${tagNames.map(t => `  - "${escapeYaml(t)}"`).join('\n')}`
    : 'tags: []';

  const topicNames = note.topics?.map(t => t.name) ?? [];
  const topicsYaml = topicNames.length > 0
    ? `topics:\n${topicNames.map(t => `  - "${escapeYaml(t)}"`).join('\n')}`
    : '';

  const lines = [
    '---',
    `note_id: "${note.note_id}"`,
    `note_type: ${note.note_type}`,
    `title: "${escapeYaml(note.title || '')}"`,
    tagsYaml,
  ];
  if (topicsYaml) lines.push(topicsYaml);
  lines.push(
    `created_at: "${note.created_at}"`,
    `updated_at: "${note.updated_at}"`,
    `source: "${note.source || ''}"`,
    '---',
  );
  return lines.join('\n');
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
  const path = urlPathBasename(url);
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : 'jpg';
}

/** 提取 Markdown 正文中的远程图片 URL（仅 http/https） */
export function extractInlineImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const url = m[1].trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** 取 URL 路径解码后的 basename（不含查询串）；无法解析时返回空串 */
function urlPathBasename(url: string): string {
  try {
    const u = new URL(url);
    const decoded = decodeURIComponent(u.pathname);
    return decoded.split('/').pop() ?? '';
  } catch {
    const noQuery = url.split('?')[0];
    try { return decodeURIComponent(noQuery.split('/').pop() ?? ''); }
    catch { return noQuery.split('/').pop() ?? ''; }
  }
}

/**
 * 基于 URL 派生稳定的附件文件名。OSS 路径中的对象名通常已含唯一哈希，
 * 直接复用可避免内容顺序变化导致重复下载。无法解析时回退到 noteId_index。
 */
export function attachmentFilenameFromUrl(url: string, fallback: string): string {
  const base = urlPathBasename(url);
  if (base && /\.[a-zA-Z0-9]{2,5}$/.test(base) && base.length <= 120) {
    return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  }
  return `${fallback}.${getExtFromUrl(url)}`;
}

export { AUDIO_NOTE_TYPES };
export type { NoteType };

// ─── 知识库帖子格式化 ────────────────────────────────────────────────────────

/** 将帖子转换为 Markdown（frontmatter + 正文） */
export function postToMarkdown(post: TopicPost): string {
  return `${buildPostFrontmatter(post)}\n${post.content || ''}`;
}

function buildPostFrontmatter(post: TopicPost): string {
  return [
    '---',
    `post_id: "${post.post_id}"`,
    `title: "${escapeYaml(post.title || '')}"`,
    `author: "${escapeYaml(post.author || '')}"`,
    `created_at: "${post.created_at}"`,
    `updated_at: "${post.updated_at}"`,
    '---',
  ].join('\n');
}

/** 生成知识库索引文件内容 */
export function topicIndexMarkdown(
  topic: { id: string; name: string; description?: string; updated_at?: string },
  resources: Array<{ resource_id: string; resource_type: string; title: string }>
): string {
  const lines: string[] = [
    '---',
    `topic_id: "${topic.id}"`,
    `name: "${escapeYaml(topic.name)}"`,
    `updated_at: "${topic.updated_at || ''}"`,
    '---',
    '',
    `# ${topic.name}`,
    '',
  ];

  if (topic.description) {
    lines.push(topic.description, '');
  }

  lines.push('## 目录', '');

  for (const res of resources) {
    const filename = res.title
      ? slugify(res.title, 30)
      : res.resource_id;
    lines.push(`- [[${filename}_${res.resource_id}|${res.title || '未命名'}]]`);
  }

  lines.push('');
  return lines.join('\n');
}
