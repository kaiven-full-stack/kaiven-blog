---
title: 三次握手的内核现场：两条队列与一个死掉的旋钮
description: 教科书的三次握手图，在 7.2 内核里是两条队列、三本计数器和一个 off-by-one。全连接队列容量实测 = backlog+1：sk_acceptq_is_full 用 > 不用 >=（sock.h:1102，注释还特意指回 2008 年的 revert 提交），somaxconn=5 塞进 6 条、backlog=3 塞进 4 条，两组钉死；listen 的截断在系统调用层 min(backlog, somaxconn)（socket.c:1968），somaxconn 出厂默认已是 4096（netns 实测，3.10 时代的 128 是老黄历）。半连接队列的守门人换了：7.x 判满条件 = reqsk_queue_len > sk_max_ack_backlog（inet_connection_sock.h:290）——上限就是 listen backlog 本尊，tcp_max_syn_backlog 退居「syncookies=0 时最后四分之一只收已证实对端」的启发式（tcp_input.c:7716）；实测 max_syn_backlog=16、backlog=100、300 发 SYN 洪水（假源 10.99.99.x，SYNACK 被对端 netns 里的黑洞路由静默吞掉）：半连接停在 101 条，SyncookiesSent=200、TCPReqQFullDoCookies=200，洪水中一发正经 connect 走 cookie 秒成（SyncookiesRecv=1——7.2 把 SyncookiesValid 改名成了 Recv，盯旧名字的量具白跑一轮）。不带 timestamp 选项的 SYN 不配拿 cookie（tcp_input.c:7680 一带）——第一轮手搓的裸 SYN 300 发全被 ListenDrops，这是隐形的闸门。abort_on_overflow 不是万灵药：它的 RST 只等「SYN 已收、ACK 时刻发现队满」那一瞬（tcp_minisocks.c:954-963），本场洪水 SYN 就被拒于门外，旋钮开到 1 计数器一字不变、客户端照样等 ETIMEDOUT。SYN 重传黑洞时间轴实测：syn_retries=1/2/3 → 3.06/7.17/19.32s，前两个与 2^(N+1)−1 严丝合缝，第三个比理论 15 多 4.3 秒记悬案；默认 retries=6 → connect 要等 127 秒才报超时；服务端 SYNACK 同款指数退避（reqsk_timer_handler，inet_connection_sock.c:1033，TCP_TIMEOUT_INIT=1s，synack_retries=5≈63s），还带养老院清退——半连接队列过半就动态下调老 req 的重试上限，注释原话「reserve half of room for young embrions」。死旋钮结案：tcp_tw_recycle 在 v7.2 全树 grep 零命中、/proc 文件不存在（4.12 删除，NAT 环境丢包灾难是死因），老资料还在推荐开启；在世家族 tcp_max_tw_buckets / tcp_tw_reuse（本机读数 2，三态）/ 新面孔 tcp_tw_reuse_delay。现场分诊：客户端超时=SYN 被拒于门（ListenOverflows 涨）、客户端收 RST=abort 旋钮且 ACK 时刻、服务端 SYN_RECV 堆积=半连接队列；ss -ltn 的 Send-Q 列就是生效 backlog。3 张内联 SVG。量具 backloglab/synflood（手搓 IP+TCP 头带选项带校验和）/connectto + handshake-netns.sh 存档 ~/net-lab，全程 netns 内无 root。实测于本机 Linux 7.2.3（CachyOS），源码对照 vanilla v7.2。
pubDate: 2026-10-01
category: network
tags: [Linux, 网络, 内核, TCP]
---

三次握手的图谁都会画：SYN、SYN+ACK、ACK，三根箭头完事。但线上因为握手出的事故——connect 偶发秒级超时、监控里 SYN_RECV 堆积、backlog 调了没效果——没有一件能从那三根箭头上看明白。因为内核的握手现场不是一张图，是**两条队列、三本计数器、一个 off-by-one，和一个已经死掉却还在被博客推荐的旋钮**。

这篇把现场全部走一遍，照例全程实测。先剧透五个数：全连接队列的真实容量是 backlog+1；半连接队列的上限在 7.x 里根本不是 `tcp_max_syn_backlog`，而是 backlog 本尊（实测 101 对 16）；syncookies 一场洪水发出 200 张、验回 1 张；SYN 重传的时间轴 3.06/7.17 秒与 2ⁿ−1 的理论值严丝合缝；`tcp_tw_recycle` 在 v7.2 的源码树里 grep 零命中。

实验场在 `unshare -rn` 造出的 netns 里（[本机 IO 篇](/posts/net-local-io/)搭好的工地）：net.ipv4 的握手旋钮全是 per-netns 的，somaxconn、syn_retries、abort_on_overflow 想拧就拧，不用求主机 root。量具三件在 `~/net-lab`：backloglab（listen 后自连 N 发、数两条队列、读 TcpExt 账）、synflood（原始套接字手搓 IP+TCP 头，带 MSS/SACK_PERM/TIMESTAMP 选项、自算校验和，只发 SYN 不回 ACK）、connectto（单次 connect 计时）。

## listen：两条队列的容量在哪定

`listen(fd, backlog)` 进来先挨一刀：`__sys_listen`（socket.c:1968）里 `backlog > somaxconn` 就砍成 somaxconn——**生效容量 = min(backlog, somaxconn)**，砍完才进 `__inet_listen_sk`（af_inet.c:198）存进 `sk_max_ack_backlog`，再由 `inet_csk_listen_start`（inet_connection_sock.c:1333）把 socket 挂上监听。somaxconn 的出厂值也换了时代：3.10 的老资料里是 128，本机 netns 里实测 **4096**（5.4 起提的默认，主机与 netns 一致）。

两条队列的分工：收到 SYN、还没等到最后那个 ACK 的连接以 request_sock 的形态待在**半连接队列**；ACK 到了、子 socket 造好、还没被 accept 取走的，排在**全连接队列**。两条队列各有各的满法、各有各的死法、各有各的账。

## 握手全程与两条队列

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 340" role="img" aria-label="三次握手与两条队列：SYN 到达过三道闸进半连接队列并回 SYNACK；ACK 到达经 tcp_check_req 造子 socket 进全连接队列；accept 取走。两处溢出分支：SYN 时全连接队满则丢弃记 ListenOverflows，ACK 时队满看 abort_on_overflow 决定 RST 还是静默" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netHSa1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">三次握手在内核里的真实行程（v7.2 函数名就位）</text>
<text class="t" x="80" y="46" text-anchor="middle" font-size="11" fill="#2b2a26">客户端</text>
<text class="t" x="560" y="46" text-anchor="middle" font-size="11" fill="#2b2a26">服务端</text>
<line class="axis" x1="80" y1="56" x2="80" y2="320" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="560" y1="56" x2="560" y2="320" stroke="#6b675e" stroke-width="1.2"/>
<line class="flk" x1="84" y1="80" x2="552" y2="100" stroke="#2b2a26" stroke-width="1.5" marker-end="url(#netHSa1)"/>
<text class="ts" x="300" y="80" text-anchor="middle" font-size="10.5" fill="#2b2a26">SYN → tcp_v4_rcv（tcp_ipv4.c:2070）→ tcp_conn_request（tcp_input.c:7620）</text>
<rect class="bx-q" x="330" y="108" width="220" height="46" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="440" y="126" text-anchor="middle" font-size="9.5" fill="#2b2a26">三道闸（见下图）→ request_sock</text>
<text class="ts" x="440" y="144" text-anchor="middle" font-size="9.5" fill="#6b675e">进半连接队列，状态 SYN_RECV</text>
<line class="flk" x1="556" y1="166" x2="88" y2="184" stroke="#2b2a26" stroke-width="1.5" marker-end="url(#netHSa1)"/>
<text class="ts" x="300" y="166" text-anchor="middle" font-size="10.5" fill="#2b2a26">SYN+ACK（cookie 模式则不占队列，ISN 里藏状态）</text>
<line class="flk" x1="84" y1="200" x2="552" y2="218" stroke="#2b2a26" stroke-width="1.5" marker-end="url(#netHSa1)"/>
<text class="ts" x="300" y="200" text-anchor="middle" font-size="10.5" fill="#2b2a26">ACK → tcp_check_req（tcp_minisocks.c:687）</text>
<rect class="bx-q" x="330" y="226" width="220" height="46" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="440" y="244" text-anchor="middle" font-size="9.5" fill="#2b2a26">tcp_v4_syn_recv_sock（:1674）造子 socket</text>
<text class="ts" x="440" y="262" text-anchor="middle" font-size="9.5" fill="#6b675e">进全连接队列，ESTABLISHED（:1393）</text>
<rect class="bx" x="330" y="284" width="220" height="30" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="440" y="303" text-anchor="middle" font-size="9.5" fill="#2b2a26">accept()（inet_csk_accept :649）取走上桌</text>
<rect class="bx-sick" x="20" y="108" width="270" height="46" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="155" y="126" text-anchor="middle" font-size="9.5" fill="#b03a2e">溢出死法①：SYN 时全连接队已满</text>
<text class="ts" x="155" y="144" text-anchor="middle" font-size="9" fill="#6b675e">SYN 直接丢 + ListenOverflows（tcp_input.c:7656）</text>
<rect class="bx-sick" x="20" y="226" width="270" height="46" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="155" y="244" text-anchor="middle" font-size="9.5" fill="#b03a2e">溢出死法②：ACK 时队满（闸①漏网的）</text>
<text class="ts" x="155" y="262" text-anchor="middle" font-size="9" fill="#6b675e">abort_on_overflow=0 静默丢 ACK；=1 回 RST（:959）</text>
</svg>
</figure>

包从哪条流水线进来是[收包篇](/posts/net-receive-path/)讲过的事；到了 `tcp_v4_rcv` 发现是个没有主人的 SYN，就转给监听 socket 的 `tcp_conn_request`——三道闸都过了才分配 request_sock、回 SYN+ACK。最后的 ACK 到达时 `tcp_check_req` 从半连接队列里认领 req，`tcp_v4_syn_recv_sock` 现场造出子 socket（一整套内核对象，账下篇称），`inet_csk_reqsk_queue_add`（:1393）把它挂进全连接队列，等 accept 来领。

## off-by-one：容量是 backlog+1

全连接队列的判满函数值得逐字读：

```c
// include/net/sock.h:1102 —— 注释原样保留在内核里
/* Note: If you think the test should be:
 *	return READ_ONCE(sk->sk_ack_backlog) >= READ_ONCE(sk->sk_max_ack_backlog);
 * Then please take a look at commit 64a146513f8f (...)
 */
static inline bool sk_acceptq_is_full(const struct sock *sk)
{
	return READ_ONCE(sk->sk_ack_backlog) > READ_ONCE(sk->sk_max_ack_backlog);
}
```

**用的是 `>` 不是 `>=`**——队列里躺着 backlog+1 条才算满。内核怕你看不惯，注释里直接贴了 2008 年那次「改错了又改回来」的提交号。netns 里两组实测钉死这个 off-by-one：

| 实验 | somaxconn | listen(backlog) | 生效值 | connect×12 成功 | srv_est | ListenOverflows |
|---|---|---|---|---|---|---|
| E-a1 | 5 | 128 | min=5 | **6** | 6 | +18 |
| E-a2 | 4096 | 3 | min=3 | **4** | 4 | +24 |

5+1=6，3+1=4，一个不多一个不少。ListenOverflows 的 +18 = 6 个被拒客户端 × 3 发 SYN（syn_retries 拧到 1，客户端在 0/1/3 秒各试一次）——每一条被拒的 SYN 都记一笔，这个计数器是「握手期队满」最灵敏的现场指标（`nstat -az ListenOverflows` 或 `netstat -s | grep -i listen`）。

被拒客户端的死相也量到了：connect 卡满量具的 4 秒截止，errno 110（ETIMEDOUT）——**SYN 连 SYN+ACK 都没换到**，它根本不知道服务端存在。cli_est 与 srv_est 严格相等（6/6、4/4），没有幽灵连接：溢出的 SYN 在闸①就死了，走不到「客户端以为成了」那一步。

## abort_on_overflow：一把等错时刻的刀

`tcp_abort_on_overflow` 是网上的知名偏方：「打开它，队列满时给客户端 RST，让它快速失败别傻等。」netns 里把它拧到 1 重跑 E-a1——**计数器一字不变**：ok=6、fail=6、errno 还是 110、ListenOverflows 还是 +18。

原因在源码里一目了然：这颗 RST 埋伏在 `tcp_check_req` 的 listen_overflow 分支（tcp_minisocks.c:954-963）——**只有「SYN 当时收了、req 都建了、最后一个 ACK 到达时才发现队满」的连接才轮得到它**（=0 静默丢 ACK 让服务端重发 SYN+ACK，=1 回 RST）。而持续满载的场景里，后来的 SYN 在闸①（tcp_conn_request 的 acceptq 检查，:7656）就被拒了，根本走不到 ACK 时刻。偏方治的是「队列偶发打满」的瞬态，治不了「队列一直满」的稳态——稳态里客户端的结局永远是超时。

## 半连接队列：守门人已经换人

老资料讲半连接队列，容量是 `min(tcp_max_syn_backlog, backlog)` 一类公式。7.x 的判满函数只有一个比较：

```c
// include/net/inet_connection_sock.h:290
static inline int inet_csk_reqsk_queue_is_full(const struct sock *sk)
{
	return inet_csk_reqsk_queue_len(sk) > READ_ONCE(sk->sk_max_ack_backlog);
}
```

**半连接队列的上限就是全连接队列的那个 backlog 本尊**。`tcp_max_syn_backlog` 还在，但只参与另一条启发式（tcp_input.c:7716-7733）：syncookies 关着、队列进了最后四分之一、对端又不是「已证实活着」的老相识——这种 SYN 才丢。syncookies=1（默认）时这条规则整个不生效。

实测把换人坐实。netns 里 `tcp_max_syn_backlog=16`、`listen(backlog=100)`，synflood 打 300 发 SYN（假源 10.99.99.x，SYNACK 的坟场后面讲）：

```
srv_synrecv = 101          ← 半连接队列停在 100+1，16 毫无存在感
SyncookiesSent = +200      ← 队满后的 200 发 SYN 全部拿到 cookie
TCPReqQFullDoCookies = +200
SyncookiesRecv = +1        ← 洪水中那一发正经 connect，走 cookie 验证秒建
ListenDrops = 0
```

syncookies 的机制一句话：**队满之后不再为 SYN 分配任何状态**，把状态加密编进 SYN+ACK 的初始序号（`__cookie_v4_init_sequence`，syncookies.c:155）发回去；客户端的 ACK 带着这个序号回来，`__cookie_v4_check`（:184）反解验证，通过了才现场造子 socket。洪水淹不掉它，因为洪水期服务端根本不记账——代价是 cookie 连接牺牲部分 TCP 选项。洪水里那发正经 connect 秒成（rc=0，SyncookiesRecv +1），就是这套机制的存在意义：**被攻击不等于拒绝服务**。

半连接队列还有养老院清退：`reqsk_timer_handler`（inet_connection_sock.c:1033）里，队列长度过半就动态下调老 req 的 SYNACK 重试上限，注释写得直白——「reserve half of room for young embrions」，给年轻胚胎留一半床位，老的洪水残骸提前清走。SYNACK 的重传和客户端 SYN 一样是指数退避（初值 TCP_TIMEOUT_INIT=1s，tcp.h:167；`tcp_syn_ack_timeout` 逐次翻倍），上限 synack_retries 默认 5，约 63 秒后放弃。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 270" role="img" aria-label="tcp_conn_request 的三道闸决策树：全连接队满则丢弃记 ListenOverflows；半连接判满用 qlen 大于 backlog；满且 syncookies 开且 SYN 带时间戳则发 cookie 不占队列，否则丢弃；syncookies 关闭时最后四分之一只收已证实对端" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netHSa2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一发 SYN 的三道闸（tcp_conn_request，tcp_input.c:7620 起）</text>
<rect class="bx-q" x="20" y="40" width="200" height="50" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="120" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">闸① 全连接队满？</text>
<text class="ts" x="120" y="78" text-anchor="middle" font-size="9" fill="#6b675e">sk_acceptq_is_full（&gt;，容量 backlog+1）</text>
<line class="fl" x1="220" y1="65" x2="266" y2="65" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netHSa2)"/>
<text class="ts" x="243" y="57" text-anchor="middle" font-size="9" fill="#6b675e">否</text>
<rect class="bx-sick" x="20" y="112" width="200" height="42" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="120" y="130" text-anchor="middle" font-size="9.5" fill="#b03a2e">是 → SYN 当场丢</text>
<text class="ts" x="120" y="146" text-anchor="middle" font-size="9" fill="#6b675e">ListenOverflows++（:7657）</text>
<line class="fl" x1="120" y1="90" x2="120" y2="108" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#netHSa2)"/>
<rect class="bx-q" x="270" y="40" width="200" height="50" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="370" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">闸② 半连接队满？</text>
<text class="ts" x="370" y="78" text-anchor="middle" font-size="9" fill="#6b675e">qlen &gt; sk_max_ack_backlog（同一个 backlog！）</text>
<line class="fl" x1="470" y1="65" x2="516" y2="65" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netHSa2)"/>
<text class="ts" x="493" y="57" text-anchor="middle" font-size="9" fill="#6b675e">否</text>
<rect class="bx" x="520" y="40" width="120" height="50" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="580" y="60" text-anchor="middle" font-size="9.5" fill="#2b2a26">req 入队</text>
<text class="ts" x="580" y="78" text-anchor="middle" font-size="9" fill="#6b675e">回普通 SYN+ACK</text>
<rect class="bx-q" x="270" y="112" width="200" height="66" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="370" y="132" text-anchor="middle" font-size="10.5" fill="#2b2a26">闸③ 满了怎么办</text>
<text class="ts" x="370" y="150" text-anchor="middle" font-size="9" fill="#6b675e">syncookies 开 且 SYN 带时间戳</text>
<text class="ts" x="370" y="166" text-anchor="middle" font-size="9" fill="#6b675e">→ cookie SYN+ACK，不占队列（:7680 一带）</text>
<line class="fl" x1="370" y1="90" x2="370" y2="108" stroke="#6b675e" stroke-width="1.4" marker-end="url(#netHSa2)"/>
<text class="ts" x="382" y="103" font-size="9" fill="#6b675e">是</text>
<rect class="bx-sick" x="520" y="112" width="120" height="66" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="tc" x="580" y="132" text-anchor="middle" font-size="9" fill="#b03a2e">cookie 关 或 无 TS</text>
<text class="ts" x="580" y="150" text-anchor="middle" font-size="9" fill="#6b675e">→ 丢弃</text>
<text class="ts" x="580" y="166" text-anchor="middle" font-size="9" fill="#6b675e">ListenDrops++</text>
<line class="fl" x1="470" y1="145" x2="516" y2="145" stroke="#b03a2e" stroke-width="1.4" marker-end="url(#netHSa2)"/>
<text class="ts" x="20" y="212" font-size="10.5" fill="#6b675e">另有一条暗闸（syncookies=0 才生效，:7716）：队列进最后四分之一时，只收「已证实活着」的对端，</text>
<text class="ts" x="20" y="230" font-size="10.5" fill="#6b675e">陌生源直接丢——tcp_max_syn_backlog 如今只管这条启发式，不再当守门员。</text>
<text class="tc" x="20" y="254" font-size="10.5" fill="#b03a2e">实测：max_syn_backlog=16、backlog=100、洪水 300 → 队列停 101，cookie 发 200，16 毫无存在感。</text>
</svg>
</figure>

## SYN 重传：3 秒、7 秒、15 秒的节拍

客户端 connect 发出去的第一个 SYN 要是石沉大海，重传的节奏是指数退避：初值 1 秒（TCP_TIMEOUT_INIT，tcp.h:167，RFC 6298），每次翻倍。`tcp_syn_retries=N` 的累计等待是 2^(N+1)−1 秒——老资料那串「1、3、7、15、31、63」就是这么来的。netns 里造了个纯黑洞（对端 ns 内 blackhole 路由，静默吞包、不回 ICMP），三个档位实测：

| tcp_syn_retries | 理论 | 实测 connect 耗时 | errno |
|---|---|---|---|
| 1 | 3s | **3.06s** | 110 ETIMEDOUT |
| 2 | 7s | **7.17s** | 110 |
| 3 | 15s | **19.32s** | 110 |

前两档严丝合缝；第三档多出 4.3 秒，两次重跑都是 19.3 上下——稳定地不对，说明不是噪声，是重传定时器在高档位有额外的松弛或我漏数了一次退避。悬案记下，不硬圆。默认 syn_retries=6 意味着 **127 秒**：线上「connect 卡了两分钟才报错」的时长就是这个旋钮定的，对面向用户的接口毫无意义，老资料的「调小它」建议至今有效。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 210" role="img" aria-label="SYN 重传节拍时间轴：SYN 在 0 秒发出，重传在 1、3、7、15 秒，间隔逐次翻倍；三档实测放弃时刻 3.06、7.17、19.32 秒，前两档与理论 3、7 重合，第三档比理论 15 多 4.3 秒" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">SYN 重传节拍：1 秒起步、逐次翻倍，放弃时刻 = 2^(N+1)−1（第三档有悬案）</text>
<line class="axis" x1="40" y1="150" x2="620" y2="150" stroke="#6b675e" stroke-width="1.3"/>
<g stroke="#6b675e" stroke-width="1.2">
<line x1="40" y1="144" x2="40" y2="156"/><line x1="69" y1="144" x2="69" y2="156"/><line x1="127" y1="144" x2="127" y2="156"/><line x1="243" y1="144" x2="243" y2="156"/><line x1="475" y1="144" x2="475" y2="156"/>
</g>
<g font-size="9" fill="#6b675e" text-anchor="middle">
<text x="40" y="172">SYN t=0</text><text x="69" y="172">重传1 @1s</text><text x="127" y="172">重传2 @3s</text><text x="243" y="172">重传3 @7s</text><text x="475" y="172">重传4 @15s</text>
</g>
<g font-size="9.5">
<text class="ts" x="44" y="60" fill="#6b675e">N=1</text>
<line class="fl" x1="70" y1="56" x2="125" y2="56" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="131" y="60" fill="#b03a2e">✕ 3.06s（理论 3）</text>
<text class="ts" x="44" y="88" fill="#6b675e">N=2</text>
<line class="fl" x1="70" y1="84" x2="244" y2="84" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="250" y="88" fill="#b03a2e">✕ 7.17s（理论 7）</text>
<text class="ts" x="44" y="116" fill="#6b675e">N=3</text>
<line class="fl" x1="70" y1="112" x2="596" y2="112" stroke="#6b675e" stroke-width="1.2"/>
<text class="tc" x="452" y="106" fill="#b03a2e">✕ 19.32s（理论 15，悬案 +4.3s）</text>
</g>
<text class="ts" x="40" y="196" font-size="10" fill="#6b675e">默认 N=6 → 127 秒才报 ETIMEDOUT；服务端 SYNACK 同款节拍（1s 起步翻倍，synack_retries=5 ≈ 63 秒放弃）。</text>
</svg>
</figure>

## 死掉的旋钮：tcp_tw_recycle 结案

老资料的优化清单里写着：TIME_WAIT 太多？开 `tcp_tw_reuse` 和 `tcp_tw_recycle`。前半句在 7.2 还活着，后半句已经是尸体：

```
$ ls /proc/sys/net/ipv4/ | grep tw_
tcp_max_tw_buckets  tcp_tw_reuse  tcp_tw_reuse_delay     ← 没有 tcp_tw_recycle
$ grep -r tw_recycle linux-7.2/{net,include}/              ← 全树零命中
```

它死于 2017 年的 4.12（公开记录：recycle 依赖 per-host 时间戳单调假设，NAT 后面多个客户端共享一个出口 IP 时时间戳乱序，服务端会静默丢弃「回退」的包——排障地狱级的丢包）。如今在世的是三兄弟：`tcp_tw_reuse`（本机读数 2——7.x 的三态，2 表示只对环回连接生效）、`tcp_max_tw_buckets`，和新面孔 `tcp_tw_reuse_delay`。TIME_WAIT 本身的功过与挥手全程，留给挥手篇细算。

## 现场分诊卡

握手事故的三种死相，对应三处现场：

- **客户端超时（errno 110）**：SYN 被拒于闸①或闸③。看服务端 `ListenOverflows`/`ListenDrops` 是否在涨，涨哪个查哪条队列。
- **客户端收到 RST**：要么服务真没监听（正常拒绝），要么 `abort_on_overflow=1` 且死在 ACK 时刻——后者说明队列在瞬态打满。
- **服务端 SYN_RECV 堆积**：半连接队列滞留，`ss -ant state syn-recv | wc -l` 数现场；持续满员看 `SyncookiesSent` 是否开动。
- 生效 backlog 现场读数：`ss -ltn` 的 **Send-Q 列**（LISTEN 状态下它就是 min(backlog, somaxconn)）。

## 小结

握手现场的家底：生效容量 min(backlog, somaxconn)，somaxconn 出厂 4096；全连接队列实际装得下 backlog+1 条（`>` 的 off-by-one，内核注释亲自背书）；半连接队列的守门人在 7.x 换成了同一个 backlog，`tcp_max_syn_backlog` 只剩一条 syncookies=0 时的启发式；队满后 syncookies 用加密 ISN 换零状态，实测 300 发洪水里 200 张 cookie、正经连接毫发无损；SYN/SYNACK 都按 1 秒起步指数退避，默认档 connect 等 127 秒、SYNACK 等 63 秒；`tcp_tw_recycle` 死透，博客里的药方该更新了。

队列装的是连接，连接占的是内存——一条 ESTABLISHED 的空连接到底吃多少内核对象、7.2 比 3.10 涨了多少，下篇拿着 slabinfo 逐件称重。

## 我踩的坑

**SYNACK 的坟场不好造，实验翻车两轮。** 半连接实验的前提是「SYN 进得来、SYNACK 发得出、ACK 永远不回来」。第一轮假源 10.77.x.x 没有路由——SYNACK 在 `route_req`（tcp_input.c:7700）就失败，req 压根不入队，300 发全变 ListenDrops，SyncookiesSent 挂零；第二轮把黑洞路由加在发送端 netns，路由查找直接判死，同款全灭。第三轮才想通：路由要通、坟场要修在**对端 netns 里面**（SYNACK 有路可走、到了对面被 blackhole 静默吞掉、没有 RST 回来杀 req）。造一个「只进不出」的拓扑，比写量具本身费脑筋。

**裸 SYN 不配拿 cookie。** 第一版 synflood 只搓了 20 字节 TCP 头——内核规定没有时间戳选项的 SYN 不发 syncookie（`want_cookie && !saw_tstamp` 直接作废）。补上 MSS/SACK_PERM/TIMESTAMP 选项、校验和把选项一起算进去，cookie 才上场。手搓报文要对着 `tcp_parse_options` 的口味来，不是对着 RFC 的最小集来。

**盯错了计数器名字，白跑一轮。** 7.2 的 TcpExt 里 cookie 验证计数叫 **SyncookiesRecv**，旧名 SyncookiesValid 已经不存在——量具按旧名解析，洪水里那发成功的 connect 愣是没记上账。读 /proc 的量具要先 dump 一遍表头对名字，别拿三年前的字段表当合同。

**阻塞 connect 在队满时会挂 127 秒。** backloglab 第一版顺序阻塞 connect，队列满之后每发都要等满 SYN 重传——12 发里 6 发溢出就是十几分钟。改成非阻塞 + poll 统一 4 秒截止，超时的记 ETIMEDOUT，整场实验 4 秒收工。量具自己不能被实验对象劫持节奏。

**19.32 秒的悬案不硬圆。** syn_retries=3 理论 15 秒，实测 19.3 且复跑稳定——差出来的 4.3 秒我没能从源码里钉死（退避链上某处的松弛或额外一轮）。写进正文、标注悬案，比编一个自洽的解释体面。前两档 3.06/7.17 已经足够证明指数退避的骨架。
