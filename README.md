# 洛克王国世界速度工具

双击 `启动速度工具.bat` 即可打开本地工具。

功能：

- 按公式计算减速、不变、加速三种性格速度
- 从 BWiki 精灵图鉴自动抓取精灵名称、立绘链接和种族值
- 从 BWiki 技能图鉴自动抓取加速技能，并记录每只精灵可使用的加速技能
- 搜索本地精灵资料库
- 自动记住查询历史
- 支持导入/导出 JSON 或 CSV 数据

数据库更新：

```text
双击 启动速度工具.bat：先自动更新数据库，再打开工具
双击 更新数据库.bat：只更新数据库
node scripts\update-db.js：更新精灵和技能数据库，并下载立绘到 data/images
node scripts\update-db.js --no-images：更新精灵和技能数据库，只使用远程立绘链接
node scripts\update-db.js --skills-only --no-images：只更新加速技能映射
node scripts\update-db.js --spirits-only --no-images：只更新精灵种族值
```

生成文件：

```text
data/spirits-db.json
data/spirits-db.js
data/skills-db.json
data/skills-db.js
data/images/
```

计算公式：

```text
速度 = round((round(1.1 × 基础速度) + round(0.55 × 个体值) + 10) × 性格修正) + 50
```

性格修正：

```text
减速 = 0.9
不变 = 1.0
加速 = 1.2
```

精灵图鉴数据来源：洛克王国:手游WIKI_BWIKI。该 WIKI 页面声明文本数据采用 CC BY-NC-SA 4.0，使用时请按其要求署名并用于非商业用途。

查询历史和你手动编辑的数据保存在浏览器本机的 localStorage 中。导出数据可以作为备份。
