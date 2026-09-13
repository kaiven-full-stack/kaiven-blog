---
title: 写一个字节，复制一整页：缺页异常与写时复制
description: fork 返回的那一刻，三页私有内存全部变成共享，代价是零；父进程往其中一页写一个字节，内核才复制出一页新的。本文沿 do_wp_page 的三岔路口走完写缺页全程：fork 的只读化、独占页的免复制、零页转正、子进程退出后页的归属翻回，并实测检验「透明大页把写时复制放大 512 倍」在今天是否还成立。正文实测于 Linux 7.2.3，并考古 v4.19 与 v5.15 两份历史源码。
pubDate: 2026-09-10
category: kernel
tags: [Linux, 内核, 内存管理]
---

上一篇看完了地图：四级页表、零页、soft-dirty 的两层记录。但 `mmap` 只画 VMA，真正把领土搬来的是缺页异常。这一篇走进缺页，看一次写的完整旅程，以及它最著名的变体：fork 之后，写一个字节，复制一整页。读完你会知道 fork 后写一个字节内核实际做了哪几步、为什么第二次写同一位置不再缺页，以及透明大页到底会不会把复制放大 512 倍。虚拟地址和页的前置概念在[《第 0 篇》](/posts/kernel-primer/)。

这也是 Redis 系列那篇快照文章真正欠的账。当时说「fork 复制的是地图，不是领土」，又说「写时复制按页记账，不按 Redis 键」，还引用了官方文档「透明大页会把一次 4KB 的复制放大成 2MB」。这一篇用实验把这三句话全部拆到内核源码级，其中第三句，会被这台机器上的实测直接推翻。

实验环境与上一篇相同：Linux 7.2.3，AMD Zen 2，源码对照 vanilla v7.2 tag。本篇还额外对照了 v4.19 与 v5.15 两份历史源码，因为写时复制的行为在 5.x 期间发生过一次不声不响的重写，而大量流传的文档至今还停留在重写之前。

## fork 改的是权限

这一节用到的观测工具先交代一句：smaps（`/proc/self/smaps`）是进程内存的逐页细账，其中 `Private_Dirty` 记「只有本进程在写」的页，`Shared_Dirty` 记「与别的进程共享着」的页。fork 之后父子共用的页，就记在后者里。

上一篇的三页实验里，写过的页 `exclusive=1`。那是本篇的关键道具：`PageAnonExclusive`，内核在页描述符上维护的「独占」标志，意思是这页匿名内存只被一个进程映射。fork 对它做的事情，v7.2 `mm/memory.c` 的 `__copy_present_ptes()` 一段注释说得明明白白：

```c
/* If it's a COW mapping, write protect it both processes. */
if (is_cow_mapping(src_vma->vm_flags) && pte_write(pte)) {
        wrprotect_ptes(src_mm, addr, src_pte, nr);   /* 父进程的 PTE 改只读 */
        pte = pte_wrprotect(pte);                    /* 子进程的副本也只读 */
}
```

fork 复制页表时，对每一个可写的私有页做两件事：**父进程的 PTE 就地改成只读，子进程的新 PTE 也写成只读**。物理页不动，内容零复制，引用计数各加一，原来的一页现在两个进程都只读地指着。

实验记录了这一步。区域里 A、B、C 三页 fork 前写过（独占），D 页只读过（还在零页上），E、F 从未触碰。fork 前后的读数：

```text
== T0 fork 前 ==
Rss=12kB  Shared_Dirty=0kB   Private_Dirty=12kB   A/B/C exclusive=1

== T1 fork 后（什么都没写，父子两边） ==
父：Rss=12kB  Shared_Dirty=12kB  Private_Dirty=0kB   A exclusive=0
子：Rss=12kB  Shared_Dirty=12kB  Private_Dirty=0kB   A exclusive=0
```

三个数字同时翻转：私有清零，共享全额，`exclusive` 灭灯。注意 **Rss 一页没多**，fork 没有分配任何数据页。上一篇量过 fork 的真实成本在页表（512:1），这一步只是把双方的写权限没收了。私有财产充公成共同财产，只需要改地图上的旗子，不需要搬任何东西。

换旗子的现场：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 332" role="img" aria-label="fork 前后对照：T0 父进程的可写 PTE 独占指向 A B C 三个物理页；T1 fork 后父与子的 PTE 都变成只读，双双指向同一批物理页，页的引用计数各加一，内容零复制" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern2As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="28" font-size="12" fill="#6b675e">T0 · fork 前：独占，可写</text>
<rect class="bx" x="60" y="40" width="150" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="135" y="62" text-anchor="middle" font-size="13" fill="#2b2a26">父进程</text>
<text class="ts" x="135" y="82" text-anchor="middle" font-size="11" fill="#6b675e">PTE：A/B/C 可写</text>
<line class="fl" x1="210" y1="68" x2="296" y2="68" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As1)"/>
<rect class="bx-q" x="300" y="40" width="44" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="322" y="72" text-anchor="middle" font-size="13" fill="#2b2a26">A</text>
<rect class="bx-q" x="356" y="40" width="44" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="378" y="72" text-anchor="middle" font-size="13" fill="#2b2a26">B</text>
<rect class="bx-q" x="412" y="40" width="44" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="434" y="72" text-anchor="middle" font-size="13" fill="#2b2a26">C</text>
<text class="ts" x="470" y="62" font-size="12" fill="#6b675e">三页 exclusive=1；</text>
<text class="ts" x="470" y="80" font-size="12" fill="#6b675e">D 还在零页，E、F 没有 PTE</text>
<text class="ts" x="20" y="156" font-size="12" fill="#6b675e">T1 · fork 后：双方只读，同一批页</text>
<rect class="bx" x="60" y="168" width="150" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="135" y="186" text-anchor="middle" font-size="13" fill="#2b2a26">父进程</text>
<text class="ts" x="135" y="204" text-anchor="middle" font-size="11" fill="#6b675e">PTE：只读</text>
<rect class="bx" x="60" y="236" width="150" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="135" y="254" text-anchor="middle" font-size="13" fill="#2b2a26">子进程</text>
<text class="ts" x="135" y="272" text-anchor="middle" font-size="11" fill="#6b675e">PTE：只读</text>
<line class="fl" x1="210" y1="190" x2="296" y2="208" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As1)"/>
<line class="fl" x1="210" y1="258" x2="296" y2="240" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As1)"/>
<rect class="bx-q" x="300" y="196" width="44" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="322" y="228" text-anchor="middle" font-size="13" fill="#2b2a26">A</text>
<rect class="bx-q" x="356" y="196" width="44" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="378" y="228" text-anchor="middle" font-size="13" fill="#2b2a26">B</text>
<rect class="bx-q" x="412" y="196" width="44" height="56" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="434" y="228" text-anchor="middle" font-size="13" fill="#2b2a26">C</text>
<text class="ts" x="470" y="216" font-size="12" fill="#6b675e">引用计数各 +1</text>
<text class="ts" x="470" y="234" font-size="12" fill="#6b675e">内容零复制</text>
<text class="ts" x="20" y="316" font-size="12" fill="#6b675e">Private_Dirty 12kB→0，Shared_Dirty 0→12kB：旗子换了，领土一步没搬</text>
</svg>
</figure>

`PageAnonExclusive` 在这一刻也一并清除。fork 的复制路径 `copy_present_ptes()` 里还有一行值得读：

```c
VM_WARN_ON_FOLIO(PageAnonExclusive(page), folio);
```

复制到子进程时，如果页还标着独占，内核直接警告。按 invariant，只要有两个映射者，独占标志就不许存在。下一节的主角就是这个标志。

## 写一个字节的完整旅程

现在父进程执行 `B[8] = 2`。CPU 拿着虚拟地址去查 TLB，查到的 PTE 只读；写权限违反，MMU 抛出缺页异常（x86 术语 #PF，error code 带着写标志位），CPU 陷入内核。这条路最终走到 `mm/memory.c` 的 `do_wp_page()`，写时复制的三岔路口。先别管函数名，三条岔路本身都很好懂：

**岔口一：这页是不是其实归我独占？**

```c
if (folio && folio_test_anon(folio) &&
    (PageAnonExclusive(vmf->page) || wp_can_reuse_anon_folio(folio, vma))) {
        if (!PageAnonExclusive(vmf->page))
                SetPageAnonExclusive(vmf->page);
        ...
        wp_page_reuse(vmf, folio);   /* 不复制，直接把 PTE 改回可写 */
        return 0;
}
```

独占页写缺页，是个误会：页分明只有我一个映射者，只读纯粹是历史遗留（比如被 `mprotect` 改过）。内核把 PTE 改回可写，故障地址重执行，完事。**一次复制都不发生。**

**岔口二：真的共享了。** 源码在这里留了一句少见的叹息：

```c
/*
 * Ok, we need to copy. Oh, well..
 */
return wp_page_copy(vmf);
```

`wp_page_copy()` 分配一页新内存，把旧页 4096 字节全部拷贝过去，父进程的 PTE 改指新页、恢复可写，旧页引用计数减一。旧页剩下的部分交给别人：子进程还指着它，它从「父子共享」降级成「仅子进程可见」，在子的 smaps 里，它从 Shared 转回 Private。

新页带着 `PageAnonExclusive` 出生。**写时复制的本质是私有化：不是「修改共享页」，而是「抄一份只属于自己的」**。旧页在新页诞生那一刻起，与父进程再无关系。

**岔口三：共享的这页是零页。** `wp_page_copy()` 开头有个判断：

```c
pfn_is_zero = is_zero_pfn(pte_pfn(vmf->orig_pte));
new_folio = folio_prealloc(mm, vma, vmf->address, pfn_is_zero);
if (!pfn_is_zero)
        __wp_page_copy_user(&new_folio->page, vmf->page, vmf);  /* 真复制 */
```

上一篇见过：匿名映射读缺页落在全内核共享的零页上。现在写它，`pfn_is_zero` 命中，新页本来就以清零页分配（`need_zero`），**拷贝这一步直接跳过**。抄一页全零的内容没有意义，零页转正的成本只有「分配一页」，不含「复制一页」。

三条岔路摆在一张图上：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="do_wp_page 三岔路口：写缺页进来后先问页是否归自己独占，独占就走 reuse 把 PTE 改回可写零复制；真的共享就走 wp_page_copy 分配新页拷贝 4096 字节；共享的是零页则分配新页但跳过拷贝" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern2As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">写缺页走到 do_wp_page：先看这页的归属，再定价</text>
<rect class="bx-q" x="220" y="36" width="220" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">写缺页 · do_wp_page</text>
<line class="fl" x1="270" y1="76" x2="130" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As2)"/>
<line class="fl" x1="330" y1="76" x2="330" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As2)"/>
<line class="fl" x1="390" y1="76" x2="530" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As2)"/>
<rect class="bx" x="20" y="120" width="210" height="88" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="125" y="144" text-anchor="middle" font-size="13" fill="#2b2a26">岔口一 · 本就独占</text>
<text class="ts" x="125" y="166" text-anchor="middle" font-size="11" fill="#6b675e">reuse：PTE 改回可写</text>
<text class="ts" x="125" y="184" text-anchor="middle" font-size="11" fill="#6b675e">零复制、零新页</text>
<rect class="bx-sick" x="245" y="120" width="210" height="88" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="350" y="144" text-anchor="middle" font-size="13" fill="#2b2a26">岔口二 · 真的共享</text>
<text class="ts" x="350" y="166" text-anchor="middle" font-size="11" fill="#6b675e">分配新页，拷满 4096 字节</text>
<text class="ts" x="350" y="184" text-anchor="middle" font-size="11" fill="#6b675e">PTE 指新页，旧页计数 −1</text>
<rect class="bx" x="470" y="120" width="170" height="88" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="555" y="144" text-anchor="middle" font-size="13" fill="#2b2a26">岔口三 · 零页</text>
<text class="ts" x="555" y="166" text-anchor="middle" font-size="11" fill="#6b675e">分配新页，跳过拷贝</text>
<text class="ts" x="555" y="184" text-anchor="middle" font-size="11" fill="#6b675e">抄全零没有意义</text>
<text class="ts" x="20" y="248" font-size="12" fill="#6b675e">三条岔路的 minflt 都 +1，价钱却分三档：改一个权限位、分配加拷贝、只分配</text>
</svg>
</figure>

## 一页的一生：完整时间线

把三岔路口讲完，实验时间线可以逐段核对了。观察用三处读数：pagemap 的 `exclusive` 位、smaps 的 `Shared/Private_Dirty`、`/proc/self/stat` 的第 10 字段 `minflt`（累计次缺页数。第 0 篇说过缺页是内核补发货的正常流程，这个数就是补发货的总次数；TLB miss 走硬件不算，只有真的陷入内核才算）。下面每段实验，重点盯 **minflt 的增量**和 **Shared、Private 两列之间的搬运方向**：

**T2：只读共享页，什么都不会发生。**

```text
父进程读 A（fork 后共享）：
minflt +0   Shared_Dirty 不变   exclusive 不变
```

只读一个双方都只读的页，权限毫无冲突，硬件直接执行。读共享页是免费的。

**T3：写 B 第一次，写时复制。**

```text
写 B 一个字节：minflt 131 -> 132 (+1)
Shared_Dirty 12kB -> 8kB    Private_Dirty 0kB -> 4kB
B：exclusive 0 -> 1
```

一次缺页，一页新内存，4kB 从 Shared 列搬到 Private 列。三岔口走了第二条岔。

**T4：写 B 第二次，免复制通行证。**

```text
再写 B 三个字节：minflt 132 -> 132 (+0)
账本完全不变
```

B 已经 `PageAnonExclusive`，三岔口第一条岔：PTE 早就可写，硬件直接执行，连内核都不用进。**一次 4KiB 的写时复制，买断的是这一页今后所有的写。**

**T5：写 D，零页转正，折扣价。** `minflt +1`，D 转独占，走的是岔口三：分配但不拷贝。上一篇只看到「零页转正」的结果，这一篇补上了它走的路：`wp_page_copy` 的 `need_zero` 快速通道。

**T6：写 E，fork 前从未触碰的页。** `minflt +1`。它根本没经历过 fork 的只读化（当时 `present=0`，没有 PTE 可改），fork 后第一次写，走的是普通匿名页写缺页：直接分配清零页，无旧页可抄。**fork 的「写时复制」只发生在 fork 时已存在的页上**。Redis 快照期间父进程新写入的键走的是这条路，所以那篇实验里「新增键」组的 `rdb_last_cow_size` 几乎不动：它们从不共享，无页可复制。

**T2b：子进程写 C，对面的读数。**

```text
子进程写 C 后：Shared_Dirty=4kB  Private_Dirty=8kB
```

子进程自己 COW 了 C（4kB），但 Private 是 8kB。多出的 4kB 正是父进程 T3 里 COW 走掉的那个 B 旧页：父进程不再指它，它如今只被子进程映射，在子的账里自动转回 Private。**COW 是对称的：父进程每私有化一页，子进程账下也多一页私有**（旧页）。没有谁通知子进程，引用计数减一的那一刻，它就独占了。

**T7：子进程退出。**

```text
子进程退出后，父进程账本：
Rss=20kB  Shared_Dirty=0kB  Private_Dirty=20kB   A/B/C exclusive=1
```

五个页（A、C 的旧页、B 的新页、D、E）全部翻回私有。子进程退出释放地址空间，它映射的页引用计数减一；减到只剩父进程一个持有者的页，重新点亮 `PageAnonExclusive`。不经过任何缺页，不搬任何数据，纯粹是引用计数到 1 时顺手翻的账。Rss=20kB 恰好对得上：三次 COW/分配（B、D、E）加两页回流的旧页（A、C）。

父子两本账，从 T1 到 T7：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="父子两本 smaps 账的条形对照：T1 fork 后双方 Shared_Dirty 都是 12kB；T3 父进程写 B 后变成共享 8kB 私有 4kB，子进程写 C 后变成共享 4kB 私有 8kB，其中多出的 4kB 是父进程不要的 B 旧页；T7 子进程退出，父进程私有涨到 20kB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="20" y="40" font-size="13" fill="#2b2a26">父进程的账</text>
<text class="ts" x="20" y="68" font-size="11" fill="#6b675e">T1 fork 后</text>
<rect class="bx" x="20" y="74" width="120" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="146" y="86" font-size="11" fill="#6b675e">共享 12kB</text>
<text class="ts" x="20" y="110" font-size="11" fill="#6b675e">T3 写 B（缺页 +1）</text>
<rect class="bx" x="20" y="116" width="80" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="100" y="116" width="40" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="146" y="128" font-size="11" fill="#6b675e">8 + 4</text>
<text class="ts" x="20" y="152" font-size="11" fill="#6b675e">T7 子进程退出</text>
<rect class="bx-sick" x="20" y="158" width="200" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="226" y="170" font-size="11" fill="#6b675e">私有 20kB</text>
<line class="axis" x1="320" y1="28" x2="320" y2="184" stroke="#6b675e" stroke-width="1" stroke-dasharray="4 3"/>
<text class="t" x="350" y="40" font-size="13" fill="#2b2a26">子进程的账</text>
<text class="ts" x="350" y="68" font-size="11" fill="#6b675e">T1 fork 后</text>
<rect class="bx" x="350" y="74" width="120" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="476" y="86" font-size="11" fill="#6b675e">共享 12kB</text>
<text class="ts" x="350" y="110" font-size="11" fill="#6b675e">T2b 写 C（缺页 +1）</text>
<rect class="bx" x="350" y="116" width="40" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="390" y="116" width="80" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="476" y="128" font-size="11" fill="#6b675e">4 + 8</text>
<rect class="bx-gone" x="350" y="152" width="140" height="20" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="420" y="166" text-anchor="middle" font-size="11" fill="#6b675e">已退出，页回流</text>
<rect class="bx" x="20" y="196" width="12" height="12" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="38" y="206" font-size="11" fill="#6b675e">Shared_Dirty</text>
<rect class="bx-sick" x="150" y="196" width="12" height="12" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/>
<text class="ts" x="168" y="206" font-size="11" fill="#6b675e">Private_Dirty</text>
<text class="ts" x="290" y="206" font-size="11" fill="#6b675e">条长：10 像素 = 1kB</text>
<text class="ts" x="20" y="238" font-size="12" fill="#6b675e">两本账互不通气，搬运全靠引用计数顺手完成</text>
</svg>
</figure>

一页的一生到此闭环：私有 →（fork）共享 →（写）私有新页 或（对方写）私有旧页 →（对方退出）私有。「独占」自始至终只是引用计数的一句话：只剩我一个映射者。

这个闭环画成状态迁移：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 272" role="img" aria-label="一页的四种状态迁移：独占私有经 fork 变成共享只读；共享页自己写就复制出独占新页，对方写则旧页归自己独占，对方退出且引用计数归一则翻回独占私有" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern2As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">四种状态之间，全靠引用计数搬运</text>
<rect class="bx-q" x="40" y="104" width="140" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="128" text-anchor="middle" font-size="13" fill="#2b2a26">独占私有</text>
<text class="ts" x="110" y="148" text-anchor="middle" font-size="11" fill="#6b675e">exclusive=1</text>
<rect class="bx" x="260" y="104" width="140" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="128" text-anchor="middle" font-size="13" fill="#2b2a26">共享只读</text>
<text class="ts" x="330" y="148" text-anchor="middle" font-size="11" fill="#6b675e">exclusive=0</text>
<line class="fl" x1="180" y1="132" x2="256" y2="132" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As4)"/>
<text class="ts" x="218" y="122" text-anchor="middle" font-size="11" fill="#6b675e">fork</text>
<rect class="bx-q" x="470" y="40" width="160" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="550" y="60" text-anchor="middle" font-size="13" fill="#2b2a26">私有 · 新页</text>
<text class="ts" x="550" y="78" text-anchor="middle" font-size="11" fill="#6b675e">带着独占出生</text>
<rect class="bx-q" x="470" y="176" width="160" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="550" y="196" text-anchor="middle" font-size="13" fill="#2b2a26">私有 · 旧页</text>
<text class="ts" x="550" y="214" text-anchor="middle" font-size="11" fill="#6b675e">从对方名下流回</text>
<line class="fl" x1="400" y1="120" x2="466" y2="76" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As4)"/>
<text class="ts" x="418" y="86" font-size="11" fill="#6b675e">自己写：复制新页</text>
<line class="fl" x1="400" y1="144" x2="466" y2="188" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As4)"/>
<text class="ts" x="418" y="178" font-size="11" fill="#6b675e">对方写：旧页归自己</text>
<path class="fl" d="M330 160 L330 244 L110 244 L110 166" fill="none" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As4)"/>
<text class="ts" x="220" y="238" text-anchor="middle" font-size="11" fill="#6b675e">对方退出：计数归 1，翻回独占</text>
</svg>
</figure>

## THP：写一个字节，复制 512 页？

Redis 那篇快照文章引用过官方文档的说法：透明大页下，父进程改一字节，最坏复制 2MiB，「一次 4KB 的 COW，被放大成 2MB」。这也是很多调优文档建议 Redis 关 THP 的头号理由。

实验直接检验它：`mmap` 32MiB，`MADV_HUGEPAGE`，逐 4KiB 触碰填满，确认 `AnonHugePages=32768kB`，16 个大页全部真实背书。fork 后，父进程在**最后一个大页的正中央**写一个字节：

```text
== T1 fork 后（父） ==
Rss=32768kB  Shared_Dirty=32768kB  Private_Dirty=0kB  AnonHuge=32768kB

== T2 写大页中央 1 字节（父） ==
minflt +1
Rss=32768kB  Shared_Dirty=32764kB  Private_Dirty=4kB   AnonHuge=30720kB
```

三个数字各自说明一件事：

- `Private_Dirty` 只涨 **4kB**。如果放大 512 倍成立，这里应该是 2048kB。没有放大，复制的只有被写的那一页。
- `AnonHuge` 掉了恰好 **2048kB**。被写的那个大页从父进程的地址空间里消失了，整页拆分成了 512 个 4KiB 页。子进程侧 `AnonHuge` 仍是 32768kB，一个不少：拆分只发生在动手写的人那边。
- `Rss` 不变。拆分不改变驻留的字节数，只改变地图的粒度。

128MiB（64 大页）复跑同样：写一字节，`Private_Dirty +4kB`，`AnonHuge 131072→129024`。

源码与实测严丝合缝。v7.2 `mm/huge_memory.c` 的 `do_huge_pmd_wp_page()`（大页写缺页的入口）全部逻辑只有两条出路：

```c
if (PageAnonExclusive(page))
        goto reuse;                        /* 独占：改权限，不复制 */
...
if (folio_ref_count(folio) == 1) {         /* 引用只剩自己：同样 reuse */
        ...
        SetPageAnonExclusive(page);
        goto reuse;
}
unlock_fallback:
        __split_huge_pmd(vma, vmf->pmd, vmf->address, false);  /* 共享：拆分 */
        return VM_FAULT_FALLBACK;           /* 让缺页按 4KiB 重来一遍 */
```

独占就改权限；共享就**把大页拆成 512 个 PTE**，返回 `VM_FAULT_FALLBACK` 让同一次缺页按 4KiB 粒度重走，然后落进上一节的 `do_wp_page()` 三岔口，只复制被写的那一页。整个函数里**没有一行「分配新大页」的代码**。

这个函数的两条出路：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 274" role="img" aria-label="大页写缺页 do_huge_pmd_wp_page 的两条出路：独占或引用只剩自己时走 reuse 改回可写零复制；仍共享时把大页拆成 512 个 PTE，同一次缺页按 4KiB 重走 do_wp_page 三岔口，只复制被写的那一页。实测 Private_Dirty 只涨 4kB，AnonHuge 掉 2048kB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern2As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">大页写缺页：两条出路，没有第三条</text>
<rect class="bx-q" x="190" y="36" width="280" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="61" text-anchor="middle" font-size="13" fill="#2b2a26">大页写缺页 · do_huge_pmd_wp_page</text>
<line class="fl" x1="270" y1="76" x2="160" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As5)"/>
<line class="fl" x1="390" y1="76" x2="500" y2="116" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As5)"/>
<rect class="bx" x="30" y="120" width="260" height="76" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="160" y="144" text-anchor="middle" font-size="13" fill="#2b2a26">独占，或引用只剩自己</text>
<text class="ts" x="160" y="166" text-anchor="middle" font-size="11" fill="#6b675e">reuse：权限改回可写</text>
<text class="ts" x="160" y="184" text-anchor="middle" font-size="11" fill="#6b675e">复制为零</text>
<rect class="bx-sick" x="370" y="120" width="260" height="76" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="500" y="144" text-anchor="middle" font-size="13" fill="#2b2a26">仍共享</text>
<text class="ts" x="500" y="166" text-anchor="middle" font-size="11" fill="#6b675e">拆分：大页变成 512 个 PTE</text>
<text class="ts" x="500" y="184" text-anchor="middle" font-size="11" fill="#6b675e">同一次缺页按 4KiB 重走</text>
<line class="fl" x1="500" y1="196" x2="500" y2="216" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As5)"/>
<rect class="bx" x="370" y="220" width="260" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="500" y="244" text-anchor="middle" font-size="11" fill="#6b675e">落进 do_wp_page 三岔口：只复制被写那页</text>
<text class="tc" x="30" y="234" font-size="12" fill="#b03a2e">实测：Private_Dirty 只涨 4kB</text>
<text class="ts" x="30" y="254" font-size="12" fill="#6b675e">AnonHuge −2048kB：那个大页退出大页编制</text>
</svg>
</figure>

### 那个 512 倍的故事，曾经是真的

旧文档不是凭空捏造。考古两份历史源码，分界清晰：

- **v4.19**（2018）：`do_huge_pmd_wp_page()` 确有整页复制路径。reuse 失败后先走 `do_huge_pmd_wp_page_fallback()`（分配 512 个小页、`copy_user_huge_page` 全量拷贝 2MiB 内容），失败再退到「分配一个全新大页、整页复制」。写一字节、复制 2MiB，两条路都是真的。
- **v5.15**（2021）：fallback 函数已经没了，结构与 v7.2 相同，只有 reuse 和拆分。

也就是说，「THP 放大 COW」的真实区间是 4.x 及更早；5.x 某次写时复制重做（介于 5.15 与 4.19 之间，具体版本不再逐个考证）之后出生的内核，包括 6.1/6.6/6.12/6.18 全部 LTS 和本机 7.2，写大页一个字节就只复制一页。Redis 官方文档的这句话，描绘的是它诞生那年的内核；十几年过去，调优建议还在流传，理由已经换了一茬。

两份历史源码摆在一起：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 212" role="img" aria-label="同名函数的两种实现：v4.19 的 do_huge_pmd_wp_page 在 reuse 失败后走 fallback，分配 512 个小页全量拷贝 2MiB，写一字节复制一整块大页是真的；v5.15 及之后 fallback 路径被整个删掉，只剩拆分后按 4KiB 重走，只复制一页" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern2As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="48" font-size="12" fill="#6b675e">v4.19（2018）</text>
<rect class="bx-sick" x="130" y="30" width="140" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="200" y="52" text-anchor="middle" font-size="12" fill="#6b675e">reuse 失败</text>
<line class="fl" x1="270" y1="48" x2="306" y2="48" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As6)"/>
<rect class="bx-sick" x="310" y="30" width="330" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="475" y="52" text-anchor="middle" font-size="12" fill="#b03a2e">fallback：分配 512 小页，全量拷贝 2MiB</text>
<text class="ts" x="130" y="86" font-size="11" fill="#6b675e">写一字节、复制 2MiB：512 倍的故事在这个年代是真的</text>
<line class="axis" x1="20" y1="102" x2="640" y2="102" stroke="#6b675e" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="20" y="140" font-size="12" fill="#6b675e">v5.15 起（含全部在役 LTS）</text>
<rect class="bx" x="200" y="122" width="140" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="270" y="144" text-anchor="middle" font-size="12" fill="#6b675e">reuse 失败</text>
<line class="fl" x1="340" y1="140" x2="376" y2="140" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern2As6)"/>
<rect class="bx" x="380" y="122" width="260" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="510" y="144" text-anchor="middle" font-size="12" fill="#6b675e">拆分，按 4KiB 重走：只复制一页</text>
<text class="ts" x="200" y="178" font-size="11" fill="#6b675e">fallback 函数整个消失，全量拷贝路径不复存在</text>
<text class="ts" x="20" y="202" font-size="12" fill="#6b675e">函数名没变，路径变了：读旧文档先问它是照着哪一年的内核写的</text>
</svg>
</figure>

这正好给上一篇的版本纪律补一条注脚：内核行为的「常识」很容易过期。CFS 换了 EEVDF，THP 的写时复制换了实现，文档却不会自己过期。

那么 THP 对 Redis 就无害了吗？也不是，理由换了。拆分本身就是成本：一次缺页要做 512 个 PTE 的改写与 TLB 失效；被拆掉的大页不会自动合并回去（本实验子进程退出后父进程 `AnonHuge` 仍是 30720kB，重聚合要等 khugepaged 后台慢慢来）；更根本的是内存膨胀：小数据集被聚合成 2MiB 粒度分配，`used_memory` 与 RSS 的比值恶化。官方「关 THP」的建议在 7.2 上依然成立，只是该引用的理由已经从「COW 放大 512 倍」换成了这些。建议可以照用，理由要按当前的内核版本重新核一遍，这也是这个系列每篇都锚定版本的原因。

## 我踩的坑

**minflt 藏在第 10 个字段里，而进程名里可以有括号和空格。** 读 `/proc/self/stat` 解析累计缺页数，直觉写法是按空格切分取第 10 个，但第二个字段 `comm`（进程名）可以包含空格甚至括号，切分会全盘错位。正确做法是从最后一个 `)` 之后开始数字段。`proc(5)` 手册明说了这一点，但错误解析不会报错，只会给出安静的荒谬数字，比崩溃难发现得多。

**stdio 自己就会制造缺页。** 第一次 `printf` 要触碰 stdout 的缓冲区，缓冲区第一次落账就是一次缺页，直接污染「写一个字节 +1」的对照实验。程序用构造函数抢在 `main` 之前 `setvbuf(stdout, NULL, _IONBF, 0)` 关掉缓冲。观测工具改变了被观测对象，而这篇的主题恰好是写一个字节引发的开销，第一笔不能记在观测者自己头上。

**fork 本身在父侧也有缺页。** 实验里 fork 前后、尚未做任何写演示时，父进程 minflt 已经 +8。这一下与 COW 无关（没有任何页被写），来源是 `fork()` 包装与运行时在父进程用户态触碰的少量新页。逐笔审计它的构成随 libc 而变，文章就不假装精确了；能确定的是它与数据页无关，数据页的 COW 前文已逐次核对过。做实验时先把「系统调用的自身开销」量出来当基线扣除，再谈「一个字节值多少次缺页」。

**大页实验必须先验货。** 上一篇 1GiB 实验里 `MADV_HUGEPAGE` 的大页达成率只有 88%~91%（物理内存不连续就回退 4KiB）。本篇 32MiB 一次拿到 100%，但这是运气不是保证，所以实验程序每次都打印 `AnonHugePages` 实测值，达成率不是 100% 时，数据必须标注「混有 4KiB 回退页」。读别人的 THP 实验数据时，第一件事也是找这个字段。

## 写时复制的规则

fork 改的是权限：父子双方的 PTE 全部只读，物理页共享，Rss 一页不多；上一篇说过停顿按页表面积结算，这一篇补上后半句，数据页的成本要到写的时候才发生。写缺页先查独占，独占就免复制，所以一次写时复制买断这页今后所有的写，第二次写连内核都不进。复制的单位永远是页，但路径决定成本：共享页写一字节复制 4096 字节，零页写一字节只分配不拷贝，未触碰页写一字节分配清零页，三个 +1 的 minflt 背后是三条不同的路径。COW 是对称的：父进程私有化一页，旧页就归子进程独占；子进程退出，引用计数归一的页自动翻回私有。Redis 用子进程的 `Private_Dirty` 近似 COW，这个近似在 4KiB 粒度上是准的，因为那就是内核记账的原生粒度。最后，「THP 放大 512 倍」已经是历史：v7.2 实测写大页中央一个字节只复制 4KiB，那个大页拆成 512 页退出大页编制；整页复制路径 v4.19 还在，v5.15 已无。

但这一篇始终留着一个问题没答：`wp_page_copy` 说「分配一页新内存」，fork 说「分配子进程的页表」，分配、分配、分配，这些页从哪里来？内核没有无限的货架。被写出来的页、被拆散的大页、512 张一打的 PTE 页，最终都来自同一个仓库：伙伴系统。

下一篇就去看仓库：《物理页的家底：伙伴系统与碎片》。
