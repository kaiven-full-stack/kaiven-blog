---
title: 同一次切换，3.5µs 还是 300µs：上下文切换的两笔账
description: 老资料的管道令牌法量出 3.4µs，还自认「没有很好地测量到间接开销」——本机 7.2.3 复现：纯令牌往返中位 3.50µs（进程）/3.36µs（线程），二十年没动过，这是直接开销：switch_mm_irqs_off 在 prev==next 处短路（tlb.c:841「Not actually switching mm's」，线程豁免条款），异 mm 才写 CR3，本机 Zen2 无 PCID，写 CR3 = TLB 全刷；__switch_to_asm 只押六个 callee-saved 寄存器加 rsp。间接开销才是变量：给两侧各加 2MB 工作集，同一次切换变 300µs（线程只要 138µs，差 3 倍）——决定性实验三点定案：总量 3M 留余量时收敛到 59/42，总量 5M 溢出时双双坠到 469/415，跨 LLC 域各自独享 L3 时消失（58/59）：2M+2M 恰好塞满 4MB L3，双地址空间的额外热行（页表、双栈、内核簿记）是压垮临界的稻草，进程组掉到内存带宽 20GB/s，线程组守在 L3 的 60GB/s。THP 实查 AnonHugePages=2048kB 排除了 TLB 填充主因。16M 档全员 4.4~5.5ms 被带宽抹平。安全税三项实测：meltdown 不受影响（无 KPTI 双页表税）、IBPB conditional（非每次切换）、STIBP always-on。切换账本 vol/invol 同核对打各占一半——谁记自愿取决于 EEVDF 先抢谁。实测于本机 Linux 7.2.3（CachyOS）、glibc 2.44、gcc 16.2.1，内核源码对照 vanilla v7.2。进程线五篇至此收官。
pubDate: 2026-09-27
category: kernel
tags: [Linux, 内核, 进程管理]
---

进程线的最后一环。前四篇走完了一个任务的半生：[出生](/posts/kernel-task-birth/)（clone 一扇门）、[换装](/posts/kernel-elf-execve/)（execve 人没换衣服全换）、[上秤](/posts/kernel-scheduler-eevdf/)（EEVDF 资格线与 deadline）、[挑座位](/posts/kernel-cpu-selection/)（wake_affine 与 POC 引擎）。每次都差一步没讲：CPU 上明明坐着别人，把旧的摘下来、新的装上去——**上下文切换**——到底花多少钱？

老资料给过答案：管道令牌法，两个进程往返一万次，平均单次 3.4µs。但它同时留了一句罕见的自我怀疑：「我们的测试代码中使用的数据并不是很多，所以其实我们上面的实验并没有很好地测量到间接开销。」

这篇补这一刀。先剧透两个数字：纯令牌切换，本机量出 **3.50µs**——二十年过去了，直接开销纹丝没动。给令牌双方各发一块 2MB 的工作集，同一次切换变成 **300µs**——而同样条件下线程对只要 138µs。同一次切换，差出两个数量级，还分出了进程与线程的两条命。钱花在哪，谁收的，量完见分晓。

实验环境：本机 Linux 7.2.3-1-cachyos（AMD Ryzen 5 5500U，6 核 12 线程，L3 两域各 4MB，Zen2 无 PCID），glibc 2.44，gcc 16.2.1；内核源码对照 vanilla v7.2。量具 `switchcost.c` 在 `~/proc-lab`：管道令牌 + 每侧一块可调大小的工作集缓冲（每 64 字节写一字节，强制取得缓存行所有权），进程对/线程对 × 四种钉核拓扑 × 五档工作集，矩阵 40 格，无 root 可复现。

## 切换的那一下：内核做了什么

`__schedule` 选中下家之后，`context_switch`（v7.2 `kernel/sched/core.c:5451`）干三件事：

```
prepare_task_switch(:5455)     记账：出队、统计、换 rq->curr
switch_mm_irqs_off(:5489)      换地址空间（如果需要的话）
switch_to(:5510)               换寄存器和栈
```

第二件是进程/线程分岔口。`switch_mm_irqs_off`（`arch/x86/mm/tlb.c:783`）进门先查一件事（:841）：

```c
if (prev == next) {
	/* Not actually switching mm's */
```

**prev 和 next 用的是同一份 mm——线程对——直接短路**，CR3 不动、TLB 不刷，注释都懒得掩饰：「其实没在切 mm」。只有跨地址空间才走 `load_new_mm_cr3`（tlb.c:565）写 CR3 寄存器，把 CPU 的页表基址换成下家的。这一写的价钱取决于硬件：有 PCID（页表地址空间标签）的 CPU 给 TLB 条目打上进程标签，换 CR3 不清场；**本机 Zen2 没有**（`/proc/cpuinfo` flags 里查无 pcid——AMD 到 Zen3 才补上），写 CR3 = TLB 全刷，下家的每一条映射都要重新 page-walk（[TLB 篇](/posts/hardware-tlb-page-walk/)量过 walk 的价钱：四级每级一次内存访问起）。

`context_switch` 里还藏着一段注释矩阵，交代内核线程怎么过关：

```
 *   user -> kernel   lazy + mmgrab_lazy_tlb()      借上家的 active_mm 用
 *   kernel ->   user   switch + mmdrop_lazy_tlb()  还回去
 *   user ->   user   switch                        正常换
```

内核线程 mm=NULL（[出生篇](/posts/kernel-task-birth/)量过：/proc/2/maps 零字节），切到它时根本不换页表——接着用上一个用户进程的地址空间（lazy TLB），反正它只跑内核地址那半段，谁家页表都一样。地址空间的「借还」在这里露了底。

第三件 `switch_to` 落到汇编 `__switch_to_asm`（`arch/x86/entry/entry_64.S:177`），全部家当就是这几行：

```asm
pushq %rbp / %rbx / %r12 / %r13 / %r14 / %r15   # 六个 callee-saved 寄存器
movq  %rsp, TASK_threadsp(%rdi)                 # 旧栈指针存进旧任务的 task_struct
movq  TASK_threadsp(%rsi), %rsp                 # 换上新任务的栈
popq  ...                                        # 在新栈上恢复六个寄存器
```

调用者保存的寄存器不管（回到用户态自然重建），FPU 状态、TLS 由 C 层的 `__switch_to` 收尾。直接开销的家底就这些：两次栈切换、十二次压弹栈、一次 CR3（跨地址空间才付）、若干记账。另外三项安全税本机实测：meltdown「Not affected」（AMD，无 KPTI，不付双页表切换税）、spectre_v2 的 IBPB 是 conditional（不是每次切换都拦）、STIBP always-on（限制 SMT 兄弟间分支预测共享）。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="context_switch 三步：prepare_task_switch 记账；switch_mm_irqs_off 分岔——同 mm 短路不碰 CR3，异 mm 写 CR3 且 Zen2 无 PCID 等于 TLB 全刷，内核线程 lazy 借上家 active_mm；switch_to 汇编押六个 callee-saved 寄存器加换 rsp；底部本机安全税三项" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernSWAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">切换的那一下（core.c:5451）：三步，一个分岔口</text>
<rect class="bx" x="30" y="46" width="120" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="90" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">prev 任务</text>
<text class="ts" x="90" y="84" text-anchor="middle" font-size="10" fill="#6b675e">正在 CPU 上</text>
<rect class="bx" x="510" y="46" width="120" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="570" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">next 任务</text>
<text class="ts" x="570" y="84" text-anchor="middle" font-size="10" fill="#6b675e">被秤选中</text>
<line class="fl" x1="150" y1="70" x2="196" y2="70" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernSWAs1)"/>
<line class="fl" x1="464" y1="70" x2="506" y2="70" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernSWAs1)"/>
<rect class="bx-q" x="200" y="42" width="260" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="64" text-anchor="middle" font-size="12.5" fill="#2b2a26">① prepare_task_switch</text>
<text class="ts" x="330" y="84" text-anchor="middle" font-size="10.5" fill="#6b675e">记账：出队 · 统计 · rq->curr 易主</text>
<line class="fl" x1="330" y1="98" x2="330" y2="118" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernSWAs1)"/>
<rect class="bx-q" x="120" y="122" width="420" height="94" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="142" text-anchor="middle" font-size="12.5" fill="#2b2a26">② switch_mm_irqs_off（tlb.c:783）——分岔口</text>
<text class="ts" x="330" y="163" text-anchor="middle" font-size="10.5" fill="#6b675e">prev == next（线程对）→ 短路，注释原话「Not actually switching mm's」</text>
<text class="ts" x="330" y="181" text-anchor="middle" font-size="10.5" fill="#6b675e">异 mm（进程对）→ 写 CR3；本机 Zen2 无 PCID = TLB 全刷，逐条重 walk</text>
<text class="ts" x="330" y="199" text-anchor="middle" font-size="10.5" fill="#6b675e">next 是内核线程（mm=NULL）→ lazy TLB，借上家 active_mm 不换页表</text>
<line class="fl" x1="330" y1="216" x2="330" y2="236" stroke="#6b675e" stroke-width="1.6" marker-end="url(#kernSWAs1)"/>
<rect class="bx" x="120" y="240" width="420" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="330" y="262" text-anchor="middle" font-size="12.5" fill="#2b2a26">③ switch_to → __switch_to_asm（entry_64.S:177）</text>
<text class="ts" x="330" y="282" text-anchor="middle" font-size="10.5" fill="#6b675e">押 6 个 callee-saved 寄存器 · 旧 rsp 存进 task_struct · 换新栈弹出</text>
<text class="ts" x="30" y="322" font-size="11" fill="#6b675e">本机安全税：meltdown 不受影响（无 KPTI 双页表）· IBPB conditional（非每次切换）· STIBP always-on</text>
</svg>
</figure>

## 直接开销：二十年没动过

矩阵先跑空载（工作集 0，纯令牌）。每格 20000 轮取中位，A/B 两侧钉法见拓扑列：

| 拓扑 | 进程对 median | 线程对 median |
|---|---|---|
| same（同逻辑核 4,4） | 3.50µs | 3.36µs |
| smt（同物理核 4,5） | 5.45µs | 5.08µs |
| l3（同 LLC 异核 4,2） | 4.43µs | 4.55µs |
| xl3（跨 LLC 域 4,8） | 5.28µs | 5.99µs |

老资料的参照系：管道两进程 3.4µs、线程 3.8µs（2.6.32 时代），lmbench 多组 2.7~5.5µs——本机同口径落在同一区间。三个读数。**其一，3.50µs 对 3.4µs**——空载进程切换的直接开销，从 2.6.32 到 7.2.3 二十年基本没动：寄存器就那么多，栈就那一条，记账再复杂也是缓存里的热数据。**其二，线程对只便宜 4%**（3.36 vs 3.50）：`prev==next` 短路省掉的 CR3/TLB 那一笔，在空载时几乎不值钱——TLB 里本来就没几条你的条目，刷了也不心疼。老资料「线程切换 ≈ 进程」的结论在本机同样成立：空载时，**切换的大头是调度器簿记和两次栈切换，不是地址空间**。**其三，拓扑差价**与上一篇 ping-pong 完全同源（同核最便宜、跨域最贵、p99 见真章），不重复展开。

顺带把切换账本翻开看一眼。同核对打 20000 轮后两侧自报（/proc/thread-self/status）：

```
进程对: [A] vol=8582  invol=11469   [B] vol=13578 invol=6473
线程对: [A] vol=9852  invol=10201   [B] vol=12820 invol=7230
```

令牌乒乓理应「全自愿」（每轮都阻塞在 read 上），账本却是自愿/非自愿各半开。这不矛盾：A 写完令牌的一瞬间，B 被唤醒且够格，EEVDF 当场抢占——A 还没走到 read 就被踹下来，这笔记**非自愿**；A 先坐到 read 上阻塞，B 才上来，这笔记**自愿**。同一轮往返记进哪一栏，取决于唤醒抢占和主动阻塞谁先到——[上一篇](/posts/kernel-scheduler-eevdf/)的「新人入队重挑，选中就抢」在账本上的指纹就是这个五五开。

## 间接开销：临界点的账单

现在给两侧各发一块工作集，每轮令牌之间都要把缓冲整个摸一遍（每 64B 写一字节）。l3 拓扑（各占一核、共享 4MB L3）下的中位数：

| 每侧工作集 | 两侧总量 | 进程对 | 线程对 | 比值 |
|---|---|---|---|---|
| 256KB | 0.5M | 9.07µs | 9.02µs | 1.00 |
| 1.5MB | 3M | 59.36µs | 41.89µs | 1.42 |
| **2MB** | **4M** | **200.26µs** | **66.92µs** | **2.99** |
| 2.5MB | 5M | 468.67µs | 414.71µs | 1.13 |
| 16MB | 32M | 5037µs | 4724µs | 1.07 |

账单在 2M 档炸开：同样的切换，进程对 200µs、线程对 67µs，差 3 倍；same 拓扑（同核共享 L1/L2）更狠，287~305µs 对 138µs（两次复跑）。但注意 1.5M 和 2.5M 两档——比值又缩回 1.4 和 1.1。**贵不是单调的，是一个峰，峰顶恰好在「两侧总量 = 4MB = 本域 L3 容量」的位置。**

三个对照实验把机制钉死：

1. **留余量**（1.5M×2 = 3M < 4MB）：进程对从 200µs 跌回 59µs，与线程对的差距缩到 17µs——那 17µs 才是 mm 切换路径（CR3+TLB 刷+簿记）的净价；
2. **溢出**（2.5M×2 = 5M > 4MB）：双双坠到 400µs+，按每轮 5MB 有效数据折算都在 11GB/s 上下——内存带宽的速度，两组一起掉下去，mm 的差别被淹没；
3. **各留余量**（xl3 拓扑 2M 档：A 独享域 0 的 4MB，B 独享域 1 的 4MB）：58.57µs 对 58.60µs，**完全相等**——数据装得下时，进程对线程毫无劣势。

拼起来就是一句话：**2M 档的 3 倍差距，不是「切地址空间」这个动作本身贵 133µs，而是双地址空间把恰好装满的 L3 推过了临界**。两份页表、两条用户栈、双份内核簿记，这些进程对独有的热行在 4MB 边缘挤掉了缓冲的数据行——进程组的每轮 touch 掉进内存（200µs ÷ 4MB ≈ 20GB/s，内存速度），线程组还守在 L3 里（67µs ≈ 60GB/s）。容量一旦有余量或彻底爆掉，差距就消失。

还有一个解释被证据排除了：TLB。本机 THP=always，实查进程的 `AnonHugePages: 2048 kB`——2M 缓冲整个是一张巨型页，CR3 全刷之后重建 TLB 只要几条表项，撑不起 133µs 的差距；16M 档（4096 个 4K 页或 8 张巨页 ×2）两组趋同也旁证了这点。间接开销的主角是**数据缓存的容量临界**，不是地址翻译。当然，边界如实交代：无 root 无 perf，PMU 计数器拆不到指令级，「临界挤出」是三点对照撑起来的推断，不是计数器直读。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 290" role="img" aria-label="间接开销三态图：l3 拓扑下中位往返时间随工作集变化，进程对与线程对在 256K 并列 9 微秒，1.5M 拉开到 59 对 42，2M 临界点炸开到 200 对 67 差 3 倍，2.5M 溢出后双双坠到 469 对 415 重新收敛；峰值恰在两侧总量等于 4MB L3 容量处" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">间接开销是一个峰，不是一条斜线（l3 拓扑，中位数，对数手感）</text>
<line class="axis" x1="60" y1="235" x2="630" y2="235" stroke="#6b675e" stroke-width="1.4"/>
<g>
<rect class="bx" x="80" y="210" width="26" height="25" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="108" y="210" width="26" height="25" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="107" y="252" text-anchor="middle" font-size="10.5" fill="#6b675e">256K×2</text>
<text class="ts" x="107" y="204" text-anchor="middle" font-size="10" fill="#6b675e">9.1 / 9.0</text>
</g>
<g>
<rect class="bx" x="190" y="140" width="26" height="95" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="218" y="157" width="26" height="78" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="217" y="252" text-anchor="middle" font-size="10.5" fill="#6b675e">1.5M×2=3M</text>
<text class="ts" x="217" y="134" text-anchor="middle" font-size="10" fill="#6b675e">59.4 / 41.9</text>
</g>
<g>
<rect class="bx-sick" x="300" y="85" width="26" height="150" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx-q" x="328" y="130" width="26" height="105" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="tc" x="327" y="252" text-anchor="middle" font-size="10.5" fill="#b03a2e">2M×2=4M 临界</text>
<text class="tc" x="327" y="79" text-anchor="middle" font-size="10" fill="#b03a2e">200.3 / 66.9（3 倍）</text>
</g>
<g>
<rect class="bx" x="410" y="48" width="26" height="187" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="438" y="53" width="26" height="182" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="437" y="252" text-anchor="middle" font-size="10.5" fill="#6b675e">2.5M×2=5M</text>
<text class="ts" x="437" y="42" text-anchor="middle" font-size="10" fill="#6b675e">468.7 / 414.7（趋同，双双掉内存）</text>
</g>
<g>
<rect class="bx" x="520" y="46" width="26" height="189" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="548" y="49" width="26" height="186" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="547" y="252" text-anchor="middle" font-size="10.5" fill="#6b675e">16M×2（同核）</text>
<text class="ts" x="547" y="40" text-anchor="middle" font-size="10" fill="#6b675e">≈5ms 带宽天花板抹平一切</text>
</g>
<text class="ts" x="60" y="276" font-size="11" fill="#6b675e">浅格 = 进程对，深格 = 线程对；峰顶 = 双份地址空间的热行把恰好装满的 L3 挤出界，进程组掉到 20GB/s，线程组守在 60GB/s</text>
</svg>
</figure>

老资料那句自我怀疑，现在可以替它补完了：它的令牌只传 1 个字节，工作集约等于零，量到的 3.4µs 是函数的原点值——没有错，但只是原点。**切换的真实价钱是个函数：f(工作集, 缓存容量余量, 是否跨地址空间, 座位拓扑)**，原点处 3.5µs，临界处 300µs，带宽区 5ms。拿一个数字当「上下文切换开销」背下来，才是那个实验真正的坑。

## 系列收束

五篇的数字摆在一起，一个任务的一生就齐了：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 190" role="img" aria-label="进程线五篇回顾流程图：出生（clone 一扇门，fork 159.3 微秒）到换装（execve pid 不变 mm 重建，RELRO 一刀）到上秤（EEVDF 资格线 deadline，切片 1.6ms）到挑座位（wake_affine 加 POC 引擎，跨域 p99 27 微秒）到切换（直接 3.5 微秒，临界 300 微秒）" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernSWAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一个任务的一生，五篇的签名数字</text>
<rect class="bx" x="20" y="48" width="112" height="72" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="76" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">① 出生</text>
<text class="ts" x="76" y="90" text-anchor="middle" font-size="9.5" fill="#6b675e">clone 一扇门</text>
<text class="ts" x="76" y="106" text-anchor="middle" font-size="9.5" fill="#6b675e">fork 159.3µs</text>
<rect class="bx" x="152" y="48" width="112" height="72" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="208" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">② 换装</text>
<text class="ts" x="208" y="90" text-anchor="middle" font-size="9.5" fill="#6b675e">pid 不变 mm 重建</text>
<text class="ts" x="208" y="106" text-anchor="middle" font-size="9.5" fill="#6b675e">RELRO 一刀劈 VMA</text>
<rect class="bx" x="284" y="48" width="112" height="72" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="340" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">③ 上秤</text>
<text class="ts" x="340" y="90" text-anchor="middle" font-size="9.5" fill="#6b675e">EEVDF 资格线</text>
<text class="ts" x="340" y="106" text-anchor="middle" font-size="9.5" fill="#6b675e">切片 1.6ms</text>
<rect class="bx" x="416" y="48" width="112" height="72" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="472" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">④ 挑座位</text>
<text class="ts" x="472" y="90" text-anchor="middle" font-size="9.5" fill="#6b675e">wake_affine+POC</text>
<text class="ts" x="472" y="106" text-anchor="middle" font-size="9.5" fill="#6b675e">跨域 p99 27µs</text>
<rect class="bx-q" x="548" y="48" width="96" height="72" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="596" y="70" text-anchor="middle" font-size="12" fill="#2b2a26">⑤ 切换</text>
<text class="ts" x="596" y="90" text-anchor="middle" font-size="9.5" fill="#6b675e">直接 3.5µs</text>
<text class="ts" x="596" y="106" text-anchor="middle" font-size="9.5" fill="#6b675e">临界 300µs</text>
<line class="fl" x1="132" y1="84" x2="148" y2="84" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSWAs2)"/>
<line class="fl" x1="264" y1="84" x2="280" y2="84" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSWAs2)"/>
<line class="fl" x1="396" y1="84" x2="412" y2="84" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSWAs2)"/>
<line class="fl" x1="528" y1="84" x2="544" y2="84" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSWAs2)"/>
<text class="ts" x="20" y="150" font-size="11" fill="#6b675e">每环都循环回起点：切换完成，新任务从它上次停下的那条指令继续——下一次出生、换装、上秤、挑座位，</text>
<text class="ts" x="20" y="170" font-size="11" fill="#6b675e">不过是另一个任务的一生。</text>
</svg>
</figure>

出生篇说，内核只有一种人叫任务，进程和线程差一张 clone 报关单；换装篇说，exec 不换人只换衣服，pid 原地不动而地址空间推倒重建；秤篇说，nice 是砝码不是令箭，资格线和 deadline 决定谁先上；座位篇说，选核是缓存热度、空闲程度和亲和性的三方协商，本机还藏着一台位图选核引擎；这篇说，切换本身便宜得二十年没涨过价，贵的是它身后被踩凉的缓存——而贵不贵，取决于你的工作集离容量临界有多近。

内存线九篇讲数据在哪、归谁管；进程线五篇讲谁来跑、怎么轮。内核的两条腿，到这里都各自走完了一程。没讲完的还有：信号怎么送达、exit 的全程、cgroup 那本组账、容器里的 PID 戏法——都是好题目，缘分到了再写。

## 我踩的坑

**token 收支不平衡，同一条河摔了第二次。** 第 4 篇刚写过「预热多了 100 个 token 量具撒谎」，这篇的 switchcost 又把 B 侧轮数设成 rounds+50——忘了 run_side 内部已经自带 50 轮预热。结果 B 永远等不到第 rounds+51 个令牌，整个矩阵后台挂死，5 分钟零输出。协议类量具的轮数守恒是**不变量**，这次直接写进了注释：两侧 rounds 相等即平衡。同一个坑摔两次，说明第一次只记住了「那次怎么修」，没抽象成「这类怎么防」。

**zsh 不分词，复跑空转一轮。** `for c in "proc same 2097152" ...; do ./switchcost $c` 在 bash 里天经地义，zsh 里 $c 是**一个**参数，量具直接报用法退出。关键复跑要么显式写参数，要么 ${=c}。

**量具的显示也会撒谎。** ws 档位的显示逻辑把 1572864（1.5M）打成了「2M」——读数是对的，标签是错的。差点把决定性实验当成 2M 档的复跑。输出格式化和测量逻辑一样需要质检。

**THP 不验证，解释就翻车。** 2M 档 proc/thr 差 3 倍，第一反应是「CR3 刷 TLB、512 个 4K 页重 walk」——查了 /sys 是 THP=always，再查进程 smaps_rollup：AnonHugePages 2048kB，缓冲整个是巨页，TLB 故事当场不成立，才逼出容量临界的正解。**解释跟着证据走，证据要查到物理层。**

**桌面机器上，临界实验必须复跑。** 2M 档 proc same 两次跑出 304.91 和 287.38——±6% 的漂移是桌面负载的呼吸。结论只建在复跑仍然站得住的差距上（3 倍的差距复跑纹丝不动，6% 的波动就不进结论）。
