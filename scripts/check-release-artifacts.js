"use strict";

const fs = require("fs");
const path = require("path");

function fail(message) {
  console.error(`[release-artifacts] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { platform: "", dir: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform") opts.platform = argv[++i] || "";
    else if (arg === "--dir") opts.dir = argv[++i] || "";
  }
  if (!opts.platform || !opts.dir) {
    fail("用法: node scripts/check-release-artifacts.js --platform <win|mac> --dir <dist>");
  }
  if (!["win", "mac"].includes(opts.platform)) {
    fail(`不支持的平台: ${opts.platform}`);
  }
  return opts;
}

function listFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function findMatches(files, re) {
  return files.filter((name) => re.test(name));
}

const { platform, dir } = parseArgs(process.argv.slice(2));
const absDir = path.resolve(dir);
const files = listFiles(absDir);

if (files.length === 0) {
  fail(`目录为空或不存在: ${absDir}`);
}

if (platform === "win") {
  const installers = findMatches(files, /^YuTianClaw-Setup-.*\.exe$/);
  const manifests = findMatches(files, /^latest\.yml$/);
  if (installers.length === 0) fail(`未找到 Windows 安装包: ${absDir}`);
  if (manifests.length === 0) fail(`未找到 Windows 更新清单 latest.yml: ${absDir}`);
  console.log(`[release-artifacts] win installers: ${installers.join(", ")}`);
  console.log(`[release-artifacts] win manifest: ${manifests.join(", ")}`);
} else {
  const dmgs = findMatches(files, /^YuTianClaw-.*\.dmg$/);
  const zips = findMatches(files, /^YuTianClaw-.*\.zip$/);
  const manifests = findMatches(files, /^latest-mac\.yml$/);
  if (dmgs.length === 0) fail(`未找到 macOS DMG: ${absDir}`);
  if (zips.length === 0) fail(`未找到 macOS ZIP: ${absDir}`);
  if (manifests.length === 0) fail(`未找到 macOS 更新清单 latest-mac.yml: ${absDir}`);
  console.log(`[release-artifacts] mac dmg: ${dmgs.join(", ")}`);
  console.log(`[release-artifacts] mac zip: ${zips.join(", ")}`);
  console.log(`[release-artifacts] mac manifest: ${manifests.join(", ")}`);
}
