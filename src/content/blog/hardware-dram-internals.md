---
title: 一条缓存行，正好内存的一口：DRAM 条解剖
description: 缓存行为什么恰好是 64 字节？因为 DDR4 总线一次突发传输吐 8 拍，正好这么多。这篇把内存条逐层拆开：电容矩阵、Bank 与 Rank，等效频率如何从两百年不动的核心频率里放大出来，tRP、tRCD、CL 各在什么时候付钱，以及顺序与随机、读与写的带宽实测。硬件原理系列第六篇，实验实测于同一台 Ryzen 5 5500U。
pubDate: 2026-09-18
category: hardware
tags: [硬件, 内存, DDR, 性能]
---

[第一篇](/posts/hardware-cache-line/)说缓存搬运按行计价，一行 64 字节。这个数字其实不是缓存单方面定的：以最普及的 DDR4 为例，总线一次突发传输（burst）送 8 拍，每拍 64 位也就是 8 字节，8 × 8 = 64，正好一条缓存行。两层硬件在这个数字上咬合，缓存只是照单全收。

这篇钻进内存条内部。要回答的是两件事：位到底存在什么东西里，行缓冲与时序那些数字值多少钱。至于第一篇跨步实验里「行越稀疏每行越贵」的那个坡，坡脚就埋在第一件事里。先交代一句口径：读本机内存条的 SPD 信息需要 root 权限的 `dmidecode -t memory`，这个环境拿不到，所以结构部分按主流 DDR4 的通用形态写，示例值都会标注；后果部分照旧在本机实测。

## 一条内存条，逐层拆开

从大到小四级。内存条上那排黑色颗粒叫 Chip；一组同时开工、合力拼出总线位宽的 Chip 叫一个 Rank，64 位总线配位宽 8 位的芯片，一个 Rank 就是 8 颗，内存条上标着 2R×8 的就是两个 Rank、每颗 8 位的意思。每颗 Chip 内部再切成十几个 Bank，Bank 才是能独立干活的分区。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="内存条四级解剖示意图：第一级内存条是一排芯片加金手指；第二级 Rank 是一组同时干活的芯片，八颗位宽 8 位的芯片并行拼出 64 位总线；第三级单颗芯片内部分成十几个 Bank；第四级每个 Bank 是电容矩阵，行线与列线交点处一个电容加一个晶体管存一个位；底部注明结构为通用 DDR4 示意，本机 SPD 需 root 权限读取" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">从一条内存到一个位：四级放大</text>
<rect class="bx-q" x="30" y="44" width="130" height="86" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx" x="40" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="54" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="68" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="82" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="96" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="110" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="124" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="138" y="58" width="12" height="18" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/>
<rect class="fill-c" x="40" y="112" width="110" height="8" rx="1" fill="#b03a2e" opacity="0.7"/>
<text class="ts" x="95" y="98" text-anchor="middle" font-size="8.5" fill="#6b675e">一排芯片</text>
<text class="ts" x="95" y="148" text-anchor="middle" font-size="9.5" fill="#2b2a26">① 内存条</text>
<text class="ts" x="95" y="164" text-anchor="middle" font-size="8.5" fill="#6b675e">金手指插进插槽</text>
<line class="fl" x1="160" y1="87" x2="188" y2="87" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<rect class="bx-q" x="190" y="44" width="130" height="86" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="200" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="214" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="228" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="242" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="256" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="270" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="284" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bx-sick" x="298" y="58" width="12" height="18" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bar" x="200" y="96" width="110" height="10" rx="1" fill="#2b2a26"/>
<text class="ts" x="255" y="122" text-anchor="middle" font-size="8" fill="#6b675e">64 位总线</text>
<text class="ts" x="255" y="148" text-anchor="middle" font-size="9.5" fill="#2b2a26">② Rank</text>
<text class="ts" x="255" y="164" text-anchor="middle" font-size="8.5" fill="#6b675e">8 颗 ×8 位的芯片并行拼 64 位</text>
<line class="fl" x1="320" y1="87" x2="348" y2="87" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<rect class="bx-q" x="350" y="44" width="130" height="86" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx" x="362" y="56" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="390" y="56" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="418" y="56" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="446" y="56" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/>
<rect class="bx" x="362" y="76" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx-sick" x="390" y="76" width="24" height="16" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/><rect class="bx" x="418" y="76" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="446" y="76" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/>
<rect class="bx" x="362" y="96" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="390" y="96" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="418" y="96" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><rect class="bx" x="446" y="96" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/>
<text class="ts" x="415" y="148" text-anchor="middle" font-size="9.5" fill="#2b2a26">③ 单颗芯片</text>
<text class="ts" x="415" y="164" text-anchor="middle" font-size="8.5" fill="#6b675e">内部再分十几个 Bank</text>
<line class="fl" x1="480" y1="87" x2="508" y2="87" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<rect class="bx-q" x="510" y="44" width="130" height="86" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<line class="grid" x1="522" y1="56" x2="628" y2="56" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="522" y1="70" x2="628" y2="70" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="522" y1="84" x2="628" y2="84" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="522" y1="98" x2="628" y2="98" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="522" y1="112" x2="628" y2="112" stroke="#a29d90" stroke-width="0.6"/>
<line class="grid" x1="536" y1="50" x2="536" y2="118" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="558" y1="50" x2="558" y2="118" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="580" y1="50" x2="580" y2="118" stroke="#a29d90" stroke-width="0.6"/><line class="grid" x1="602" y1="50" x2="602" y2="118" stroke="#a29d90" stroke-width="0.6"/>
<rect class="bx-sick" x="574" y="78" width="12" height="12" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="575" y="148" text-anchor="middle" font-size="9.5" fill="#2b2a26">④ Bank：电容矩阵</text>
<text class="ts" x="575" y="164" text-anchor="middle" font-size="8.5" fill="#6b675e">交点 = 一个电容 + 一个晶体管 = 一个位</text>
<text class="ts" x="30" y="196" font-size="9.5" fill="#6b675e">结构按通用 DDR4 示意：2R×8 的条子 = 2 个 Rank、每颗芯片位宽 8 位；服务器条的 Rank 是 72 位，</text>
<text class="ts" x="30" y="214" font-size="9.5" fill="#6b675e">多出来的 8 位是 ECC 校验芯片，第七篇的主角。本机条子的 SPD 需 root 权限的 dmidecode 才能读，</text>
<text class="ts" x="30" y="232" font-size="9.5" fill="#6b675e">本环境没拿到，图中不标本机数值。</text>
</svg>
</figure>

从大到小四级。内存条上那排黑色颗粒叫 Chip；一组同时开工、合力拼出总线位宽的 Chip 叫一个 Rank，64 位总线配位宽 8 位的芯片，一个 Rank 就是 8 颗，内存条上标着 2R×8 的就是两个 Rank、每颗 8 位的意思。每颗 Chip 内部再切成十几个 Bank，Bank 才是能独立干活的分区。

Bank 的内部是一个二维电容矩阵：行线和列线交错，每个交点挂一个电容加一个晶体管，电容里有没有电荷就是 0 和 1。这个存储方式决定了两件事。一是电容会漏电，读出来的数据必须周期性重新充上，这就是刷新，DDR4 的标准是 64 ms 内把所有行刷一遍；二是读取有破坏性，感应电路靠电容放电到位线上判断 0/1，读完必须回写，所以「读」在 DRAM 内部从来不是白拿的。

矩阵按行组织还带来一个关键角色：行缓冲（row buffer），Bank 里一排感应放大器。访问一个位的流程是先「激活」一整行，把整行（通常 1-2 KB）的电荷全部读进感应放大器，再从行缓冲里按列地址挑出要的那几个字节。用完这一行，访问别处前要「预充电」把位线恢复原状。一个位的存取，背后是一整行的起落。

## 频率数字是怎么放大的

内存条上写着 DDR4-3200，好像电路一秒振荡 32 亿次。没有。读一个电容的物理过程快不起来，DRAM 的核心频率二十年来一直在 133 到 200 MHz 附近徘徊，放大的全是传输手段：

- 核心频率 200 MHz：电容阵列真实的节奏；
- 预取 8 位：每个核心周期，内部一次并行取 8 位放到传输通道上，速度 ×8；
- 双沿传输：时钟上升沿、下降沿各传一次，这是 DDR（Double Data Rate）名字的由来，再 ×2。

200 MHz × 8 × 2 = 3200 MT/s（每秒传输次数），这就是 DDR4-3200。等效频率一路看涨、核心频率原地踏步，是预取和双沿在撑数字。而预取有个前提：一次取的 8 位得真的都有人用。它们来自同一列的相邻位置，也就是说，预取赌的还是局部性，跟第一篇缓存行的「顺路 60 字节」是同一场赌局的两端。

## 三个时序，两种命运

内存条规格里最出名的三个数：CL（Column Address Latency，列选通延迟）、tRCD（行激活到列访问的间隔）、tRP（预充电时间）。它们对应的就是上面那套行流程，单位是时钟周期。访问的命运分两种：

要的数据所在行已经在行缓冲里（row buffer hit），只付 CL；不在（miss），先给现在开着的行预充电付 tRP，再激活目标行付 tRCD，最后列选通付 CL。以典型的 DDR4-3200、CL22-22-22 为例算个数（示例值，非本机 SPD）：时钟 1600 MHz，一拍 0.625 ns，命中约 22 拍 ≈ 13.8 ns，miss 三段约 66 拍 ≈ 41 ns，三倍差距。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="一次内存读的两种命运时间线：行缓冲命中只付 CL 列选通约 13.8 纳秒然后 BL8 突发吐出 64 字节；行 miss 要先 tRP 预充电、再 tRCD 激活行、再 CL 列选通，三段各 22 拍共约 41 纳秒才开始传数据；底部注明实测内存台阶约 95 纳秒，时序表之外的差额是控制器排队、总线调度、TLB 与核到内存控制器的往返" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">一次读的两种命运（DDR4-3200 CL22-22-22 典型示例值）</text>
<text class="ts" x="30" y="66" font-size="10" fill="#2b2a26">行命中</text>
<rect class="bx" x="110" y="50" width="110" height="26" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="165" y="67" text-anchor="middle" font-size="9" fill="#2b2a26">CL 22 拍 ≈13.8ns</text>
<rect class="bx-q" x="220" y="50" width="60" height="26" rx="1" fill="#f6f3ec" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="250" y="67" text-anchor="middle" font-size="9" fill="#b03a2e">BL8 吐 64B</text>
<text class="ts" x="300" y="67" font-size="9.5" fill="#6b675e">目标行已在行缓冲里</text>
<text class="ts" x="30" y="122" font-size="10" fill="#2b2a26">行 miss</text>
<rect class="bx" x="110" y="106" width="110" height="26" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="165" y="123" text-anchor="middle" font-size="9" fill="#2b2a26">tRP 预充电 ≈13.8ns</text>
<rect class="bx" x="220" y="106" width="110" height="26" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="275" y="123" text-anchor="middle" font-size="9" fill="#2b2a26">tRCD 激活行 ≈13.8ns</text>
<rect class="bx" x="330" y="106" width="110" height="26" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="385" y="123" text-anchor="middle" font-size="9" fill="#2b2a26">CL ≈13.8ns</text>
<rect class="bx-q" x="440" y="106" width="60" height="26" rx="1" fill="#f6f3ec" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="470" y="123" text-anchor="middle" font-size="9" fill="#b03a2e">BL8 64B</text>
<text class="tc" x="516" y="123" font-size="9.5" fill="#b03a2e">数据动身前 ≈41ns</text>
<text class="ts" x="30" y="166" font-size="9.5" fill="#6b675e">第二篇实测本机「内存台阶」约 95 ns/次：时序表只解释其中约 41 ns，</text>
<text class="ts" x="30" y="184" font-size="9.5" fill="#6b675e">其余是控制器排队、总线调度、TLB（第三篇的 7-50 ns）与核到内存控制器的往返。</text>
<text class="ts" x="30" y="204" font-size="9.5" fill="#6b675e">行缓冲 = Bank 里的感应放大器排；同一行连续命中时，只有 CL 要付。</text>
</svg>
</figure>

把两个数字放在一起看，才不至于迷信规格书：[第二篇](/posts/hardware-memory-mountain/)实测的内存台阶是约 95 ns 一次随机访问，时序三段只解释约 41 ns，剩下的差额花在控制器的排队与调度、核到内存控制器的往返，以及[第三篇](/posts/hardware-tlb-page-walk/)量过的 TLB 上。规格书上的时序是 DRAM 芯片自己的动作时间，一次访问的完整价钱从来不止芯片这一段。

## 顺序偏好的价钱，实测

行缓冲的存在让内存也有了「顺序偏好」：连续访问同一行，只付 CL；跳着访问，每次都付全套。第一篇的跨步实验量过坡的形状，这次把坡拆开：行局部性和页局部性各值多少钱？

设计一个四顺序对照：512 MiB 缓冲（远超 L3），四种访问顺序都把全部 838 万行恰好摸一遍，总流量完全相同，只有顺序不同：

```c
/* seq：顺序扫，行、页全局部 */
/* rowmiss：4096 步长回绕，每步换页又换行 */
for (size_t p = 0; p < 64; p++)
    for (size_t off = p * 64; off < SZ; off += 4096) { … }
/* pagerand：页序按大步长伪随机，页内 64 行顺序扫：页不局部，行局部 */
/* prand：大步长伪随机整行跳跃，全不局部 */
```

```text
512 MiB 缓冲，每种顺序摸全部 8388608 行恰好一遍，3 轮交错取中位
seq      顺序扫（行+页双局部）  : 中位=  40.1 ms  带宽= 13.4 GB/s (min=12.3 max=14.6)
rowmiss  4096 步长（行页双 miss）: 中位=  90.0 ms  带宽=  6.0 GB/s (min=5.1 max=6.4)
pagerand 页随机+页内顺序      : 中位=  50.8 ms  带宽= 10.6 GB/s (min=8.0 max=10.6)
prand    伪随机整行跳跃       : 中位= 131.8 ms  带宽=  4.1 GB/s (min=3.6 max=4.4)
```

拆出来了。丢掉行局部性、保住页局部性的 pagerand 还有 seq 的 79%；行页全丢的 rowmiss 只剩 45%；连 Bank 落点都无法预测的 prand 只剩 31%。顺序偏好的大头是行缓冲，TLB 那一层（第三篇的老朋友）占小头。Kafka 的日志段把一切押在追加写上（[《追加的纪律》](/posts/kafka-log-segments/)），兑的就是 seq 对 prand 这 3 倍多的差价；B+ 树的随机下降每次取页都在坡的另一端付钱。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="局部性四顺序带宽条形图：同样的 512 MiB 总流量，顺序扫 13.4 GB/s 为百分之百，页随机页内顺序 10.6 保留 79%，4096 步长行页双 miss 6.0 剩 45%，伪随机整行跳跃 4.1 剩 31%；底部注明另一遍运行绝对值漂移但比例稳定，行局部性是大头" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">同流量，不同顺序（GB/s，512 MiB 全量扫描）</text>
<text class="ts" x="200" y="64" text-anchor="end" font-size="9.5" fill="#6b675e">seq 顺序扫</text>
<rect class="bar" x="210" y="50" width="335" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="551" y="64" font-size="9.5" fill="#6b675e">13.4（100%）</text>
<text class="ts" x="200" y="98" text-anchor="end" font-size="9.5" fill="#6b675e">pagerand 页随机+页内顺序</text>
<rect class="bar" x="210" y="84" width="265" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="481" y="98" font-size="9.5" fill="#6b675e">10.6（79%）丢页保行</text>
<text class="ts" x="200" y="132" text-anchor="end" font-size="9.5" fill="#6b675e">rowmiss 4096 步长</text>
<rect class="bx-sick" x="210" y="118" width="150" height="20" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="366" y="132" font-size="9.5" fill="#b03a2e">6.0（45%）行页全丢</text>
<text class="ts" x="200" y="166" text-anchor="end" font-size="9.5" fill="#6b675e">prand 伪随机跳跃</text>
<rect class="bx-sick" x="210" y="152" width="103" height="20" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="319" y="166" font-size="9.5" fill="#b03a2e">4.1（31%）全不局部</text>
<text class="ts" x="30" y="198" font-size="9.5" fill="#6b675e">另一遍运行：12.0 / 8.4 / 4.2 / 3.5，绝对值随机器状态漂，比例稳定：行局部性是大头。</text>
</svg>
</figure>

两遍运行的绝对带宽漂了 10% 到 30%（内存和频率当天状态不同），四个顺序的相对格局不变：保行丢页仍是小亏，丢行仍是腰斩起步。跨天比较绝对值没有意义，同轮比较比例才作数，这条纪律从 MQ 系列一路沿用到现在。

## 总线是半双工的

内存总线一次只能朝一个方向传：要么读，要么写，掉头有空转代价。读和写的「带宽」因此是两回事，实测四种操作：

```c
/* store：普通写循环。写分配（RFO）：写一行前，硬件先把这行读进缓存，
   语义上写 1 字节，总线上先读 64 再写 64 */
for (size_t i = 0; i < SZ / 8; i++) q[i] = i;
/* nt：非临时写，整行 8 个 qword 用 _mm_stream_si64 直写，绕过 RFO */
for (size_t i = 0; i < SZ; i += 64)
    for (int k = 0; k < 8; k++)
        _mm_stream_si64((long long *)(dst + i) + k, (long long)(i + k));
```

```text
256 MiB 缓冲（远超 L3），带宽按程序语义字节计，3 轮交错取中位
read  读（四路累加）      :  14.6 GB/s  (中位 18.4 ms, min=18.4 max=22.3)
store 普通写（含 RFO 回读）:   6.4 GB/s  (中位 42.2 ms, min=41.3 max=49.7)
nt    非临时写（绕过 RFO） :  16.6 GB/s  (中位 16.2 ms, min=15.8 max=16.2)
copy  复制（读+写）       :   3.6 GB/s  (中位 73.8 ms, min=63.5 max=77.6)
```

数字要按「总线流量」重算才看得懂。read 每个语义字节过总线一次；store 有 RFO，语义 6.4 GB/s 的背后总线跑了约 12.8；nt 直写不回读，总线 1 倍，语义带宽立刻追平甚至超过读（另一遍读到 21.1）；copy 最贵，读源、RFO 目标、写目标，每个语义字节过总线三次，3.6 × 3 ≈ 10.8。四种操作的总线真实流量其实都在 11 到 17 GB/s 一带，拉开语义带宽差距的，是每个语义字节过几趟总线。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="语义带宽与总线流量对照条形图：非临时写 16.6 GB/s 总线一倍，读 14.6 总线一倍，普通写 6.4 但总线两倍即 12.8，复制 3.6 总线三倍即 10.8；store 与 copy 的条后画虚线幽灵条表示总线真实流量；底部注明四种操作总线流量都在 11 到 17 GB/s 一带，语义带宽的差距等于每个语义字节过总线的趟数" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">语义带宽（实心）与总线流量（虚框）</text>
<text class="ts" x="180" y="64" text-anchor="end" font-size="9.5" fill="#6b675e">nt 非临时写</text>
<rect class="bar" x="190" y="50" width="332" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="528" y="64" font-size="9.5" fill="#6b675e">16.6 · 总线 ×1</text>
<text class="ts" x="180" y="98" text-anchor="end" font-size="9.5" fill="#6b675e">read 读</text>
<rect class="bar" x="190" y="84" width="292" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="488" y="98" font-size="9.5" fill="#6b675e">14.6 · 总线 ×1</text>
<text class="ts" x="180" y="132" text-anchor="end" font-size="9.5" fill="#6b675e">store 普通写</text>
<rect class="bar" x="190" y="118" width="128" height="20" rx="1" fill="#2b2a26"/>
<rect class="bx-gone" x="318" y="118" width="128" height="20" rx="1" fill="none" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="ts" x="452" y="132" font-size="9.5" fill="#6b675e">6.4 · 总线 ×2 = 12.8（RFO 回读）</text>
<text class="ts" x="180" y="166" text-anchor="end" font-size="9.5" fill="#6b675e">copy 复制</text>
<rect class="bar" x="190" y="152" width="72" height="20" rx="1" fill="#2b2a26"/>
<rect class="bx-gone" x="262" y="152" width="144" height="20" rx="1" fill="none" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="ts" x="412" y="166" font-size="9.5" fill="#6b675e">3.6 · 总线 ×3 = 10.8（读源+RFO+写）</text>
<text class="ts" x="30" y="202" font-size="9.5" fill="#6b675e">四种操作的总线流量都在 11-17 GB/s 一带：总线只认流量，不认语义。</text>
<text class="ts" x="30" y="222" font-size="9.5" fill="#6b675e">另一遍：read 16.2 / store 6.4 / nt 21.1 / copy 4.1，store 两遍分毫不差。</text>
</svg>
</figure>

RFO 不是浪费，它是缓存一致性的入场费：不先把行读进来，部分写入的行就没法维持「缓存里的行与内存一致」。但如果整行都是新数据、而且短期内不会再读它，这笔回读就是纯税，非临时写（non-temporal store）就是为此准备的免税通道。glibc 的 memcpy 超过阈值会切换成 NT 存储；`read()`/`write()` 在用户缓冲与页缓存之间成 GB 地拷贝（[《write() 返回了，数据还在内存里》](/posts/kernel-page-cache-writeback/)），大块时走的正是这类优化过的路径。代价是 NT 写绕过缓存，写完立刻要读的场景反而更慢，免税通道只适合一去不回头的流。

## 怎么用

优化的第一问永远是访问顺序。同一份数据、同一段总线，换个顺序差 3 倍：能排序就排序，能分块就分块，让每次激活的行多干点活再预充电。

估算写路径时先数总线趟数。语义上的「写 1 GB」，普通 store 是总线 2 GB，复制是 3 GB；大容量流式写考虑 NT，前提是整行写、不回头。

规格书的时序只是芯片自己的动作。评估一次访问，把控制器排队、TLB、互联都算进来，第二篇的 95 ns 和这篇的 41 ns 之间的差额就是教训本身。

想核对自家内存的真实时序，服务器上 `dmidecode -t memory` 读 SPD，`sudo` 不能少；读不到就用这篇的示例算法心算个量级。

---

这篇把内存条拆到了电容：位存在电容里，读就有破坏性，刷新就躲不掉。行缓冲一次开一整行，顺序与随机的带宽就差出 3 倍；总线半双工加上 RFO，写的语义带宽只剩读的一半不到。下一篇回到条子上多出来的那 8 颗芯片：服务器内存的 72 位里，64 位是数据，8 位是 ECC。一个位被高能粒子翻了面，海明码怎么在 9 行 8 列的矩阵里把它揪出来并翻回去，纯算法的一篇。
