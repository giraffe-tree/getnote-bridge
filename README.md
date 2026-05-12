# Get Bridge — Obsidian Plugin

将 [Get 笔记](https://biji.com)（原「Get」App）的内容同步到 Obsidian Vault。

Sync your [Get 笔记](https://biji.com) notes into Obsidian.

---

## 功能 / Features

- **增量同步**：只拉取新增和更新的笔记，速度快
- **全量同步**：从头重建，确保本地与云端一致
- **知识库同步**：支持选择个人/订阅知识库，分别按间隔自动同步
- **附件下载**：图片自动保存到本地 `attachments/` 子目录
- **自动同步**：可配置笔记同步间隔（5 分钟 ~ 1 小时）和知识库同步间隔（30 分钟 ~ 6 小时）
- **概览仪表盘**：同步状态卡片 + 最近笔记预览 + 年度热力图
- **OAuth 授权**：浏览器一键完成，无需手动填写 Token

---

- **Incremental sync** — fetches only new/updated notes
- **Full sync** — rebuilds everything from scratch
- **Knowledge base sync** — choose personal / subscribed bases, auto-sync on schedule
- **Attachment download** — images saved locally under `attachments/`
- **Auto-sync** — configurable intervals for notes (5 min–1 hr) and knowledge bases (30 min–6 hr)
- **Overview dashboard** — status cards, latest note preview, annual activity heatmap
- **OAuth login** — one-click browser auth, no manual token copy-paste

---

## 安装 / Installation

### 手动安装（Manual）

1. 前往 [Releases](https://github.com/giraffe-tree/getnote-bridge/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`
2. 将三个文件放到 Vault 的 `.obsidian/plugins/getnote-bridge/` 目录下
3. 在 Obsidian **设置 → 社区插件** 中启用 **Get Bridge**

---

1. Download `main.js`, `manifest.json`, `styles.css` from [Releases](https://github.com/giraffe-tree/getnote-bridge/releases)
2. Copy them to `<your-vault>/.obsidian/plugins/getnote-bridge/`
3. Enable **Get Bridge** in Obsidian **Settings → Community Plugins**

---

## 使用 / Usage

1. 打开 **设置 → Get Bridge → 配置** Tab
2. 点击「立即授权」，浏览器完成 OAuth 登录
3. 配置同步目标目录（默认 `GetNotes`）
4. 前往「操作」Tab，点击「开始同步」

---

1. Open **Settings → Get Bridge → 配置 (Config)** tab
2. Click **立即授权 (Authorize)** and complete OAuth in browser
3. Set target directory (default: `GetNotes`)
4. Go to **操作 (Actions)** tab and click **开始同步 (Sync Now)**

---

## 笔记格式 / Note Format

每条笔记保存为独立的 Markdown 文件，文件名格式为 `YYYY-MM-DD_<title>.md`，frontmatter 包含：

Each note is saved as a Markdown file named `YYYY-MM-DD_<title>.md` with frontmatter:

```yaml
---
title: "笔记标题"
note_type: plain_text
tags:
  - tag1
created_at: "2024-01-01 10:00:00"
updated_at: "2024-01-02 12:00:00"
---
```

---

## 开发 / Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

---

## License

MIT
