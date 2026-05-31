/**
 * afterPack.js — electron-builder afterPack 钩子
 *
 * 在 electron-builder 完成文件收集（含 node_modules 剥离）之后、
 * 签名和生成安装包之前，将预构建的 Node.js + openclaw 资源注入到 app bundle。
 *
 * 目录结构（注入后）:
 *   macOS: YuTianClaw.app/Contents/Resources/gateway/
 *   Windows: resources/gateway/ + resources/runtime/
 *
 * macOS 不需要注入 runtime/node，因为打包模式下 constants.ts 直接复用
 * Electron Helper binary（ELECTRON_RUN_AS_NODE=1），无需独立 Node.js 二进制。
 */

"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { Arch } = require("builder-util");

// ─── 工具函数 ───

function resolveArchName(arch) {
  if (typeof arch === "string") return arch;
  const name = Arch[arch];
  if (typeof name === "string") return name;
  throw new Error(`[afterPack] 无法识别 arch: ${String(arch)}`);
}

function resolveTargetId(context) {
  // 环境变量覆盖（调试/CI 场景）
  const fromEnv = process.env.YUTIANCLAW_TARGET;
  if (fromEnv) return fromEnv;
  const platform = context.electronPlatformName;
  const arch = resolveArchName(context.arch);
  return `${platform}-${arch}`;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isSymbolicLink()) {
      // 符号链接 → 解引用后复制实际文件（避免 asar/signing 问题）
      try {
        const real = fs.realpathSync(s);
        fs.copyFileSync(real, d);
        fs.chmodSync(d, fs.statSync(real).mode);
      } catch {
        // 悬挂链接（常见于 node_modules/.bin）直接跳过，避免 ENOENT 中断打包
        try {
          const target = fs.readlinkSync(s);
          console.warn(`[afterPack] 跳过悬挂符号链接: ${s} -> ${target}`);
        } catch {
          console.warn(`[afterPack] 跳过无法解析的符号链接: ${s}`);
        }
      }
    } else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode);
    }
  }
}

function injectDir(src, dest, label, appOutDir) {
  if (!fs.existsSync(src)) {
    throw new Error(`[afterPack] 资源目录不存在: ${src}`);
  }
  copyDirSync(src, dest);
  console.log(`[afterPack] 已注入 ${label}/ → ${path.relative(appOutDir, dest)}`);
}

function addDirToZip(zip, srcDir, zipPrefix = "") {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDirToZip(zip, src, zipPath);
    } else if (entry.isFile()) {
      zip.addLocalFile(src, zipPrefix);
    }
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function archiveGatewayDir(resourcesDir, appOutDir) {
  const gatewayDir = path.join(resourcesDir, "gateway");
  const gatewayZip = path.join(resourcesDir, "gateway.zip");
  const openclawPkgPath = path.join(gatewayDir, "node_modules", "openclaw", "package.json");

  if (fs.existsSync(openclawPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(openclawPkgPath, "utf-8"));
    fs.writeFileSync(
      path.join(resourcesDir, "gateway-version.json"),
      `${JSON.stringify({ version: pkg.version || "unknown", nodeVersion: "22" }, null, 2)}\n`,
      "utf-8"
    );
  }

  if (!fs.existsSync(gatewayDir)) {
    throw new Error(`[afterPack] gateway 目录不存在，无法压缩: ${gatewayDir}`);
  }

  if (fs.existsSync(gatewayZip)) fs.rmSync(gatewayZip, { force: true });

  const zip = new AdmZip();
  addDirToZip(zip, gatewayDir);
  // 只把 2 万多个小文件聚合成一个文件，不在 zip 层压缩。
  // 这样 NSIS 仍可统一压缩安装包，兼顾下载体积和安装时文件数。
  for (const entry of zip.getEntries()) {
    entry.header.method = 0;
  }
  zip.writeZip(gatewayZip);

  const hash = sha256File(gatewayZip);
  fs.writeFileSync(`${gatewayZip}.sha256`, hash, "utf-8");
  fs.rmSync(gatewayDir, { recursive: true, force: true });

  const sizeMb = (fs.statSync(gatewayZip).size / 1024 / 1024).toFixed(2);
  console.log(
    `[afterPack] 已压缩 gateway/ → ${path.relative(appOutDir, gatewayZip)} (${sizeMb} MB, sha256=${hash.slice(0, 12)})`
  );
}

// ─── afterPack 入口 ───

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const appOutDir = context.appOutDir;
  const targetId = resolveTargetId(context);
  const arch = resolveArchName(context.arch);

  // 平台差异：macOS 资源在 .app 包内，Windows 直接在 resources/ 下
  const resourcesDir =
    platform === "darwin"
      ? path.join(
          appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources"
        )
      : path.join(appOutDir, "resources");

  const sourceBase = path.join(__dirname, "..", "resources", "targets", targetId);

  if (!fs.existsSync(sourceBase)) {
    throw new Error(
      [
        `[afterPack] 未找到目标资源目录: ${sourceBase}`,
        `请先执行资源打包:`,
        `  node scripts/package-resources.js --platform ${platform} --arch ${arch}`,
        `或通过 npm 脚本:`,
        `  npm run package:resources -- --platform ${platform} --arch ${arch}`,
      ].join("\n")
    );
  }

  console.log(`[afterPack] 使用目标资源: ${targetId}`);

  // ── 注入 gateway/（所有平台必须）──
  injectDir(
    path.join(sourceBase, "gateway"),
    path.join(resourcesDir, "gateway"),
    "gateway",
    appOutDir
  );

  // ── 验证插件已注入（构建时由 package-resources.js Step 3 写入 openclaw/extensions/）──
  const extDir = path.join(resourcesDir, "gateway", "node_modules", "openclaw", "extensions");
  if (fs.existsSync(extDir)) {
    const plugins = fs.readdirSync(extDir).filter((f) => {
      const manifest = path.join(extDir, f, "openclaw.plugin.json");
      return fs.existsSync(manifest);
    });
    if (plugins.length > 0) {
      console.log(`[afterPack] 已注入插件（${plugins.length} 个）: ${plugins.join(", ")}`);
    } else {
      console.warn(
        "[afterPack] ⚠️  extensions/ 存在但无有效插件，国内 IM 渠道功能不可用\n" +
          "           请重新执行: node scripts/package-resources.js"
      );
    }
  } else {
    console.warn(
      "[afterPack] ⚠️  未找到 openclaw/extensions/，国内 IM 渠道插件将不可用\n" +
        "           请重新执行: node scripts/package-resources.js"
    );
  }

  // ── 验证 clawhub CLI 已安装 ──
  const clawhubEntry = path.join(resourcesDir, "gateway", "node_modules", "clawhub", "bin", "clawdhub.js");
  if (fs.existsSync(clawhubEntry)) {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(resourcesDir, "gateway", "node_modules", "clawhub", "package.json"),
        "utf-8"
      )
    );
    console.log(`[afterPack] clawhub v${pkg.version} 已就绪`);
  } else {
    console.warn(
      "[afterPack] ⚠️  未找到 clawhub，skills 管理功能将不可用\n" +
        "           请重新执行: node scripts/package-resources.js"
    );
  }

  // ── 将 gateway 大量小文件压成单个 zip，减少 NSIS 安装时文件解压数量 ──
  archiveGatewayDir(resourcesDir, appOutDir);

  // ── 注入 runtime/（仅 Windows 需要，macOS 使用 Electron Helper 代替 Node.js）──
  if (platform === "win32") {
    injectDir(
      path.join(sourceBase, "runtime"),
      path.join(resourcesDir, "runtime"),
      "runtime",
      appOutDir
    );
  }

  // ── macOS：删除注入的 runtime/bin/node 节省空间（打包模式下不使用）──
  // （macOS 不注入 runtime/ 所以无需处理）

  console.log("[afterPack] 资源注入完成");
};
