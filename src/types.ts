export type NoteType =
  | 'plain_text'
  | 'img_text'
  | 'link'
  | 'audio'
  | 'meeting'
  | 'local_audio'
  | 'internal_record'
  | 'class_audio'
  | 'recorder_audio'
  | 'recorder_flash_audio';

export const AUDIO_NOTE_TYPES: NoteType[] = [
  'audio', 'meeting', 'local_audio', 'internal_record',
  'class_audio', 'recorder_audio', 'recorder_flash_audio',
];

export interface NoteTag {
  id: string;
  name: string;
  type: 'ai' | 'manual' | 'system';
}

export interface NoteTopic {
  id: string;
  name: string;
}

export interface NoteAttachment {
  type: 'image' | 'audio' | 'link' | 'pdf';
  url: string;
  original_url?: string;
  title?: string;
  size?: number;
  duration?: number;
}

/** 列表接口返回的笔记（精简字段，int64 已字符串化） */
export interface GetNote {
  note_id: string;
  title: string;
  content: string;
  note_type: NoteType;
  source: string;
  tags: NoteTag[];
  topics: NoteTopic[];
  is_child_note: boolean;
  children_count: number;
  parent_id: string;
  created_at: string;  // "YYYY-MM-DD HH:MM:SS"
  updated_at: string;
}

/** 详情接口额外字段 */
export interface GetNoteDetail extends GetNote {
  audio?: {
    transcript: string;
    original: string;
    play_url: string;
    duration: number;  // 秒
  };
  web_page?: {
    url: string;
    excerpt: string;
    content: string;
  };
  attachments: NoteAttachment[];
  children_ids: string[];
}

export interface GetBridgeSettings {
  apiKey: string;
  clientId: string;
  keyExpiresAt: number;        // Unix 秒
  targetDir: string;
  noteTypes: NoteType[];
  downloadAttachments: boolean;
  syncInterval: number;        // 秒，0=手动
  debugMode: boolean;
  cursor: string;              // 翻页游标，空串=首次
  lastSyncStats?: LastSyncStats;
  // 知识库同步配置
  knowledgeBaseDir: string;     // 知识库存储目录，默认 GetNotes/KnowledgeBase
  selectedTopicIds: string[];   // 用户选择同步的个人知识库 ID 列表
  selectedSubscribedTopicIds: string[]; // 用户选择同步的订阅知识库 ID 列表
}

export interface LastSyncStats {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  duration: number;   // 秒
  timestamp: number;  // Date.now()
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success';

export interface ErrorDetails {
  message: string;
  code?: number;
  status?: number;
  timestamp: number;
}

export interface SyncProgress {
  status: 'fetching' | 'processing' | 'completed' | 'error';
  message?: string;
  processedCount?: number;
  stats?: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  error?: Error;
}

export interface QuotaBucket {
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;  // Unix 秒
}

export interface QuotaInfo {
  read?: { daily?: QuotaBucket; monthly?: QuotaBucket };
  write?: { daily?: QuotaBucket; monthly?: QuotaBucket };
}

// ─── 知识库（Topic）类型 ────────────────────────────────────────────────────

export interface KnowledgeTopic {
  id: string;
  name: string;
  description?: string;
  cover_url?: string;
  scope?: string;
  stats?: {
    note_count: number;
    file_count: number;
    live_count: number;
    blogger_count: number;
  };
  created_at: string;
  updated_at: string;
}

export interface TopicResource {
  resource_id: string;
  resource_type: 'note' | 'post' | 'link' | 'file';
  title: string;
  content?: string;
  directory_id?: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface TopicDirectory {
  id: string;
  name: string;
  parent_id?: string;
  order_index: number;
}

export interface TopicDetail extends KnowledgeTopic {
  directories: TopicDirectory[];
  resources: TopicResource[];
}

export interface TopicPost {
  post_id: string;
  title: string;
  content: string;
  excerpt?: string;
  author?: string;
  created_at: string;
  updated_at: string;
  attachments?: NoteAttachment[];
}

export interface TopicSyncStats {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
  duration: number;
  timestamp: number;
}
