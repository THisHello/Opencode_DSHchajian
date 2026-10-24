---
name: belle2-light-setup
description: 如何 source Belle II 软件环境（basf2 / light 发行版），以及本 B 衰变分析使用的 light-2601-hyperion 环境配置。
---

# Belle II / basf2 / light 环境配置 Skill

本文档记录如何在本机加载 Belle II 软件环境，以及本 B 衰变分析使用的软件版本。

---

## 1. 本分析使用的版本

当前 B 衰变分析使用：

```text
light-2601-hyperion
```

- 软件类型：Belle II **light 发行版**
- 分析框架：`basf2`
- ROOT：随 light 环境提供

---

## 2. 加载环境

在登录一个全新的 shell 后，需要先 source：

```bash
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion
```

也可以写成：

```bash
b2setup light-2601-hyperion
```

如果当前 shell 没有 source，`basf2`、`root` 等命令通常不可用。

查看已安装/可用的 release：

```bash
source /cvmfs/belle.cern.ch/tools/b2setup
b2setup --help
```

---

## 3. 验证环境

加载后检查：

```bash
which basf2
basf2 --version
which root
root --version
```

如果 `basf2` 可用，说明 light 环境已加载成功。

---

## 4. 运行 basf2 分析脚本

```bash
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion

cd /path/to/analysis
basf2 your_script.py
```

如果需要指定多个输入文件或参数：

```bash
basf2 your_script.py input1.root input2.root
```

---

## 5. 运行 ROOT 脚本

```bash
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion

cd /path/to/analysis
root -l -b -q 'your_macro.C("arg1")'
```

在自动化 / 非交互 shell（脚本、agent、批处理）中，`source` 可能**静默失败**（命令可正常返回，但 `root` 不在 `PATH` 上，甚至连续重试多次也不恢复）。此时用 wrapper 脚本更稳：

```bash
cd /path/to/analysis
$HOME/Bmeson/Note/skills/run_root.sh -l -q -b your_macro.C
```

wrapper 内容：在同一个 shell 里 `source` b2setup，确认 `root` 可用后再 `exec root "$@"`；失败时把原因写到 stderr。也可以临时自建：

```bash
cat > /tmp/run_root.sh <<'EOF'
#!/bin/bash
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion >/tmp/b2setup.log 2>&1
command -v root >/dev/null || { echo "b2setup failed" >&2; exit 1; }
exec root "$@"
EOF
```

如果 `root` 命令找不到，通常是环境未 source 或 cvmfs 未挂载。先执行：

```bash
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion
```

再检查：

```bash
which root
```

---

## 6. basf2 脚本中的 global tag

分析脚本中通常需要指定与 light 版本对应的 global tag：

```python
import basf2 as b2

b2.conditions.prepend_globaltag("analysis_tools_light-2601-hyperion")
```

注意：global tag 名称必须与使用的 light 发行版一致，否则可能出现条件数据不匹配。

---

## 7. 常见问题

### 7.1 `b2setup: command not found`
- 确认 cvmfs 已挂载：
  ```bash
  ls /cvmfs/belle.cern.ch
  ```
- 如果 cvmfs 未挂载，先挂载 cvmfs，或联系管理员。

### 7.2 `basf2: command not found`
- 确认已经执行：
  ```bash
  source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion
  ```
- 每个新 shell 都需要重新 source。

### 7.3 `root: command not found`
- 同上，先确认 `b2setup` 是否成功；
- 若 light 环境已 source 但仍找不到，可以尝试使用 b2setup 提供的 ROOT 路径，或直接使用完整路径：
  ```bash
  /cvmfs/belle.cern.ch/el9/externals/<version>/Linux_x86_64/common/root/bin/root
  ```
- 若在非交互 shell 中 `source` 本身静默失败（连续重试也不恢复），不要在失败的命令后继续拼接 `root`，改用 §5 的 wrapper 方式（`source` + `exec root` 在同一 shell 内完成）。注意 `source ... | tail` 之类的管道会把 `source` 放进子 shell，环境不会保留；`source ... >log 2>&1 && root ...` 也只在同一 shell 内才有效。

### 7.4 版本不一致
- 不要混用 `light-2505-deimos` 与 `light-2601-hyperion`；
- 运行脚本前先确认当前 source 的是哪个版本：
  ```bash
  basf2 --version
  ```

---

## 8. 快速参考

```bash
# 加载本分析环境
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion

# 运行 ROOT 绘图宏
root -l -b -q 'draw_fit_br_grid.C("ch1",0)'

# 运行 basf2 分析脚本
basf2 user_ana.py

# 检查当前环境
basf2 --version
which root
```
