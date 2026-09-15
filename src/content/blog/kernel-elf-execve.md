---
title: 人没换，衣服全换了：execve 与 ELF 加载
description: readelf 报的入口不是 main 而是 _start（0x401070），反汇编里 main 的地址只是被 mov 进 rdi 的一个参数。exec 不是转世是换装：实测 pid 379842 exec 前后不变、cwd 不变、没设 CLOEXEC 的 fd 3 跨门活着仍指 /dev/null，设了 CLOEXEC 当场 EBADF；兄弟线程直接蒸发（Threads 2→1，de_thread 等它们死透才放行）。地址空间整个推倒重建：4 个 LOAD 段在 maps 里落成 5 行，多出来的一行是 Full RELRO——内核先把 RW 段整块铺成 rw-p，ld.so 重定位做完把 .got/.dynamic mprotect 回只读，VMA 一分为二（offset 0x2000/0x3000 相邻是铁证），norelro 对照则整块保持可写。.bss 是空头支票：同样 4MB 数组，不初始化文件只有 16024 字节，初始化后 4016064 字节，差 250 倍，MemSiz 比 FileSiz 多的 8 字节由内核当场清零兑现。PIE 版 main 地址每次运行都换地方，no-pie 钉死 0x401040。实测于本机 Linux 7.2.3、glibc 2.44、gcc 16.2.1，内核源码对照 vanilla v7.2，glibc 对照官方 glibc-2.44 tag。
pubDate: 2026-09-24
category: kernel
tags: [Linux, 内核, 进程管理]
---

[上一篇](/posts/kernel-task-birth/)讲了任务的出生：fork、vfork、pthread_create、kernel_thread 四个入口全进 `kernel_clone` 一扇门，进程与线程只差一张 clone 报关单。出生完还有个遗留问题：fork 出的子进程，代码和数据都是父进程的复制品。shell fork 出来的子进程总不能接着当 shell——它注定要变成 `ls` 或者 `vim`。

换装靠 exec。开场照例两个悬案。

悬案一：程序的入口是 main 吗？`readelf -h` 对本机编译的 hello 报的入口地址是 0x401070；`nm -n` 一查，0x401070 上站的符号叫 `_start`，main 反而排在它前面（0x401040）。入口压根不是 main——那内核把 CPU 交给谁了？

悬案二：exec 前后，什么死了，什么活着？量具实测：pid 379842 exec 前是它，exec 后还是它；cwd 没动；shell 重定向开的 fd 3 跨过 exec 还活着，仍指向 /dev/null。可另一边：主线程 exec 前进程里明明有 2 个线程，exec 后 `Threads: 1`——兄弟线程凭空蒸发了。同一场 exec，有的东西纹丝不动，有的东西尸骨无存，界线到底画在哪？

答案一句话：**exec 不换人，只换衣服**。task_struct 这个人站在原地（pid、cwd、fd 大多保留），身上的 mm——整个地址空间——推倒重建。死的只有旧衣服和几样随身违禁品。

实验环境沿用前两篇：本机 Linux 7.2.3（AMD Ryzen 5 5500U），glibc 2.44，gcc 16.2.1；内核源码对照 vanilla v7.2，glibc 对照官方 glibc-2.44 tag。量具在 `~/proc-lab`，普通用户态可复现。

## 衣服本身：ELF 解剖

先把衣服摊开看。一个最简 hello.c 编译两版：默认（PIE）和 `-no-pie`：

```
$ file hello_pie   | cut -d, -f1-2
hello_pie:   ELF 64-bit LSB pie executable, x86-64
$ file hello_nopie | cut -d, -f1-2
hello_nopie: ELF 64-bit LSB executable, x86-64
```

ELF（Executable and Linkable Format）是 Linux 可执行文件的通用格式，目标文件（.o）、动态库（.so）、coredump 也都是它。文件内部有两套视角，这是理解 ELF 的第一道坎：

- **Section**：编译链接器的视角。.text 放代码、.rodata 放只读数据、.data 放已初始化全局变量、.bss 放未初始化全局变量，由 Section Header Table 索引；
- **Segment**：加载器的视角。内核不关心你有几个 Section，只关心「哪块内容以什么权限进内存」，于是权限相同的相邻 Section 合并成一个 Segment，由 Program Header Table 索引。

```
$ readelf -SW hello_nopie   # Section 视角（节选）
  [12] .text      PROGBITS  0000000000401040 001040 000126 00  AX
  [23] .got       PROGBITS  0000000000403fc8 002fc8 000020 08  WA
  [25] .data      PROGBITS  0000000000404008 003008 000014 00  WA
  [26] .bss       NOBITS    000000000040401c 00301c 00000c 00  WA

$ readelf -lW hello_nopie   # Segment 视角（节选）
  Type     Offset   VirtAddr           FileSiz  MemSiz   Flg Align
  INTERP   0x0003ac 0x00000000004003ac 0x00001c 0x00001c R   0x1
      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
  LOAD     0x000000 0x0000000000400000 0x0005b0 0x0005b0 R   0x1000
  LOAD     0x001000 0x0000000000401000 0x000175 0x000175 R E 0x1000
  LOAD     0x002000 0x0000000000402000 0x000208 0x000208 R   0x1000
  LOAD     0x002de8 0x0000000000403de8 0x000234 0x000240 RW  0x1000
```

Program Header 里类型一堆（PHDR/INTERP/NOTE/DYNAMIC/GNU_RELRO……），但**只有 LOAD 需要进内存**，其余是给内核和动态链接器看的元数据。四个 LOAD 按权限分列：只读（ELF 头和符号表）、可执行（.text）、只读（.rodata）、可写（.data/.bss）。INTERP 那行值得多看一眼：它声明本程序需要「程序解释器」/lib64/ld-linux-x86-64.so.2——动态链接器。凡是动态链接的程序，内核加载完并不直接跳 main 或 _start，而是先把 ld.so 装进来、把入口交给它，由它完成动态库加载和重定位，再跳进程序本体。

三处细节埋着伏笔：

**其一，.bss 是空头支票。** 它的 Type 是 NOBITS——文件里不占一个字节的货，只登记一个尺寸。上面的 RW 段 FileSiz 0x234、MemSiz 0x240，差的 0xc（12 字节）就是 .bss（`data_noinit` 4 字节加对齐）。把这张支票开大点看效果，同一个 100 万元素 int 数组，一版不初始化（进 .bss），一版初始化（进 .data）：

```
$ ls -l bss_big data_big | awk '{print $9, $5}'
bss_big 16024
data_big 4016064
```

同样 4MB 的数据，文件尺寸差 250 倍。NOBITS 段在文件里只有一行登记（.bss 尺寸 0x3d0920），装载时内核把 MemSiz 超出 FileSiz 的部分用零兑现（v7.2 `fs/binfmt_elf.c:455` 的 `vm_brk_flags`）——而零页的物理内存还是缺页时才逐页到账，[第 0 篇](/posts/kernel-primer/)的按需分配在这里又出现了一次。全局变量「不初始化就是 0」不是编译器帮你赋的值，是这段兑现逻辑的赠品。

**其二，EXEC 与 DYN 是两种人生。** `-no-pie` 版的 Type 是 EXEC，VirtAddr 写死 0x400000，加载时按 ELF 里的地址原样映射；默认 PIE 版的 Type 是 DYN，VirtAddr 从 0 起算，全是相对偏移，加载基址由内核当场随机挑——这就是 ASLR。实测把 main 的地址打出来：

```
$ ./hello_pie; ./hello_pie
hello 100 0 main@0x5569e068e040
hello 100 0 main@0x55e182b74040
$ ./hello_nopie; ./hello_nopie
hello 100 0 main@0x401040
hello 100 0 main@0x401040
```

PIE 版每次运行 main 都换地方，no-pie 版钉死在 0x401040。攻击者想靠固定地址埋跳转的把戏，被 PIE 拆了台。后面对账 maps 时，这个「基址 + 偏移」的结构还会用到。

**其三，入口不是 main。** `readelf -h` 报 Entry point 0x401070（PIE 版是相对值 0x1070），`nm -n` 显示 0x401070 是 `_start`。这个符号是 glibc 用汇编写的一段开场白，`sysdeps/x86_64/start.S:57`。它的故事留到最后一节，先把内核这边的换装流程走完。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 330" role="img" aria-label="ELF 两套视角：左侧文件布局自上而下为 ELF 头、Program Header Table、各 Section、Section Header Table；右侧加载视角为四个 LOAD 段按权限合并：只读、可执行、只读、可写；Section 给链接器看，Segment 给加载器看，只有 LOAD 进内存" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernEXAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一个文件，两套视角：Section 给链接器看，Segment 给加载器看</text>
<text class="t" x="60" y="52" font-size="12.5" fill="#2b2a26">文件布局</text>
<rect class="bx-q" x="30" y="62" width="200" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="130" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">ELF 头（64B）</text>
<text class="ts" x="130" y="95" text-anchor="middle" font-size="10" fill="#6b675e">magic · Type · Entry</text>
<rect class="bx" x="30" y="110" width="200" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="130" y="127" text-anchor="middle" font-size="12" fill="#2b2a26">Program Header Table</text>
<text class="ts" x="130" y="143" text-anchor="middle" font-size="10" fill="#6b675e">Segment 的花名册</text>
<rect class="bx" x="30" y="158" width="200" height="88" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="130" y="178" text-anchor="middle" font-size="12" fill="#2b2a26">Sections</text>
<text class="ts" x="130" y="196" text-anchor="middle" font-size="10.5" fill="#6b675e">.text · .rodata · .data</text>
<text class="ts" x="130" y="212" text-anchor="middle" font-size="10.5" fill="#6b675e">.bss（NOBITS 空头支票）</text>
<text class="ts" x="130" y="228" text-anchor="middle" font-size="10.5" fill="#6b675e">.got · .init_array …</text>
<rect class="bx" x="30" y="254" width="200" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="130" y="271" text-anchor="middle" font-size="12" fill="#2b2a26">Section Header Table</text>
<text class="ts" x="130" y="287" text-anchor="middle" font-size="10" fill="#6b675e">链接时用，加载不看</text>
<text class="t" x="420" y="52" font-size="12.5" fill="#2b2a26">加载视角：只有 LOAD 进内存</text>
<rect class="bx" x="380" y="62" width="250" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="505" y="79" text-anchor="middle" font-size="12" fill="#2b2a26">LOAD R（0x400000）</text>
<text class="ts" x="505" y="95" text-anchor="middle" font-size="10" fill="#6b675e">ELF 头 · 符号表 · .interp</text>
<rect class="bx-q" x="380" y="110" width="250" height="40" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="505" y="127" text-anchor="middle" font-size="12" fill="#2b2a26">LOAD R E（0x401000）</text>
<text class="ts" x="505" y="143" text-anchor="middle" font-size="10" fill="#6b675e">.text 代码，只读可执行</text>
<rect class="bx" x="380" y="158" width="250" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="505" y="175" text-anchor="middle" font-size="12" fill="#2b2a26">LOAD R（0x402000）</text>
<text class="ts" x="505" y="191" text-anchor="middle" font-size="10" fill="#6b675e">.rodata 字符串常量</text>
<rect class="bx" x="380" y="206" width="250" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="505" y="226" text-anchor="middle" font-size="12" fill="#2b2a26">LOAD RW（0x403de8）</text>
<text class="ts" x="505" y="242" text-anchor="middle" font-size="10" fill="#6b675e">.data 有货 · .bss 记账</text>
<text class="ts" x="505" y="255" text-anchor="middle" font-size="10" fill="#6b675e">MemSiz 0x240 &gt; FileSiz 0x234</text>
<line class="fl" x1="230" y1="200" x2="376" y2="130" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs1)"/>
<line class="fl" x1="230" y1="205" x2="376" y2="230" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs1)"/>
<text class="ts" x="252" y="160" font-size="10.5" fill="#6b675e">同权限</text>
<text class="ts" x="252" y="175" font-size="10.5" fill="#6b675e">合并</text>
<text class="ts" x="30" y="318" font-size="11" fill="#6b675e">INTERP 段另有所指：动态链接器 ld.so，内核先把入口交给它，再由它跳进程序</text>
</svg>
</figure>

## 门房：从 execve 到 load_elf_binary

shell 跑一条命令的标准姿势是 fork + execve（fork 那半上一篇刚拆过）。execve 进内核后的路，v7.2 `fs/exec.c`：

```
execve(:1943) → do_execveat_common(:1808)
  → alloc_bprm(:1425)        备一个临时的 linux_binprm：
                             新 mm、第一页栈都先挂它名下（见番外）
  → bprm_execve(:1754)
      → prepare_binprm(:1628) 读文件头 256 字节
      → search_binary_handler(:1675) 遍历 formats 链表找认领人
```

`alloc_bprm` 里那两样——给新程序备一个全新 mm、先在栈顶划一页——[两种栈番外](/posts/kernel-two-stacks/)已经逐行拆过（`bprm_mm_init` 与 `create_init_stack_vma`，参数环境再把这页撑到 132KB），这里不重复，只记住：**新衣服在旧人还穿着旧衣服时就已经在后台备好了**。

`prepare_binprm` 读文件头，老内核读 128 字节，v7.2 已是 256（`include/uapi/linux/binfmts.h:19` 的 `BINPRM_BUF_SIZE`）。读开头是为了认格式：头 4 字节 `\x7fELF` 归 ELF 加载器管，`#!` 开头的归脚本加载器管。`search_binary_handler` 拿着这 256 字节遍历全局链表 `formats`（`fs/exec.c:89`），链表上每个 `linux_binfmt` 都试着认领，认领成功就调用它的 `load_binary`。v7.2 树里注册的加载器：`binfmt_elf`（:2132）、`binfmt_script`（#! 脚本）、`binfmt_misc`（用户自定义，比如 qemu 跨架构）、`binfmt_flat` 与 `binfmt_elf_fdpic`（嵌入式无 MMU 场景）。老资料里常见的 a.out、EM86 已经从内核删除了——`fs/` 下连文件都不剩。顺带一个冷知识：你每天跑的 shell 脚本，走的也是这扇门，`#!/bin/bash` 那行就是给 binfmt_script 看的报关单。

对 ELF 文件，认领人是 `load_elf_binary`（`fs/binfmt_elf.c:832`）。它的工作分两大段：先脱旧衣，再穿新衣。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 452" role="img" aria-label="execve 换装流程：execve 进 do_execveat_common，alloc_bprm 备好新 mm 与第一页栈，prepare_binprm 读头 256 字节，search_binary_handler 遍历 formats 链表（elf/script/misc/flat），load_elf_binary 先 begin_new_exec 脱旧衣（de_thread、CLOEXEC 清算、信号表复位、exec_mmap 换 mm），再 elf_map 逐段穿衣、create_elf_tables 建栈，最后 START_THREAD 把 rip 指到入口" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernEXAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">换装全程，人（task_struct）自始至终没动：pid、cwd、父进程原地保留</text>
<rect class="bx" x="110" y="40" width="380" height="50" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="300" y="61" text-anchor="middle" font-size="12.5" fill="#2b2a26">execve → do_execveat_common</text>
<text class="ts" x="300" y="79" text-anchor="middle" font-size="10.5" fill="#6b675e">fs/exec.c:1943 → :1808</text>
<line class="fl" x1="300" y1="90" x2="300" y2="102" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs2)"/>
<rect class="bx" x="110" y="106" width="380" height="50" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="300" y="127" text-anchor="middle" font-size="12.5" fill="#2b2a26">alloc_bprm：备好新 mm 与第一页栈</text>
<text class="ts" x="300" y="145" text-anchor="middle" font-size="10.5" fill="#6b675e">:1425 · 衣服先做，人还穿着旧的</text>
<line class="fl" x1="300" y1="156" x2="300" y2="168" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs2)"/>
<rect class="bx" x="110" y="172" width="380" height="50" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="300" y="193" text-anchor="middle" font-size="12.5" fill="#2b2a26">prepare_binprm：读文件头 256 字节</text>
<text class="ts" x="300" y="211" text-anchor="middle" font-size="10.5" fill="#6b675e">:1628 · 认格式：\x7fELF 还是 #!</text>
<line class="fl" x1="300" y1="222" x2="300" y2="234" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs2)"/>
<rect class="bx" x="110" y="238" width="380" height="50" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="300" y="259" text-anchor="middle" font-size="12.5" fill="#2b2a26">search_binary_handler：遍历 formats</text>
<text class="ts" x="300" y="277" text-anchor="middle" font-size="10.5" fill="#6b675e">:1675 → load_elf_binary（binfmt_elf.c:832）</text>
<text class="ts" x="500" y="256" font-size="10.5" fill="#6b675e">elf</text>
<text class="ts" x="500" y="270" font-size="10.5" fill="#6b675e">script（#!）</text>
<text class="ts" x="500" y="284" font-size="10.5" fill="#6b675e">misc · flat</text>
<line class="fl" x1="300" y1="288" x2="300" y2="300" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs2)"/>
<rect class="bx-sick" x="110" y="304" width="380" height="50" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="300" y="325" text-anchor="middle" font-size="12.5" fill="#2b2a26">begin_new_exec：脱旧衣（:1010）</text>
<text class="ts" x="300" y="343" text-anchor="middle" font-size="10.5" fill="#6b675e">兄弟线程清算 · CLOEXEC 关门 · 信号表复位 · 换 mm</text>
<line class="fl" x1="300" y1="354" x2="300" y2="366" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernEXAs2)"/>
<rect class="bx-q" x="110" y="370" width="380" height="50" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="300" y="391" text-anchor="middle" font-size="12.5" fill="#2b2a26">elf_map 逐段穿衣 → START_THREAD</text>
<text class="ts" x="300" y="409" text-anchor="middle" font-size="10.5" fill="#6b675e">建栈 create_elf_tables · rip = 入口 · rsp = 栈顶</text>
</svg>
</figure>

## 脱旧衣：begin_new_exec

穿新衣之前先盘点旧账。`begin_new_exec`（`fs/exec.c`，被 `load_elf_binary:1010` 调用）干的就是清算，v7.2 里的关键几步：

```
de_thread(:1134)          等所有兄弟线程死透——exec 是单人动作
unshare_files(:1145)      fd 表若與人共享，先拆伙独立
set_mm_exe_file(:1154)    新 mm 登记「我是谁」
exec_mmap(:1167)          旧 mm 摘下，bprm 里备好的新 mm 上身
unshare_sighand(:1188)    信号处理表独立并复位
do_close_on_exec(:1205)   凡带 CLOEXEC 标记的 fd，全部关门
```

悬案二的「死」名单就在这里。最狠的是第一条 `de_thread`：多线程进程里任何一个线程调 exec，其余线程全部被终结，exec 完成后进程只剩一个线程。量具 `threadexec.c` 实测——主线程先创建一个睡 30 秒的兄弟线程再 exec：

```
[exec 前] Threads:	2
[exec 后 pid=379976]
Threads:	1
```

exec 后 pid 还是 379976（shell 的 `$$` 读的就是它），线程数却回到 1。这很合理：新程序的代码里根本没有那些线程的函数体，让它们活着才是灾难。

fd 的去留由 CLOEXEC（close-on-exec）一位决定。量具 `fdexec.c` 用 shell 重定向预先打开 fd 3，两种姿势对照：

```
$ ./fdexec keep 3</dev/null
[exec 前] pid=379842
[exec 前] cwd=/home/kaiven/proc-lab
lr-x------ 1 kaiven kaiven 64 ... /proc/self/fd/3 -> /dev/null
[exec 后] fd 3 活着
$ ./fdexec cloexec 3</dev/null
[exec 前] pid=379844
[exec 前] 已给 fd 3 设 CLOEXEC
[exec 后] fd 3 已死 (EBADF)
```

不设 CLOEXEC，fd 3 跨过 exec 依然指向 /dev/null——`ls -l /proc/self/fd/3` 是 exec 之后的新程序（sh）读出来的，铁证。设了 CLOEXEC，`do_close_on_exec` 当场关门。fd 0/1/2 通常都不带 CLOEXEC，所以新程序的输出天然接着原终端——shell 管道 `ls | grep x` 能工作，靠的正是「fd 活过 exec」这条规则。

把生死簿汇总：

| 活着跨过 exec | 死在 exec 里 |
|---|---|
| pid / tgid、父进程、进程树位置 | 整个地址空间 mm（推倒重建） |
| cwd、根目录（fs_struct 保留） | 兄弟线程（de_thread 清算） |
| 未设 CLOEXEC 的 fd | 设了 CLOEXEC 的 fd |
| nice 值、rlimit、会话与进程组 | 信号处理函数（复位默认；屏蔽字与未决信号保留） |
| 打开的文件偏移（fd 活着的话） | stdio 未 flush 的用户态缓冲（随旧 mm 蒸发） |

## 穿新衣：逐段映射与建栈

`exec_mmap` 之后，`load_elf_binary` 开始往新 mm 上穿衣服，v7.2 的顺序：

1. **栈搬正**：`setup_arg_pages`（:1028）把 bprm 里暂存的那页栈挪到最终地址、按 rlimit 放开成长空间——栈的出生细节番外讲过，这里它是穿衣服前先把衣架挂好；
2. **映射 LOAD 段**：循环 Program Header，每个 PT_LOAD 调 `elf_map`（`binfmt_elf.c:371`）做文件映射——注意是 `vm_mmap` 建 VMA，**不读文件内容**，代码和数据要等真正执行/访问时缺页再从磁盘进内存（又是按需分配）。段内 MemSiz 超出 FileSiz 的部分（.bss）用 `vm_brk_flags`（:455）补零映射；
3. **加载 INTERP**：有动态链接器就先 `load_elf_interp`（:1254）把 ld.so 映射进来，入口地址换成 ld.so 的；
4. **建新栈**：`create_elf_tables`（:1296）把 argv、envp、辅助向量 auxv 摆到栈上——番外量过，这一摆就从 4KB 撑到 132KB；
5. **堆指针归零**：`mm->start_brk = mm->brk = ELF_PAGEALIGN(elf_brk)`（:1330），紧跟着 `arch_randomize_brk`（:1340）给堆起点也掺一把 ASLR 随机。老内核这里是个独立的 `set_brk` 函数，v7.2 已挪到段循环之后统一收口。堆从此出发，malloc 的小额通道（brk）和 [VMA 篇](/posts/kernel-vma-malloc/)讲的两条通道从这里起跑；
6. **交棒**：`finalize_exec`（:1378）收尾，`START_THREAD`（:1379）把寄存器收拾好：rip = 入口地址，rsp = bprm->p（栈顶）。

从这一刻起，CPU 再调度到这个任务，跑的就是新程序了。人还是那个人，衣服从里到外全换了。

## maps 五行对四个 LOAD 段

衣服穿完是什么样子，`/proc/pid/maps` 就是验货单。拿一个钉死地址的 no-pie 程序（`pausenopie`，pause() 挂住方便看）对账：

```
$ readelf -lW pausenopie | grep LOAD        $ grep pausenopie /proc/$P/maps
  LOAD 0x000000 0x400000 0x5b0 0x5b0 R      00400000-00401000 r--p 00000000
  LOAD 0x001000 0x401000 0x155 0x155 R E    00401000-00402000 r-xp 00001000
  LOAD 0x002000 0x402000 0x1f0 0x1f0 R      00402000-00403000 r--p 00002000
  LOAD 0x002de8 0x403de8 0x230 0x238 RW     00403000-00404000 r--p 00002000
                                            00404000-00405000 rw-p 00003000
```

前三个 LOAD 与前三行 maps 一一对上：地址、权限、offset 严丝合缝（RW 段的 MemSiz 0x238 − FileSiz 0x230 = 8 字节，正是它 .bss 的大小——空头支票和兑现记录也对上了）。**但第四个 LOAD 段变成了两行 maps，而且第一行竟是只读的。** RW 段怎么会有只读的一半？

线索在 offset 列：两行分别是 0x2000 和 0x3000，页号相邻——这是一整块映射被**劈开**的痕迹，不是两次独立 mmap。再看 Program Header 里那个一直没出场的角色：

```
GNU_RELRO  0x002de8  0x403de8  0x218  R
```

GNU_RELRO 段覆盖 [0x403de8, 0x404000)——恰好是 RW 段的头部（.init_array、.dynamic、.got 这批「启动时要改写、跑起来不许再动」的表格），终点 0x404000 齐着页边界；.data（0x404008）和 .bss（0x404018）落在下一页。真相是两班倒：**内核先把整个 RW 段一次铺成两页的 rw-p VMA（offset 0x2000 起）；程序跑起来后，ld.so 完成重定位，按 GNU_RELRO 的嘱咐把 [0x403000, 0x404000) mprotect 回只读**（glibc `elf/dl-reloc.c:362`），VMA 应声一分为二。这就是 Full RELRO：.got 从「可写的函数指针表」变成只读，改 GOT 劫持控制流的老招式被直接拆梯。链接器把 RELRO 终点凑齐页边界、让 .data 挪到下一页，就是为了这一刀切得干净。

对照组验证：同一份代码加 `-Wl,-z,norelro` 重编，maps 里那块区域就是一整段 rw-p，没人来劈——拆分确实是 ld.so 干的，不是内核。

PIE 程序结构相同，只是整体加了随机基址。看运行中的 `/usr/bin/cat`：四个 LOAD 段落在基址 0x563de800f000 上，RW 段同样裂成 r--p（offset 0xe000）+ rw-p（offset 0xf000）两行——RELRO 那一刀，谁来都躲不掉。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="四个 LOAD 段对出五行 maps：前三段一一对应；RW 段被劈成两行，内核先整块铺 rw-p，ld.so 重定位后按 GNU_RELRO 把前一页 mprotect 回只读，VMA 一分为二，offset 0x2000 与 0x3000 相邻是同一块映射被拆的铁证" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernEXAs3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="kernEXAs4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">对账：左边 readelf -lW（静态），右边 /proc/pid/maps（运行时）</text>
<rect class="bx" x="30" y="48" width="240" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="150" y="70" text-anchor="middle" font-size="11" fill="#2b2a26">LOAD R　0x400000　0x5b0</text>
<rect class="bx" x="30" y="96" width="240" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="150" y="118" text-anchor="middle" font-size="11" fill="#2b2a26">LOAD R E 0x401000　0x155</text>
<rect class="bx" x="30" y="144" width="240" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="150" y="166" text-anchor="middle" font-size="11" fill="#2b2a26">LOAD R　0x402000　0x1f0</text>
<rect class="bx" x="30" y="192" width="240" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="150" y="213" text-anchor="middle" font-size="11" fill="#2b2a26">LOAD RW 0x403de8</text>
<text class="ts" x="150" y="231" text-anchor="middle" font-size="10" fill="#6b675e">FileSiz 0x230 · MemSiz 0x238</text>
<rect class="bx" x="380" y="48" width="255" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="507" y="70" text-anchor="middle" font-size="11" fill="#2b2a26">00400000-00401000 r--p 00000000</text>
<rect class="bx" x="380" y="96" width="255" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="507" y="118" text-anchor="middle" font-size="11" fill="#2b2a26">00401000-00402000 r-xp 00001000</text>
<rect class="bx" x="380" y="144" width="255" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="507" y="166" text-anchor="middle" font-size="11" fill="#2b2a26">00402000-00403000 r--p 00002000</text>
<rect class="bx-sick" x="380" y="192" width="255" height="36" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="ts" x="507" y="214" text-anchor="middle" font-size="11" fill="#2b2a26">00403000-00404000 r--p 00002000</text>
<rect class="bx" x="380" y="240" width="255" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="507" y="262" text-anchor="middle" font-size="11" fill="#2b2a26">00404000-00405000 rw-p 00003000</text>
<line class="fl" x1="270" y1="66" x2="376" y2="66" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernEXAs3)"/>
<line class="fl" x1="270" y1="114" x2="376" y2="114" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernEXAs3)"/>
<line class="fl" x1="270" y1="162" x2="376" y2="162" stroke="#6b675e" stroke-width="1.4" marker-end="url(#kernEXAs3)"/>
<line class="flc" x1="270" y1="210" x2="376" y2="208" stroke="#b03a2e" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#kernEXAs4)"/>
<line class="flc" x1="270" y1="226" x2="376" y2="256" stroke="#b03a2e" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#kernEXAs4)"/>
<text class="tc" x="30" y="284" font-size="11.5" fill="#b03a2e">RW 段一分为二：内核先整块铺 rw-p，ld.so 重定位后按 GNU_RELRO</text>
<text class="tc" x="30" y="302" font-size="11.5" fill="#b03a2e">mprotect [0x403000,0x404000) 回只读，VMA 劈开（Full RELRO）</text>
<text class="ts" x="30" y="326" font-size="11" fill="#6b675e">铁证：两行 offset 0x2000/0x3000 页号相邻——同一块映射的拆分痕迹；norelro 对照则整块 rw-p</text>
</svg>
</figure>

## 从 _start 到 main

衣服穿好，CPU 的 rip 被指到入口 0x401070——`_start`。它到底干了什么，反汇编见真章：

```
$ objdump -d --no-show-raw-insn hello_nopie | sed -n '/<_start>:/,/hlt/p'
0000000000401070 <_start>:
  401070:	endbr64
  401074:	xor    %ebp,%ebp
  401076:	mov    %rdx,%r9
  401079:	pop    %rsi          # argc
  40107a:	mov    %rsp,%rdx     # argv
  40107d:	and    $0xfffffffffffffff0,%rsp   # 栈对齐到 16 字节
  401081:	push   %rax
  401082:	push   %rsp
  401083:	xor    %r8d,%r8d
  401086:	xor    %ecx,%ecx
  401088:	mov    $0x401040,%rdi            # ← main 的地址，作为参数
  40108f:	call   *0x2f33(%rip)  # 403fc8 <__libc_start_main@GLIBC_2.34>
  401095:	hlt
```

悬案一结案，证据就一行：`mov $0x401040,%rdi`——**main 的地址是被当作第一个参数塞进 rdi 的**。入口不是 main，main 只是 _start 请出来的一位客人。内核交给程序的现场极简：栈上是 argc/argv/envp，寄存器基本清零（xor ebp 顺手断了栈回溯的链），_start 把这些原料按调用约定码好，调 glibc 的 `__libc_start_main`。

`__libc_start_main`（glibc `csu/libc-start.c`）接棒后做 libc 侧的开机自检：初始化 stack protector、跑 `.preinit_array` 和 `.init_array` 里的构造函数（:179、:188——C 程序的 `__attribute__((constructor))` 就是搭这班车在 main 之前跑的），最后在 :372 `__libc_start_call_main(main, argc, argv)` 里调用 main；main 返回后调 exit，进程谢幕。那句 `hlt` 是永远不该走到的保险丝——__libc_start_main 不回头。

动态链接的程序还有个前置剧情：内核把入口交给的其实是 ld.so（INTERP 段那位），它把 libc 等共享库装进地址空间、做完重定位、执行 RELRO 那一刀，然后才跳到程序的 _start。所以上一节 maps 里 libc 的那几行，是 ld.so 的手笔，不在 hello 自己的 LOAD 段里。

## 我踩的坑

**stdio 缓冲不跨 exec，同一个坑我掉了两次。** fdexec 和 threadexec 第一版的「[exec 前]」输出全都凭空消失——printf 写进的是 stdio 的用户态缓冲区，缓冲挂在旧地址空间的堆上，exec 把 mm 整个换掉，没 flush 的字就随旧衣服一起火化了。给两个量具都补上 `fflush(stdout)` 才见到输出。这个坑本身就是本篇论点的脚注：用户态的一切（缓冲、全局变量、malloc 的堆）都活在 mm 里，exec 之后灰飞烟灭；能跨过去的只有内核记的账（fd、cwd、pid）。

**readelf 会说中文。** 本机 locale 下 readelf 输出「类型:」「入口点地址:」，`grep "Type:"` 一无所获，我一度以为 binutils 坏了。脚本里对 binutils 家族一律 `LC_ALL=C`，grep 的是稳定英文字段，不是给读者看的翻译。

**PIE 的对账要先找基址。** cat 的 LOAD 段 VirtAddr 从 0 起算，maps 里却趴在 0x563de800f000——对账前先从 maps 第一行把基址抠出来，每段地址 = 基址 + VirtAddr。忘了这一步，会以为 readelf 和 maps 在讲两个文件。

**老数字会过期。** 流传很广的「execve 读文件头 128 字节」在 v7.2 上是 256（BINPRM_BUF_SIZE）；「Linux 支持 a.out 格式」在 v7.2 的 fs/ 目录里连尸体都找不到。对照材料写死的数字，都要在目标版本上重新数一遍。

## 换装完毕

两个悬案并案归档。入口不是 main：内核把 rip 指向 _start，main 只是它 rdi 里的一个参数，中间还隔着 ld.so 的整场动态链接。exec 的生死簿也点清了：人（task_struct）没换——pid、cwd、进程树、nice 值原地不动，fd 只要没挂 CLOEXEC 也照常接班；换掉的是全部衣服——mm 推倒重建、信号处理复位、兄弟线程清算、stdio 缓冲火化。所谓「运行一个新程序」，在内核眼里只是同一个任务换了一身行头继续排队。

而「排队」正是下一步的事。新衣服的 START_THREAD 只是把 rip 和 rsp 摆好，任务本身早在上一篇的 `wake_up_new_task` 里就挂上了运行队列。轮到它上场时，CPU 凭什么挑中它、给它跑多久、跑腻了怎么换人——调度器的事，下一篇讲。
