let schemaReadyPromise;

const DEFAULT_MAIL_DOMAIN = "1239999.xyz";
const MAIL_TTL_SECONDS = 86400;
const MAX_TEXT_LENGTH = 15000;
const MAX_HTML_LENGTH = 120000;

export default {
  async email(message, env) {
    if (!env.DB) return;

    await this.ensureSchema(env);

    const to = message.to || "";
    const box = this.getBoxFromAddress(to);
    if (!box) return;

    const now = Date.now();
    const id = crypto.randomUUID();
    const raw = await new Response(message.raw).text();
    const subject = message.headers.get("subject") || "(鏃犱富棰?";

    const contentType = message.headers.get("content-type") || "";
    const boundaryMatch = contentType.match(/boundary=(?:"?)([^";\s]+)(?:"?)/i);
    const boundary = boundaryMatch ? boundaryMatch[1] : null;

    let htmlBody = "";
    let textBody = "";

    if (boundary) {
      const parts = raw.split(`--${boundary}`);
      for (const part of parts) {
        const headBodySplit = part.split(/\r?\n\r?\n/);
        if (headBodySplit.length < 2) continue;

        const header = headBodySplit[0].toLowerCase();
        let content = headBodySplit.slice(1).join("\n\n").trim();
        content = content.replace(/--\s*$/, "");

        const charset = header.match(/charset=(?:"?)([^";\s]+)/)?.[1] || "utf-8";
        const encoding = header.includes("base64")
          ? "base64"
          : (header.includes("quoted-printable") ? "qp" : "7bit");

        const decoded = this.universalDecode(content, encoding, charset);

        if (header.includes("text/html")) {
          htmlBody = decoded;
        } else if (header.includes("text/plain")) {
          textBody = decoded;
        }
      }
    }

    if (!htmlBody && !textBody) {
      const simpleSplit = raw.split(/\r?\n\r?\n/);
      textBody = simpleSplit.length > 1 ? simpleSplit.slice(1).join("\n\n") : raw;
    }

    let textContent = htmlBody || textBody;
    if (htmlBody) {
      textContent = htmlBody
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]*>/g, (tag) => (tag.match(/br|p|div|tr|li/i) ? "\n" : ""))
        .replace(/&nbsp;/g, " ")
        .replace(/\n\s*\n/g, "\n");
    }

    const sanitizedHtml = this.sanitizeHtmlEmail(htmlBody).trim().substring(0, MAX_HTML_LENGTH);
    const expiresAt = Math.floor(now / 1000) + MAIL_TTL_SECONDS;

    await env.DB.prepare(
      `INSERT INTO emails (
        id,
        box,
        sender,
        recipient,
        subject,
        content,
        html_content,
        created_at,
        created_at_ms,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        box,
        message.from || "",
        to,
        this.decodeMimeWord(subject),
        textContent.trim().substring(0, MAX_TEXT_LENGTH),
        sanitizedHtml,
        new Date(now).toISOString(),
        now,
        expiresAt
      )
      .run();

    await this.maybeCleanupExpiredEmails(env, expiresAt);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const host = this.getMailHost(env, request);

    if (!env.DB) {
      return new Response(this.getHTML({ box: "", host, missingDb: true }), {
        status: 500,
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    await this.ensureSchema(env);

    if (url.pathname === "/api/list") {
      const box = this.normalizeBox(url.searchParams.get("box") || "");
      if (!box) {
        return this.json({ box, host, emails: [], fetchedAt: new Date().toISOString() });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const { results } = await env.DB.prepare(
        `SELECT
           id,
           box,
           sender AS "from",
           recipient AS "to",
           subject,
           content,
           html_content AS "htmlContent",
           created_at AS time
         FROM emails
         WHERE box = ? AND expires_at > ?
         ORDER BY created_at_ms DESC
         LIMIT 100`
      )
        .bind(box, nowSeconds)
        .all();

      await this.maybeCleanupExpiredEmails(env, nowSeconds);

      return this.json({
        box,
        host,
        emails: results || [],
        fetchedAt: new Date().toISOString()
      });
    }

    const box = this.getBoxFromPath(url.pathname);
    return new Response(this.getHTML({ box, host, missingDb: false }), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  },

  async ensureSchema(env) {
    if (!schemaReadyPromise) {
      schemaReadyPromise = (async () => {
        await env.DB.batch([
          env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS emails (
              id TEXT PRIMARY KEY,
              box TEXT NOT NULL,
              sender TEXT NOT NULL DEFAULT '',
              recipient TEXT NOT NULL DEFAULT '',
              subject TEXT NOT NULL DEFAULT '',
              content TEXT NOT NULL DEFAULT '',
              html_content TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              created_at_ms INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            )`
          ),
          env.DB.prepare(
            "CREATE INDEX IF NOT EXISTS idx_emails_box_created ON emails(box, created_at_ms DESC)"
          ),
          env.DB.prepare(
            "CREATE INDEX IF NOT EXISTS idx_emails_expires_at ON emails(expires_at)"
          )
        ]);

        await this.ensureHtmlColumn(env);
      })().catch((error) => {
        schemaReadyPromise = undefined;
        throw error;
      });
    }

    return schemaReadyPromise;
  },

  async ensureHtmlColumn(env) {
    const tableInfo = await env.DB.prepare("PRAGMA table_info(emails)").all();
    const columns = Array.isArray(tableInfo.results) ? tableInfo.results : [];
    if (!columns.some((column) => column.name === "html_content")) {
      await env.DB.prepare("ALTER TABLE emails ADD COLUMN html_content TEXT NOT NULL DEFAULT ''").run();
    }
  },

  async maybeCleanupExpiredEmails(env, nowSeconds) {
    if (Math.random() >= 0.02) return;

    await env.DB.prepare("DELETE FROM emails WHERE expires_at <= ?")
      .bind(nowSeconds)
      .run();
  },

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json;charset=UTF-8" }
    });
  },

  universalDecode(data, encoding, charset) {
    try {
      let uint8;
      if (encoding === "base64") {
        const bin = atob(data.replace(/\s/g, ""));
        uint8 = Uint8Array.from(bin, (char) => char.charCodeAt(0));
      } else if (encoding === "qp") {
        const unescaped = data
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        uint8 = Uint8Array.from(unescaped, (char) => char.charCodeAt(0));
      } else {
        uint8 = new TextEncoder().encode(data);
      }

      const decoder = new TextDecoder(charset.toLowerCase().includes("gb") ? "gbk" : "utf-8");
      return decoder.decode(uint8);
    } catch (error) {
      return data;
    }
  },

  decodeMimeWord(str) {
    return str.replace(/=\?([^?]+)\?([QB])\?([^?]+)\?=/gi, (match, charset, encoding, data) => {
      const normalizedEncoding = encoding.toLowerCase() === "b" ? "base64" : "qp";
      return this.universalDecode(data, normalizedEncoding, charset);
    });
  },

  sanitizeHtmlEmail(html = "") {
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<base\b[^>]*>/gi, "");
  },

  normalizeBox(value = "") {
    return value.trim().replace(/[^a-z0-9_-]/gi, "").toUpperCase();
  },

  getBoxFromPath(pathname) {
    const [firstSegment = ""] = pathname.split("/").filter(Boolean);
    return this.normalizeBox(firstSegment);
  },

  getBoxFromAddress(address = "") {
    const mailbox = address.split(",")[0].trim();
    const localPart = mailbox.split("@")[0] || "";
    return this.normalizeBox(localPart);
  },

  getMailHost(env, request) {
    const configured = String(env.MAIL_DOMAIN || "").trim();
    if (configured) return configured;

    const url = new URL(request.url);
    if (url.hostname === "localhost") return DEFAULT_MAIL_DOMAIN;
    return DEFAULT_MAIL_DOMAIN;
  },

  escapeHTML(value = "") {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  getHTML({ box = "", host = "", missingDb = false }) {
    const title = box ? `${box} 临时邮箱` : "临时邮箱";
    const escapedBox = this.escapeHTML(box);
    const escapedHost = this.escapeHTML(host);
    const fullAddress = box && host ? `${escapedBox}@${escapedHost}` : "";

    let notice = "随机生成一个邮箱名，或输入你自己的邮箱名，即可进入独立收件箱。";
    if (missingDb) {
      notice = "当前还没有绑定 D1 数据库，请先完成 D1 配置后再访问。";
    } else if (box) {
      notice = "收藏本页面下次可直接打开，邮件保留 24 小时。";
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@400" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      color-scheme: light;
      --page-bg: #f7fafc;
      --surface-low: #f1f4f6;
      --surface-lowest: #ffffff;
      --surface-high: #e5e9eb;
      --surface-variant: rgba(255, 255, 255, 0.16);
      --text-main: #181c1e;
      --text-soft: #616b75;
      --text-faint: #8a94a0;
      --blue-main: #004bca;
      --blue-bright: #0061ff;
      --blue-soft: #dbe7ff;
      --chip-bg: rgba(255, 255, 255, 0.15);
      --chip-border: rgba(255, 255, 255, 0.12);
      --card-shadow: 0 24px 48px -18px rgba(0, 75, 202, 0.15);
      --hero-shadow: 0 18px 44px -26px rgba(0, 75, 202, 0.28);
    }
    body.dark {
      color-scheme: dark;
      --page-bg: #0b0e13;
      --surface-low: #242d38;
      --surface-lowest: #181f28;
      --surface-high: #2f3946;
      --surface-variant: rgba(148, 163, 184, 0.14);
      --text-main: #e8edf3;
      --text-soft: #a7b4c2;
      --text-faint: #7d8a98;
      --blue-main: #004bca;
      --blue-bright: #0061ff;
      --blue-soft: #202a38;
      --chip-bg: rgba(255, 255, 255, 0.1);
      --chip-border: rgba(255, 255, 255, 0.08);
      --card-shadow: 0 34px 90px -34px rgba(0, 0, 0, 0.72);
      --hero-shadow: 0 24px 56px -28px rgba(0, 0, 0, 0.42);
    }
    body {
      margin: 0;
      background: var(--page-bg);
      color: var(--text-main);
      font-family: "Inter", sans-serif;
      transition: background 0.3s ease, color 0.3s ease;
    }
    #appShell,
    .theme-panel,
    .theme-soft-panel,
    .theme-warm-panel,
    .theme-input,
    .theme-empty-state,
    .theme-email-card,
    .theme-email-head,
    .theme-address-link,
    .theme-note,
    .theme-primary-button,
    .theme-secondary-button,
    .theme-accent-button,
    .theme-preview-frame,
    .theme-toggle-button,
    #statusBar {
      transition: background-color 0.25s ease, color 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease, transform 0.25s ease;
    }
    .font-headline {
      font-family: "Manrope", sans-serif;
    }
    .ambient-glow {
      box-shadow: var(--card-shadow);
    }
    .glass-chip {
      background: var(--chip-bg);
      border: 1px solid rgba(0, 75, 202, 0.18);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }
    .hero-gradient {
      background: linear-gradient(145deg, var(--blue-main) 0%, var(--blue-bright) 100%);
      box-shadow: var(--hero-shadow);
    }
    body.dark .hero-gradient {
      background: #20262e;
    }
    body.dark .glass-chip {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.1);
    }
    body.dark #appShell {
      box-shadow: 0 34px 90px -34px rgba(0, 0, 0, 0.76);
    }
    #appShell {
      background: var(--surface-lowest);
      box-shadow: var(--card-shadow);
    }
    .theme-panel {
      background: var(--surface-lowest);
      color: var(--text-main);
    }
    .theme-soft-panel {
      background: var(--surface-low);
      color: var(--text-main);
    }
    .theme-warm-panel {
      background: color-mix(in srgb, var(--blue-soft) 56%, var(--surface-lowest) 44%);
      color: var(--text-soft);
    }
    .theme-input {
      background: var(--surface-lowest);
      border: 1px solid rgba(115, 118, 135, 0.2);
      box-shadow: inset 0 0 0 1px rgba(115, 118, 135, 0.02);
      color: var(--text-main);
    }
    .theme-input::placeholder {
      color: var(--text-faint);
    }
    .theme-input:focus {
      border-color: rgba(0, 97, 255, 0.35);
      box-shadow: 0 0 0 4px rgba(0, 97, 255, 0.08);
    }
    .theme-empty-state {
      background: var(--surface-low);
      color: var(--text-soft);
    }
    .theme-email-card {
      background: var(--surface-lowest);
      box-shadow: 0 14px 28px -22px rgba(0, 75, 202, 0.28);
    }
    .theme-email-head {
      background: var(--surface-low);
    }
    .theme-address-link {
      color: var(--blue-main);
      text-decoration: none;
    }
    .theme-address-link:hover {
      color: var(--blue-bright);
    }
    .theme-note {
      color: var(--text-soft);
    }
    .theme-primary-button {
      background: linear-gradient(90deg, var(--blue-main), var(--blue-bright));
      color: #ffffff;
      box-shadow: 0 18px 36px -22px rgba(0, 97, 255, 0.52);
    }
    .theme-primary-button:hover {
      transform: translateY(-1px);
      filter: brightness(1.02);
    }
    body.dark .theme-primary-button {
      background: linear-gradient(90deg, #004bca, #0061ff);
      color: #ffffff;
      box-shadow: 0 18px 36px -22px rgba(0, 97, 255, 0.45);
    }
    body.dark .theme-primary-button:hover {
      filter: brightness(1.05);
    }
    .theme-secondary-button {
      background: var(--surface-lowest);
      color: var(--text-soft);
      box-shadow: inset 0 0 0 1px rgba(115, 118, 135, 0.12);
    }
    .theme-secondary-button:hover {
      background: var(--surface-low);
      color: var(--text-main);
    }
    .theme-accent-button {
      background: var(--surface-high);
      color: var(--text-main);
    }
    .theme-accent-button:hover {
      background: color-mix(in srgb, var(--surface-high) 82%, white 18%);
    }
    .theme-preview-frame {
      background: #ffffff;
    }
    .theme-toggle-button {
      background: var(--surface-low);
      color: var(--text-soft);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      box-shadow: inset 0 0 0 1px rgba(115, 118, 135, 0.12);
    }
    .theme-toggle-button:hover {
      background: var(--surface-high);
      color: var(--text-main);
    }
    body.dark .theme-panel .text-slate-900,
    body.dark .theme-soft-panel .text-slate-900,
    body.dark .theme-email-card .text-slate-900 {
      color: var(--text-main) !important;
    }
    body.dark .theme-panel .text-slate-700,
    body.dark .theme-soft-panel .text-slate-700,
    body.dark .theme-email-card .text-slate-700 {
      color: var(--text-soft) !important;
    }
    body.dark .theme-panel .text-slate-500,
    body.dark .theme-soft-panel .text-slate-500,
    body.dark .theme-email-card .text-slate-500,
    body.dark .theme-email-card .text-slate-400 {
      color: var(--text-faint) !important;
    }
    body.dark .theme-email-card .text-sky-700,
    body.dark .theme-soft-panel .text-sky-700,
    body.dark .theme-panel .text-sky-700 {
      color: var(--blue-bright) !important;
    }
    body.dark #currentAddress {
      color: var(--text-main) !important;
    }
    body.dark #randomAddressPreview {
      color: var(--text-main) !important;
    }
    body.dark .theme-soft-panel .glass-chip {
      color: var(--text-main) !important;
    }
    body.dark .glass-chip.text-\[var\(--blue-main\)\] {
      color: var(--text-main) !important;
    }
    body.dark #copyPageUrlBtn,
    body.dark #openRandomInboxBtn,
    body.dark #refreshBtn {
      color: var(--text-main) !important;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
    }
  </style>
</head>
<body class="min-h-screen">
  <div class="min-h-screen">
    <header id="heroSection" class="hero-gradient px-5 pb-12 pt-5 text-white md:px-8 md:pb-14 md:pt-6">
      <div class="mx-auto max-w-5xl">
        <div class="mx-auto max-w-2xl text-center">
          <div class="glass-chip inline-flex rounded-full px-3 py-1 text-[10px] font-semibold tracking-[0.24em] text-white/90">TEMP MAILBOX</div>
          <h1 class="mt-4">
            <a href="/" class="font-headline text-4xl font-extrabold tracking-tight text-white transition hover:text-white/90 md:text-5xl">临时邮箱</a>
          </h1>
          <p class="mx-auto mt-3 max-w-xl text-sm font-medium leading-7 text-blue-50/82 md:text-base md:leading-7">${notice}</p>
        </div>
      </div>
    </header>

    <main class="relative z-10 mx-auto -mt-10 max-w-4xl px-4 pb-8 md:-mt-12">
      <div id="appShell" class="ambient-glow overflow-hidden rounded-[28px] p-5 md:p-7">
        <div id="contentArea" class="space-y-6">
        ${
          missingDb
            ? `<div class="rounded-[22px] bg-rose-50 px-5 py-4 text-sm leading-7 text-rose-700">
                缺少 D1 绑定。请在 Cloudflare Worker 的绑定设置里添加 <span class="font-mono">DB</span>，然后刷新页面。
              </div>`
            : ""
        }

        ${
          box
            ? `<section class="space-y-2">
                <div class="theme-panel rounded-[24px] p-6 md:p-7">
                  <div class="mb-6 flex items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                      <div class="h-7 w-1.5 rounded-full bg-[var(--blue-main)]"></div>
                      <div class="font-headline text-2xl font-bold text-slate-900">当前收件箱</div>
                    </div>
                    <button id="themeToggleBtn" type="button" class="theme-toggle-button material-symbols-outlined inline-flex h-8 w-8 items-center justify-center rounded-full text-[16px]">dark_mode</button>
                  </div>
                  <div class="grid gap-5 lg:grid-cols-[1.55fr_0.95fr]">
                    <div class="flex h-full flex-col">
                    <div>
                    <button id="currentAddress" type="button" class="mt-3 block break-all text-left font-headline text-2xl font-bold text-[var(--blue-main)] transition hover:opacity-85 md:text-[2rem]">${fullAddress}</button>
                    <div class="mt-6 flex flex-wrap items-start gap-3">
                      <button id="copyAddressBtn" class="theme-primary-button inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">复制邮箱</button>
                      <button id="copyPageUrlBtn" class="theme-secondary-button inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">复制网址</button>
                      <button id="openRandomInboxBtn" type="button" class="theme-secondary-button inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">随机生成</button>
                    </div>
                    </div>
                    <div class="mt-auto flex justify-start pt-3">
                      <button id="refreshBtn" class="theme-secondary-button inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">刷新收件</button>
                    </div>
                    </div>
                    <div class="theme-soft-panel rounded-[24px] p-6 md:p-7">
                      <div class="mt-1 space-y-3 text-sm text-slate-700">
                        <div class="glass-chip flex w-fit items-center justify-start rounded-full px-3 py-1 font-medium text-[var(--blue-main)]">自动刷新中</div>
                        <div>自动刷新：每 5 秒一次</div>
                        <div id="mailCountText">邮件数量：0 封</div>
                        <div id="lastUpdatedText">最近刷新：未开始</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div id="statusBar" class="hidden rounded-[20px] px-4 py-3 text-sm"></div>
                <div id="emails" class="${box || missingDb ? "space-y-4" : "hidden"}"></div>
              </section>`
            : `<section class="space-y-5">
                <div class="theme-panel rounded-[26px] p-6 md:p-8">
                  <div class="mb-8 flex items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                      <div class="h-7 w-1.5 rounded-full bg-[var(--blue-main)]"></div>
                      <div class="font-headline text-2xl font-bold text-slate-900">快速开始</div>
                    </div>
                    <button id="themeToggleBtn" type="button" class="theme-toggle-button material-symbols-outlined inline-flex h-8 w-8 items-center justify-center rounded-full text-[16px]">dark_mode</button>
                  </div>
                    <div class="space-y-7">
                      <div class="flex justify-center">
                        <button id="randomBoxBtn" class="theme-primary-button inline-flex min-w-[220px] items-center justify-center gap-2 rounded-xl px-8 py-4 text-base font-semibold sm:min-w-[280px]">
                        <span class="material-symbols-outlined text-[20px]">auto_fix_high</span>
                        <span>随机生成邮箱</span>
                        </button>
                      </div>
                      <div>
                        <div class="mb-3 ml-1 text-sm font-semibold text-slate-500">点击下面邮箱地址，进入收件箱</div>
                        <div class="theme-soft-panel flex flex-col gap-3 rounded-[18px] p-2 sm:flex-row sm:items-center">
                          <button id="randomAddressPreview" type="button" class="theme-address-link min-w-0 flex-1 truncate rounded-[14px] px-4 py-3 text-left font-headline text-lg font-bold"></button>
                          <button id="copyRandomAddressBtn" class="theme-secondary-button inline-flex shrink-0 items-center justify-center gap-2 rounded-[14px] px-5 py-3 text-sm font-semibold">
                            <span class="material-symbols-outlined text-[18px]">content_copy</span>
                            <span>复制</span>
                          </button>
                        </div>
                      </div>
                      <div class="h-px bg-slate-200/70"></div>
                      <div>
                        <label class="mb-3 ml-1 block text-sm font-semibold text-slate-500" for="boxInput">输入自定义名称</label>
                        <form id="jumpForm" class="space-y-4">
                          <input id="boxInput" maxlength="24" placeholder="例如：Mybusiness123" class="theme-input w-full rounded-[16px] px-4 py-4 text-base outline-none" />
                          <button class="theme-accent-button inline-flex w-full items-center justify-center gap-2 rounded-xl px-6 py-4 text-base font-semibold" type="submit">
                            <span class="material-symbols-outlined text-[20px]">inbox</span>
                            <span>进入收件箱</span>
                          </button>
                        </form>
                        <div id="inputHelp" class="theme-note mt-3 text-xs">支持字母、数字、下划线和短横线，系统会自动转成大写。</div>
                      </div>
                    </div>
                  </div>
                <div id="statusBar" class="hidden rounded-[20px] px-4 py-3 text-sm"></div>
                <div id="emails" class="${box || missingDb ? "space-y-4" : "hidden"}"></div>
              </section>`
        }
        </div>
      </div>
    </main>

      <footer class="mx-auto flex max-w-5xl flex-col gap-4 px-6 pb-10 pt-6 text-sm text-slate-400 md:flex-row md:items-center md:justify-between">
        <div>© 2026 <a href="https://www.phehe.com" class="hover:text-[var(--blue-main)]">Phehe.com</a>. All rights reserved.</div>
        <div class="flex gap-6">
        <a href="#" class="hover:text-[var(--blue-main)]">Privacy</a>
        <a href="#" class="hover:text-[var(--blue-main)]">Terms</a>
        <a href="#" class="hover:text-[var(--blue-main)]">Support</a>
      </div>
    </footer>
  </div>

  <script>
    const currentBox = ${JSON.stringify(box)};
    const mailHost = ${JSON.stringify(host)};
    const missingDb = ${JSON.stringify(missingDb)};
    const refreshIntervalMs = 5000;
    let nextRefreshTimer = null;
    let currentTheme = "light";
    let latestEmails = [];
    const expandedEmailIds = new Set();
    const emailViewMode = new Map();

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }

    function normalizeBox(value) {
      return String(value || "").trim().replace(/[^a-z0-9_-]/gi, "").toUpperCase();
    }

    function setTheme(theme) {
      currentTheme = theme === "dark" ? "dark" : "light";
      document.body.classList.toggle("dark", currentTheme === "dark");

      const themeToggleBtn = document.getElementById("themeToggleBtn");
      if (themeToggleBtn) {
        themeToggleBtn.textContent = currentTheme === "dark" ? "light_mode" : "dark_mode";
        themeToggleBtn.title = currentTheme === "dark" ? "切换到浅色模式" : "切换到深色模式";
        themeToggleBtn.setAttribute("aria-label", themeToggleBtn.title);
      }

      localStorage.setItem("temp-mail-theme", currentTheme);
    }

    function initTheme() {
      const savedTheme = localStorage.getItem("temp-mail-theme");
      setTheme(savedTheme === "dark" ? "dark" : "light");
      document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
        setTheme(currentTheme === "dark" ? "light" : "dark");
      });
    }

    function randomBox() {
      const seed = Math.random().toString(36).slice(2, 8).toUpperCase();
      const suffix = Date.now().toString(36).slice(-2).toUpperCase();
      return normalizeBox(seed + suffix);
    }

    function mailboxAddress(boxName) {
      return boxName && mailHost ? boxName + "@" + mailHost : "";
    }

    async function copyText(value, successMessage) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        showStatus(successMessage, "success");
      } catch (error) {
        showStatus("复制失败，请手动复制。", "error");
      }
    }

    function showStatus(message, type) {
      const bar = document.getElementById("statusBar");
      if (!bar) return;
      const styles = {
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        error: "border-rose-200 bg-rose-50 text-rose-700",
        info: "border-sky-200 bg-sky-50 text-sky-700"
      };
        bar.className = "rounded-2xl px-4 py-3 text-sm " + (styles[type] || styles.info);
      bar.textContent = message;
      bar.classList.remove("hidden");
    }

    function formatTime(value) {
      return new Date(value).toLocaleString("zh-CN");
    }

    function updateRefreshMeta(count, fetchedAt) {
      const mailCountText = document.getElementById("mailCountText");
      const lastUpdatedText = document.getElementById("lastUpdatedText");
      if (mailCountText) mailCountText.textContent = "邮件数量：" + count + " 封";
      if (lastUpdatedText) lastUpdatedText.textContent = "最近刷新：" + formatTime(fetchedAt);
    }

    function getPreviewText(mail) {
      const source = String(mail.content || mail.htmlContent || "")
        .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
        .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ");
      return source
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 260);
    }

    function renderEmail(mail) {
      const isExpanded = expandedEmailIds.has(mail.id);
      const hasHtml = Boolean(mail.htmlContent);
      const currentView = emailViewMode.get(mail.id) || "text";
      const previewText = getPreviewText(mail);
      const htmlId = "mail-html-" + mail.id;
      const textId = "mail-text-" + mail.id;
      const iframeSrcdoc = hasHtml ? escapeAttr(mail.htmlContent) : "";
      const previewSuffix = previewText.length >= 260 ? "..." : "";
      const controls = hasHtml
        ? '<div class="mb-3 flex flex-wrap gap-2">'
          + '<button class="theme-secondary-button rounded-lg px-3 py-1.5 text-xs font-medium transition" data-mail-view="text" data-mail-id="' + mail.id + '">文本视图</button>'
          + '<button class="theme-secondary-button rounded-lg px-3 py-1.5 text-xs font-medium transition" data-mail-view="html" data-mail-id="' + mail.id + '">HTML 预览</button>'
          + '</div>'
        : '';
      const expanded = isExpanded
        ? '<div class="px-4 py-4 text-sm leading-7 text-slate-700">'
          + controls
          + '<div id="' + htmlId + '" class="' + (hasHtml && currentView === "html" ? '' : 'hidden ') + 'theme-preview-frame overflow-hidden rounded-xl">'
          + '<iframe class="h-[560px] w-full bg-white" sandbox="" referrerpolicy="no-referrer" srcdoc="' + iframeSrcdoc + '"></iframe>'
          + '</div>'
          + '<div id="' + textId + '" class="' + (!hasHtml || currentView === "text" ? '' : 'hidden') + '">'
          + '<pre>' + escapeHtml(mail.content) + '</pre>'
          + '</div>'
          + '</div>'
        : '';

      return '<article class="theme-email-card overflow-hidden rounded-[22px]">'
        + '<div class="theme-email-head px-4 py-4">'
        + '<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">'
        + '<div class="min-w-0 flex-1">'
        + '<div class="truncate text-lg font-semibold text-slate-900">' + escapeHtml(mail.subject || "(无主题)") + '</div>'
        + '<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">'
        + '<span class="break-all text-sky-700">' + escapeHtml(mail.from) + '</span>'
        + '<span class="text-slate-400">→</span>'
        + '<span class="break-all text-slate-400">' + escapeHtml(mail.to) + '</span>'
        + '</div>'
        + '<div class="mt-3 text-sm leading-6 text-slate-700">' + escapeHtml(previewText || "暂无预览内容") + previewSuffix + '</div>'
        + '</div>'
        + '<div class="flex shrink-0 flex-col items-start gap-2 md:items-end">'
        + '<div class="text-xs text-slate-400">' + formatTime(mail.time) + '</div>'
        + '<button class="theme-secondary-button rounded-lg px-3 py-1.5 text-xs font-medium transition" data-mail-toggle="' + mail.id + '">' + (isExpanded ? '收起' : '展开') + '</button>'
        + '</div>'
        + '</div>'
        + '</div>'
        + expanded
        + '</article>';
    }

      function renderEmpty() {
        if (missingDb) {
          return '<div class="theme-empty-state rounded-2xl border px-4 py-10 text-center text-sm">完成 D1 绑定后，这里会显示邮件列表。</div>';
        }
        if (!currentBox) {
          return '';
        }
        const displayHost = window.location.host
          ? window.location.host.charAt(0).toUpperCase() + window.location.host.slice(1)
          : '';
        const directUrl = escapeHtml(displayHost + '/' + currentBox);
        return '<div class="theme-empty-state rounded-[22px] px-4 py-10 text-center text-sm">'
          + '<div>当前还没有发往 ' + escapeHtml(mailboxAddress(currentBox)) + ' 的邮件。</div>'
          + '<div class="mt-3">地址后加邮箱前缀可直达当前页面，如：' + directUrl + '</div>'
          + '</div>';
      }
    function renderEmailList() {
      const dom = document.getElementById("emails");
      if (!dom) return;
      dom.innerHTML = latestEmails.length ? latestEmails.map(renderEmail).join("") : renderEmpty();
    }

    function syncStateWithEmails() {
      const validIds = new Set(latestEmails.map((mail) => mail.id));
      Array.from(expandedEmailIds).forEach((id) => {
        if (!validIds.has(id)) expandedEmailIds.delete(id);
      });
      Array.from(emailViewMode.keys()).forEach((id) => {
        if (!validIds.has(id)) emailViewMode.delete(id);
      });
    }

    function scheduleAutoRefresh() {
      if (!currentBox || missingDb) return;
      clearTimeout(nextRefreshTimer);
      nextRefreshTimer = setTimeout(() => {
        if (expandedEmailIds.size > 0) {
          scheduleAutoRefresh();
          return;
        }
        loadInbox(true);
      }, refreshIntervalMs);
    }

    async function loadInbox(silent) {
      const dom = document.getElementById("emails");
      if (!dom) return;

      if (missingDb || !currentBox) {
        dom.innerHTML = renderEmpty();
        return;
      }

      const refreshBtn = document.getElementById("refreshBtn");
      if (refreshBtn) refreshBtn.disabled = true;

      try {
        const res = await fetch("/api/list?box=" + encodeURIComponent(currentBox));
        const payload = await res.json();
        latestEmails = Array.isArray(payload.emails) ? payload.emails : [];
        syncStateWithEmails();
        renderEmailList();
        updateRefreshMeta(latestEmails.length, payload.fetchedAt || new Date().toISOString());
        if (!silent) {
          showStatus("收件箱已刷新。", "info");
        }
      } catch (error) {
        showStatus("刷新失败，请稍后再试。", "error");
      } finally {
        if (refreshBtn) refreshBtn.disabled = false;
        scheduleAutoRefresh();
      }
    }
    function setupHomePage() {
      const preview = document.getElementById("randomAddressPreview");
      const boxInput = document.getElementById("boxInput");
      const jumpForm = document.getElementById("jumpForm");
      let generatedBox = randomBox();

      function updatePreview() {
        if (preview) preview.textContent = mailboxAddress(generatedBox);
      }

      function goToBox(boxName) {
        const normalized = normalizeBox(boxName);
        if (!normalized) {
          showStatus("请输入有效的邮箱名。", "error");
          return;
        }
        window.location.href = "/" + encodeURIComponent(normalized);
      }

      document.getElementById("randomBoxBtn")?.addEventListener("click", () => {
        generatedBox = randomBox();
        updatePreview();
        showStatus("已生成新的随机邮箱。", "success");
      });

      document.getElementById("copyRandomAddressBtn")?.addEventListener("click", () => {
        copyText(mailboxAddress(generatedBox), "随机邮箱地址已复制。");
      });

      preview?.addEventListener("click", () => {
        goToBox(generatedBox);
      });

      jumpForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        goToBox(boxInput?.value || generatedBox);
      });

      boxInput?.addEventListener("input", () => {
        const normalized = normalizeBox(boxInput.value);
        if (normalized !== boxInput.value) {
          boxInput.value = normalized;
        }
      });

      updatePreview();
    }

    function setupInboxPage() {
      document.getElementById("emails")?.addEventListener("click", (event) => {
        const toggle = event.target.closest("[data-mail-toggle]");
        if (toggle) {
          const id = toggle.getAttribute("data-mail-toggle");
          if (expandedEmailIds.has(id)) {
            expandedEmailIds.delete(id);
          } else {
            expandedEmailIds.add(id);
          }
          renderEmailList();
          return;
        }

        const viewTrigger = event.target.closest("[data-mail-view]");
        if (viewTrigger) {
          const id = viewTrigger.getAttribute("data-mail-id");
          const view = viewTrigger.getAttribute("data-mail-view");
          if (id && view) {
            emailViewMode.set(id, view);
            expandedEmailIds.add(id);
            renderEmailList();
          }
        }
      });

      document.getElementById("copyAddressBtn")?.addEventListener("click", () => {
        copyText(mailboxAddress(currentBox), "邮箱地址已复制。");
      });

      document.getElementById("copyPageUrlBtn")?.addEventListener("click", () => {
        copyText(window.location.href, "页面网址已复制。");
      });

      document.getElementById("currentAddress")?.addEventListener("click", () => {
        copyText(mailboxAddress(currentBox), "邮箱地址已复制。");
      });

      document.getElementById("refreshBtn")?.addEventListener("click", () => {
        clearTimeout(nextRefreshTimer);
        loadInbox(false);
      });

      document.getElementById("openRandomInboxBtn")?.addEventListener("click", () => {
        const nextBox = randomBox();
        window.open("/" + encodeURIComponent(nextBox), "_blank", "noopener,noreferrer");
      });

      loadInbox(true);
    }
    initTheme();

    if (missingDb) {
      document.getElementById("emails").classList.remove("hidden");
      document.getElementById("emails").innerHTML = renderEmpty();
    } else if (currentBox) {
      document.getElementById("emails").classList.remove("hidden");
      setupInboxPage();
    } else {
      setupHomePage();
    }
  </script>
</body>
</html>`;
  }
};









