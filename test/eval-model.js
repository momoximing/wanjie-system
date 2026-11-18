#!/usr/bin/env node
/*
 * 模型效果评测 · 万界 Personal Agent
 * 用法：先 node ai-proxy.js（并在模型中心配好模型），再 node test/eval-model.js
 * 走真实 /chat 链路，用固定题集测四件事：
 *   1) 意图判断（chat / memory / record 三分流）
 *   2) 记忆写回（记住 → 确认 memWrite）
 *   3) 长上下文（前文注入是否生效）
 *   4) 延迟 / 工具调用
 * 只读评测，不写任何用户数据（草稿止于返回，不落库）。
 */
const http = require('http');

const PORT = process.env.PORT || 8787;
const HOST = '127.0.0.1';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host:HOST, port:PORT, path, method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data) } }, res => {
      let buf=''; res.on('data',c=>buf+=c); res.on('end',()=>{
        try { resolve(JSON.parse(buf)); } catch(e){ reject(new Error('返回不是 JSON: '+buf.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, ()=>req.destroy(new Error('超过 60 秒无响应')));
    req.end(data);
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host:HOST, port:PORT, path }, res => {
      let buf=''; res.on('data',c=>buf+=c); res.on('end',()=>{
        try { resolve(JSON.parse(buf)); } catch(e){ reject(new Error('返回不是 JSON')); }
      });
    });
    req.on('error', reject);
  });
}
const C = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', d:'\x1b[2m', x:'\x1b[0m', b:'\x1b[1m' };
const pad = (s,n) => { s=String(s); return s + ' '.repeat(Math.max(0,n-[...s].reduce((a,c)=>a+(c.charCodeAt(0)>255?2:1),0))); };

/* 固定题集：expect 是"正确答案"，用来给模型打分 */
const CASES = [
  { id:'E1', group:'意图', input:'最近工作有点累，但项目总算推起来了。',
    expect:'chat', check:r => r.ops.length===0 ? 'chat' : (r.memWrite?'memory':'record') },
  { id:'E2', group:'意图', input:'记住：我叫林墨，在做一个认知系统。',
    expect:'memory', check:r => r.memWrite?'memory':(r.ops.length?'record':'chat') },
  { id:'E3', group:'意图', input:'日记：今天把 Agent 骨架跑通了，挺顺。',
    expect:'record', check:r => r.ops.length?'record':(r.memWrite?'memory':'chat') },
  { id:'E4', group:'记忆', input:'记住：我最在意的是自由度，讨厌被安排。',
    expect:'memWrite', check:r => r.memWrite ? 'memWrite' : 'none' },
  { id:'E5', group:'记忆', input:'你现在知道关于我的什么？',
    expect:'recall', setup:'mem', check:r => /自由|林墨|认知/.test(r.reply||'') ? 'recall-ok' : 'recall-miss' },
  { id:'E6', group:'上下文', input:'我们刚才说的是哪三件事？',
    expect:'context', setup:'ctx', check:r => /押注|复盘|日记|认知|自由/.test(r.reply||'') ? 'ctx-ok' : 'ctx-miss' }
];

/* 每轮请求复刻前端 buildContext 的结构：system + 工作记忆 + 摘要 + 最近消息 */
function makeMessages(c) {
  const mem = '【你对他的了解，每轮都可见】\nuser: ' +
    (c.setup==='mem' || c.setup==='ctx' ? '林墨在做认知系统；最在意自由度，讨厌被安排。' : '（暂无）');
  const history = c.setup==='ctx'
    ? [ {role:'user',content:'记一下今天的三件事：写完押注框架、复盘了上周、记了条日记。'},
        {role:'assistant',content:'好，我留意到了这三件。'} ]
    : [];
  return {
    messages: history.concat([{ role:'user', content:c.input }]),
    system: '你是「万界」——帮用户把想法沉淀成认知系统的 Personal Agent。\n'+
      '聊天就好好聊，别每句都往记录上引。只有用户明确要记一件事、或确有值得长期保存的事实时，'+
      '才用工具起草（草稿要用户点头才写入）。\n\n'+mem,
    tools: [
      { name:'wanjie.add_d', description:'写入日记', inputSchema:{type:'object',properties:{text:{type:'string'}}} },
      { name:'wanjie.add_l3b', description:'写入押注', inputSchema:{type:'object',properties:{claim:{type:'string'}}} },
      { name:'wanjie.remember', description:'写一条长期记忆。block 取 user/persona/openLoops，value 为内容。',
        inputSchema:{type:'object',properties:{block:{type:'string'},value:{type:'string'}},required:['block','value']} },
      { name:'wanjie.recall', description:'读工作记忆', inputSchema:{type:'object',properties:{}} }
    ],
    context:{ today:new Date().toISOString().slice(0,10), counts:{}, memory:{user:'林墨在做认知系统；最在意自由度'} },
    intent:'auto'
  };
}

(async () => {
  console.log('\n'+C.b+'万界 · 模型效果评测'+C.x+'  （只读，不写用户数据）\n');
  let h;
  try { h = await get('/health'); }
  catch(e){ console.log(C.r+'连不上本机网关：'+e.message+C.x+'\n请先运行  node ai-proxy.js\n'); process.exit(1); }
  const models = await get('/models').catch(()=>({ models:[] }));
  if(!models.models || !models.models.length){
    console.log(C.y+'模型中心还没配模型。'+C.x+'评测需要真模型（本地规则引擎测不出语义能力）。');
    console.log('请打开网页 → 设置 → 模型中心 → 添加 DeepSeek，填入 API key 后重跑。\n');
    process.exit(2);
  }
  const target = process.argv[2] || models.defaultId || models.models[0].id;
  const chosen = models.models.find(m=>m.id===target) || models.models[0];
  console.log('评测模型：'+C.b+(chosen.name||chosen.model)+C.x+'   题目数：'+CASES.length+'\n');

  const rows=[]; let score=0;
  for(const c of CASES){
    const t0=Date.now();
    let r, err='';
    try { r = await post('/chat', Object.assign({ modelId:chosen.id }, makeMessages(c))); }
    catch(e){ err=e.message; r={ reply:'', ops:[], notes:[] }; }
    const ms=Date.now()-t0;
    if(err) err='网关错误';
    const got = err ? 'ERR' : c.check(r);
    const hit = (c.expect==='chat'&&got==='chat') || (c.expect==='memory'&&got==='memory') ||
      (c.expect==='record'&&got==='record') || (c.expect==='memWrite'&&got==='memWrite') ||
      (c.expect==='recall'&&got==='recall-ok') || (c.expect==='context'&&got==='ctx-ok');
    if(hit) score++;
    rows.push({ id:c.id, group:c.group, expect:c.expect, got, hit, ms, err,
      tools:(r.tools||[]).join(','), reply:String(r.reply||'').slice(0,40).replace(/\n/g,' ') });
    console.log('  '+(hit?C.g+'✓':C.r+'✗')+C.x+' '+pad(c.id,4)+pad(c.group,6)+
      '判='+pad(got,10)+C.d+pad(ms+'ms',8)+C.x+(r.tools&&r.tools.length?C.d+'['+r.tools.join(',')+']'+C.x:''));
  }
  console.log('\n'+C.b+'结果：'+score+' / '+CASES.length+' 通过'+C.x+'  '+
    (score===CASES.length?C.g+'意图与记忆链路完整':score>=4?C.y+'基本可用，个别场景需调提示词':C.r+'该模型不适合做本系统的 Agent')+C.x+'\n');
  console.log(C.d+'完整回复（前 40 字）已列于上。逐题细看可用浏览器对话框手动复测。'+C.x+'\n');
  process.exit(score===CASES.length?0:1);
})();
