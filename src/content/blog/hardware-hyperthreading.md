---
title: 第二个逻辑核：从 0.01 个到 0.93 个物理核
description: top 显示 12 核，本机其实只有 6 个物理核，另外 6 个逻辑核的价钱天差地别：计算饱和的负载下实测只值 1%，纯等内存的负载下值 93%，几乎等于一个真核。这篇拆开超线程复制了什么、共享了什么，并把 SMT 收益的两个端点在同一台机器上量出来。硬件原理系列第四篇，实验实测于同一台 Ryzen 5 5500U。
pubDate: 2026-09-16
category: hardware
tags: [硬件, CPU, 超线程, 性能]
---

[第一篇《只要 4 个字节，送来 64 个》](/posts/hardware-cache-line/)的伪共享矩阵里藏着一组没展开的数：两个线程钉在同一个物理核的两个超线程上，写同一条缓存行要 83 ms，分行只要 10 ms；而那 10 ms 又比跨物理核分行的读数慢。两个逻辑核加起来，从来不等于两个核。这篇把这句话量成数字：一个逻辑核到底值多少个物理核？本机的答案是一个区间，下界 0.01，上界 0.93。

## 本机的核数账

先把家底数清楚。Linux 把每个逻辑核登记成 `/proc/cpuinfo` 里的一个 processor 条目：

```bash
grep -c '^processor' /proc/cpuinfo        # 12
grep 'physical id' /proc/cpuinfo | sort -u   # 只有一个值：0
grep 'core id' /proc/cpuinfo | sort -u       # 六个值：0 1 2 4 5 6
lscpu -e=CPU,CORE,SOCKET
```

```text
CPU CORE SOCKET
  0    0      0
  1    0      0
  2    1      0
  3    1      0
  ...
 10    5      0
 11    5      0
```

三个概念就此对齐：物理 CPU 是主板上那颗芯片，`physical id` 去重后只有一个；物理核是芯片里真正带执行单元的核，`core id` 去重后六个；逻辑核是操作系统看到的 processor，十二个。`lscpu -e` 的映射表说得最直白：cpu0 和 cpu1 同属 CORE 0，cpu2 和 cpu3 同属 CORE 1，两个逻辑核挤一个物理核，这就是超线程（SMT，Simultaneous Multi-Threading）。

顺带一个容易让人起疑的细节：`core id` 的原始编号是 0、1、2、4、5、6，跳过了 3。这是 AMD 按 CCX 分段编号留的空位，不是缺了一个核，数个数就好，别数编号。

## 复制了什么，共享了什么

一个物理核装成两个逻辑核，硬件上做的是一笔精算：把便宜的东西复制一份，把贵的东西留着共用。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="物理核解剖图：一个大框代表物理核 0，里面并排两个小框是逻辑核 0 和逻辑核 1 各自的架构状态（寄存器组、程序计数器等，复制成本低），下方是共享的大块：执行单元、L1 32K 与 L2 512K 缓存、TLB；两个逻辑核的箭头汇入共享区，旁注说明 SMT 的赌注是单线程吃不满执行单元" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw4ArrS" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-s" d="M0,0 L10,5 L0,10 z" fill="#6b675e"/></marker>
</defs>
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">物理核 0（cpu0 + cpu1）的家当</text>
<rect class="bx-q" x="50" y="36" width="560" height="196" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<rect class="bx" x="76" y="56" width="230" height="56" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="191" y="80" text-anchor="middle" font-size="10.5" fill="#2b2a26">逻辑核 0 · 架构状态</text>
<text class="ts" x="191" y="99" text-anchor="middle" font-size="9" fill="#6b675e">寄存器组、PC 等，各一份</text>
<rect class="bx" x="354" y="56" width="230" height="56" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="469" y="80" text-anchor="middle" font-size="10.5" fill="#2b2a26">逻辑核 1 · 架构状态</text>
<text class="ts" x="469" y="99" text-anchor="middle" font-size="9" fill="#6b675e">复制的部分：便宜，KB 级</text>
<line class="fl" x1="191" y1="112" x2="270" y2="146" stroke="#6b675e" stroke-width="1.2" marker-end="url(#hw4ArrS)"/>
<line class="fl" x1="469" y1="112" x2="390" y2="146" stroke="#6b675e" stroke-width="1.2" marker-end="url(#hw4ArrS)"/>
<rect class="bx-sick" x="76" y="150" width="508" height="62" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="330" y="174" text-anchor="middle" font-size="10.5" fill="#b03a2e">共享的部分：执行单元、L1 32K + L2 512K、TLB 的大部分</text>
<text class="ts" x="330" y="195" text-anchor="middle" font-size="9" fill="#6b675e">贵的那部分只有一份（第一篇实测：L1/L2 的 shared_cpu_list 就是 0-1）</text>
<text class="ts" x="50" y="256" font-size="10" fill="#6b675e">SMT 的赌注：单线程吃不满执行单元，空窗卖给第二个线程</text>
</svg>
</figure>

复制的部分是架构状态：每个逻辑核有自己的一套寄存器、自己的程序计数器，操作系统把它当独立 CPU 调度。这部分是硅片上便宜的地皮。共享的部分是真正贵的：执行单元（乘法器、加法器、访存端口）、L1 和 L2 缓存、TLB 的大部分。第一篇读 sysfs 时见过证据：L1、L2 的 `shared_cpu_list` 都是 `0-1`，两个逻辑核共用一份。

于是 SMT 的全部逻辑就是一句赌注：单线程通常吃不满一个核的执行单元，把空窗卖给第二个线程。赌赢赌输，取决于负载给不给空窗留货。空窗从哪来？最典型的就是等内存：一次 DRAM 访问上百纳秒，核内够跑几百条指令，这些指令位就是 SMT 的货源。下面把两个端点都摆上实验台。

## 两个端点，实测

基准程序两种负载、三种落位，外加一组整机对照：

```c
/* ALU 负载：四条独立乘加链，把乘法器打满（吞吐饱和型） */
for (long i = 0; i < a->n; i++) {
    x0 = x0 * 6364136223846793005ULL + 1;   /* 四条链互不依赖， */
    x1 = x1 * 6364136223846793005ULL + 3;   /* 乘法器每周期都有活干， */
    x2 = x2 * 6364136223846793005ULL + 5;   /* 流水线没有空窗 */
    x3 = x3 * 6364136223846793005ULL + 7;
}
/* MEM 负载：第 2 篇同款 64M 随机环链依赖读，每步等一次内存 */

/* 落位：pthread_setaffinity_np 钉死
   单线程 cpu0 / 双线程同核 cpu0+1 / 双线程跨核 cpu0+2 */
```

ALU 负载刻意用四条独立链：若用一条依赖链，瓶颈是乘法延迟而不是乘法器吞吐，核其实没吃饱，量出来的就不是「饱和」端点了。MEM 负载直接复用[第二篇《从 1.25 纳秒到 95 纳秒》](/posts/hardware-memory-mountain/)内存山那把尺子，64M 随机环链，每步约 107 ns，核的时间几乎全花在等。8 个配置轮次交错跑 5 轮取中位，完整跑两遍：

```text
吞吐 M iter/s，5 轮交错取中位（括号内为倍数与 min-max）
ALU 单线程       钉 cpu0      :    977.3  (1.00x, 966.9-981.7)
ALU 双线程同核   钉 cpu0+1    :    991.8  (1.01x, 989.3-1002.9)
ALU 双线程跨核   钉 cpu0+2    :   1919.8  (1.96x, 1825.9-1957.3)
MEM 单线程       钉 cpu0      :      9.3  (1.00x, 8.5-9.4)
MEM 双线程同核   钉 cpu0+1    :     17.9  (1.93x, 15.6-18.0)
MEM 双线程跨核   钉 cpu0+2    :     17.8  (1.92x, 16.9-18.4)
ALU 6 线程  每物理核一个     :   5279.4  (5.40x, 5115.5-5544.8)
ALU 12 线程 全部逻辑核      :   5354.5  (5.48x, 4904.6-5464.8)
整机 SMT 收益（12 线程 / 6 线程，同为 6 个物理核干活）: 1.01x
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 236" role="img" aria-label="执行单元占用时间线对照：第一行 ALU 单线程，指令块排满时间轴，没有空窗；第二行 MEM 单线程，发出 load 后是大段等待数据的空白，指令块稀疏；第三行同核双线程跑 MEM，第二个线程的指令块（朱砂色）填进第一个线程的等待空窗，时间轴接近排满；右侧标注 ALU 加第二线程只得 1% 至 2%，MEM 得 85% 至 93%" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">空窗在哪，收益就在哪</text>
<text class="ts" x="40" y="58" font-size="9.5" fill="#6b675e">ALU 单线程</text>
<rect class="bar" x="130" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="164" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="198" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="232" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="266" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="300" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="334" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="368" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="402" y="44" width="34" height="20" fill="#2b2a26"/><rect class="bar" x="436" y="44" width="34" height="20" fill="#2b2a26"/>
<text class="ts" x="486" y="58" font-size="9.5" fill="#6b675e">乘法器排满</text>
<text class="ts" x="40" y="112" font-size="9.5" fill="#6b675e">MEM 单线程</text>
<rect class="bar" x="130" y="98" width="14" height="20" fill="#2b2a26"/><rect class="bx-gone" x="144" y="98" width="86" height="20" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/><rect class="bar" x="230" y="98" width="14" height="20" fill="#2b2a26"/><rect class="bx-gone" x="244" y="98" width="86" height="20" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/><rect class="bar" x="330" y="98" width="14" height="20" fill="#2b2a26"/><rect class="bx-gone" x="344" y="98" width="86" height="20" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/><rect class="bar" x="430" y="98" width="14" height="20" fill="#2b2a26"/><rect class="bx-gone" x="444" y="98" width="26" height="20" fill="#ece9e2" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="486" y="112" font-size="9.5" fill="#6b675e">虚框 = 等数据</text>
<text class="ts" x="40" y="166" font-size="9.5" fill="#6b675e">MEM 同核双线程</text>
<rect class="bar" x="130" y="152" width="14" height="20" fill="#2b2a26"/><rect class="bx-sick" x="144" y="152" width="86" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bar" x="230" y="152" width="14" height="20" fill="#2b2a26"/><rect class="bx-sick" x="244" y="152" width="86" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bar" x="330" y="152" width="14" height="20" fill="#2b2a26"/><rect class="bx-sick" x="344" y="152" width="86" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><rect class="bar" x="430" y="152" width="14" height="20" fill="#2b2a26"/><rect class="bx-sick" x="444" y="152" width="26" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="486" y="166" font-size="9.5" fill="#6b675e">朱砂 = 线程 B 补位</text>
<text class="tc" x="130" y="206" font-size="10.5" fill="#b03a2e">ALU 加第二个线程：+1~2%（没有空窗）    MEM 加第二个线程：+85~93%（空窗全是货）</text>
</svg>
</figure>

计算饱和端的读数最省：ALU 双线程同核 991.8 对单线程 977.3，第二个逻辑核只带来 1% 到 2%（两遍分别读 1.01x 和 1.02x）。乘法器被第一个线程占满，第二个线程排队等位，总吞吐几乎不动。这就是标题里的 0.01：对计算饱和的负载，一个逻辑核只值 0.01 个物理核。对照组 ALU 跨核 1.96x 说明这个数字不是负载写坏了：换一个真物理核，吞吐老实翻倍。

纯等内存端换了副面孔：MEM 双线程同核 17.9 对单线程 9.3，第二个逻辑核带来 93%（另一遍 85%）。每个线程每步都在等 DRAM 的一百来纳秒，核的执行单元几乎全程空转，第二个线程把空窗全部接住。更值得注意的是 MEM 同核 1.93x 与 MEM 跨核 1.92x 几乎相等：瓶颈在内存延迟而不在核，此时一个物理核开两个线程，约等于两个物理核各开一个线程。这是标题里的 0.93。

整机对照把两个端点合到一起：6 线程（每物理核一个）5279.4，12 线程（全部逻辑核）5354.5，收益 1.00 至 1.01 倍。计算饱和的负载下，超线程整机白给。顺带一个诚实的脚注：6 线程组折算单线程 880 M/s，比独占时的 977 低约 10%，那是全核睿频回落的价钱，跟 SMT 无关，两组配置都摊了这份钱，对比仍然公平。

## 「平均 20-30%」是怎么算的

Intel 对超线程的公开口径是平均提升 20% 到 30%。拿本机两个端点一夹就明白了：真实负载是两种极端的混合，等内存的时间占比越高，收益越靠近 93%；执行单元越饱和，收益越靠近 1%。20-30% 是对「典型混合负载」的加权平均，不是承诺。你的负载值多少，拿同一把尺子自己量：把线程钉进同一个物理核，看吞吐掉了多少，就知道 sibling 抢走了什么。

## 逻辑核的另一面

同核双线程对总量是 +1%，对存量线程是另一回事：ALU 配置里每个线程的独跑速度从 977 掉到约 496，直接腰斩。总吞吐没亏，是因为两个半速线程加起来约等于一个全速线程；但对延迟敏感的单个请求，sibling（同一物理核上的另一个逻辑核）一住进来，处理速度就是减半。云上买到的 vCPU 多数是逻辑核，你的实例性能有一半掌握在邻居手里，除非买的是独占物理核的规格。

共享的不只是执行单元。第一篇量过：同核两线程写同一条缓存行 83 ms，分行 10 ms，L1 就在两人中间，行不出核也要排队。L1、L2、TLB 全是合租的，一个线程可以用缓存把另一个线程的数据顶出去。

安全那一栏也记着 SMT 的名字。本机 lscpu 的漏洞清单实测有一行：

```text
Retbleed: Mitigation; untrained return thunk; SMT enabled with STIBP protection
```

跨逻辑核的侧信道（预测器状态、缓存痕迹都是共享的）需要 STIBP 这类机制专门设防，防护本身也有开销。侧信道细节不是本文的范围，只需要知道：SMT 的共享清单里还有微架构状态，安全通告里它常年在场。

最后是按核计费的授权费。操作系统报 12 核，按核授权的软件就按 12 收钱。本机实测：计算饱和负载下 12 线程与 6 线程吞吐相同，关掉 SMT 后核数减半而性能不动，授权费直接减半；访存密集负载则相反，关 SMT 等于扔掉近一半吞吐。这个决定现在可以按负载算出来了。

## 怎么用

数核的时候先问口径。`nproc`、top、K8s 的 `cpu: 1` 数的都是逻辑核；容量规划要按负载类型折算：计算密集除以 2 还要再打个折，访存密集可以按接近实核算。

延迟敏感的服务绑核要绑物理核，用 `thread_siblings_list` 查清谁和谁同住，把 sibling 留给别人或者干脆空着。绑了 cpu0 不绑走 cpu1，等于只锁了半间房。

判断 SMT 对自己负载的价值，最省事的办法就是本文的对照法：同一负载分别在「每物理核一线程」与「全逻辑核」两种铺法下量吞吐，差值就是你的负载给 SMT 的定价。

---

这篇给「逻辑核不是核」标了价：0.01 到 0.93 个物理核，取决于负载在等什么。等内存的空窗是 SMT 的货源，饱和的执行单元是它的天花板。下一篇把镜头拉远到核与核之间：本机是单 NUMA 节点，但「远近」的影子第一篇就量到过，同核 83 ms、同 CCX 102 ms、跨 CCX 126 ms。内存也分远近，那篇讲 NUMA。
