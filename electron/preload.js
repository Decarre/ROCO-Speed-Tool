"use strict";

const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

function dataDirFromArgv() {
  const prefix = "--roco-data-dir=";
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const dataDir = dataDirFromArgv();
const spirits = dataDir ? readJson(path.join(dataDir, "spirits-db.json")) : null;
const skills = dataDir ? readJson(path.join(dataDir, "skills-db.json")) : null;

if (spirits) window.ROCO_SPIRITS_DB = spirits;
if (skills) window.ROCO_SKILLS_DB = skills;

window.ROCO_DESKTOP = {
  dataDir,
  async updateDatabase(options) {
    return ipcRenderer.invoke("roco:update-db", options);
  },
  async readDatabase() {
    return ipcRenderer.invoke("roco:read-db");
  },
  async openDataDir() {
    return ipcRenderer.invoke("roco:open-data-dir");
  },
  onUpdateLog(callback) {
    ipcRenderer.on("roco:update-log", (_event, text) => callback(text));
  },
  onUpdateProgress(callback) {
    ipcRenderer.on("roco:update-progress", (_event, progress) => callback(progress));
  }
};
