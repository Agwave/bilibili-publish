'use strict';
/**
 * browser.js — WSL2 侧的浏览器桥接层
 *
 * 架构：Node/Playwright 跑在 WSL2，浏览器跑在 Win11，两者通过 CDP 通信。
 * .wslconfig 里开了 networkingMode=mirrored，WSL2 与 Win11 共享 localhost，
 * 所以 127.0.0.1:9222 直达（实测网关 IP 不通，只有环回是共享的）。
 *
 * 两个必须知道的限制：
 * 1. Chrome/Edge 136+ 禁止在默认 profile 上开远程调试端口，必须用独立的
 *    --user-data-dir。好处是登录态就持久化在那个目录里，扫一次码长期有效。
 * 2. profile 目录必须在 Windows 可见的文件系统上（C 盘），Windows 进程读不了
 *    ext4 上的 WSL 路径。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// 浏览器候选：Windows 路径给浏览器用，Linux 路径给我们自己探测存在性用
const BROWSERS = {
  edge: [
    { win: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { win: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ],
  chrome: [
    { win: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { win: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  ],
};

function winToLinux(winPath) {
  return '/mnt/' + winPath[0].toLowerCase() + winPath.slice(2).replace(/\\/g, '/');
}

let cachedUserProfile = null;
/** 取 Windows 侧 USERPROFILE。缓存，避免每次调用都起一个 PowerShell。 */
async function getWindowsUserProfile() {
  if (cachedUserProfile) return cachedUserProfile;
  const out = await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', '$env:USERPROFILE'], (err, stdout) => {
      if (err) return reject(new Error(`取 Windows USERPROFILE 失败: ${err.message}`));
      resolve(stdout);
    });
  });
  cachedUserProfile = out.replace(/^\uFEFF/, '').trim();
  if (!cachedUserProfile) throw new Error('Windows USERPROFILE 为空');
  return cachedUserProfile;
}

/** 解析浏览器 profile 目录（Windows 路径）。默认 C:\Users\<user>\bilibili-publish\profile */
async function resolveProfileDir(config) {
  const configured = config.browser && config.browser.profileDirWindows;
  if (configured) return configured;
  return `${await getWindowsUserProfile()}\\bilibili-publish\\profile`;
}

/** 按偏好挑一个已安装的浏览器，返回 Windows 路径；都没有则报错 */
function pickBrowserExe(prefer) {
  const order = prefer === 'chrome' ? ['chrome', 'edge'] : ['edge', 'chrome'];
  for (const name of order) {
    for (const cand of BROWSERS[name]) {
      if (fs.existsSync(winToLinux(cand.win))) return { name, exe: cand.win };
    }
  }
  throw new Error('没找到 Edge 或 Chrome，请确认 Windows 侧装了其中之一');
}

/** 探一下 CDP 端口是否已有实例在听。通了返回 /json/version 的内容，否则 null。 */
async function probeCdp(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 用 PowerShell 的 Start-Process 拉起 Windows 浏览器。
 *
 * 为什么不用 spawn 直接跑 .exe：那样拉起的进程挂在 WSL 进程树下，WSL 命令一退出
 * 浏览器可能被一起收掉。Start-Process 创建的是独立进程，能活过我们的命令。
 */
function launchWindowsBrowser(exe, args) {
  const quoted = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const cmd = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${quoted}`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], (err, stdout, stderr) => {
      if (err) return reject(new Error(`拉起浏览器失败: ${err.message}\n${stderr || ''}`));
      resolve();
    });
  });
}

/** 轮询等 CDP 就绪 */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await probeCdp(port);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * 保证有一个可用的浏览器连接。已有实例就直接连，没有就拉起来再连。
 * 返回 { browser, context, info, launched }
 */
async function ensureBrowser(config, log = () => {}) {
  const port = (config.browser && config.browser.cdpPort) || 9222;
  let info = await probeCdp(port);
  let launched = false;

  if (!info) {
    const { name, exe } = pickBrowserExe(config.browser && config.browser.prefer);
    const profileDir = await resolveProfileDir(config);
    // profile 目录得先存在，否则某些版本会静默用默认 profile（那会被策略挡住）
    const profileLinux = winToLinux(profileDir);
    fs.mkdirSync(profileLinux, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,msEdgeIdentityFeatures',
      'about:blank',
    ];
    log(`拉起 Win11 浏览器: ${name}`);
    log(`  profile: ${profileDir}`);
    await launchWindowsBrowser(exe, args);
    launched = true;

    info = await waitForCdp(port, 30000);
    if (!info) {
      throw new Error(
        `等了 30s 浏览器还没在 ${port} 端口上监听。常见原因：\n` +
          `  1. 该 profile 已被另一个浏览器窗口占用（浏览器不允许两个实例共用一个 profile）\n` +
          `     → 关掉用这个 profile 打开的窗口，或者删掉 ${profileDir} 里的 SingletonLock\n` +
          `  2. 端口被占用：netstat -ano | findstr ${port}\n` +
          `  3. Windows 防火墙拦了回环（本机镜像网络下少见）`
      );
    }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('CDP 连上了但拿不到浏览器上下文');
  return { browser, context, info, launched };
}

/** 取一个可复用的 page：优先复用已有的 about:blank，否则新开 */
async function getPage(context) {
  const pages = context.pages();
  const blank = pages.find((p) => p.url() === 'about:blank');
  return blank || (await context.newPage());
}

module.exports = {
  ensureBrowser,
  getPage,
  probeCdp,
  pickBrowserExe,
  resolveProfileDir,
  winToLinux,
  getWindowsUserProfile,
};
