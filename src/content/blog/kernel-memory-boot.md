---
title: 插了 16GB，账面只剩 15GB：内存的出身
description: 标称 16GB，free -m 只报 15362MB，消失的 1021MB 分两级：固件在清单里先扣走约 628MB，内核再永久自留 393MB，其中 struct page 账本一项占 246MB、六成有余。系列第一篇番外不进运行时，只用开机日志和两个 /proc 文件结清从通电到伙伴系统交接的全程：E820 清单六段 System RAM、PCI 洞是地址改道不占容量、只活十几秒的 memblock 管家、Faking a node 的三行证据，以及三本账的精确互咬：e820 求和与 dmesg 分母只差页帧 0 的 4K，Σmanaged×4K 与 MemTotal 分毫不差，reserved 字段 553484K 恰好等于永久自留加开机后七笔归还之和。实测于本机 Linux 7.2.3（UEFI 启动、固件未提供 SRAT），源码对照 vanilla v7.2。
pubDate: 2026-09-21
category: kernel
tags: [Linux, 内核, 内存管理]
---

系列主线已经收官：从第 0 篇的三样前置出发，沿着一次访存沉进页表、写时复制、伙伴系统、slab、VMA、page cache，直到第七篇的 OOM 保险丝，全程都站在运行时。这篇是系列的第一篇番外，往反方向走，回到所有故事开始之前的那一刻：通电。问题只有一个：机器上插的内存到底有多少，内核的账本上又报了多少，中间差的算谁的。

先看本机的数：

```text
$ free -m
               total        used        free      shared  buff/cache   available
Mem:           15362        9253        2134          59        4494        6108
```

标称容量 16GB，也就是 16384MiB；free 报的 total 是 15362MiB。差 1021MB，约 1GB。这 1GB 不是一笔扣的，它分两级：第一级发生在内核开始干活之前，固件扣的；第二级发生在开机过程里，内核自己留的。两级都有痕迹可查，本文用开机日志和两个 /proc 文件逐笔结清，其中第二级能闭合到个位数的 K。

实验环境照例先交代：本机笔记本，AMD Ryzen 5 5500U（Zen 2，6 核 12 线程），UEFI 启动（AMI，EFI v2.7），内核 7.2.3-1-cachyos，源码对照 vanilla v7.2 tag。用 dmidecode 读标称容量和 SPD 需要 root，这个环境拿不到（[硬件系列 DRAM 篇](/posts/hardware-dram-internals/)是同款口径），所以「标称 16GiB」按规格单和清单反推，第一级账只能结到量级；页与 /proc 这些前置概念见[《第 0 篇》](/posts/kernel-primer/)。

## 第一级减法：固件的清单

刚通电的内核对内存一无所知：有多少、在哪些地址、哪段能用，全不知道。硬件和操作系统中间还隔着一层固件，主板闪存里驻着的软件，它对操作系统的接口规范是 ACPI（Advanced Configuration and Power Interface），1997 年由英特尔、微软、东芝几家推出第一版。物理内存的分布，就是固件按这个规范报给内核的。

报告机制的名字很古董：E820。老 BIOS 路径是发 15H 号中断、操作码 0xE820，固件一段一段吐出内存地址范围。本机走的是 UEFI，固件交出来的是 EFI memory map，内核把它转换成同一张 e820_table，v7.2 的 `arch/x86/kernel/e820.c` 里留着这个入口：

```c
/*
 * Pass the firmware (bootloader) E820 map to the kernel and process it:
 */
__init char * e820__memory_setup_default(void)
{
        char *who = "BIOS-e820";
        ...
}
```

所以日志标签写的仍是 BIOS-e820，哪怕这台机器根本没跑过 BIOS 中断。这张清单会全文打进开机日志，用 `journalctl -k -b` 读，不需要 root（本机的 dmesg 命令被 `kernel.dmesg_restrict` 挡了，journalctl 是不受限的那条路）：

```text
BIOS-provided physical RAM map:
BIOS-e820: [mem 0x0000000000000000-0x000000000009ffff]  System RAM
BIOS-e820: [mem 0x00000000000a0000-0x00000000000fffff]  device reserved
BIOS-e820: [mem 0x0000000000100000-0x0000000009cfefff]  System RAM
BIOS-e820: [gap 0x00000000d0000000-0x00000000efffffff]
BIOS-e820: [mem 0x0000000100000000-0x000000040e2fffff]  System RAM
BIOS-e820: [mem 0x000000040e300000-0x000000042fffffff]  device reserved
```

（节选，本机完整清单连 gap 共 37 行。）三类标签是三种命运：**System RAM** 进内核的账本；**device reserved** 和 ACPI NVS、ACPI data 是固件与设备自留的，内核不碰；**gap** 表示这段地址空间里什么都没有。本机全部六段 System RAM：

| 段 | 地址范围 | 大小 |
| --- | --- | --- |
| 0 | 0x0 - 0x9ffff | 0.62MiB |
| 1 | 0x100000 - 0x9cfefff | 156.00MiB |
| 2 | 0xa001000 - 0xa1fffff | 2.00MiB |
| 3 | 0xa20f000 - 0xc9e5dfff | 3068.31MiB |
| 4 | 0xcd1ff000 - 0xcdffffff | 14.00MiB |
| 5 | 0x100000000 - 0x40e2fffff | 12515.00MiB |
| 合计 | | **16134072K ≈ 15.39GiB** |

清单里有两笔值得停下。

一笔是那个 gap：0xd0000000 - 0xefffffff，整整 512MiB，传说中的 PCI 洞。理解它的关键是：**洞不占容量**。这段地址空间让位给了 PCI 设备的 MMIO 寄存器，本该落在这里的内存被整体改道到 4G 以上，所以第五段能是一整条 12.2GiB 的连续区间。洞是地址的改道，不是内存的蒸发。

另一笔是压着地址空间最顶端的 device reserved：0x40e300000 - 0x42fffffff，541.0MiB。在内存顶端留一段给集成显卡帧缓冲（UMA）或者固件运行时是常见做法，本机的 5500U 正好带着 Radeon 集显。但 SPD 和 dmidecode 都读不到，这 541MiB 具体给了谁，我不猜，只记录位置和大小。固件报的清单内核还会当场修订，日志里就有一行 `efi: Remove mem51: MMIO range=[0xf0000000-0xf7ffffff] (128MB) from e820 map`，把一段标错了的 MMIO 从清单里划掉。

第一级的账到此能结出来的部分：标称 16777216K 减去 System RAM 合计 16134072K，固件层面少了 643144K，约 628MiB。其中确定的大头是顶端那 541.0MiB，剩下约 87MiB 散落在低地址的 ACPI NVS、ACPI data 和各类固件段里。再细就结不动了：低地址那些 device reserved 里哪些真有内存背书、哪些只是 MMIO 地址空间，不靠 dmidecode 分不出来。**量具够不着的地方，账就停在那个精度上**，第一级记「约 628MiB」。

## 只活十几秒的管家

清单到手，得有人管。可此刻该管内存的伙伴系统自己还不存在，它的货架和账本本身就要花内存，鸡生蛋。内核的办法是先立一个过渡管家：memblock。结构简单到近乎潦草，两个 region 数组，memory 记可用段，reserved 记预留段，仅此而已。

创建在 setup_arch 里，v7.2 `arch/x86/kernel/setup.c` 的调用顺序（行号是该 tag 下的）：

```c
e820__memory_setup();        /* 963: 清单从 boot_params 存进全局 e820_table 并打印 */
...
e820__memblock_setup();      /* 1077: 按清单建 memblock 分配器 */
...
initmem_init();              /* 1191: NUMA 感知与页框管理初始化 */
arch_reserve_crashkernel();  /* 1198: 给 kdump 预留内存 */
```

`e820__memblock_setup()` 的活儿就是遍历清单逐条登记：System RAM 走 `memblock_add()` 进 memory 列表，特殊的 SOFT_RESERVED 段走 `memblock_reserve()` 进 reserved 列表。从这里开始，到伙伴系统立起来之前，内核所有要内存的地方都找管家借。

大额的借主在本机日志里都有痕迹。第一个是内核镜像自己，code、rwdata、rodata、bss 加起来约 46MiB。第二个是页框管理账本 struct page：每 4KiB 物理页配一个 64 字节的描述符，按 SPARSEMEM_VMEMMAP 模型建（本机配置 =y），这本账的成本第二级减法里结。第三个是 NUMA 的节点对象，日志里那行很有意思：

```text
NODE_DATA(0) allocated [mem 0x40e2d4f80-0x40e2fffff]
```

x86 的 memblock 分配强制 top-down，node 0 的管理对象（pglist_data 连周边，共 172K）被直接顶到了全部内存的最后一段。第四个常客是 kdump：`crashkernel=` 参数划一段内存给崩溃时的应急内核，服务器上常见几百 MB。本机内核编译了 CONFIG_CRASH_DUMP=y，但命令行没带参数，`/sys/kernel/kexec_crash_size` 读出来是 0，一分没借，如实记。

管家的工作时间极短。等伙伴系统要用的 pglist_data、zone、货架结构都建完，交接仪式就在 mem_init 的调用链末端举行，v7.2 `mm/memblock.c`：

```c
void __init memblock_free_all(void)
{
        unsigned long pages;

        free_unused_memmap();
        reset_all_zones_managed_pages();

        memblock_clear_kho_scratch_only();
        pages = free_low_memory_core_early();
        totalram_pages_add(pages);
}
```

真正的交接在 `free_low_memory_core_early()`：先调 `memmap_init_reserved_pages()` 把 reserved 列表的页逐一标记，再遍历 memory 列表逐段把页放进各 zone 的 free_area 货架。注意 reserved 的部分也算「交接」了，只是方式不同：页登记进册，但带着已占用的标记，伙伴系统永远不会把它们出货。交接完 `totalram_pages_add()` 把总数记进 totalram 计数器，这个计数器就是后面 `/proc/meminfo` 里的 MemTotal。

交接之后管家谢幕。memblock 的结构体和 region 数组都标着 `__initdata`，自己占的内存也一并还给伙伴系统，运行时不留任何痕迹。想看它工作时的样子只有两条路：内核命令行加 `memblock=debug` 再重启（`early_memblock()` 解析这个参数，`memblock_dump_all()` 会把两份列表全量打进日志），或者开 CONFIG_MEMBLOCK_DEBUG 读 v7.2 新增的 debugfs 接口，那需要 root。本机两条都没走，也没有为本文重启；方法留给想自证的读者。账本不依赖它，管家的全部成果都写在了下面三本能对上的账里。

从清单到货架的全程：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="开机内存流水线：固件 UEFI/ACPI 交出 EFI 内存映射，转成 e820_table 清单（六段 System RAM 共 16134072K），memblock 管家按 memory 和 reserved 两份列表登记，借主包括内核镜像、memmap、NODE_DATA 和 kdump（本机为 0），memblock_free_all 交接时可用段逐页上货架、reserved 带标记移交，终点是伙伴系统的十一层货架" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernB1As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">从清单到货架：开机十几秒里的内存交接</text>
<rect class="bx-q" x="20" y="44" width="180" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">固件 UEFI / ACPI</text>
<text class="ts" x="110" y="86" text-anchor="middle" font-size="11" fill="#6b675e">EFI 内存映射（无 SRAT）</text>
<rect class="bx-q" x="240" y="44" width="180" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">e820_table 清单</text>
<text class="ts" x="330" y="86" text-anchor="middle" font-size="11" fill="#6b675e">System RAM 六段 · 16134072K</text>
<rect class="bx" x="460" y="44" width="180" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="550" y="66" text-anchor="middle" font-size="13" fill="#2b2a26">memblock 管家</text>
<text class="ts" x="550" y="86" text-anchor="middle" font-size="11" fill="#6b675e">memory / reserved 两份列表</text>
<line class="fl" x1="200" y1="72" x2="236" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB1As1)"/>
<line class="fl" x1="420" y1="72" x2="456" y2="72" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB1As1)"/>
<line class="fl" x1="550" y1="100" x2="550" y2="136" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB1As1)"/>
<rect class="bx" x="460" y="140" width="180" height="60" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="550" y="160" text-anchor="middle" font-size="13" fill="#2b2a26">借主们</text>
<text class="ts" x="550" y="177" text-anchor="middle" font-size="10.5" fill="#6b675e">镜像 · memmap · NODE_DATA</text>
<text class="ts" x="550" y="192" text-anchor="middle" font-size="10.5" fill="#6b675e">kdump（本机没借，0）</text>
<rect class="bx-q" x="240" y="140" width="180" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="160" text-anchor="middle" font-size="12.5" fill="#2b2a26">memblock_free_all</text>
<text class="ts" x="330" y="177" text-anchor="middle" font-size="10.5" fill="#6b675e">可用段逐页上货架</text>
<text class="ts" x="330" y="192" text-anchor="middle" font-size="10.5" fill="#6b675e">reserved 带标记移交</text>
<rect class="bx-q" x="20" y="140" width="180" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="160" text-anchor="middle" font-size="12.5" fill="#2b2a26">伙伴系统 free_area</text>
<text class="ts" x="110" y="177" text-anchor="middle" font-size="10.5" fill="#6b675e">十一层货架从此有货</text>
<text class="ts" x="110" y="192" text-anchor="middle" font-size="10.5" fill="#6b675e">第三篇的起点</text>
<line class="fl" x1="456" y1="170" x2="424" y2="170" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB1As1)"/>
<line class="fl" x1="236" y1="170" x2="204" y2="170" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB1As1)"/>
<text class="ts" x="20" y="228" font-size="12" fill="#6b675e">管家自己是 __initdata：交接完连自身占用一起释放，运行时只剩日志</text>
</svg>
</figure>

交接的终点正是[《第三篇：物理页的家底》](/posts/kernel-buddy-allocator/)的起点，buddyinfo 那十一层货架里的货，就是从这一刻开始有的。

## 贴标签：SRAT 与 Faking a node

清单解决了「哪些地址是内存」。服务器上还要解决「每段内存离哪颗 CPU 近」，这就是 NUMA，答案同样在固件里：ACPI 规范定义了两张表，SRAT（System Resource Affinity Table）记系统里有几个 node、每个 node 有哪些核和哪些内存，SLIT（System Locality Information Table）记 node 之间的距离。内核侧的解析入口是 `drivers/acpi/numa/srat.c` 的 `acpi_numa_init()` 和 `acpi_parse_srat()`，这条链从 6.1 到 v7.2 没怎么动过。

但本机的固件压根没给 SRAT。整份开机日志里搜 SRAT 和 SLIT，零命中，取而代之的是三行：

```text
No NUMA configuration found
Faking a node at [mem 0x0000000000000000-0x00000000040e2fffff]
NODE_DATA(0) allocated [mem 0x40e2d4f80-0x40e2fffff]
```

三行的出处是 x86 NUMA 初始化的回退链，v7.2 `arch/x86/mm/numa.c`：

```c
void __init x86_numa_init(void)
{
        if (!numa_off) {
                if (!numa_init(x86_acpi_numa_init))  /* 首选：ACPI SRAT */
                        return;
                if (!numa_init(amd_numa_init))       /* 次选：上古 AMD K8 北桥探测 */
                        return;
                if (acpi_disabled && !numa_init(of_numa_init))
                        return;
        }

        numa_init(dummy_numa_init);  /* 兜底：造一个覆盖全部内存的单节点，永不失败 */
}
```

本机是 AMD，但第二关 `amd_numa_init` 是给 K8 时代北桥寄存器留的路，Zen 上早已不适用；SRAT 又缺席，于是三关全空，`dummy_numa_init()` 把 0x0 - 0x40e2fffff 整个包成 node 0。Faking a node，伪造一个节点，日志用词毫不掩饰。单节点机器上 NUMA 从此当平面内存用，node 和 zone 的结构还在，只是都只剩一份。这正是[硬件系列 NUMA 篇](/posts/hardware-numa/)的本地半段，那篇量的是服务器侧的双路拓扑和距离阶梯，这里不重复。

顺带一个版本考古：6.1 时代干这活的 `numa_register_memblks()` 住在 `arch/x86/mm/numa.c`；到 v7.2，这段 x86 和 arm64 共用的逻辑搬进了 `mm/numa_memblks.c`，拆成 `numa_memblks_init()` 和 `numa_register_meminfo()`，`arch/x86/mm/numa.c` 里只剩回退链和这句 Faking。跨版本读内核，文件路径是最靠不住的东西。

## 第二级减法：把账结到个位数

交接和标签都完成了，开始算术。内核自己在开机时打了一行总账：

```text
Memory: 15563276K/16134068K available (22486K kernel code, 2968K rwdata,
        17176K rodata, 4824K init, 4208K bss, 553484K reserved, 0K cma-reserved)
```

先别急着做减法，这行里三个数有三个口径，v7.2 `mm/mm_init.c` 的 `mem_init_print_info()` 写得清楚：

```c
pr_info("Memory: %luK/%luK available (%luK kernel code, ... %luK reserved, ...)\n",
        K(nr_free_pages()), K(physpages),
        ...
        K(physpages - totalram_pages() - totalcma_pages),
```

分母是 physpages，进了账的物理页总数；available 是 `nr_free_pages()`，打印那一瞬间伙伴货架上的空闲页；reserved 不是直接读出来的，是 physpages − totalram 反推的。口径不同，这里埋着一个坑，后面踩给你看。

先对三本账。

**对账一：分母对 e820 求和。** 六段 System RAM 合计 16134072K，分母是 16134068K，差 4K。这 4K 有明确下落，日志里的 Initmem 行是从 0x1000 起步的：

```text
Initmem setup node 0 [mem 0x0000000000001000-0x00000000040e2fffff]
```

页帧 0 从不进账本。留着 0 页不用是 x86 Linux 的老传统：NULL 所在的那一页不映射，空指针解引用就必然炸得干脆，不会读到任何真数据。清单第一段明明是 640K，进账本只剩 639K。

**对账二：分母对 zoneinfo。** `/proc/zoneinfo` 每个 zone 有三列：spanned（地址跨度摊了多少页，洞也算）、present（真有 struct page 实体的页有多少）、managed（交给伙伴系统管的页有多少）。本机三个 zone：

```text
Node 0, zone      DMA   spanned    4095   present    3999   managed    3840
Node 0, zone    DMA32   spanned 1044480   present  825678   managed  809245
Node 0, zone   Normal   spanned 3203840   present 3203840   managed 3119783
```

Σpresent = 4033517 页，乘 4K 等于 16134068K，与 dmesg 的分母分毫不差。三列本身也各自成故事，拿最小的 DMA 区当标本：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 232" role="img" aria-label="DMA 区三列示意：spanned 4095 页的长条上有一个 96 页的红色缺口，那是 0xa0000 到 0xfffff 的传统显存与 BIOS 窗口；present 3999 页是去掉缺口后的实体；managed 3840 页是再减去预留后真正交给伙伴系统出货的部分。下方注明 DMA32 区差 218802 页全是 4G 以下的洞，Normal 区无洞" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">DMA 区的三列（单位：页）：spanned 数地址，present 数实体，managed 数出货</text>
<text class="tc" x="150" y="44" font-size="10.5" fill="#b03a2e">96 页的洞：0xa0000-0xfffff，传统显存/BIOS 窗口</text>
<text class="ts" x="100" y="70" text-anchor="end" font-size="11" fill="#6b675e">spanned 4095</text>
<rect class="bx" x="110" y="54" width="480" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-sick" x="129" y="54" width="12" height="24" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="100" y="110" text-anchor="end" font-size="11" fill="#6b675e">present 3999</text>
<rect class="bx-q" x="110" y="94" width="469" height="24" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<rect class="bx-sick" x="129" y="94" width="12" height="24" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="100" y="150" text-anchor="end" font-size="11" fill="#6b675e">managed 3840</text>
<rect class="bar" x="110" y="134" width="450" height="24" fill="#2b2a26"/>
<text class="onbar" x="122" y="150" font-size="10.5" fill="#f6f3ec">真正交给伙伴系统出货的部分</text>
<text class="ts" x="20" y="184" font-size="11" fill="#6b675e">DMA32：spanned − present = 218802 页，全是 4G 以下的洞（PCI 洞 512MiB、MMIO、固件区）</text>
<text class="ts" x="20" y="202" font-size="11" fill="#6b675e">Normal：spanned = present = 3203840 页，4G 以上没有一个洞；到 managed 差的 84057 页是 memmap 与各类预留</text>
<text class="ts" x="20" y="224" font-size="12" fill="#6b675e">present 与 managed 的差额就是第二级减法的发生地</text>
</svg>
</figure>

DMA 区 spanned − present = 96 页，恰好是 0xa0000 - 0xfffff 那 384K，清单第二行 device reserved 打出来的洞。DMA32 差的 218802 页是 4G 以下全部的洞加起来。Normal 区 spanned = present，4G 以上的 12.2GiB 一个洞都没有。

**对账三：managed 对 MemTotal。** Σmanaged = 3932868 页，乘 4K 等于 15731472K。而 `/proc/meminfo`：

```text
MemTotal:       15731472 kB
```

精确相等。硬件系列 NUMA 篇里读过的那行 `MemTotal: 15731472 kB`，就是这本账的终点。free -m 的 total 15362，不过是这个数除以 1024 再向下取整。

两端都钉死了，中间就都看得见了。present − managed = 100649 页 = 402596K ≈ 393MiB，这就是第二级减法：内核为自己永久留用的部分，开机结束也不会还。拆成三笔：

第一笔 memmap，大头。每个物理页一个 struct page，x86_64 上标准 64 字节，4033517 × 64B = 252094K ≈ 246MiB，占永久自留的 62.6%。算术很直白：每 4096 字节内存配 64 字节户口，比例 1.56%，内存越大户口越多，16GB 的机器光户口就要吃掉约 250MB。

第二笔内核镜像常驻：code 22486K + rwdata 2968K + rodata 17176K + bss 4208K = 46838K。init 段的 4824K 不在内，它开完机就还了，下面有行可对。

第三笔散预留 103664K ≈ 101MiB：percpu 区、启动期页表、e820 RAM buffer 和各类边角。逐项清单要 memblock=debug 才看得见，本文不编造分解，记总账。

永久自留结清，reserved 字段 553484K 也能拆了。它等于 402596K + 150888K，后面这 150888K 来自开机日志里的七笔归还：

```text
Freeing SMP alternatives memory: 68K
efi: Freeing EFI boot services memory: 60404K
Freeing initrd memory: 82268K
Freeing unused decrypted memory: 2028K
Freeing unused kernel image (initmem) memory: 4824K
Freeing unused kernel image (text/rodata gap) memory: 40K
Freeing unused kernel image (rodata/data gap) memory: 1256K
```

七笔相加恰好 150888K，与永久自留求和恰好 553484K，与 reserved 字段分毫不差。这些是开机期间「先借后还」的部分：最大一笔是 initrd，initramfs 镜像占的 82268K 在解包进真正的根文件系统之后整段归还；第二大是 EFI boot services，固件自己的工作面 60404K，移交完就收回；init 段那 4824K 与 Memory 行里的「4824K init」字段互相印证。

两级减法的全景：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 296" role="img" aria-label="账本瀑布图：最上深色长条是反推的标称 16777216K；向下第一条红色窄段是第一级减法，固件扣走 643144K 外加页帧 0 的 4K，得到 e820 System RAM 即 present 16134068K；再向下第二条红色窄段是第二级减法，内核永久自留 402596K，得到 managed 即 MemTotal 15731472K，也就是 free 报的 15362MiB；下方浅色框列出永久自留三笔分解、reserved 字段的精确拆分和 17308K 中间项的口径" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">两级减法：从标称 16GiB 到 MemTotal（条长按 K 数等比）</text>
<rect class="bar" x="30" y="36" width="600" height="30" fill="#2b2a26"/>
<text class="onbar" x="40" y="55" font-size="12" fill="#f6f3ec">标称 16384MiB = 16777216K（反推，dmidecode 需 root）</text>
<rect class="bx-sick" x="607" y="66" width="23" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="600" y="77" text-anchor="end" font-size="10.5" fill="#b03a2e">第一级：固件 −643144K（约 −628MiB），另有页帧 0 的 4K</text>
<rect class="bx-q" x="30" y="80" width="577" height="30" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="40" y="99" font-size="12.5" fill="#2b2a26">e820 System RAM = present = 16134068K</text>
<rect class="bx-sick" x="593" y="110" width="14" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="586" y="121" text-anchor="end" font-size="10.5" fill="#b03a2e">第二级：内核永久自留 −402596K（−393.2MiB）</text>
<rect class="bar" x="30" y="124" width="563" height="30" fill="#2b2a26"/>
<text class="onbar" x="40" y="143" font-size="12" fill="#f6f3ec">managed = MemTotal = 15731472K（free 报 15362MiB）</text>
<rect class="bx" x="30" y="170" width="600" height="92" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="44" y="190" font-size="11.5" fill="#6b675e">永久自留 402596K = memmap 252094K（62.6%）+ 镜像常驻 46838K + 散预留 103664K</text>
<text class="ts" x="44" y="210" font-size="11.5" fill="#6b675e">reserved 字段 553484K = 永久自留 402596K + 开机后七笔归还 150888K，精确</text>
<text class="ts" x="44" y="230" font-size="11.5" fill="#6b675e">归还最大一笔：initrd 82268K；次大：EFI boot services 60404K</text>
<text class="ts" x="44" y="250" font-size="11.5" fill="#6b675e">中间项 17308K = totalram − nr_free_pages：开机早期自用与 pcp 零钱，日志无行</text>
<text class="ts" x="30" y="284" font-size="12" fill="#6b675e">两端精确：Σpresent×4K = dmesg 分母 = e820 求和 − 4K；Σmanaged×4K = MemTotal</text>
</svg>
</figure>

还剩一个幽灵。available 15563276K 加上七笔归还 150888K 是 15714096K，距离 MemTotal 还差 17376K，把 SMP alternatives 那 68K 也算上仍差 17308K。这就是开头说三个口径时埋的坑：available 读的是伙伴货架，可货架上见不到的页不等于都发出去了。开机早期内核自己的分配（页表、哈希表、各类结构），外加 pcp 零钱抽屉（[第三篇](/posts/kernel-buddy-allocator/)的钉子实验量过它：释放的页先被 per-CPU 缓存吸收，不进伙伴链表），这些页在 totalram 里仍然算数，在 `nr_free_pages()` 里却已经不露面。totalram 减 nr_free，正是 17308K。这笔数被两端精确夹死，但 dmesg 不会为它的构成打印任何行，归属是按机制推的，如实记。

现在把整条链串起来：标称 16777216K，第一级固件拿走 643144K（约数，确定的大头是顶端 541MiB），页帧 0 再去 4K，得 present 16134068K；第二级内核永久自留 402596K（memmap 252094K + 镜像 46838K + 散预留 103664K），得 managed = MemTotal = 15731472K；free 报 15362MiB。标称到账面的 1045744K，628MiB 归固件，393MiB 归内核，1MiB 是反推与取整的零头，每一笔背后都有一行日志或一个算式。

## 我踩的坑

**Memory 行的三个字段口径不同。** available 读货架（`nr_free_pages`），reserved 按 totalram 反推，两者压根不是同一个东西的读数。我把它们当同一口径直接加减，得到 17308K 的幽灵，一度怀疑自己漏了哪行 Freeing 日志，翻出 `mem_init_print_info()` 的源码才明白两个数各自从哪来。对账的第一步不是加减，是把每个数的口径弄清。

**4K 的差最容易被吃掉。** e820 求和 16134072K，dmesg 分母 16134068K，awk 加出来差 4K，第一反应是「取整误差」想划掉。追下去发现是页帧 0，有地址、有机制（Initmem 从 0x1000 起步）、有传统（留 NULL 页）。账本的可信度恰恰建在小差值上：4K 都有名有姓，402596K 的分解才敢让人信。

**别硬把第一级配平。** 我第一版账本试图把 643144K 全部逐段落实，把低地址的 device reserved 全按内存背书算，结果配出来的总量反而超出标称 30 多 MiB。真相是 0xf0000000 - 0xf7ffffff 这类段是 MMIO，压根不占容量，日志里 `efi: Remove mem51` 那行就是证据。哪些段有内存背书，dmidecode 拿不到就是分不出来，这级账停在「约 628MiB」才是诚实的。

## 出身的两本账

内存的出身是两本账。固件的清单回答哪些地址是内存：UEFI 交出 EFI 内存映射，内核转成 e820_table，六段 System RAM 合计 16134072K；PCI 洞是地址改道不占容量，顶端 541MiB 的 device reserved 归固件自留，页帧 0 按传统永不进账，于是 present 停在 16134068K。内核的自留回答管理本身花了多少：memblock 当过渡管家，借给镜像、memmap、NODE_DATA（top-down，顶在最后的 172K）和 kdump（本机为 0），`memblock_free_all` 交接之后伙伴系统接手，Σmanaged 乘 4K 恰等于 MemTotal 15731472K；永久自留 402596K 里 struct page 户口占 62.6%，reserved 字段 553484K 恰好等于永久自留加七笔归还，最大一笔是 initrd 的 82268K。NUMA 的标签在本机没贴成：SRAT 缺席，x86 的三级回退走到 `dummy_numa_init`，Faking a node，全部内存进 node 0。从这一刻起，系统里每个物理页都有了户口：它住在哪个 zone 的哪层货架，第三篇讲过；它被谁借走、翻译、复制、回收，前面七篇讲过。

账结清了，进程这一侧还剩一块主线没细说的空白：两样都叫「栈」的东西。一样归内核管，出生只有一页，边用边长，撞到限额就不给长；另一样内核完全不管，glibc 在用户态一次申请到位，从生到死不会长大。同一个名字，两种命运，连溢出的姿势都不一样。

下一篇：《同样是 8MB 的栈，一种边用边长，一种一次给全》。
