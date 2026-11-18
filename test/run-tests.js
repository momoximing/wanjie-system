#!/usr/bin/env node
'use strict';
/* ============================================================
   万界 · 自动化测试（零依赖，Node 18+）
   运行： npm test    或    node test/run-tests.js
   覆盖：语法检查 / 服务端 /data 持久化(含重启) / 模型中心 CRUD 与打码
        / 示例数据完整性 / 前端关键函数与接口静态断言
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8897);
const TMP = path.join(ROOT, 'test', '.tmpdata');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n\x1b[36m▸ ' + t + '\x1b[0m'); }

function req(method, urlpath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'127.0.0.1', port:PORT, path:urlpath, method,
      headers: data ? { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data) } : {} }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ code:res.statusCode, json:JSON.parse(b), raw:b }); }
        catch (e) { resolve({ code:res.statusCode, json:null, raw:b }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function startProxy() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TMP, { recursive:true });
    const env = Object.assign({}, process.env, { PORT:String(PORT), WANJIE_DATA_DIR:TMP });
    const p = spawn(process.execPath, ['ai-proxy.js'], { cwd:ROOT, env, stdio:['ignore','pipe','pipe'] });
    let log = ''; const onLog = c => { log += c; if (String(c).indexOf('http://localhost') >= 0) { clearTimeout(timer); resolve(p); } };
    p.stdout.on('data', onLog); p.stderr.on('data', c => log += c);
    const timer = setTimeout(() => reject(new Error('代理启动超时：' + log)), 6000);
  });
}
function stopProxy(p) { return new Promise(r => { if (!p || p.killed) return r(); p.on('exit', r); p.kill('SIGTERM'); setTimeout(r, 1500); }); }

async function testSyntax() {
  section('语法检查');
  const proxy = fs.readFileSync(path.join(ROOT, 'ai-proxy.js'), 'utf8');
  try { new vm.Script(proxy); ok('ai-proxy.js 语法', true); } catch (e) { ok('ai-proxy.js 语法', false, e.message); }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  ok('index.html 内联脚本存在', !!m);
  if (m) { try { new vm.Script(m[1]); ok('index.html 内联 JS 语法', true); } catch (e) { ok('index.html 内联 JS 语法', false, e.message); } }
  const css = html.match(/<style>([\s\S]*?)<\/style>/);
  if (css) { const o = (css[1].match(/{/g)||[]).length, c = (css[1].match(/}/g)||[]).length; ok('CSS 括号平衡', o===c, o+'/'+c); }
  return html;
}

function testStatic(html) {
  section('前端关键能力静态断言');
  [['存储适配器 STORE','const STORE='],['服务端探测 /health',"storage==='server'"],['/data 推送','/data'],
   ['全文搜索 searchRecords','function searchRecords'],['高亮 markKw','function markKw'],['检索渲染 renderSearch','function renderSearch'],
   ['证据链 jumpToEvidence','function jumpToEvidence'],['起草确认 commit','function commit'],
   ['模型中心 mcSave','function mcSave'],['多轮对话 AIClient.chat','chat(']
  ].forEach(([n, needle]) => ok(n, html.indexOf(needle) >= 0));
}

function testSample() {
  section('示例数据完整性');
  const p = path.join(ROOT, 'examples', 'sample-db.json');
  ok('示例文件存在', fs.existsSync(p));
  if (!fs.existsSync(p)) return;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const ids = ['L0','L1','VERIFY','L2O','L2W','D','POOL','L3A','L3B','L4A','L4B','C','L5'];
  ok('13 模块齐全', ids.every(k => Array.isArray(d[k])), ids.filter(k => !Array.isArray(d[k])).join(','));
  ok('有 meta 与 settings', !!d.meta && !!d.settings);
  ok('示例含证据链 ev', JSON.stringify(d).indexOf('"ev"') >= 0);
  ok('示例无真实密钥', !/sk-[A-Za-z0-9]{12,}/.test(JSON.stringify(d)));
}

async function testServer() {
  section('服务端 · 数据持久化与模型中心');
  fs.rmSync(TMP, { recursive:true, force:true }); fs.mkdirSync(TMP, { recursive:true });
  let p = await startProxy();
  try {
    let h = await req('GET', '/health');
    ok('health storage=server', h.json && h.json.storage==='server', h.raw);
    ok('health version=2', h.json && h.json.version===2);
    let d0 = await req('GET', '/data');
    ok('首次 /data 为空', d0.json && d0.json.data===null, d0.raw);
    const payload = { meta:{version:1,updated:new Date().toISOString(),origin:'autotest'}, L0:[{date:'2026-11-17',reason:'自动化测试'}], settings:{} };
    let w = await req('POST', '/data', { data:payload });
    ok('POST /data 成功', w.json && w.json.ok===true, w.raw);
    ok('数据文件已落盘', fs.existsSync(path.join(TMP,'db.json')));
    let bad = await req('POST', '/data', { data:[1,2] });
    ok('拒绝非对象 data', bad.json && bad.json.ok===false);
    let m = await req('POST', '/models', { action:'save', models:[{name:'T',base:'http://x/v1',model:'m1',key:'sk-abcdef123456',isDefault:true}] });
    ok('保存模型成功', m.json && m.json.ok, m.raw);
    let mList = await req('GET', '/models');
    ok('模型列表密钥打码', mList.json.models[0].keyMask.indexOf('••••')>=0 && mList.json.models[0].keyMask.indexOf('abcdef')<0, mList.json.models[0].keyMask);
    // 重启
    await stopProxy(p); p = await startProxy();
    let d2 = await req('GET', '/data');
    ok('重启后数据保留', d2.json && d2.json.data && d2.json.data.meta.origin==='autotest', d2.raw);
    let m2 = await req('GET', '/models');
    ok('重启后模型保留', m2.json && m2.json.models && m2.json.models.length===1, m2.raw);
    let page = await req('GET', '/index.html');
    ok('静态托管正常', page.code===200 && /<!DOCTYPE|<html/i.test(page.raw));
  } finally {
    await stopProxy(p);
    fs.rmSync(TMP, { recursive:true, force:true });
  }
}

function testAgentCore(html) {
  section('Personal Agent 骨架 · 数据迁移 / 意图分流 / 上下文');
  [['会话结构 sessions','DB.sessions'],['工作记忆 memory','DB.memory'],
   ['上下文组装 buildContext','function buildContext'],['滚动摘要 maybeCompact','function maybeCompact'],
   ['意图分流 classifyIntent','function classifyIntent'],['记忆提取 extractMemoryWrite','function extractMemoryWrite'],
   ['本地对话 localChat','function localChat'],['会话切换 switchSession','function switchSession'],
   ['记忆面板 renderMemoryPanel','function renderMemoryPanel'],['记忆写入起草 memWrite','memWrite']
  ].forEach(([n,needle])=>ok(n, html.indexOf(needle)>=0));

  // 用 vm 沙箱加载真实函数源码，测纯逻辑（mock 掉 DOM 与外部依赖）
  const start=html.indexOf('const MEM_BLOCKS=');
  const end=html.indexOf('function fmtSize(');
  if(start<0||end<0||end<=start){ ok('函数源码可提取',false); return; }
  const src=html.slice(start,end);
  const sandbox={
    DB:JSON.parse(JSON.stringify({
      chat:[{role:'user',content:'旧消息一'},{role:'assistant',content:'旧消息二'}],
      settings:{}, L0:[], L3B:[]
    })),
    MODULES:[{id:'L0',name:'状态',fields:[]},{id:'L3B',name:'押注',fields:[]}],
    count:()=>0, esc:x=>String(x), $:()=>null, renderChat:()=>{}, renderSessions:()=>{}, toast:()=>{}, save:()=>{},
    looksLikeDraft:()=>false, NEW_INTENT:/^(日记|押注|判例|事项)/,
    Date, JSON, Math, Object, Array, String, Number, RegExp, console
  };
  try{
    vm.createContext(sandbox);
    vm.runInContext(src+'\n;globalThis.T={normalizeAgentMemory,currentSession,switchSession,newSession,classifyIntent,extractMemoryWrite,estTokens,buildContext,maybeCompact,MEM_BLOCKS,getDB:()=>DB,setCHAT:v=>{CHAT=v}};',sandbox);
    const T=sandbox.T;
    T.normalizeAgentMemory();
    const db=T.getDB();
    ok('旧 chat 迁移为首个会话', db.sessions.length===1 && db.sessions[0].messages.length===2);
    ok('工作记忆三块初始化', T.MEM_BLOCKS.every(k=>db.memory[k]===''));
    ok('activeSession 指向首会话', !!db.activeSession && db.activeSession===db.sessions[0].id);
    ok('重复迁移幂等', (T.normalizeAgentMemory(), db.sessions.length===1));
    ok('意图·record', T.classifyIntent('日记：今天很累')==='record');
    ok('意图·memory', T.classifyIntent('记住：我叫小明')==='memory');
    ok('意图·chat', T.classifyIntent('你觉得最近怎么样')==='chat');
    ok('记忆提取·user块', (()=>{const w=T.extractMemoryWrite('记住：我叫小明');return w&&w.block==='user'&&/小明/.test(w.value);})());
    ok('记忆提取·openLoops块', (()=>{const w=T.extractMemoryWrite('记住：我在做万界项目');return w&&w.block==='openLoops';})());
    ok('token 估算中文', T.estTokens('一二三四')===4 && T.estTokens('abcd')===1);
    ok('上下文含工作记忆占位', /工作记忆/.test(T.buildContext().system));
    ok('上下文只取最近消息', T.buildContext().messages.length<=8);
    T.newSession();
    ok('新建会话后计数为 2', T.getDB().sessions.length===2);
  }catch(e){ ok('Agent 骨架逻辑加载',false,e.message); }
}

function testProxyTools() {
  section('模型网关 · 工具名映射与记忆写回');
  const src = fs.readFileSync(path.join(__dirname,'..','ai-proxy.js'),'utf8');
  const a=src.indexOf('function toolNameToModule('), b=src.indexOf('function extractJSON(');
  if(a<0||b<0||b<=a){ ok('代理工具函数可提取',false); return; }
  const sb={ String, RegExp, console };
  try{
    vm.createContext(sb);
    const pre=src.indexOf('function toolWireName(');
    const withWire=(pre>=0&&pre<a?src.slice(pre,src.indexOf('function toOpenAITools(')):'')+src.slice(a,b);
    vm.runInContext(withWire+'\n;globalThis.P={toolNameToModule,isRecallTool,isRememberTool,toolWireName:globalThis.toolWireName||function(x){return String(x).replace(/\\./g,"_")}};',sb);
    const P=sb.P;
    ok('点号工具名 → 模块ID', P.toolNameToModule('wanjie.add_l3b')==='L3B');
    ok('下划线工具名 → 模块ID', P.toolNameToModule('wanjie_add_l0')==='L0');
    ok('数字模块ID 不丢', P.toolNameToModule('wanjie.add_l2o')==='L2O');
    ok('remember 识别（点号）', P.isRememberTool('wanjie.remember')===true);
    ok('recall 识别（下划线）', P.isRecallTool('wanjie_recall')===true);
    ok('普通工具不误判', P.isRememberTool('wanjie.add_d')===false && P.toolNameToModule('别的')==='');
    ok('工具名点号转下划线（DeepSeek 合法）', P.toolWireName('wanjie.add_d')==='wanjie_add_d' && P.toolWireName('wanjie.remember')==='wanjie_remember');
    ok('发出工具做名字转换', /name:toolWireName\(t\.name\)/.test(src));
    ok('网关返回 memWrite 字段', src.indexOf('out.memWrite = memWrite')>=0);
  }catch(e){ ok('代理工具函数加载',false,e.message); }
}

(async () => {
  console.log('\n\x1b[1m万界系统 · 自动化测试\x1b[0m');
  const html = await testSyntax();
  testStatic(html);
  testAgentCore(html);
  testProxyTools();
  testSample();
  try { await testServer(); } catch (e) { fail++; console.log('  \x1b[31m✗ 服务端测试异常:\x1b[0m ' + e.message); }
  console.log('\n' + (fail===0 ? '\x1b[32m' : '\x1b[31m') + '结果：' + pass + ' 通过 / ' + fail + ' 失败\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})();
