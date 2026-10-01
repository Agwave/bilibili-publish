'use strict';
/**
 * cover.js — 从成片抽封面
 *
 * game-wind 的片头（build.js 里的 `1-title` 段）是整片第一段，按封面标准排版
 * ——内容收在中央 1320px（见 game-wind/tools/video/theme.js:79-87）。
 * 所以直接抽第 0 帧就是设计好的封面。
 *
 * 【为什么不做预裁切】
 * game-wind 的 README 按「B站封面是 16:10」设计，但 2026-10 实测 B 站已改成
 * 双比例，且两种比例的处理方式不同（对上传图 1146x717 的实测结果）：
 *
 *   首页推荐封面 (4:3)  → 等比缩放后**裁切填满**，取中央 4:3 区域
 *   个人空间封面 (16:9) → 整图**加黑边**（contain）
 *
 * 所以上传完整的 1920×1080 第 0 帧是最优解：
 *   4:3 裁中央 1440px，内容 1320px 两侧各留 60px；
 *   16:9 完整显示，正好是片头原貌。
 * 反之若预先裁成 16:10，4:3 边距只剩 39px，16:9 还要加黑边，两头都更差。
 *
 * 不走「改 make_video.sh 加 --keep 取 1-title.png」那条路：那要重渲染整片（几分钟）
 * 且有覆盖已有视频的风险，而第 0 帧与之等价。
 *
 * WSL2 里没有系统 ffmpeg，用 npm 包 ffmpeg-static 提供的二进制（game-wind 也是这么做的）。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ffmpegPath = require('ffmpeg-static');

// npm 安装 ffmpeg-static 时偶尔会丢掉可执行位（解包顺序/中断重装都可能触发），
// 表现为 spawn 时报 EACCES 或者干脆静默无输出。这里自愈一下。
try {
  const mode = fs.statSync(ffmpegPath).mode;
  if (!(mode & 0o111)) fs.chmodSync(ffmpegPath, 0o755);
} catch {
  /* 文件不存在的话，下面真正用到时会给出更清楚的报错 */
}

// B 站封面推荐尺寸
const COVER_W = 1146;
const COVER_H = 717;
const TARGET_AR = 16 / 10;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ffmpeg 探测信息走 stderr，很多命令"成功"也返回非零，这里把两者都交回调用方
      resolve({ err, stdout, stderr });
    });
  });
}

/** 从 ffmpeg -i 的 stderr 里读分辨率 */
async function probeVideo(videoPath) {
  const { stderr } = await run(['-hide_banner', '-i', videoPath]);
  const m = /Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  if (!m) throw new Error(`读不出视频分辨率: ${videoPath}`);
  const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    durationSec: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
  };
}

/**
 * 抽第 0 帧作为封面。默认**不裁切**，整帧原样输出——
 * 见文件头注释：B站会自己按 4:3 裁 / 按 16:9 加边，预裁只会两头不讨好。
 *
 * opts.at        抽帧时间点，默认 0（片头第一帧）
 * opts.crop16x10 传 true 则预裁成 16:10（保留这条路径是为了对比验证，正常不用）
 */
async function extractCover(videoPath, outPath, opts = {}) {
  if (!fs.existsSync(videoPath)) throw new Error(`找不到视频: ${videoPath}`);

  const { width, height } = await probeVideo(videoPath);
  const at = opts.at != null ? opts.at : 0;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', videoPath, '-frames:v', '1'];

  let note = '整帧原样（不裁切）';
  if (opts.crop16x10) {
    const cropW = Math.round(Math.min(width, height * TARGET_AR) / 2) * 2; // 偶数宽，避免编码器抱怨
    const cropX = Math.round((width - cropW) / 2);
    args.push('-vf', `crop=${cropW}:${height}:${cropX}:0`);
    note = `预裁 16:10，左右各切 ${cropX}px`;
    args.push('-y', outPath);
    const r = await run(args);
    if (r.err || !fs.existsSync(outPath)) {
      throw new Error(`抽封面失败: ${(r.stderr || (r.err && r.err.message) || '').trim().slice(0, 300)}`);
    }
    return { path: outPath, sourceSize: `${width}x${height}`, note, bytes: fs.statSync(outPath).size };
  }

  args.push('-y', outPath);
  const { err, stderr } = await run(args);
  if (err || !fs.existsSync(outPath)) {
    throw new Error(`抽封面失败: ${(stderr || (err && err.message) || '').trim().slice(0, 300)}`);
  }
  return { path: outPath, sourceSize: `${width}x${height}`, note, bytes: fs.statSync(outPath).size };
}

/** 封面方案预览（不落盘），doctor 和日志用 */
async function planCover(videoPath) {
  const { width, height, durationSec } = await probeVideo(videoPath);
  const ar = width / height;
  return {
    source: `${width}x${height}`,
    durationSec,
    // B站 4:3 裁切后，内容的实际安全余量
    fourThreeWidth: Math.round(height * (4 / 3)),
    sixNineWidth: width,
    aspect: ar.toFixed(3),
  };
}

module.exports = { extractCover, probeVideo, planCover, ffmpegPath, COVER_W, COVER_H };
