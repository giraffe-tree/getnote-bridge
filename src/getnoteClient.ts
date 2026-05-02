import { requestUrl } from 'obsidian';
import type { GetNote, GetNoteDetail, QuotaInfo, QuotaBucket } from './types';

const BASE_URL = 'https://openapi.biji.com';

export class GetNoteApiError extends Error {
  constructor(
    message: string,
    public code?: number,
    public status?: number,
    public rateLimited?: boolean
  ) {
    super(message);
    this.name = 'GetNoteApiError';
  }
}

/** JSON 解析前将 int64 ID 字段转为字符串，防止精度丢失 */
function safeParseJson(text: string): unknown {
  const safe = text.replace(
    /"(id|note_id|parent_id)"\s*:\s*(\d+)/g,
    '"$1":"$2"'
  );
  return JSON.parse(safe);
}

/** 兼容多种返回结构，从 data 中解析出读/写的日/月配额 */
function parseQuota(data: Record<string, unknown>): QuotaInfo {
  // 优先支持 data.rate_limit.{read,write}.{daily,monthly}，
  // 也兼容直接 data.{read,write}.{daily,monthly} 的扁平形式
  const root = (data.rate_limit && typeof data.rate_limit === 'object'
    ? data.rate_limit
    : data) as Record<string, unknown>;

  const pickBucket = (b: unknown): QuotaBucket | undefined => {
    if (!b || typeof b !== 'object') return undefined;
    const r = b as { limit?: number; used?: number; remaining?: number; reset_at?: number };
    if (typeof r.remaining !== 'number' && typeof r.limit !== 'number') return undefined;
    return {
      limit: r.limit ?? 0,
      used: r.used ?? 0,
      remaining: r.remaining ?? 0,
      resetAt: r.reset_at ?? 0,
    };
  };

  const pickGroup = (g: unknown): { daily?: QuotaBucket; monthly?: QuotaBucket } | undefined => {
    if (!g || typeof g !== 'object') return undefined;
    const obj = g as Record<string, unknown>;
    return { daily: pickBucket(obj.daily), monthly: pickBucket(obj.monthly) };
  };

  return { read: pickGroup(root.read), write: pickGroup(root.write) };
}

export class GetNoteClient {
  private apiKey: string;
  private clientId: string;

  constructor(apiKey: string, clientId: string) {
    this.apiKey = apiKey;
    this.clientId = clientId;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: this.apiKey,
      'X-Client-ID': this.clientId,
      'Content-Type': 'application/json',
    };
  }

  async listNotes(cursor: string): Promise<{
    notes: GetNote[];
    hasMore: boolean;
    cursor: string;
  }> {
    const cursorParam = cursor && cursor !== '0' ? encodeURIComponent(cursor) : '0';
    const url = `${BASE_URL}/open/api/v1/resource/note/list?cursor=${cursorParam}`;

    try {
      const resp = await requestUrl({ url, method: 'GET', headers: this.headers });
      const body = safeParseJson(resp.text) as {
        success: boolean;
        data: { notes: GetNote[]; has_more: boolean; cursor: string };
        error?: { code: number; message: string; reason?: string };
      };

      if (!body.success) {
        const err = body.error;
        if (resp.status === 429 || err?.code === 42900) {
          throw new GetNoteApiError(err?.message || 'rate limited', err?.code, resp.status, true);
        }
        if (err?.code === 10001) {
          throw new GetNoteApiError('凭证无效或已过期，请重新授权', err.code, 401);
        }
        throw new GetNoteApiError(err?.message || 'API 错误', err?.code, resp.status);
      }

      return {
        notes: body.data.notes || [],
        hasMore: body.data.has_more,
        cursor: body.data.cursor || '',
      };
    } catch (e) {
      if (e instanceof GetNoteApiError) throw e;
      throw new GetNoteApiError(`请求失败: ${(e as Error).message}`);
    }
  }

  /** 拉取笔记详情（录音转写、链接原文等富内容） */
  async getNoteDetail(noteId: string): Promise<GetNoteDetail> {
    const url = `${BASE_URL}/open/api/v1/resource/note/detail?id=${noteId}`;
    try {
      const resp = await requestUrl({ url, method: 'GET', headers: this.headers });
      const body = safeParseJson(resp.text) as {
        success: boolean;
        data: { note: GetNoteDetail };
        error?: { code: number; message: string };
      };

      if (!body.success) {
        throw new GetNoteApiError(body.error?.message || 'API 错误', body.error?.code, resp.status);
      }
      return body.data.note;
    } catch (e) {
      if (e instanceof GetNoteApiError) throw e;
      throw new GetNoteApiError(`请求详情失败: ${(e as Error).message}`);
    }
  }

  /** 验证凭证是否有效（拉取第一页，成功即通过） */
  async validateCredentials(): Promise<void> {
    await this.listNotes('0');
  }

  /** 查询当前配额（rate-limit/quota 接口） */
  async getQuota(): Promise<QuotaInfo> {
    const url = `${BASE_URL}/open/api/v1/resource/rate-limit/quota`;
    try {
      const resp = await requestUrl({ url, method: 'GET', headers: this.headers });
      const body = safeParseJson(resp.text) as {
        success: boolean;
        data?: Record<string, unknown>;
        error?: { code: number; message: string };
      };
      if (!body.success) {
        throw new GetNoteApiError(body.error?.message || 'API 错误', body.error?.code, resp.status);
      }
      return parseQuota(body.data ?? {});
    } catch (e) {
      if (e instanceof GetNoteApiError) throw e;
      throw new GetNoteApiError(`查询配额失败: ${(e as Error).message}`);
    }
  }

  async downloadFile(url: string): Promise<ArrayBuffer | null> {
    try {
      const resp = await requestUrl({ url, method: 'GET' });
      return resp.status === 200 ? resp.arrayBuffer : null;
    } catch {
      return null;
    }
  }
}
