---
title: 数据也讲究落户：NUMA 与远近的价钱
description: 双路服务器上内存分本地与远端，远端访问交一辈子的税；本机单节点，但每个 CCX 独享的 L3 一样只认自己的住户。这篇用一条 3 MB 的环链量出数据搬家的价钱：原住地每步 9.9 纳秒，搬家那一遍 69 纳秒，差 7 倍。NUMA 的结构、观察命令与绑定策略一并讲清。硬件原理系列第五篇，实验实测于同一台 Ryzen 5 5500U。
pubDate: 2026-09-17
category: hardware
tags: [硬件, CPU, NUMA, 内存, 性能]
---

[第一篇](/posts/hardware-cache-line/)的伪共享矩阵量出过一组梯度：两个线程写同一条缓存行，钉在同一个物理核上 83 ms，同 CCX 跨核 102 ms，跨 CCX 126 ms。行在核之间跑得越远，价钱越高。这篇把镜头拉到最大的距离维度：数据落户在哪里，访问它的核住在哪里。

这套位置学问叫 NUMA（Non-Uniform Memory Access，非一致内存访问）：访问一段内存要多久，取决于发起访问的核与那段内存的相对位置。先把本机的底交代清楚：这台 Ryzen 是单节点机器，没有严格意义的「远端内存」；但每个 CCX 独享的 L3 同样只认自己的住户，远近的缩影照样量得出来。服务器的全貌用结构和命令讲，本机的部分用实测数字讲。

## 本机有多远

Linux 把 NUMA 拓扑挂在 `/sys/devices/system/node/` 下，一个节点一个目录：

```bash
ls /sys/devices/system/node/
cat /sys/devices/system/node/node0/cpulist
grep MemTotal /sys/devices/system/node/node0/meminfo
```

```text
has_cpu
has_generic_initiator
has_memory
has_normal_memory
node0
online
possible
power
uevent
0-11
Node 0 MemTotal:       15731472 kB
```

目录里只躺着一个 node0（其余是属性文件）：12 个逻辑核和全部 15 GB 内存同属一个节点，lscpu 里 `NUMA 节点：1` 说的就是这件事。单节点的原因是结构性的：这颗芯片的所有核经由同一套内存控制器访问内存，两边等远。

服务器就不是这样了。

## 服务器的远近

双路服务器的主板上装着两颗物理 CPU，每颗自带内存控制器，各自直连一半内存条。核访问自己这颗 CPU 直连的内存，叫本地访问；要读另一颗 CPU 名下的内存，数据得先走片间互联（Intel 叫 UPI，AMD 叫 Infinity Fabric），叫远端访问。内核把「一颗 CPU 加它直连的内存」划成一个 node，这就是 NUMA 节点的来历。

装了 numactl 的服务器上一条命令就能看全（下面是双路机器的示例输出，本机单节点给不出）：

```text
# numactl --hardware（示例）
available: 2 nodes (0-1)
node 0 cpus: 0-23
node 0 size: 65536 MB
node 1 cpus: 24-47
node 1 size: 65536 MB
node distances:
node   0   1
  0:  10  21
  1:  21  10
```

`node distances` 是一张相对距离表：10 是本地基准，21 表示跨节点一跳。它是固件报的相对数，不等于精确的延迟倍数，真倍数要在自己的机器上量。配套的命令还有：`dmidecode -t memory` 看每根内存条插在哪个槽、多大；`numastat` 看进程的内存落在哪些节点、有没有跨节点流量。

内存落户有一条默认规矩叫 first touch：页第一次被写时，落在当时执行的那个核所属的节点上。主线程串行初始化大数组，内存就全落主线程的节点，之后工作线程若跑在对面节点，人人交远端税。多线程并行初始化、或用 `numactl --membind` / `--cpunodebind` 显式指定，都能改写落户结果。内核还有 numa_balancing 机制会自动把页往访问它的节点搬，搬不搬得动、值不值得搬，就是下面这个实验要量化的事。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 312" role="img" aria-label="两种远近对照图：左半是双路服务器示意，两颗 CPU 各带内存控制器直连自己的内存条，中间片间互联，node0 的核读 node1 的内存要走互联交远端税，且稳态存在；右半是本机单芯片，两个 CCX 各 3 核共享一块 4 MB L3，内存控制器只有一套，内存等远，远近只存在于 L3 的私属关系上" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw5Arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-s" d="M0,0 L10,5 L0,10 z" fill="#6b675e"/></marker>
<marker id="hw5ArrC" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-c" d="M0,0 L10,5 L0,10 z" fill="#b03a2e"/></marker>
</defs>
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">双路服务器：内存分远近（示意）</text>
<rect class="bx-q" x="40" y="38" width="120" height="70" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="100" y="58" text-anchor="middle" font-size="9.5" fill="#2b2a26">CPU 0 · node0</text>
<text class="ts" x="100" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">核 0-23</text>
<text class="ts" x="100" y="94" text-anchor="middle" font-size="8.5" fill="#6b675e">内存控制器 IMC</text>
<rect class="bx-q" x="200" y="38" width="120" height="70" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="260" y="58" text-anchor="middle" font-size="9.5" fill="#2b2a26">CPU 1 · node1</text>
<text class="ts" x="260" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">核 24-47</text>
<text class="ts" x="260" y="94" text-anchor="middle" font-size="8.5" fill="#6b675e">内存控制器 IMC</text>
<line class="flk" x1="160" y1="73" x2="200" y2="73" stroke="#2b2a26" stroke-width="1.4" marker-start="url(#hw5Arr)" marker-end="url(#hw5Arr)"/>
<text class="ts" x="180" y="64" text-anchor="middle" font-size="8" fill="#6b675e">UPI / IF</text>
<rect class="bx" x="40" y="140" width="120" height="44" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="100" y="158" text-anchor="middle" font-size="9" fill="#2b2a26">内存 A（node0）</text>
<text class="ts" x="100" y="174" text-anchor="middle" font-size="8.5" fill="#6b675e">CPU0 直连</text>
<rect class="bx" x="200" y="140" width="120" height="44" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="260" y="158" text-anchor="middle" font-size="9" fill="#2b2a26">内存 B（node1）</text>
<text class="ts" x="260" y="174" text-anchor="middle" font-size="8.5" fill="#6b675e">CPU1 直连</text>
<line class="fl" x1="100" y1="108" x2="100" y2="136" stroke="#6b675e" stroke-width="1.2" marker-end="url(#hw5Arr)"/>
<line class="fl" x1="260" y1="108" x2="260" y2="136" stroke="#6b675e" stroke-width="1.2" marker-end="url(#hw5Arr)"/>
<path class="flc" d="M 140 108 C 170 128, 220 128, 250 140" fill="none" stroke="#b03a2e" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#hw5ArrC)"/>
<text class="tc" x="40" y="206" font-size="9" fill="#b03a2e">node0 的核读内存 B：走片间互联，远端税</text>
<text class="ts" x="40" y="224" font-size="9" fill="#6b675e">只要数据不搬家，这笔税一直交（稳态）</text>
<text class="t" x="370" y="24" font-size="12" fill="#2b2a26">本机：单节点，内存等远</text>
<rect class="bx-q" x="380" y="38" width="250" height="146" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx" x="392" y="52" width="106" height="52" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="445" y="72" text-anchor="middle" font-size="9" fill="#2b2a26">CCX0 · 3 核</text>
<text class="ts" x="445" y="90" text-anchor="middle" font-size="8.5" fill="#6b675e">L3 4M（cpu0-5）</text>
<rect class="bx" x="512" y="52" width="106" height="52" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="565" y="72" text-anchor="middle" font-size="9" fill="#2b2a26">CCX1 · 3 核</text>
<text class="ts" x="565" y="90" text-anchor="middle" font-size="8.5" fill="#6b675e">L3 4M（cpu6-11）</text>
<text class="ts" x="505" y="128" text-anchor="middle" font-size="9" fill="#2b2a26">一套内存控制器</text>
<text class="ts" x="505" y="148" text-anchor="middle" font-size="8.5" fill="#6b675e">node0 = 全部 12 核 + 15 GB</text>
<text class="ts" x="505" y="172" text-anchor="middle" font-size="8.5" fill="#6b675e">L3 互不共享，数据住哪边哪边快</text>
<rect class="bx" x="392" y="200" width="226" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="505" y="224" text-anchor="middle" font-size="9" fill="#2b2a26">内存 15 GB（到两个 CCX 等远）</text>
<line class="fl" x1="505" y1="184" x2="505" y2="196" stroke="#6b675e" stroke-width="1.2" marker-end="url(#hw5Arr)"/>
<text class="tc" x="380" y="262" font-size="9" fill="#b03a2e">远近只有一层：L3 私属，换 CCX 时搬家税一次付清</text>
<text class="ts" x="30" y="294" font-size="9.5" fill="#6b675e">左边是结构示意（非本机实测）；右边与第一篇 sysfs 读出的 shared_cpu_list 一致。服务器的远端税是稳态的，见左下注。</text>
</svg>
</figure>

## 本机实测：搬家的价钱

单节点机器量不出稳态的远端内存，但量得出搬家。本机的 L3 是 CCX 私产（第一篇的 sysfs 里写得明白：`shared_cpu_list` 一边是 0-5，一边是 6-11），一份数据只要装得进 4 MB 的 L3，它住哪边，哪边的核读它就快。

实验用一条 3 MiB 的随机环链：装得进一个 CCX 的 L3，又装不进 512 KiB 的 L2，每次访问的去向非 L3 即内存，位置效应被放到最大。流程是先在原住 CCX 的核上把数据追热，量出稳态；然后立刻把线程改钉到对面 CCX 的核上追一遍，量搬家那一遍；再在对面追几遍，量入住后的新稳态。5 轮，奇偶轮交换搬家方向：

```c
pin(cpu2);                        /* CCX0 */
for (int i = 0; i < 6; i++) t[i] = lap();   /* 前 3 遍预热，后 3 遍计时 */
pin(cpu8);                        /* 改钉 CCX1，数据不动，人动 */
cold = lap();                     /* 搬家冷遍 */
for (int i = 0; i < 4; i++) u[i] = lap();   /* 入住后的新稳态 */
```

```text
3 MiB 环链（49152 节点），5 轮方向交替，各取中位
原住 CCX 稳态 :  9.86 ns/访问 (min=9.62 max=11.86)
搬家冷遍      : 69.14 ns/访问 (min=47.11 max=82.27)  = 稳态的 7.0 倍
新 CCX 稳态   : 10.21 ns/访问 (min=9.89 max=53.22)
```

三个数各就各位。原住稳态 9.86 ns，正是[第二篇](/posts/hardware-memory-mountain/)内存山的 L3 台阶（1M 档 8.09、2M 档 9.03，3 MiB 读到 9.9 合情合理）。搬家冷遍 69.14 ns，7 倍价钱：对面的 L3 里一行都没有，每次访问都得下内存；同时那个核的 TLB 对这条链也全生，[第三篇](/posts/hardware-tlb-page-walk/)量过的页表行走一并计入，这个数字是两项之和，本文没再往下拆。新稳态 10.21 ns：数据随着访问重新入住对面的 L3，价钱应声回落。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="L3 搬家成本条形图：原住 CCX 稳态 9.86 纳秒每次访问，搬家冷遍 69.14 纳秒是稳态的 7 倍，朱砂色标出，新 CCX 稳态 10.21 纳秒回落到原价；底部注明另一遍运行原住稳态中位被 L3 同住进程踩到 40.6 但 min 仍是 9.85，共享 L3 的基线读数 min 比中位可信" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">同一份 3 MiB 数据，三种时刻的价钱（ns/访问）</text>
<text class="ts" x="180" y="62" text-anchor="end" font-size="9.5" fill="#6b675e">原住 CCX 稳态</text>
<rect class="bar" x="190" y="48" width="59" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="255" y="62" font-size="9.5" fill="#6b675e">9.86（L3 命中，对上篇台阶）</text>
<text class="ts" x="180" y="100" text-anchor="end" font-size="9.5" fill="#b03a2e">搬家冷遍</text>
<rect class="bx-sick" x="190" y="86" width="415" height="20" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="tc" x="611" y="100" text-anchor="end" font-size="9.5" fill="#b03a2e">69.14 = 7.0 倍</text>
<text class="ts" x="180" y="138" text-anchor="end" font-size="9.5" fill="#6b675e">新 CCX 稳态</text>
<rect class="bar" x="190" y="124" width="61" height="20" rx="1" fill="#2b2a26"/>
<text class="ts" x="257" y="138" font-size="9.5" fill="#6b675e">10.21（数据重新入住，回落）</text>
<text class="ts" x="190" y="172" font-size="9.5" fill="#6b675e">冷遍 = 对面 L3 全冷 + 该核 TLB 全冷，两项合计</text>
<text class="ts" x="190" y="196" font-size="9.5" fill="#6b675e">另一遍运行原住稳态中位被踩到 40.6（min 仍 9.85）：共享 L3 的基线，min 比中位可信</text>
</svg>
</figure>

那遍被踩的读数值得多说一句。完整程序跑过两遍，第二遍的原住稳态中位是 40.60 ns，min 却仍是 9.85：轮次进行中有别的进程借住了 L3，把多数轮的中位顶了上去，只有最干净的一轮留下了真实价钱。基线被污染时，连「7 倍」都会缩水成假的「1.5 倍」，因为分母脏了。共享 L3 上的读数纪律，第一篇说过中位与 min 的分工，这次连本带利又验证了一遍。

## 距离阶梯

到这里，本机量过的距离可以排成一张阶梯表：

| 层级 | 共享的资产 | 实测参照 |
| --- | --- | --- |
| 同物理核（SMT 兄弟） | 执行单元、L1、L2 | 伪共享同行 83 ms（[第一篇](/posts/hardware-cache-line/)）；访存负载第二线程白捡 85~93%（[第四篇](/posts/hardware-hyperthreading/)） |
| 同 CCX 跨核 | L3 | 伪共享同行 102 ms；数据在自家 L3 时 9.9 ns/步 |
| 跨 CCX | 无（L3 互不私通） | 伪共享同行 126 ms；数据搬家一遍 69 ns/步 |
| 跨 socket（服务器） | 无，且内存本身分边 | 本机量不出；稳态远端税不随搬家消失，用 numactl 在自己的机器上量 |

前三层是本机实测，最后一层是结构推断：单芯片上搬家税一次付清，因为内存对两边等远；双路服务器上数据就算搬了家，落在对面节点的页仍要一辈子走片间互联，除非内核的 numa_balancing 或你自己把它挪回来。这也是为什么服务器上的 NUMA 绑定值得专门做，而本机这样的单节点桌面，绑核只需要关心 L3 这一层。

## 怎么用

拿到一台服务器，先跑 `numactl --hardware` 看节点数和距离矩阵，再用 `numastat -p <pid>` 看目标进程的内存实际落在哪。发现大面积跨节点，两条路：把线程绑过去（`--cpunodebind`），或把内存绑过来（`--membind`），延迟敏感的服务通常两个都绑。

初始化顺序决定落户。first touch 规则下，主线程串行 memset 大数组，内存全落主线程的节点；改成工作线程各初始化各的分段，内存天然就地落户。这条在写代码时就要想，事后靠 numa_balancing 自动搬页，搬动本身也是成本。

单节点机器也别觉得这篇与己无关。L3 的私属脾气一样存在：绑核跑延迟敏感任务时，把线程和数据留在同一个 CCX，搬家税能省则省；而任何共享 L3 上的基准测试，min 与中位要分开看。

---

这篇的三个读数都属于同一份 3 MiB 的数据：在老家每步 9.9 ns，被迫搬家那一遍 69 ns，住定之后又回到 10.2 ns。服务器的内存落户同理，只是税更重、且按月征收。下一篇钻进内存条内部：第一篇的跨步实验里，行越稀疏每行越贵，那个坡是内存自己的顺序偏好。Rank、Bank、电容矩阵，CL、tRCD、tRP 各在什么时候付钱，一篇讲清。
