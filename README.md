# 洛克王国世界速度工具

本项目现在提供桌面版：安装后点击程序图标即可打开独立窗口，不需要手动打开浏览器页面。

## 使用

- 安装版：从 GitHub Release 下载 `洛克王国世界速度工具 Setup.exe`，安装后从桌面或开始菜单启动。
- 开发版：运行 `npm install` 后执行 `npm start`。
- 首次打开不会内置完整数据库，点击右上角“更新数据库”后会从 BWiki 抓取精灵和技能数据。
- 数据库会保存到系统应用数据目录，不会打包进安装包。

## 功能

- 按公式计算减速、默认、加速三种性格速度
- 计算加速技能，并支持设置技能使用次数
- 计算速度相关特性，支持固定速度修正和倍率修正
- 从 BWiki 精灵图鉴抓取精灵名称、编号、立绘链接和种族值
- 从 BWiki 技能图鉴抓取加速技能，并按精灵可用技能匹配
- 使用统一的本地轻量速度效果识别器判断技能和特性文本，覆盖 `速度+80`、`速度永久+150`、`提升自身150点速度`、`速度提升20%` 等多种描述
- 更新数据库时会尝试从精灵详情页识别速度特性，复杂条件可手动填写
- 推送版本标签时会由 GitHub Actions 自动生成 Release 安装包
- 支持按名称、`noXXX` 编号、`sXXX` 速度搜索
- 自动记住查询历史，支持单条编辑/删除
- 显示竖向速度线和常见速度点

## 数据库更新

桌面版推荐直接点击右上角“更新数据库”。

命令行也可以更新：

```text
npm run update-db
node scripts\update-db.js --no-images
node scripts\update-db.js --skills-only --no-images
node scripts\update-db.js --spirits-only --no-images
```

默认命令会生成：

```text
data/spirits-db.json
data/spirits-db.js
data/skills-db.json
data/skills-db.js
data/images/
```

这些文件是本地生成数据，不作为程序本体提交或打包。

## 打包

```text
npm install
npm run dist
```

安装包会输出到 `dist/`，并排除已下载的数据库和图片。

## 计算公式

```text
速度 = round((round(1.1 × 基础速度) + round(0.55 × 个体值) + 10) × 性格修正) + 50
```

性格修正：

```text
减速 = 0.9
默认 = 1.0
加速 = 1.2
```

精灵图鉴数据来源：洛克王国:手游WIKI_BWIKI。该 WIKI 页面声明文本数据采用 CC BY-NC-SA 4.0，使用时请按其要求署名并用于非商业用途。
