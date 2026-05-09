#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const { setTimeout: sleep } = require("timers/promises");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const JSON_PATH = path.join(DATA_DIR, "spirits-db.json");
const JS_PATH = path.join(DATA_DIR, "spirits-db.js");
const INDEX_URL = "https://wiki.biligame.com/rocom/%E7%B2%BE%E7%81%B5%E5%9B%BE%E9%89%B4";
const BASE_URL = "https://wiki.biligame.com";
const MAX_CONCURRENCY = 2;
const REQUEST_DELAY_MS = 700;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 567]);

const args = new Set(process.argv.slice(2));
const shouldDownloadImages = !args.has("--no-images");

main().catch((error) => {
  console.error(`更新失败：${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGE_DIR, { recursive: true });

  console.log("正在读取精灵图鉴首页...");
  const indexHtml = await fetchText(INDEX_URL);
  const indexEntries = parseIndex(indexHtml);

  if (!indexEntries.length) {
    throw new Error("没有从图鉴首页解析到精灵条目，页面结构可能已变化。");
  }

  console.log(`图鉴首页解析到 ${indexEntries.length} 个条目，开始抓取详情...`);
  const spirits = [];
  await mapLimit(indexEntries, MAX_CONCURRENCY, async (entry, index) => {
    await sleep((index % MAX_CONCURRENCY) * REQUEST_DELAY_MS);
    try {
      const detail = await scrapeDetail(entry);
      if (detail && Number.isFinite(detail.baseSpeed)) {
        spirits.push(detail);
        console.log(`✓ ${detail.no || ""} ${detail.displayName} 速度${detail.baseSpeed}`);
      } else {
        console.warn(`跳过：${entry.displayName} 未解析到速度种族值`);
      }
    } catch (error) {
      console.warn(`跳过：${entry.displayName} ${error.message}`);
    }
  });

  const sorted = spirits.sort((a, b) => {
    const noDiff = Number(a.noNumber || 0) - Number(b.noNumber || 0);
    return noDiff || a.displayName.localeCompare(b.displayName, "zh-Hans-CN");
  });

  if (sorted.length < Math.max(20, indexEntries.length * 0.6)) {
    throw new Error(`只成功解析 ${sorted.length}/${indexEntries.length} 条，疑似被限流；已取消写入，稍后再试。`);
  }

  const database = {
    source: INDEX_URL,
    licenseNote: "数据来源：洛克王国:手游WIKI_BWIKI。WIKI 页面声明文本数据采用 CC BY-NC-SA 4.0，请按其要求署名并用于非商业用途。",
    updatedAt: new Date().toISOString(),
    count: sorted.length,
    spirits: sorted
  };

  await fs.writeFile(JSON_PATH, JSON.stringify(database, null, 2), "utf8");
  await fs.writeFile(
    JS_PATH,
    `window.ROCO_SPIRITS_DB = ${JSON.stringify(database, null, 2)};\n`,
    "utf8"
  );

  console.log(`完成：已生成 ${JSON_PATH}`);
  console.log(`完成：已生成 ${JS_PATH}`);
}

async function scrapeDetail(entry) {
  const html = await fetchText(entry.url);
  const text = htmlToText(html);
  const stats = parseStats(text);
  const portraitUrl = findPortraitUrl(html, entry.name) || entry.portraitUrl || "";
  const localImage = shouldDownloadImages && portraitUrl
    ? await downloadPortrait(portraitUrl, entry)
    : "";

  return {
    no: entry.no,
    noNumber: entry.noNumber,
    name: entry.name,
    form: entry.form,
    displayName: entry.displayName,
    baseSpeed: stats.speed,
    stats,
    portraitUrl,
    localImage,
    pageUrl: entry.url
  };
}

function parseIndex(html) {
  const anchors = [];
  const anchorRegex = /<a\b[^>]*href="([^"]*\/rocom\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = anchorRegex.exec(html))) {
    const href = decodeHtml(match[1]);
    const text = cleanText(match[2]);
    if (!text) continue;
    anchors.push({
      href: absoluteUrl(href),
      text,
      index: match.index
    });
  }

  const entries = [];
  const seen = new Set();

  for (let i = 0; i < anchors.length; i += 1) {
    const current = anchors[i];
    const noMatch = current.text.match(/^NO\.(\d+)/i);
    if (!noMatch) continue;

    const next = anchors[i + 1];
    if (!next || isIgnoredLinkText(next.text)) continue;

    let form = "";
    const maybeForm = anchors[i + 2];
    if (maybeForm && maybeForm.index - next.index < 500 && !/^NO\./i.test(maybeForm.text) && !isIgnoredLinkText(maybeForm.text)) {
      form = maybeForm.text === next.text ? "" : maybeForm.text;
    }

    const windowHtml = html.slice(current.index, Math.min(html.length, current.index + 1800));
    const portraitUrl = findPortraitUrl(windowHtml, next.text);
    const name = next.text.trim();
    const displayName = form ? `${name}（${form}）` : name;
    const key = `${current.text}|${displayName}|${next.href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      no: current.text,
      noNumber: Number(noMatch[1]),
      name,
      form,
      displayName,
      url: next.href,
      portraitUrl
    });
  }

  return entries;
}

function parseStats(text) {
  const labels = ["种族值", "生命", "物攻", "魔攻", "物防", "魔防", "速度"];
  const stats = {};

  for (const label of labels) {
    const value = numberAfterLabel(text, label);
    if (Number.isFinite(value)) {
      const key = {
        "种族值": "total",
        "生命": "hp",
        "物攻": "physicalAttack",
        "魔攻": "magicAttack",
        "物防": "physicalDefense",
        "魔防": "magicDefense",
        "速度": "speed"
      }[label];
      stats[key] = value;
    }
  }

  return stats;
}

function numberAfterLabel(text, label) {
  const index = text.indexOf(label);
  if (index < 0) return NaN;
  const nearby = text.slice(index + label.length, index + label.length + 80);
  const match = nearby.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : NaN;
}

function findPortraitUrl(html, name) {
  const decoded = decodeHtml(html);
  const imageRegex = /(?:src|data-src|data-original)="([^"]+)"/g;
  const candidates = [];
  let match;
  while ((match = imageRegex.exec(decoded))) {
    const url = absoluteUrl(match[1]);
    const cleanUrl = decodeURIComponentSafe(url);
    if (/页面[ _%]宠物[ _%]立绘|%E9%A1%B5%E9%9D%A2.*%E5%AE%A0%E7%89%A9.*%E7%AB%8B%E7%BB%98/.test(cleanUrl)) {
      candidates.push(url);
    }
  }

  if (!candidates.length) return "";
  const nameHit = candidates.find((url) => decodeURIComponentSafe(url).includes(name));
  return nameHit || candidates[0];
}

async function downloadPortrait(url, entry) {
  const extMatch = new URL(url).pathname.match(/\.(png|jpg|jpeg|webp)(?:$|\/)/i);
  const ext = extMatch ? extMatch[1].toLowerCase().replace("jpeg", "jpg") : "png";
  const fileName = `${safeFileName(`${entry.no}-${entry.displayName}`)}.${ext}`;
  const filePath = path.join(IMAGE_DIR, fileName);
  const relativePath = `data/images/${fileName}`;

  try {
    await fs.access(filePath);
    return relativePath;
  } catch {
    // Image is not cached yet.
  }

  try {
    const bytes = await fetchBuffer(url);
    await fs.writeFile(filePath, bytes);
    return relativePath;
  } catch (error) {
    console.warn(`立绘下载失败：${entry.displayName} ${error.message}`);
    return "";
  }
}

async function fetchText(url) {
  const buffer = await fetchBuffer(url);
  return buffer.toString("utf8");
}

async function fetchBuffer(url) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 ROCO-Speed-Tool/1.0 (+local personal database updater)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,*/*;q=0.8",
          "Referer": INDEX_URL
        },
        redirect: "follow"
      });

      if (response.ok) {
        return Buffer.from(await response.arrayBuffer());
      }

      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!RETRY_STATUSES.has(response.status)) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }

    const delay = 1200 * (attempt + 1) * (attempt + 1);
    await sleep(delay);
  }
  throw lastError;
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function htmlToText(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\s+/g, "\n")
    .trim();
}

function cleanText(html) {
  return decodeHtml(html)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function absoluteUrl(value) {
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return new URL(value, BASE_URL).toString();
}

function isIgnoredLinkText(text) {
  return /^(首页|图鉴|地图|工具|攻略|刷新|阅读|编辑|查看全部|精灵图鉴|精灵筛选|普通|草|火|水|光|地|冰|龙|电|毒|虫|武|翼|萌|幽|恶|机械|幻)$/.test(text);
}

function safeFileName(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}
