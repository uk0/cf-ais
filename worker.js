// /worker.js —— 摘要机器人 (SSE + postMessage + Zhipu/OpenAI 双方言 + 429轮询API Key)
const DEFAULT_MODEL = 'glm-4v-flash';
const DEBUG = false;

/* ------------ 基础响应 ------------ */
function jsonResponse(obj, init = {}) {
    return new Response(JSON.stringify(obj), {
        ...init,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cross-Origin-Opener-Policy': 'unsafe-none',
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Permissions-Policy':
                'autoplay=*, encrypted-media=*, fullscreen=*, picture-in-picture=*',
            ...(init.headers || {}),
        },
    });
}
function htmlResponse(html, init = {}) {
    return new Response(html, {
        ...init,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cross-Origin-Opener-Policy': 'unsafe-none',
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Permissions-Policy':
                'autoplay=*, encrypted-media=*, fullscreen=*, picture-in-picture=*',
            ...(init.headers || {}),
        },
    });
}

/* ------------ 工具 ------------ */
function stripHTML(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|br|li|h[1-6]|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 解析 env 中的 API keys（支持单个 or 逗号分隔多个） */
function getApiKeys(env) {
    const many = (env.OPENAI_API_KEYS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (many.length > 0) return many;
    const single = (env.OPENAI_API_KEY || '').trim();
    return single ? [single] : [];
}

/** OpenAI 兼容分支的 image parts */
function buildImageBlocksOpenAI(images = []) {
    const out = [];
    for (const it of images) {
        let src = typeof it === 'string' ? it : it?.src || it?.url || '';
        if (!src) continue;
        if (!src.startsWith('http') && !src.startsWith('data:')) {
            src = `data:image/png;base64,${src}`;
        }
        out.push({ type: 'image_url', image_url: { url: src } });
        if (out.length >= 12) break;
    }
    return out;
}

/** 智谱分支的 image parts（支持 http(s) 或 纯 base64；若是 data: 自动剥前缀） */
function toZhipuImageBlocks(partsOrImages = []) {
    const out = [];
    for (const it of partsOrImages) {
        let src =
            typeof it === 'string'
                ? it
                : it?.image_url?.url || it?.src || it?.url || '';
        if (!src) continue;
        if (src.startsWith('data:')) {
            const i = src.indexOf('base64,');
            src = i >= 0 ? src.slice(i + 7) : src; // 纯 base64
        }
        out.push({ type: 'image_url', image_url: { url: src } });
        if (out.length >= 12) break;
    }
    return out;
}

/** 方言检测 */
function detectDialect(apiBase, model) {
    const base = (apiBase || '').toLowerCase();
    const m = (model || '').toLowerCase();
    if (base.includes('open.bigmodel.cn') || m.startsWith('glm-')) return 'zhipu';
    return 'openai';
}

/** 判断是否可因限流而重试/换key */
async function shouldRotateOnError(resp) {
    if (!resp) return false;
    if (resp.status === 429) return true;
    try {
        const text = await resp.clone().text();
        if (!text) return false;
        const low = text.toLowerCase();
        // 兼容不同厂商/文案
        return low.includes('rate limit') || low.includes('too many requests');
    } catch {
        return false;
    }
}

/** 与上游建立 SSE —— 增加 429 轮询 API Key */
async function streamOpenAI({ env, systemPrompt, userPrompt, userParts, model }) {
    const keys = getApiKeys(env);
    if (keys.length === 0)
        return jsonResponse({ error: 'Missing OPENAI_API_KEY(S)' }, { status: 500 });

    const apiBase = (env.OPENAI_API_BASE || 'https://open.bigmodel.cn/api/paas/v4').replace(
        /\/+$/,
        ''
    );
    const usedModel = model || env.SUM_MODEL || DEFAULT_MODEL;
    const dialect = detectDialect(apiBase, usedModel);
    const url = `${apiBase}/chat/completions`;

    // 组装 body（与 key 无关）
    let body;
    if (dialect === 'zhipu') {
        const content = [];
        if (Array.isArray(userParts) && userParts.length) {
            const firstText = userParts.find((x) => x && x.type === 'text');
            if (firstText?.text) content.push({ type: 'text', text: firstText.text });
            const others = userParts.filter((x) => !x || x.type !== 'text');
            content.push(...toZhipuImageBlocks(others));
        } else {
            content.push({ type: 'text', text: userPrompt || '' });
        }
        body = {
            model: usedModel,
            stream: true,
            temperature: 0.2,
            messages: [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                { role: 'user', content },
            ],
        };
    } else {
        let userContent = userPrompt;
        if (Array.isArray(userParts) && userParts.length) userContent = userParts;
        body = {
            model: usedModel,
            stream: true,
            temperature: 0.2,
            messages: [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                { role: 'user', content: userContent },
            ],
        };
    }

    if (DEBUG) {
        console.log('======================================================');
        console.log(JSON.stringify(body));
        console.log('======================================================');
    } else {
        console.log('======================================================');
        console.log({ dialect, usedModel });
        console.log('======================================================');
    }

    // 顺序尝试每个 key：非 429 直接返回；429/RateLimit 则更换 key 继续
    let lastErrText = '';
    for (let idx = 0; idx < keys.length; idx++) {
        const key = keys[idx];
        let upstream;
        try {
            upstream = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
            });
        } catch (e) {
            lastErrText = `fetch error with key#${idx + 1}: ${String(e)}`;
            // 网络异常，继续换下一个 key
            if (idx < keys.length - 1) continue;
            return jsonResponse(
                { error: 'Upstream fetch failed', detail: lastErrText },
                { status: 502 }
            );
        }

        if (!upstream.ok || !upstream.body) {
            // 非 OK：看是否要轮换 key
            const rotate = await shouldRotateOnError(upstream);
            try {
                lastErrText = await upstream.text();
            } catch {
                lastErrText = '';
            }
            if (rotate && idx < keys.length - 1) {
                // 换下一个 key 继续
                console.log(`[rate-limit] rotate key: ${idx + 1} -> ${idx + 2}`);
                continue;
            }
            // 不可重试或已是最后一个 key：返回错误
            return jsonResponse(
                {
                    error: 'Upstream not ok',
                    status: upstream.status,
                    body: (lastErrText || '').slice(0, 2000),
                },
                { status: upstream.status || 502 }
            );
        }

        // OK：建立 SSE 透传
        const readable = new ReadableStream({
            async start(controller) {
                const enc = new TextEncoder();
                const reader = upstream.body.getReader();
                try {
                    controller.enqueue(enc.encode(`event: open\ndata: {}\n\n`));
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        controller.enqueue(value);
                    }
                    controller.enqueue(enc.encode(`event: done\ndata: [DONE]\n\n`));
                } catch (e) {
                    controller.enqueue(
                        enc.encode(
                            `event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`
                        )
                    );
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin',
            },
        });
    }

    // 理论到不了：兜底错误
    return jsonResponse(
        { error: 'All API keys failed', detail: (lastErrText || '').slice(0, 2000) },
        { status: 502 }
    );
}

function buildPrompts({ pageText, extraPrompt, images, apiBase, model }) {
    const systemPrompt = `
你是一位专业的中文网页内容总结助手。请阅读并理解以下网页正文（可能包含文本、图像及代码片段），输出一个结构化且简洁的总结：
输出要求：
1. 关键信息提炼：
  用 3～7 条要点概括主要内容，涵盖文章主题、结论、观点或新闻事件。
  保持条理清晰，避免冗长复述或感叹性语句。
2. 细节提炼与支撑：
   如有数据、事实、时间、人物、地点，请准确提取。
   若作者表达了观点、结论或分析，请说明其依据或逻辑。
3. 结构归纳：
   若内容包含操作步骤、教程、配置方法，请以简洁的步骤说明呈现。
   若为评论或观点文，请区分作者态度与客观信息。
4. 风险与限制（可选）：
   若文中涉及风险、警告、争议、局限性，请单独列出简要说明。
5. 图像整合（如有）：
   综合图像、截图或图表所传递的信息，无需逐张描述。
6. 结尾总结：
   最后一行以 TL;DR: 开头，用一句话给出文章的整体精要结论。

ResponseFormat ：
    🔹 要点：
    1. ...
    2. ...
     ....
    📊 数据与细节：
    - ...
    ⚠️ 风险与限制：
    - ...
    🤔 用户问题（如有）：
    - ...
    🧩 TL;DR：一句话总结核心思想。
`;

    const prefix = extraPrompt ? `对本文的提问: ${extraPrompt}\n\n` : '';
    const textBlock = `===== 文章内容 Start =====
${pageText}
===== 文章内容 End =====`;

    const dialect = detectDialect(apiBase, model);
    if (Array.isArray(images) && images.length) {
        if (dialect === 'zhipu') {
            // 原样传回，由 zhipu 分支转 image_url(url|base64)
            return {
                systemPrompt,
                userParts: [{ type: 'text', text: prefix + textBlock }].concat(images),
            };
        }
        return {
            systemPrompt,
            userParts: [{ type: 'text', text: prefix + textBlock }].concat(
                buildImageBlocksOpenAI(images)
            ),
        };
    }
    return { systemPrompt, userPrompt: prefix + textBlock };
}

/* ------------ 兜底 GET ?url= ------------ */
async function fetchAndExtract(url, request) {
    const r = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0' },
    });
    if (!r.ok) throw new Error(`Fetch target failed: ${r.status}`);
    const html = await r.text();
    return stripHTML(html).slice(0, 20000);
}

/* ------------ 路由 ------------ */
export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);
        if (request.method === 'OPTIONS') return jsonResponse({}, { status: 204 });

        // 自检
        if (pathname === '/api/upstream-test') {
            try {
                return await streamOpenAI({
                    env,
                    systemPrompt: '你是诊断助手，回答“pong”两个字。',
                    userPrompt: 'ping',
                    userParts: null,
                    model: env.SUM_MODEL || DEFAULT_MODEL,
                });
            } catch (e) {
                return jsonResponse({ error: String(e) }, { status: 500 });
            }
        }

        // 嵌入页（只收 postMessage）
        if (pathname === '/embed/summarizer' && request.method === 'GET') {
            const html = `<!doctype html><html lang="zh-CN">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Summarizer</title>
<style>
:root{--bg:rgba(30,31,34,.55);--fg:#eaeef2;--muted:#b6beca;--border:rgba(255,255,255,.18);--accent:#3b82f6;--blur:saturate(180%) blur(18px);}
html,body{height:100%}body{margin:0;background:transparent;color:var(--fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;}
.dock{position:fixed;right:16px;bottom:16px;display:flex;gap:8px;align-items:center;background:var(--bg);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--border);border-radius:14px;padding:8px 10px;box-shadow:0 12px 40px rgba(0,0,0,.35);}
.dock input{width:min(46vw,320px);background:transparent;color:var(--fg);border:1px solid var(--border);border-radius:10px;padding:8px 10px;outline:none;}
.dock input::placeholder{color:var(--muted);}
.dock button {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 12px;
  padding: 8px 14px;
  cursor: pointer;
  white-space: nowrap;
  font-weight: 500;
  letter-spacing: 0.3px;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    0 2px 4px rgba(0, 0, 0, 0.25),
    0 8px 16px rgba(0, 0, 0, 0.2);
  transition: all 0.25s ease;
}
.dock button:hover {
  background: rgba(255, 255, 255, 0.25);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.6),
    0 4px 12px rgba(0, 0, 0, 0.25);
  transform: translateY(-1px);
}
.dock button:active {
  background: rgba(255, 255, 255, 0.18);
  transform: translateY(0);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}
.dock button[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: none;
}
.result{position:fixed;right:16px;bottom:76px;width:min(90vw,640px);max-height:min(72vh,560px);overflow:auto;background:var(--bg);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--border);border-radius:14px;padding:12px;box-shadow:0 14px 44px rgba(0,0,0,.38);display:none;white-space:pre-wrap;}
.row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px}.title{font-weight:600;letter-spacing:.2px}
.ctrls{display:flex;gap:6px}.ctrls button{background:rgba(255,255,255,.08);border:1px solid var(--border);color:var(--fg);border-radius:9px;padding:6px 10px;cursor:pointer;}
.ghost{color:var(--muted)}
</style></head>
<body>
<div class="dock">
  <input id="q" placeholder="可选：围绕主题/查询内容（留空也可）" value="">
  <button id="go" disabled>等待接受…</button>
</div>
<div class="result" id="result">
  <div class="row">
    <div class="ctrls">
      <button id="copyBtn">复制</button>
    </div>
  </div>
  <div id="log" class="ghost">等待总结开始…</div>
</div>
<script>
(function(){
  const q = document.getElementById('q');
  const go = document.getElementById('go');
  const box = document.getElementById('result');
  const log = document.getElementById('log');
  const copyBtn = document.getElementById('copyBtn');

  let lastPayload = null;
  let esAbort = null;

  function openBox(){ box.style.display = 'block'; }
  copyBtn.onclick = async function(){
    try { await navigator.clipboard.writeText(log.textContent || ''); copyBtn.textContent='已复制'; setTimeout(()=>copyBtn.textContent='复制', 1200); } catch(e){}
  };

  function pingParentReady() {
    try { window.parent && window.parent.postMessage({ type: 'qwq-ready' }, '*'); } catch (e) {}
    console.log('[Summarizer iframe] sent qwq-ready');
  }

  async function readSSE(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const lines = raw.split('\\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trim());
        for (const line of lines) {
          if (line === '[DONE]') { return; }
          try {
            const j = JSON.parse(line);
            const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content)
                        || (j.delta && j.delta.content) || '';
            if (delta) { log.classList.remove('ghost'); log.textContent += delta; }
          } catch(_) { log.classList.remove('ghost'); log.textContent += line; }
        }
      }
    }
  }

  async function startPOST(payload){
    openBox();
    log.classList.add('ghost');
    log.textContent = '[streaming] \\n\\r';
    go.disabled = true; go.textContent = 'Generating…';

    if (esAbort) { esAbort.abort(); }
    esAbort = new AbortController();

    try {
      const resp = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: payload.text || '',
          images: Array.isArray(payload.images) ? payload.images : [],
          extra: (payload.extra || '') + (q.value ? ('\\n用户问题: ' + q.value) : '')
        }),
        signal: esAbort.signal
      });
      if (!resp.ok) {
        const errText = await resp.text();
        log.classList.remove('ghost');
        log.textContent += '\\n[upstream error ' + resp.status + '] ' + errText.slice(0, 800);
        return;
      }
      if (!resp.body) throw new Error('SSE upstream empty body');
      await readSSE(resp);
    } catch (e) {
      log.textContent += '\\n[error] ' + e.message;
    } finally {
      go.disabled = false; go.textContent = '继续提问';
      esAbort = null;
    }
    q.value = '';
    try{ q.reset && q.reset(); }catch(_){}
  }

  go.onclick = function(){
    if (!lastPayload) {
      openBox();
      log.classList.remove('ghost');
      log.textContent = '未收到父页数据，等父页发送或请在父页侧触发。';
      return;
    }
    startPOST(lastPayload);
  };

  window.addEventListener('message', (ev) => {
    const data = ev && ev.data;
    if (!data) return;
    if (data.type === 'qwq-summarize') {
      console.log('[Summarizer iframe] got qwq-summarize from', ev.origin);
      lastPayload = {
        text: (data.text || '').toString(),
        images: Array.isArray(data.images) ? data.images : [],
        extra: (data.extra || '').toString()
      };
      go.disabled = false; go.textContent = '继续提问';
      startPOST(lastPayload); // 自动开始
    }
  });

  window.addEventListener('DOMContentLoaded', pingParentReady);
})();
</script>
</body></html>`;
            return htmlResponse(html);
        }

        // 摘要接口（POST 推荐；GET 仅兜底）
        if (pathname === '/api/summarize' && (request.method === 'GET' || request.method === 'POST')) {
            try {
                let extra = '', raw = '', images = [], url = null;

                if (request.method === 'GET') {
                    const u = new URL(request.url);
                    url = u.searchParams.get('url');
                    extra = u.searchParams.get('extra') || '';
                } else {
                    const ct = request.headers.get('Content-Type') || '';
                    if (ct.includes('application/json')) {
                        const j = await request.json();
                        url = j.url || null;
                        extra = j.extra || '';
                        raw = j.text || '';
                        images = Array.isArray(j.images) ? j.images : [];
                    } else if (ct.includes('application/x-www-form-urlencoded')) {
                        const f = await request.formData();
                        url = f.get('url'); extra = f.get('extra') || ''; raw = f.get('text') || '';
                        try { images = JSON.parse(f.get('images') || '[]'); } catch(_) { images = []; }
                    }
                }

                let pageText = (raw || '').trim();
                if (!pageText) {
                    if (url) pageText = await fetchAndExtract(url, request);
                    else return jsonResponse({ error: '缺少正文 text（推荐父页 postMessage 传入），或提供 url 以兜底抓取' }, { status: 400 });
                }

                const apiBase = env.OPENAI_API_BASE || 'https://open.bigmodel.cn/api/paas/v4';
                const model = env.SUM_MODEL || DEFAULT_MODEL;
                const { systemPrompt, userPrompt, userParts } =
                    buildPrompts({ pageText, extraPrompt: extra, images, apiBase, model });
                console.log('[Summarizer] use apiBase', apiBase);
                console.log('[Summarizer] use model', model);
                return await streamOpenAI({ env, systemPrompt, userPrompt, userParts, model });
            } catch (e) {
                return jsonResponse({ error: String(e) }, { status: 500 });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
};