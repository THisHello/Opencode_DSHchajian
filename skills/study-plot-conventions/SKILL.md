---
name: study-plot-conventions
description: study 部分绘图约定：sideband 首图扣除信号区 data，全部信号区拟合谱不展示信号区 data，inclusive MC 使用含 cosTBTO 的 Stack_TopoAna 叠加图；变量以当前 study.md 为准，不写死。
---

# Study 绘图约定 Skill

适用于 `study.md` / 内部 note 中 sideband 与 inclusive MC 相关图。

> 注意：每个分析的变量、实验、channel 都可能不同，本 skill **不写死这些列表**。具体内容以当前 `study.md` / 分析配置为准。

> 当前分析现状（仅记录，不作为通用规则）：使用 Belle + Belle~II，包含两个 channel。

---

## 1. Sideband 第一次展示图

- 第一次展示某个**分析所用谱**的 sideband 区间时，**扣除该谱信号区内的 data 事例**。
- 只展示 sideband 区 data。
- 图例说明展示的是 sideband region 数据。

## 2. ΔE sideband 分布图

- 展示每个 sideband 区内的 ΔE 分布时，**可以包含全部 ΔE data**。
- 因为 sideband 是由其他变量定义的，ΔE 没有做信号窗切除。

## 3. 全部信号区拟合谱图

- 当全部选取信号区后展示所拟合谱时，**不展示信号区 data**。
- 与 sideband 首图规则一致。

## 4. Inclusive MC 分布展示

- study 中展示 inclusive MC 分布时，**使用各谱的叠加图 `*_incMC_stack_TopoAna.pdf/.png`**。
- 使用**含 cosTBTO 的版本**，不使用 `_noCosTBTO`。
- 当前分析参考目录（仅作为示例，不写死到通用规则）：

  ```text
  $HOME/Bmeson/run/belle2/plot/h1101/newIncMC/
  ```

- 不要只展示单一 MC 点图或单个成分。
- 使用的变量应与当前 `study.md` 保持一致。

## 5. 已确认约定

- [x] sideband 首图扣除信号区 data
- [x] 全部信号区拟合谱不展示信号区 data
- [x] inclusive MC 使用含 cosTBTO 的 `Stack_TopoAna` 叠加图
- [x] 变量、实验、channel 不写死，以当前 `study.md` / 分析为准
- [ ] 当前分析具体使用哪些变量/实验/channel（临时记录，不写入通用规则）
