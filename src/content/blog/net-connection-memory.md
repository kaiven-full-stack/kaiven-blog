---
title: 一条空闲连接的价钱：3.8KB 花在哪了
description: 无 root 时代的称重法：/proc/slabinfo 0400、/sys/kernel/slab 属性同样读不了，但 /sys/kernel/btf/vmlinux 是 0444——bpftool 一把导出对象全家精确尺寸：tcp_sock 2496B（老资料 2.6.32 slabtop 实测 1.62K=1659B，涨 50%，180 个成员）、sockfs_inode 768B（缓存实铸的结构，socket.c:374；BTF 里还留着旧款 socket_alloc 704B=老资料的 0.69K——两代结构体并存，认错名字整个对照偏 64B）、dentry 192B（0.19K 依旧）、file 176B（filp 0.19K 反而瘦了）、inet_timewait_sock 232B、tcp_request_sock 320B（④那 101 条半连接的 transient 单价）。四件套净尺寸 3632B/端点，对老资料 2.7K 涨三成，大头全在 tcp_sock。双天平归属：dentry+sock_inode 带 SLAB_RECLAIM_ACCOUNT（dcache.c:3475/socket.c:377）记 SReclaimable，TCP+filp 不带（file_table.c:639）记 SUnreclaim——先按 slab 对齐算账再上秤：SUnreclaim 桶预测 2909B/端点（TCP 2496→每 slab 3 对象摊 2731 + filp 178），实测 2809~2926，误差 <4%；SReclaimable 桶预测 1014B，实测 737（n=2000，被桌面 dentry 池 freelist 复用咬低 18%）→904~989（n≥20k 收敛）——秤的实验样本量必须压过背景池。connmem 量具单进程自导自演（L 监听+n 客户端+accept 回收，n=2000/20000×2/60000 四轮）：每端点 3547~3858B、每连接（双端点）~7.7KB，6 万连接 Slab +452MB，总量∝n 线性成立；fd 表翻倍到 65536 格×8B=512KB 的 vmalloc 账一轮可见。百万端点 ≈3.9GB，老资料 4GB 虚机装百万连接 slab 占 3.2GB 的量级判断依旧成立，余量更紧。TIME_WAIT 换装实测：客户端先关（主动方），filp/dentry/sockfs_inode/tcp_sock 四件套全退场，只剩 tw_sock_TCP 一件（inet_twsk_alloc inet_timewait_sock.c:168，缓存名 tw_sock_%s sock.c:4189）——232B 对 3.8KB 一折六；twcnt=+n 如数上场，sockstat TCP mem 115→1395 页（2 万条 TW≈260B/条与对象同量级）；空闲 ESTABLISHED 的缓冲账≈0（tcpmem 纹丝不动）——对象与缓冲两本账不能混。slab 页不随对象退：post 相 SUnreclaim 残留 +12~27MB（partial 链/per-cpu 缓存等收缩器，呼应 slab 篇）；TCP_TIMEWAIT_LEN=60*HZ（tcp.h:140）编译期常量不是旋钮。端口算术先于内存算术：6 万连接单监听口先撞 ephemeral 上限 28232，L=4 分治。3 张内联 SVG。实测于本机 Linux 7.2.3（CachyOS，nofile 1048576），源码对照 vanilla v7.2，connmem 存档 ~/net-lab，无 root 可复现。
pubDate: 2026-10-02
category: network
tags: [Linux, 网络, 内核, TCP]
---

[握手篇](/posts/net-tcp-handshake/)结尾留了个问题：队列装的是连接，连接占的是内存——一条 ESTABLISHED 的空连接，到底吃掉多少内核对象？老资料给过答案：2.6.32 的机器上装了一百万条，slabtop 逐件数出来，四件套合计 3K 出头。这篇在本机 7.2.3 上重新称一遍，先看剧透：**每端点实测 3.8KB，净尺寸账对老资料涨了三成，大头全落在 tcp_sock 一件上（1659→2496B，+50%）**；而 TIME_WAIT 换装之后只剩 232B——全价的十六分之一。

称重的第一道坎是权限：`/proc/slabinfo` 是 0400，`/sys/kernel/slab/*` 的属性文件同样读不动。但 7.x 时代多了第二把无 root 的精确尺——**BTF**：`/sys/kernel/btf/vmlinux` 权限 0444，本机正好有 bpftool：

```
$ bpftool btf dump file /sys/kernel/btf/vmlinux format raw | grep "STRUCT 'tcp_sock'"
[138025] STRUCT 'tcp_sock' size=2496 vlen=180
```

一行命令，内核亲手报出每个结构体的精确尺寸——这比老资料的 slabtop 抄录还硬。秤则用三本世界可读的账：`/proc/meminfo` 的 Slab/SReclaimable/SUnreclaim（两杆天平）、`/proc/net/sockstat` 的 TCP 行、`/proc/net/tcp` 的状态计数。

## 对象家族：一条连接的四件套

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 290" role="img" aria-label="一条连接端点的对象家族：fd 指向 struct file（filp 缓存 176 字节），file 指向 socket+inode 复合体（sock_inode_cache 704 字节）并带一个 dentry（192 字节），socket 指向 sk 即 tcp_sock（TCP 缓存 2496 字节）；旁边两个 transient：半连接的 tcp_request_sock 320 字节、TIME_WAIT 的 tw_sock_TCP 232 字节" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netCMa1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一个端点 = 四件常驻对象（尺寸为 7.2.3 BTF 精确值）</text>
<rect class="bx" x="20" y="46" width="90" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="65" y="70" text-anchor="middle" font-size="11" fill="#2b2a26">fd</text>
<text class="ts" x="65" y="88" text-anchor="middle" font-size="9" fill="#6b675e">fd 表 8B/格</text>
<line class="fl" x1="110" y1="74" x2="146" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netCMa1)"/>
<rect class="bx-q" x="150" y="46" width="140" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="220" y="66" text-anchor="middle" font-size="11" fill="#2b2a26">struct file</text>
<text class="tc" x="220" y="84" text-anchor="middle" font-size="9.5" fill="#b03a2e">filp 缓存 · 176B</text>
<text class="ts" x="220" y="97" text-anchor="middle" font-size="8.5" fill="#6b675e">file_table.c:639</text>
<line class="fl" x1="290" y1="74" x2="326" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netCMa1)"/>
<rect class="bx-q" x="330" y="46" width="150" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="405" y="66" text-anchor="middle" font-size="11" fill="#2b2a26">socket+inode 复合体</text>
<text class="tc" x="405" y="84" text-anchor="middle" font-size="9.5" fill="#b03a2e">sock_inode_cache · 768B</text>
<text class="ts" x="405" y="97" text-anchor="middle" font-size="8.5" fill="#6b675e">socket.c:330/:373</text>
<line class="fl" x1="480" y1="74" x2="516" y2="74" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netCMa1)"/>
<rect class="bx-q" x="520" y="46" width="120" height="56" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="580" y="66" text-anchor="middle" font-size="11" fill="#2b2a26">tcp_sock (sk)</text>
<text class="tc" x="580" y="84" text-anchor="middle" font-size="9.5" fill="#b03a2e">"TCP" 缓存 · 2496B</text>
<text class="ts" x="580" y="97" text-anchor="middle" font-size="8.5" fill="#6b675e">sock.c:4263</text>
<line class="fl" x1="405" y1="102" x2="405" y2="128" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netCMa1)"/>
<rect class="bx" x="330" y="132" width="150" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="405" y="150" text-anchor="middle" font-size="10.5" fill="#2b2a26">dentry（伪文件系统）</text>
<text class="tc" x="405" y="166" text-anchor="middle" font-size="9.5" fill="#b03a2e">dentry 缓存 · 192B</text>
<text class="ts" x="20" y="128" font-size="10" fill="#6b675e">出生链：__sys_socket(socket.c:1788) → inet_create 里 sk_alloc(af_inet.c:333) 铸 tcp_sock</text>
<text class="ts" x="20" y="146" font-size="10" fill="#6b675e">→ sock_alloc_file(:525) → alloc_file_pseudo(:532) 顺手带上 file 和 dentry</text>
<rect class="bx" x="20" y="196" width="290" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="165" y="214" text-anchor="middle" font-size="9.5" fill="#2b2a26">transient①：半连接 request_sock · 320B</text>
<text class="ts" x="165" y="230" text-anchor="middle" font-size="9" fill="#6b675e">"request_sock_TCP"（sock.c:4230）——④那 101 条 ≈ 32KB</text>
<rect class="bx" x="330" y="196" width="310" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="485" y="214" text-anchor="middle" font-size="9.5" fill="#2b2a26">transient②：TIME_WAIT 的 tw_sock_TCP · 232B</text>
<text class="ts" x="485" y="230" text-anchor="middle" font-size="9" fill="#6b675e">inet_twsk_alloc（inet_timewait_sock.c:168），下文换装现场</text>
<text class="ts" x="20" y="272" font-size="11" fill="#6b675e">一条连接两个端点（客户端 sock + 服务端子 sock），四件套 ×2；BTF 报 tcp_sock 有 180 个成员。</text>
</svg>
</figure>

四件常驻对象一件不少，和老资料 2.6.32 时代的名单完全同款：`struct file`（filp 缓存）、socket 与 inode 的复合体（sock_inode_cache）、dentry（伪文件系统给每个 socket 挂的目录项）、以及大头 `tcp_sock`（缓存名就叫 "TCP"，proto_register 按 tcp_prot.name 铸的，sock.c:4263、tcp_ipv4.c:3349）。复合体这里有个两代同堂的陷阱：BTF 里旧款 `socket_alloc`（704B，正是老资料抄的 0.69K）和新款 `sockfs_inode`（**768B**，多了一个成员）并存，缓存实铸用的是后者（socket.c:374 的 sizeof）——认错名字，整个对照就偏 64B。出生链一条线：`__sys_socket`（socket.c:1788）→ `inet_create` 里 `sk_alloc`（af_inet.c:333）铸出 tcp_sock → `sock_alloc_file`（:525）→ `alloc_file_pseudo`（:532）顺手带上 file 和 dentry。

## 先算账，再上秤

meminfo 的两杆天平不是随便分的——**dentry 和 sock_inode_cache 带 SLAB_RECLAIM_ACCOUNT 标志**（dcache.c:3475、socket.c:377），记进 SReclaimable；**TCP 和 filp 不带**（file_table.c:639 只有 ACCOUNT/TYPESAFE_BY_RCU），记进 SUnreclaim。家族归属清楚，就能先按 BTF 尺寸加 slab 对齐把预测账算出来：

| 桶 | 对象 | 纯尺寸 | slab 对齐后/件 | 桶预测/端点 |
|---|---|---|---|---|
| SUnreclaim | tcp_sock | 2496B | ~2731B（3 件/slab） | **~2909B** |
| SUnreclaim | file | 176B | ~178B（23 件/slab） | |
| SReclaimable | sockfs_inode | 768B | ~819B（5 件/slab） | **~1014B** |
| SReclaimable | dentry | 192B | ~195B（21 件/slab） | |

然后上秤。量具 connmem（`~/net-lab`）单进程自导自演：L 个监听 socket、n 条客户端连接、accept 全部收回，ESTABLISHED 且零数据——标准「空闲连接」工况；三本账在建立前后各自快照。分批建连（每 2000 条收一次 accept 队列，容量 4097 是[握手篇](/posts/net-tcp-handshake/)量过的）：

| n（连接数） | 端点数 | SReclaimable/端点 | SUnreclaim/端点 | Slab 合计/端点 | 每连接（双端） |
|---|---|---|---|---|---|
| 2 000 | 4 000 | 737B | 2809B | 3547B | 7.1KB |
| 20 000（r1） | 40 000 | 922B | 2926B | 3849B | 7.7KB |
| 20 000（r2） | 40 000 | 904B | 2883B | 3787B | 7.6KB |
| 60 000 | 120 000 | 989B | 2868B | 3858B | 7.7KB |

两个桶对着预测看：**SUnreclaim 桶实测 2809~2926B，预测 2909B，误差 4% 以内**——tcp_sock+file 的 slab 账基本是分毫不差；SReclaimable 桶在 n=2000 时只有 737B（比预测低 18%），n≥20000 收敛到 904~989B——小样本被背景池咬了：桌面系统常年攒着的 dentry/sockfs partial slab 里有空位，新对象先住空房，不触发新页分配。**秤上的样本量必须压过背景池**，这和内存山实验要压过缓存容量是同一类纪律。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 240" role="img" aria-label="先算后称对比：SUnreclaim 桶预测 2909 字节对实测 2809 至 2926，误差 4% 以内；SReclaimable 桶预测 1014 字节，小样本实测 737 被 freelist 复用咬低，大样本收敛到 904 至 989" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">BTF 算出来的账 vs meminfo 称出来的账（每端点字节数）</text>
<line class="axis" x1="150" y1="200" x2="640" y2="200" stroke="#6b675e" stroke-width="1.3"/>
<text class="ts" x="20" y="70" font-size="10.5" fill="#2b2a26">SUnreclaim</text>
<text class="ts" x="20" y="86" font-size="9" fill="#6b675e">TCP+filp</text>
<rect class="bx-gone" x="150" y="52" width="436" height="16" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="592" y="64" font-size="9" fill="#6b675e">预测 2909</text>
<rect class="bx-q" x="150" y="72" width="432" height="16" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="588" y="84" font-size="9" fill="#2b2a26">实测 2809~2926（误差&lt;4%）</text>
<text class="ts" x="20" y="140" font-size="10.5" fill="#2b2a26">SReclaimable</text>
<text class="ts" x="20" y="156" font-size="9" fill="#6b675e">dentry+sock_inode</text>
<rect class="bx-gone" x="150" y="122" width="152" height="16" fill="none" stroke="#6b675e" stroke-width="1.1" stroke-dasharray="4 3"/>
<text class="ts" x="308" y="134" font-size="9" fill="#6b675e">预测 1014</text>
<rect class="bx-sick" x="150" y="142" width="111" height="16" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="267" y="154" font-size="9" fill="#b03a2e">n=2k 实测 737（freelist 咬低 18%）</text>
<rect class="bx-q" x="150" y="162" width="148" height="16" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="304" y="174" font-size="9" fill="#2b2a26">n≥20k 实测 904~989（收敛）</text>
<text class="ts" x="20" y="224" font-size="10.5" fill="#6b675e">条形长度按字节等比（0.15 px/B）；背景池的空位只影响 SReclaimable 桶——dentry 是桌面系统的大户。</text>
</svg>
</figure>

顺带两笔小账。fd 表：4 万个 fd 逼着 fdtable 翻倍到 65536 格 × 8B = 512KB——r2 轮的 VmallocUsed 正好 +512KB（r1 轮没看见，vmalloc 账被桌面噪声和记账时机淹了，一轮可见一轮不可见，如实记）。缓冲账：ESTABLISHED 空闲连接的 sockstat TCP mem 栏纹丝不动（115 页）——**对象和缓冲是两本账**，空连接只付对象钱，缓冲钱等数据来了再付。

## 对照老资料：四成涨幅全在一件上

| 对象 | 2.6.32（老资料 slabtop） | 7.2.3（BTF） | 变化 |
|---|---|---|---|
| dentry | 0.19K | 192B | 原地踏步 |
| filp / file | 0.19K | 176B | 反而瘦了 |
| sock_inode_cache | 0.69K（旧 socket_alloc 704B） | sockfs_inode 768B | +9%，多了一个成员 |
| TCP / tcp_sock | 1.62K（1659B） | **2496B** | **+50%** |
| 四件套合计 | ≈2.7K（书结论「3K 多」） | 净尺寸 3632B，实测 ~3.8K（含 slab 对齐） | **+32%（净尺寸口径）** |

dentry 十几年没动过一个字节，file 甚至还瘦了点，sockfs 复合体多了一个成员涨 64B——**涨价的大头是 tcp_sock：1659 → 2496 字节**，BTF 顺带报了它的成员数：180 个。十几年里塞进去的东西（时间戳精细化、BPF 挂钩、MPTCP 字段、拥塞控制私有区……）都长在这一个结构体里。每连接（双端点）7.7KB、百万端点约 3.9GB——老资料那台 4GB 虚机装百万连接、slab 占掉 3.2GB 的量级判断，在 7.2 上依然成立，只是余量更紧了。「服务器最大连接数受限于内存」这个结论没变，单价变了。

## TIME_WAIT 换装：全价的十六分之一

connmem 拆场的顺序是客户端先关（它是主动关闭方，TIME_WAIT 归它——为什么归主动方，挥手篇细讲）。关闭瞬间发生的是一场换装：filp、dentry、sock_inode、tcp_sock 四件套**全部退场**，内核只留一件小得多的替身——`inet_twsk_alloc`（inet_timewait_sock.c:168）从 "tw_sock_TCP" 缓存（名字是 `kasprintf("tw_sock_%s", ...)` 拼的，sock.c:4189）里取一个 **232 字节**的 inet_timewait_sock，记住四元组和序号，把尸体守满 60 秒。

账本如实上映：n=20000 拆场后 `/proc/net/tcp` 的 TIME_WAIT 计数 +20000 整、sockstat 的 tw 栏同步；TCP mem 栏从 115 页爬到 1395 页——每条约 260B，与 tw 对象 232B 同量级（slab 对齐后 ~241B/件，232B 对象 17 件一个 4K slab）。**232B 对 3.8KB，一条 TIME_WAIT 只收全价端点的十六分之一**。老资料说 TIME_WAIT「仅 0.5KB」，方向一致，7.2 的对象更苗条。所以「几万个 TIME_WAIT 会不会吃光内存」这个问题，答案在老资料那年就是不会，现在更不会——TIME_WAIT 真正贵的不是内存，是它占着一个本地端口（⑥的正题）。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 220" role="img" aria-label="TIME_WAIT 换装：主动关闭方 close 后，file、dentry、sockfs_inode、tcp_sock 四件套全部退场，只剩 232 字节的 tw_sock_TCP 记住四元组和序号，守满 60 秒；价钱从每端点 3.8KB 降到 241B，十六分之一" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netCMa2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">close()（主动方）是一场换装：四件退场，一件替身守 60 秒</text>
<rect class="bx" x="20" y="44" width="250" height="120" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="145" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">ESTABLISHED 端点 · 实测 ~3.8KB</text>
<text class="ts" x="145" y="86" text-anchor="middle" font-size="9.5" fill="#6b675e">file 176B ＋ dentry 192B</text>
<text class="ts" x="145" y="104" text-anchor="middle" font-size="9.5" fill="#6b675e">＋ sockfs_inode 768B</text>
<text class="ts" x="145" y="122" text-anchor="middle" font-size="9.5" fill="#6b675e">＋ tcp_sock 2496B</text>
<text class="ts" x="145" y="148" text-anchor="middle" font-size="9" fill="#6b675e">（fd 表里还占一格）</text>
<line class="fl" x1="270" y1="104" x2="356" y2="104" stroke="#6b675e" stroke-width="1.6" marker-end="url(#netCMa2)"/>
<text class="ts" x="313" y="94" text-anchor="middle" font-size="9.5" fill="#6b675e">close()</text>
<rect class="bx-q" x="360" y="64" width="280" height="80" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="500" y="88" text-anchor="middle" font-size="11" fill="#2b2a26">tw_sock_TCP · 232B（对齐后 ~241B）</text>
<text class="ts" x="500" y="108" text-anchor="middle" font-size="9.5" fill="#6b675e">只记四元组、序号、时间戳——inet_twsk_alloc</text>
<text class="ts" x="500" y="126" text-anchor="middle" font-size="9.5" fill="#6b675e">倒计时 60s：TCP_TIMEWAIT_LEN=60*HZ（tcp.h:140，编译期常量）</text>
<text class="ts" x="20" y="192" font-size="11" fill="#6b675e">实测：拆场后 twcnt 恰好 +n；sockstat TCP mem +1280 页 ≈ 260B/条。价钱是十六分之一，</text>
<text class="ts" x="20" y="210" font-size="11" fill="#6b675e">但它攥着一个本地端口不放——TIME_WAIT 真正贵的是端口，那是⑥的案子。</text>
</svg>
</figure>

60 秒这个数也顺手钉死：`TCP_TIMEWAIT_LEN = 60*HZ`（tcp.h:140）——**编译期常量，不是旋钮**，sysctl 里找不到它，想改只能重编内核。

## slab 页不随对象退场

还有一笔账值得单记：拆场之后，meminfo 的 Slab 并没有跌回基线——SUnreclaim 残留 +12~27MB（n 越大残留越多）。对象明明全放了，页为什么不还？因为 SLUB 的空 slab 页不是对象一走就退还给[伙伴系统](/posts/kernel-buddy-allocator/)的：partial 链表和每核缓存攥着一批空房等下一个租户，收缩器（shrinker）巡过来才清——[slab 篇](/posts/kernel-slab-slub/)讲过的那套「分配快、归还需要等」的经济学。对连接场景的启示：**连接洪峰过后，内核内存不会立刻回落**，监控上看到 Slab 高位横盘不代表泄漏，先看 shrinker 和 partial 链。

## 小结

一条空闲连接的完整价目表（7.2.3，本机实测 + BTF）：每端点四件套实测 ~3.8KB（净尺寸 3632B + slab 对齐），每连接双端 ~7.7KB；半连接的 request_sock 320B 是握手期的临时工；TIME_WAIT 换装后 232B，全价的十六分之一；空闲连接不占缓冲账；fd 表、vmalloc 另有小账。涨价的十几年大头全在 tcp_sock 一件上（1659→2496B，180 个成员）。称重方法论也留了一份：slabinfo 读不了的时代，**BTF 给尺寸、meminfo 双天平给归属、sockstat 和 /proc/net/tcp 给计数**——先算后称，两相对照。

单价有了，下一篇算总量：一台机器到底装得下多少条连接？fd 的三层金字塔、客户端 65535 的迷思、端口耗尽时 connect 的 CPU 爆炸——百万连接篇见。

## 我踩的坑

**slabinfo 读不了不是死路，BTF 是无 root 时代的第二把尺。** /proc/slabinfo 和 /sys/kernel/slab 的属性文件全是 root 专属，差点把这篇写成「纯源码推算」。翻权限时撞见 /sys/kernel/btf/vmlinux 是 0444——bpftool 一条命令导出全内核结构体的精确尺寸，比抄任何博客的数字都硬。但两把尺口径不同：BTF 给的是纯 struct 尺寸，slab 对齐（每 slab 装几件、摊到每件多少）要自己算，差了 5~15%；拿 BTF 尺寸直接对着 meminfo 增量喊「对不上」，是自己漏了中间那步。

**小样本被背景池咬了 18%。** n=2000 那轮 SReclaimable 每端点只有 737B，比预测低一大截——不是账错了，是桌面系统常年攒的 dentry partial slab 里有空位，四千个新对象先住空房，没触发几个新页。n≥20000 才收敛到预测附近。在跑着业务的机器上做称重实验，样本量必须压过背景池，不然称出来的是「背景池的空位数」。

**TIME_WAIT 的残留账，meminfo 算不清。** 想从拆场后的 SUnreclaim 残留反推 tw 单价：两轮反推出 630~920B/条，跟对象尺寸 232B 差着三四倍——残留里混着没归还的 est 阶段 partial slab 页，还混着前几轮实验 60 秒窗口内没死透的背景 TW（跑一轮积一批）。这笔账要 per-cache 计数才能算清，那需要 root——如实留白，改用 sockstat 的 mem 栏（260B/条）做旁证。账算不干净的时候，宁可换一本账，不可硬凑。

**端口算术先于内存算术。** 6 万条连接要是只对一个监听端口发起，先撞上的不是内存墙，是 ephemeral 端口上限（本机 32768~60999，共 28232 个）——四元组里源端口先耗尽。connmem 加了 -L 参数分四个监听口才跑通 60000。这是⑥「一台机器多少条连接」的头一道算术题，在⑤的量具里就先撞上了。

**BTF 里两代结构体并存，认错名字对照全歪。** sock_inode_cache 的对象尺寸，BTF 报 `socket_alloc` 704B——和老资料的 0.69K「分毫不差」，差点就此收工。多看一眼：还有个 `sockfs_inode` 768B，而缓存创建处（socket.c:374）sizeof 的是**后者**——704 是留在 BTF 里的旧款类型，768 才是现役。对照数字过于漂亮的时候要警惕：先回源码确认「缓存到底铸的哪个 struct」，再谈分毫不差。
