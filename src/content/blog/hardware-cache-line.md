---
title: 只要 4 个字节，送来 64 个：缓存金字塔与 Cache Line
description: CPU 向内存要一个 int，缓存搬回来的永远是一整行 64 字节。对齐的价钱、伪共享的来历、连续布局的顺风车，都出自这一行。硬件原理系列第一篇，实验全部实测于一台 Ryzen 5 5500U。
pubDate: 2026-09-15
category: hardware
tags: [硬件, CPU, 缓存, 性能]
---

[《Zig 的原子操作与内存顺序》](/posts/zig-atomic-ordering/)那篇留过一个没结的案：false sharing 会让无关的原子变量彼此拖累，但「具体收益仍需测量」。这篇把它测掉。它同时是一个新系列的开篇。前面六个系列写内核、数据库、消息队列、语言运行时，全是软件层，其中不少结论踩在同一批硬件事实上：连续布局为什么快，多线程的计数器为什么要隔开。这个系列把那些事实一件件搬到自己的机器上量一遍。

第一件事实是一个容易被略过的数字：64。缓存向下一层取数据时，取回的是整整 64 字节的一行，哪怕你只要其中 4 个字节。

## 本机的金字塔

缓存是 CPU 与内存之间的暂存层。访问一个地址时先查缓存，查到叫命中，查不到叫 miss，要往下一层去取，取的时候一次搬一整块。层级越靠上，越小、越快、离核越近。写任何关于缓存的结论之前，先勘探自己这台机器的金字塔长什么样，内核把每层缓存的档案挂在 `/sys/devices/system/cpu/cpu0/cache/` 下：

```bash
cd /sys/devices/system/cpu/cpu0/cache
for i in 0 1 2 3; do
  echo "index$i: $(cat index$i/level) $(cat index$i/type) $(cat index$i/size) shared=$(cat index$i/shared_cpu_list) line=$(cat index$i/coherency_line_size)"
done
```

```text
index0: 1 Data 32K shared=0-1 line=64
index1: 1 Instruction 32K shared=0-1 line=64
index2: 2 Unified 512K shared=0-1 line=64
index3: 3 Unified 4096K shared=0-5 line=64
```

C 程序不借助 shell 也能问到同一批数字：

```c
#include <unistd.h>
sysconf(_SC_LEVEL1_DCACHE_SIZE);      // 32768
sysconf(_SC_LEVEL2_CACHE_SIZE);       // 524288
sysconf(_SC_LEVEL3_CACHE_SIZE);       // 4194304
sysconf(_SC_LEVEL1_DCACHE_LINESIZE);  // 64
```

本机是一颗 Ryzen 5 5500U，Zen 2 架构，6 个物理核、12 个逻辑核。逐条解读这些输出。L1 分数据与指令各 32 KiB，每物理核一份；L2 统一缓存 512 KiB，也是每物理核一份；L3 一块 4 MiB。`shared=0-1` 说明 cpu0 与 cpu1 共用这些缓存，它们是同一个物理核上的两个超线程：一颗物理核对外呈现成两个逻辑核，共享核内的执行单元与缓存，这个系列后面会专门拆它。再去问 cpu6 的 index3，`shared_cpu_list` 变成 6-11：本机 6 个核分成两组，Zen 2 把几个物理核和一块共享 L3 打包成一个 CCX（Core Complex），这台机器有两个 CCX，各 3 个核共享一块 4 MiB 的 L3，两个 CCX 之间不共享。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 362" role="img" aria-label="本机缓存金字塔与拓扑：L1 数据与指令各 32 KiB 每物理核，L2 512 KiB 每物理核，L3 两块各 4 MiB，内存 16 GB；下方 6 个物理核分成两个 CCX，cpu0 到 cpu5 共享一块 L3，cpu6 到 cpu11 共享另一块，每个物理核的两个超线程共享 L1 与 L2，两个 CCX 之间走片内互联；每一层的缓存行都是 64 字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw1Arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-s" d="M0,0 L10,5 L0,10 z" fill="#6b675e"/></marker>
</defs>
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">本机金字塔：Ryzen 5 5500U（Zen 2，6 核 12 线程）</text>
<rect class="bx-q" x="120" y="38" width="140" height="36" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="190" y="61" text-anchor="middle" font-size="11" fill="#2b2a26">L1d + L1i</text>
<rect class="bx" x="95" y="82" width="190" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="190" y="105" text-anchor="middle" font-size="11" fill="#2b2a26">L2</text>
<rect class="bx" x="70" y="126" width="240" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="190" y="149" text-anchor="middle" font-size="11" fill="#2b2a26">L3 × 2</text>
<rect class="bx" x="45" y="170" width="290" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.3"/>
<text class="t" x="190" y="193" text-anchor="middle" font-size="11" fill="#2b2a26">内存</text>
<text class="ts" x="350" y="60" font-size="10" fill="#6b675e">32 KiB 数据 + 32 KiB 指令，每物理核一份</text>
<text class="ts" x="350" y="104" font-size="10" fill="#6b675e">512 KiB，每物理核一份</text>
<text class="ts" x="350" y="148" font-size="10" fill="#6b675e">每块 4 MiB，3 个核共享</text>
<text class="ts" x="350" y="192" font-size="10" fill="#6b675e">16 GB，本机单 NUMA 节点</text>
<line class="fl" x1="28" y1="206" x2="28" y2="44" stroke="#6b675e" stroke-width="1.2" marker-end="url(#hw1Arr)"/>
<text class="ts" x="20" y="125" text-anchor="middle" font-size="9.5" fill="#6b675e" transform="rotate(-90 20 125)">小而快，miss 就往下穿透</text>
<text class="t" x="30" y="238" font-size="12" fill="#2b2a26">共享关系：shared_cpu_list 的解读</text>
<rect class="bx-q" x="40" y="250" width="250" height="90" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="50" y="268" font-size="9.5" fill="#6b675e">CCX0 · L3 4 MiB（cpu0-5 共享）</text>
<rect class="bx" x="50" y="278" width="72" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="86" y="293" text-anchor="middle" font-size="9" fill="#2b2a26">核 0</text>
<text class="ts" x="86" y="306" text-anchor="middle" font-size="9" fill="#6b675e">cpu0+1</text>
<rect class="bx" x="130" y="278" width="72" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="166" y="293" text-anchor="middle" font-size="9" fill="#2b2a26">核 1</text>
<text class="ts" x="166" y="306" text-anchor="middle" font-size="9" fill="#6b675e">cpu2+3</text>
<rect class="bx" x="210" y="278" width="72" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="246" y="293" text-anchor="middle" font-size="9" fill="#2b2a26">核 2</text>
<text class="ts" x="246" y="306" text-anchor="middle" font-size="9" fill="#6b675e">cpu4+5</text>
<rect class="bx-q" x="370" y="250" width="250" height="90" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="ts" x="380" y="268" font-size="9.5" fill="#6b675e">CCX1 · L3 4 MiB（cpu6-11 共享）</text>
<rect class="bx" x="380" y="278" width="72" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="416" y="293" text-anchor="middle" font-size="9" fill="#2b2a26">核 3</text>
<text class="ts" x="416" y="306" text-anchor="middle" font-size="9" fill="#6b675e">cpu6+7</text>
<rect class="bx" x="460" y="278" width="72" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="496" y="293" text-anchor="middle" font-size="9" fill="#2b2a26">核 4</text>
<text class="ts" x="496" y="306" text-anchor="middle" font-size="9" fill="#6b675e">cpu8+9</text>
<rect class="bx" x="540" y="278" width="72" height="36" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="576" y="293" text-anchor="middle" font-size="9" fill="#2b2a26">核 5</text>
<text class="ts" x="576" y="306" text-anchor="middle" font-size="9" fill="#6b675e">cpu10+11</text>
<line class="fl" x1="294" y1="295" x2="366" y2="295" stroke="#6b675e" stroke-width="1.2" marker-start="url(#hw1Arr)" marker-end="url(#hw1Arr)"/>
<text class="ts" x="330" y="286" text-anchor="middle" font-size="9" fill="#6b675e">片内互联</text>
<text class="ts" x="40" y="358" font-size="9.5" fill="#6b675e">超线程兄弟共享一个物理核的 L1 与 L2；coherency_line_size 每一层都是 64 字节</text>
</svg>
</figure>

档案里最重要的数字是最后那个：`coherency_line_size = 64`。金字塔的每一层搬运数据都以 64 字节为单位，这个单位叫缓存行，Cache Line。本文剩下的部分都是这一行带来的后果。

## 搬运按行计价

「一次搬一整块」的直觉容易接受，也容易不信服：我只读一个 int，硬件真会多搬 60 个字节？真的会。缓存与内存之间的交换接口按行设计，地址只用来定位是哪一行，行到了以后，里面的字节哪个有用由 CPU 自己挑。多搬的 60 个字节也不算白搬，下一次访问若落在附近，直接命中，不用再下去。

搭车的便宜在前面系列里到处都是。Redis 的 listpack 把小条目紧凑地排在一起，一次缓存行加载带出一串相邻条目（[《Redis 的对象编码与转换》](/posts/redis-object-encoding/)）；CPython 的 set 做开放寻址时先来一轮九连探，9 个相邻槽位大概率坐在一两条行里，一次搬运喂饱九次探测（[《CPython 的 set 与开放寻址》](/posts/cpython-set-open-addressing/)）。

便宜只是一面，另一面是在本机验证「按行计价」本身。开一个 32 MiB 的缓冲，远超本机 8 MiB 的 L3 总量，扫描必然穿透到内存。用不同跨步走完整块缓冲，把摸到的值加起来：

```c
#define SIZE (32ul << 20)
uint8_t *buf = malloc(SIZE);
size_t strides[] = {8, 16, 64, 128, 512, 4096};
/* 轮次交错：同一轮把六种跨步各跑一遍，9 轮后取各自的中位数，
   避免调频漂移单独落在某一种跨步头上 */
for (int r = 0; r < ROUNDS; r++)
    for (int s = 0; s < ns; s++) {
        double t0 = now();
        uint64_t sum = 0;
        for (size_t i = 0; i < SIZE; i += strides[s]) sum += buf[i];
        res[s][r] = now() - t0;
    }
```

```text
buffer = 32 MiB（本机 L3 = 2 x 4 MiB，数据驻留内存），9 轮交错取中位
stride=   8B  load 次数= 4194304  摸到的行=  524288  中位=   2.87 ms (min=2.08 max=3.91)  每行=   5.5 ns
stride=  16B  load 次数= 2097152  摸到的行=  524288  中位=   2.19 ms (min=1.72 max=3.09)  每行=   4.2 ns
stride=  64B  load 次数=  524288  摸到的行=  524288  中位=   1.72 ms (min=1.67 max=2.33)  每行=   3.3 ns
stride= 128B  load 次数=  262144  摸到的行=  262144  中位=   1.25 ms (min=1.20 max=2.22)  每行=   4.8 ns
stride= 512B  load 次数=   65536  摸到的行=   65536  中位=   0.34 ms (min=0.25 max=0.58)  每行=   5.2 ns
stride=4096B  load 次数=    8192  摸到的行=    8192  中位=   0.05 ms (min=0.04 max=0.07)  每行=   6.2 ns
```

前三行是关键对照。stride=8 发出 419 万次 load，stride=64 只发 52 万次，指令数差 8 倍，中位耗时只差 1.67 倍（2.87 对 1.72 ms），因为两者摸到的行一样多，都是 524288 条。搬运的时间按行数付费，不按字节数；stride=8 多出来的部分，大多花在执行那 367 万次多余的 load 指令上。

stride=128 摸到的行少了一半，时间只降 27%。跳过的行多半也被硬件预取器提前搬了上来：它认得出固定的跨步，猜你会顺着走下去。跨步拉大到 512，预取器跟不上，时间掉到 0.34 ms，行数与耗时重新对上。

「每行」那一列还有个反向的信息：跨步越大，单行越贵，3.3 ns 涨到 6.2 ns。行来得密集时，预取跟得上，内存那边的行缓冲也常命中；行稀疏下来，两个便宜都占不到。这条线往后会碰到内存自己的顺序偏好，这个系列讲到内存硬件时再量。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 290" role="img" aria-label="行搬运示意：CPU 要 4 个字节，一次 miss 从下一层搬上来整条 64 字节的行，目标 4 字节高亮，其余 60 字节顺路同行；下方是三档跨步扫描的条形对比，stride 8 为 2.87 毫秒、419 万次 load，stride 16 为 2.19 毫秒、210 万次，stride 64 为 1.72 毫秒、52 万次，三者摸到的行同为 524288 条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw2Arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-i" d="M0,0 L10,5 L0,10 z" fill="#2b2a26"/></marker>
</defs>
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">一次 miss，搬上来一整行</text>
<rect class="bx-q" x="40" y="36" width="150" height="32" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="t" x="115" y="57" text-anchor="middle" font-size="10.5" fill="#2b2a26">CPU 要 4 个字节</text>
<text class="ts" x="210" y="57" font-size="10" fill="#6b675e">miss 发生，缓存向下一层取数</text>
<line class="flk" x1="115" y1="68" x2="115" y2="94" stroke="#2b2a26" stroke-width="1.3" marker-end="url(#hw2Arr)"/>
<rect class="bx" x="60" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="94" y="98" width="34" height="34" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx" x="128" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="162" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="196" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="230" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="264" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="298" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="332" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="366" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="400" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="434" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="468" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="502" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="536" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="570" y="98" width="34" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="60" y="146" font-size="9" fill="#6b675e">字节 0</text>
<text class="ts" x="604" y="146" text-anchor="end" font-size="9" fill="#6b675e">字节 63</text>
<text class="tc" x="60" y="168" font-size="10.5" fill="#b03a2e">取 4 个字节，搬 64 个：高亮的是要的，其余 60 个顺路同行</text>
<text class="t" x="30" y="200" font-size="11" fill="#2b2a26">32 MiB 扫描：行数相同，load 次数差 8 倍</text>
<text class="ts" x="30" y="221" font-size="9.5" fill="#6b675e">stride=8 · 419 万次 load</text>
<rect class="bar" x="200" y="208" width="158" height="16" rx="1" fill="#2b2a26"/>
<text class="ts" x="364" y="221" font-size="9.5" fill="#6b675e">2.87 ms</text>
<text class="ts" x="30" y="243" font-size="9.5" fill="#6b675e">stride=16 · 210 万次</text>
<rect class="bar" x="200" y="230" width="120" height="16" rx="1" fill="#2b2a26"/>
<text class="ts" x="326" y="243" font-size="9.5" fill="#6b675e">2.19 ms</text>
<text class="ts" x="30" y="265" font-size="9.5" fill="#6b675e">stride=64 · 52 万次</text>
<rect class="bar" x="200" y="252" width="95" height="16" rx="1" fill="#2b2a26"/>
<text class="ts" x="301" y="265" font-size="9.5" fill="#6b675e">1.72 ms</text>
<text class="ts" x="30" y="284" font-size="9.5" fill="#6b675e">三档都摸到 524288 行：搬运耗时打底相同，差额是执行 load 指令的时间</text>
</svg>
</figure>

## 跨行，拆成两半

行还决定地址该坐在哪里。一次 8 字节读若完整落在一条行内，一次访问搞定；若恰好骑在行边界上，就要拆成两次。这是对齐这件事的硬件来源。[《Zig 的内存布局》](/posts/zig-memory-layout/)讲过 padding 如何让字段落在能被 4 或 8 整除的地址上，那是 ABI 的尺子；64 是缓存的尺子，两把尺子各管各的。

跨行读贵多少？第一把尺子没能量出来。在 256 KiB 的缓冲（驻留本核 L2）里每行读一个 uint64，偏移 0 是对齐的，偏移 60 时这 8 个字节横跨 63 与 64 的边界：

```c
for (size_t i = 0; i < n; i++) {
    uint64_t v;
    memcpy(&v, buf + i * 64 + off, sizeof v);  /* off = 0 或 60 */
    sink += v;
}
```

```text
L2 驻留（256 KiB，2000 遍/轮）
  轮1：对齐 off=0 0.25   跨行 off=60 0.25   差 -0.00
  轮2：对齐 off=0 0.27   跨行 off=60 0.25   差 -0.02
  轮3：对齐 off=0 0.25   跨行 off=60 0.27   差 +0.02
内存驻留（32 MiB，4 遍/轮）
  轮1：对齐 off=0 1.85   跨行 off=60 1.99   差 +0.15
  轮2：对齐 off=0 1.77   跨行 off=60 1.88   差 +0.11
  轮3：对齐 off=0 1.91   跨行 off=60 1.86   差 -0.04
```

差值约等于零，内存尺度上也埋在噪声里。原因不玄：这些 load 互相不依赖，流水线并行发射，单条的拆行开销被重叠遮住了，整体卡在带宽上。

换一把尺子，让读与读互相依赖：每次读的地址就藏在上一次读回的值里，流水线没法超前，只能一步一等。4096 条行连成随机环链，预取器也无从跟踪：

```c
uint64_t idx = off;
for (long i = 0; i < STEPS; i++) {
    uint64_t v;
    memcpy(&v, buf + idx, sizeof v);
    idx = v;              /* 下一站的地址在这次读回的值里 */
}
```

```text
随机环链 4096 行，每次读依赖上次结果，20000000 步/轮
轮1：对齐 off=0  3.40 ns/读   跨行 off=60 4.11 ns/读   差 +0.70 ns（+21%）
轮2：对齐 off=0  3.39 ns/读   跨行 off=60 4.11 ns/读   差 +0.72 ns（+21%）
轮3：对齐 off=0  3.41 ns/读   跨行 off=60 4.13 ns/读   差 +0.73 ns（+21%）
```

现形了：跨行比对齐贵 21%，每次 0.7 纳秒，三轮几乎不抖。同一个事实，一把尺子下看不见，另一把尺子下干干净净。Kafka 收官篇[《别信第一份读数》](/posts/kafka-latency-measurement/)聊过量具本身如何塑造读数，硬件层也不例外。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 258" role="img" aria-label="对齐读与跨行读的字节格对照：上半幅 8 字节块占字节 48 到 55，完整落在行边界 63 与 64 的左侧，一次访问，实测 3.40 纳秒；下半幅 8 字节块占字节 60 到 67，骑在行边界上，拆成两次访问，实测 4.11 纳秒，贵 21%；两幅用的是同一段字节与同一种读法" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="26" font-size="11" fill="#2b2a26">对齐读：8 字节完整落在一行内</text>
<rect class="bx" x="90" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="150" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="210" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="270" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="330" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="390" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="450" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="510" y="38" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect x="90" y="38" width="120" height="38" rx="1" fill="#f6f3ec" stroke="#b03a2e" stroke-width="2.4"/>
<line class="flk" x1="330" y1="30" x2="330" y2="84" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="120" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">48-51</text>
<text class="ts" x="180" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">52-55</text>
<text class="ts" x="240" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">56-59</text>
<text class="ts" x="300" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">60-63</text>
<text class="ts" x="360" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">64-67</text>
<text class="ts" x="420" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">68-71</text>
<text class="ts" x="480" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">72-75</text>
<text class="ts" x="540" y="92" text-anchor="middle" font-size="8.5" fill="#6b675e">76-79</text>
<text class="ts" x="330" y="108" text-anchor="middle" font-size="9" fill="#6b675e">行边界 63|64</text>
<text class="tc" x="150" y="126" text-anchor="middle" font-size="9.5" fill="#b03a2e">读 48-55：一次访问 · 3.40 ns</text>
<text class="t" x="30" y="156" font-size="11" fill="#2b2a26">跨行读：8 字节骑在行边界上</text>
<rect class="bx" x="90" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="150" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="210" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="270" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="330" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="390" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="450" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="510" y="168" width="60" height="38" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="270" y="168" width="120" height="38" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="2.4"/>
<line class="flk" x1="330" y1="160" x2="330" y2="214" stroke="#2b2a26" stroke-width="2"/>
<text class="ts" x="120" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">48-51</text>
<text class="ts" x="180" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">52-55</text>
<text class="ts" x="240" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">56-59</text>
<text class="ts" x="300" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">60-63</text>
<text class="ts" x="360" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">64-67</text>
<text class="ts" x="420" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">68-71</text>
<text class="ts" x="480" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">72-75</text>
<text class="ts" x="540" y="228" text-anchor="middle" font-size="8.5" fill="#6b675e">76-79</text>
<text class="tc" x="330" y="248" text-anchor="middle" font-size="9.5" fill="#b03a2e">读 60-67：拆成两次访问 · 4.11 ns（+21%，依赖读实测）</text>
</svg>
</figure>

说句公道话，0.7 纳秒并不可怕。普通顺序访问的代码很少需要操心一个 8 字节变量是否跨行，真正在意的是指针追逐、链表遍历这类把读延迟摆在关键路径上的代码。对齐的大头收益在别处，接着看。

## 伪共享：无关的变量互相拖慢

64 字节一个单位还有第三个后果，也是最不直观的一个：行是缓存一致性的单位。多核各自持有缓存，硬件协议保证同一个地址在所有核看来一致；一个核要写某行里的一个字节，必须先独占整行，其他核缓存里的同一行随之作废。作废的粒度是整行，协议不知道你只写了哪几个字节。

由此推出一个场景。两个线程各自给自己的计数器加一，两个变量在数据上毫无交集，但它们坐在同一条行里，相距 8 字节。线程 A 每写一次，这行在核 B 的缓存里作废；B 下一次加一，要把行搬回来；搬回来 A 又要写，再作废。行在两个核之间往返，两个计数器却谁也没碰谁。这就是伪共享，false sharing。

在本机把 Zig 原子操作篇那句「仍需测量」测掉，顺带把拓扑也量进去。两个线程各自增 2000 万次，线程落位三种，按本机的共享关系挑：cpu0 与 cpu1 是同一物理核的两个超线程，共享 L1、L2；cpu0 与 cpu2 同 CCX 跨核，共享 L3；cpu0 与 cpu6 跨 CCX，L3 也不共享。槽位两种排法：相距 8 字节是同行，相距 64 字节是分行。用 `pthread_setaffinity_np` 钉核：

```c
static uint64_t line[16] __attribute__((aligned(64)));
/* 同行：slotA = &line[0]，slotB = &line[1]   相距 8 字节
   分行：slotA = &line[0]，slotB = &line[8]  相距 64 字节 */

static void *worker(void *a) {
    Arg *arg = a;
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(arg->cpu, &set);
    pthread_setaffinity_np(pthread_self(), sizeof set, &set);
    for (long i = 0; i < N; i++) (*arg->p)++;   /* volatile，防进寄存器 */
    return NULL;
}
```

六个配置轮次交错，每配置 5 轮取中位；整个程序完整跑了两遍，同行的读数两遍分毫不差：

```text
每线程 20000000 次自增，5 轮交错，每配置取中位
同行  同物理核 cpu0+cpu1（SMT 兄弟，共享 L1/L2）  中位=   83 ms (min=82 max=84)
同行  同 CCX 跨核 cpu0+cpu2（共享 L3）          中位=  102 ms (min=100 max=103)
同行  跨 CCX     cpu0+cpu6（L3 也不共享）      中位=  126 ms (min=123 max=126)
分行  同物理核 cpu0+cpu1（SMT 兄弟，共享 L1/L2）  中位=   10 ms (min=10 max=36)
分行  同 CCX 跨核 cpu0+cpu2（共享 L3）          中位=    9 ms (min=5 max=28)
分行  跨 CCX     cpu0+cpu6（L3 也不共享）      中位=   16 ms (min=6 max=36)
计数核对：line[0]=600000000（期望 600000000）  line[1]=300000000（期望 300000000）  line[8]=300000000（期望 300000000）
```

有三件事值得记。

其一是同行的代价。分行时三种落位都在 6 到 16 ms 之间；同行时是 83、102、126 ms，最少慢 8 倍。折算到单次自增，分行约 0.3 纳秒一次，是 L1 就地读写的速度；同行超过 6 纳秒，差额全花在等行上路。

其二是行的路程梯度。同行的三种落位 83、102、126 ms 单调递增。SMT 兄弟共用一份 L1，行根本不出核，慢是因为两个线程对同一行的读写仍要在核内排队；同 CCX 跨核，行经由 L3 往返；跨 CCX 连 L3 都不共享，行要横穿片内互联。行跑多远，时间加多少，每一档都有实测值。

其三是数字不会错，只是慢。跑完核对三个槽位的计数，6 亿、3 亿、3 亿，与推演逐项相符。伪共享不破坏结果，它让行白跑。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 336" role="img" aria-label="伪共享对照图：上半幅两个核的 L1 之间画着同一条 64 字节行，槽 A 与槽 B 相距 8 字节同在一行，朱砂双向箭头表示行在两核之间往返，每次写都把行从对方缓存里作废；下半幅两个核各持一条行，槽 A 与槽 B 分居两行，没有一致性流量；底部是实测数字，同行三种落位 83、102、126 毫秒，分行 10、9、16 毫秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw4ArrC" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-c" d="M0,0 L10,5 L0,10 z" fill="#b03a2e"/></marker>
</defs>
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">同一行：槽位相距 8 字节</text>
<rect class="bx" x="40" y="38" width="150" height="80" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="115" y="56" text-anchor="middle" font-size="10" fill="#2b2a26">核 0 的 L1</text>
<rect class="bx-sick" x="55" y="66" width="30" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="70" y="86" text-anchor="middle" font-size="10" fill="#b03a2e">A</text>
<rect class="bx-q" x="85" y="66" width="90" height="30" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="130" y="86" text-anchor="middle" font-size="8.5" fill="#6b675e">其余 56 字节</text>
<rect class="bx" x="470" y="38" width="150" height="80" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="545" y="56" text-anchor="middle" font-size="10" fill="#2b2a26">核 2 的 L1</text>
<rect class="bx-q" x="485" y="66" width="90" height="30" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="530" y="86" text-anchor="middle" font-size="8.5" fill="#6b675e">其余 56 字节</text>
<rect class="bx-sick" x="575" y="66" width="30" height="30" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="590" y="86" text-anchor="middle" font-size="10" fill="#b03a2e">B</text>
<text class="ts" x="329" y="50" text-anchor="middle" font-size="9.5" fill="#6b675e">同一条 64B 行</text>
<rect class="bx-sick" x="225" y="58" width="26" height="34" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="t" x="238" y="80" text-anchor="middle" font-size="10" fill="#b03a2e">A</text>
<rect class="bx-sick" x="251" y="58" width="26" height="34" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="t" x="264" y="80" text-anchor="middle" font-size="10" fill="#b03a2e">B</text>
<rect class="bx" x="277" y="58" width="26" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="303" y="58" width="26" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="329" y="58" width="26" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="355" y="58" width="26" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="381" y="58" width="26" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="407" y="58" width="26" height="34" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<line class="flc" x1="192" y1="75" x2="221" y2="75" stroke="#b03a2e" stroke-width="1.4" marker-start="url(#hw4ArrC)" marker-end="url(#hw4ArrC)"/>
<line class="flc" x1="437" y1="75" x2="466" y2="75" stroke="#b03a2e" stroke-width="1.4" marker-start="url(#hw4ArrC)" marker-end="url(#hw4ArrC)"/>
<text class="ts" x="330" y="118" text-anchor="middle" font-size="10" fill="#6b675e">每次写都先把行从对方缓存里作废，再把行搬回来</text>
<text class="tc" x="330" y="136" text-anchor="middle" font-size="10.5" fill="#b03a2e">两个计数器从未共享数据，却互相拖慢</text>
<text class="t" x="30" y="172" font-size="12" fill="#2b2a26">分行：槽位相距 64 字节</text>
<rect class="bx" x="40" y="186" width="150" height="80" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="115" y="204" text-anchor="middle" font-size="10" fill="#2b2a26">核 0 的 L1</text>
<rect class="bx-q" x="55" y="214" width="30" height="30" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="70" y="234" text-anchor="middle" font-size="10" fill="#2b2a26">A</text>
<rect class="bx-q" x="85" y="214" width="90" height="30" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="130" y="234" text-anchor="middle" font-size="8.5" fill="#6b675e">行 1 其余字节</text>
<rect class="bx" x="470" y="186" width="150" height="80" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="545" y="204" text-anchor="middle" font-size="10" fill="#2b2a26">核 2 的 L1</text>
<rect class="bx-q" x="485" y="214" width="90" height="30" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="530" y="234" text-anchor="middle" font-size="8.5" fill="#6b675e">行 2 其余字节</text>
<rect class="bx-q" x="575" y="214" width="30" height="30" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="590" y="234" text-anchor="middle" font-size="10" fill="#2b2a26">B</text>
<text class="ts" x="330" y="230" text-anchor="middle" font-size="10" fill="#6b675e">各写各的行，行不出自己的核，零一致性流量</text>
<text class="ts" x="40" y="292" font-size="10" fill="#6b675e">同行实测（每线程 2000 万次自增）：同物理核 83 ms · 同 CCX 跨核 102 ms · 跨 CCX 126 ms</text>
<text class="ts" x="40" y="310" font-size="10" fill="#6b675e">分行实测：10 / 9 / 16 ms（三种落位，偶发噪声由中位数吸收）</text>
<text class="tc" x="40" y="330" font-size="10.5" fill="#b03a2e">行跑多远，就慢多少：不出核、经 L3、横穿片内互联，一档一个价钱</text>
</svg>
</figure>

这个矩阵还附带一堂测量课，第一版程序踩了坑。当时六个配置顺序执行，同行在前、分行在后，结果分行跨核读出 44 到 76 ms，看上去比分行 SMT 还慢三倍，像是分行也出了什么问题。原因是同行配置乒乓了几秒钟，把整机拖进低频状态，紧随其后的分行继承了这份状态。改成轮次交错、让六个配置共享同一段时间环境之后，假差距消失，分行回到 6 至 16 ms。对比配置时，先后顺序会把前面的状态带进后面的读数。

工程上躲伪共享有现成的样板。Linux 内核的 SLUB 分配器把快路径做成 per-CPU freelist，每个核只碰自己那份，分配路径上无锁也无一致性流量（[《内核的 pymalloc》](/posts/kernel-slab-slub/)），这就是把分行制度化的做法。语言层面，Zig 给了 `std.atomic.cache_line` 当填充常量，C 里用 `alignas(64)`，C++ 里用 `alignas(64)`，把多线程的热点字段各自撑满一行。

## 这 64 字节的用法

把三个实验收拢，这一行给出的行动建议其实很短。

写布局时，记得搬运按行计价。一行里有效字节越密，单个字节越便宜，本机实测的两端是每行 3.3 ns 与 6.2 ns。小对象紧凑排布，热数组别留大洞，搭车的便宜自己会来。

写单线程访问时，别高估跨行的价钱。+21% 听着扎眼，基数只有 0.7 纳秒，且只在依赖读的关键路径上现形。普通代码里对齐优化的优先级，排在算法与访问模式之后。

写多线程计数时，先问行在哪。每线程的槽位撑满 64 字节，或者 per-CPU 聚合最后合并，都行；别让两个核写同一条行。本机数据：这一条值 8 到 20 倍。

不确定时，把拓扑读出来。`shared_cpu_list` 写着谁共享 L1、谁共享 L3，`sysconf` 与 `lscpu` 可以互相验证。伪共享的「伪」字，说的是代码里看不见共享，硬件里看得见。

---

本文只量了一个数字：64。搬运认它，对齐认它，缓存一致性也认它。下一篇把这座金字塔从顶到底走一遍，逐层量出访问延迟，看悬崖出现在哪一级、落差有多大。
