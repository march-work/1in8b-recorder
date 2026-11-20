# 数据格式

## 来源

数据来自 `https://1in8b.life` 页面中的 IndexedDB 数据库 `rec1in8b`。

导出的对象仓库：

| 仓库 | 内容 |
|---|---|
| `state` | 主状态，key 固定为 `main` |
| `states` | 结构化状态照片，每次保存/抉择节点 |
| `snapshots` | 文本快照 |
| `timelines` | 时间线，按 `lifeId` 存储 |
| `countries` | 国家统计/存活曲线缓存，按国家语言存储 |

本次导出只保留 `Daan Smit` / `BEL` / `lifeId = s1795160329798` 的人生。

## 文件

### `raw-indexeddb.json`

完整原始导出，包含上述五个仓库的原始对象。适合需要逐字段复核或重新处理的场景。

### `life.json`

```json
{
  "format": "1in8b-life",
  "schema": 1,
  "lifeId": "s1795160329798",
  "meta": {},
  "counts": {},
  "life": {}
}
```

`life` 包含抉择、重心、结果、快照计数、状态计数、基线等主状态字段。

### `states.jsonl`

一行一张状态照片。主要字段：

```json
{
  "schema": 1,
  "id": "st-...",
  "lifeId": "s1795160329798",
  "at": "ISO 时间",
  "saveAt": 1795160329798,
  "saveAtISO": "ISO 时间",
  "saveKey": "one8b.zh.save.v3",
  "reason": "save | decision-before | start",
  "phase": "before | after | null",
  "decisionRef": null,
  "hookRef": null,
  "age": 6,
  "year": "2006年",
  "identity": {},
  "stats": {},
  "money": {},
  "family": {},
  "educationWork": {},
  "focus": {},
  "comps": [],
  "currentYear": {},
  "countryRef": "BEL|zh",
  "country": {},
  "survival": {},
  "visible": {},
  "backend": {},
  "confidence": "high",
  "source": "save+page",
  "bytes": 12345
}
```

字段说明：

- `identity`：姓名、性别、出生、居住地、宗教、民族、学历、气质、MRZ
- `stats`：健康、幸福、知识、人际关系
- `money`：现金、房产、债务、收入、分位、净资产
- `family`：父母、伴侣、子女、祖父母、兄弟姐妹
- `educationWork`：教育、学校、工作、正式工作
- `focus`：当前重心和可见的全部重心
- `comps`：同秒出生的人
- `currentYear`：当前年度记录
- `countryRef`：国家资料引用
- `survival`：当前存活摘要
- `visible`：页面上可见的文字，包括 ID 卡、MRZ、状态、钱、家人、重心、页面文字
- `backend`：游戏后台完整当前状态；不包含历史 log/years、临时队列和历史 done
- `truncated`：1.5.0 起为 false

### `states.csv`

状态照片的表格版，便于 Excel/BI。复杂字段以 JSON 字符串放入 `familyJson`、`compsJson`。

### `decisions.csv`

每条抉择的每个选项一行，包含：

- 题目、问题、正文
- 选项
- 最终选择
- 手动/自动/静默/历史
- 前后状态照片 ID
- 结果、备注、决策耗时

### `focus.csv`

每条重心记录的每个选项一行。

### `timeline.csv`

时间线条目。当前数据集的 `timelines` 仓库只有 1 条，CSV 如实反映这一点。

### `snapshots.jsonl`

一行一张文本快照。类型包括：

- `birth`
- `year`
- `decision`
- `sheet`

### `countries.csv`

国家统计长表，每行一个指标。当前只有 `BEL|zh`。

### `manifest.json`

- 数据源、人生、国家、记录器版本
- 各仓库数量
- 状态照片原因分布
- 文本快照类型分布
- 文件字节数与 SHA-256
- 已知限制

### `SHA256SUMS`

上述文件的 SHA-256 校验和。

## 版本

- 状态照片 schema：1
- 记录器版本：1.5.0
- IndexedDB 版本：2
- 文本快照的 `truncated` 在 1.5.0 起为 false


## 导入与查看

- 记录器：`所有人生 → 导出 / 维护 → 导入 JSON`，选择 `raw-indexeddb.json`
- 导入为合并模式，不覆盖本地数据
- 静态查看：仓库根目录运行 `python3 -m http.server 8080`，打开 `/viewer/`
- 导入和查看都不会恢复游戏自己的 localStorage 存档
