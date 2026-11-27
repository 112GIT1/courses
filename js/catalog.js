/**
 * 课程表 · 课程目录（内置选课目录 + 纯逻辑）
 *
 * 目的：把「一门一门手填」变成「勾选批量添加」。
 *
 * 设计要点：
 *   1. **只读静态数据，不落库**。目录条目本身永远不进 localStorage：
 *      用户勾选后由 app.js 的 buildCourseRecord() 生成标准课程记录写进
 *      `course-manager:v1`，目录不新增任何存储键，也不改课程记录的结构。
 *   2. 纯函数 + 数据，零 DOM 依赖，可脱离浏览器单测（`node --check` / require 都能过）。
 *   3. 判重键 = 「课程名 + 星期 + 起始时间」，与「同名不同时段视为不同课」的
 *      产品约定一致（补齐星期或换时段后可以再加一门）。
 *   4. 时间冲突只做**统计**不做拦截：应用本身支持同星期重叠课并排显示，
 *      目录这边只负责在结果摘要里如实报「N 门与已有课程时间重叠」。
 *   5. 上课时间对齐 timetable.js 的节次表（两节连排：08:30–10:00 / 10:20–11:50 /
 *      14:30–16:00 / 16:20–17:50 / 18:30–20:00 / 20:20–21:50），
 *      勾选后直接落在课表网格的整节位置上，不会出现「压线」的碎块。
 *
 * 对外暴露 `window.CourseCatalog`（app.js 在解析期取走，与 CourseTimetable 同款约定）：
 *   —— 常量 ——
 *   CATEGORY_ALL / CATEGORIES / CATALOG
 *   —— 查找 ——
 *   findEntry(id)
 *   —— 判重 ——
 *   normalizeName(v) / duplicateKey(name, weekday, startTime)
 *   buildKeySet(courses) / isDuplicate(entry, keySet) / countAdded(entries, keySet)
 *   —— 过滤 ——
 *   matchQuery(entry, query) / filterEntries(entries, options) / countByCategory(entries)
 *   —— 时间 ——
 *   normalizeTimeString(v) / timeToMinutes(v) / isOverlap(...) / hasConflict(entry, courses)
 *   countConflicts(entries, courses)
 *
 * 说明：本模块**不做任何文案格式化**。星期文案与「08:30–10:00」统一由 app.js 的
 * WEEKDAY_LABELS + formatTimeRange 生成，全应用只有一份时间格式。
 */
(function (global) {
  'use strict';

  /* ==================== 一、常量 ==================== */

  /** 「全部」筛选值：分类 chips 的第一项 */
  var CATEGORY_ALL = '全部';

  /**
   * 分类清单。顺序 = 分类 chips 从左到右的顺序，
   * 大致按「公共课 → 专业课 → 技能课」排列，与真实选课目录的阅读习惯一致。
   * @type {Array<string>}
   */
  var CATEGORIES = ['通识', '思政', '专业基础', '专业选修', '语言', '体育', '实验', '艺术'];

  /** 判重键的分隔符：用不可能出现在课程名里的控制字符，避免「A|B」这类名字撞键 */
  var KEY_SEP = '\u0000';

  /**
   * 内置示例目录：40 门课，覆盖 8 个分类。
   * 字段固定 9 个：id / name / category / intro / weekday / startTime / endTime / teacher / place。
   * 时间点全部对齐节次表，见文件头注释。
   * @type {Array<{id: string, name: string, category: string, intro: string,
   *               weekday: number, startTime: string, endTime: string,
   *               teacher: string, place: string}>}
   */
  var CATALOG = [
    /* ---- 通识（6）---- */
    {
      id: 'cat-01',
      name: '大学生心理健康',
      category: '通识',
      intro: '认识情绪与压力，学会在集体生活里照顾好自己的心理状态',
      weekday: 3,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '张明远',
      place: '教二-201'
    },
    {
      id: 'cat-02',
      name: '自然科学概论',
      category: '通识',
      intro: '从星空到细胞，用通识视角理解科学方法如何解释日常现象',
      weekday: 1,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '李慧',
      place: '教三-108'
    },
    {
      id: 'cat-03',
      name: '创新创业基础',
      category: '通识',
      intro: '从发现身边问题到做出最小可行产品，完整走一遍创业流程',
      weekday: 4,
      startTime: '16:20',
      endTime: '17:50',
      teacher: '王海涛',
      place: '经管楼-302'
    },
    {
      id: 'cat-04',
      name: '学术写作与文献检索',
      category: '通识',
      intro: '学会查文献、读论文，写出格式规范的课程报告与引用',
      weekday: 2,
      startTime: '10:20',
      endTime: '11:50',
      teacher: '陈静',
      place: '图书馆-研讨间3'
    },
    {
      id: 'cat-05',
      name: '信息素养与数据思维',
      category: '通识',
      intro: '用表格和图表把结论讲清楚，避免被错误的统计口径误导',
      weekday: 5,
      startTime: '10:20',
      endTime: '11:50',
      teacher: '赵鹏',
      place: '计算机楼-机房2'
    },
    {
      id: 'cat-06',
      name: '大学生职业规划',
      category: '通识',
      intro: '梳理兴趣与能力，把大学四年排成一条可执行的成长路径',
      weekday: 5,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '孙倩',
      place: '就业中心-报告厅'
    },

    /* ---- 思政（4）---- */
    {
      id: 'cat-07',
      name: '思想道德与法治',
      category: '思政',
      intro: '结合真实案例讨论法律与道德的边界，思考公民的责任',
      weekday: 1,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '周文斌',
      place: '教一-101'
    },
    {
      id: 'cat-08',
      name: '马克思主义基本原理',
      category: '思政',
      intro: '读懂经典文本的核心概念，用辩证法分析现实社会问题',
      weekday: 2,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '郑亚楠',
      place: '教一-203'
    },
    {
      id: 'cat-09',
      name: '毛泽东思想和中国特色社会主义理论体系概论',
      category: '思政',
      intro: '梳理近百年中国道路的历史脉络与理论演进，注重联系现实',
      weekday: 4,
      startTime: '10:20',
      endTime: '11:50',
      teacher: '周文斌',
      place: '教一-101'
    },
    {
      id: 'cat-10',
      name: '形势与政策',
      category: '思政',
      intro: '围绕时事政策做专题讲解与课堂讨论，每两周集中上一次',
      weekday: 3,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '郑亚楠',
      place: '教一-203'
    },

    /* ---- 专业基础（6）---- */
    {
      id: 'cat-11',
      name: '线性代数 B',
      category: '专业基础',
      intro: '矩阵、行列式与特征值，为后续专业课打牢计算与证明基础',
      weekday: 1,
      startTime: '10:20',
      endTime: '11:50',
      teacher: '吴建国',
      place: '教四-301'
    },
    {
      id: 'cat-12',
      name: '高等数学 A（上）',
      category: '专业基础',
      intro: '极限、导数与积分的系统训练，配套每周一次习题课',
      weekday: 2,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '吴建国',
      place: '教四-301'
    },
    {
      id: 'cat-13',
      name: '大学物理（力学）',
      category: '专业基础',
      intro: '从牛顿定律到刚体转动，用微积分重建高中物理的图像',
      weekday: 3,
      startTime: '10:20',
      endTime: '11:50',
      teacher: '何伟',
      place: '教四-204'
    },
    {
      id: 'cat-14',
      name: '概率论与数理统计',
      category: '专业基础',
      intro: '随机变量、分布与参数估计，学会用数据说话的基本方法',
      weekday: 4,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '吴建国',
      place: '教四-301'
    },
    {
      id: 'cat-15',
      name: '程序设计基础（C 语言）',
      category: '专业基础',
      intro: '从变量与循环写到指针与文件，亲手完成 8 个小程序作业',
      weekday: 1,
      startTime: '16:20',
      endTime: '17:50',
      teacher: '林晓峰',
      place: '计算机楼-305'
    },
    {
      id: 'cat-16',
      name: '离散数学',
      category: '专业基础',
      intro: '集合、图论与逻辑演算，算法课和数据库课的共同前置知识',
      weekday: 5,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '林晓峰',
      place: '计算机楼-210'
    },

    /* ---- 专业选修（6）---- */
    {
      id: 'cat-17',
      name: '数据结构与算法',
      category: '专业选修',
      intro: '线性表、树与图的手写实现，附复杂度分析与经典算法题',
      weekday: 2,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '林晓峰',
      place: '计算机楼-305'
    },
    {
      id: 'cat-18',
      name: '计算机网络',
      category: '专业选修',
      intro: '从网线到 HTTP，逐层拆开数据在网络中的一次完整旅行',
      weekday: 3,
      startTime: '16:20',
      endTime: '17:50',
      teacher: '高翔',
      place: '计算机楼-401'
    },
    {
      id: 'cat-19',
      name: '操作系统',
      category: '专业选修',
      intro: '进程、内存与文件系统，配套四个可在本机运行的内核实验',
      weekday: 4,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '高翔',
      place: '计算机楼-401'
    },
    {
      id: 'cat-20',
      name: '数据库系统原理',
      category: '专业选修',
      intro: '关系模型、SQL 与事务，动手设计一个能跑起来的小系统',
      weekday: 5,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '徐丽',
      place: '计算机楼-机房2'
    },
    {
      id: 'cat-21',
      name: '人工智能导论',
      category: '专业选修',
      intro: '搜索、机器学习与神经网络的基本概念，不要求先修微积分',
      weekday: 3,
      startTime: '20:20',
      endTime: '21:50',
      teacher: '徐丽',
      place: '计算机楼-报告厅'
    },
    {
      id: 'cat-22',
      name: '数字信号处理',
      category: '专业选修',
      intro: '采样、傅里叶变换与滤波器设计，配套 MATLAB 上机练习',
      weekday: 2,
      startTime: '16:20',
      endTime: '17:50',
      teacher: '何伟',
      place: '教四-204'
    },

    /* ---- 语言（4）---- */
    {
      id: 'cat-23',
      name: '大学英语（三）',
      category: '语言',
      intro: '以学术话题为线索练听说读写，每单元一次小组展示',
      weekday: 1,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '刘思远',
      place: '外语楼-402'
    },
    {
      id: 'cat-24',
      name: '学术英语写作',
      category: '语言',
      intro: '从段落结构到论文摘要，逐稿修改自己的英文写作样本',
      weekday: 3,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '刘思远',
      place: '外语楼-402'
    },
    {
      id: 'cat-25',
      name: '日语零基础入门',
      category: '语言',
      intro: '五十音起步，一学期学完日常问候与自我介绍的基本表达',
      weekday: 4,
      startTime: '20:20',
      endTime: '21:50',
      teacher: '铃木彩',
      place: '外语楼-105'
    },
    {
      id: 'cat-26',
      name: '英语口语（外教）',
      category: '语言',
      intro: '小班圆桌讨论，围绕校园与社会话题做即兴表达训练',
      weekday: 5,
      startTime: '16:20',
      endTime: '17:50',
      teacher: '陈大卫',
      place: '外语楼-语音室1'
    },

    /* ---- 体育（4）---- */
    {
      id: 'cat-27',
      name: '羽毛球（初级）',
      category: '体育',
      intro: '握拍、发球与基本步法，最后三周安排班内循环赛',
      weekday: 1,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '马强',
      place: '体育馆-2号场'
    },
    {
      id: 'cat-28',
      name: '篮球（提高班）',
      category: '体育',
      intro: '需要一定基础，重点练战术配合与体能，每周一次对抗赛',
      weekday: 2,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '马强',
      place: '体育馆-篮球场'
    },
    {
      id: 'cat-29',
      name: '游泳（初级）',
      category: '体育',
      intro: '从熟悉水性到连续游完 50 米，不会游泳的同学优先选课',
      weekday: 3,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '韩雪',
      place: '游泳馆'
    },
    {
      id: 'cat-30',
      name: '太极拳',
      category: '体育',
      intro: '二十四式简化太极拳，动作舒缓，适合久坐后放松肩颈',
      weekday: 4,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '韩雪',
      place: '体育馆-形体房'
    },

    /* ---- 实验（5）---- */
    {
      id: 'cat-31',
      name: '大学物理实验',
      category: '实验',
      intro: '八个基础力学与电学实验，重点训练误差分析与数据处理',
      weekday: 1,
      startTime: '20:20',
      endTime: '21:50',
      teacher: '何伟',
      place: '实验楼-305'
    },
    {
      id: 'cat-32',
      name: '化学实验基础',
      category: '实验',
      intro: '从滴定到分光光度法，进实验室前必须完成安全考核',
      weekday: 2,
      startTime: '20:20',
      endTime: '21:50',
      teacher: '沈丽',
      place: '实验楼-108'
    },
    {
      id: 'cat-33',
      name: '电路与电子实验',
      category: '实验',
      intro: '用面包板搭出放大与滤波电路，每次课交一份实测报告',
      weekday: 3,
      startTime: '20:20',
      endTime: '21:50',
      teacher: '高翔',
      place: '实验楼-212'
    },
    {
      id: 'cat-34',
      name: '软件工程实训',
      category: '实验',
      intro: '四人一组做真实小项目，按周交付并相互做代码评审',
      weekday: 5,
      startTime: '20:20',
      endTime: '21:50',
      teacher: '徐丽',
      place: '计算机楼-305'
    },
    {
      id: 'cat-35',
      name: '生物观察实验',
      category: '实验',
      intro: '显微镜下的细胞与组织观察，训练规范的记录与绘图',
      weekday: 7,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '沈丽',
      place: '实验楼-108'
    },

    /* ---- 艺术（5）---- */
    {
      id: 'cat-36',
      name: '音乐鉴赏',
      category: '艺术',
      intro: '按体裁听西方与中国经典作品，学会描述自己的听感',
      weekday: 6,
      startTime: '08:30',
      endTime: '10:00',
      teacher: '罗静',
      place: '艺术楼-音乐厅'
    },
    {
      id: 'cat-37',
      name: '美术鉴赏',
      category: '艺术',
      intro: '走进美术馆看原作，理解构图、色彩与时代背景的关系',
      weekday: 6,
      startTime: '10:20',
      endTime: '11:50',
      teacher: '罗静',
      place: '艺术楼-展厅'
    },
    {
      id: 'cat-38',
      name: '摄影基础',
      category: '艺术',
      intro: '手机也能拍好照片：构图、用光与基础后期，双周交作业',
      weekday: 6,
      startTime: '14:30',
      endTime: '16:00',
      teacher: '韦然',
      place: '艺术楼-暗房'
    },
    {
      id: 'cat-39',
      name: '书法基础',
      category: '艺术',
      intro: '从执笔与临帖开始，一学期写完一幅完整的楷书作品',
      weekday: 6,
      startTime: '16:20',
      endTime: '17:50',
      teacher: '韦然',
      place: '艺术楼-302'
    },
    {
      id: 'cat-40',
      name: '影视鉴赏',
      category: '艺术',
      intro: '按导演与流派看经典影片，学会写有观点的短影评',
      weekday: 6,
      startTime: '18:30',
      endTime: '20:00',
      teacher: '罗静',
      place: '艺术楼-放映厅'
    }
  ];

  /* ==================== 二、工具函数 ==================== */

  /**
   * 数字补零到两位。
   * @param {number} value
   * @return {string}
   */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /**
   * 把任意输入规范化为 "HH:MM"，非法输入返回空串。
   * @param {*} value
   * @return {string}
   */
  function normalizeTimeString(value) {
    if (typeof value !== 'string') {
      return '';
    }
    var match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.replace(/\s+/g, ''));
    if (!match) {
      return '';
    }
    var hours = Number(match[1]);
    var minutes = Number(match[2]);
    if (!isFinite(hours) || !isFinite(minutes) || hours > 23 || minutes > 59) {
      return '';
    }
    return pad2(hours) + ':' + pad2(minutes);
  }

  /**
   * "HH:MM" 转分钟数，非法值返回 -1。
   * @param {string} value
   * @return {number}
   */
  function timeToMinutes(value) {
    var normalized = normalizeTimeString(value);
    if (!normalized) {
      return -1;
    }
    var parts = normalized.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  /**
   * 星期值兜底到 1-7。
   * @param {*} value
   * @return {number}
   */
  function normalizeWeekday(value) {
    var num = Number(value);
    if (!isFinite(num) || Math.floor(num) !== num || num < 1 || num > 7) {
      return 1;
    }
    return num;
  }

  /**
   * 课程名归一化（**判重与搜索共用这一个出口**，保证两侧同一把尺子）：
   *   1. NFKC：全角括号 / 全角字母数字 / 组合字符折叠成半角等价形式，
   *      「大学英语(三)」与「大学英语（三）」才会被判成同一门；
   *   2. 连续空白压成一个空格并去首尾，避免「线性代数  B」重复；
   *   3. 转小写，让「C 语言」与「c 语言」等价（只影响判重键，不影响展示）。
   * 注意 NFKC 只做「等价字符折叠」，不会把不同的汉字或不同的时段判成同一门。
   * @param {*} name
   * @return {string}
   */
  function normalizeName(name) {
    if (typeof name !== 'string') {
      return '';
    }
    var value = name;
    if (typeof value.normalize === 'function') {
      value = value.normalize('NFKC');
    }
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* ==================== 三、判重 ==================== */

  /**
   * 判重键：课程名 + 星期 + 起始时间。
   * 同名但不同时段视为不同课（可以各加一门），所以结束时间与教师都不进键。
   * @param {string} name
   * @param {number} weekday
   * @param {string} startTime
   * @return {string}
   */
  function duplicateKey(name, weekday, startTime) {
    return (
      normalizeName(name) +
      KEY_SEP +
      String(normalizeWeekday(weekday)) +
      KEY_SEP +
      normalizeTimeString(startTime)
    );
  }

  /**
   * 目录条目的判重键。
   * @param {Object} entry
   * @return {string}
   */
  function entryKey(entry) {
    if (!entry || typeof entry !== 'object') {
      return '';
    }
    return duplicateKey(entry.name, entry.weekday, entry.startTime);
  }

  /**
   * 课程记录的判重键（字段集与 buildCourseRecord 一致）。
   * @param {Object} course
   * @return {string}
   */
  function courseKey(course) {
    if (!course || typeof course !== 'object') {
      return '';
    }
    return duplicateKey(course.name, course.weekday, course.startTime);
  }

  /**
   * 用已有课程列表构建判重键集合。
   * @param {Array<Object>} courses
   * @return {Object<string, boolean>}
   */
  function buildKeySet(courses) {
    var keys = {};
    if (!Array.isArray(courses)) {
      return keys;
    }
    for (var i = 0; i < courses.length; i += 1) {
      var key = courseKey(courses[i]);
      if (key) {
        keys[key] = true;
      }
    }
    return keys;
  }

  /**
   * 目录条目是否已在课表里（同名 + 同星期 + 同起始时间）。
   * @param {Object} entry
   * @param {Object<string, boolean>} keySet
   * @return {boolean}
   */
  function isDuplicate(entry, keySet) {
    if (!entry || !keySet) {
      return false;
    }
    var key = entryKey(entry);
    return Boolean(key) && keySet[key] === true;
  }

  /**
   * 统计目录里已经添加过的条目数量（顶部「已添加 M 门」用）。
   * @param {Array<Object>} entries
   * @param {Object<string, boolean>} keySet
   * @return {number}
   */
  function countAdded(entries, keySet) {
    if (!Array.isArray(entries)) {
      return 0;
    }
    var total = 0;
    for (var i = 0; i < entries.length; i += 1) {
      if (isDuplicate(entries[i], keySet)) {
        total += 1;
      }
    }
    return total;
  }

  /* ==================== 四、查找 / 过滤 ==================== */

  /**
   * 按 id 查目录条目。
   * @param {string} id
   * @param {Array<Object>} [entries] 缺省为内置目录
   * @return {Object|null}
   */
  function findEntry(id, entries) {
    var list = Array.isArray(entries) ? entries : CATALOG;
    if (typeof id !== 'string' || !id) {
      return null;
    }
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) {
        return list[i];
      }
    }
    return null;
  }

  /**
   * 关键词匹配：课程名 / 分类 / 简介 / 教师，包含匹配、不区分大小写。
   * 空关键词恒命中。
   * @param {Object} entry
   * @param {string} query
   * @return {boolean}
   */
  function matchQuery(entry, query) {
    var needle = normalizeName(query);
    if (!needle) {
      return true;
    }
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    var fields = [entry.name, entry.category, entry.intro, entry.teacher];
    for (var i = 0; i < fields.length; i += 1) {
      // 两侧都用 normalizeName：全角/半角、大小写、多余空白都不影响命中
      var value = normalizeName(fields[i]);
      if (value && value.indexOf(needle) >= 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 按关键词 + 分类过滤目录，保持目录原有顺序。
   * @param {Array<Object>} entries
   * @param {{query?: string, category?: string}} [options]
   * @return {Array<Object>}
   */
  function filterEntries(entries, options) {
    var list = Array.isArray(entries) ? entries : CATALOG;
    var opts = options && typeof options === 'object' ? options : {};
    var query = typeof opts.query === 'string' ? opts.query : '';
    var category = typeof opts.category === 'string' && opts.category ? opts.category : CATEGORY_ALL;
    var result = [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (category !== CATEGORY_ALL && entry.category !== category) {
        continue;
      }
      if (!matchQuery(entry, query)) {
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  /**
   * 按分类统计条目数（只用于自测 / 文档核对，UI 不需要）。
   * @param {Array<Object>} [entries]
   * @return {Object<string, number>}
   */
  function countByCategory(entries) {
    var list = Array.isArray(entries) ? entries : CATALOG;
    var counts = {};
    for (var i = 0; i < CATEGORIES.length; i += 1) {
      counts[CATEGORIES[i]] = 0;
    }
    for (var j = 0; j < list.length; j += 1) {
      var category = list[j].category;
      if (typeof counts[category] === 'number') {
        counts[category] += 1;
      }
    }
    return counts;
  }

  /* ==================== 五、时间重叠（只统计，不拦截） ==================== */

  /**
   * 两个时间区间是否重叠（左闭右开 [start, end)）。
   * 任一区间非法时返回 false：宁可漏报，也不误报冲突。
   * @param {number} aStart
   * @param {number} aEnd
   * @param {number} bStart
   * @param {number} bEnd
   * @return {boolean}
   */
  function isOverlap(aStart, aEnd, bStart, bEnd) {
    if (aStart < 0 || aEnd < 0 || bStart < 0 || bEnd < 0) {
      return false;
    }
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * 单个条目是否与已有课程列表里的某一门时间冲突（同星期 + 区间重叠）。
   * @param {Object} entry 目录条目或任何带 weekday/startTime/endTime 的对象
   * @param {Array<Object>} courses
   * @return {boolean}
   */
  function hasConflict(entry, courses) {
    if (!entry || !Array.isArray(courses)) {
      return false;
    }
    var weekday = normalizeWeekday(entry.weekday);
    var start = timeToMinutes(entry.startTime);
    var end = timeToMinutes(entry.endTime);
    if (start < 0 || end <= start) {
      return false;
    }
    for (var i = 0; i < courses.length; i += 1) {
      var course = courses[i];
      if (!course || typeof course !== 'object') {
        continue;
      }
      if (normalizeWeekday(course.weekday) !== weekday) {
        continue;
      }
      var cStart = timeToMinutes(course.startTime);
      var cEnd = timeToMinutes(course.endTime);
      if (isOverlap(start, end, cStart, cEnd)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 统计一批条目里有多少条与已有课程时间冲突。
   * @param {Array<Object>} entries
   * @param {Array<Object>} courses
   * @return {number}
   */
  function countConflicts(entries, courses) {
    if (!Array.isArray(entries)) {
      return 0;
    }
    var total = 0;
    for (var i = 0; i < entries.length; i += 1) {
      if (hasConflict(entries[i], courses)) {
        total += 1;
      }
    }
    return total;
  }

  /* ==================== 六、导出 ==================== */

  global.CourseCatalog = {
    /* 常量 */
    CATEGORY_ALL: CATEGORY_ALL,
    CATEGORIES: CATEGORIES,
    CATALOG: CATALOG,

    /* 查找 / 过滤 */
    findEntry: findEntry,
    matchQuery: matchQuery,
    filterEntries: filterEntries,
    countByCategory: countByCategory,

    /* 判重 */
    normalizeName: normalizeName,
    duplicateKey: duplicateKey,
    buildKeySet: buildKeySet,
    isDuplicate: isDuplicate,
    countAdded: countAdded,

    /* 时间 */
    normalizeTimeString: normalizeTimeString,
    timeToMinutes: timeToMinutes,
    normalizeWeekday: normalizeWeekday,
    isOverlap: isOverlap,
    hasConflict: hasConflict,
    countConflicts: countConflicts
  };
})(typeof window !== 'undefined' ? window : globalThis);
