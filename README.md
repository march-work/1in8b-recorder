# 1in8b Recorder

公开仓库：[march-work/1in8b-recorder](https://github.com/march-work/1in8b-recorder)

一个用于 [1in8b.life](https://1in8b.life/) 的 Tampermonkey 记录器，以及一份公开的比利时人生数据样本。

> 本项目不是 1in8b.life 官方项目，与站点、Jin’s Earth 无隶属关系。游戏内容与数据的权利归原权利人所有。
>
> 安装方式见 [install/README.md](install/README.md)。

## 功能

- 记录每次抉择：题目、全部选项、最终选择
- 区分手动、自动、静默自动
- 记录重心、时间线、文本快照
- 每次游戏保存记录结构化状态照片
- 记录身份、MRZ、状态、钱、家人、工作教育、同秒出生、人生地图
- 国家统计和存活曲线按国家缓存
- 按人生查看：当前人生、所有人生、返回、筛选
- 删除单个人生、清空全部、已删除人生不会被补录复活
- 导出 JSON、JSONL、CSV

## 当前版本

**1.5.0**

- 取消文本快照单局 2 MB / 全部 50 MB 上限
- 取消单张 20,000 字符截断（年度/面板、出生证明、开局说明）
- 不再生成 `snapcap` 警告
- 更新时清除已有 `snapcap` 提示
- 其余记录、导出、删除、查看逻辑不变

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 在本仓库根目录启动本地安装服务：

   ```bash
   ./install/serve.sh
   ```

3. 在 Chrome 打开：

   ```text
   http://127.0.0.1:8787/1in8b-recorder.user.js
   ```

4. Tampermonkey 确认安装/更新
5. 打开或刷新 `https://1in8b.life/` 游戏页

详细步骤见 [install/README.md](install/README.md)。

## 使用

- 右下角 `1in8b 本局 N`：当前人生抉择数
- 点击打开当前人生
- 左上角 `← 所有人生`：返回所有人生列表
- 人生详情：`抉择 / 时间线 / 重心`
- 抉择可按 `全部 / 手动 / 自动 / 静默 / 历史` 筛选
- `导出 / 维护` 中提供 JSON、JSONL、CSV 导出
- 人生详情底部可删除此人生
- 所有人生页可清空全部

## 数据

公开数据样本：

- 人物：Daan Smit（生成角色）
- 出生国家：比利时 BEL
- 年龄范围：0–82 岁
- 状态照片：308 张
- 文本快照：172 张
- 抉择：63 条
- 重心：10 条
- 国家：1 份（BEL）
- 时间线：记录器现有 1 条
- 数据目录：[`data/belgium-daan-smit/`](data/belgium-daan-smit/)

数据说明：

- 只包含这一个人生
- 不包含其他人生
- 不包含 Chrome 配置、Cookie、Token、Local Storage
- `raw-indexeddb.json` 是完整原始导出
- `manifest.json` 和 `SHA256SUMS` 用于校验
- 详见 [docs/DATA_FORMAT.md](docs/DATA_FORMAT.md) 和 [docs/PRIVACY.md](docs/PRIVACY.md)

## 目录

```text
src/        Tampermonkey 用户脚本
install/    安装脚本与说明
docs/       设计、数据格式、隐私、测试
data/       比利时人生数据样本
```

## 限制

- 不是官方工具，不保证站点改版后仍可用
- 游戏内部完整状态在闭包中，记录器只能读取存档和页面
- 状态照片按保存/抉择节点记录，不是每一次内部 tick
- 本数据集的 timeline store 只有 1 条，属于记录器当时保存到该仓库的实际内容
- 所有数据只代表生成游戏内容，不是现实人物数据

## 测试

见 [docs/TESTING.md](docs/TESTING.md)。

## 许可证

- 代码：MIT，见 [LICENSE](LICENSE)
- 数据：见 [NOTICE.md](NOTICE.md)
