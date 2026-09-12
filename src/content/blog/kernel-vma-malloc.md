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

glibc 的堆和 pymalloc 用的机制高度相似：内部同样按尺寸分箱（fastbins/smallbins/largebins）、同样有 tcache（每线程缓存，free 的 chunk 先进缓存不下沉）、同样把释放的 chunk 留作复用而不是归还。`malloc_trim(0)` 才是把堆顶空余还给内核的显式动作。CPython 那篇里「显式调用 malloc_trim 后大对象场景 RSS 才回落」的现象，机制就在这里：trim 之前，那些页在 glibc 手里打转；trim 之后，brk 收缩，VMA 变短，未触碰的尾页连同页表一起消失。而 trim 只能还**堆顶**的连续空区，堆中间的洞（第三篇钉子实验的用户态版本）谁也还不掉，除非整块是 mmap 来的。

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

```text
第 1 层  glibc：tcache 里恰好有个空闲 chunk → 直接切给你，不进内核
         （内核视角：什么都没发生）
第 2 层  brk/mmap：chunk 不够 → 扩 VMA，地址空间登记在册
         （内核视角：VMA 变了，页表没动，物理内存没动）
第 3 层  缺页：你写 *p 那一刻 → 缺页异常，分配物理页，页表填上
         （内核视角：现在才知道这一页，第一/二篇的全部故事）
```

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
