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

function req(method, urlpath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host:'127.0.0.1', port:PORT, path:urlpath, method, headers:h }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ code:res.statusCode, json:JSON.parse(b), raw:b, headers:res.headers }); }
        catch (e) { resolve({ code:res.statusCode, json:null, raw:b, headers:res.headers }); } });
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

/* ---------- P0-3 数据主权加固：网络边界 / 令牌 / 滚动备份 / 损坏回滚 ---------- */
const HPORT = Number(process.env.TEST_PORT || 8897) + 1;
const HTMP = path.join(ROOT, 'test', '.tmpdata-hard');
const HTOKEN = 'autotest-token-xyz';
function hreq(method, urlpath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host:'127.0.0.1', port:HPORT, path:urlpath, method, headers:h }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ code:res.statusCode, json:JSON.parse(b), raw:b, headers:res.headers }); }
        catch (e) { resolve({ code:res.statusCode, json:null, raw:b, headers:res.headers }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function startHardProxy() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { PORT:String(HPORT), WANJIE_DATA_DIR:HTMP, WANJIE_TOKEN:HTOKEN });
    const p = spawn(process.execPath, ['ai-proxy.js'], { cwd:ROOT, env, stdio:['ignore','pipe','pipe'] });
    let log = ''; const onLog = c => { log += c; if (String(c).indexOf('http://localhost') >= 0) { clearTimeout(timer); resolve(p); } };
    p.stdout.on('data', onLog); p.stderr.on('data', c => log += c);
    const timer = setTimeout(() => reject(new Error('加固代理启动超时：' + log)), 6000);
  });
}

async function testHardening() {
  section('P0-3 · 数据主权加固');
  fs.rmSync(HTMP, { recursive:true, force:true }); fs.mkdirSync(HTMP, { recursive:true });
  let p = await startHardProxy();
  try {
    // 令牌门禁：未带令牌的写接口应 401
    const noTok = await hreq('POST', '/data', { data:{ meta:{}, L0:[], settings:{} } });
    ok('令牌·无凭证 POST /data 被拒(401)', noTok.code===401 && noTok.json.ok===false, noTok.raw);
    // 带令牌成功
    const withTok = await hreq('POST', '/data', { data:{ meta:{origin:'hard'}, L0:[{date:'2026-11-19',reason:'加固测试'}], settings:{} } }, { 'X-Wanjie-Token':HTOKEN });
    ok('令牌·带凭证 POST /data 成功', withTok.code===200 && withTok.json.ok===true, withTok.raw);
    // 跨站 Origin 被拒（即便带令牌）
    const evil = await hreq('GET', '/data', null, { Origin:'https://evil.example', 'X-Wanjie-Token':HTOKEN });
    ok('边界·跨站 Origin 被拒(403)', evil.code===403 && evil.json.ok===false, evil.raw);
    // file:// 的 Origin:null 放行（带令牌）
    const nullOrigin = await hreq('GET', '/data', null, { Origin:'null', 'X-Wanjie-Token':HTOKEN });
    ok('边界·Origin:null 放行', nullOrigin.code===200 && nullOrigin.json.ok===true, nullOrigin.raw);
    // CORS 不再通配符
    const corsCheck = await hreq('GET', '/health', null, { Origin:'https://evil.example' });
    const acao = corsCheck.headers['access-control-allow-origin'] || '';
    ok('CORS·不再返回通配符 *', acao!=='*', acao || '(空)');
    // health 暴露令牌状态，且免令牌可读（前端靠它探测服务端模式）
    const hh = await hreq('GET', '/health');
    ok('health·needToken=true', hh.json && hh.json.needToken===true, hh.raw);
    ok('health·免令牌可探测', hh.code===200 && hh.json && hh.json.storage==='server', hh.raw);
    // 滚动备份：连续写两次后应生成 .bak.1
    await hreq('POST', '/data', { data:{ meta:{origin:'bak2'}, L0:[], settings:{} } }, { 'X-Wanjie-Token':HTOKEN });
    await hreq('POST', '/data', { data:{ meta:{origin:'bak3'}, L0:[], settings:{} } }, { 'X-Wanjie-Token':HTOKEN });
    ok('备份·生成 db.json.bak.1', fs.existsSync(path.join(HTMP,'db.json.bak.1')));
    // 损坏回滚：篡改主文件为坏 JSON，重启后应自动从备份恢复
    fs.writeFileSync(path.join(HTMP,'db.json'), '{ broken json', 'utf8');
    await stopProxy(p); p = await startHardProxy();
    const recovered = await hreq('GET', '/data', null, { 'X-Wanjie-Token':HTOKEN });
    ok('回滚·损坏后从备份恢复可用数据', recovered.json && recovered.json.ok===true && recovered.json.data && typeof recovered.json.data==='object', recovered.raw);
    ok('回滚·保留损坏现场 .corrupt', fs.readdirSync(HTMP).some(f=>f.indexOf('.corrupt.')>=0));
    // 托管页注入令牌脚本
    const page = await hreq('GET', '/index.html');
    ok('托管页·注入令牌脚本', page.code===200 && page.raw.indexOf('__WANJIE_TOKEN__')>=0);
  } finally {
    await stopProxy(p);
    fs.rmSync(HTMP, { recursive:true, force:true });
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

function testArchiveRecall() {
  section('读路径 · 档案召回与上下文注入');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // 用 vm 提取 archiveRecall 真实源码，喂带数据的 DB 测召回
  const s = html.indexOf('function archiveRecall(text, limit){');
  const e = html.indexOf('/* 组装上下文', s);
  if (s < 0 || e < 0) { ok('archiveRecall 源码可提取', false); return; }
  const src = html.slice(s, e);
  const sb = {
    MODULES:[
      {id:'L0', name:'L0 状态底座', fields:[{k:'date'},{k:'reason'}]},
      {id:'L3A', name:'L3-a 行动判例', fields:[{k:'situation'},{k:'action'}]}
    ],
    DB:{
      L0:[{date:'2026-11-01', reason:'因为赶稿睡眠差'}, {date:'2026-11-05', reason:'因为开会心累'}],
      L3A:[{situation:'早上写最难那段', action:'先做难的更省力'}]
    },
    String, Number, Math, Array, console
  };
  try {
    vm.createContext(sb);
    vm.runInContext(src + '\n;globalThis.RECALL=archiveRecall;', sb);
    const R = sb.RECALL;
    ok('召回·空查询返回空', R('', 6).length === 0);
    ok('召回·单关键词命中', R('赶稿', 6).length === 1 && R('赶稿',6)[0].m === 'L0');
    ok('召回·中文连续句按二字切命中', R('我最近赶稿的事', 6).length >= 1);
    ok('召回·跨模块命中', R('睡眠 最难', 6).length === 2);
    ok('召回·多关键词按命中数排序', (()=>{const r=R('因为 sleep 赶稿 睡眠',6);return r.length>=1 && r[0].score>=2;})());
    ok('召回·limit 上限生效', R('因为', 1).length === 1);
    ok('召回·片段截断 160 字', R('赶稿',6)[0].snippet.length <= 160);
  } catch (err) { ok('archiveRecall 逻辑加载', false, err.message); }

  // 静态接线断言
  ok('buildContext 产出 archive 字段', /archive:archive/.test(html));
  ok('云端请求把 archive 发给服务端', /archive:ctx\.archive/.test(html));
  ok('本地模式也走召回', /localAgent\(txt, archiveRecall\(txt,6\)\)/.test(html));
  ok('本地对话消费 archive', /localChat\(text,archive\)/.test(html));

  // 服务端 archiveBlock：提取真实源码测
  const proxy = fs.readFileSync(path.join(ROOT, 'ai-proxy.js'), 'utf8');
  const ps = proxy.indexOf('function archiveBlock(archive) {');
  const pe = proxy.indexOf('async function runAgent', ps);
  if (ps < 0 || pe < 0) { ok('archiveBlock 源码可提取', false); return; }
  const psrc = proxy.slice(ps, pe);
  const psb = { String, Array, console };
  try {
    vm.createContext(psb);
    vm.runInContext(psrc + '\n;globalThis.BLOCK=archiveBlock;', psb);
    const B = psb.BLOCK;
    ok('服务端·空档案不注入', B([]) === '');
    ok('服务端·有档案注入系统提示', /相关旧记录/.test(B([{mname:'L0 状态底座', snippet:'因为赶稿'}])));
    ok('服务端·档案条数封顶 6', (B(Array.from({length:10},(_,i)=>({m:'L0',snippet:'x'+i}))).match(/^- /gm)||[]).length === 6);
    ok('服务端·runAgent 调用 archiveBlock', /archiveBlock\(context\.archive\)/.test(proxy));
  } catch (err) { ok('archiveBlock 逻辑加载', false, err.message); }
}

function testP1P2Features() {
  section('P1/P2 · 校准 / 健康度 / 融合 / 分级');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // 提取一段纯函数源码（从起点到下一个函数定义前）
  function grab(startMark, nextMark) {
    const s = html.indexOf(startMark), e = html.indexOf(nextMark, s + 10);
    return (s >= 0 && e > s) ? html.slice(s, e) : null;
  }
  // Brier Score
  const brierSrc = grab('function brierStats(rows){', '/* P1-6 记忆健康度');
  if (brierSrc) {
    try {
      const sb = { DB:{L3B:[]}, Number, Math, Array, isFinite, console };
      vm.createContext(sb); vm.runInContext(brierSrc + '\n;globalThis.F=brierStats;', sb);
      ok('Brier·无结算返回空', sb.F([]).n === 0 && sb.F([]).score === null);
      const rows=[{prob:70,verdict:'成立'},{prob:70,verdict:'不成立'},{prob:85,verdict:'成立'}];
      const st=sb.F(rows);
      ok('Brier·计入 3 条已结算', st.n === 3);
      ok('Brier·分数在 0-1 之间', st.score >= 0 && st.score <= 1);
      ok('Brier·未结算/作废不计', sb.F([{prob:70,verdict:'未结算'},{prob:70,verdict:'作废'}]).n === 0);
      ok('Brier·分桶命中率', st.buckets.some(b=>b.label==='70%'&&b.rate===0.5));
    } catch (err) { ok('brierStats 逻辑加载', false, err.message); }
  } else ok('brierStats 源码可提取', false);

  // 健康度
  const healthSrc = grab('function healthStats(h){', '/* ---------- 4. AI 总控层');
  if (healthSrc) {
    try {
      const sb = { Date, Number, Math, Array, console,
        DB:{health:{drafts:10,commits:8,abandoned:2,recallHits:5,commitMs:4000,commitN:4,installed:Date.now()-10*864e5},
            L3A:[{ev:[{m:'L0',k:'x'}]}],L3B:[{}],L4A:[],L4B:[],C:[]} };
      vm.createContext(sb); vm.runInContext(healthSrc + '\n;globalThis.F=healthStats;', sb);
      const st=sb.F();
      ok('健康度·采纳率 8/10=80%', st.editRate === 80);
      ok('健康度·平均落盘 1 秒', st.avgSec === 1);
      ok('健康度·召回命中数', st.recallHits === 5);
      ok('健康度·证据完整率 50%', st.evidenceRate === 50);
    } catch (err) { ok('healthStats 逻辑加载', false, err.message); }
  } else ok('healthStats 源码可提取', false);

  // RRF 融合 + cosine
  const fuseSrc = grab('function fuseRecall(kw,sem){', '/* 组装上下文');
  const cosSrc = grab('function cosineLocal(a,b){', '/* RRF 融合');
  if (fuseSrc) {
    try {
      const sb = { Math, Array, Object, console };
      vm.createContext(sb);
      vm.runInContext((cosSrc||'')+'\n'+fuseSrc+'\n;globalThis.F={fuseRecall,cosineLocal};', sb);
      const F=sb.F;
      ok('融合·无语义时返回关键词', F.fuseRecall([{m:'L0',idx:0}],[]).length===1);
      ok('融合·两路合并去重', F.fuseRecall([{m:'L0',idx:0}],[{m:'L3B',idx:1}]).length===2);
      ok('融合·同一条去重', F.fuseRecall([{m:'L0',idx:0}],[{m:'L0',idx:0}]).length===1);
      if (F.cosineLocal) {
        ok('余弦·相同向量=1', Math.abs(F.cosineLocal([1,0],[1,0])-1)<1e-9);
        ok('余弦·正交向量=0', Math.abs(F.cosineLocal([1,0],[0,1]))<1e-9);
      }
    } catch (err) { ok('融合逻辑加载', false, err.message); }
  } else ok('fuseRecall 源码可提取', false);

  // 静态接线断言
  ok('P1-1 风险分级：低风险集合存在', /const LOW_RISK=new Set/.test(html));
  ok('P1-1 确认卡按风险分组', /p-group.*日常记录|日常记录 · 可一次勾选/.test(html));
  ok('P1-1 commit 读勾选子集', /boxes\.forEach\(b=>\{ if\(!b\.checked/.test(html));
  ok('P1-2 宽恕式回归入口', /graceForgiveMode\(\)/.test(html));
  ok('P1-2 顺延不删记录', /顺延 7 天 · 一条都没删/.test(html));
  ok('P1-3 L3-b 有 prob 字段', /\{k:'prob',l:'我有多确定/.test(html));
  ok('P1-4 L4 有反例字段', /failsWhen/.test(html) && /worksWhen/.test(html));
  ok('P1-5 版本元数据接纳', /supersedes.*conflictsWith|'supersedes','conflictsWith'/.test(html));
  ok('P2-1 领域切片接线', /data-dom/.test(html) && /domainRecords/.test(html));
  ok('P2-2 辅助视图接线', /setMapMode\('evidence'\)/.test(html) && /renderMatrixView/.test(html));
  ok('P2-3 体检简报接线', /cognitiveCheckup/.test(html) && /genCheckup/.test(html));
  ok('P2-4 默认关闭的 embed 开关', /WANJIE_EMBED === '1'/.test(fs.readFileSync(path.join(ROOT,'ai-proxy.js'),'utf8')));
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

function testValidateRules(html) {
  section('校验层 · 13 硬规则真实单元测试（validate 源码）');
  const s = html.indexOf('function validate(id,rec){');
  const e = html.indexOf('const GAPS', s);
  if (s < 0 || e < 0 || e <= s) { ok('validate 源码可提取', false); return; }
  const src = html.slice(s, e);
  const mocks = { L3A:0, L3B:0 };
  const sb = { count:(id)=>mocks[id]||0, Date, Math, JSON, console };
  try {
    vm.createContext(sb);
    vm.runInContext(src + '\n;globalThis.VALIDATE=validate;', sb);
  } catch (err) { ok('validate 源码加载', false, err.message); return; }
  const V = sb.VALIDATE;
  const errs = (id, rec) => V(id, rec).errors.join(' | ');

  // L0：字数硬拦 + 叙事词拒绝
  ok('L0 原因 >12 字被拦', /超过 12 字/.test(errs('L0', {reason:'因为昨天晚上没睡好今天状态特别差'})));
  ok('L0 原因 ≤12 字放行', errs('L0', {reason:'因为睡眠不足'}) === '');
  ok('L0 含「然后」被拦并提示归 D', /归 D 日记/.test(errs('L0', {reason:'因为然后就睡了'})));
  ok('L0 含「后来/接着」同样被拦', /归 D 日记/.test(errs('L0', {reason:'因为后来放弃了'})) && /归 D 日记/.test(errs('L0', {reason:'因为接着开会'})));

  // L2-W 来源
  ok('L2-W 无来源被拦', /来源/.test(errs('L2W', {title:'某制度'})));
  ok('L2-W 有来源放行', errs('L2W', {title:'某制度', source:'官网公告 2026-01'}) === '');

  // L3-b 三样齐
  ok('L3-b 三样全缺报 3 条', (errs('L3B', {claim:'会成'}).match(/缺/g)||[]).length === 3);
  ok('L3-b 三样齐放行', errs('L3B', {claim:'会成', due:'2027-01-01', metric:'看板完成项', opponent:'老张'}) === '');

  // L3-a 假设 + 验收
  ok('L3-a 缺假设被拦', /假设/.test(errs('L3A', {acceptance:'完成标准'})));
  ok('L3-a 缺验收标准被拦', /验收标准/.test(errs('L3A', {hypothesis:'拆小能启动'})));
  ok('L3-a 假设+验收齐放行', errs('L3A', {hypothesis:'拆小能启动', acceptance:'30 分钟内动笔', fact:'做了', interpret:'有效'}) === '');

  // L4 同类判例 ≥3
  mocks.L3A = 2; mocks.L3B = 2;
  ok('L4-a 同类 <3 被拦', /≥3/.test(errs('L4A', {trigger:'t'})));
  ok('L4-b 同类 <3 被拦', /≥3/.test(errs('L4B', {occasion:'o'})));
  mocks.L3A = 3; mocks.L3B = 3;
  ok('L4-a 同类 =3 放行', errs('L4A', {trigger:'t'}) === '');
  ok('L4-b 同类 =3 放行', errs('L4B', {occasion:'o'}) === '');

  // C 共识：残片 / 结论双档
  ok('C 残片缺三要素被拦', (errs('C', {tier:'残片'}).match(/残片缺/g)||[]).length === 3);
  ok('C 残片三要素齐放行', errs('C', {tier:'残片', at:'2026-01-01', proposer:'老张', occasion:'午休'}) === '');
  ok('C 结论出处 <2 被拦', /出处不足 2 个/.test(errs('C', {tier:'结论', sources:'L0-a', confirmedAt:'2026-01-01'})));
  ok('C 结论冷却 <7 天被拦', /冷却未满 7 天/.test(errs('C', {tier:'结论', sources:'L0-a,L1-b', confirmedAt:'2026-01-01', cooledAt:new Date(Date.now()-3*864e5).toISOString()})));
  ok('C 结论缺确认日被拦', /确认/.test(errs('C', {tier:'结论', sources:'L0-a,L1-b', cooledAt:new Date(Date.now()-8*864e5).toISOString()})));
  ok('C 结论条件齐放行', errs('C', {tier:'结论', sources:'L0-a,L1-b', confirmedAt:'2026-01-01', cooledAt:new Date(Date.now()-8*864e5).toISOString()}) === '');

  // INBOX 必回执
  ok('INBOX 待回执被拦', /回执/.test(errs('INBOX', {from:'外部Agent', text:'原文照录', receipt:'待回执'})));
  ok('INBOX 缺来信原文被拦', /原文/.test(errs('INBOX', {from:'外部Agent', receipt:'已回执'})));
  ok('INBOX 齐全放行', errs('INBOX', {from:'外部Agent', text:'原文照录', receipt:'已回执'}) === '');

  // L1 一次只改一句（文案已与代码对齐）
  ok('L1 多句被拦', /一句/.test(errs('L1', {text:'我重视自由。我也重视稳定。'})));
  ok('L1 分号并列被拦', /一句/.test(errs('L1', {text:'我重视自由；也重视稳定'})));
  ok('L1 单句放行', errs('L1', {text:'我重视可掌控的自由度'}) === '');

  // VERIFY 具名真人
  ok('VERIFY 空姓名被拦', /真人/.test(errs('VERIFY', {})));
  ok('VERIFY 具名放行', errs('VERIFY', {name:'老张'}) === '');
}

(async () => {
  console.log('\n\x1b[1m万界系统 · 自动化测试\x1b[0m');
  const html = await testSyntax();
  testStatic(html);
  testValidateRules(html);
  testAgentCore(html);
  testArchiveRecall();
  testP1P2Features();
  testProxyTools();
  testSample();
  try { await testServer(); } catch (e) { fail++; console.log('  \x1b[31m✗ 服务端测试异常:\x1b[0m ' + e.message); }
  try { await testHardening(); } catch (e) { fail++; console.log('  \x1b[31m✗ 加固测试异常:\x1b[0m ' + e.message); }
  console.log('\n' + (fail===0 ? '\x1b[32m' : '\x1b[31m') + '结果：' + pass + ' 通过 / ' + fail + ' 失败\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})();
