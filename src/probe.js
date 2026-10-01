'use strict';
/**
 * probe.js — 投稿页 DOM 探针
 *
 * 用途：B 站创作中心 DOM 改过不止一次（公开项目里能看到 bre-* → vui_* 的迁移），
 * 所以不预设选择器，直接把真实结构 dump 下来，据此定稿 selectors.js。
 *
 * 关键：投稿页是 SPA，**没上传视频之前页面上根本没有标题/简介/标签表单**。
 * 所以有两种模式：
 *   node cli.js probe                只看落地态（拖拽区 + iframe 结构）
 *   node cli.js probe --upload       真传一个视频，再看表单态（不提交）
 *
 * 产物落在 artifacts/probe-<时间戳>/，含截图、页面 HTML、结构化清单。
 */

const fs = require('fs');
const path = require('path');
const { ensureBrowser, getPage } = require('./browser');

const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame?page_from=creative_home_top_upload';

/** 在页面里跑的元素清单：把所有可能相关的可交互元素抓出来 */
function inventoryScript() {
  // SVG 元素的 className 是 SVGAnimatedString 对象而不是字符串，一律强转
  const trim = (s, n = 60) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n);
  const info = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || undefined,
    name: el.getAttribute('name') || undefined,
    id: el.id || undefined,
    cls: trim(el.getAttribute('class') || el.className, 120) || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    accept: el.getAttribute('accept') || undefined,
    text: trim(el.innerText, 40) || undefined,
  });

  const q = (sel) => Array.from(document.querySelectorAll(sel));

  // 统计 class 前缀，用来判断这一版用的是哪套设计系统（bre_* / vui_* / bcc-*）
  const prefixCount = {};
  for (const el of q('*')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    for (const c of cls.split(/\s+/)) {
      if (!c) continue;
      const p = c.split(/[-_]/)[0];
      if (p) prefixCount[p] = (prefixCount[p] || 0) + 1;
    }
  }
  const topPrefixes = Object.entries(prefixCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .filter(([, n]) => n > 2)
    .map(([p, n]) => `${p}(${n})`);

  return {
    url: location.href,
    title: document.title,
    bodyTextHead: trim(document.body.innerText, 800),
    prefixes: topPrefixes,
    fileInputs: q('input[type=file]').map(info),
    textInputs: q('input[type=text], input:not([type]), textarea').map(info),
    contentEditables: q('[contenteditable=true], [contenteditable=""]').map(info),
    buttons: q('button, [role=button], [class*=btn], [class*=button]')
      .map(info)
      .filter((b) => b.text || b.cls)
      .slice(0, 60),
    selects: q('select, [class*=select], [class*=dropdown], [class*=cascader]').map(info).slice(0, 40),
    // 上传相关容器，用来定位拖拽区
    uploadish: q('[class*=upload], [class*=Upload]').map(info).slice(0, 30),
    // 弹窗（封面选取、创作声明都可能是弹窗）
    modals: q('[class*=modal], [class*=Modal], [class*=dialog], [class*=Dialog]').map(info).slice(0, 20),
  };
}

async function dumpState(page, outDir, label, log) {
  fs.mkdirSync(outDir, { recursive: true });

  const shot = path.join(outDir, `${label}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(async () => {
    // 页面太长时 fullPage 可能失败，退回可视区截图
    await page.screenshot({ path: shot });
  });

  const html = path.join(outDir, `${label}.html`);
  fs.writeFileSync(html, await page.content(), 'utf8');

  const inv = await page.evaluate(inventoryScript);
  const json = path.join(outDir, `${label}.json`);
  fs.writeFileSync(json, JSON.stringify(inv, null, 2), 'utf8');

  // iframe 结构：B 站的上传 input 历史上就在 iframe[name=videoUpload] 里
  const frames = page.frames().map((f) => ({
    name: f.name() || undefined,
    url: f.url(),
    isMain: f === page.mainFrame(),
  }));
  fs.writeFileSync(path.join(outDir, `${label}.frames.json`), JSON.stringify(frames, null, 2), 'utf8');

  log(`  截图: ${path.relative(process.cwd(), shot)}`);
  log(`  HTML: ${path.relative(process.cwd(), html)}`);
  log(`  清单: ${path.relative(process.cwd(), json)}`);
  log(`  页面: ${inv.url}`);
  log(`  文案: ${inv.bodyTextHead.slice(0, 160)}……`);
  if (inv.prefixes.length) log(`  class 前缀: ${inv.prefixes.join(' ')}`);

  const counts = {
    文件输入: inv.fileInputs.length,
    文本框: inv.textInputs.length,
    可编辑区: inv.contentEditables.length,
    按钮: inv.buttons.length,
    下拉: inv.selects.length,
    弹窗: inv.modals.length,
  };
  log(`  元素计数: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (frames.length > 1) {
    log(`  iframe ${frames.length - 1} 个:`);
    for (const f of frames.filter((x) => !x.isMain)) {
      log(`    name=${f.name || '(无)'} url=${f.url.slice(0, 90)}`);
    }
  }

  return { shot, html, json, inv, frames };
}

async function probe(cfg, args = {}) {
  const log = console.log;
  const { context, info } = await ensureBrowser(cfg, log);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(process.cwd(), 'artifacts', `probe-${stamp}`);
  log(`浏览器: ${info.Browser}`);

  const page = await getPage(context);
  log(`打开投稿页: ${UPLOAD_URL}`);
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  if (page.url().includes('passport.bilibili.com')) {
    throw new Error('未登录（被重定向到 passport）。先跑 `node cli.js login` 扫码。');
  }

  log('\n--- 落地态 ---');
  await dumpState(page, outDir, 'landing', log);

  if (!args.upload) {
    log(`\n提示：要看表单态（标题/简介/标签/封面），加 --upload 真传一个视频再探。`);
    log(`产物目录: ${path.relative(process.cwd(), outDir)}`);
    return { outDir, landing: true };
  }

  // ---- 表单态：真传视频，但不提交 ----
  const gwmod = require('./gamewind');
  const date = args.date === true || !args.date ? gwmod.latestDate(cfg.gamewindPath) : args.date;
  const video = gwmod.videoPath(cfg.gamewindPath, date);
  if (!fs.existsSync(video)) throw new Error(`找不到视频: ${video}`);
  const sizeMB = (fs.statSync(video).size / 1048576).toFixed(1);
  log(`\n--- 表单态：上传 ${path.basename(video)} (${sizeMB} MB) ---`);

  const dom = require('./dom');
  const inputs = await dom.describeFileInputs(page);
  log('页面上的文件输入：');
  for (const x of inputs) log(`  ${x.where} accept=${x.accept} name=${x.name}`);

  const fileInput = await dom.findFileInput(page, 'video');
  if (!fileInput) throw new Error('没定位到视频文件输入，见上面的清单');
  log(`用这个: ${fileInput.where} accept=${fileInput.accept}`);

  await fileInput.loc.setInputFiles(video);
  log('已投喂文件，等上传+转码（最长等 10 分钟）……');

  const deadline = Date.now() + ((cfg.publish && cfg.publish.uploadTimeoutMs) || 600000);
  let lastLog = 0;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    const waited = Math.round((deadline - Date.now()) / 1000);
    if (Date.now() - lastLog > 20000) {
      lastLog = Date.now();
      const hint = txt.includes('上传完成') ? '上传完成' : txt.includes('%') ? '上传中' : '等待中';
      log(`  ${hint}…… 剩余超时 ${Math.ceil(waited / 60)} 分钟`);
    }
    // 表单出现的标志：出现了标题输入
    const hasForm = await page.locator('input[type=text], textarea').count();
    if (hasForm > 0 && txt.includes('标题')) break;
    await page.waitForTimeout(3000);
  }

  log('\n--- 表单态 dump ---');
  await dumpState(page, outDir, 'form', log);
  log(`\n产物目录: ${path.relative(process.cwd(), outDir)}`);
  log('注意：探针只上传、不填写、不提交。这个视频会留在草稿箱或上传暂存里，去创作中心清掉即可。');
  return { outDir };
}

module.exports = { probe, UPLOAD_URL };
