---
name: mcrd-grid-submission
description: Belle II MC run-dependent (MCrd) signal MC 网格生产提交流程通用注意事项：prepare/count/test/register/upload/approve/DSS/profile，不绑定具体任务号。
---

# MCrd 网格提交通用 Skill

本文档是 Belle II **MC run-dependent (MCrd) signal MC** 的通用网格提交流程与注意事项。适用对象是 `mcrd_processing` 目录下的 `b2dp-*` 工具链，以及后续 DSS 注册。

**不要**把本文档绑定到某个具体 GitLab issue 或具体 EventType；使用时用占位符替换。

---

## 1. 整体流程

```text
b2dp-prepare-MCrd         生成 campaign 目录、grid json、steering、dec/sandbox
b2dp-count-generated-events
                          统计预计事件数/亮度
本地 test_steering        验证 steering 能跑通
b2dp-grid-register        注册 ProdID
b2dp-grid-uploadFile      上传 steering
b2dp-grid-approve         approve 生产
b2dp-register-dss-signal  注册 DSS / Collection
gb2_prod_status / gb2_prod_summary
                          查看进度
```

---

## 2. 环境准备

- 生成配置：`basf2` 环境
- Grid 注册/上传/approve/DSS：`gbasf2` 环境
- 需要设置：
  ```bash
  export GB2_SETUP_SCRIPT=/cvmfs/belle.kek.jp/grid/gbasf2/pro/tools/setup.sh
  export RUCIO_ACCOUNT='<yourgriduser>'
  ```
- 每个新 shell 都要重新 source 相应环境。

---

## 3. 生成生产配置

### 3.1 基础命令

```bash
./b2dp-prepare-MCrd \
  -c_d <dataset_config>.yaml \
  -c_g <signal_config>.yaml \
  [--minLumi 10000] \
  [-resub _v2]
```

- `-c_d`：dataset 配置，例如 run1-only 用 `config_dataset_proc16.yaml`，run1+run2 用 `config_dataset_proc16_prompt.yaml`。
- `-c_g`：signal/generic 配置。
- `--minLumi`：跳过亮度低于阈值的短 run，单位 nb。
- `-resub _v2`：为 `ProductionName` 加后缀，用于同一 EventType 的第二次及以后生产。

### 3.2 目录名

生成的目录名是：

```text
<campaign>_<gitlab>
```

例如 `<campaign>` 来自 signal config 的 `campaign`，`<gitlab>` 来自 `gitlab` 字段。

- 如果目录已存在，默认会 abort。
- `--force` 会删除旧目录并重建，**不是追加**。
- 需要保留旧文件时，应使用新的 `gitlab` 目录，或先备份旧目录。

### 3.3 `-resub` 的实际效果

- `-resub` 只改变 JSON 里的 `ProductionName`，例如：
  ```json
  "ProductionName": "..._v2"
  ```
- **不会**改变 steering/json 的文件名。
- 所以文件名不带 `_v2` 是正常的，关键看 JSON 里的 `ProductionName`。

### 3.4 只做 run1 / run2

- run1-only：`-c_d config_dataset_proc16.yaml`，signal config 用 run1 版本。
- run2-only：`-c_d config_dataset_prompt.yaml`。
- run1+run2：`-c_d config_dataset_proc16_prompt.yaml`。
- 注意 run1 和 run2 的 release 不同，`b2dp-prepare-MCrd` 会根据 exp 自动选择。

---

## 4. 生成后检查

### 4.1 目录结构

```bash
ls <campaign_dir>
```

应包含：

```text
<dataset_config>.yaml
<signal_config>.yaml
exp*/                # 每个实验/能量点一个目录
logging.log
```

如果没有某个 exp 目录，通常是配置里没有对应能量点或 dataset 配置缺失。

### 4.2 计数

```bash
./b2dp-count-generated-events --dir <campaign_dir>
```

统计每个 EventType 的事件数、亮度、run 数。

### 4.3 本地测试 steering

```bash
cd <campaign_dir>/<exp_dir>
../../test_steering.sh <exp> <run>
# 或 release6
../../test_steering_rel6.sh <exp> <run> <release>
```

检查输出：

```bash
head -n 20 *.out
```

也可以：

```bash
../../check_steering.sh
```

---

## 5. Grid 注册/上传/approve

### 5.1 注册

```bash
./b2dp-grid-register \
  --dir <campaign_dir> \
  -sconfig <signal_config>.yaml
```

- `-sconfig` 必须是 **campaign 目录内**的 signal config 文件名，不是外层路径。
- 脚本会遍历 signal config 中的 EventType，对每个 exp 目录里的 `grid_*.json` 执行 `gb2_prod_register`。
- 结果写入 `<campaign_dir>/register.log`，得到 ProdID。

### 5.2 上传

```bash
./b2dp-grid-uploadFile --dir <campaign_dir>
```

- 读取 `register.log`，对 OK 的 ProdID 执行 `gb2_prod_uploadFile -p <prodID>`。
- 结果写入 `upload.log`。

### 5.3 approve

```bash
./b2dp-grid-approve --dir <campaign_dir>
```

- 读取 `upload.log`，检查状态是否为 `ToApprove`，然后 `gb2_prod_approve -p <prodID>`。
- 结果写入 `approve.log`。

### 5.4 只处理 run1 或 run2

`b2dp-grid-register` 支持：

```bash
--exp run1   # 只处理 exp <= 26
--exp run2   # 只处理 exp >= 30
```

默认是 run1+run2。

---

## 6. DSS 注册

### 6.1 前提

- 所有相关 ProdID 的 Status 都必须为 `Done`。
- 如果还有 `Running`，DSS 脚本会拒绝注册并提示：
  ```text
  Not all prodID are done for EventType ..., please check the status!
  ```

### 6.2 命令

```bash
./b2dp-register-dss-signal \
  -b <BGx1> \
  -c <campaign> \
  -r <prod_start> <prod_end>
```

- `-c` 必须和生产的 `Campaign` 一致，否则范围查询不到。
- `-r` 接受两个数字：起始和结束 ProdID。
- ProdID 范围从 `register.log` / `approve.log` 获取。

### 6.3 输出解读

- 开头的 `df.head()` 只是整份 status 的前 5 行预览，不是过滤后的结果。
- 如果 `Registered events: []` 且 `NOT registered events: []`，说明：
  - `-c` campaign 不对，或
  - ProdID 范围不在该 campaign 下。
- 如果某个 EventType 未注册，是因为还有 ProdID 未 `Done`。

### 6.4 v2 / 重复生产注意

- 同一 EventType 可以有多个 production，只要 `ProductionName` 不同。
- 第二次及以后生产使用 `_v2`、`_v3` 后缀。
- **不要删除旧的 DSS / Collection**，除非申请人明确要求。
- 新的 Collection 名要不同，例如：
  ```text
  <campaign>_Signal_<EventType>_v2
  ```
- 也可以把 v1+v2 放进一个新 collection，但名字仍要与旧 collection 不同。

### 6.5 使用修复后的 DSS 脚本

- 如果 `b2dp-register-dss-signal` 出现 stdout 解析错误，确认使用的是修复后的版本（采用 JSON 输出），而不是旧的 csv 解析版本。

---

## 7. 查看进度

```bash
gb2_prod_status -p `seq <start> <end>`
gb2_prod_status -c <campaign> -g signal -s all
gb2_prod_summary -p `seq <start> <end>` --type
```

---

## 8. 常见参数与注意事项

### 8.1 `special_request`

| 配置 | 行为 |
|---|---|
| 不设置 | 使用 `b2dp_generators.py` 生成标准 generator |
| `'generator'` | 使用 `b2dp_generators_special.py` 生成特殊 generator，仍用默认 steering 模板 |
| `'template'` | 不自动生成 generator，把 `GENERATORTOBEREPLACED` 置为 `dummy`，使用 `-tmplt_str` 指定的自定义模板 |

- `dummy` 只是占位值，若模板里没有 `GENERATORTOBEREPLACED`，不会出现在最终 steering 中。
- 使用特殊 generator 时，需要把新 EventType 分支加到 `b2dp_generators_special.py`。

### 8.2 `NewDecfile_format`

- `NewDecfile_format: dec` 表示使用本地 `<EventType>.dec`。
- 脚本会：
  - 检查当前目录是否存在该 dec 文件；
  - 复制到每个 exp 子目录；
  - 加入 grid `InputSandboxFile`。
- steering 中应引用 `./<EventType>.dec`，不要用 `b2.find_file('decfiles/dec/...')`。

### 8.3 PHOKHARA / ISR

- 使用 `ge.add_phokhara_evtgen_combination` 时，如果信号是 ISR 过程，必须保留：
  ```python
  isr_events=True
  ```
- 通常还需要：
  ```python
  min_inv_mass_vpho=minMass
  max_inv_mass_vpho=10
  ```
- 若申请人要求，还需在 `PhokharaInput` 里加：
  ```python
  m.param('MinInvMassHadronsGamma', 8**2)
  ```

### 8.4 能量点

- `BeamEnergy_NumEvents` 可以按能量点分别写：
  ```yaml
  BeamEnergy_NumEvents:
    4S: <N>
    4S_offres: <N>
    5S_scan: <N>
  ```
- 也可以写总事件数并指定能量点：
  ```yaml
  BeamEnergy_NumEvents:
    Inclusive: <N>
  Inclusive_BeamEnergy: ['4S', '4S_offres', '5S_scan']
  ```
  `Inclusive` 表示所有指定能量点**合计** N 个事件，按亮度比例分配。
- 如果要求“每个能量点各 N”，必须分开写。

### 8.5 dec 文件头

- 文件名和文件内 `# EventType:` 必须一致，避免后续混淆。
- 包含 charge conjugate 时，dec 文件里应有两个分支。

---

## 9. 快速检查清单

- [ ] 当前目录是 `mcrd_processing`？
- [ ] `-c_d` 是否对应 run1/run2 范围？
- [ ] `-c_g` 的 `campaign` / `gitlab` 是否符合预期目录名？
- [ ] 信号配置里的 `special_request` 是否正确？
- [ ] `b2dp_generators_special.py` 中是否有对应 EventType 分支？
- [ ] 本地 `.dec` 文件是否存在、文件名是否正确？
- [ ] `isr_events=True` 是否保留？
- [ ] 能量点是否按申请人要求设置？
- [ ] 生成目录中是否包含所有 exp 目录？
- [ ] JSON 中 `ProductionName` 是否带 `_v2`（如需重提交）？
- [ ] `register.log` / `upload.log` / `approve.log` 状态是否 OK？
- [ ] DSS 注册前所有 ProdID 是否 `Done`？
- [ ] `-c` 是否与生产 Campaign 一致？
- [ ] 是否保留了旧 v1 collection / DSS？
