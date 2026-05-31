"use strict";

const fs = require("fs");
const path = require("path");

function mapAssetUrl(raw, version, baseUrl) {
  const v = raw.trim();
  if (!v || /^https?:\/\//i.test(v)) return v;
  const prefixed = `${version}/${v.replace(/^\/+/, "")}`;
  return baseUrl ? `${baseUrl}/${prefixed}` : prefixed;
}

function rewriteYaml(content, version, baseUrl) {
  const lines = content.split(/\r?\n/);
  return lines
    .map((line) => {
      let m = line.match(/^(\s*(?:-\s*)?url:\s*)(["']?)([^"']+)\2(\s*)$/);
      if (m) return `${m[1]}${m[2]}${mapAssetUrl(m[3], version, baseUrl)}${m[2]}${m[4]}`;
      m = line.match(/^(\s*(?:-\s*)?path:\s*)(["']?)([^"']+)\2(\s*)$/);
      if (m) return `${m[1]}${m[2]}${mapAssetUrl(m[3], version, baseUrl)}${m[2]}${m[4]}`;
      return line;
    })
    .join("\n");
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    console.error(`[FAIL] ${label}\nexpected to contain: ${needle}`);
    process.exit(1);
  }
  console.log(`[PASS] ${label}`);
}

function runFixtureTest() {
  const version = "0.1.0";
  const baseUrl = "";
  const before = [
    "version: 0.1.0",
    "files:",
    "  - url: YuTianClaw-Setup-0.1.0-x64.exe",
    "  - url: YuTianClaw-Setup-0.1.0-arm64.exe",
    "path: YuTianClaw-Setup-0.1.0-x64.exe",
    "releaseDate: '2026-03-18T11:44:42.922Z'",
    "",
  ].join("\n");

  const after = rewriteYaml(before, version, baseUrl);

  assertContains(
    after,
    "  - url: 0.1.0/YuTianClaw-Setup-0.1.0-x64.exe",
    "支持重写列表字段 - url"
  );
  assertContains(
    after,
    "  - url: 0.1.0/YuTianClaw-Setup-0.1.0-arm64.exe",
    "支持重写列表字段 - url（arm64）"
  );
  assertContains(
    after,
    "path: 0.1.0/YuTianClaw-Setup-0.1.0-x64.exe",
    "支持重写顶层 path"
  );
}

function maybeTestRealFile() {
  const file = process.argv[2];
  if (!file) return;

  const version = process.argv[3] || "0.1.0";
  const baseUrl = (process.argv[4] || "").trim().replace(/\/+$/, "");
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`[FAIL] 文件不存在: ${abs}`);
    process.exit(1);
  }

  const before = fs.readFileSync(abs, "utf8");
  const after = rewriteYaml(before, version, baseUrl);
  const out = `${abs}.rewritten`;
  fs.writeFileSync(out, after);
  console.log(`[INFO] 已生成重写结果: ${out}`);
}

runFixtureTest();
maybeTestRealFile();
console.log("[OK] rewrite latest yml test passed");
