/**
 * 课程表 · 节次配置 + 排课推荐（纯逻辑模块，完全不依赖 DOM）
 *
 * 之所以单独成文件：节次表、午休区间、连续排课算法都属于「可单测的纯函数」，
 * 放在 Node 里也能直接跑（只需提供 global.window 即可 require）。
 *
 * 对外暴露 `window.CourseTimetable`：
 *
 *   CourseTimetable.PERIODS        // 12 节的唯一定义处（改这里就等于改整张课表）
 *   CourseTimetable.LUNCH          // 午休区间（不可排课）
 *   CourseTimetable.AXIS           // 默认时轴范围
 *   CourseTimetable.PX_PER_MINUTE  // 时轴像素密度（1 分钟对应多少像素）
 *   CourseTimetable.STEP_MINUTES   // 推算步进粒度（5 分钟）
 *   CourseTimetable.WEEKDAY_LABELS // 星期文案
 *   CourseTimetable.timeToMinutes('08:07')        -> 487
 *   CourseTimetable.minutesToTime(487)            -> '08:07'
 *   CourseTimetable.buildAxisBounds(courses)      -> {startMinute, endMinute}
 *   CourseTimetable.layoutDayBlocks(dayCourses)   -> [{course, lane, lanes, startMinute, endMinute}]
 *   CourseTimetable.findNextSlot(options)         -> {weekday, startTime, endTime, periodIndex} | null
 *   CourseTimetable.formatSlotLabel(slot)         -> '周三 第3节 10:00–11:40'
 *   CourseTimetable.periodIndexAt(minute)         -> 1..12 | 0
 *   CourseTimetable.periodRangeToTimes(3, 4)      -> {startTime: '10:20', endTime: '11:00'}
 *   CourseTimetable.periodIndexOf('10:20')        -> 3
 *
 * 节次编排（改 PERIODS 时的基准）：
 *   1. 每节 40 分钟；两节之后留 20 分钟大课间，其余课间 10 分钟；
 *   2. 上午 4 节 08:30 开始、11:50 结束（上午节次 1-4）；
 *   3. 午休 11:50–14:00；下午 4 节 14:30 开始、17:50 结束（节次 5-8）；
 *   4. 晚间 4 节 18:30 开始、21:50 结束（节次 9-12）。
 */
(function (global) {
  'use strict';

  /* ==================== 一、唯一的配置区 ==================== */

  /**
   * 固定节次表。要调整上课时间，只改这一处即可（网格、左轴、排课推算会一起生效）。
   * index 必须从 1 连续递增。
   * @type {Array<{index: number, start: string, end: string}>}
   */
  var PERIODS = [
    { index: 1, start: '08:30', end: '09:10' },
    { index: 2, start: '09:20', end: '10:00' },
    { index: 3, start: '10:20', end: '11:00' },
    { index: 4, start: '11:10', end: '11:50' },
    { index: 5, start: '14:30', end: '15:10' },
    { index: 6, start: '15:20', end: '16:00' },
    { index: 7, start: '16:20', end: '17:00' },
    { index: 8, start: '17:10', end: '17:50' },
    { index: 9, start: '18:30', end: '19:10' },
    { index: 10, start: '19:20', end: '20:00' },
    { index: 11, start: '20:20', end: '21:00' },
    { index: 12, start: '21:10', end: '21:50' }
  ];

  /** 午休：不可排课时段（左闭右开 [start, end)） */
  var LUNCH = { start: '11:50', end: '14:00' };

  /** 默认时轴范围；若有课程超出这个范围，会由 buildAxisBounds 自动扩展 */
  var AXIS = { start: '08:30', end: '22:00' };

  /** 时轴像素密度：1 分钟 = 1.6px（45 分钟一节 = 72px） */
  var PX_PER_MINUTE = 1.6;

  /** 推算步进粒度（分钟） */
  var STEP_MINUTES = 5;

  /** 星期文案，下标 0 对应周一 */
  var WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /** 一天的分钟数，用于时间边界保护 */
  var MINUTES_PER_DAY = 1440;

  /* ==================== 二、时间工具（模块内部自足） ==================== */

  /**
   * 数字补零到两位。
   * @param {number} value
   * @return {string}
   */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /**
   * 把输入规范化为 "HH:MM"，非法值返回空串。
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
   * @param {*} value
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
   * 分钟数转 "HH:MM"，越界时收敛到 [00:00, 23:59]。
   * @param {number} minutes
   * @return {string}
   */
  function minutesToTime(minutes) {
    var value = Math.round(Number(minutes));
    if (!isFinite(value)) {
      return '';
    }
    if (value < 0) {
      value = 0;
    }
    if (value > MINUTES_PER_DAY - 1) {
      value = MINUTES_PER_DAY - 1;
    }
    return pad2(Math.floor(value / 60)) + ':' + pad2(value % 60);
  }

  /**
   * 接受 "HH:MM" 或纯分钟数，统一解析为分钟；失败时返回兜底值。
   * @param {*} value
   * @param {number} fallback
   * @return {number}
   */
  function resolveMinute(value, fallback) {
    if (typeof value === 'number' && isFinite(value)) {
      var num = Math.round(value);
      return num >= 0 && num <= MINUTES_PER_DAY ? num : fallback;
    }
    var parsed = timeToMinutes(value);
    return parsed >= 0 ? parsed : fallback;
  }

  /**
   * 星期值收敛到 1-7。
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
   * 星期中文文案。
   * @param {number} weekday 1-7
   * @return {string}
   */
  function weekdayLabel(weekday) {
    var day = normalizeWeekday(weekday);
    return WEEKDAY_LABELS[day - 1];
  }

  /* ==================== 三、时轴与分道布局 ==================== */

  /**
   * 计算时轴范围：至少覆盖 AXIS 的默认范围，同时自动扩展以容纳所有课程。
   * 结果对齐到 5 分钟，且不超出 [00:00, 24:00]。
   * @param {Array<Object>} courses
   * @return {{startMinute: number, endMinute: number}}
   */
  function buildAxisBounds(courses) {
    var start = resolveMinute(AXIS.start, 8 * 60);
    var end = resolveMinute(AXIS.end, 22 * 60);
    var list = Array.isArray(courses) ? courses : [];
    for (var i = 0; i < list.length; i += 1) {
      var startMinute = timeToMinutes(list[i] && list[i].startTime);
      var endMinute = timeToMinutes(list[i] && list[i].endTime);
      if (startMinute < 0 || endMinute < 0 || endMinute <= startMinute) {
        continue;
      }
      if (startMinute < start) {
        start = startMinute;
      }
      if (endMinute > end) {
        end = endMinute;
      }
    }
    start = Math.max(0, Math.floor(start / STEP_MINUTES) * STEP_MINUTES);
    end = Math.min(MINUTES_PER_DAY, Math.ceil(end / STEP_MINUTES) * STEP_MINUTES);
    if (end <= start) {
      end = start + 60;
    }
    return { startMinute: start, endMinute: end };
  }

  /**
   * 计算某一天课程的分道布局。
   *
   * 规则：时间重叠（含首尾相接视为不重叠）的课程进入同一个「簇」，
   * 簇内按开始时间贪心分配道次，最终簇内所有课程平分所在列的宽度。
   *
   * @param {Array<Object>} dayCourses 仅同一天的课程
   * @return {Array<{course: Object, startMinute: number, endMinute: number, lane: number, lanes: number}>}
   */
  function layoutDayBlocks(dayCourses) {
    var items = [];
    var list = Array.isArray(dayCourses) ? dayCourses : [];
    for (var i = 0; i < list.length; i += 1) {
      var course = list[i];
      var startMinute = timeToMinutes(course && course.startTime);
      var endMinute = timeToMinutes(course && course.endTime);
      if (startMinute < 0 || endMinute < 0 || endMinute <= startMinute) {
        continue;
      }
      items.push({
        course: course,
        startMinute: startMinute,
        endMinute: endMinute,
        lane: 0,
        lanes: 1
      });
    }

    items.sort(function (a, b) {
      if (a.startMinute !== b.startMinute) {
        return a.startMinute - b.startMinute;
      }
      if (a.endMinute !== b.endMinute) {
        return a.endMinute - b.endMinute;
      }
      return String(a.course.name).localeCompare(String(b.course.name), 'zh-Hans-CN');
    });

    var result = [];
    var cluster = [];
    var clusterEnd = -1;

    function flushCluster() {
      if (cluster.length === 0) {
        return;
      }
      var laneEnds = [];
      for (var k = 0; k < cluster.length; k += 1) {
        var item = cluster[k];
        var lane = -1;
        for (var l = 0; l < laneEnds.length; l += 1) {
          if (laneEnds[l] <= item.startMinute) {
            lane = l;
            break;
          }
        }
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(0);
        }
        laneEnds[lane] = item.endMinute;
        item.lane = lane;
      }
      var lanes = laneEnds.length;
      for (var m = 0; m < cluster.length; m += 1) {
        cluster[m].lanes = lanes;
        result.push(cluster[m]);
      }
      cluster = [];
      clusterEnd = -1;
    }

    for (var j = 0; j < items.length; j += 1) {
      // 与当前簇已占用的时间完全不重叠（含相接）时，开启新簇
      if (cluster.length > 0 && items[j].startMinute >= clusterEnd) {
        flushCluster();
      }
      cluster.push(items[j]);
      if (items[j].endMinute > clusterEnd) {
        clusterEnd = items[j].endMinute;
      }
    }
    flushCluster();

    return result;
  }

  /* ==================== 四、连续排课推荐 ==================== */

  /**
   * 找出某个分钟落在第几节。
   * @param {Array<{index: number, start: string, end: string}>} periods
   * @param {number} minute
   * @return {number} 节的 index（1 起）；落在课间或午休时返回 0
   */
  function periodIndexAt(minute, periods) {
    var list = Array.isArray(periods) && periods.length > 0 ? periods : PERIODS;
    for (var i = 0; i < list.length; i += 1) {
      var startMinute = timeToMinutes(list[i].start);
      var endMinute = timeToMinutes(list[i].end);
      if (startMinute < 0 || endMinute < 0) {
        continue;
      }
      if (minute >= startMinute && minute < endMinute) {
        return list[i].index;
      }
    }
    return 0;
  }

  /**
   * 节次区间 → 具体起止时间。
   *
   * 这是「节次唯一所有者」对外提供的换算入口：识别服务只需要输出 periodStart/periodEnd，
   * 由本函数给出确定性的时间，避免模型自己做算术（幻觉时间的主要来源）。
   *
   * 规则：
   *   ① 起始节次必须是 1..PERIODS.length 的整数，否则返回空字符串（调用方留空让用户补）；
   *   ② 结束节次缺省 / 非法 / 小于起始节次时，按「只上起始节」处理；
   *   ③ 结束节次超出 12 时收敛到最后一节（越界不抛错，识别结果再脏也不能中断流程）。
   *
   * @param {number|string} startIdx 起始节次（1 起）
   * @param {number|string} [endIdx] 结束节次（1 起，含）
   * @return {{startTime: string, endTime: string}}
   */
  function periodRangeToTimes(startIdx, endIdx) {
    var empty = { startTime: '', endTime: '' };
    if (!Array.isArray(PERIODS) || PERIODS.length === 0) {
      return empty;
    }
    var from = Math.round(Number(startIdx));
    if (!isFinite(from) || from < 1 || from > PERIODS.length) {
      return empty;
    }
    var to = Math.round(Number(endIdx));
    if (!isFinite(to) || to < from) {
      to = from;
    }
    if (to > PERIODS.length) {
      to = PERIODS.length;
    }
    var first = PERIODS[from - 1];
    var last = PERIODS[to - 1] || first;
    if (!first || !last) {
      return empty;
    }
    return { startTime: first.start || '', endTime: last.end || '' };
  }

  /**
   * 具体时间 → 所属节次。
   * 落在课间 / 午休 / 时间轴之外时返回 0（与 periodIndexAt 的语义保持一致）。
   *
   * @param {string|number} time 'HH:MM' 或分钟数
   * @return {number} 1..12 或 0
   */
  function periodIndexOf(time) {
    var minute = typeof time === 'number' && isFinite(time) ? Math.round(time) : timeToMinutes(time);
    if (!isFinite(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
      return 0;
    }
    return periodIndexAt(minute, PERIODS);
  }

  /**
   * 收集某一天所有「已被占用」的时间区间（已有课程 + 午休）。
   * @param {Array<Object>} courses
   * @param {number} weekday
   * @param {number} lunchStart
   * @param {number} lunchEnd
   * @return {Array<{start: number, end: number}>}
   */
  function collectBusyIntervals(courses, weekday, lunchStart, lunchEnd) {
    var intervals = [];
    var list = Array.isArray(courses) ? courses : [];
    for (var i = 0; i < list.length; i += 1) {
      var course = list[i];
      if (!course || normalizeWeekday(course.weekday) !== weekday) {
        continue;
      }
      var startMinute = timeToMinutes(course.startTime);
      var endMinute = timeToMinutes(course.endTime);
      if (startMinute < 0 || endMinute < 0 || endMinute <= startMinute) {
        continue;
      }
      intervals.push({ start: startMinute, end: endMinute });
    }
    if (lunchEnd > lunchStart) {
      intervals.push({ start: lunchStart, end: lunchEnd });
    }
    return intervals;
  }

  /**
   * 判断 [start, end) 是否与任一同日占用区间重叠（首尾相接不算重叠）。
   * @param {number} start
   * @param {number} end
   * @param {Array<{start: number, end: number}>} busyIntervals
   * @param {number} dayEnd
   * @return {boolean}
   */
  function isSlotFree(start, end, busyIntervals, dayEnd) {
    if (end > dayEnd) {
      return false;
    }
    for (var i = 0; i < busyIntervals.length; i += 1) {
      var busy = busyIntervals[i];
      if (start < busy.end && end > busy.start) {
        return false;
      }
    }
    return true;
  }

  /**
   * 构造返回值。
   * @param {number} weekday
   * @param {number} startMinute
   * @param {number} duration
   * @param {Array<Object>} periods
   * @return {{weekday: number, startTime: string, endTime: string, periodIndex: number}}
   */
  function buildSlot(weekday, startMinute, duration, periods) {
    return {
      weekday: weekday,
      startTime: minutesToTime(startMinute),
      endTime: minutesToTime(startMinute + duration),
      periodIndex: periodIndexAt(startMinute, periods)
    };
  }

  /**
   * 连续排课推荐：为一段课程时长寻找下一个可用时段。
   *
   * 语义 = 连续排课。起点默认接在刚保存课程的 endTime 之后（afterTime），
   * 优先对齐节次起点；当天排不下则顺延到之后的星期几（周一→周二…周日循环），
   * 7 天都排不下返回 null（调用方据此提示「本周已排满」）。
   *
   * 候选 [s, s+duration) 必须同时满足：
   *   ① 不与同日任何现有课程区间重叠（首尾相接不算重叠）；
   *   ② 与午休 [lunch.start, lunch.end) 无交集；
   *   ③ s + duration <= dayEnd；
   *   ④ s >= dayStart（第一天还要 s >= afterTime）。
   *
   * @param {{
   *   weekday: (number|string),
   *   duration: number,
   *   courses: Array<Object>,
   *   periods: Array<{index: number, start: string, end: string}>,
   *   lunch: {start: string, end: string},
   *   dayStart: (string|number),
   *   dayEnd: (string|number),
   *   afterTime: (string|number|undefined)
   * }} options
   * @return {{weekday: number, startTime: string, endTime: string, periodIndex: number}|null}
   */
  function findNextSlot(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var weekday = normalizeWeekday(opts.weekday);
    var duration = Math.round(Number(opts.duration));
    if (!isFinite(duration) || duration <= 0) {
      return null;
    }
    duration = Math.max(STEP_MINUTES, duration);

    var courseList = Array.isArray(opts.courses) ? opts.courses : [];
    var periodList = Array.isArray(opts.periods) && opts.periods.length > 0 ? opts.periods : PERIODS;
    var lunch = opts.lunch && typeof opts.lunch === 'object' ? opts.lunch : LUNCH;
    var lunchStart = resolveMinute(lunch.start, 11 * 60 + 50);
    var lunchEnd = resolveMinute(lunch.end, 14 * 60);
    var dayStart = resolveMinute(opts.dayStart, resolveMinute(AXIS.start, 8 * 60));
    var dayEnd = resolveMinute(opts.dayEnd, resolveMinute(AXIS.end, 22 * 60));
    var afterTime = resolveMinute(opts.afterTime, -1);

    if (dayEnd - dayStart < duration) {
      return null;
    }

    // 节次起点列表（升序）
    var periodStarts = [];
    for (var p = 0; p < periodList.length; p += 1) {
      var periodStart = timeToMinutes(periodList[p].start);
      if (periodStart >= 0) {
        periodStarts.push(periodStart);
      }
    }
    periodStarts.sort(function (a, b) {
      return a - b;
    });

    for (var offset = 0; offset < 7; offset += 1) {
      var day = ((weekday - 1 + offset) % 7) + 1;
      var lowerBound = dayStart;
      if (offset === 0 && afterTime > lowerBound) {
        lowerBound = afterTime;
      }
      if (lowerBound + duration > dayEnd) {
        continue;
      }
      var busyIntervals = collectBusyIntervals(courseList, day, lunchStart, lunchEnd);

      // 第一轮：优先对齐节次起点
      for (var i = 0; i < periodStarts.length; i += 1) {
        var candidateStart = periodStarts[i];
        if (candidateStart < lowerBound) {
          continue;
        }
        if (isSlotFree(candidateStart, candidateStart + duration, busyIntervals, dayEnd)) {
          return buildSlot(day, candidateStart, duration, periodList);
        }
      }

      // 第二轮：按 5 分钟步进扫描空档
      var stepStart = Math.ceil(lowerBound / STEP_MINUTES) * STEP_MINUTES;
      for (var cursor = stepStart; cursor + duration <= dayEnd; cursor += STEP_MINUTES) {
        if (isSlotFree(cursor, cursor + duration, busyIntervals, dayEnd)) {
          return buildSlot(day, cursor, duration, periodList);
        }
      }
    }

    return null;
  }

  /**
   * 把推荐结果格式化为可读文案。
   * @param {{weekday: number, startTime: string, endTime: string, periodIndex: number}|null} slot
   * @return {string}
   */
  function formatSlotLabel(slot) {
    if (!slot) {
      return '';
    }
    var label = weekdayLabel(slot.weekday) + ' ';
    if (slot.periodIndex > 0) {
      label += '第' + slot.periodIndex + '节 ';
    }
    return label + slot.startTime + '–' + slot.endTime;
  }

  /* ==================== 五、配置自检（仅开发期提示） ==================== */

  /**
   * 校验节次配置是否满足编排约束，不满足时在控制台给出提示。
   * 运行期不做任何修正，避免悄悄改变用户看到的时间。
   */
  function assertConfig() {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') {
      return;
    }
    var lunchStart = timeToMinutes(LUNCH.start);
    var lunchEnd = timeToMinutes(LUNCH.end);
    var previousEnd = -1;
    for (var i = 0; i < PERIODS.length; i += 1) {
      var period = PERIODS[i];
      var startMinute = timeToMinutes(period.start);
      var endMinute = timeToMinutes(period.end);
      if (startMinute < 0 || endMinute < 0) {
        console.warn('[CourseTimetable] 第' + period.index + '节时间格式非法：', period);
        continue;
      }
      if (endMinute <= startMinute) {
        console.warn('[CourseTimetable] 第' + period.index + '节结束时间不晚于开始时间：', period);
      }
      if (startMinute < previousEnd) {
        console.warn('[CourseTimetable] 第' + period.index + '节与上一节时间重叠：', period);
      }
      if (startMinute < lunchEnd && endMinute > lunchStart) {
        console.warn('[CourseTimetable] 第' + period.index + '节跨越了午休时段：', period);
      }
      previousEnd = endMinute;
    }
    if (PERIODS.length !== 12) {
      console.warn('[CourseTimetable] 预期 12 节，当前为 ' + PERIODS.length + ' 节');
    }
  }

  assertConfig();

  /* ==================== 六、导出 ==================== */

  global.CourseTimetable = {
    PERIODS: PERIODS,
    LUNCH: LUNCH,
    AXIS: AXIS,
    PX_PER_MINUTE: PX_PER_MINUTE,
    STEP_MINUTES: STEP_MINUTES,
    WEEKDAY_LABELS: WEEKDAY_LABELS,
    normalizeTimeString: normalizeTimeString,
    timeToMinutes: timeToMinutes,
    minutesToTime: minutesToTime,
    normalizeWeekday: normalizeWeekday,
    weekdayLabel: weekdayLabel,
    buildAxisBounds: buildAxisBounds,
    layoutDayBlocks: layoutDayBlocks,
    periodIndexAt: periodIndexAt,
    periodRangeToTimes: periodRangeToTimes,
    periodIndexOf: periodIndexOf,
    findNextSlot: findNextSlot,
    formatSlotLabel: formatSlotLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
