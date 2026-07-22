# GitHub Actions 编译步骤

1. 新建或清空 GitHub 仓库。
2. 将本目录内的全部文件上传到仓库根目录，必须保留 `.github/workflows/build-windows.yml`。
3. 不要上传旧版 `package-lock.json`。本包刻意不包含锁文件，工作流会从 npm 官方仓库重新安装依赖。
4. 打开 Actions → Build Windows EXE → Run workflow。
5. 成功后在运行详情底部 Artifacts 下载 `FocusTodo-Windows`。
6. 解压后可得到安装版和便携版 EXE。

若仓库里已有旧文件，请先删除旧的 `package-lock.json`，再上传本包。
