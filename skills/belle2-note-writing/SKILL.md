---
name: belle2-note-writing
description: 内部 note 写作注意事项：不写具体拟合参数、大表大图用 resizebox、语言自然简洁。
---

# 内部 Note 写作注意

## 1. 定位

这是**内部 note**，不需要写成正式 paper，也不需要过多背景和解释。

## 2. 内容取舍

- 一般不给出具体拟合参数，例如：
  - 双高斯 `μ1/σ1/μ2/σ2/f`
  - 背景 `N_bkg`、`p0`
- 只写用了什么模型/方法：
  - 使用 double-Gaussian 信号模型；
  - 给出函数形式即可。
- 不写 broken-signal 等内部决策说明。
- 不堆砌不必要的表格。
- 不写「本分析不涉及 X，因此不考虑 X 的系统误差」这类多余段落。例如：
  - 反例：`\subsubsection{Photon reconstruction} The signal final states contain no photons, so photon-reconstruction systematics are not considered in this analysis.`
  - 不涉及的项直接省略，不必逐条声明「未考虑/不适用」；确有必要时在系统误差列表中一笔带过，不要单独开小节。

## 3. 公式精简

- 公式中重复出现的同类项要提取公因子，避免公式过长。
- 例如中间态分支比 `B(Ks→π+π−)`、`B(Λ→pπ−)` 只出现一次，放到括号外面。

## 4. 排版

- 大表格用：
  ```latex
  \resizebox{\textwidth}{!}{ ... }
  ```
- 大图用：
  ```latex
  \includegraphics[width=\textwidth]{...}
  ```
  或 `\resizebox{\textwidth}{!}{\includegraphics{...}}`
- 子图宽度按**每行数量**确定，不要写死固定值：
  - 一行 4 张时可用 `0.24\textwidth`（留少量间距）；
  - 一行 `n` 张时约为 `1/n` 减去列间距，按实际调整；
  - 每行超过 4 张时要重新计算，不能直接套 `0.24`。
- 图和表不要超出版心。

## 5. 语言

- 自然、简洁，避免生硬解释。
- 不使用 i.e.、e.g. 这类缩写，直接写清楚意思。
- 内部 note 不必过度正式。

## 6. 快速检查

- [ ] 有没有不必要的具体拟合参数？
- [ ] 有没有生硬内部解释？
- [ ] 有没有「不涉及 X 所以不考虑」的多余段落？
- [ ] 公式是否提取了公因子？
- [ ] 大表/大图是否 resize？
