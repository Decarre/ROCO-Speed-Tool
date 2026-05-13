#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const { setTimeout: sleep } = require("timers/promises");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.ROCO_DATA_DIR
  ? path.resolve(process.env.ROCO_DATA_DIR)
  : path.join(ROOT, "data");
const USE_EXTERNAL_DATA_DIR = Boolean(process.env.ROCO_DATA_DIR);
const IMAGE_DIR = path.join(DATA_DIR, "images");
const JSON_PATH = path.join(DATA_DIR, "spirits-db.json");
const JS_PATH = path.join(DATA_DIR, "spirits-db.js");
const SKILLS_JSON_PATH = path.join(DATA_DIR, "skills-db.json");
const SKILLS_JS_PATH = path.join(DATA_DIR, "skills-db.js");
const INDEX_URL = "https://wiki.biligame.com/rocom/%E7%B2%BE%E7%81%B5%E5%9B%BE%E9%89%B4";
const SKILL_INDEX_URL = "https://wiki.biligame.com/rocom/%E6%8A%80%E8%83%BD%E5%9B%BE%E9%89%B4";
const BASE_URL = "https://wiki.biligame.com";
const LICENSE_NOTE = "数据来源：洛克王国:手游WIKI_BWIKI。WIKI 页面声明文本数据采用 CC BY-NC-SA 4.0，请按其要求署名并用于非商业用途。";
const MAX_CONCURRENCY = 2;
const REQUEST_DELAY_MS = 700;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 567]);

const args = new Set(process.argv.slice(2));
const shouldDownloadImages = !args.has("--no-images");
const shouldUpdateSpirits = !args.has("--skills-only");
const shouldUpdateSkills = !args.has("--spirits-only");
const PROGRESS_PREFIX = "__ROCO_PROGRESS__";
const runRecognizerSelfTest = args.has("--recognizer-self-test");
const debugSpiritUrlArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--debug-spirit-url="));

main().catch((error) => {
  console.error(`更新失败：${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  if (runRecognizerSelfTest) {
    runSpeedEffectRecognizerSelfTest();
    return;
  }

  if (debugSpiritUrlArg) {
    const url = debugSpiritUrlArg.slice("--debug-spirit-url=".length);
    const html = await fetchText(url);
    console.log(JSON.stringify({
      url,
      speedTraits: parseSpeedTraits(html, htmlToText(html))
    }, null, 2));
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(IMAGE_DIR, { recursive: true });

  if (shouldUpdateSpirits) {
    await updateSpirits();
  }

  if (shouldUpdateSkills) {
    await updateSkills();
  }

  emitProgress({
    phase: "complete",
    label: "数据库更新完成",
    current: 1,
    total: 1,
    detail: "全部完成"
  });
}

function emitProgress(progress) {
  console.log(`${PROGRESS_PREFIX}${JSON.stringify({
    ...progress,
    time: Date.now()
  })}`);
}

async function updateSpirits() {
  console.log("正在读取精灵图鉴首页...");
  const indexHtml = await fetchText(INDEX_URL);
  const indexEntries = parseIndex(indexHtml);

  if (!indexEntries.length) {
    throw new Error("没有从图鉴首页解析到精灵条目，页面结构可能已变化。");
  }

  console.log(`图鉴首页解析到 ${indexEntries.length} 个条目，开始抓取详情...`);
  let completed = 0;
  emitProgress({
    phase: "spirits",
    label: "抓取精灵资料",
    current: completed,
    total: indexEntries.length,
    detail: "开始抓取精灵详情"
  });
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
    } finally {
      completed += 1;
      emitProgress({
        phase: "spirits",
        label: "抓取精灵资料",
        current: completed,
        total: indexEntries.length,
        detail: entry.displayName
      });
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
    licenseNote: LICENSE_NOTE,
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
  emitProgress({
    phase: "spirits",
    label: "精灵资料已保存",
    current: indexEntries.length,
    total: indexEntries.length,
    detail: "精灵数据库写入完成"
  });
}

async function updateSkills() {
  console.log("正在读取技能图鉴首页...");
  const skillIndexHtml = await fetchText(SKILL_INDEX_URL);
  const skillEntries = parseSkillIndex(skillIndexHtml);
  console.log(`技能图鉴首页解析到 ${skillEntries.length} 个候选技能，开始筛选速度技能...`);

  let completed = 0;
  emitProgress({
    phase: "skills",
    label: "筛选加速技能",
    current: completed,
    total: skillEntries.length,
    detail: "开始读取技能详情"
  });
  const skills = [];
  await mapLimit(skillEntries, MAX_CONCURRENCY, async (entry, index) => {
    await sleep((index % MAX_CONCURRENCY) * REQUEST_DELAY_MS);
    try {
      const detail = await scrapeSkillDetail(entry);
      if (detail) {
        skills.push(detail);
        console.log(`✓ 技能 ${detail.name} ${detail.variants.map((item) => `+${item.speedBonus}`).join("/")}`);
      }
    } catch (error) {
      console.warn(`跳过技能：${entry.name} ${error.message}`);
    } finally {
      completed += 1;
      emitProgress({
        phase: "skills",
        label: "筛选加速技能",
        current: completed,
        total: skillEntries.length,
        detail: entry.name
      });
    }
  });

  const sortedSkills = skills.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  const skillDatabase = {
    source: SKILL_INDEX_URL,
    licenseNote: LICENSE_NOTE,
    updatedAt: new Date().toISOString(),
    count: sortedSkills.length,
    skills: sortedSkills
  };

  await fs.writeFile(SKILLS_JSON_PATH, JSON.stringify(skillDatabase, null, 2), "utf8");
  await fs.writeFile(
    SKILLS_JS_PATH,
    `window.ROCO_SKILLS_DB = ${JSON.stringify(skillDatabase, null, 2)};\n`,
    "utf8"
  );

  console.log(`完成：已生成 ${SKILLS_JSON_PATH}`);
  console.log(`完成：已生成 ${SKILLS_JS_PATH}`);
  emitProgress({
    phase: "skills",
    label: "加速技能已保存",
    current: skillEntries.length,
    total: skillEntries.length,
    detail: "技能数据库写入完成"
  });
  await attachSpeedSkillsToSpirits(skillDatabase);
}

async function scrapeDetail(entry) {
  const html = await fetchText(entry.url);
  const text = htmlToText(html);
  const stats = parseStats(text);
  const speedTraits = parseSpeedTraits(html, text);
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
    skillNames: parseSpiritSkillNames(html),
    speedTraits,
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

function parseSkillIndex(html) {
  const entries = [];
  const seen = new Set();
  const anchorRegex = /<a\b[^>]*href="([^"]*\/rocom\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = anchorRegex.exec(html))) {
    const href = decodeHtml(match[1]);
    const name = cleanText(match[2]);
    if (!name || isIgnoredLinkText(name) || /^NO\./i.test(name) || seen.has(name)) continue;
    if (/图鉴|筛选|WIKI|页面|历史|编辑|刷新|地图|工具|攻略|贡献|设置|分类|用户|文件|模板|模块|帮助/.test(name)) continue;

    seen.add(name);
    entries.push({
      name,
      url: absoluteUrl(href)
    });
  }

  return entries;
}

async function scrapeSkillDetail(entry) {
  const html = await fetchText(entry.url);
  const text = htmlToText(html);
  if (!text.includes("技能威力")) return null;

  const effect = parseSkillEffect(text);
  const variants = parseSpeedBoostVariants(effect);
  if (!variants.length) return null;

  return {
    name: entry.name,
    effect,
    variants,
    pageUrl: entry.url
  };
}

function parseSkillEffect(text) {
  const normalized = text.replace(/\n+/g, "\n");
  const markIndex = normalized.indexOf("✦");
  if (markIndex >= 0) {
    const afterMark = normalized.slice(markIndex + 1, markIndex + 1400);
    return afterMark
      .split(/\n可以学会的精灵|\n取自|\n分类/)[0]
      .replace(/\n+/g, "")
      .trim();
  }

  const speedIndex = normalized.indexOf("速度+");
  if (speedIndex >= 0) {
    return normalized.slice(Math.max(0, speedIndex - 60), speedIndex + 180)
      .replace(/\n+/g, "")
      .trim();
  }

  return "";
}

function parseSpeedBoostVariants(effect) {
  return recognizeSpeedAdjustments(effect)
    .filter((item) => item.flatBonus > 0 && item.multiplier === 1)
    .map((item, index) => ({
      label: index === 0 ? "默认" : item.label,
      speedBonus: item.flatBonus,
      confidence: item.confidence,
      evidence: item.evidence
    }));
}

function recognizeSpeedEffects(effect) {
  return recognizeSpeedAdjustments(effect)
    .filter((item) => item.flatBonus !== 0)
    .map((item) => ({
      ...item,
      speedBonus: item.flatBonus
    }));
}

function recognizeSpeedAdjustments(effect) {
  const text = normalizeEffectText(effect);
  if (!text) return [];

  const adjustments = [];
  const clauses = splitEffectClauses(text);
  for (const clause of clauses) {
    const candidates = speedAdjustmentCandidates(clause);
    for (const candidate of candidates) {
      const duplicate = adjustments.some((item) =>
        item.flatBonus === candidate.flatBonus &&
        item.multiplier === candidate.multiplier &&
        item.label === candidate.label &&
        item.evidence === candidate.evidence
      );
      if (!duplicate) adjustments.push(candidate);
    }
  }

  return adjustments;
}

function normalizeEffectText(effect) {
  return decodeHtml(String(effect || ""))
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function splitEffectClauses(text) {
  return String(text || "")
    .split(/[。；;！!？?]/)
    .flatMap((part) => part.split(/(?=应对|若|如果|当|本技能)/))
    .map((part) => part.trim())
    .filter(Boolean);
}

function speedAdjustmentCandidates(clause) {
  if (!clause.includes("速度")) return [];
  const flatPatterns = [
    { regex: /速度(?:值|能力|等级)?(?:永久|临时|持续)?\s*\+\s*(\d+)/g, sign: 1 },
    { regex: /速度(?:值|能力|等级)?(?:永久|临时|持续)?(?:提升|提高|增加|上升|获得|强化)\s*(\d+)(?![\d%％倍])/g, sign: 1 },
    { regex: /(?:提升|提高|增加|上升|获得|强化)\s*(?:自身|自己|我方|本精灵)?\s*(\d+)(?![\d%％倍])\s*(?:点|的)?速度(?:值|能力|等级)?/g, sign: 1 },
    { regex: /\+\s*(\d+)\s*(?:点|的)?速度(?:值|能力|等级)?/g, sign: 1 },
    { regex: /速度(?:值|能力|等级)?(?:降低|减少|下降|削弱)\s*(\d+)(?![\d%％倍])/g, sign: -1 },
    { regex: /(?:降低|减少|下降|削弱)\s*(?:敌方|对方|目标|自身|自己|我方)?\s*(\d+)(?![\d%％倍])\s*(?:点|的)?速度(?:值|能力|等级)?/g, sign: -1 },
    { regex: /速度(?:值|能力|等级)?\s*-\s*(\d+)/g, sign: -1 }
  ];

  const candidates = [];
  for (const pattern of flatPatterns) {
    let match;
    while ((match = pattern.regex.exec(clause))) {
      const amount = Number(match[1]) * pattern.sign;
      if (!Number.isFinite(amount) || amount === 0) continue;
      const confidence = speedEffectConfidence(clause, match[0], amount);
      if (confidence < 60) continue;

      candidates.push({
        label: labelBefore(clause, match.index),
        flatBonus: amount,
        multiplier: 1,
        type: "flat",
        confidence,
        evidence: match[0]
      });
    }
  }

  const multiplierPatterns = [
    { regex: /速度(?:提升|提高|增加|上升)\s*(\d+(?:\.\d+)?)%/g, toMultiplier: (value) => 1 + value / 100 },
    { regex: /速度(?:降低|减少|下降)\s*(\d+(?:\.\d+)?)%/g, toMultiplier: (value) => Math.max(0, 1 - value / 100) },
    { regex: /速度(?:变为|变成|提升至|提高至)?\s*(\d+(?:\.\d+)?)\s*倍/g, toMultiplier: (value) => value }
  ];

  for (const pattern of multiplierPatterns) {
    let match;
    while ((match = pattern.regex.exec(clause))) {
      const multiplier = Math.round(pattern.toMultiplier(Number(match[1])) * 1000) / 1000;
      if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier === 1) continue;
      const confidence = speedEffectConfidence(clause, match[0], multiplier > 1 ? 1 : -1);
      if (confidence < 60) continue;

      candidates.push({
        label: labelBefore(clause, match.index),
        flatBonus: 0,
        multiplier,
        type: "multiplier",
        confidence,
        evidence: match[0]
      });
    }
  }

  return candidates;
}

function speedEffectConfidence(clause, evidence, amount) {
  let score = 0;
  if (/速度/.test(evidence)) score += 25;
  if (/[+\-]\d+|\d+/.test(evidence)) score += 20;
  if (/获得|提升|提高|增加|上升|强化|永久|临时|持续/.test(clause)) score += 35;
  if (/自己|自身|我方|本精灵/.test(clause)) score += 12;
  if (/降低|减少|下降|削弱/.test(clause) && amount < 0) score += 20;
  if (/改为|变为/.test(clause)) score += 15;
  if (/速度差|速度比|越高|越低|威力|伤害|先手|优先|命中|闪避/.test(clause)) score -= 45;
  if (/敌方|对方|目标/.test(clause) && amount > 0 && !/自己|自身|我方|本精灵/.test(clause)) score -= 25;
  if (/速度差值/.test(clause)) score -= 70;
  return Math.max(0, Math.min(100, score));
}

function runSpeedEffectRecognizerSelfTest() {
  const cases = [
    {
      name: "示弱",
      text: "自己获得萌化：速度永久+150。",
      expected: [150]
    },
    {
      name: "快速移动",
      text: "自己获得速度+80，应对防御：改为速度+160。",
      expected: [80, 160]
    },
    {
      name: "折射",
      text: "携带电属性技能时，自己获得50速度值。",
      expected: [50]
    },
    {
      name: "文字顺序变化",
      text: "提升自身150点速度。",
      expected: [150]
    },
    {
      name: "伤害依赖速度差，不是加速",
      text: "造成物伤，速度比敌方越高，本次技能威力越高。速度差值越大威力越高。",
      expected: []
    }
  ];
  const adjustmentCases = [
    {
      name: "速度百分比提升",
      text: "入场后速度提升20%。",
      expected: [{ flatBonus: 0, multiplier: 1.2 }]
    },
    {
      name: "速度倍数变化",
      text: "天气存在时速度变为1.5倍。",
      expected: [{ flatBonus: 0, multiplier: 1.5 }]
    },
    {
      name: "速度降低固定值",
      text: "目标速度降低50。",
      expected: [{ flatBonus: -50, multiplier: 1 }]
    }
  ];

  let failed = 0;
  for (const item of cases) {
    const actual = recognizeSpeedEffects(item.text).map((variant) => variant.speedBonus);
    const ok = JSON.stringify(actual) === JSON.stringify(item.expected);
    console.log(`${ok ? "✓" : "✗"} ${item.name}: ${JSON.stringify(actual)}`);
    if (!ok) failed += 1;
  }

  for (const item of adjustmentCases) {
    const actual = recognizeSpeedAdjustments(item.text).map((variant) => ({
      flatBonus: variant.flatBonus,
      multiplier: variant.multiplier
    }));
    const ok = JSON.stringify(actual) === JSON.stringify(item.expected);
    console.log(`${ok ? "✓" : "✗"} ${item.name}: ${JSON.stringify(actual)}`);
    if (!ok) failed += 1;
  }

  const blackCatTraits = parseSpeedTraits(`
    <div class="rocom_sprite_info_characteristic_content">
      <p><img alt="预警" title="预警" /></p>
      <p class="rocom_sprite_info_characteristic_title font-mainfeiziti">预警</p>
      <p class="rocom_sprite_info_characteristic_text font-fzltyjt">若敌方技能足够击败自己，回合开始时自己获得速度+50。</p>
    </div>
    <div class="rocom_sprite_temp_attribute_box">
      <p>精灵属性</p>
    </div>
  `, "");
  const blackCatOk = blackCatTraits[0]?.name === "预警" && blackCatTraits[0]?.variants?.[0]?.flatBonus === 50;
  console.log(`${blackCatOk ? "✓" : "✗"} 黑猫巫师特性: ${JSON.stringify(blackCatTraits)}`);
  if (!blackCatOk) failed += 1;

  if (failed) {
    throw new Error(`速度效果识别器自检失败：${failed} 项`);
  }
}

async function attachSpeedSkillsToSpirits(skillDatabase) {
  let database;
  try {
    database = JSON.parse(await fs.readFile(JSON_PATH, "utf8"));
  } catch {
    return;
  }

  if (!database?.spirits?.length) return;

  const skillByName = new Map(skillDatabase.skills.map((skill) => [skill.name, skill]));
  for (const spirit of database.spirits) {
    const skillNames = Array.isArray(spirit.skillNames) ? spirit.skillNames : [];
    spirit.speedSkills = skillNames
      .map((name) => skillByName.get(name))
      .filter(Boolean)
      .map((skill) => ({
        name: skill.name,
        effect: skill.effect,
        variants: skill.variants,
        pageUrl: skill.pageUrl
      }));
  }

  database.updatedAt = new Date().toISOString();
  await fs.writeFile(JSON_PATH, JSON.stringify(database, null, 2), "utf8");
  await fs.writeFile(
    JS_PATH,
    `window.ROCO_SPIRITS_DB = ${JSON.stringify(database, null, 2)};\n`,
    "utf8"
  );
  console.log(`完成：已把加速技能写入 ${JSON_PATH}`);
}

function parseSpiritSkillNames(html) {
  const decoded = decodeURIComponentSafe(decodeHtml(html));
  const mainStart = decoded.indexOf("精灵属性");
  const source = mainStart >= 0 ? decoded.slice(mainStart) : decoded;
  const endCandidates = ["取自“", "分类", "catlinks"];
  const end = endCandidates
    .map((marker) => source.indexOf(marker))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0] || source.length;
  const section = source.slice(0, end);
  const names = new Set();
  const imageRegex = /(?:alt|title)="技能图标\s+([^"]+)"/g;
  let match;

  while ((match = imageRegex.exec(section))) {
    const name = cleanSkillName(match[1]);
    if (name && !isIgnoredSkillName(name)) names.add(name);
  }

  const linkRegex = /<a\b[^>]*href="\/rocom\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((match = linkRegex.exec(section))) {
    const hrefName = cleanSkillName(decodeURIComponentSafe(match[1]).replace(/_/g, " "));
    const textName = cleanSkillName(cleanText(match[2]));
    const name = textName || hrefName;
    if (name && !isIgnoredSkillName(name)) names.add(name);
  }

  return Array.from(names);
}

function parseSpeedTraits(html, text) {
  const traits = parseTraitBlocks(html, text)
    .map((trait) => ({
      ...trait,
      variants: parseSpeedTraitVariants(trait.effect)
    }))
    .filter((trait) => trait.variants.length);

  if (traits.length) return traits;

  const section = parseTraitSection(html, text);
  if (!section) return [];

  const variants = parseSpeedTraitVariants(section);
  if (!variants.length) return [];

  return [{
    name: "速度特性",
    effect: section,
    variants
  }];
}

function parseTraitBlocks(html, text) {
  const decodedHtml = decodeURIComponentSafe(decodeHtml(html));
  const blocks = [];
  const traitArea = sliceTraitHtmlArea(decodedHtml);
  const blockRegex = /<div\b[^>]*class="([^"]*)"[^>]*>/g;
  let match;

  while ((match = blockRegex.exec(traitArea))) {
    if (!hasClassToken(match[1], "rocom_sprite_info_characteristic_content")) {
      continue;
    }

    const block = extractDivBlock(traitArea, match.index);
    if (!block) {
      continue;
    }

    const titleMatch = block.match(/class="[^"]*rocom_sprite_info_characteristic_title[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const effectMatch = block.match(/class="[^"]*rocom_sprite_info_characteristic_text[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const imageTitleMatch = block.match(/(?:alt|title)="([^"]+)"/);
    const name = cleanText(titleMatch?.[1] || imageTitleMatch?.[1] || "速度特性");
    const effect = cleanText(effectMatch?.[1] || block);
    if (effect) {
      blocks.push({ name, effect });
    }
  }

  if (blocks.length) return blocks;

  const section = parseTraitSection(html, text);
  return section ? [{ name: inferTraitName(section), effect: section }] : [];
}

function sliceTraitHtmlArea(decodedHtml) {
  const characteristicIndex = decodedHtml.search(/<div\b[^>]*class="[^"]*rocom_sprite_characteristic[^"]*"[^>]*>/);
  const start = characteristicIndex >= 0 ? characteristicIndex : 0;
  const rest = decodedHtml.slice(start);
  const attributeIndex = rest.search(/<div\b[^>]*class="[^"]*rocom_sprite_temp_attribute_box[^"]*"[^>]*>/);
  return attributeIndex >= 0 ? rest.slice(0, attributeIndex) : rest;
}

function hasClassToken(classValue, token) {
  return String(classValue || "").split(/\s+/).includes(token);
}

function extractDivBlock(html, startIndex) {
  const tagRegex = /<\/?div\b[^>]*>/g;
  tagRegex.lastIndex = startIndex;
  let depth = 0;
  let match;

  while ((match = tagRegex.exec(html))) {
    if (match[0][1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(startIndex, tagRegex.lastIndex);
      }
    } else {
      depth += 1;
    }
  }

  return "";
}

function parseTraitSection(html, text) {
  const decoded = decodeURIComponentSafe(decodeHtml(html));
  const plainText = text || htmlToText(decoded);
  const normalized = plainText.replace(/\n+/g, "\n");
  const startMatch = normalized.match(/精灵特性|特性/);
  if (!startMatch) return "";

  const start = startMatch.index || 0;
  const nearby = normalized.slice(start, start + 1800);
  return nearby
    .split(/\n(?:精灵属性|精灵技能|血脉技能|可学技能石|技能石|种族值|取自|分类)/)[0]
    .replace(/\n+/g, " ")
    .trim();
}

function inferTraitName(section) {
  const compact = String(section || "").replace(/\s+/g, "");
  const match = compact.match(/特性([^：:。；;\s]{1,12})/);
  return match ? match[1] : "速度特性";
}

function parseSpeedTraitVariants(effect) {
  return recognizeSpeedAdjustments(effect).map((adjustment, index) => ({
    label: index === 0 ? "默认" : adjustment.label,
    flatBonus: adjustment.flatBonus,
    multiplier: adjustment.multiplier,
    confidence: adjustment.confidence,
    evidence: adjustment.evidence
  }));
}

function cleanSkillName(value) {
  return String(value || "")
    .replace(/\.(?:png|jpg|jpeg|webp)$/i, "")
    .replace(/^技能图标\s*/, "")
    .replace(/_/g, " ")
    .trim();
}

function isIgnoredSkillName(name) {
  return /^(普通|草|火|水|光|地|冰|龙|电|毒|虫|武|翼|萌|幽|恶|机械|幻|物攻|魔攻|状态|防御|星星背景)$/.test(name);
}

function labelBefore(effect, matchIndex) {
  const before = effect.slice(0, matchIndex);
  const parts = before.split(/[。；;]/);
  const clause = parts[parts.length - 1] || "";
  const segment = clause.split(/[，,]/).pop() || clause;
  return segment
    .replace(/改为$/, "")
    .replace(/[：:，,、\s]+$/g, "")
    .trim() || "条件效果";
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
  const cachedPath = USE_EXTERNAL_DATA_DIR ? pathToFileURL(filePath).href : relativePath;

  try {
    await fs.access(filePath);
    return cachedPath;
  } catch {
    // Image is not cached yet.
  }

  try {
    const bytes = await fetchBuffer(url);
    await fs.writeFile(filePath, bytes);
    return cachedPath;
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
