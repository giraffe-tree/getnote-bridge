import { App, Modal, requestUrl, setIcon } from 'obsidian';

const DEVICE_CODE_URL = 'https://openapi.biji.com/open/api/v1/oauth/device/code';
const TOKEN_URL = 'https://openapi.biji.com/open/api/v1/oauth/token';
const CLIENT_ID = 'cli_a1b2c3d4e5f6789012345678abcdef90';

type OAuthState = 'requesting' | 'pending' | 'error';

export class OAuthFlow extends Modal {
  private onSuccess!: (apiKey: string, clientId: string, expiresAt: number) => Promise<void>;
  private pollIntervalId: number | null = null;
  private countdownIntervalId: number | null = null;
  private expiresAt = 0;
  private countdownEl: HTMLElement | null = null;

  constructor(app: App) {
    super(app);
  }

  launch(onSuccess: (apiKey: string, clientId: string, expiresAt: number) => Promise<void>): void {
    this.onSuccess = onSuccess;
    super.open();
  }

  onOpen(): void {
    this.renderState('requesting');
    void this.start();
  }

  onClose(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.pollIntervalId !== null) {
      window.clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.countdownIntervalId !== null) {
      window.clearInterval(this.countdownIntervalId);
      this.countdownIntervalId = null;
    }
  }

  private async start(): Promise<void> {
    try {
      const resp = await requestUrl({
        url: DEVICE_CODE_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
      });
      const body = resp.json as {
        success: boolean;
        data?: { code: string; verification_uri: string; user_code: string; expires_in: number };
      };

      if (!body.success || !body.data) {
        this.renderState('error', '获取授权码失败，请稍后重试');
        return;
      }

      const { code, verification_uri, user_code, expires_in } = body.data;
      this.expiresAt = Date.now() + expires_in * 1000;
      this.renderState('pending', undefined, verification_uri, user_code);
      this.startCountdown();
      this.startPolling(code);
    } catch (e) {
      this.renderState('error', `网络错误：${(e as Error).message}`);
    }
  }

  private startPolling(code: string): void {
    this.pollIntervalId = window.setInterval(async () => {
      if (Date.now() > this.expiresAt) {
        this.cleanup();
        this.renderState('error', '授权码已过期，请重新发起');
        return;
      }

      try {
        const resp = await requestUrl({
          url: TOKEN_URL,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'device_code', client_id: CLIENT_ID, code }),
        });

        const body = resp.json as {
          success?: boolean;
          data?: { msg?: string; api_key?: string; client_id?: string; expires_at?: number };
        };
        const data = body.data ?? {};

        if (data.api_key) {
          this.cleanup();
          await this.onSuccess(data.api_key, data.client_id ?? CLIENT_ID, data.expires_at ? data.expires_at * 1000 : 0);
          this.close();
          return;
        }

        if (data.msg === 'rejected') {
          this.cleanup();
          this.renderState('error', '用户已拒绝授权');
        } else if (data.msg === 'expired_token') {
          this.cleanup();
          this.renderState('error', '授权码已过期，请重新发起');
        } else if (data.msg === 'already_consumed') {
          this.cleanup();
          this.renderState('error', '授权码已被使用，可能已配置成功，请关闭弹窗');
        }
        // authorization_pending: 继续轮询
      } catch { /* 网络抖动，继续 */ }
    }, 5000);
  }

  private startCountdown(): void {
    this.countdownIntervalId = window.setInterval(() => {
      if (!this.countdownEl) return;
      const remaining = Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      this.countdownEl.textContent = `${m}分${String(s).padStart(2, '0')}秒后过期`;
      if (remaining === 0) {
        window.clearInterval(this.countdownIntervalId!);
        this.countdownIntervalId = null;
      }
    }, 1000);
  }

  private renderState(state: OAuthState, errorMsg?: string, verificationUri?: string, userCode?: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('getnote-auth-modal');

    const header = contentEl.createDiv({ cls: 'getnote-auth-header' });
    const iconEl = header.createSpan({ cls: 'getnote-auth-icon' });
    setIcon(iconEl, 'key');
    header.createEl('h2', { text: 'Get 笔记授权', cls: 'getnote-auth-title' });

    if (state === 'requesting') {
      contentEl.createDiv({ cls: 'getnote-auth-loading', text: '正在获取授权码...' });
      return;
    }

    if (state === 'error') {
      const errEl = contentEl.createDiv({ cls: 'getnote-auth-error' });
      const errIcon = errEl.createSpan({ cls: 'getnote-auth-error-icon' });
      setIcon(errIcon, 'alert-circle');
      errEl.createSpan({ text: errorMsg ?? '授权失败' });
      contentEl.createEl('button', { text: '关闭', cls: 'mod-cta getnote-auth-btn' })
        .addEventListener('click', () => this.close());
      return;
    }

    // pending state
    if (!verificationUri || !userCode) return;

    contentEl.createDiv({ cls: 'getnote-auth-desc', text: '请用浏览器打开以下链接完成授权：' });

    const linkEl = contentEl.createEl('a', {
      cls: 'getnote-auth-link',
      text: verificationUri,
      href: verificationUri,
    });
    linkEl.addEventListener('click', e => {
      e.preventDefault();
      window.open(verificationUri);
    });

    const codeSection = contentEl.createDiv({ cls: 'getnote-auth-code-section' });
    codeSection.createDiv({ cls: 'getnote-auth-code-label', text: '确认码' });
    codeSection.createDiv({ cls: 'getnote-user-code', text: userCode });
    codeSection.createDiv({ cls: 'getnote-auth-code-hint', text: '⚠️ 授权页面会显示此确认码，请核对一致后授权' });

    contentEl.createDiv({ cls: 'getnote-auth-status', text: '⏳ 等待授权中...' });
    this.countdownEl = contentEl.createDiv({ cls: 'getnote-countdown' });

    contentEl.createEl('button', { text: '取消', cls: 'getnote-auth-btn' })
      .addEventListener('click', () => this.close());
  }
}
