---
name: pdglive-lookup
description: 查询 PDG / pdgLive 数据:粒子分支比、误差、比值 R、拟合(FIT)信息与相关系数矩阵、跨版本数值对比。当用户要求核对 PDG 数值、查看 pdgLive 上的分支比或相关系数、验证论文引用的 PDG 输入时使用。
license: MIT
compatibility: opencode
metadata:
  source: "PDG / pdgLive (pdgapi.lbl.gov, pdglive.lbl.gov)"
  verified_edition: "2026"
---

# PDG / pdgLive 数据查询

## When to use me

用户要"用 pdgLive / PDG 接口查/核"粒子的分支比、误差、相关系数、拟合信息,或核对论文引用的 PDG 数值(如 Λc+、Ξc0、Ξc− 分支比)时。也可用于跨版本数值对比。

## 入口与关系(先看这里,别绕路)

| 入口 | 地址 | 用途 |
|---|---|---|
| pdgLive 网页 | https://pdglive.lbl.gov | 粒子页 + "Constrained Fit information"(唯一交互式看相关系数矩阵处) |
| REST API | https://pdgapi.lbl.gov | 即 pdgLive 每个 JSON 按钮背后的接口(响应 `request_url` 显示 `https://pdglive.lbl.gov//api/...`);文档 https://pdgapi.lbl.gov/doc/restapi.html |
| Python 包 | `pip install pdg` | 内嵌当前版 SQLite 数据文件,离线可用 |
| listings PDF | https://pdg.lbl.gov/2026/listings/rpp2026-list-<slug>.pdf | 唯一含 FIT INFORMATION 相关系数矩阵的非网页形式 |

**关键限制**:官方 status 页(https://pdgapi.lbl.gov/doc/status.html)写明 "Fit information and correlation matrices are **not yet accessible**"。→ REST API / JSON 按钮 / Python 包**都拿不到相关系数矩阵**;只能在 pdgLive 的 `Fit.action` 页或 listings PDF 的 "FIT INFORMATION" 框里看。

## REST API

- Base `https://pdgapi.lbl.gov`,端点:
  - `/info` — 版本、引用、更新时间
  - `/summaries/<PDGID>` — Summary 值(当前版)
  - `/summaries/<PDGID>/<EDITION>` — 旧版(如 `/S033.4/2025`)
  - `/listings/<PDGID>` — 测量记录,含 `related_data`(比值条目,`S0XXRYY` 形式,如 `S045R16`)
- PDGID 形如 `S033.4`(段号.模式号);大小写不敏感;分支比的 `mode_number` = listing 中 Γ_i 序号。
- 关键字段:`value` / `error_positive` / `error_negative` / `value_text` / `scale_factor` / `type` / `section`。
  - `type`: `"OUR FIT"` = 存在约束拟合(Λc+、Ξc0);`"OUR AVERAGE"` = 无拟合(Ξc+)。**看 type 即可判断 PDG 是否做了拟合**。
  - `scale_factor > 1`: 误差已被 PDG 缩放,引用时直接用。
- 限速:<2 请求/秒,循环内 sleep 0.8s。
- 无名称搜索:名称→PDGID 走 pdg 包或在 pdgLive 页面看 JSON 按钮旁标注的 PDGID。

## 已核实 PDGID 速查(PDG 2026)

| 量 | PDGID | 值(2026) | type |
|---|---|---|---|
| Λc+ → pK−π+ | S033.4 | (6.37±0.21)×10⁻² | OUR FIT |
| Λc+ → pK⁰S | S033.24 | (1.63±0.07)×10⁻² | OUR FIT |
| Ξc⁰ → Ξ−π+ | S048.1 | (1.43±0.27)×10⁻² | OUR FIT |
| Ξc⁰ → ΛK−π+ | S048.12 | (1.45±0.28)×10⁻² | OUR FIT |
| Ξc⁰ → pK−K−π+ | S048.10 | (4.9±1.0)×10⁻³ | OUR FIT |
| Ξc+ → pK−π+ | S045.13 | (6.2±3.0)×10⁻³ | OUR AVERAGE |
| Ξc+ → Ξ−π+π+ | S045.3 | (2.9±1.3)×10⁻² | OUR AVERAGE |
| R = G(pK−π+)/G(Ξ−2π+) | S045R16 | 0.21±0.04 | OUR AVERAGE |
| G(Ξ−2π+)/G(total) | S045R3 | (2.86±1.21±0.38)×10⁻² | 测量 |

粒子段号:Λc± = S033, Ξc± = S045, Ξc0 = S048。

## 相关系数查看步骤(pdgLive)

1. `https://pdglive.lbl.gov/Particle.action?init=0&node=<段号>`(Ξc0 → S048, Λc+ → S033)
2. 页面顶部蓝字 **"Constrained Fit information"** → `https://pdglive.lbl.gov/Fit.action?node=S048&init=0`
3. 页面:拟合说明(如 Ξc0: "An overall fit to 7 branching ratios uses 8 measurements to determine 4 parameters. χ²=1.4 for 4 d.o.f.")+ 百分比相关矩阵(行列标 x1 x5 x13 x27)+ 模式对照表(Γ1 = pK−K−π+ …)
4. 点 **"show precise values?"** 取未取整值(Ξc0: 63.80912 / 86.04353 / 74.15911 / 64.17929 / 55.31477 / 74.58932);写论文用精确值
5. 读法:xᵢ ≡ Γᵢ/Γ_total,索引 = DECAY MODES 表 Γ 编号;下三角,行×列

已核实数值:Λc+ ρ(pK⁰S, pK−π+) = **32%**;Ξc0 ρ(ΛK−π+, Ξ−π+) = **74%**、ρ(pK−K−π+, Ξ−π+) = **86%**、ρ(pK−K−π+, ΛK−π+) = **64%**。

## listings PDF(文件名不能猜)

在 `https://pdg.lbl.gov/2026/listings/contents_listings.html` 里 grep `rpp2026-list-` 取 slug(2025 版改年份)。已核实:`rpp2026-list-lambdac-plus.pdf`、`rpp2026-list-xic-plus.pdf`、`rpp2026-list-xic-zero.pdf`。提取:`pip install pypdf` + `PdfReader` + 逐页 `extract_text()`;PDF 文本行列会错位(ﬁ 连字、矩阵拆行),按"每行一个 x_i 标签"恢复。

## pdg 包用法(等价的名称→PDGID 路线)

```python
import pdg
api = pdg.connect()
print(api.edition, api.citation)   # '2026', F. Takahashi et al., IJMPA 41, 2630011 (2026)
p = api.get_particle_by_name('Xi_c()0')   # 名字必须带括号! 'Xi_c0'/'Lambda_c+' 报错
```

- 合法 ASCII 名:`Lambda_c()+`、`Xi_c()0`、`Xi_c()+`、`Xibar_c()-`。
- `api.get('S033')` 返回含正反粒子的列表;找段号可用 `api.get_particles()` 遍历。

## 最小模板(已知 PDGID)

```bash
# 简版:取 /info + /summaries(含旧版),间隔 0.8s
curl -s -m 60 "https://pdgapi.lbl.gov/info" -o /tmp/pdg_info.json
sleep 0.8
for id in S033.4 S033.4/2025 S048.12 S048.1 S048.10 S045.13 S045.3; do
  curl -s -m 60 "https://pdgapi.lbl.gov/summaries/$id" -o "/tmp/pdg_${id//\//_}.json"
  sleep 0.8
done
# 相关系数:Fit.action?node=S048&init=0(网页)或 listings PDF 的 FIT INFORMATION
```

## 环境注意(按机器适配)

- 本机(DSH 沙箱)受限模式下外网被禁(pwsh curl 000/exit 35),需 danger-full-access 放行;另一台机器一般无需。
- 脚本/输出用 UTF-8(`sys.stdout.reconfigure(encoding='utf-8', errors='replace')`),防含希腊字母/ﬁ 连字的文本崩终端。
- 复杂逻辑:先用编辑器写脚本文件再执行,循环请求加 sleep 限速。

## 输出惯例

- 先报版本引用(2026 = F. Takahashi et al. (Particle Data Group), Int. J. Mod. Phys. A 41, 2630011 (2026))
- 每个值给 PDGID + type(OUR FIT/OUR AVERAGE)+ value_text + scale_factor;与用户陈述逐项对照,明确标注一致/不一致
- 旧版对比走 `/summaries/<ID>/<EDITION>`;引用来源注明 "values from the PDG constrained fit, correlation coefficients from pdgLive 'Constrained Fit information'" + Fit.action 链接
- 相关系数给精确值,并说明 xᵢ ↔ 模式对应关系
- 提醒 API 不含拟合信息,别从 JSON/包里找相关系数
