'use strict';
/**
 * login.js — 扫码登录与登录态检测
 *
 * 登录态存在 Windows 侧浏览器 profile 目录里（见 browser.js），所以只需要人工扫一次码，
 * 之后每次运行直接复用。SESSDATA 大约一个月过期，过期后重跑 `cli.js login` 即可。
 */

const { ensureBrowser, getPage } = require('./browser');

const LOGIN_URL = 'https://passport.bilibili.com/login';
const MEMBER_URL = 'https://member.bilibili.com/platform/home';

/** 是否已登录：能拿到非空的 SESSDATA cookie 就算 */
async function hasSession(context) {
  const cookies = await context.cookies([
    'https://www.bilibili.com',
    'https://member.bilibili.com',
  ]);
  return cookies.some((c) => c.name === 'SESSDATA' && c.value);
}

/** 取登录态摘要，doctor 命令用 */
async function sessionInfo(context) {
  const cookies = await context.cookies(['https://www.bilibili.com', 'https://member.bilibili.com']);
  const sess = cookies.find((c) => c.name === 'SESSDATA');
  if (!sess || !sess.value) return { loggedIn: false };
  const expired = sess.expires && sess.expires > 0 ? new Date(sess.expires * 1000) : null;
  const daysLeft = expired ? Math.floor((expired - Date.now()) / 86400000) : null;
  return { loggedIn: true, expiresAt: expired, daysLeft };
}

/**
 * 扫码登录。浏览器窗口会显示二维码，人工用 B 站 App 扫。
 * 轮询 cookie 直到出现 SESSDATA，或超时。
 */
async function login(config, log = console.log) {
  const { context, info } = await ensureBrowser(config, log);
  log(`浏览器: ${info.Browser}`);

  if (await hasSession(context)) {
    const s = await sessionInfo(context);
    log(`已经是登录状态${s.daysLeft != null ? `（SESSDATA 约剩 ${s.daysLeft} 天）` : ''}，无需重新扫码`);
    return { alreadyLoggedIn: true };
  }

  const page = await getPage(context);
  log('打开登录页，请在弹出的浏览器窗口里用 B 站 App 扫码……');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  const timeoutMs = (config.login && config.login.timeoutMs) || 300000;
  const deadline = Date.now() + timeoutMs;
  let lastTick = 0;

  while (Date.now() < deadline) {
    if (await hasSession(context)) {
      log('扫码成功，登录态已写入浏览器 profile');
      await page.goto(MEMBER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      return { alreadyLoggedIn: false };
    }
    const waited = Math.floor((Date.now() - (deadline - timeoutMs)) / 1000);
    if (waited - lastTick >= 15) {
      lastTick = waited;
      log(`  等待扫码中…… 已等 ${waited}s / ${Math.floor(timeoutMs / 1000)}s`);
    }
    await page.waitForTimeout(2000);
  }

  throw new Error(`等了 ${Math.floor(timeoutMs / 1000)}s 还没检测到登录。二维码可能已过期，重跑一次试试。`);
}

module.exports = { login, hasSession, sessionInfo, LOGIN_URL, MEMBER_URL };
