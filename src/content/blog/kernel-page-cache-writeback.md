---
title: write() 返回了，数据还在内存里：page cache 与脏页回写
description: 256MiB 的 write 用 0.12 秒就返回了，盘根本没碰过。本文拆开 write 之后的漫长旅程：page cache 怎么让读写都变成内存操作、脏页怎么标记、flusher 后台线程按什么水位和时钟干活、fsync 到底承诺了什么；实测三种 fsync 写法的吞吐差（2114 MB/s 的纯 write、605 MB/s 的段段 fsync），把 Redis appendfsync 三档策略的丢失窗口落到内核时间线上。实测于 Linux 7.2.3、btrfs 根分区。
pubDate: 2026-09-10
category: kernel
tags: [Linux, 内核, 文件系统, 内存管理]
---

一次 256MiB 的 `write` 用 0.121 秒返回（2114 MB/s），同一块盘换成每 4MiB fsync 一次，吞吐掉到 605 MB/s。中间只差一件事：要不要等盘。这一篇回答三个问题：write() 返回时数据到底在哪、内核在什么条件下才真正写盘、fsync 的承诺精确到哪一层又不含哪一层。（前置概念见[《第 0 篇》](/posts/kernel-primer/)的页与 /proc 两节。）

Redis 系列拆 AOF 时留过一个尾巴：`appendfsync everysec` 的丢失窗口约一秒，但这「一秒」在内核里是什么、由谁计时、为什么恰好是一秒，那篇只说到「交给内核的脏页机制」。VMA 篇收尾时也埋了钩子。这一篇接上这两条线：从 `write()` 返回的那一刻开始，跟着一页数据走完它到盘片的全程。

实验环境：Linux 7.2.3，AMD Zen 2，NVMe SSD，根分区 btrfs。文件系统不是背景板：本篇的多个实验结果都带着 btrfs 的指纹，遇到时会单独说明。源码对照 vanilla v7.2 tag。观测主要看 `/proc/meminfo` 的 `Dirty`（已改未写的页）和 `Writeback`（正在写盘的页）两列。

## write 是一次内存拷贝

第一课是这个系列的老朋友了：**写文件也是「先欠着」**。

`write(fd, buf, 256MiB)` 的内核路径里没有一步碰到盘。它做的是：把用户缓冲区的内容拷进内核的 **page cache**，一段按页组织的内存缓存，每个文件在缓存里占着自己的页。写入只是把这些页标记为「脏」（dirty，与盘上内容不一致），然后返回。第二篇实验里 smaps 的 `Private_Dirty` 记的是匿名页的脏；这里 `/proc/meminfo` 的 `Dirty` 记的是文件页的脏。同一个词，两本账。

page cache 是读写的双向缓存：写先进缓存（快），读先查缓存（重复读不碰盘）。它的收益用实验说话：256MiB 连续 write，0.121 秒返回，**2114 MB/s**。这块 NVMe 的真实顺序写大约在这个速度以下，但 write 根本没去排队，它只是把数据搬进了内存。

这一次 write 的旅程：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 216" role="img" aria-label="write 的旅程：用户缓冲区的 256MiB 经一次内存拷贝进入 page cache，文件页被标脏，0.121 秒返回；盘此刻一步没碰，之后由 flusher 或 fsync 来收" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern6As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">write(fd, buf, 256MiB)：内核路径里没有一步碰盘</text>
<rect class="bx" x="30" y="60" width="140" height="64" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="100" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">用户缓冲区</text>
<text class="ts" x="100" y="106" text-anchor="middle" font-size="11" fill="#6b675e">256MiB</text>
<line class="fl" x1="170" y1="92" x2="226" y2="92" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern6As1)"/>
<text class="ts" x="198" y="82" text-anchor="middle" font-size="11" fill="#6b675e">内存拷贝</text>
<rect class="bx-q" x="230" y="48" width="220" height="92" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="340" y="70" text-anchor="middle" font-size="13" fill="#2b2a26">page cache</text>
<rect class="bx-sick" x="248" y="80" width="28" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="282" y="80" width="28" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="316" y="80" width="28" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="350" y="80" width="28" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="384" y="80" width="28" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<rect class="bx-sick" x="418" y="80" width="14" height="20" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="340" y="124" text-anchor="middle" font-size="11" fill="#6b675e">这个文件的页，全部标「脏」</text>
<line class="fl" x1="450" y1="92" x2="506" y2="92" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#kern6As1)"/>
<text class="ts" x="478" y="82" text-anchor="middle" font-size="10" fill="#6b675e">之后才</text>
<rect class="bx-gone" x="510" y="60" width="120" height="64" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="6 4"/>
<text class="t" x="570" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">盘</text>
<text class="ts" x="570" y="106" text-anchor="middle" font-size="11" fill="#6b675e">此刻一步没碰</text>
<text class="ts" x="30" y="166" font-size="12" fill="#6b675e">0.121 秒返回：write 只做了两件事，搬进缓存、标脏</text>
<text class="ts" x="30" y="188" font-size="12" fill="#6b675e">盘那边不着急：数据什么时候落，由水位和时钟说了算</text>
<text class="ts" x="30" y="208" font-size="12" fill="#6b675e">观测就盯 meminfo 两列：Dirty 记欠账，Writeback 记正在搬运</text>
</svg>
</figure>

脏页的两个去向构成本篇的两条线：**被动线**（fsync，应用主动催收）和**主动线**（flusher，内核自己安排）。先看内核自己的安排。

## flusher：水位与时钟

谁来把脏页写下去？内核为每个存储设备（准确说是 backing device，bdi）配了后台回写线程（flusher/kworker 线程，`/proc/meminfo` 的 `Writeback` 列就是它们正在搬运的量）。它们按两条规则醒来：

**规则一：时钟。** `vm.dirty_writeback_centisecs`（本机 1500），每 15 秒醒一次扫一遍。

**规则二：水位。** `vm.dirty_background_bytes`（本机 64MiB），后台脏页超过这个量，不等时钟，立刻醒。

但注意，醒来是一回事，写多快是另一回事。真正狠的是写入者自己头上的第三道闸：`vm.dirty_bytes`（本机 256MiB）。v7.2 `mm/page-writeback.c` 的设计注释写得直白：

```text
 * balance_dirty_pages() must be called by processes which are generating dirty
 * data.  It looks at the number of dirty pages in the machine and will force
 * the caller to wait once crossing the (background_thresh + dirty_thresh) / 2.
 * If we're over `background_thresh' then the writeback threads are woken to
 * perform writeout.
```

每产生脏页的进程都会被按页抽查（`balance_dirty_pages_ratelimited`）：脏页总量过了水位中点，**写入者自己被按住睡眠**，直到回写追上。这是「write 快」的真正边界：小数据量随便写（自由区），逼近 256MiB 水位时写入吞吐被强行压到盘速。内核宁可让写入者等，也不让内存被脏页灌满。

三道闸在一根标尺上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 192" role="img" aria-label="脏页量数轴上的三道闸：0 到 64MiB 是自由区；过 64MiB flusher 被唤醒开始后台回写；过 160MiB 中点写入者被抽查按住睡眠；256MiB 是硬顶。另有一条与标尺无关的时钟每 15 秒扫一遍" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern6As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">横轴：全系统脏页总量（本机 bytes 模式）</text>
<rect class="bar" x="60" y="96" width="115" height="8" fill="#a29d90"/>
<rect class="bar" x="175" y="96" width="173" height="8" fill="#6b675e"/>
<rect class="bar" x="348" y="96" width="173" height="8" fill="#b03a2e"/>
<rect class="bar" x="521" y="96" width="79" height="8" fill="#2b2a26"/>
<line class="axis" x1="60" y1="100" x2="620" y2="100" stroke="#6b675e" stroke-width="1.2" marker-end="url(#kern6As2)"/>
<line class="flk" x1="175" y1="70" x2="175" y2="130" stroke="#2b2a26" stroke-width="2"/>
<line class="flc" x1="348" y1="70" x2="348" y2="130" stroke="#b03a2e" stroke-width="2"/>
<line class="flc" x1="521" y1="70" x2="521" y2="130" stroke="#b03a2e" stroke-width="2"/>
<text class="tc" x="175" y="62" text-anchor="middle" font-size="12" fill="#b03a2e">64MiB：flusher 被唤醒</text>
<text class="tc" x="348" y="62" text-anchor="middle" font-size="12" fill="#b03a2e">160MiB 中点：写入者被按住</text>
<text class="tc" x="545" y="62" text-anchor="middle" font-size="12" fill="#b03a2e">256MiB 硬顶</text>
<text class="ts" x="117" y="150" text-anchor="middle" font-size="11" fill="#6b675e">随便写</text>
<text class="ts" x="261" y="150" text-anchor="middle" font-size="11" fill="#6b675e">后台回写开工，写入者还自由</text>
<text class="ts" x="434" y="150" text-anchor="middle" font-size="11" fill="#6b675e">写入吞吐被压到盘速</text>
<text class="ts" x="560" y="150" text-anchor="middle" font-size="11" fill="#6b675e">绝不允许越过</text>
<text class="ts" x="20" y="178" font-size="12" fill="#6b675e">另有一条与标尺无关的时钟：每 15 秒扫一遍，30 秒内最老的脏页优先</text>
</svg>
</figure>

（顺带一个版本注脚：脏页限制有两套旋钮，`dirty_ratio` 按内存百分比、`dirty_bytes` 按绝对值，一套生效另一套归零显示。本机是 bytes 模式：64MiB 唤醒、256MiB 硬顶。改哪套、读哪套，先看对方是不是零。）

### 实测：一批脏页的时间线

实验 A 在 btrfs 上写 256MiB 不 fsync，然后每半秒采样（重点盯 **Dirty 的走势**，Cached 是全系统缓存、噪声源）：

```text
A0 写前                Dirty=  3868kB   （系统背景脏页）
A1 write 256MiB 返回   Dirty= 25596kB   ← 注意：只涨了 25MB
  +0.5s               Dirty= 27320kB
  +2.0s               Dirty= 27468kB   ← 稳着不动
  +4.5s               Dirty= 27496kB   ← 还是不动
  +5.0s               Dirty= 13312kB   ← flusher 一口气带走一半
```

两个读数需要解释。**其一，256MiB 的 write 只让 Dirty 涨了 25MB。** 读数本身没坏，这是 btrfs 的行为：文件系统有自己的写缓存与合并层，数据先进入 btrfs 的内部结构（这部分常常直接进入它自己的落盘路径），最后一批才以脏页形式留在 page cache。换成 ext4/xfs，Dirty 会涨得更接近写入量。**换文件系统，write 的可见行为就变**；结论绑定版本，也绑定文件系统。

**其二，25MB 脏页稳稳躺了 4.5 秒才被写走。** 时钟是 15 秒、水位 64MiB 没到，flusher 没有任何理由提前干活，直到某个周期扫到了这批「过期」脏页（`dirty_expire_centisecs`，本机 30 秒内最老的脏页优先）。对写入进程来说这 4.5 秒毫无感知；对断电来说这 4.5 秒的数据在内存里。

这 5 秒的 Dirty 画成曲线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="实验 A 的 Dirty 曲线：写前 3868kB，write 256MiB 返回后跳到 25596kB 只涨了 25MB，随后在 27000kB 平台上纹丝不动躺了 4.5 秒，第 5 秒被 flusher 一口气带到 13312kB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">实验 A：写 256MiB 不 fsync，每半秒采一次 Dirty</text>
<text class="ts" x="20" y="42" font-size="11" fill="#6b675e">Dirty（kB）</text>
<line class="grid" x1="70" y1="147" x2="610" y2="147" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="93" x2="610" y2="93" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="200" x2="70" y2="36" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="200" x2="620" y2="200" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="151" text-anchor="end" font-size="11" fill="#6b675e">10000</text>
<text class="ts" x="62" y="97" text-anchor="end" font-size="11" fill="#6b675e">20000</text>
<polyline class="curve-k" points="70,179 82,63 119,54 266,53 512,53 561,129" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="70" cy="179" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="82" cy="63" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="119" cy="54" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="266" cy="53" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="512" cy="53" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="561" cy="129" r="3" fill="#b03a2e"/>
<text class="tc" x="100" y="90" font-size="12" fill="#b03a2e">256MiB 的 write 只让 Dirty 涨了 25MB（btrfs 的中间层）</text>
<text class="ts" x="300" y="72" font-size="11" fill="#6b675e">平台：稳着不动 4.5 秒</text>
<text class="tc" x="380" y="116" font-size="12" fill="#b03a2e">flusher 带走了它</text>
<text class="ts" x="70" y="218" text-anchor="middle" font-size="11" fill="#6b675e">A0 写前</text>
<text class="ts" x="119" y="218" text-anchor="middle" font-size="11" fill="#6b675e">A1+0.5s</text>
<text class="ts" x="266" y="218" text-anchor="middle" font-size="11" fill="#6b675e">+2s</text>
<text class="ts" x="512" y="218" text-anchor="middle" font-size="11" fill="#6b675e">+4.5s</text>
<text class="ts" x="573" y="218" text-anchor="middle" font-size="11" fill="#6b675e">+5s</text>
<text class="ts" x="20" y="240" font-size="12" fill="#6b675e">每半秒一个采样点：平台是真实的静止，不是采样稀疏</text>
</svg>
</figure>

## fsync：它承诺什么，不承诺什么

以上是内核自选动作。应用要更强保证时，主动催收：`fsync(fd)`。

fsync 的承诺精确地说：**把这个文件的内容和必要的元数据推进到存储设备，等设备确认**。它返回后，进程崩了数据还在；但注意两个不含：不含设备自身缓存之后的事（断电时设备里那份另说），也不含全局 Dirty 清零（只管自己文件的页）。实验 D 拍到了这个细节：

```text
D1 64MiB write 完成   Dirty= 68420kB
   fsync 用时 0.050s
   fsync 返回          Dirty=  7208kB   ← 掉了 61MB，剩的是别人的
```

fsync 返回瞬间，自己文件的脏页清完（落到设备），系统背景脏页原样躺着。**Dirty 是全局指标，fsync 是单文件动作**，读监控时把这俩混在一起，会得出「fsync 没用」的假结论。

实验 D 这一笔清的是谁的账：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 178" role="img" aria-label="fsync 前后的 Dirty 构成：写完成时全局 Dirty 是 68420kB，其中 61MB 属于本文件、7MB 是别的进程的背景脏页；fsync 用 0.050 秒只清掉本文件那 61MB，返回时剩下的 7208kB 全是背景" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern6As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">全局 Dirty 一列里的两种脏页</text>
<text class="tc" x="172" y="40" text-anchor="middle" font-size="11" fill="#b03a2e">本文件 61MB</text>
<text class="ts" x="300" y="40" text-anchor="middle" font-size="11" fill="#6b675e">背景 7MB</text>
<rect class="bx-sick" x="80" y="48" width="184" height="32" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx" x="264" y="48" width="22" height="32" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="80" y="98" font-size="11" fill="#6b675e">D1：64MiB write 完成，Dirty=68420kB</text>
<line class="fl" x1="310" y1="64" x2="404" y2="64" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern6As4)"/>
<text class="ts" x="357" y="54" text-anchor="middle" font-size="11" fill="#6b675e">fsync 0.050s</text>
<rect class="bx" x="420" y="48" width="22" height="32" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="450" y="40" font-size="11" fill="#6b675e">只剩背景 7208kB</text>
<text class="ts" x="420" y="98" font-size="11" fill="#6b675e">fsync 返回</text>
<rect class="bx-sick" x="80" y="114" width="12" height="12" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="98" y="124" font-size="11" fill="#6b675e">本文件的脏页</text>
<rect class="bx" x="220" y="114" width="12" height="12" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="238" y="124" font-size="11" fill="#6b675e">别的进程的背景脏页</text>
<text class="ts" x="20" y="158" font-size="12" fill="#6b675e">拿全局监控评估单文件 fsync，永远差一截</text>
</svg>
</figure>

### 三种写法的实测吞吐

现在把 Redis 的三档策略放进内核时间线实测。同一块盘、同样 256MiB：

| 姿势 | 对应 Redis 档 | 实测 | 说明 |
| --- | --- | ---: | --- |
| 纯 write，不 fsync | （appendfsync no） | 2114 MB/s | 数据在 page cache，断电丢 |
| 每 4MiB write + fsync | appendfsync always | 605 MB/s | 每段都等设备确认 |
| 256MiB write + 末尾一次 fsync | everysec 的批量等价 | 4755 MB/s* | 窗口内全欠，最后一次还清 |

\* 第三行 0.135s 写 + 0.029s fsync，合计吞吐折算；everysec 真实实现是「每秒一次后台线程 fsync」，这里是它的简化模型。

三个数字就是三种价：always 的 605 MB/s 输在 64 次往返上，每次 fsync 都要等设备确认，把流式写切成段段确认；纯 write 的 2114 MB/s 是内存速度的假象；末尾一次 fsync 拿到最高的「确认后吞吐」，代价是整个写入窗口的数据都悬在内存里。Redis 选 everysec 是中间价：一秒的窗口，最多丢一秒，吞吐几乎不受影响。

三种价摆在一起：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 206" role="img" aria-label="三种写法同一块盘的吞吐条形图：纯 write 不 fsync 是 2114 MB/s，对应 Redis appendfsync no；每 4MiB 一次 fsync 是 605 MB/s，对应 always；256MiB 写完末尾一次 fsync 折算 4755 MB/s，对应 everysec 的批量等价" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一块盘、同样 256MiB，三种写法的折算吞吐</text>
<text class="ts" x="20" y="58" font-size="12" fill="#6b675e">纯 write 不 fsync · appendfsync no</text>
<rect class="bar" x="20" y="64" width="191" height="22" fill="#2b2a26"/>
<text class="tc" x="220" y="80" font-size="12" fill="#b03a2e">2114 MB/s：内存速度的假象</text>
<text class="ts" x="20" y="104" font-size="12" fill="#6b675e">每 4MiB write + fsync · always</text>
<rect class="bar" x="20" y="110" width="55" height="22" fill="#2b2a26"/>
<text class="tc" x="84" y="126" font-size="12" fill="#b03a2e">605 MB/s：64 次等设备确认的往返价</text>
<text class="ts" x="20" y="150" font-size="12" fill="#6b675e">末尾一次 fsync · everysec 的批量等价</text>
<rect class="bar" x="20" y="156" width="430" height="22" fill="#2b2a26"/>
<text class="onbar" x="235" y="172" text-anchor="middle" font-size="11" fill="#f6f3ec">4755 MB/s：窗口内全欠着，最后一次性还清</text>
<text class="ts" x="460" y="172" font-size="11" fill="#6b675e">条越长吞吐越高</text>
<text class="ts" x="20" y="198" font-size="12" fill="#6b675e">吞吐的另一面是欠账时长：no 欠到 flusher 来收，always 一段都不欠，everysec 欠一秒</text>
</svg>
</figure>

这就是「丢失窗口约一秒」的完整内核含义：**不是数据写了一半，是整整一秒的 write 都还停在 page cache 或文件系统内部缓冲里，从未见过盘**。断电时这扇窗口里的数据蒸发；进程崩溃时反而不会丢（page cache 是内核的，进程死了缓存还在，flusher 照常写走）。「进程崩溃不丢、断电才丢」这条经验，机制就在这两层之间。

窗口里外，两种结局：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="everysec 丢失窗口的内核时间线：上一次 fsync 到下一次 fsync 之间的一秒里，所有 write 都悬在 page cache 与文件系统缓冲中从未见过盘；断电则窗口内的数据蒸发，进程崩溃则缓存还在由 flusher 照常写走不丢" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern6As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="kern6Ac6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">「丢失窗口约一秒」在内核时间线上的样子</text>
<rect class="bx-sick" x="180" y="56" width="240" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="300" y="78" text-anchor="middle" font-size="12" fill="#b03a2e">这一秒的 write 全悬在缓存，从未见过盘</text>
<line class="flk" x1="180" y1="92" x2="180" y2="146" stroke="#2b2a26" stroke-width="2"/>
<line class="flk" x1="420" y1="92" x2="420" y2="146" stroke="#2b2a26" stroke-width="2"/>
<line class="axis" x1="60" y1="140" x2="600" y2="140" stroke="#6b675e" stroke-width="1.2" marker-end="url(#kern6As6)"/>
<text class="ts" x="180" y="162" text-anchor="middle" font-size="11" fill="#6b675e">上一次 fsync</text>
<text class="ts" x="420" y="162" text-anchor="middle" font-size="11" fill="#6b675e">下一次 fsync（1 秒后）</text>
<line class="flc" x1="250" y1="146" x2="250" y2="180" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#kern6Ac6)"/>
<text class="tc" x="240" y="176" text-anchor="end" font-size="11" fill="#b03a2e">断电</text>
<line class="fl" x1="400" y1="146" x2="480" y2="180" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern6As6)"/>
<text class="ts" x="416" y="176" font-size="11" fill="#6b675e">进程崩溃</text>
<rect class="bx-sick" x="140" y="184" width="220" height="40" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="250" y="208" text-anchor="middle" font-size="12" fill="#b03a2e">窗口内的数据蒸发</text>
<rect class="bx" x="380" y="184" width="260" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="510" y="208" text-anchor="middle" font-size="12" fill="#6b675e">缓存是内核的，flusher 照常写走</text>
<text class="ts" x="20" y="242" font-size="12" fill="#6b675e">丢不丢，取决于死的是谁：进程死了内存还在，电源死了内存跟着没</text>
</svg>
</figure>

## 读路径的另一半

page cache 的另一半是读。第一次 read 把文件页从盘搬进缓存，之后的读全是内存命中。第 0 篇速查表里那本 `/proc/meminfo` 的 `Cached`（本机常年 5.6GB）就是它。这就是为什么「再跑一遍程序更快」：二进制、库、数据文件都还躺在缓存里。

它也解释了两个日常现象。其一，`free` 显示的「可用内存」不等于「空闲」：缓存放着 5.6GB，但进程要内存时内核立刻丢弃干净页腾地。缓存是可压缩的，这是第四篇 SReclaimable 的文件页版本。其二，重复跑基准测试会得到虚高的分数，测的是缓存，不是盘。想让第二次读也碰盘，得先清缓存（`echo 3 > /proc/sys/vm/drop_caches`，root 权限，生产环境慎用）。

## 我踩的坑

**write 会被截短，且失败信息是假的。** B 段实验第一次跑，write 循环立刻报 `Bad address`（EFAULT）。排查发现两层问题：本会话沙箱对单次 write 有约 12KB 的截短（write 返回 12400 而非请求量，但返回值是合法的部分写），而我的 4MiB 段直接越过 1MiB 缓冲区读了界外内存。两个教训：**write 返回值必须检查并循环补写**（教科书正确写法本来就是 while 循环），以及 **perror 打出的错误可能是上一个系统调用留下的旧 errno**，「Success」报在失败分支里，是 C 错误处理的经典陷阱。

**数字不合预期时，先怀疑中间层。** 「256MiB 写入只涨 25MB Dirty」第一眼像实验失败。换 ext4 对照的念头一起，就明白了是 btrfs 的内部缓冲：文件系统在 page cache 和盘之间又垫了一层自己的结构。这个「失败数据」反而成了本篇最重要的版本边界素材。

**fsync 后 Dirty 不归零不是 bug。** 实验 C 里 fsync 返回后 Dirty 还剩 25MB，差一点写成「fsync 失效」。实验 D 的持续采样证明那是系统背景脏页（别的进程的），fsync 只清自己文件的账。全局指标和单文件动作的粒度差，又一次差点制造假结论。

**tmpfs 不能做本篇实验。** 最初想把实验放 `/tmp`（系列前几篇的老习惯），写到一半才想起 tmpfs 是纯内存文件系统，**根本没有回写**，脏页机制对它不存在。换成家目录的 btrfs。第 0 篇说「/proc 是账本」，这一篇的补充是：**账本记什么，取决于文件系统在不在「盘」那一侧**。

## write 与 fsync 的语义

write() 是一次内存拷贝：数据进 page cache、页标脏、立刻返回，盘在不在、快不快，这一刻都不相干。读写共享这本缓存，`Cached` 那 5GB 是系统免费的加速器。回写由时钟、水位和写入者自己三重驱动：flusher 每 15 秒醒一次或脏页过 64MiB 被唤醒，30 秒内最老的脏页优先；脏页逼近 256MiB 硬顶时，写入者被按住睡眠，「write 快」的自由区以水位为界，内核绝不让脏页灌满内存。fsync 只承诺自己的文件：返回即该文件内容与必要元数据已被设备确认；不承诺全局 Dirty 清零，也不承诺别的进程的数据。丢失窗口的本质是「从未见过盘的 write 集合」，进程崩溃不扩大它，断电才收割它。三档策略是三种价：纯 write 内存价、段段 fsync 往返价、批量一次 fsync 窗口价；Redis everysec 的「最多丢一秒」翻译成内核语言，就是一秒窗口内的 write 全部悬在 page cache 与文件系统缓冲里。文件系统不同，窗口内的可见行为就不同，btrfs 的中间层让 256MiB 只露出 25MB 的脏。

page cache 补上了观测面的最后一块：页表管虚拟侧、伙伴系统管物理侧、slab 管内核自己的小对象、page cache 管文件的页。到这里，「分配」的故事全部讲完。还剩最后一个问题：内存真的见底时，内核怎么决定杀谁。

下一篇：《最后一道保险丝：OOM killer 与内存压力》。
