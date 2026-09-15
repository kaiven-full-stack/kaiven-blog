---
title: 同样是 8MB 的栈，一种边用边长，一种一次给全
description: ulimit -s 说 8MB，无限递归果然死在第 7588 帧，深度与限额严格线性（943/7588/60776，比例 1:8:64）；一千个线程每人 8MB 栈，VmSize 长到 7.82GiB，VmRSS 却只有 10MB，maps 行数一行没多。本文拆开两样都叫栈的东西：进程栈归内核管，exec 时出生一页，被参数环境撑到 132KB，缺页时 expand_downwards 挪一下 vm_start 就算长大；线程栈内核完全不管，glibc 一次 mmap 8MiB+4KiB，TCB 压在栈顶，guard 页垫在栈底，线程死后整条退回 40MB 的缓存仓库。1MB 的 guard gap 只在下方另有 VMA 时才拦人：空旷处 4MiB 大跳实测合法，有障碍时栈停在它上方 1023KB 处，-fstack-clash-protection 把「越过障碍 2MB 深处摔死」变成「死在合法边界」。还记录一次时代变迁：glibc 2.44 已改用 MADV_GUARD_INSTALL 装 guard 页，maps 里的 ---p 行消失，千条线程栈因此被内核合并成一个 7.82GiB 的 VMA。实测于本机 Linux 7.2.3、glibc 2.44、gcc 16.2.1，内核源码对照 vanilla v7.2，glibc 对照官方 glibc-2.44 tag。
pubDate: 2026-09-22
category: kernel
tags: [Linux, 内核, 内存管理]
---

[上一篇番外](/posts/kernel-memory-boot/)把内存的出身账结清了，这篇把镜头拉回进程一侧，讲一个人人天天用、很少有人看过内部的结构：栈。开场两个悬案。

悬案一：`ulimit -s` 说栈的上限是 8MB。无限递归会撞死在这 8MB 上，这不奇怪；奇怪的是，一个函数里只有一个 4MB 的局部数组，明明在 8MB 以内，可栈指针一步跳下去 4MB，内核认不认？直觉说「跳太远会被毙」，v7.2 上实测的答案是：**看下面有没有东西**。

悬案二：每个线程要一条独立的栈，默认大小恰好也是 8MB。一千个线程，一千段 8MB，会不会把进程压垮？实测：VmSize 长到 7.82GiB，VmRSS 只有 10MB，而 `/proc/self/maps` 的行数，一行都没有多。一行都没多，这比压垮更有意思。

两个悬案指向同一个事实：Linux 上叫「栈」的东西有两种，实现天差地别。进程栈归内核管，出生一页、边用边长；线程栈内核完全不管，glibc 一次申请到位、从生到死不长一寸。这篇逐个拆开。

实验环境沿用上一篇番外：本机 Linux 7.2.3（AMD Ryzen 5 5500U），glibc 2.44，gcc 16.2.1；内核源码对照 vanilla v7.2，glibc 源码对照官方 glibc-2.44 tag。实验全部是普通用户态 C 程序，`ulimit -s` 默认 8192（单位 KB）。

## 进程栈：出生只有一页

进程栈是 exec 的时候建出来的。v7.2 的 `fs/exec.c` 里，`bprm_mm_init()` 先把 RLIMIT_STACK 存进 `bprm->rlim_stack`（注释写着 exec 期间所有计算用它），然后调 `create_init_stack_vma()`。这个函数在 v7.2 被拆进了新文件 `mm/vma_exec.c`，核心就几行：

```c
vma->vm_end = STACK_TOP_MAX;
vma->vm_start = vma->vm_end - PAGE_SIZE;
...
mm->stack_vm = mm->total_vm = 1;
*top_mem_p = vma->vm_end - sizeof(void *);
```

一个 VMA，一页大，贴着地址空间顶端。进程栈的出生登记就这 4KB。物理内存一页没给，[第 1 篇](/posts/kernel-page-tables/)立过的规矩在这里同样生效：VMA 只登记地址范围，物理页等缺页再说。

随后 `setup_arg_pages()` 把 argv、envp、辅助向量压进这一页，不够就当场调 `expand_stack_locked()`（fs/exec.c:718）把 VMA 往下推。所以程序刚起来，maps 里的 [stack] 段就已经是 132KB：

```text
7ffdb68db000-7ffdb68fc000 rw-p 00000000 00:00 0    [stack]
```

132KB，参数和环境变量撑出来的实际大小。此后栈的每一次长大，都是同一套动作的重播。

顺带一个对照实验：glibc 也提供查询主线程栈的接口，`pthread_getattr_np(pthread_self(), ...)`，本机实测报 `size=8380416`（7.99MiB，比 8MiB 少两页对齐零头）。同一条栈，内核 VMA 说 132KB，glibc 说 7.99MiB，谁都没说谎：glibc 按 RLIMIT_STACK 反推出「最多能用这么多」的配额，内核 VMA 只登记「现在实际长到这么多」。配额是承诺，VMA 是记账，[VMA 篇](/posts/kernel-vma-malloc/)的二分法在栈上原样重现。

## 长大是缺页的副产品

进程栈没有任何专门的「长大」操作。函数调用把栈指针压到 vm_start 以下，访问了一段没登记的地址，触发缺页；缺页处理发现这个地址落在一个 GROWSDOWN 的 VMA 下沿之外，顺手把 VMA 的 vm_start 往下挪。长大，是缺页的副产品。

v7.2 的路径从 x86 缺页入口开始：

```c
/* arch/x86/mm/fault.c:1366 */
vma = lock_mm_and_find_vma(mm, address, regs);
```

这个函数（`mm/mmap_lock.c:496`）做三件事：`find_vma` 找 VMA；地址落在里面就直接返回；地址落在 vm_start 之下、而 VMA 带着 GROWSDOWN 标记，就把读锁升级成写锁，调 `expand_stack_locked()`。真正挪登记的是 `mm/vma.c` 的 `expand_downwards()`：

```c
size = vma->vm_end - address;
grow = (vma->vm_start - address) >> PAGE_SHIFT;

error = -ENOMEM;
if (grow <= vma->vm_pgoff) {
        error = acct_stack_growth(vma, size, grow);
        if (!error) {
                ...
                vma->vm_start = address;
```

扩张动作本身就一行：`vm_start = address`。重活全在前置检查 `acct_stack_growth()` 里：地址空间总量、mlock 限额、hugetlb 区域、overcommit，以及最常撞上的一条：

```c
/* Stack limit test */
if (size > rlimit(RLIMIT_STACK))
        return -ENOMEM;
```

扩张后的尺寸超过 RLIMIT_STACK，返回 -ENOMEM，缺页处理拿不到 VMA，SIGSEGV。无限递归的直接死因就是这一行。

死得多忠诚于限额？三档对照实验，每帧约 1KB，用 sigaltstack 装 SIGSEGV 处理器在崩溃现场报深度：

```text
ulimit -s 1024     SIGSEGV depth=943
ulimit -s 8192     SIGSEGV depth=7588
ulimit -s 65536    SIGSEGV depth=60776
```

943 : 7588 : 60776，比例 1 : 8.05 : 64.4，与限额严格线性。栈是预付费卡：充多少，说多深。

长大的过程可以现场围观。递归时每 1000 帧打印一次 [stack] 段和 VmRSS：

```text
depth=1000   VmRSS=2960kB   [stack] 7fff5e995000-7fff5eaa6000  (1092KB)
depth=3000   VmRSS=5248kB   [stack] 7fff5e77a000-7fff5eaa6000  (3248KB)
depth=5000   VmRSS=7404kB   [stack] 7fff5e55f000-7fff5eaa6000  (5404KB)
depth=7000   VmRSS=9560kB   [stack] 7fff5e344000-7fff5eaa6000  (7560KB)
```

两个读数两个故事。vm_end 7fff5eaa6000 从头到尾一动不动，栈顶在 exec 时就钉死了；动的是 vm_start，每 1000 帧往下推约 1076KB，与帧宽吻合。VmRSS 同步爬坡，每 1000 帧约 1080KB：用掉的每字节栈都是缺页到账的物理页。地址按帧登记，物理页按触碰到账，两层账各走各的。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="进程栈生长时间线：exec 时 create_init_stack_vma 建一页 VMA，参数环境把它撑到 132KB，之后每次访问越出 vm_start 触发缺页，lock_mm_and_find_vma 转 expand_downwards，通过 acct_stack_growth 检查则 vm_start 下移继续跑，检查失败则 SIGSEGV；实测 8MB 限额下递归死在 7588 帧，每 1000 帧 vm_start 下移约 1076KB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernB2As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">进程栈的生长：vm_end 钉死，vm_start 被缺页一级级往下推</text>
<rect class="bx-q" x="20" y="44" width="180" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="64" text-anchor="middle" font-size="12.5" fill="#2b2a26">exec：出生一页</text>
<text class="ts" x="110" y="82" text-anchor="middle" font-size="10.5" fill="#6b675e">create_init_stack_vma</text>
<rect class="bx" x="240" y="44" width="180" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="64" text-anchor="middle" font-size="12.5" fill="#2b2a26">参数环境撑开</text>
<text class="ts" x="330" y="82" text-anchor="middle" font-size="10.5" fill="#6b675e">本机起步 132KB</text>
<rect class="bx" x="460" y="44" width="180" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="550" y="64" text-anchor="middle" font-size="12.5" fill="#2b2a26">缺页：addr &lt; vm_start</text>
<text class="ts" x="550" y="82" text-anchor="middle" font-size="10.5" fill="#6b675e">lock_mm_and_find_vma</text>
<line class="fl" x1="200" y1="68" x2="236" y2="68" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As1)"/>
<line class="fl" x1="420" y1="68" x2="456" y2="68" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As1)"/>
<line class="fl" x1="550" y1="92" x2="550" y2="126" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As1)"/>
<rect class="bx" x="460" y="130" width="180" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="550" y="150" text-anchor="middle" font-size="12.5" fill="#2b2a26">expand_downwards</text>
<text class="ts" x="550" y="168" text-anchor="middle" font-size="10.5" fill="#6b675e">GROWSDOWN 才受理</text>
<rect class="bx-q" x="240" y="130" width="180" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="150" text-anchor="middle" font-size="12.5" fill="#2b2a26">acct_stack_growth</text>
<text class="ts" x="330" y="168" text-anchor="middle" font-size="10.5" fill="#6b675e">RLIMIT · gap · overcommit</text>
<rect class="bx-q" x="20" y="130" width="180" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="150" text-anchor="middle" font-size="12.5" fill="#2b2a26">通过：vm_start = addr</text>
<text class="ts" x="110" y="168" text-anchor="middle" font-size="10.5" fill="#6b675e">每 1000 帧下移 1076KB</text>
<line class="fl" x1="460" y1="154" x2="424" y2="154" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As1)"/>
<line class="fl" x1="240" y1="154" x2="204" y2="154" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As1)"/>
<rect class="bx-sick" x="240" y="204" width="400" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="440" y="222" text-anchor="middle" font-size="12.5" fill="#2b2a26">检查不过：拒绝扩张，SIGSEGV</text>
<text class="ts" x="440" y="240" text-anchor="middle" font-size="10.5" fill="#6b675e">实测 8MB 限额：无限递归死在 depth=7588</text>
<line class="flc" x1="330" y1="178" x2="380" y2="200" stroke="#b03a2e" stroke-width="1.6" stroke-dasharray="4 3"/>
</svg>
</figure>

## 1MB 无人区

回到悬案一：4MB 的局部数组，一步跳下去，死不死。

先交代这个担忧的来历，名叫 stack clash（栈冲突）：栈指针一大步跳过低洼地带，如果下方恰好有别的映射（堆、mmap 段、另一条栈），这一跳可能让栈数据静默落进别人的地盘，中间连一次缺页警报都没有。内核的防线叫 stack_guard_gap，v7.2 `mm/mmap.c:940`：

```c
unsigned long stack_guard_gap = 256UL<<PAGE_SHIFT;
```

256 页，1MB 无人区。启动参数 `stack_guard_gap=` 可以改，本机默认。

关键在这条防线在哪里执行。v7.2 的 expand_downwards 里，检查对象是 prev，栈下方最近的那个 VMA：

```c
/* Enforce stack_guard_gap */
prev = vma_prev(&vmi);
if (prev) {
        if (!vma_test(prev, VMA_GROWSDOWN_BIT) &&
            vma_is_accessible(prev) &&
            (address - prev->vm_end < stack_guard_gap))
                return -ENOMEM;
}
```

把条件读仔细：只有下方**确实存在**一个可访问的、非栈类的 VMA，且新地址离它不足 1MB，扩张才被拒绝。下方一片空旷的话，这一跳多大它都不管。所以悬案一的前半个答案反直觉：**空旷处的 4MB 大跳合法**。实测：4MB 局部数组，先摸最低地址再逐页向上摸，SURVIVED，退出码 0。objdump 确认 gcc 16.2.1 默认（-fstack-clash-protection 处于禁用，`gcc -Q --help=common` 可查）把整个帧编译成一条 `sub $0x400018,%rsp`，扩张一次到位，vm_start 直接下移 4MB。

版本考古一则：老内核（≤6.3）的 x86 缺页路径上还有一条独立规则，故障地址若低于栈指针 65536+32×8 字节就直接 bad_area，注释里说是给 enter、pusha 这类上古指令留的缓冲。6.4 用 lock_mm_and_find_vma 统一各架构的栈扩张时，这条 cushion 从 x86 消失；v7.2 的 fault.c 里连 GROWSDOWN 都 grep 不到了。

想让 guard gap 现身，得人工布一个障碍：用 MAP_FIXED 在栈 vm_start 下方 2MB 处钉一个 64KB 的可读写匿名映射，然后两种死法。

第一种，逐帧走近（递归下降，每帧 544B，障碍在 -2MB 处）：

```text
obstacle=[0x7ffe6adb9000-0x7ffe6adc9000)  (vm_start0 - obstacle_end = 1984 KB)
SIGSEGV depth=2033  (addr-obstacle_end=+1023 KB, vm_start0-addr=960 KB)
```

栈长到 960KB 就停了：1984KB 减去 1024KB 的无人区，一字节不多。故障地址落在 obstacle_end+1023KB，正好是边界线。对照组无障碍递归 2400 帧（栈长约 1.3MB）活蹦乱跳。无人区就是无人区：可以逼近，不能进入。

第二种，才是 stack clash 本尊：同样的障碍，换成那个 4MB 大跳。无保护版本：

```text
SIGSEGV  (addr-obstacle_end=-1992 KB)
```

故障地址在障碍**下方** 2MB。这次也被拦下了（find_vma 找到的是不带 GROWSDOWN 的障碍，扩张无从谈起），但这个地址暴露了事故形态：栈指针已经飞越过别人的整段映射，落在了它身后 2MB 的位置。加 -fstack-clash-protection 重编译再跑，同一次大跳：

```text
SIGSEGV  (addr-obstacle_end=+1020 KB)
```

编译器在大帧序言里每 4KB 插一条探测，栈指针一级级往下踩，扩张在无人区边界被正常拒绝，故障地址停在 obstacle_end+1020KB。两次都死，死的位置差了 3MB：一次死在别人地盘身后 2MB，一次死在自己边界线上。这就是栈冲突保护的全部意义，**它不负责让你活，负责让你死在正确的地方**。空旷处两个版本都活（无保护和带探测各测一次），保护对规矩程序零负担。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 278" role="img" aria-label="guard gap 四种实测姿势：第一行空旷处 4MiB 大跳存活，扩张一次到位；第二行障碍在下方 2MB、逐帧递归逼近，栈长到 960KB 停住，死在障碍上方 1023KB 的边界；第三行障碍存在时 4MiB 大跳无保护，故障地址在障碍下方 1992KB，飞越了整段映射；第四行同样大跳但编译期带探测，死在障碍上方 1020KB 的合法边界。黑块是障碍映射，虚线区是 1MB 无人区，红叉是 SIGSEGV 位置" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">1MB 无人区的四种实测姿势（stack_guard_gap = 256 页）</text>
<text class="ts" x="20" y="56" font-size="11" fill="#6b675e">空旷 · 4MiB 大跳</text>
<rect class="bx-q" x="180" y="40" width="250" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="305" y="57" text-anchor="middle" font-size="10.5" fill="#6b675e">下方无 VMA：一次扩 4MB，合法</text>
<text class="t" x="450" y="57" font-size="12" fill="#2b2a26">SURVIVED</text>
<text class="ts" x="20" y="108" font-size="11" fill="#6b675e">障碍 · 逐帧逼近</text>
<rect class="bar" x="180" y="92" width="14" height="26" fill="#2b2a26"/>
<rect class="bx-gone" x="194" y="92" width="100" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="244" y="109" text-anchor="middle" font-size="9.5" fill="#6b675e">1MB 无人区</text>
<rect class="bx" x="294" y="92" width="136" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="362" y="109" text-anchor="middle" font-size="9.5" fill="#6b675e">栈扩到 960KB 停</text>
<text class="tc" x="298" y="88" font-size="12" fill="#b03a2e">✕ +1023KB</text>
<text class="tc" x="450" y="109" font-size="11.5" fill="#b03a2e">SIGSEGV 死于边界</text>
<text class="ts" x="20" y="160" font-size="11" fill="#6b675e">障碍 · 大跳无保护</text>
<rect class="bar" x="180" y="144" width="14" height="26" fill="#2b2a26"/>
<rect class="bx-gone" x="194" y="144" width="100" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<rect class="bx" x="294" y="144" width="136" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="120" y="140" font-size="12" fill="#b03a2e">✕ −1992KB</text>
<line class="flc" x1="132" y1="146" x2="160" y2="156" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="4 3"/>
<text class="tc" x="450" y="161" font-size="11.5" fill="#b03a2e">SIGSEGV 死在障碍身后 2MB</text>
<text class="ts" x="20" y="212" font-size="11" fill="#6b675e">障碍 · 大跳带探测</text>
<rect class="bar" x="180" y="196" width="14" height="26" fill="#2b2a26"/>
<rect class="bx-gone" x="194" y="196" width="100" height="26" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<rect class="bx" x="294" y="196" width="136" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="298" y="192" font-size="12" fill="#b03a2e">✕ +1020KB</text>
<text class="tc" x="450" y="213" font-size="11.5" fill="#b03a2e">SIGSEGV 死于边界</text>
<text class="ts" x="20" y="248" font-size="11.5" fill="#6b675e">黑块 = MAP_FIXED 钉的 64KB 障碍映射；✕ 后的数字 = 故障地址相对障碍顶端的偏移</text>
<text class="ts" x="20" y="268" font-size="11.5" fill="#6b675e">探测（-fstack-clash-protection，每 4KB 一踩）改变的不是生死，是死亡地点</text>
</svg>
</figure>

## 线程栈：内核完全不管

线程栈从哪来？答案有点冒犯：内核不发。内核眼里没有「线程」这个物种，`clone(CLONE_VM)` 出来的只是一个共享地址空间的轻量级进程，共享的就是那个 mm_struct；每个线程的栈在哪、多大，内核一概不问。线程栈从头到尾是用户态 glibc（NPTL）的事。

历史一句话带过：Linux 最早的线程库 LinuxThreads 在用户空间模拟线程，信号、调度、同步处处变形，也不符合 POSIX；IBM 的 NGPT 和 Red Hat 的 NPTL 竞相重写，2003 年 IBM 退场，NPTL 成了唯一传人，glibc 2.34 时整体并入 libc。今天调 pthread_create，用的就是它。

看它怎么发栈。glibc 2.44 `nptl/allocatestack.c`，`allocate_stack()` 先定大小：

```c
if (attr->stacksize != 0)
        size = attr->stacksize;
else
        {
                lll_lock (__default_pthread_attr_lock, LLL_PRIVATE);
                size = __default_pthread_attr.internal.stacksize;
                lll_unlock (__default_pthread_attr_lock, LLL_PRIVATE);
        }
```

用户没指定就用默认值。默认多大？本机三档 ulimit 实测（`pthread_getattr_default_np`）：

```text
ulimit -s 8192       default stacksize = 8.00 MiB   guardsize = 4096
ulimit -s 1024       default stacksize = 1.00 MiB
ulimit -s unlimited  default stacksize = 2.00 MiB
```

两个发现。其一，**默认线程栈跟着 RLIMIT_STACK 走**，和进程栈的限额同源，所以说「线程默认也是 8MB」。其二，unlimited 时不发疯，落回 2MiB：这是 glibc 的架构默认栈大小，通用兜底值就是 2MB（ia64 上曾定义为 32MB），有些旧资料拿着 ia64 的数一概而论「线程栈最大 32MB」，在 x86_64 上不成立。地板也有：`sysconf(_SC_THREAD_STACK_MIN)` = 16384，配得再小也不低于 16KB。

定完大小先翻二手仓：`get_cached_stack()` 在 stack_cache 链表里找不小于请求尺寸的最小一条（比请求大出 4 倍以上的不收，免得浪费），找不到才开新的：

```c
return __mmap (NULL, size, prot, MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);
```

一次 mmap，8MiB+4KiB 整段到位。这是和进程栈的根本分野：进程栈出生一页、内核按需扩张，线程栈出生即全额、从此不长一寸。当然「全额」只是 VMA 篇里的第 2 层：拿到的是地址范围，物理页仍旧等缺页逐页到账，这个伏笔千线程实验会收。

映射好了装 guard 页。默认 1 页（E4 实测 guardsize=4096），位置在映射底部（栈向下增长的架构）。但 glibc 2.44 的安装方式是新面孔：

```c
static int allocate_stack_mode = ALLOCATE_GUARD_MADV_GUARD;
...
if (__madvise (guard, guardsize, MADV_GUARD_INSTALL) == 0)
        {
                pd->stack_mode = ALLOCATE_GUARD_MADV_GUARD;
                return true;
        }
/* If madvise fails ... it just need to PROT_NONE the guard area.  */
atomic_store_relaxed (&allocate_stack_mode, ALLOCATE_GUARD_PROT_NONE);
```

MADV_GUARD_INSTALL 是内核 6.13 新增的 madvise：把页标记成 guard（访问即 SIGSEGV），但**不改 VMA 的保护属性、不切分 VMA**。内核太老不支持，glibc 自动降级回 mprotect(PROT_NONE) 的老办法。本机 7.2.3，走的新路。这个选择有一个直接的观测后果，还给下一节埋了一个惊喜。

最后把线程对象压上栈：struct pthread（也就是 TCB）放在栈顶（`- TLS_PRE_TCB_SIZE` 方向），随后带着 CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_THREAD 等 flag 调 clone，新线程从这条用户态栈上开跑。解剖一条活线程（线程内自报 + maps 对照）：

```text
thread: stackbase=0x7f0754e00000 size=8388608 (8.00 MiB) guardsize=4096
thread: pthread_self(TCB)=0x7f07555ff6c0  stacktop(base+size)=0x7f0755600000  &local=0x7f07555fee07
maps 命中行: 7f0754dff000-7f0755600000 rw-p 00000000 00:00 0
```

三个数拼出完整布局：映射全长 0x801000 = 8MiB+4KiB，多出的 4K 就是 guard 页；stackbase 比映射底端高 4K，坐实底页是 guard；TCB 距栈顶 0x940（2368B），那是 TLS 静态区加 pthread 对象本体；线程函数的局部变量又在 TCB 下方 2.2KB。从上往下：TLS/TCB、函数帧、向着 8MiB 深处生长，最底下垫着 guard。

惊喜在 maps 那行：只有一条 rw-p，**没有 ---p 的 guard 行**。旧文章教人认线程栈，都说「rw-p 大段下面跟着一条 ---p 4K 就是 guard 页」，那是 mprotect 时代的指纹。MADV_GUARD_INSTALL 装的 guard 不改保护属性，maps 里彻底隐形。保护没有消失，只是看不见了：真踩上去照样 SIGSEGV，下面千线程篇的溢出实验就是证据。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 252" role="img" aria-label="allocate_stack 发放线程栈的流程：先定大小（attr 指定或默认等于 RLIMIT_STACK），查 stack_cache 二手仓（不小于请求的最小一条，超 4 倍拒用），命中直接复用；未命中则 mmap 8MiB+4KiB，用 MADV_GUARD_INSTALL 装底部 guard 页（老内核降级 mprotect），TCB 压栈顶，最后 clone 带 CLONE_VM 共享地址空间；线程退出整条栈退回缓存，上限 40MB" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernB2As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">glibc 2.44 发放线程栈：allocate_stack 的六步</text>
<rect class="bx-q" x="20" y="44" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="115" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">① 定大小</text>
<text class="ts" x="115" y="82" text-anchor="middle" font-size="10" fill="#6b675e">attr ?: 默认 = RLIMIT_STACK</text>
<rect class="bx" x="250" y="44" width="190" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">② 查 stack_cache</text>
<text class="ts" x="345" y="82" text-anchor="middle" font-size="10" fill="#6b675e">≥size 的最小条，&gt;4× 拒用</text>
<rect class="bx" x="480" y="44" width="160" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="560" y="64" text-anchor="middle" font-size="12" fill="#2b2a26">③ 未命中 mmap</text>
<text class="ts" x="560" y="82" text-anchor="middle" font-size="10" fill="#6b675e">8MiB+4K · MAP_STACK</text>
<line class="fl" x1="210" y1="68" x2="246" y2="68" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As3)"/>
<line class="fl" x1="440" y1="68" x2="476" y2="68" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As3)"/>
<line class="fl" x1="560" y1="92" x2="560" y2="126" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As3)"/>
<rect class="bx-sick" x="480" y="130" width="160" height="48" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="560" y="150" text-anchor="middle" font-size="12" fill="#2b2a26">④ 装 guard 页</text>
<text class="ts" x="560" y="168" text-anchor="middle" font-size="10" fill="#6b675e">madvise 安装，maps 隐形</text>
<rect class="bx" x="250" y="130" width="190" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="345" y="150" text-anchor="middle" font-size="12" fill="#2b2a26">⑤ TCB 压栈顶</text>
<text class="ts" x="345" y="168" text-anchor="middle" font-size="10" fill="#6b675e">栈顶 − TLS_PRE_TCB_SIZE</text>
<rect class="bx-q" x="20" y="130" width="190" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="115" y="150" text-anchor="middle" font-size="12" fill="#2b2a26">⑥ clone</text>
<text class="ts" x="115" y="168" text-anchor="middle" font-size="10" fill="#6b675e">CLONE_VM：共享地址空间</text>
<line class="fl" x1="480" y1="154" x2="444" y2="154" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As3)"/>
<line class="fl" x1="250" y1="154" x2="214" y2="154" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernB2As3)"/>
<rect class="bx-gone" x="140" y="204" width="380" height="36" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="330" y="226" text-anchor="middle" font-size="10.5" fill="#6b675e">线程退出：整条栈退回 stack_cache（上限 40MB），下次创建在 ② 直接命中</text>
<line class="fl" x1="115" y1="178" x2="160" y2="200" stroke="#6b675e" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#kernB2As3)"/>
</svg>
</figure>

## 一千个线程：两组读数与一次合并

悬案二结账。创建 1000 个线程，两种姿势：串行（建一个 join 一个，滚一千轮）和并发（一千个同时活着）。每个线程只摸 4KB 数据，全程读三个指标：

```text
串行：
start   VmSize=3212kB     VmRSS=1884kB    maps行=25   ~8M匿名段=0
i=1     VmSize=11408kB    VmRSS=2088kB    maps行=26   ~8M匿名段=1
i=1000  VmSize=11408kB    VmRSS=2088kB    maps行=26   ~8M匿名段=1

并发：
start   VmSize=3212kB     VmRSS=1860kB    maps行=25
i=1000  VmSize=8199476kB  VmRSS=10408kB   maps行=26
```

串行组是 stack_cache 的独角戏：第 1 个线程之后就有了一条 8MB 段，此后一千轮生死，VmSize 纹丝不动，永远是那一条栈在轮回。线程退出时栈不还内核，退回缓存链表（`nptl-stack.c` 里上限 `__nptl_stack_cache_maxsize = 40MB`，超了裁剪），下一个线程直接领走。一千个线程过手，RSS 恒定在 2088kB，物理页只磨出一条栈的量。

并发组是第 2 层的极限演出：一千条活线程，每条 8MB 配额，VmSize = 8199476kB ≈ 7.82GiB，虚拟地址空间真的铺出去了 8GB；VmRSS = 10408kB ≈ 10MB，每个线程只碰了 4KB 数据加 TCB，物理页就只到账这么多。**虚拟是配额，物理是触碰**，两个读数相差八百倍，是按需分页最直白的一张账单。

而 maps 行=26 才是本节真正的意外。一千条线程栈，maps 为什么一行没多？把进程的 maps 直接 dump 出来，答案一行：

```text
7f558d418000-7f5781800000 rw-p 00000000 00:00 0     （7.82 GiB）
```

一千条栈被合并成了一个 7.82GiB 的 VMA。合并条件全齐：glibc 的 mmap 挨着放，内核把相邻映射排得首尾相接；每段 flag 完全相同（rw-p 匿名）；而 MADV_GUARD_INSTALL 装的 guard 页不切分 VMA。三件事凑在一起，[VMA 篇](/posts/kernel-vma-malloc/)讲过的「同质则合」把一千段拉成了一段。要是 glibc 还在用 mprotect 做 guard，每条栈底都有一条 ---p 切断边界，maps 会老老实实一千多行。一次 madvise 的升级，顺带把千线程进程的地图从一本厚书合并成了一页纸。

这个合并不是没有代价的方向：VMA 篇数过「maps 行数是地址空间破碎度的直接读数」，现在这条经验要加个注脚，glibc 2.44 + 内核 6.13 之后，线程栈不再贡献行数，数行数估线程数会严重低估。反过来 vm.max_map_count 的压力也小了：一千条栈以前吃一千个 VMA 名额，现在吃一个。

最后补一个死亡笔记：线程栈不会扩张，线程里无限递归，踩到 guard 页就是 SIGSEGV。而线程栈只是共享地址空间里的一段 mmap，SIGSEGV 默认杀的是**整个进程**。实测：主线程每 100ms 打一行，子线程无限递归，输出停在：

```text
main: 创建线程后继续打印
main alive 1
（退出码 139 = 128 + SIGSEGV）
```

没有「只死那个线程」这回事。地址空间是共享的，账单也是共享的。

## 两种栈，一张表

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 300" role="img" aria-label="地址空间里的两种栈对照：左侧进程栈由内核管理，vm_end 钉死在顶端，出生一页被参数环境撑到 132KB，缺页时 vm_start 下移边用边长，下方是 1MB guard gap 无人区，配额 RLIMIT_STACK 8MB；右侧线程栈由 glibc 管理，一次 mmap 8MiB+4KiB，顶端 2368B 是 TLS 加 TCB，中间是函数帧生长区，底部 4K guard 页用 madvise 安装在 maps 不可见，死后整条退回缓存" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同一个名字，两种合同（本机实测数值标注）</text>
<text class="t" x="150" y="50" text-anchor="middle" font-size="13" fill="#2b2a26">进程栈 · 内核管</text>
<rect class="bar" x="60" y="60" width="180" height="10" fill="#2b2a26"/>
<text class="ts" x="250" y="69" font-size="10" fill="#6b675e">vm_end：exec 钉死</text>
<rect class="bx-q" x="60" y="70" width="180" height="88" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="150" y="94" text-anchor="middle" font-size="11" fill="#6b675e">[stack] VMA</text>
<text class="ts" x="150" y="112" text-anchor="middle" font-size="10.5" fill="#6b675e">出生 1 页，参数环境撑到 132KB</text>
<text class="ts" x="150" y="130" text-anchor="middle" font-size="10.5" fill="#6b675e">缺页 → vm_start 下移</text>
<text class="ts" x="150" y="148" text-anchor="middle" font-size="10.5" fill="#6b675e">配额 = RLIMIT_STACK（8MB）</text>
<text class="ts" x="250" y="163" font-size="10" fill="#6b675e">vm_start：一路下移</text>
<rect class="bx-gone" x="60" y="158" width="180" height="40" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="150" y="182" text-anchor="middle" font-size="10.5" fill="#6b675e">guard gap 1MB 无人区</text>
<text class="ts" x="150" y="222" text-anchor="middle" font-size="10.5" fill="#6b675e">（下方另有 VMA 时才拦扩张）</text>
<text class="t" x="490" y="50" text-anchor="middle" font-size="13" fill="#2b2a26">线程栈 · glibc 管</text>
<rect class="bar" x="400" y="60" width="180" height="22" fill="#2b2a26"/>
<text class="onbar" x="490" y="75" text-anchor="middle" font-size="10" fill="#f6f3ec">TLS + TCB：2368B</text>
<rect class="bx" x="400" y="82" width="180" height="116" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="490" y="110" text-anchor="middle" font-size="11" fill="#6b675e">栈体 8MiB</text>
<text class="ts" x="490" y="128" text-anchor="middle" font-size="10.5" fill="#6b675e">mmap 一次到位</text>
<text class="ts" x="490" y="146" text-anchor="middle" font-size="10.5" fill="#6b675e">函数帧向下生长</text>
<text class="ts" x="490" y="164" text-anchor="middle" font-size="10.5" fill="#6b675e">从生到死不长一寸</text>
<text class="ts" x="490" y="182" text-anchor="middle" font-size="10.5" fill="#6b675e">溢出踩 guard：全进程 139</text>
<rect class="bx-sick" x="400" y="198" width="180" height="14" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.3"/>
<text class="tc" x="490" y="230" text-anchor="middle" font-size="10" fill="#b03a2e">guard 4K：madvise 安装，maps 隐形</text>
<text class="ts" x="20" y="262" font-size="11.5" fill="#6b675e">左边内核记账、按需扩张；右边 glibc 全额发放、定额终身</text>
<text class="ts" x="20" y="282" font-size="11.5" fill="#6b675e">相同点只有一条：物理页都靠缺页逐页到账（并发千线程：虚拟 7.82GiB / 物理 10MB）</text>
</svg>
</figure>

| | 进程栈 | 线程栈 |
| --- | --- | --- |
| 谁创建 | 内核（exec → create_init_stack_vma） | glibc（pthread_create → allocate_stack） |
| 出生大小 | 1 页，被参数环境撑到 132KB | 默认 = RLIMIT_STACK，本机 8MiB 一次到位 |
| 能否生长 | 能：缺页触发 expand_downwards | 不能：配额即终身 |
| 上限检查 | acct_stack_growth 对 RLIMIT_STACK | 创建时定死；pthread_attr 可改 |
| 防护 | 与下方 VMA 保持 1MB gap | 底部 4K guard 页（madvise 安装） |
| 溢出姿势 | 拒扩或跳进映射，SIGSEGV | 踩 guard，SIGSEGV，全进程同死 |
| 物理页 | 缺页逐页到账 | 同左（千线程虚拟 7.82GiB / 物理 10MB） |
| 身后事 | 随进程注销 | 整条退回 stack_cache（上限 40MB）复用 |

## 我踩的坑

**量具自己吃栈。** 为了在崩溃现场报深度，我把读 /proc/self/maps 的代码塞进了递归函数，里面有个 char sl[512] 的局部缓冲。结果帧宽从 16B 被撑到 537B，对照组 25000 帧直接撞上 8MB 限额死了，我一度以为发现了新机制。把读数逻辑拆成独立的 noinline 函数、只在终点调一次，帧宽才恢复原样。测栈的实验，量具必须轻。

**-O2 会把帧删掉。** 用局部数组 filler[512] 撑帧宽，编译器判定「只写不读」是死存储，整个数组连帧一起删了：2400 帧递归没走出初始 132KB 的 VMA，障碍实验「安静通过」，其实是刺激根本没加上。volatile 加回去帧才回来（对照组 [stack] 长到 1288KB，与 2400×544B 吻合）。实验结果太安静时，先怀疑刺激有没有加上，objdump 看 `sub rsp` 的立即数，别信想象。

**尾调用把递归变循环。** rec() 最后一句调 rec() 是标准尾调用，-O2 会优化成跳转，栈永远不涨。全程 -fno-optimize-sibling-calls 压住，并在调用后留一句哑语句兜底。

**maps 经验会过期。** 「rw-p 大段下的 ---p 4K 是线程栈 guard」「一条线程一段 maps」，这两条老经验在 glibc 2.44 + 内核 6.13 上双双失效：guard 页 madvise 化后隐形，千条栈合并成一行。经验失效往往不是经验记错了，是底层换了做法。

## 两种合同

同一个「栈」字，两种合同。进程栈跟内核签：出生登记一页，每长一步都是缺页加当场记账，上限写在 RLIMIT_STACK 里，943、7588、60776，死的深度与配额严格成正比；生长路上有 1MB 无人区，但它只在下方另有 VMA 时才拦人，空旷处的大跳无罪，逼近障碍时停在边界上方 1023KB，而栈冲突保护改变的不是生死，是死亡地点。线程栈跟 glibc 签：默认 8MiB 配额一次发放，从此不长一寸，TCB 压在栈顶，guard 垫在栈底，2.44 起改 madvise 安装、从 maps 里彻底隐身；线程死了栈退回 40MB 的缓存仓库，串行千线程只磨一条栈，并发千线程 7.82GiB 配额对应 10MB 物理页，还顺手被内核合并成一条 VMA。两种合同只有一处条款相同：物理页都要靠缺页逐页到账，这是 VMA 篇三层账本的最后一次回响。

番外两篇到此收束：上一篇看内存从哪来，固件的清单交到伙伴系统的货架；这一篇看内存怎么用，一样边用边长，一样一次给全。加上主线七篇，内存这本账，从出身到合同，齐了。
