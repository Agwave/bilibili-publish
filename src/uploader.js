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
 * 页面行为上的两个坑（实测）：
 *   - 标题会被自动预填成文件名（"2026-10-01"），不清空就会和真标题拼在一起；
 *   - 「创作声明」是必填下拉，漏了它投稿按钮点不动。
 */

const fs = require('fs');
const path = require('path');
const { ensureBrowser, getPage } = require('./browser');
const { find, findFileInput, describeFileInputs } = require('./dom');
const S = require('./selectors');

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

async function fillTags(page, tags, log) {
  await clearTags(page, log);

  const hit = await find(page, S.tagInput);
  if (!hit) {
    log(`! 找不到标签输入框，跳过：${tags.join(', ')}`);
    return;
  }

  for (const t of tags) {
    const before = (await readTags(page)).length;
    try {
      await hit.loc.click();
      await hit.loc.fill(t.slice(0, S.tagMaxLen));
      await page.waitForTimeout(300);
      await hit.loc.press('Enter');
      await page.waitForTimeout(500);
    } catch (e) {
      log(`  ! 标签「${t}」输入异常：${String(e.message).split('\n')[0]}`);
      continue;
    }
    const after = await readTags(page);
    if (after.length === before) {
      log(`  ! 标签「${t}」没生效（可能被上限挡住，或联想下拉吞了回车）`);
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
    return { submitted: true, bvid, dir };
  } catch (e) {
    const saved = await capture(page, dir, 'error');
    log('');
    log(`失败：${e.message}`);
    if (saved) log(`现场已存证: ${path.relative(process.cwd(), dir)}（浏览器没关，可以直接看）`);
    throw e;
  }
}

module.exports = { upload };
