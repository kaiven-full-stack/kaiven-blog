---
title: 内核的 pymalloc：slab、slub 与对象缓存
description: 6 万个文件删完，dentry 总数一秒回落；8000 个进程生死，SUnreclaim 只起 ±1MB 涟漪。本文拆开内核的小对象柜台：kmem_cache 与 size class、per-CPU 无锁快路径、partial 链与 min_partial 的整页归还条件；三组实验记下对象缓存的三种命运，立即回落、滞留复用、脉冲回稳，并与 pymalloc 的 block/pool/arena 逐层对照：同一道题，内核多交了「并发」与「回收」两份答卷。实测于 Linux 7.2.3，源码对照 vanilla v7.2。
pubDate: 2026-09-10
category: kernel
tags: [Linux, 内核, 内存管理]
---

第三篇结尾留了一个柜台没开：伙伴系统最小出货规格是一整页 4KiB，但内核自己充满了几十、几百字节的需求，dentry（文件名的缓存条目：每个被查过的文件名占一个）、inode（文件的元数据档案：大小、权限、时间戳都在里面）、task_struct（进程自身的档案）、页表页、各种哈希节点。每个结构体撕一页是灾难：内部碎片直接失控。用户态对这道题的答案是 pymalloc，CPython 系列已经拆过；内核的答案叫 slab 分配器，如今的具体实现是 SLUB。这一篇拆它，并且全程与 pymalloc 对照着读，两者像到可以互相验证，又在不同维度上各自越界。（前置概念见[《第 0 篇》](/posts/kernel-primer/)。）

实验环境沿用系列惯例：Linux 7.2.3，AMD Zen 2，源码对照 vanilla v7.2 tag。开工先撞上一堵墙，墙本身就是第一课：`/proc/slabinfo` 在这台机器上 `-r--------`，root 才能读；连 `/sys/kernel/slab/dentry/object_size` 这种属性文件也无特权不可读。这是本系列第二次撞上同一堵墙：第一篇 pagemap 的 PFN 被静默清零，这次是 slabinfo 和 sysfs 属性，同样在收紧物理内存布局信息，防的都是 Rowhammer 一类攻击。所以本文的观测工具降级为三个无特权可读的观测点：`/proc/sys/fs/dentry-state`（dentry 总数与 unused 数）、`/proc/meminfo` 的 `Slab/SReclaimable/SUnreclaim`、以及实验自身的行为。够用，而且逼出了更干净的实验设计。

## 柜台：kmem_cache 和 size class

slab 的核心抽象是 `kmem_cache`：一种对象的专属柜台。dentry 有自己的 cache，task_struct 有自己的，kmalloc 是一组按尺寸分档的通用柜台。每个 cache 有名字、对象大小、对齐、每页放多少个对象。pymalloc 的 size class 思想原样出现在这里，只是粒度更粗：pymalloc 从 16 到 512 字节切 32 档，slab 的通用档位按 2 的幂走：

```c
const struct kmalloc_info_struct kmalloc_info[] __initconst = {
        INIT_KMALLOC_INFO(96, 96),
        INIT_KMALLOC_INFO(192, 192),
        INIT_KMALLOC_INFO(8, 8),
        INIT_KMALLOC_INFO(16, 16),
        INIT_KMALLOC_INFO(32, 32),
        ...
        INIT_KMALLOC_INFO(2097152, 2M)
};
```

8 字节到 2MiB 的幂次序列，外加 96 和 192 两档特招。没有它们，97~128 字节的请求全要取整到 128，插这两档把最常见的「略超过 96」区间省下来。pymalloc 的 32 档精细是因为 Python 对象尺寸千奇百怪；slab 通用档粗，因为专用 cache 才是主力，需要高频分配的结构体干脆自建柜台，对象大小就是柜台大小，零取整损耗。**通用档给「偶发、尺寸不定」的分配兜底，专用柜台服务「高频、尺寸固定」的主力**。这个分工 pymalloc 也有影子：类型自己的 freelist 对 slub 的专用 cache。

通用柜台的档位排开：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 182" role="img" aria-label="kmalloc 通用档位：8、16、32、64、96、128、192、256、512、1K 直到 2M，其中 96 和 192 是朱砂标出的特招档；90 字节的请求落进 96 档只浪费 6 字节，没有 96 档就得取整到 128 浪费 38 字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern4Ac3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">kmalloc 通用档：2 的幂打底，两档特招（朱砂框）</text>
<rect class="bx" x="20" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="42" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">8</text>
<rect class="bx" x="72" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="94" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">16</text>
<rect class="bx" x="124" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="146" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">32</text>
<rect class="bx" x="176" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="198" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">64</text>
<rect class="bx-sick" x="228" y="44" width="44" height="40" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="250" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">96</text>
<rect class="bx" x="280" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="302" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">128</text>
<rect class="bx-sick" x="332" y="44" width="44" height="40" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="354" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">192</text>
<rect class="bx" x="384" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="406" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">256</text>
<rect class="bx" x="436" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="458" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">512</text>
<rect class="bx" x="488" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="510" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">1K</text>
<text class="ts" x="562" y="69" text-anchor="middle" font-size="14" fill="#6b675e">…</text>
<rect class="bx" x="592" y="44" width="44" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="614" y="69" text-anchor="middle" font-size="12" fill="#2b2a26">2M</text>
<text class="ts" x="20" y="118" font-size="12" fill="#6b675e">例：90 字节的请求</text>
<line class="flc" x1="170" y1="112" x2="240" y2="90" stroke="#b03a2e" stroke-width="1.6" marker-end="url(#kern4Ac3)"/>
<text class="tc" x="250" y="118" font-size="12" fill="#b03a2e">落进 96 档，只浪费 6 字节</text>
<text class="ts" x="20" y="146" font-size="12" fill="#6b675e">没有 96 档，它得取整到 128、浪费 38 字节：特招的全部理由</text>
<text class="ts" x="20" y="168" font-size="12" fill="#6b675e">专用 kmem_cache 不进这排档位：柜台按对象定制，零取整损耗</text>
</svg>
</figure>

专用柜台还有一手：合并。尺寸相近、属性相同的 cache 可以共享底层 slab（`/sys/kernel/slab` 里那些 `:0000064` 伪目录名就是合并后的匿名柜台，本机无特权读不了内容，但目录名本身泄露了尺寸）。合并省内存，代价是失去隔离；带 `SLAB_NO_MERGE` 的柜台（比如涉及安全的）保持独立。

## 三级库存：per-CPU、partial、新页

柜台之下是库存。SLUB 把一张 slab 页（通常就是伙伴系统的一页，order-0，第三篇的货架在第四篇的第一个客户）分给某个 cache，切成 N 个对象，然后这张页在三种状态间流转。v7.2 `mm/slub.c` 的文件头注释把状态机写得很清楚，摘一段：

```text
   Slabs on node partial list have at least one free object. A limited number
   of slabs on the list can be fully free (slab->inuse == 0), until we start
   discarding them.
...
   - node partial slab:            SL_partial && !full && !frozen
   - full slab, not on any list:  !SL_partial &&  full && !frozen
```

分配走三级，`___slab_alloc()` 的骨架：

```c
object = get_from_partial(s, node, trynode_flags, ac);  /* 先找现成 */
if (object)
        goto success;
slab = new_slab(s, trynode_flags, ac->alloc_flags, node); /* 再开新页 */
```

第一级不在慢路径函数里，**per-CPU freelist 是内联在分配入口的快路径**：每个 CPU 持有一张「冻结」（frozen）的 slab，从它上面摘对象只是一次指针操作，无锁、无原子指令、无 cache line 弹跳。这是 SLUB 相对老 SLAB 的核心进化，也是它对 pymalloc 最大的超越：CPython 靠 GIL 天然单线程，pymalloc 的 usedpools 不用考虑竞争；内核上百个 CPU 同时分配，快路径必须无锁。快路径耗尽才进 `___slab_alloc`：从节点 partial 链表取一张半空的页，都没有就 `new_slab` 向伙伴系统要新页。

三级库存，一级一列：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 266" role="img" aria-label="SLUB 三级库存：第一级 per-CPU 冻结页是无锁快路径，对象从这里逐个摘走；耗尽后从第二级节点 partial 链表取半空的页；再没有才走第三级 new_slab 向伙伴系统要一张 order-0 新页切成对象" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern4As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="t" x="110" y="52" text-anchor="middle" font-size="13" fill="#2b2a26">第一级 · per-CPU 冻结页</text>
<text class="ts" x="110" y="70" text-anchor="middle" font-size="11" fill="#6b675e">快路径：无锁指针操作</text>
<rect class="bx-q" x="45" y="84" width="130" height="92" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bar" x="55" y="94" width="22" height="22" fill="#2b2a26"/>
<rect class="bar" x="85" y="94" width="22" height="22" fill="#2b2a26"/>
<rect class="bar" x="115" y="94" width="22" height="22" fill="#2b2a26"/>
<rect class="bar" x="145" y="94" width="22" height="22" fill="#2b2a26"/>
<rect class="bar" x="55" y="132" width="22" height="22" fill="#2b2a26"/>
<rect class="bx" x="85" y="132" width="22" height="22" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="115" y="132" width="22" height="22" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="145" y="132" width="22" height="22" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="110" y="196" text-anchor="middle" font-size="11" fill="#6b675e">对象从这里逐个摘走</text>
<line class="fl" x1="200" y1="120" x2="241" y2="120" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As1)"/>
<text class="ts" x="220" y="110" text-anchor="middle" font-size="10" fill="#6b675e">摘空了</text>
<text class="t" x="335" y="52" text-anchor="middle" font-size="13" fill="#2b2a26">第二级 · partial 链表</text>
<text class="ts" x="335" y="70" text-anchor="middle" font-size="11" fill="#6b675e">半空的页，排队等着被领走</text>
<rect class="bx" x="265" y="84" width="130" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bar" x="271" y="98" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="286" y="98" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="301" y="98" width="11" height="11" fill="#2b2a26"/>
<rect class="bx-q" x="316" y="98" width="11" height="11" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="331" y="98" width="11" height="11" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="346" y="98" width="11" height="11" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="361" y="98" width="11" height="11" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx" x="275" y="132" width="130" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bar" x="281" y="146" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="296" y="146" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="311" y="146" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="326" y="146" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="341" y="146" width="11" height="11" fill="#2b2a26"/>
<rect class="bar" x="356" y="146" width="11" height="11" fill="#2b2a26"/>
<rect class="bx-q" x="371" y="146" width="11" height="11" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="386" y="146" width="11" height="11" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1"/>
<text class="ts" x="335" y="196" text-anchor="middle" font-size="11" fill="#6b675e">这样的页排成一条链</text>
<line class="fl" x1="425" y1="120" x2="466" y2="120" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As1)"/>
<text class="ts" x="445" y="110" text-anchor="middle" font-size="10" fill="#6b675e">链上没了</text>
<text class="t" x="560" y="52" text-anchor="middle" font-size="13" fill="#2b2a26">第三级 · 伙伴系统</text>
<text class="ts" x="560" y="70" text-anchor="middle" font-size="11" fill="#6b675e">new_slab：要一张 order-0 新页</text>
<rect class="bx-q" x="495" y="84" width="130" height="92" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<line class="grid" x1="527" y1="84" x2="527" y2="176" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<line class="grid" x1="559" y1="84" x2="559" y2="176" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<line class="grid" x1="591" y1="84" x2="591" y2="176" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 3"/>
<text class="ts" x="560" y="134" text-anchor="middle" font-size="11" fill="#6b675e">切成 N 个对象</text>
<text class="ts" x="560" y="196" text-anchor="middle" font-size="11" fill="#6b675e">到这一级才惊动伙伴系统</text>
<text class="ts" x="20" y="232" font-size="12" fill="#6b675e">第一级内联在分配入口：命中就走完，连慢路径函数都不进</text>
<text class="ts" x="20" y="252" font-size="12" fill="#6b675e">深色格是在用对象，浅色格是空闲对象</text>
</svg>
</figure>

释放对称：对象回到 slab 的空闲链，多数情况不惊动任何锁。页的生命周期由 `__slab_free()` 收尾，全空时有一个熟悉的判断：

```c
if (unlikely(!new.inuse && n->nr_partial >= s->min_partial))
        goto slab_empty;
...
slab_empty:
        remove_partial(n, slab);
        discard_slab(s, slab);      /* 整页归还伙伴系统 */
```

**slab 页全空，且 partial 链上的页数已经够到 `min_partial`，页才会归还伙伴系统；不够数就留在链上当库存。** 这个条件和 pymalloc 那篇「arena 必须整体满足条件才能退还」几乎是同一句话：block 回 pool 只是复用，pool 全空回 arena 只是复用，arena 整体空闲才真正退租；对象回 slab 只是复用，slab 全空进 partial 只是库存，partial 够数后整页才真正退还。差一个对象，整页退不掉。arena 卡 1MiB，slab 卡 4KiB，第三篇的伙伴块卡 2MiB，同一个结构在三个尺度上反复出现。这是「页粒度库存 × 小对象需求」这道题的数学必然。

一张 slab 页的流转：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 258" role="img" aria-label="slab 页状态流转：new_slab 从伙伴系统拿到 order-0 页，挂在某个 CPU 上成为冻结页；对象摘空后转入节点 partial 链表；被 CPU 领走则回到冻结态；全空时若 partial 库存已够深就整页归还伙伴系统，库存不够则留下当预备" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern4As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="26" font-size="12" fill="#6b675e">一张 slab 页在三种状态之间流转</text>
<path class="fl" d="M410 96 C 390 52, 265 52, 248 92" fill="none" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As2)"/>
<text class="ts" x="328" y="48" text-anchor="middle" font-size="11" fill="#6b675e">被某个 CPU 领走，继续冻结</text>
<rect class="bx" x="20" y="96" width="120" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="80" y="120" text-anchor="middle" font-size="13" fill="#2b2a26">伙伴系统</text>
<text class="ts" x="80" y="140" text-anchor="middle" font-size="11" fill="#6b675e">order-0 的一页</text>
<line class="fl" x1="140" y1="124" x2="191" y2="124" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As2)"/>
<text class="ts" x="165" y="114" text-anchor="middle" font-size="10" fill="#6b675e">new_slab</text>
<rect class="bx-q" x="195" y="96" width="140" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="265" y="120" text-anchor="middle" font-size="13" fill="#2b2a26">冻结页 frozen</text>
<text class="ts" x="265" y="140" text-anchor="middle" font-size="11" fill="#6b675e">挂在某个 CPU 上</text>
<line class="fl" x1="335" y1="124" x2="386" y2="124" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As2)"/>
<text class="ts" x="360" y="114" text-anchor="middle" font-size="10" fill="#6b675e">对象摘空</text>
<rect class="bx" x="390" y="96" width="140" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="460" y="120" text-anchor="middle" font-size="13" fill="#2b2a26">partial 链表</text>
<text class="ts" x="460" y="140" text-anchor="middle" font-size="11" fill="#6b675e">半空页的库存</text>
<line class="fl" x1="430" y1="152" x2="430" y2="186" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As2)"/>
<text class="ts" x="420" y="174" text-anchor="end" font-size="10" fill="#6b675e">全空，库存已够深</text>
<line class="fl" x1="500" y1="152" x2="565" y2="186" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern4As2)"/>
<text class="ts" x="512" y="174" font-size="10" fill="#6b675e">全空，库存还不够</text>
<rect class="bx-sick" x="370" y="190" width="120" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="430" y="208" text-anchor="middle" font-size="12" fill="#2b2a26">整页归还</text>
<text class="ts" x="430" y="226" text-anchor="middle" font-size="10" fill="#6b675e">discard_slab</text>
<rect class="bx" x="525" y="190" width="125" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="587" y="208" text-anchor="middle" font-size="12" fill="#2b2a26">留在库存</text>
<text class="ts" x="587" y="226" text-anchor="middle" font-size="10" fill="#6b675e">防「刚还就借」的抖动</text>
<path class="fl" d="M370 212 L 80 212 L 80 158" fill="none" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#kern4As2)"/>
<text class="ts" x="200" y="206" text-anchor="middle" font-size="10" fill="#6b675e">回到货架</text>
<text class="ts" x="20" y="248" font-size="12" fill="#6b675e">流转兜兜转转，只有「整页归还」那一步真的碰伙伴系统</text>
</svg>
</figure>

## 实验：6 万个文件的三种命运

理论说完，看真实数字。tmpfs 上创建 6 万个文件（`/tmp` 是 tmpfs，纯内存文件系统，避开磁盘 IO 噪声），每个文件在内核里至少留下一个 inode 和一个 dentry，全部从 slab 柜台出货。下面的表重点盯两列：**dentry 总数**（缓存条目的生死）和 **SUnreclaim**（不可回收的内核内存），Slab 总量和 unused 列是配角：

```text
          dentry 总数   unused    Slab(kB)   SUnreclaim(kB)
S0 基线      177426     138457     684704       290628
S1 创建后    237430     138460     729184       335108   (+44.5MB)
S2 删除后    177430     138460     687576       293500   (+2.9MB)
S3 重建后    237431     138460     728732       334656
S4 再删除    177429     138460     689584       295508   (+4.9MB)
```

三段读数，三种命运，逐一拆开：

**命运一：立即回落。** S2 删除 6 万个文件，dentry 总数瞬间 -60000，一个不差。我原以为会看到 pymalloc 式的滞留（对象死了、楼还亮着），结果 dentry 直接消失。原因在 `d_delete()`：文件删除时如果 dentry 引用计数为 1（没有别的使用者），v7.2 的默认策略是**不把它转成负 dentry 缓存，直接释放**；`fs/dcache.c` 里那个策略开关 `dentry_negative_policy`（sysctl `/proc/sys/fs/dentry-negative`，本机为 0）控制的就是「删除时转负缓存还是立即释放」。pymalloc 对死亡对象是「先记账后归还、整楼清空才退租」，dcache 对独占 dentry 是「当场退房」。语义不同：dentry 是缓存，缓存项失效就该走；Python 对象是程序数据，回收要排队。

**命运二：残留在 min_partial。** dentry 计数归零了，Slab 却留下 +2.9MB（S2）。释放的 6 万个对象散在许多张 slab 页上，每页只要还有一个别家的对象，整页退不掉（`min_partial` 条件）；S4 残留涨到 +4.9MB，两轮循环的钉子越积越多，和 pymalloc 那篇「稀疏幸存者钉住 39 座 arena」是同款结构，尺度缩小一千倍。

**命运三：循环复用，峰值不涨。** S3 重建 6 万个文件，Slab 涨回 728MB，**没有超过 S1 的峰值 729MB**。第二循环的分配没有开新页，用的是第一轮留在 partial 链上的空对象：缓存的真正收益在 S2→S3 这一跳，min_partial 那 2.9MB「没退掉」的页，恰好是下一轮「不用再要」的库存。pymalloc 留最后一座全空 arena 防「刚还就借」的抖动，slab 留 `min_partial` 张空页防「刚 discard 就 new_slab」的抖动。同一笔保险费，两家都交，而且都交得心甘情愿。

两本账五个阶段，叠在同一条时间轴上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 286" role="img" aria-label="6 万文件实验的两条折线：上排 dentry 总数在 177426 与 237430 之间整齐起落，删除 6 万就回落 6 万；下排 SUnreclaim 在 290628kB 与 335108kB 之间起落，但删除后不回基线，残留从 +2.9MB 涨到 +4.9MB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<line class="grid" x1="100" y1="30" x2="100" y2="232" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="220" y1="30" x2="220" y2="232" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="340" y1="30" x2="340" y2="232" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="460" y1="30" x2="460" y2="232" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="580" y1="30" x2="580" y2="232" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<text class="t" x="20" y="36" font-size="13" fill="#2b2a26">dentry 总数</text>
<polyline class="curve-k" points="100,100 220,40 340,100 460,40 580,100" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="100" cy="100" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="220" cy="40" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="340" cy="100" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="460" cy="40" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="580" cy="100" r="3" fill="#b03a2e"/>
<text class="tc" x="340" y="128" text-anchor="middle" font-size="12" fill="#b03a2e">删 6 万就回落 6 万，一个不差</text>
<text class="t" x="20" y="166" font-size="13" fill="#2b2a26">SUnreclaim（kB）</text>
<polyline class="curve-k" points="100,230 220,170 340,226 460,171 580,223" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="100" cy="230" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="220" cy="170" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="340" cy="226" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="460" cy="171" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="580" cy="223" r="3" fill="#b03a2e"/>
<text class="tc" x="220" y="152" text-anchor="middle" font-size="12" fill="#b03a2e">涨的 44.5MB 全记在不可回收侧</text>
<text class="ts" x="100" y="252" text-anchor="middle" font-size="11" fill="#6b675e">S0 基线</text>
<text class="ts" x="220" y="252" text-anchor="middle" font-size="11" fill="#6b675e">S1 创建 6 万</text>
<text class="ts" x="340" y="252" text-anchor="middle" font-size="11" fill="#6b675e">S2 删除</text>
<text class="ts" x="460" y="252" text-anchor="middle" font-size="11" fill="#6b675e">S3 重建</text>
<text class="ts" x="580" y="252" text-anchor="middle" font-size="11" fill="#6b675e">S4 再删除</text>
<text class="tc" x="20" y="276" font-size="12" fill="#b03a2e">删除之后：dentry 当场退房，SUnreclaim 的页滞留 min_partial，残留 +2.9MB → +4.9MB</text>
</svg>
</figure>

还有一个分流细节：涨的 44.5MB 全记在 **SUnreclaim**，不是 SReclaimable。dentry cache 本身带 `SLAB_RECLAIM_ACCOUNT` 标志（`dcache.c:3475`），理论上记入可回收；但 tmpfs 的文件 inode（shmem_inode_cache）活着的文件是不可回收的，加上新建 dentry 在被引用期间也不可回收，这笔账大部分落在不可回收侧。记在哪一侧，按「对象当前是否可被丢弃重建」决定。这个细节现在不重要，到 OOM 篇会用上。

## 实验：查找不存在的文件，什么都没发生

dentry 缓存的经典故事是负 dentry：查找一个不存在的文件名，内核缓存「它不存在」这个事实，下次同名查找直接命中缓存、跳过整个文件系统查找。教科书还说负 dentry 会大量囤积、靠 LRU 慢慢收缩。实测：

```text
S0 基线        dentry=177458  unused=138501
S1 失败查找×6万 dentry=177463  unused=138504
S2 重复查找×6万 dentry=177462  unused=138504
```

**一个负 dentry 都没建。** 6 万次失败查找，dentry 总数几乎没有变化。这不是实验出错：`lookup_slow()`（`fs/namei.c`）里，查找失败返回 `-ENOENT` 前是否缓存负 dentry，取决于文件系统自己的 `->lookup` 回调；tmpfs（以及现代内核的多数路径）选择不缓存这种失败。`d_delete()` 的那个 sysctl 也佐证：连「删除时留负缓存」都默认关闭。负 dentry 的囤积叙事属于旧内核和大磁盘文件系统的年代；在 v7.2 的 tmpfs 上，「查无此名」就是查完即忘。

这组「零结果」实验我保留了整段：它推翻了我带着进实验的教科书预期。又一次，同一个结论换个版本就要重新核实。零结果同样是数据。

## 实验：8000 个进程的生死涟漪

最后把 dentry（可回收侧、缓存语义）和进程（不可回收侧、纯分配语义）对照。两轮各 4000 个短命进程（`/bin/true`），每个进程至少消耗一个 task_struct、一套页表页（第一篇量过 fork 的账）、一堆 kmalloc 临时对象：

```text
                 Slab(kB)   SReclaimable(kB)   SUnreclaim(kB)
S0 基线           685076        394052            291024
S1 4000 进程后     685964        394044            291920   (+0.9MB)
S1 +2s            686080        394040            292040
S2 4000 进程后     686196        394024            292172   (+1.1MB)
S2 +2s            686124        394024            292100   (回落)
```

8000 次进程生死，SReclaimable 一点没动，进程开销全部落在不可回收侧，与 dentry 实验的分流互相印证。SUnreclaim 只起 ±1MB 的涟漪随即回稳：释放的对象回到 per-CPU freelist 和 partial 链，绝大多数根本没有走到「向伙伴系统归还」那一步，下一批进程立刻复用。**slab 的库存深度（per-CPU + partial）天然是个减震器**：稳态负载下，进出柜台的对象流在内部就消化了，伙伴系统几乎感觉不到。这也解释了 Slab 那 685MB 为什么长期稳定：那是柜台的合理库存水位，不是泄漏。

涟漪的形状：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 184" role="img" aria-label="8000 个进程生死的 SUnreclaim 折线：从基线 291024kB 升到 292172kB 又微微回落，全程只有约 1MB 的涟漪，纵轴已放大" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">8000 个进程生死：SUnreclaim 只起 ±1MB 涟漪（纵轴已放大）</text>
<line class="axis" x1="60" y1="128" x2="600" y2="128" stroke="#6b675e" stroke-width="1.2"/>
<polyline class="curve-k" points="80,120 200,58 320,49 440,40 560,45" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="80" cy="120" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="200" cy="58" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="320" cy="49" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="440" cy="40" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="560" cy="45" r="3" fill="#b03a2e"/>
<text class="ts" x="80" y="146" text-anchor="middle" font-size="11" fill="#6b675e">S0 基线</text>
<text class="ts" x="200" y="146" text-anchor="middle" font-size="11" fill="#6b675e">4000 进程</text>
<text class="ts" x="320" y="146" text-anchor="middle" font-size="11" fill="#6b675e">+2s</text>
<text class="ts" x="440" y="146" text-anchor="middle" font-size="11" fill="#6b675e">再 4000</text>
<text class="ts" x="560" y="146" text-anchor="middle" font-size="11" fill="#6b675e">+2s 回稳</text>
<text class="ts" x="20" y="172" font-size="12" fill="#6b675e">爬升、平台、微落：全程发生在库存内部，整页归还那一步几乎没被触发</text>
</svg>
</figure>

## 对照总表：pymalloc × SLUB

四篇的对照在此收拢成一张表。读法：左列是 pymalloc 的概念，右列是 slub 的对应物，它们解决的是同一道题，**页粒度库存 × 小对象需求 × 碎片控制**：

| 维度 | pymalloc (CPython 3.14) | SLUB (Linux 7.2) |
| --- | --- | --- |
| 尺寸分档 | size class，16~512B 共 32 档 | 专用 kmem_cache + kmalloc 幂次档（96/192 特招） |
| 最小单位 | block（16B 起） | 对象（8B 起） |
| 复用容器 | pool 16KiB，单档专服 | slab 页 4KiB，单 cache 专服 |
| 整体归还 | arena 1MiB 全空才退 | 页全空且 partial ≥ min_partial 才退 |
| 防「刚还就借」 | 保留最后一座全空 arena | 保留 min_partial 张空页 |
| 并发 | GIL 天然单线程，无锁 | per-CPU 冻结页，无锁快路径 |
| 上游 | mmap（arena 层） | 伙伴系统（new_slab） |
| 回收 | 无 shrinker，只能等全空 | 可回收 cache 挂 shrinker，LRU 逐对象回收 |
| 观测 | `sys._debugmallocstats()`（root-only 的镜像处境：无特权也能用） | `/proc/slabinfo`、sysfs 属性全 root-only |

最深的差别在最后两行。**回收维度**：pymalloc 没有 shrinker（回收器，内存紧张时主动丢弃缓存内容腾地方的机制），内存紧张时它无能为力，只能等程序自己把对象删干净；slab 的可回收 cache（dentry、inode）挂着 shrinker，内存紧张时内核能逐个丢弃缓存对象、把页吐出来，代价是下次访问要重建。「缓存」和「数据」的分界线，就是「可丢弃重建」这五个字。**观测维度**的反讽也有趣：CPython 把 `_debugmallocstats` 留给所有用户，内核把 slabinfo 锁进 root。内核这样做的原因，是 slabinfo 里写着物理内存布局，那正是要防的信息。

## 我踩的坑

**三个观测点全被锁，实验设计被逼着重做。** 最初计划读 `/proc/slabinfo` 做逐 cache 差分，root-only。退到 `/sys/kernel/slab/*/`，属性文件同样不可读。最后落到 `dentry-state` + meminfo 两个全局观测点。全局读数噪声大（别的进程同时在动），对策是差分 + 大批量（6 万、8000 的量级让信号淹没噪声）+ 同一秒内完成。约束催生设计，这比「一切顺利」的实验可信，因为它被迫依赖的是任何机器都有的观测点。

**两轮实验预期全错，错得都有营养。** 负 dentry 那轮，我带着「失败查找会囤积负缓存」的教科书预期设计，结果是零，一路查到 tmpfs 的 lookup 回调才确认这是现代行为。dentry 删除那轮，我预期「删完滞留」，结果立即回落，查到 `d_delete` 的默认策略。两轮「失败」最后都成了文章里最有价值的部分。带着预测做实验是对的，预测错了不修正叙事是错的。

**`/usr/bin/time` 不存在。** 量 fork 成本第一反应写了 `/usr/bin/time -f`，Arch 系没装 GNU time，shell 内建 `time` 又不吃格式参数。改用 zsh 的 `time (…)` 包裹。小坑，但提醒了我这个系列的实验环境从头到尾是一台真实日用机，不是干净的实验室。

## slab 与 pymalloc 的差别在哪

slab 是内核的 pymalloc，结构同构到可以互译：size class 对 kmem_cache、pool 对 slab 页、arena 的整体退还条件对 `min_partial`，「差一个没自由，整块退不掉」在 4KiB、1MiB、2MiB 三个尺度上反复出现。slab 比 pymalloc 多答了两道附加题。一道是并发：per-CPU 冻结页的无锁快路径，CPython 用 GIL 逃掉的那道题。一道是回收：可回收 cache 挂 shrinker，内存紧张时逐对象吐出，pymalloc 无解的那道题。这两道题正是「内核态」和「用户态运行时」的分界线。缓存的命运也不只有「滞留」一种叙事：dentry 删除即回落（缓存语义，失效即走）、负 dentry 查完即忘（现代默认）、min_partial 残留是库存（稳态水位）。三组实验拆掉了我带进来的单一叙事，「对象死了内存不还」只是三种命运之一，且在 v7.2 的 dcache 上恰好是最不典型的那种。最后，SReclaimable 与 SUnreclaim 的分流按「可否丢弃重建」记：dentry 与 inode 挂 shrinker 可回收，task_struct、页表、kmalloc 不可回收。这个分流平时只是字段细节，内存紧张时就是生死线，shrinker 先救可回收侧，救不动才轮到 OOM。

四篇走下来，内存管理从页表到伙伴系统再到 slab，一直停在「分配」这一侧。释放的另一头还有没讲的部分：`free()` 归还的页进了 LRU 链表，被标记为可回收，却要等到内存真正紧张时才有人来收，那里站着 shrinker、水位和最后的裁判。这个故事留到系列的末尾。

下一篇先收束地址层：《malloc 返回了，内核还不知道：brk、mmap 与 VMA》。
