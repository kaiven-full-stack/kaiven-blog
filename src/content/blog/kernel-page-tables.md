---
title: Linux 页表：一次访存的四层翻译
description: mmap 返回的指针指向一页并不存在的内存，读到的字节来自全内核共享的零页。本文沿四级页表走完一次访存：pagemap 的三页读数、零页转正、soft-dirty 的两层记录、页表按触碰面积 512:1 增长、大页旁边那张押着的空 PTE 页，以及一条指针追逐链测出的页表行走成本。源码对照 vanilla v7.2，实验跑在本机 Linux 7.2.3。
pubDate: 2026-09-10
category: kernel
tags: [Linux, 内核, 内存管理]
---

`mmap` 返回一个指向三页内存的指针，`pagemap` 说这三页都不存在；对其中一页读一个字节，pagemap 改口说「存在」了，进程的 RSS 却一个字节没涨。这一篇把这两句矛盾的话拆开，顺带回答三个问题：为什么读 `mmap` 返回的指针得到 0 而占用不涨、一次地址翻译要走几步、大页省了什么又没省什么。

从这篇起进入正文。没有内核基础的话，建议先花几分钟读[《第 0 篇：指针、页，和内核的账本》](/posts/kernel-primer/)，虚拟地址、页、/proc 三样前置东西那篇都讲了。

先记住一句话：指针是进程的，页是内核的。`malloc` 给你一段连续的虚拟地址，内核却可以一页都不给；你对 `A[0]` 读了一个字节，pagemap 说这页「存在」，进程的 RSS 却一字节都没涨。要看懂这些，得把虚拟地址翻译成物理地址的那套机构整个打开。

Redis 系列写过快照与 fork：那次说，fork 复制的是地图，不是领土，两份页表指向同一批物理页，停顿按页表的面积结算。那篇文章把「地图」当成了一个黑盒常数：页表多大、按什么规律涨、为什么大页能救场，都停在了门口。这一篇把它打开，也是这个新系列的第一步：先看清地图本身，再去追那些真正在地图上发生的事故。

本系列源码锚定 **vanilla v7.2 tag**；实验在本机完成，Linux 7.2.3（发行版打包，补丁不逐项核对，实现细节以 vanilla 源码为准）、AMD Zen 2 六核笔记本、12GiB 内存。CPU 未启用 la57（`grep la57 /proc/cpuinfo` 为空），因此全文按四级页表讨论；与 6.12/6.18 LTS 的行为差异，遇到时随篇标注。实验程序用 zig cc 编译，就是 Zig 系列里那条一行交叉编译的命令，这次只是让它编本机目标。

## 一次访存，四层翻译

第 0 篇说过，每个进程手里有一本自己的翻译表，也就是页表；这一节把它拆开，看看它长什么样、查一次要走几步。

x86-64 的虚拟地址是 48 位（用户空间有效 47 位），被切成五段：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 118" role="img" aria-label="x86-64 的 48 位虚拟地址切成五段：PGD、PUD、PMD、PTE 四段各 9 位，对应 512 个条目，最后 12 位页内偏移对应页内 4096 个字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">48 位虚拟地址：四段选条目，一段定字节</text>
<rect class="bx" x="40" y="44" width="109" height="48" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="94" y="65" text-anchor="middle" font-size="13" fill="#2b2a26">PGD 索引</text>
<text class="ts" x="94" y="84" text-anchor="middle" font-size="11" fill="#6b675e">9 位 · 512 条目</text>
<rect class="bx" x="149" y="44" width="109" height="48" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="203" y="65" text-anchor="middle" font-size="13" fill="#2b2a26">PUD 索引</text>
<text class="ts" x="203" y="84" text-anchor="middle" font-size="11" fill="#6b675e">9 位 · 512 条目</text>
<rect class="bx" x="258" y="44" width="109" height="48" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="312" y="65" text-anchor="middle" font-size="13" fill="#2b2a26">PMD 索引</text>
<text class="ts" x="312" y="84" text-anchor="middle" font-size="11" fill="#6b675e">9 位 · 512 条目</text>
<rect class="bx" x="367" y="44" width="109" height="48" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="421" y="65" text-anchor="middle" font-size="13" fill="#2b2a26">PTE 索引</text>
<text class="ts" x="421" y="84" text-anchor="middle" font-size="11" fill="#6b675e">9 位 · 512 条目</text>
<rect class="bx-q" x="476" y="44" width="144" height="48" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="548" y="65" text-anchor="middle" font-size="13" fill="#2b2a26">页内偏移</text>
<text class="ts" x="548" y="84" text-anchor="middle" font-size="11" fill="#6b675e">12 位 · 4096 字节</text>
<text class="ts" x="40" y="110" font-size="12" fill="#6b675e">高位在左：前四段每段从对应层的表里挑一个条目，末段直接指到页内第几个字节</text>
</svg>
</figure>

9 位索引意味着每张表 512 个条目；每个条目 8 字节；512 × 8B = 4KiB，一张表恰好占一页。硬件的翻译流程是从 CR3 寄存器拿到 PGD 的物理地址起步，然后一层一层读下去：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 176" role="img" aria-label="硬件翻译链：CPU 从 CR3 寄存器拿到 PGD 物理地址，依次走 PGD 页、PUD 页、PMD 页、PTE 页四层表，找到物理页，再用 12 位偏移定位字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern1As2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">硬件的走表路线：一跳一层，每跳用掉一段 9 位索引</text>
<rect class="bx-q" x="16" y="64" width="84" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="58" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">CR3</text>
<text class="ts" x="58" y="104" text-anchor="middle" font-size="11" fill="#6b675e">寄存器</text>
<line class="fl" x1="100" y1="90" x2="113" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern1As2)"/>
<rect class="bx" x="118" y="64" width="84" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="160" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">PGD 页</text>
<text class="ts" x="160" y="104" text-anchor="middle" font-size="11" fill="#6b675e">第一层</text>
<line class="fl" x1="202" y1="90" x2="215" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern1As2)"/>
<rect class="bx" x="220" y="64" width="84" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="262" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">PUD 页</text>
<text class="ts" x="262" y="104" text-anchor="middle" font-size="11" fill="#6b675e">第二层</text>
<line class="fl" x1="304" y1="90" x2="317" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern1As2)"/>
<rect class="bx" x="322" y="64" width="84" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="364" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">PMD 页</text>
<text class="ts" x="364" y="104" text-anchor="middle" font-size="11" fill="#6b675e">第三层</text>
<line class="fl" x1="406" y1="90" x2="419" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern1As2)"/>
<rect class="bx" x="424" y="64" width="84" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="466" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">PTE 页</text>
<text class="ts" x="466" y="104" text-anchor="middle" font-size="11" fill="#6b675e">第四层</text>
<line class="fl" x1="508" y1="90" x2="521" y2="90" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern1As2)"/>
<rect class="bx-q" x="526" y="64" width="84" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="568" y="86" text-anchor="middle" font-size="13" fill="#2b2a26">物理页</text>
<text class="ts" x="568" y="104" text-anchor="middle" font-size="11" fill="#6b675e">数据在这</text>
<text class="ts" x="20" y="142" font-size="12" fill="#6b675e">进了物理页，再用那 12 位偏移定位到第几个字节</text>
<text class="ts" x="20" y="162" font-size="12" fill="#6b675e">起点在 CPU 寄存器里，后面每一步都在内存里：走表的成本就是这么来的</text>
</svg>
</figure>

注意这条链上每一步存的都是下一层页表的**物理地址**，所以走表这件事本身不需要「先翻译页表自己的地址」，没有鸡生蛋的问题。内核软件想读写页表时才需要借助直映射窗口，那是另一回事。

每张表管辖的范围，往上翻 512 倍：

| 一张表 | 条目指向 | 管辖范围 |
| --- | --- | ---: |
| PTE 页 | 物理页 | 512 × 4KiB = **2MiB** |
| PMD 页 | PTE 页 | 512 × 2MiB = **1GiB** |
| PUD 页 | PMD 页 | 512 × 1GiB = **512GiB** |
| PGD | PUD 页 | 512 × 512GiB = **256TiB** |

这个结构直接给出一个预测公式：**每多触碰 2MiB 内存，页表就多一张 4KiB 的 PTE 页**。后面会用实验验证它。另外两条先记在这里：PTE 里的 Accessed/Dirty 位由硬件在访存时顺手置位，Redis 那篇「被碰过的页」的账，硬件一直记着；而四级不是终点，la57 已经把第五级带进来（57 位地址空间），只是本机没启用。

最要紧的一条推论是成本：如果没有任何缓存，一次访存要先读四张表页、再读数据页，**五次内存访问才换来一个字节**。内核为摊销这笔钱发明了 TLB，那是本文后半场要量的东西。在那之前，先弄清一个更基本的问题：页表什么时候才真的占内存？

## mmap 只画了 VMA，页表仍是一片空白

实验从一个三页的匿名映射开始。两侧各垫两页 `PROT_NONE` 护栏（原因见「我踩的坑」），中间三页分别叫 A、B、C。观察工具是 `/proc/self/pagemap`，内核翻译表的「公开查询版」：每个虚拟页对应一条 64 位记录，登记这一页的当前状态（存在与否、是否独占、是否被写过），核心的几位列在下面（v7.2 文档）：

```text
bit 63  present          该页当前在物理内存中
bit 62  swapped          已换出
bit 61  file/shared-anon 文件页或共享匿名页
bit 56  exclusive        该页只被本进程映射
bit 55  soft-dirty       自上次清除以来被写过
bit 0–54  PFN            物理页帧号
```

读取本身只是一次 `pread`：

```c
static uint64_t pagemap_entry(int fd, uintptr_t vaddr) {
    uint64_t e = 0;
    pread(fd, &e, 8, (off_t)(vaddr / 4096) * 8);
    return e;
}
```

`mmap` 刚返回时，三页的记录是：

```text
A  raw=0x0080000000000000  present=0  soft-dirty=1
B  raw=0x0080000000000000  present=0  soft-dirty=1
C  raw=0x0080000000000000  present=0  soft-dirty=1
smaps：Rss=0kB
```

`mmap` 做的事情只有一件：在进程的 VMA（虚拟内存区域）链表里登记一段边界，起点、长度、权限。页表一级都还没动，`present` 全是 0。地址空间是进程的，可以随便画；物理页是内核的，此刻一页都还没给。

那 `soft-dirty=1` 是怎么回事？C 从没被碰过，账上却记着「脏」。这是 soft-dirty 的第一层记录：VMA 级的 `VM_SOFTDIRTY` 标志。新 VMA 出生自带这个标志，语义是「我无法保证我里面发生过什么」。VMA 会被合并、被拆分，内核没法为新边界内的页担保清白，只能先记为可疑。

### 读到的零页，不属于你

现在对 A 读一个字节，对 B 写一个字节，C 保持不动：

```text
A  raw=0x8080000000000000  present=1  exclusive=0
B  raw=0x8180000000000000  present=1  exclusive=1
C  raw=0x0080000000000000  present=0
smaps：Rss=4kB  Private_Dirty=4kB
```

两页都「存在」了，但存在的方式不一样。B 拥有自己独占的物理页（`exclusive=1`），它贡献了 smaps 里那 4kB。A 呢？`present=1`，但 `exclusive=0`，而且 **Rss 一字未涨**，三页的区域只驻留了 B 的一页。

PFN 字段帮不上忙（下一节解释），但三件旁证拼出了答案：A 落在了**零页**上，内核全局共享的那一页全零内存。对匿名映射的读缺页，内核没有理由为你真的分配一页：映射保证读出来是零，那就把所有人指到同一页现成的零上。零页被无数进程同时映射，所以 `exclusive=0`；smaps 不为它记账，所以 Rss 不涨。

零页的故事在 phase 3 收尾。先用 `clear_refs` 清一次标志（下面细说），然后对 A 写入一个字节：

```text
A  raw=0x8180000000000000  present=1  exclusive=1  soft-dirty=1
B  raw=0x8100000000000000  present=1  exclusive=1  soft-dirty=0
C  raw=0x0000000000000000  present=0                soft-dirty=0
smaps：Rss=8kB  Private_Dirty=8kB
```

A 转正了：写缺页无法再用零页搪塞，内核这才分配一页属于它自己的内存，`exclusive` 变 1，Rss 涨到 8kB。**「存在」分两种：借来的零页，和写出来的独占页。** 这个区别在下一篇写时复制里会再次出现：fork 之后，父子共享的页与独占的页，走的是不同的改写路径。

### soft-dirty：两层记录

phase 2 那次清除，是往 `/proc/self/clear_refs` 写一个 `4`。v7.2 源码 `fs/proc/task_mmu.c` 的 `clear_refs_write()` 处理它，动作分两层：先把所有 VMA 的 `VM_SOFTDIRTY` 标志清掉，再用 `walk_page_range()` 扫全进程页表，逐个 PTE 调 `clear_soft_dirty()`，最后 `flush_tlb_mm()`。两层标志一起归零。

于是 phase 3 的读数变成了教科书式的对照：A 被写过，PTE 级重新标脏；B 自清除后没动过，`soft-dirty=0`；C 从未被触碰，两层记录都是干净的零。对比 phase 0，它出生时那个「可疑」的 VMA 标志也被抹掉了。

三页的三个阶段，摆在一张格子里：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 312" role="img" aria-label="三页三阶段状态格：phase 0 刚 mmap 时 A B C 三页 present 全为 0，soft-dirty 全为 1，Rss 为 0；phase 2 A 读一页后 present=1 但 exclusive=0 落在共享零页，B 写一页后 present=1 exclusive=1，C 没动，Rss 4kB；phase 3 清除标志后 A 再写，present=1 dirty=1 转正，B 保持 dirty=0，C 两层记录全干净，Rss 8kB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="130" y="60" font-size="12" fill="#6b675e" text-anchor="middle">A · 读了一个字节</text>
<text class="ts" x="377" y="60" font-size="12" fill="#6b675e" text-anchor="middle">B · 写了一个字节</text>
<text class="ts" x="547" y="60" font-size="12" fill="#6b675e" text-anchor="middle">C · 没碰</text>
<text class="ts" x="16" y="94" font-size="12" fill="#6b675e">phase 0</text>
<text class="ts" x="16" y="112" font-size="12" fill="#6b675e">刚 mmap</text>
<text class="tc" x="16" y="130" font-size="12" fill="#b03a2e">Rss=0kB</text>
<rect class="bx-gone" x="130" y="76" width="155" height="60" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="207" y="100" text-anchor="middle" font-size="13" fill="#2b2a26">present=0</text>
<text class="ts" x="207" y="120" text-anchor="middle" font-size="11" fill="#6b675e">soft-dirty=1：出生即可疑</text>
<rect class="bx-gone" x="300" y="76" width="155" height="60" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="377" y="100" text-anchor="middle" font-size="13" fill="#2b2a26">present=0</text>
<text class="ts" x="377" y="120" text-anchor="middle" font-size="11" fill="#6b675e">soft-dirty=1：出生即可疑</text>
<rect class="bx-gone" x="470" y="76" width="155" height="60" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="547" y="100" text-anchor="middle" font-size="13" fill="#2b2a26">present=0</text>
<text class="ts" x="547" y="120" text-anchor="middle" font-size="11" fill="#6b675e">soft-dirty=1：出生即可疑</text>
<text class="ts" x="16" y="166" font-size="12" fill="#6b675e">phase 2</text>
<text class="ts" x="16" y="184" font-size="12" fill="#6b675e">A 读、B 写</text>
<text class="tc" x="16" y="202" font-size="12" fill="#b03a2e">Rss=4kB</text>
<rect class="bx" x="130" y="148" width="155" height="60" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="207" y="172" text-anchor="middle" font-size="12" fill="#2b2a26">present=1 · exclusive=0</text>
<text class="ts" x="207" y="192" text-anchor="middle" font-size="11" fill="#6b675e">读缺页：落在共享零页</text>
<rect class="bx-q" x="300" y="148" width="155" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="377" y="172" text-anchor="middle" font-size="12" fill="#2b2a26">present=1 · exclusive=1</text>
<text class="ts" x="377" y="192" text-anchor="middle" font-size="11" fill="#6b675e">写缺页：独占页才记账</text>
<rect class="bx-gone" x="470" y="148" width="155" height="60" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="547" y="172" text-anchor="middle" font-size="13" fill="#2b2a26">present=0</text>
<text class="ts" x="547" y="192" text-anchor="middle" font-size="11" fill="#6b675e">谁也没碰</text>
<text class="ts" x="16" y="238" font-size="12" fill="#6b675e">phase 3</text>
<text class="ts" x="16" y="256" font-size="12" fill="#6b675e">clear 后 A 再写</text>
<text class="tc" x="16" y="274" font-size="12" fill="#b03a2e">Rss=8kB</text>
<rect class="bx-sick" x="130" y="220" width="155" height="60" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="207" y="244" text-anchor="middle" font-size="12" fill="#2b2a26">present=1 · dirty=1</text>
<text class="ts" x="207" y="264" text-anchor="middle" font-size="11" fill="#6b675e">转正，且重新标脏</text>
<rect class="bx-q" x="300" y="220" width="155" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="377" y="244" text-anchor="middle" font-size="12" fill="#2b2a26">present=1 · dirty=0</text>
<text class="ts" x="377" y="264" text-anchor="middle" font-size="11" fill="#6b675e">清除之后没再动过</text>
<rect class="bx-gone" x="470" y="220" width="155" height="60" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="547" y="244" text-anchor="middle" font-size="12" fill="#2b2a26">present=0 · dirty=0</text>
<text class="ts" x="547" y="264" text-anchor="middle" font-size="11" fill="#6b675e">两层记录都干净</text>
<text class="ts" x="20" y="302" font-size="12" fill="#6b675e">A 列走完三种状态：不存在 → 借来的 → 自己的；Rss 只为最后两种里的独占页掏钱</text>
</svg>
</figure>

这套机制不是观赏用的。增量备份、热迁移、数据库脏页追踪，都靠「清除 → 干活 → 再读」的循环，把两次快照之间真正被写过的页筛出来。Redis 的 `SET` 触发多少 COW 不能从命令推算，但内核这本页级账本一直是准的。

### PFN 为什么读不到

你可能注意到所有记录的 `pfn=0`。Linux 4.0 起，pagemap 的 PFN 字段只对持有 `CAP_SYS_ADMIN` 的进程可见；没有特权时静默清零，其余位照常。源码里的判据和注释是：

```c
/* do not disclose physical addresses: attack vector */
pm.show_pfn = file_ns_capable(file, &init_user_ns, CAP_SYS_ADMIN);
```

公开的理由是 Rowhammer 类攻击：物理地址信息会降低这类攻击的门槛。本实验在无特权环境运行，所以只能靠位标志与 smaps 做旁证，这也是本文所有关于零页的推断都标注「旁证」的原因。想直读物理地址，需要 root 或相应能力。

## 页表按触碰面积增长

现在验证那条预测公式。程序 `mmap` 一段 1GiB 匿名内存，从低到高**每 4KiB 触碰一个字节**，逐段记录 `/proc/self/status` 的 `VmPTE`。这个字段来自内核的 `mm_pgtables_bytes()`，把四级页表占用的字节全记在一起：

```text
mode=nohuge（madvise MADV_NOHUGEPAGE）
触碰量      VmPTE      ΔVmPTE     VmRSS
  128MiB      304kB       —      133084kB
  256MiB      560kB    +256kB     264156kB
  384MiB      816kB    +256kB     395228kB
  512MiB     1072kB    +256kB     526300kB
  640MiB     1328kB    +256kB     657372kB
  768MiB     1584kB    +256kB     788444kB
  896MiB     1840kB    +256kB     919516kB
 1024MiB     2096kB    +256kB    1050588kB
munmap 后      44kB              2012kB
```

每触碰 128MiB，`VmPTE` 恰好增加 256kB：128MiB ÷ 2MiB = 64 张 PTE 页 × 4KiB = 256kB。**512:1。** 公式成立。

这笔账画成线：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 270" role="img" aria-label="VmPTE 随触碰量线性增长：从 128MiB 时 304kB 到 1024MiB 时 2096kB，八个测量点落在同一条直线上，斜率是触碰量的五百一十二分之一" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">1GiB 匿名映射，nohuge 臂：VmPTE 随触碰量线性增长</text>
<line class="grid" x1="70" y1="179" x2="610" y2="179" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="138" x2="610" y2="138" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="97" x2="610" y2="97" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="56" x2="610" y2="56" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="220" x2="70" y2="36" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="220" x2="618" y2="220" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="183" text-anchor="end" font-size="11" fill="#6b675e">500</text>
<text class="ts" x="62" y="142" text-anchor="end" font-size="11" fill="#6b675e">1000</text>
<text class="ts" x="62" y="101" text-anchor="end" font-size="11" fill="#6b675e">1500</text>
<text class="ts" x="62" y="60" text-anchor="end" font-size="11" fill="#6b675e">2000</text>
<text class="ts" x="20" y="44" font-size="11" fill="#6b675e">VmPTE（kB）</text>
<polyline class="curve-k" points="137,195 205,174 272,153 340,132 407,111 475,90 542,70 610,49" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="137" cy="195" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="205" cy="174" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="272" cy="153" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="340" cy="132" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="407" cy="111" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="475" cy="90" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="542" cy="70" r="3" fill="#b03a2e"/>
<circle class="fill-c" cx="610" cy="49" r="3" fill="#b03a2e"/>
<text class="tc" x="240" y="186" font-size="12" fill="#b03a2e">斜率 1/512：触碰量 ÷ 512 = 新增页表字节</text>
<text class="ts" x="240" y="204" font-size="12" fill="#6b675e">一路直线到 1GiB，中途没有拐点</text>
<text class="ts" x="205" y="238" text-anchor="middle" font-size="11" fill="#6b675e">256</text>
<text class="ts" x="340" y="238" text-anchor="middle" font-size="11" fill="#6b675e">512</text>
<text class="ts" x="475" y="238" text-anchor="middle" font-size="11" fill="#6b675e">768</text>
<text class="ts" x="610" y="238" text-anchor="middle" font-size="11" fill="#6b675e">1024</text>
<text class="ts" x="616" y="258" text-anchor="end" font-size="11" fill="#6b675e">触碰量（MiB）</text>
</svg>
</figure>

这个数字也和 Redis 那篇的算例接上了头。那篇说：24GiB 地址空间按每页 8 字节条目估算，页表条目约 48MB。那是「条目账」；本文量的是「页账」。密集填充时两本账恰好相等：一张 PTE 页 512 个条目 × 8B = 4KiB，24GiB ÷ 4KiB × 8B = 48MiB = 12,288 张 PTE 页 × 4KiB。殊途同归不是巧合，是 512 × 8B = 4KiB 这个设计的必然。稀疏时则页账吃亏：一张表哪怕只有一个条目，也要整张驻留。

另外两处细节。RSS 一栏：1050588kB − 1048576kB（触碰量）= 2012kB，正好等于 munmap 后的残值。**RSS 就是触碰面积加进程基线**，本实验没有隐藏开销。`VmPTE` 的残值 44kB 则是进程自身（代码段、栈、libc）的页表；旧资料里常有的 `VmPMD` 行在这台 7.2.3 的 status 里已经不存在，PMD 页如今一并计入 `VmPTE` 的口径，拿旧脚本去读会读到一个空值，这也是踩过才知道的坑。

## 大页不省页表，省的是 TLB

上面的实验用了 `MADV_NOHUGEPAGE`，是为了先量出纯净的 4KiB 基线。现在放开手脚，跑三条臂：不设置（宿主机 THP 是 `always`）、显式 `MADV_NOHUGEPAGE`、显式 `MADV_HUGEPAGE`，各触碰满 1GiB：

| 臂 | AnonHugePages | 大页占比 | VmPTE |
| --- | ---: | ---: | ---: |
| nohuge | 0 kB | 0% | 2096 kB |
| plain（系统 always） | 706560 kB | 69% | 2096 kB |
| huge（MADV_HUGEPAGE） | 913408 kB | 88% | 2092 kB |

三条臂的大页占比天差地别，`VmPTE` 却停在同一数字上（±4kB 是进程基线噪声）。

大页没有让页表变小。一个 PMD 条目本来可以管 1GiB，如今每个 2MiB 大页折掉一个条目；但每个大页旁边，内核都押了一张 4KiB 的 PTE 页。源码在 `mm/huge_memory.c` 的 `__do_huge_pmd_anonymous_page()`，匿名大页缺页路径上：

```c
folio = vma_alloc_anon_folio_pmd(vma, vmf->address);  /* 2MiB 大页 */
pgtable = pte_alloc_one(vma->vm_mm);                   /* 一张 4KiB PTE 页 */
...
pgtable_trans_huge_deposit(vma->vm_mm, vmf->pmd, pgtable);
map_anon_folio_pmd_pf(folio, vmf->pmd, vma, haddr);
mm_inc_nr_ptes(vma->vm_mm);                            /* 计入页表字节 */
```

那张 PTE 页是空的，当场不用，`deposit` 这个词也确实像押金：将来某个时刻（迁移、remap、或者把大页拆回 4KiB），内核需要在这位 PMD 底下挂出 512 个 PTE，缺页路径上不许分配失败（失败处理的代价太高），所以提前把表押在这里。`mm_inc_nr_ptes()` 让它如实计入 `VmPTE`。

押金关系画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="大页的押金结构：一个 PMD 条目指向 2MiB 大页，同时旁边押着一张空的 4KiB PTE 页，当场不用但如实计入 VmPTE；将来大页拆回 512 个小页时这张表顶上" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kern1As5" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一个 PMD 条目管一个大页，旁边另押一张空表</text>
<rect class="bx" x="40" y="52" width="120" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="100" y="74" text-anchor="middle" font-size="13" fill="#2b2a26">PMD 条目</text>
<text class="ts" x="100" y="94" text-anchor="middle" font-size="11" fill="#6b675e">1 个</text>
<line class="fl" x1="160" y1="78" x2="196" y2="78" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kern1As5)"/>
<text class="ts" x="178" y="68" text-anchor="middle" font-size="11" fill="#6b675e">指向</text>
<rect class="bx-q" x="200" y="48" width="250" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="325" y="72" text-anchor="middle" font-size="14" fill="#2b2a26">2MiB 大页</text>
<text class="ts" x="325" y="94" text-anchor="middle" font-size="11" fill="#6b675e">顶 512 个小页，物理连续</text>
<line class="fl" x1="100" y1="104" x2="100" y2="146" stroke="#6b675e" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#kern1As5)"/>
<text class="ts" x="110" y="130" font-size="11" fill="#6b675e">顺手押下</text>
<rect class="bx-gone" x="40" y="150" width="120" height="52" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="100" y="172" text-anchor="middle" font-size="12" fill="#6b675e">空的 PTE 页</text>
<text class="ts" x="100" y="190" text-anchor="middle" font-size="11" fill="#6b675e">512 格全空着</text>
<text class="tc" x="200" y="166" font-size="12" fill="#b03a2e">表是空的，账是实的：如实计入 VmPTE</text>
<text class="ts" x="200" y="186" font-size="12" fill="#6b675e">将来大页拆回 512 个小页，这张表就地顶上</text>
<text class="ts" x="20" y="230" font-size="12" fill="#6b675e">三条实验臂的大页占比 0%、69%、88%，VmPTE 读数纹丝不动</text>
</svg>
</figure>

于是账目清楚了：每个大页省下的那张 PTE 页（512 个条目只占一个 PMD 条目），被押金原样抵消，1GiB 触碰量的页表一分没省。大页的收益在另一处：TLB。下一节把它的单价量出来。

还有一个环境观察，值得记进排查清单：Redis 那篇写作时记录宿主机 THP 是 `madvise`，本文实验时 `/sys/kernel/mm/transparent_hugepage/enabled` 已经是 `[always]`，系统更新会悄悄拨动这道开关。引用任何调优建议之前，先看一眼这个开关现在的值。

另有一组数字要留意：plain 臂的大页占比只有 69%，huge 臂 88%，而且跑一次变一次（另一轮是 91%）。大页需要 2MiB **物理连续**的内存，内存越紧、碎片越多，「凑齐一大块」就越难，凑不齐就回退成普通页。这个「物理连续有多难」的问题，要等讲到伙伴系统才有完整的答案。

## TLB：把地图搬进缓存

四级页表把一次访存放大成最多五次内存访问，系统还能跑，靠的是 TLB（Translation Lookaside Buffer）：地图查询的高速缓存。它小得惊人：Zen 2 的 L1 dTLB 每页尺寸 64 项，L2 dTLB 公开资料为 1536 项。于是问题变成：**超过 64 页的工作集，每一跳要多付多少钱？**

实验是一条指针追逐链：把 N 个页做随机置换，每页开头 8 字节存下一页的地址，顺藤摸瓜地跳。每跳只碰 8 字节，页序随机，工作集决定「同时在几张不同的页之间打转」：

```c
for (size_t k = 0; k < npages; k++) {
    size_t next = perm[(k + 1 == npages) ? 0 : (k + 1)];
    *(volatile uintptr_t *)(base + perm[k] * 4096) = base + next * 4096;
}
/* 之后反复沿链跳 2^21 次，取每跳平均耗时 */
```

工作集从小到大扫（绑核运行，墙钟计时，每档跑五轮取首轮、其余轮作波动参考）。表格不需要逐行看，重点盯两处：**64 页**（第一级 TLB 恰好装满）和 **8MiB / 2048 页**（第二级 TLB 也装不下），其余行只是连接两个台阶的坡：

| 工作集 | 页数（4KiB） | 每跳耗时 |
| ---: | ---: | ---: |
| 256KiB | 64 | 3.6 ns |
| 512KiB | 128 | 8.1 ns |
| 1MiB | 256 | 12.1 ns |
| 2MiB | 512 | 12.7 ns |
| 4MiB | 1024 | 40.0 ns |
| 8MiB | 2048 | 100.1 ns |
| 16MiB | 4096 | 108.6 ns |
| 32MiB | 8192 | 108.7 ns |
| 64MiB | 16384 | 128.7 ns |
| 128MiB | 32768 | 113.1 ns |
| 256MiB | 65536 | 118.2 ns |
| 512MiB | 131072 | 123.8 ns |

曲线有两个台阶。64 页以内每跳 3.6ns，全部塞进 L1 dTLB，地图查询近乎免费，慢的只是数据自己（在 L2 缓存里）。8MiB（2048 页）处跳上 100ns 平台：2048 超过了 L2 dTLB 的 1536 项，TLB 彻底沦陷，每跳都要由硬件页表行走器去内存里翻四层表，再加上工作集也早已出了 L3（本机每 CCX 4MiB），平台值 100～130ns 就是「页表行走 + DRAM 取数」的合计。中间 4MiB 那档 40ns，是 L3 尚能接住一部分、TLB 已经开始漏的过渡带。这些台阶位置与 AMD 公开的 Zen 2 缓存/TLB 参数对得上，但归属解读应读作「与结构参数一致的解释」，不是逐位的取证。

两个台阶画出来：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 276" role="img" aria-label="指针追逐链每跳平均耗时曲线：横轴是工作集页数（对数），64 页以内每跳 3.6 纳秒贴着底部，128 到 1024 页缓慢爬升，2048 页起跳上 100 纳秒平台直到 13 万页；两道虚线分别标出 L1 dTLB 64 项和 L2 dTLB 1536 项的容量墙" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">指针追逐链：每跳平均耗时随工作集的变化</text>
<text class="ts" x="20" y="44" font-size="11" fill="#6b675e">每跳 ns</text>
<line class="grid" x1="70" y1="162" x2="620" y2="162" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="grid" x1="70" y1="94" x2="620" y2="94" stroke="#a29d90" stroke-width="1" stroke-dasharray="3 4"/>
<line class="axis" x1="70" y1="230" x2="70" y2="36" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="70" y1="230" x2="624" y2="230" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="62" y="166" text-anchor="end" font-size="11" fill="#6b675e">50</text>
<text class="ts" x="62" y="98" text-anchor="end" font-size="11" fill="#6b675e">100</text>
<polyline class="curve-k" points="70,225 119,219 168,214 217,213 266,176 315,94 364,83 413,83 462,55 511,77 560,70 609,62" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="70" cy="225" r="3.5" fill="#b03a2e"/>
<circle class="fill-c" cx="315" cy="94" r="3.5" fill="#b03a2e"/>
<line class="fl" x1="94" y1="230" x2="94" y2="64" stroke="#6b675e" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="tc" x="100" y="80" font-size="12" fill="#b03a2e">64 页：L1 dTLB（64 项）在这里装满</text>
<line class="fl" x1="289" y1="230" x2="289" y2="40" stroke="#6b675e" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="tc" x="295" y="44" font-size="12" fill="#b03a2e">1536 项：L2 dTLB 在这里沦陷</text>
<text class="ts" x="110" y="190" font-size="12" fill="#6b675e">左段贴底：翻译全在 L1 命中</text>
<text class="ts" x="430" y="140" font-size="12" fill="#6b675e">从这里往右，每跳都背上一次页表行走</text>
<text class="ts" x="70" y="248" text-anchor="middle" font-size="11" fill="#6b675e">64</text>
<text class="ts" x="168" y="248" text-anchor="middle" font-size="11" fill="#6b675e">256</text>
<text class="ts" x="266" y="248" text-anchor="middle" font-size="11" fill="#6b675e">1024</text>
<text class="ts" x="364" y="248" text-anchor="middle" font-size="11" fill="#6b675e">4096</text>
<text class="ts" x="462" y="248" text-anchor="middle" font-size="11" fill="#6b675e">16K</text>
<text class="ts" x="560" y="248" text-anchor="middle" font-size="11" fill="#6b675e">64K</text>
<text class="ts" x="624" y="266" text-anchor="end" font-size="11" fill="#6b675e">工作集（4KiB 页数，横轴对数）</text>
</svg>
</figure>

最能说明问题的是最后一组的对照：同样 512MiB 工作集、同一条链，只把页的尺寸从 4KiB 换成 2MiB 大页：

```text
4KiB 页（131072 项）：每跳 123.8 ns
2MiB 大页（  256 项）：每跳 104.1 ns
```

大页臂把 512MiB 折成 256 个 TLB 项，轻松住进 L2 dTLB，地图查询基本不再需要去内存里翻表；104ns 就是这台机器 DRAM 延迟本身。**差出来的约 20ns，是每次页表行走的净成本**：TLB 漏掉一次，访存就多付这么一笔。再把工作集缩到单个 2MiB 大页（512 页、1 个 TLB 项），每跳只剩 11.1ns：一个 TLB 项盖住整个工作集，剩下的纯粹是缓存与内存的速度。

这些数字只描述本机本次：笔记本频率在漂，五轮之间的波动有 ±15%，而且追逐链测的是平均延迟，不是硬件事件计数。但两个结论足够稳：**TLB 容量是比缓存容量更早到的墙**（64 页就到，缓存要好几百页）；**大页的收益就是这堵墙往远处挪了 512 倍**。

最后澄清一个常见误会：TLB miss 和缺页异常是两回事。TLB 漏了，硬件页表行走器自己去翻表，进程毫无知觉；只有走到表项发现 `present=0`，地图上根本没有这一页，才会真的陷入内核。那才是缺页异常。mmap 之后的第一次触碰、读到的零页、写出来的独占页，前面这些故事都发生在缺页里。

## 我踩的坑

**`VmPMD` 已经不在了。** 第一版脚本照着旧资料读 `VmPMD:`，读到的全是空值。7.2 的 status 只有 `VmPTE`，口径是 `mm_pgtables_bytes()`，四级全算。教训不新鲜但总有人踩：读 `/proc` 的脚本要按内核版本核对字段，`/proc` 从来不是稳定 ABI。

**smaps 的账会被 VMA 合并污染。** 第一版三页实验没加护栏，smaps 报出「三页区域 Private_Dirty=20kB」，连四的倍数都不是。原因是这段映射和相邻的匿名 VMA 合并成了一个，smaps 记的是合并后的大区域。两侧垫上 `PROT_NONE` 护栏（权限不同，内核不合并）后，三页的读数才干净。smaps 记的是 VMA 的账，不是你以为的那段地址的账。

**perf 不在，TSC 在漂。** 本机 `perf_event_paranoid=2` 且没装 perf，一开始想用 rdtscp 计周期数，又发现笔记本变频下「周期」和「时间」互相换算不出来。最终改用 `CLOCK_MONOTONIC` 墙钟、每档两百多万跳取平均。这测不出硬件事件的细粒度，但对「每跳平均延迟」这种量级的问题是够用的，而且可复现。

## 这一篇量出来的规律

mmap 不分配内存，它只在 VMA 链表里画一段边界，页表一动不动，pagemap 里 `present=0`；内存是触碰出来的。「存在」分两种：读缺页落在全内核共享的零页上，Rss 不涨、不独占；写一个字节才转正成独占页，转正的路径下一篇接着拆。页表按触碰面积以 512:1 增长，每多触碰 2MiB 多一张 4KiB 的 PTE 页，fork 的停顿按这本账结算，Redis 那篇的 48MB 算例在这里落了地。大页不省页表：每个 2MiB 大页旁边押着一张空的 PTE 页（`pgtable_trans_huge_deposit`），为的是将来拆分时不必在缺页路径上赌一次分配；省下的是每次 TLB miss 约 20ns 的页表行走，和把 TLB 容量墙推远 512 倍。PFN 自 4.0 起对无特权进程静默清零，所以本文关于零页的推断全部只靠位标志与 smaps 旁证。最后记住三个观测点的分工：pagemap 记页（present/exclusive/soft-dirty），smaps 记 VMA 聚合（Rss/Private_Dirty），`VmPTE` 记进程页表字节，排查内存问题时先弄清自己在读哪一个。

地图只负责登记领土的位置，不负责把领土搬来。把页搬来的是缺页异常：零页如何被识破、fork 之后父子共享的页如何记录、写时复制在哪一步真的复制，都发生在缺页路径里。

下一篇就走进去：《写一个字节，复制一整页：缺页异常与写时复制》。
