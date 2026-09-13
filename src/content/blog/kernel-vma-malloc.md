---
title: malloc 返回了，内核还不知道：brk、mmap 与 VMA
description: malloc(64) 不到 1 微秒就返回，可内核对此一无所知，那 64 字节住在哪？本文拆开用户态与内核的边界：brk 与 mmap 双通道、glibc 的动态阈值如何实测翻转分配路径、VMA 的合并与分裂（一次 mprotect 让一条变三条，改回去又重新长拢）、madvise 为何能阻止合并，以及 maps 里 3818 条记录的飞书和 23 条的最小 C 程序之间隔着什么。glibc 行为以本机实测为准，内核源码对照 vanilla v7.2。
pubDate: 2026-09-10
category: kernel
tags: [Linux, 内核, 内存管理]
---

```text
malloc(64)  返回 0x6748010，用时不足 1 微秒。
[heap]      132KiB，没有变化。
pagemap     present=0，该页不存在。
```

这是一次 `malloc(64)` 的全部观测：用户态拿到了地址，内核侧却什么都没动，堆还是原来那么大，那一页甚至不存在。这一篇就拆这三行是怎么来的：`malloc` 的请求被翻译成哪两个系统调用、由什么决定走哪个，`mprotect` 和 `madvise` 为什么会改变 `/proc/self/maps` 的行数，以及「内核还不知道」这句话完整拆开有几层。（前置概念见[《第 0 篇》](/posts/kernel-primer/)。）

这个系列一路走来，地址层的主角前四篇都已出场：页表是地图，缺页是搬东西的动作，伙伴系统是仓库，slab 是内核自己的柜台。但有一个最日常的入口一直没拆：`malloc`。CPython 系列拆 pymalloc 时顺嘴提过一句「arena 层最后走 mmap」就停住了；这一篇把这条线走到底，看 `malloc` 把你的请求翻译成什么系统调用、内核用什么结构接住、以及为什么这一切的答案是「先欠着」。

实验环境照旧：Linux 7.2.3，AMD Zen 2，源码对照 vanilla v7.2 tag。本篇的 glibc 是 Arch 当前打包的版本，malloc 参数以实测为准。

## malloc 的两条通道

`malloc` 不是系统调用，是 glibc 里的一台调度机。它管理着两个向内核要内存的通道：

**通道一：brk。** 进程地址空间里有一个特殊标记 `program break`，内核为之维护一个专门的 VMA（在 maps 里显示为 `[heap]`）。`brk(addr)` 把这个标记往前推，推过的区间就归堆使用；往后拉则是收缩。整个过程只是扩展一个已存在的 VMA，没有新建映射。

**通道二：mmap。** 每次调用独立映射一段匿名内存，用完 `munmap` 整段归还。第二篇结尾说过 pymalloc 的 arena 层用的就是它，`malloc` 的大块分配走的是同一条路。

一台调度机，两个出口：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="malloc 是 glibc 里的调度机：请求与阈值比较，小的走 brk 通道把 heap VMA 的终点往前推并优先复用空闲 chunk，大的走 mmap 通道独立映射一段、munmap 整段归还" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern5As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="230" y="32" width="200" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="57" text-anchor="middle" font-size="13" fill="#2b2a26">malloc(n) 的请求</text>
<line class="fl" x1="330" y1="72" x2="330" y2="92" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern5As1)"/>
<rect class="bx" x="230" y="96" width="200" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="114" text-anchor="middle" font-size="13" fill="#2b2a26">glibc 调度机</text>
<text class="ts" x="330" y="132" text-anchor="middle" font-size="11" fill="#6b675e">拿 chunk 尺寸和阈值比</text>
<line class="fl" x1="280" y1="140" x2="170" y2="162" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern5As1)"/>
<text class="ts" x="196" y="146" text-anchor="middle" font-size="11" fill="#6b675e">阈值以下</text>
<line class="fl" x1="380" y1="140" x2="490" y2="162" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern5As1)"/>
<text class="ts" x="464" y="146" text-anchor="middle" font-size="11" fill="#6b675e">阈值以上</text>
<rect class="bx" x="30" y="166" width="270" height="58" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="165" y="188" text-anchor="middle" font-size="13" fill="#2b2a26">通道一 · brk 扩堆</text>
<text class="ts" x="165" y="208" text-anchor="middle" font-size="11" fill="#6b675e">推 [heap] 的终点，优先复用空闲 chunk</text>
<rect class="bx" x="360" y="166" width="270" height="58" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="495" y="188" text-anchor="middle" font-size="13" fill="#2b2a26">通道二 · mmap 独立段</text>
<text class="ts" x="495" y="208" text-anchor="middle" font-size="11" fill="#6b675e">新映射一段，munmap 整段归还</text>
<text class="ts" x="20" y="244" font-size="12" fill="#6b675e">多数请求连出口都到不了：tcache 和分箱在 glibc 内部就把它们消化了</text>
</svg>
</figure>

哪个请求走哪条通道？glibc 的默认阈值是 **128KiB**（`M_MMAP_THRESHOLD`）：小于阈值的请求从堆上切，优先复用空闲 chunk，不够就 brk 扩堆；大于阈值的直接 mmap。实测（分配 64K~2M 七档，看返回地址落在 `[heap]` 区间还是独立段）：

```text
第一轮（进程刚启动，默认阈值 128KiB）：
malloc  64KiB  → HEAP
malloc 100KiB  → HEAP
malloc 127KiB  → HEAP
malloc 129KiB  → HEAP   ← 边界比想象中宽
malloc 160KiB  → MMAP段
malloc 256KiB  → MMAP段
malloc 1024KiB → MMAP段
malloc 2048KiB → MMAP段
```

分界线在 129KiB~160KiB 之间，比 128KiB 的名义阈值略宽。glibc 的判断发生在 chunk 级（请求 + 16 字节头部 + 对齐，与阈值比较），且堆顶还有上次 brk 留下的余量可吃。精确边界随历史漂移，但「小走堆、大走 mmap」的结构清晰。

### 动态阈值：第二轮全部变卦

把上面七块全部 free，再原样分配一遍：

```text
第二轮（释放过 2MiB 的 mmap 块之后）：
malloc  64KiB  → HEAP
malloc 127KiB  → HEAP
malloc 160KiB  → HEAP   ← 上一轮走 MMAP
malloc 256KiB  → HEAP   ← 上一轮走 MMAP
malloc 1024KiB → HEAP   ← 上一轮走 MMAP
malloc 2048KiB → HEAP   ← 上一轮走 MMAP
```

七档全部改走 heap，连 2MiB 都不例外，heap 从 424KiB 一路长到 4040KiB。

原因是 glibc 的**动态阈值**：释放一个 mmap 来的大块时，分配器把阈值抬到刚释放的块大小（上限 32MiB，`DEFAULT_MMAP_THRESHOLD_MAX`）。逻辑是纯经验的：刚刚那个尺寸 mmap 来又 mmap 走，说明这个尺码常见，改走堆、靠 arena 化复用更划算。副作用同样实测可见：释放 2MiB 块之后，阈值抬到 2MiB 档，之后**所有** 2MiB 以内的请求都涌向 heap，哪怕程序接下来一万次分配都只要一次 2MiB。第三轮实验里 1000 个 64KiB 把 heap 顶到 62.5MiB，就是阈值抬升后堆通道敞开吃进的例子。

两轮七档摆在一起：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="七档分配的两轮对照：第一轮 64K 到 129K 走 HEAP、160K 以上走 MMAP；中间释放过一次 2MiB 的 mmap 块后，第二轮八档全部改走 HEAP，连 2048K 都不例外" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一段代码跑两轮，中间只隔了一次 free(2MiB)</text>
<text class="ts" x="90" y="48" text-anchor="middle" font-size="11" fill="#6b675e">64K</text>
<text class="ts" x="160" y="48" text-anchor="middle" font-size="11" fill="#6b675e">100K</text>
<text class="ts" x="230" y="48" text-anchor="middle" font-size="11" fill="#6b675e">127K</text>
<text class="ts" x="300" y="48" text-anchor="middle" font-size="11" fill="#6b675e">129K</text>
<text class="ts" x="370" y="48" text-anchor="middle" font-size="11" fill="#6b675e">160K</text>
<text class="ts" x="440" y="48" text-anchor="middle" font-size="11" fill="#6b675e">256K</text>
<text class="ts" x="510" y="48" text-anchor="middle" font-size="11" fill="#6b675e">1024K</text>
<text class="ts" x="580" y="48" text-anchor="middle" font-size="11" fill="#6b675e">2048K</text>
<text class="ts" x="20" y="78" font-size="12" fill="#6b675e">第一轮</text>
<rect class="bx-q" x="60" y="60" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="90" y="79" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="130" y="60" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="160" y="79" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="200" y="60" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="230" y="79" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="270" y="60" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="300" y="79" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-sick" x="340" y="60" width="60" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="370" y="79" text-anchor="middle" font-size="10" fill="#b03a2e">MMAP</text>
<rect class="bx-sick" x="410" y="60" width="60" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="440" y="79" text-anchor="middle" font-size="10" fill="#b03a2e">MMAP</text>
<rect class="bx-sick" x="480" y="60" width="60" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="510" y="79" text-anchor="middle" font-size="10" fill="#b03a2e">MMAP</text>
<rect class="bx-sick" x="550" y="60" width="60" height="30" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="580" y="79" text-anchor="middle" font-size="10" fill="#b03a2e">MMAP</text>
<text class="ts" x="20" y="126" font-size="12" fill="#6b675e">第二轮</text>
<rect class="bx-q" x="60" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="90" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="130" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="160" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="200" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="230" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="270" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="300" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="340" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="370" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="410" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="440" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="480" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="510" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<rect class="bx-q" x="550" y="108" width="60" height="30" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="580" y="127" text-anchor="middle" font-size="10" fill="#6b675e">HEAP</text>
<text class="ts" x="20" y="166" font-size="12" fill="#6b675e">free 掉一个 2MiB 的 mmap 块，阈值就地抬到 2MiB：后四档全部变卦</text>
<text class="ts" x="20" y="188" font-size="12" fill="#6b675e">上限 32MiB：再大的块释放多少次，阈值也停在那里</text>
</svg>
</figure>

glibc 的堆和 pymalloc 用的机制高度相似：内部同样按尺寸分箱（fastbins/smallbins/largebins）、同样有 tcache（每线程缓存，free 的 chunk 先进缓存不下沉）、同样把释放的 chunk 留作复用而不是归还。`malloc_trim(0)` 才是把堆顶空余还给内核的显式动作。CPython 那篇里「显式调用 malloc_trim 后大对象场景 RSS 才回落」的现象，机制就在这里：trim 之前，那些页在 glibc 手里打转；trim 之后，brk 收缩，VMA 变短，未触碰的尾页连同页表一起消失。而 trim 只能还**堆顶**的连续空区，堆中间的洞（第三篇钉子实验的用户态版本）谁也还不掉，除非整块是 mmap 来的。

trim 能还的和还不了的：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 194" role="img" aria-label="malloc_trim 前后对照：堆由在用段、中间的洞、在用段和堆顶空余组成；trim 之后 brk 收缩，堆顶空余整段归还内核，中间的洞因为不连着堆顶，谁也还不掉" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern5As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">trim 前：一条 [heap] VMA 的内部地形</text>
<rect class="bar" x="30" y="40" width="120" height="40" fill="#2b2a26"/>
<text class="onbar" x="90" y="64" text-anchor="middle" font-size="11" fill="#f6f3ec">在用</text>
<rect class="bx-gone" x="150" y="40" width="100" height="40" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="200" y="64" text-anchor="middle" font-size="11" fill="#6b675e">洞</text>
<rect class="bar" x="250" y="40" width="150" height="40" fill="#2b2a26"/>
<text class="onbar" x="325" y="64" text-anchor="middle" font-size="11" fill="#f6f3ec">在用</text>
<rect class="bx" x="400" y="40" width="230" height="40" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="515" y="64" text-anchor="middle" font-size="11" fill="#6b675e">堆顶空余</text>
<line class="fl" x1="615" y1="84" x2="615" y2="106" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern5As5)"/>
<text class="ts" x="605" y="100" text-anchor="end" font-size="11" fill="#6b675e">malloc_trim(0)</text>
<text class="ts" x="20" y="100" font-size="12" fill="#6b675e">trim 后：brk 收缩，VMA 变短</text>
<rect class="bar" x="30" y="112" width="120" height="40" fill="#2b2a26"/>
<rect class="bx-gone" x="150" y="112" width="100" height="40" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<rect class="bar" x="250" y="112" width="150" height="40" fill="#2b2a26"/>
<rect class="bx-gone" x="400" y="112" width="230" height="40" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="515" y="136" text-anchor="middle" font-size="11" fill="#6b675e">已归还</text>
<text class="tc" x="200" y="172" text-anchor="middle" font-size="12" fill="#b03a2e">洞还赖着：它不连着堆顶</text>
<text class="ts" x="20" y="190" font-size="12" fill="#6b675e">这就是 arena 化的全部动机：一段一空就整段 munmap，不给洞留位置</text>
</svg>
</figure>

## VMA：内核怎么登记地址区间

现在过边界，看内核怎么接。`brk` 和 `mmap` 落到内核，共同的操作对象是 **VMA（vm_area_struct）**：一段虚拟地址区间的描述，包括起点、终点、权限、背书（文件还是匿名）、标志。可以把它理解为「内存地图上的一行」：第 0 篇翻过的 `/proc/self/maps`，每行就是一个 VMA。第一篇说过「mmap 只画了 VMA」，它「我踩的坑」一节的护栏实验也还欠一句原理，这里一并还清。

一个进程的全部 VMA 挂在 mm_struct 的 maple 树上（v7.2 已是 maple tree，早期内核是红黑链表，又一个版本演进点），`/proc/<pid>/maps` 就是这份登记册的打印版。**VMA 是内核记账的最小单位，页表是它的细化**：VMA 说「7f2c..0000-7f2c..2000 可读写」，页表才说「其中哪些页真的存在」。一个 C 程序的 maps 只有 23 条；桌面环境里的飞书有 3818 条。差异来源后面细说。

### brk 为什么便宜：扩展现有 VMA

v7.2 的 `do_brk_flags()`（`mm/vma.c`）把 brk 的便宜写得很直白：

```c
if (vma && vma->vm_end == addr) {
        vmg.just_expand = true;
        if (vma_merge_new_range(&vmg))
                goto out;          /* 扩展现有 VMA，完事 */
}
/* 走到这里才分配新的 vm_area_struct */
vma = vm_area_alloc(mm);
```

堆顶扩展优先尝试**把现有 heap VMA 的终点往后挪**：改一个字段，不分配任何新结构、不碰页表。只有扩展不成立（比如撞上相邻映射）才走 `vm_area_alloc` 建新 VMA。这就是连续小 malloc 的全部内核成本：多数时候连一次 VMA 分配都没有，只是 heap VMA 的 `vm_end` 涨了几个 4KiB。对照 slab 篇：`vm_area_struct` 自己正是 slab 专用柜台（内核栈那种 UNMOVABLE 的常驻户）的货，每次分配都真实花内存，所以内核才这么执着于合并。

### 合并与分裂的六段实验

VMA 的核心性质是**同质区间自动归拢**：相邻、同权限、同背书、同标志的 VMA 合并成一条；任何一维不同就断开。六段实验逐段实测（maps 计数含程序自身 23 条基线；每行只看一个动作和 maps 的增减，其余数字不用盯）：

```text
A: 一整块 4MiB rw                    maps 23 → 24   （+1，新映射）
B: 中间 1MiB 改只读                  maps 24 → 26   （+2，一条分裂成三条）
C: 改回 rw                           maps 26 → 24   （-2，三条重新长拢）
D: 挖掉 512KiB 洞                    maps 24 → 25   （+1，洞两侧各断一次）
E2: 后半 1MiB madvise(DONTFORK)     maps 25 → 27   （+2，madvise 也分裂）
F: 两个不相邻的独立 1MiB             不变，各占一条
```

六段实验画成地址段：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 298" role="img" aria-label="六段 VMA 实验的地址段示意：A 一整块可读写占一条；B 中间改只读，一条分裂成三条；C 改回可读写，三条重新合并成一条；D 中段 munmap 挖洞，洞两侧各断一次；E2 后半段 madvise 后权限没变但 flags 不同，照样分裂成两条；F 两个不相邻的独立段各占一条不合并" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="110" y="32" font-size="12" fill="#6b675e">实验区的地址空间（A–E2 为同一段 4MiB 的六个瞬间）</text>
<text class="ts" x="640" y="32" text-anchor="end" font-size="12" fill="#6b675e">maps 增减</text>
<text class="ts" x="20" y="69" font-size="12" fill="#6b675e">A</text>
<rect class="bx-q" x="110" y="52" width="460" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="340" y="69" text-anchor="middle" font-size="11" fill="#6b675e">一整块 rw</text>
<text class="tc" x="640" y="69" text-anchor="end" font-size="12" fill="#b03a2e">+1</text>
<text class="ts" x="20" y="109" font-size="12" fill="#6b675e">B</text>
<rect class="bx-q" x="110" y="92" width="172" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="196" y="109" text-anchor="middle" font-size="11" fill="#6b675e">rw</text>
<rect class="bx-sick" x="282" y="92" width="116" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="340" y="109" text-anchor="middle" font-size="11" fill="#b03a2e">ro</text>
<rect class="bx-q" x="398" y="92" width="172" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="484" y="109" text-anchor="middle" font-size="11" fill="#6b675e">rw</text>
<text class="tc" x="640" y="109" text-anchor="end" font-size="12" fill="#b03a2e">+2</text>
<text class="ts" x="20" y="149" font-size="12" fill="#6b675e">C</text>
<rect class="bx-q" x="110" y="132" width="460" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="340" y="149" text-anchor="middle" font-size="11" fill="#6b675e">改回 rw：三条当场长拢回一条</text>
<text class="tc" x="640" y="149" text-anchor="end" font-size="12" fill="#b03a2e">−2</text>
<text class="ts" x="20" y="189" font-size="12" fill="#6b675e">D</text>
<rect class="bx-q" x="110" y="172" width="230" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="225" y="189" text-anchor="middle" font-size="11" fill="#6b675e">rw</text>
<rect class="bx-gone" x="340" y="172" width="58" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="369" y="189" text-anchor="middle" font-size="11" fill="#6b675e">洞</text>
<rect class="bx-q" x="398" y="172" width="172" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="484" y="189" text-anchor="middle" font-size="11" fill="#6b675e">rw</text>
<text class="tc" x="640" y="189" text-anchor="end" font-size="12" fill="#b03a2e">+1</text>
<text class="ts" x="20" y="229" font-size="12" fill="#6b675e">E2</text>
<rect class="bx-q" x="110" y="212" width="345" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="282" y="229" text-anchor="middle" font-size="11" fill="#6b675e">rw</text>
<rect class="bx" x="455" y="212" width="115" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="5 3"/>
<text class="ts" x="512" y="229" text-anchor="middle" font-size="10" fill="#6b675e">rw·DONTFORK</text>
<text class="tc" x="640" y="229" text-anchor="end" font-size="12" fill="#b03a2e">+2</text>
<text class="ts" x="20" y="269" font-size="12" fill="#6b675e">F</text>
<rect class="bx-q" x="110" y="252" width="115" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="167" y="269" text-anchor="middle" font-size="11" fill="#6b675e">1MiB</text>
<text class="ts" x="340" y="269" text-anchor="middle" font-size="11" fill="#6b675e">不相邻</text>
<rect class="bx-q" x="455" y="252" width="115" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="512" y="269" text-anchor="middle" font-size="11" fill="#6b675e">1MiB</text>
<text class="tc" x="640" y="269" text-anchor="end" font-size="12" fill="#b03a2e">0</text>
<text class="ts" x="20" y="292" font-size="12" fill="#6b675e">B、C 一对：分裂不是永久的，属性改回同质，下一次操作顺手就合回去</text>
</svg>
</figure>

四条规律，逐一说：

**B（mprotect 分裂）**：权限边界就是 VMA 边界。改一段的权限，内核把一条 VMA 拆成「前-rw / 中-ro / 后-rw」三条。这就是第一篇护栏实验的原理：PROT_NONE 的护栏页制造了权限差，实验区与邻居的 VMA 断开，smaps 才能给出干净的读数。

**C（重新合并）**：分裂不是永久的。把中间段改回 rw，三边的属性重新同质，内核当场合并回一条，maps 数回到 24。VMA 的合并是**惰性自愈**的：没有后台任务，是每次 mmap/munmap/mprotect 顺手尝试的 `vma_merge` 系列（`can_vma_merge_before/after` 检查六个维度：地址相邻、vm_flags、背书文件、偏移、匿名页链 anon_vma、策略）。伙伴系统的合并靠释放路径的循环升级，VMA 的合并靠操作路径的就地尝试，两个「自愈机制」的触发时机不同，哲学相同。

**E2（madvise 分裂）**：这条最反直觉。`madvise(DONTFORK)` 不改任何页权限（区段照样 rw），maps 却 +2。原因是 madvise 改的是 **vm_flags**（这个区间 fork 时不要复制），flags 不同即不可合并，一段被切出来。第一篇的 `MADV_NOHUGEPAGE`、第二篇的 `MADV_DONTNEED`、第三篇的 `MADV_HUGEPAGE` 全都有这个副作用：**给内核的每一条区间级建议，都以 VMA 边界为粒度记账**。这也解释了 maps 里那些 4KiB 见方的碎片段从哪来：某段内存吃过一次 madvise，边界就刻在那了。

**D（挖洞）**：munmap 中段留下两个新边界。结合 C 看：洞填不回来（除非重新映射同属性区间），但洞两侧若属性相同仍是连续的。`/proc/maps` 里那些首尾相接的同权限段，就是被历史操作切碎又部分长拢的地层。

### 3818 条 VMA 的飞书

有了上面的机制，真实进程的 maps 就能读了。23 条的 C 程序：代码段、数据段、动态链接器映射若干、heap、stack、以及 glibc/平台库的几十条映射。3818 条的飞书多了什么：每个共享库一条、V8/JSC 的堆多段、每条线程栈一段、mmap 来的大对象各一段、再加上无数 madvise/mprotect 切出来的边界。**maps 的行数是「地址空间破碎度」的直接读数**，和 RSS 是两个正交的维度。

这也是 `vm.max_map_count`（本机 1048576）存在的原因：VMA 不是免费的，每条约占 200 字节的 slab 内存加上 maple 树的节点，八条飞书就会到两万条量级。恶意或失控的进程可以用百万次 mmap 把自己撑到上限，内核在 `do_brk_flags` 开头就检查 `mm->map_count > get_sysctl_max_map_count()`，超限返回 ENOMEM。这个上限是自我保护，不是配额承诺。

## 从 malloc 到物理页：三层延迟

现在可以把开头那三行 `malloc(64)` 的日志解释全了。从用户态到内核，这块内存分三层欠着：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 274" role="img" aria-label="malloc 到物理页的三层延迟：第一层 glibc 的 tcache 里有空闲 chunk 就直接切给你，内核视角什么都没发生；第二层 chunk 不够才走 brk 或 mmap 扩 VMA，地址空间登记在册但页表没动；第三层第一次写的那一刻缺页，分配物理页填页表，内核这时才知道这一页" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern5As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<rect class="bx-q" x="30" y="36" width="420" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="50" y="58" font-size="13" fill="#2b2a26">第 1 层 · glibc 缓存</text>
<text class="ts" x="50" y="78" font-size="11" fill="#6b675e">tcache 里有空闲 chunk：直接切给你，不进内核</text>
<text class="tc" x="470" y="58" font-size="12" fill="#b03a2e">内核视角：</text>
<text class="tc" x="470" y="78" font-size="12" fill="#b03a2e">什么都没发生</text>
<line class="fl" x1="240" y1="92" x2="240" y2="112" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern5As4)"/>
<text class="ts" x="252" y="107" font-size="11" fill="#6b675e">chunk 不够了</text>
<rect class="bx" x="30" y="116" width="420" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="50" y="138" font-size="13" fill="#2b2a26">第 2 层 · brk / mmap</text>
<text class="ts" x="50" y="158" font-size="11" fill="#6b675e">扩 VMA：地址空间登记在册，页表没动</text>
<text class="ts" x="470" y="138" font-size="12" fill="#6b675e">内核视角：</text>
<text class="ts" x="470" y="158" font-size="12" fill="#6b675e">账上多了一行，家底没动</text>
<line class="fl" x1="240" y1="172" x2="240" y2="192" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern5As4)"/>
<text class="ts" x="252" y="187" font-size="11" fill="#6b675e">第一次写 *p</text>
<rect class="bx-sick" x="30" y="196" width="420" height="56" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="50" y="218" font-size="13" fill="#2b2a26">第 3 层 · 缺页</text>
<text class="ts" x="50" y="238" font-size="11" fill="#6b675e">分配物理页、填页表：真实家底到这一刻才动</text>
<text class="tc" x="470" y="218" font-size="12" fill="#b03a2e">内核视角：</text>
<text class="tc" x="470" y="238" font-size="12" fill="#b03a2e">现在才知道这一页</text>
<text class="ts" x="20" y="268" font-size="12" fill="#6b675e">开头三行日志正好对应三层：拿到地址（第 1 层）、堆没变（没到第 2 层）、页不存在（没到第 3 层）</text>
</svg>
</figure>

`malloc` 的「快」是把成本推给了未来：glibc 的缓存吃掉绝大多数调用的成本（第 1 层常驻），VMA 扩展几乎免费（第 2 层只有偶尔的 brk），物理内存按触碰逐页到账（第 3 层是缺页）。**三层欠账对应三种浪费**：tcache 里过期不还的 chunk（RSS 高位）、VMA 破碎（maps 膨胀）、触碰过的页的页表与物理页（真实的占用开销）。CPython 那篇的「对象死亡 ≠ RSS 下降」横跨这三层：对象死了进第 1 层的缓存，arena 空了仍在第 2 层的 VMA 里，只有整体 munmap 才同时清掉 2 和 3。

于是 pymalloc 的 arena 设计动机也清楚了：CPython 为什么不让小对象直接走 glibc 的堆？先补一句背景，pymalloc 是 CPython 的分配器，它把内存组织成一兆字节一个的「arena」，底层正是一次 `mmap`。答案在于：glibc 的堆（brk 通道）只还堆顶，小对象散布堆中，永远凑不齐「堆顶连续空区」。arena 化把「一 MiB 一 MiB 的 mmap 段」作为回收单位，整段空了就整段 munmap，**用第 2 层的粗粒度换第 1 层的可回收性**。这是用户态分配器对「brk 还不了中间的洞」的釜底抽薪。

## 我踩的坑

**void\* 指针算术，一段坑了两次。** `mmap(a0+(i<<20),...)` 里 a0 是 `void*`，C 标准没定义它的算术，GCC/clang 按 1 字节步长展开，i<<20 变成向上 4MiB 的**字节**偏移，mmap 拿到未对齐地址，MAP_FIXED 覆盖失败，段错误。同一个坑在挖洞那行又踩了一次。改成 `(uint8_t*)a0+(i<<20)` 才干净。写实验时总觉得 void\* 算术「能跑」，它跑起来的时候才是最危险的。

**MAP_FIXED 在这个沙箱里根本走不通。** 修正指针算术后 MAP_FIXED 仍然崩，本会话的沙箱禁止覆盖已有映射。VMA 实验整个换方案：预留大块 PROT_NONE，用 mprotect 分段切权限，效果等价（B 段实验就是这么来的）。约束下的替代路径往往更接近本质：mprotect 才是「纯权限边界」的最小实验。

**malloc_usable_size 拿野指针当探针。** 想读 glibc 的当前阈值，随手写了个 `malloc_usable_size((void*)8)`。这不是读取器，它解引用 chunk 头，8 这个地址没有 chunk，段错误，核心转储。glibc 没有暴露「读当前动态阈值」的接口（mallopt 只能写），想看阈值只能像本文这样用分配行为反推。野指针不挑时候，一出手就是核心转储。

**strace 不在，别的都得在。** 追系统调用序列的第一反应是 strace，本机没装。好在 brk/mmap 的效果全部可以从 `/proc/self/maps` 和 `[heap]` 区间反推，本文的实验全靠这两个无特权观测点。这又是第四篇的老教训：先把观测点盘一遍，再设计实验。

## 地址层的结论

malloc 是 glibc 里的一台调度机：小请求走 brk 扩堆、大请求走独立 mmap，tcache 和分箱把绝大多数调用挡在内核之外；阈值 128KiB 起步，随大块的释放动态抬升（上限 32MiB），所以同一行 `malloc(256<<10)` 在同一进程的不同时刻走的是不同通道。brk 便宜在扩展：`do_brk_flags` 优先挪现有 VMA 的终点，多数堆增长不产生任何新内核结构；VMA 是内核地址记账的最小单位，约 200 字节一条，住在 slab 柜台上，这就是 max_map_count 上限和内核执着于合并的原因。VMA 是活的：同质则合，异质则裂。mprotect 切出权限边界，一条变三条，改回去当场长拢；madvise 不改页权限也能切，vm_flags 是合并的独立维度；munmap 挖的洞靠重新映射才能填。maps 的行数是地址空间破碎度的直接读数，飞书 3818 条对 C 程序 23 条。而「malloc 返回了，内核还不知道」的完整含义是三层延迟：glibc 缓存吃掉调用成本、VMA 登记地址范围、缺页才动真实的家底。三层各有各的浪费，也各有各的回收路径：`malloc_trim` 只还堆顶、munmap 整段清除、arena 化用粗粒度换可回收性。

三层里，第三层（触碰、缺页、真实占用）四篇前就拆完了，这一篇补上的是前两层：调度机的缓存与地址空间的登记。地址层至此收束。系列开头立过的账，还剩两笔在「释放」那一头：write() 返回后数据赖在 page cache 里的账，和内存见底时那道最后的保险丝。

下一篇：《write() 返回了，数据还在内存里：page cache 与脏页回写》，顺便把 Redis everysec 丢失窗口的最后一段补完。
