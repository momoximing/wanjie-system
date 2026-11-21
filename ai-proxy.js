#!/usr/bin/env node
/* ============================================================
   万界 · 模型网关（零依赖，Node 18+）

   万界 · 本机服务（模型中心 + 数据持久化），零依赖，Node 18+。

   数据落盘（删容器/重启都不丢）：
   - 数据目录 ./data（可用 WANJIE_DATA_DIR 覆盖），内含：
       db.json       网页的全部记录（13 模块 + 设置 + 节点位置）
       models.json   模型中心配置（密钥只存这里，前端永远拿不到明文）
   - GET  /data        读全部数据（首次返回 data:null）
   - POST /data        原子写全部数据（写临时文件再 rename，防半写损坏）

   模型中心：
   - GET  /models        列出模型（密钥打码）
   - POST /models        保存模型列表（增改删）
   - POST /models/test   测试某个模型连通性
   - GET  /presets       预设 provider 模板（OpenAI/DeepSeek/Kimi/智谱/Ollama/Anthropic…）
   - POST /chat          多轮对话 + 工具调用，可带 modelId 指定模型
   - POST /parse         旧版单轮（兼容保留）
   - GET  /              托管 index.html     GET /health 健康检查

   旧的环境变量（WANJIE_LLM_*）仍可用：没配 models.json 时自动当成一个默认模型。
   启动：node ai-proxy.js    浏览器打开 http://localhost:8787
   Docker：docker compose up -d（数据自动挂到本机 ./data）
   注意：别从 https 在线页调 http://localhost，浏览器会因私有网络拦截。
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DATA_DIR = path.resolve(process.env.WANJIE_DATA_DIR || path.join(DIR, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const MODELS_FILE = process.env.WANJIE_MODELS_FILE || path.join(DATA_DIR, 'models.json');
const PORT = Number(process.env.PORT || 8787);
/* 网络边界：默认只听回环（局域网连不上）。Docker 里端口映射要求 0.0.0.0，
   由 docker-compose 显式设 WANJIE_HOST=0.0.0.0，靠容器网络隔离保护。 */
const HOST = process.env.WANJIE_HOST || '127.0.0.1';
/* 可选访问令牌：默认空=不启用，保持零配置双击/同源体验不变。
   设置 WANJIE_TOKEN 后：所有 POST 接口要求 X-Wanjie-Token 头，令牌在托管页面时注入前端。 */
const TOKEN = process.env.WANJIE_TOKEN || '';
const KEEP_BAK = 5;                    // 数据文件滚动备份保留份数
let DATA_CORRUPT = false;              // 主数据文件曾损坏且未能从备份恢复
const MAX_TURNS = 6;
/* ---------- P2-4 可选本地 Embedding（默认关闭）----------
   默认关闭；只有同时设置 WANJIE_EMBED=1 与 WANJIE_EMBED_URL 才启用。
   只走 OpenAI 兼容 /embeddings 端点；推荐指向本机 Ollama / LM Studio。
   若填的是云端 URL，属于用户显式授权，前端会给出显眼提示。 */
const EMBED_ON = process.env.WANJIE_EMBED === '1' && !!process.env.WANJIE_EMBED_URL;
const EMBED_URL = process.env.WANJIE_EMBED_URL || '';
const EMBED_MODEL = process.env.WANJIE_EMBED_MODEL || 'nomic-embed-text';
const EMBED_KEY = process.env.WANJIE_EMBED_KEY || '';
const EMBED_IS_CLOUD = !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(EMBED_URL);
const VECTORS_FILE = path.join(DATA_DIR, 'vectors.json');
let VECTOR_CACHE = null;
function loadVectors() {
  if (VECTOR_CACHE) return VECTOR_CACHE;
  try { const d = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8')); VECTOR_CACHE = d && typeof d === 'object' ? d : {}; }
  catch (e) { VECTOR_CACHE = {}; }
  return VECTOR_CACHE;
}
function saveVectors() {
  try { atomicWrite(VECTORS_FILE, JSON.stringify(VECTOR_CACHE || {})); } catch (e) {}
}
/* 调 embedding 端点，返回向量数组。失败返回 null，由调用方回退关键词检索。 */
async function embedTexts(texts) {
  const url = EMBED_URL.replace(/\/$/, '') + '/embeddings';
  const headers = { 'Content-Type':'application/json' };
  if (EMBED_KEY) headers['Authorization'] = 'Bearer ' + EMBED_KEY;
  const r = await fetch(url, { method:'POST', headers,
    body: JSON.stringify({ model:EMBED_MODEL, input:texts.map(t => String(t).slice(0, 2000)) }) });
  if (!r.ok) throw new Error('embedding 接口 ' + r.status);
  const data = await r.json().catch(() => ({}));
  const list = Array.isArray(data.data) ? data.data : [];
  // 按 index 归位（OpenAI 兼容格式）
  const out = new Array(texts.length);
  list.forEach(x => { if (typeof x.index === 'number' && Array.isArray(x.embedding)) out[x.index] = x.embedding; });
  return out.every(v => Array.isArray(v)) ? out : null;
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/* ---------- 数据落盘：建目录 + 原子写 + 滚动快照 + 损坏回滚 ---------- */
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive:true }); } catch (e) {} }
function atomicWrite(file, text) {
  ensureDataDir();
  // 写前把当前完好文件轮转一份 .bak.N（保留最近 5 份），再原子替换主文件。
  // 这样即使新内容写坏，也有历史版本可回滚。备份失败不阻断主写入。
  try {
    if (fs.existsSync(file)) {
      for (let i = KEEP_BAK - 1; i >= 1; i--) {
        const from = file + '.bak.' + i, to = file + '.bak.' + (i + 1);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.copyFileSync(file, file + '.bak.1');
    }
  } catch (e) {}
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file); // 同分区 rename 是原子的，避免半写损坏
}
function parseDataFile(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch (e) { return null; }
}
function loadData() {
  const main = parseDataFile(DATA_FILE);
  if (main) { DATA_CORRUPT = false; return main; }
  // 主文件损坏或不存在 → 只从备份恢复，绝不返回 null 让前端把空数据推上去覆盖。
  DATA_CORRUPT = !!fs.existsSync(DATA_FILE);   // 存在但解析失败 = 真损坏
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.corrupt.' + Date.now()); } catch (e) {}
  }
  for (let i = 1; i <= KEEP_BAK; i++) {
    const bak = parseDataFile(DATA_FILE + '.bak.' + i);
    if (bak) {
      try {
        fs.copyFileSync(DATA_FILE + '.bak.' + i, DATA_FILE);  // 恢复到主文件
        DATA_CORRUPT = false;
        console.log('数据文件损坏，已从 .bak.' + i + ' 自动恢复');
      } catch (e) {}
      return bak;
    }
  }
  return null; // 主文件与全部备份都没有 → 真是首次使用
}
function saveData(obj) { atomicWrite(DATA_FILE, JSON.stringify(obj)); }
/* 从旧位置迁移 models.json（升级前在 DIR 根目录） */
function migrateLegacyModels() {
  const legacy = path.join(DIR, 'models.json');
  if (MODELS_FILE === legacy) return;
  try {
    if (!fs.existsSync(MODELS_FILE) && fs.existsSync(legacy)) {
      ensureDataDir(); fs.copyFileSync(legacy, MODELS_FILE);
      console.log('已把旧 models.json 迁移到数据目录');
    }
  } catch (e) {}
}
ensureDataDir();
migrateLegacyModels();

/* ---------- provider 预设：点一下就填好 URL 与模型名 ---------- */
const PRESETS = [
  { id:'openai',      label:'OpenAI',              protocol:'openai',    base:'https://api.openai.com/v1',         model:'gpt-4o-mini',              key:1 },
  { id:'deepseek',    label:'DeepSeek',            protocol:'openai',    base:'https://api.deepseek.com/v1',       model:'deepseek-flash',           key:1 },
  { id:'moonshot',    label:'Moonshot · Kimi',     protocol:'openai',    base:'https://api.moonshot.cn/v1',        model:'moonshot-v1-8k',           key:1 },
  { id:'zhipu',       label:'智谱 GLM',            protocol:'openai',    base:'https://open.bigmodel.cn/api/paas/v4', model:'glm-4-flash',           key:1 },
  { id:'siliconflow', label:'硅基流动',            protocol:'openai',    base:'https://api.siliconflow.cn/v1',     model:'Qwen/Qwen2.5-7B-Instruct', key:1 },
  { id:'openrouter',  label:'OpenRouter',          protocol:'openai',    base:'https://openrouter.ai/api/v1',      model:'openai/gpt-4o-mini',       key:1 },
  { id:'anthropic',   label:'Anthropic · Claude',  protocol:'anthropic', base:'https://api.anthropic.com/v1',      model:'claude-3-5-haiku-latest',  key:1 },
  { id:'ollama',      label:'Ollama（本地·免费）',  protocol:'openai',    base:'http://localhost:11434/v1',         model:'qwen2.5',                  key:0 },
  { id:'lmstudio',    label:'LM Studio（本地·免费）',protocol:'openai',   base:'http://localhost:1234/v1',          model:'local-model',              key:0 },
  { id:'custom',      label:'自定义（OpenAI 兼容）', protocol:'openai',   base:'',                                  model:'',                         key:1 }
];

/* ---------- 模型配置读写 ---------- */
function envFallback() {
  if (!process.env.WANJIE_LLM_KEY && !process.env.WANJIE_LLM_BASE) return null;
  return [{
    id:'env', name:'环境变量模型', protocol:'openai',
    base:(process.env.WANJIE_LLM_BASE || 'https://api.openai.com/v1').replace(/\/$/,''),
    key:process.env.WANJIE_LLM_KEY || '',
    model:process.env.WANJIE_LLM_MODEL || 'gpt-4o-mini',
    preset:'openai', isDefault:true
  }];
}
function loadModels() {
  try {
    const raw = fs.readFileSync(MODELS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch (e) {}
  return envFallback() || [];
}
function saveModels(arr) {
  atomicWrite(MODELS_FILE, JSON.stringify(Array.isArray(arr) ? arr : [], null, 2));
}
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '••••';
  return s.slice(0, 6) + '••••' + s.slice(-4);
}
function publicModel(m) {
  return {
    id:m.id, name:m.name || m.model, protocol:m.protocol || 'openai',
    base:m.base || '', model:m.model || '', preset:m.preset || '',
    keySet:!!m.key, keyMask:maskKey(m.key), isDefault:!!m.isDefault
  };
}
function uid() { return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ---------- 选模型 ---------- */
function pickModel(list, id) {
  if (id) return list.find(m => m.id === id) || null;
  return list.find(m => m.isDefault) || list[0] || null;
}

/* ---------- 模型调用：OpenAI 兼容 / Anthropic ---------- */
/* OpenAI/Anthropic 工具名只允许 [a-zA-Z0-9_-]，点号会被 400 拒绝。发出前把点号转下划线，回来时两种都认。 */
function toolWireName(name) { return String(name || '').replace(/\./g, '_'); }
function toOpenAITools(tools) {
  return (Array.isArray(tools) ? tools : []).map(t => ({
    type:'function',
    function:{ name:toolWireName(t.name), description:t.description || '', parameters:t.inputSchema || { type:'object', properties:{} } }
  }));
}
function toAnthropicTools(tools) {
  return (Array.isArray(tools) ? tools : []).map(t => ({
    name:toolWireName(t.name), description:t.description || '', input_schema:t.inputSchema || { type:'object', properties:{} }
  }));
}
function normalBase(base, protocol) {
  let b = String(base || '').replace(/\/$/, '');
  if (protocol === 'anthropic' && !/\/v\d+$/.test(b)) b += '/v1';
  return b;
}
function headersFor(cfg) {
  if (cfg.protocol === 'anthropic') {
    return {
      'Content-Type':'application/json',
      'x-api-key':cfg.key || '',
      'anthropic-version':'2023-06-01'
    };
  }
  const h = { 'Content-Type':'application/json' };
  if (cfg.key) h['Authorization'] = 'Bearer ' + cfg.key;
  return h;
}
/* SSRF 收口：模型中心可填任意 base，服务端会代发请求。
   只允许 http/https，拒绝云元数据地址——本机 Ollama/LM Studio 与内网自建
   模型服务属于合法场景，保留；真正的跳板目标是 169.254.169.254 等元数据端点。
   注意：这只挡"明显危险目标"，不是完整 SSRF 防护；服务默认只绑回环是更硬的边界。 */
function assertSafeEndpoint(u) {
  let url;
  try { url = new URL(u); }
  catch (e) { throw new Error('模型地址不是合法 URL'); }
  const proto = String(url.protocol || '').toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') throw new Error('模型地址只支持 http/https');
  const host = String(url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const META_HOSTS = [
    '169.254.169.254',            // AWS/GCP/Azure 通用元数据
    '100.100.100.200',            // 阿里云元数据
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
    'fd00:ec2::254'               // AWS IMDS IPv6
  ];
  if (META_HOSTS.indexOf(host) >= 0) throw new Error('模型地址指向云元数据服务，已拒绝');
  // 169.254.0.0/16 link-local 整段（元数据常在此段）一律拒绝
  if (/^169\.254\./.test(host)) throw new Error('模型地址指向链路本地地址，已拒绝');
  return u;
}
function callUrl(cfg) {
  const b = normalBase(cfg.base, cfg.protocol);
  const u = cfg.protocol === 'anthropic' ? b + '/messages' : b + '/chat/completions';
  return assertSafeEndpoint(u);
}
async function callModel(cfg, messages, tools) {
  let body;
  if (cfg.protocol === 'anthropic') {
    const sys = messages.find(m => m.role === 'system');
    const convo = messages.filter(m => m.role !== 'system').map(m => ({ role:m.role, content:String(m.content || '') }));
    body = { model:cfg.model, max_tokens:1600, messages:convo };
    if (sys) body.system = String(sys.content || '');
    if (tools && tools.length) body.tools = toAnthropicTools(tools);
  } else {
    body = { model:cfg.model, temperature:0.2, messages:messages };
    if (tools && tools.length) body.tools = toOpenAITools(tools);
  }
  const r = await fetch(callUrl(cfg), { method:'POST', headers:headersFor(cfg), body:JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.error && (data.error.message || data.error.type) ? (data.error.message || data.error.type) : JSON.stringify(data);
    throw new Error('模型接口 ' + r.status + '：' + String(detail).slice(0, 220));
  }
  return data;
}
/* 归一化模型回复：{text, calls:[{id,name,args}], rawAssistant} */
function normalizeReply(cfg, data) {
  if (cfg.protocol === 'anthropic') {
    const content = Array.isArray(data.content) ? data.content : [];
    let text = '';
    const calls = [];
    for (const b of content) {
      if (b.type === 'text') text += String(b.text || '');
      if (b.type === 'tool_use') calls.push({ id:b.id, name:b.name, args:b.input || {} });
    }
    return { text:text.trim(), calls, rawAssistant:{ role:'assistant', content } };
  }
  const choice = data.choices && data.choices[0];
  const msg = (choice && choice.message) || {};
  const calls = (msg.tool_calls || []).map(tc => {
    let args = {};
    try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); }
    catch (e) { args = { _raw:(tc.function && tc.function.arguments) || '' }; }
    return { id:tc.id, name:(tc.function && tc.function.name) || '', args };
  });
  return { text:String(msg.content || '').trim(), calls, rawAssistant:msg };
}
function toolResultMessage(cfg, callId, text) {
  if (cfg.protocol === 'anthropic') {
    return { role:'user', content:[{ type:'tool_result', tool_use_id:callId, content:text }] };
  }
  return { role:'tool', tool_call_id:callId, content:text };
}
function appendAssistant(cfg, convo, raw) {
  if (cfg.protocol === 'anthropic') { convo.push(raw); return; }
  convo.push(raw);
}

/* ---------- 工具调用循环 ---------- */
function toolNameToModule(name) {
  const s = String(name || '');
  const m = s.match(/^wanjie[._]add[._](.+)$/i);
  return m ? m[1].toUpperCase() : '';
}
function isRecallTool(name) { return /^wanjie[._]recall$/i.test(String(name)); }
function isRememberTool(name) { return /^wanjie[._]remember$/i.test(String(name)); }
function extractJSON(text) {
  const m = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = m ? m[1] : String(text || '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}
function opsFromDraft(obj) {
  const list = (obj && (obj.ops || obj.operations || obj.drafts));
  if (!Array.isArray(list)) return [];
  return list.filter(o => o && o.m).map(o => ({ m:String(o.m).toUpperCase(), rec:o.rec || {} }));
}
/* 档案召回：把前端本机检索到的相关旧记录拼进系统提示，让模型"想起"历史。
   只读参考，绝不作为写入依据；条数与字数都设上限，防止撑爆上下文。 */
function archiveBlock(archive) {
  const list = (Array.isArray(archive) ? archive : []).slice(0, 6);
  if (!list.length) return '';
  const lines = list.map(a => '- [' + String(a.mname || a.m || '记录') + '] ' + String(a.snippet || '').slice(0, 160));
  return '\n\n【从用户档案里找到的相关旧记录（只读参考，可用于回答和起草证据链；不要当成新事实写库，没有依据别编造）：】\n' + lines.join('\n');
}

async function runAgent(cfg, input) {
  const system = input.system || '你是万界系统的录入助手。';
  const history = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const context = input.context || {};
  const sysMsg = system + '\n\n今天：' + (context.today || new Date().toISOString().slice(0, 10)) +
    '\n现有条数：' + JSON.stringify(context.counts || {}) +
    '\n\n你可以在需要时用工具起草记录（工具只生成草稿，写入要用户点头）。' +
    '缺关键信息时先用自然语言追问，别替用户编造。' +
    archiveBlock(context.archive);
  const files = Array.isArray(context.files) ? context.files.slice(0, 5) : [];
  const fileNote = files.length
    ? '\n\n用户附加了这些本地文件（只作本轮上下文，不要据此自动写入记录；要写入必须用工具起草并等用户确认）：\n' +
      files.map(f => '--- ' + String(f.name || '附件') + ' ---\n' + String(f.text || '').slice(0, 12000)).join('\n\n')
    : '';
  const convo = [{ role:'system', content:sysMsg + fileNote }].concat(
    history.filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .map(m => ({ role:m.role, content:String(m.content || '').slice(0, 8000) }))
  );
  const ops = [], notes = [], usedTools = [];
  let reply = '', memWrite = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const data = await callModel(cfg, convo, tools);
    const out = normalizeReply(cfg, data);
    if (out.text) reply = out.text;
    const calls = out.calls;

    if (!calls.length) {
      const draft = extractJSON(out.text);
      if (draft && (draft.ops || draft.operations)) ops.push(...opsFromDraft(draft));
      if (draft && draft.memWrite && ['user','persona','openLoops'].includes(draft.memWrite.block))
        memWrite = { block:draft.memWrite.block, value:String(draft.memWrite.value || '').slice(0, 300) };
      break;
    }

    appendAssistant(cfg, convo, out.rawAssistant);
    for (const c of calls) {
      if (usedTools.indexOf(c.name) < 0) usedTools.push(c.name);
      if (isRememberTool(c.name)) {
        const a = c.args || {};
        if (['user','persona','openLoops'].includes(a.block))
          memWrite = { block:a.block, value:String(a.value || '').slice(0, 300) };
        convo.push(toolResultMessage(cfg, c.id, '记忆草稿已接收，等待用户点头。'));
        continue;
      }
      if (isRecallTool(c.name)) {
        convo.push(toolResultMessage(cfg, c.id, '用户的记忆已附在上下文中，请据此回答。'));
        continue;
      }
      const mod = toolNameToModule(c.name);
      if (!mod) { convo.push(toolResultMessage(cfg, c.id, '未识别的工具，已忽略。')); continue; }
      ops.push({ m:mod, rec:c.args });
      convo.push(toolResultMessage(cfg, c.id, '草稿已接收，等待用户确认后写入。'));
      if (c.args && c.args._warning) notes.push(String(c.args._warning));
    }
  }
  const out = { reply:reply || '已整理好草稿，看下面确认。', ops, notes,
    turns:Math.min(MAX_TURNS, ops.length + 1), model:cfg.name || cfg.model, tools:usedTools };
  if (memWrite) out.memWrite = memWrite;
  return out;
}

async function runParse(cfg, input) {
  const system = input.prompt || '把用户的一句话解析成 {"ops":[{"m":"模块ID","rec":{...}}]}，只输出 JSON。';
  const data = await callModel(cfg, [
    { role:'system', content:system + '\n\n可用模块：' + JSON.stringify(input.tools || []) + '\n只输出 JSON。' },
    { role:'user', content:input.text || '' }
  ], []);
  const out = normalizeReply(cfg, data);
  const draft = extractJSON(out.text) || {};
  return { ops:opsFromDraft(draft), notes:draft.notes || [], note:draft.note || '' };
}

/* 拉取服务商当前可用的真实模型名（密钥只在本机用，不外传） */
async function fetchModelList(cfg) {
  if (!cfg.base && cfg.preset !== 'ollama' && cfg.preset !== 'lmstudio') throw new Error('没填接口地址');
  const u = callUrl(cfg);                 // 完整接口地址，如 https://api.deepseek.com/v1/chat/completions
  const cut = u.replace(/\/chat\/completions\/?$/, '').replace(/\/messages\/?$/, '').replace(/\/$/, '');
  const endpoint = cut + '/models';
  const r = await fetch(endpoint, { method:'GET', headers:headersFor(cfg) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.error && (data.error.message || data.error.type) ? data.error.message || data.error.type : JSON.stringify(data);
    throw new Error('拉取模型列表失败 ' + r.status + '：' + String(detail).slice(0, 180));
  }
  const ids = Array.isArray(data) ? data.map(x => x && (x.id || x.name))
    : Array.isArray(data.data) ? data.data.map(x => x && (x.id || x.name))
    : [];
  const models = ids.filter(Boolean).map(String);
  if (!models.length) throw new Error('服务商没返回模型列表（可能该端点不支持 /models）');
  return { models, endpoint };
}

/* 连通测试：发一句最短请求，确认能回话 */
async function testModel(cfg) {
  if (!cfg.base && cfg.preset !== 'ollama' && cfg.preset !== 'lmstudio') throw new Error('没填接口地址');
  if (!cfg.model) throw new Error('没填模型名');
  const t0 = Date.now();
  const data = await callModel(cfg, [
    { role:'system', content:'只回一个字：好' },
    { role:'user', content:'测试连通' }
  ], []);
  const out = normalizeReply(cfg, data);
  if (!out.text && !data.content && !(data.choices && data.choices[0])) throw new Error('模型没有返回内容');
  return { ok:true, ms:Date.now() - t0, text:out.text.slice(0, 60) || '（收到回复）' };
}

/* ---------- 网络边界：只接受本机来源，防跨站读取与 DNS rebinding ---------- */
function localHostname(h) {
  h = String(h || '').toLowerCase().replace(/:\d+$/, ''); // 去端口
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '';
}
function localOrigin(origin) {
  if (!origin) return true;                    // 无 Origin：同源请求 / curl / Node 测试，放行
  if (origin === 'null') return true;          // file:// 双击打开，放行
  try {
    const u = new URL(origin);
    return localHostname(u.hostname);
  } catch (e) { return false; }
}
function hostOK(req) {
  if (localHostname(req.headers.host)) return true;
  return !!TOKEN;   // 显式设了令牌=用户主动开放，允许非本机 Host，但仍须带令牌
}
function tokenOK(req) {
  if (!TOKEN) return true;                      // 未设令牌 → 只靠本机边界
  return req.headers['x-wanjie-token'] === TOKEN;
}
function corsFor(req) {
  const origin = req.headers.origin;
  const allow = (origin && origin !== 'null' && localOrigin(origin)) ? origin
    : (origin === 'null' ? 'null' : 'http://localhost:' + PORT);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Wanjie-Token',
    'Vary': 'Origin'
  };
}
function json(req, res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type':'application/json; charset=utf-8' }, corsFor(req)));
  res.end(JSON.stringify(obj));
}
/* API 门禁：页面本身不拦（地址栏导航无 Origin），接口一律过本机边界 + 令牌校验 */
function apiGate(req, res, url) {
  const isPage = req.method === 'GET' &&
    (url === '/' || url === '/index.html' || /^\/[A-Za-z0-9_\-]+\.html$/.test(url));
  if (isPage) return true;
  if (!hostOK(req) || !localOrigin(req.headers.origin)) {
    json(req, res, 403, { ok:false, error:'仅限本机访问（跨站或外部 Host 被拒绝）' }); return false;
  }
  // /health 只暴露无害状态（模型数/数据目录/是否需令牌），不含记录内容；
  // 免令牌放行，保证前端能探测到服务端模式。真正的数据/对话接口仍要令牌。
  if (url === '/health') return true;
  if (!tokenOK(req)) {
    json(req, res, 401, { ok:false, error:'访问令牌无效' }); return false;
  }
  return true;
}
/* 注入前端的令牌脚本：仅当设置了 WANJIE_TOKEN 时，页面内所有 fetch 自动带令牌头 */
function tokenInject() {
  if (!TOKEN) return '';
  return '<script>window.__WANJIE_TOKEN__=' + JSON.stringify(TOKEN) + ';'
    + '(function(){var f=window.fetch;window.fetch=function(u,o){o=o||{};'
    + 'var h={};var oh=o.headers||{};if(oh&&oh.forEach){oh.forEach(function(v,k){h[k]=v;});}'
    + 'else{for(var k in oh)h[k]=oh[k];}h["X-Wanjie-Token"]=window.__WANJIE_TOKEN__;'
    + 'var n={};for(var p in o)n[p]=o[p];n.headers=h;return f(u,n);};})();</script>';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 12e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsFor(req)); return res.end(); }
  const url = (req.url || '/').split('?')[0];
  if (!apiGate(req, res, url)) return;

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return fs.readFile(path.join(DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(404); return res.end('index.html not found'); }
      if (TOKEN) html = html.replace('</head>', tokenInject() + '</head>');
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache, no-store, must-revalidate' });
      res.end(html);
    });
  }
  // 托管目录内其它 .html（本地测试页 / 自定义页面）
  if (req.method === 'GET' && /^\/[A-Za-z0-9_\-]+\.html$/.test(url)) {
    const f = path.join(DIR, path.basename(url));
    return fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache, no-store, must-revalidate' });
      res.end(buf);
    });
  }
  if (req.method === 'GET' && url === '/health') {
    const list = loadModels();
    return json(req, res, 200, {
      ok:true, models:list.length, default:(pickModel(list) || {}).id || '', port:PORT,
      storage:'server', dataDir:DATA_DIR, hasData:!!loadData(), version:2,
      needToken:!!TOKEN, recovered:DATA_CORRUPT===false && !!loadData(), dataCorrupt:DATA_CORRUPT,
      embed:{enabled:EMBED_ON, model:EMBED_ON?EMBED_MODEL:'', cloud:EMBED_ON?EMBED_IS_CLOUD:false}
    });
  }
  /* ---------- P2-4 可选 Embedding：文本 → 向量（带本地缓存） ---------- */
  if (req.method === 'POST' && url === '/embed') {
    if (!EMBED_ON) return json(req, res, 200, { ok:false, enabled:false, reason:'未启用（需 WANJIE_EMBED=1 和 WANJIE_EMBED_URL）' });
    let input;
    try { input = await readBody(req); } catch (e) { return json(req, res, 400, { ok:false, error:'请求体不是 JSON' }); }
    const texts = Array.isArray(input.texts) ? input.texts.map(x => String(x).slice(0, 2000)).slice(0, 64) : [];
    if (!texts.length) return json(req, res, 200, { ok:true, enabled:true, vectors:[] });
    const cache = loadVectors();
    const miss = [], idxs = [];
    texts.forEach((t, i) => { const k = EMBED_MODEL + '|' + t; if (Array.isArray(cache[k])) { /* hit */ } else { miss.push(t); idxs.push(i); } });
    if (miss.length) {
      try {
        const vs = await embedTexts(miss);
        if (vs) vs.forEach((v, j) => { cache[EMBED_MODEL + '|' + miss[j]] = v; });
        if (vs) saveVectors();
      } catch (e) { return json(req, res, 200, { ok:false, enabled:true, error:String(e.message).slice(0,160) }); }
    }
    const vecs = texts.map(t => cache[EMBED_MODEL + '|' + t] || null);
    return json(req, res, 200, { ok:true, enabled:true, model:EMBED_MODEL, cloud:EMBED_IS_CLOUD, vectors:vecs });
  }
  /* ---------- 数据持久化：网页记录落到数据卷 ---------- */
  if (req.method === 'GET' && url === '/data') {
    const d = loadData();
    return json(req, res, 200, { ok:true, data:d });
  }
  if (req.method === 'POST' && url === '/data') {
    let input;
    try { input = await readBody(req); }
    catch (e) { return json(req, res, 400, { ok:false, error:'请求体不是 JSON' }); }
    const data = input && input.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return json(req, res, 400, { ok:false, error:'data 必须是对象' });
    }
    try {
      saveData(data);
      return json(req, res, 200, { ok:true, savedAt:new Date().toISOString(), bytes:fs.statSync(DATA_FILE).size });
    } catch (e) {
      return json(req, res, 500, { ok:false, error:'写数据失败：' + ((e && e.message) || e) });
    }
  }
  if (req.method === 'GET' && url === '/presets') {
    return json(req, res, 200, { ok:true, presets:PRESETS });
  }
  if (req.method === 'GET' && url === '/models') {
    const list = loadModels();
    return json(req, res, 200, { ok:true, models:list.map(publicModel), defaultId:(pickModel(list) || {}).id || '', file:MODELS_FILE });
  }
  if (req.method === 'POST' && url === '/models') {
    let input;
    try { input = await readBody(req); }
    catch (e) { return json(req, res, 400, { ok:false, error:'请求体不是 JSON' }); }
    const list = loadModels();
    const action = input.action || 'save';
    if (action === 'save') {
      let next = Array.isArray(input.models) ? input.models : [];
      next = next.map(m => {
        const clean = {
          id:m.id || uid(), name:String(m.name || m.model || '未命名模型'),
          protocol:m.protocol === 'anthropic' ? 'anthropic' : 'openai',
          base:String(m.base || '').trim(), model:String(m.model || '').trim(),
          preset:String(m.preset || ''), isDefault:!!m.isDefault
        };
        const old = list.find(x => x.id === m.id);
        clean.key = (m.key != null && String(m.key).trim() && !/^••/.test(String(m.key)))
          ? String(m.key).trim() : (old ? old.key || '' : '');
        return clean;
      });
      if (next.length && !next.some(m => m.isDefault)) next[0].isDefault = true;
      try { saveModels(next); }
      catch (e) { return json(req, res, 500, { ok:false, error:'写 models.json 失败：' + e.message }); }
      return json(req, res, 200, { ok:true, models:next.map(publicModel), defaultId:(pickModel(next) || {}).id || '' });
    }
    if (action === 'test') {
      const ref = input.model || (input.id ? { id:input.id } : null);
      const cfg = ref && ref.id ? (list.find(m => m.id === ref.id) || ref) : ref;
      if (!cfg) return json(req, res, 400, { ok:false, error:'没指定要测试的模型' });
      try { return json(req, res, 200, Object.assign({ ok:true }, await testModel(cfg))); }
      catch (e) { return json(req, res, 200, { ok:false, error:(e && e.message) || String(e) }); }
    }
    if (action === 'fetch') {
      const ref = input.model || (input.id ? { id:input.id } : null);
      const cfg = ref && ref.id ? (list.find(m => m.id === ref.id) || ref) : ref;
      if (!cfg) return json(req, res, 400, { ok:false, error:'没指定服务商' });
      try { return json(req, res, 200, Object.assign({ ok:true }, await fetchModelList(cfg))); }
      catch (e) { return json(req, res, 200, { ok:false, error:(e && e.message) || String(e) }); }
    }
    return json(req, res, 400, { ok:false, error:'未知 action：' + action });
  }
  if (req.method === 'POST' && (url === '/chat' || url === '/parse')) {
    let input;
    try { input = await readBody(req); }
    catch (e) { return json(req, res, 400, { reply:'请求体不是 JSON', ops:[] }); }
    const list = loadModels();
    const cfg = pickModel(list, input.modelId);
    if (!cfg) {
      return json(req, res, 200, {
        reply:'模型中心还没配模型：打开设置 → 模型中心，添加一个模型（或填 WANJIE_LLM_KEY 后重启）。没配也能用「本地演示」体验追问流程。',
        ops:[], notes:[], demo:true
      });
    }
    try {
      const out = url === '/chat' ? await runAgent(cfg, input) : await runParse(cfg, input);
      json(req, res, 200, out);
    } catch (e) {
      json(req, res, 200, { reply:'网关出错：' + ((e && e.message) || e), ops:[], notes:[] });
    }
    return;
  }
  json(req, res, 404, { ok:false, error:'没有这个接口' });
});

server.listen(PORT, HOST, () => {
  const list = loadModels();
  const def = pickModel(list);
  console.log('万界本机服务： http://localhost:' + PORT + '  （监听 ' + HOST + '）');
  if (!localHostname(HOST)) {
    console.log('  ⚠ 监听所有网卡：同一网络任何人都能连到本机端口。');
    console.log('    令牌只挡跨站浏览器请求，挡不住同网络直接 curl 取页面里的令牌——真正的安全边界是网络绑定。');
    console.log('    请把 docker-compose.yml 的 ports 改成 "127.0.0.1:' + PORT + ':' + PORT + '"，或只在本机/可信网络使用。');
  }
  if (TOKEN) console.log('  访问令牌：已启用（前端自动携带，接口需 X-Wanjie-Token；注意它不能替代网络绑定）');
  console.log('已配置模型：' + list.length + ' 个' + (def ? '，默认「' + (def.name || def.model) + '」' : '（模型中心还没配）'));
  console.log('数据目录：  ' + DATA_DIR);
  console.log('  记录 → ' + DATA_FILE + (loadData() ? '（已有数据）' : '（空，网页首次打开会写入）'));
  console.log('  模型 → ' + MODELS_FILE);
  console.log('浏览器打开即自动落盘；数据随 ./data 卷保留，删容器不丢。');
});
