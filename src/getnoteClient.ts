import { requestUrl } from 'obsidian';
import type { GetNote, GetNoteDetail, QuotaInfo, QuotaBucket, KnowledgeTopic, TopicPost } from './types';

const BASE_URL = 'https://openapi.biji.com';

// ─── 客户端节流 + 限流退避 + 观测日志 ──────────────────────────────────────
// 1) 节流：连续两次请求至少间隔 500ms（≈ 2 QPS）
// 2) 退避：触发 429/10202 后按 1s/2s/4s/8s/16s/32s 重试，6 次仍败抛错
// 3) 配额耗尽（10203）不重试，立即返回让上层处理
// 4) 日志：每次请求输出到控制台，附 10s/60s 滑动窗口请求数
// ──────────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 500;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000];

let _nextSlot = 0;

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 预约下一个请求时隙：保证与上一次预约至少间隔 MIN_INTERVAL_MS */
async function _throttleSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, _nextSlot - now);
  _nextSlot = Math.max(now, _nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await _sleep(wait);
}

const _reqTimestamps: number[] = [];

function _recordRequest(): void {
  const now = Date.now();
  _reqTimestamps.push(now);
  const cutoff = now - 5 * 60_000;
  while (_reqTimestamps.length && _reqTimestamps[0] < cutoff) _reqTimestamps.shift();
}

function _reqStats(): { req10s: number; req60s: number } {
  const now = Date.now();
  let req10s = 0, req60s = 0;
  for (const t of _reqTimestamps) {
    const age = now - t;
    if (age <= 10_000) req10s++;
    if (age <= 60_000) req60s++;
  }
  return { req10s, req60s };
}

function _hms(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function _rateHeaders(h?: Record<string, string>): Record<string, string> {
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk.startsWith('x-ratelimit') || lk.startsWith('x-quota') || lk === 'retry-after') {
      out[lk] = v;
    }
  }
  return out;
}

function _logCall(
  endpoint: string,
  start: number,
  status: number,
  body: { success?: boolean; error?: { code?: number; reason?: string; message?: string; rate_limit?: unknown } } | null,
  headers?: Record<string, string>
): void {
  const { req10s, req60s } = _reqStats();
  const elapsed = Date.now() - start;
  const err = body?.error;
  const isRateLimited = status === 429 || err?.code === 10202 || err?.code === 10203;
  const isError = (body !== null && body.success === false) || status >= 400 || status === 0;
  const tag = isRateLimited ? 'RATE-LIMITED' : isError ? 'error' : 'ok';
  const fn = (isRateLimited || isError) ? console.warn : console.log;

  const errPart = err
    ? ` code=${err.code ?? '-'} reason=${err.reason ?? '-'}${err.message ? ` msg="${err.message}"` : ''}`
    : '';

  const rh = _rateHeaders(headers);
  const extras: Record<string, unknown> = {};
  if (Object.keys(rh).length) extras.headers = rh;
  if (err?.rate_limit) extras.rate_limit = err.rate_limit;

  const line = `[GetNote ${_hms()}] ${endpoint} ${tag} status=${status} ${elapsed}ms req10s=${req10s} req60s=${req60s}${errPart}`;
  if (Object.keys(extras).length) {
    fn(line, extras);
  } else {
    fn(line);
  }
}

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

/**
 * 统一请求入口：节流 + 429/10202 指数退避 + 日志。
 * - 退避全部失败时抛 GetNoteApiError(rateLimited=true)
 * - 网络/解析错误抛 GetNoteApiError，不重试
 * - 其他响应（含 10203 配额耗尽 / 业务错误）原样返回，由调用方判断
 */
async function _doRequest(
  endpoint: string,
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: any }> {
  let lastStatus = 0;
  let lastError: { code?: number; message?: string; reason?: string } | undefined;

  for (let attempt = 0; attempt <= BACKOFF_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = BACKOFF_DELAYS_MS[attempt - 1];
      console.warn(
        `[GetNote ${_hms()}] ${endpoint} 限流退避: ${delay / 1000}s 后重试 (第 ${attempt}/${BACKOFF_DELAYS_MS.length} 次)`
      );
      await _sleep(delay);
    }

    await _throttleSlot();
    _recordRequest();
    const t0 = Date.now();

    let resp: { status: number; text: string; headers: Record<string, string> };
    try {
      resp = await requestUrl({ url, method: 'GET', headers, throw: false });
    } catch (e) {
      _logCall(endpoint, t0, 0, null);
      throw new GetNoteApiError(`请求失败: ${(e as Error).message}`);
    }

    let body: any;
    try {
      body = safeParseJson(resp.text);
    } catch (e) {
      _logCall(endpoint, t0, resp.status, null, resp.headers);
      throw new GetNoteApiError(`响应解析失败: ${(e as Error).message}`, undefined, resp.status);
    }

    _logCall(endpoint, t0, resp.status, body, resp.headers);

    lastStatus = resp.status;
    lastError = body?.error;

    const code = body?.error?.code;

    // 配额耗尽（10203）：重试无用，原样返回让上层抛错
    if (code === 10203) return { status: resp.status, body };

    // QPS 限流（10202 或 HTTP 429）：进入下一轮退避
    if (code === 10202 || resp.status === 429) continue;

    return { status: resp.status, body };
  }

  const totalSec = BACKOFF_DELAYS_MS.reduce((a, b) => a + b, 0) / 1000;
  throw new GetNoteApiError(
    `请求频率超限，已退避重试 ${BACKOFF_DELAYS_MS.length} 次（累计等待 ${totalSec}s）仍失败：${lastError?.message ?? ''}`,
    lastError?.code ?? 10202,
    lastStatus || 429,
    true
  );
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

    const { status, body } = await _doRequest('list', url, this.headers);

    if (!body?.success) {
      const err = body?.error;
      if (status === 429 || err?.code === 10202 || err?.code === 10203 || err?.code === 42900) {
        throw new GetNoteApiError(err?.message || 'rate limited', err?.code, status, true);
      }
      if (err?.code === 10001) {
        throw new GetNoteApiError('凭证无效或已过期，请重新授权', err.code, 401);
      }
      throw new GetNoteApiError(err?.message || 'API 错误', err?.code, status);
    }

    return {
      notes: body.data.notes || [],
      hasMore: body.data.has_more,
      cursor: body.data.cursor || '',
    };
  }

  /** 拉取笔记详情（录音转写、链接原文等富内容） */
  async getNoteDetail(noteId: string): Promise<GetNoteDetail> {
    const url = `${BASE_URL}/open/api/v1/resource/note/detail?id=${noteId}`;

    const { status, body } = await _doRequest('detail', url, this.headers);

    if (!body?.success) {
      const err = body?.error;
      if (status === 429 || err?.code === 10202 || err?.code === 10203) {
        throw new GetNoteApiError(err?.message || 'rate limited', err?.code, status, true);
      }
      throw new GetNoteApiError(err?.message || 'API 错误', err?.code, status);
    }
    return body.data.note;
  }

  /** 验证凭证是否有效（拉取第一页，成功即通过） */
  async validateCredentials(): Promise<void> {
    await this.listNotes('0');
  }

  /** 查询当前配额（rate-limit/quota 接口） */
  async getQuota(): Promise<QuotaInfo> {
    const url = `${BASE_URL}/open/api/v1/resource/rate-limit/quota`;

    const { status, body } = await _doRequest('quota', url, this.headers);

    if (!body?.success) {
      throw new GetNoteApiError(body?.error?.message || 'API 错误', body?.error?.code, status);
    }
    return parseQuota(body.data ?? {});
  }

  async downloadFile(url: string): Promise<ArrayBuffer | null> {
    try {
      const resp = await requestUrl({ url, method: 'GET' });
      return resp.status === 200 ? resp.arrayBuffer : null;
    } catch {
      return null;
    }
  }

  // ─── 知识库（Topic）API ────────────────────────────────────────────────────

  /** 列出用户的个人知识库 */
  async listTopics(): Promise<KnowledgeTopic[]> {
    return this._fetchTopicList('topic-list', '');
  }

  /** 列出用户订阅的知识库 */
  async listSubscribedTopics(page = 1): Promise<KnowledgeTopic[]> {
    const url = `${BASE_URL}/open/api/v1/resource/knowledge/subscribe/list?page=${page}`;
    const { status, body } = await _doRequest('subscribed-topic-list', url, this.headers);

    if (!body?.success) {
      const err = body?.error;
      if (err?.code === 10001) {
        throw new GetNoteApiError('凭证无效或已过期，请重新授权', err.code, 401);
      }
      throw new GetNoteApiError(err?.message || '获取订阅知识库列表失败', err?.code, status);
    }

    const topics: KnowledgeTopic[] = [];
    const rawList = body.data?.topics ?? body.data?.list ?? body.data ?? [];
    for (const item of rawList) {
      if (!item) continue;
      topics.push({
        id: String(item.id ?? item.topic_id ?? ''),
        name: String(item.name ?? item.title ?? '未命名知识库'),
        description: item.description,
        cover_url: item.cover_url ?? item.cover,
        scope: item.scope,
        stats: item.stats,
        created_at: item.created_at ?? '',
        updated_at: item.updated_at ?? '',
      });
    }

    // 递归翻页
    if (body.data?.has_more) {
      const next = await this.listSubscribedTopics(page + 1);
      topics.push(...next);
    }

    return topics;
  }

  private async _fetchTopicList(endpoint: string, query: string): Promise<KnowledgeTopic[]> {
    const url = `${BASE_URL}/open/api/v1/resource/topic/list${query}`;
    const { status, body } = await _doRequest(endpoint, url, this.headers);

    if (!body?.success) {
      const err = body?.error;
      if (err?.code === 10001) {
        throw new GetNoteApiError('凭证无效或已过期，请重新授权', err.code, 401);
      }
      throw new GetNoteApiError(err?.message || '获取知识库列表失败', err?.code, status);
    }

    const topics: KnowledgeTopic[] = [];
    const rawList = body.data?.topics ?? body.data?.list ?? body.data ?? [];
    for (const item of rawList) {
      if (!item) continue;
      topics.push({
        id: String(item.id ?? item.topic_id ?? ''),
        name: String(item.name ?? item.title ?? '未命名知识库'),
        description: item.description,
        cover_url: item.cover_url ?? item.cover,
        scope: item.scope,
        stats: item.stats,
        created_at: item.created_at ?? '',
        updated_at: item.updated_at ?? '',
      });
    }
    return topics;
  }

  /** 获取知识库内资源列表（笔记+帖子混合） */
  async listTopicResources(topicId: string): Promise<{
    resources: Array<{
      resource_id: string;
      resource_type: string;
      title: string;
      created_at: string;
      updated_at: string;
      note_id?: string;
      post_id?: string;
    }>;
    hasMore: boolean;
    cursor: string;
  }> {
    const cursorParam = '';
    const url = `${BASE_URL}/open/api/v1/topic/resource/list?topic_id=${topicId}&cursor=${cursorParam}`;

    const { status, body } = await _doRequest('topic-resources', url, this.headers);

    if (!body?.success) {
      const err = body?.error;
      if (err?.code === 10001) {
        throw new GetNoteApiError('凭证无效或已过期，请重新授权', err.code, 401);
      }
      throw new GetNoteApiError(err?.message || '获取知识库资源失败', err?.code, status);
    }

    const rawList = body.data?.resources ?? body.data?.list ?? body.data ?? [];
    const resources = [];
    for (const item of rawList) {
      if (!item) continue;
      resources.push({
        resource_id: String(item.id ?? item.resource_id ?? ''),
        resource_type: String(item.type ?? item.resource_type ?? 'note'),
        title: String(item.title ?? ''),
        created_at: item.created_at ?? '',
        updated_at: item.updated_at ?? '',
        note_id: item.note_id ? String(item.note_id) : undefined,
        post_id: item.post_id ? String(item.post_id) : undefined,
      });
    }

    return {
      resources,
      hasMore: body.data?.has_more ?? false,
      cursor: body.data?.cursor ?? '',
    };
  }

  /** 获取帖子详情 */
  async getPostDetail(postId: string): Promise<TopicPost> {
    const url = `${BASE_URL}/open/api/v1/topic/post/detail?id=${postId}`;

    const { status, body } = await _doRequest('post-detail', url, this.headers);

    if (!body?.success) {
      const err = body?.error;
      if (err?.code === 10001) {
        throw new GetNoteApiError('凭证无效或已过期，请重新授权', err.code, 401);
      }
      throw new GetNoteApiError(err?.message || '获取帖子详情失败', err?.code, status);
    }

    const post = body.data?.post ?? body.data ?? {};
    return {
      post_id: String(post.id ?? post.post_id ?? postId),
      title: String(post.title ?? ''),
      content: String(post.content ?? post.body ?? ''),
      excerpt: post.excerpt,
      author: post.author?.name ?? post.author_name,
      created_at: post.created_at ?? '',
      updated_at: post.updated_at ?? '',
      attachments: post.attachments ?? [],
    };
  }
}
