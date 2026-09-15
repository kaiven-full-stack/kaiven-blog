---
title: 24 毫秒不见了：调度器从 CFS 走到 EEVDF
description: 老资料实测调度靠两个旋钮：sched_latency_ns=24ms、sched_min_granularity_ns=3ms，本机 7.2.3 的 /proc/sys/kernel 里两个都不见了，/proc/sched_debug 也搬走了——CFS 在 6.6 被 EEVDF 取代：基准线从单调递增的 min_vruntime 换成加权平均 V，挑任务先问「欠不欠它 CPU」（lag≥0 才 eligible），再在够格者里挑 virtual deadline 最早的；红黑树还是那棵树，增广出 min_vruntime 做 O(log n) 堆搜索。旋钮没死只是搬家：debugfs 的 base_slice_ns（要 root），vanilla 默认 0.7ms，本机被 CachyOS 调成 1.6ms——普通用户从 /proc/pid/sched 的 se.slice 里把它泄了底。权重表倒是二十年没动：两个死循环钉同一核对打，nice 0 对 5 实测 75.4%:24.6%、对 19 实测 98.6%:1.4%，与 sched_prio_to_weight 的 1024:335、1024:15 咬合到 0.1 个百分点；nice 19 没饿死，8 秒里上浮 79 次、每次吃满 1.48ms；对照组单段 1.46ms 正是基础切片的量级；对手不够格时 nice 0 一口气独占 14.25ms。顺手扫了全机负 nice 进程，权重与 vanilla 表逐一吻合。实测于本机 Linux 7.2.3、glibc 2.44、gcc 16.2.1，内核源码对照 vanilla v7.2。
pubDate: 2026-09-25
category: kernel
tags: [Linux, 内核, 进程管理]
---

[上一篇](/posts/kernel-elf-execve/)结尾，换好衣服的任务被 `wake_up_new_task` 挂上了某个 CPU 的运行队列。挂上去之后呢——什么时候轮到它？轮到它跑多久？这篇讲那杆秤：调度器。

开场悬案是从一份老资料来的。那份材料（源码钉在 5.4/6.1 时代）实测调度时靠两个 sysctl 旋钮：

```
kernel.sched_latency_ns = 24000000        # 调度周期：最迟 24ms 轮一遍
kernel.sched_min_granularity_ns = 3000000 # 最小粒度：一次至少跑 3ms
```

在本机（Linux 7.2.3）上找这两个旋钮：

```
$ sysctl kernel.sched_latency_ns kernel.sched_min_granularity_ns
sysctl: 无法对 /proc/sys/kernel/sched_latency_ns 进行 stat 操作: 没有那个文件或目录
sysctl: 无法对 /proc/sys/kernel/sched_min_granularity_ns 进行 stat 操作: 没有那个文件或目录
```

都不见了。翻遍 `/proc/sys/kernel/` 里现存的 sched 旋钮，公平调度那套一个不剩，倒是多出一排没人讲过的 `sched_poc_*`（那是下一篇选核的故事）。连老资料的另一个读数入口 `/proc/sched_debug` 也没了。

旋钮没了，秤还在不在？在——只是换了原理、换了藏身处，而它最老的那盒砝码，二十年没换过。这篇把三件事说清：调度器的秤换了三代的来龙去脉；本机这杆新秤（EEVDF）怎么工作；以及那盒没换的砝码（nice 权重表）当场称重验证。

实验环境沿用前两篇：本机 Linux 7.2.3（AMD Ryzen 5 5500U，6 核 12 线程，CONFIG_HZ=1000），glibc 2.44，gcc 16.2.1；内核源码对照 vanilla v7.2。对抗实验的量具 `niceduel.c` 在 `~/proc-lab`，无 root 可复现。

## 三代秤

调度器要回答的从来只有两个问题：**挑谁上 CPU，让它跑多久**。三代秤都是围绕这两问换的零件。

**O(n) 时代（~2.4，2001）**：全系统一条队列，每个任务带静态优先级，跑过就调低、没跑就调高（动态优先级）。挑人 = 从头扫一遍队列找动态优先级最高的——O(n)。核少进程少的年代够用。

**O(1) 时代（2.5/2.6，2003）**：多核来了，全局队列的锁竞争扛不住。改成每个 CPU 一条自己的运行队列（per-CPU runqueue，`struct rq`），140 个优先级各挂一条链表，配一个 bitmap 标记哪些优先级上有人——挑人变成「找 bitmap 第一个置位的 bit」，O(1)。这个 bitmap 戏法眼熟吗？[出生篇](/posts/kernel-task-birth/)里 pid 账本用的就是同一招。跑多长：时间片按优先级**预先算死**，10ms 到 200ms。麻烦也出在这：一轮的总时长 = 在场任务时间片之和，10 个各拿 100ms 的任务排前面，新来的就得等 1 秒——调度延迟不可控，交互程序会被批处理任务活活压死。

**CFS 时代（2.6.23，2007）**：完全公平调度器把「时间片」扔了，换成一个记账数：**vruntime**（虚拟运行时间）。任务每跑一段真实时间，vruntime 按权重换算着往上涨——权重大的涨得慢，权重小的涨得快。就绪任务全挂在一棵按 vruntime 排序的红黑树上，挑人 = 摘**最左边**那个（vruntime 最小 = 最「亏」的）。跑多久不再预先定死，而是动态算一个调度周期（老资料机器上 24ms），按权重比例切给在场任务；周期内你的份额用完，就被左边的邻居换下。公平从「轮流坐庄」变成「账面上谁亏谁先跑」。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 316" role="img" aria-label="调度器三代秤时间线：2.4 的 O(n) 全局队列动态优先级；2.5 的 O(1) per-CPU 队列加 140 优先级 bitmap，时间片按优先级预分 10-200ms；2.6.23 的 CFS vruntime 红黑树摘最左，周期 24ms 动态切分；6.6 的 EEVDF 资格线加最早 deadline，基础切片 0.7ms" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernSCAs1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三代秤，两个老问题：挑谁上 CPU，让它跑多久</text>
<line class="axis" x1="30" y1="56" x2="630" y2="56" stroke="#6b675e" stroke-width="1.4"/>
<text class="t" x="70" y="46" text-anchor="middle" font-size="11.5" fill="#2b2a26">2.4</text>
<text class="t" x="225" y="46" text-anchor="middle" font-size="11.5" fill="#2b2a26">2.5/2.6</text>
<text class="t" x="390" y="46" text-anchor="middle" font-size="11.5" fill="#2b2a26">2.6.23</text>
<text class="t" x="555" y="46" text-anchor="middle" font-size="11.5" fill="#2b2a26">6.6 ~ 本机 7.2.3</text>
<rect class="bx" x="20" y="70" width="135" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="87" y="92" text-anchor="middle" font-size="12.5" fill="#2b2a26">O(n)</text>
<text class="ts" x="87" y="114" text-anchor="middle" font-size="10.5" fill="#6b675e">全局一条队列</text>
<text class="ts" x="87" y="132" text-anchor="middle" font-size="10.5" fill="#6b675e">动态优先级</text>
<text class="ts" x="87" y="150" text-anchor="middle" font-size="10.5" fill="#6b675e">挑人：整队扫一遍</text>
<text class="ts" x="87" y="176" text-anchor="middle" font-size="10.5" fill="#6b675e">多核锁竞争</text>
<text class="ts" x="87" y="194" text-anchor="middle" font-size="10.5" fill="#6b675e">扛不住</text>
<rect class="bx" x="172" y="70" width="135" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="239" y="92" text-anchor="middle" font-size="12.5" fill="#2b2a26">O(1)</text>
<text class="ts" x="239" y="114" text-anchor="middle" font-size="10.5" fill="#6b675e">per-CPU 队列 ×140 优先级</text>
<text class="ts" x="239" y="132" text-anchor="middle" font-size="10.5" fill="#6b675e">bitmap 找第一个 bit</text>
<text class="ts" x="239" y="150" text-anchor="middle" font-size="10.5" fill="#6b675e">时间片按优先级预分</text>
<text class="ts" x="239" y="168" text-anchor="middle" font-size="10.5" fill="#6b675e">10~200ms</text>
<text class="ts" x="239" y="194" text-anchor="middle" font-size="10.5" fill="#6b675e">延迟不可控：10×100ms=1s</text>
<rect class="bx" x="324" y="70" width="135" height="150" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="391" y="92" text-anchor="middle" font-size="12.5" fill="#2b2a26">CFS</text>
<text class="ts" x="391" y="114" text-anchor="middle" font-size="10.5" fill="#6b675e">vruntime 记账</text>
<text class="ts" x="391" y="132" text-anchor="middle" font-size="10.5" fill="#6b675e">红黑树摘最左</text>
<text class="ts" x="391" y="150" text-anchor="middle" font-size="10.5" fill="#6b675e">周期 24ms 动态切</text>
<text class="ts" x="391" y="168" text-anchor="middle" font-size="10.5" fill="#6b675e">粒度 3ms 保底</text>
<text class="ts" x="391" y="194" text-anchor="middle" font-size="10.5" fill="#6b675e">两个旋钮现已失踪</text>
<rect class="bx-q" x="476" y="70" width="164" height="150" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="558" y="92" text-anchor="middle" font-size="12.5" fill="#2b2a26">EEVDF</text>
<text class="ts" x="558" y="114" text-anchor="middle" font-size="10.5" fill="#6b675e">资格线 V（加权平均）</text>
<text class="ts" x="558" y="132" text-anchor="middle" font-size="10.5" fill="#6b675e">够格者挑最早 deadline</text>
<text class="ts" x="558" y="150" text-anchor="middle" font-size="10.5" fill="#6b675e">基础切片 0.7ms（vanilla）</text>
<text class="ts" x="558" y="168" text-anchor="middle" font-size="10.5" fill="#6b675e">本机调成 1.6ms</text>
<text class="ts" x="558" y="194" text-anchor="middle" font-size="10.5" fill="#6b675e">旋钮搬进 debugfs</text>
<line class="fl" x1="155" y1="145" x2="168" y2="145" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSCAs1)"/>
<line class="fl" x1="307" y1="145" x2="320" y2="145" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSCAs1)"/>
<line class="fl" x1="459" y1="145" x2="472" y2="145" stroke="#6b675e" stroke-width="1.5" marker-end="url(#kernSCAs1)"/>
<text class="ts" x="20" y="252" font-size="11" fill="#6b675e">每换代解决上一代的痛点：锁竞争 → 延迟不可控 → （CFS 的补丁哲学见下文）</text>
<text class="ts" x="20" y="276" font-size="11" fill="#6b675e">本机 7.2.3 现役：EEVDF + 每任务自定义切片（custom_slice）+ fair_server 防实时任务饿死普通任务的反向保险</text>
<text class="ts" x="20" y="300" font-size="11" fill="#6b675e">选核器另有 Piece-Of-Cake（sched_poc_*）——下一篇的主角</text>
</svg>
</figure>

CFS 干了十六年，但它的设计里有个别扭：公平靠「谁 vruntime 最小谁先跑」，延迟保障却靠两个补丁参数——周期（latency）保证所有人 24ms 轮一遍，粒度（granularity）保证轮到的人至少跑 3ms 不被打碎。参数互相牵制，人多了周期被粒度顶大，延迟承诺就松了。2023 年的 6.6 内核，CFS 的挑人核心被换成了 **EEVDF**（Earliest Eligible Virtual Deadline First，最早够格虚拟截止期优先）——失踪的两个旋钮，就是这次换代扔掉的。

## 本机这杆秤：EEVDF

EEVDF 把「挑谁」拆成两问，v7.2 `kernel/sched/fair.c:1121` 的注释原文就两行：

```
 * EEVDF selects the best runnable task from two criteria:
 *  1) the task must be eligible (must be owed service)
 *  2) from those tasks that meet 1), we select the one
 *     with the earliest virtual deadline.
```

**第一问：欠不欠它的？** 每个任务有个 lag（欠账）：`lag_i = w_i × (V − v_i)`，其中 v_i 是任务的 vruntime，**V 是全体就绪任务 vruntime 的加权平均**（`vruntime_eligible`，fair.c:894——CFS 用单调递增的 min_vruntime 当基准线，EEVDF 换成了会随队列浮动的平均线）。v_i 落在平均线左边，lag 为正：它拿到的 CPU 少于应得，**够格**（eligible）；落在右边，它已经吃超了，不够格，先等着。

**第二问：够格的里面，谁最急？** 每个任务有个虚拟截止期 `deadline = vruntime + 换算成虚拟时间的切片`（fair.c:1252，注释就一行公式：`vd_i = ve_i + r_i / w_i`）。切片 r_i 默认是全局基础切片 `sysctl_sched_base_slice`（v7.2 默认 **0.7ms**，fair.c:79），权重越大同样的切片折算出的虚拟时长越短、deadline 越近。够格者里挑 deadline 最早的——短切片、高权重的任务天然「急」，长切片批处理任务天然「不急」，延迟敏感者不再被大块头压住。

数据结构还是那棵红黑树，但换了排法（fair.c:1128 注释）：**树按 deadline 排序，同时每个节点增广记录子树内最小 vruntime**，于是「够格者中找最早 deadline」能剪枝着做堆搜索，O(log n)（`pick_eevdf`，fair.c:1136）。CFS 时代「无脑摘最左」升级成「先过资格线，再比急迫度」。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 356" role="img" aria-label="CFS 与 EEVDF 挑人对比：左边 CFS 红黑树按 vruntime 排序直接摘最左节点，基准是单调的 min_vruntime；右边 EEVDF 树按 deadline 排序，先画加权平均 V 资格线，vruntime 在 V 左侧的才够格，够格者中挑 deadline 最早的；lag 为正表示欠它 CPU" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="kernSCAs2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="t" x="30" y="34" font-size="12.5" fill="#2b2a26">CFS（~6.5）：摘最左</text>
<line class="fl" x1="160" y1="80" x2="100" y2="130" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="160" y1="80" x2="220" y2="130" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="220" y1="152" x2="190" y2="190" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="220" y1="152" x2="255" y2="190" stroke="#6b675e" stroke-width="1.3"/>
<circle class="bx" cx="160" cy="70" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="160" y="74" text-anchor="middle" font-size="10.5" fill="#2b2a26">v=5</text>
<circle class="bx-sick" cx="100" cy="140" r="16" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.6"/>
<text class="ts" x="100" y="144" text-anchor="middle" font-size="10.5" fill="#2b2a26">v=2</text>
<circle class="bx" cx="220" cy="140" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="220" y="144" text-anchor="middle" font-size="10.5" fill="#2b2a26">v=7</text>
<circle class="bx" cx="190" cy="200" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="190" y="204" text-anchor="middle" font-size="10.5" fill="#2b2a26">v=6</text>
<circle class="bx" cx="255" cy="200" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="255" y="204" text-anchor="middle" font-size="10.5" fill="#2b2a26">v=9</text>
<text class="ts" x="30" y="248" font-size="11" fill="#6b675e">树按 vruntime 排，最左 = 最亏，直接摘</text>
<text class="ts" x="30" y="268" font-size="11" fill="#6b675e">基准线：min_vruntime（只涨不跌）</text>
<text class="ts" x="30" y="288" font-size="11" fill="#6b675e">延迟保障：周期 24ms + 粒度 3ms 两个补丁旋钮</text>
<line class="axis" x1="330" y1="50" x2="330" y2="320" stroke="#a8a29a" stroke-width="1" stroke-dasharray="3 3"/>
<text class="t" x="365" y="34" font-size="12.5" fill="#2b2a26">EEVDF（6.6 ~ 本机 7.2.3）：资格线内挑最急</text>
<line class="fl" x1="500" y1="80" x2="440" y2="130" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="500" y1="80" x2="565" y2="130" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="565" y1="152" x2="530" y2="190" stroke="#6b675e" stroke-width="1.3"/>
<line class="fl" x1="565" y1="152" x2="600" y2="190" stroke="#6b675e" stroke-width="1.3"/>
<circle class="bx" cx="500" cy="70" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="500" y="74" text-anchor="middle" font-size="10.5" fill="#2b2a26">d=8</text>
<circle class="bx" cx="440" cy="140" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="440" y="144" text-anchor="middle" font-size="10.5" fill="#2b2a26">d=5</text>
<circle class="bx-sick" cx="565" cy="140" r="16" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.6"/>
<text class="ts" x="565" y="144" text-anchor="middle" font-size="10.5" fill="#2b2a26">d=6</text>
<circle class="bx" cx="530" cy="200" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="530" y="204" text-anchor="middle" font-size="10.5" fill="#2b2a26">d=7</text>
<circle class="bx" cx="600" cy="200" r="16" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2" stroke-dasharray="3 2"/>
<text class="ts" x="600" y="204" text-anchor="middle" font-size="10.5" fill="#6b675e">d=4</text>
<line class="flc" x1="365" y1="170" x2="640" y2="170" stroke="#b03a2e" stroke-width="1.4" stroke-dasharray="6 3"/>
<text class="tc" x="368" y="163" font-size="11" fill="#b03a2e">V：加权平均 vruntime（资格线）</text>
<text class="ts" x="365" y="248" font-size="11" fill="#6b675e">树按 deadline(d) 排；v ≤ V 才够格（实心），吃超的靠边站</text>
<text class="ts" x="365" y="268" font-size="11" fill="#6b675e">d=4 最急但不够格（虚线）→ 落选；d=6 够格且最急 → 当选</text>
<text class="ts" x="365" y="288" font-size="11" fill="#6b675e">lag = w×(V−v)：正数 = 欠它的；睡眠醒来 lag 保留（PLACE_LAG）</text>
<text class="ts" x="20" y="330" font-size="11" fill="#6b675e">欠账被钳制在约一个切片内（fair.c:828 稳态界），等待因此有上界——不再需要粒度旋钮兜底</text>
<line class="flc" x1="565" y1="158" x2="565" y2="170" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#kernSCAs2)"/>
</svg>
</figure>

几个配角也各就各位：任务睡醒回队时，lag 会被保留（`place_entity`，fair.c:5986，PLACE_LAG）——睡前的欠账醒来接着算，不会被清零占便宜，也不会带着陈年旧账插队（lag 被钳制在约一个最大切片内，fair.c:833）；唤醒抢占的判据从 CFS 的「vruntime 差超过粒度」变成一个更直接的问题：**把新人入队后重新跑一遍挑人，挑出来的若是新人就抢**（`wakeup_preempt_fair`，fair.c:9772，源码注释：if @p has become the most eligible task, force preemption）。实时任务（SCHED_FIFO/RR）照旧绝对优先，v7.2 还多了个反向保险 fair_server（`update_curr` 里的 `dl_server_update`）：实时任务霸占太久时，给普通任务留一条保底通道。

那失踪的旋钮呢？没死，搬家了。基础切片现在叫 `base_slice_ns`，藏在 `/sys/kernel/debug/sched/`（debugfs，0644 要 root，debug.c:648）——普通用户看不见。但 `/proc/pid/sched` 把它泄了底：

```
$ grep se.slice /proc/1/sched /proc/2/sched /proc/$$/sched
/proc/1/sched:se.slice                                     :              1600000
/proc/2/sched:se.slice                                     :              1600000
/proc/395806/sched:se.slice                                :              1600000
```

systemd、kthreadd、随便一个用户任务，se.slice 全是 **1.6ms**。vanilla 源码里默认值是 0.7ms（fair.c:79）——本机跑的是 CachyOS 内核，发行版把它调大了。debugfs 的门锁着，值却写在每个任务的脸上。

## 砝码没换：三场对抗赛

秤换了原理，砝码呢？nice 值那盒砝码——`sched_prio_to_weight` 40 个数（core.c:10606）——从 CFS 时代原封不动搬进了 EEVDF，`calc_delta_fair` 的换算公式也没动。老资料说 nice 不是优先级是权重，说得再对也只是嘴账；权重到底兑不兑现，打个架就知道了。

量具 `niceduel.c`：fork 两个死循环孩子，**钉在同一个核上**（排除多核干扰），各设 nice 值对打 8 秒，各自从 `/proc/self/schedstat` 汇报真实吃到的 CPU（exec）、排队等待（wait）、上机次数（slices），从 `/proc/self/sched` 汇报内核实际用的 prio 和 weight。跑三场，每场两轮：

| 对阵 | 实测 exec 比例（两轮） | 权重表预期 | 实测 weight（<<10） | 实测 prio |
|---|---|---|---|---|
| nice 0 vs 0 | 50.0 : 50.0 | 50.0 : 50.0 | 1048576 : 1048576 | 120 : 120 |
| nice 0 vs 5 | 75.4 : 24.6 | 75.3 : 24.7 | 1048576 : 343040 | 120 : 125 |
| nice 0 vs 19 | 98.5~98.6 : 1.5~1.4 | 98.6 : 1.4 | 1048576 : 15360 | 120 : 139 |

三场全部与权重表咬合到 0.1 个百分点。链条也逐环对上：nice 5 → prio 125（=120+5）→ weight 335<<10=343040 → CPU 份额 335/(1024+335)=24.6%。砝码是真砝码。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 252" role="img" aria-label="三场对抗赛结果条形图：nice 0 对 0 实测 50.0 比 50.0；对 5 实测 75.4 比 24.6，预期 75.3 比 24.7；对 19 实测 98.6 比 1.4，预期 98.6 比 1.4；实测与权重表预期误差 0.1 个百分点内" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">三场对抗赛：8 秒窗口，同核对打，实测 exec 份额 vs 权重表预期</text>
<text class="ts" x="105" y="58" text-anchor="end" font-size="11.5" fill="#2b2a26">0 vs 0</text>
<rect class="bx-q" x="115" y="44" width="240" height="24" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="355" y="44" width="240" height="24" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="235" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">50.0%</text>
<text class="ts" x="475" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">50.0%</text>
<text class="ts" x="105" y="106" text-anchor="end" font-size="11.5" fill="#2b2a26">0 vs 5</text>
<rect class="bx-q" x="115" y="92" width="362" height="24" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="477" y="92" width="118" height="24" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="296" y="108" text-anchor="middle" font-size="10.5" fill="#2b2a26">75.4%（预期 75.3）</text>
<text class="ts" x="536" y="108" text-anchor="middle" font-size="10.5" fill="#2b2a26">24.6%</text>
<text class="ts" x="105" y="154" text-anchor="end" font-size="11.5" fill="#2b2a26">0 vs 19</text>
<rect class="bx-q" x="115" y="140" width="473" height="24" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="588" y="140" width="7" height="24" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="350" y="156" text-anchor="middle" font-size="10.5" fill="#2b2a26">98.6%（预期 98.6）</text>
<text class="ts" x="565" y="156" text-anchor="middle" font-size="10.5" fill="#2b2a26">1.4%</text>
<line class="flc" x1="477" y1="86" x2="477" y2="122" stroke="#b03a2e" stroke-width="1.6"/>
<text class="ts" x="115" y="196" font-size="11" fill="#6b675e">深色 = nice 0，浅色 = 对手；红线 = 权重表预期分界（1024 : 335）</text>
<text class="ts" x="115" y="218" font-size="11" fill="#6b675e">weight 实测 1048576 : 343040 : 15360（= 1024/335/15 × 1024），prio = 120/125/139</text>
<text class="ts" x="115" y="240" font-size="11" fill="#6b675e">两轮复跑，份额漂移 ≤ 0.1 个百分点</text>
</svg>
</figure>

更有意思的是切片明细，EEVDF 的资格机制直接写在数字里：

```
对照组（0 vs 0）：每人 slices≈2710 次，exec≈3.96s → 平均每段 1.46ms
0 vs 19：nice 19 一侧 slices=79，exec=0.117s → 平均每段 1.48ms，wait=7.88s
         nice 0  一侧 slices=550，exec=7.84s → 平均每段 14.25ms
```

三个观察。其一，对抗双方每段上机都是 **1.46~1.48ms，正是 se.slice=1.6ms 的量级**——基础切片不是摆设，是每段上机的实际长度（略短于 1.6ms，有些段被唤醒抢占提前打断）。其二，nice 19 **没有饿死**：8 秒里它上浮 79 次，每次吃满一段 1.5ms 再沉下去。它的剧本是 EEVDF 的资格线：排队时 lag 一点点积正（欠它的越来越多），积到 v ≤ V 就够格上浮，吃掉一段、lag 转负、回到队里继续等。1.4% 的份额正是权重表承诺的数字，不多不少。其三，nice 0 一侧平均每段长达 14.25ms——远超基础切片。不是它搞特殊：对手不够格时，切片用完触发重挑，`pick_eevdf` 挑来挑去还是它，「换人」成了空转，于是一口气跑到对手浮上资格线为止。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 208" role="img" aria-label="0 对 19 对抗的上机节奏时间线：nice 0 长时间独占（平均单段 14.25ms），nice 19 的 lag 排队积正到够格时上浮吃一段 1.48ms 再沉下去，循环往复；nice 19 全程 79 段共 0.117 秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">0 vs 19 的上机节奏（示意按实测比例）：资格线下的等待与上浮</text>
<rect class="bx-q" x="30" y="48" width="120" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="150" y="48" width="13" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-q" x="163" y="48" width="120" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="283" y="48" width="13" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-q" x="296" y="48" width="120" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="416" y="48" width="13" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-q" x="429" y="48" width="120" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bx-sick" x="549" y="48" width="13" height="30" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<rect class="bx-q" x="562" y="48" width="68" height="30" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="90" y="67" text-anchor="middle" font-size="10.5" fill="#2b2a26">nice 0 独占</text>
<text class="ts" x="223" y="67" text-anchor="middle" font-size="10.5" fill="#2b2a26">nice 0 独占</text>
<text class="ts" x="356" y="67" text-anchor="middle" font-size="10.5" fill="#2b2a26">nice 0 独占</text>
<text class="ts" x="489" y="67" text-anchor="middle" font-size="10.5" fill="#2b2a26">nice 0 独占</text>
<text class="tc" x="156" y="100" text-anchor="middle" font-size="10.5" fill="#b03a2e">↑1.48ms</text>
<text class="ts" x="30" y="128" font-size="11" fill="#6b675e">nice 0：单段平均 14.25ms——对手不够格时，切片用完重挑还是自己，一路跑到对手浮上资格线</text>
<text class="ts" x="30" y="150" font-size="11" fill="#6b675e">nice 19：排队积 lag → v ≤ V 够格 → 上浮吃一段 1.48ms → lag 转负 → 沉回队列；8 秒共 79 段</text>
<text class="ts" x="30" y="172" font-size="11" fill="#6b675e">对照组（0 vs 0）：双方都始终够格，节奏变成 1.46ms 一段的乒乓交替，各 2700+ 段</text>
<text class="ts" x="30" y="194" font-size="11" fill="#6b675e">全部 involuntary 切换（voluntary=0）：死循环从不主动让位，每一段都是被秤换下来的</text>
</svg>
</figure>

顺手把「nice 是权重不是优先级」的最后半句也钉死：`chrt --max` 实测，SCHED_OTHER 的优先级区间是 **0/0**——普通进程根本没有优先级可调，nice 动的是权重；真正带绝对抢占的优先级（1~99）只属于 SCHED_FIFO/RR 实时任务。chrt 的策略清单里还多了个老内核没有的条目：SCHED_EXT——用 BPF 写自定义调度器的框架，本机选核器 sched_poc 的灵感正是从它生态里的 scx_cake 调度器搬回内核的（下一篇的主角）。

## 旋钮都去哪了

结案陈词。老资料的两个旋钮：`sched_latency_ns`（24ms 周期）死了，它的职责被 EEVDF 的资格机制吸收——欠账钳制在约一个切片内，等待自有上界，不再需要一个全局周期兜底；`sched_min_granularity_ns`（3ms 粒度）也死了，它的职责由基础切片接管——vanilla 默认 0.7ms，本机 CachyOS 调成 1.6ms，藏在要 root 的 debugfs 里，却从每个任务的 `/proc/pid/sched` se.slice 字段漏了出来。老资料那句「进程调度延迟不超过 24ms」在今天的内核上不再成立，今天的承诺换成了另一种形式：lag 有界，deadline 有序。

而二十年没换的是那 40 个砝码。我把全机负 nice 的进程扫了一遍对表：WeChatAppEx（nice -1）weight 1277、spotify/chrome（-4）2501、kioworker（-6）3906、electron/ZCode（-8）6100、amdgpu 的 kworker（-20）88761——与 vanilla 权重表逐一吻合，无一私改。秤换了原理，砝码还是那盒砝码：这是内核换代里少见的「不变量」，也是老资料到今天唯一还能原样引用的数字。

## 我踩的坑

**基线 nice 是漂的。** 第一轮对抗跑出个怪数：设 nice 0 的孩子 prio 竟是 116（nice -4）。顺藤摸瓜：工具链起命令的 shell 有时带着 nice -4（宿主对活跃命令的提速），后台 `&` 挂起的任务又被加了 +5——同一个量具，换个姿势起跑，基线就不一样。修法：量具内部先 `getpriority` 读基线、`nice(-base)` 归零，再打印实际 nice 而不是入参。**读数对不上预期时，先查量具自己的出身。**

**权重表的索引我记错了一格。** 看到 nice -4 的任务 weight=2501<<10，我第一反应是「发行版改表了」——vanilla 表里 2501 明明在 -5 那格（错）。全机扫描重建权重表后对源码一数：table[-4] 就是 2501，是我把 [-5] 行的位置数劈了。差点把「自己算错」写成「内核私改」，教训：指控别人改数据之前，先把手指的落点核对一遍。

**vruntime 斜率别乱解读。** 量具本来还想量「vruntime 涨速 = 1024/weight」（nice 19 理论上 68 倍速）。实测斜率对不上公式：EEVDF 时代 /proc/pid/sched 打出的 vruntime 是相对平均线的键值，入队出队还有平移，两次采样的差值不是干净的累计量。这个指标直接弃用——公式验证有 exec 份额就够了，不必强拧一个脏读数。

**/proc/sched_debug 没了。** 老资料查调度状态的标准入口，如今搬去了 debugfs（要 root）。无 root 的替代读数链：`/proc/pid/sched`（prio/weight/se.slice/vruntime）+ `/proc/pid/schedstat`（exec/wait/slices 三件套）+ `/proc/pid/status`（切换计数），本篇全部实验只用了这三样。

## 秤与砝码

三件事收进档案。其一，挑谁上 CPU 的逻辑换了三代：扫队列 → bitmap 找 bit → 摘 vruntime 最左 → 资格线内挑最早 deadline，本机 7.2.3 现役最后一种，基础切片 1.6ms，藏在 debugfs。其二，nice 是砝码不是令箭：SCHED_OTHER 优先级恒为 0/0，nice 通过权重表兑换 CPU 份额，三场对抗赛实测与 40 个数字的兑换率分毫不差，nice 19 也饿不死——它只是要等 lag 积满才上浮吃一段。其三，读数是会搬家的：sysctl 死了、sched_debug 搬家了、se.slice 从 /proc/pid/sched 漏出来，找旋钮的功夫不比用旋钮少。

任务已经在队列里排着了，秤也认得了。但还有一个问题没回答：`wake_up_new_task` 把它挂上的是**哪个** CPU 的队列？12 个逻辑核，6 个物理核，两伙人共享缓存——挑核挑得好不好，缓存热不热，直接决定跑起来的快慢。下一篇讲选核：wake_affine、调度域、负载均衡，以及本机那排 `sched_poc_*` 旋钮背后的新选择器。
