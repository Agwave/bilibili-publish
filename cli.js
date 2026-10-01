#!/usr/bin/env node
'use strict';
/**
 * bilibili-publish — 把 game-wind 的日报视频自动投稿到 B 站
 *
 * 代码跑在 WSL2，浏览器跑在 Win11，CH 见 src/browser.js。
 *
 *   node cli.js doctor              自检：素材、ffmpeg、浏览器、登录态
 *   node cli.js login               扫码登录（只需一次）
 *   node cli.js probe               探投稿页 DOM，用于定稿选择器
 *   node cli.js upload [--date D] [--dry-run] [--submit]
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`找不到配置文件: ${CONFIG_PATH}`);
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // 环境变量优先，方便临时换仓库
  if (process.env.GAMEWIND_PATH) cfg.gamewindPath = process.env.GAMEWIND_PATH;
  return cfg;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else (out[key] = next), i++;
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- doctor

async function cmdDoctor(cfg) {
  let problems = 0;

  head('1. game-wind 素材');
  const gw = cfg.gamewindPath;
  if (!fs.existsSync(gw)) {
    bad(`gamewindPath 不存在: ${gw}`);
    problems++;
  } else {
    ok(`仓库: ${gw}`);
    const gwmod = require('./src/gamewind');
    const dates = gwmod.listDates(gw);
    if (!dates.length) {
      bad('data/ 下没有任何快照');
      problems++;
    } else {
      ok(`快照 ${dates.length} 天，最新 ${dates[dates.length - 1]}`);
      const latest = dates[dates.length - 1];
      const a = gwmod.assets(gw, latest);
      a.specExists ? ok(`spec:   ${path.relative(gw, a.spec)}`) : (bad(`缺 spec: ${a.spec}`), problems++);
      a.videoExists
        ? ok(`视频:   ${path.relative(gw, a.video)} (${(fs.statSync(a.video).size / 1048576).toFixed(1)} MB)`)
        : (bad(`缺视频: ${a.video}`), problems++);
      const rec = gwmod.readPublishRecord(gw, latest);
      if (rec && rec.bvid) warn(`最新日期已投过稿: ${rec.bvid}`);
    }
  }

  head('2. ffmpeg');
  try {
    const ff = require('ffmpeg-static');
    fs.existsSync(ff) ? ok(`ffmpeg-static: ${ff}`) : (bad(`ffmpeg-static 路径不存在: ${ff}`), problems++);
  } catch (e) {
    bad(`ffmpeg-static 未安装（npm install 还没跑完？）`);
    problems++;
  }

  head('3. 浏览器桥接 (WSL2 → Win11)');
  try {
    const { ensureBrowser } = require('./src/browser');
    const { info, context, launched } = await ensureBrowser(cfg, (m) => console.log(`  ${m}`));
    ok(launched ? '浏览器已拉起' : '复用已在运行的浏览器实例');
    ok(`CDP 已连通: ${info.Browser}`);
    const p = context.pages();
    ok(`当前标签页 ${p.length} 个`);

    head('4. B 站登录态');
    const { sessionInfo } = require('./src/login');
    const s = await sessionInfo(context);
    if (s.loggedIn) {
      ok(`已登录${s.daysLeft != null ? `，SESSDATA 约剩 ${s.daysLeft} 天` : ''}`);
      if (s.daysLeft != null && s.daysLeft <= 3) warn('快过期了，建议尽快重跑 `node cli.js login`');
    } else {
      warn('未登录，跑 `node cli.js login` 扫码');
    }
  } catch (e) {
    bad(String(e.message).split('\n')[0]);
    problems++;
  }

  head(problems === 0 ? '自检通过' : `自检发现 ${problems} 个问题`);
  return problems === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- login

async function cmdLogin(cfg) {
  const { login } = require('./src/login');
  await login(cfg, (m) => console.log(m));
  return 0;
}

// ---------------------------------------------------------------- probe / upload

async function cmdProbe(cfg, args) {
  const { probe } = require('./src/probe');
  await probe(cfg, args);
  return 0;
}

async function cmdUpload(cfg, args) {
  const { upload } = require('./src/uploader');
  const gwmod = require('./src/gamewind');
  const date = args.date === true || !args.date ? gwmod.latestDate(cfg.gamewindPath) : args.date;
  if (!date) throw new Error('推导不出日期，请显式指定 --date YYYY-MM-DD');
  // 默认就是真投稿（无人值守用）；--dry-run 是开发调试开关，填完停在提交前
  const dryRun = !!args['dry-run'];
  await upload(cfg, { date, dryRun, log: console.log });
  return 0;
}

// ---------------------------------------------------------------- main

const USAGE = `
bilibili-publish — game-wind 日报视频自动投稿

  node cli.js doctor                    自检：素材、ffmpeg、浏览器、登录态
  node cli.js login                     扫码登录（只需一次）
  node cli.js probe                     探投稿页 DOM，用于定稿选择器
  node cli.js upload [选项]             投稿

upload 选项：
  --date YYYY-MM-DD   指定日期，默认取 game-wind 最新快照
  --dry-run           只填不投：填完全部字段后停在「立即投稿」之前，并截图

默认行为是真投稿（无人值守用）。改选择器或改元数据时请先加 --dry-run 验证。

环境变量：
  GAMEWIND_PATH       覆盖 config.json 里的 game-wind 仓库路径
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || args.help) {
    console.log(USAGE);
    return 0;
  }

  const cfg = loadConfig();

  switch (cmd) {
    case 'doctor':
      return await cmdDoctor(cfg);
    case 'login':
      return await cmdLogin(cfg);
    case 'probe':
      return await cmdProbe(cfg, args);
    case 'upload':
      return await cmdUpload(cfg, args);
    default:
      console.error(`未知命令: ${cmd}`);
      console.log(USAGE);
      return 2;
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error(`\n\x1b[31m失败:\x1b[0m ${e && e.message ? e.message : e}`);
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  });
