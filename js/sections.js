/**
 * 课程表 · 栏目数据层（旅游 / 当日任务 / 栏目配置）
 *
 * 设计要点：
 *   1. 三个独立 localStorage 键，**绝不**并入 `course-manager:v1`：
 *        course-manager:trips:v1      → {version:1, trips:[…]}
 *        course-manager:tasks:v1      → {version:1, tasks:[…]}
 *        course-manager:sections:v1   → {version:1, lastSection, dates, configs}
 *      课程键的写入是「整包重建」（app.js 的 writeStore 只放 {version, courses}），
 *      任何塞进同一键的非课程字段都会在下一次保存课程时被无声抹掉，因此必须分开。
 *   2. 版本策略与 swap-log.js 完全一致：
 *        · 读：version 缺失或 ≤1 正常解析；version > 1 **仍尽力解析已知字段**（前向兼容），
 *          只额外给一条提示，不阻断；
 *        · 写：永远写 version:1；
 *        · **读取阶段绝不回写同一个键**（避免一次打开就覆盖原始数据）；
 *        · JSON.parse 失败 → 返回空列表 + notice，并尽力把原文备份到 `…:corrupt-backup`
 *          （只在备份键为空时写一次，且备份失败不阻断主流程）。
 *   3. 日期一律用**本地日期字符串 `YYYY-MM-DD`**：
 *        · 禁止 `new Date('2026-11-26')` —— 它按 UTC 解析，UTC+N 时区会变成前一天；
 *        · 需要 Date 对象时一律 `new Date(y, m-1, d)`（见 dateToLocal）；
 *        · 需要「今天」时用 todayString()，**不用** `toISOString().slice(0,10)`。
 *   4. 全部是纯函数 + 一层存储适配，可在 Node 里直接单测（`require('./sections.js')`）。
 *
 * 对外暴露 `window.CourseSections`（app.js 在解析期取走，与 CourseTimetable 同款约定）：
 *   —— 键与常量 ——
 *   TRIPS_KEY / TASKS_KEY / CONFIG_KEY / STORE_VERSION / NOTE_MAX_LENGTH
 *   TITLE_MAX_TASK / TITLE_MAX_TRIP / MAX_DATE_DRIFT_DAYS
 *   TASK_GROUP_ORDER / TRIP_STATUS / TRIP_STATUS_LIST / TRIP_STATUS_LABELS / TASK_GROUPS
 *   —— 日期 ——
 *   normalizeDateString(v) / isDateString(v) / todayString() / shiftDate(date, delta)
 *   daysBetween(from, to) / weekdayCn(date) / formatDateLabel(date) / formatDateFullCn(date)
 *   relativeDayLabel(date, today) / monthLabelOf(date)
 *   —— 清洗与构造 ——
 *   sanitizeTask(raw) / sanitizeTrip(raw) / buildTaskRecord(values, opts) / buildTripRecord(values, opts)
 *   —— 存储 ——
 *   readTasks() / writeTasks(list) / readTrips() / writeTrips(list) / readConfig() / writeConfig(patch)
 *   —— 校验 ——
 *   validateTaskValues(values) / validateTripValues(values)
 *   —— 筛选 / 分组 / 格式化 ——
 *   filterTasksByDate(tasks, date) / tripCoversDate(trip, date)
 *   filterTripsByDate(trips, date)（只取覆盖该天的，排除 idea）
 *   filterTripsForView(trips, date)（列表用：date 为空 = 全部，idea 恒保留）
 *   groupTasks(tasks) / groupTrips(trips, today)
 *   formatTaskSide(task) / formatTaskTimeRange(task)
 *   tripEndDate(trip) / isTripEnded(trip, today)   ← 「已结束」的唯一判定（右列与组徽标共用）
 *   formatTripSide(trip, today) / formatTripSub(trip) / formatTripRange(trip)
 *   —— 工具 ——
 *   createId() / nextTaskId() / nextTripId()
 *
 * ReadResult  = {list: Array, notice: string|null, corrupt: boolean, future: boolean}
 * WriteResult = {ok: boolean, notice: string|null}
 */
(function (global) {
  'use strict';

  /* ==================== 一、常量 ==================== */

  /** 旅游存储键（与课程数据、日志完全分开） */
  var TRIPS_KEY = 'course-manager:trips:v1';
  /** 当日任务存储键 */
  var TASKS_KEY = 'course-manager:tasks:v1';
  /** 栏目配置存储键（lastSection / 选中日期 / 列表配置） */
  var CONFIG_KEY = 'course-manager:sections:v1';
  /** 损坏数据备份键（尽力而为，不参与展示） */
  var TRIPS_BACKUP_KEY = 'course-manager:trips:v1:corrupt-backup';
  var TASKS_BACKUP_KEY = 'course-manager:tasks:v1:corrupt-backup';
  var CONFIG_BACKUP_KEY = 'course-manager:sections:v1:corrupt-backup';
  /** 任务提醒的提前量：null = 不提醒，0 = 准时，5/10 = 提前 N 分钟 */
  var REMIND_OPTIONS = [
    { value: null, label: '不提醒' },
    { value: 0, label: '准时' },
    { value: 5, label: '提前 5 分钟' },
    { value: 10, label: '提前 10 分钟' }
  ];
  /** 合法提前量白名单，用于清洗脏值 */
  var REMIND_VALUES = [0, 5, 10];

  /** 结构版本：写入永远写 1 */
  var STORE_VERSION = 1;
  /** 备注最大长度（与 app.js 的 NOTE_MAX_LENGTH 同口径） */
  var NOTE_MAX_LENGTH = 500;
  /** 任务标题最大长度 */
  var TITLE_MAX_TASK = 80;
  /** 行程标题 / 目的地最大长度 */
  var TITLE_MAX_TRIP = 60;
  var DEST_MAX_TRIP = 60;
  /** 保存的日期距今天超过这个天数时回落为今天（避免长期不用后打开看到空白页） */
  var MAX_DATE_DRIFT_DAYS = 30;
  /** 一天的毫秒数（只用于差天计算，取整前先四舍五入吃掉夏令时的 ±1 小时） */
  var DAY_MS = 86400000;

  /** 星期文案：下标 = Date#getDay()（0 表示周日） */
  var WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 行程状态枚举 */
  var TRIP_STATUS = { IDEA: 'idea', PLANNED: 'planned', DONE: 'done' };
  /** 行程状态白名单 */
  var TRIP_STATUS_LIST = [TRIP_STATUS.IDEA, TRIP_STATUS.PLANNED, TRIP_STATUS.DONE];
  /** 行程状态中文（表单下拉与读屏播报共用一份） */
  var TRIP_STATUS_LABELS = {
    idea: '想法',
    planned: '计划中',
    done: '已完成'
  };

  /** 任务分组的固定顺序（不含已完成组；已完成永远置末） */
  var TASK_GROUP_ORDER = ['morning', 'afternoon', 'evening', 'allday'];
  /** 任务分组元数据：key → 中文标签 */
  var TASK_GROUPS = {
    morning: '上午',
    afternoon: '下午',
    evening: '晚上',
    allday: '未安排时间',
    done: '已完成'
  };
  /** 时段边界（分钟）：00:00–11:59 上午 / 12:00–17:59 下午 / 18:00–23:59 晚上 */
  var NOON_MINUTES = 12 * 60;
  var EVENING_MINUTES = 18 * 60;
  /** 列表配置的合法取值 */
  var LAYOUT_ROW = 'row';
  var LAYOUT_COLUMN = 'column';

  /* ==================== 二、小工具 ==================== */

  /**
   * 数字补零到两位。
   * @param {number} value
   * @return {string}
   */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /**
   * 取存储对象；浏览器禁用存储时返回 null（调用方降级为空数据 + 提示）。
   * @return {Storage|null}
   */
  function getStorage() {
    try {
      return global.localStorage || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * 生成唯一 id。
   *
   * 与 app.js:330 的 createId 等价（crypto.randomUUID → 时间戳 + 随机串）。
   * 这里独立实现一份而不是从 app.js 取：app.js 是单个 IIFE，没有对外暴露该函数，
   * 而 sections.js 必须能在 Node 里被单独 require 做纯函数单测。
   * @return {string}
   */
  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      try {
        return global.crypto.randomUUID();
      } catch (err) {
        /* 极少数环境不允许调用，降级处理 */
      }
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * 任务 id 生成入口（语义化别名，方便将来换成自增序号而不动调用方）。
   * @return {string}
   */
  function nextTaskId() {
    return createId();
  }

  /**
   * 行程 id 生成入口。
   * @return {string}
   */
  function nextTripId() {
    return createId();
  }

  /**
   * 把任意输入规范化为 "HH:MM"，非法输入返回空串（与 app.js normalizeTimeString 同口径）。
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
   * "HH:MM" → 分钟数，非法值返回 -1。
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
   * 截断字符串到指定长度（不报错，保住用户输入）。
   * @param {*} value
   * @param {number} max
   * @return {string}
   */
  function sliceTo(value, max) {
    var text = typeof value === 'string' ? value : '';
    return text.length > max ? text.slice(0, max) : text;
  }

  /**
   * 正数时间戳兜底。
   * @param {*} value
   * @param {number} fallback
   * @return {number}
   */
  function positiveNumber(value, fallback) {
    var num = Number(value);
    return isFinite(num) && num > 0 ? num : fallback;
  }

  /* ==================== 三、日期（本地日期字符串） ==================== */

  /**
   * 解析 `YYYY-MM-DD`，用本地 Date 回读校验（拒绝 2026-02-30 / 2026-2-3）。
   * @param {*} value
   * @return {{year: number, month: number, day: number}|null}
   */
  function parseDateParts(value) {
    if (typeof value !== 'string') {
      return null;
    }
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) {
      return null;
    }
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (!isFinite(year) || !isFinite(month) || !isFinite(day)) {
      return null;
    }
    if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    // 唯一的合法性判据：本地构造后回读三值必须相等（2026-02-30 → 3 月 2 日，不相等 → 非法）
    var probe = new Date(year, month - 1, day);
    if (
      probe.getFullYear() !== year ||
      probe.getMonth() !== month - 1 ||
      probe.getDate() !== day
    ) {
      return null;
    }
    return { year: year, month: month, day: day };
  }

  /**
   * 拼装 `YYYY-MM-DD`。
   * @param {number} year
   * @param {number} month 1-12
   * @param {number} day
   * @return {string}
   */
  function buildDateString(year, month, day) {
    return year + '-' + pad2(month) + '-' + pad2(day);
  }

  /**
   * 本地 Date（**绝不**用 new Date('YYYY-MM-DD')，那会按 UTC 解析）。
   * @param {{year: number, month: number, day: number}} parts
   * @return {Date}
   */
  function dateToLocal(parts) {
    return new Date(parts.year, parts.month - 1, parts.day);
  }

  /**
   * 规范化为本地日期字符串，非法返回空串。
   * @param {*} value
   * @return {string}
   */
  function normalizeDateString(value) {
    var parts = parseDateParts(value);
    return parts ? buildDateString(parts.year, parts.month, parts.day) : '';
  }

  /**
   * 是否是合法的本地日期字符串。
   * @param {*} value
   * @return {boolean}
   */
  function isDateString(value) {
    return Boolean(parseDateParts(value));
  }

  /**
   * 本地「今天」的日期字符串。
   * @return {string}
   */
  function todayString() {
    var now = new Date();
    return buildDateString(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /**
   * 日期加减天数（跨月 / 跨年 / 夏令时都安全）。
   * @param {string} dateString
   * @param {number} delta 正数向后，负数向前
   * @return {string} 非法输入返回空串
   */
  function shiftDate(dateString, delta) {
    var parts = parseDateParts(dateString);
    var days = Number(delta);
    if (!parts || !isFinite(days)) {
      return '';
    }
    var shifted = new Date(parts.year, parts.month - 1, parts.day + Math.round(days));
    return buildDateString(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
  }

  /**
   * 两个日期相差多少天（to - from）。
   * @param {string} fromDate
   * @param {string} toDate
   * @return {number} 任一非法返回 0
   */
  function daysBetween(fromDate, toDate) {
    var from = parseDateParts(fromDate);
    var to = parseDateParts(toDate);
    if (!from || !to) {
      return 0;
    }
    return Math.round((dateToLocal(to).getTime() - dateToLocal(from).getTime()) / DAY_MS);
  }

  /**
   * 星期中文（周三 / 周日）。
   * @param {string} dateString
   * @return {string} 非法返回空串
   */
  function weekdayCn(dateString) {
    var parts = parseDateParts(dateString);
    if (!parts) {
      return '';
    }
    return WEEKDAY_LABELS[dateToLocal(parts).getDay()];
  }

  /**
   * "11月27日"（副标题 / 文案用，紧凑无空格）。
   * @param {string} dateString
   * @return {string} 非法返回空串
   */
  function formatDateLabel(dateString) {
    var parts = parseDateParts(dateString);
    return parts ? parts.month + '月' + parts.day + '日' : '';
  }

  /**
   * "11 月 27 日"（空状态标题用，按设计稿带空格）。
   * @param {string} dateString
   * @return {string}
   */
  function formatDateFullCn(dateString) {
    var parts = parseDateParts(dateString);
    return parts ? parts.month + ' 月 ' + parts.day + ' 日' : '';
  }

  /**
   * 相对日期词：今天 / 明天 / 昨天 / 后天 / 前天 / N 天后 / N 天前。
   * 超过 ±7 天不显示相对词（此时"37 天后"没有信息量）。
   * @param {string} dateString
   * @param {string} today 参照日（不传则用本地今天）
   * @return {string}
   */
  function relativeDayLabel(dateString, today) {
    var base = normalizeDateString(today) || todayString();
    var target = normalizeDateString(dateString);
    if (!target) {
      return '';
    }
    var diff = daysBetween(base, target);
    if (diff === 0) {
      return '今天';
    }
    if (diff === 1) {
      return '明天';
    }
    if (diff === -1) {
      return '昨天';
    }
    if (diff === 2) {
      return '后天';
    }
    if (diff === -2) {
      return '前天';
    }
    var abs = Math.abs(diff);
    if (abs > 7) {
      return '';
    }
    return diff > 0 ? diff + ' 天后' : abs + ' 天前';
  }

  /**
   * 日期所在月份的键与标签。
   * @param {string} dateString
   * @return {{key: string, label: string}}
   */
  function monthLabelOf(dateString) {
    var parts = parseDateParts(dateString);
    if (!parts) {
      return { key: '', label: '' };
    }
    return {
      key: parts.year + '-' + pad2(parts.month),
      label: parts.year + '年' + parts.month + '月'
    };
  }

  /* ==================== 四、清洗与构造 ==================== */

  /**
   * 校验并修补单条任务，必填项缺失返回 null（调用方丢弃并计数）。
   * 逐条对照 app.js 的 sanitizeCourse：
   *   · 非对象 / 必填为空 → null
   *   · id 非法 → 重新生成
   *   · date 非法 → 整条丢弃（与 sanitizeCourse 对 name 的处理一致）
   *   · done 非布尔 → Boolean()
   *   · done === true 且 doneAt 非法 → 用 updatedAt 兜底（保证"已完成组"排序稳定）
   *   · done === false → doneAt 恒为 null（单一真相）
   *   · note 超长 → 截断；可选字段只有非空才写入，绝不凭空补 null
   * @param {*} raw
   * @return {Object|null}
   */
  /**
   * 把任意输入收敛成合法的提醒提前量。
   * @param {*} raw
   * @return {number|null} 0/5/10，或 null 表示不提醒
   */
  function normalizeRemindMinutes(raw) {
    if (raw === null || raw === undefined || raw === '' || raw === false) {
      return null;
    }
    var n = Number(raw);
    for (var i = 0; i < REMIND_VALUES.length; i += 1) {
      if (REMIND_VALUES[i] === n) {
        return n;
      }
    }
    return null;
  }

  /**
   * 计算一条任务这次提醒应当触发的时刻。
   * 没有开始时间、不提醒、或已完成的，一律返回 null。
   * @param {Object} task
   * @return {number|null} 毫秒时间戳
   */
  function taskReminderAt(task) {
    if (!task || typeof task !== 'object') {
      return null;
    }
    var minutes = normalizeRemindMinutes(task.remindMinutes);
    if (minutes === null) {
      return null;
    }
    var date = normalizeDateString(task.date);
    var start = normalizeTimeString(task.startTime);
    if (!date || !start) {
      return null;
    }
    var parts = date.split('-');
    var hm = start.split(':');
    var at = new Date(
      Number(parts[0]),
      Number(parts[1]) - 1,
      Number(parts[2]),
      Number(hm[0]),
      Number(hm[1]),
      0,
      0
    ).getTime();
    return at - minutes * 60000;
  }

  function sanitizeTask(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) {
      return null;
    }
    var date = normalizeDateString(raw.date);
    if (!date) {
      return null;
    }
    var now = Date.now();
    var updatedAt = positiveNumber(raw.updatedAt, now);
    var createdAt = positiveNumber(raw.createdAt, updatedAt);
    var done = Boolean(raw.done);
    var doneAt = null;
    if (done) {
      doneAt = positiveNumber(raw.doneAt, updatedAt);
    }
    var task = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
      title: sliceTo(title, TITLE_MAX_TASK),
      date: date,
      startTime: normalizeTimeString(raw.startTime),
      endTime: normalizeTimeString(raw.endTime),
      remindMinutes: null,
      done: done,
      createdAt: createdAt,
      updatedAt: updatedAt,
      doneAt: doneAt
    };
    // 提醒要有开始时间才有意义：缺字段时，有开始时间默认「准时」，没有则不提醒。
    if (task.startTime) {
      // 只有「字段缺失」才默认准时；显式 null 是用户选的「不提醒」，必须保留。
      task.remindMinutes =
        raw.remindMinutes === undefined ? 0 : normalizeRemindMinutes(raw.remindMinutes);
    }
    var note = sliceTo(typeof raw.note === 'string' ? raw.note.trim() : '', NOTE_MAX_LENGTH);
    if (note) {
      task.note = note;
    }
    return task;
  }

  /**
   * 校验并修补单条行程，必填项缺失返回 null。
   * @param {*} raw
   * @return {Object|null}
   */
  function sanitizeTrip(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) {
      return null;
    }
    // status 要在 startDate 校验之前算出来：`idea`（想法）是唯一允许"没定日期"的状态
    var status = TRIP_STATUS_LIST.indexOf(raw.status) >= 0 ? raw.status : TRIP_STATUS.PLANNED;
    var startDate = normalizeDateString(raw.startDate);
    if (!startDate && status !== TRIP_STATUS.IDEA) {
      // planned / done 缺出发日期仍然整条丢弃（与 sanitizeCourse 对 name 的处理一致）
      return null;
    }
    var now = Date.now();
    var updatedAt = positiveNumber(raw.updatedAt, now);
    var createdAt = positiveNumber(raw.createdAt, updatedAt);
    var trip = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
      title: sliceTo(title, TITLE_MAX_TRIP)
    };
    // startDate：只有 `idea` 允许为空，为空时**不写这个键**
    // （与"可选字段只有非空才写入"同口径，避免出现 startDate: "" 这种半状态）
    if (startDate) {
      trip.startDate = startDate;
    }
    trip.status = status;
    trip.createdAt = createdAt;
    trip.updatedAt = updatedAt;
    // endDate：没有出发日期时无意义（想法），或早于 startDate 时清洗为空串
    // （修复而不是丢弃，保住用户行程）
    var endDate = normalizeDateString(raw.endDate);
    if (!startDate || (endDate && endDate < startDate)) {
      endDate = '';
    }
    if (endDate) {
      trip.endDate = endDate;
    }
    var destination = sliceTo(
      typeof raw.destination === 'string' ? raw.destination.trim() : '',
      DEST_MAX_TRIP
    );
    if (destination) {
      trip.destination = destination;
    }
    var note = sliceTo(typeof raw.note === 'string' ? raw.note.trim() : '', NOTE_MAX_LENGTH);
    if (note) {
      trip.note = note;
    }
    return trip;
  }

  /**
   * 统一的「任务记录」构造入口：新增与编辑都走这里，避免两条写库路径分叉。
   * @param {Object} values 已校验的业务字段 {title, date, startTime, endTime, note}
   * @param {{id?: string, createdAt?: number, now?: number, done?: boolean, doneAt?: number|null}} [options]
   * @return {Object|null}
   */
  function buildTaskRecord(values, options) {
    var input = values && typeof values === 'object' ? values : {};
    var opts = options && typeof options === 'object' ? options : {};
    var now = positiveNumber(opts.now, Date.now());
    var done = Boolean(opts.done);
    return sanitizeTask({
      id: opts.id,
      title: input.title,
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      remindMinutes: input.remindMinutes,
      note: input.note,
      done: done,
      createdAt: opts.createdAt,
      updatedAt: now,
      doneAt: done ? positiveNumber(opts.doneAt, now) : null
    });
  }

  /**
   * 统一的「行程记录」构造入口。
   * @param {Object} values {title, destination, startDate, endDate, status, note}
   * @param {{id?: string, createdAt?: number, now?: number}} [options]
   * @return {Object|null}
   */
  function buildTripRecord(values, options) {
    var input = values && typeof values === 'object' ? values : {};
    var opts = options && typeof options === 'object' ? options : {};
    return sanitizeTrip({
      id: opts.id,
      title: input.title,
      destination: input.destination,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.status,
      note: input.note,
      createdAt: opts.createdAt,
      updatedAt: positiveNumber(opts.now, Date.now())
    });
  }

  /* ==================== 五、校验（纯函数，不触碰 DOM） ==================== */

  /**
   * 任务表单校验。
   * @param {Object} values
   * @return {Array<{field: string, message: string}>} field ∈ title|date|time|note
   */
  function validateTaskValues(values) {
    var input = values && typeof values === 'object' ? values : {};
    var issues = [];
    var title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) {
      issues.push({ field: 'title', message: '请填写任务标题' });
    } else if (title.length > TITLE_MAX_TASK) {
      issues.push({ field: 'title', message: '标题最多 ' + TITLE_MAX_TASK + ' 个字' });
    }
    if (!normalizeDateString(input.date)) {
      issues.push({ field: 'date', message: '请选择任务日期' });
    }
    var start = normalizeTimeString(input.startTime);
    var end = normalizeTimeString(input.endTime);
    if (start && end && timeToMinutes(end) <= timeToMinutes(start)) {
      issues.push({
        field: 'time',
        message: '结束时间需晚于开始时间（暂不支持跨零点任务）'
      });
    }
    var remind = normalizeRemindMinutes(input.remindMinutes);
    if (remind !== null && !start) {
      // 没有开始时间就没有「到点」，提醒必然落空，校验期挡住
      issues.push({ field: 'remind', message: '设置提醒需要先填开始时间' });
    }
    var note = typeof input.note === 'string' ? input.note : '';
    if (note.length > NOTE_MAX_LENGTH) {
      issues.push({ field: 'note', message: '备注最多 ' + NOTE_MAX_LENGTH + ' 个字' });
    }
    return issues;
  }

  /**
   * 行程表单校验。
   * @param {Object} values
   * @return {Array<{field: string, message: string}>} field ∈ title|startDate|endDate|note
   */
  /**
   * 行程表单校验。
   *
   * `startDate` 只在 `status !== 'idea'` 时必填：想法（`idea`）的语义就是"还没定下来"，
   * 强制要求日期等于让「想法清单」名不副实。想法若填了日期，仍要按格式校验，
   * 且 `endDate < startDate` 照旧报错。
   *
   * @param {Object} values
   * @param {{previousStatus?: string}} [options]
   *        `previousStatus` 用于区分同一个数据状态（planned + 无日期）下的两种提示：
   *        从「想法」升级成「计划中」时说"计划中的行程需要出发日期"，
   *        其它情况（新建计划中）说"请选择出发日期"。
   * @return {Array<{field: string, message: string}>} field ∈ title|startDate|endDate|note
   */
  function validateTripValues(values, options) {
    var input = values && typeof values === 'object' ? values : {};
    var opts = options && typeof options === 'object' ? options : {};
    var issues = [];
    var title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) {
      issues.push({ field: 'title', message: '请填写行程名称' });
    } else if (title.length > TITLE_MAX_TRIP) {
      issues.push({ field: 'title', message: '名称最多 ' + TITLE_MAX_TRIP + ' 个字' });
    }

    var status = TRIP_STATUS_LIST.indexOf(input.status) >= 0 ? input.status : TRIP_STATUS.PLANNED;
    var isIdea = status === TRIP_STATUS.IDEA;
    var rawStart = typeof input.startDate === 'string' ? input.startDate.trim() : '';
    var startDate = normalizeDateString(rawStart);
    if (!startDate) {
      if (isIdea) {
        // 想法允许留空；但"填了却非法"仍要报错，避免静默丢用户输入
        if (rawStart) {
          issues.push({ field: 'startDate', message: '出发日期格式不正确' });
        }
      } else {
        issues.push({
          field: 'startDate',
          message:
            opts.previousStatus === TRIP_STATUS.IDEA
              ? '计划中的行程需要出发日期'
              : '请选择出发日期'
        });
      }
    }

    var endDate = normalizeDateString(input.endDate);
    if (endDate && !startDate && !isIdea) {
      issues.push({ field: 'endDate', message: '请先选择出发日期，再填返回日期' });
    }
    if (startDate && endDate && endDate < startDate) {
      issues.push({ field: 'endDate', message: '返回日期不能早于出发日期' });
    }
    var note = typeof input.note === 'string' ? input.note : '';
    if (note.length > NOTE_MAX_LENGTH) {
      issues.push({ field: 'note', message: '备注最多 ' + NOTE_MAX_LENGTH + ' 个字' });
    }
    return issues;
  }

  /* ==================== 六、存储 ==================== */

  /**
   * 尽力把损坏的原文备份到旁路键（只在备份键为空时写，失败不阻断）。
   * @param {string} key
   * @param {string} backupKey
   */
  function backupCorrupt(key, backupKey) {
    var storage = getStorage();
    if (!storage) {
      return;
    }
    try {
      if (storage.getItem(backupKey)) {
        // 已经备份过一次：保留最早的那份原始数据，不再覆盖
        return;
      }
      var raw = storage.getItem(key);
      if (raw) {
        storage.setItem(backupKey, raw);
      }
    } catch (err) {
      /* 备份失败不影响"降级为空列表"这条主路径 */
    }
  }

  /**
   * 通用读取：try/catch + 结构校验 + 逐条清洗，**永不回写原键**。
   * @param {{key: string, backupKey: string, field: string, label: string, sanitize: Function}} spec
   * @return {{list: Array<Object>, notice: string|null, corrupt: boolean, future: boolean}}
   */
  function readCollection(spec) {
    var storage = getStorage();
    if (!storage) {
      return {
        list: [],
        notice: '当前浏览器禁止访问本地存储，' + spec.label + '可以查看但无法保存。',
        corrupt: false,
        future: false
      };
    }
    var raw = null;
    try {
      raw = storage.getItem(spec.key);
    } catch (err) {
      return {
        list: [],
        notice: '当前浏览器禁止访问本地存储，' + spec.label + '可以查看但无法保存。',
        corrupt: false,
        future: false
      };
    }
    if (!raw) {
      return { list: [], notice: null, corrupt: false, future: false };
    }

    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      backupCorrupt(spec.key, spec.backupKey);
      return {
        list: [],
        notice: spec.label + '数据已损坏，本次显示为空（原始内容已尝试备份）。',
        corrupt: true,
        future: false
      };
    }

    // 兼容两种结构：{version, <field>} 或直接是数组
    var source = null;
    var future = false;
    if (Array.isArray(parsed)) {
      source = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed[spec.field])) {
      source = parsed[spec.field];
      var version = Number(parsed.version);
      if (isFinite(version) && version > STORE_VERSION) {
        future = true;
      }
    }
    if (!source) {
      backupCorrupt(spec.key, spec.backupKey);
      return {
        list: [],
        notice: spec.label + '数据格式无法识别，本次显示为空（原始内容已尝试备份）。',
        corrupt: true,
        future: false
      };
    }

    var list = [];
    var dropped = 0;
    for (var i = 0; i < source.length; i += 1) {
      var item = spec.sanitize(source[i]);
      if (item) {
        list.push(item);
      } else {
        dropped += 1;
      }
    }

    var notice = null;
    if (dropped > 0) {
      notice = '有 ' + dropped + ' 条' + spec.label + '记录格式不完整，已忽略（原始数据未被覆盖）。';
    }
    if (future) {
      var futureNotice = spec.label + '数据由更高版本创建，已尽力读取已知字段。';
      notice = notice ? notice + futureNotice : futureNotice;
    }
    return { list: list, notice: notice, corrupt: false, future: future };
  }

  /**
   * 通用写入（整包重建，永远写 version:1）。
   * @param {{key: string, field: string, label: string}} spec
   * @param {Array<Object>} list
   * @return {{ok: boolean, notice: string|null}}
   */
  function writeCollection(spec, list) {
    var storage = getStorage();
    if (!storage) {
      return { ok: false, notice: '当前浏览器禁止访问本地存储，' + spec.label + '无法保存。' };
    }
    var payload = { version: STORE_VERSION };
    payload[spec.field] = Array.isArray(list) ? list : [];
    try {
      storage.setItem(spec.key, JSON.stringify(payload));
      return { ok: true, notice: null };
    } catch (err) {
      return {
        ok: false,
        notice: spec.label + '写入失败（可能空间已满或被禁用），本次修改未能保存。'
      };
    }
  }

  /**
   * 读取任务列表。
   * @return {{list: Array<Object>, notice: string|null, corrupt: boolean, future: boolean}}
   */
  function readTasks() {
    return readCollection({
      key: TASKS_KEY,
      backupKey: TASKS_BACKUP_KEY,
      field: 'tasks',
      label: '任务',
      sanitize: sanitizeTask
    });
  }

  /**
   * 写入任务列表。
   * @param {Array<Object>} list
   * @return {{ok: boolean, notice: string|null}}
   */
  function writeTasks(list) {
    var clean = [];
    var source = Array.isArray(list) ? list : [];
    for (var i = 0; i < source.length; i += 1) {
      var task = sanitizeTask(source[i]);
      if (task) {
        clean.push(task);
      }
    }
    return writeCollection({ key: TASKS_KEY, field: 'tasks', label: '任务' }, clean);
  }

  /**
   * 读取行程列表。
   * @return {{list: Array<Object>, notice: string|null, corrupt: boolean, future: boolean}}
   */
  function readTrips() {
    return readCollection({
      key: TRIPS_KEY,
      backupKey: TRIPS_BACKUP_KEY,
      field: 'trips',
      label: '行程',
      sanitize: sanitizeTrip
    });
  }

  /**
   * 写入行程列表。
   * @param {Array<Object>} list
   * @return {{ok: boolean, notice: string|null}}
   */
  function writeTrips(list) {
    var clean = [];
    var source = Array.isArray(list) ? list : [];
    for (var i = 0; i < source.length; i += 1) {
      var trip = sanitizeTrip(source[i]);
      if (trip) {
        clean.push(trip);
      }
    }
    return writeCollection({ key: TRIPS_KEY, field: 'trips', label: '行程' }, clean);
  }

  /**
   * 单个列表栏目的默认配置（所有布尔缺省 = true：默认全显示）。
   * @return {{layout: string, showMeta: boolean, showSide: boolean, showAvatar: boolean, showGroupTitle: boolean}}
   */
  function defaultSectionConfig() {
    return {
      layout: LAYOUT_ROW,
      showMeta: true,
      showSide: true,
      showAvatar: true,
      showGroupTitle: true
    };
  }

  /**
   * 栏目配置的默认值。
   * @return {{lastSection: string, dates: {tasks: string, trips: string}, configs: Object}}
   */
  function defaultConfig() {
    return {
      lastSection: 'grid',
      dates: { tasks: '', trips: '' },
      configs: {
        list: defaultSectionConfig(),
        trips: defaultSectionConfig(),
        tasks: defaultSectionConfig()
      }
    };
  }

  /**
   * 清洗单个列表配置：未知字段丢弃，布尔缺省 true，layout 非法回落 row。
   * @param {*} raw
   * @return {Object}
   */
  function sanitizeSectionConfig(raw) {
    var base = defaultSectionConfig();
    if (!raw || typeof raw !== 'object') {
      return base;
    }
    base.layout = raw.layout === LAYOUT_COLUMN ? LAYOUT_COLUMN : LAYOUT_ROW;
    base.showMeta = raw.showMeta !== false;
    base.showSide = raw.showSide !== false;
    base.showAvatar = raw.showAvatar !== false;
    base.showGroupTitle = raw.showGroupTitle !== false;
    return base;
  }

  /**
   * 读取栏目配置。任何异常都降级为默认值，**不回写原键**。
   * @return {{lastSection: string, dates: {tasks: string, trips: string}, configs: Object,
   *           notice: string|null, corrupt: boolean, future: boolean}}
   */
  function readConfig() {
    var base = defaultConfig();
    var storage = getStorage();
    if (!storage) {
      return {
        lastSection: base.lastSection,
        dates: base.dates,
        configs: base.configs,
        notice: '当前浏览器禁止访问本地存储，栏目设置无法保存。',
        corrupt: false,
        future: false
      };
    }
    var raw = null;
    try {
      raw = storage.getItem(CONFIG_KEY);
    } catch (err) {
      return {
        lastSection: base.lastSection,
        dates: base.dates,
        configs: base.configs,
        notice: '当前浏览器禁止访问本地存储，栏目设置无法保存。',
        corrupt: false,
        future: false
      };
    }
    if (!raw) {
      return {
        lastSection: base.lastSection,
        dates: base.dates,
        configs: base.configs,
        notice: null,
        corrupt: false,
        future: false
      };
    }

    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      backupCorrupt(CONFIG_KEY, CONFIG_BACKUP_KEY);
      return {
        lastSection: base.lastSection,
        dates: base.dates,
        configs: base.configs,
        notice: '栏目设置已损坏，已回到默认设置（原始内容已尝试备份）。',
        corrupt: true,
        future: false
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      backupCorrupt(CONFIG_KEY, CONFIG_BACKUP_KEY);
      return {
        lastSection: base.lastSection,
        dates: base.dates,
        configs: base.configs,
        notice: '栏目设置格式无法识别，已回到默认设置（原始内容已尝试备份）。',
        corrupt: true,
        future: false
      };
    }

    var future = false;
    var version = Number(parsed.version);
    if (isFinite(version) && version > STORE_VERSION) {
      future = true;
    }

    var lastSection = typeof parsed.lastSection === 'string' ? parsed.lastSection : '';
    var dates = parsed.dates && typeof parsed.dates === 'object' ? parsed.dates : {};
    var configs = parsed.configs && typeof parsed.configs === 'object' ? parsed.configs : {};
    return {
      lastSection: lastSection || base.lastSection,
      dates: {
        // tasks 的选中日期必须合法；trips 的 '' 表示"全部"，是合法值
        tasks: normalizeDateString(dates.tasks),
        trips: normalizeDateString(dates.trips)
      },
      configs: {
        list: sanitizeSectionConfig(configs.list),
        trips: sanitizeSectionConfig(configs.trips),
        tasks: sanitizeSectionConfig(configs.tasks)
      },
      notice: future ? '栏目设置由更高版本创建，已尽力读取已知字段。' : null,
      corrupt: false,
      future: future
    };
  }

  /**
   * 写入栏目配置（读-改-写，只覆盖 patch 里出现的字段）。
   *
   * patch 支持：`{lastSection, dates:{tasks,trips}, configs:{list|trips|tasks}}`。
   * 这是**写路径**，因此允许读一次现状用于合并；readConfig 本身从不回写。
   * @param {Object} patch
   * @return {{ok: boolean, notice: string|null}}
   */
  function writeConfig(patch) {
    var storage = getStorage();
    if (!storage) {
      return { ok: false, notice: '当前浏览器禁止访问本地存储，栏目设置无法保存。' };
    }
    var current = readConfig();
    var next = {
      lastSection: current.lastSection,
      dates: { tasks: current.dates.tasks, trips: current.dates.trips },
      configs: {
        list: current.configs.list,
        trips: current.configs.trips,
        tasks: current.configs.tasks
      }
    };
    var input = patch && typeof patch === 'object' ? patch : {};

    if (typeof input.lastSection === 'string' && input.lastSection) {
      next.lastSection = input.lastSection;
    }
    if (input.dates && typeof input.dates === 'object') {
      if (Object.prototype.hasOwnProperty.call(input.dates, 'tasks')) {
        next.dates.tasks = normalizeDateString(input.dates.tasks);
      }
      if (Object.prototype.hasOwnProperty.call(input.dates, 'trips')) {
        next.dates.trips = normalizeDateString(input.dates.trips);
      }
    }
    if (input.configs && typeof input.configs === 'object') {
      var keys = ['list', 'trips', 'tasks'];
      for (var i = 0; i < keys.length; i += 1) {
        if (input.configs[keys[i]]) {
          next.configs[keys[i]] = sanitizeSectionConfig(input.configs[keys[i]]);
        }
      }
    }

    try {
      storage.setItem(
        CONFIG_KEY,
        JSON.stringify({
          version: STORE_VERSION,
          lastSection: next.lastSection,
          dates: next.dates,
          configs: next.configs
        })
      );
      return { ok: true, notice: null };
    } catch (err) {
      return {
        ok: false,
        notice: '栏目设置写入失败（可能空间已满或被禁用），本次修改未能保存。'
      };
    }
  }

  /* ==================== 七、筛选 ==================== */

  /**
   * 取某一天的任务（日期字符串相等即命中）。
   * @param {Array<Object>} tasks
   * @param {string} date
   * @return {Array<Object>}
   */
  function filterTasksByDate(tasks, date) {
    var target = normalizeDateString(date);
    var list = Array.isArray(tasks) ? tasks : [];
    if (!target) {
      return [];
    }
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].date === target) {
        out.push(list[i]);
      }
    }
    return out;
  }

  /**
   * 行程的日期区间是否覆盖某天。
   * 无 endDate = 仅当天；字符串比较即时间序（跨年安全：'2026-12-31' < '2027-01-01'）。
   * @param {Object} trip
   * @param {string} date
   * @return {boolean}
   */
  function tripCoversDate(trip, date) {
    var target = normalizeDateString(date);
    if (!trip || !target) {
      return false;
    }
    var start = normalizeDateString(trip.startDate);
    if (!start) {
      return false;
    }
    var end = normalizeDateString(trip.endDate);
    if (!end) {
      return start === target;
    }
    return start <= target && target <= end;
  }

  /**
   * 取覆盖某天的行程。`idea` 状态不参与日期筛选（无确定日期）。
   * @param {Array<Object>} trips
   * @param {string} date
   * @return {Array<Object>}
   */
  function filterTripsByDate(trips, date) {
    var list = Array.isArray(trips) ? trips : [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var trip = list[i];
      if (!trip || trip.status === TRIP_STATUS.IDEA) {
        continue;
      }
      if (tripCoversDate(trip, date)) {
        out.push(trip);
      }
    }
    return out;
  }

  /**
   * 列表视图用的行程筛选：日期为空 = 全部；否则「区间覆盖该天」，但
   * **`idea` 永远保留**（想法没有确定日期，不该因为选了某天就消失）。
   * @param {Array<Object>} trips
   * @param {string} date 空串 / 非法 → 返回全部
   * @return {Array<Object>}
   */
  function filterTripsForView(trips, date) {
    var list = Array.isArray(trips) ? trips : [];
    var target = normalizeDateString(date);
    if (!target) {
      return list.slice();
    }
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var trip = list[i];
      if (!trip) {
        continue;
      }
      if (trip.status === TRIP_STATUS.IDEA) {
        out.push(trip);
        continue;
      }
      if (tripCoversDate(trip, target)) {
        out.push(trip);
      }
    }
    return out;
  }

  /* ==================== 八、分组 ==================== */

  /**
   * 任务分组的时段键。
   * @param {Object} task
   * @return {string} morning|afternoon|evening|allday
   */
  function taskSlotKey(task) {
    var minute = timeToMinutes(task && task.startTime);
    if (minute < 0) {
      return 'allday';
    }
    if (minute < NOON_MINUTES) {
      return 'morning';
    }
    if (minute < EVENING_MINUTES) {
      return 'afternoon';
    }
    return 'evening';
  }

  /**
   * 按「上午 → 下午 → 晚上 → 未安排时间 → 已完成」分组，空组不返回。
   *
   * 组内排序：有时段 → startTime 升序 → createdAt 升序；未安排 → createdAt 升序；
   * 已完成 → doneAt 降序（刚完成的在上）。
   * @param {Array<Object>} tasks
   * @return {Array<{key: string, label: string, items: Array<Object>}>}
   */
  function groupTasks(tasks) {
    var list = Array.isArray(tasks) ? tasks : [];
    var buckets = { morning: [], afternoon: [], evening: [], allday: [], done: [] };
    for (var i = 0; i < list.length; i += 1) {
      var task = list[i];
      if (!task) {
        continue;
      }
      if (task.done) {
        buckets.done.push(task);
      } else {
        buckets[taskSlotKey(task)].push(task);
      }
    }

    var timedSort = function (a, b) {
      var diff = timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
      if (diff !== 0) {
        return diff;
      }
      return Number(a.createdAt) - Number(b.createdAt);
    };
    var createdSort = function (a, b) {
      return Number(a.createdAt) - Number(b.createdAt);
    };
    var doneSort = function (a, b) {
      var diff = Number(b.doneAt || 0) - Number(a.doneAt || 0);
      if (diff !== 0) {
        return diff;
      }
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    };

    buckets.morning.sort(timedSort);
    buckets.afternoon.sort(timedSort);
    buckets.evening.sort(timedSort);
    buckets.allday.sort(createdSort);
    buckets.done.sort(doneSort);

    var groups = [];
    for (var k = 0; k < TASK_GROUP_ORDER.length; k += 1) {
      var key = TASK_GROUP_ORDER[k];
      if (buckets[key].length > 0) {
        groups.push({ key: key, label: TASK_GROUPS[key], items: buckets[key] });
      }
    }
    // 已完成独立成组并永远置末
    if (buckets.done.length > 0) {
      groups.push({ key: 'done', label: TASK_GROUPS.done, items: buckets.done });
    }
    return groups;
  }

  /**
   * 行程分组：按 startDate 的月份升序，`idea` 归入末尾「想法清单」。
   * @param {Array<Object>} trips
   * @param {string} [today]
   * @return {Array<{key: string, label: string, items: Array<Object>, ended: boolean}>}
   */
  function groupTrips(trips, today) {
    var list = Array.isArray(trips) ? trips : [];
    var base = normalizeDateString(today) || todayString();
    var currentMonth = base.slice(0, 7);
    var ideas = [];
    var buckets = {};
    var monthKeys = [];
    for (var i = 0; i < list.length; i += 1) {
      var trip = list[i];
      if (!trip) {
        continue;
      }
      if (trip.status === TRIP_STATUS.IDEA) {
        ideas.push(trip);
        continue;
      }
      var month = monthLabelOf(trip.startDate);
      if (!month.key) {
        // 兜底：没有出发日期的行程一律进「想法清单」。
        // 正常数据里只有 idea 会缺日期（sanitizeTrip 已保证），但宁可归到一个
        // 语义相近的组，也不要让一条已存下来的行程凭空消失。
        ideas.push(trip);
        continue;
      }
      if (!buckets[month.key]) {
        buckets[month.key] = [];
        monthKeys.push(month.key);
      }
      buckets[month.key].push(trip);
    }

    monthKeys.sort();
    var groups = [];
    for (var k = 0; k < monthKeys.length; k += 1) {
      var key = monthKeys[k];
      var items = buckets[key];
      items.sort(function (a, b) {
        if (a.startDate !== b.startDate) {
          return a.startDate < b.startDate ? -1 : 1;
        }
        return Number(a.createdAt) - Number(b.createdAt);
      });
      var parts = key.split('-');
      // 组徽标与右列共用 isTripEnded()（P2-1 的成因就是两处各判一套）。
      // 语义：**整月已过去**，或 **组内每一条都已结束** 才标「已结束」。
      // 用 every 而不是 some：同月里还有待出行的行程时，标"已结束"是在说假话。
      var allEnded = items.length > 0;
      for (var d = 0; d < items.length; d += 1) {
        if (!isTripEnded(items[d], base)) {
          allEnded = false;
          break;
        }
      }
      groups.push({
        key: key,
        label: Number(parts[0]) + '年' + Number(parts[1]) + '月',
        items: items,
        ended: key < currentMonth || allEnded
      });
    }

    if (ideas.length > 0) {
      ideas.sort(function (a, b) {
        return Number(b.createdAt) - Number(a.createdAt);
      });
      groups.push({ key: 'idea', label: '想法清单', items: ideas, ended: false });
    }
    return groups;
  }

  /* ==================== 九、展示格式化 ==================== */

  /**
   * 任务右侧列：有开始时间显示时间，没有显示「全天」。
   * @param {Object} task
   * @return {string}
   */
  function formatTaskSide(task) {
    var start = normalizeTimeString(task && task.startTime);
    return start || '全天';
  }

  /**
   * 任务时间段文案（08:30–09:00），两端都有才返回。
   * @param {Object} task
   * @return {string}
   */
  function formatTaskTimeRange(task) {
    var start = normalizeTimeString(task && task.startTime);
    var end = normalizeTimeString(task && task.endTime);
    if (start && end) {
      return start + '–' + end;
    }
    return start;
  }

  /**
   * 行程的"结束日"：有 endDate 用它，否则用 startDate（单日行程）。
   * @param {Object} trip
   * @return {string} 非法 / 缺失返回空串
   */
  function tripEndDate(trip) {
    if (!trip) {
      return '';
    }
    return normalizeDateString(trip.endDate) || normalizeDateString(trip.startDate) || '';
  }

  /**
   * 「已结束」的**唯一判定**。
   *
   * 右列文案与月份组的「已结束」徽标必须共用这一个函数 —— 各写一套正是 P2-1
   * （同一行说结束了、同一组说还没到）的成因。
   *
   * 判定：`status === 'done'`（手动标完成）**或** `(endDate || startDate) < 今天`。
   * `idea` 不是"结束"，是另一类（无确定日期），由调用方单独处理。
   * @param {Object} trip
   * @param {string} [today] 参照日（不传则用本地今天）
   * @return {boolean}
   */
  function isTripEnded(trip, today) {
    if (!trip) {
      return false;
    }
    if (trip.status === TRIP_STATUS.DONE) {
      return true;
    }
    var base = normalizeDateString(today) || todayString();
    var end = tripEndDate(trip);
    if (!end) {
      return false;
    }
    return end < base;
  }

  /**
   * 行程右侧列：进行中 / 还剩 N 天 / 已结束 / 想法。
   * @param {Object} trip
   * @param {string} [today]
   * @return {string}
   */
  function formatTripSide(trip, today) {
    if (!trip) {
      return '';
    }
    if (trip.status === TRIP_STATUS.IDEA) {
      return '想法';
    }
    var base = normalizeDateString(today) || todayString();
    var start = normalizeDateString(trip.startDate);
    if (!start) {
      return '';
    }
    if (isTripEnded(trip, base)) {
      return '已结束';
    }
    if (base < start) {
      var days = daysBetween(base, start);
      return days > 0 ? '还剩 ' + days + ' 天' : '';
    }
    return '进行中';
  }

  /**
   * 行程副标题：目的地（选填）。
   * @param {Object} trip
   * @return {string}
   */
  /**
   * 行程副标题：目的地（选填）。
   * 没有出发日期（只可能是 `idea` 想法）时以「日期待定」开头 —— 副标题是行内
   * **唯一**会显示时间线索的位置，不能留空让人以为是数据丢了。
   * @param {Object} trip
   * @return {string}
   */
  function formatTripSub(trip) {
    if (!trip) {
      return '';
    }
    var destination = typeof trip.destination === 'string' ? trip.destination.trim() : '';
    var dateTbd = !normalizeDateString(trip.startDate);
    if (dateTbd) {
      return destination ? '日期待定 · ' + destination : '日期待定';
    }
    return destination;
  }

  /**
   * 行程日期区间文案：`11月28日–11月30日` / `11月28日`（单日）/ `日期待定`（想法无日期）。
   * @param {Object} trip
   * @return {string}
   */
  function formatTripRange(trip) {
    if (!trip) {
      return '';
    }
    var start = formatDateLabel(trip.startDate);
    if (!start) {
      return '日期待定';
    }
    var end = formatDateLabel(trip.endDate);
    return end && end !== start ? start + '–' + end : start;
  }

  /* ==================== 十、导出 ==================== */

  global.CourseSections = {
    /* 键与常量 */
    TRIPS_KEY: TRIPS_KEY,
    TASKS_KEY: TASKS_KEY,
    CONFIG_KEY: CONFIG_KEY,
    STORE_VERSION: STORE_VERSION,
    NOTE_MAX_LENGTH: NOTE_MAX_LENGTH,
    TITLE_MAX_TASK: TITLE_MAX_TASK,
    TITLE_MAX_TRIP: TITLE_MAX_TRIP,
    DEST_MAX_TRIP: DEST_MAX_TRIP,
    MAX_DATE_DRIFT_DAYS: MAX_DATE_DRIFT_DAYS,
    TASK_GROUP_ORDER: TASK_GROUP_ORDER,
    TASK_GROUPS: TASK_GROUPS,
    TRIP_STATUS: TRIP_STATUS,
    TRIP_STATUS_LIST: TRIP_STATUS_LIST,
    TRIP_STATUS_LABELS: TRIP_STATUS_LABELS,
    LAYOUT_ROW: LAYOUT_ROW,
    LAYOUT_COLUMN: LAYOUT_COLUMN,

    /* 日期 */
    normalizeDateString: normalizeDateString,
    isDateString: isDateString,
    todayString: todayString,
    shiftDate: shiftDate,
    daysBetween: daysBetween,
    weekdayCn: weekdayCn,
    formatDateLabel: formatDateLabel,
    formatDateFullCn: formatDateFullCn,
    relativeDayLabel: relativeDayLabel,
    monthLabelOf: monthLabelOf,

    /* 清洗与构造 */
    normalizeTimeString: normalizeTimeString,
    timeToMinutes: timeToMinutes,
    sanitizeTask: sanitizeTask,
    sanitizeTrip: sanitizeTrip,
    buildTaskRecord: buildTaskRecord,
    buildTripRecord: buildTripRecord,
    sanitizeSectionConfig: sanitizeSectionConfig,
    defaultSectionConfig: defaultSectionConfig,
    defaultConfig: defaultConfig,

    /* 存储 */
    readTasks: readTasks,
    writeTasks: writeTasks,
    readTrips: readTrips,
    writeTrips: writeTrips,
    readConfig: readConfig,
    writeConfig: writeConfig,

    /* 校验 */
    validateTaskValues: validateTaskValues,
    normalizeRemindMinutes: normalizeRemindMinutes,
    taskReminderAt: taskReminderAt,
    REMIND_OPTIONS: REMIND_OPTIONS,
    validateTripValues: validateTripValues,

    /* 筛选 / 分组 / 格式化 */
    filterTasksByDate: filterTasksByDate,
    tripCoversDate: tripCoversDate,
    filterTripsByDate: filterTripsByDate,
    filterTripsForView: filterTripsForView,
    taskSlotKey: taskSlotKey,
    groupTasks: groupTasks,
    groupTrips: groupTrips,
    formatTaskSide: formatTaskSide,
    formatTaskTimeRange: formatTaskTimeRange,
    tripEndDate: tripEndDate,
    isTripEnded: isTripEnded,
    formatTripSide: formatTripSide,
    formatTripSub: formatTripSub,
    formatTripRange: formatTripRange,

    /* 工具 */
    createId: createId,
    nextTaskId: nextTaskId,
    nextTripId: nextTripId
  };
})(typeof window !== 'undefined' ? window : globalThis);
