---
title: 悬崖的最底层：HDD 的寻道与 SSD 的擦除块
description: 一次访存的完整悬崖，最后一级落在磁盘上：本机 NVMe 的随机读 p99 约 100 微秒，是内存的一千倍；HDD 的随机读是十毫秒量级，是 L1 缓存的十万倍。这篇拆开两种介质的物理距离：磁头的寻道花在哪，SSD 为什么必须先擦后写，FTL 的映射表如何把随机变成顺序，写放大又是如何堆起来的。硬件原理系列收官篇，SSD 部分实测于本机 WDC SN530。
pubDate: 2026-09-20
category: hardware
tags: [硬件, 磁盘, SSD, 性能]
---

内存山量到 95 ns 就停了，那是本系列实测的最低一级。悬崖再往下还有一层：断电之后数据住的地方，磁盘。这一层的价钱用微秒和毫秒计，跟上面几层差着三个到七个数量级。

磁盘有两种介质，结构南辕北辙：机械硬盘（HDD）靠磁头在旋转的盘片上找位置，固态硬盘（SSD）靠电荷关在晶体管里不出逃。但整个存储行业几十年来的工程共识只有一条：越顺序越好，越随机越贵。这篇拆两种介质各自的「贵」从哪里来。口径先交代：本机是笔记本，只有 NVMe 固态（WDC SN530 512G），没有机械盘，HDD 部分按结构与算术写、标注典型值；SSD 部分本机实测，裸块设备要 root 权限拿不到，实验退到文件级 O_DIRECT，量的是「应用发出一次读写」的总价钱，文件系统与盘内固件的性格都含在里面。

## 本机的盘

```text
$ lsblk -d -o NAME,MODEL,ROTA,SIZE,TRAN
NAME    MODEL                          ROTA   SIZE TRAN
zram0                                     0    15G
nvme0n1 WDC PC SN530 SDBPNPZ-512G-1002    0 476.9G nvme

$ cat /sys/block/nvme0n1/queue/rotational
0
$ cat /sys/block/nvme0n1/queue/scheduler
none mq-deadline [kyber] adios bfq
$ cat /sys/block/nvme0n1/queue/nr_requests
256
$ cat /sys/block/nvme0n1/queue/discard_max_bytes
2199023255040

$ findmnt -no SOURCE,FSTYPE,OPTIONS /
/dev/nvme0n1p2[/@] btrfs rw,noatime,compress=zstd:1,ssd,discard=async,space_cache=v2,subvolid=256,subvol=/@

$ systemctl is-enabled fstrim.timer
enabled
```

几个字段值得停留。`rotational=0` 是内核给「无寻道介质」的标记；调度器一栏五个名字都是多队列时代的 IO 调度器，NVMe 够快，多数场景让路给 none 或 kyber 这类轻量方案；`discard_max_bytes` 非零说明盘接受 TRIM 命令。挂载选项里 `discard=async` 表示 btrfs 在删除数据后异步地把「这些块不要了」通知盘，`fstrim.timer` 则是每周全盘扫一遍的兜底。两套 TRIM 制度这台机器都开着，后面讲 SSD 内部时会明白这为什么重要。

## HDD：距离写在物理里

机械盘的结构一句话：若干盘片叠在一根主轴上旋转，磁头装在摆臂上径向移动，数据以磁化方向存在盘片的同心圆磁道上。读一个扇区，磁头要先摆到位（寻道），再等目标扇区转过来（旋转等待），最后磁头划过读出（传输）。

时间都花在前两段。7200 转的盘一圈 8.33 ms（60 ÷ 7200），目标扇区平均要等半圈，旋转等待约 4.2 ms；寻道按行程远近在 1 ms 到 10 ms 之间，典型全行程几毫秒。两段加起来，一次随机读 5 到 10 ms，一秒做一百到两百次，这就是 HDD 随机 IO 的天花板，由转速和机械行程决定，固件再聪明也只是把多个请求排成顺路的电梯序（NCQ 干的事），省不掉单程的物理时间。

顺序读完全是另一个世界：磁头摆一次，之后数据自己从磁头底下流过，带宽由面密度和转速决定，现代机械盘一两百 MB/s。同一块盘，顺序与随机差出三个数量级。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 210" role="img" aria-label="HDD 一次读的时间解剖：随机读要先寻道几毫秒、再平均等半圈旋转约 4.2 毫秒、最后传输仅零点几毫秒；顺序读只寻道一次，之后数据连续流过，按一两百 MB/s 计传输 1 MB 只要约 10 微秒；两者相差三个数量级；标注为 7200 转盘的典型值与算术，本机无机械盘未实测" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">一次读的时间去哪了（7200 转典型值，本机无 HDD，未实测）</text>
<text class="ts" x="30" y="62" font-size="9.5" fill="#6b675e">随机读</text>
<rect class="bx-sick" x="90" y="46" width="200" height="24" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="190" y="62" text-anchor="middle" font-size="9" fill="#b03a2e">寻道 1-10 ms</text>
<rect class="bx-sick" x="290" y="46" width="180" height="24" rx="1" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="380" y="62" text-anchor="middle" font-size="9" fill="#b03a2e">旋转等待 平均 4.2 ms</text>
<rect class="bx" x="470" y="46" width="8" height="24" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1"/>
<text class="ts" x="492" y="62" font-size="9" fill="#6b675e">传输（可忽略）</text>
<text class="ts" x="30" y="116" font-size="9.5" fill="#6b675e">顺序读</text>
<rect class="bx" x="90" y="100" width="60" height="24" rx="1" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="120" y="116" text-anchor="middle" font-size="9" fill="#2b2a26">寻道一次</text>
<rect class="bx-q" x="150" y="100" width="420" height="24" rx="1" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="360" y="116" text-anchor="middle" font-size="9" fill="#2b2a26">数据连续流过：100-200 MB/s，1 MB 只要 ~10 µs</text>
<text class="tc" x="90" y="156" font-size="10.5" fill="#b03a2e">同一块盘：随机 5-10 ms/次（约百级 IOPS），顺序百 MB/s 级，差三个数量级</text>
<text class="ts" x="90" y="182" font-size="9.5" fill="#6b675e">旋转等待可算术：60 s ÷ 7200 转 = 8.33 ms/圈，平均等半圈 = 4.17 ms；寻道由行程决定。</text>
</svg>
</figure>

## SSD：没有机械，为什么还是怕随机

NAND 闪存存位靠的是把电荷关进晶体管的浮栅（或电荷陷阱）里。跟 [DRAM 的电容](/posts/hardware-dram-internals/)一样是「电荷即数据」，但浮栅漏得极慢，断电也在，这是非易失的来源。代价藏在三个不对称里：

- 读写单位是页（4-16 KB），擦除单位是块（几百个页，MB 级）；
- 写之前必须先擦，而擦是按块来的，且慢（毫秒级）；
- 每个块的擦写次数有寿命上限，几千到几万次量级，擦一次老一分。

「改写一个页」因此做不到原地进行：原地改写要求先擦，而擦会连坐整块里其他还有效的页。SSD 的解法是在固件里养一张映射表，叫 FTL（Flash Translation Layer）：主机眼里的逻辑页号，对应盘内一个物理页号。改写不碰旧位置，而是写进一个新的空闲页，映射表改指新址，旧页标记无效。无效页攒多了，后台的垃圾回收（GC）把同一个块里还有效的页搬去别处，整块擦净，重新入池。

这套机制把随机的代价从「慢」改成了「搬运」：GC 搬运有效页产生的额外写入，就是写放大（Write Amplification）。随机小写让无效页散布在各处，每个块里都夹着一堆有效页，GC 搬得多、放大重；顺序写让一个块从头到尾一次写满，作废时整块一起作废，GC 几乎白捡。同一个盘、同样的数据量，写的顺序不同，盘的内部工作量和寿命消耗能差出几倍。TRIM 是主机侧的助攻：文件系统把「这些逻辑页用户不要了」告诉盘，FTL 直接标记无效，GC 连搬都不用搬。本机 `discard=async` 加 `fstrim.timer` 的两套制度，供的就是这个。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 268" role="img" aria-label="SSD 擦除块与 FTL 三时刻示意图：擦除块内含 12 个页；时刻一新写，逻辑页 LBA1 到 LBA5 依次写进物理页，映射表记下对应关系；时刻二覆盖写 LBA3，数据写进新的空闲物理页，映射表改指新址，旧物理页标记无效但不擦除；时刻三垃圾回收，块里无效页占多数时，把仍有效的页搬到别的块，整块擦净重新入池，这次搬运就是写放大的来源" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="hw8Arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-s" d="M0,0 L10,5 L0,10 z" fill="#6b675e"/></marker>
<marker id="hw8ArrC" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="mk-c" d="M0,0 L10,5 L0,10 z" fill="#b03a2e"/></marker>
</defs>
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">擦除块的一生：新写、覆盖、GC（一格 = 一个页）</text>
<text class="ts" x="30" y="52" font-size="9.5" fill="#2b2a26">① 新写：映射表登记 LBA→物理页</text>
<rect class="bx-q" x="30" y="60" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="48" y="77" text-anchor="middle" font-size="8.5" fill="#2b2a26">L1</text>
<rect class="bx-q" x="66" y="60" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="84" y="77" text-anchor="middle" font-size="8.5" fill="#2b2a26">L2</text>
<rect class="bx-q" x="102" y="60" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="120" y="77" text-anchor="middle" font-size="8.5" fill="#2b2a26">L3</text>
<rect class="bx-q" x="138" y="60" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="156" y="77" text-anchor="middle" font-size="8.5" fill="#2b2a26">L4</text>
<rect class="bx-q" x="174" y="60" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="192" y="77" text-anchor="middle" font-size="8.5" fill="#2b2a26">L5</text>
<rect class="bx-gone" x="210" y="60" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="246" y="60" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="282" y="60" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="318" y="60" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="30" y="106" font-size="9.5" fill="#2b2a26">② 覆盖写 L3：写新页，旧页作废（不擦）</text>
<rect class="bx-q" x="30" y="114" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="48" y="131" text-anchor="middle" font-size="8.5" fill="#2b2a26">L1</text>
<rect class="bx-q" x="66" y="114" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="84" y="131" text-anchor="middle" font-size="8.5" fill="#2b2a26">L2</text>
<rect class="bx-gone" x="102" y="114" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="4 3"/><text class="ts" x="120" y="131" text-anchor="middle" font-size="8" fill="#a29d90">L3 废</text>
<rect class="bx-q" x="138" y="114" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="156" y="131" text-anchor="middle" font-size="8.5" fill="#2b2a26">L4</text>
<rect class="bx-q" x="174" y="114" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="192" y="131" text-anchor="middle" font-size="8.5" fill="#2b2a26">L5</text>
<rect class="bx-sick" x="210" y="114" width="36" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/><text class="ts" x="228" y="131" text-anchor="middle" font-size="8.5" fill="#b03a2e">L3 新</text>
<rect class="bx-gone" x="246" y="114" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="282" y="114" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<rect class="bx-gone" x="318" y="114" width="36" height="26" fill="none" stroke="#a29d90" stroke-width="1" stroke-dasharray="4 3"/>
<text class="ts" x="30" y="160" font-size="9.5" fill="#2b2a26">③ GC：有效页搬走，整块擦净回池</text>
<rect class="bx-gone" x="30" y="168" width="324" height="26" fill="none" stroke="#a29d90" stroke-width="1.2" stroke-dasharray="4 3"/>
<text class="ts" x="192" y="185" text-anchor="middle" font-size="8.5" fill="#a29d90">整块擦除（唯一能擦的粒度）</text>
<rect class="bx-q" x="400" y="168" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="418" y="185" text-anchor="middle" font-size="8.5" fill="#2b2a26">L1</text>
<rect class="bx-q" x="436" y="168" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="454" y="185" text-anchor="middle" font-size="8.5" fill="#2b2a26">L2</text>
<rect class="bx-q" x="472" y="168" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="490" y="185" text-anchor="middle" font-size="8.5" fill="#2b2a26">L4</text>
<rect class="bx-q" x="508" y="168" width="36" height="26" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/><text class="ts" x="526" y="185" text-anchor="middle" font-size="8.5" fill="#2b2a26">L5</text>
<rect class="bx-sick" x="544" y="168" width="36" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/><text class="ts" x="562" y="185" text-anchor="middle" font-size="8.5" fill="#b03a2e">L3</text>
<line class="flc" x1="360" y1="181" x2="394" y2="181" stroke="#b03a2e" stroke-width="1.3" marker-end="url(#hw8ArrC)"/>
<text class="ts" x="400" y="212" font-size="8.5" fill="#6b675e">搬进别的块（这次搬运 = 写放大）</text>
<text class="tc" x="30" y="246" font-size="10" fill="#b03a2e">顺序写：块内一次写满，作废时整块齐废，GC 免搬运。随机写：废页散布各处，GC 要大搬。</text>
</svg>
</figure>

## 实测这块盘

实验用文件级 O_DIRECT（绕页缓存、不绕文件系统与 FTL），1 GiB 暂存文件，四操作轮内交错、3 轮取中位；随机操作采 30000 个样本，出 p50/p99/max：

```c
int fd = open(PATH, O_RDWR | O_CREAT | O_TRUNC | O_DIRECT, 0644);
/* 顺序：128K 块扫完 1 GiB；随机：4K 块随机对齐偏移 × 30000 次
   每操作单独计时存样本，排序取分位数 */
off_t off = (off_t)(rand() % (FILESZ / 4096)) * 4096;
ssize_t n = dowrite ? pwrite(fd, buf, 4096, off) : pread(fd, buf, 4096, off);
```

```text
WDC SN530 512G · btrfs · O_DIRECT 文件级 · 1 GiB · 3 轮交错取中位
顺序读 128K :   5.14 GB/s
顺序写 128K :   1.23 GB/s
随机读 4K   :   79348 IOPS   p50=   2.8 us  p99=  102.8 us  max=  404.2 us
随机写 4K   :   24363 IOPS   p50=  37.0 us  p99=   94.3 us  max= 1724.3 us
```

先认一桩悬案。顺序写两遍读数 1.20 与 1.23 GB/s，稳；顺序读两遍却是 3.23 与 5.14，而且 5.14 超过了这块盘 PCIe 3.0 ×4 链路的物理上限（约 3.5 GB/s）。从设备读出来的字节不可能比链路快，多出来的部分只能发生在主机侧：最可疑的是 btrfs 的 zstd 透明压缩，测试文件按 0xA5 填充，压缩率极高，设备读出的字节远少于交回程序的字节，「带宽」被解压放大了。文件级基准量的从来不是裸盘，这条读数当上界看，口径声明又一次兑现了必要性。

随机读那行藏着第二个故事：p50 只有 2.8 µs，p99 却是 102.8 µs，差 37 倍。NAND 页读本身要几十微秒，2.8 µs 根本不落地，那是命中了某一层缓存的快路径（盘内缓存或文件系统层）；102.8 µs 才是 NAND 加排队的真身。同一个负载两个世界，平均数 79K IOPS 骑在两峰之间，谁也不描述。[《别信第一份读数》](/posts/kafka-latency-measurement/)里积压消费的双峰分布，在存储层原样重演。盘的内部也是一座金字塔，存储这门生意，层层都是缓存。

随机写 p50 37 µs 稳定得多：写没有「命中缓存就免单」的运气，每笔都要过固件的映射与落位。max 1724 µs 的长尾尖峰，是 GC 或刷写恰好在背后干活的时刻，盘一边伺候你一边收拾内务。IOPS 上写只有读的三成，读写不对称从 [内存总线那篇](/posts/hardware-dram-internals/)的 RFO 一路延续到存储层。最后照例交代量不到的：写放大是稳态与寿命尺度的效应，单队列深度的瞬时延迟看不见它，要长时稳态压测加 SMART 磨损计数才量得动，本环境没有 root 也没跑数小时，这段只按机制推理，不冒充实测。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 410" role="img" aria-label="系列收官完整悬崖图，纵轴对数刻度从 1 纳秒到 100 毫秒共九个数量级：L1 缓存 1.25 纳秒，L2 缓存 3.5 纳秒，L3 缓存 10 纳秒，内存 95 纳秒，SSD 随机读 p99 约 103 微秒，HDD 随机读约 10 毫秒（典型值，本机无 HDD）；相邻级之间标注倍数，从内存到 SSD 是一千倍，SSD 到 HDD 是一百倍，从 L1 到 HDD 跨七个数量级；前五级为本系列实测" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">完整的悬崖：一次访问的六级价钱（纵轴对数）</text>
<line class="grid" x1="80" y1="50" x2="620" y2="50" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="88" x2="620" y2="88" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="126" x2="620" y2="126" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="164" x2="620" y2="164" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="202" x2="620" y2="202" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="240" x2="620" y2="240" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="278" x2="620" y2="278" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="316" x2="620" y2="316" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="grid" x1="80" y1="354" x2="620" y2="354" stroke="#a29d90" stroke-width="0.8" stroke-dasharray="3 3"/>
<line class="axis" x1="80" y1="40" x2="80" y2="364" stroke="#6b675e" stroke-width="1.2"/>
<line class="axis" x1="80" y1="364" x2="620" y2="364" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="72" y="54" text-anchor="end" font-size="8.5" fill="#6b675e">100ms</text>
<text class="ts" x="72" y="92" text-anchor="end" font-size="8.5" fill="#6b675e">10ms</text>
<text class="ts" x="72" y="130" text-anchor="end" font-size="8.5" fill="#6b675e">1ms</text>
<text class="ts" x="72" y="168" text-anchor="end" font-size="8.5" fill="#6b675e">100µs</text>
<text class="ts" x="72" y="206" text-anchor="end" font-size="8.5" fill="#6b675e">10µs</text>
<text class="ts" x="72" y="244" text-anchor="end" font-size="8.5" fill="#6b675e">1µs</text>
<text class="ts" x="72" y="282" text-anchor="end" font-size="8.5" fill="#6b675e">100ns</text>
<text class="ts" x="72" y="320" text-anchor="end" font-size="8.5" fill="#6b675e">10ns</text>
<text class="ts" x="72" y="358" text-anchor="end" font-size="8.5" fill="#6b675e">1ns</text>
<polyline class="curve-k" points="120,350.3 210,333.3 300,316 390,278.8 480,163.5 570,88" fill="none" stroke="#2b2a26" stroke-width="2"/>
<circle class="fill-c" cx="120" cy="350.3" r="3.4" fill="#2b2a26"/>
<circle class="fill-c" cx="210" cy="333.3" r="3.4" fill="#2b2a26"/>
<circle class="fill-c" cx="300" cy="316" r="3.4" fill="#2b2a26"/>
<circle class="fill-c" cx="390" cy="278.8" r="3.4" fill="#2b2a26"/>
<circle class="fill-c" cx="480" cy="163.5" r="3.4" fill="#2b2a26"/>
<circle class="fill-c" cx="570" cy="88" r="3.4" fill="#b03a2e"/>
<text class="ts" x="126" y="344" font-size="8.5" fill="#6b675e">1.25 ns</text>
<text class="ts" x="216" y="327" font-size="8.5" fill="#6b675e">3.5 ns</text>
<text class="ts" x="306" y="310" font-size="8.5" fill="#6b675e">10 ns</text>
<text class="ts" x="384" y="272" text-anchor="end" font-size="8.5" fill="#6b675e">95 ns</text>
<text class="ts" x="474" y="157" text-anchor="end" font-size="8.5" fill="#6b675e">p99 103 µs</text>
<text class="tc" x="570" y="78" text-anchor="middle" font-size="8.5" fill="#b03a2e">~10 ms（典型值）</text>
<text class="ts" x="345" y="289" text-anchor="middle" font-size="9" fill="#6b675e">×10</text>
<text class="ts" x="430" y="210" text-anchor="middle" font-size="9" fill="#6b675e">×1000</text>
<text class="ts" x="531" y="120" font-size="9" fill="#6b675e">×100</text>
<text class="ts" x="120" y="382" text-anchor="middle" font-size="9" fill="#2b2a26">L1</text>
<text class="ts" x="210" y="382" text-anchor="middle" font-size="9" fill="#2b2a26">L2</text>
<text class="ts" x="300" y="382" text-anchor="middle" font-size="9" fill="#2b2a26">L3</text>
<text class="ts" x="390" y="382" text-anchor="middle" font-size="9" fill="#2b2a26">内存</text>
<text class="ts" x="480" y="382" text-anchor="middle" font-size="9" fill="#2b2a26">SSD 随机读</text>
<text class="tc" x="570" y="382" text-anchor="middle" font-size="9" fill="#b03a2e">HDD 随机读</text>
<text class="ts" x="30" y="402" font-size="9.5" fill="#6b675e">前五级为本系列实测（同一台 Ryzen 5 5500U + WDC SN530），HDD 为 7200 转公开典型值。从 L1 到 HDD，七个数量级。</text>
</svg>
</figure>

## 为什么大家都押顺序

把两种介质的「贵」并排放，顺序 IO 的价值不用再论证：HDD 那一层，顺序省的是寻道与旋转，一次省几毫秒；SSD 这一层，顺序省的是 GC 搬运与写放大，省的是盘的内部工作量和寿命。再往存储栈上游走，[内存的顺序省的是行激活](/posts/hardware-dram-internals/)，本机实测 3 倍多；缓存那一层的 64 字节一口，第一篇就量过了。从电容到磁头，整个存储栈每一层都在为顺序打折、对随机加价。

所以存储系统的设计史，半部就是迎合顺序 IO 的历史。内核的页缓存把千万次散小的写攒成整页的大块写再下刷（[《write() 返回了，数据还在内存里》](/posts/kernel-page-cache-writeback/)）；InnoDB 把数据装进 16 KB 的页、用 B+ 树把千万行的随机定位压成三四次页访问（[《一行数据落在哪里》](/posts/mysql-innodb-pages-btree/)），再把 redo 日志写成纯追加；Kafka 干脆把产品形态做成只能追加的日志段，读也按段顺序扫（[《追加的纪律》](/posts/kafka-log-segments/)）。它们赌的是同一件事：介质对顺序的偏爱不会变。

## 怎么用

SSD 别塞满。空闲块是 GC 的周转空间，盘越满，搬运会话越频繁，写放大越重，性能掉得也越狠，留出富余是免费的保养。

确认 TRIM 在工作：`findmnt` 看有没有 `discard` 挂载项，`systemctl status fstrim.timer` 看兜底扫描开没开。本机两套都开着，这也是它的随机写 p50 能稳在 37 µs 的底气之一。

看寿命用 SMART：`smartctl -a /dev/nvme0`（要 root）里的已写入总量对照厂商标称 TBW，比任何跑分都实在。

延迟敏感的评估别只看平均：随机读的 p50 与 p99 差着 37 倍，选缓存命中率、排队深度还是换盘，取决于你的用户在哪个峰上。

机械盘只留给顺序场景：备份、归档、冷数据。让它做随机寻址，等于让磁头跳华尔兹。

---

八篇至此收齐。这一系列做的事始终只有一件：把软件性能底下的硬件事实，在自己的机器上一件件量出来。L1 的 1.25 ns、L3 的 4 MB 边界、TLB 的 1024 条目、逻辑核的 0.01 到 0.93、搬家的 69 ns、行缓冲的 3 倍、海明码的 59640 种漏网，到今天磁盘的 100 µs。数字换一台机器就全变了，量法不变：控制变量、轮次交错、中位与 min 分开看、口径如实交代。硬件原理系列到此完结。
