---
title: 从 1.25 纳秒到 95 纳秒：内存山的四个台阶
description: 同一次依赖读，工作集装在 L1 里时花 1.25 纳秒，漏到内存里花 95 纳秒。这篇把工作集从 2 KiB 扫到 64 MiB，在自己的机器上把内存山逐点量出来：四个台阶、三道悬崖，以及内存台阶里藏着的那笔页表行走。硬件原理系列第二篇，实验实测于同一台 Ryzen 5 5500U。
pubDate: 2026-09-15
category: hardware
tags: [硬件, CPU, 缓存, 内存, 性能]
---

上一篇[《只要 4 个字节，送来 64 个》](/posts/hardware-cache-line/)画出了缓存金字塔的形状，故意没回答「每层快多少」。这篇把数字补上：把工作集从 2 KiB 扫到 64 MiB，逐档量一次访存的真实延迟，看悬崖出现在哪一级、落差有多大。

这条曲线有个现成的名字：内存山（memory mountain），CSAPP 拿它当经典实验。本机这座山有四个台阶，登顶全程 76 倍；量山的路上还顺手抓到两种脏读数，一种是被人踩平的 L3 台顶，一种是混进内存台阶里的页表行走。

## 量具先定准：依赖读

上篇的教训还在：流式求和那把尺子，连跨行读的 21% 都遮住了。要量「一次访问」的延迟，得让下一次读的地址藏在上一次读回的值里，流水线无法超前，每一步都实打实地等数据到位。

程序就是上篇那个追逐实验的扩展。给定工作集大小，把缓冲切成 64 字节的行，每行头 8 个字节存下一站的字节偏移，Fisher-Yates 洗牌保证访问顺序随机，全体行连成一条单环：

```c
/* 在 buf 前 sz 字节建随机单环链：每条行内存下一站的偏移 */
static void build_chain(uint8_t *buf, size_t sz) {
    size_t n = sz / 64;
    size_t *perm = malloc(n * sizeof(size_t));
    for (size_t i = 0; i < n; i++) perm[i] = i;
    for (size_t i = n - 1; i > 0; i--) {         /* Fisher-Yates */
        size_t j = (((size_t)rand() << 15) ^ (size_t)rand()) % (i + 1);
        size_t t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (size_t i = 0; i < n; i++) {
        uint64_t v = perm[(i + 1) % n] * 64;
        memcpy(buf + perm[i] * 64, &v, sizeof v);
    }
    free(perm);
}

static double chase(uint8_t *buf, long steps) {
    uint64_t idx = 0;
    long warm = steps / 5;                        /* 热身不计时 */
    for (long i = 0; i < warm; i++) { uint64_t v; memcpy(&v, buf + idx, sizeof v); idx = v; }
    double t0 = now();
    for (long i = 0; i < steps; i++) {
        uint64_t v;
        memcpy(&v, buf + idx, sizeof v);
        idx = v;                                  /* 下一站地址在这次读回的值里 */
    }
    return (now() - t0) / steps;
}
```

随机顺序是必须的：上篇 stride=128 那档已经看过预取器的热情，顺序链会被它提前搬运，量出来的是预取速度。纪律照旧：钉在 cpu0（属 CCX0，能用的 L3 就是那块 4 MiB，另一半在另一个 CCX 上，钉住的进程碰不到）；16 档工作集轮次交错跑 5 轮，各取中位；步数随档位自适应，保证单点计时都在毫秒级以上。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 200" role="img" aria-label="随机环链示意：16 条 64 字节的行排成一排，访问顺序由随机洗牌决定，弧线箭头依次从行 3 跳到行 11，再跳到行 0、行 7、行 14，全体行连成一条单环；下方放大一条行，头部 8 字节存下一站的字节偏移，其余 56 字节不参与，读回的值就是下一次读的地址" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw2ArrA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-i" d="M0,0 L10,5 L0,10 z" fill="#2b2a26"/></marker>
</defs>
<text class="t" x="30" y="20" font-size="12" fill="#2b2a26">随机环链：每一站是一条 64B 行</text>
<rect class="bx-sick" x="60" y="56" width="34" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="77" y="75" text-anchor="middle" font-size="9" fill="#b03a2e">0</text>
<rect class="bx" x="94" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="128" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="162" y="56" width="34" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="179" y="75" text-anchor="middle" font-size="9" fill="#b03a2e">3</text>
<rect class="bx" x="196" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="230" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="264" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="298" y="56" width="34" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="315" y="75" text-anchor="middle" font-size="9" fill="#b03a2e">7</text>
<rect class="bx" x="332" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="366" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="400" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="434" y="56" width="34" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="451" y="75" text-anchor="middle" font-size="9" fill="#b03a2e">11</text>
<rect class="bx" x="468" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="502" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="536" y="56" width="34" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="553" y="75" text-anchor="middle" font-size="9" fill="#b03a2e">14</text>
<rect class="bx" x="570" y="56" width="34" height="30" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<path class="flk" d="M 179 52 Q 315 22 451 52" fill="none" stroke="#2b2a26" stroke-width="1.3" marker-end="url(#hw2ArrA)"/>
<path class="flk" d="M 451 52 Q 264 8 77 52" fill="none" stroke="#2b2a26" stroke-width="1.3" marker-end="url(#hw2ArrA)"/>
<path class="flk" d="M 77 90 Q 196 112 315 90" fill="none" stroke="#2b2a26" stroke-width="1.3" marker-end="url(#hw2ArrA)"/>
<path class="flk" d="M 315 52 Q 425 28 536 52" fill="none" stroke="#2b2a26" stroke-width="1.3" marker-end="url(#hw2ArrA)"/>
<text class="ts" x="60" y="128" font-size="9.5" fill="#6b675e">访问顺序随机成环：3 → 11 → 0 → 7 → 14 → …，从任意一站出发，绕一圈回到原地</text>
<line class="fl" x1="179" y1="88" x2="128" y2="138" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<rect class="bx-q" x="60" y="142" width="120" height="38" rx="2" fill="#f6f3ec" stroke="#b03a2e" stroke-width="1.6"/>
<text class="ts" x="120" y="165" text-anchor="middle" font-size="9" fill="#b03a2e">下一站偏移 · 8B</text>
<rect class="bx" x="180" y="142" width="300" height="38" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="330" y="165" text-anchor="middle" font-size="9" fill="#6b675e">其余 56 字节（不参与追逐）</text>
<text class="ts" x="496" y="165" font-size="9.5" fill="#6b675e">读回的值 = 下一次读的地址</text>
</svg>
</figure>

## 本机的山

16 档工作集，一次完整运行的读数：

```text
钉 cpu0（CCX0，L3=4M），5 轮交错取中位，随机环链依赖读
主缓冲 AnonHugePages=65536 kB（THP 背书情况，/proc/self/smaps 实读）
  2K  中位=   1.25 ns/访问  (min=  1.24 max=  1.25)  步数=2000000
  4K  中位=   1.24 ns/访问  (min=  1.24 max=  1.26)  步数=2000000
  8K  中位=   1.24 ns/访问  (min=  1.24 max=  1.24)  步数=2000000
 16K  中位=   1.24 ns/访问  (min=  1.24 max=  1.25)  步数=2000000
 32K  中位=   1.25 ns/访问  (min=  1.24 max=  1.27)  步数=2000000
 64K  中位=   2.74 ns/访问  (min=  2.71 max=  3.25)  步数=1000000
128K  中位=   3.19 ns/访问  (min=  3.17 max=  3.27)  步数=1000000
256K  中位=   3.35 ns/访问  (min=  3.33 max=  3.36)  步数=1000000
512K  中位=   3.48 ns/访问  (min=  3.40 max=  3.50)  步数=1000000
  1M  中位=   8.09 ns/访问  (min=  8.06 max=  8.10)  步数=400000
  2M  中位=   9.03 ns/访问  (min=  9.01 max=  9.06)  步数=400000
  4M  中位=  15.62 ns/访问  (min= 10.82 max= 24.13)  步数=400000
  8M  中位=  74.49 ns/访问  (min= 73.36 max= 78.75)  步数=400000
 16M  中位=  86.00 ns/访问  (min= 83.37 max= 86.97)  步数=200000
 32M  中位=  91.49 ns/访问  (min= 90.78 max= 96.12)  步数=200000
 64M  中位=  94.48 ns/访问  (min= 93.99 max= 95.15)  步数=200000
```

从山脚往上读。

L1 台阶：2K 到 32K，五档全是 1.24 至 1.25 ns，档与档之间差不过 0.01。边界与 sysfs 里的 32K 严丝合缝。按本机 4 GHz 的睿频折算，约 5 个时钟周期。

第一道悬崖在 32K 之后：64K 档跳到 2.74 ns，512K 档 3.48 ns，这是 L2 台阶，落差两倍多。64K 是个过渡档，工作集装不满 L1 又刚过界，装得下的部分留在 L1，装不下的落 L2，平均值坐在两级之间。

第二道悬崖在 512K 之后：1M 档 8.09 ns，进入 L3 台阶。1M 与 2M 两档的 min-max 极差只有 0.04 和 0.05 ns，稳得像画出来的。

4M 档开始飘。这一档中位 15.62，min 10.82，max 24.13；换一遍完整程序重跑，同档中位是 38.25，max 冲到 111.51。原因写在拓扑里：L3 的 `shared_cpu_list=0-5`，这块 4 MiB 是 6 个逻辑核的公产，机器上任何别的进程路过都会带走几行。工作集恰好等于容量时，同住者一脚就能把你踹下台顶，min 值 10.82 才更接近 L3 的真实延迟。共享缓存上的读数，中位数只能看个大概，min 值干净的时候才作数。

第三道悬崖在 4M 之后：8M 档 74.49 ns，工作集超出 L3，几乎每一步都漏到内存。此后 16M、32M、64M 继续缓爬到 94.48。全程登顶 1.24 到 94.48，76 倍；同样按 4 GHz 折算，5 个周期对 380 个周期。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="本机内存山曲线：横轴为工作集从 2K 到 64M 对数刻度，纵轴为纳秒每次访问。L1 台阶 2K 到 32K 约 1.25 纳秒，L2 台阶 64K 到 512K 为 2.7 到 3.5 纳秒，L3 台阶 1M 到 4M 为 8 到 16 纳秒，内存台阶 8M 到 64M 从 74 爬到 95 纳秒；三道悬崖分别标注 2.2 倍、2.3 倍、4.8 倍；4M 档画有 min-max 须线并注记另一遍运行中位 38.25，共享 L3 被同住进程干扰" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<rect x="64" y="40" width="174" height="240" fill="#ece9e2" opacity="0.35"/>
<rect x="238" y="40" width="149" height="240" fill="#ece9e2" opacity="0.55"/>
<rect x="387" y="40" width="113" height="240" fill="#ece9e2" opacity="0.35"/>
<rect x="500" y="40" width="136" height="240" fill="#ece9e2" opacity="0.55"/>
<text class="ts" x="151" y="56" text-anchor="middle" font-size="9.5" fill="#6b675e">L1 台阶 1.24-1.25</text>
<text class="ts" x="312" y="56" text-anchor="middle" font-size="9.5" fill="#6b675e">L2 台阶 2.7-3.5</text>
<text class="ts" x="443" y="56" text-anchor="middle" font-size="9.5" fill="#6b675e">L3 台阶 8-16</text>
<text class="ts" x="568" y="56" text-anchor="middle" font-size="9.5" fill="#6b675e">内存 74-95</text>
<line class="grid" x1="64" y1="280" x2="636" y2="280" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="64" y1="236" x2="636" y2="236" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="64" y1="193" x2="636" y2="193" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="64" y1="149" x2="636" y2="149" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="64" y1="105" x2="636" y2="105" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="64" y1="62" x2="636" y2="62" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="axis" x1="64" y1="34" x2="64" y2="280" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="64" y1="280" x2="636" y2="280" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="56" y="284" text-anchor="end" font-size="9" fill="#6b675e">0</text>
<text class="ts" x="56" y="240" text-anchor="end" font-size="9" fill="#6b675e">20</text>
<text class="ts" x="56" y="196" text-anchor="end" font-size="9" fill="#6b675e">40</text>
<text class="ts" x="56" y="153" text-anchor="end" font-size="9" fill="#6b675e">60</text>
<text class="ts" x="56" y="109" text-anchor="end" font-size="9" fill="#6b675e">80</text>
<text class="ts" x="56" y="65" text-anchor="end" font-size="9" fill="#6b675e">100</text>
<text class="ts" x="24" y="160" text-anchor="middle" font-size="9.5" fill="#6b675e" transform="rotate(-90 24 160)">ns / 访问</text>
<polyline class="curve-k" points="70,277.3 107.3,277.3 144.7,277.3 182,277.3 219.3,277.3 256.7,274 294,273 331.3,272.7 368.7,272.4 406,262.3 443.3,260.3 480.7,245.9 518,117.5 555.3,92.4 592.7,80.4 630,73.8" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="70" cy="277.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="107.3" cy="277.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="144.7" cy="277.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="182" cy="277.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="219.3" cy="277.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="256.7" cy="274" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="294" cy="273" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="331.3" cy="272.7" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="368.7" cy="272.4" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="406" cy="262.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="443.3" cy="260.3" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="480.7" cy="245.9" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="518" cy="117.5" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="555.3" cy="92.4" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="592.7" cy="80.4" r="2.6" fill="#2b2a26"/>
<circle class="fill-c" cx="630" cy="73.8" r="2.6" fill="#2b2a26"/>
<line class="axis" x1="480.7" y1="256.4" x2="480.7" y2="227.4" stroke="#b03a2e" stroke-width="1.4"/>
<line class="axis" x1="475.7" y1="256.4" x2="485.7" y2="256.4" stroke="#b03a2e" stroke-width="1.4"/>
<line class="axis" x1="475.7" y1="227.4" x2="485.7" y2="227.4" stroke="#b03a2e" stroke-width="1.4"/>
<line class="fl" x1="420" y1="150" x2="476" y2="224" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<text class="tc" x="414" y="146" text-anchor="end" font-size="9.5" fill="#b03a2e">4M 档须线是本遍的 min-max；另一遍中位 38.25</text>
<text class="tc" x="238" y="238" font-size="10" fill="#b03a2e">×2.2</text>
<text class="tc" x="389" y="230" font-size="10" fill="#b03a2e">×2.3</text>
<text class="tc" x="502" y="186" font-size="10" fill="#b03a2e">×4.8</text>
<text class="ts" x="70" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">2K</text>
<text class="ts" x="144.7" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">8K</text>
<text class="ts" x="219.3" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">32K</text>
<text class="ts" x="294" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">128K</text>
<text class="ts" x="368.7" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">512K</text>
<text class="ts" x="443.3" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">2M</text>
<text class="ts" x="518" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">8M</text>
<text class="ts" x="592.7" y="296" text-anchor="middle" font-size="8.5" fill="#6b675e">32M</text>
<text class="ts" x="350" y="318" text-anchor="middle" font-size="9.5" fill="#6b675e">工作集（对数刻度）· 依赖读中位值，16 档 5 轮交错</text>
<text class="ts" x="636" y="318" text-anchor="end" font-size="9" fill="#6b675e">台阶边界 32K / 512K / 4M 与 sysfs 容量一致</text>
</svg>
</figure>

## 台顶藏着多少页表行走

8M 到 64M 的缓爬值得多看一眼。内存颗粒本身不会越读越慢，变化的是页：4K 页背书的 64M 工作集有 16384 个页，随机访问之下远超 TLB 容量，几乎每一步都附带一次页表行走。这条线索按下不表，先用对照实验把它钉住。

本机的透明大页设置是 `THP=always`，但 `defrag=defer+madvise`：缺页时不为凑 2M 大页做同步内存规整，能不能被大页背书要看碎片状况和后台 khugepaged 的心情。这个「心情」被我撞了个正着：第一遍运行时主缓冲的 `AnonHugePages` 实读只有 2048 kB，64M 一档量出 107.04 ns；第二遍实读 65536 kB（全部背书），同一档 94.48 ns。同一份代码，同一座山，差出 12 ns。所以对照组两头都必须强制，背书情况从 `/proc/self/smaps` 实读，不猜：

```c
madvise(nbuf, MAXSZ, MADV_NOHUGEPAGE);   /* 强制 4K 页 */
madvise(hbuf, MAXSZ, MADV_HUGEPAGE);     /* 强制 2M 大页 */
```

```text
64M 强制 4K 页（AnonHugePages=0 kB）    =108.35 ns/访问
64M 强制大页（AnonHugePages=65536 kB）  = 98.95 ns/访问   差=+9.41 ns
（另一遍：102.14 对 95.12，差 +7.03 ns）
```

4K 页管 16384 个页，大页只管 32 个，页表行走几乎消失。7 到 9 ns 的差值就是它的身价，约占内存台阶的 8%。内核侧的页表机制在[《Linux 页表：一次访存的四层翻译》](/posts/kernel-page-tables/)里写过了；这几纳秒在硬件侧怎么花出去的、大页什么时候值得开，下一篇逐层量。

## 山的另一面：带宽

延迟只是一个面。另一个面是带宽：单位时间搬得动多少数据。量法换成顺序流式扫描，每档约 256 MiB 工作量，同样钉核、交错、取中位。

这把尺子自己先翻过一次车。第一版用单个累加器，16K 档只量出 29.7 GB/s：加法是依赖链，每周期一次、每次 8 字节，4 GHz 下封顶约 32 GB/s，量到的是 ALU。换成四路独立累加器，加法不再互相等：

```c
uint64_t s0 = 0, s1 = 0, s2 = 0, s3 = 0;
for (long r = 0; r < reps; r++)
    for (size_t i = 0; i + 32 <= sz; i += 32) {
        uint64_t a, b, c, d;
        memcpy(&a, buf + i, 8);       /* 四条独立依赖链 */
        memcpy(&b, buf + i + 8, 8);
        memcpy(&c, buf + i + 16, 8);
        memcpy(&d, buf + i + 24, 8);
        s0 += a; s1 += b; s2 += c; s3 += d;
    }
```

```text
钉 cpu0，每档约 256 MiB 流式读工作量，3 轮交错取中位
 16K  中位=  109.9 GB/s  (min=108.5 max=119.9)
256K  中位=  125.2 GB/s  (min=123.7 max=125.7)
  2M  中位=   81.0 GB/s  (min=80.6 max=84.4)
  8M  中位=   20.1 GB/s  (min=19.8 max=21.1)
 64M  中位=   19.7 GB/s  (min=19.6 max=19.9)
```

L1、L2 两档的 110 至 125 GB/s 仍顶着一层天花板，只是换成了四路加法自己的上限：4 路 × 8 字节 × 4 GHz ≈ 128 GB/s。这两级的存储带宽比程序吃得下的还大，量不出来。L3 档 81 GB/s 开始露出存储的真身，内存档约 20 GB/s，与上一篇 32M 扫描折算出的数字对得上。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 252" role="img" aria-label="流式读带宽条形图：16K 档 109.9 GB/s，256K 档 125.2 GB/s，2M 档 81.0 GB/s，8M 档 20.1 GB/s，64M 档 19.7 GB/s；朱砂虚线标出四路加法指令上限约 128 GB/s，L1 与 L2 两档顶在指令上限而非存储上限" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">流式读带宽：山的另一面（GB/s）</text>
<text class="ts" x="160" y="59" text-anchor="end" font-size="9.5" fill="#6b675e">16K · L1</text>
<rect class="bar" x="170" y="46" width="338" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="514" y="60" font-size="9.5" fill="#6b675e">109.9</text>
<text class="ts" x="160" y="93" text-anchor="end" font-size="9.5" fill="#6b675e">256K · L2</text>
<rect class="bar" x="170" y="80" width="385" height="20" rx="1" fill="#2b2a26"/>
<text class="onbar" x="547" y="94" text-anchor="end" font-size="9.5" fill="#f6f3ec">125.2</text>
<text class="ts" x="160" y="127" text-anchor="end" font-size="9.5" fill="#6b675e">2M · L3</text>
<rect class="bar" x="170" y="114" width="249" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="425" y="128" font-size="9.5" fill="#6b675e">81.0</text>
<text class="ts" x="160" y="161" text-anchor="end" font-size="9.5" fill="#6b675e">8M · 超出 L3</text>
<rect class="bar" x="170" y="148" width="62" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="238" y="162" font-size="9.5" fill="#6b675e">20.1</text>
<text class="ts" x="160" y="195" text-anchor="end" font-size="9.5" fill="#6b675e">64M · 内存</text>
<rect class="bar" x="170" y="182" width="61" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="237" y="196" font-size="9.5" fill="#6b675e">19.7</text>
<line class="spine" x1="564" y1="38" x2="564" y2="208" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="5 3"/>
<text class="tc" x="556" y="32" text-anchor="end" font-size="9" fill="#b03a2e">四路加法指令上限 ≈128 GB/s</text>
<text class="ts" x="30" y="234" font-size="9.5" fill="#6b675e">同机同日。L1/L2 两档顶的是指令上限，存储的真实带宽比这更高</text>
</svg>
</figure>

从山顶到山脚，带宽只掉了 6 倍左右，远缓于延迟的 76 倍。坡缓的原因在前面已经出现过：带宽有预取器和多个并发 miss 可以赚，流式访问把延迟藏进了重叠里；依赖读的延迟无处可藏，每一步都得全额付款。同一座山，两个面的形状不一样，优化手段也就不一样：带宽吃紧的场景靠分块、压缩、减少搬运量；延迟吃紧的场景只能改访问模式，把依赖链剪短。

## 这座山怎么用

写热路径之前，先估工作集会落在哪个台阶。32K、512K、4M 是这台机器的三道坎，坎的位置每台机器都不同，从 sysfs 读自己的，别抄别人的数字。热数据从 512K 压进 32K，单次访问从 3.5 ns 回到 1.25 ns；放任它涨过 4M，每一步都在付 74 ns 起步。

数组和指针结构的差别，在山上就是两个面的差别。CPython 的 list 用连续数组加过度分配（[《每次搬家只多租一成》](/posts/cpython-list-internals/)），顺序扫描走的是带宽面，预取器全程帮忙；链表、树、哈希链一跳一跳走的是延迟面，每一跳都是一次依赖读。工作集在 L3 以内时跳一步 8 ns，漏到内存跳一步 95 ns，同样的算法差出一个量级。

B+ 树是延迟面上的工程师。树的每一层就是一次依赖读，树高就是攀岩的次数；InnoDB 用 16KB 的页把三四层做成千万行的容量（[《一行数据落在哪里》](/posts/mysql-innodb-pages-btree/)），就是在把登山次数压到四次以内，再让上面的层尽量留在低台阶上。

还有一条给共享机器的：L3 是公产。台顶被同住进程踩来踩去，4M 档两遍运行的中位能差出 20 多 ns。在开发机上量 L3 级别的数字，min 比中位可信；上了服务器，才有条件谈 L3 隔离与绑定，那是 NUMA 那篇的事。

---

这座山带走两组数就够了：台阶 1.25、3.5、8 至 16、95 ns，悬崖立在 32K、512K、4M 之后。延迟的落差是 76 倍，带宽的坡度只有 6 倍，两个面要用两种手段去优化。下一篇去拆内存台阶里那 7 到 9 ns 的页表行走：四层翻译每层多少钱，大页什么时候值得开。
