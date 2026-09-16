---
title: send() 的一个字节被拷贝了几次
description: 上一篇欠的账：lo 包往返 12.3µs，管道令牌只要 3.5µs——这次同拓扑（l3，钉核 0/2）重测拆成三层：管道 4.43 → AF_UNIX 数据报 6.90 → UDP 11.41 → TCP 12.85µs，socket 机器（skb 分配、入队出队、唤醒）+2.5，IP/UDP 协议处理+4.5，连接簿记+1.4。拷贝账正题：单向 2 次 CPU 拷贝——发送侧 user→skb（UDP 走 ip_generic_getfrag，ip_output.c:932：设备能卸载校验和就纯 copy_from_iter，不能就 csum_and_copy 边拷边算；TCP 走 skb_copy_to_page_nocache，tcp.c:1310），接收侧 skb→user（skb_copy_datagram_iter，datagram.c:531）；lo 的内核内部零拷贝（loopback_xmit 直递），一个来回 4 次，跨机另加两次 DMA（不占 CPU 占内存带宽）；协议栈逐层只 push 头不动载荷，邻居 hh_cache 盖 16 字节 L2 头（neighbour.h:507）是零头。两部制资费实测：64B→1400B 体积差 22 倍，rtt 中位只从 11.20 涨到 11.65µs（每包一口价）；16384B 涨到 16.0、65507B 到 32.7，增量段斜率折算 ~12GB/s。CPU jiffies 账当不得真：4.2GB 拷贝量对应 system 时间仅三四十毫秒——tick 采样漏记短爆发、64KB 工作集又常驻 L2，两种解释分不开，每字节单价只能读 RTT 斜率。分片账本分毫不差：ping -s 4000 → FragCreates +60（20 数据报×3 片）、FragOKs +20、回程 ReasmReqds +60/ReasmOKs +20，1000B 对照全零；lo MTU 65536，UDP 上限 65507 在 lo 上设计上永不触发分片。qdisc=发送侧的闸：常规路径入队出队发送全在系统调用内联完成（__dev_xmit_skb，dev.c:4185）——上一篇 NET_TX 门可罗雀的结构性原因；本机 lo/wlan0 根 qdisc 均 noqueue，default_qdisc=fq_codel 是全局旋钮（netns 内无此文件，v7.2 的 net/core 旋钮多半 init_net 专属）；netns 活体（unshare -rn 无 root）：veth 出生自带 IFF_NO_QUEUE（veth.c:1748），noqueue 连账都不记（50 个 ping 穿过后 tc -s 仍 Sent 0），换 netem loss 10% 账本立刻开张（Sent 185 pkt、dropped 19、实测丢 9.5%）；veth 往返 min 11µs 与 lo 同量级。TX 完成回收三条路：有线网卡 dev_kfree_skb_irq→completion_queue→NET_TX；本机 WiFi 走 ieee80211_tx_status_irqsafe→tasklet（status.c:40、main.c:467）——上一篇 ping 窗口 TASKLET +425 而 NET_TX +0 就此破案；lo 所有权直递零回收。校验和口径实测：lo 卸载全 on（根本不算），wlan0 tx-checksumming off（CPU 买单，skb_checksum_help dev.c:3569）。skb 本体来自 skbuff_head_cache slab（skbuff.c:442）；MSG_ZEROCOPY 的 msg_ubuf 分支（ip_output.c:1009）留给零拷贝篇。4 张内联 SVG。实测于本机 Linux 7.2.3（CachyOS），源码对照 vanilla v7.2，量具 lotok v2（新增 AF_UNIX 模式与 min/med/avg 三读数）存档 ~/net-lab，无 root 可复现。
pubDate: 2026-09-29
category: network
tags: [Linux, 网络, 内核]
---

[上一篇](/posts/net-receive-path/)结尾欠了一笔账：同样一次锁步往返，lo 上的包要 12.3µs，管道令牌只要 3.5µs——贵出的两倍多花在哪了？这篇先还这笔账，再回答标题的问题：`send()` 出去的一个字节，到底被拷贝了几次。

先剧透答案：**单向两次 CPU 拷贝**——发送侧从用户缓冲拷进 skb，接收侧从 skb 拷回用户缓冲。协议栈逐层穿行不碰载荷；DMA 不算 CPU 拷贝但占内存带宽；lo 连 DMA 都没有。至于那笔延迟账，这次在同拓扑（l3，钉核 0/2）重测三层、再把切换篇的管道数据并进来对账，每层明码标价。

环境同上一篇：本机 7.2.3-1-cachyos，源码对照 vanilla v7.2，量具 `~/net-lab`（lotok 升级到 v2：加了 AF_UNIX 模式和 min/med/avg 三个读数，与切换篇量具同口径），无 root，桌面背景不安静、全部前后差分。这篇的锁步实验统一钉 cpu0/cpu2——同 LLC 异核，正是[切换篇](/posts/kernel-context-switch/)量管道令牌 4.43µs 用的 l3 拓扑，账才对得上。

## 全景：一个字节的发送路线

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 330" role="img" aria-label="发送全景：send 系统调用经 socket 层到传输层组装 skb 并发生唯一一次大拷贝，IP 层加头查路由按需分片，邻居子系统盖 16 字节二层头，dev_queue_xmit 选队列过 qdisc 闸，驱动 ndo_start_xmit 挂 TX 环 DMA 发出，完成中断回收 skb；拷贝点用朱砂标注" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netTXa1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">send() 的七站：只有一站搬货，其余都是盖戳和排队</text>
<rect class="bx" x="20" y="40" width="145" height="66" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="92" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">① send 系统调用</text>
<text class="ts" x="92" y="77" text-anchor="middle" font-size="9.5" fill="#6b675e">sock_sendmsg → 协议族分发</text>
<text class="ts" x="92" y="93" text-anchor="middle" font-size="9.5" fill="#6b675e">lock_sock 持锁上路</text>
<line class="fl" x1="165" y1="73" x2="181" y2="73" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa1)"/>
<rect class="bx-q" x="185" y="40" width="145" height="66" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="257" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">② 传输层：装 skb</text>
<text class="tc" x="257" y="77" text-anchor="middle" font-size="9.5" fill="#b03a2e">★ 唯一大拷贝：user→skb</text>
<text class="ts" x="257" y="93" text-anchor="middle" font-size="9.5" fill="#6b675e">skb 本体出自 slab（skbuff.c:442）</text>
<line class="fl" x1="330" y1="73" x2="346" y2="73" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa1)"/>
<rect class="bx" x="350" y="40" width="145" height="66" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="422" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">③ IP 层</text>
<text class="ts" x="422" y="77" text-anchor="middle" font-size="9.5" fill="#6b675e">加 IP 头 · 查路由 · netfilter</text>
<text class="ts" x="422" y="93" text-anchor="middle" font-size="9.5" fill="#6b675e">超 MTU → 分片（:307 判断）</text>
<line class="fl" x1="495" y1="73" x2="511" y2="73" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa1)"/>
<rect class="bx" x="515" y="40" width="130" height="66" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="580" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">④ 邻居子系统</text>
<text class="tc" x="580" y="77" text-anchor="middle" font-size="9.5" fill="#b03a2e">★ 盖 16B L2 头戳</text>
<text class="ts" x="580" y="93" text-anchor="middle" font-size="9.5" fill="#6b675e">hh_cache memcpy（零头）</text>
<path class="fl" d="M 580 106 L 580 132 L 92 132 L 92 156" fill="none" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa1)"/>
<rect class="bx" x="20" y="160" width="145" height="66" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="92" y="180" text-anchor="middle" font-size="11.5" fill="#2b2a26">⑤ dev_queue_xmit</text>
<text class="ts" x="92" y="197" text-anchor="middle" font-size="9.5" fill="#6b675e">选发送队列（pick_tx :4696）</text>
<text class="ts" x="92" y="213" text-anchor="middle" font-size="9.5" fill="#6b675e">qdisc 闸：入队+出队内联跑</text>
<line class="fl" x1="165" y1="193" x2="181" y2="193" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa1)"/>
<rect class="bx" x="185" y="160" width="145" height="66" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="257" y="180" text-anchor="middle" font-size="11.5" fill="#2b2a26">⑥ 驱动 ndo_start_xmit</text>
<text class="ts" x="257" y="197" text-anchor="middle" font-size="9.5" fill="#6b675e">挂 TX 环、推 wp</text>
<text class="tc" x="257" y="213" text-anchor="middle" font-size="9.5" fill="#b03a2e">DMA 取货（不占 CPU）</text>
<line class="fl" x1="330" y1="193" x2="346" y2="193" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa1)"/>
<rect class="bx" x="350" y="160" width="145" height="66" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="422" y="180" text-anchor="middle" font-size="11.5" fill="#2b2a26">⑦ 完成中断 → 回收</text>
<text class="ts" x="422" y="197" text-anchor="middle" font-size="9.5" fill="#6b675e">硬件确认后才敢放内存</text>
<text class="ts" x="422" y="213" text-anchor="middle" font-size="9.5" fill="#6b675e">三条路，见下文</text>
<rect class="bx-q" x="515" y="160" width="130" height="66" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="580" y="180" text-anchor="middle" font-size="11" fill="#2b2a26">lo 近道</text>
<text class="ts" x="580" y="197" text-anchor="middle" font-size="9.5" fill="#6b675e">⑥⑦ 合并：skb 直递</text>
<text class="ts" x="580" y="213" text-anchor="middle" font-size="9.5" fill="#6b675e">接收 backlog，零 DMA</text>
<text class="ts" x="20" y="256" font-size="11" fill="#6b675e">载荷只在 ② 被搬一次；③④ 逐层往 skb 头部 push 几十字节的头，货物原地不动。</text>
<text class="ts" x="20" y="274" font-size="11" fill="#6b675e">接收端还有一次对称的 skb→user（②的镜像），所以「单向两次 CPU 拷贝」。</text>
<text class="ts" x="20" y="300" font-size="11" fill="#6b675e">校验和：② 只记欠条（CHECKSUM_PARTIAL），设备支持卸载就一直欠着；</text>
<text class="ts" x="20" y="318" font-size="11" fill="#6b675e">不支持（本机 wlan0）则 ⑥ 前由 skb_checksum_help 当场补齐——CPU 买单。</text>
</svg>
</figure>

②的拷贝点，UDP 和 TCP 各有各的写法。UDP 在 `__ip_append_data`（ip_output.c:949）里组装数据报，搬货的回调是 `ip_generic_getfrag`（:932），两条分支写得明明白白：

```c
if (skb->ip_summed == CHECKSUM_PARTIAL) {
	copy_from_iter_full(to, len, &msg->msg_iter);        // 设备会算校验和：纯拷贝
} else {
	csum_and_copy_from_iter_full(to, len, &csum, ...);       // 设备不会：边拷边算
	skb->csum = csum_block_add(skb->csum, csum, odd);
}
```

本机的口径差异就藏在这：`ethtool -k lo` 的 tx-checksumming 是 on——lo 上的包校验和从头到尾没人算过（反正是内存直递，坏了算谁的）；`ethtool -k wlan0` 却是 off——WiFi 卡不接这活，发送前 `skb_checksum_help`（dev.c:3569）用 CPU 补算。同一个 send()，两张网卡两本账。

TCP 的拷贝在 `tcp_sendmsg_locked`（tcp.c:1116）：`skb_copy_to_page_nocache`（:1310）把用户数据搬进 skb 挂的页里。skb 本体则来自 slab——`kmem_cache_alloc(net_hotdata.skbuff_cache, ...)`（skbuff.c:442），`/sys/kernel/slab/` 里那个 skbuff_head_cache，[slab 篇](/posts/kernel-slab-slub/)讲的那套 per-cpu freelist 机器。每发一包分配一次、收完释放一次，高频小包场景这就是热点，也是 SLUB 存在的意义。

接收端镜像对称：`recvfrom` 把 skb 里的数据拷回用户缓冲（`skb_copy_datagram_iter`，datagram.c:531）。所以单向两次、lo 往返四次。跨机呢？多两次 DMA——发送侧网卡从内存取货、接收侧网卡往内存卸货——DMA 不占 CPU，但占内存带宽，这笔账在[内存山](/posts/hardware-memory-mountain/)那篇量过单价。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="一个字节的单程票三种走法：lo 单向两次 CPU 拷贝（user 到 skb、skb 到 user），内核内部直递零拷贝；跨机在中间多两次 DMA；sendfile 则让用户缓冲退出舞台，页缓存直接 DMA 给网卡" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netTXa3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一个字节的单程票：★ 是 CPU 拷贝，只售两张</text>
<text class="ts" x="20" y="48" font-size="10.5" fill="#6b675e">lo 单向 = 2 次 CPU 拷贝</text>
<rect class="bx" x="20" y="56" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="65" y="78" text-anchor="middle" font-size="10" fill="#2b2a26">用户缓冲 A</text>
<line class="fl" x1="110" y1="74" x2="176" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<text class="tc" x="143" y="66" text-anchor="middle" font-size="9.5" fill="#b03a2e">★拷贝①</text>
<rect class="bx-q" x="180" y="56" width="90" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="225" y="78" text-anchor="middle" font-size="10" fill="#2b2a26">skb</text>
<line class="fl" x1="270" y1="74" x2="366" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<text class="ts" x="318" y="66" text-anchor="middle" font-size="9.5" fill="#6b675e">直递，内核内 0 拷贝</text>
<rect class="bx-q" x="370" y="56" width="90" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="415" y="78" text-anchor="middle" font-size="10" fill="#2b2a26">skb（同一个）</text>
<line class="fl" x1="460" y1="74" x2="526" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<text class="tc" x="493" y="66" text-anchor="middle" font-size="9.5" fill="#b03a2e">★拷贝②</text>
<rect class="bx" x="530" y="56" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="575" y="78" text-anchor="middle" font-size="10" fill="#2b2a26">用户缓冲 B</text>
<text class="ts" x="20" y="120" font-size="10.5" fill="#6b675e">跨机单向 = 2 次 CPU + 2 次 DMA</text>
<rect class="bx" x="20" y="128" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="65" y="150" text-anchor="middle" font-size="10" fill="#2b2a26">用户缓冲 A</text>
<line class="fl" x1="110" y1="146" x2="176" y2="146" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<text class="tc" x="143" y="138" text-anchor="middle" font-size="9.5" fill="#b03a2e">★拷贝①</text>
<rect class="bx-q" x="180" y="128" width="90" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="225" y="150" text-anchor="middle" font-size="10" fill="#2b2a26">skb</text>
<line class="fl" x1="270" y1="146" x2="336" y2="146" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<rect class="bx" x="340" y="128" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="405" y="144" text-anchor="middle" font-size="9.5" fill="#2b2a26">DMA→网卡·线·网卡→DMA</text>
<text class="ts" x="405" y="158" text-anchor="middle" font-size="9" fill="#6b675e">不占 CPU，占内存带宽</text>
<line class="fl" x1="470" y1="146" x2="526" y2="146" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<text class="tc" x="498" y="138" text-anchor="middle" font-size="9.5" fill="#b03a2e">★拷贝②</text>
<rect class="bx" x="530" y="128" width="90" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="575" y="150" text-anchor="middle" font-size="10" fill="#2b2a26">用户缓冲 B</text>
<text class="ts" x="20" y="192" font-size="10.5" fill="#6b675e">sendfile 预告：用户缓冲退出舞台</text>
<rect class="bx-gone" x="20" y="200" width="90" height="36" rx="4" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="65" y="222" text-anchor="middle" font-size="10" fill="#6b675e">用户缓冲</text>
<rect class="bx-q" x="180" y="200" width="90" height="36" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="225" y="222" text-anchor="middle" font-size="10" fill="#2b2a26">页缓存</text>
<line class="fl" x1="270" y1="218" x2="336" y2="218" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa3)"/>
<rect class="bx" x="340" y="200" width="130" height="36" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="405" y="222" text-anchor="middle" font-size="9.5" fill="#2b2a26">DMA 直达网卡</text>
<text class="ts" x="490" y="222" font-size="9.5" fill="#6b675e">CPU 拷贝 0 次——零拷贝篇细算</text>
</svg>
</figure>

## 拆账：管道 → unix → UDP → TCP

同拓扑（cpu0/cpu2，l3）、同锁步纪律、五万轮取中位，四种往返并排：

| 往返方式 | rtt 中位（两轮） | 增量 | 增量买到了什么 |
|---|---|---|---|
| 管道令牌（切换篇原数据） | 4.43µs | — | 两次系统调用 + 两次唤醒切换的地基价 |
| AF_UNIX 数据报 | 6.90µs | +2.5µs | socket 机器：skb 分配/入队/出队、socket 唤醒 |
| UDP over lo | 11.41µs | +4.5µs | IP/UDP 协议处理：组头、路由、校验和欠条、hash 查表、软中断中转 |
| TCP over lo | 12.85µs | +1.4µs | 连接簿记：序号、ACK、发送队列管理 |

上一篇的悬案结案：**包比管道贵出的部分，一半是 socket 机器，另一半才是 IP 协议栈**。unix 数据报已经走完了 skb 的全套生老病死（分配、排队、唤醒、释放），只是不经过 IP 层——它比管道贵的 2.5µs 就是 skb 机器的明码标价；UDP 再贵的 4.5µs 才是「网络协议」本身的价钱。口径交代：unix 组走 socketpair，省了地址查找那一步，拆账是数量级账不是逐项发票。

顺带看 CPU 侧：50k 轮里客户端 stime 约 22 个 jiffy（64B 档），平均每轮 0.44µs——远小于 11.4µs 的往返。锁步乒乓的大头根本不是 CPU 忙，是两侧互相等：发包→睡下→对端处理→唤醒→调度回来，[切换篇](/posts/kernel-context-switch/)讲的那套唤醒与上下文切换才是延迟的主体。这也解释了为什么吞吐型应用要换打法——不等了，批量发，那是 epoll 篇的事。

## 两部制资费：每包一口价，每字节另计

包的大小从 64B 扫到 65507B（UDP 单包上限），中位数（两轮交错）：

| 载荷 | 64B | 256B | 1024B | 1400B | 4096B | 16384B | 65507B |
|---|---|---|---|---|---|---|---|
| rtt_med | 11.20µs | 11.23 | 11.59 | 11.65 | 13.11 | 16.00 | 32.66 |

64B 到 1400B，体积差 22 倍，延迟只涨 0.45µs——**平台区，每包一口价**（约 11µs 的固定成本：系统调用、skb、协议处理、软中断、两次唤醒，跟货多少无关）。4096B 起爬坡，到 65507B 翻了三倍——**爬坡区，每字节另计**：拿 16384→65507 两点算斜率，ΔRTT 16.66µs 对应每轮多拷 4×49123 字节，折算 **~12GB/s**——正是缓存/内存级 memcpy 的量级，四次拷贝（每方向 in+out）的边际单价。

CPU 账本想验证这个斜率，结果翻车了：65507B×8000 轮 = 4.2GB 拷贝量，`/proc/stat` 里 cpu0+cpu2 的 system 时间却只有三四十毫秒——照面值算是 105GB/s，越过本机内存带宽五倍。两种解释分不开：tick 采样记不住 33µs 一次的短爆发（HZ=1000，爆发比 tick 短）；或者 64KB 的工作集根本没出 L2（每核 512KB），拷贝真跑出了缓存速度。**每字节单价只能信 RTT 斜率，CPU jiffies 账只做数量级参考**——这账本在收包篇已经前科在案（软中断时间不进任务账），这次是采样粒度又摆了一道。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 280" role="img" aria-label="左：三层拆账柱状图，管道 4.43 微秒、AF_UNIX 6.90、UDP 11.41、TCP 12.85，增量分别为 socket 机器 2.5、IP/UDP 协议 4.5、连接簿记 1.4；右：两部制资费曲线，64 到 1400 字节平台在 11 微秒出头，4096 起爬坡，65507 到 32.7，增量斜率约 12GB/s" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">左：三层拆账（l3 拓扑，中位）　右：两部制资费（UDP 中位）</text>
<line class="axis" x1="40" y1="220" x2="310" y2="220" stroke="#6b675e" stroke-width="1.3"/>
<rect class="bx" x="52" y="176" width="42" height="44" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="73" y="170" text-anchor="middle" font-size="9.5" fill="#2b2a26">4.43</text>
<text class="ts" x="73" y="236" text-anchor="middle" font-size="9.5" fill="#6b675e">管道</text>
<rect class="bx" x="116" y="151" width="42" height="69" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="137" y="145" text-anchor="middle" font-size="9.5" fill="#2b2a26">6.90</text>
<text class="ts" x="137" y="236" text-anchor="middle" font-size="9.5" fill="#6b675e">unix</text>
<rect class="bx-q" x="180" y="106" width="42" height="114" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="201" y="100" text-anchor="middle" font-size="9.5" fill="#2b2a26">11.41</text>
<text class="ts" x="201" y="236" text-anchor="middle" font-size="9.5" fill="#6b675e">UDP</text>
<rect class="bx" x="244" y="92" width="42" height="128" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="265" y="86" text-anchor="middle" font-size="9.5" fill="#2b2a26">12.85</text>
<text class="ts" x="265" y="236" text-anchor="middle" font-size="9.5" fill="#6b675e">TCP</text>
<text class="tc" x="105" y="140" text-anchor="middle" font-size="9" fill="#b03a2e">+2.5 socket 机器</text>
<text class="tc" x="169" y="95" text-anchor="middle" font-size="9" fill="#b03a2e">+4.5 IP/UDP</text>
<text class="tc" x="233" y="80" text-anchor="middle" font-size="9" fill="#b03a2e">+1.4 连接簿记</text>
<text class="ts" x="40" y="262" font-size="10" fill="#6b675e">单位 µs；管道数据引自切换篇同拓扑（l3 进程对）</text>
<line class="axis" x1="350" y1="240" x2="640" y2="240" stroke="#6b675e" stroke-width="1.3"/>
<polyline class="flk" points="365,178 410,178 455,176 500,176 545,168 590,152 630,60" fill="none" stroke="#2b2a26" stroke-width="1.6"/>
<g fill="#2b2a26">
<circle cx="365" cy="178" r="3"/><circle cx="410" cy="178" r="3"/><circle cx="455" cy="176" r="3"/><circle cx="500" cy="176" r="3"/><circle cx="545" cy="168" r="3"/><circle cx="590" cy="152" r="3"/><circle cx="630" cy="60" r="3"/>
</g>
<g font-size="8.5" fill="#6b675e" text-anchor="middle">
<text x="365" y="254">64B</text><text x="410" y="254">256</text><text x="455" y="254">1K</text><text x="500" y="254">1.4K</text><text x="545" y="254">4K</text><text x="590" y="254">16K</text><text x="630" y="254">64K</text>
</g>
<text class="ts" x="365" y="196" font-size="9.5" fill="#6b675e">一口价平台 ~11µs（64B→1400B 只差 0.45）</text>
<text class="tc" x="520" y="90" font-size="9.5" fill="#b03a2e">爬坡段斜率 ≈12GB/s</text>
<text class="tc" x="520" y="104" font-size="9.5" fill="#b03a2e">（每轮 4 次拷贝计价，32.66µs@64K）</text>
<text class="ts" x="350" y="270" font-size="10" fill="#6b675e">rtt 中位（µs），两轮交错取平均</text>
</svg>
</figure>

## 分片：一封信装不下就拆三封

IP 层出站前查一次 MTU（`__ip_finish_output`，ip_output.c:307）：超了就 `ip_fragment`（:575）拆信。本机实测，`ping -s 4000`（4008 字节数据报，wlan0 MTU 1500）发 20 个：

```
FragCreates: +60    （20 个数据报 × 3 片，账本分毫不差）
FragOKs:     +20
ReasmReqds:  +60    （回程 20 个 4008B 应答，各拆 3 片回来）
ReasmOKs:    +20
对照 -s 1000：四项全零
```

账在 `/proc/net/snmp` 的 Ip 行，平时这几栏常年是 0，一做实验就跳——干净得少见。分片的规矩顺带交代：片的数据长度必须是 8 的倍数（片偏移字段以 8 字节为单位），任何一片丢了整个数据报作废（接收端没法重组），所以路径 MTU discovery 和「别发超过 MTU 的 UDP」是老生常谈。lo 上这些都不会发生：lo 的 MTU 是 65536，而 UDP 单包上限 65507（65535 − 20 IP 头 − 8 UDP 头），**设计上就装得下**——本机 IO 永远不分片，这是 65507 这个怪数字的真正来历。

真网卡上 TCP 大段另有活法：TSO/GSO 把切片的活推迟到最后一刻（硬件或软件）。本机 wlan0 的 segmentation offload 全 off（`ethtool -k` 实测），WiFi 卡不接这活；lo 则宣称全 on——反正 64KB 的 skb 它一口吞下，无所谓切不切。

## qdisc：发送侧的闸

⑤那一站值得单独说，因为它牵着上一篇的悬案。`__dev_queue_xmit`（dev.c:4771）选好发送队列（`netdev_pick_tx`，:4696——多队列篇的主角），接着 `__dev_xmit_skb`（:4185）过 qdisc 这道闸。关键在「过」的方式：**常规路径下，入队、出队、调驱动发送，全部在发送方系统调用的上下文里内联跑完**——不等软中断、不排队等下回。这就是 NET_TX 门可罗雀的结构性原因：发送这条流水线上根本没有留给软中断的常规岗位。

本机没有活体 qdisc 可看：lo 和 wlan0 的根 qdisc 都是 noqueue（mac80211 在驱动内部另有自己的队列）。`net.core.default_qdisc` 是 fq_codel，但它是全局旋钮——netns 里的 `/proc/sys/net/core/` 根本没有这个文件（上一篇盘点过那张短名单，v7.2 的 net/core 旋钮多半 init_net 专属）。

活体去 netns 里造（`unshare -rn`，无 root）：

```
== v0 root qdisc:            qdisc noqueue ...        ← veth 出生自带 IFF_NO_QUEUE（veth.c:1748）
== ping -c 50 穿 veth 后:    tc -s: Sent 0 bytes 0 pkt   ← noqueue 连账都不记！
== tc qdisc replace dev v0 root netem loss 10%
== ping -c 200:              181 received, 9.5% packet loss
== tc -s:                    Sent 18078 bytes 185 pkt (dropped 19, ...)
```

两个发现。**noqueue 不记账**：50 个 ping 明明全通了（rtt min 11µs，和 lo 同量级——③的素材），`tc -s` 却一个字节都没记——包没经过 qdisc 的代码路径，统计自然为零。**闸换上就有账**：netem 一挂，sent/dropped 立刻开张，19 个丢包对上 9.5% 的实测丢失——发送侧的丢包闸和它的账本，无 root 也能全须全尾地看一遍。收包篇的四道闸是接收侧的，这是发送侧补上的那道。

## 发送完成：skb 谁来收尸

字节发出去了，skb 占的内存还不能放——得等硬件确认「真的发出去了」。回收路线三条：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="TX 完成回收三条路：有线网卡走硬中断 dev_kfree_skb_irq 挂 completion_queue 由 NET_TX 软中断释放；本机 WiFi 在中断线程里调 ieee80211_tx_status_irqsafe 挂给 tasklet，由 TASKLET 向量释放；lo 则所有权直递接收方，零回收" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netTXa2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">skb 的三种收尸路线（本机只有后两种）</text>
<rect class="bx" x="20" y="40" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="85" y="58" text-anchor="middle" font-size="10.5" fill="#2b2a26">有线网卡</text>
<text class="ts" x="85" y="74" text-anchor="middle" font-size="9" fill="#6b675e">TX 完成硬中断</text>
<rect class="bx" x="20" y="100" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="85" y="118" text-anchor="middle" font-size="10.5" fill="#2b2a26">本机 WiFi（rtw88）</text>
<text class="ts" x="85" y="134" text-anchor="middle" font-size="9" fill="#6b675e">中断线程里报 tx 状态</text>
<rect class="bx" x="20" y="160" width="130" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="85" y="178" text-anchor="middle" font-size="10.5" fill="#2b2a26">lo</text>
<text class="ts" x="85" y="194" text-anchor="middle" font-size="9" fill="#6b675e">没有「发出去」这回事</text>
<line class="fl" x1="150" y1="62" x2="196" y2="62" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa2)"/>
<line class="fl" x1="150" y1="122" x2="196" y2="122" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa2)"/>
<line class="fl" x1="150" y1="182" x2="196" y2="182" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netTXa2)"/>
<rect class="bx-q" x="200" y="40" width="270" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="335" y="58" text-anchor="middle" font-size="9.5" fill="#2b2a26">dev_kfree_skb_irq（dev.c:3460）→ completion_queue</text>
<text class="ts" x="335" y="74" text-anchor="middle" font-size="9.5" fill="#6b675e">raise NET_TX → net_tx_action 里统一释放</text>
<rect class="bx-q" x="200" y="100" width="270" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="335" y="118" text-anchor="middle" font-size="9.5" fill="#2b2a26">ieee80211_tx_status_irqsafe → tasklet（status.c:40）</text>
<text class="ts" x="335" y="134" text-anchor="middle" font-size="9.5" fill="#6b675e">TASKLET 软中断里释放（main.c:467）</text>
<rect class="bx-q" x="200" y="160" width="270" height="44" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="335" y="178" text-anchor="middle" font-size="9.5" fill="#2b2a26">loopback_xmit 里 skb_orphan 脱钩</text>
<text class="ts" x="335" y="194" text-anchor="middle" font-size="9.5" fill="#6b675e">所有权直递接收方，接收端用完释放，零回收</text>
<rect class="bx" x="490" y="70" width="150" height="74" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="565" y="92" text-anchor="middle" font-size="9.5" fill="#b03a2e">实测：ping 400 发窗口</text>
<text class="ts" x="565" y="110" text-anchor="middle" font-size="9.5" fill="#6b675e">TASKLET cpu10 +425</text>
<text class="ts" x="565" y="126" text-anchor="middle" font-size="9.5" fill="#6b675e">NET_TX +0</text>
<line class="fl" x1="470" y1="122" x2="486" y2="112" stroke="#6b675e" stroke-width="1.3" marker-end="url(#netTXa2)"/>
<text class="ts" x="20" y="228" font-size="11" fill="#6b675e">上一篇 ping 窗口里 TASKLET 无故 +425 的悬案，在中间这条路破案。</text>
</svg>
</figure>

有线网卡的路线是 NET_TX 三个常客之一（dev_kfree_skb_irq，中断上下文释放 skb 的延迟清理）——但本机没有有线网卡。WiFi 的 tx 状态上报走 `ieee80211_tx_status_irqsafe`（mac80211 status.c:22），它把 skb 挂上队列后 `tasklet_schedule`（:40），真正的释放在 TASKLET 软中断里的 `ieee80211_tasklet_handler`（main.c:467，注册于 :1035）。上一篇 ping 窗口里 cpu10 的 TASKLET 凭空 +425 而 NET_TX 纹丝不动——悬案就此破案：**本机的发送回收骑的是 TASKLET 向量**。lo 最干脆：`loopback_xmit` 进门就 `skb_orphan` 把 skb 和发送方 socket 脱钩，所有权直递接收端，接收方用完释放——没有回收这回事。

TX 环的 wp/rp 和 RX 环同一套舞步：驱动挂包推 wp，硬件发完推自己的完成指针，驱动追上就把 skb 解下来走上面三条路之一。

## 小结

标题的答案收拢：**send() 的一个字节，单向被 CPU 拷贝两次**（进 skb 一次、出 skb 一次），lo 往返四次，跨机另加两次 DMA；载荷之外的协议头是逐层 push 上去的，不拷贝；邻居盖的 16 字节 L2 头戳是零头；校验和看设备脸色——lo 全免，wlan0 CPU 现算。延迟是两部制资费：每包一口价 ~11µs（大头是系统调用、唤醒和调度，不是协议处理），每字节增量按 ~12GB/s 计。

下一篇把镜头拉回本机：127.0.0.1 到底过不过网卡，本机 IP 和环回地址有没有性能差，veth 的 11µs 和 lo 的 12.3µs 差在哪——本机 IO 篇见。

## 我踩的坑

**CPU jiffies 账算每字节单价，翻车翻出五倍。** 4.2GB 拷贝对 40ms system 时间，照面值 105GB/s，超内存带宽五倍。tick 采样记不住 33µs 的短爆发，64KB 工作集又可能全程住在 L2 里——两种解释在现有量具下分不开，每字节单价最后只信 RTT 斜率。用系统自带的账本前先问一句：这账是逐笔记的，还是抽查的？

**netns 里的世界比主机短一截。** `default_qdisc`、`netdev_max_backlog` 这些旋钮在 netns 的 /proc/sys/net/core/ 里根本不存在（init_net 专属），脚本里按主机经验写路径直接报错。还有更阴的：netns 里写 `ping_group_range` 失败（EINVAL），ping 却照样通——因为 `unshare -rn` 给了 CAP_NET_RAW，ping 走的是原始套接字，压根不需要那个 sysctl。**权限到了哪条路上，得先弄清楚再下结论**，不然会把「碰巧能用」当成「配置生效」。

**noqueue 连账都不记，差点当成路不通。** veth 上 50 个 ping 全通，`tc -s` 却是 Sent 0——包走的是绕过 qdisc 的直发路径，统计自然为零。qdisc 的账只记过闸的包；判断流量走没走，得换 /proc/net/dev 那本账对。

**socketpair 的拆账是数量级账。** AF_UNIX 对照组省了地址查找那一步，+2.5µs 的「socket 机器」标价里不含这项。三层拆账拿来定性分账没问题，谁要拿它当逐项发票，得先把每层的量具做齐。

**avg 是氛围组，med 才进结论。** 65507B 档 avg 37.1µs 对 med 33.4——桌面背景的一次干扰尖峰全被平均吃了进去，中位纹丝不动。两轮交错复跑后 med 相差 1.4µs、avg 相差 0.07µs，这篇的表格全部用 med，跟切换篇同口径。
