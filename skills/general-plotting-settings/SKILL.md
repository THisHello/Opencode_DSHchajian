---
name: general-plotting-settings
description: 通用绘图设置与文档排版注意项（ROOT/RooFit 背景线、多子图比例与边距、pull 分布、legend/注释、希腊字母、字号；LaTeX 大图/大表 resizebox）
---

# 通用绘图设置 Skill

本文档是绘图时通用的注意事项和解决方案，适用于 ROOT/RooFit、matplotlib 以及 LaTeX 文稿中的图/表排版。不要把它限定为某个具体分析。

---

## 1. 图片比例与画布尺寸

- 画图前先明确目标比例，例如 `3:2`、`16:9`、`4:3`。
- 在 ROOT 中，`TCanvas(name, title, w, h)` 保存出的 PNG 尺寸通常**不等于** `w × h`，会扣除窗口边框（常见为宽少 4 px、高少 28 px）。
- 若需要精确输出，可以先测试：
  ```bash
  file test.png
  ```
  再根据偏差补偿画布尺寸。例如希望输出 `1800 × 1200`（3:2）时：

  ```cpp
  TCanvas* c = new TCanvas("c", "title", 1804, 1228);
  ```

- 多子图网格：
  ```cpp
  c->Divide(3, 2);
  ```
  若每个子图也要特定纵横比，需要自行调整画布宽高或使用多 pad 布局。

---

## 2. RooFit 联合/组合拟合中画背景线

### 问题
在 `RooSimultaneous` 联合拟合结果上画背景（bkg）分量时，常见两种错误：

1. 单独构造 background-only 模型：
   - 背景默认按 data 总数归一化，可能在某些区域高于 Total Fit。
2. 再给单独 bkg-only 模型加 `RelativeExpected`：
   - 背景可能被压到接近 0。

### 通用正确做法
直接从**完整的拟合模型**中选择背景分量，而不是另造一个背景-only 模型：

```cpp
// 联合模型
simModel.plotOn(frame,
                ProjWData(cat, data),
                Components(RooArgSet(*bkg1, *bkg2)),
                LineColor(kRed), LineStyle(kDashed), LineWidth(3),
                Name("Bkg"));
```

如果是非联合的简单模型：

```cpp
model.plotOn(frame,
             Components(*bkg),
             LineColor(kRed), LineStyle(kDashed), LineWidth(3),
             Name("Bkg"));
```

这样背景与 Total Fit 使用同一套归一化，背景线不会高于总拟合线（因为信号 PDF 非负）。

### 判据
数值检查：

```cpp
max(bkgCurve - totalCurve) == 0
```

若 `> 0`，说明背景归一化错误。

---

## 3. 多数据集/多实验分开展示

联合拟合可以只做一次，但展示时可以按数据集分开画：

- 每个数据集保留自己的 data、模型分量、背景分量；
- 物理参数仍由联合 fit 给出，例如共享的总信号产额；
- 画图时只画各自的数据和模型分量。

示例：

```cpp
// dataset A
dsA->plotOn(frame, ...);
modelA->plotOn(frame, ..., Name("Total"));
modelA->plotOn(frame, Components(*bkgA), ..., Name("Bkg"));

// dataset B
dsB->plotOn(frame, ...);
modelB->plotOn(frame, ..., Name("Total"));
modelB->plotOn(frame, Components(*bkgB), ..., Name("Bkg"));
```

输出文件命名建议带上数据集名，例如：

```text
result_datasetA.pdf/.png
result_datasetB.pdf/.png
```

---

## 4. Y 轴范围与 legend 留白

通用做法：

1. 找数据最高 bin；
2. 找总拟合曲线最高点；
3. 找背景/其他曲线最高点；
4. 取三者最大值，再放大一个系数。

```cpp
double ymax = data_max;
if (totalCurve) ymax = TMath::Max(ymax, totalCurve->GetMaximum());
if (bkgCurve)   ymax = TMath::Max(ymax, bkgCurve->GetMaximum());

frame->SetMinimum(0);
frame->SetMaximum(1.6 * ymax);
```

- 经验系数：`1.5–1.6`，具体取决于 legend 大小和数据波动。
- 如果图中有误差棒，应使用 `max(bin content + bin error)`。

Legend 推荐设置：

```cpp
TLegend* leg = new TLegend(0.62, 0.70, 0.86, 0.87);
leg->SetBorderSize(0);   // 不要 legend 边框
leg->SetLineColor(0);
leg->SetFillColor(0);
leg->SetTextFont(62);
leg->SetTextSize(0.042);
leg->Draw();
```

也可以全局设置：

```cpp
gStyle->SetLegendBorderSize(0);
```

要点：
- **legend 不要加边框**：`SetBorderSize(0)`；
- 不要贴近图框边缘；
- 大小要能容纳所有条目；
- 与数据曲线保持一定间距。

---

## 5. 坐标轴标题与刻度统一设置

ROOT 全局设置示例：

```cpp
gStyle->SetLabelFont(42, "xyz");
gStyle->SetLabelSize(0.05, "xyz");
gStyle->SetLabelOffset(0.01, "xyz");
gStyle->SetTitleFont(42, "xyz");
gStyle->SetTitleSize(0.08, "xyz");
gStyle->SetTitleOffset(0.9, "xyz");
gStyle->SetNdivisions(505, "xyz");
```

常用建议：
- TitleSize：`0.08`
- LabelSize：`0.05–0.055`
- Font：`42`（ROOT 标准字体）
- Title 和 Label 都 `CenterTitle()`

### 5.1 轴标题被裁剪 / 与刻度数字重叠

**X 轴标题被底部裁剪**：TitleSize 0.08 + LabelSize 0.05 时，`SetBottomMargin(0.20)`（标题更大时继续增加）。

**Y 轴标题压到刻度数字**：不要依赖 ROOT 默认左边距（0.10）；显式设置左边距并把 Y 轴 title offset 调大：

```cpp
c->SetLeftMargin(0.17);
frame->GetYaxis()->SetTitleOffset(1.3);   // TitleSize>=0.06 时建议 >=1.2
```

- 刻度位数多（如 `80000`）时需要更大间隙；
- `c->SetTopMargin(2)` 是无效写法（边距应在 0–1），应写 `0.05–0.08`；
- 可直接沿用 `liy/Style`（L/B=0.2、TitleSize 0.07、LabelSize 0.06），或对齐 IO 拟合图 `run/IOcheck/draw_fit_br_grid.C`（TitleSize 0.08、LabelSize 0.055、L 0.17/B 0.24、R 0.05）。

**分格画布（`TCanvas::Divide`）**：每个子 pad 各自按 gStyle 边距绘图、字号相对 pad 高度，小 pad 用 `BottomMargin=0.17` 时 X 标题距 pad 底仅 ~25 px，容易被 pad 边界或相邻 pad 遮住。多 panel 网格建议 `SetPadBottomMargin(0.24)` + `SetTitleOffset(0.9)`（见 `draw_fit_br_grid.C`，改后 ~74 px）；自检：PNG 四边无暗像素、各 panel 的 X 标题字形高度一致。

**自检**：用 pdf 文本包围盒检查标题与刻度是否重叠：

```bash
pdftotext -bbox fig.pdf - | python3 -c '
import sys,re
ws=[(float(a),float(b),float(c),float(d),e) for a,b,c,d,e in re.findall(
    r"<word xMin=\"([\d.]+)\" yMin=\"([\d.]+)\" xMax=\"([\d.]+)\" yMax=\"([\d.]+)\">([^<]*)</word>",
    sys.stdin.read())]
rot=lambda w:(w[3]-w[1])>1.2*(w[2]-w[0])
yt=[w for w in ws if w[4] in ("Events","MeV") and rot(w)]
tx2=max(w[2] for w in yt)
labs=[w for w in ws if re.match(r"^[-\d.,]+$",w[4]) and not rot(w) and w[0]>=tx2]
print("Y gap =", min(w[0] for w in labs)-tx2, "pt  (>0 即不重叠)")
'
```

如果使用 matplotlib：

```python
plt.rcParams.update({
    "font.size": 14,
    "axes.labelsize": 18,
    "xtick.labelsize": 14,
    "ytick.labelsize": 14,
    "legend.fontsize": 12,
})
```

### 5.2 Y 轴数值很大时改按 ×10³ 显示

**问题：** 刻度为 5 位数（如 `30000`）时标签很宽，即使增大左边距和 `TitleOffset`，Y 标题仍可能被画布左边缘裁掉（PNG 左边缘有暗像素），而且标题离刻度数字偏远。用户要求“重画坐标轴、Ytitle 标注 ×10³、减小刻度数字”。

**修复：** 隐藏原生标签，用 `TGaxis` 在同一位置叠加“数值 ÷10³”的轴，标题里注明 `×10³`：

```cpp
#include "TGaxis.h"
...
frame->GetYaxis()->SetTitle("Events (#times10^{3}) / 5 MeV");  // ×10³ 紧随 "Events"，括号括起、内部不留空格
frame->GetYaxis()->SetTitleOffset(0.8);                       // 标签变短后可减小
frame->GetYaxis()->SetLabelSize(0);                           // 隐藏原生标签
...
frame->Draw();
TGaxis* yax = new TGaxis(frame->GetXaxis()->GetXmin(), 0,
                         frame->GetXaxis()->GetXmin(), frame->GetMaximum(),
                         0, frame->GetMaximum() * 1e-3, 505, "");  // 区间同 frame、Ndivisions 同 505
yax->SetLabelFont(42);
yax->SetLabelSize(0.055);
yax->SetLabelOffset(0.005);
yax->SetTickSize(0);      // 刻度线由 frame 提供
yax->Draw();
```

- 叠加轴必须在 `frame->Draw()` 之后 `Draw()`；上下限都要 ÷10³；
- 备选：`TGaxis::SetMaxDigits(3)` 让 ROOT 自动把 `×10³` 画在轴顶端（但不在标题里）；
- `TitleOffset` 与标签宽度匹配：5 位数字需 ~1.3，2 位（0–80）用 0.8；
- 同时把 `BottomMargin` 加到 `>=0.24`、X 轴 `SetTitleOffset(0.9)`，避免 `[GeV]` 的 `]` 被下边缘裁掉。

**自检（PNG 边缘是否被裁）：**

```bash
python3 -c '
from PIL import Image; import numpy as np
a=np.array(Image.open("fig.png").convert("L")); d=(a<180)
print("left cut:", int(d[:,:3].sum()), "bottom cut:", int(d[-3:,:].sum()))   # 都应为 0
'
```

- 实测参考：`{belle,belle2}/Fit/MC/h110{1,2}/fit_de{,bymode}.C` 改后 896×622 图 content 边界 x=[39,852]、y=[41,566]，左/右/下均无裁剪。

---

## 6. LaTeX / note 中处理大图和大表

### 6.1 大表格使用 `\resizebox`

当表格列数很多、宽度超过 `\textwidth` 时，用 `\resizebox` 缩放：

```latex
\begin{table}[htbp]
  \centering
  \resizebox{\textwidth}{!}{%
    \begin{tabular}{lcccc}
      \hline
      A & B & C & D & E \\
      \hline
      ... & ... & ... & ... & ... \\
      \hline
    \end{tabular}%
  }
  \caption{大表格标题}
  \label{tab:example}
\end{table}
```

注意：
- `\resizebox` 会按比例缩放，文字也会变小，若表格特别宽应同时考虑字号；
- 不要在所有表格上都用，只有超出版心宽度时才需要；
- 如果表格太长（纵向），考虑拆表或使用 `longtable`。

### 6.2 大图使用宽度控制

普通大图建议：

```latex
\begin{figure}[htbp]
  \centering
  \includegraphics[width=\textwidth]{figure.pdf}
  \caption{...}
  \label{fig:example}
\end{figure}
```

如果仍太大，可以：

```latex
\includegraphics[width=0.8\textwidth]{figure.pdf}
```

如果需要强制缩放到版心宽度：

```latex
\resizebox{\textwidth}{!}{\includegraphics{figure.pdf}}
```

要点：
- 图不要超出页边距；
- 多子图用 `minipage` 或 `subfigure` 布局；
- 图内字号要保证缩放后仍可读。

---

## 7. 通用检查清单

- [ ] 图片比例是否符合要求？
- [ ] 多子图：每格比例是否对齐参考图、各格是否一致？
- [ ] 多子图：格上方标题是否被裁（`SetTextAlign(23)`）？
- [ ] 注释/legend 是否在格内且不压数据？
- [ ] 每次改图后是否重新渲染并目视自检？
- [ ] 背景线是否低于 Total Fit（联合拟合）？
- [ ] 各数据集是否分开展示？
- [ ] Y 轴是否留出 legend 空白？
- [ ] legend 是否碰到图框/数据？
- [ ] 坐标轴标题、刻度大小是否统一？
- [ ] PDF/PNG 是否同步更新？
- [ ] 大表格/大图是否已用 `\resizebox` 或 width 控制？
- [ ] 文档引用路径是否正确？
- [ ] 压缩包是否已更新？

---

## 8. 产物同步

绘图完成后，通常需要同步到：

```text
memo/Fig_new/
memo/pdf/
memo/png/
memo/archives/
```

压缩包统一放在：

```text
memo/archives/
```

推荐提供精选压缩包（如 `new_figures.zip`）作为最终下载包。

---

## 9. 多子图（pull / 残差 / 扫描）绘图经验

做 3×2、2×3 这类多 panel 图时，反复踩过的坑与通用做法如下。核心原则：**先对齐参考图的比例，小步改参数，每次渲染后目视自检。**

### 9.1 先对齐参考图的比例，不要凭感觉
- 动手前先找同类图的参考比例，量出像素：
  ```bash
  python3 -c "from PIL import Image; im=Image.open('ref.png'); print(im.size, im.size[0]/im.size[1])"
  ```
- 单 panel 参考常见为 `800×700`（比例 ≈1.14，略横向）。做 3×2 网格时画布取 `3×800 × 2×700 = 2400×1400`，每格即为同款比例。
- **不要用接近正方形的格子**：小 pad 里会显得"太高"，与参考单图不一致。若用户说"比例不对"，先量参考图再定画布。
- `TCanvas` 存出的 PNG 略小于 `w×h`，务必用上面的命令核对实际尺寸。

### 9.2 子图网格的边距与行间距
- `c->Divide(ncol, nrow, xgap, ygap)`：`xgap` 小；`ygap` 控制行距。
- 上下两排的视觉间距 ≈ 上排 `BottomMargin` + 下排 `TopMargin` + `ygap`。间距过大就**依次**减小：先 `ygap`，再两排的 top/bottom margin。
- 每个 pad 的边距按 pad 自身设：`LeftMargin` 要够放 Y 标题，`BottomMargin` 要够放 X 标题。

### 9.3 顶部标题：锚点决定是否被裁
- 用 `TLatex` 画每格上方居中标题时，`SetTextAlign(23)`（水平居中、**顶端**锚定）+ `y≈0.98` 最稳，永不越出 pad 上边界。
- `SetTextAlign(21)` 是**底端**锚定，文字向上生长，`y` 稍高就顶到边界被裁。

### 9.4 注释 / legend 不越界、不压数据
- 注释框右边界要 ≤ `1 - RightMargin`，否则超出子图框。
- 位置选数据低的区域（如高斯尾部上角），必要时配合 `SetMaximum` 留白。
- 留白系数"够用就好"：角落小注释 `1.15–1.25×max`；需要横向铺开的注释 `1.3–1.45×max`。过大显空，过小压数据。
- `TPaveText` 行距过大时，**缩小 box 高度**即可收紧（行数固定时高度越小行距越紧）；字号由 `SetTextSize` 单独控制。

### 9.5 希腊字母更像 LaTeX
- ROOT `#mu` / `#sigma` 字形随字体变：Helvetica(`42`) 是 sans 形；**Times(`132`)** 的 `#mu` 是衬线斜体，更接近 LaTeX `\mu`。
- 直接给注释 `pt->SetTextFont(132);` 即可。

### 9.6 数据点画在拟合曲线之上
```cpp
h->Draw("E1");        // 先画直方图，确定 frame
fit->Draw("same");    // 画拟合曲线
h->Draw("E1 same");   // 再把数据点画到曲线之上
```

### 9.7 边画边自检（必须）
- 每次改完参数都**重新生成并打开 PNG 目视检查**：标题是否被裁、X/Y 标题是否压刻度或越界、注释是否压数据/越界、各格比例是否一致、上下排间距是否合适。
- 小步改、渲染、看图、再改；不要一次堆很多改动。
- 像素法辅助检查边缘裁剪：
  ```bash
  python3 -c '
  from PIL import Image; import numpy as np
  a=np.array(Image.open("fig.png").convert("L")); d=(a<180)
  print("cut L/R/T/B:", int(d[:,:3].sum()), int(d[:,-3:].sum()), int(d[:3,:].sum()), int(d[-3:,:].sum()))  # 都应为 0
  '
  ```

### 9.8 与 note 拼图方式对齐
- 先确认 note 是"**一张 canvas 含所有子图**"还是"**多张单 panel 子图 + LaTeX `minipage`/`\makebox` 标注**"，两者做法不同，先问清楚再画。
- 若 Br 等参数已画在每格上方，则 caption 写描述性内容、不再逐格罗列；否则在 caption 中按顺序（如 top left to bottom right）说明。
