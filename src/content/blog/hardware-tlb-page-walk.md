---
title: 一块 TLB 只看住 4 MB：页表行走与大页的价钱
description: 页表把虚拟地址翻译成物理地址，翻译本身也要读内存。这篇用 cpuid 指令挖出本机 TLB 档案，再把 TLB 台阶一级级量出来：4K 页的 L2 TLB 触达只有 4 MB，超了每步多付 10 纳秒；页表自己撑爆缓存后，价钱涨到 40 纳秒以上。大页就是赎回这笔钱的工具，值不值取决于访问模式。硬件原理系列第三篇，实验实测于同一台 Ryzen 5 5500U。
pubDate: 2026-09-15
category: hardware
tags: [硬件, CPU, TLB, 内存, 性能]
---

上一篇[《从 1.25 纳秒到 95 纳秒》](/posts/hardware-memory-mountain/)的内存山里有一段没拆干净的零头：64M 工作集随机读，强制 4K 页比强制大页每次贵 7 到 9 ns，约占内存台阶的 8%。这笔钱付给了页表行走。这篇把行走本身拆开：它走几步、每步多少钱、什么时候变贵，以及大页这个赎身工具到底值不值。

## 一次访问，最多五次内存读

虚拟地址到物理地址的翻译，内核侧的机制[《Linux 页表：一次访存的四层翻译》](/posts/kernel-page-tables/)写过了：页表分层存放，缺页时由内核负责建立。这篇量硬件侧：翻译进行时，CPU 到底做了什么。

本机是 48 位虚拟地址、四级页表（lscpu 里 `Address sizes: 48 bits virtual`，flags 里没有五级的 la57）。48 位地址切成五段，每段 9、9、9、9、12 位，前四段是四层页表的索引，最后 12 位是页内偏移。翻译一次地址，MMU（CPU 里负责地址翻译的硬件单元）拿着索引逐层查表：PGD 里查出 PUD 的地址，再一路查到 PTE，PTE 里才是物理页基址。页表存在内存里，所以最坏情况下一共五次内存读：四次查表，一次取数据。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="四级页表翻译全景：48 位虚拟地址切成五段，前四段各 9 位分别是 PGD、PUD、PMD、PTE 四层页表的索引，最后 12 位是页内偏移；MMU 拿索引逐层查表，四次内存读后得到物理页基址，加上页内偏移合成物理地址再读数据，最坏五次内存读；朱砂虚线是 TLB 旁路，命中时四次查表全部跳过" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw3Arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-i" d="M0,0 L10,5 L0,10 z" fill="#2b2a26"/></marker>
<marker id="hw3ArrC" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-c" d="M0,0 L10,5 L0,10 z" fill="#b03a2e"/></marker>
</defs>
<text class="t" x="30" y="22" font-size="12" fill="#2b2a26">48 位虚拟地址（本机，四级页表）</text>
<rect class="bx-q" x="60" y="32" width="107" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="113" y="51" text-anchor="middle" font-size="9" fill="#2b2a26">47-39 · PGD 索引</text>
<rect class="bx-q" x="167" y="32" width="107" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="220" y="51" text-anchor="middle" font-size="9" fill="#2b2a26">38-30 · PUD 索引</text>
<rect class="bx-q" x="274" y="32" width="107" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="327" y="51" text-anchor="middle" font-size="9" fill="#2b2a26">29-21 · PMD 索引</text>
<rect class="bx-q" x="381" y="32" width="107" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="434" y="51" text-anchor="middle" font-size="9" fill="#2b2a26">20-12 · PTE 索引</text>
<rect class="bx" x="488" y="32" width="142" height="30" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="559" y="51" text-anchor="middle" font-size="9" fill="#2b2a26">11-0 · 页内偏移</text>
<rect class="bx" x="70" y="106" width="90" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="115" y="127" text-anchor="middle" font-size="10" fill="#2b2a26">PGD</text>
<rect class="bx" x="205" y="106" width="90" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="250" y="127" text-anchor="middle" font-size="10" fill="#2b2a26">PUD</text>
<rect class="bx" x="340" y="106" width="90" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="385" y="127" text-anchor="middle" font-size="10" fill="#2b2a26">PMD</text>
<rect class="bx" x="475" y="106" width="90" height="34" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="520" y="127" text-anchor="middle" font-size="10" fill="#2b2a26">PTE</text>
<line class="flk" x1="113" y1="62" x2="113" y2="102" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<line class="flk" x1="160" y1="123" x2="201" y2="123" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<text class="ts" x="180" y="115" text-anchor="middle" font-size="8.5" fill="#6b675e">读①</text>
<line class="flk" x1="220" y1="62" x2="245" y2="102" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<line class="flk" x1="295" y1="123" x2="336" y2="123" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<text class="ts" x="315" y="115" text-anchor="middle" font-size="8.5" fill="#6b675e">读②</text>
<line class="flk" x1="327" y1="62" x2="380" y2="102" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<line class="flk" x1="430" y1="123" x2="471" y2="123" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<text class="ts" x="450" y="115" text-anchor="middle" font-size="8.5" fill="#6b675e">读③</text>
<line class="flk" x1="434" y1="62" x2="515" y2="102" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<rect class="bx-q" x="340" y="180" width="150" height="34" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="415" y="201" text-anchor="middle" font-size="9.5" fill="#2b2a26">物理页基址</text>
<line class="flk" x1="520" y1="140" x2="440" y2="176" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<text class="ts" x="510" y="164" text-anchor="middle" font-size="8.5" fill="#6b675e">读④</text>
<line class="fl" x1="559" y1="62" x2="470" y2="176" stroke="#a29d90" stroke-width="1.1" stroke-dasharray="3 3" marker-end="url(#hw3Arr)"/>
<text class="ts" x="560" y="160" font-size="8.5" fill="#6b675e">＋页内偏移</text>
<rect class="bx-sick" x="540" y="180" width="90" height="34" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="585" y="201" text-anchor="middle" font-size="9.5" fill="#b03a2e">读⑤ 数据</text>
<line class="flk" x1="490" y1="197" x2="536" y2="197" stroke="#2b2a26" stroke-width="1.2" marker-end="url(#hw3Arr)"/>
<path class="flc" d="M 66 47 C 26 120, 140 197, 336 197" fill="none" stroke="#b03a2e" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#hw3ArrC)"/>
<text class="tc" x="120" y="176" font-size="9.5" fill="#b03a2e">TLB 命中：四次查表全跳过</text>
<text class="ts" x="60" y="244" font-size="9.5" fill="#6b675e">最坏五次内存读：四次查表 + 一次取数。页表自己住在内存里，查表的每一读也走缓存，</text>
<text class="ts" x="60" y="262" font-size="9.5" fill="#6b675e">所以实际价钱取决于页表条目在不在缓存里，这正是下面两组实验要分开量的东西。</text>
</svg>
</figure>

五次内存读是最坏情况，实际几乎没人这么惨，因为翻译结果本身也有缓存：TLB（Translation Lookaside Buffer），挂在 MMU 里的翻译缓存，存「虚拟页号 → 物理页基址」的映射。命中时四次查表整体跳过，只剩读数据那一次。于是问题变成：TLB 装得下多少？装不下时行走多少钱？

## 本机的 TLB 档案

缓存的档案在 sysfs 里躺着（第一篇读过），TLB 没有这个待遇，得向 CPU 直接发 cpuid 指令问。AMD 的 TLB 信息在 Fn8000_0005、Fn8000_0006、Fn8000_0019 三个叶子里，写二十行 C 自己解：

```c
#include <cpuid.h>
unsigned int a, b, c, d;
__cpuid(0x80000005, a, b, c, d);
/* EAX=L1 DTLB，EBX=L1 ITLB：
   低半 [15:8] 关联度(0xFF=全关联) [7:0] 条目数，对应 4K 页
   高半 [31:24] 关联度 [23:16] 条目数，对应 2M/4M 页 */
printf("L1 DTLB: 4K 页 %u 条目\n", a & 0xFF);
```

```text
Fn8000_0005 raw: EAX=ff40ff40 EBX=ff40ff40 ECX=20080140 EDX=20080140
L1 DTLB: 4K 页 64 条目(关联度 0xff=全关联)，2M/4M 页 64 条目(0xff=全关联)
L1 ITLB: 4K 页 64 条目，2M/4M 页 64 条目
对验 L1 数据缓存: 32 KB、8 路、行 64 B（sysfs: 32K/index0）
对验 L1 指令缓存: 32 KB、8 路、行 64 B（sysfs: 32K/index1）
Fn8000_0006 raw: EAX=48006400 EBX=68006400 ECX=02006140 EDX=00409140
对验 L2 缓存: 512 KB（sysfs: 512K/index2）
L2 DTLB 按 [27:16]/[11:0] 解: 2M/4M 页 2048 条目，4K 页 1024 条目（以实验为准）
L2 ITLB 按 [27:16]/[11:0] 解: 2M/4M 页 2048 条目，4K 页 1024 条目
Fn8000_0019 raw: EAX=f040f040 EBX=00000000（1G 页: L1 64 条目 / L2 64 条目）
```

解码正确不正确，有个现成的对验：Fn8000_0005 的 ECX、EDX 两个寄存器装的其实是 L1 缓存的几何参数，按同一套字节序解出来是 32 KB、8 路、行 64 B，与第一篇从 sysfs 读到的 index0/index1 严丝合缝。缓存部分解对了，同一寄存器组里的 TLB 字段也就可信。

整理成本机的 TLB 档案：L1 DTLB 对 4K 页 64 条目、全关联，对 2M/4M 大页也是 64 条目；L2 统一 TLB 对 4K 页 1024 条目（这个字段各家资料的解法有细微出入，原始值如上，下面的实验会替它定音）；1G 大页另有 64 条目。

档案直接换算成触达（reach）：条目数 × 页大小，就是 TLB 不 miss 能看住的内存总量。

- L1 DTLB：64 × 4K = **256 KB**
- L2 TLB：1024 × 4K = **4 MB**
- 换 2M 大页：L1 64 × 2M = 128 MB，L2 2048 × 2M = 4 GB

同一块 TLB 硬件，换个页大小，看住的世界差三个数量级。这就是大页的全部秘密：它不治翻译，它消灭翻译的次数。

## 把翻译的台阶量出来

档案是纸面数字，台阶要自己量。设计沿用内存山的依赖读追逐，但把变量反过来钉死：环链节点恒为 4096 个，数据足迹恒为 256 KiB，稳稳驻留 L2；唯一改变的是这 4096 个节点散布在多少个 4K 页上，从 64 页到 4096 页。缓存行为全程恒定，延迟的变化只能来自 TLB。

```c
/* 节点 i 的家：页 p = i%P，页内行号 line = ((i/P)*7 + p*13) % 64 */
static uint64_t node_off(int i, size_t P) {
    size_t p = (size_t)i % P;
    size_t k = (size_t)i / P;
    size_t line = (k * 7 + p * 13) % 64;
    return (uint64_t)(p * PAGE + line * 64);
}
```

这行号公式是返工换来的。第一版图省事，把每页的节点都放在页第 0 行，结果页地址全是 4096 的整倍数，缓存组号由地址中间位决定，4096 步长让所有节点撞进同 16 个 L2 set，L1 更是全撞一组：256 页档量出 8.84 ns 的「假台阶」，其实是缓存组冲突，跟 TLB 无关。修正办法是让页内行号按 (k×7 + p×13) mod 64 打散，7 与 64 互质保证同页节点互不撞行，跨页节点铺满所有缓存组；建链时再加一道地址单射自检。自检当天就立了功：16 页档报出节点地址冲突，查出来是页内行数超过 64 时翻到了下一页，两个节点写进了同一个 8 字节，环链退化成短环，量出 0.99 ns 的更快假数。数据可疑时，先怀疑量具，这次连量具的 bug 都有案可查。

修正后，钉 cpu0、5 轮交错、每档取中位：

```text
缓冲 AnonHugePages=0 kB（应为 0：强制 4K 页）
节点恒 4096 个（数据 256 KiB 驻留 L2），只改页散布；钉 cpu0，5 轮交错取中位
页散布=  64 页  中位=  3.01 ns/访问  (min=  2.95 max=  3.06)
页散布= 128 页  中位=  4.96 ns/访问  (min=  4.84 max=  5.33)
页散布= 256 页  中位=  4.43 ns/访问  (min=  4.42 max=  4.46)
页散布= 512 页  中位=  4.76 ns/访问  (min=  4.70 max=  5.22)
页散布=1024 页  中位=  8.66 ns/访问  (min=  8.55 max=  8.79)
页散布=1536 页  中位=  9.54 ns/访问  (min=  9.42 max= 10.09)
页散布=2048 页  中位=  9.25 ns/访问  (min=  9.12 max=  9.83)
页散布=4096 页  中位= 13.34 ns/访问  (min=13.23 max=17.15)
```

从低往高读。64 页档 3.01 ns，就是上一篇 256K 工作集的 L2 数据基线（那边读的 3.35，跨遍漂移一成以内），TLB 全程命中，翻译不要钱。128 到 512 页档抬到 4.4 至 5.0 ns：页数超过 L1 DTLB 的 64 条目，每步都要去 L2 TLB 查一次，这 1.4 到 2 ns 就是 L2 TLB 的查询价。1024 到 2048 页是边界带，两遍完整程序一遍读 5.1 至 5.7，另一遍读 8.7 至 9.5，LRU 在容量线附近掷骰子，加上 L3 上住着别的进程，这一带天生漂；cpuid 解出的 1024 条目正落在漂移带起点。4096 页档两遍都是 13.1 至 13.3，稳了：L2 TLB 彻底兜不住，每步一次完整页表行走。

注意这个 13.3 ns 的成色：此时 PTE 表总共才 32 KB（4096 项 × 8 B），四层查表全部命中缓存，这是「热页表」行走的价钱，比 L2 数据基线贵约 10 ns。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 320" role="img" aria-label="TLB 台阶曲线：横轴为页散布 64 到 4096 页（对数刻度），纵轴为纳秒每次访问，两遍完整运行的两条折线。64 页约 3.0 纳秒是 L2 数据基线；128 到 512 页抬到 4.4 至 5.0，是 L2 TLB 查询价；1024 到 2048 页是容量边界带，两遍读数在 5.1 到 9.5 之间漂移；4096 页两遍都落在 13.1 至 13.3，完整页表行走约加 10 纳秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<rect x="60" y="40" width="55" height="230" fill="#ece9e2" opacity="0.35"/>
<rect x="115" y="40" width="345" height="230" fill="#ece9e2" opacity="0.55"/>
<rect x="460" y="40" width="170" height="230" fill="#ece9e2" opacity="0.35"/>
<text class="ts" x="87" y="56" text-anchor="middle" font-size="9" fill="#6b675e">L1 DTLB</text>
<text class="ts" x="287" y="56" text-anchor="middle" font-size="9.5" fill="#6b675e">L2 TLB 兜住（4K 页 1024 条目）：每步多付查询价 1.4-2 ns</text>
<text class="ts" x="545" y="56" text-anchor="middle" font-size="9" fill="#6b675e">页表行走</text>
<line class="grid" x1="60" y1="270" x2="630" y2="270" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="60" y1="207" x2="630" y2="207" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="60" y1="144" x2="630" y2="144" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="60" y1="81" x2="630" y2="81" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="axis" x1="60" y1="34" x2="60" y2="270" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="60" y1="270" x2="630" y2="270" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="52" y="274" text-anchor="end" font-size="9" fill="#6b675e">0</text>
<text class="ts" x="52" y="211" text-anchor="end" font-size="9" fill="#6b675e">4</text>
<text class="ts" x="52" y="148" text-anchor="end" font-size="9" fill="#6b675e">8</text>
<text class="ts" x="52" y="85" text-anchor="end" font-size="9" fill="#6b675e">12</text>
<text class="ts" x="24" y="152" text-anchor="middle" font-size="9.5" fill="#6b675e" transform="rotate(-90 24 152)">ns / 访问</text>
<polyline class="curve-s" points="70,221 160,200.6 250,192.9 340,190.2 430,189.3 482.6,188.5 520,180.2 610,63.9" fill="none" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 3"/>
<polyline class="curve-k" points="70,222.7 160,192 250,200.4 340,195.2 430,133.9 482.6,120.1 520,124.7 610,60.4" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="70" cy="222.7" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="160" cy="192" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="250" cy="200.4" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="340" cy="195.2" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="430" cy="133.9" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="482.6" cy="120.1" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="520" cy="124.7" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="610" cy="60.4" r="2.6" fill="#2b2a26"/>
<text class="ts" x="76" y="242" font-size="9" fill="#6b675e">3.0 = L2 数据基线（对上篇 3.35）</text>
<text class="tc" x="452" y="96" font-size="9.5" fill="#b03a2e">边界带：两遍漂 5.1-9.5</text>
<text class="tc" x="604" y="86" text-anchor="end" font-size="9.5" fill="#b03a2e">13.1-13.3：整次行走 +10 ns</text>
<text class="ts" x="70" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">64</text>
<text class="ts" x="160" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">128</text>
<text class="ts" x="250" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">256</text>
<text class="ts" x="340" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">512</text>
<text class="ts" x="430" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">1024</text>
<text class="ts" x="482.6" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">1536</text>
<text class="ts" x="520" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">2048</text>
<text class="ts" x="610" y="286" text-anchor="middle" font-size="8.5" fill="#6b675e">4096</text>
<text class="ts" x="345" y="306" text-anchor="middle" font-size="9.5" fill="#6b675e">页散布（数据足迹恒 256 KiB）· 实线/虚线 = 两遍完整运行</text>
</svg>
</figure>

## 页表自己撑爆缓存之后

热页表行走 10 ns 有个前提：页表本身装得进缓存。工作集一大，这个前提就没了。1 GiB 缓冲按 4K 页要 262144 个页，PTE 表自身 2 MiB，是 L2（512 KiB）的四倍：行走的第四步取 PTE，得去 L3 甚至内存。

量法升级：1 GiB 缓冲每页只放一个节点，262144 个节点的随机环链，钉 cpu0，3 轮交错：

```text
4K 缓冲 AnonHugePages=0 kB，大页缓冲 AnonHugePages=90112 kB
1 GiB 随机依赖读（150000 步/轮，3 轮交错取中位）
  4K 页（262144 页，PTE 表 2 MiB）  中位= 150.22 ns/访问 (min=148.53 max=150.57)
  2M 大页（512 页）                 中位= 146.69 ns/访问 (min=141.64 max=152.93)
```

4K 页一侧两遍完整程序读数 150.2 与 151.5 ns，很稳。对照组却翻车了：大页缓冲的 AnonHugePages 只有 90112 kB，1 GiB 里只背书了 8.6%；再跑一遍也只有 14%。单独探测更小的缓冲一样惨：256 MiB 背书 7%，512 MiB 背书 11%。原因写在系统状态里：本机 THP 的 defrag 策略是 defer+madvise，缺页时不为凑大页做同步规整，全靠后台 khugepaged 慢慢折叠，而它开机至今总共只折叠了 464 页；hugetlb 预留池是 0，非 root 又没法预留。内存碎片化到这个程度，大页就是分配不出来。

所以 1 GiB 的大页基线只能推算：上一篇 64M 全背书时的大页读数是 95 至 99 ns，1 GiB 的数据访问本身会略贵一点（DRAM 行局部性更差），扣除之后，冷页表行走约 +40 至 50 ns，是热页表（+10 ns）的四五倍。四层查表里最贵的是取 PTE 那一层，它从缓存命中变成了 L3 甚至内存访问。

这次翻车本身比实验更值钱。上一篇做实验时，同一台机器的主缓冲还是 65536 kB 全额背书；隔了一天，同样的调用只能要到 7% 到 14%。THP 开了也未必拿得到，背书率跟着系统碎片状态漂。任何大页实验都必须从 `/proc/self/smaps` 实读 AnonHugePages 验货，配置写着 always 不算数。

## 那大页到底值不值

把三个场景的实测并排放：

随机访问、64M 工作集（PTE 128 KB，L2 兜住）：大页每步省 7 至 9 ns，约 8%。随机访问、1 GiB 工作集（PTE 2 MiB，L2 兜不住）：推算每步省 40 至 50 ns，三成上下。顺序流式呢？64 MiB 全缓冲流式扫描，4K 页对大页，第一版程序固定先测 4K，三遍读出大页「稳定慢 6% 到 8%」，像个真发现；把先后顺序按轮交替再测，符号直接翻脸（-6.6% 与 +15.3%）。所谓稳定差异是顺序偏置加噪声。顺序流式时预取器跑在一切前面，翻译开销早就被藏干净了，大页无稳定收益。

代价那一侧，本篇又添了一条实证：背书不确定，想要的时候可能要不到。另一条老代价在 Redis 那边写过：THP 把写时复制的粒度从 4K 放大到 2M，fork 型程序改一个字节要陪葬两兆的拷贝（[《快照在后台，停顿发生在前台》](/posts/redis-fork-cow/)），Redis 官方建议关 THP 就是为了这个。内核侧的碎片与拆分代价，页表篇和[《物理页的家底》](/posts/kernel-buddy-allocator/)都写过。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 256" role="img" aria-label="TLB 触达对比条形图（对数刻度）：4K 页时 L1 DTLB 64 条目只看住 256 KB，L2 TLB 1024 条目看住 4 MB；换 2M 大页后 L1 DTLB 看住 128 MB，L2 TLB 看住 4 GB，同一块硬件触达差三个数量级；底部注记实测：随机 64M 大页每步省 7 至 9 纳秒，随机 1G 推算省 40 至 50 纳秒，顺序流式无稳定差异" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">触达 = 条目数 × 页大小（横轴对数）</text>
<text class="ts" x="192" y="64" text-anchor="end" font-size="9" fill="#6b675e">4K 页 · L1 DTLB（64 条目）</text>
<rect class="bar" x="200" y="50" width="26" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="232" y="64" font-size="9.5" fill="#6b675e">256 KB</text>
<text class="ts" x="192" y="98" text-anchor="end" font-size="9" fill="#6b675e">4K 页 · L2 TLB（1024 条目）</text>
<rect class="bar" x="200" y="84" width="130" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="336" y="98" font-size="9.5" fill="#6b675e">4 MB</text>
<text class="ts" x="192" y="132" text-anchor="end" font-size="9" fill="#6b675e">2M 页 · L1 DTLB（64 条目）</text>
<rect class="bx-sick" x="200" y="118" width="260" height="20" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="466" y="132" font-size="9.5" fill="#b03a2e">128 MB</text>
<text class="ts" x="192" y="166" text-anchor="end" font-size="9" fill="#6b675e">2M 页 · L2 TLB（2048 条目）</text>
<rect class="bx-sick" x="200" y="152" width="390" height="20" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="596" y="166" text-anchor="end" font-size="9.5" fill="#b03a2e">4 GB</text>
<line class="axis" x1="200" y1="182" x2="590" y2="182" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="226" y="196" text-anchor="middle" font-size="8" fill="#6b675e">256K</text>
<text class="ts" x="330" y="196" text-anchor="middle" font-size="8" fill="#6b675e">4M</text>
<text class="ts" x="434" y="196" text-anchor="middle" font-size="8" fill="#6b675e">64M</text>
<text class="ts" x="538" y="196" text-anchor="middle" font-size="8" fill="#6b675e">1G</text>
<text class="ts" x="590" y="196" text-anchor="end" font-size="8" fill="#6b675e">4G</text>
<text class="ts" x="30" y="222" font-size="9.5" fill="#6b675e">实测口径：随机 64M 工作集，大页每步省 7-9 ns（约 8%）；随机 1G，推算省 40-50 ns；</text>
<text class="ts" x="30" y="240" font-size="9.5" fill="#6b675e">顺序流式无稳定收益（交替测量顺序后，差值正负翻转）。</text>
</svg>
</figure>

值不值的判断因此很简单：看访问模式，再看热页数。随机访问的热工作集除以 4K，超过 1024 页（4 MB），L2 TLB 就开始漏，每漏一次付 10 ns 起，工作集再大付到 40 ns 以上；这种场景大页是真金。顺序流式的热数据再多，预取器兜底，大页可有可无。至于 fork 频繁的进程，先算 COW 放大那笔再做决定。

## 这份档案怎么用

估热页数，别估热字节。4 MB 是本机 4K 页的 L2 TLB 边界，随机访问的热点超过它，翻译开始按次收费。边界位置每台机器不同，用 cpuid 或实验量自己的。

全局 THP=always 是把整机押上，madvise 按 VMA 控制才是手术刀。本文所有实验都用 `madvise(MADV_HUGEPAGE)` / `MADV_NOHUGEPAGE` 逐缓冲指定，从不依赖全局配置；生产上同理，数据库把自己的缓冲池 madvise 成大页，其余进程不受牵连。

背书要验货。AnonHugePages 从 `/proc/self/smaps` 实读，本篇两个实验一个全额背书、一个只有 8%，配置相同，命运不同。

翻译的钱分两档记：页表热时 +10 ns，页表冷时 +40 ns 起。做延迟预算的时候，TLB miss 和 cache miss 是两笔独立的开销，谁也替不了谁。

---

这篇把上一篇的 7 到 9 ns 拆成了档案、台阶和两档行走价：L1 DTLB 64 条目看 256 KB，L2 TLB 1024 条目看 4 MB，超界每步 +10 ns，页表自己冷了涨到 +40 ns 以上。下一篇回到第一篇伪共享矩阵里留的那个数：同一物理核的两个超线程，同行 83 ms、分行只要 10 ms。逻辑核为什么不是核，下一篇文章拆给你看。
