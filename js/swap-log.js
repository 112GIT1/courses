/**
 * 课程表 · 工作日志（目前记录「课表互换」操作）
 *
 * 设计要点：
 *   1. 独立的 localStorage 键 `course-manager:log:v1`，与课程数据完全分开：
 *      日志写失败不会影响互换结果，课程写失败也不会污染日志。
 *   2. 读取一律 try/catch + 结构校验：损坏时降级为空列表并返回提示，
 *      并且 **绝不** 在读取阶段回写（原内容保留，不会因为一次打开页面就被清空）。
 *   3. 只在写新记录时做「损坏数据备份」（尽力而为，失败不阻断），
 *      确保追加日志不会把用户的原始数据彻底覆盖掉。
 *   4. 最多保留 MAX_ENTRIES 条，超出丢弃最旧的记录。
 *   5. 全部是纯函数 + 一个存储适配层，方便在 Node 里直接单测。
 *
 * 对外暴露 `window.CourseSwapLog`：
 *   CourseSwapLog.read()                  -> {entries, notice, corrupt}
 *   CourseSwapLog.append(entry)           -> {ok, notice, entries}
 *   CourseSwapLog.clear()                 -> {ok, notice}
 *   CourseSwapLog.groupByDay(entries)     -> [{key, label, items}]
 *   CourseSwapLog.formatClock(ts)         -> '09:05'
 *   CourseSwapLog.formatTarget(target)    -> '高等数学 周三 08:30–10:00'
 *   CourseSwapLog.formatEntrySummary(e)   -> '高等数学 周三 08:30–10:00 ⇄ 大学英语 周五 14:30–16:00'
 */
(function (global) {
  'use strict';

  /* ==================== 一、常量 ==================== */

  /** 日志存储键（与课程数据 course-manager:v1 分开） */
  var LOG_KEY = 'course-manager:log:v1';
  /** 日志结构版本 */
  var LOG_VERSION = 1;
  /** 最多保留的日志条数，超出丢弃最旧的 */
  var MAX_ENTRIES = 200;
  /** 检测到损坏数据时，原文备份键（仅尽力备份，不参与展示） */
  var BACKUP_KEY = 'course-manager:log:v1:corrupt-backup';
  /** 星期文案，下标 0 对应周一 */
  var WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  /** 合法结果值 */
  var RESULT_SUCCESS = 'success';
  var RESULT_FAILED = 'failed';

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
   * 规范化为 "HH:MM"，非法输入返回空串。
   * @param {*} value
   * @return {string}
   */
  function normalizeTime(value) {
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
   * 星期值规范化为 1-7，非法值返回 0（表示「时间未知」，用于已失效的课程）。
   * @param {*} value
   * @return {number}
   */
  function normalizeWeekday(value) {
    var num = Number(value);
    if (!isFinite(num)) {
      return 0;
    }
    var int = Math.floor(num);
    if (int < 1 || int > 7) {
      return 0;
    }
    return int;
  }

  /**
   * 取存储对象；浏览器禁用存储时返回 null。
   * @return {Storage|null}
   */
  function getStorage() {
    try {
      var storage = global.localStorage;
      return storage || null;
    } catch (err) {
      return null;
    }
  }

  /* ==================== 三、结构校验 ==================== */

  /**
   * 校验单条「涉及对象」。
   * @param {*} raw
   * @return {{id: string, name: string, weekday: number, startTime: string, endTime: string}|null}
   */
  function sanitizeTarget(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      return null;
    }
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      name: name,
      weekday: normalizeWeekday(raw.weekday),
      startTime: normalizeTime(raw.startTime),
      endTime: normalizeTime(raw.endTime)
    };
  }

  /**
   * 校验单条日志记录，非法记录返回 null。
   * @param {*} raw
   * @param {number} index 用于生成缺失 id
   * @return {Object|null}
   */
  function sanitizeEntry(raw, index) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var at = Number(raw.at);
    if (!isFinite(at) || at <= 0) {
      return null;
    }
    var targets = [];
    if (Array.isArray(raw.targets)) {
      for (var i = 0; i < raw.targets.length; i += 1) {
        var target = sanitizeTarget(raw.targets[i]);
        if (target) {
          targets.push(target);
        }
      }
    }
    var position = typeof index === 'number' ? index : 0;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : 'log-' + at + '-' + position,
      at: at,
      action: typeof raw.action === 'string' && raw.action ? raw.action : 'swap',
      title: typeof raw.title === 'string' && raw.title ? raw.title : '互换课程位置',
      targets: targets,
      result: raw.result === RESULT_FAILED ? RESULT_FAILED : RESULT_SUCCESS,
      reason: typeof raw.reason === 'string' ? raw.reason : ''
    };
  }

  /* ==================== 四、读写 ==================== */

  /**
   * 读取日志。任何异常都降级为空列表，并且不写回存储。
   * @return {{entries: Array<Object>, notice: string|null, corrupt: boolean}}
   */
  function read() {
    var storage = getStorage();
    if (!storage) {
      return {
        entries: [],
        notice: '当前浏览器禁止访问本地存储，工作日志无法读取或保存。',
        corrupt: false
      };
    }

    var raw = null;
    try {
      raw = storage.getItem(LOG_KEY);
    } catch (err) {
      return {
        entries: [],
        notice: '当前浏览器禁止访问本地存储，工作日志无法读取或保存。',
        corrupt: false
      };
    }
    if (!raw) {
      return { entries: [], notice: null, corrupt: false };
    }

    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        entries: [],
        notice: '工作日志数据已损坏，本次显示为空（原始内容未被覆盖）。',
        corrupt: true
      };
    }

    // 兼容两种结构：{version, entries} 或直接是数组
    var list = null;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      list = parsed.entries;
    }
    if (!list) {
      return {
        entries: [],
        notice: '工作日志格式无法识别，本次显示为空（原始内容未被覆盖）。',
        corrupt: true
      };
    }

    var entries = [];
    var dropped = 0;
    for (var i = 0; i < list.length; i += 1) {
      var entry = sanitizeEntry(list[i], i);
      if (entry) {
        entries.push(entry);
      } else {
        dropped += 1;
      }
    }
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }
    var notice = null;
    if (dropped > 0) {
      notice = '有 ' + dropped + ' 条日志格式不完整，已忽略（原始内容未被覆盖）。';
    }
    return { entries: entries, notice: notice, corrupt: false };
  }

  /**
   * 写入日志（整表覆盖）。
   * @param {Array<Object>} entries
   * @return {{ok: boolean, notice: string|null}}
   */
  function write(entries) {
    var storage = getStorage();
    if (!storage) {
      return { ok: false, notice: '当前浏览器禁止访问本地存储，工作日志无法保存。' };
    }
    try {
      storage.setItem(LOG_KEY, JSON.stringify({ version: LOG_VERSION, entries: entries }));
      return { ok: true, notice: null };
    } catch (err) {
      return {
        ok: false,
        notice: '工作日志写入失败（可能空间已满或被禁用），本次记录未能保存。'
      };
    }
  }

  /**
   * 把损坏的原始内容备份到旁路键（尽力而为，失败不阻断）。
   */
  function backupCorruptRaw() {
    var storage = getStorage();
    if (!storage) {
      return;
    }
    try {
      var raw = storage.getItem(LOG_KEY);
      if (raw) {
        storage.setItem(BACKUP_KEY, raw);
      }
    } catch (err) {
      /* 备份失败不阻断主流程 */
    }
  }

  /**
   * 追加一条日志：超过上限时丢弃最旧的。
   * @param {Object} entry
   * @return {{ok: boolean, notice: string|null, entries: Array<Object>}}
   */
  function append(entry) {
    var clean = sanitizeEntry(entry, 0);
    if (!clean) {
      return { ok: false, notice: '日志内容不合法，未能写入。', entries: [] };
    }
    var current = read();
    if (current.corrupt) {
      // 损坏数据先备份，再写入新结构，避免原始内容被静默覆盖
      backupCorruptRaw();
    }
    var next = current.entries.concat([clean]);
    if (next.length > MAX_ENTRIES) {
      next = next.slice(next.length - MAX_ENTRIES);
    }
    var result = write(next);
    return { ok: result.ok, notice: result.notice, entries: next };
  }

  /**
   * 清空日志（写入空列表，保留版本结构）。
   * @return {{ok: boolean, notice: string|null}}
   */
  function clear() {
    return write([]);
  }

  /* ==================== 五、展示格式化 ==================== */

  /**
   * 时间戳 → "HH:MM"。
   * @param {number} timestamp
   * @return {string}
   */
  function formatClock(timestamp) {
    var date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) {
      return '';
    }
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  /**
   * 时间戳 → 本地日期键 "YYYY-MM-DD"。
   * @param {number} timestamp
   * @param {number} [offsetDays] 相对偏移天数（-1 表示昨天）
   * @return {string}
   */
  function dayKey(timestamp, offsetDays) {
    var date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) {
      return '';
    }
    if (typeof offsetDays === 'number' && isFinite(offsetDays) && offsetDays !== 0) {
      date.setDate(date.getDate() + offsetDays);
    }
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  /**
   * 日期键 → 分组标题（今天 / 昨天 / YYYY-MM-DD）。
   * @param {string} key
   * @param {number} now
   * @return {string}
   */
  function formatDayLabel(key, now) {
    if (!key) {
      return '';
    }
    if (key === dayKey(now)) {
      return '今天';
    }
    if (key === dayKey(now, -1)) {
      return '昨天';
    }
    return key;
  }

  /**
   * 单个对象 → "高等数学 周三 08:30–10:00"。
   * @param {{name: string, weekday: number, startTime: string, endTime: string}} target
   * @return {string}
   */
  function formatTarget(target) {
    if (!target || typeof target !== 'object') {
      return '';
    }
    var name = typeof target.name === 'string' ? target.name : '';
    var weekday = normalizeWeekday(target.weekday);
    var dayText = weekday >= 1 ? WEEKDAY_LABELS[weekday - 1] : '时间未知';
    var start = normalizeTime(target.startTime);
    var end = normalizeTime(target.endTime);
    var range = '';
    if (start && end) {
      range = start + '–' + end;
    } else if (start) {
      range = start + ' 开始';
    } else if (end) {
      range = '至 ' + end;
    }
    return (name + ' ' + dayText + (range ? ' ' + range : '')).trim();
  }

  /**
   * 一条记录 → "A 周三 08:30–10:00 ⇄ B 周五 14:30–16:00"。
   * @param {Object} entry
   * @return {string}
   */
  function formatEntrySummary(entry) {
    if (!entry || !Array.isArray(entry.targets) || entry.targets.length === 0) {
      return '（无涉及对象）';
    }
    var parts = [];
    for (var i = 0; i < entry.targets.length; i += 1) {
      var text = formatTarget(entry.targets[i]);
      if (text) {
        parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join(' ⇄ ') : '（无涉及对象）';
  }

  /**
   * 按日期分组：日期组从新到旧，组内按时间从新到旧。
   * @param {Array<Object>} entries
   * @param {number} [nowTs]
   * @return {Array<{key: string, label: string, items: Array<Object>}>}
   */
  function groupByDay(entries, nowTs) {
    var now = Number(nowTs);
    if (!isFinite(now) || now <= 0) {
      now = Date.now();
    }
    var list = Array.isArray(entries) ? entries : [];
    var buckets = {};
    var keys = [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      var key = dayKey(entry && entry.at);
      if (!key) {
        continue;
      }
      if (!buckets[key]) {
        buckets[key] = [];
        keys.push(key);
      }
      buckets[key].push(entry);
    }
    keys.sort(function (a, b) {
      if (a === b) {
        return 0;
      }
      return a < b ? 1 : -1;
    });

    var groups = [];
    for (var k = 0; k < keys.length; k += 1) {
      var items = buckets[keys[k]].slice();
      items.sort(function (a, b) {
        return Number(b.at) - Number(a.at);
      });
      groups.push({ key: keys[k], label: formatDayLabel(keys[k], now), items: items });
    }
    return groups;
  }

  /* ==================== 六、导出 ==================== */

  global.CourseSwapLog = {
    LOG_KEY: LOG_KEY,
    LOG_VERSION: LOG_VERSION,
    MAX_ENTRIES: MAX_ENTRIES,
    RESULT_SUCCESS: RESULT_SUCCESS,
    RESULT_FAILED: RESULT_FAILED,
    normalizeTime: normalizeTime,
    normalizeWeekday: normalizeWeekday,
    sanitizeEntry: sanitizeEntry,
    read: read,
    write: write,
    append: append,
    clear: clear,
    formatClock: formatClock,
    dayKey: dayKey,
    formatDayLabel: formatDayLabel,
    formatTarget: formatTarget,
    formatEntrySummary: formatEntrySummary,
    groupByDay: groupByDay
  };
})(typeof window !== 'undefined' ? window : globalThis);
