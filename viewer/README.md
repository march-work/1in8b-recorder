# 静态数据查看器

无需安装 Tampermonkey，直接查看仓库里的比利时数据。

## 使用

在仓库根目录启动静态服务：

```bash
python3 -m http.server 8080
```

打开：

```text
http://127.0.0.1:8080/viewer/
```

## 数据

查看器读取：

```text
data/belgium-daan-smit/raw-indexeddb.json
```

展示：

- 人生
- 抉择
- 时间线
- 重心
- 状态照片
- 文本快照
- 国家资料

## 说明

- 只读，不会修改数据
- 不需要安装脚本
- 不包含其他人生
- 数据量较大，首次打开需要几秒加载
