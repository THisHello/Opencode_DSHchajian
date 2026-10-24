---
name: belle2-official-values
description: 查询 Belle II 官方 Performance Recommendations 中的 tracking、slow-pion、K_S0、PID、N_Y4S、f_+- 等官方值、系统误差和相关性建议。当用户需要“官方推荐值/官方页面/performance recommendation/系统误差官方表/100% correlation/官方 N_Y4S”时使用。
compatibility: opencode
metadata:
  whenToUse: 用户要求查看或核对 Belle II 官方性能推荐值、官方 correction tables、Run1/Run2 相关性、N_Y4S、f_+-、tracking/PID/Ks 系统误差时
---

# 查询 Belle II 官方 Performance Recommendations 值

## 用途

本 skill 记录如何用官方工具 `b2help-recommendation` 快速读取 Belle II 官方
Performance Recommendations 页面内容，包括：

- Mid-to-High Momentum Track Efficiency
- Slow Pion Efficiency Correction
- KShort (`K_S0`) Efficiency Correction
- PID Efficiency / Fake Rate Corrections
- Integrated Luminosity / N_Y4S
- Total Number of Produced B0/B+ Mesons、f_+-、f_00
- 官方对 Run1 / Run2 相关性的建议
- 各条目的 Status（READY / PRELIMINARY / DEPRECATED）

## 关键点

1. **网页版被 Anubis 挡住**：  
   `https://belle2.pages.desy.de/performance/recommendations/` 直接访问会要求 JS
   验证。**优先使用命令行工具**，内容来自同一个官方 payload。

2. **工具需要先加载 light 环境**，否则 `b2help-recommendation: command not found`。
   非交互 shell 也必须 source。

3. **`b2help-recommendation` 只针对 Belle II**。  
   它没有“Belle vs Belle II”的关联性建议；页面里的 `100% correlated` 全部是
   Belle II **Run1 vs Run2** 之间。

## 加载环境

```bash
source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion

# 确认可用
b2help-recommendation --help
```

工具路径（light-2601-hyperion，版本可能变化）：

```text
/cvmfs/belle.cern.ch/el9/releases/light-2601-hyperion/bin/Linux_x86_64/opt/b2help-recommendation
```

## 基本用法

```bash
# 查看可用 tags
b2help-recommendation -r 8 --summary --no-pager

# 查看特定 tag
b2help-recommendation -r 8 -t Tracking --no-pager
b2help-recommendation -r 8 -t EventProperties --no-pager
b2help-recommendation -r 8 -t K_S0 --no-pager
b2help-recommendation -r 8 -t PID --no-pager
b2help-recommendation -r 8 -t Systematics --no-pager

# 用 MC campaign 代替 release
b2help-recommendation -mc MC16 -t Tracking --no-pager

# 用更干净的 rst 输出
b2help-recommendation -r 8 -t Tracking -f rst --no-pager
```

常用组合 tag（tag 可组合，用空格分开，不要用长标题）：

```bash
# Mid-to-High Momentum Track Efficiency Systematics
b2help-recommendation -r 8 -t Tracking Systematics --no-pager

# Slow Pion Efficiency Correction
b2help-recommendation -r 8 -t Tracking pion Correction --no-pager

# KShort Efficiency Correction
b2help-recommendation -r 8 -t K_S0 Systematics Correction --no-pager

# PID Efficiency and Fake Rate Corrections
b2help-recommendation -r 8 -t PID Correction Systematics --no-pager

# Integrated Luminosity
b2help-recommendation -r 8 -t EventProperties Data Systematics --no-pager

# Total Number of Produced B0 and B+ Mesons
b2help-recommendation -r 8 -t EventProperties Data Systematics --no-pager

# Reconstruction Performance in Run1 vs Run2
b2help-recommendation -r 8 -t EventProperties Tracking Neutrals PID --no-pager
```

## 本分析常用官方值（已核对）

以下内容来自 `-r 8`（release-08 / MC16）的 CLI 输出，可直接引用。

### Tracking

```text
Mid-to-High Momentum Track Efficiency Systematics:
  systematic per track for Run1       - 0.375%
  systematic per track for Run2 (2024)- 0.375%
  0.375% = sum in quadrature of (0.317 ± 0.037 (stat) ± 0.197 (syst)) %
  Status: READY / PRELIMINARY

Slow Pion Efficiency Correction:
  binning:
    (1) 0.05 <= p < 0.12 GeV
    (2) 0.12 <= p < 0.16 GeV
    (3) 0.16 <= p < 0.20 GeV
  "You should assume 100% correlation for the systematic uncertainty
   between Run1 and Run2."
  Status: READY
```

当前分析已经下载的官方 slow-pion CSV：

```text
$HOME/Bmeson/run/Systematic/B2_tracking_2026/tables/slowpi_results_Run1.csv
$HOME/Bmeson/run/Systematic/B2_tracking_2026/tables/slowpi_results_Run2.csv
```

### K_S0 / KShort

```text
KShort Efficiency Correction:
  "assume 100% correlation for the systematic uncertainty (sys_corr,
   there is no sys_uncorr) between Run1 and Run2 (2024)"
  84 bins in (momentum, cosTheta, 2d-vertex distance) 3D space
  for Ks with 2d-vertex distance < 0.5 cm:
    use the two Ks daughter tracking corrections
    (p<0.2 GeV -> slow-pion; p>0.2 GeV -> mid-to-high momentum)
  Status: READY
```

注意：

- 官方页面文字写 `84 bins`，但当前 `correction-tables` 的 2D CSV
  `K_S0_calib_2D_Run1/2_ks_M.csv` 实际有 **66 个非空 bin**（3 p × 3 cosθ × 9 d，
  部分 bin 合并）。
- 官方 Ks 表基于 `M(pi+pi-) ∈ (0.480,0.516)` 和
  `significanceOfDistance(KS0) > 3`；如果分析选择不同，需要向 Ks conveners 确认。

### N_Y4S / 亮度

```text
Integrated Luminosity:
  Run1 4S       : 359.45 ± 1.67 /fb
  Run2 (2024) 4S: 132.90 ± 0.80 /fb

Total Number of Produced B0 and B+ Mesons:
  Run1 NY4S      : (380.9 ± 5.5) x 1e6
  Run2 NY4S      : (139.7 ± 2.1) x 1e6
  combined Run1+Run2 NY4S: (520.6 ± 7.6) x 1e6
  "assuming 100% correlation between Run1 and Run2 uncertainties"
  f00 = 0.4861 +0.0074 -0.0080
  f+- = 0.5113 +0.0073 -0.0108
  sym: f00 = 0.4861 ± 0.0080, f+- = 0.5113 ± 0.0108
```

### PID

```text
PID Efficiency and Fake Rate Corrections:
  "The corrections should be applied to the MC."
  "The correction tables and their uncertainties are computed via the
   Systematics Framework and they can be applied via the SysVar tool."
  Systematics Framework : https://syscorrfw.readthedocs.io/en/latest/
  SysVar                : software.belle2.org/.../OfflineReweighting.html
  Status: READY
```

注意：

- 官方页面**有** PID/SysVar 推荐方法。
- 在当前 MC16 分析中，官方 π/K/p correction CSV 可能尚未提供；
  因此本项目使用旧 `liyang_script` 表。需要随时用 `b2help-recommendation -r 8 -t PID` 复查。

## 官方相关性建议速查

| 对象 | 官方建议 |
|---|---|
| Slow pion | Run1/Run2 systematic 100% correlated |
| K_S0 sys_corr | Run1/Run2 100% correlated |
| N_Y4S | Run1+Run2 组合误差按 100% correlated |
| Belle vs Belle II | **官方页面未给出建议**；一般按 detector performance 独立处理 |
| PDG / f_+- | 外部输入，两个实验共用时按关联处理 |

## 结合本项目的使用流程

1. 查询官方值：

   ```bash
   source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion
   b2help-recommendation -r 8 -t Tracking --no-pager
   b2help-recommendation -r 8 -t EventProperties --no-pager
   ```

2. 若官方值变化：

   - tracking/Ks：更新 `B2_tracking_2026/tables/`、`B2_Ks_2026/tables/`；
   - N_Y4S：更新 `run/IOcheck/constants.py` 中 `N_YS4_Belle2`；
   - 然后重新生成 `C_values.txt`，重跑 IOcheck / fitmodel；
   - 最后更新 `memo/tex/` 中的 note 文本和 `Systematic_summary.md`。

3. 需要从 GitLab 下载官方向量表时，参考 `gitlab-desy-basf2` skill。

## 常见报错

```text
b2help-recommendation: command not found
```

- 没有 source light 环境：
  ```bash
  source /cvmfs/belle.cern.ch/tools/b2setup light-2601-hyperion
  ```

```text
root: command not found
```

- 同上；非交互后台脚本也要先 source，或用 `bash -c 'source ...; command'`。
