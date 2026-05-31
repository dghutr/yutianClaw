"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function fail(message) {
  console.error(`[merge-latest-yml] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { out: "", inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      opts.out = argv[++i] || "";
    } else if (arg === "--in") {
      opts.inputs.push(argv[++i] || "");
    } else {
      fail(`未知参数: ${arg}`);
    }
  }
  if (!opts.out || opts.inputs.length < 2) {
    fail("用法: node scripts/merge-latest-yml.js --out <file> --in <file1> --in <file2>");
  }
  return opts;
}

function readYaml(file) {
  if (!fs.existsSync(file)) fail(`文件不存在: ${file}`);
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function toArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function normalizeFiles(doc) {
  const files = toArray(doc.files).map((item) => ({ ...item }));
  if (files.length > 0) return files;

  if (doc.path || doc.sha512 || doc.sha2) {
    return [
      {
        url: doc.path || doc.url,
        sha512: doc.sha512,
        sha2: doc.sha2,
      },
    ].filter((item) => item.url);
  }

  return [];
}

function mergePackages(docs) {
  const merged = {};
  for (const doc of docs) {
    const packages = doc.packages;
    if (!packages || typeof packages !== "object") continue;
    for (const [arch, info] of Object.entries(packages)) {
      merged[arch] = info;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function dedupeFiles(files) {
  const map = new Map();
  for (const file of files) {
    const key = file.url || file.path;
    if (!key) continue;
    map.set(key, file);
  }
  return Array.from(map.values());
}

function mergeDocs(docs) {
  const [first, ...rest] = docs;
  if (!first) fail("没有可合并的 yml");

  for (const doc of rest) {
    if (doc.version !== first.version) {
      fail(`version 不一致: ${first.version} vs ${doc.version}`);
    }
  }

  const merged = {
    version: first.version,
    files: dedupeFiles(docs.flatMap(normalizeFiles)),
    releaseDate: first.releaseDate,
  };

  const packages = mergePackages(docs);
  if (packages) merged.packages = packages;

  if (first.stagingPercentage != null) merged.stagingPercentage = first.stagingPercentage;
  if (first.minimumSystemVersion != null) merged.minimumSystemVersion = first.minimumSystemVersion;

  return merged;
}

const opts = parseArgs(process.argv.slice(2));
const docs = opts.inputs.map((file) => readYaml(path.resolve(file)));
const merged = mergeDocs(docs);
const outFile = path.resolve(opts.out);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, yaml.dump(merged, { lineWidth: 120, noRefs: true }));

console.log(`[merge-latest-yml] merged ${opts.inputs.length} files -> ${outFile}`);
console.log(
  `[merge-latest-yml] files: ${merged.files.map((file) => file.url || file.path).join(", ")}`
);
