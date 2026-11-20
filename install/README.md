# 安装

## 1. 安装 Tampermonkey

在 Chrome 安装 Tampermonkey 扩展。

## 2. 启动本地安装服务

在仓库根目录执行：

```bash
./install/serve.sh
```

服务默认监听：

```text
http://127.0.0.1:8787/1in8b-recorder.user.js
```

## 3. 安装用户脚本

在 Chrome 打开上面的本地地址，Tampermonkey 会显示安装或更新。

## 4. 打开游戏

打开：

```text
https://1in8b.life/
```

刷新页面，右下角会出现记录器。

## 更新

更新版本时：

1. 在仓库中更新 `src/1in8b-recorder.user.js`
2. 保持 `serve.sh` 运行
3. 在 Chrome 打开安装地址
4. Tampermonkey 点更新
5. 刷新游戏页

## 说明

- 本地服务只绑定 `127.0.0.1`
- 不修改游戏存档
- 所有记录保存在浏览器 IndexedDB
- 删除浏览器站点数据会同时删除记录器数据，建议先导出
