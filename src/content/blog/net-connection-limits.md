---
title: 一台机器一百万条连接？fd 金字塔与 65535 迷思
description: 连接数的三面墙全程 netns 实弹（connscale 量具：递增建连、窗口延迟/CPU/errno 分账、多源 IP、可压低 fd 限额）。fd 金字塔三层各有 errno：nofile（本机软硬都 1048576，老资料时代 1024；EMFILE 执法在 fs/file.c:197/213）→ fs.nr_open（本机 2147483584=恰好编译上限 sysctl_nr_open_max，vanilla 默认 1048576，fs/file.c:96/100；抬它的配置项没找到，如实标注；setrlimit 超限 EPERM，kernel/sys.c:1513）→ fs.file-max（本机 2097152，CachyOS 70-cachyos-settings.conf:46；ENFILE 执法 file_table.c:282 并打内核日志）；实测把 soft 压到 5000：停在 2989 条自连（一条自连吃 2 个 fd：2989 客户端+2000 子 socket+杂项≈4993），EMFILE 连发 200 触发量具停机闸。服务端结论：端口从不限制服务端（每条连接四元组不同），限它的是 fd 与内存——⑤的单价 3.86KB/端点 × 百万 ≈3.9GB，本机 file-max 2.09M、nofile 可抬到 2^31，「百万连接」在 7.2 是配置与内存问题不是内核结构问题；十万条实弹背书：单进程 100000 连接（20 万 fd）建成、零失败。客户端 65535 迷思死刑：单通道（源 IP×目的 IP×目的端口固定）的上限是 ip_local_port_range 的 28232 个 ephemeral 端口（不是 65535），实测墙在 28230（监听 socket 的自动端口也吃 ephemeral，差的 2 个不硬抠）；乘法突破实测：4 个 lo 别名源 IP → 40000 条中位 11.5µs 全程平稳零失败，4 个目的端口 → 100000 条。墙外税是本文最陡的曲线：占用 ≤14000 时 connect 中位 12.0~12.9µs、CPU ~1µs/条；跨过 14116（=28232 的一半！）中位跳到 1490µs（×115）、CPU 144µs/条（×150）——奇偶分道扫描实锤：__inet_hash_connect 起点=四元组 siphash+table_perturb 随机表（inet_hashtables.c:1081），step=2 第一遍只扫偶端口（注释原话 In first pass we try ports of @low parity，:1088），偶类占满后 other_parity_scan（:1112）第二遍全扫——每个 connect 扫满 ~14116 个占用端口（CPU 144µs），每候选 cond_resched（:1161）把 wall 拉到 1.5~2.8ms；4 目的实验的拐点精确落在 4×14116=56464（50K 窗口 med 15.7/avg 697.8 双峰现场）——两个独立实验钉死同一机制。老资料绪论「端口不足 connect CPU 大幅升高」悬案全数字复现；较新内核的旋钮 ip_local_port_step_width（随机步长打散扫描，:1074，netns 实测 0=关）。E-i 后半程 44K 条 connect 花 105 秒（前半 56K 条只要 1 秒）。errno 分诊：EMFILE=nofile、ENFILE=file-max、setrlimit EPERM=nr_open、EADDRNOTAVAIL=端口耗尽。3 张内联 SVG。实测于本机 Linux 7.2.3（CachyOS），源码对照 vanilla v7.2，量具 connscale.c/limits-netns.sh 存档 ~/net-lab，全程 netns 无 root。
pubDate: 2026-10-03
category: network
tags: [Linux, 网络, 内核, TCP]
---

「一台服务器最多支持多少条 TCP 连接？」——面试常青树，答案五花八门：65535、一百万、受限于内存、受限于 fd……这篇把每一面墙都找到、编号、实测撞上去，听每面墙报出自己的 errno。剧透四个数：fd 限额 5000 时自连停在 **2989** 条；单源单目的的端口墙在 **28230**；墙外 connect 的中位延迟从 12µs 跳到 **1490µs**，拐点精确落在端口范围的**一半**；单进程 **100000** 条连接实弹建成。

场地照旧：`unshare -rn` 的 netns（[本机 IO 篇](/posts/net-local-io/)的工地），量具 connscale（`~/net-lab`）——递增建连，每窗口报延迟中位/均值、自身 stime、errno 分账，支持多源 IP 和压低 fd 限额。口径先交代：自导自演模式下**一条连接吃两个 fd**（客户端一个、accept 回来的子 socket 一个），真实部署里两端各付一个。

## fd 金字塔：三层限额，三种 errno

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="fd 三层金字塔：进程级 nofile 本机 1048576 超限 EMFILE；进程级天花板 nr_open 本机 2147483584 恰为编译上限，setrlimit 超限 EPERM；系统级 file-max 本机 2097152 超限 ENFILE；右侧标注老资料时代的默认值 1024/4096" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">开一个 fd 要过三层闸，每层闸有自己的 errno</text>
<polygon class="bx" points="200,44 340,44 380,104 160,104" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="270" y="68" text-anchor="middle" font-size="11" fill="#2b2a26">① RLIMIT_NOFILE（进程）</text>
<text class="tc" x="270" y="88" text-anchor="middle" font-size="9.5" fill="#b03a2e">本机 soft=hard=1048576 · 超限 EMFILE</text>
<polygon class="bx" points="160,108 380,108 420,168 120,168" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="270" y="132" text-anchor="middle" font-size="11" fill="#2b2a26">② fs.nr_open（进程限额的天花板）</text>
<text class="tc" x="270" y="152" text-anchor="middle" font-size="9.5" fill="#b03a2e">本机 2147483584=编译上限 · setrlimit 超限 EPERM</text>
<polygon class="bx" points="120,172 420,172 460,232 80,232" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="270" y="196" text-anchor="middle" font-size="11" fill="#2b2a26">③ fs.file-max（全系统）</text>
<text class="tc" x="270" y="216" text-anchor="middle" font-size="9.5" fill="#b03a2e">本机 2097152 · 超限 ENFILE + 内核日志</text>
<text class="ts" x="480" y="76" font-size="9.5" fill="#6b675e">执法点：fs/file.c:197/213</text>
<text class="ts" x="480" y="92" font-size="9.5" fill="#6b675e">（rlimit 在 :621 取）</text>
<text class="ts" x="480" y="140" font-size="9.5" fill="#6b675e">执法点：kernel/sys.c:1513</text>
<text class="ts" x="480" y="156" font-size="9.5" fill="#6b675e">默认 1048576（fs/file.c:96）</text>
<text class="ts" x="480" y="204" font-size="9.5" fill="#6b675e">执法点：file_table.c:282</text>
<text class="ts" x="480" y="220" font-size="9.5" fill="#6b675e">"VFS: file-max limit reached"</text>
<text class="ts" x="20" y="246" font-size="10" fill="#6b675e">老资料时代：nofile 默认 1024/4096，file-max 按内存公式推——本机三层全被发行版抬过（file-max 出自 CachyOS conf:46）。</text>
</svg>
</figure>

三层的执法点都在源码里明写着：`__alloc_fd` 对着 rlimit 砍（fs/file.c:197/213，EMFILE）；`setrlimit` 想把 nofile 抬过 `fs.nr_open` 直接 EPERM（kernel/sys.c:1513）；`alloc_empty_file` 对着 `files_stat.max_files` 查全系统水位（file_table.c:282，ENFILE，还往内核日志里打一行 "VFS: file-max limit reached"）。本机的三层读数：nofile 软硬都是 1048576（老资料时代的默认是 1024/4096——那时「Too many open files」是日常），file-max 2097152（CachyOS 在 70-cachyos-settings.conf:46 设的，和[收包篇](/posts/net-receive-path/)那个 backlog 旋钮同一个文件），file-nr 显示全系统此刻才开着 19475 个。nr_open 有个小悬案：本机读数 2147483584，恰好等于编译期上限 `sysctl_nr_open_max`（fs/file.c:100，INT_MAX 按 64 对齐），而 vanilla 默认是 1048576（:96）——谁把它抬到顶的，sysctl.d 里翻了个遍没找到出处，疑似内核侧改动，如实标注不编归属。

第一面墙实弹撞给你看：connscale 把 soft 压到 5000 再建连——

```
summary ok=2989 ... emfile=200 ...
```

停在 2989 条：2989 个客户端 fd + 2000 个已 accept 的子 fd + 监听 + stdio ≈ 4993，第 5000 个 `socket()` 开始 EMFILE，连发 200 个触发量具停机闸。**墙是 fd 总数，不是连接数**——自连模式一条吃俩，这个除法不做，报数就翻倍。

## 服务端：端口从不限制它

「服务端最多 65535 条连接」是流传最广的错账。看四元组就明白：(源IP, 源端口, 目的IP, 目的端口)——服务端所有连接的目的侧固定（自己的 IP:端口），但**源侧是客户端自带的**，一百万个客户端各拿各的端口，四元组互不相同。理论空间 2^48 量级，实际上服务端只有两面墙：fd 金字塔（本机 nofile 一百万，还能抬到 nr_open 的 2^31）和内存（[上一篇](/posts/net-connection-memory/)称过单价：3.86KB/端点，百万端点 ≈ 3.9GB——本机 15GB，老资料那台 4GB 虚机装百万连接 slab 吃掉 3.2GB，是同一笔账的两个时代）。

十万条实弹：connscale -n 100000 -L 4（4 个监听端口分治，理由见下节），单进程 20 万个 fd 全部建成、零失败。**百万没有硬冲**——桌面机推满要 ~4GB slab 加上墙外税的时间账，单价 × 数量的算术加十万实弹足够背书，如实标注。

## 客户端：28232 的墙，和 65535 的迷思

客户端的约束是另一回事：源端口得从 `ip_local_port_range`（本机 32768~60999，共 **28232** 个——不是 65535，0~32767 留给知名端口）里拿。但迷思的要害在「单通道」三个字：端口是**每个 (源IP, 目的IP, 目的端口) 通道**独享的资源。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 230" role="img" aria-label="四元组容量图：连接由源IP源端口目的IP目的端口唯一确定；服务端目的侧固定但源侧由客户端自带，容量等于 fd 乘内存与端口无关；客户端单通道的源端口池只有 28232 个，但通道数可以乘源 IP 数和目的端口数——4 源 IP 实测 40000 条、4 目的端口实测 100000 条" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">四元组：(源IP, 源端口, 目的IP, 目的端口)——变的是谁，容量就归谁</text>
<rect class="bx-q" x="20" y="40" width="300" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="170" y="62" text-anchor="middle" font-size="11" fill="#2b2a26">服务端：目的侧固定，源侧客户端自带</text>
<text class="ts" x="170" y="82" text-anchor="middle" font-size="9.5" fill="#6b675e">每条连接四元组天然不同，端口不构成约束</text>
<text class="tc" x="170" y="102" text-anchor="middle" font-size="9.5" fill="#b03a2e">容量 = fd 金字塔 × 内存（⑤单价 3.86KB/端点）</text>
<rect class="bx-q" x="340" y="40" width="300" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="490" y="62" text-anchor="middle" font-size="11" fill="#2b2a26">客户端：单通道 = 一个源端口池</text>
<text class="ts" x="490" y="82" text-anchor="middle" font-size="9.5" fill="#6b675e">(srcIP, dstIP, dstPort) 固定 → srcPort 池 28232</text>
<text class="tc" x="490" y="102" text-anchor="middle" font-size="9.5" fill="#b03a2e">实测墙：28230（EADDRNOTAVAIL）</text>
<rect class="bx" x="340" y="136" width="300" height="70" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="490" y="158" text-anchor="middle" font-size="10.5" fill="#2b2a26">乘法突破：通道数 × 28232</text>
<text class="ts" x="490" y="178" text-anchor="middle" font-size="9.5" fill="#6b675e">×4 源 IP（lo 别名）→ 40000 条实测平稳（E-h）</text>
<text class="ts" x="490" y="194" text-anchor="middle" font-size="9.5" fill="#6b675e">×4 目的端口 → 100000 条实测建成（E-i）</text>
<line class="fl" x1="490" y1="116" x2="490" y2="132" stroke="#6b675e" stroke-width="1.4"/>
<text class="ts" x="20" y="158" font-size="10.5" fill="#6b675e">「客户端最多 65535 条」错两处：</text>
<text class="ts" x="20" y="176" font-size="10.5" fill="#6b675e">池子是 28232 不是 65535；</text>
<text class="ts" x="20" y="194" font-size="10.5" fill="#6b675e">池子按通道分，不是全局一口。</text>
</svg>
</figure>

实测把墙撞出来——单源单目的建连：

```
win done=14000 ok=14000 med_us=12.9  stime_jif=16
win done=16000 ok=16000 med_us=1490.3 stime_jif=304    ← 拐点在这两个窗口之间
...
summary ok=28230 ... eaddrnotavail=200
```

墙在 28230（28232 里监听 socket 的自动端口也吃掉一个，差的两个不硬抠），errno 是 **EADDRNOTAVAIL**——autobind 把范围扫穿也找不到空位。而 65535 迷思的死刑执行得很干脆：往 lo 上加 4 个别名 IP 当源地址（netns 里 `ip addr add` 即可，老资料要 20 台真机的排场），**40000 条连接、中位 11.2~11.5µs 全程平稳、零失败**——4 个源 IP × 28232 = 112928 的容量，40000 连拐点都没碰到。目的侧同理可乘：4 个监听端口分治就是 E-i 的十万条。老资料的多 IP 方案，在 netns 里十分钟复现。

## 墙外税：拐点为什么在一半

E-g 那条曲线是本文最陡的一段：占用不过 14000 时，connect 中位 12µs、CPU 约 1µs/条；跨过拐点，中位 1490µs（×115）、CPU 144µs/条（×150）；后半程 14000 条花了 22 秒，前半程只要 0.2 秒。E-i 的 4 通道版本把拐点的身份钉死了：**50000→60000 窗口之间**（那格的 avg 697.8 对 med 15.7，正是窗口跨过拐点的双峰现场），而 4×14116 = **56464**。

拐点 = 范围的一半。这不是巧合，是奇偶分道扫描的指纹。`__inet_hash_connect`（inet_hashtables.c:1040）的端口选择：起点由四元组 siphash 加一张随机扰动表算出（`inet_sk_port_offset` :656、table_perturb :1081-1085），然后——源码注释原话「In first pass we try ports of @low parity」（:1088）——**step=2，第一遍只扫偶数端口**；偶数类占满才进 `other_parity_scan`（:1112）扫另一半。于是：偶数类没满时，探测几下就命中空位（平台期 CPU ~1µs）；偶数类一满（14116 个），每次 connect 都要把第一遍的 14116 个占用端口**全数扫过**才轮到奇数类——14116 次探测 × ~10ns ≈ 140µs，与 stime 实测 144µs/条严丝合缝；每个候选端口还带一次 `cond_resched()`（:1161），一万四千次让出把 wall time 进一步拉到 1.5~2.8ms。E-i 后半程 44000 条花了 105 秒，前半程 56000 条只花 1 秒——同一台机器、同一个量具，差的只是扫描深度。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 260" role="img" aria-label="端口耗尽爆炸曲线：横轴已占用端口数，纵轴 connect 中位延迟对数感；14000 前平台 12 微秒，14116（范围一半）处垂直跳到 1500 微秒平台，28230 撞墙 EADDRNOTAVAIL；叠加 4 通道实验拐点 56464 的标注" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netCLa1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">connect 中位延迟 vs 已占用端口（E-g 实测，纵轴两段刻度，横轴按端口数等比）</text>
<line class="axis" x1="50" y1="220" x2="620" y2="220" stroke="#6b675e" stroke-width="1.3"/>
<line class="axis" x1="50" y1="220" x2="50" y2="40" stroke="#6b675e" stroke-width="1.3"/>
<polyline class="flk" points="90,214 131,214 171,214 212,214 252,214 292,214 333,213 336,86 373,88 414,87 454,90 494,86 535,88 575,84 612,82" fill="none" stroke="#2b2a26" stroke-width="1.8"/>
<line class="flc" x1="335" y1="220" x2="335" y2="60" stroke="#b03a2e" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="tc" x="335" y="52" text-anchor="middle" font-size="10" fill="#b03a2e">14116 = 范围的一半（偶端口类占满）</text>
<line class="flc" x1="616" y1="220" x2="616" y2="100" stroke="#b03a2e" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="tc" x="560" y="240" text-anchor="middle" font-size="9.5" fill="#b03a2e">墙 28230：EADDRNOTAVAIL</text>
<text class="ts" x="90" y="206" font-size="9.5" fill="#6b675e">平台期：med 12.0~12.9µs，CPU ~1µs/条</text>
<text class="ts" x="360" y="76" font-size="9.5" fill="#6b675e">墙外税：med 1404~1556µs（×115），CPU 144µs/条（×150）</text>
<text class="ts" x="56" y="120" font-size="9" fill="#6b675e">1500µs</text>
<text class="ts" x="56" y="212" font-size="9" fill="#6b675e">12µs</text>
<text class="ts" x="44" y="240" font-size="9" fill="#6b675e">0</text>
<text class="ts" x="150" y="240" font-size="9" fill="#6b675e">7000</text>
<text class="ts" x="318" y="240" font-size="9" fill="#6b675e">14116</text>
<text class="ts" x="470" y="240" font-size="9" fill="#6b675e">21000</text>
<text class="ts" x="20" y="256" font-size="10" fill="#6b675e">E-i（4 目的通道）同款拐点落在 4×14116=56464：50K 窗口 med 15.7/avg 697.8 的双峰就是跨越现场——机制两处独立命中。</text>
</svg>
</figure>

老资料绪论里那个线上悬案——「端口不充足时 connect 的 CPU 消耗大幅度增加，负载却不高」——至此全数字复现：CPU 烧在内核的端口扫描里（stime 账），不产生就绪任务（负载账），监控上就是「CPU 高、负载正常、连接慢」的三联征。较新的内核还添了个旋钮 `ip_local_port_step_width`（:1074，随机步长打散扫描，netns 内实测读数 0=关）——时代差清单再添一行。生产上的教训一句话：**别等 EADDRNOTAVAIL，connect 延迟的斜率就是端口水位的报警器**。

## 小结

四面墙的门牌与 errno：nofile → EMFILE（实测 5000 限额停 2989 条自连）；nr_open → setrlimit EPERM（本机已在编译上限 2^31−2048）；file-max → ENFILE（本机 2.09M，全系统水位 19475）；单通道端口 → EADDRNOTAVAIL（墙 28230，拐点 14116）。服务端容量 = fd × 内存，与端口无关；客户端容量 = 通道数 × 28232，通道靠源 IP/目的端口相乘——65535 迷思死于四元组。墙外税 ×115，机制是奇偶分道扫描在偶端口类耗尽后的全程跋涉。十万条单机建成，百万条 = 3.9GB 内存加一套抬过的限额，不是神话也不是常态。

连接建起来了，就有散场的一天。下一篇讲挥手：四次挥手的状态机、TIME_WAIT 为什么守在主动关闭方、那 60 秒里端口是怎么被扣住的——⑤⑥两篇埋的 TW 账，一次清完。

## 我踩的坑

**上一篇写进的容量规则，这一篇的量具一头撞上。** 握手篇刚量过 accept 队列容量 = backlog+1 = 4097，connscale 却把 accept 回收绑在报告窗口上、窗口设了 5000——第 4098 条起 SYN 被闸①拒收，客户端进 127 秒的 SYN 重传，脚本当场挂死六分钟。修法是回收与报告解耦：每 2000 条必收一次，窗口只管打印。同一条纪律第二次交学费（切换篇的 token 守恒也是摔过才写进注释）：**知道的规则要写进量具的不变量，写在文章里不算数。**

**fd 耗尽时，量具自己的 stdio 也开不了文件。** E-f 撞墙后 summary 里 stime_jif=-1：读 /proc/self/stat 要 fopen，要 fd——EMFILE 风暴里 fopen 同样失败。撞 fd 墙的量具得预留一个应急 fd（启动时 open 一个占位、用时 close），这次靠窗口行里已有的读数兜了底。

**avg 和 med 必须成对看，这次是 avg 立了功。** E-i 的 60000 窗口：med 15.7µs 一派正常，avg 697.8µs 暴露了窗口正跨过拐点——中位数把双峰抹平，均值把拐点招供。之前几篇的纪律是「med 进结论、avg 是氛围」，这一篇反过来了：找拐点，avg 才是探针。两句话不矛盾：报稳态用 med，找异态盯 avg。

**墙的位置差 2 个端口，不硬抠。** 28232 的范围，墙在 28230：监听 socket 的自动端口也从 ephemeral 段里拿（吃掉 1 个），还有 1 个的出入在边界处理里——量具精度之内说不清就不编故事，墙的位置报 ±2。

**找不到出处的配置，如实说找不到。** nr_open 恰好等于编译上限，翻遍 sysctl.d 无果，疑点是内核侧默认值改动——但「疑」就是疑，写进正文的是读数、编译上限的源码行号和「没找到出处」六个字，不是一个编出来的归属。
