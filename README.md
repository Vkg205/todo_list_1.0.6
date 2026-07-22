# FocusTodo Pro Desktop v1.0.3

Windows 本地独立运行的 Electron 待办工具，可脱离 Chrome 使用。

## 本次版本重点

- 修复子任务文本框无法正常输入的问题。
- 支持 XLSX、CSV、JSON 导入与导出。
- 内置标准 XLSX 导入模板，中文字段不会因 CSV 编码产生乱码。
- 支持附件文件选择、打开和链接附件。
- 补齐循环任务生成、跳过循环、终止循环、稍后提醒。
- 新增周历、组合筛选、清单隐藏/恢复、默认清单与优先级设置。
- 保留本地 JSON 持久化和自动备份。

## 本地启动

```bash
npm install --no-audit --no-fund
npm start
```

## 构建 Windows EXE

```bash
npm run build:win
```

也可以直接使用 `.github/workflows/build-windows.yml` 在 GitHub Actions 编译。

## 导入模板

项目内置：

```text
templates/FocusTodo_Import_Template.xlsx
```

应用中也可进入“设置 → 导入、导出与备份 → XLSX 模板”另存模板。

## 数据位置

应用数据保存在 Electron `userData` 目录下的 `todo-data.json`，并保留 `todo-data.backup.json`。覆盖安装和普通卸载默认不会删除任务数据。

## v1.0.5 任务依赖与 DDL
- 支持多前置任务、完成阻塞和循环依赖检查。
- 前置任务计划时间向后调整时，后续任务递归自动顺延。
- 末尾任务必须填写 DDL；顺延后超过 DDL 会自动置顶提醒重新排期。
- XLSX/CSV 导入导出新增前置任务ID、末尾任务和 DDL 字段。
