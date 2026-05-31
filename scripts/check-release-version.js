"use strict";

const fs = require("fs");
const path = require("path");
const semver = require("semver");

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = String(pkg.version || "").trim();

function fail(message) {
  console.error(`[release-version] ${message}`);
  process.exit(1);
}

if (!version) {
  fail("package.json 缺少 version");
}

if (!semver.valid(version)) {
  fail(`版本 "${version}" 不是合法 semver。请使用 x.y.z 或合法 prerelease/build 元数据格式`);
}

console.log(`[release-version] version ok: ${version}`);
