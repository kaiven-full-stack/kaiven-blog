---
title: 72 个位里揪出 1 个：ECC 内存与海明码
description: 服务器内存条是 72 位宽，多出来的 8 位是海明码。单比特翻了，症候群直接就是出错位置的二进制，定位并翻回去；双比特翻了，报警拒交脏数据；三比特翻了，它全程看不见。这三种下场，本文用 C 把全部六万余种组合穷举验证了一遍。硬件原理系列第七篇。
pubDate: 2026-09-19
category: hardware
tags: [硬件, 内存, ECC, 海明码]
---

上一篇拆内存条时留了个尾巴：服务器条子的一个 Rank 是 72 位，比家用条多出 8 位，由额外的内存芯片承担。这 8 位就是这篇的主角。它们干的活，是用 1950 年发明的海明码看住 64 位数据：任何一个位翻了面，定位它，翻回去；两个位同时翻了，报警，拒绝交出脏数据。发明人 Richard Hamming 因为这个工作拿了 1968 年的图灵奖，七十多年过去，这套码还躺在每一根服务器内存条上。

## 翻面没有想象中罕见

[上一篇](/posts/hardware-dram-internals/)说过，位存在电容里：有电荷是 1，没电荷是 0。电容这个东西天生不保真，它会漏电，所以内存要每 64 ms 刷新一轮；它也会被高能粒子（宇宙射线中子、封装材料的 α 粒子）撞出额外电荷或撞丢电荷，一个位就地翻面。

单个位翻面听着像小概率的稀奇事，架不住量大时间长。Google 2009 年发表过一项覆盖几万台服务器的大规模实地研究：约 8% 的内存条在一年里至少出过一次可纠正的位翻转，而且出错不是完全随机撒点，行与列方向上有聚集性。家用电脑对此无所谓，翻的如果只是一个像素，肉眼看不出来，真出了事重启就好；服务器连续跑几个月几年，内存里躺着的可能是订单、余额或者一个指针，一个位翻面，指针就成了野指针，数字就差之千里。ECC（Error Checking and Correcting）就是为此上到条子上的第二道防线。

## 一位奇偶校验：只报案，不说位置

最便宜的检错是一位奇偶校验：在 64 位数据后面附 1 位，让整体（含校验位）中 1 的个数恒为偶数。写入时算好，读出时重算，1 的个数变成奇数，就说明有位翻了。

它的本事和局限都一目了然。本事：单比特翻转必然改变 1 的总数的奇偶，跑不掉。局限有两条：一是只报案不报案情，知道有错，不知道 64 位里是哪一位，没法纠；二是双比特翻转会让奇偶翻两次负负得正，校验通过，它全程失明。要定位，1 位校验不够，得多设几个校验位，并且让它们的管辖范围互相交叠。

## 二进制地址：海明码的戏法

海明码的想法说出来朴素得惊人：给 72 个位置编号 1 到 72，编号写成二进制正好 7 位；第 k 个校验位负责管住所有「位置号第 k 位是 1」的位置。每个位置因此被一个独一无二的校验位组合管着，而这个组合恰好就是它自己的位置号。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 332" role="img" aria-label="海明码覆盖示意：三条横带各 16 格代表位置 1 到 16，第一带是校验位 1 管辖的位置（位置号第 0 位为 1，即全部奇数位），第二带是校验位 2 管辖的（第 1 位为 1，即 2、3、6、7、10、11、14、15），第三带是校验位 4 管辖的（第 2 位为 1，即 4 到 7 和 12 到 15），管辖格朱砂色；组与组犬牙交错，任何位置被哪个唯一的校验位组合管着，这个组合就是它的二进制编号；下方工作例：第 30 位翻面，30 的二进制是 0011110，于是 2、4、8、16 四组校验失败，拼出的 syndrome 等于 30" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">每个校验位管一组犬牙交错的位置（以位置号 1-16 为例）</text>
<text class="ts" x="92" y="52" text-anchor="end" font-size="9" fill="#6b675e">校验位 1 管：第 0 位=1</text>
<rect class="bx-sick" x="100" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="114" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">1</text>
<rect class="bx" x="130" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="144" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">2</text>
<rect class="bx-sick" x="160" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="174" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">3</text>
<rect class="bx" x="190" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="204" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">4</text>
<rect class="bx-sick" x="220" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="234" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">5</text>
<rect class="bx" x="250" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="264" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">6</text>
<rect class="bx-sick" x="280" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="294" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">7</text>
<rect class="bx" x="310" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="324" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">8</text>
<rect class="bx-sick" x="340" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="354" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">9</text>
<rect class="bx" x="370" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="384" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">10</text>
<rect class="bx-sick" x="400" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="414" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">11</text>
<rect class="bx" x="430" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="444" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">12</text>
<rect class="bx-sick" x="460" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="474" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">13</text>
<rect class="bx" x="490" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="504" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">14</text>
<rect class="bx-sick" x="520" y="58" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="534" y="76" text-anchor="middle" font-size="8.5" fill="#b03a2e">15</text>
<rect class="bx" x="550" y="58" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="564" y="76" text-anchor="middle" font-size="8.5" fill="#6b675e">16</text>
<text class="ts" x="92" y="112" text-anchor="end" font-size="9" fill="#6b675e">校验位 2 管：第 1 位=1</text>
<rect class="bx" x="100" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="114" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">1</text>
<rect class="bx-sick" x="130" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="144" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">2</text>
<rect class="bx-sick" x="160" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="174" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">3</text>
<rect class="bx" x="190" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="204" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">4</text>
<rect class="bx" x="220" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="234" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">5</text>
<rect class="bx-sick" x="250" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="264" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">6</text>
<rect class="bx-sick" x="280" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="294" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">7</text>
<rect class="bx" x="310" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="324" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">8</text>
<rect class="bx" x="340" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="354" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">9</text>
<rect class="bx-sick" x="370" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="384" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">10</text>
<rect class="bx-sick" x="400" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="414" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">11</text>
<rect class="bx" x="430" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="444" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">12</text>
<rect class="bx" x="460" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="474" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">13</text>
<rect class="bx-sick" x="490" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="504" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">14</text>
<rect class="bx-sick" x="520" y="118" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="534" y="136" text-anchor="middle" font-size="8.5" fill="#b03a2e">15</text>
<rect class="bx" x="550" y="118" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="564" y="136" text-anchor="middle" font-size="8.5" fill="#6b675e">16</text>
<text class="ts" x="92" y="172" text-anchor="end" font-size="9" fill="#6b675e">校验位 4 管：第 2 位=1</text>
<rect class="bx" x="100" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="114" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">1</text>
<rect class="bx" x="130" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="144" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">2</text>
<rect class="bx" x="160" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="174" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">3</text>
<rect class="bx-sick" x="190" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="204" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">4</text>
<rect class="bx-sick" x="220" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="234" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">5</text>
<rect class="bx-sick" x="250" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="264" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">6</text>
<rect class="bx-sick" x="280" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="294" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">7</text>
<rect class="bx" x="310" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="324" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">8</text>
<rect class="bx" x="340" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="354" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">9</text>
<rect class="bx" x="370" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="384" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">10</text>
<rect class="bx" x="400" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="414" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">11</text>
<rect class="bx-sick" x="430" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="444" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">12</text>
<rect class="bx-sick" x="460" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="474" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">13</text>
<rect class="bx-sick" x="490" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="504" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">14</text>
<rect class="bx-sick" x="520" y="178" width="28" height="28" fill="#efe0d9" stroke="#b03a2e" stroke-width="1"/><text class="ts" x="534" y="196" text-anchor="middle" font-size="8.5" fill="#b03a2e">15</text>
<rect class="bx" x="550" y="178" width="28" height="28" fill="#ece9e2" stroke="#6b675e" stroke-width="0.8"/><text class="ts" x="564" y="196" text-anchor="middle" font-size="8.5" fill="#6b675e">16</text>
<text class="ts" x="100" y="228" font-size="9.5" fill="#6b675e">任何位置被哪几个校验位管着，这个组合就是它位置号的二进制。72 个位置，7 个校验位足够点名。</text>
<text class="t" x="30" y="256" font-size="11" fill="#2b2a26">工作例：第 30 位翻面（30 = 0011110 二进制）</text>
<rect class="bx" x="100" y="266" width="44" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="0.9"/><text class="ts" x="122" y="283" text-anchor="middle" font-size="8.5" fill="#6b675e">64 组 ok</text>
<rect class="bx" x="150" y="266" width="44" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="0.9"/><text class="ts" x="172" y="283" text-anchor="middle" font-size="8.5" fill="#6b675e">32 组 ok</text>
<rect class="bx-sick" x="200" y="266" width="50" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/><text class="ts" x="225" y="283" text-anchor="middle" font-size="8.5" fill="#b03a2e">16 组 FAIL</text>
<rect class="bx-sick" x="256" y="266" width="44" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/><text class="ts" x="278" y="283" text-anchor="middle" font-size="8.5" fill="#b03a2e">8 组 FAIL</text>
<rect class="bx-sick" x="306" y="266" width="44" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/><text class="ts" x="328" y="283" text-anchor="middle" font-size="8.5" fill="#b03a2e">4 组 FAIL</text>
<rect class="bx-sick" x="356" y="266" width="44" height="26" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/><text class="ts" x="378" y="283" text-anchor="middle" font-size="8.5" fill="#b03a2e">2 组 FAIL</text>
<rect class="bx" x="406" y="266" width="44" height="26" fill="#ece9e2" stroke="#6b675e" stroke-width="0.9"/><text class="ts" x="428" y="283" text-anchor="middle" font-size="8.5" fill="#6b675e">1 组 ok</text>
<text class="tc" x="470" y="283" font-size="9.5" fill="#b03a2e">syndrome = 0011110 = 30</text>
<text class="ts" x="100" y="316" font-size="9.5" fill="#6b675e">七个组各验一次奇偶，FAIL 的组按权拼起来，读出来就是出错位置的编号。第 8 位全校验 P 管全体，用来分辨单翻与双翻。</text>
</svg>
</figure>

解码时把每个组重新做一遍 XOR：七个组的结果按权拼成一个 7 位数，叫 syndrome（症候群）。没有错时全组通过，syndrome 是 0；某一位翻了，它属于哪几个组，哪几个组的奇偶就被破坏，syndrome 拼出来恰好等于那个位置的编号。第 8 个校验位 P 是全体 71 位的总奇偶：翻一个位，P 必为奇；翻两个位，各自破坏的组互相抵消一部分，syndrome 仍非零但 P 变回偶。「syndrome 非零且 P 奇」是单翻，定位纠正；「syndrome 非零且 P 偶」是双翻，知道错了但不知道错在哪两个位置，只能报警。这就是 SEC-DED：纠一检二（Single Error Correction, Double Error Detection）。

## 穷举：一套码的能力与边界

道理讲完照例上机器。写一个 72 位 SEC-DED 的编解码器：位置 1 到 72，2 的幂位置放 7 个校验位，位置 72 放全校验 P，其余 64 个位置放数据：

```c
/* 编码：校验位 k = 它管辖组内所有位的 XOR */
for (int k = 0; k < 7; k++) {
    uint8_t x = 0;
    for (int p = 1; p <= 71; p++)
        if (p != (1 << k) && ((p >> k) & 1)) x ^= bit[p];
    bit[1 << k] = x;
}
/* 解码：每组连校验位一起再 XOR 一遍拼出 syndrome；
   syndrome 非零且 P 奇 → 单翻，位置 = syndrome，翻回去；
   syndrome 非零且 P 偶 → 双翻，报警，数据一个字不动 */
```

先走一个工作例，翻掉第 30 位：

```text
例数据字 0054494E475955A5，编码 72 位后把第 30 位翻面：
  校验位  1（管位置号第 0 位为 1 的组）: 组内奇偶 = 0 ok
  校验位  2（管位置号第 1 位为 1 的组）: 组内奇偶 = 1 FAIL
  校验位  4（管位置号第 2 位为 1 的组）: 组内奇偶 = 1 FAIL
  校验位  8（管位置号第 3 位为 1 的组）: 组内奇偶 = 1 FAIL
  校验位 16（管位置号第 4 位为 1 的组）: 组内奇偶 = 1 FAIL
  校验位 32（管位置号第 5 位为 1 的组）: 组内奇偶 = 0 ok
  校验位 64（管位置号第 6 位为 1 的组）: 组内奇偶 = 0 ok
  syndrome = 30，全校验 P = 1
  判定 status=1（1=单位纠错）定位位置 30，纠正后数据 复原
```

30 写成二进制是 0011110，失败的组正是 2、4、8、16，戏法与上文所述分毫不差。然后是穷举：72 个单翻位置、全部 2556 个双翻组合、全部 59640 个三翻组合，一个不漏全跑一遍：

```text
单比特穷举    72/72   ：全部定位并纠正
双比特穷举 2556/2556 ：全部报警拒交（零静默出错 0 起）
三比特穷举 59640 组合：误判为单位错 58961，误判为 P 位错 679，报警 0
              → 三翻静默通过率 100.00%（海明码的能力边界）
```

单翻和双翻的表现是数学保证，穷举只是把保证跑给你看。值得注意的是双翻的处置：报警意味着内存控制器不把这条数据交出去，通常的后续是原地重读，代价是一次延迟，不是数据出错。三翻那一行才是这套码的真实边界：三个位同时翻面，全体奇偶 P 必然又是奇数，syndrome 拼出来指向一个错误的位置，解码器会自信地把一个本来没错的位「纠正」反，交出脏数据，全程无告警。59640 种组合，静默通过 59640 种。

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 244" role="img" aria-label="海明码三种结局流程图：单比特翻转时 syndrome 非零且全校验为奇，定位纠正，穷举 72 个位置全部纠正成功；双比特翻转时 syndrome 非零但全校验为偶，报警拒交，控制器重读，穷举 2556 个组合全部报警零静默；三比特翻转时全校验必为奇，伪装成单翻被误纠到错误位置，穷举 59640 个组合全部静默通过，这是码的数学边界" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="t" x="30" y="24" font-size="12" fill="#2b2a26">翻面个数决定结局（数字为本文穷举结果）</text>
<rect class="bx-q" x="36" y="40" width="86" height="40" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="79" y="65" text-anchor="middle" font-size="10" fill="#2b2a26">翻 1 个位</text>
<rect class="bx" x="150" y="40" width="240" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<text class="ts" x="270" y="57" text-anchor="middle" font-size="9" fill="#2b2a26">syndrome 非零，P 为奇</text>
<text class="ts" x="270" y="72" text-anchor="middle" font-size="9" fill="#6b675e">→ 位置 = syndrome，翻回去</text>
<rect class="bx" x="418" y="40" width="212" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<text class="ts" x="524" y="64" text-anchor="middle" font-size="9.5" fill="#2b2a26">72 / 72 纠正成功，数据无恙</text>
<line class="fl" x1="122" y1="60" x2="146" y2="60" stroke="#6b675e" stroke-width="1.2"/>
<line class="fl" x1="390" y1="60" x2="414" y2="60" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="36" y="100" width="86" height="40" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="79" y="125" text-anchor="middle" font-size="10" fill="#2b2a26">翻 2 个位</text>
<rect class="bx" x="150" y="100" width="240" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<text class="ts" x="270" y="117" text-anchor="middle" font-size="9" fill="#2b2a26">syndrome 非零，P 为偶</text>
<text class="ts" x="270" y="132" text-anchor="middle" font-size="9" fill="#6b675e">→ 有错但定不了位，报警拒交</text>
<rect class="bx" x="418" y="100" width="212" height="40" rx="2" fill="#ece9e2" stroke="#6b675e" stroke-width="1.1"/>
<text class="ts" x="524" y="118" text-anchor="middle" font-size="9.5" fill="#2b2a26">2556 / 2556 报警，零静默出错</text>
<text class="ts" x="524" y="133" text-anchor="middle" font-size="8.5" fill="#6b675e">控制器重读，代价是一次延迟</text>
<line class="fl" x1="122" y1="120" x2="146" y2="120" stroke="#6b675e" stroke-width="1.2"/>
<line class="fl" x1="390" y1="120" x2="414" y2="120" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="36" y="160" width="86" height="40" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.1"/>
<text class="t" x="79" y="185" text-anchor="middle" font-size="10" fill="#2b2a26">翻 3 个位</text>
<rect class="bx-sick" x="150" y="160" width="240" height="40" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="270" y="177" text-anchor="middle" font-size="9" fill="#b03a2e">P 必为奇，伪装成单翻</text>
<text class="ts" x="270" y="192" text-anchor="middle" font-size="9" fill="#6b675e">→ 误纠到错误位置，无告警</text>
<rect class="bx-sick" x="418" y="160" width="212" height="40" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="524" y="178" text-anchor="middle" font-size="9.5" fill="#b03a2e">59640 / 59640 静默通过</text>
<text class="ts" x="524" y="193" text-anchor="middle" font-size="8.5" fill="#6b675e">其中 58961 起纠错地方，679 起放行</text>
<line class="fl" x1="122" y1="180" x2="146" y2="180" stroke="#6b675e" stroke-width="1.2"/>
<line class="fl" x1="390" y1="180" x2="414" y2="180" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="36" y="228" font-size="9.5" fill="#6b675e">三翻的误判率是码的数学边界，与运气无关：奇数个翻转让全校验永远读出「单翻」的签名。</text>
</svg>
</figure>

边界划清了，为什么工业界还是用了几十年？因为粒子撞击一次通常只翻一个位，三翻要求三个位同时出事，概率是单翻的三次方量级，稀疏错误的场景里几乎不会发生。海明码用 12.5% 的冗余位（8/64）和一撮 XOR 门，把最常见的错误全兜住了，性能代价只有几个百分点。它兜不住的场景另有专用方案：整颗芯片阵亡是 8 位一起错的突发错误，服务器级的 Chipkill 类方案用符号级的码吃掉整颗芯片；SSD 的 NAND 磨损出错天生是多比特的，所以闪存用的是反复迭代解码的 LDPC。每种码各有自己盯的错误形状。

## 故意翻位的人

以上都假设翻位是天灾。2014 年起的公开研究证明它也可以是人祸：Rowhammer 类攻击反复刷新某一行内存，邻近行（受害者行）的电容会被扰动漏电，位就这么翻了。它的麻烦在于一次可能翻出多个位，SEC-DED 兜不住；公开文献里已有借它改写页表项完成提权的演示，内存厂商的应对是在控制器里加目标行刷新（TRR）之类的缓解，操作系统和虚拟化层也各有防御。细节不展开，只留一个结论：内存的「物理隔离」比直觉里软，安全模型不能默认硬件位永远忠诚。

## 你的机器有没有

判断口径有三条。看位宽：`dmidecode -t memory` 的 `Total Width` 是 72 位就有 ECC，64 位就没有（要 root）。看 EDAC：Linux 的错误纠正子系统会在 `/sys/devices/system/edac/mc/` 下为每个内存控制器注册一个 `mc0`、`mc1` 目录，可纠正错误计数就在里面的 `ce_count`。本机的实读结果：

```text
$ ls /sys/devices/system/edac/mc/
power
subsystem
uevent
```

框架在，一个 mc 设备都没有注册，这是非 ECC 内存的典型形态，与这台消费级笔记本的身份相符（dmesg 也被 `dmesg_restrict=1` 挡着，日志侧无法交叉验证，如实记一笔）。没有 ECC 的机器上，位翻的下场是静默损坏或者莫名崩溃，赌的是运行时长短、数据不要紧。

服务器上要盯的是 `ce_count` 的增长率：可纠正错误本身无害，海明码当场就修了；但增长率抬头是内存条老化的前兆，运维据此安排换条，把「报警」变成「体检指标」。另外一个新变化：DDR5 在每颗芯片内部自带了一层 on-die ECC，对付单元密度上来之后变多的内部翻转；它管不到芯片与控制器之间的总线，所以服务器条的 72 位侧带 ECC 照旧存在，两层各守一段。

## 怎么用

ECC 是服务器的必选项，别省。它与软件校验是分工，不是替代：海明码管硬件层的稀疏位翻，软件层的校验和管它够不着的东西。InnoDB 每页头部的 CRC32 用来抓撕裂页，崩溃恢复重放前先验页身（[《断电之后》](/posts/mysql-innodb-redo-recovery/)）；Kafka 的每个消息批也带 CRC，写入算一遍、消费端再算一遍，传输与磁盘的损坏当场现形（[《追加的纪律》](/posts/kafka-log-segments/)）。硬件管天灾的单个位，软件管链路上的整段数据，一层都省不得。

应用层不必为内存自己写校验，那是 ECC 的活；但要知道它的能力边界：纠一检二，三翻失明。对完整性有极端要求的场景，往上一层找答案。

---

8 个校验位看 64 个数据位，靠的是给每个位置发一个二进制地址：谁的组坏了，syndrome 就拼出谁的编号。穷举给这套码发了一份完整的简历：72 个单翻全部纠正，2556 个双翻全部报警；至于 59640 个三翻，全部漏网，那是边界，往上兜的是 Chipkill 和 LDPC 们的活。下一篇是本系列的收官：硬盘。机械臂的寻道与闪存的擦写块，写放大与 TRIM，以及为什么两种完全不同的介质最后都崇拜同一个神：顺序 IO。
