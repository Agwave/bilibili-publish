# bilibili-publish

把 [`game-wind`](../game-wind) 的每日游戏榜单日报视频自动投稿到 B 站。

game-wind 那边「只做生成，不涉及投稿」——B 站没给个人 UP 主开放投稿 API。这个项目用
Playwright 驱动真实浏览器，把「开创作中心 → 拖文件 → 填标题简介标签分区 → 裁封面 → 点投稿」
这一串手工操作自动化掉。

## 架构：代码在 WSL2，浏览器在 Win11

```
        WSL2 (Linux)                              Win11
┌────────────────────────────────┐   CDP     ┌─────────────────────────────┐
│ bilibili-publish/              │  :9222    │ Edge                        │
│  Node + Playwright             │──────────▶│  --remote-debugging-port    │
│  读 /home/.../<date>.mp4       │ 127.0.0.1 │  --user-data-dir=           │
│      ↓ 字节流                  │           │    C:\Users\<你>\           │
│  Playwright 驱动填表            │           │      bilibili-publish\      │
└────────────────────────────────┘           │      profile  ← 登录态存这   │
                                             └─────────────────────────────┘
```

两个关键点，都是实测确认过的：

1. **WSL2 与 Win11 共享 localhost。** 前提是 `.wslconfig` 里有 `networkingMode=mirrored`
   （Windows 11 22H2+）。这时 `127.0.0.1:9222` 从 WSL2 直达 Windows 上的浏览器；
   反过来用网关 IP（`ip route` 里那个）是**不通**的。
2. **传文件要传 Linux 路径。** Playwright 的驱动进程在 WSL2，它按 Linux 路径 stat 文件、
   再把字节流送给 Windows 上的浏览器。传 `C:\...` 会 `ENOENT`，传 `/home/...` 反而可行
   ——所以视频不必往 C 盘拷。

浏览器 profile 必须落在 Windows 能看到的文件系统上（默认 `C:\Users\<你>\bilibili-publish\profile`），
Windows 进程读不了 ext4 上的 WSL 路径。Chrome/Edge 136+ 禁止在默认 profile 上开远程调试端口，
所以必须用独立目录——好处是登录态存在里面，扫一次码能管 7 天。

## 用法

```bash
npm install

node cli.js doctor                    # 自检：素材、ffmpeg、浏览器、登录态
node cli.js login                     # 扫码登录（只需一次，会弹 Edge 窗口）
node cli.js probe                     # 探投稿页 DOM（选择器失效时用）
node cli.js upload --dry-run          # 只填不投：填完停在提交前 + 截图
node cli.js upload                    # 真投稿
node cli.js upload --date 2026-09-30
```

不传 `--date` 就取 game-wind 最新快照（对齐 `make_video.sh` 的取法）。
**默认就是真投稿**（无人值守用）；改选择器或元数据时**先加 `--dry-run` 验证**，
停在提交前并截图，避免选择器写错把垃圾内容发出去。

## 元数据从哪来

`game-wind/data/reports/<date>.video.json` 里没有任何现成的标题/简介/标签/分区字段，
全部由 `src/metadata.js` 合成。文案刻意与视频内一致，常量抄自
`game-wind/tools/video/render.js`：

| 字段 | 来源 |
|---|---|
| 品牌名 | `render.js:130` 的 `BRAND` |
| 日期格式 | `render.js:134-137` 的 `fullDate()`，`2026-10-01` → `2026.10.01` |
| 概况文案 | `render.js:210-215` 的 `titleStat()`，`畅销榜 33 条重大变化，8 家公司` |
| 免责声明 | `render.js:220-221` 的 `DISCLAIMER` |

改这些措辞时两边要一起改。

- **标题** ≤80 字符：`游戏投资榜单快报 2026.10.01｜畅销榜 33 条重大变化，8 家公司`
- **简介** ≤2000 字符：`data/reports/<date>.md` 全文有 3100~3700 字符，**超限不能用**，
  所以用 spec 重新渲染精简版；超限时按条数动态裁剪（先砍每家公司的条数，再砍公司数）
- **标签** ≤10 个：`tagsFixed` 里放固定词；**不足 10 个时**，才会按「变化条数」降序
  补公司名、按幅度补游戏名。填满 10 个固定就不再有动态标签，每天完全一致
- **分区**：`config.json` 的 `publish.tid`，值是**分区名**（如 `游戏`），不是数字 tid
- **创作声明**：`config.json` 的 `publish.statement`，我们选「个人观点，仅供参考」，
  和视频片尾那句免责声明对得上
- **封面**：抽视频第 0 帧，**不裁切**（原因见下）

### 标签是怎么选的

`tagsFixed` 里那 10 个**基本都是从 B站 投稿页自己的「推荐标签」行里挑的**——B站 会按
当天的标题和简介生成一批推荐标签，那些是它认为在这个内容领域有流量的。把那行 dump 出来
对照着挑，比凭空想有效。实测两次投稿时 B站 的推荐（按出现顺序）：

```
10-01: 游戏杂谈 | 游戏推荐 | 手游情报 | 榜单 | 游戏投资 | 公司 | 腾讯投资
       游戏行业 | 游戏公司 | 三七互娱 | 网易投资 | 世纪华通
09-30: 游戏杂谈 | 游戏推荐 | 手游情报 | 游戏投资 | 快报 | 游戏 | 公司 | 榜单
       游戏行业 | 游戏排行榜 | 手游 | 三七互娱 | 腾讯控股 | 哔哩哔哩 | 网易 | 完美世界
```

挑的时候有两个判断：

- **没选排最前的 `游戏杂谈` / `游戏推荐`。** 它们出现频次最高、流量多半也最大，但那是
  娱乐向游戏的标签，与商业分析频道调性不符，吸来的观众不精准。频道本来就偏
  「行业 / 公司 / 投资」，选同方向的更稳。
- **没选 `游戏流水`。** 它既不在 B站 推荐里，也和内容对不上——全片只有名次数据
  （字段仅 `rank`/`prev`/`delta`），**没有任何流水数值**。game-wind 当初正是因为这个把
  品牌从「游戏投资流水快报」改成了「游戏投资榜单快报」。挂这个标签会把想看营收的人
  引进来然后掉头就走。

要换标签改 `config.json` 的 `publish.tagsFixed` 即可。**保持 10 个**就不会有动态补充；
减到 10 个以下，代码会按「变化条数」降序自动补公司名。

### 封面比例：B站已经改了，别再按 16:10 裁

game-wind 的 README 是按「B站封面是 16:10」设计的，但 2026-10 实测 B 站已改成
**双比例**，而且两种比例的处理方式不同（对上传图做的像素级实测）：

| B站输出 | 比例 | 处理方式 |
|---|---|---|
| 首页推荐封面 | **4:3** | 等比缩放后**裁切填满**，取中央 4:3 区域 |
| 个人空间封面 | **16:9** | 整图**加黑边**（contain） |

所以**上传完整的 1920×1080 第 0 帧是最优解**：4:3 裁中央 1440px，内容 1320px 两侧各留
60px；16:9 完整显示，正好是片头原貌。反之若预先裁成 16:10，4:3 边距只剩 39px，
16:9 还要加黑边——两头都更差。这条路径保留在 `cover.js` 的 `crop16x10` 选项里，
只用于对比验证，正常不要开。

## 配置

`config.json`：

```jsonc
{
  "gamewindPath": "~/ai-project/game-wind",   // 支持 ~ 展开；也可用 GAMEWIND_PATH 环境变量覆盖
  "browser": { "cdpPort": 9222, "prefer": "edge" },
  "publish": {
    "tid": "游戏",                    // 分区名（不是数字 id），30 个可选值见 selectors.js 的 TID_OPTIONS
    "statement": "个人观点，仅供参考",  // 创作声明，6 个可选值见 STATEMENT_OPTIONS
    "copyright": 1,                   // 1=原创 2=转载
    "tagsFixed": ["游戏投资", "手游", "游戏排行榜", "游戏行业"],
    "maxTags": 10,
    "uploadTimeoutMs": 600000         // 等表单出现的上限
  }
}
```

环境变量 `GAMEWIND_PATH` 可临时覆盖仓库路径。

## 投稿页实测结构（2026-10-01 验证）

公开资料里的写法**基本都过时了**。实测当前版本（`bcc-*` 打底 + Vue）：

| 项目 | 公开资料里的写法 | 当前实际 |
|---|---|---|
| 文件输入 | 在 `iframe[name="videoUpload"]` 里 | **就在主文档**，`div.bcc-upload-wrapper input[type=file]` |
| 分区 | 两级 tid 级联 | **单层扁平**，30 个选项（`div.video-human-type div.select-controller` → `p.item-cont-main`） |
| 创作声明 | 不存在 | **必填下拉**，6 个选项，不选投稿按钮点不动 |
| 封面上传 | `bre-settings__coverbox__img__icon` | `div.cover-module-main span.add-text` → 弹窗 `div.cover-upload input[type=file]` |

六个反直觉的坑，都已在代码里处理：

1. **标题会被自动预填成文件名**（`2026-10-01`）。不清空就会和真标题拼在一起。
2. **标签会被预置 3 个**（按默认分区给，实测 `生活记录/学习/记录`）。标签上限 10，
   不清掉的话我们自己的 10 个只能进去 7 个，**而且不会报错**——B站静默丢弃。
   所以 `fillTags` 会先清空、再逐个添加、最后**核对实际集合**。
3. **页面上有 3 个 `input[type=file]`**（视频 / 字幕 `.txt` / 压缩包 `.zip`），
   还有个 `accept=".txt"` 的字幕输入。不能取「第一个」，要按 `accept` 过滤（见 `src/dom.js`）。
4. **简介是 Quill 编辑器**，页面上有 2 个 `ql-editor`（另一个是「粉丝动态」），
   必须限定 `div.desc-container` 容器。另外 `.ql-editor` 是 `white-space: pre-wrap`，
   `innerText` 读数会比原文长，比对时要去掉空白。
5. **别从页面 HTML 正则捞 bvid。** 页面上混着推荐位等无关的 BV 号，实测会捞到错的那个
   （2026-10-01 首次投稿就存了个错 bvid `BVHgBzVhbcto`，实际是 `BV1pBaz6aEjY`）。
   可靠做法是投稿后查创作中心稿件列表接口、按标题认领。
6. **有些标签手打加不上，必须点 B站 的推荐 chip。** 实测「手游情报」在输入框里打完按回车
   **无事发生**——不加、不报错，输入框还会被清空，看起来像成功。但点 `div.hot-tag-item`
   里它自己的推荐 chip 就能加上（多半是活动标签，只认自己的入口）。
   所以 `fillTags` 的策略是：**先找推荐 chip 点，没有再退回手打**。

顺带一提：B站现在**允许先投稿、后传完**（页面原话「不需要等待上传完成」），
所以流程不等转码，只等表单出现。

另外，实测所有稿件的底层分区都是 **tid=65**（分区名显示为「游戏」）——自动流程选的
和手工投的那几版一致。

## 定时自动投稿

已接在 game-wind 出片任务后面：

```cron
# bilibili-publish：日报视频自动投稿到B站（接在 game-wind 8:10 出片之后）
15 8 * * * cd /path/to/bilibili-publish && ./scripts/cron_upload.sh >> logs/cron.log 2>&1
```

`scripts/cron_upload.sh` 做三件事，都是 cron 环境特有的坑：

1. **自己找 node。** cron 不加载 shell 配置，PATH 里没有 nvm。脚本按版本号排序取最新的
   （`sort -V`，别用字典序——`v20` 会排在 `v24` 前面）。
2. **等出片。** 8:10 的出片任务可能还没跑完，脚本最多等 10 分钟
   （`WAIT_SECS` 可调），而不是直接失败。
3. **幂等。** 有 `publish.json` 就直接退出，不会重复投稿。

脚本支持三个环境变量，都只在手动调试时用（cron 里不设）：

| 变量 | 作用 |
|---|---|
| `DATE=2026-09-30` | 覆盖自动推导的日期 |
| `DRY_RUN=1` | 只填不投，停在提交前，**不产生稿件也不写投稿记录** |
| `WAIT_SECS=0` | 不等出片，没有就立刻失败 |

拿历史日期试跑整条脚本链路（安全，不会投稿）：

```bash
DRY_RUN=1 DATE=2026-09-30 ./scripts/cron_upload.sh
```

实测这一步会完整走一遍「推导日期 → 等视频 → 上传 → 填标题/简介/创作声明/分区/标签/封面」，
约 33 秒（6.6MB 的片子），然后停在提交前。改完脚本用它自测，再让 cron 去跑真投稿。

> **前提**：WSL2 要常开，否则到点不触发。game-wind 的 README 里记了 WSL 的 cron 常驻办法。

## 投稿记录与幂等

投稿成功后会在 `game-wind/data/videos/<date>.publish.json` 写一条记录（含 bvid）。
下次跑同一个日期会直接拒绝，避免重复投稿。要重投就删掉那个文件。

> **已知盲区**：这个检查只认我们自己写的记录，**看不到手工投的稿**。
> 2026-10-01 就踩过：当天中午手工投过一版，下午自动流程又投了一版，号上出现了两份同日期稿件。
> 如果手工投稿的习惯还保留着，要么改成只走自动流程，要么在投稿前先去创作中心确认一下。

## 排障

**选择器失效是最大的风险。** B 站创作中心改过不止一次 DOM（公开项目里能看到
`bre-*` → `vui_*` 的迁移，以及反复的「修复封面上传」「新增创作声明步骤」补丁）。
所有选择器集中在 `src/selectors.js`，每个都给多个候选按序尝试。

症状是「卡在某一步直到超时」。处理办法：

```bash
node cli.js probe           # 重新 dump 页面结构 + 截图
```

产物在 `artifacts/probe-<时间戳>/`，含截图、HTML、元素清单（输入框/按钮/下拉/弹窗）、
iframe 列表、class 前缀统计。对着它改 `selectors.js` 即可。

任何一步失败都会把截图和 HTML 存到 `artifacts/upload-<日期>-<时间戳>/`，**并且不关浏览器**，
方便你直接看现场。

| 症状 | 原因与处理 |
|---|---|
| `等了 30s 浏览器还没在 9222 端口上监听` | 该 profile 已被另一个浏览器窗口占用。关掉那个窗口，或删掉 profile 目录里的 `SingletonLock` |
| 被重定向到 passport | 登录态过期（SESSDATA 只有 7 天），重跑 `node cli.js login` |
| `读不出视频分辨率` / ffmpeg 无输出 | `chmod +x node_modules/ffmpeg-static/ffmpeg`（代码里有自愈，但中断重装后可能仍需要） |
| 卡在「等表单出现」 | 转码慢，或文件输入框的选择器失效 |
| 投稿按钮一直不可点 | 还在转码，代码会等最多 5 分钟 |

### 备选方案

`connectOverCDP` 的官方文档说它 "significantly lower fidelity"（比 Playwright 自己的
协议连接保真度低）。实测上传、填表、传文件都正常，但万一后续交互出问题，可以退到
**在 Win11 上原生跑 Playwright**：装个 Windows 版 Node，代码基本不用改，
只把 `src/browser.js` 里的 `connectOverCDP` 换成 `chromium.launch()`。
视频文件届时要从 WSL 侧的 `/home/...` 换成 Windows 能读的路径。
