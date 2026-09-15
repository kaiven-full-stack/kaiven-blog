---
title: 第 0 篇：指针、页，和内核的账本
description: 这个系列的前置阅读，不需要任何内核基础。同一个地址为什么在两个进程里是两个世界、内存为什么按 4096 字节一页管理、/proc 为什么可以当账本翻，三样东西讲清楚，后面七篇的门槛就低了一半。文末附系列阅读地图和术语速查表。实验跑在本机 Linux 7.2.3 上。
pubDate: 2026-09-10
category: kernel
tags: [Linux, 内核, 内存管理, 入门]
---

一页内存，地址 `0x7f3ded282000`。父进程在上面写下 111，然后 fork 出一个子进程，子进程在同一个地址写下 222。之后，子进程读这个地址得到 222，父进程读它还是 111。

同一个地址，两个进程，读到两个不同的值。觉得反直觉就对了，这正是整个系列要解释的第一件事。

「听雨」的内核系列已经写了七篇：页表、写时复制、伙伴系统、slab、VMA、page cache、OOM。写的人痛快，但如果你打开第一篇就被「四级页表」「pagemap 位定义」劝退，那是我的问题。这一篇补上缺失的台阶：三样东西，三节讲完。不需要内核基础，最好会一点 C；不会也行，代码块都可以当伪代码读。

三样东西是：

1. **指针（虚拟地址）是每家自己的门牌号**：为什么同一个地址能在两个进程里指向不同的内存；
2. **页（4KiB）是内存管理的最小单位**：为什么内核不按字节管内存；
3. **/proc 是内核的账本**：这个系列的一切实验都靠它。

## 第一样东西：地址是每家自己编的

先看那个实验的代码，全部逻辑就这么几行：

```c
uint64_t *p = mmap(NULL, 4096, PROT_READ|PROT_WRITE,
                   MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);  /* 向内核要一页内存 */
*p = 111;                                              /* 写 111 */
if (fork() == 0) {                                     /* 复制出一个子进程 */
    *p = 222;                                          /* 子进程写 222 */
    printf("子进程读到 %lu\n", *p);                     /* 222 */
    _exit(0);
}
wait(NULL);
printf("父进程读到 %lu\n", *p);                         /* 111 */
```

`mmap` 返回一个地址，比如 `0x7f3ded282000`。fork 之后，子进程把 `0x7f3ded282000` 上的值改成 222，父进程去读同一个地址，读到的还是 111。同一个门牌号，两家人，两个屋子。

日常直觉在这里失效：我们默认「地址」像 GPS 坐标一样全局唯一。但程序里的地址（教科书叫**虚拟地址**）从来不是物理世界的坐标，而是每个进程自己内部的一套编号。就像每栋楼都有自己的 101 室：你朋友家的 101 和你家的 101 当然不是同一个房间。进程就是楼，虚拟地址就是门牌号，而物理内存是整座城市。

那谁负责「门牌号 → 实际房间」的翻译？内核。每个进程手里有一张自己的**页表**，也就是翻译表，内核维护、CPU 硬件查询。上面实验的真相是：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 300" role="img" aria-label="虚拟地址 0x7f3ded282000 经两张翻译表各自翻译：父进程的页表指向物理房间 A，写着 111；子进程的页表指向物理房间 B，写着 222。fork 时翻译表整个复制一份，之后各写各的" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern0As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一个虚拟地址，两张翻译表，两个物理房间</text>
<rect class="bx-q" x="215" y="40" width="230" height="38" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="64" text-anchor="middle" font-size="14" fill="#2b2a26">0x7f3ded282000</text>
<line class="fl" x1="280" y1="78" x2="180" y2="114" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As1)"/>
<line class="fl" x1="380" y1="78" x2="480" y2="114" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As1)"/>
<rect class="bx" x="75" y="120" width="190" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="170" y="143" text-anchor="middle" font-size="14" fill="#2b2a26">父进程的翻译表</text>
<text class="ts" x="170" y="163" text-anchor="middle" font-size="12" fill="#6b675e">页表，内核维护</text>
<rect class="bx" x="395" y="120" width="190" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="490" y="143" text-anchor="middle" font-size="14" fill="#2b2a26">子进程的翻译表</text>
<text class="ts" x="490" y="163" text-anchor="middle" font-size="12" fill="#6b675e">fork 时整个复制了一份</text>
<line class="fl" x1="170" y1="176" x2="170" y2="204" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As1)"/>
<line class="fl" x1="490" y1="176" x2="490" y2="204" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As1)"/>
<rect class="bx-q" x="95" y="210" width="150" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="170" y="231" text-anchor="middle" font-size="12" fill="#6b675e">物理房间 A</text>
<text class="t" x="170" y="252" text-anchor="middle" font-size="14" fill="#2b2a26">写着 111</text>
<rect class="bx-q" x="415" y="210" width="150" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="490" y="231" text-anchor="middle" font-size="12" fill="#6b675e">物理房间 B</text>
<text class="t" x="490" y="252" text-anchor="middle" font-size="14" fill="#2b2a26">写着 222</text>
<text class="ts" x="20" y="290" font-size="12" fill="#6b675e">各进程读到的都是自己表里登记的房间：父读 111，子读 222，互不相扰</text>
</svg>
</figure>

fork 复制进程时，翻译表也复制了一份；之后两边各自改动，就渐渐分了家。这套机制带来三个日常结论，先记住结论、细节系列正文再拆：

- **一个进程永远不可能用指针直接摸到另一个进程的内存**。你只有自己这本翻译表，编号在表外查无此房。这就是进程隔离。
- **两个进程里打印出同一个地址，不代表同一块内存**。比对跨进程的指针没有意义。
- **「内存不足」常常另有原因，物理内存可能还剩很多**。翻译表可以给每个进程都登记一个巨大的地址空间（64 位机器上是 256TiB），实际房间按需分配。申请不等于占用，这是后面所有「欠着」故事的起点。

术语速记：**虚拟地址**（程序里的指针）、**物理地址**（真实内存的坐标）、**页表**（每个进程一本的翻译表）。系列第一篇《Linux 页表：一次访存的四层翻译》讲的就是这张翻译表。

## 第二样东西：内存按页管，一页 4096 字节

如果翻译按字节做，每个字节一条记录，翻译表自己就会比内存还大。所以所有的翻译、分配、记账都按**页**进行：一页通常 4096 字节，翻译表只登记「第 N 页虚拟 → 第 M 页物理」。

两种记法的差距，拿 1GiB 内存算一算：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 130" role="img" aria-label="同样 1GiB 内存的两种记法：每字节一条记录需要 1073741824 条，长条占满画面；每 4096 字节一页一条记录只要 262144 条，只剩一个窄条，条目数是前者的四千零九十六分之一" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同样 1GiB 内存，两种记法</text>
<text class="ts" x="20" y="63" font-size="12" fill="#6b675e">每字节一条</text>
<rect class="bar" x="170" y="48" width="430" height="20" fill="#2b2a26"/>
<text class="onbar" x="385" y="63" text-anchor="middle" font-size="12" fill="#f6f3ec">1,073,741,824 条记录</text>
<text class="ts" x="20" y="108" font-size="12" fill="#6b675e">每页（4KiB）一条</text>
<rect class="bar" x="170" y="93" width="3" height="20" fill="#2b2a26"/>
<text class="tc" x="182" y="108" font-size="12" fill="#b03a2e">262,144 条，条目数正好差 4096 倍</text>
</svg>
</figure>

4096 这个数字是权衡出来的：页越大，翻译表越小、查得越快，但「要一页只用几十字节」的浪费越大。4096 是几十年筛下来的中间值。你以后会遇到的很多名词，本质都是「页」的不同玩法：

- **缺页（page fault）**：程序访问的页在翻译表里还没登记（比如 `malloc` 要了内存但一次都没碰），CPU 当场停下、陷入内核，内核补登记、找一页真实内存，然后程序若无其事地继续。缺页是内核「补发货」的正常流程。`malloc` 快的秘密就是它常常根本不发货，等你真用了再说。
- **大页**：把页放大到 2MiB 一格，翻译表条目变少。第一篇会实测它的利弊。
- **写时复制（COW）**：fork 时不真的复制内存，先把两家的翻译表都改成「只读」；谁真写了，再复制那一页。上面实验里 fork 后子进程写 222 触发的正是这个机制，第二篇整篇讲它。

缺页的全过程，摊开成四步：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 172" role="img" aria-label="缺页四步：第一步 malloc 下单，返回地址但只登了记还没发货；第二步首次写这个地址，翻译表查无登记，CPU 当场停下；第三步陷入内核补登记，给一页清零的真实内存；第四步回到程序接着执行，RSS 从此多出一页" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern0As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">从下单到到货：一次缺页的四步</text>
<rect class="bx" x="12" y="44" width="143" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="83" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">① 下单</text>
<text class="ts" x="83" y="88" text-anchor="middle" font-size="12" fill="#6b675e">malloc 返回地址</text>
<text class="ts" x="83" y="106" text-anchor="middle" font-size="12" fill="#6b675e">只登了记，没发货</text>
<rect class="bx-sick" x="177" y="44" width="143" height="76" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="248" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">② 触碰</text>
<text class="ts" x="248" y="88" text-anchor="middle" font-size="12" fill="#6b675e">首次写这个地址</text>
<text class="ts" x="248" y="106" text-anchor="middle" font-size="12" fill="#6b675e">查无登记，CPU 停下</text>
<rect class="bx" x="342" y="44" width="143" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="413" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">③ 补发货</text>
<text class="ts" x="413" y="88" text-anchor="middle" font-size="12" fill="#6b675e">陷入内核补登记</text>
<text class="ts" x="413" y="106" text-anchor="middle" font-size="12" fill="#6b675e">给一页清零的真内存</text>
<rect class="bx-q" x="507" y="44" width="143" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="578" y="68" text-anchor="middle" font-size="14" fill="#2b2a26">④ 继续</text>
<text class="ts" x="578" y="88" text-anchor="middle" font-size="12" fill="#6b675e">回到程序接着执行</text>
<text class="ts" x="578" y="106" text-anchor="middle" font-size="12" fill="#6b675e">RSS 从此多出一页</text>
<line class="fl" x1="155" y1="82" x2="173" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As3)"/>
<line class="fl" x1="320" y1="82" x2="338" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As3)"/>
<line class="fl" x1="485" y1="82" x2="503" y2="82" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As3)"/>
<text class="ts" x="20" y="156" font-size="12" fill="#6b675e">四步走完，程序毫无感知：它只是觉得自己写了一个变量</text>
</svg>
</figure>

一个可以现在就做的验证：`malloc(100)` 之后马上看进程内存占用，几乎没变；把 100 字节写满，占用涨 **4KiB** 起步，因为内核发货的最小单位是一页，哪怕你只要 100 字节。

这次验证的现场：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 234" role="img" aria-label="要 100 字节，到货一页：4096 字节的页里只有开头一小条朱砂色是写满的 100 字节，其余 3996 字节归这个进程独占。下方 RSS 对比：malloc 之后几乎没动，写满之后多出 4KiB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">要 100 字节，到货一页</text>
<rect class="bx-q" x="40" y="44" width="480" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx-sick" x="40" y="44" width="12" height="56" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="300" y="76" text-anchor="middle" font-size="12" fill="#6b675e">其余 3996 字节：归这个进程独占，别人也用不上</text>
<text class="ts" x="532" y="76" font-size="12" fill="#6b675e">一页 = 4096 B</text>
<line class="flc" x1="46" y1="100" x2="46" y2="116" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="40" y="134" font-size="12" fill="#b03a2e">写满的 100 字节</text>
<text class="ts" x="40" y="172" font-size="12" fill="#6b675e">malloc(100) 刚返回时的 RSS</text>
<rect class="bar" x="290" y="158" width="6" height="18" fill="#2b2a26"/>
<text class="ts" x="304" y="172" font-size="12" fill="#6b675e">几乎没动：还没发货</text>
<text class="ts" x="40" y="212" font-size="12" fill="#6b675e">把 100 字节写满后的 RSS</text>
<rect class="bar" x="290" y="198" width="96" height="18" fill="#2b2a26"/>
<text class="tc" x="394" y="212" font-size="12" fill="#b03a2e">+4KiB：一页起步</text>
</svg>
</figure>

## 第三样东西：/proc 是内核的账本

内核内部的状态，理论上你看不见：你的进程有哪些内存段、翻译表多大、系统还剩多少空闲页。但 Linux 把这些内部状态**挂成了文件**，放在 `/proc` 目录下，读文件就等于查账：

```text
cat /proc/meminfo          # 全系统内存账：总共多少、用了多少、缓存多少
cat /proc/self/maps        # 我这个进程的内存地图：每段地址、权限、来自哪
cat /proc/self/status      # 我这个进程的概况：占用、页表大小、线程数
cat /proc/buddyinfo        # 内核仓库的空闲页货架（第三篇的主角）
```

做个最小实验。`malloc(100)` 返回地址 `0x5243010`，然后翻自己的地图：

```text
$ cat /proc/self/maps
...
05243000-05264000 rw-p 00000000 00:00 0    [heap]
...
```

`malloc` 给的地址 `0x5243010` 就落在 `05243000-05264000` 这段里，它叫**堆（heap）**，是程序日常小内存的来源。第一行十六进制是这段的起止地址，`rw-p` 是权限（可读可写、私有），`[heap]` 是它的名字。

这个系列每篇的实验，本质上都是同一件事：**做一个动作，然后翻 /proc 里对应的账本，看数字怎么变**。账本不小，但常用的就几本，遇到再查即可。提前把本系列出场的账本列一张速查：

| 账本 | 一句话说明 |
| --- | --- |
| `/proc/self/maps` | 我的内存地图，一段一行 |
| `/proc/self/status` | 我的概况页，其中 `VmRSS` 是真实占用的物理内存 |
| `/proc/meminfo` | 全系统内存账 |
| `/proc/buddyinfo` | 内核空闲页仓库的货架清单 |
| `/proc/vmstat` | 内核活动的累计计数器（比如大页成功/失败次数） |

术语速记：**RSS**（Resident Set Size，进程真实占用的物理内存大小）。注意它和 `malloc` 了多少字节是两个世界：前者是「发货到货」，后者是「下了多少订单」。

## 你不需要记住的东西

为降低打开下一篇的心理负担，先把「不用背」的说清楚：

- **具体数字**不用背。页是 4096 字节、堆从哪开始、阈值 128KiB，用的时候回来查，文章里也都会重申。
- **内核源码路径**不用背。`mm/memory.c` 还是 `mm/huge_memory.c` 无关紧要，文章引用源码只是证明「结论有出处」。
- **/proc 的全部字段**不用背。上面那本速查表遇到再翻。
- **Linux 命令行经验**不是必需。系列实验的程序都不长，能读懂 C 的 `if` 和 `printf` 就够。

真正需要的只有三样，就是这篇讲的三样：地址是每家自己的编号、内存按页管、/proc 是账本。后面每篇开头都会重申当时需要的背景。

## 系列阅读地图

七篇正文、番外，与新开的过程线，每篇解决一个具体问题，可以按需跳读：

| 篇 | 标题 | 一句话内容 |
| --- | --- | --- |
| 1 | Linux 页表：一次访存的四层翻译 | 翻译表（页表）长什么样、一次地址翻译的成本 |
| 2 | 写一个字节，复制一整页 | fork 后写内存到底发生了什么（COW 全程） |
| 3 | 物理页的家底 | 内核的页仓库（伙伴系统）怎么管货架、碎片是什么 |
| 4 | 内核的 pymalloc | 内核自己的小对象柜台（slab），和 CPython 的分配器对照 |
| 5 | malloc 返回了，内核还不知道 | malloc 的两条通道和内核的地址记账（VMA） |
| 6 | write() 返回了，数据还在内存里 | 文件读写怎么先走内存、什么时候落盘、fsync 承诺什么 |
| 7 | 最后一道保险丝 | 内存见底时，内核怎么挑一个进程杀掉 |
| 番外 | 插了 16GB，账面只剩 15GB | 开机到交接：固件的清单、memblock 与账面两级减法 |
| 番外 | 同样是 8MB 的栈 | 进程栈边用边长，线程栈一次给全，无人区与隐形 guard |
| 进程线 1 | clone 这扇门 | 任务的出生：fork 与建线程进同一个 kernel_clone，进程线程只差一张报关单 |
| 进程线 2 | 人没换，衣服全换了 | exec 换装：begin_new_exec 的生死簿、LOAD 段逐一映射、RELRO 一刀与 maps 对账 |
| 进程线 3 | 24 毫秒不见了 | 调度器三代秤走到 EEVDF：资格线、deadline、权重表当场称重 |

推荐顺序：0 → 1 → 2 是一条主线（地址 → 翻译 → 写入），3 → 4 是物资线（仓库 → 柜台），5 收束地址线，6 → 7 讲释放（先落盘缓存，再最后保险）。赶时间的话，0 → 1 → 2 读完你就已经跨过了这个系列最陡的坡；3 到 7 每篇开头都有独立的问题引入，单读也成立。番外不在主线里，讲的是主线之前和主线之外的事，任何时候单读都行。进程线是内存九篇之后新开的第二条主线，讲时间：任务怎么出生、怎么换装、怎么排队、怎么被换下，第 1 篇单读成立，读完内存线接着走正好。

这条路径排成一条路线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 292" role="img" aria-label="系列阅读路线：第一行主线从 0 前置三样到 1 页表四层翻译再到 2 写时复制；折回第二行物资线 3 伙伴系统到 4 slab 柜台，再到 5 VMA 账本收束地址线；折到第三行释放线 6 page cache 到 7 OOM 保险丝" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern0As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="30" font-size="12" fill="#6b675e">主线：地址 → 翻译 → 写入</text>
<rect class="bx-q" x="60" y="52" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="135" y="78" text-anchor="middle" font-size="14" fill="#2b2a26">0 · 前置三样</text>
<rect class="bx-q" x="255" y="52" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="78" text-anchor="middle" font-size="14" fill="#2b2a26">1 · 页表翻译</text>
<rect class="bx-q" x="450" y="52" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="525" y="78" text-anchor="middle" font-size="14" fill="#2b2a26">2 · 写时复制</text>
<line class="fl" x1="210" y1="73" x2="251" y2="73" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<line class="fl" x1="405" y1="73" x2="446" y2="73" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<line class="fl" x1="525" y1="94" x2="525" y2="132" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<text class="ts" x="20" y="126" font-size="12" fill="#6b675e">物资线：仓库 → 柜台</text>
<rect class="bx-q" x="450" y="136" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="525" y="162" text-anchor="middle" font-size="14" fill="#2b2a26">3 · 伙伴系统</text>
<rect class="bx-q" x="255" y="136" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="162" text-anchor="middle" font-size="14" fill="#2b2a26">4 · slab 柜台</text>
<rect class="bx-q" x="60" y="136" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="135" y="162" text-anchor="middle" font-size="14" fill="#2b2a26">5 · VMA 账本</text>
<line class="fl" x1="450" y1="157" x2="409" y2="157" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<line class="fl" x1="255" y1="157" x2="214" y2="157" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<line class="fl" x1="135" y1="178" x2="135" y2="216" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<rect class="bx-q" x="60" y="220" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="135" y="246" text-anchor="middle" font-size="14" fill="#2b2a26">6 · page cache</text>
<rect class="bx-q" x="255" y="220" width="150" height="42" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="246" text-anchor="middle" font-size="14" fill="#2b2a26">7 · OOM 保险丝</text>
<line class="fl" x1="210" y1="241" x2="251" y2="241" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern0As5)"/>
<text class="ts" x="440" y="234" font-size="12" fill="#6b675e">释放线：先落盘缓存，</text>
<text class="ts" x="440" y="252" font-size="12" fill="#6b675e">再最后保险</text>
<text class="ts" x="20" y="284" font-size="12" fill="#6b675e">箭头是建议的阅读顺序，不是依赖：每篇开头都会重申当时需要的背景</text>
</svg>
</figure>

三样东西讲完了。指针是每家自己编的门牌号，翻译由内核的页表完成；内存按 4KiB 一页发货，订单和到货是两回事；这一切的状态都挂在 /proc 里，可以自己去翻。

带上这三样东西，从《Linux 页表：一次访存的四层翻译》出发。
