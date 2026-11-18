# 发布与推广实操手册

这份文档是给维护者看的：从零把项目开源到 GitHub，并让别人真的看到、用上。

---

## 一、推上 GitHub

```bash
cd wanjie

# 首次：配置身份（只做一次）
git config --global user.name "你的GitHub用户名"
git config --global user.email "你的GitHub注册邮箱"

# 初始化并首次提交
git init
git add .
git commit -m "feat: 万界系统 v1.0 首发开源"
git branch -M main
git remote add origin https://github.com/momoximing/wanjie-system.git
git push -u origin main
```

> 国内 push 失败多半是网络问题，配好代理重试即可，不是命令错了。

## 二、开在线体验地址（最关键）

本仓库已配好 `.github/workflows/pages.yml`，push 后只需手动点一次：

1. 仓库页 → **Settings** → 左侧 **Pages**
2. Build and deployment → Source 选 **GitHub Actions**
3. 等 1-2 分钟，地址生成：`https://momoximing.github.io/wanjie-system/`

以后每次 push 到 main 都会自动重新部署。在线版是纯静态前端 + localStorage，别人点开即可体验录入流程（不含服务端/模型网关，没有密钥风险）。

把这个链接填进 `README.md` 顶部的「在线体验」占位处，并替换截图链接里的 `你的用户名`。

## 三、仓库元信息（影响被搜到）

Settings → General 里填：

- **Description**：`从零记录的个人 Agent · 说话即录入 · 规则校验 · 你点头才落盘 · 本机 Docker + 模型中心`
- **Topics**（加号逐个加）：`agent` `knowledge-graph` `note-taking` `second-brain` `local-first` `docker` `chinese` `mind-map` `personal-knowledge-management`

README 顶部的徽章、截图链接里的 `你的用户名` 记得全部替换。

## 四、让别人看到（按性价比排序）

1. **知乎**（你正在做黑客松 S3，这是天然场景）：在参赛回答/文章里嵌在线 Demo 链接 + 一张图谱截图，讲"我做了个说话就能记、还会追问的系统"这类痛点故事，别贴代码。
2. **V2EX** → 分享创造节点；**少数派** / **掘金**：发一篇体验文，配在线地址。
3. **GitHub 社区**：给相关中文项目列表提 PR 收录；在看板/工具类的 awesome 列表里加自己。
4. 每个能发言的地方都带上在线 Demo 链接——**没有可点开的地址，基本没人会去 clone**。

## 五、确认有人看（看数据，不靠感觉）

| 想知道 | 去哪看 |
|---|---|
| 仓库有多少人点进 | 仓库页 → Insights → Traffic → Views（看 unique） |
| 多少人 clone 了 | 同上 → Clones |
| 多少人认可 | Star / Fork / Watching 数字，有 star 会收到通知 |
| 有没有人真在用 | Issues 里的提问 / PR |

在线 Demo 的访问量 GitHub 不统计。想要的话：接一个隐私友好的统计（Plausible / Umami），或最简单地——README 里写一句"帮到你就点个 Star"，用 star 数当代理指标。

**第一周参考线**：Views > 100、3-5 个 star、哪怕 1 个 issue，就算真的有人看了。前期冷很正常，主要靠第四步主动导流。

## 六、后续维护

- 每次功能改动更新 `CHANGELOG.md`，发 release 时打 tag（如 `v1.1.0`）。
- `.github/workflows/test.yml` 会在每次 push / PR 自动跑测试，绿了再合并。
- 收到 issue 及时回，哪怕只是"收到了，下版看"，活跃度直接影响留存。
