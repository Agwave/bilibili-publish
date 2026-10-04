# AGENTS.md — 本仓库对 AI 助手的工作要求

## 1. 每次改完代码，必须依次完成以下检查（禁止跳过）

```bash
# 1. 语法检查（全量，新增文件别忘了加进来）
for f in cli.js src/*.js; do node --check "$f" || exit 1; done

# 2. 自检：素材、ffmpeg、浏览器桥接、登录态
node cli.js doctor
```

本仓库**没有配 linter，也没有测试框架**。语法检查只能挡住笔误，真正的回归风险在
**投稿页选择器失效**——那是页面改版导致的，语法检查永远发现不了。所以：

> **改动涉及 `selectors.js` / `uploader.js` / `dom.js` / `browser.js` 时，收尾必须再跑一次
> `node cli.js upload --date <最近日期> --dry-run`**，看它能不能一路填到「停在提交前」。
> 这是本仓库唯一的真集成测试，等价于 game-wind 里的 `go test ./...`。

注意 `--dry-run` 会**真的上传一个视频**到创作中心（只是不提交），会留下草稿。

### 3. 涉及系统集成时，还要在「cron 环境」里再验一次

**普通终端跑通 ≠ cron 里跑通。** cron 的 PATH 只有 `/usr/bin:/bin`，
**没有 Windows 互操作路径**——那些是 WSL 给交互式终端加的。2026-10-04 早上的定时投稿
就是这么挂的：代码在终端里好好的，cron 里报 `spawn powershell.exe ENOENT`。

所以凡是碰了「调外部程序」的改动，用同款环境复验：

```bash
# 快：只验能不能起浏览器、连 CDP、认登录态
env -i HOME="$HOME" PATH=/usr/bin:/bin "$(ls -d $HOME/.nvm/versions/node/*/bin/node | sort -V | tail -1)" cli.js doctor

# 全：连脚本逻辑一起验，走完整链路但不投稿
env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c 'DRY_RUN=1 DATE=<最近日期> ./scripts/cron_upload.sh'
```

**别只测「已投过跳过」那条分支**——它会在碰到系统调用之前就退出，等于什么都没验
（这就是上面那个 bug 溜过去的原因）。要让它真正走到打开浏览器那一步。

规则：调用外部程序的**一律写绝对路径**（`powershell.exe` 走 `resolvePowershell()`，
ffmpeg 走 `ffmpeg-static`）。PATH 查找只在交互式终端下成立。

改动只在 `metadata.js` / `cover.js` 这类不碰页面和系统集成的模块时，跑 doctor + 肉眼核对即可。

## 2. Git commit message 格式

首行：`[改动类型](改动核心模块): 细节描述`

**改动类型**（常用）：`feat` `fix` `perf` `chore` `test` `refactor` `docs` `style` `build` `revert`

**核心模块**：`browser`（浏览器桥接）`login`（登录）`dom`（元素定位）`gamewind`（仓库对接）
`metadata`（元数据合成）`cover`（封面抽帧）`selectors`（选择器）`probe`（DOM 探针）
`uploader`（投稿流程）`cli`（命令行）`cron`（定时）`config`（配置）`docs`（文档）

**规则**：
- 首行简洁，说清楚"改了什么、为什么"
- 单次改动内容较多时，首行之后空一行，用「- 」短横线分点列出
- 尾注 `Co-Authored-By: Claude <noreply@anthropic.com>`
- **改选择器时必须写清 B站当时的页面形态**——否则下次改版时无从判断旧值是靠什么命中的

示例：

```
[fix](selectors): 标签超限静默丢弃导致漏标，改为先清空再逐个核对

- 页面加载时 B站按默认分区预置 3 个标签（实测 生活记录/学习/记录），
  占掉 10 个上限里的 3 个；原先日志谎报「10/10 成功」，实际只进去 7 个
- 改为一、清空预置标签，二、逐个添加并检查 chip 数是否增加，
  三、最后比对实际集合与预期集合的差集
```

```
[docs](cron): 补 AGENTS.md，固化检查流程与选择器维护约定
```

## 3. 注释写法

本仓库的注释**只写"为什么"和"坑在哪"**，不写"是什么"。判断标准：把注释盖住，
代码本身应该已经说明了它在做什么；注释要说明的是**为什么非这么写不可**。

**要写的**：

- **反直觉的取舍**。例：`browser.js` 里为什么用 PowerShell 的 `Start-Process`
  而不是直接 spawn —— 因为前者拉起的进程能活过 WSL 命令的生命周期。
- **别人踩过的坑**。例：`cover.js` 里为什么不做预裁切，附上实测的裁切/加边数据。
- **外部依赖的出处**。抄或对齐别的仓库时标明位置，例如
  `BRAND` 抄自 `game-wind/tools/video/render.js:130`，
  `ListDates` 对齐 `internal/store/store.go:56-74`。这样上游改了能对上。
- **模块头**：这个文件负责什么、关键取舍是什么。多文件协同时（如 `dom.js`
  被 `uploader.js` 和 `probe.js` 共用）要点明共享原因。

**不要写的**：`// 设置标题`、`// 循环遍历数组`、`// 返回结果` 这类复述代码的注释；
也不要用注释掉的方式留死代码。

行内注释用 `//`，块注释用 `/** */` 只出现在文件头和导出函数上。

## 4. 架构要点（改代码前必读）

**代码跑在 WSL2，浏览器跑在 Win11，两者用 CDP 通信。** 这不是随便选的，两个前提
缺一不可，动 `browser.js` 前必须知道：

1. 能连通靠的是 `~/.wslconfig` 里的 `networkingMode=mirrored`（WSL2 与 Win11 共享
   localhost）。改用网关 IP 是不通的。
2. **传文件必须传 Linux 路径**。Playwright 的驱动进程在 WSL2，它按 Linux 路径 stat
   文件再把字节流送过去；传 `C:\...` 会 `ENOENT`。所以视频可以一直待在 WSL 文件系统里。

浏览器 profile 必须在 C 盘（Windows 进程读不了 ext4 路径），登录态就存在那里。

## 5. 页面相关的铁律

投稿页 DOM 改过不止一次，公开资料里的写法**基本都过时了**。完整版见 README 的
「投稿页实测结构」，这里只列动手前必须记住的：

- **所有选择器只写在 `src/selectors.js`**，不许散落到 `uploader.js`。失效时用
  `node cli.js probe` 重新 dump 页面结构（截图 + HTML + 元素清单）再改。
- **标签三件事**：①先清空预置的（B站 按默认分区塞 3 个，占掉上限）；②加的时候**优先点
  B站 的推荐 chip（`div.hot-tag-item`），没有再手打**——实测「手游情报」手打无效且不报错；
  ③最后核对实际集合。超限和手打无效都是**静默**的，不核对就会谎报成功。
- **改标签配置后必须跑一次 dry-run 验证 B站 收不收**。标签可见性只有页面说了算，
  代码里推不出来的。
- **bvid 不许从页面 HTML 正则捞**，页面上混着推荐位的 BV 号，实测捞错过。查稿件列表接口按标题认领。
- **封面不许预裁切**，B站按 4:3 裁、按 16:9 加边，上传完整帧才是最优解（数据见 README）。
- 元数据文案与视频内文案要一致，常量抄自 game-wind 的 `render.js`，改一处要两处一起改。

## 6. 定时任务

每天 8:15 由 `scripts/cron_upload.sh` 自动投稿，接在 game-wind 8:10 出片之后。
改这个脚本时注意 cron 环境的三个坑（脚本注释里写了）：PATH 里没有 nvm、
出片可能还没跑完、以及必须幂等。

**登录态只有 7 天有效期**，所以大约**每周要人工扫一次码**。这是本工具目前最大的运维负担。

过期的判定很精确——B站 把 `SESSDATA` / `bili_jct` / `DedeUserID` 三个 cookie 设成同一个
到期时刻，且与登录时刻的**时分秒完全相同**（实测 10-01 15:21 登录 → 10-08 15:21 过期）。
想看还剩多久：

```bash
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const c=await b.contexts()[0].cookies(['https://www.bilibili.com']);const s=c.find(x=>x.name==='SESSDATA');console.log(new Date(s.expires*1000).toLocaleString('zh-CN'),'剩',((s.expires*1000-Date.now())/86400000).toFixed(2),'天');await b.close()})()"
```

或直接 `node cli.js doctor`（剩 ≤3 天会告警）。

过期后定时任务会失败，`logs/cron.log` 里有明确提示（不会静默失败），需要重跑
`node cli.js login` 扫码。
