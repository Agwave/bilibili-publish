'use strict';
/**
 * uploader.js — 投稿主流程
 *
 * 顺序：幂等检查 → 生成元数据 → 抽封面 → 打开投稿页 → 传视频 → 等表单
 *       → 标题 → 简介 → 创作声明 → 分区 → 标签 → 封面 → 提交 → 记 bvid
 *
 * 三条硬规矩：
 *   1. 任何一步失败都截图 + 存 HTML 到 artifacts/，并且**不关浏览器**——留着现场好排查；
 *   2. 不传 --submit 就停在提交前（默认安全），调试选择器时不会误发；
 *   3. 已投过的日期直接拒绝，避免重复投稿。
 *
 * 页面行为上的三个坑（实测）：
 *   - 标题会被自动预填成文件名（"2026-10-01"），不清空就会和真标题拼在一起；
 *   - 「创作声明」是必填下拉，漏了它投稿按钮点不动；
 *   - 封面编辑器点「完成」会弹「16:9 封面未修改」同步确认框，不答它编辑器就不关，
 *     残留的遮罩把「立即投稿」挡死（2026-10-09 的失败原因）。见 setCover。
 */

const fs = require('fs');
const path = require('path');
const { ensureBrowser, getPage } = require('./browser');
const { sessionInfo } = require('./login');
const { find, findFileInput, describeFileInputs } = require('./dom');
const S = require('./selectors');
const notify = require('./notify');

// ---------------------------------------------------------------- 小工具

function makeArtifacts(cfg, date) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(
    process.cwd(),
    (cfg.publish && cfg.publish.artifactsDir) || 'artifacts',
    `upload-${date}-${stamp}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 出错时留证据。存证本身失败不能盖掉原始错误。 */
async function capture(page, dir, label) {
  try {
    await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(dir, `${label}.html`), await page.content(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 在下拉里点一个精确文本匹配的选项 */
async function pickOption(page, optionSelector, text, log, label) {
  const opt = page.locator(optionSelector, { hasText: new RegExp(`^\\s*${text}\\s*$`) }).first();
  await opt.waitFor({ state: 'visible', timeout: 8000 });
  await opt.scrollIntoViewIfNeeded();
  await opt.click();
  await page.waitForTimeout(600);
  log(`${label}: ${text}`);
}

// ---------------------------------------------------------------- 各步骤

async function openUploadPage(page, log) {
  log('打开投稿页……');
  await page.goto(S.uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  if (page.url().includes('passport.bilibili.com')) {
    throw new Error('未登录（被重定向到 passport）。先跑 `node cli.js login` 扫码。');
  }
}

async function uploadVideo(page, videoPath, cfg, log) {
  const sizeMB = (fs.statSync(videoPath).size / 1048576).toFixed(1);
  const input = await findFileInput(page, 'video');
  if (!input) {
    const d = await describeFileInputs(page);
    throw new Error(
      '找不到视频文件输入框。当前页面上的 input[type=file]：\n' +
        d.map((x) => `  ${x.where} accept=${x.accept} name=${x.name}`).join('\n')
    );
  }
  log(`投喂视频 ${path.basename(videoPath)} (${sizeMB} MB) → ${input.where}`);
  await input.loc.setInputFiles(videoPath);

  // 表单出现（能定位到标题输入）就说明文件已接收、可以开始填了。
  // B站明说「不需要等待上传完成即可投稿」，所以这里不等转码。
  const timeout = (cfg.publish && cfg.publish.uploadTimeoutMs) || 600000;
  const deadline = Date.now() + timeout;
  let lastLog = 0;

  while (Date.now() < deadline) {
    const title = await find(page, S.title, 1200);
    if (title) {
      log('表单已出现（文件已接收，可开始填写）');
      return title;
    }
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
      const pct = /(\d{1,3})%/.exec(txt);
      log(`  ${pct ? `上传中 ${pct[1]}%` : '等待表单出现'}……`);
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    `上传后等了 ${Math.round(timeout / 60000)} 分钟还没出现标题输入框。跑 probe 确认选择器是否失效。`
  );
}

async function fillTitle(page, titleLoc, title, log) {
  // 先清空——页面会把文件名预填进来
  const prefilled = await titleLoc.inputValue().catch(() => '');
  if (prefilled) {
    await titleLoc.click();
    await titleLoc.press('Control+A');
    await titleLoc.press('Delete');
    await page.waitForTimeout(300);
    log(`清掉了预填的标题: "${prefilled}"`);
  }
  await titleLoc.fill(title);
  await page.waitForTimeout(500);

  let got = await titleLoc.inputValue().catch(() => '');
  if (got !== title) {
    // 受控组件偶尔吞输入，退回逐字符敲
    await titleLoc.click();
    await titleLoc.press('Control+A');
    await titleLoc.press('Delete');
    await titleLoc.type(title, { delay: 40 });
    got = await titleLoc.inputValue().catch(() => '');
  }
  if (got !== title) {
    throw new Error(`标题没填对：期望 "${title}"，实际 "${got}"`);
  }
  log(`标题 (${got.length}/${S.titleMaxLen}): ${got}`);
}

async function fillDesc(page, desc, log) {
  const hit = await find(page, S.desc);
  if (!hit) throw new Error('找不到简介编辑器（div.desc-container 里的 ql-editor）');
  await hit.loc.click();
  await hit.loc.fill(desc);
  await page.waitForTimeout(600);

  // 比对时忽略空白：Quill 把每个换行变成 <p>，而 .ql-editor 是 white-space: pre-wrap，
  // innerText 会把块级换行和源文本换行叠加，字数看着比原文多，但内容其实是对的。
  const squash = (s) => s.replace(/\s+/g, '');
  let got = await hit.loc.innerText().catch(() => '');
  if (squash(got).length < squash(desc).length * 0.9) {
    // Quill 对 fill 偶尔不买账，退回键盘输入
    await hit.loc.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type(desc, { delay: 1 });
    await page.waitForTimeout(800);
    got = await hit.loc.innerText().catch(() => '');
  }
  if (!squash(got).length) throw new Error('简介没填进去');
  const same = squash(got) === squash(desc);
  log(`简介: ${squash(got).length} 字${same ? '（与预期一致）' : `（与预期有差异：预期 ${squash(desc).length}）`}`);
}

async function fillStatement(page, text, log) {
  const trigger = await find(page, S.statementTrigger);
  if (!trigger) {
    log('! 找不到创作声明下拉，跳过（投稿按钮可能会因此不可点）');
    return false;
  }
  await trigger.loc.click();
  await page.waitForTimeout(1200);
  await pickOption(page, S.statementOptions, text, log, '创作声明');
  return true;
}

async function fillTid(page, tid, log) {
  if (!tid) {
    log('! config.json 里没设 publish.tid，跳过分区（会用页面默认值）');
    return false;
  }
  const trigger = await find(page, S.tidTrigger);
  if (!trigger) {
    log('! 找不到分区选择器，跳过分区');
    return false;
  }
  await trigger.loc.click();
  await page.waitForTimeout(1500);
  try {
    await pickOption(page, S.tidOptions, tid, log, '分区');
    return true;
  } catch {
    log(`! 分区列表里没有「${tid}」，保持了页面默认值`);
    await page.keyboard.press('Escape');
    return false;
  }
}

/** 读当前已添加的标签文本 */
async function readTags(page) {
  return page.evaluate((sel) => {
    const cont = document.querySelector('#tag-container');
    if (!cont) return [];
    return Array.from(cont.querySelectorAll(sel))
      .map((e) => e.textContent.replace(/[×✕]/g, '').trim())
      .filter(Boolean);
  }, S.tagChipText);
}

/**
 * 清掉页面上已有的标签。
 * 为什么必须清：页面一加载 B站就按**默认分区**预置了 3 个标签（实测 生活记录/学习/记录），
 * 而标签上限是 10——不清的话我们自己的 10 个只能进去 7 个，剩下的被静默丢弃。
 */
async function clearTags(page, log) {
  const existing = await readTags(page);
  if (!existing.length) return;
  let guard = 0;
  while ((await page.locator(S.tagChip).count()) > 0 && guard++ < 20) {
    await page.locator(S.tagChip).first().locator(S.tagChipClose).click();
    await page.waitForTimeout(300);
  }
  log(`清掉了预置标签: ${existing.join(' / ')}`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 轮询等条件成立，超时返回 false。用来等页面的续期请求出现。 */
async function pollUntil(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// 续期是一条四步链，三个接口都要看着：
//   cookie/info   页面自己问「该续了吗」，返回 refresh 布尔值
//   取 refresh_csrf、调 cookie/refresh  换发新的 SESSDATA
//   confirm/refresh  落库，没走完新 cookie 可能不算数
const PASSPORT_API = {
  info: /passport\.bilibili\.com\/x\/passport-login\/web\/cookie\/info/,
  refresh: /passport\.bilibili\.com\/x\/passport-login\/web\/cookie\/refresh/,
  confirm: /passport\.bilibili\.com\/x\/passport-login\/web\/confirm\/refresh/,
};

/**
 * 登录态保活。
 *
 * B站 的 cookie 续期逻辑**只挂在主站页面**（www.bilibili.com）——实测投稿页
 * 从头到尾不调 `cookie/info`，所以光跑投稿流程是不会续期的，登录一到期就掉。
 *
 * 做法是模拟「用户每天开一次 B站」：访问主站，让 B站 自己的 JS 去调
 * `GET passport.bilibili.com/x/passport-login/web/cookie/info`，它判断该续了
 * （`refresh: true`）就会由**页面自己的代码**完成续期、换发一份新的 SESSDATA
 * （新期限多长由 B站 定，不一定是 7 天——实测两次扫码分别拿到 7 天和 180 天）。
 *
 * 为什么不自己调续期接口：那样得先逆清楚 refresh 的参数，而且主动打这类接口
 * 更容易撞风控。让页面自己走一遍是它设计内的路径，风险最低。
 *
 * **2026-10-09 重写**：上一版是「goto 主站 → 死等 6 秒 → 关页」的盲操作，
 * 全程不监听任何请求、也不看 cookie/info 返回了什么，所以它**已经失效了也不出声**。
 * 从 10-05 到 10-08 连跑 4 天，SESSDATA 到期时间一直是 2026/10/8 15:21:26，
 * 一次都没往后跳——续期从没成功过，而日志里连一行都没有。两个具体毛病：
 *
 *   1. 6 秒是拍脑袋的。`domcontentloaded` 时页面还在加载 JS，续期链是异步四步，
 *      6 秒后 `page.close()` 完全可能把请求掐在半路；
 *   2. 唯一的失败检测是「URL 变成 passport.bilibili.com」——**这条永远不会命中**，
 *      主站匿名也能正常打开（实测无 cookie 访问返回 200、不跳登录页）。
 *
 * 现在改成等响应本身：挂监听 → 等 cookie/info → 若 refresh 为 true 再等
 * cookie/refresh 与 confirm/refresh，全都有日志。这样「没触发」「没到窗口」
 * 「拿到了但读不出来」「链路断了」在日志里是四种不同的行，而不是一律静默。
 *
 * 返回 { ok, refresh }。注意它仍然只负责**跑**保活，续期到底成没成由调用方
 * 比对 SESSDATA 到期时间判定——那才是唯一的地面真值。
 */
async function keepAlive(context, log) {
  const page = await context.newPage();
  const seen = { info: null, refresh: null, confirm: null };
  // 监听必须在 goto 之前挂上：cookie/info 是页面一加载就发的，goto 返回之后再挂会漏掉它，
  // 而「这个请求到底发没发出来」正是判断保活有没有生效的关键。
  page.on('response', (res) => {
    const u = res.url();
    for (const k of Object.keys(PASSPORT_API)) {
      if (!seen[k] && PASSPORT_API[k].test(u)) seen[k] = res;
    }
  });

  try {
    // 后台标签页里站点的登录态模块可能压根不跑，显式提到前台
    await page.bringToFront().catch(() => {});
    await page.goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (!(await pollUntil(() => seen.info, 30000))) {
      log('! 保活：30s 内没等到主站发 cookie/info —— 这次没有触发续期检查（登录态大概率已失效）');
      return { ok: false, refresh: null };
    }

    let data = null;
    try {
      data = (await seen.info.json()).data;
    } catch {
      // 响应体读不到就按「未知」处理，别把保活整体判成失败
    }
    // 「读不出来」和「refresh=false」必须分成两句。原先两者共用一句
    // 「还没到续期窗口」——响应体读不到时那是在**把猜测当事实**，
    // 而这恰恰是本模块最初栽的那个坑（失效了却报成正常）。
    if (!data) {
      log('! 保活：cookie/info 的响应体读不出来，本次续期状态未知（≠ 还没到窗口）');
      return { ok: true, refresh: null };
    }
    if (data.refresh !== true) {
      log(`保活: cookie/info refresh=${data.refresh}（还没到续期窗口）`);
      return { ok: true, refresh: false };
    }

    log('保活: cookie/info refresh=true，等页面完成续期……');
    if (!(await pollUntil(() => seen.refresh, 30000))) {
      log('! 保活：refresh=true 但 30s 内没看到 cookie/refresh —— 续期链没跑起来');
      return { ok: false, refresh: true };
    }
    log(`保活: cookie/refresh HTTP ${seen.refresh.status()}`);

    // 等不到 confirm 不判硬失败：真正算不算数看调用方比对的到期时间，
    // 这里记一笔只为出问题时能区分「链路没跑」和「跑了但没落库」。
    if (await pollUntil(() => seen.confirm, 15000)) {
      log(`保活: confirm/refresh HTTP ${seen.confirm.status()}`);
    } else {
      log('! 保活：没等到 confirm/refresh，续期可能没落库');
    }
    return { ok: true, refresh: true };
  } catch (e) {
    // 保活失败不该拖垮投稿，记一笔继续
    log(`! 保活访问失败（不影响本次投稿）：${String(e.message).split('\n')[0]}`);
    return { ok: false, refresh: null };
  } finally {
    // 这张页是 keepAlive 自己开的私有页（不是 getPage() 发的那张），直接关掉即可：
    // 每次调用都新建、用完即弃，不存在复用问题，也不会攒下来。
    // 调用方那类「跑完整条流程的页」才需要 releasePage() 归位——别把两者搞混。
    await page.close().catch(() => {});
  }
}

/** 写一个标签，返回是否真的加上去了（以 chip 数增加为准） */
async function addTag(page, input, tag) {
  const before = (await readTags(page)).length;

  // 先看 B站 的推荐标签行里有没有现成的。有就点它——这不是偷懒，是必须：
  // 实测「手游情报」手打后回车**无事发生**（输入框还会被清空），点推荐 chip 才能加上。
  // 这类多半是活动标签，只认 B站 自己的入口。推荐 chip 本身也比手打更稳（B站 自己认可的）。
  const rec = page
    .locator(S.tagRecommendChip, { hasText: new RegExp(`^\\s*${escapeRe(tag)}\\s*$`) })
    .first();
  if (await rec.count().catch(() => 0)) {
    await rec.scrollIntoViewIfNeeded().catch(() => {});
    await rec.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
    if ((await readTags(page)).length > before) return true;
  }

  // 推荐行里没有（或点了没用），退回手打
  await input.click();
  await input.fill(tag);
  await page.waitForTimeout(350);
  await input.press('Enter');
  await page.waitForTimeout(600);
  return (await readTags(page)).length > before;
}

async function fillTags(page, tags, log) {
  await clearTags(page, log);
  // 清空最后一个 chip 会触发组件重渲染，紧接着写第一个标签的 fill+Enter 会被吞掉
  // （实测 2026-09-30 那次「手游情报」就是这么丢的）。等一下再开始。
  await page.waitForTimeout(800);

  const hit = await find(page, S.tagInput);
  if (!hit) {
    log(`! 找不到标签输入框，跳过：${tags.join(', ')}`);
    return;
  }

  for (const t of tags) {
    const tag = t.slice(0, S.tagMaxLen);
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        ok = await addTag(page, hit.loc, tag);
      } catch (e) {
        log(`  ! 标签「${tag}」输入异常：${String(e.message).split('\n')[0]}`);
        break;
      }
      if (!ok && attempt === 1) log(`  「${tag}」第一次没生效，重试`);
      if (!ok && attempt === 2) {
        const leftover = await hit.loc.inputValue().catch(() => '');
        log(
          `  ! 「${tag}」两次都没加上${leftover ? `（输入框残留 "${leftover}"）` : ''}` +
            `，可能是被 10 个上限挡住或该标签不被接受`
        );
      }
    }
  }

  // 核对最终结果——这一步是必须的：不核对的话，标签被静默丢弃了也不知道
  const got = await readTags(page);
  const missing = tags.filter((t) => !got.includes(t));
  const extra = got.filter((t) => !tags.includes(t));
  log(`标签 ${got.length}/${S.tagTotal}: ${got.join(' / ')}`);
  if (missing.length) log(`  ! 没加上的: ${missing.join(' / ')}`);
  if (extra.length) log(`  ! 多出来的: ${extra.join(' / ')}`);
  if (missing.length || extra.length) {
    log('  （投出去的标签和预期不一致，检查上方原因）');
  }
}

/** 页面上还有几个可见的弹窗遮罩。0 = 没有东西挡着，可以放心点。 */
async function visibleMaskCount(page) {
  return await page
    .locator(S.mask)
    .evaluateAll((els) =>
      els.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none';
      }).length
    )
    .catch(() => 0);
}

/** 某个选择器当前有没有可见元素。用来判断弹窗开没开，而不是「在不在 DOM 里」。 */
async function isVisible(page, selector) {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return false;
  return await loc.isVisible().catch(() => false);
}

/**
 * 保证页面上没有弹窗遮罩挡着，挡着就等它消失；等不到就报错。
 *
 * 这个检查值得单独存在：遮罩的失败方式特别难查——它不动 DOM、不报错，
 * 只是让后面每一次点击都变成 "intercepts pointer events" 然后超时 30 秒。
 * 报错信息指向的是**被点不到的那个按钮**，真正的原因在几十行之外。
 * 2026-10-09 的封面同步框就是这么卡死投稿的，所以宁可在源头吼一声。
 */
async function ensureNoMask(page, log, what, timeoutMs = 10000) {
  // 通知权限引导框是已知的无害遮罩，来了就顺手关掉
  if (await isVisible(page, S.notifyDialog)) {
    log('关掉浏览器通知引导框');
    await page.locator(S.notifyDialogDismiss).first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await visibleMaskCount(page);
    if (n === 0) return true;
    if (Date.now() >= deadline) {
      throw new Error(
        `${what}前还有 ${n} 个弹窗遮罩没关掉，继续下去只会点不动按钮。` +
          `已知来源是封面编辑器的「16:9 同步确认」框——见 selectors.js 的 coverSyncModal 注释。`
      );
    }
    await page.waitForTimeout(400);
  }
}

/**
 * 用完的标签页**归位**成 about:blank，而不是关掉。
 *
 * 为什么不关：关页有个看不出来的副作用——**它是最后一张时浏览器会跟着退出**
 * （实测 2026-10-09：清完历史标签后跑一次 dry-run，Edge 进程直接归零、9222 端口
 * 只剩 502，下次运行得重新拉起，弹窗 + 慢几秒）。归位两头都要：
 * 页不会堆——`getPage()` 只认领 `about:blank`，下次运行直接复用这张；
 * 浏览器也常驻，`ensureBrowser()` 的「复用已在运行的实例」快路径得以成立。
 *
 * 为什么非得收尾：不收的话每次运行都多一张**回收不掉**的页（`getPage()` 认不出停着
 * 投稿页的它）。实测 2026-10-09 曾堆到 10 张，全是历次运行留下的。
 * 这不只是占资源——排查时随手抓一张会读到**几天前的状态**，那次
 * 「页面显示稿件投递成功、接口却查不到」的误判就是这么来的。
 *
 * 失败路径**不归位**（见 catch）：那时留着现场比干净更有用。
 */
async function releasePage(page) {
  try {
    await page.goto('about:blank', { timeout: 15000 });
  } catch {
    // 归位失败（页面崩了 / 连接断了）就退化成关页，别留一张认不出来的页
    await page.close().catch(() => {});
  }
}

async function setCover(page, coverPath, log) {
  const trigger = await find(page, S.coverTrigger, 8000);
  if (!trigger) {
    log('! 找不到「添加封面」入口，跳过封面');
    return false;
  }
  await trigger.loc.click();
  await page.waitForTimeout(3000);

  const input = page.locator(S.fileInputCover).first();
  try {
    await input.waitFor({ state: 'attached', timeout: 10000 });
  } catch {
    log('! 封面弹窗里没出现文件输入，跳过封面');
    return false;
  }
  await input.setInputFiles(coverPath);
  log('封面上传中，等预览生成……');
  await page.waitForTimeout(6000);

  const done = await find(page, S.coverDone, 8000);
  if (!done) {
    log('! 找不到封面弹窗的「完成」按钮，封面可能没生效');
    return false;
  }
  await done.loc.click();
  await page.waitForTimeout(2500);

  // 关掉封面编辑器要两步，实测（2026-10-09）中间态有三种：
  //   只开着同步框 / 只开着编辑器 / 两个都开着。
  // 所以不能「答完同步框就当完事」——答完编辑器还在，遮罩照样挡死后面的点击。
  // 这里循环到编辑器真的没了为止：有同步框先答它，没有就再点「完成」。
  for (let i = 0; i < 4 && (await isVisible(page, S.coverEditor)); i++) {
    if (await isVisible(page, S.coverSyncModal)) {
      log('封面编辑器弹出「16:9 封面未修改」同步确认框，选「确认同步」');
      await page.locator(S.coverSyncConfirm).first().click().catch(() => {});
    } else {
      const again = await find(page, S.coverDone, 4000);
      if (!again) break; // 既没有同步框也没有「完成」——下面 ensureNoMask 会报实情
      log('同步确认已答，再点一次「完成」关掉封面编辑器');
      await again.loc.click().catch(() => {});
    }
    await page.waitForTimeout(2500);
  }

  // 这里必须核对遮罩真的没了才敢报成功。老版本直接打了「封面已设置」就往下走，
  // 结果投稿被残留的遮罩挡死，日志却显示一切正常——和标签那次谎报成功是同一类毛病。
  await ensureNoMask(page, log, '确认封面');
  log(`封面已设置: ${path.basename(coverPath)}`);
  return true;
}

/** 等视频上传完成（B站允许提前投稿，所以这里只是尽量等，等不到不致命） */
async function waitUploadDone(page, log, maxMs = 180000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (txt.includes(S.uploadDoneText)) {
      log('视频上传完成');
      return true;
    }
    await page.waitForTimeout(3000);
  }
  log('! 没等到「上传完成」字样，但 B站允许先投稿后传完，继续');
  return false;
}

/**
 * 投稿后认领 bvid。
 *
 * **不要**从页面 HTML 里正则捞 BV 号——页面上混着推荐位等无关的 BV 号，
 * 实测会捞到错的那个（2026-10-01 那次记录里存的就是个错 bvid）。
 * 可靠做法是查创作中心的稿件列表接口，按标题认领刚投的那条。
 */
async function fetchBvid(page, title, log) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await page.evaluate(async (api) => {
        const res = await fetch(api, { credentials: 'include' });
        return await res.json();
      }, S.archivesApi);
      if (data && data.code === 0) {
        const arcs = (data.data && (data.data.arc_audits || data.data.arcs)) || [];
        const mine = arcs.map((a) => a.Archive || a).find((a) => (a.title || '').trim() === title.trim());
        if (mine && mine.bvid) return mine.bvid;
      } else {
        log(`  ! 稿件接口返回 ${data && data.code}，稍后重试`);
      }
    } catch (e) {
      log(`  ! 查 bvid 失败：${String(e.message).split('\n')[0]}`);
    }
    await page.waitForTimeout(4000);
  }
  return null;
}

async function submitAndCapture(page, title, log) {
  const submit = await find(page, S.submit, 10000);
  if (!submit) throw new Error('找不到「立即投稿」按钮');

  for (let i = 0; i < 60; i++) {
    if (!(await submit.loc.isDisabled().catch(() => false))) break;
    if (i % 4 === 0) log('  投稿按钮还不可点（多半还有必填项没填完），等……');
    await page.waitForTimeout(3000);
  }

  // 最后一道防线：有遮罩残留的话，下面的 click 会以 "intercepts pointer events"
  // 超时 30 秒，报错还指向「立即投稿」这个无辜的按钮。宁可在这里说清楚。
  await ensureNoMask(page, log, '点击「立即投稿」');

  log('点击「立即投稿」……');
  await submit.loc.click();
  await page.waitForTimeout(7000);
  log(`提交后 URL: ${page.url()}`);

  const bvid = await fetchBvid(page, title, log);
  if (bvid) log(`稿件已认领: ${bvid}`);
  else log('! 没能在稿件列表里认领到（可能还在排队），去创作中心确认一下 bvid');
  return bvid;
}

// ---------------------------------------------------------------- 主流程

async function upload(cfg, { date, dryRun, log = console.log }) {
  const gwmod = require('./gamewind');
  const meta = require('./metadata');
  const cover = require('./cover');

  // 0. 幂等：投过就别再投
  const prev = gwmod.readPublishRecord(cfg.gamewindPath, date);
  if (prev && prev.bvid) {
    throw new Error(
      `${date} 已经投过稿了（${prev.bvid}，${prev.publishedAt}）。要重投请先删掉 ${gwmod.publishRecordPath(cfg.gamewindPath, date)}`
    );
  }

  // 1. 素材
  const a = gwmod.assets(cfg.gamewindPath, date);
  if (!a.specExists) throw new Error(`缺 spec: ${a.spec}`);
  if (!a.videoExists) throw new Error(`缺视频: ${a.video}`);
  const spec = gwmod.readSpec(cfg.gamewindPath, date);

  // 2. 元数据 + 封面
  const md = meta.build(spec, cfg);
  const dir = makeArtifacts(cfg, date);
  const coverPath = path.join(dir, 'cover.png');
  const coverInfo = await cover.extractCover(a.video, coverPath, {});

  log(`日期: ${date}`);
  log(`视频: ${path.relative(process.cwd(), a.video)} (${(fs.statSync(a.video).size / 1048576).toFixed(1)} MB)`);
  log(`封面: ${coverInfo.sourceSize} ${coverInfo.note}`);
  log(`标题: ${md.title}`);
  log(`分区: ${md.tid || '(页面默认)'}`);
  log(`标签: ${md.tags.join(' / ')}`);
  log(`简介: ${md.desc.length} 字`);
  log(`产物目录: ${path.relative(process.cwd(), dir)}`);

  // 3. 浏览器
  const { context, info } = await ensureBrowser(cfg, log);
  log(`浏览器: ${info.Browser}`);

  // 保活 + 登录态预检。放在这个位置是因为浏览器反正已经拉起来了，顺路做，没有额外开销。
  //
  // 先记一次到期时间，跑完保活再记一次——如果 B站 这次真的续了，两次会不同，
  // 日志里能看到。这也是验证「保活到底有没有用」的唯一手段（见 keepAlive 注释）。
  const before = await sessionInfo(context);
  await keepAlive(context, log);
  const sess = await sessionInfo(context);

  if (before.expiresAt && sess.expiresAt && sess.expiresAt > before.expiresAt) {
    log(`✓ 登录态已自动续期：${before.expiresAt.toLocaleString('zh-CN')} → ${sess.expiresAt.toLocaleString('zh-CN')}`);
  }

  // 每天一行，既让你在日志里看得见状态，也是「保活到底有没有生效」的观测点：
  // 到期时间一直不变 = B站 还没到续期窗口；某天突然往后跳 = 续期成功
  // （跳多少天由 B站 定，别按 7 天去认——实测两次扫码分别拿到 7 天和 180 天）。
  log(
    sess.loggedIn
      ? `登录态: 已登录，SESSDATA 剩 ${sess.daysLeft} 天` +
          (sess.expiresAt ? `（${sess.expiresAt.toLocaleString('zh-CN')} 过期）` : '')
      : '登录态: 未登录'
  );

  // SESSDATA 只有 7 天有效期（见 AGENTS.md），到期当天投稿会直接失败——那时已经错过当天了。
  // 所以临近到期就在这里提前吼一声，让你有时间安排扫码。
  //
  // 除了写日志还推企业微信：10-08 那天这行字**确实打进了 cron.log**，但没人翻日志，
  // 于是 10-09 照样丢了稿。只写日志的告警在无人值守场景下等于没有。
  const warnDays = (cfg.publish && cfg.publish.sessionWarnDays) || 2;
  if (sess.loggedIn && sess.daysLeft != null && sess.daysLeft <= warnDays) {
    const expires = sess.expiresAt ? sess.expiresAt.toLocaleString('zh-CN') : '未知';
    log('');
    log(`⚠️  登录态快过期：SESSDATA 只剩 ${sess.daysLeft} 天（${expires}）`);
    log('    过期后定时投稿会失败。尽快跑一次: node cli.js login');
    log('');
    await notify.push(
      cfg,
      'session-expiring',
      `### ⚠️ B站 登录态快过期\n` +
        `>SESSDATA 只剩 **${sess.daysLeft} 天**（${expires} 过期）\n` +
        `>过期后定时投稿会失败，当天视频需要手动补投。\n` +
        `>处理：\n` +
        '```\ncd ~/ai-project/bilibili-publish\nnode cli.js login\n```',
      log
    );
  }

  const page = await getPage(context);
  await openUploadPage(page, log);

  try {
    const titleHit = await uploadVideo(page, a.video, cfg, log);
    await fillTitle(page, titleHit.loc, md.title, log);
    await fillDesc(page, md.desc, log);
    await fillStatement(page, (cfg.publish && cfg.publish.statement) || S.STATEMENT_DEFAULT, log);
    await fillTid(page, md.tid, log);
    await fillTags(page, md.tags, log);

    await setCover(page, coverPath, log);

    if (dryRun) {
      await capture(page, dir, 'dry-run-filled');
      log('');
      log('--dry-run：已填完全部字段，停在提交前。');
      log(`  截图: ${path.relative(process.cwd(), path.join(dir, 'dry-run-filled.png'))}`);
      log('  去掉 --dry-run 即真正投稿。');
      await releasePage(page);
      return { submitted: false, dir };
    }

    await waitUploadDone(page, log);
    await capture(page, dir, 'before-submit');

    const bvid = await submitAndCapture(page, md.title, log);
    const record = {
      date,
      title: md.title,
      bvid,
      tags: md.tags,
      tid: md.tid,
      video: a.video,
      cover: coverPath,
      publishedAt: new Date().toISOString(),
    };
    const recPath = gwmod.writePublishRecord(cfg.gamewindPath, date, record);
    log(`投稿完成${bvid ? `，bvid=${bvid}` : '（没抓到 bvid，去创作中心确认一下）'}`);
    log(`记录已写入: ${path.relative(cfg.gamewindPath, recPath)}`);

    await releasePage(page);
    return { submitted: true, bvid, dir };
  } catch (e) {
    const saved = await capture(page, dir, 'error');
    log('');
    log(`失败：${e.message}`);
    if (saved) log(`现场已存证: ${path.relative(process.cwd(), dir)}（浏览器没关，可以直接看）`);
    throw e;
  }
}

// keepAlive 单独导出：它不含任何投稿副作用，可以脱离投稿流程单独跑，
// 用来观察「主站到底有没有发 cookie/info、有没有续期」。排查登录态时很省事。
module.exports = { upload, keepAlive };
