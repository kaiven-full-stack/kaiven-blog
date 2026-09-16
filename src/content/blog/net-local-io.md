---
title: 192.168.0.2 也走 lo：本机 IO 的近路与远路
description: 两个民间说法在本机 7.2.3 上判刑。「只有 127.0.0.1 不过网卡」——错：ip route get 192.168.0.2（本机 WiFi 地址）直接解析成 dev lo，连挂在 linkdown 的 docker0 上的 172.17.0.1 也走 lo；网卡地址一配上，fib_add_ifaddr 就往 local 表登记 /32 的 RTN_LOCAL 路由（fib_frontend.c:1150），查找命中 RTN_LOCAL 就把出设备改成 net->loopback_dev（route.c:2872，注释原话「L3 master device is the loopback for that domain」）——登记簿（ip route list table local 里写 dev docker0）和现场解析（route get 给出 dev lo）是两本账。7.2 的 local 表还有个戏法：无自定义规则时它是 main 表的别名（fib_new_table，fib_frontend.c:88，一棵 trie 两块招牌），fib_lookup 快路径只查 main/default 两个缓存指针（ip_fib.h:373）；本机因 Meta 隧道在 9000/9001 挂了规则，退回全量规则行走（rule 0 即 local 表）。「换成 127.0.0.1 能快一点」——也错：锁步五万轮中位，127.0.0.1 11.12~11.16µs、192.168.0.2 11.34~11.36、网桥地址 172.18.0.1 11.78，差异在噪声内；/proc/net/dev 铁证：10.4 万包全记 lo（+104004），wlan0 全程 +1 背景。lo 走近路省掉的：DMA、硬中断、驱动 TX 环、qdisc（noqueue 直发 dev.c:4942）、线缆、ARP（lo 邻居生来 NUD_NOARP，arp.c:272）；不省的远路：系统调用、IP/UDP 协议栈（ip_local_deliver，ip_input.c:250）、软中断与 backlog、两次拷贝、唤醒——「本机 IO 没开销」是错觉。lo 细节三件套：假以太网头（hard_header_len=ETH_HLEN，loopback.c:169，MAC 全 0，为抓包生态兼容）；账本完全对称（rx_pkt==tx_pkt==94 亿，每包两侧各记一次）；MTU 65536 令 65507 的 UDP 永不分片。自写 AF_PACKET 量具 pcap-sniff 在 netns 内抓现行（主机无 CAP_NET_RAW 开不了，如实标注）：ping 自己挂在 v0 上的地址，lo 抓到 80 帧（echo 40+reply 40，tx/rx 双 tap 各记一次）、v0 零 ICMP；ping 对管子则 lo 零帧、v0 44 帧且含 2 个 ARP——lo 从不解析邻居，veth 必须。veth 税同轮实测：lo min 14/avg 35µs vs veth min 24/avg 45µs，一跳 +10µs；归因 veth_xmit（veth.c:347）→ __dev_forward_skb（dev.c:2451）带 skb_scrub_packet（skbuff.c:6278）跨 netns 洗漱 → 对端 __netif_rx → 发送核 backlog 软中断 → 第二套协议栈：一层容器网络 = 一根管子 + 第二套栈的税，bridge/NAT 完整税表留给容器篇。eBPF sockmap 可连协议栈都跳过，要 CAP_BPF，无 root 不做，留给 eBPF 篇。3 张内联 SVG。实测于本机 Linux 7.2.3（CachyOS），源码对照 vanilla v7.2，量具 lotok v3（-H 目标地址）/pcap-sniff/local-io-netns.sh 存档 ~/net-lab，无 root 可复现。
pubDate: 2026-09-30
category: network
tags: [Linux, 网络, 内核]
---

关于本机网络 IO，民间流传两个说法。其一：「127.0.0.1 不过网卡，所以把服务地址从本机 IP 换成 127.0.0.1 能省开销。」其二（隐含在其一里）：「只有 127.0.0.1 特殊，本机 IP 是要走网卡的。」

这篇在本机 7.2.3 上把两个说法一起判刑。先剧透：本机 IP 也走 lo——`ip route get 192.168.0.2`（这台机器自己的 WiFi 地址）当场给出 `dev lo`；而三个地址的锁步延迟差在噪声以内，「换地址提速」无从谈起。真正的问题不是「哪个地址快」，而是：**lo 这条近路到底近在哪，以及它没近掉的部分有多贵**——最后这笔账会直接算到容器网络的头上。

量具交代：`~/net-lab` 新增 pcap-sniff.c（AF_PACKET 抓包计数，按方向和协议分类；主机上无特权用户开不了 AF_PACKET——要 CAP_NET_RAW，所以抓包实验全部在 `unshare -rn` 的 netns 里做，那里有全权）和 lotok v3（加 `-H` 目标地址）。主机上的实验照旧无 root、前后差分。

## 路由表的两本账

先看现场。这台机器有四个「自己的地址」：环回 127.0.0.1、WiFi 的 192.168.0.2、docker0 网桥的 172.17.0.1（接口还是 linkdown 的）、用户网桥的 172.18.0.1。逐个问路由：

```
$ ip route get 192.168.0.2
local 192.168.0.2 dev lo table local src 192.168.0.2
$ ip route get 172.17.0.1        # docker0 此刻 linkdown
local 172.17.0.1 dev lo table local src 172.17.0.1
```

全是 `dev lo`，连 down 着的网桥地址也不例外。但翻开 local 表的登记簿，画风不一样：

```
$ ip route list table local
local 127.0.0.0/8 dev lo proto kernel scope host src 127.0.0.1
local 172.17.0.1 dev docker0 proto kernel scope host src 172.17.0.1
local 192.168.0.2 dev wlan0 proto kernel scope host src 192.168.0.2   （节选）
```

登记簿上 192.168.0.2 明明写着 `dev wlan0`！两本账没有说谎，它们记的就不是同一件事：**登记的是地址的户籍（挂在哪个接口上），解析的是包的实际走法**。户籍在网卡地址配上的那一刻登记——`fib_add_ifaddr`（fib_frontend.c:1133）给每个新地址调 `fib_magic(RTM_NEWROUTE, RTN_LOCAL, addr, 32, ...)`（:1150），往 local 表塞一条 /32、类型为 RTN_LOCAL 的路由。而查路由的结果一旦命中 RTN_LOCAL，出设备当场改写：

```c
// net/ipv4/route.c:2872（ip_route_output_key_hash_rcu 内）
if (res->type == RTN_LOCAL) {
	...
	/* L3 master device is the loopback for that domain */
	dev_out = l3mdev_master_dev_rcu(FIB_RES_DEV(*res)) ? :
		net->loopback_dev;
```

注释写得直白：这个域的 L3 主设备就是环回。**「本机 IP 走不走网卡」这个问题，在路由查找的最后一步就被改判了**——目标是自己，出设备一律 lo。接收侧对称：包进来发现目的是 RTN_LOCAL，直接 `goto local_input`（route.c:2397）交给本机协议栈，压根不考虑转发。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 260" role="img" aria-label="路由判定：目的地址查 fib，命中 RTN_LOCAL 则出设备改写为 lo（不管登记在哪个接口），否则走 main 表、邻居解析、真网卡；右侧标注本机四个地址全部判为 local 的实测" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netLOa1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一次路由查找的改判现场（route.c:2872）</text>
<rect class="bx" x="20" y="44" width="140" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="90" y="66" text-anchor="middle" font-size="11" fill="#2b2a26">目的地址</text>
<text class="ts" x="90" y="84" text-anchor="middle" font-size="9.5" fill="#6b675e">127.x / 192.168.0.2 / …</text>
<line class="fl" x1="160" y1="70" x2="196" y2="70" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netLOa1)"/>
<rect class="bx-q" x="200" y="40" width="150" height="60" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="275" y="62" text-anchor="middle" font-size="11" fill="#2b2a26">fib 查找</text>
<text class="ts" x="275" y="80" text-anchor="middle" font-size="9.5" fill="#6b675e">rule 0：local 表（/32 户籍）</text>
<text class="ts" x="275" y="94" text-anchor="middle" font-size="9.5" fill="#6b675e">然后 main 表（连通/默认）</text>
<line class="fl" x1="350" y1="56" x2="406" y2="56" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netLOa1)"/>
<text class="ts" x="378" y="48" text-anchor="middle" font-size="9.5" fill="#6b675e">RTN_LOCAL</text>
<line class="fl" x1="350" y1="88" x2="406" y2="150" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netLOa1)"/>
<text class="ts" x="362" y="130" text-anchor="middle" font-size="9.5" fill="#6b675e">RTN_UNICAST</text>
<rect class="bx-q" x="410" y="34" width="230" height="48" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="tc" x="525" y="54" text-anchor="middle" font-size="10.5" fill="#b03a2e">dev_out = net-&gt;loopback_dev（改判！）</text>
<text class="ts" x="525" y="72" text-anchor="middle" font-size="9.5" fill="#6b675e">登记在 wlan0/docker0 名下也一样</text>
<rect class="bx" x="410" y="140" width="230" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="525" y="160" text-anchor="middle" font-size="10.5" fill="#2b2a26">main 表命中 → 邻居解析 → 真网卡</text>
<text class="ts" x="525" y="178" text-anchor="middle" font-size="9.5" fill="#6b675e">跨机包的正路（含 ARP/DMA/线缆）</text>
<text class="ts" x="20" y="222" font-size="11" fill="#6b675e">实测：本机四个地址（127.0.0.1 / 192.168.0.2 / 172.17.0.1 linkdown / 172.18.0.1）route get 全部 dev lo。</text>
<text class="ts" x="20" y="242" font-size="11" fill="#6b675e">7.2 戏法：无自定义规则时 local 表是 main 的别名（fib_frontend.c:88）；本机有 Meta 的规则（9000/9001），走全量行走。</text>
</svg>
</figure>

顺带一个 7.2 的戏法，读过老资料的会感兴趣：当年那个「fib_lookup 先查 local 表、再查 main 表」的双表循环已经变样。快路径（ip_fib.h:373）只查 `fib_main`、`fib_default` 两个缓存指针——因为**没有自定义规则时，local 表根本就是 main 表的别名**：`fib_new_table` 里一句 `if (id == RT_TABLE_LOCAL && !net->ipv4.fib_has_custom_rules) alias = fib_new_table(net, RT_TABLE_MAIN)`（fib_frontend.c:88），一棵 trie 挂两块招牌，快路径查 main 自然命中 local 条目。一旦系统里出现自定义规则，别名戏法失效，退回 `__fib_lookup` 的全量规则行走（默认规则：0 号 local、32766 main、32767 default，fib_rules.c:484-490）。本机正是后者——`ip rule` 里 9000/9001 挂着代理软件 Meta 的规则，所以每个包都老老实实从 rule 0 的 local 表查起。

## 等速：三个地址，一条路

说法二判决前，把「127.0.0.1 更快」这个说法也过一遍堂。锁步 UDP 五万轮、钉核 0/2（与发送篇同口径），只换目标地址：

| 目标地址 | rtt 中位（两轮） | rtt min | /proc/net/dev 增量 |
|---|---|---|---|
| 127.0.0.1 | 11.16 / 11.12µs | 9.73 / 11.00 | lo +104002，wlan0 +4/+4（背景） |
| 192.168.0.2（本机 WiFi 地址） | 11.34 / 11.36µs | 10.08 / 10.65 | lo +104004，wlan0 +1/+2（背景） |
| 172.18.0.1（用户网桥地址） | 11.78µs | 11.15 | 同上量级 |

中位差最大 0.24µs（2%），min 值两轮交错互有胜负——**本机量具分不出这三个地址的快慢**。计数器是铁证：十万四千个包全部记在 lo 名下，wlan0 的增量是纯背景噪声（桌面常驻流量），一个实验包都没碰过无线卡。

「换 127.0.0.1 提速」的偏方可以休矣：不是它快，是它们仨走的同一条路。这条偏方唯一的真实收益场景是绕开防火墙/代理对本机网段地址的拦截规则——那是策略账，不是性能账。

## 近路与远路

lo 这条近路，省掉的是什么、留下的是什么，把收包篇的七站图拿来划掉几站就清楚了：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="本机 IO 对跨机 IO：划掉 DMA 写环、硬中断、驱动 TX 环、qdisc 排队、线缆、ARP 解析六站；保留系统调用、传输层拷贝、IP 层、软中断 backlog、协议栈分发、socket 队列、唤醒七站；结论是省的全是硬件和排队，协议栈整套照走" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netLOa2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">省掉的（虚线划掉）与留下的：本机 IO 的账单</text>
<g>
<rect class="bx-gone" x="20" y="40" width="140" height="40" rx="4" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="90" y="64" text-anchor="middle" font-size="10" fill="#6b675e">DMA 写 RingBuffer</text>
<line class="flc" x1="24" y1="60" x2="156" y2="44" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx-gone" x="176" y="40" width="140" height="40" rx="4" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="246" y="64" text-anchor="middle" font-size="10" fill="#6b675e">硬中断 + 中断线程</text>
<line class="flc" x1="180" y1="60" x2="312" y2="44" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx-gone" x="332" y="40" width="140" height="40" rx="4" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="402" y="64" text-anchor="middle" font-size="10" fill="#6b675e">qdisc 排队（noqueue）</text>
<line class="flc" x1="336" y1="60" x2="468" y2="44" stroke="#b03a2e" stroke-width="1.4"/>
<rect class="bx-gone" x="488" y="40" width="152" height="40" rx="4" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="564" y="64" text-anchor="middle" font-size="10" fill="#6b675e">线缆 / 空口 / ARP</text>
<line class="flc" x1="492" y1="60" x2="636" y2="44" stroke="#b03a2e" stroke-width="1.4"/>
</g>
<g>
<rect class="bx" x="20" y="106" width="86" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="63" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">系统调用</text>
<text class="ts" x="63" y="144" text-anchor="middle" font-size="9" fill="#6b675e">lock_sock</text>
<line class="fl" x1="106" y1="132" x2="118" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#netLOa2)"/>
<rect class="bx" x="122" y="106" width="86" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="165" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">装 skb+拷贝</text>
<text class="ts" x="165" y="144" text-anchor="middle" font-size="9" fill="#6b675e">发送篇 ★</text>
<line class="fl" x1="208" y1="132" x2="220" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#netLOa2)"/>
<rect class="bx" x="224" y="106" width="86" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="267" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">IP 层+路由</text>
<text class="ts" x="267" y="144" text-anchor="middle" font-size="9" fill="#6b675e">RTN_LOCAL 改判</text>
<line class="fl" x1="310" y1="132" x2="322" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#netLOa2)"/>
<rect class="bx-q" x="326" y="106" width="86" height="52" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="369" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">loopback_xmit</text>
<text class="ts" x="369" y="144" text-anchor="middle" font-size="9" fill="#6b675e">orphan+直塞 backlog</text>
<line class="fl" x1="412" y1="132" x2="424" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#netLOa2)"/>
<rect class="bx" x="428" y="106" width="86" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="471" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">软中断分发</text>
<text class="ts" x="471" y="144" text-anchor="middle" font-size="9" fill="#6b675e">ip_local_deliver</text>
<line class="fl" x1="514" y1="132" x2="526" y2="132" stroke="#6b675e" stroke-width="1.4" marker-end="url(#netLOa2)"/>
<rect class="bx" x="530" y="106" width="110" height="52" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="585" y="128" text-anchor="middle" font-size="9.5" fill="#2b2a26">socket 队列+唤醒</text>
<text class="ts" x="585" y="144" text-anchor="middle" font-size="9" fill="#6b675e">拷贝② 出栈</text>
</g>
<text class="ts" x="20" y="192" font-size="11" fill="#6b675e">省掉的全是硬件和排队；留下的协议栈一套没少——所以 11µs 对管道的 4.4µs（发送篇拆账）。</text>
<text class="ts" x="20" y="212" font-size="11" fill="#6b675e">lo 细节：假以太网头 hard_header_len=ETH_HLEN（loopback.c:169，MAC 全 0，喂抓包生态）；</text>
<text class="ts" x="20" y="232" font-size="11" fill="#6b675e">账本对称 rx_pkt==tx_pkt==9,401,080,756（每包 tx、rx 各记一次）；MTU 65536，UDP 65507 永不分片。</text>
</svg>
</figure>

**省掉的**：DMA 写环、硬中断、中断线程、驱动 TX 环、qdisc 排队（lo 是 noqueue，`__dev_queue_xmit` 末尾直接 `netdev_start_xmit`，dev.c:4942）、线缆或空口、还有 ARP——lo 的邻居条目生下来就是 NUD_NOARP（arp.c:272 认 IFF_LOOPBACK 标志），本机 IO 从不解析邻居。

**留下的**：系统调用、传输层装 skb 和那两次拷贝、IP 层（加头、查路由、netfilter 钩子一个不落）、软中断和 backlog 队列、协议栈分发（`ip_local_deliver`，ip_input.c:250）、socket 入队、唤醒接收方。收包篇和发送篇量过的每一站，lo 只缺席了硬件那几站——这就是 11µs 对管道 4.4µs 的全部差价来源，也是「本机 IO 近乎免费」这个错觉的验伪：**它免的只是网卡的费，协议栈的费一分没免**。

lo 还有三个容易踩到的细节。其一，它有假以太网头：`hard_header_len = ETH_HLEN`（loopback.c:169），帧里那 14 字节 MAC 全 0——lo 上根本没人看它，纯粹为抓包生态兼容（tcpdump -i lo 显示 EN10MB 就是这么来的）。其二，它的账本完全对称：`/proc/net/dev` 里 lo 的 rx_pkt 和 tx_pkt 都是 9,401,080,756——每个包既是发又是收，两侧各记一次，对不上才奇怪。其三，MTU 65536：发送篇算过，UDP 上限 65507 恰好塞得下，本机 IO 设计上永不分片。

## netns 里抓现行

主机上没有 CAP_NET_RAW，抓包实验搬进 `unshare -rn` 的 netns：造一对 veth（v0 留外层、v1 塞进子 netns），给 v0 挂两个网段的地址（10.99.0.1/24 和 10.77.0.1/24），然后两组对照，每组同时在 lo 和 v0 上开抓：

| 实验 | ping 目标 | lo 抓到 | v0 抓到 |
|---|---|---|---|
| A：自己的地址 | 10.77.0.1（挂在 v0 上） | **80 帧**：icmp_echo 40 + icmp_reply 40 | 10 帧（全是 IPv6 背景噪声），**ICMP 零** |
| B：对管子 | 10.99.0.2（子 netns） | **0 帧** | 44 帧：echo 20 + reply 20 + **ARP 2** + 噪声 2 |

三个读数。第一，A 组坐实路由改判：目标地址明明挂在 v0 上，包却一帧都没碰 v0，全在 lo 上转——RTN_LOCAL 改判的现行抓到。第二，lo 上的帧数是包数的两倍（40 个包抓出 80 帧，out 39 / in 41）：**AF_PACKET 在发送 tap 和接收 tap 各记一次**，lo 一个设备身兼两职，所以每包两条记录；veth 的 v0 只管发或收其中一头，44 帧就是 44 次。不知道这个口径，就会把「包被复制了」当成 bug。第三，B 组里那 2 个 ARP：veth 是真设备，跨 netns 通信要先解析邻居；lo 永远是 NUD_NOARP，一个 ARP 都不会有。

## veth 税：第二套协议栈的价钱

同一轮实验里顺手量了 lo 和 veth 的 RTT（各 100 发，-i 0.01，同参数背靠背）：

```
lo  （127.0.0.1）: min 14µs / avg 35µs / max  69µs
veth（10.99.0.2） : min 24µs / avg 45µs / max 111µs
```

一跳 veth 的税：**min +10µs（+71%），avg +10µs（+29%）**。税单拆开看，veth 比 lo 多付三样：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 230" role="img" aria-label="lo 与 veth 的路径对比：lo 一套协议栈内直递；veth 要把 skb 跨 netns 洗漱（skb_scrub_packet）、塞进对端设备的 backlog、再走一遍完整的第二套协议栈，min 多 10 微秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netLOa3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">同样不出机器，veth 比 lo 多付三样</text>
<rect class="bx-q" x="20" y="40" width="620" height="46" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="36" y="59" font-size="10.5" fill="#2b2a26">lo：协议栈 → loopback_xmit → orphan → 本核 backlog → 软中断 → 协议栈（同一套）→ socket</text>
<text class="ts" x="36" y="77" font-size="9.5" fill="#6b675e">min 14µs / avg 35µs（netns 实测，100 发）</text>
<rect class="bx" x="20" y="100" width="620" height="86" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="36" y="119" font-size="10.5" fill="#2b2a26">veth：协议栈 → veth_xmit（veth.c:347）→ 多付的三样 → 对端 netns 协议栈 → socket</text>
<text class="tc" x="36" y="139" font-size="9.5" fill="#b03a2e">① 跨 netns 洗漱：__dev_forward_skb（dev.c:2451）→ skb_scrub_packet（skbuff.c:6278）</text>
<text class="tc" x="36" y="156" font-size="9.5" fill="#b03a2e">② 对端设备重新入队：__netif_rx → 发送核的 backlog → 又一轮软中断出勤</text>
<text class="tc" x="36" y="173" font-size="9.5" fill="#b03a2e">③ 第二套协议栈：skb-&gt;dev 已换成对端 netns 的设备，路由/netfilter/ARP 全部重来</text>
<text class="ts" x="330" y="212" font-size="11" fill="#6b675e">min 24µs / avg 45µs——一层容器网络 = 一根管子 + 第二套栈的税（bridge/NAT 的完整税表见容器篇）</text>
</svg>
</figure>

`veth_xmit`（veth.c:347）拿到对端设备后调 `veth_forward_skb`（:320）：`__dev_forward_skb`（dev.c:2451）先给 skb 做跨 netns 的洗漱——`skb_scrub_packet`（skbuff.c:6278）抹掉路由缓存、netfilter 标记、pktmark 这些属于上一个命名空间的痕迹——然后 `__netif_rx` 把它塞进**发送方所在核**的 backlog（没有 RPS 时不会跨核投递），软中断再出勤一轮。此时 skb 的 dev 已经是对端 netns 的设备，接下来走的是完整第二套协议栈：再查一次路由（这回在对面 netns 里）、再过一遍 netfilter、veth 还要 ARP。lo 的直递只有一套栈一次软中断，veth 是两套栈两轮处理——**+10µs 就是「第二套栈」的入场费**。

这笔账直接就是容器网络的底价：sidecar 模式里应用与代理同机不同 netns，一来一回就是两次 veth 税。老资料提醒过别把本机 IO 当免费的滥用，容器时代得加一句：跨 netns 的本机 IO，比 lo 还要再贵一截的路。想连协议栈都跳过去，7.2 时代的正经办法是 eBPF 的 sockmap/sk_redirect（把两个 socket 直接对接）——要 CAP_BPF，本机无 root 不做了，留给 eBPF 篇。

## 小结

两个说法的判决书：**127.0.0.1 不过网卡，但「只有它不过」是错的**——凡是自己名下的地址，路由查找命中 RTN_LOCAL 一律改走 lo，户籍登记在哪个接口都不影响；**「换 127.0.0.1 提速」也是错的**——三个地址锁步中位差 2% 以内，十万包一个都没碰 wlan0。lo 的近路省掉的是硬件和排队（DMA、中断、qdisc、ARP、线缆），协议栈整套照走，11µs 的定价里大头仍是系统调用、拷贝和唤醒。veth 在 lo 之上再收第二套栈的税，min +10µs——这是容器网络逐跳税表的第一行。

下一篇进连接的世界：三次握手在内核里的现场，两条队列（半连接、全连接），以及一个已经在 4.12 被内核删掉、老资料却还在推荐的旋钮。

## 我踩的坑

**量具的字节序翻了两回。** pcap-sniff 手工把两个字节拼成 ethertype（已经是主机序），又顺手套了个 ntohs——再翻一次，所有帧全归 weird，协议细分归零。方向计数没坏，A/B 对照的结论侥幸没翻车，但 ICMP 明细全丢，只能修完重跑。教训：量具上战场前，先拿已知答案的样本跑一遍（20 个 ping 就该看到 20 个 echo）——这次是靠「weird=80 不对劲」才发现的，要是分类名起得含糊点，可能就带着脏账写文章了。

**裸 wait 把 sleep 600 也等上了。** netns 脚本里两个抓包进程放后台，回头一个不带参数的 `wait`——它等的是**全部**子进程，包括那个撑住子 netns 的 `sleep 600`。脚本当场挂死十分钟量级。`wait` 要指名道姓：记下 $! 逐个等。

**lo 上抓包，帧数是包数的两倍。** 40 个包抓出 80 帧，第一反应是「哪里在复制包」——其实是 AF_PACKET 的 tx 和 rx 两个 tap 点各记一次，lo 一个设备兼任收发两端。看抓包计数先分方向（sll_pkttype），不然「放大两倍」的假象能编出一整个错误故事。

**ping 和 lotok 的延迟不能互相比。** netns 里 ping lo min 14µs，主机上 lotok UDP 锁步中位 11.2µs——看似 ping 更快，其实两把尺子：ping 是内核代答 ICMP（对端无进程参与）、每包起停用户态计时；lotok 是双进程 UDP 回显、预热五万轮、钉核。跨量具的数字只能各自成对比较，混排就是伪对照。

**route 表显示的设备会骗人。** `ip route list table local` 里 172.17.0.1 写着 dev docker0，`ip route get` 却给 dev lo——前者是户籍登记，后者是现场改判后的结果。只看 list 就下「走 docker0」的结论，正是老资料里「被路由表迷惑」的原样重演；判断走哪条路，永远以 get（或抓包/计数器）为准。
