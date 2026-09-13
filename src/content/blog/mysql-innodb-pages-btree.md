---
title: 一行数据落在哪里：页、区、段与 B+ 树
description: MySQL 系列第一篇。空表为什么一出生就占 112KB？.ibd 文件里前 7 页各自是谁？为什么 32 页是共享碎片区与独享整区的分水岭（源码 FSEG_FRAG_ARR_N_SLOTS 对上了实测）？本文用 docker 里的 MySQL 8.4.11 加一个自写的 .ibd 二进制解析器，把 InnoDB 的空间管理拆到字节级：页头、FSP 头、XDES 区位图、INODE 段条目，再往上走到 B+ 树。百万行表实测树高 3、根页 8 个指针；随机主键让叶子填充率跌到 69%、空间多耗 39%；回表比覆盖索引多 1717 倍页读。每一格都是当场跑出来的数字。
pubDate: 2026-09-10
category: mysql
tags: [MySQL, 数据库, 存储引擎]
---

一张空表，112KiB。你没看错：**建表那一刻，一个字节的用户数据都没有，.ibd 文件已经分配了 7 页**。这 7 页是谁？为什么是 7？从这个问题往下挖，会依次撞见 InnoDB 空间管理的四层结构（页、区、段、表空间），最后落到 B+ 树上。这也是本系列（钉住 MySQL 8.4 LTS）的第一篇：先把地基打牢，后面讲 MVCC 的版本链、锁的记录定位，全都站在页和索引的结构之上。一行数据在 .ibd 文件里怎么布局、主键顺序插入的表为什么又小又快、回表到底贵在哪，都会在这条路上得到答案。

本篇全部实验来自 docker 里的 MySQL 8.4.11（`mysql:8` 镜像），数字是当场跑出来的；涉及二进制布局的部分，我写了一个 200 行的 Python 解析器直接拆 .ibd 文件核对。倒不是不信文档，只是文档不告诉你**实测**有多齐整：段条目上的页数和优化器统计信息能对到个位数不差。

## 一页：InnoDB 的最小单位

先看配置：

```sql
SELECT @@innodb_page_size;   -- 16384
SET GLOBAL innodb_page_size = 8192;
-- ERROR 1238 (HY000): Variable 'innodb_page_size' is a read only variable
```

16KiB，一页。这是 InnoDB 一切空间操作的计量单位，**且不可在线修改**：页大小写进每个 .ibd 文件的标志位，建库时定型，终身不改（想改只能重建整个实例）。

为什么是 16KiB？往上对齐：16KiB 页 = 文件系统一页（4KiB）的 4 倍，与内核 page cache 打交道时整数倍对齐，不会出现一页数据横跨两个内核页的尴尬（我写过内核侧的对照：[《page cache 与脏页回写》](/posts/kernel-page-cache-writeback/)）。往下看：B+ 树一个节点一页，16KiB 决定了扇出（一个节点能放多少个指针），扇出决定树高，树高决定每次查询要走几页。这三个「决定」是本篇后半的主角。

一个索引页的骨架（精简到只留本篇要用的字段）：

```text
页头（38 字节起）
  ├─ 页类型 @24（2B）：17855 = 索引页，9 = 区描述页，3 = 段 inode 页 …
  ├─ 前驱/后继页号 @8/@12（4B×2）：叶子页的双向链
  └─ 页号、校验和、LSN（日志序号，redo 篇的主角）
页体（38 字节起）
  ├─ 记录数 @54、页级 @64、索引号 @66
  └─ 用户记录，按主键序存放，页内有序、页间链成链
```

（字段偏移按 MySQL 8.4 源码 `fil0fil.h` 与 `page0types.h`；解析器的字段映射是我用已知值（索引号 160、树高、行数）逐个对齐校准的。）

一行数据落在页内，不是简单的 append。InnoDB 按**行格式**打包：COMPACT/DYNAMIC（8.4 默认 DYNAMIC）都是「变长长度列表 + NULL 位图 + 记录头 + 列数据」，记录头里藏着「下一条记录的偏移」，所以**页内是单向链表**：从页头的「最小记录」（infimum）开始，沿链走，依次经过按主键序排列的每行，直到「最大记录」（supremum）。插入是链表插入；删除是把记录标记为已删、加入页内垃圾链，垃圾字节记在页头 @46，等页满再整理。这就是为什么后面的实验里你能看到「叶子页平均 2098 字节垃圾」这种数字。

页内这条链的样子：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 198" role="img" aria-label="一个索引页内部的单向链表：从 infimum 最小记录出发，沿记录头里的下一条偏移依次经过按主键序排列的用户记录，直到 supremum 最大记录；删除只标记并挂进垃圾链，等页满再整理" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my1As1" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">一个 16KiB 索引页的内部：按主键序串成的单向链</text>
<rect class="bx" x="20" y="40" width="620" height="96" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="36" y="70" width="76" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="74" y="91" text-anchor="middle" font-size="10" fill="#6b675e">infimum</text>
<line class="fl" x1="112" y1="87" x2="136" y2="87" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As1)"/>
<rect class="bx-q" x="140" y="70" width="88" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="184" y="91" text-anchor="middle" font-size="10" fill="#6b675e">id=5 的行</text>
<line class="fl" x1="228" y1="87" x2="242" y2="87" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As1)"/>
<rect class="bx-q" x="246" y="70" width="88" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="290" y="91" text-anchor="middle" font-size="10" fill="#6b675e">id=9 的行</text>
<line class="fl" x1="334" y1="87" x2="348" y2="87" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As1)"/>
<rect class="bx-q" x="352" y="70" width="88" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="396" y="91" text-anchor="middle" font-size="10" fill="#6b675e">id=17 的行</text>
<line class="fl" x1="440" y1="87" x2="454" y2="87" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As1)"/>
<rect class="bx-gone" x="458" y="70" width="60" height="34" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="488" y="91" text-anchor="middle" font-size="10" fill="#6b675e">…</text>
<line class="fl" x1="518" y1="87" x2="540" y2="87" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As1)"/>
<rect class="bx-q" x="544" y="70" width="80" height="34" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="584" y="91" text-anchor="middle" font-size="10" fill="#6b675e">supremum</text>
<text class="ts" x="36" y="126" font-size="10" fill="#6b675e">记录头存「下一条的偏移」；已删记录挂进页内垃圾链，垃圾字节记在页头 @46</text>
<text class="ts" x="20" y="162" font-size="12" fill="#6b675e">页内有序，页间也有序：叶子页靠页头的前驱/后继页号串成双向链</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">插入是链表插入，从不是追加写：这就是页内会有空洞与垃圾的原因</text>
</svg>
</figure>

### 溢出：一行装不下一页怎么办

行格式决定长列怎么放。建两张表，各插 1 万行 12000 字节的 VARCHAR，对比 DYNAMIC 与 COMPACT：

| 表 | 叶子页数 | 每页行数 | 文件大小 |
| --- | --- | --- | --- |
| ROW_FORMAT=DYNAMIC | 31 | 322.6 | 164MiB* |
| ROW_FORMAT=COMPACT | 557 | 18.0 | 176MiB |

*DYNAMIC 表另有一万页溢出页，含溢出页总占用两表相当；差异在叶子页的数量。

12000 字节超过页内阈值，两种格式都溢出。区别在**留在叶子页里的部分**：COMPACT 留 768 字节前缀 + 20 字节指针，DYNAMIC 只留 20 字节指针、值整体搬去溢出页。768 字节前缀的设计意图是「前缀查询不用回溢出页」，代价是每行白白多背 748 字节。上表右列就是这笔「768 前缀税」：同样一页，DYNAMIC 能放 322 行的元信息，COMPACT 只放 18 行，二级索引的扇出直接被压掉一个数量级。8.0 起默认 DYNAMIC，就是这笔账算明白了。

溢出页本身也值得看一眼：8.4 的溢出值不再是旧文档说的「无结构 BLOB 页」，而是**自带小型索引的 LOB 页族**（解析器抓到的页类型 22–29：LOB_INDEX/LOB_DATA/LOB_FIRST…，页类型 24 是溢出值的第一页）。一个 12000 字节的值占一个 LOB_FIRST 页；更大的值会散成多个 LOB_DATA 页、用 LOB_INDEX 串起来，大对象内部又是一个「页 + 目录」的迷你世界。

## 一个 .ibd 的起点：空表七页

现在回答开头的问题。`information_schema.INNODB_TABLESPACES` 查 FILE_SIZE：114688 字节 = 7 页。这 7 页是谁？`FLUSH TABLES ... FOR EXPORT` 后把 .ibd 拷出来，用解析器读每页的页类型：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 204" role="img" aria-label="空表 .ibd 的 7 页布局：page 0 是 FSP_HDR 全局账本，page 1 变更缓冲位图，page 2 INODE 段条目，page 3 SDI 表字典，这四页是表空间自己的初始结构；page 4 是主键 B+ 树根页，page 5 与 6 预留" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">114688 字节 = 7 页，每页都有名字</text>
<rect class="bx" x="20" y="44" width="84" height="70" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="62" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 0</text>
<text class="ts" x="62" y="82" text-anchor="middle" font-size="9" fill="#6b675e">FSP_HDR</text>
<text class="ts" x="62" y="98" text-anchor="middle" font-size="9" fill="#6b675e">全局账本</text>
<rect class="bx" x="108" y="44" width="84" height="70" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="150" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 1</text>
<text class="ts" x="150" y="82" text-anchor="middle" font-size="9" fill="#6b675e">IBUF_BITMAP</text>
<text class="ts" x="150" y="98" text-anchor="middle" font-size="9" fill="#6b675e">变更缓冲位图</text>
<rect class="bx" x="196" y="44" width="84" height="70" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="238" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 2</text>
<text class="ts" x="238" y="82" text-anchor="middle" font-size="9" fill="#6b675e">INODE</text>
<text class="ts" x="238" y="98" text-anchor="middle" font-size="9" fill="#6b675e">段条目 ×85</text>
<rect class="bx" x="284" y="44" width="84" height="70" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="326" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 3</text>
<text class="ts" x="326" y="82" text-anchor="middle" font-size="9" fill="#6b675e">SDI</text>
<text class="ts" x="326" y="98" text-anchor="middle" font-size="9" fill="#6b675e">表字典</text>
<rect class="bx-q" x="372" y="44" width="84" height="70" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="t" x="414" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 4</text>
<text class="tc" x="414" y="82" text-anchor="middle" font-size="9" fill="#b03a2e">INDEX</text>
<text class="ts" x="414" y="98" text-anchor="middle" font-size="9" fill="#6b675e">主键树根页</text>
<rect class="bx-gone" x="460" y="44" width="84" height="70" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="502" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 5</text>
<text class="ts" x="502" y="82" text-anchor="middle" font-size="9" fill="#6b675e">预留</text>
<rect class="bx-gone" x="548" y="44" width="84" height="70" rx="3" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="t" x="590" y="64" text-anchor="middle" font-size="11" fill="#2b2a26">page 6</text>
<text class="ts" x="590" y="82" text-anchor="middle" font-size="9" fill="#6b675e">预留</text>
<line class="flk" x1="20" y1="124" x2="368" y2="124" stroke="#2b2a26" stroke-width="1.6"/>
<text class="ts" x="20" y="140" font-size="11" fill="#6b675e">page 0–3：表空间自己的初始结构，与用户数据无关</text>
<line class="flc" x1="372" y1="124" x2="632" y2="124" stroke="#b03a2e" stroke-width="1.6"/>
<text class="tc" x="372" y="158" font-size="11" fill="#b03a2e">page 4 起：你的数据将来住在这棵树上</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">SDI 让 .ibd 自描述：拷走一个文件，就带走了表结构的全部信息</text>
</svg>
</figure>

页 0/1/2/3 是**表空间自己**的初始结构，与数据无关：全局元数据（FSP 头、区描述符的位图）、变更缓冲的位图、段条目、字典。SDI（Serialized Dictionary Information）是 8.0 的设计，把表结构直接存进 .ibd，所以 .ibd 文件**自描述**，拷走一个文件就带走了表结构的全部信息（8.0 之前的字典只在共享的系统表空间里）。页 4 才是第一棵 B+ 树的根：你的一行数据将来就住在这个页开始的树里。

而这张表有**两个段在排队等数据**。页 2 的 INODE 是段条目页，每段一个 192 字节的条目。解析空表的页 2：

```text
seg id=1  slot=0  frag=[3]              ← 字典树的根（页 3）
seg id=2  slot=1  frag=[]               ← 字典树的另一个段，空
seg id=3  slot=2  frag=[4]              ← 主键树的「内部页段」
seg id=4  slot=3  frag=[5,6,7,...]      ← 主键树的「叶子段」
```

四个段，每张表出生自带。**每个 B+ 树有两个段**：叶子页一个段，内部页一个段。为什么分开记？因为查询路径只碰内部页的少数几页（树高 3 的百万行表，一次点查内部页只走 2 页）而叶子页是数据主体；分开之后，扫描叶子段不会把内部页的缓存挤掉，这是 InnoDB 给 B+ 树的「热点分离」。

## 区与段：从共享碎片区到独享整区

页之上还有两层。**区（extent）= 64 页 = 1MiB**，InnoDB 向文件系统申请空间以区为单位；**段（segment）**是区的集合，一棵 B+ 树的叶子页属于叶子段，内部页属于内部段。听起来是「树大了就按区拿地」，但地怎么拿，有一条精确到源码的路线。

一行数据的完整住址，四层坐标：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 212" role="img" aria-label="四层坐标嵌套图：最外层是表空间 .ibd 文件，里面按段划分（叶子段、内部段、字典段各自独立），段由区组成（一区 64 页 1MiB），区里是一页页 16KiB 的页，行数据住在页内" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">从文件到一行数据：四层坐标</text>
<rect class="bx" x="20" y="40" width="620" height="120" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="36" y="60" font-size="12" fill="#2b2a26">表空间 · .ibd 文件</text>
<rect class="bx-q" x="40" y="70" width="400" height="76" rx="4" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="52" y="88" font-size="11" fill="#6b675e">段（叶子段 / 内部段 / 字典段…）</text>
<rect class="bx" x="60" y="96" width="250" height="40" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="72" y="112" font-size="10" fill="#6b675e">区 extent = 64 页 = 1MiB</text>
<rect class="bx-sick" x="80" y="118" width="90" height="14" rx="2" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.2"/>
<text class="ts" x="190" y="130" font-size="10" fill="#6b675e">页 16KiB · 行住在页内</text>
<rect class="bx-gone" x="460" y="70" width="160" height="76" rx="4" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="540" y="100" text-anchor="middle" font-size="11" fill="#6b675e">另一个段</text>
<text class="ts" x="540" y="118" text-anchor="middle" font-size="10" fill="#6b675e">各段独立向表空间要地</text>
<text class="ts" x="20" y="184" font-size="12" fill="#6b675e">一行数据的住址：big_seq.ibd → 叶子段 → 第 100 个区 → 区内第 43 页 → 页内链表的某条记录</text>
<text class="ts" x="20" y="204" font-size="12" fill="#6b675e">区是向文件系统要地的单位，段是逻辑归属的单位，页是一切操作的计量单位</text>
</svg>
</figure>

### 32 页的分水岭

建一张新表，一行一行插，每 20 行记一次文件大小（截取关键段）：

```text
rows=4300  file=557056  (34 页)
rows=4460  file=573440  (35 页)
...
rows=4960  file=622592  (38 页)
rows=5120  file=2097152 (128 页)    ← 一次 +90 页
rows=5280  file=9437184 (576 页)    ← 一次 +448 页
rows>5280  …之后每次正好 +1MiB（64 页）
```

三个阶段，两次跳变。源码（`fsp0fsp.cc`）把每一步都说死了：

**第一阶段：碎片区逐页领用。** 新段的第一批页不住自己的区里，而是从表空间开头的**共享碎片区**按页领。空表 7 页就住在这里，每段最多领 32 页（`FSEG_FRAG_ARR_N_SLOTS = FSP_EXTENT_SIZE / 2`，源码常数与实测对上：跳变发生在 37–38 页时，正是叶子段的 32 个碎片槽用完的临界点）。为什么？一张 10 行的日志表也独享 1MiB 一个区，太浪费；碎片区让小段按页蹭住，是空间上的省俭。

**第二阶段：独享整区。** 第 33 页起，段直接领整个区，从此一领一区。38→128 的 +90 页跳变来自表空间扩展策略（`fsp_get_pages_to_extend_ibd`）：文件大小不足 64 页先补齐到整区，小表每次扩 1 个区；这里补 64 + 扩 64 = 128，再减去已用 38 页，数字完全对上。

**第三阶段：32MiB 之后批发。** 表空间超过 32MiB 后，每次扩展从 1 个区跳到 4 个区（`FSP_FREE_ADD = 4`）。实测验证：47.6 万行的表（31MiB）下一次扩展直接 +4MiB，之后每次都是整 4MiB，32MiB 的分界在文件大小曲线上像台阶一样清晰。

（128→576 那次 +448 页的大跳，是 B+ 树页分配前的安全余量在起作用：每次分页前 `fsp_reserve_free_extents` 会预留 2 个区保证页分裂不会半路失败，预留不足就成倍扩展、循环重试。日常无需记它，但你在监控里看到的「表空间一次涨一大截」，多半是它。）

三个阶段摆开：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 226" role="img" aria-label="表空间扩展三阶段：第一段新段前 32 页从共享碎片区逐页领用，实测跳变在 37 到 38 页对上 FSEG_FRAG_ARR_N_SLOTS=32；第二段第 33 页起独享整区，一区 64 页，38 到 128 的加 90 页是先补齐整区再扩一区；第三段表空间超过 32MiB 后 FSP_FREE_ADD=4，每次扩展从 1 个区跳到 4 个区" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my1As3" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">段长大的三段路：蹭住 → 独门 → 批发</text>
<rect class="bx" x="20" y="44" width="190" height="116" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="115" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">① 碎片区蹭住</text>
<text class="ts" x="32" y="88" font-size="10" fill="#6b675e">新段前 32 页从共享碎片区</text>
<text class="ts" x="32" y="104" font-size="10" fill="#6b675e">按页领；空表 7 页就住这</text>
<text class="ts" x="32" y="124" font-size="10" fill="#6b675e">源码常数 32 = 64/2，与实测</text>
<text class="ts" x="32" y="140" font-size="10" fill="#6b675e">跳变点 37–38 页对上</text>
<line class="fl" x1="210" y1="102" x2="228" y2="102" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my1As3)"/>
<rect class="bx" x="232" y="44" width="190" height="116" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="327" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">② 独享整区</text>
<text class="ts" x="244" y="88" font-size="10" fill="#6b675e">第 33 页起一领一区：</text>
<text class="ts" x="244" y="104" font-size="10" fill="#6b675e">1 区 = 64 页 = 1MiB</text>
<text class="ts" x="244" y="124" font-size="10" fill="#6b675e">38→128 的 +90：先补齐整区</text>
<text class="ts" x="244" y="140" font-size="10" fill="#6b675e">64 页，再扩 1 个区</text>
<line class="fl" x1="422" y1="102" x2="440" y2="102" stroke="#6b675e" stroke-width="1.6" marker-end="url(#my1As3)"/>
<rect class="bx-sick" x="444" y="44" width="196" height="116" rx="4" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="t" x="542" y="66" text-anchor="middle" font-size="12" fill="#2b2a26">③ 32MiB 后批发</text>
<text class="ts" x="456" y="88" font-size="10" fill="#6b675e">FSP_FREE_ADD = 4：</text>
<text class="ts" x="456" y="104" font-size="10" fill="#6b675e">每次扩展 1 个区变 4 个区</text>
<text class="ts" x="456" y="124" font-size="10" fill="#6b675e">实测 31MiB 的表下一次</text>
<text class="ts" x="456" y="140" font-size="10" fill="#6b675e">扩展直接 +4MiB</text>
<text class="ts" x="20" y="186" font-size="12" fill="#6b675e">128→576 的 +448 大跳来自页分裂前的 2 区安全预留：预留不足就成倍扩</text>
<text class="ts" x="20" y="208" font-size="12" fill="#6b675e">XDES 位图与 INODE 段条目两份磁盘记录，与优化器统计能对到个位数不差</text>
</svg>
</figure>

### 磁盘上的两份记录：XDES 位图与 INODE 段条目

这套层级在磁盘上如何记录？两份元数据，都在 .ibd 文件里，我的解析器都能读：

**XDES 区描述符（每 16384 页一个）。** 一个 40 字节的条目管 64 页的区：区号、属于哪个段、状态（FREE / FREE_FRAG / FULL_FRAG / FSEG）、64 页 × 2bit 的逐页位图。解析百万行表 big_seq：

```text
extents total=103  by state: {FSEG: 100, FREE_FRAG: 1, FREE: 1}
```

103 个区，100 个划给了段，和段条目对得上。

**INODE 段条目（页 2 起）。** 每段一条：段 id、三个区链表（free / not_full / full）、32 个碎片页号。解析 big_seq 的叶子段：

```text
seg id=4: not_full=1 ext (43 pages used), full=99 ext, frag=32 pages
        → 99×64 + 43 + 32 = 6411 页
```

而优化器统计（`mysql.innodb_index_stats`）里这张表主键的 `n_leaf_pages` = **6411**。两个独立的来源：磁盘上的二进制段条目、优化器的统计表，对到个位数不差。两个独立来源对上的瞬间，是做实验最踏实的瞬间。

## B+ 树：三层结构，百万行三页寻址

地基铺完，往上盖树。B+ 树为什么长这样、InnoDB 的 B+ 树有什么特别，网上套路化讲解很多；我只讲实测能看到的骨架，和三个被数字直接钉住的性质。

### 高度：百万行，树高 3

百万行顺序主键表（big_seq）的实测结构：

```text
root_page=4  root_level=2  tree_height=3
levels: {0: 6411 叶, 1: 8 中间, 2: 1 根}
leaves: 6411 页 × avg 156.0 行/页 = 1,000,000 行
```

三层：根 1 页 → 8 个中间页 → 6411 个叶子页。**一次主键点查最多走 3 页**（根→中间→叶，实际更少：根和中间页几乎永远在 buffer pool 里）。一千万行表（big10m）树高 4：64110 叶 + 80 中间 + 1 根。粗算每多一层容量翻约 800 倍（中间页每页约 800 指针），**树高 5 就能放约 5 亿行**。「B+ 树很矮」靠的是扇出的算术，不是口号。

这棵百万行的树：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 262" role="img" aria-label="百万行表 big_seq 的 B+ 树：根页 1 页指向 8 个中间页，中间页指向 6411 个叶子页，每叶平均 156 行；根和中间页属于内部段常驻内存，叶子页属于叶子段是数据主体；一次主键点查沿朱砂路径最多走 3 页" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my1As4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="my1Ac4" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">big_seq：tree_height=3，一次点查最多走 3 页（朱砂路径）</text>
<rect class="bx-q" x="300" y="40" width="90" height="32" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="345" y="60" text-anchor="middle" font-size="11" fill="#6b675e">根 · 1 页</text>
<rect class="bx" x="100" y="106" width="80" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="140" y="125" text-anchor="middle" font-size="10" fill="#6b675e">中间页</text>
<rect class="bx-q" x="305" y="106" width="80" height="30" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="345" y="125" text-anchor="middle" font-size="10" fill="#6b675e">中间页</text>
<rect class="bx" x="510" y="106" width="80" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="550" y="125" text-anchor="middle" font-size="10" fill="#6b675e">中间页</text>
<text class="ts" x="238" y="125" font-size="11" fill="#6b675e">…</text>
<text class="ts" x="452" y="125" font-size="11" fill="#6b675e">…</text>
<text class="ts" x="600" y="125" font-size="10" fill="#6b675e">共 8 页</text>
<line class="fl" x1="320" y1="72" x2="148" y2="102" stroke="#6b675e" stroke-width="1.2" marker-end="url(#my1As4)"/>
<line class="flc" x1="345" y1="72" x2="345" y2="102" stroke="#b03a2e" stroke-width="1.8" marker-end="url(#my1Ac4)"/>
<line class="fl" x1="370" y1="72" x2="542" y2="102" stroke="#6b675e" stroke-width="1.2" marker-end="url(#my1As4)"/>
<rect class="bx" x="40" y="176" width="64" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="112" y="176" width="64" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="184" y="176" width="64" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx-q" x="313" y="176" width="64" height="30" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<rect class="bx" x="385" y="176" width="64" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="457" y="176" width="64" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<rect class="bx" x="529" y="176" width="64" height="30" rx="3" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="ts" x="278" y="195" font-size="11" fill="#6b675e">…</text>
<text class="ts" x="602" y="195" font-size="10" fill="#6b675e">6411 叶</text>
<line class="fl" x1="330" y1="136" x2="120" y2="172" stroke="#6b675e" stroke-width="1.2" marker-end="url(#my1As4)"/>
<line class="flc" x1="345" y1="136" x2="345" y2="172" stroke="#b03a2e" stroke-width="1.8" marker-end="url(#my1Ac4)"/>
<line class="fl" x1="360" y1="136" x2="560" y2="172" stroke="#6b675e" stroke-width="1.2" marker-end="url(#my1As4)"/>
<text class="ts" x="20" y="228" font-size="11" fill="#6b675e">内部段：根 + 中间页，点查路径，几乎常驻 buffer pool　·　叶子段：6411 页 × 156 行 = 一百万行，叶子间双向链</text>
<text class="ts" x="20" y="250" font-size="12" fill="#6b675e">扇出 ≈ 每页 800 指针：每多一层容量翻约 800 倍，树高 5 就能放约 5 亿行</text>
</svg>
</figure>

### 扇出：谁决定一页放多少指针

根页 8 个指针看着不多，这是**百万行 156 行/页的宽行**（每行 ~100 字节）的情形。扇出的公式是 `(16KiB − 页开销) / 条目大小`：

- 主键树的内部页条目 = 主键值 + 子页号。BIGINT 主键 ≈ 14 字节/条目 → 内部页约 1170 指针
- 二级索引的叶子条目 = 索引列 + 主键值 → 条目比主键叶子窄 → 每页条目更多

实测对照（users 表，百万行，含 13 字节 name 二级索引）：

| 树 | 叶子页 | 行/页 | 扇出证据 |
| --- | --- | --- | --- |
| PRIMARY（id, name, city, age） | 3437 | 291 | 中间层 5 页 |
| idx_name（name, id） | 1695 | 590 | 中间层 4 页 |

idx_name 的条目 = name + id，比主键行窄一半，**每页条目翻倍（291→590）**、树更瘦。这条性质是后面「覆盖索引为什么快」的一半答案：索引树越瘦，扫同样行数要摸的页越少。

### 顺序主键 vs 随机主键：写满才分 vs 写半就分

往两棵树里各插百万行：一张顺序 id，一张随机 id（同一批数，乘大素数打散）。叶子页的实测对比：

| | big_seq（顺序） | big_rand（随机） |
| --- | --- | --- |
| 每叶行数（avg/min/max） | 156.0 / 78 / 156 | 122.1 / 113 / 135 |
| 页填充率 | ~100% | ~69% |
| 叶子页数 | 6411 | 8192 |
| 文件大小 | 112MiB | 156MiB |
| 物理页序 = 键序？ | 是 | **否** |

两个数字两组结论：

**填充率。** 顺序插入永远落在最右叶子页，写满（156 行）才分裂、且是「追加式」分裂，每页都是满的；随机插入落在任意叶子页，页内空间剩约 15/16 时就得预防性分裂（给两个页各留一半），所以每页只装到七成。69% 对 100%，**同一百万行多花 39% 空间、多耗 39% 内存缓存**。这就是「主键要递增」的物理本质：UUID 主键不是「乱」所以慢，是**每页常年七成空**所以又胖又费缓存。

**物理页序。** 解析器沿叶子页的双向链走 big_rand，页号忽大忽小（NOT ascending）：叶子页在磁盘上的物理顺序与键序**无关**。页永远是「分配一个空页 → 链表插入」，从不搬家，只有指针在动。这回答了一个隐蔽的常见误解：**InnoDB 不会为了顺序去搬页**。顺序插入的表叶子页序恰好递增（分配序≈键序），是行为的结果，不是维护的成本；随机表的「乱」不额外花搬页的钱，只花填充率的代价。

两种填法：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 238" role="img" aria-label="顺序主键与随机主键的叶子页填充对照：顺序插入永远追加到最右页，写满 156 行才分裂，填充率接近 100%，文件 112MiB；随机插入落点随机，页内剩约十五分之一就预防性分裂各留一半，填充率约 69%，同样一百万行文件 156MiB，多花 39%" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">同样一百万行：写满才分 vs 写半就分</text>
<rect class="bx" x="20" y="40" width="300" height="128" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="170" y="60" text-anchor="middle" font-size="12" fill="#2b2a26">big_seq · 顺序主键</text>
<rect class="bx-q" x="40" y="72" width="60" height="60" rx="2" fill="#2b2a26" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="110" y="72" width="60" height="60" rx="2" fill="#2b2a26" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-q" x="180" y="72" width="60" height="60" rx="2" fill="#2b2a26" stroke="#2b2a26" stroke-width="1"/>
<rect class="bx-gone" x="250" y="72" width="60" height="60" rx="2" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="70" y="106" text-anchor="middle" font-size="9" fill="#f6f3ec">156 行</text>
<text class="ts" x="140" y="106" text-anchor="middle" font-size="9" fill="#f6f3ec">156 行</text>
<text class="ts" x="210" y="106" text-anchor="middle" font-size="9" fill="#f6f3ec">156 行</text>
<text class="ts" x="280" y="106" text-anchor="middle" font-size="9" fill="#6b675e">新页</text>
<text class="tc" x="170" y="152" text-anchor="middle" font-size="11" fill="#b03a2e">填充率 ~100% · 追加式分裂</text>
<rect class="bx" x="340" y="40" width="300" height="128" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="490" y="60" text-anchor="middle" font-size="12" fill="#2b2a26">big_rand · 随机主键</text>
<rect class="bx-q" x="360" y="72" width="60" height="60" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bar" x="361" y="91" width="58" height="40" fill="#6b675e"/>
<rect class="bx-q" x="430" y="72" width="60" height="60" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bar" x="431" y="95" width="58" height="36" fill="#6b675e"/>
<rect class="bx-q" x="500" y="72" width="60" height="60" rx="2" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<rect class="bar" x="501" y="88" width="58" height="43" fill="#6b675e"/>
<rect class="bx-gone" x="570" y="72" width="60" height="60" rx="2" fill="none" stroke="#a29d90" stroke-dasharray="4 3"/>
<text class="ts" x="490" y="152" text-anchor="middle" font-size="11" fill="#6b675e">剩约 1/16 就预防性分裂，两页各留一半</text>
<text class="tc" x="630" y="60" text-anchor="end" font-size="11" fill="#b03a2e">填充率 ~69%</text>
<rect class="bar" x="20" y="184" width="224" height="16" fill="#2b2a26"/>
<text class="onbar" x="28" y="196" font-size="10" fill="#f6f3ec">big_seq 112MiB · 6411 叶</text>
<rect class="bar" x="20" y="206" width="312" height="16" fill="#b03a2e"/>
<text class="onbar" x="28" y="218" font-size="10" fill="#f6f3ec">big_rand 156MiB · 8192 叶（+39%）</text>
<text class="ts" x="350" y="196" font-size="11" fill="#6b675e">条长 = 文件大小：多出的 39% 空间，</text>
<text class="ts" x="350" y="214" font-size="11" fill="#6b675e">也是 buffer pool 里多占的 39% 缓存</text>
</svg>
</figure>

### 段条目再次核对

big_seq 的叶子段：99 满区 + 43/64 半满区 + 32 碎片页 = 6411 页，与 `n_leaf_pages` 一致。big_rand 的段条目同法可读：8192 叶对应 127 满 + 1 半 + 32 碎片，同样成立。两张表，四次独立核对（磁盘段条目 vs 优化器统计，×2），全部对上。

## 聚簇与二级索引：一张表，两棵树

「聚簇索引」这个词的谜底现在只剩一层窗户纸：**主键树的叶子页就是数据本身**。行不住在某个「堆」里再被索引指着，行就住在主键树的叶子上，按主键序排列。这就是「索引即数据，数据即索引」：一张 InnoDB 表 = 主键 B+ 树 + 零或多棵二级索引树。

二级索引树的叶子条目 = 索引列值 + **主键值**（不是指向行的物理指针）。为什么存主键而不存页号指针？因为页会分裂、行会移动：**如果二级索引指向物理位置，每次页分裂都要连带更新所有二级索引**；存主键值，行的「地址」永远有效，代价是每次经二级索引找行都要回主键树再走一遍。这个取舍的名字你一定听过：**回表**。

实测两张树的登记信息（`INNODB_INDEXES`）：

```text
PRIMARY   INDEX_ID=171  N_FIELDS=6  PAGE_NO=4
idx_name  INDEX_ID=172  N_FIELDS=2  PAGE_NO=42
```

PRIMARY 的 N_FIELDS=6：4 个用户列 + **DB_TRX_ID + DB_ROLL_PTR** 两个隐藏列，每行自带的「最后修改我的事务号」和「指向上一版本的回滚指针」。它们是 MVCC 的地基，本系列第二篇的主角；今天只需记住：**它们就长在主键树的每一片叶子上**，这也是行必须住在主键树上的原因之一。

idx_name 的 N_FIELDS=2：name + id。二级索引天生携带主键，**「覆盖」是二级索引的天然属性**。

### 回表的成本：1717 倍

users 表百万行，同一批 10 万行的前缀范围查询，只换 SELECT 的列：

```sql
SELECT COUNT(name) FROM users WHERE name LIKE 'user00001%';  -- 只碰 idx_name
SELECT COUNT(age)  FROM users WHERE name LIKE 'user00001%';  -- 要回表取 age
```

EXPLAIN 的标注一句话分野：`Covering index range scan`（覆盖）vs `Index range scan ... （回表隐在其中）`。三组量具同时上：

| 量具 | COUNT(name) 覆盖 | COUNT(age) 回表 | 倍数 |
| --- | --- | --- | --- |
| EXPLAIN ANALYZE 实测耗时 | 38 ms | 156 ms | 4.1× |
| buffer pool 页读请求 | 233 | 400,189 | **1717×** |
| Handler_read_next | 100,004 | 100,000 | ≈1× |
| Handler_read_key | 13 | 1 | — |

四行数字四个结论：

**耗时只差 4 倍，页读差 1717 倍。** 因为回表的 40 万次页读几乎全部命中 buffer pool（测试表 92MiB，内存放得下）。**回表的真实代价被内存掩盖了，落到磁盘上才会现形**：表大于内存时，回表的随机页读会把 SSD 打出延迟尖刺，那时 4 倍会变成 40 倍。数字的戏剧性差别（1717 vs 4）本身就是一课。

**每行恰好多 ~4 次页读。** 400,189 − 233 ≈ 4 × 100,000：用户表树高 3，每次回表从二级索引拿到主键后，回主键树走「根→中间→叶」三次页访问 + 读到的叶子页本身 = 4 页。算术对上了结构。回表是每行重新走一遍树的活。

一次回表的四页：

<figure class="art-fig" data-pagefind-ignore>
<svg viewBox="0 0 660 254" role="img" aria-label="回表路径：二级索引 idx_name 的叶子条目只有 name 加主键 id；要 age 就得拿着 id 回主键树，走根页、中间页、叶子页取出整行，每行合计约 4 次页读；覆盖查询 233 次页读对比回表 40 万次，差 1717 倍" xmlns="http://www.w3.org/2000/svg" font-family="'Noto Serif SC','Songti SC','STSong',serif">
<defs>
<marker id="my1As6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-s" d="M0 0 L8 4 L0 8 Z" fill="#6b675e"/></marker>
<marker id="my1Ac6" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto"><path class="mk-c" d="M0 0 L8 4 L0 8 Z" fill="#b03a2e"/></marker>
</defs>
<text class="ts" x="20" y="24" font-size="12" fill="#6b675e">SELECT age … WHERE name LIKE …：每行都要走右边这棵树</text>
<rect class="bx" x="30" y="60" width="180" height="130" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="120" y="82" text-anchor="middle" font-size="12" fill="#2b2a26">idx_name 树</text>
<rect class="bx-q" x="50" y="94" width="140" height="30" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="120" y="113" text-anchor="middle" font-size="10" fill="#6b675e">中间层 · 4 页</text>
<rect class="bx-q" x="50" y="134" width="140" height="40" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.4"/>
<text class="ts" x="120" y="150" text-anchor="middle" font-size="10" fill="#6b675e">叶子条目 = name + id</text>
<text class="ts" x="120" y="166" text-anchor="middle" font-size="10" fill="#6b675e">没有 age</text>
<line class="flc" x1="190" y1="140" x2="286" y2="66" stroke="#b03a2e" stroke-width="1.8" marker-end="url(#my1Ac6)"/>
<text class="tc" x="214" y="100" font-size="10" fill="#b03a2e">拿着 id 回表</text>
<rect class="bx-q" x="290" y="44" width="120" height="30" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="350" y="63" text-anchor="middle" font-size="10" fill="#6b675e">PRIMARY 根页 ①</text>
<rect class="bx-q" x="290" y="104" width="120" height="30" rx="3" fill="#f6f3ec" stroke="#2b2a26" stroke-width="1.2"/>
<text class="ts" x="350" y="123" text-anchor="middle" font-size="10" fill="#6b675e">中间页 ②</text>
<rect class="bx-sick" x="290" y="164" width="120" height="34" rx="3" fill="#efe0d9" stroke="#b03a2e" stroke-width="1.4"/>
<text class="tc" x="350" y="185" text-anchor="middle" font-size="10" fill="#b03a2e">叶子页 ③④ 取整行</text>
<line class="fl" x1="350" y1="74" x2="350" y2="100" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As6)"/>
<line class="fl" x1="350" y1="134" x2="350" y2="160" stroke="#6b675e" stroke-width="1.4" marker-end="url(#my1As6)"/>
<rect class="bx" x="460" y="60" width="180" height="130" rx="4" fill="#ece9e2" stroke="#6b675e" stroke-width="1.2"/>
<text class="t" x="550" y="82" text-anchor="middle" font-size="12" fill="#2b2a26">两笔总账</text>
<text class="ts" x="472" y="106" font-size="10" fill="#6b675e">覆盖 COUNT(name)：233 页读</text>
<text class="tc" x="472" y="128" font-size="10" fill="#b03a2e">回表 COUNT(age)：400,189 页读</text>
<text class="ts" x="472" y="150" font-size="10" fill="#6b675e">≈ 每行 +4 页 × 10 万行</text>
<text class="ts" x="472" y="172" font-size="10" fill="#6b675e">页读差 1717 倍，耗时只差 4.1 倍</text>
<text class="ts" x="20" y="222" font-size="12" fill="#6b675e">耗时差距小是因为 40 万次页读几乎全命中 buffer pool：表大于内存时，</text>
<text class="ts" x="20" y="242" font-size="12" fill="#6b675e">回表的随机页读才会现出真实代价</text>
</svg>
</figure>

**Handler 计数器看不到回表。** Handler_read_next 两边都是 10 万（服务器层向存储引擎要了同样多的行），回表发生在引擎内部，server 层感知不到。**想在性能排查里看到回表，用 EXPLAIN 的 Covering 标注或 buffer pool 计数器，别指望 Handler**。这也是很多「明明加了索引还是慢」排查失效的原因：常用的量具对这个问题是盲的。

**覆盖索引是「免费」的。** idx_name 的叶子天然带主键值，`SELECT name` / `SELECT id` / `WHERE name` 打中的查询自动覆盖，一分钱额外索引不用建。要 age 也覆盖就得付出真金白银：把 age 加进索引（`INDEX(name, age)`），用写入放大和索引变胖换查询免回表。值不值，用上面的量具算，不靠背口诀。

## 四层坐标与两棵树

一行数据的完整住址是四层坐标：表空间 .ibd → 段（叶子段/内部段）→ 区（64 页）→ 页（16KiB）。空表 7 页是表空间自己的初始结构（两份元数据 + 位图 + 字典 + 根页 + 预留），页 2 的段条目在建表时就写好了四条。碎片区 32 页是省俭，独享区是成长，32MiB 后每次批发 4 个区，每一级都有源码常数与实测对上。

B+ 树矮靠的是扇出的算术：百万行树高 3，一千万行树高 4；16KiB 页 ÷ 条目大小 = 每页指针数，指数叠上去，五层树放五亿行。点查最多三页，根和中间页常驻内存，「走树」在热路径上约等于只读一个叶子页。

主键选择是在为叶子填充率投票：顺序主键每叶 156 行、物理页序递增；随机主键每叶 122 行（69%）、空间多耗 39%。「自增主键好」的物理本质是写满才分与写半就分的区别。

回表 = 每行重走一遍聚簇树：覆盖 233 页读 vs 回表 40 万页读（1717 倍），每行恰好 +4 页（树高 3 + 叶子本身）；耗时只差 4 倍是因为 buffer pool 兜住了随机读，表大于内存时才会现出真实代价。覆盖是二级索引的天然属性（叶子自带主键），要不要为它加宽索引，用页读数算，不背口诀。

两个独立来源对上数字，是理解落地的一刻：磁盘上的段条目（99 满区 + 43 页 + 32 碎片 = 6411）与优化器统计（n_leaf_pages = 6411）完全一致。InnoDB 的空间管理不是「大概如此」的文档描述；它可以逐字节核对。

这一篇拆的是静态结构；下一篇让数据动起来：PRIMARY 那 6 个字段里的 DB_TRX_ID 和 DB_ROLL_PTR，如何在 MVCC 里把一行串成版本链。
