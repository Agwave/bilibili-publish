'use strict';
/**
 * gamewind.js — 与 game-wind 仓库的路径/日期约定对接
 *
 * 命名约定（对齐 game-wind/scripts/make_video.sh:65-66 的纯字符串拼接）：
 *   spec:  <gamewind>/data/reports/<date>.video.json
 *   video: <gamewind>/data/videos/<date>.mp4
 *   report:<gamewind>/data/reports/<date>.md
 */

const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 列出所有有快照的日期，升序。
 * 对齐 game-wind/internal/store/store.go:56-74 的 ListDates：
 * 只扫 data/ 根目录下文件名恰为 15 字符的 .json（即 `2026-08-18.json`），
 * 不会误取 data/reports/ 里的文件。
 */
function listDates(root) {
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.length === 15 && f.endsWith('.json') && DATE_RE.test(f.slice(0, 10)))
    .map((f) => f.slice(0, 10))
    .sort();
}

/** 最新日期。对齐 make_video.sh:56-63 取 `gamewind list | tail -1` 的语义。 */
function latestDate(root) {
  const dates = listDates(root);
  return dates.length ? dates[dates.length - 1] : null;
}

const specPath = (root, date) => path.join(root, 'data', 'reports', `${date}.video.json`);
const videoPath = (root, date) => path.join(root, 'data', 'videos', `${date}.mp4`);
const reportPath = (root, date) => path.join(root, 'data', 'reports', `${date}.md`);
const publishRecordPath = (root, date) => path.join(root, 'data', 'videos', `${date}.publish.json`);

/** 校验一个日期对应的投稿素材是否齐全 */
function assets(root, date) {
  const out = {
    date,
    spec: specPath(root, date),
    video: videoPath(root, date),
    report: reportPath(root, date),
  };
  out.specExists = fs.existsSync(out.spec);
  out.videoExists = fs.existsSync(out.video);
  out.reportExists = fs.existsSync(out.report);
  return out;
}

function readSpec(root, date) {
  const p = specPath(root, date);
  if (!fs.existsSync(p)) throw new Error(`找不到视频规格: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 读取既往投稿记录（如果投过）。用于幂等检查。 */
function readPublishRecord(root, date) {
  const p = publishRecordPath(root, date);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writePublishRecord(root, date, record) {
  const p = publishRecordPath(root, date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return p;
}

module.exports = {
  listDates,
  latestDate,
  specPath,
  videoPath,
  reportPath,
  publishRecordPath,
  assets,
  readSpec,
  readPublishRecord,
  writePublishRecord,
};
