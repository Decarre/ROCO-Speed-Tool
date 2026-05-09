"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");

let mainWindow;

function appDataDir() {
  return path.join(app.getPath("userData"), "data");
}

function appPath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readDatabase() {
  const dataDir = appDataDir();
  const [spirits, skills] = await Promise.all([
    readJson(path.join(dataDir, "spirits-db.json")),
    readJson(path.join(dataDir, "skills-db.json"))
  ]);
  return { dataDir, spirits, skills };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: "洛克王国世界速度工具",
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: appPath("electron", "preload.js"),
      contextIsolation: false,
      nodeIntegration: false,
      additionalArguments: [`--roco-data-dir=${appDataDir()}`]
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(appPath("index.html"));
}

ipcMain.handle("roco:read-db", readDatabase);

ipcMain.handle("roco:open-data-dir", async () => {
  await fs.mkdir(appDataDir(), { recursive: true });
  await shell.openPath(appDataDir());
});

ipcMain.handle("roco:update-db", async (_event, options = {}) => {
  const dataDir = appDataDir();
  await fs.mkdir(dataDir, { recursive: true });

  const scriptPath = appPath("scripts", "update-db.js");
  const args = [scriptPath];
  if (options.noImages) args.push("--no-images");
  if (options.skillsOnly) args.push("--skills-only");
  if (options.spiritsOnly) args.push("--spirits-only");

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: app.getAppPath(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ROCO_DATA_DIR: dataDir
      },
      windowsHide: true
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      mainWindow?.webContents.send("roco:update-log", chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
      mainWindow?.webContents.send("roco:update-log", chunk.toString("utf8"));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`数据库更新失败，退出码 ${code}\n${output}`));
      }
    });
  });

  return readDatabase();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
