# FocusTodo Pro：GitHub 云端编译 Windows EXE

这个压缩包是 **Windows 桌面版完整源码**。GitHub Actions 会在真正的 Windows 云主机上生成：

- `FocusTodo Pro-1.0.0-x64.exe`：可选择安装位置的安装版
- `FocusTodo Pro-1.0.0-x64.exe`：便携版也会生成，但由于默认文件名模板可能相近，electron-builder 通常会自动区分；可在 Actions 产物中查看全部 EXE

> 云端编译不需要你的电脑安装 Node.js、Electron 或 Visual Studio。

## 方法一：网页手动触发编译

### 1. 新建 GitHub 仓库

1. 登录 GitHub。
2. 点击右上角 `+` → `New repository`。
3. 仓库名称填写 `FocusTodo-Desktop`。
4. 建议选择 `Private`，避免源码公开。
5. 不要勾选初始化 README、`.gitignore` 或 License。
6. 点击 `Create repository`。

### 2. 上传源码

1. 解压本压缩包。
2. 打开刚创建的仓库。
3. 点击 `uploading an existing file`，或 `Add file` → `Upload files`。
4. 将解压目录里的所有内容上传到仓库根目录。
5. 必须确认以下文件位于仓库根目录：

```text
package.json
main.js
preload.js
src/
.github/workflows/build-windows.yml
```

6. 点击 `Commit changes`。

### 3. 启动云端编译

1. 打开仓库顶部的 `Actions`。
2. 第一次使用时，点击允许启用 Actions。
3. 左侧选择 `Build Windows EXE`。
4. 点击右侧 `Run workflow` → 再点击绿色 `Run workflow`。
5. 等待约 3～10 分钟，直到任务显示绿色对勾。

### 4. 下载 EXE

1. 点击已完成的编译任务。
2. 滚动到页面下方的 `Artifacts`。
3. 下载 `FocusTodo-Windows`。
4. 解压下载文件，即可看到 Windows `.exe`。

GitHub 的 Artifacts 通常保留 90 天，具体时间受仓库设置影响。

## 方法二：通过版本标签自动编译并发布

在本地安装 Git 后，在项目目录执行：

```bash
git init
git add .
git commit -m "Initial FocusTodo desktop"
git branch -M main
git remote add origin https://github.com/你的用户名/FocusTodo-Desktop.git
git push -u origin main

git tag v1.0.0
git push origin v1.0.0
```

推送 `v1.0.0` 标签后，工作流不仅会编译，还会自动把 EXE 上传到仓库的 `Releases` 页面。

## 本地调试（可选）

电脑安装 Node.js 22 后，在项目目录执行：

```bash
npm install
npm start
```

本地打包 Windows EXE：

```bash
npm run build:win
```

生成文件位于：

```text
dist/
```

## Windows 安装提示

由于当前安装包没有购买代码签名证书，Windows SmartScreen 可能显示“未知发布者”。这是未签名的个人应用常见提示，不代表程序包含病毒。可点击：

```text
更多信息 → 仍要运行
```

正式对外发布时，建议购买 Windows 代码签名证书，并在 GitHub Secrets 中配置签名。

## 桌面版已增加

- 脱离 Chrome 独立运行
- Windows 系统托盘
- 关闭窗口后后台常驻
- 托盘快速新建待办
- 开机自动启动开关
- Windows 原生通知
- 本地 JSON 数据文件和原子写入
- 提醒任务重新调度

桌面版本身不能直接读取 Chrome 当前网页，这是浏览器扩展专属权限；可以在任务附件中手动粘贴网页链接。
