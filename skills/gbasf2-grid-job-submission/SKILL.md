---
name: gbasf2-grid-job-submission
description: Belle II gbasf2 用户作业（Data/MC ntuple）的 grid 提交与故障处理：pilot、cputime/队列最低要求、可写 SE 与 banned_site、Waiting/Failed 诊断，以及硬性规则（Waiting 不处理、Failed 只 reschedule、新项目必须先经用户确认）。
compatibility: opencode
metadata:
  whenToUse: 需要用 gbasf2 提交 Data/MC 用户作业、作业长期 Waiting、出现 Failed/Killed、输出上传失败、需要 reschedule，或需要在用户明确确认后补交缺失输入时
---

# gbasf2 Grid 用户作业提交

适用于 `gbasf2 steering.py -i <collection>` 这类用户分析作业（Data/MC ntuple）。
不适用于 `b2dp-*` MCrd 生产链；后者见 `mcrd-grid-submission`。

核心原则：**先 pilot，再放量；Waiting 不处理；Failed 只 reschedule；不自行提交新项目；不要整批 kill 未失败作业。**

---

## 0. 硬性规则（必须遵守）

- **Waiting 作业不要处理**：不 kill、不 reschedule、不补交、不提交新项目。
- **Failed / Stalled / Killed 只用 `gb2_job_reschedule`**。
- **不得自行提交新项目**。
- **确需提交新项目时，必须先获得用户明确确认**；未确认前只能监控和 reschedule。
- 不要因为一部分作业失败就 kill 整个项目。

---

## 1. 环境与代理

```bash
source /cvmfs/belle.cern.ch/tools/b2setup <release>
source /cvmfs/belle.kek.jp/grid/gbasf2/pro/bashrc
```

先检查代理：

```bash
gb2_proxy_info
```

代理过期时续期（交互命令）：

```bash
gb2_proxy_init -g belle -v 24:00
```

注意：

- 每个新 shell 都要重新 source。
- 代理过期后 `gb2_job_status` 等客户端命令会失败，但已经在 grid 上运行的作业不受影响。
- 长时间提交用 `nohup` 后台跑，避免客户端被终端/超时中断。

---

## 2. 提交前检查清单

1. **release 与输入数据匹配**：用户作业的 release 应与输入 mdst 的生产 release 兼容。
2. **Global tag / DB snapshot**：
   - 生产数据通常绑定固定 DB snapshot（例如 `DB00001234`），不是当前中央 GT。
   - 当前中央 GT 可能已经重命名 trigger bit；不要用当前 GT 的名字推断生产 ntuple 的分支名。
   - 必须用 pilot 输出确认目标分支确实存在且非 NaN。
3. **项目名**：gbasf2 项目名最长 **32 字符**。
4. **输入**：collection 路径或 `--input_dslist` 文件；先用 `gb2_ds_list -s all` 确认文件可见。
5. **输出 SE**：gbasf2 **没有 failover SE**；输出 SE 不可写会直接让作业以 254 失败。
6. **磁盘/配额**：确认输出 dataset 路径和配额。

---

## 3. Pilot（强制）

不要直接提交全量。先取 1–2 个输入文件：

```bash
gb2_ds_list -s all "<input-path>/sub00/*" | head -2 > pilot_inputs.txt
```

提交 pilot：

```bash
gbasf2 steering.py \
  -p <pilot-project> \
  -s <release> \
  --input_dslist pilot_inputs.txt \
  -n 1 \
  --cputime 180 \
  --noscout --force
```

下载并检查输出：

```bash
gb2_job_status -p <pilot-project>
gb2_ds_get /belle/user/<grid-user>/<pilot-project> -o <local-dir> -f
```

必须检查：

- 作业是否 Done；
- 目标 trigger/变量分支是否 **非 NaN**；
- prescale 值是否符合预期；
- 关键选择后的计数是否合理；
- 输出文件是否成功上传（Done 且能在 dataset 中列出；只有 Done 不代表上传成功，见 5.1）。

只有 pilot 全部通过，才允许放量。

---

## 4. cputime 与队列最低要求

`--cputime` 单位是**分钟**；JDL 里显示的是**秒**。

常见下限（以实际诊断为准）：

| 站点 | 最低 cputime |
|---|---:|
| KEK | 10800 s = 180 min |
| Australia | 172800 s = 2880 min |

诊断 Waiting 作业：

```bash
gb2_diagnostic --waiting_job <jobid> --no_color
```

重点看：

```text
JDL cputime (3600) < minCPUTimeAllQueue(10800.0)
```

如果 cputime 低于队列下限，作业会**永久 Waiting**，不会被匹配。

关键结论：

- `gb2_job_reschedule` **不会修改 JDL**，所以不能修复 cputime 太低的问题。
- Waiting 作业**不处理**；不要自行补交新项目。若确实需要修正 JDL，先向用户说明并获得明确确认。

建议：pilot 通过后，正式提交的 `--cputime` 至少覆盖所有候选队列的最低值；不确定时用较高值（例如 180 min；需要 Australia 时用 2880 min）。

---

## 5. 站点与 SE

失败日志里常见：

```text
Destination SEs=<SE>
Skip unavailable <SE>: Permission denied (13: SE.isValid: Write access not currently permitted.)
Failed to upload output data file
No failover ses defined.
gbasf2: SE candidates exhausted.
```

这说明 basf2 本身可能已经成功，失败发生在最后上传阶段：物理结果是对的，只是输出写不出去。输出 SE 由作业实际运行的站点决定，`-d/--default_se` 已禁用，所以唯一可控手段是排除站点。

### 5.1 经验：一个不可写的 SE 会毁掉整批作业（2026-10-20 bucket49/50）

实际经过：

- `261020_Lumi_4S_exp42_2_bfzo` / `..._3_bfzo` 没有 ban UVic，作业被调度到 `DIRAC.UVic.ca` / `DIRAC.UVic-local.ca`，输出 SE 固定为 `UVic-TMP-SE`；
- 该 SE 对当前用户不可写，b49 有 910 个、b50 有 26 个作业在 basf2 **成功之后**报 `Permission denied (13: SE.isValid: Write access not currently permitted.)` → `No failover ses defined` → `Error: data upload` → `254`；
- 剩余 5128 + 4273 个作业被批量 kill 后重交，整批白跑一遍；
- 同样输入、同样 steering、同样 release，其他站点正常完成（b49 658 个、b50 264 个 Done）；
- 加 `--banned_site DIRAC.UVic.ca,DIRAC.UVic-local.ca` 重新提交（`bfz3`）后，同类上传失败为 0。

两个关键认知：

1. 这不是随机故障。同一个 SE、同一个权限错误，重试不会变好，只有换站点才会；
2. 错误发生在最后一步，物理结果是对的，很容易被误判成 steering/变量问题。

### 5.2 硬性做法

- pilot 中只要有作业出现 `Permission denied (13: SE.isValid...)` 或 `No failover ses defined`，**先 ban 掉该站点再放量**，不要“先全量交再补”；
- 放量命令显式写出 `--banned_site`，并把列表记录在提交日志里，不要依赖默认选择：

```bash
--banned_site SITE_A,SITE_B
```

- 提交后前 30 分钟重点看 Failed 是否集中在同一个 `Destination SEs`；同类失败集中出现时越早止损越好；
- 一个坏站点的影响与调度到该站点的比例成正比：pilot 只有 2 个作业时可能只暴露 1 个失败，不代表比例低；
- 不要 pin 死单个服务器；ban 掉坏站点后让 grid 自动调度其余站点；
- 如果只剩一个可用站点，确认该站点满足 cputime 下限，并且输入副本可读。

### 5.3 已知问题站点

| 站点 | 症状 | 处理 |
|---|---|---|
| `DIRAC.UVic.ca`、`DIRAC.UVic-local.ca` | `UVic-TMP-SE` 不可写，上传失败 254 | ban |

---

## 6. 正式提交

推荐把提交命令写进脚本，用 `nohup` 后台执行：

```bash
nohup bash submit.sh > submit.log 2>&1 &
```

脚本中：

```bash
gbasf2 steering.py \
  -p <project> \
  -s <release> \
  -i <collection> \
  --cputime 180 \
  --noscout --force \
  --banned_site SITE_A,SITE_B
```

注意：

- 成功 pilot 后才用 `--noscout`；否则保留 scout。
- `--force` 用于非交互提交。
- **不要**因为一部分作业失败就 kill 整个项目；先看 Done/Failed/Waiting 分布。
- 大项目提交后，等所有 job 注册完成再判断状态；`Received` 不计入 `gb2_job_status` 的 summary。

---

## 7. 监控与诊断

状态总览：

```bash
gb2_job_status -p <project>
```

Failed 详情：

```bash
gb2_job_status -p <project> --status Failed -l
```

单作业失败原因（不需要手动下载日志）：

```bash
gb2_diagnostic --failed_job <jobid> --no_color
```

Waiting 原因：

```bash
gb2_diagnostic --waiting_job <jobid> --no_color
```

Waiting 诊断会给出：

- JDL cputime；
- 输入 LFN 与副本 SE；
- 各候选站点是否 Active；
- 队列最低 cputime；
- 最近 pilot 数量。

---

## 8. 取缺失作业的输入 LFN

只有在用户明确确认要提交新项目时，才用 DIRAC API 收集对应输入 LFN：

```python
from BelleDIRAC.gbasf2.lib.job.information_collector import InformationCollector
from DIRAC.Interfaces.API.Dirac import Dirac

project = "<project>"
ic = InformationCollector()
d = Dirac()

jobs = ic.getAllJobsInProject(
    project, None, ["<grid-user>", "belle"], {"Status": ["Waiting"]}
)["Value"]

for j in jobs:
    jdl = d.getJobJDL(j)["Value"]
    print(j, jdl.get("InputData"), jdl.get("CPUTime"))
```

把 `Status` 改成 `Failed` 可获取失败作业输入。

---

## 9. reschedule 与补交的区别（补交必须先确认）

官方命令：

```bash
gb2_job_reschedule -p <project> --doAll
gb2_job_reschedule -j <jobid1>,<jobid2>
```

硬限制：

- 只处理 **Failed / Stalled / Killed**；
- **Waiting 作业不会被选中**；
- 复用**完全相同的 sandbox 和 JDL**；
- 不能修改 cputime、site list、输入文件。

本项目的硬性规则：**Waiting 不处理；Failed 只 reschedule；任何新项目必须先经用户确认。**

| 问题 | 能否用 reschedule 修 | 本项目允许的动作 |
|---|---|---|
| pilot/站点临时停摆 | 可以先试 | 直接 reschedule |
| 输出 SE 临时不可写 | 可以先试；若 JDL 仍含坏站点，可能再次失败 | 先 reschedule；反复失败则向用户说明，等待确认 |
| cputime 低于队列下限 | **不能** | Waiting 保持原样；不自行补交 |
| site list 需要 ban 站点 | **不能** | Waiting 保持原样；不自行补交 |
| Waiting 卡住 | **不能**，reschedule 不选中 Waiting | 保持 Waiting，不处理 |
| 输入文件/参数错误 | **不能** | 向用户说明，等待确认后再决定 |

gbasf2 自己的说明：

> Only jobs which have fatal status (Failed, Killed, Stalled) are affected.
> Exact same sandbox and parameters are reused. Thus you may need to submit a new project if there is an issue with the input parameters.

---

## 10. 缺失输入的处理流程

按本项目的硬性规则，**不要自动补交**。

1. **Waiting**：保持原样，不 kill、不 reschedule、不补交、不提交新项目。
2. **Failed / Stalled / Killed**：只执行 `gb2_job_reschedule`；不要因为失败就新开项目。
3. 如果 reschedule 后仍然反复失败，或确实需要修正 JDL / site list：
   - 先向用户说明原因、影响范围和拟提交的输入清单；
   - **只有得到用户明确确认后**，才允许提交新项目；
   - 新项目只能包含缺失输入，不得重跑已完成文件。
4. 统计口径（仅用于向用户说明，不自动执行）：

```text
missing = total_inputs - done
missing ≈ waiting + failed (+ stalled)
```

5. 用户确认后，才用第 8 节脚本收集对应输入 LFN，并提交最小子集项目。

---

## 11. 故障签名表

| 现象 | 可能原因 | 按本项目规则的处理 |
|---|---|---|
| `basf2helper.py Exited With Status 254` + `Error: data upload` | 输出上传失败 | 先 reschedule；反复失败则向用户说明，等待确认 |
| `Permission denied (13: SE.isValid...)` | SE 对当前用户不可写 | 先 reschedule；反复失败则向用户说明，等待确认 |
| `No failover ses defined` | 没有备用 SE | 先 reschedule；反复失败则向用户说明，等待确认 |
| `Job stalled: pilot not running` | 站点/pilot 基础设施 | 直接 reschedule；不要新开项目 |
| 长期 Waiting + `JDL cputime < minCPUTimeAllQueue` | cputime 太低 | 保持 Waiting；向用户说明，不自行补交 |
| 长期 Waiting + 站点 `not available` | 站点没有 pilot | 保持 Waiting；向用户说明，不自行补交 |
| `trigger name does not exist` / 分支全 NaN | GT/menu 与生产 snapshot 不一致 | 用生产 DB snapshot 重新 pilot，确认分支名 |
| `Project name is too long` | 项目名 > 32 字符 | 缩短项目名 |
| 作业停在 `Received` 很久 | 提交服务排队 | 等待；不要重复提交 |

---

## 12. 提交前快速 checklist

- [ ] 代理有效
- [ ] release 与输入数据匹配
- [ ] DB snapshot / GT 已确认
- [ ] pilot 1–2 文件通过，目标分支非 NaN
- [ ] 项目名 ≤ 32 字符
- [ ] `--cputime` ≥ 所有候选队列最低值
- [ ] 已知坏站点已加入 `--banned_site`
- [ ] 输出 SE 可写（pilot 已验证）
- [ ] 大项目用 `nohup` 后台提交
- [ ] 提交后先看 Done/Failed/Waiting，不急于 kill
- [ ] Waiting 未做任何处理
- [ ] Failed 只用 `gb2_job_reschedule`
- [ ] 新项目已获得用户明确确认（如适用）
- [ ] 失败优先 `gb2_diagnostic`；只用 reschedule；不自行补交
