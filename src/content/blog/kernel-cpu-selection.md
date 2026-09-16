---
title: 任务也挑座位：wake_affine、负载均衡与 Piece-Of-Cake
description: 上一篇任务挂上了「某个 CPU」的运行队列——哪个？本机拓扑 sysfs 实报：6 物理核 12 线程、L3 分两域（0-5 与 6-11 各 4MB），管道 ping-pong 量出座位的真实差价：同逻辑核往返中位 4.71µs、SMT 兄弟核 5.01、同 LLC 异核 4.99（p99 9.93）、跨 LLC 域 6.40（p99 27.35µs，尾部翻三倍）；同核往返 RES IPI 几乎为零，跨核几百次。放养模式的悬案：唤醒方钉在 cpu4，被唤醒的 B 只有 16% 落回 A 的核对，53% 赖在远端 cpu9/10/11——sync 引力确实把 target 指到了 cpu4，但唤醒瞬间 A 还占着它，target 闸门不过，recent 粘性接管（CachyOS 还把 recent 检查提到了函数最顶上）；cpu5 略多于 cpu4，恰是 POC 瀑布 Level 4t「target 的 SMT 兄弟」的指纹。负载均衡三态实测：钉死 0 次迁移、单线程放养 8 秒 0 次（跑得顺没人动你）、20 线程群堵 12 核 328 次迁移。本机还有个全书未载的独门引擎：/proc/sys/kernel 里八个 sched_poc_* 旋钮，vanilla v7.2 检索为零——CachyOS 下游的 Piece-Of-Cake 选核器 v2.6.3（源自 scx_cake）：每 LLC 一个 atomic64 位图、六级瀑布、packed 字一条 TZCNT 出双层结果，/sys/kernel/poc_selector 无 root 可读 active=1，TZCNT/POPCNT/PDEP 硬件三件套全开；旋钮 0644 要 root，A/B 拨不动，机制读源码、行为看间接。实测于本机 Linux 7.2.3（CachyOS）、glibc 2.44，vanilla 对照 v7.2，POC 对照 CachyOS/linux tag cachyos-7.2.3-2。
pubDate: 2026-09-26
category: kernel
tags: [Linux, 内核, 进程管理]
---

[上一篇](/posts/kernel-scheduler-eevdf/)讲完了秤：EEVDF 决定队列里**谁**先上 CPU。但还有个更早的问题没交代——出生篇结尾那句 `wake_up_new_task` 把新任务挂上「某个 CPU」的运行队列，**哪个** CPU？这台机器有 12 个逻辑核，任务的每一次出生、每一次睡醒，内核都要当场替它挑一个座位。挑得好，缓存是热的、唤醒是顺路的；挑得不好，数据全在别的核的缓存里凉着，每次唤醒还要跨核发中断。

开场两个悬案。

悬案一：管道两头各一个进程做令牌往返，A 钉死在 cpu4，B 放养。按老资料的说法，wake_affine 机制会「尽量优先选择唤醒它的进程所在的核」——B 应该赖在 A 旁边才对。实测 20000 轮的落点分布：B 落回 A 那个核对（cpu4/5）的比例只有 **16%**，反而 53% 的时间待在远端的 cpu9/10/11 上。引力失效了？

悬案二：翻本机 `/proc/sys/kernel/` 找调度旋钮，除了上一篇见过的，还多出一排任何资料都没提过的名字：`sched_poc_selector`、`sched_poc_greedy_search`、`sched_poc_smt_fallback`……一共八个。在 vanilla v7.2 源码树里全文检索 `sched_poc`：**零命中**。这台机器的内核里藏着一台资料之外的引擎。

这篇把选核这件事拆成三层：通用的挑座位逻辑（vanilla 源码）、座位的实测差价（本机量具）、以及那台独门引擎（CachyOS 的 Piece-Of-Cake 选核器）。

实验环境：本机 Linux 7.2.3-1-cachyos（AMD Ryzen 5 5500U，裸机无虚拟化），vanilla 源码对照 v7.2，POC 源码对照 CachyOS/linux 仓库 tag `cachyos-7.2.3-2`（本机包 7.2.3-1 同源码）。量具 `pingpong.c`、`migrate.c` 在 `~/proc-lab`，无 root 可复现；POC 旋钮 0644 要 root，本篇拨不动它，机制读源码、行为看间接证据，边界如实交代。

## 本机地图：12 个座位，三层远近

先画座位表。sysfs 实报：

```
cpu0/1 → core 0    L1d/L1i/L2 共享：0-1
cpu2/3 → core 1    L3 共享：0-5（4MB）
...                L3 共享：6-11（4MB）
cpu10/11 → core 6
```

6 个物理核，每核 2 个超线程（[超线程篇](/posts/hardware-hyperthreading/)讲过：兄弟线程共享一套执行单元）；L3 分成两个域，0-5 一域、6-11 一域，各 4MB——注意这不是 NUMA，整机一个内存节点，只是缓存分了两个岛（[NUMA 篇](/posts/hardware-numa/)的跨节点罚单在这里降级成跨 LLC 罚单）。

座位的远近分三层，每层对应一种缓存共享关系：同一逻辑核（一切全热）→ SMT 兄弟核（共享 L1/L2，只丢各核私有状态）→ 同 LLC 异核（L1/L2 全凉，L3 还认得你）→ 跨 LLC 域（连 L3 都凉了，数据回内存去取）。内核把这个层次结构叫**调度域**（sched_domain），开机时按缓存拓扑建成一棵树：SMT 域 → LLC 域 → 全机域，越往下共享越好、迁移越便宜。

差价当场量。`pingpong.c`：两个进程用管道打令牌，一轮 = A 写 1 字节唤醒 B + B 写回 1 字节唤醒 A，20000 轮，五种座位安排对照：

| 模式 | 座位 | 往返中位 | 平均 | p99 | RES 重调度 IPI |
|---|---|---|---|---|---|
| same | 同逻辑核（都钉 cpu4） | 4.71µs | 5.27µs | 8.10µs | +95 |
| smt | 同物理核两超线程（4,5） | 5.01µs | 5.31µs | 7.87µs | +153 |
| l3 | 同 LLC 异核（4,2） | 4.99µs | 5.94µs | 9.93µs | +785 |
| xl3 | 跨 LLC 域（4,8） | 6.40µs | 8.94µs | **27.35µs** | +277 |
| free | A 钉 cpu4，B 放养 | 4.94µs | 6.59µs | 19.10µs | +462 |

三个读数点。**中位数差距不大**（4.7~6.4µs），令牌往返的大头是两次上下文切换本身，座位远近只在边际上加价；**尾部差距巨大**——跨 LLC 域 p99 27.35µs，是同核的 3.4 倍，冷缓存的账不在平均值里，在尾巴里。**IPI 那一列**：同逻辑核往返几乎不产生核间中断（95 次里大半是背景噪声——同一个运行队列内置 NEED_RESCHED 标记即可，不用通知任何人）；一旦跨逻辑核，几百次起步（读 /proc/interrupts 的 RES 行对账，含背景）。SMT 兄弟核也只有 153——空闲侧在 idle 里用 MWAIT 盯着 NEED_RESCHED 的内存位，多数唤醒不必真发中断。

free 模式那行先留着，悬案一的证据在下一节。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 306" role="img" aria-label="本机座位图与三层远近：12 个逻辑核排成 6 个物理核的 SMT 对，L3 分两域 0-5 与 6-11 各 4MB；同逻辑核往返中位 4.71 微秒、SMT 兄弟 5.01、同 LLC 异核 4.99 但 p99 9.93、跨 LLC 域 6.40 且 p99 27.35 微秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">本机座位表：6 物理核 × 2 超线程，L3 两个岛；ping-pong 量出的三层差价</text>
<rect class="bx-q" x="30" y="46" width="285" height="120" rx="6" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="40" y="64" font-size="11" fill="#6b675e">LLC 域 0（L3 4MB，cpu 0-5）</text>
<g>
<rect class="bx" x="42" y="76" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/><text class="ts" x="70" y="97" text-anchor="middle" font-size="11" fill="#2b2a26">cpu0|1</text>
<rect class="bx" x="106" y="76" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/><text class="ts" x="134" y="97" text-anchor="middle" font-size="11" fill="#2b2a26">cpu2|3</text>
<rect class="bx-q" x="170" y="76" width="56" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/><text class="ts" x="198" y="97" text-anchor="middle" font-size="11" fill="#2b2a26">cpu4|5</text>
<text class="ts" x="198" y="126" text-anchor="middle" font-size="10" fill="#b03a2e">A 钉在 cpu4</text>
</g>
<text class="ts" x="42" y="152" font-size="10.5" fill="#6b675e">每格 = 1 物理核（一对 SMT 兄弟，共享 L1/L2）</text>
<rect class="bx-q" x="345" y="46" width="285" height="120" rx="6" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="355" y="64" font-size="11" fill="#6b675e">LLC 域 1（L3 4MB，cpu 6-11）</text>
<g>
<rect class="bx" x="357" y="76" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/><text class="ts" x="385" y="97" text-anchor="middle" font-size="11" fill="#2b2a26">cpu6|7</text>
<rect class="bx" x="421" y="76" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/><text class="ts" x="449" y="97" text-anchor="middle" font-size="11" fill="#2b2a26">cpu8|9</text>
<rect class="bx" x="485" y="76" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/><text class="ts" x="513" y="97" text-anchor="middle" font-size="11" fill="#2b2a26">cpu10|11</text>
</g>
<text class="ts" x="357" y="152" font-size="10.5" fill="#6b675e">跨岛 = L3 也凉，p99 从 9.9µs 跳到 27.4µs</text>
<text class="t" x="30" y="196" font-size="12" fill="#2b2a26">三层远近，三档差价（往返中位 / p99）：</text>
<text class="ts" x="30" y="220" font-size="11" fill="#6b675e">同一逻辑核　4.71 / 8.10 µs　　一切全热，唤醒不发 IPI（同队列置标记即可）</text>
<text class="ts" x="30" y="240" font-size="11" fill="#6b675e">SMT 兄弟核　5.01 / 7.87 µs　　共享 L1/L2；MWAIT 盯标记，多数唤醒免中断</text>
<text class="ts" x="30" y="260" font-size="11" fill="#6b675e">同 LLC 异核　4.99 / 9.93 µs　　L1/L2 凉，L3 还认得你；IPI 数百次起步</text>
<text class="tc" x="30" y="280" font-size="11" fill="#b03a2e">跨 LLC 域　　6.40 / 27.35 µs　　全凉回内存；中位只贵 36%，尾部贵 3.4 倍</text>
</svg>
</figure>

## 叫醒时的找房逻辑

任务被唤醒（或出生）时选座位，入口是 `select_task_rq_fair`（v7.2 `kernel/sched/fair.c:9536`）。主干两步：

**第一步，wake_affine 定大方向**（fair.c:8276）。源码注释开门见山（:8191）：「快速判断在哪个 CPU 上能**最快**跑起来，为了快，只考虑两个候选：唤醒者的核（this_cpu）和上次的核（prev_cpu）」。两段式：WA_IDLE 先看「现在」——唤醒者那个核若是空闲（或即将空闲，sync 唤醒时唤醒者马上就要睡），直接选它，数据八成还在它的缓存里；不成再走 WA_WEIGHT 比两个核的负载权重。选了唤醒者的核返回它，否则返回 prev_cpu。

**第二步，select_idle_sibling 找具体座位**（fair.c:8802）。拿着大方向（target）依次过闸：target 本身空闲吗（空则立返）→ prev 空闲吗（源码注释原话 "don't be stupid"：上次的核还空着就别折腾）→ recent_used 整核空闲吗 → 扫一个整核空闲的（select_idle_core，SMT 时代整核空着最香）→ 扫任意空闲逻辑核（select_idle_cpu，带 SIS_UTIL 扫描预算）→ 退而求其次找空闲的 SMT 兄弟（select_idle_smt）。都找不到，返回 target 硬上。找不到空闲才走慢路径 `sched_balance_find_dst_group`：按调度域逐层找最闲的组、最闲的队列——这是「负载均衡式选核」，贵，但总得有个座位。

这套逻辑就是悬案一的被告。B 为什么只有 16% 落回 A 身边？把链条摆开看，引力其实**发动了**，被下一道闸拦下了：

其一，**wake_affine 确实把 target 指到了 cpu4**。管道写是 sync 唤醒（v7.2 `fs/pipe.c:493` 用 `wake_up_interruptible_sync_poll`，WF_SYNC 一路传进来），而 A 写完令牌就会阻塞等回信——`wake_affine_idle` 的 sync 分支（fair.c:8220）：唤醒者的队列上只剩它自己一个（`rq->nr_running == 1`），就返回 this_cpu。语义正是「我要睡了，你接我的核」。

其二，**接核的闸门在 select_idle_sibling 第一道：target 现在空闲吗**（fair.c:8825 `choose_idle_cpu(target)` 则直接返回）。唤醒发生在 A 的 `write()` 还没返回时——A 本人还占着 cpu4，闸门看它是忙的，target 落选。引力输给了时机：等 A 真正睡下、cpu4 空出来，B 的座位早定了。

其三，**target 落选后，粘性闸门接管**。vanilla 的顺序是 target → prev（注释原话 "don't be stupid"：上次的核还空闲就别搬家）→ recent_used（上上次的核，整核空闲才回）；而本机 CachyOS 把 recent_used **提到了函数最顶上**（POC 源码致谢里点名这个改动，出自 "sched/fair: Prefer the previous cpu for wakeup" 补丁系列），六级瀑布也是 1r 排在 1t 之前——下游有意强化了「回旧座位」。B 一旦在远端核落脚，recent 就指向那里，只要整核空闲（桌面机器上常态），下一轮直接回去，自我强化。

于是落点直方图成了引擎的指纹：53% 扎堆 cpu9/10/11（recent 粘性的地盘）；cpu5（9%）略多于 cpu4（7%）——恰是 POC 瀑布 Level 4t「target 的 SMT 兄弟」的位置：cpu4 被 A 占着不空闲，它的兄弟 cpu5 代为接人。当然，没有 root 打不开 poc_count 分层计数器，这条对应关系只能算方向一致的间接证据，不作定论。

free 模式的完整落点直方图（20000 轮，A 钉 cpu4）：

```
B 落点: cpu0=2% cpu2=5% cpu4=7% cpu5=9% cpu6=10% cpu7=9%
        cpu8=6% cpu9=22% cpu10=12% cpu11=19% | B 换核 574 次
```

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="放养模式 B 的落点直方图：A 钉在 cpu4，B 落在 cpu4 只有 7%、cpu5 9%，而远端 cpu9 22%、cpu11 19%、cpu10 12%；prev 粘性强过 waker 引力" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">A 钉 cpu4，B 放养 20000 轮的落点——B 并不赴约</text>
<g font-size="10.5">
<text class="ts" x="40" y="216" text-anchor="middle" fill="#6b675e">0</text><text class="ts" x="90" y="216" text-anchor="middle" fill="#6b675e">1</text><text class="ts" x="140" y="216" text-anchor="middle" fill="#6b675e">2</text><text class="ts" x="190" y="216" text-anchor="middle" fill="#6b675e">3</text><text class="ts" x="240" y="216" text-anchor="middle" fill="#6b675e">4</text><text class="ts" x="290" y="216" text-anchor="middle" fill="#6b675e">5</text><text class="ts" x="340" y="216" text-anchor="middle" fill="#6b675e">6</text><text class="ts" x="390" y="216" text-anchor="middle" fill="#6b675e">7</text><text class="ts" x="440" y="216" text-anchor="middle" fill="#6b675e">8</text><text class="ts" x="490" y="216" text-anchor="middle" fill="#6b675e">9</text><text class="ts" x="540" y="216" text-anchor="middle" fill="#6b675e">10</text><text class="ts" x="590" y="216" text-anchor="middle" fill="#6b675e">11</text>
</g>
<rect class="bx" x="28" y="208" width="24" height="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="78" y="212" width="24" height="0.5" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="128" y="198" width="24" height="14" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="178" y="212" width="24" height="0.5" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-q" x="228" y="193" width="24" height="19" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx-q" x="278" y="188" width="24" height="24" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx" x="328" y="186" width="24" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="378" y="188" width="24" height="24" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx" x="428" y="196" width="24" height="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<rect class="bx-sick" x="478" y="154" width="24" height="58" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx-sick" x="528" y="180" width="24" height="32" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx-sick" x="578" y="162" width="24" height="50" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="490" y="146" text-anchor="middle" font-size="10.5" fill="#b03a2e">22%</text>
<text class="tc" x="590" y="154" text-anchor="middle" font-size="10.5" fill="#b03a2e">19%</text>
<text class="ts" x="240" y="185" text-anchor="middle" font-size="10.5" fill="#2b2a26">7%</text>
<text class="ts" x="290" y="180" text-anchor="middle" font-size="10.5" fill="#2b2a26">9%</text>
<text class="ts" x="265" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">A 的核对（4+5）合计 16%</text>
<text class="tc" x="520" y="60" text-anchor="middle" font-size="11.5" fill="#b03a2e">远端三核（9+10+11）合计 53%</text>
<line class="fl" x1="265" y1="68" x2="265" y2="150" stroke="#6b675e" stroke-width="1.2" stroke-dasharray="3 3"/>
<line class="flc" x1="520" y1="68" x2="520" y2="140" stroke="#b03a2e" stroke-width="1.2" stroke-dasharray="3 3"/>
<text class="ts" x="30" y="240" font-size="11" fill="#6b675e">解读：sync 引力把 target 指到 cpu4，但唤醒瞬间 A 还占着它 → target 闸门不过 → recent 粘性接管；B 换核 574 次，p99 19.1µs</text>
</svg>
</figure>

## 没人叫你的时候：负载均衡

唤醒选核是「有人叫门」时的即时决策；还有另一只手在后台慢悠悠地挪人——**周期性负载均衡**。节拍器还是上一篇那个 scheduler_tick：每 tick 检查要不要踢一脚 `SCHED_SOFTIRQ`（`trigger_load_balance`），软中断 `sched_balance_softirq`（fair.c:14499，老资料里叫 run_rebalance_domains，6.9 起全家改名 sched_balance_*）从最底层调度域开始逐层向上：`sched_balance_rq`（:13271）→ `sched_balance_find_src_group` 找最忙的组和最忙的队列 → `detach_tasks`（:10895）从人家队列里拆任务 → `attach_tasks` 挂到自己头上。拆人时 `can_migrate_task` 会尊重每个任务的 cpus_ptr 亲和性掩码——钉死的任务谁也不动。另有一条 newidle 路径（`sched_balance_newidle`，:5735）：CPU 正要进入空闲时顺手看一眼别的队列有没有活，有就拉一个过来，别空转。

这只手什么时候真会动？`migrate.c` 三态实测（每线程自报 `/proc/thread-self/sched` 的 `se.nr_migrations` 差值，8 秒窗口）：

```
mode=pinned 线程= 1 时长=8s | 迁移总数=0 | 到访核数=1
mode=solo   线程= 1 时长=8s | 迁移总数=0 | 到访核数=1
mode=herd   线程=20 时长=8s | 迁移总数=328（单线程 min=7 max=41）| 到访核数 min=2 max=9
```

**跑得顺，没人动你**：单个放养的死循环线程，8 秒零迁移、始终一个核——系统不忙时没有失衡，负载均衡找不到搬你的理由。**失衡才搬迁**：20 个死循环堵 12 个核，8 秒 328 次迁移，单线程最多被搬 41 次、足迹踏遍 9 个核。**钉死豁免**：pinned 组零迁移，亲和性掩码就是免搬金牌。老资料说「进程在核间飘来飘去」，飘的条件在这里量出来了：不是常态，是失衡时的纠偏。顺带，这也是在离线混部的代价来源——离线任务把核填满，在线任务的唤醒既找不到空闲的唤者核（WA_IDLE 失效）、又频繁被负载均衡搬走（缓存全凉），两头挨打。

## 本机独门：Piece-Of-Cake 选核器

悬案二结案。那八个 `sched_poc_*` 旋钮，vanilla v7.2 全文检索零命中——是 **CachyOS 的下游补丁**。本机包 `linux-cachyos 7.2.3-1`（README 自述：默认 EEVDF 调度器 + Cachy Sauce），源码 tag `cachyos-7.2.3-2`，文件 `kernel/sched/poc_selector.c`，2038 行，版本 2.6.3，作者 Masahito Suzuki（2026），头注释自报家门：

```
 * Piece-Of-Cake (POC) CPU Selector
 * Fast idle CPU selector inspired by RitzDaCat's scx_cake scheduler
 * "Piece of Cake" - making idle CPU search a piece of cake!
 * Tracks idle state in per-LLC atomic64_t bitmaps with lock-free
 * atomic64_read/or/andnot for O(1) idle CPU lookup.
```

它解决的问题很具体：vanilla 的 `select_idle_cpu` 找空闲核要**扫描**（带 SIS_UTIL 预算的 cpumask 遍历），核多的机器上每次唤醒都扫一遍不便宜。POC 的办法：每个 LLC 域维护一个 64 位原子位图，1 位 = 1 个逻辑核的空闲状态，核进出空闲时用无锁的 `atomic64_or/andnot` 维护——找空闲核从「扫描」变成**位运算**。本机两个 LLC 域各 6 核，远小于 64 位的上限，全速路径生效（`/sys/kernel/poc_selector/status/all_llc_eligible` = 1，这个 sysfs 状态口 444 权限，无 root 可读，`active` = 1 现役中）。

选座是一挂六级瀑布，注释里写得明明白白（poc_selector.c:982）：

```
Level 0:   饱和检查——全忙直接返回，不折腾
Level 1r:  最近用过的核整核空闲 → 就是它
Level 1s:  target 位在位图里空闲 → 就是它（L1/TLB 亲和，旋钮 target_sticky 管，默认关）
Level 1t:  target 的整核空闲 → target
Level 1p:  prev 的整核空闲 → prev
─── 有位图找整核 ───
Level 2:   L2 簇内找空闲整核（一条 CTZ 指令）
Level 3:   全 LLC 找空闲整核（轮转 + PDEP 选位）
─── 没整核了，找单个空闲超线程 ───
Level 4s/4p/4t/4r:  sync 让核 / prev 的 SMT 兄弟 / target 的 / recent 的
[过载闸门：SIS_UTIL 预算耗尽 → 跳过 5/6]
Level 5/6: 簇内 / 全 LLC 找任意空闲逻辑核
```

漂亮的地方在打包：LLC ≤32 核时，簇候选塞进一个 64 位字的低 32 位、全 LLC 候选塞高 32 位，**一条 TZCNT 同时解出两级答案**；再用 ror32 轮转把选择摊开到不同空闲核上。`/sys/kernel/poc_selector/hw_accel/` 实报了本机的硬件三件套：ctz=HW(TZCNT)、popcnt=HW(POPCNT)、ptselect=HW(PDEP)——全是单指令。它还留了 13 个分层命中计数器（`/sys/kernel/poc_selector/count/` 下 l1r 到 l6 加 fallback），可惜开关 `sched_poc_count` 要 root，本机全是 0，看不到命中分布。

旋钮全在 `/proc/sys/kernel/`，0644 root——无 root 一个也拨不动（写入 EPERM 实测）。所以本篇的边界：**机制是从 2038 行源码里读出来的，行为只有间接证据**。间接证据倒是有一条能对上：本机 `target_sticky=0`，意味着 Level 1s（target 空闲就粘上去）这条路是关着的——free 模式里 B 对 target 的冷淡、对 prev 的忠诚（1r/1p 都开着），与旋钮状态方向一致。真要坐实，得有 root 把 `poc_count` 打开跑一轮计数器，或者拨 `target_sticky=1` 做 A/B——留给有权限的读者复现。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 330" role="img" aria-label="POC 六级瀑布与位图原理：每 LLC 一个 atomic64 位图，1 位 1 核；Level 0 饱和检查，1r/1s/1t/1p 四个亲和候选，2/3 找空闲整核（簇内 CTZ、全 LLC 轮转 PDEP），4 系找 SMT 兄弟，过载闸门后 5/6 找任意空闲核；packed 模式把簇候选与 LLC 候选打进一个 64 位字，一条 TZCNT 出双层答案" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernCSAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">Piece-Of-Cake：找空闲核从「扫描」变「位运算」（本机 active=1，v2.6.3）</text>
<text class="t" x="30" y="56" font-size="12" fill="#2b2a26">每 LLC 一个 atomic64 位图</text>
<g>
<rect x="30" y="66" width="26" height="26" fill="#2b2a26"/><rect x="58" y="66" width="26" height="26" fill="#2b2a26"/><rect x="86" y="66" width="26" height="26" fill="none" stroke="#6b675e"/><rect x="114" y="66" width="26" height="26" fill="#2b2a26"/><rect x="142" y="66" width="26" height="26" fill="none" stroke="#6b675e"/><rect x="170" y="66" width="26" height="26" fill="none" stroke="#6b675e"/>
</g>
<text class="ts" x="30" y="112" font-size="10.5" fill="#6b675e">实心 = 忙，空心 = 空闲；核进出空闲时 atomic64_or / andnot 无锁维护</text>
<text class="ts" x="30" y="130" font-size="10.5" fill="#6b675e">本机 LLC 域 = 6 核 ≤ 64 位 → 全速路径；超 64 核的 LLC 交回 CFS 扫描</text>
<text class="t" x="360" y="56" font-size="12" fill="#2b2a26">packed 搜索（≤32 核/LLC）</text>
<g>
<rect x="360" y="66" width="120" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/><text class="ts" x="420" y="83" text-anchor="middle" font-size="10" fill="#2b2a26">簇候选 [31:0]</text>
<rect x="480" y="66" width="120" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/><text class="ts" x="540" y="83" text-anchor="middle" font-size="10" fill="#2b2a26">LLC 候选 [63:32]</text>
</g>
<text class="ts" x="360" y="112" font-size="10.5" fill="#6b675e">一个 64 位字装两级候选，一条 TZCNT 出答案；ror32 轮转摊开选择</text>
<text class="ts" x="360" y="130" font-size="10.5" fill="#6b675e">硬件三件套实报：TZCNT / POPCNT / PDEP 全开</text>
<text class="t" x="30" y="166" font-size="12" fill="#2b2a26">六级瀑布（命中即返回）</text>
<rect class="bx" x="30" y="178" width="600" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="40" y="195" font-size="11" fill="#2b2a26">0 饱和检查：全忙 → 返回 -1，交回 CFS 慢路径</text>
<rect class="bx-q" x="30" y="208" width="600" height="26" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="40" y="225" font-size="11" fill="#2b2a26">1r / 1s / 1t / 1p：recent 整核空闲 · target 位空闲（sticky 旋钮，默认关）· target 整核 · prev 整核</text>
<rect class="bx" x="30" y="238" width="600" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="40" y="255" font-size="11" fill="#2b2a26">2 / 3：L2 簇内空闲整核（CTZ）→ 全 LLC 空闲整核（轮转 PTSELECT）</text>
<rect class="bx" x="30" y="268" width="600" height="26" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="40" y="285" font-size="11" fill="#2b2a26">4s/4p/4t/4r：没整核就找 SMT 兄弟——sync 让核 · prev 的 · target 的 · recent 的</text>
<rect class="bx-sick" x="30" y="298" width="600" height="26" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="40" y="315" font-size="11" fill="#2b2a26">[SIS_UTIL 过载闸门] → 5 / 6：簇内 / 全 LLC 任意空闲逻辑核（greedy_search 旋钮管闸门，默认开=总搜）</text>
</svg>
</figure>

## 你手里的钉子：taskset 与亲和性

内核挑座位三方协商：缓存热度、谁空闲、你的亲和性掩码。前两条你管不着，第三条给你留着口子。`taskset` 实测：

```
$ taskset -c 4 sleep 6 &        # 启动就钉在 cpu4（注意：起命令用 -c）
$ taskset -p 20355              # 读回现有掩码（-p 是对已有 pid）
pid 20355 的当前亲和力掩码：10   # 0x10 = 0b10000 = cpu4
```

掩码存进 `task_struct` 的 `cpus_mask`，唤醒选核（`cpumask_test_cpu` 过滤候选）和负载均衡（`can_migrate_task`）都认它——migrate 实验 pinned 组零迁移就是回执。程序里直接调 `sched_setaffinity` 等价（pingpong 量具就是这么钉的）。要不要钉？本篇的数据给了两面：跨 LLC 的 p99 是 3.4 倍差价，钉对座位能吃到；但钉死也放弃了「忙时让负载均衡挪你」的弹性，钉在一个被别的负载占住的核上反而更惨。延迟敏感、缓存足迹大的线程值得钉；普通任务交给内核。

## 我踩的坑

**ping-pong 预热多了 100 个 token，量具直接撒谎。** 第一版 A 预热 100 轮、B 只跑 n 轮，token 收支不平衡：B 提前退场，A 的尾部读全吃 EOF，lat 数组尾部一片没赋值的 0，排序后 min=0.00µs——「零延迟往返」差点写进文章。修法：B 的轮数 = 预热 + 计量，A 记录实际完成数、只排序真样本。**量具输出的第一道质检：min 小于物理下限时，先查量具再查世界。**

**grep "^RES" 匹配不到 /proc/interrupts。** 那个文件每行行首带空格，锚定行首的 grep 一无所获，IPI 增量全是 0-0=0 的假读数，差点得出「跨核也不要 IPI」的荒谬结论。换成 awk '/RES:/' 才有真数。

**taskset 的 -p 和 -c 是两种用法。** `taskset -pc 4 sleep 6` 报「错误用法」——带 -p 是对已有 pid 操作（taskset -pc 4 PID），启动新命令只用 -c。老资料里两种写法的例子都有，抄串了就是这一个错。

**在 fair.c 里 grep "poc"，命中一堆 llc_epoch。** "e-poc-h" 里藏着 "poc"，子串误报淹没了真集成点。换 `poc_select\|POC_` 带词形的模式才找到 `#include "poc_selector.c"` 那行——对，这台引擎是整个文件 include 进 fair.c 的，不是独立编译单元。

**free 模式两次跑出两个世界。** 第一版（坏量具）B 的落点集中在 cpu0-5，修好后重跑散满 12 个核、扎堆 cpu9-11。桌面负载本身就是实验变量：它坐在哪些核上，B 就被挤离哪些核。落点分布这种读数，报 run 与 run 之间的方差和当时的负载，比报一个「结论」诚实。

## 座位表收起来

选核这层结案。三方协商的全貌：唤醒时 wake_affine 定大方向（sync 且唤者将睡，target 就指到唤者核），select_idle_sibling——在本机是 POC 那挂六级位图瀑布——挑具体座位，全忙时慢路径找最闲的组；后台负载均衡只在失衡时出手（solo 零迁移、herd 328 次），亲和性掩码是唯一的免搬金牌。悬案一的答案：引力发动了，输给了时机——B 被唤醒那一瞬间 A 还没睡下，「target 现在空闲吗」的闸门看到 cpu4 是忙的；接管的是「回旧座位」的粘性闸门，而且本机内核特意把它提到了最顶上。悬案二的答案：八个旋钮是 CachyOS 从 scx_cake 搬进内核的 O(1) 选核引擎，无 root 拨不动，但 sysfs 状态口开着——active=1，它一直在场，落点直方图里那点 cpu5 多于 cpu4 的偏心，多半就是它 Level 4t 的手笔。

还剩最后一环。任务出生了、换装了、被秤挑中了、被安上座位了——可 CPU 上明明已经坐着别人。把旧任务摘下来、新任务装上去的那一下，`context_switch`，到底花多少钱？老资料量出 3.4µs 又自己承认「没有很好地测量到间接开销」——收官篇，把这笔账连本带利量清楚。
