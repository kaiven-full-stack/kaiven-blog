---
title: NET_TX 只出勤了 25 次：硬中断、软中断与 NAPI
description: 开机 3 小时账本就偏科：NET_TX 全部 12 核合计出勤 25 次，NET_RX 出勤 119 万次，一比四万七，其中 86% 挤在被单队列 WiFi 卡中断线钉住的 cpu10 上。收包全程在本机 7.2.3 读通并量通：rtw88 的硬中断上半部只干两件事——关中断、IRQ_WAKE_THREAD（pci.c:1153），真活儿在 irq/85 内核线程里，见到 IMR_ROK 才 napi_schedule（:1021）；RingBuffer 本机真实存在——512 个描述符 × 11478 字节预分配 skb、wp/rp 双指针（pci.h:13/176），指针数组预分配、skb 随收随补，老资料拿 igb 讲的结论在 rtw88 上原样成立。/proc/softirqs 数的是出勤不是包：handle_softirqs 每执行一个 action 记一次数（softirq.c:619），出勤可以空跑。lo 上一包一出勤、洪泛也不批处理：__dev_queue_xmit 的 rcu_read_lock_bh（dev.c:4796）让软中断在同一个系统调用收尾的 local_bh_enable（:302）就地清算，队列里永远只有一个包；ksoftirqd 全部 12 线程 3 小时累计出工 119ms，6.2 万包实验期间 schedstat 纹丝不动（58532→58532）——软中断服务时间记进 /proc/stat 的全局 si 账（cpu0 +5ms），不记在任何任务名下；出场条件只有 2ms/10 轮上限（softirq.c:543-544）或 RT 内核，拿竞争进程强制也没逼出来。WiFi 三级账本实测折损：ping 400 发 → irq85 +1660 → NET_RX +1203 → processed +435 ≈ rx_packets +434，中断里混着发送完成与 beacon，管理帧在 mac80211 内消化不进 IP 栈（processed 计数点 dev.c:6020）。丢包四道闸四本账：网卡环（ethtool rx_dropped 现役 131）、backlog（softnet_stat 第 2 列，本机 0，缩旋钮要 root 如实标注）、socket 接收队列（rcvdrop 实测：缓冲缩到 4608 字节，发 5 万存活 4，RcvbufErrors、InErrors、/proc/net/udp drops 三本账全是 49996，两轮全同——记的是 truesize 不是载荷）、TCP 不丢改缩窗口。time_squeeze 全机现役 2 次——3 小时里 NAPI 超预算恰好两次。NET_TX 全内核只有三处 raise（qdisc 重启 dev.c:3391、硬中断上下文释放 skb :3460、CPU 热插拔 :12762），发包不过它的门，本机 lo/wlan0 根 qdisc 均为 noqueue 实测。net.core.threaded 全局旋钮在 7.2 已消失，只剩每设备 /sys 开关（本机全 0）；CachyOS 把 netdev_max_backlog 从默认 1000（hotdata.c:19）抬到 4096（70-cachyos-settings.conf:43）。实测于本机 Linux 7.2.3（CachyOS）、gcc 16.2.1，内核源码对照 vanilla v7.2；量具四件存档 ~/net-lab，无 root 可复现；无有线网卡、无第二台机器，高 pps 批处理与跨机路径按源码口径如实标注。Linux 网络系列开篇。
pubDate: 2026-09-28
category: network
tags: [Linux, 网络, 内核]
---

开机两个半小时，`/proc/softirqs` 的账本已经严重偏科：

```
                CPU0     CPU1    ...    CPU10     合计
NET_TX:            0        1    ...        8       25
NET_RX:         5582     1535    ...  1028078  1188999
```

NET_RX 出勤 119 万次，NET_TX 只有 25 次——一比四万七千。而且 NET_RX 的 86% 挤在 cpu10 一个核上：这台机器唯一的真网卡是块单队列 WiFi 卡，中断线钉死在 cpu10，收包的软中断就全在这一核打转。

3.10 时代的老资料早注意过这对兄弟的悬殊，用词是「大得多的多」，还记过一个读者疑问：send 发一句 Hello World 出去，NET_TX 居然不涨。这篇把收包全程在本机 7.2.3 上重新走一遍：每一站谁干活、活记在哪本账上、包死在哪道闸。先剧透两个数：v7.2 全内核 raise NET_TX 的地方只有三处，发包根本不过它的门；而 NET_RX 出勤两百多万次的同一台机器上，兜底的 ksoftirqd 线程累计只干了 119 毫秒的活。

实验环境：本机 Linux 7.2.3-1-cachyos（AMD Ryzen 5 5500U，6 核 12 线程，L3 两域），内核源码对照 vanilla v7.2。网卡只有 wlan0（RTL8821CE，rtw88 驱动，单 RX/TX 队列，单条 MSI 中断 irq85）和 lo；没有有线口，也没有第二台机器——涉及真网卡高流量、跨机路径的部分按源码口径讲，如实标注。量具在 `~/net-lab`：softsnap.py（六本账快照差分）、lotok.c（锁步令牌）、udpflood.c（洪泛）、rcvdrop.c（队列溢出），全部无 root 可跑。桌面不安静（Docker 和浏览器常驻），全文数字都是前后差分。

## 全景：一个包的七站

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 350" role="img" aria-label="收包全景七站：网卡 DMA 写 RingBuffer，硬中断举手，irq 线程分发，NET_RX 软中断按 budget 收包，协议栈分发，socket 接收队列，唤醒进程；每站标注账本位置；lo 本机流量跳过前三站直接进软中断" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netRXa1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">收包流水线：七站，每站一本账</text>
<rect class="bx" x="20" y="40" width="145" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="92" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">① 网卡 + DMA</text>
<text class="ts" x="92" y="77" text-anchor="middle" font-size="9.5" fill="#6b675e">把包写进 RingBuffer</text>
<text class="tc" x="92" y="94" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：ethtool -S</text>
<line class="fl" x1="165" y1="71" x2="181" y2="71" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa1)"/>
<rect class="bx" x="185" y="40" width="145" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="257" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">② 硬中断 irq85</text>
<text class="ts" x="257" y="77" text-anchor="middle" font-size="9.5" fill="#6b675e">只举手：关中断+醒线程</text>
<text class="tc" x="257" y="94" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：/proc/interrupts</text>
<line class="fl" x1="330" y1="71" x2="346" y2="71" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa1)"/>
<rect class="bx" x="350" y="40" width="145" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="422" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">③ irq/85 线程</text>
<text class="ts" x="422" y="77" text-anchor="middle" font-size="9.5" fill="#6b675e">读状态位，napi_schedule</text>
<text class="tc" x="422" y="94" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：线程 stime</text>
<line class="fl" x1="495" y1="71" x2="511" y2="71" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa1)"/>
<rect class="bx-q" x="515" y="40" width="130" height="62" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="580" y="60" text-anchor="middle" font-size="11.5" fill="#2b2a26">④ NET_RX 软中断</text>
<text class="ts" x="580" y="77" text-anchor="middle" font-size="9.5" fill="#6b675e">NAPI：budget 300/2ms</text>
<text class="tc" x="580" y="94" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：softirqs+softnet</text>
<path class="fl" d="M 580 102 L 580 130 L 92 130 L 92 158" fill="none" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa1)"/>
<rect class="bx" x="20" y="162" width="145" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="92" y="182" text-anchor="middle" font-size="11.5" fill="#2b2a26">⑤ 协议栈分发</text>
<text class="ts" x="92" y="199" text-anchor="middle" font-size="9.5" fill="#6b675e">ip_rcv → udp/tcp_v4_rcv</text>
<text class="tc" x="92" y="216" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：processed 列</text>
<line class="fl" x1="165" y1="193" x2="181" y2="193" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa1)"/>
<rect class="bx" x="185" y="162" width="145" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="257" y="182" text-anchor="middle" font-size="11.5" fill="#2b2a26">⑥ socket 接收队列</text>
<text class="ts" x="257" y="199" text-anchor="middle" font-size="9.5" fill="#6b675e">满了当场丢，有账</text>
<text class="tc" x="257" y="216" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：snmp+net/udp</text>
<line class="fl" x1="330" y1="193" x2="346" y2="193" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa1)"/>
<rect class="bx" x="350" y="162" width="145" height="62" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="422" y="182" text-anchor="middle" font-size="11.5" fill="#2b2a26">⑦ 唤醒进程</text>
<text class="ts" x="422" y="199" text-anchor="middle" font-size="9.5" fill="#6b675e">sync 唤醒，交给调度器</text>
<text class="tc" x="422" y="216" text-anchor="middle" font-size="9.5" fill="#b03a2e">账：vol/invol 切换</text>
<rect class="bx-q" x="515" y="162" width="130" height="62" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="580" y="182" text-anchor="middle" font-size="11" fill="#2b2a26">lo 近道</text>
<text class="ts" x="580" y="199" text-anchor="middle" font-size="9.5" fill="#6b675e">发送方系统调用直塞</text>
<text class="ts" x="580" y="214" text-anchor="middle" font-size="9.5" fill="#6b675e">backlog，跳过①②③</text>
<text class="ts" x="20" y="256" font-size="11" fill="#6b675e">开机点卯：net_dev_init（dev.c:13240）给 NET_TX/NET_RX 登记 action（:13317-8），</text>
<text class="ts" x="20" y="274" font-size="11" fill="#6b675e">每核发一个 backlog 伪 NAPI（poll=process_backlog，:13285）；ksoftirqd 由 spawn_ksoftirqd</text>
<text class="ts" x="20" y="292" font-size="11" fill="#6b675e">（softirq.c:1165）在 early_initcall 登记——十二个内核线程，mm=NULL 的那批</text>
<text class="ts" x="20" y="318" font-size="11" fill="#6b675e">本机现实：单队列 WiFi，①→④ 全钉在 cpu10；软中断共 10 个向量（interrupt.h:550），网络占两个</text>
</svg>
</figure>

值班的名单是开机就排好的：`net_dev_init`（dev.c:13240）里 `open_softirq` 给 NET_TX、NET_RX 登记处理函数（:13317-13318），每个核还领到一个叫 backlog 的伪 NAPI（`poll = process_backlog`，:13285）——lo、veth 这类没有硬件队列的设备全靠它。兜底线程 ksoftirqd 更早，`spawn_ksoftirqd`（softirq.c:1165）在 early_initcall 就注册了十二个——它们是内核线程，[出生篇](/posts/kernel-task-birth/)里数过的那四百五十多个 mm=NULL 的同伙。

## RingBuffer：本机就有实物

老资料讲收包都从网卡的 RingBuffer 讲起，拿 Intel igb 举例。这台机器没有有线网卡，但 RingBuffer 不用靠想象——wlan0 的 rtw88 驱动里就有一个，结构一眼能认出来：

```c
// drivers/net/wireless/realtek/rtw88/pci.h:176
struct rtw_pci_ring {
	u8 *head;          // 描述符环，dma_alloc_coherent 分配
	dma_addr_t dma;
	u8 desc_size;
	u32 len;           // 512 格（RTK_MAX_RX_DESC_NUM，pci.h:13）
	u32 wp;            // 写指针：硬件 DMA 进包后推进
	u32 rp;            // 读指针：驱动消费后推进
};
```

初始化时一口气备好全部家当：描述符环一块 DMA 一致性内存（dma_alloc_coherent，pci.c:266），512 个 skb 在 for 循环里逐个 `dev_alloc_skb`（:274）、`dma_map_single(DMA_FROM_DEVICE)`（:222）挂上去。每个缓冲 11478 字节（RTK_PCI_RX_BUF_SIZE = 11454+24，pci.h:15）——比以太网 MTU 大七倍半，因为 WiFi 一张聚合帧能塞下好几个包。工作起来：硬件收包 DMA 进缓冲、推 wp；驱动的 NAPI 从 rp 追上去消费，每消费一个就补一个新 skb 重新挂环（`rtw_pci_rx_napi`，pci.c:1042，补货在 :1089），包本身经 `ieee80211_rx_napi`（:1105）交给 mac80211。

老资料拿 igb 总结的那句「指针数组是预先分配好的，skb 随收包动态补充」，在 rtw88 上原样成立。环满硬件写不进去就丢，账在驱动统计里：`ethtool -S wlan0` 的 rx_dropped 现役 131（顺带 rx_duplicates 也是 131——无线环境的重传帧）。`ethtool -g wlan0` 倒是一路 n/a：rtw88 没实现 get_ringparam，环的长度只能从源码读，这算无 root 之外的第二个口径边界。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 250" role="img" aria-label="rtw88 接收环结构：512 格描述符环，每格挂一个预分配的 11478 字节 skb 并已 DMA 映射；硬件收包 DMA 写入并推进写指针 wp，驱动 NAPI 从读指针 rp 消费、每消费一格补一个新 skb 重新挂环；环满硬件写不进则丢包，记账在 ethtool rx_dropped" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netRXa4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">rtw88 的接收环（pci.h:176）：512 格，wp 在前面写，rp 在后面追</text>
<text class="ts" x="70" y="52" font-size="10" fill="#6b675e">skb 缓冲（每格 11478B，开机预分配 + dma_map_single）</text>
<g>
<rect class="bx" x="70" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="132" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="194" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="256" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="318" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="380" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="442" y="60" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx-q" x="504" y="60" width="56" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<text class="ts" x="532" y="81" text-anchor="middle" font-size="9.5" fill="#2b2a26">新包</text>
</g>
<text class="ts" x="576" y="81" font-size="12" fill="#6b675e">…</text>
<text class="ts" x="40" y="81" font-size="12" fill="#6b675e">…</text>
<g>
<rect class="bx-q" x="70" y="112" width="56" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.3"/>
<rect class="bx" x="132" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="194" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="256" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="318" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="380" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="442" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<rect class="bx" x="504" y="112" width="56" height="34" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
</g>
<text class="ts" x="70" y="108" font-size="10" fill="#6b675e">描述符环（dma_alloc_coherent，len=512）</text>
<text class="t" x="98" y="133" text-anchor="middle" font-size="10" fill="#2b2a26">rp</text>
<text class="t" x="532" y="133" text-anchor="middle" font-size="10" fill="#2b2a26">wp</text>
<line class="fl" x1="60" y1="160" x2="180" y2="160" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa4)"/>
<text class="ts" x="60" y="176" font-size="9.5" fill="#6b675e">NAPI 从 rp 消费（poll，weight 64）</text>
<line class="flk" x1="440" y1="160" x2="560" y2="160" stroke="#2b2a26" stroke-width="1.5" marker-end="url(#netRXa4)"/>
<text class="ts" x="440" y="176" font-size="9.5" fill="#6b675e">硬件 DMA 写入，推进 wp（irq85 举手）</text>
<path class="fl" d="M 98 112 L 98 100 L 40 100 L 40 208 L 300 208" fill="none" stroke="#6b675e" stroke-width="1.3" marker-end="url(#netRXa4)"/>
<rect class="bx" x="304" y="190" width="290" height="40" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="449" y="207" text-anchor="middle" font-size="9.5" fill="#6b675e">消费一格 → 补一个新 skb 重新挂环</text>
<text class="ts" x="449" y="222" text-anchor="middle" font-size="9.5" fill="#6b675e">dev_alloc_skb（pci.c:274/:1089）+ 重新 dma_map</text>
<text class="tc" x="20" y="244" font-size="10.5" fill="#b03a2e">环满追不上 → 硬件丢包，账在 ethtool -S rx_dropped（本机现役 131）</text>
</svg>
</figure>

## 硬中断：只举一次手

irq85 是 wlan0 的 MSI 中断线，开机以来 159 万次，全部记在 cpu10——单队列卡就这一条线，落在哪个核，哪个核就把收包的活全包了。它的上半部短得惊人：

```c
// drivers/net/wireless/realtek/rtw88/pci.c:1153
static irqreturn_t rtw_pci_interrupt_handler(int irq, void *dev)
{
	rtw_pci_disable_interrupt(rtwdev, rtwpci);  // 先关门，防重入
	return IRQ_WAKE_THREAD;                     // 叫醒线程，完事
}
```

两件事：关中断、返回 IRQ_WAKE_THREAD。驱动自己选了线程化中断（`devm_request_threaded_irq`，:1642；本机 cmdline 没有 threadirqs，不是内核强制的），真正读状态、分派活计的是 `irq/85-rtw88_pc` 这个内核线程（threadfn，:1171）：六个发送完成队列各归各的 tx isr，收到包（状态位 IMR_ROK）才走 `rtw_pci_rx_isr`（:1017）→ `napi_schedule`（:1021）。这个线程三小时累计 stime 3.2 秒——159 万次召唤，平均每次 2µs，名副其实的传达室。

于是本机的收包比教科书图多一级：**硬中断（举手）→ 中断线程（分派）→ 软中断（干活）**。硬中断上下文金贵，谁都待不久；重活一律往后递。

## 软中断：出勤和干活是两本账

`napi_schedule` 最终落到 `____napi_schedule`（dev.c:4965）：把 NAPI 挂上本核的 poll_list，然后 `raise_softirq_irqoff(NET_RX_SOFTIRQ)`（:4998）。raise 这个词容易想重了——它只是置一个位：`or_softirq_pending(1UL << nr)`（softirq.c:802），每核一张 pending 位图，十个向量一人一位。

位什么时候变成干活？三个现场，殊途同归到 `handle_softirqs`（softirq.c:579）：

1. **硬中断出口关卡**：`__irq_exit_rcu`（:720）发现不在中断里且有 pending → `invoke_softirq`（:487，非 RT 内核当场 `__do_softirq`）——真网卡的包多半在这里被处理，借的是被打断者（常常是 idle）的上下文；
2. **local_bh_enable**（:302）：关了下半部的代码段收尾时当场清算——lo 的发送路径走的就是这个门，后面细说；
3. **ksoftirqd 线程**（`run_ksoftirqd`，:1068）：门卫条件一行——`local_softirq_pending()`（:1064）。

`handle_softirqs` 用 ffs 扫位图，每个 action 执行前先 `kstat_incr_softirqs_this_cpu`（:619）——**/proc/softirqs 的计数点就在这：一次调用记一次出勤，处理了几个包不管，一个没处理也记**。这就是「出勤」和「干活」的分家。循环带两道闸：2ms 时间上限（MAX_SOFTIRQ_TIME，:543）和 10 轮重启上限（MAX_SOFTIRQ_RESTART，:544）；到点还有新活，`wakeup_softirqd`（:75）把剩下的移交给线程。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 320" role="img" aria-label="软中断从 raise 到执行：or_softirq_pending 置位图一位，三个执行现场（硬中断出口、local_bh_enable、ksoftirqd 门卫）都汇入 handle_softirqs，ffs 扫位图逐个执行 action 并计数，2ms 或 10 轮上限未完则 wakeup_softirqd 移交线程" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netRXa2" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">raise 只是置位，干活看三个现场的心情</text>
<rect class="bx-q" x="20" y="40" width="180" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="110" y="62" text-anchor="middle" font-size="11.5" fill="#2b2a26">raise_softirq_irqoff</text>
<text class="ts" x="110" y="80" text-anchor="middle" font-size="9.5" fill="#6b675e">or_softirq_pending（:799）</text>
<text class="ts" x="110" y="96" text-anchor="middle" font-size="9.5" fill="#6b675e">每核位图，10 向量各 1 位</text>
<line class="fl" x1="200" y1="60" x2="246" y2="60" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<line class="fl" x1="200" y1="78" x2="246" y2="138" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<line class="fl" x1="200" y1="96" x2="246" y2="216" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<rect class="bx" x="250" y="36" width="200" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="350" y="56" text-anchor="middle" font-size="11" fill="#2b2a26">① 硬中断出口</text>
<text class="ts" x="350" y="74" text-anchor="middle" font-size="9.5" fill="#6b675e">__irq_exit_rcu(:720)→invoke(:487)</text>
<rect class="bx" x="250" y="114" width="200" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="350" y="134" text-anchor="middle" font-size="11" fill="#2b2a26">② local_bh_enable(:302)</text>
<text class="ts" x="350" y="152" text-anchor="middle" font-size="9.5" fill="#6b675e">lo 发送在系统调用收尾清算</text>
<rect class="bx" x="250" y="192" width="200" height="48" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="350" y="212" text-anchor="middle" font-size="11" fill="#2b2a26">③ ksoftirqd 门卫</text>
<text class="ts" x="350" y="230" text-anchor="middle" font-size="9.5" fill="#6b675e">run_ksoftirqd(:1068)，有 pending 才跑</text>
<line class="fl" x1="450" y1="60" x2="486" y2="120" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<line class="fl" x1="450" y1="138" x2="486" y2="138" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<line class="fl" x1="450" y1="216" x2="486" y2="156" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<rect class="bx-q" x="490" y="100" width="150" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="565" y="122" text-anchor="middle" font-size="11.5" fill="#2b2a26">handle_softirqs(:579)</text>
<text class="ts" x="565" y="140" text-anchor="middle" font-size="9.5" fill="#6b675e">ffs 扫位图 → 每 action 前</text>
<text class="ts" x="565" y="156" text-anchor="middle" font-size="9.5" fill="#6b675e">kstat_incr(:619)=出勤+1</text>
<path class="fl" d="M 565 176 L 565 250 L 350 250" fill="none" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa2)"/>
<rect class="bx" x="130" y="234" width="220" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="240" y="252" text-anchor="middle" font-size="9.5" fill="#6b675e">还有活且 &lt;2ms 且 &lt;10 轮 → 重来</text>
<text class="ts" x="240" y="268" text-anchor="middle" font-size="9.5" fill="#6b675e">超限 → wakeup_softirqd(:75) 移交③</text>
<text class="ts" x="20" y="304" font-size="11" fill="#6b675e">本机实测：6.2 万包期间 ksoftirqd/0 schedstat 58532→58532；软中断时间记 /proc/stat 全局 si 列（cpu0 +5ms），不进任务账</text>
</svg>
</figure>

## NAPI：节拍器

NET_RX 的 action 是 `net_rx_action`（dev.c:7920），开工先领两份预算：包数 budget = netdev_budget（默认 300，hotdata.c:14），时间 netdev_budget_usecs（默认 2000µs，HZ=1000 时恰好 2 个 jiffy，hotdata.c:16）。然后循环从 poll_list 摘 NAPI 调 `napi_poll`（:7792）收工，每个 NAPI 一轮最多干 weight 个包——rtw88 用 `netif_napi_add` 的默认值 NAPI_POLL_WEIGHT=64（netdevice.h:2870），backlog 伪 NAPI 领 dev_rx_weight=64（dev.c:6672）。预算烧完活还没干完：`time_squeeze` 加一、剩下的挂回 poll_list、重新 raise NET_RX（:7979）——下一轮多半就轮到 ksoftirqd 出场了。

顺带一个旋钮变迁：5.12 时代加入的全局 `net.core.threaded`（把 NAPI 整体线程化的开关）在 7.2 的 sysctl 表里已经消失，只剩每设备的 `/sys/class/net/*/threaded`——本机 wlan0 和 lo 都是 0，NAPI 不线程化。rtw88 的线程化发生在更靠前的中断层，而且是驱动自选的。

成绩单在 `/proc/net/softnet_stat`，v7.2 一行 15 列（softnet_seq_show，net-procfs.c:123）：第 1 列 processed——计数点在 `__netif_receive_skb_core` 开头（dev.c:6020），只有真正进入协议栈分发函数的包才记；第 2 列 drops（backlog 满）；第 3 列 time_squeeze；第 10 列 received_rps；第 12 列当前 backlog 长度；第 13 列是这行属于哪个 CPU；14、15 列再把 backlog 拆成 input/process 两条队列。本机三小时：processed 合计 203 万，drops **0**，time_squeeze **2**——NAPI 超预算这件事，三小时里恰好发生过两次。生产机上这一列要是持续上涨，才是该动 budget 或者上多队列的信号。

## 实验：一包一出勤

第一组用锁步令牌（lotok，收支守恒纪律同[切换篇](/posts/kernel-context-switch/)的量具）：UDP，客户端钉 cpu0、服务端钉 cpu1，五万轮加两千轮预热，每轮一来一回。softsnap 前后差分：

| 账本 | cpu0 | cpu1 | 备注 |
|---|---|---|---|
| NET_RX 出勤 | +52000 | +52000 | =50000+2000 预热，一个不多一个不少，落在发送方核上 |
| processed | +52000 | +52000 | 全部进了协议栈分发 |
| NET_TX | +0 | +0 | 十万包发送，一次没出勤 |
| ksoftirqd schedstat | 不动 | 不动 | 全程没被唤醒 |

RTT 平均 12.3µs（两轮 12.64/12.30）。TCP 锁步对照组同一本账：NET_RX 52003/52001，RTT 13.98µs——多出的几个包是建连拆连，有连接的簿记每轮再贵 1.7µs。顺带记一笔：[切换篇](/posts/kernel-context-switch/)量过管道令牌往返 3.5µs——同样一次往返，包比管道令牌贵出两倍半，贵在哪，留给发送篇和本机 IO 篇拆账。

第二组不限速洪泛（udpflood，20 万包钉 cpu2 发、cpu3 收，21 万 pps）：NET_RX cpu2 **+200001**——洪泛之下一包一出勤依旧，没有批处理。为什么？lo 的软中断出勤点就在发送方的系统调用里：`__dev_queue_xmit` 进门就关下半部（`rcu_read_lock_bh`，dev.c:4796，注释原话「Disable soft irqs」），`loopback_xmit`（loopback.c:70）把 skb 与原 socket 脱钩（skb_orphan，:80）后直接 `__netif_rx`（:90）→ `enqueue_to_backlog`（:5381）挂进本核 input_pkt_queue 并置位 NET_RX；系统调用收尾 `local_bh_enable` 当场清算（softirq.c:302）。下一个包进来时队列早就空了——**批处理要「包堆得比干得快」才出现，而 lo 的干和发在同一个系统调用里，永远堆不起来**。真网卡的 NAPI 从 DMA 环一次拉一批（weight 64）才是批处理的主场；本机 WiFi 实测只有 ~12Mbps，聚合拉不满，这篇就不硬造批处理比数据了（RPS 跨核投递会造出另一个批处理窗口，多队列篇再量）。

ksoftirqd 的决定性对照单独跑了一轮：6.2 万包期间，ksoftirqd/0 的 schedstat 调度计数 58532→58532、voluntary_ctxt_switches 58504→58504——一次都没被唤醒；同一窗口 `/proc/stat` 的 cpu0 si 列 +5ms、cpu1 +6ms。**软中断的服务时间记在全局 si 账上，不记在任何任务的 utime/stime 名下**——活干了，在发送方系统调用的上下文里干的。放大到全机：NET_RX 出勤 250 万次，十二个 ksoftirqd 三小时累计出工 119ms。

不死心，还强制了一把：cpu2 上钉一个忙循环竞争进程再洪泛 30 万包——ksoftirqd/2 依旧零出勤。一包一 pending、当场消化，2ms/10 轮的上限根本碰不到；副作用倒是量到两个：洪泛速率对半砍（0.94s→2.35s，[EEVDF](/posts/kernel-scheduler-eevdf/) 把核分了一半给竞争者），以及顺手丢的 604 个包——全死在 socket 队列那道闸，账在下面。

## WiFi 的三级账本

真网卡组：ping 网关 400 发、curl 下载 8 秒（单流与四流各一轮），cpu10 上三本账的折损：

| 窗口 | irq85 | NET_RX 出勤 | processed | wlan0.rx_packets |
|---|---|---|---|---|
| ping ×400（4.1s） | +1660 | +1203 | +435 | +434 |
| curl 单流（4.3MB） | +7238 | +5467 | +4280 | +4058 |
| curl 四流（12MB） | +17762 | +13410 | +11696 | +11218 |

三级各数各的：**中断**里混着发送完成、beacon、固件消息——400 个来回敲出 1660 次；**出勤**可以空跑——pending 置了位，执行时 poll_list 已被上一轮清空；**processed** 只数进了 IP 栈的包——WiFi 的 beacon 和管理帧在 mac80211 里就消化掉了，根本不进这本账（rtw88 交包走 ieee80211_rx_napi，pci.c:1105）。cpu10 开机以来 125 万次出勤对 53 万 processed，一半多是空跑加管理帧。驱动层还有一本更靠前的账：ethtool 的 rx_packets（ping 窗口 +512）比 netdev 层（+434）多出 78——驱动收进来的和交上去的不是一回事，中间隔着重复帧（rx_duplicates 同窗 +1）、过滤掉的帧，和两次读表之间挤进来的背景流量。

这就是老资料绪论里「单队列机器 si 全打在一个核」的完整机制：单队列 → 单中断线 → NAPI 软中断全落 cpu10（该核 si 时间累计 7.9 秒、硬中断 6.6 秒）。药方——RSS 多队列、RPS——是多队列篇的正题。

再澄清一个数：ping RTT min 0.96ms / avg 11.5ms / max 36ms，十倍差距不是网络抖，是 WiFi 省电在拉长尾巴（rtw88 的 poll 函数首尾就是一对 link_ps 电源开关，pci.c:1660）。无线卡上量延迟，先分离省电再谈网络。

## 丢包去哪了：四道闸，四本账

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 300" role="img" aria-label="丢包四道闸：网卡环满记 ethtool rx_dropped，backlog 满记 softnet_stat 第 2 列，socket 接收队列满记 snmp RcvbufErrors 与 proc net udp drops 列（实测发五万存活四，三本账同为 49996），TCP 不丢包改缩窗口" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="netRXa3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="22" font-size="12" fill="#6b675e">一个包的四道闸：每道闸都有自己的账本</text>
<rect class="bx" x="20" y="42" width="90" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="65" y="68" text-anchor="middle" font-size="11" fill="#2b2a26">包进来</text>
<line class="fl" x1="110" y1="64" x2="126" y2="64" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa3)"/>
<rect class="bx-sick" x="130" y="42" width="120" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="190" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">闸① 网卡环满</text>
<text class="ts" x="190" y="77" text-anchor="middle" font-size="9" fill="#6b675e">硬件写不进</text>
<line class="fl" x1="250" y1="64" x2="266" y2="64" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa3)"/>
<rect class="bx-sick" x="270" y="42" width="120" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="330" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">闸② backlog 满</text>
<text class="ts" x="330" y="77" text-anchor="middle" font-size="9" fill="#6b675e">qlen &gt; 4096</text>
<line class="fl" x1="390" y1="64" x2="406" y2="64" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa3)"/>
<rect class="bx-sick" x="410" y="42" width="120" height="44" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="t" x="470" y="60" text-anchor="middle" font-size="10.5" fill="#2b2a26">闸③ socket 队满</text>
<text class="ts" x="470" y="77" text-anchor="middle" font-size="9" fill="#6b675e">rmem+size&gt;rcvbuf</text>
<line class="fl" x1="530" y1="64" x2="546" y2="64" stroke="#6b675e" stroke-width="1.5" marker-end="url(#netRXa3)"/>
<rect class="bx" x="550" y="42" width="90" height="44" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="595" y="62" text-anchor="middle" font-size="10.5" fill="#2b2a26">收下</text>
<text class="ts" x="595" y="78" text-anchor="middle" font-size="9" fill="#6b675e">唤醒进程</text>
<rect class="bx" x="130" y="106" width="120" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="190" y="124" text-anchor="middle" font-size="9.5" fill="#6b675e">账：ethtool -S</text>
<text class="ts" x="190" y="140" text-anchor="middle" font-size="9.5" fill="#6b675e">rx_dropped 现役 131</text>
<text class="ts" x="190" y="156" text-anchor="middle" font-size="9.5" fill="#6b675e">（本机无力强制，标注）</text>
<rect class="bx" x="270" y="106" width="120" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="330" y="124" text-anchor="middle" font-size="9.5" fill="#6b675e">账：softnet_stat 列2</text>
<text class="tc" x="330" y="140" text-anchor="middle" font-size="9.5" fill="#b03a2e">本机现役 0</text>
<text class="ts" x="330" y="156" text-anchor="middle" font-size="9.5" fill="#6b675e">（缩旋钮要 root）</text>
<rect class="bx" x="410" y="106" width="120" height="56" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="470" y="124" text-anchor="middle" font-size="9.5" fill="#6b675e">账：snmp RcvbufErrors</text>
<text class="ts" x="470" y="140" text-anchor="middle" font-size="9.5" fill="#6b675e">+ InErrors + drops 列</text>
<text class="tc" x="470" y="156" text-anchor="middle" font-size="9.5" fill="#b03a2e">实测 49996 三账全同</text>
<rect class="bx-q" x="130" y="192" width="400" height="62" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="330" y="214" text-anchor="middle" font-size="11" fill="#2b2a26">闸③ 实测（rcvdrop，两轮全同）：缓冲缩到 4608B，发 50000×64B，存活 4 个</text>
<text class="ts" x="330" y="232" text-anchor="middle" font-size="9.5" fill="#6b675e">记的是 skb truesize（~1.1KB）不是载荷——4608÷1152=4；判满在 __udp_enqueue_schedule_skb(:1655)</text>
<text class="ts" x="330" y="247" text-anchor="middle" font-size="9.5" fill="#6b675e">记账三处：udp.c:2307 的 RCVBUFERRORS+INERRORS（注释：charged twice）、/proc/net/udp drops 列（udp.h:305 NUMA 分账）</text>
<text class="ts" x="20" y="284" font-size="11" fill="#6b675e">闸④ TCP 不在这里丢：接收队列将满时把通告窗口缩成 0，让发送方停下——流控的账，另篇再算</text>
</svg>
</figure>

从网卡到 socket，一个包可能死在四道闸：

**闸一，网卡环满**：硬件写不进，当场丢，账在驱动统计（ethtool -S）。要逼它发生得让流量超过「中断+轮询」的消费速度，本机 WiFi 无能为力——标注：未强制实测。

**闸二，backlog 队列满**：`enqueue_to_backlog` 检查 `qlen > net_hotdata.max_backlog`（dev.c:5396）——本机这个旋钮被 CachyOS 抬到 4096（vanilla 默认 1000，hotdata.c:19；出处 /usr/lib/sysctl.d/70-cachyos-settings.conf:43，POC 选核引擎的同一个发行版，连网络 backlog 都顺手调过）。超了就 SKB_DROP_REASON_CPU_BACKLOG（:5427），记进 softnet_stat 第 2 列（v7.2 的丢包记账也 NUMA 化了，numa_drop_add :5428）。本机现役 drops=0；它是全局旋钮，缩它要 root——同样如实标注，没硬测。

**闸三，socket 接收队列满**：唯一无 root 能逼出来的闸，rcvdrop 量具实测。把 SO_RCVBUF 缩到生效 4608 字节（设 2304，内核翻倍），对自己洪泛 50000 个 64B UDP 包：**存活 4 个**。三本账分毫不差——/proc/net/snmp 的 RcvbufErrors +49996、InErrors +49996（记账点 `__udp_queue_rcv_skb`，udp.c:2307，源码注释原话「an ENOMEM error is charged twice」，所以两栏同涨）、/proc/net/udp 本 socket 的 drops 列 +49996（per-socket 账本，v7.2 里也 NUMA 分账再懒聚合，udp.h:305）。两轮实验，六个数字全同。存活为什么恰好是 4：判满记的不是 64 字节载荷，是 skb->truesize（约 1.1KB，`__udp_enqueue_schedule_skb` :1655 起，rmem+size>rcvbuf 即 drop :1784）——4608 除以 1152，正好 4 个。判满还有个豁免：队列全空时放一个进来，哪怕它超尺寸。

**闸四，TCP 不过这道闸**：接收队列将满时它不丢包，把通告窗口缩成 0，把问题推回发送方——那是流控的账，另篇再算。

前面实验里顺手丢的包都对得上号：E1b 第一轮 205 个、第二轮 0 个、竞争组 604 个——全死在闸三，当轮 snmp 的 RcvbufErrors 增量一一相符。

## 终点：入队，然后叫醒谁

包过了四道闸，`__udp_enqueue_schedule_skb` 把它挂上 sk_receive_queue，然后调 `sk->sk_data_ready`——默认实现 `sock_def_readable`（sock.c:3649）：

```c
wake_up_interruptible_sync_poll(&wq->wait, EPOLLIN | EPOLLPRI | EPOLLRDNORM | EPOLLRDBAND);
```

sync 的意思是唤醒但别当场抢占；至于把等待者唤到哪个核、什么时候真正切过去——那是[挑座位](/posts/kernel-cpu-selection/)和[切换](/posts/kernel-context-switch/)两篇的地盘。收包路径到这里交棒，剩下的是调度器的事。TCP 的对应入口是 tcp_v4_rcv（tcp_ipv4.c:2070），IP 层分发在 ip_rcv（ip_input.c:603），UDP 在 udp_rcv（udp.c:2588）——`__netif_receive_skb_core`（dev.c:5986）按包类型逐层递进去。TCP 还多一层口袋：socket 被用户进程持锁时，包先进 sk_backlog（`__sk_backlog_rcv`，sock.c:327），口袋同样以 sk_rcvbuf 为限、回放时队列满照样丢包记进 sk_drops，持锁者 `release_sock`（:3854）时统一回放。

## NET_TX 破案

全内核源码树里，raise NET_TX_SOFTIRQ 的只有三处：

| 位置 | 触发条件 |
|---|---|
| __netif_reschedule（dev.c:3391） | qdisc 需要重启重发 |
| dev_kfree_skb_irq（:3460） | 驱动在硬中断上下文释放 skb，延迟清理 |
| CPU 热插拔（:12762） | 下线核的 poll_list 搬家 |

`net_tx_action`（:5794）相应只有两份工：清 completion_queue 上待释放的 skb、把 output_queue 上的 qdisc 重新跑起来。正常发包不过它的门：`__dev_queue_xmit` 的入队、出队、驱动发送全在系统调用里同步走完；lo 连 qdisc 都没有（`tc qdisc show` 实测 noqueue；wlan0 的根 qdisc 也是 noqueue——mac80211 在里面自有队列）。所以「send 之后 NET_TX 不涨」的答案是：**发包这件事从来不归 NET_TX 管**。lo 场景里包的后续接收由 NET_RX 当场 raise；真网卡的发送完成回收发生在硬中断或 NAPI 上下文，顺带把 skb 塞进 completion_queue——那 25 次出勤，最可能就是哪个驱动在硬中断上下文释放 skb 的延迟清理，抓不到现行，不强行归因。

两本账并排：写作时点，NET_TX 25 次，NET_RX 2,516,129 次。一比十万。老资料时代读者要问的问题，在 7.2 上有更干脆的答案。

这篇讲到一个包进 socket 队列、唤醒进程为止。字节往返的另外半程——send() 的拷贝账、发送完成的硬中断怎么回收 RingBuffer、以及 NET_TX 为什么在发送侧更加门可罗雀——下篇。

## 我踩的坑

**任务 jiffies 不含软中断时间，差点冤枉 ksoftirqd。** 最初拿 ksoftirqd 累计 119ms 当「软中断全内联」的证据——证据是错的：软中断服务时间记在 /proc/stat 的全局 si 列，任务的 utime/stime 天然干净，就算 ksoftirqd 真干了活这两个数也不动。判断线程出不出工要看 schedstat 的调度计数和 voluntary 切换数，那上面才记账（58532→58532 才算证据）。

**单次读 /proc 也能读出谜。** 用 awk 抄绝对值时，NET_RX 总数有一次比前后快照高出 70 万——计数器只增不减，账对不上就是那次读数作废，弃用重测。跟硬件篇「读数越过接口物理上限先怀疑主机侧」是同一条纪律：先怀疑读数，再怀疑世界。

**强制实验要先算机制允不允许。** 为了逼 ksoftirqd 出场，拿竞争进程制造 need_resched——但 lo 路径一次出勤只有一个 pending，restart 上限的判断根本轮不到，竞争进程只把洪泛速率砍了半。白忙一场，副产品是一条 EEVDF 对半分核的速率数据。设计强制实验前先读清楚分支条件，力气才不会打空。

**非锁步的洪泛，丢包是概率。** 同样 20 万包洪泛，第一轮 socket 丢 205、第二轮一个不丢——收发快慢的瞬时赛跑决定生死。结论只放复跑站得住的：锁步组（E1a）和确定性溢出组（E4）才能承诺分毫不差。

**WiFi 的延迟不分省电就白量。** ping min 0.96ms、avg 11.5ms、max 36ms，十倍差距不是网络抖动，是省电睡眠把尾巴拉长。无线卡上量延迟，先看电源管理策略，不然量到的是网卡的盹。
