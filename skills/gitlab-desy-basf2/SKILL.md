---
name: gitlab-desy-basf2
description: 访问 DESY GitLab 上的 Belle II 私有仓库 basf2(gitlab.desy.de/belle2/software/basf2):读取分支提交历史、单个提交、diff、文件内容、分支/标签列表等。当用户要求查看 basf2 提交记录、变更、文件、核对 release 分支内容,或涉及该仓库 GitLab API 时使用。
compatibility: opencode
metadata:
  whenToUse: 用户要求访问 gitlab.desy.de/belle2/software/basf2 的内容(提交历史/diff/文件/分支),或给出与该仓库相关的 GitLab API 请求时
---

# DESY GitLab: Belle II basf2 私有仓库访问

## 认证凭据(私有仓库,必须带 token)

- token 优先从环境变量 `GITLAB_DESY_TOKEN` 读取;未设置时从 `<token-file>` 读取(该文件权限应为 600,仅本人可读);若两者都没有则报错,不要硬编码 token。
- 请求头:`PRIVATE-TOKEN: <token>`(`Authorization: Bearer <token>` 也行)。
- 安全:token 是敏感凭据,不要外泄;若泄露立即到 `https://gitlab.desy.de/-/user_settings/access_tokens` 撤销。
- 坑:不带 token 请求会返回 HTTP 200 的 GitLab Sign in 页面,**不要误判为仓库公开**。

## 环境注意

- Linux 上 `curl` / python `urllib` 均可直连;优先用 curl 或 python 标准库,不需要额外依赖。
- 分页/循环用脚本:`cat > /tmp/gitlab.py <<'EOF' ... EOF` 再 `python3 /tmp/gitlab.py`,避免超长单行命令。

## API 基础

- Base:`https://gitlab.desy.de/api/v4/projects/belle2%2Fsoftware%2Fbasf2`
  (项目路径必须 URL 编码:`belle2/software/basf2` → `belle2%2Fsoftware%2Fbasf2`)
- 查询参数里的分支名也要编码:`release/08-02` → `ref_name=release%2F08-02`;python 用 `urllib.parse.urlencode` 统一编码。

| 用途 | 路径 |
|---|---|
| 提交列表 | `/repository/commits?ref_name=<branch>&per_page=100&page=N`(支持 `since`/`until`/`author`/`search`;`ref_name` 也接受 tag) |
| 单个提交 | `/repository/commits/<sha>` |
| 提交 diff | `/repository/commits/<sha>/diff` |
| 分支列表 | `/repository/branches?search=release%2F08` |
| 标签列表 | `/repository/tags` |
| ref 比较 | `/repository/compare?from=<ref>&to=<ref>` |
| 目录树 | `/repository/tree?ref=<ref>&path=<dir>`(可选 `recursive=true`) |
| 文件原始内容 | `/repository/files/<urlencoded_path>/raw?ref=<ref>` |
| 文件历史 | `/repository/files/<path>/commits?ref_name=<ref>` |

## 最小可用模板

```bash
# curl 版(最快)
curl -s -H "PRIVATE-TOKEN: $GITLAB_DESY_TOKEN" \
  "https://gitlab.desy.de/api/v4/projects/belle2%2Fsoftware%2Fbasf2/repository/commits?ref_name=release%2F08-02&per_page=10"
```

### 常用 Python 封装

```python
import os, json, urllib.request, urllib.parse

BASE = "https://gitlab.desy.de/api/v4/projects/belle2%2Fsoftware%2Fbasf2"

def _read_token():
    t = os.environ.get("GITLAB_DESY_TOKEN")
    if t:
        return t
    p = os.path.expanduser("<token-file>")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return f.read().strip()
    raise RuntimeError("GITLAB_DESY_TOKEN is not set")

TOKEN = _read_token()

def api(path, params=None):
    params = params or {}
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"PRIVATE-TOKEN": TOKEN})
    with urllib.request.urlopen(req) as r:
        return json.load(r)
```

## 常用示例

### 列出 release 分支

```python
for b in api("/repository/branches", {"search": "release/08"}):
    print(b["name"])
```

### 查看某分支最近提交

```python
for c in api("/repository/commits", {"ref_name": "release/08-02", "per_page": 10}):
    print(c["id"], c["created_at"], c["title"])
```

### 查看某个提交的 diff

```python
diff = api(f"/repository/commits/{sha}/diff")
for d in diff:
    print("---", d["new_path"], d.get("old_path"))
    print(d.get("diff", "")[:2000])
```

### 读取某个文件原始内容

```python
path = urllib.parse.quote("path/to/file.py", safe="")
raw = api(f"/repository/files/{path}/raw", {"ref": "release/08-02"})
print(raw)
```

注意:文件原始终端返回文本;如果文件是二进制,应另存为文件或用 base64 接口。

## 注意事项

- 所有私有仓库请求必须带 `PRIVATE-TOKEN`。
- 分支名、文件路径都要 URL 编码。
- 返回结果大时用 `per_page` 分页,不要一次拉全部。
- 不要将 token 写入日志、输出文件或提交到 git。
- 只读访问;不通过此 skill 做修改、合并、MR 操作。
