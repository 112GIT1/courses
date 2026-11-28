/**
 * 课程表 · 应用逻辑
 *
 * 零依赖、零构建的纯静态实现，可离线运行（file:// 直接打开即可）。
 * 数据全部保存在 localStorage，仅在用户主动操作时写入，绝不写入任何预置示例数据。
 *
 * 模块分为七层：
 *   1. 工具函数（时间、ID、星期、DOM 构建）
 *   2. 数据层（localStorage 读写 + 结构校验 + 统一的记录构造）
 *   3. 视图层（课表网格 / 分组清单 / 未设置时间，全部通过 createElement + textContent）
 *   4. 交互层（表单面板、课程详情、确认框、撤销提示、焦点管理、滚动锁定）
 *   5. 排课助手（连续排课推荐，纯算法在 timetable.js，本层只负责展示与交互）
 *   6. 图片导入（识别能力全部在 import-service.js，本层只负责界面与入库）
 *   7. 互换与工作日志（互换只改 weekday/startTime/endTime/updatedAt；日志存储在 swap-log.js）
 *   8. 课程颜色（只存 8 个 token；没有 color 的旧数据按课名哈希自动派生，不写库）
 */
(function () {
  'use strict';

  /* ==================== 一、常量 ==================== */

  /** localStorage 键名（保持不变，老数据零迁移） */
  var STORAGE_KEY = 'course-manager:v1';
  /** 数据结构版本（保持不变） */
  var STORE_VERSION = 1;
  /** 备注最大长度 */
  var NOTE_MAX_LENGTH = 500;
  /** 撤销提示停留时长（毫秒） */
  var UNDO_TIMEOUT_MS = 5000;
  /** 批量导入的撤销窗口（毫秒）：整批误触代价更大，比单条删除给得更长 */
  var IMPORT_UNDO_TIMEOUT_MS = 10000;
  /** 识别进度文案的节流下限（毫秒）：低于它就不刷新，避免读屏被刷屏 */
  var IMPORT_STATUS_THROTTLE_MS = 1000;
  /** 「今天」信息条的刷新周期（毫秒） */
  var TODAY_REFRESH_MS = 60000;
  /** 低于这个置信度：黄边 + 默认不勾选 + 置顶 */
  var LOW_CONFIDENCE = 0.6;
  /** 任务提醒的轮询周期（毫秒）。30 秒足够准，又不会让后台标签页频繁唤醒 */
  var REMINDER_TICK_MS = 30000;
  /** 允许的迟到窗口：标签页被挂起后恢复，仍算「这一分钟内到点」，超时不再补响 */
  var REMINDER_GRACE_MS = 90000;
  /** 「稍后提醒」的间隔 */
  var REMINDER_SNOOZE_MS = 300000;
  /** 面板 / 遮罩退场动画时长，需与 styles.css 保持一致 */
  var OVERLAY_ANIMATION_MS = 220;
  /** 星期文案，下标 0 对应周一 */
  var WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  /** SVG 命名空间 */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  /** 表单面板可聚焦元素选择器 */
  var FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  /** 新增课程时的默认时间 */
  var DEFAULT_START_TIME = '08:30';
  var DEFAULT_END_TIME = '10:00';
  /** 点击遮罩关闭的守卫窗口：打开后极短时间内的点击视为连点误触 */
  var OVERLAY_GUARD_MS = 300;
  /** 触控热区最小边长（px），课程块通过透明伪元素凑到这个尺寸 */
  var TAP_MIN_PX = 44;

  /**
   * 「按天」模式的断点：< 560px 视为窄屏。
   * 必须与 styles.css 里的 `@media (max-width: 559px)` 保持一致 ——
   * 一处控制 JS 的默认显示方式，一处控制按天视图的排版细节。
   */
  var TT_DAY_QUERY = '(max-width: 559px)';

  /** 整周模式滑动提示的存活时间（毫秒）：够看见，又不至于一直占着一行 */
  var TT_HINT_TIMEOUT_MS = 8000;
  /** 互换模式需要选中的课程数量 */
  var SWAP_PICK_LIMIT = 2;
  /** 互换结果的三种终态 */
  var SWAP_STATUS_SUCCESS = 'success';
  var SWAP_STATUS_SAME_POSITION = 'same-position';
  var SWAP_STATUS_INVALID = 'invalid';
  var SWAP_STATUS_WRITE_FAILED = 'write-failed';

  /* ---- 课程颜色：只存 token，绝不存任意 hex ---- */
  /**
   * 8 个预设颜色 token。数组顺序 = 表单里色块的排列顺序，
   * 相邻两项要么色相相差较大（>30°），要么明度差别明显，色弱用户也能分辨。
   * @type {Array<string>}
   */
  var COURSE_COLORS = ['blue', 'teal', 'green', 'amber', 'purple', 'orange', 'red', 'gray'];
  /** token → 中文名（色块 aria-label 用） */
  var COURSE_COLOR_LABELS = {
    blue: '蓝色',
    teal: '青色',
    green: '绿色',
    amber: '琥珀色',
    purple: '紫色',
    orange: '橙色',
    red: '红色',
    gray: '灰色'
  };
  /** 课名哈希的取模基数：质数，且足够小以保证 (hash*31+charCode) 不丢精度 */
  var COLOR_HASH_MOD = 1000000007;

  /* ---- 课表配置：统一从 timetable.js 读取，本文件不再重复定义 ---- */
  var TT = window.CourseTimetable || {};
  var PERIODS = Array.isArray(TT.PERIODS) && TT.PERIODS.length > 0 ? TT.PERIODS : [];
  var LUNCH =
    TT.LUNCH && TT.LUNCH.start && TT.LUNCH.end ? TT.LUNCH : { start: '11:50', end: '14:00' };
  var AXIS = TT.AXIS && TT.AXIS.start && TT.AXIS.end ? TT.AXIS : { start: '08:30', end: '22:00' };
  var PX_PER_MINUTE =
    typeof TT.PX_PER_MINUTE === 'number' && TT.PX_PER_MINUTE > 0 ? TT.PX_PER_MINUTE : 1.6;

  /* ---- 栏目数据层：统一从 sections.js 读取（解析期取走，与上面 TT 同款约定） ---- */
  var SEC = window.CourseSections || {};
  /* 任务 / 行程的存储键由 sections.js 拥有；这里只借它的值做 storage 事件过滤，
     读档仍然走 SEC.readTasks / SEC.readTrips（不自己解析 JSON）。 */
  var TASKS_STORAGE_KEY = SEC.TASKS_KEY || 'course-manager:tasks:v1';
  var TRIPS_STORAGE_KEY = SEC.TRIPS_KEY || 'course-manager:trips:v1';
  /* ---- 课程目录：只读静态数据 + 判重/过滤纯函数（catalog.js） ---- */
  var CAT = window.CourseCatalog || {};
  /** 4 个平级栏目，顺序 = 分段控件里的顺序 */
  var VIEWS = ['grid', 'list', 'trips', 'tasks'];
  /** 栏目 → 顶栏标题 */
  var SECTION_TITLES = {
    grid: '我的课程',
    list: '我的课程',
    trips: '我的旅行',
    tasks: '我的任务'
  };
  /** 栏目 → 主按钮文案（aria-label 与可见文案共用一份，避免两处走偏） */
  var SECTION_ADD_LABELS = {
    grid: '添加课程',
    list: '添加课程',
    trips: '添加行程',
    tasks: '添加任务'
  };
  /** 打开 / 编辑浮层时记住的触发元素（关闭后归还焦点） */
  var itemOverlayOpenedAt = 0;

  /* ---- 栏目（清单 / 旅游 / 任务）的列表显示配置 ---- */

  /** 可配置的三个列表栏目 → 中文名（设置面板标题与副标题共用） */
  var LIST_SECTION_NAMES = { list: '清单', trips: '旅游', tasks: '任务' };

  /**
   * 每个栏目支持哪些配置项。
   * 清单卡片（`.card`）没有"右侧状态列"也没有头像，因此这两项对它恒为不支持：
   * 设置面板里仍会渲染出来（置灰 + 说明），避免三个栏目的面板长得不一样。
   * @type {Object<string, Object<string, boolean>>}
   */
  var SETTING_SUPPORT = {
    list: { layout: true, showMeta: true, showSide: false, showAvatar: false, showGroupTitle: true },
    trips: { layout: true, showMeta: true, showSide: true, showAvatar: true, showGroupTitle: true },
    tasks: { layout: true, showMeta: true, showSide: true, showAvatar: true, showGroupTitle: true }
  };

  /**
   * 4 个开关的定义（顺序 = 面板里的顺序）。
   * `desc` 按栏目给不同说明，避免"任务=备注"这类词串到旅游栏目上。
   */
  var SETTING_DEFS = [
    {
      key: 'showMeta',
      label: '简要信息',
      desc: { list: '时间 / 教师 / 地点 / 备注', trips: '目的地', tasks: '备注' },
      offText: { list: '只显示课程名称', trips: '只显示行程名称', tasks: '只显示任务标题' }
    },
    {
      key: 'showSide',
      label: '右侧状态',
      desc: {
        list: '清单卡片没有这一项',
        trips: '进行中 / 还剩 N 天 / 已结束',
        tasks: '时间或「全天」'
      }
    },
    {
      key: 'showAvatar',
      label: '图标头像',
      desc: { list: '清单卡片没有这一项', trips: '行首的首字色块', tasks: '行首的首字色块' }
    },
    {
      key: 'showGroupTitle',
      label: '分组标题',
      desc: {
        list: '按星期分的组头',
        trips: '按出发月份分的组头',
        tasks: '上午 / 下午 / 晚上'
      }
    }
  ];

  /** 布局的两个取值与文案 */
  var LAYOUT_ROW = 'row';
  var LAYOUT_COLUMN = 'column';

  var reducedMotionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  /* ==================== 二、DOM 引用 ==================== */

  var courseSummaryEl = null;
  var courseListEl = null;
  var emptyStateEl = null;
  var btnAddEl = null;
  var btnAddEmptyEl = null;

  var timetableViewEl = null;
  var timetableScrollEl = null;
  var unscheduledEl = null;
  var unscheduledListEl = null;
  var viewTabGridEl = null;
  var viewTabListEl = null;
  var viewTabTripsEl = null;
  var viewTabTasksEl = null;
  var appTitleEl = null;
  var btnAddLabelEl = null;
  var btnTodayEl = null;
  var btnCameraEl = null;
  var btnCameraEmptyEl = null;
  var btnCameraEmptyLabelEl = null;
  var btnMoreEl = null;
  var moreMenuEl = null;
  var importCameraEl = null;
  var importCameraPickEl = null;
  var importCancelRunEl = null;
  var importRunEl = null;
  var importBulkEl = null;
  var importBulkTitleEl = null;
  var importBulkWeekdayEl = null;
  var importBulkPeriodStartEl = null;
  var importBulkPeriodEndEl = null;
  var importBulkAllEl = null;
  var importBulkNoneEl = null;
  var todayBarEl = null;
  var todayBarTextEl = null;

  /* 今日面板（当日课程 + 当日任务） */
  var todayOverlayEl = null;
  var todaySheetEl = null;
  var todayTitleEl = null;
  var todayBodyEl = null;
  var todayCloseEl = null;
  var todayDoneEl = null;
  /** @type {HTMLElement|null} 打开今日面板的触发元素（关闭后归还焦点） */
  var lastTodayTrigger = null;

  /* 课表显示方式：整周 / 按天（全部是内存态，不写存储） */
  var ttModeEl = null;
  var ttModeWeekEl = null;
  var ttModeDayEl = null;
  var ttDaysEl = null;
  var ttHintEl = null;
  /** 本次会话是否已经给过「左右滑动」提示 */
  var ttHintShown = false;
  /** 整周模式本次是否已自动定位到今天列 */
  var ttAutoScrolled = false;
  /** 用户是否手动横向滚过整周课表（滚过之后不再抢滚动） */
  var ttUserScrolled = false;
  /** 星期 chips 重建后焦点该落在哪一天（方向键换天时用一次就清掉） */
  var ttPendingChipFocus = 0;
  /** 上一次构建整周课表时的宽屏列宽下限（随道数变化，供视口变化时重算 fit 用） */
  var ttWideColMin = 88;
  /** 上一次构建整周课表时全表最多需要几道并排 */
  var ttMaxLanes = 1;
  /** 上一次观测到的横向滚动位置，用来判断是不是真的横向滚了 */
  var ttLastScrollLeft = 0;
  /** 滑动提示的自动隐藏定时器 */
  var ttHintTimerId = null;
  /** 视口变化的防抖定时器 */
  var ttResizeTimerId = null;
  var btnSwapEl = null;
  var btnLogEl = null;

  var swapBarEl = null;
  var swapBarStatusEl = null;
  var swapBarDetailEl = null;
  var swapExitEl = null;
  var swapConfirmEl = null;

  var logOverlayEl = null;
  var logSheetEl = null;
  var logCloseEl = null;
  var logDoneEl = null;
  var logClearEl = null;
  var logCountEl = null;
  var logNoticeEl = null;
  var logEmptyEl = null;
  var logGroupsEl = null;

  var assistantBarEl = null;
  var assistantTextEl = null;
  var assistantContinueEl = null;
  var assistantDismissEl = null;

  var noticeEl = null;
  var noticeTextEl = null;
  var noticeCloseEl = null;

  var detailOverlayEl = null;
  var detailSheetEl = null;
  var detailTitleEl = null;
  var detailBodyEl = null;
  var detailCloseEl = null;
  var detailEditEl = null;
  var detailDeleteEl = null;

  var formOverlayEl = null;
  var sheetEl = null;
  var formTitleEl = null;
  var formEl = null;
  var formCloseEl = null;
  var formCancelEl = null;
  var formImportEl = null;
  var nameInput = null;
  var weekdaySelect = null;
  var startInput = null;
  var endInput = null;
  var teacherInput = null;
  var placeInput = null;
  var noteInput = null;
  var noteCounterEl = null;
  var colorPickerEl = null;
  var errorNameEl = null;
  var errorTimeEl = null;

  /* ---- 课程目录浮层（勾选批量添加） ---- */
  var catalogOverlayEl = null;
  var catalogSheetEl = null;
  var catalogFooterEl = null;
  var catalogCloseEl = null;
  var catalogManualEl = null;
  var catalogStatsEl = null;
  var catalogSearchEl = null;
  var catalogChipsEl = null;
  var catalogListEl = null;
  var catalogEmptyEl = null;
  var catalogCountEl = null;
  var catalogClearEl = null;
  var catalogAddEl = null;
  var catalogStatusEl = null;

  var importOverlayEl = null;
  var importSheetEl = null;
  var importCloseEl = null;
  var importCancelEl = null;
  var importConfirmEl = null;
  var importPickEl = null;
  var importFileEl = null;
  var importDropzoneEl = null;
  var importThumbsEl = null;
  var importStatusEl = null;
  var importWarningsEl = null;
  var importCandidatesEl = null;

  var confirmOverlayEl = null;
  var confirmDialogEl = null;
  var confirmTitleEl = null;
  var confirmMessageEl = null;
  var confirmOkEl = null;
  var confirmCancelEl = null;

  var undoToastEl = null;
  var undoToastTextEl = null;
  var undoButtonEl = null;

  var liveRegionEl = null;

  /* ---- 栏目（旅游 / 任务）---- */
  var dateBarEl = null;
  var dateInputEl = null;
  var datePrevEl = null;
  var dateNextEl = null;
  var dateTodayEl = null;
  var dateClearEl = null;
  var tasksViewEl = null;
  var tasksListEl = null;
  var tasksEmptyEl = null;
  var tasksEmptyTitleEl = null;
  var tasksEmptyDescEl = null;
  var tasksEmptyAddEl = null;
  var tripsViewEl = null;
  var tripsListEl = null;
  var tripsEmptyEl = null;
  var tripsEmptyTitleEl = null;
  var tripsEmptyDescEl = null;
  var tripsEmptyAddEl = null;
  var tripsEmptyAddLabelEl = null;
  var tripsEmptyHintEl = null;
  var btnSettingsEl = null;

  /* ---- 新增 / 编辑浮层（任务 + 行程共用） ---- */
  var itemOverlayEl = null;
  var itemSheetEl = null;
  var itemTitleEl = null;
  var itemTitleLabelEl = null;
  var itemFormEl = null;
  var itemCloseEl = null;
  var itemCancelEl = null;
  var itemDeleteEl = null;
  var itemTitleInput = null;
  var itemDateInput = null;
  var itemStartInput = null;
  var itemEndInput = null;
  var itemDestinationInput = null;
  var itemStartDateInput = null;
  var itemEndDateInput = null;
  var itemStatusSelect = null;
  var itemNoteInput = null;
  var itemNoteCounterEl = null;
  var itemErrorTitleEl = null;
  var itemErrorDateEl = null;
  var itemErrorTimeEl = null;
  var itemErrorTripDateEl = null;
  var itemRemindInput = null;
  var itemErrorRemindEl = null;
  var itemRemindHintEl = null;

  /* ---- 提醒引擎（内存态即可：重启后按「到点 90 秒内」重新判定，历史不补响）---- */
  var reminderStackEl = null;
  var btnNotifyEl = null;
  /** 已触发过的提醒，键 = 任务 + 日期 + 提前量 + 开始时间 */
  var reminderFired = {};
  /** 「稍后提醒」队列：[{ task, at, key }] */
  var reminderSnoozes = [];
  var reminderTickerId = null;

  /* ---- 显示设置浮层 ---- */
  var displayOverlayEl = null;
  var displaySheetEl = null;
  var displayTitleEl = null;
  var displayCloseEl = null;
  var displayDoneEl = null;
  var displayNoteEl = null;
  var displaySettingsEl = null;

  /* ---- 铃声浮层（列表 / 试听 / 选择 / 保存）---- */
  var btnRingtoneEl = null;
  var ringtoneOverlayEl = null;
  var ringtoneSheetEl = null;
  var ringtoneListEl = null;
  var ringtoneCurrentNameEl = null;
  var ringtoneCurrentPlayEl = null;
  var ringtoneHintEl = null;
  var ringtoneSaveEl = null;
  var ringtoneCancelEl = null;
  var ringtoneCloseEl = null;
  var ringtoneTrigger = null;
  var ringtoneOpenedAt = 0;
  /** 浮层内的草稿选择：未点「保存」不落库 */
  var ringtoneDraftId = '';
  /** 已保存的铃声 id（启动时从存储读一次，供菜单标题展示） */
  var ringtoneSavedId = '';

  /* ==================== 三、内部状态 ==================== */

  var state = {
    /** @type {Array<Object>} 课程列表（内存中的唯一数据源） */
    courses: [],
    /** @type {string|null} 正在编辑的课程 id，null 表示新增 */
    editingId: null,
    /** @type {'grid'|'list'|'trips'|'tasks'} 当前栏目 */
    view: 'grid',
    /** @type {Array<Object>} 任务列表（数据源在 sections 存储层，这里只是内存副本） */
    tasks: [],
    /** @type {Array<Object>} 行程列表（旅游栏目下一轮接入 UI） */
    trips: [],
    /** @type {string} 任务栏目选中的日期（本地日期字符串 YYYY-MM-DD） */
    tasksDate: '',
    /** @type {string} 旅游栏目选中的日期（'' = 全部，下一轮接入） */
    tripsDate: '',
    /** @type {Object} 栏目配置（lastSection / dates / configs，来自 sections:v1） */
    sectionConfig: {
      lastSection: 'grid',
      dates: { tasks: '', trips: '' },
      configs: {
        list: { layout: 'row', showMeta: true, showSide: true, showAvatar: true, showGroupTitle: true },
        trips: { layout: 'row', showMeta: true, showSide: true, showAvatar: true, showGroupTitle: true },
        tasks: { layout: 'row', showMeta: true, showSide: true, showAvatar: true, showGroupTitle: true }
      }
    },
    /** @type {'task'|'trip'} 新增/编辑浮层当前的业务类型 */
    itemMode: 'task',
    /** @type {string|null} 正在编辑的任务/行程 id，null 表示新增 */
    itemEditingId: null,
    /**
     * @type {'week'|'day'} 课表显示方式：整周 / 按天。
     * 只在内存里，不写 sections:v1、也不新增任何存储键：
     * 刷新后按屏幕宽度重新取默认值（窄屏按天、宽屏整周）。
     */
    ttMode: 'week',
    /** @type {number} 按天模式选中的星期（1-7）；0 / 非法时取今天 */
    ttDay: 0,
    /** @type {boolean} 用户是否手动切换过显示方式（是则 resize 不再覆盖他的选择） */
    ttModeUserSet: false
  };

  /** 新增/编辑浮层的表单快照（脏检查用） */
  var itemFormSnapshot = '';
  /** 打开浮层前的焦点元素 */
  var itemTrigger = null;
  /** 显示设置浮层打开前的焦点元素与打开时刻 */
  var settingsTrigger = null;
  var displayOpenedAt = 0;

  /** 打开面板时的表单快照，用于判断是否有未保存修改 */
  var formSnapshot = '';
  /** 打开面板前的焦点元素，用于关闭后归还焦点 */
  var lastFormTrigger = null;
  /** 确认框中待解决的 Promise resolve 函数 */
  var confirmResolver = null;
  /** aria-live 播报令牌：用于丢弃过期的播报 */
  var announceToken = 0;
  /** 确认框打开前的焦点元素 */
  var lastConfirmTrigger = null;
  /** 待撤销的删除记录 */
  var pendingUndo = null;
  var undoTimerId = null;
  var toastHideTimerId = null;
  /** 滚动锁定的嵌套层数与还原位置 */
  var scrollLockDepth = 0;
  var savedScrollY = 0;
  /** 各面板最近一次打开的时间戳，用于过滤“打开瞬间”落在遮罩上的连点误触 */
  var overlayOpenedAt = 0;
  var detailOpenedAt = 0;
  var importOpenedAt = 0;
  /** 对话框栈：栈顶为当前活跃对话框 */
  var dialogStack = [];

  /** 排课助手当前推荐的时段（null 表示没有可推荐时段） */
  var pendingSuggestion = null;
  /** 详情浮层当前展示的课程 id */
  var detailCourseId = null;
  var lastDetailTrigger = null;

  /** 互换模式状态 */
  var swapState = {
    /** 是否处于互换模式 */
    active: false,
    /** 已选课程 id，按选择顺序（最多 2 个） */
    picked: [],
    /** 执行中守卫：确认框打开或写库过程中为 true，防止连点造成两次交换 */
    busy: false
  };
  /** 工作日志浮层打开前的焦点元素 */
  var logTrigger = null;
  /** 工作日志浮层最近一次打开的时间戳（遮罩误触守卫） */
  var logOpenedAt = 0;
  /** 视口变化后重测操作条高度的定时器 */
  var swapMetricsTimerId = null;

  /** 课程目录浮层的临时状态（纯 UI，不落库） */
  var catalogState = {
    /** @type {string} 搜索关键词（即时过滤） */
    query: '',
    /** @type {string} 当前分类，'全部' 表示不过滤 */
    category: '全部',
    /** @type {Object<string, boolean>} 已勾选的目录 id */
    selected: {},
    /** @type {Object<string, boolean>} 已有课程的判重键集合（打开 / 提交前重建） */
    keys: {},
    /** @type {Object<string, HTMLElement>} 目录 id → 行元素（就地更新用） */
    rowEls: {},
    /** @type {HTMLElement|null} 打开浮层前的焦点元素 */
    trigger: null,
    /** 提交中守卫：防止连点造成两次写入 */
    busy: false,
    /** 浮层最近一次打开的时间戳（遮罩误触守卫） */
    openedAt: 0
  };

  /** 图片导入面板的临时状态 */
  var importState = {
    /** @type {Array<File>} 已选图片 */
    files: [],
    /** @type {Array<string>} 缩略图 objectURL，关闭时必须 revoke */
    objectUrls: [],
    /** @type {Array<Object>} 候选课程（可编辑） */
    candidates: [],
    busy: false,
    /** 请求序号：用于丢弃已被替换的识别结果 */
    requestId: 0,
    /** 流程阶段：collecting / recognizing / reviewing / importing */
    phase: 'collecting',
    /** 图片来源：camera / screenshot（决定预处理长边档位） */
    source: 'screenshot',
    /** 当前识别的 AbortController（取消时 abort） */
    controller: null,
    /** 进度文案最后一次刷新的时间戳（节流用） */
    lastStatusAt: 0,
    origin: 'toolbar',
    trigger: null
  };

  /** 「今天」信息条的定时器（页面隐藏时暂停） */
  var todayTimerId = null;
  /** 打开相机输入前聚焦的元素（取消拍摄后焦点不能留在 body） */
  var cameraTrigger = null;
  /** 「更多」菜单是否展开 */
  var moreMenuOpen = false;

  /** 遮罩元素的隐藏定时器（避免快速开关时的竞态） */
  var hideTimers = new WeakMap();

  /* ==================== 四、工具函数 ==================== */

  /**
   * 是否偏好减少动效。
   * @return {boolean}
   */
  function prefersReducedMotion() {
    return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
  }

  /**
   * 数字补零到两位。
   * @param {number} value
   * @return {string}
   */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /**
   * 生成唯一 id：优先 crypto.randomUUID，降级为时间戳 + 随机串。
   * @return {string}
   */
  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      try {
        return window.crypto.randomUUID();
      } catch (err) {
        /* 极少数环境不允许调用，降级处理 */
      }
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * 本地时区的今天是周几。
   * @return {number} 1-7，1 表示周一
   */
  function todayWeekday() {
    var day = new Date().getDay(); // 0 = 周日
    return day === 0 ? 7 : day;
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
  function clampWeekday(value) {
    var num = Number(value);
    if (!isFinite(num) || Math.floor(num) !== num || num < 1 || num > 7) {
      return 1;
    }
    return num;
  }

  /**
   * 创建一个带类名与文本的元素（全程 textContent，不拼 HTML）。
   * @param {string} tagName
   * @param {string} [className]
   * @param {string} [text]
   * @return {HTMLElement}
   */
  function createEl(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (typeof text === 'string') {
      node.textContent = text;
    }
    return node;
  }

  /**
   * 创建内联图标（引用文档内的 <symbol>）。
   * @param {string} symbolId 例如 "icon-clock"
   * @return {SVGElement}
   */
  function createIcon(symbolId) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + symbolId);
    svg.appendChild(use);
    return svg;
  }

  /**
   * 解析地点字段：判断是否为可点击链接。
   * @param {*} place
   * @return {{isUrl: boolean, href: string, text: string}|null}
   */
  function toPlaceInfo(place) {
    var value = typeof place === 'string' ? place.trim() : '';
    if (!value) {
      return null;
    }
    if (!/^https?:\/\//i.test(value)) {
      return { isUrl: false, href: '', text: value };
    }
    var label = '打开链接';
    try {
      var url = new URL(value);
      var host = url.hostname.replace(/^www\./i, '');
      if (host) {
        var hasPath = url.pathname && url.pathname !== '/' && url.pathname !== '';
        label = hasPath ? host + '/…' : host;
      }
    } catch (err) {
      label = '打开链接';
    }
    return { isUrl: true, href: value, text: label };
  }

  /**
   * 无障碍播报（写入隐藏的 aria-live 区域）。
   * 用递增令牌丢弃过期播报：连续快速操作（例如选点后立刻取消）时，
   * 只让最后一条消息落到 aria-live 里，避免读屏念到上一条过期内容。
   * @param {string} message
   */
  function announce(message) {
    if (!liveRegionEl) {
      return;
    }
    announceToken += 1;
    var token = announceToken;
    liveRegionEl.textContent = '';
    window.setTimeout(function () {
      if (token !== announceToken) {
        return;
      }
      liveRegionEl.textContent = message;
    }, 30);
  }

  /**
   * 课程是否有可用于课表的时间区间。
   * @param {Object} course
   * @return {boolean}
   */
  function isSchedulable(course) {
    var startMinute = timeToMinutes(course && course.startTime);
    var endMinute = timeToMinutes(course && course.endTime);
    return startMinute >= 0 && endMinute >= 0 && endMinute > startMinute;
  }

  /**
   * 时间 → 所在节次（1..12，落在课间/午休/界外返回 0）。
   * 优先用 timetable.js 的 periodIndexOf（节次表的唯一所有者）。
   * @param {string} time 'HH:MM'
   * @return {number}
   */
  function periodIndexByTime(time) {
    var api = window.CourseTimetable;
    if (api && typeof api.periodIndexOf === 'function') {
      return api.periodIndexOf(time);
    }
    var minute = timeToMinutes(time);
    if (minute < 0) {
      return 0;
    }
    for (var i = 0; i < PERIODS.length; i += 1) {
      var startMinute = timeToMinutes(PERIODS[i].start);
      var endMinute = timeToMinutes(PERIODS[i].end);
      if (startMinute >= 0 && endMinute >= 0 && minute >= startMinute && minute < endMinute) {
        return PERIODS[i].index || i + 1;
      }
    }
    return 0;
  }

  /**
   * 该时间是否正好是某一节的开始/结束边界（如 08:30、10:00、11:50）。
   * @param {string} time
   * @param {'start'|'end'} edge
   * @return {boolean}
   */
  function isPeriodBoundary(time, edge) {
    var minute = timeToMinutes(time);
    if (minute < 0) {
      return false;
    }
    var key = edge === 'start' ? 'start' : 'end';
    for (var i = 0; i < PERIODS.length; i += 1) {
      if (timeToMinutes(PERIODS[i][key]) === minute) {
        return true;
      }
    }
    return false;
  }

  /**
   * 该时间是否正好是某一节的结束边界（如 10:00、11:50）。
   * @param {string} time
   * @return {boolean}
   */
  function isPeriodEndBoundary(time) {
    return isPeriodBoundary(time, 'end');
  }

  /**
   * 结束时间 → 所在（或刚好结束的）节次。
   * 结束时间常常正好落在节次边界上（08:30–10:00 的第 2 节到 10:00 结束），
   * 这时往回看 1 分钟就能拿到正确的节次；非边界、又不落在任何节内则返回 0。
   * @param {string} time
   * @return {number}
   */
  function periodIndexForEnd(time) {
    var index = periodIndexByTime(time);
    if (index > 0) {
      return index;
    }
    if (!isPeriodEndBoundary(time)) {
      return 0;
    }
    var minute = timeToMinutes(time) - 1;
    if (minute < 0) {
      return 0;
    }
    return periodIndexByTime(pad2(Math.floor(minute / 60)) + ':' + pad2(minute % 60));
  }

  /**
   * 一门课按「节」数算几节：
   *   08:30–10:00（第1-2节，两端都对齐节次边界）→ 2
   *   10:20–11:50（第3-4节）→ 2
   *   08:30–09:10（只上第1节）→ 1
   *   09:00–09:30（非整节，起点不对齐）→ 1
   * 只有「首尾都正好落在节次边界上」才按区间求和，否则一律 1 节；
   * 任一端取不到节次也按 1 节，绝不抛错。
   * @param {Object} course
   * @return {number} 0 表示这门课没有可用时间
   */
  function countCoursePeriods(course) {
    if (!isSchedulable(course)) {
      return 0;
    }
    if (!isPeriodBoundary(course.startTime, 'start') || !isPeriodBoundary(course.endTime, 'end')) {
      return 1;
    }
    var start = periodIndexByTime(course.startTime);
    var end = periodIndexForEnd(course.endTime);
    if (start > 0 && end >= start) {
      return end - start + 1;
    }
    return 1;
  }

  /**
   * 按 id 查找课程。
   * @param {string} courseId
   * @return {Object|null}
   */
  function findCourseById(courseId) {
    for (var i = 0; i < state.courses.length; i += 1) {
      if (state.courses[i].id === courseId) {
        return state.courses[i];
      }
    }
    return null;
  }

  /* ========== 四·补：颜色体系（工具函数续） ========== */

  /**
   * 校验颜色 token。
   * 非白名单值一律归零为空串：既不会写入本地存储，也不会透传进 class / data 属性。
   * @param {*} value
   * @return {string} '' 或 8 个 token 之一
   */
  function normalizeCourseColor(value) {
    if (typeof value !== 'string') {
      return '';
    }
    var token = value.trim().toLowerCase();
    return COURSE_COLORS.indexOf(token) >= 0 ? token : '';
  }

  /**
   * 课名的稳定哈希。
   * 只与字符码有关，与课程 id、顺序、时间、设备无关，
   * 因此同一个课名在任何时候、任何设备、刷新多少次都得到同一个值。
   * @param {string} name
   * @return {number} 非负整数
   */
  function hashCourseName(name) {
    var text = typeof name === 'string' ? name.trim() : '';
    var hash = 0;
    for (var i = 0; i < text.length; i += 1) {
      // 31 * hash 的最大值远小于 2^53，不会丢精度，结果可跨设备复现
      hash = (hash * 31 + text.charCodeAt(i)) % COLOR_HASH_MOD;
    }
    return hash;
  }

  /**
   * 由课名派生颜色：旧数据没有 color 时靠它立刻拿到颜色。
   * 只在渲染时调用，绝不写回存储（保持「不迁移」原则）。
   * @param {string} name
   * @return {string}
   */
  function deriveCourseColor(name) {
    return COURSE_COLORS[hashCourseName(name) % COURSE_COLORS.length];
  }

  /**
   * 课程最终展示用的颜色 token：显式颜色优先，否则按课名自动派生。
   * @param {Object} course
   * @return {string}
   */
  function resolveCourseColor(course) {
    var explicit = normalizeCourseColor(course && course.color);
    if (explicit) {
      return explicit;
    }
    return deriveCourseColor(course && course.name);
  }

  /**
   * 唯一的颜色出口：课表块 / 清单卡片 / 详情圆点都必须经过这里，
   * 保证同一门课在三处拿到同一个 data-color（CSS 只认这个属性）。
   * @param {HTMLElement} node
   * @param {Object} course
   * @return {HTMLElement}
   */
  function applyCourseColor(node, course) {
    if (!node) {
      return node;
    }
    node.setAttribute('data-color', resolveCourseColor(course));
    return node;
  }

  /* ========== 四·续：栏目工具 ========== */

  /**
   * 当前（或指定）栏目是否属于「课程」两个视图。
   * 课程专属的渲染 / 显隐 / 互换入口只在这里为真时才处理。
   * @param {string} [view]
   * @return {boolean}
   */
  function isCourseView(view) {
    var target = typeof view === 'string' ? view : state.view;
    return target === 'grid' || target === 'list';
  }

  /**
   * 栏目对应的分段控件按钮。
   * @param {string} view
   * @return {HTMLElement|null}
   */
  function tabElementFor(view) {
    if (view === 'grid') {
      return viewTabGridEl;
    }
    if (view === 'list') {
      return viewTabListEl;
    }
    if (view === 'trips') {
      return viewTabTripsEl;
    }
    if (view === 'tasks') {
      return viewTabTasksEl;
    }
    return null;
  }

  /**
   * 按 id 查找任务。
   * @param {string} taskId
   * @return {Object|null}
   */
  function findTaskById(taskId) {
    for (var i = 0; i < state.tasks.length; i += 1) {
      if (state.tasks[i].id === taskId) {
        return state.tasks[i];
      }
    }
    return null;
  }

  /**
   * 任务在 state.tasks 里的下标，找不到返回 -1。
   * @param {string} taskId
   * @return {number}
   */
  function taskIndexOf(taskId) {
    for (var i = 0; i < state.tasks.length; i += 1) {
      if (state.tasks[i].id === taskId) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 按 id 查找任务行元素。
   * @param {string} taskId
   * @return {HTMLElement|null}
   */
  function findTaskRow(taskId) {
    if (!tasksListEl) {
      return null;
    }
    var rows = tasksListEl.querySelectorAll('.row[data-task-id]');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute('data-task-id') === taskId) {
        return rows[i];
      }
    }
    return null;
  }

  /**
   * 按 id 查找行程。
   * @param {string} tripId
   * @return {Object|null}
   */
  function findTripById(tripId) {
    for (var i = 0; i < state.trips.length; i += 1) {
      if (state.trips[i].id === tripId) {
        return state.trips[i];
      }
    }
    return null;
  }

  /**
   * 行程在 state.trips 里的下标，找不到返回 -1。
   * @param {string} tripId
   * @return {number}
   */
  function tripIndexOf(tripId) {
    for (var i = 0; i < state.trips.length; i += 1) {
      if (state.trips[i].id === tripId) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 按 id 查找行程行元素。
   * @param {string} tripId
   * @return {HTMLElement|null}
   */
  function findTripRow(tripId) {
    if (!tripsListEl) {
      return null;
    }
    var rows = tripsListEl.querySelectorAll('.row[data-trip-id]');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute('data-trip-id') === tripId) {
        return rows[i];
      }
    }
    return null;
  }

  /* ========== 四·续二：栏目显示配置（T04） ========== */

  /**
   * 当前栏目对应的「列表配置键」。
   * 课表不是列表，落到 list（设置入口在课表下本来就不显示）。
   * @return {'list'|'trips'|'tasks'}
   */
  function currentListSection() {
    if (state.view === 'trips') {
      return 'trips';
    }
    if (state.view === 'tasks') {
      return 'tasks';
    }
    return 'list';
  }

  /**
   * 取某栏目的显示配置（缺省时按默认值补齐并写回内存，绝不自动写库）。
   * @param {'list'|'trips'|'tasks'} section
   * @return {{layout: string, showMeta: boolean, showSide: boolean, showAvatar: boolean, showGroupTitle: boolean}}
   */
  function getViewConfig(section) {
    var key = LIST_SECTION_NAMES[section] ? section : 'list';
    if (!state.sectionConfig.configs) {
      state.sectionConfig.configs = {};
    }
    var cfg = state.sectionConfig.configs[key];
    if (!cfg || typeof cfg !== 'object') {
      cfg = {
        layout: LAYOUT_ROW,
        showMeta: true,
        showSide: true,
        showAvatar: true,
        showGroupTitle: true
      };
      state.sectionConfig.configs[key] = cfg;
      return cfg;
    }
    // 逐项兜底：老配置 / 缺字段时按"显示"处理，避免整行消失
    if (cfg.layout !== LAYOUT_COLUMN) {
      cfg.layout = LAYOUT_ROW;
    }
    cfg.showMeta = cfg.showMeta !== false;
    cfg.showSide = cfg.showSide !== false;
    cfg.showAvatar = cfg.showAvatar !== false;
    cfg.showGroupTitle = cfg.showGroupTitle !== false;
    return cfg;
  }

  /**
   * 把配置写成 data-* 属性交给 CSS（结构不重建，只换选择器）。
   *
   * ⚠️ 只对**分组内部**那个 `.section-list` 使用：外层 `#tasks-list` / `#trips-list`
   * 也是 `.section-list`，若把 `data-layout` 写在外层，`.group` 会变成 grid item
   * （两个分组被排成两列），而不是"每个分组内部两列"。
   * @param {HTMLElement} listEl 分组内部的行容器 <ul>
   * @param {Object} cfg
   */
  function applySectionListConfig(listEl, cfg) {
    if (!listEl) {
      return;
    }
    listEl.setAttribute('data-layout', cfg.layout === LAYOUT_COLUMN ? 'column' : 'row');
    listEl.setAttribute('data-avatar', cfg.showAvatar === false ? 'false' : 'true');
  }

  /**
   * 清单栏目的配置落点（#course-list）。
   * 清单的"简要信息 / 分组标题"只做 CSS 隐藏，不改 createCard 结构（零回归）。
   * @param {HTMLElement} listEl
   * @param {Object} cfg
   */
  function applyCourseListConfig(listEl, cfg) {
    if (!listEl) {
      return;
    }
    listEl.setAttribute('data-layout', cfg.layout === LAYOUT_COLUMN ? 'column' : 'row');
    listEl.setAttribute('data-meta', cfg.showMeta === false ? 'false' : 'true');
    listEl.setAttribute('data-group-title', cfg.showGroupTitle === false ? 'false' : 'true');
  }

  /**
   * 该栏目是否支持某个配置项。
   * @param {'list'|'trips'|'tasks'} section
   * @param {string} key
   * @return {boolean}
   */
  function isSettingSupported(section, key) {
    var support = SETTING_SUPPORT[section] || SETTING_SUPPORT.list;
    return support[key] !== false;
  }

  /**
   * 取标题首字符（头像里的字）。用 Array.from 兜住 emoji / 代理对。
   * @param {*} text
   * @return {string}
   */
  function firstChar(text) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value) {
      return '·';
    }
    var chars = Array.from ? Array.from(value) : value.split('');
    return chars.length > 0 ? chars[0] : value.charAt(0);
  }

  /**
   * 把容器内所有具名控件序列化为字符串（表单脏检查用）。
   * 与课程表单的 JSON.stringify(readRawFormValues()) 等价，但字段集由 DOM 决定，
   * 因此同一个函数可以服务课程表单与任务/行程表单。
   * @param {HTMLElement} rootEl
   * @return {string}
   */
  function serializeFields(rootEl) {
    if (!rootEl) {
      return '';
    }
    var fields = rootEl.querySelectorAll('[name]');
    var pairs = [];
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      var value = '';
      if (field.type === 'checkbox' || field.type === 'radio') {
        // radio 只记选中的那个，否则同组多个 input 会互相覆盖
        if (field.type === 'radio' && !field.checked) {
          continue;
        }
        value = field.type === 'checkbox' ? String(field.checked) : String(field.value);
      } else {
        value = String(field.value);
      }
      pairs.push(field.name + '=' + value);
    }
    return pairs.join('&');
  }

  /* ==================== 五、数据层 ==================== */

  /**
   * 校验并修补单条课程记录，非法记录返回 null 由调用方丢弃。
   * 兼容老数据：新增的 source / importBatchId / color 都是可选字段，缺省时不写入。
   * @param {*} raw
   * @return {Object|null}
   */
  function sanitizeCourse(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      return null;
    }
    var createdAt = Number(raw.createdAt);
    var updatedAt = Number(raw.updatedAt);
    var course = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
      name: name,
      weekday: clampWeekday(raw.weekday),
      startTime: normalizeTimeString(raw.startTime),
      endTime: normalizeTimeString(raw.endTime),
      teacher: typeof raw.teacher === 'string' ? raw.teacher : '',
      place: typeof raw.place === 'string' ? raw.place : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX_LENGTH) : '',
      createdAt: isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
      updatedAt: isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now()
    };
    // 可选字段：只有来源明确时才写入，绝不凭空补默认值
    if (raw.source === 'manual' || raw.source === 'image') {
      course.source = raw.source;
    }
    if (typeof raw.importBatchId === 'string' && raw.importBatchId) {
      course.importBatchId = raw.importBatchId;
    }
    // 颜色：只接受 8 个白名单 token，脏值直接归零（不写字段）；
    // 老数据没有 color 时不补、不迁移，渲染时按课名自动派生
    var colorToken = normalizeCourseColor(raw.color);
    if (colorToken) {
      course.color = colorToken;
    }
    return course;
  }

  /**
   * 统一的课程记录构造入口：手动录入与图片导入都走这里，避免两条写库路径分叉。
   * @param {Object} values 已校验的业务字段（7 个基础字段 + 可选的 color）
   * @param {{id?: string, createdAt?: number, now?: number, source?: string, importBatchId?: string}} [options]
   * @return {Object}
   */
  function buildCourseRecord(values, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var now = isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    var createdAt = Number(opts.createdAt);
    var record = {
      id: typeof opts.id === 'string' && opts.id ? opts.id : createId(),
      name: values.name,
      weekday: clampWeekday(values.weekday),
      startTime: normalizeTimeString(values.startTime),
      endTime: normalizeTimeString(values.endTime),
      teacher: String(values.teacher || ''),
      place: String(values.place || ''),
      note: String(values.note || '').slice(0, NOTE_MAX_LENGTH),
      createdAt: isFinite(createdAt) && createdAt > 0 ? createdAt : now,
      updatedAt: now
    };
    if (opts.source === 'manual' || opts.source === 'image') {
      record.source = opts.source;
    }
    if (typeof opts.importBatchId === 'string' && opts.importBatchId) {
      record.importBatchId = opts.importBatchId;
    }
    // 颜色是可选字段：只有显式选中具体颜色才写入；
    // 空串代表「自动配色」，不落库（旧数据与图片导入都走这条路）
    var colorToken = normalizeCourseColor(values.color);
    if (colorToken) {
      record.color = colorToken;
    }
    return record;
  }

  /**
   * 读取本地数据。任何异常都降级为空列表并给出提示，绝不让页面白屏。
   * @return {{courses: Array<Object>, notice: string|null}}
   */
  function readStore() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return {
        courses: [],
        notice: '当前浏览器禁止访问本地存储，课程可以查看但无法保存。'
      };
    }
    if (!raw) {
      return { courses: [], notice: null };
    }

    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { courses: [], notice: '本地数据已损坏，已重置为空列表（原有内容未被覆盖）。' };
    }

    // 兼容两种结构：{version, courses} 或直接是数组
    var list = null;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.courses)) {
      list = parsed.courses;
    }

    if (!list) {
      return { courses: [], notice: '本地数据格式无法识别，已重置为空列表（原有内容未被覆盖）。' };
    }

    var courses = [];
    var dropped = 0;
    for (var i = 0; i < list.length; i += 1) {
      var course = sanitizeCourse(list[i]);
      if (course) {
        courses.push(course);
      } else {
        dropped += 1;
      }
    }
    // 忽略的记录需要告知用户，否则下次保存会静默覆盖掉原始数据
    var notice = null;
    if (dropped > 0) {
      notice = '有 ' + dropped + ' 条记录格式不完整，已忽略（原始数据未被覆盖）。';
    }
    return { courses: courses, notice: notice };
  }

  /**
   * 写入本地数据。
   * @param {Array<Object>} courses
   * @return {{ok: boolean, notice: string|null}}
   */
  function writeStore(courses) {
    try {
      var payload = { version: STORE_VERSION, courses: courses };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return { ok: true, notice: null };
    } catch (err) {
      return {
        ok: false,
        notice: '本地存储写入失败（可能空间已满或被禁用），本次修改未能保存。'
      };
    }
  }

  /**
   * 持久化当前课程列表，失败时提示用户。
   * @return {boolean}
   */
  function persistCourses() {
    var result = writeStore(state.courses);
    if (!result.ok && result.notice) {
      showNotice(result.notice);
    }
    return result.ok;
  }

  /**
   * 持久化任务列表（写 `course-manager:tasks:v1`，与课程键完全隔离）。
   * @return {boolean}
   */
  function persistTasks() {
    if (typeof SEC.writeTasks !== 'function') {
      showNotice('任务模块未能加载，本次修改无法保存。');
      return false;
    }
    var result = SEC.writeTasks(state.tasks);
    if (!result.ok && result.notice) {
      showNotice(result.notice);
    }
    return result.ok;
  }

  /**
   * 写入栏目配置（lastSection / 选中日期 / 列表配置）。
   * @param {Object} patch 见 CourseSections.writeConfig
   * @return {boolean}
   */
  function persistSectionConfig(patch) {
    if (typeof SEC.writeConfig !== 'function') {
      return false;
    }
    var result = SEC.writeConfig(patch);
    if (!result.ok && result.notice) {
      showNotice(result.notice);
    }
    if (patch && typeof patch === 'object') {
      if (typeof patch.lastSection === 'string' && patch.lastSection) {
        state.sectionConfig.lastSection = patch.lastSection;
      }
      if (patch.dates && typeof patch.dates === 'object') {
        if (typeof patch.dates.tasks === 'string') {
          state.sectionConfig.dates.tasks = patch.dates.tasks;
        }
        if (typeof patch.dates.trips === 'string') {
          state.sectionConfig.dates.trips = patch.dates.trips;
        }
      }
      if (patch.configs && typeof patch.configs === 'object') {
        var keys = ['list', 'trips', 'tasks'];
        for (var i = 0; i < keys.length; i += 1) {
          if (patch.configs[keys[i]]) {
            state.sectionConfig.configs[keys[i]] = patch.configs[keys[i]];
          }
        }
      }
    }
    return result.ok;
  }

  /* ==================== 六、视图层 · 公共 ==================== */

  /**
   * 显示顶部提示条。
   * @param {string} message
   */
  function showNotice(message) {
    if (!noticeEl || !noticeTextEl) {
      return;
    }
    noticeTextEl.textContent = message;
    noticeEl.hidden = false;
  }

  /**
   * 隐藏顶部提示条。
   */
  function hideNotice() {
    if (noticeEl) {
      noticeEl.hidden = true;
    }
  }

  /**
   * 格式化时间段展示文案。
   * @param {Object} course
   * @return {string}
   */
  function formatTimeRange(course) {
    var start = normalizeTimeString(course.startTime);
    var end = normalizeTimeString(course.endTime);
    if (start && end) {
      return start + '–' + end;
    }
    if (start) {
      return start + ' 开始';
    }
    if (end) {
      return '至 ' + end;
    }
    return '';
  }

  /* ==================== 七、视图层 · 清单 ==================== */

  /**
   * 按星期分组，组内按开始时间升序。
   * @param {Array<Object>} courses
   * @return {Array<{weekday: number, items: Array<Object>}>}
   */
  function groupCourses(courses) {
    var buckets = {};
    for (var i = 0; i < courses.length; i += 1) {
      var course = courses[i];
      var weekday = clampWeekday(course.weekday);
      if (!buckets[weekday]) {
        buckets[weekday] = [];
      }
      buckets[weekday].push(course);
    }

    var groups = [];
    for (var day = 1; day <= 7; day += 1) {
      var items = buckets[day];
      if (!items || items.length === 0) {
        continue;
      }
      items.sort(function (a, b) {
        var diff = timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
        if (diff !== 0) {
          return diff;
        }
        return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
      });
      groups.push({ weekday: day, items: items });
    }
    return groups;
  }

  /**
   * 创建卡片中的一行元信息（图标 + 文本）。
   * @param {string} iconId
   * @param {string|Node} content
   * @return {HTMLLIElement}
   */
  function createMetaItem(iconId, content) {
    var item = document.createElement('li');
    item.className = 'card__meta-item';
    item.appendChild(createIcon(iconId));
    var textWrap = document.createElement('span');
    textWrap.className = 'card__meta-text';
    if (typeof content === 'string') {
      textWrap.textContent = content;
    } else {
      textWrap.appendChild(content);
    }
    item.appendChild(textWrap);
    return item;
  }

  /**
   * 创建地点节点：URL 渲染为安全外链，其余为纯文本。
   * @param {{isUrl: boolean, href: string, text: string}} placeInfo
   * @return {HTMLElement}
   */
  function createPlaceNode(placeInfo) {
    if (!placeInfo.isUrl) {
      var span = document.createElement('span');
      span.textContent = placeInfo.text;
      return span;
    }
    var link = document.createElement('a');
    link.className = 'card__link';
    link.href = placeInfo.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = placeInfo.href;
    link.textContent = placeInfo.text;
    link.appendChild(createIcon('icon-link'));
    return link;
  }

  /**
   * 创建卡片操作按钮。
   * @param {string} action "edit" | "delete"
   * @param {string} iconId
   * @param {string} label
   * @param {string} extraClass
   * @param {string} courseName 用于无障碍标签
   * @return {HTMLButtonElement}
   */
  function createActionButton(action, iconId, label, extraClass, courseName) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--sm ' + extraClass;
    button.setAttribute('data-action', action);
    button.setAttribute('aria-label', label + '课程：' + courseName);
    button.appendChild(createIcon(iconId));
    var span = document.createElement('span');
    span.textContent = label;
    button.appendChild(span);
    return button;
  }

  /**
   * 渲染单张课程卡片。
   * @param {Object} course
   * @return {HTMLElement}
   */
  function createCard(course) {
    // 互换模式下卡片变成可选项（按钮语义），不提供编辑 / 删除入口，
    // 避免「点卡片」同时意味着「打开详情」和「选中用于互换」。
    if (swapState.active) {
      return createSwapCard(course);
    }

    var card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('data-course-id', course.id);
    // 颜色统一由 applyCourseColor 产出 data-color（左侧竖条 + 课名前的圆点由 CSS 负责）
    applyCourseColor(card, course);

    var title = document.createElement('h3');
    title.className = 'card__name';
    title.textContent = course.name;
    card.appendChild(title);

    // 版式：标题一行；下面「信息区 + 操作区」两列并排（信息区里时间/教师/地点行内用 · 分隔）。
    // 目的：320px 下单卡 <=140px，首屏完整可见 >=3 张；信息一条不删。
    var body = createEl('div', 'card__body');
    var info = createEl('div', 'card__info');

    var timeRange = formatTimeRange(course);
    if (timeRange) {
      var timeRow = document.createElement('p');
      timeRow.className = 'card__time';
      timeRow.appendChild(createIcon('icon-clock'));
      var timeText = document.createElement('span');
      timeText.textContent = timeRange;
      timeRow.appendChild(timeText);
      info.appendChild(timeRow);
    }

    var meta = document.createElement('ul');
    meta.className = 'card__meta';

    var teacher = typeof course.teacher === 'string' ? course.teacher.trim() : '';
    if (teacher) {
      meta.appendChild(createMetaItem('icon-user', teacher));
    }

    var placeInfo = toPlaceInfo(course.place);
    if (placeInfo) {
      meta.appendChild(createMetaItem('icon-pin', createPlaceNode(placeInfo)));
    }

    if (meta.childNodes.length > 0) {
      info.appendChild(meta);
    }

    var note = typeof course.note === 'string' ? course.note.trim() : '';
    if (note) {
      var noteEl = document.createElement('p');
      noteEl.className = 'card__note';
      noteEl.textContent = note;
      info.appendChild(noteEl);
    }

    var actions = document.createElement('div');
    actions.className = 'card__actions';
    actions.appendChild(
      createActionButton('edit', 'icon-edit', '编辑', 'btn--ghost', course.name)
    );
    actions.appendChild(
      createActionButton('delete', 'icon-trash', '删除', 'btn--danger-ghost', course.name)
    );

    body.appendChild(info);
    body.appendChild(actions);
    card.appendChild(body);

    return card;
  }

  /**
   * 互换模式下的课程卡片：整张卡片就是一个可切换选中态的按钮。
   * 只保留「名称 + 星期 + 时间」，让用户一眼看清要交换的是哪个位置。
   * @param {Object} course
   * @return {HTMLButtonElement}
   */
  function createSwapCard(course) {
    var pickedIndex = swapState.picked.indexOf(course.id);
    var isPicked = pickedIndex >= 0;
    var weekday = clampWeekday(course.weekday);
    var timeText = formatTimeRange(course) || '时间未设置';
    var positionText = WEEKDAY_LABELS[weekday - 1] + ' ' + timeText;

    var card = createEl('button', 'card card--swap');
    card.type = 'button';
    card.setAttribute('data-course-id', course.id);
    applyCourseColor(card, course);
    card.setAttribute('aria-pressed', String(isPicked));
    var ariaLabel =
      course.name +
      '，' +
      positionText +
      (isPicked
        ? '，已选为第 ' + (pickedIndex + 1) + ' 门，再次点击可取消'
        : '，点击选择用于互换');
    card.setAttribute('aria-label', ariaLabel);
    if (isPicked) {
      card.classList.add('is-swap-picked');
    }

    card.appendChild(createEl('span', 'card__name', course.name));
    var timeRow = createEl('span', 'card__time');
    timeRow.appendChild(createIcon('icon-clock'));
    timeRow.appendChild(createEl('span', '', timeText));
    card.appendChild(timeRow);
    card.appendChild(createEl('span', 'card__swap-day', positionText));
    if (isPicked) {
      card.appendChild(createEl('span', 'swap-pick-badge', String(pickedIndex + 1)));
    }
    return card;
  }

  /**
   * 渲染一个星期分组。
   * @param {number} weekday 1-7
   * @param {Array<Object>} items
   * @param {number} todayWeekdayValue
   * @param {Object} [cfg] 清单栏目的显示配置
   * @return {HTMLElement}
   */
  function createGroup(weekday, items, todayWeekdayValue, cfg) {
    var config = cfg || null;
    var section = document.createElement('section');
    section.className = 'group';
    var label = WEEKDAY_LABELS[weekday - 1];

    // 关掉「分组标题」时不渲染组头，但分组语义必须靠 aria-label 保住
    // （否则读屏听到的是一串没有归属的卡片）
    if (config && config.showGroupTitle === false) {
      section.setAttribute('aria-label', label);
    } else {
      section.setAttribute('aria-labelledby', 'group-title-' + weekday);
    }

    if (!config || config.showGroupTitle !== false) {
      var header = document.createElement('div');
      header.className = 'group__header';

      var title = document.createElement('h2');
      title.className = 'group__title';
      title.id = 'group-title-' + weekday;
      title.textContent = label;
      header.appendChild(title);

      if (weekday === todayWeekdayValue) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '今天';
        header.appendChild(badge);
      }

      var count = document.createElement('span');
      count.className = 'group__count';
      count.textContent = items.length + ' 门';
      header.appendChild(count);

      section.appendChild(header);
    }

    var cards = document.createElement('div');
    cards.className = 'group__cards';
    for (var i = 0; i < items.length; i += 1) {
      cards.appendChild(createCard(items[i]));
    }
    section.appendChild(cards);

    return section;
  }

  /**
   * 渲染分组清单。
   */
  function renderList() {
    if (!courseListEl) {
      return;
    }
    courseListEl.textContent = '';
    var cfg = getViewConfig('list');
    applyCourseListConfig(courseListEl, cfg);
    var today = todayWeekday();
    var groups = groupCourses(state.courses);
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < groups.length; i += 1) {
      fragment.appendChild(createGroup(groups[i].weekday, groups[i].items, today, cfg));
    }
    courseListEl.appendChild(fragment);
  }

  /* ==================== 八、视图层 · 课表网格 ==================== */

  /**
   * 在容器内绝对定位一个区块。
   * @param {HTMLElement} node
   * @param {number} topMinute 相对时轴起点的分钟偏移
   * @param {number} heightMinute 高度（分钟）
   */
  function positionByTime(node, topMinute, heightMinute) {
    node.style.top = (topMinute * PX_PER_MINUTE).toFixed(2) + 'px';
    node.style.height = (heightMinute * PX_PER_MINUTE).toFixed(2) + 'px';
  }

  /**
   * 渲染「未设置时间」区块（老数据里可能存在没有时间的课程，绝不能丢）。
   * @param {Array<Object>} courses
   */
  function renderUnscheduled(courses) {
    if (!unscheduledEl || !unscheduledListEl) {
      return;
    }
    unscheduledListEl.textContent = '';
    if (courses.length === 0) {
      unscheduledEl.hidden = true;
      return;
    }
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < courses.length; i += 1) {
      fragment.appendChild(createCard(courses[i]));
    }
    unscheduledListEl.appendChild(fragment);
    unscheduledEl.hidden = false;
  }

  /**
   * 创建单个课程块。
   * 位置与高度完全由真实 startTime/endTime 映射（不要求整节次对齐），
   * 因此跨节次不会被裁剪、相邻短课块也不会互相压盖。
   * 触控热区不靠 min-height，而是由透明伪元素在「同道上真正空出来的时间」里外扩。
   * @param {{course: Object, startMinute: number, endMinute: number, lane: number, lanes: number}} item
   * @param {{startMinute: number, endMinute: number}} bounds
   * @param {{up: number, down: number}} hit 伪元素可向外扩展的像素（已避开相邻块）
   * @return {HTMLButtonElement}
   */
  function createBlock(item, bounds, hit) {
    var course = item.course;
    var pickedIndex = swapState.active ? swapState.picked.indexOf(course.id) : -1;
    var topMinute = item.startMinute - bounds.startMinute;
    var rawHeightMinute = item.endMinute - item.startMinute;
    // 严格按时间计算，不再设 44px 下限（否则短课块会压住后面的块）
    var pixelHeight = rawHeightMinute * PX_PER_MINUTE;

    var block = createEl('button', 'tt-block');
    block.type = 'button';
    block.setAttribute('data-course-id', course.id);
    // 颜色统一由 applyCourseColor 产出 data-color（左侧 4px 竖条 + tint 底色由 CSS 负责）
    applyCourseColor(block, course);
    // 互换模式下课程块本身就是一个「选择项」：整块（含伪元素热区）都可点选
    if (swapState.active) {
      block.classList.add('is-swap-candidate');
      block.setAttribute('aria-pressed', pickedIndex >= 0 ? 'true' : 'false');
      if (pickedIndex >= 0) {
        block.classList.add('is-swap-picked');
      }
    }

    var laneWidth = 100 / item.lanes;
    block.style.top = (topMinute * PX_PER_MINUTE).toFixed(2) + 'px';
    block.style.height = pixelHeight.toFixed(2) + 'px';
    block.style.left = 'calc(' + (item.lane * laneWidth).toFixed(4) + '% + 2px)';
    block.style.width = 'calc(' + laneWidth.toFixed(4) + '% - 4px)';

    // 透明热区外扩（只在空档里扩，绝不侵入相邻块的地盘）
    if (hit && (hit.up > 0 || hit.down > 0)) {
      block.style.setProperty('--hit-top', (-hit.up).toFixed(2) + 'px');
      block.style.setProperty('--hit-bottom', (-hit.down).toFixed(2) + 'px');
    }

    // 信息密度按可用高度降级（真实高度变矮后细化出 tiny 一档）
    var tier = 'tiny';
    if (pixelHeight >= 88) {
      tier = 'high';
    } else if (pixelHeight >= 56) {
      tier = 'mid';
    } else if (pixelHeight >= 26) {
      tier = 'low';
    }
    // 三道及以上并排时块宽很窄，只保留名称（时间会被截成无意义碎片）
    if (item.lanes >= 3 && (tier === 'high' || tier === 'mid')) {
      tier = 'narrow';
    }
    block.setAttribute('data-tier', tier);

    var timeText =
      normalizeTimeString(course.startTime) + '–' + normalizeTimeString(course.endTime);
    var weekdayText = WEEKDAY_LABELS[clampWeekday(course.weekday) - 1];
    var teacherText = typeof course.teacher === 'string' ? course.teacher.trim() : '';
    var placeInfo = toPlaceInfo(course.place);

    // 无障碍标签始终包含「星期 + 时间 + 是否与他课重叠」，
    // 这样即使块被压到只剩名称、或被并排分道，读屏也能唯一辨识。
    var ariaLabel = course.name + '，' + weekdayText + ' ' + timeText;
    if (item.lanes > 1) {
      ariaLabel +=
        '，与另外 ' + (item.lanes - 1) + ' 门课时间重叠，这是并排的第 ' + (item.lane + 1) + ' 个';
    }
    if (swapState.active) {
      ariaLabel +=
        pickedIndex >= 0
          ? '，已选为第 ' + (pickedIndex + 1) + ' 门，再次点击可取消选择'
          : '，点击选择用于互换';
    } else {
      ariaLabel += '，查看课程详情';
    }
    block.setAttribute('aria-label', ariaLabel);

    if (item.lanes >= 3) {
      // 三道以上时块内只剩名称，title 兜住完整信息（悬停 / 长按可辨识）
      var titleParts = [course.name, weekdayText + ' ' + timeText];
      if (teacherText) {
        titleParts.push(teacherText);
      }
      if (placeInfo) {
        titleParts.push(placeInfo.text);
      }
      if (item.lanes > 1) {
        titleParts.push('共 ' + item.lanes + ' 门重叠，第 ' + (item.lane + 1) + ' 个');
      }
      block.title = titleParts.join(' · ');
    } else {
      block.title = course.name + '  ' + timeText;
    }

    block.appendChild(createEl('span', 'tt-block__name', course.name));
    if (tier === 'high' || tier === 'mid') {
      block.appendChild(createEl('span', 'tt-block__time', timeText));
    }
    if (tier === 'high') {
      var metaParts = [];
      if (teacherText) {
        metaParts.push(teacherText);
      }
      if (placeInfo) {
        metaParts.push(placeInfo.text);
      }
      if (metaParts.length > 0) {
        block.appendChild(createEl('span', 'tt-block__meta', metaParts.join(' · ')));
      }
    }

    // 选中序号角标：1 / 2，与底部操作条里的顺序一致
    if (pickedIndex >= 0) {
      block.appendChild(createEl('span', 'swap-pick-badge', String(pickedIndex + 1)));
    }

    return block;
  }

  /**
   * 计算一个课程块的触控热区可以向上 / 向下外扩多少像素。
   *
   * 原则（按优先级）：① 绝不侵入同一道上相邻课程块的地盘；② 在不侵入的前提下尽量凑到 44px。
   * 相邻块之间的空档（同一道上下相接的课程之间）就是可扩展的上限，
   * 因此短课块即使只能保住自身高度，也不会压住后面的块。
   *
   * @param {{startMinute: number, endMinute: number}} item
   * @param {Array<{startMinute: number, endMinute: number}>} laneItems 同一道上的块（按开始时间升序）
   * @param {{startMinute: number, endMinute: number}} bounds
   * @return {{up: number, down: number}}
   */
  function computeHitArea(item, laneItems, bounds) {
    var top = (item.startMinute - bounds.startMinute) * PX_PER_MINUTE;
    var height = (item.endMinute - item.startMinute) * PX_PER_MINUTE;
    var need = TAP_MIN_PX - height;
    if (!(need > 0)) {
      return { up: 0, down: 0 };
    }
    var index = laneItems ? laneItems.indexOf(item) : -1;
    var prev = index > 0 ? laneItems[index - 1] : null;
    var next = index >= 0 && index < laneItems.length - 1 ? laneItems[index + 1] : null;
    var upAvailable = prev ? (item.startMinute - prev.endMinute) * PX_PER_MINUTE : top;
    var bodyHeight = (bounds.endMinute - bounds.startMinute) * PX_PER_MINUTE;
    var downAvailable = next
      ? (next.startMinute - item.endMinute) * PX_PER_MINUTE
      : bodyHeight - (top + height);
    if (!(upAvailable > 0)) {
      upAvailable = 0;
    }
    if (!(downAvailable > 0)) {
      downAvailable = 0;
    }
    // 先均分，某一侧不够再由另一侧补
    var up = Math.min(need / 2, upAvailable);
    var down = Math.min(need - up, downAvailable);
    var rest = need - up - down;
    if (rest > 0) {
      up += Math.min(rest, upAvailable - up);
    }
    return { up: Math.round(up * 100) / 100, down: Math.round(down * 100) / 100 };
  }

  /**
   * 创建某一天的列：淡淡的节次格 + 午休带 + 课程块。
   * @param {number} weekday
   * @param {Array<Object>} layout 该天已分道的块（layoutDayBlocks 的结果）
   * @param {{startMinute: number, endMinute: number}} bounds
   * @param {number} today
   * @return {HTMLElement}
   */
  function createDayColumn(weekday, layout, bounds, today) {
    var column = createEl('div', 'tt__col');
    column.setAttribute('data-weekday', String(weekday));
    if (weekday === today) {
      column.classList.add('is-today');
    }

    // 节次格：仅用于提供极淡网格线，保证行列可对照
    for (var i = 0; i < PERIODS.length; i += 1) {
      var period = PERIODS[i];
      var startMinute = timeToMinutes(period.start);
      var endMinute = timeToMinutes(period.end);
      if (startMinute < bounds.startMinute) {
        startMinute = bounds.startMinute;
      }
      if (endMinute > bounds.endMinute) {
        endMinute = bounds.endMinute;
      }
      if (endMinute <= startMinute) {
        continue;
      }
      var cell = createEl('div', 'tt__cell');
      positionByTime(cell, startMinute - bounds.startMinute, endMinute - startMinute);
      column.appendChild(cell);
    }

    // 午休带：明确不可排课
    var lunchStart = timeToMinutes(LUNCH.start);
    var lunchEnd = timeToMinutes(LUNCH.end);
    if (lunchStart >= 0 && lunchEnd > lunchStart && lunchEnd > bounds.startMinute && lunchStart < bounds.endMinute) {
      var bandStart = Math.max(lunchStart, bounds.startMinute);
      var bandEnd = Math.min(lunchEnd, bounds.endMinute);
      var lunchBand = createEl('div', 'tt__lunch');
      lunchBand.setAttribute('aria-hidden', 'true');
      positionByTime(lunchBand, bandStart - bounds.startMinute, bandEnd - bandStart);
      column.appendChild(lunchBand);
    }

    // 课程块：同一 weekday 上时间重叠的课程已由 layoutDayBlocks 分道。
    // 同一道内按开始时间升序，据此算出每块可以安全外扩的触控热区。
    var laneBuckets = {};
    for (var lk = 0; lk < layout.length; lk += 1) {
      var laneKey = layout[lk].lane;
      if (!laneBuckets[laneKey]) {
        laneBuckets[laneKey] = [];
      }
      laneBuckets[laneKey].push(layout[lk]);
    }
    for (var k = 0; k < layout.length; k += 1) {
      var laneItems = laneBuckets[layout[k].lane] || [];
      column.appendChild(createBlock(layout[k], bounds, computeHitArea(layout[k], laneItems, bounds)));
    }

    return column;
  }

  /**
   * 构建整张课表（按 state.ttMode 分派：整周 7 列网格 / 按天时间轴）。
   */
  function buildTimetable() {
    if (!timetableScrollEl) {
      return;
    }
    timetableScrollEl.textContent = '';

    var scheduled = [];
    var unscheduled = [];
    for (var i = 0; i < state.courses.length; i += 1) {
      if (isSchedulable(state.courses[i])) {
        scheduled.push(state.courses[i]);
      } else {
        unscheduled.push(state.courses[i]);
      }
    }
    renderUnscheduled(unscheduled);

    if (PERIODS.length === 0 || typeof TT.buildAxisBounds !== 'function') {
      timetableScrollEl.appendChild(
        createEl('p', 'timetable__fallback', '课表模块未能加载，请切换到「清单」视图查看课程。')
      );
      return;
    }

    ensureTimetableMode();
    if (state.ttMode === 'day') {
      buildDayView(scheduled);
      syncTimetableModeControls();
      return;
    }

    var bounds = TT.buildAxisBounds(scheduled);
    var bodyHeight = (bounds.endMinute - bounds.startMinute) * PX_PER_MINUTE;
    var today = todayWeekday();

    // 先按天分道：同时算出全表最多需要几道，
    // 用它抬升列最小宽度，保证并排的每一道仍有 44px 的可点宽度。
    var dayLayouts = {};
    var maxLanes = 1;
    for (var layoutDay = 1; layoutDay <= 7; layoutDay += 1) {
      var layoutCourses = [];
      for (var li = 0; li < scheduled.length; li += 1) {
        if (clampWeekday(scheduled[li].weekday) === layoutDay) {
          layoutCourses.push(scheduled[li]);
        }
      }
      var dayLayout =
        typeof TT.layoutDayBlocks === 'function' ? TT.layoutDayBlocks(layoutCourses) : [];
      dayLayouts[layoutDay] = dayLayout;
      for (var lb = 0; lb < dayLayout.length; lb += 1) {
        if (dayLayout[lb].lanes > maxLanes) {
          maxLanes = dayLayout[lb].lanes;
        }
      }
    }

    var table = createEl('div', 'tt');
    // 每道至少 48px（块左右各留 2px 内缩后仍有 44px 可点）。
    // 只在宽屏生效：手机上列宽固定 88px，否则一屏放不下几列。
    // 这两个数交给 applyTimetableColumnFit() 折算成宽屏的 --tt-col-fit（见该函数）。
    ttWideColMin = Math.max(88, maxLanes * 48);
    ttMaxLanes = maxLanes;

    // 表头行（整行 sticky 顶部）：左上角 + 7 个星期
    var headRow = createEl('div', 'tt__row tt__row--head');
    var corner = createEl('div', 'tt__corner', '节次');
    headRow.appendChild(corner);

    for (var day = 1; day <= 7; day += 1) {
      var head = createEl('div', 'tt__day-head');
      if (day === today) {
        head.classList.add('is-today');
      }
      head.appendChild(createEl('span', 'tt__day-name', WEEKDAY_LABELS[day - 1]));
      if (day === today) {
        head.appendChild(createEl('span', 'tt__day-today', '今天'));
      }
      headRow.appendChild(head);
    }
    table.appendChild(headRow);

    // 主体行：左侧节次轴（sticky 左）+ 7 列课程区
    var bodyRow = createEl('div', 'tt__row tt__row--body');
    bodyRow.style.height = bodyHeight.toFixed(2) + 'px';

    var axis = createEl('div', 'tt__axis');

    for (var p = 0; p < PERIODS.length; p += 1) {
      var periodItem = PERIODS[p];
      var periodStart = timeToMinutes(periodItem.start);
      var periodEnd = timeToMinutes(periodItem.end);
      if (periodStart < bounds.startMinute) {
        periodStart = bounds.startMinute;
      }
      if (periodEnd > bounds.endMinute) {
        periodEnd = bounds.endMinute;
      }
      if (periodEnd <= periodStart) {
        continue;
      }
      var axisCell = createEl('div', 'tt__axis-cell');
      positionByTime(axisCell, periodStart - bounds.startMinute, periodEnd - periodStart);
      axisCell.appendChild(createEl('span', 'tt__axis-index', '第' + periodItem.index + '节'));
      axisCell.appendChild(
        createEl('span', 'tt__axis-time', periodItem.start + '–' + periodItem.end)
      );
      axis.appendChild(axisCell);
    }

    var lunchStartMinute = timeToMinutes(LUNCH.start);
    var lunchEndMinute = timeToMinutes(LUNCH.end);
    if (
      lunchStartMinute >= 0 &&
      lunchEndMinute > lunchStartMinute &&
      lunchEndMinute > bounds.startMinute &&
      lunchStartMinute < bounds.endMinute
    ) {
      var lunchBandStart = Math.max(lunchStartMinute, bounds.startMinute);
      var lunchBandEnd = Math.min(lunchEndMinute, bounds.endMinute);
      var axisLunch = createEl('div', 'tt__axis-lunch');
      positionByTime(axisLunch, lunchBandStart - bounds.startMinute, lunchBandEnd - lunchBandStart);
      axisLunch.appendChild(createEl('span', 'tt__axis-lunch-title', '午休'));
      axisLunch.appendChild(
        createEl('span', 'tt__axis-lunch-time', LUNCH.start + '–' + LUNCH.end)
      );
      axis.appendChild(axisLunch);
    }
    bodyRow.appendChild(axis);

    // 7 列课程区
    var columns = createEl('div', 'tt__cols');
    for (var colDay = 1; colDay <= 7; colDay += 1) {
      columns.appendChild(createDayColumn(colDay, dayLayouts[colDay], bounds, today));
    }
    bodyRow.appendChild(columns);
    table.appendChild(bodyRow);

    timetableScrollEl.appendChild(table);
    applyTimetableColumnFit();
    syncTimetableModeControls();
    syncWeekScrollState();
  }

  /**
   * 宽屏列宽的自适应：只在「差几个像素就能铺满」时才铺满，否则老实接受横滑。
   *
   * 为什么需要：768 宽的窗口里容器内宽 688，而 7×88 + 76 = 692 —— 恒差 4px。
   * 结果就是第 7 列被裁掉几个像素、`scrollWidth - clientWidth > 2` 成立，
   * 于是顺带弹出「左右滑动查看整周」——用 4px 的溢出骗用户去滑动。
   *
   * 做法：算出「7 列刚好铺满」的列宽（`--tt-col-fit`），但**只在它接近整周下限
   * （88px）时**才采用；偏离太多（640 的 73px、700 的 82px）就回落到 88px 接受横滑 ——
   * 横滑至少信息完整，把列压窄会让「08:30–10:00」变省略号、课名被裁行，比横滑更糟。
   *
   * 另一条边界：当天有多门课时间重叠、需要并排分道时，列宽不能被压到每道不足 44px
   * 的可点宽度（`.tt-block` 左右各内缩 2px，所以一道要 48px 才有 44px 的块）。
   * 这种"物理上放不下"的情况宁可横滑（提示是诚实的），也不做假适配。
   */
  function applyTimetableColumnFit() {
    if (!timetableScrollEl) {
      return;
    }
    var table = timetableScrollEl.querySelector('.tt');
    if (!table) {
      return;
    }
    var axisEl = timetableScrollEl.querySelector('.tt__axis');
    var axisWidth = axisEl ? axisEl.getBoundingClientRect().width : 0;
    var available = timetableScrollEl.clientWidth - axisWidth;
    if (!(available > 0)) {
      return;
    }
    var fit = Math.floor(available / 7);
    if (!(fit > 0)) {
      return;
    }
    // 一道 48px（块左右各内缩 2px 后才剩 44px 的可点宽度）；
    // 再 +2px 余量吸收两个亚像素损耗：① 列自己的 1px 左边框（`.tt__col` 是 border-box，
    // 块宽按列内容宽算）；② `width: calc(33.3333% - 4px)` 的百分比截断。
    // 只 +1 时三道并排实测 43.98px，差 0.02px 就不达标。
    var tapFloor = Math.max(TAP_MIN_PX, ttMaxLanes * (TAP_MIN_PX + 4) + 2);
    // 只有差 ≤4px 才铺满；差得多说明这个宽度根本放不下 7 列，回落 88px 走横滑
    var effective = fit >= ttWideColMin - 4 ? Math.min(ttWideColMin, fit) : ttWideColMin;
    if (effective < tapFloor) {
      effective = tapFloor;
    }
    table.style.setProperty('--tt-col-fit', effective + 'px');
  }

  /* ==================== 七·二、手机端按天课表（整周 / 按天） ==================== */

  /**
   * 当前视口是否更该用「按天」：< 560px 视为窄屏。
   * @return {boolean}
   */
  function prefersDayTimetable() {
    if (typeof window.matchMedia !== 'function') {
      return false;
    }
    try {
      return window.matchMedia(TT_DAY_QUERY).matches;
    } catch (err) {
      return false;
    }
  }

  /**
   * 按屏幕宽度取默认显示方式（只在首次进入、或用户没手动切换过时生效）。
   * @return {'week'|'day'}
   */
  function defaultTimetableMode() {
    return prefersDayTimetable() ? 'day' : 'week';
  }

  /**
   * 保证 state.ttMode / state.ttDay 始终是合法值。
   */
  function ensureTimetableMode() {
    if (state.ttMode !== 'week' && state.ttMode !== 'day') {
      state.ttMode = defaultTimetableMode();
    }
    if (!(state.ttDay >= 1 && state.ttDay <= 7)) {
      state.ttDay = todayWeekday();
    }
  }

  /**
   * 切换「整周 / 按天」。只改内存，不写 sections:v1、也不新增存储键。
   * @param {'week'|'day'} mode
   * @param {boolean} fromUser 是否由用户手动切换（是则 resize 不再覆盖）
   */
  function setTimetableMode(mode, fromUser) {
    var next = mode === 'day' ? 'day' : 'week';
    if (fromUser) {
      state.ttModeUserSet = true;
    }
    if (next === state.ttMode) {
      syncTimetableModeControls();
      return;
    }
    state.ttMode = next;
    if (next === 'day' && !(state.ttDay >= 1 && state.ttDay <= 7)) {
      state.ttDay = todayWeekday();
    }
    if (next === 'week') {
      // 切回整周时允许再自动定位一次今天列（用户手动滚过的除外）
      ttAutoScrolled = false;
    }
    hideTtHint();
    buildTimetable();
    syncTimetableModeControls();
    announce(next === 'day' ? '已切换到按天显示' : '已切换到整周显示');
  }

  /**
   * 同步「整周 / 按天」分段控件与星期 chips。
   */
  function syncTimetableModeControls() {
    var dayMode = state.ttMode === 'day';
    if (ttModeWeekEl) {
      if (dayMode) {
        ttModeWeekEl.classList.remove('is-active');
      } else {
        ttModeWeekEl.classList.add('is-active');
      }
      ttModeWeekEl.setAttribute('aria-pressed', dayMode ? 'false' : 'true');
    }
    if (ttModeDayEl) {
      if (dayMode) {
        ttModeDayEl.classList.add('is-active');
      } else {
        ttModeDayEl.classList.remove('is-active');
      }
      ttModeDayEl.setAttribute('aria-pressed', dayMode ? 'true' : 'false');
    }
    if (ttDaysEl) {
      ttDaysEl.hidden = !dayMode;
    }
    renderWeekdayChips();
  }

  /**
   * 重建星期 chips（周一…周日）。
   *
   * - 今天：`aria-current="date"` + 小圆点（不靠颜色单独承载语义，读屏也会念「今天」）
   * - 选中：aria-pressed=true + 实心样式
   * - 重建时把焦点还给同一天的 chip，键盘用户不会因为重建而丢焦点
   */
  function renderWeekdayChips() {
    if (!ttDaysEl) {
      return;
    }
    var activeEl = document.activeElement;
    var focusWeekday = 0;
    if (activeEl && typeof ttDaysEl.contains === 'function' && ttDaysEl.contains(activeEl)) {
      var rawDay = Number(activeEl.getAttribute('data-weekday'));
      focusWeekday = rawDay >= 1 && rawDay <= 7 ? rawDay : 0;
    }
    // 方向键 / 点击换天时，焦点必须跟着走到"新的那天"（否则读屏还在念旧的那天）。
    // pendingChipFocus 由 selectTimetableDay 写入，用一次就清掉。
    if (ttPendingChipFocus >= 1 && ttPendingChipFocus <= 7) {
      focusWeekday = ttPendingChipFocus;
      ttPendingChipFocus = 0;
    }
    ttDaysEl.textContent = '';
    if (state.ttMode !== 'day') {
      return;
    }
    ensureTimetableMode();
    var today = todayWeekday();
    var focusTarget = null;
    for (var day = 1; day <= 7; day += 1) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tt-day-chip';
      chip.setAttribute('data-weekday', String(day));
      chip.textContent = WEEKDAY_LABELS[day - 1];
      var selected = day === state.ttDay;
      if (selected) {
        chip.classList.add('is-selected');
      }
      chip.setAttribute('aria-pressed', selected ? 'true' : 'false');
      if (day === today) {
        chip.classList.add('is-today');
        chip.setAttribute('aria-current', 'date');
      }
      chip.setAttribute(
        'aria-label',
        WEEKDAY_LABELS[day - 1] + (day === today ? '，今天' : '')
      );
      ttDaysEl.appendChild(chip);
      if (day === focusWeekday) {
        focusTarget = chip;
      }
    }
    if (focusTarget) {
      safeFocus(focusTarget);
    }
  }

  /**
   * 按天模式选择某一天。
   * @param {number} weekday 1-7
   */
  function selectTimetableDay(weekday) {
    var day = Number(weekday);
    if (!(day >= 1 && day <= 7)) {
      return;
    }
    if (day === state.ttDay) {
      syncTimetableModeControls();
      return;
    }
    state.ttDay = day;
    // chips 会被重建，先记下"焦点应该落在哪天"，重建时再还给新 chip
    ttPendingChipFocus = day;
    buildTimetable();
    syncTimetableModeControls();
    announce('已切换到' + WEEKDAY_LABELS[day - 1]);
  }

  /**
   * 显示方式分段的点击委托。
   * @param {MouseEvent} event
   */
  function handleTimetableModeClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var button = target.closest('[data-tt-mode]');
    if (!button) {
      return;
    }
    setTimetableMode(button.getAttribute('data-tt-mode'), true);
  }

  /**
   * 星期 chips 的点击委托。
   * @param {MouseEvent} event
   */
  function handleTimetableDaysClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var chip = target.closest('.tt-day-chip[data-weekday]');
    if (!chip) {
      return;
    }
    selectTimetableDay(Number(chip.getAttribute('data-weekday')));
  }

  /**
   * 星期 chips 的键盘操作：←/→ 前后一天，Home/End 跳到周一/周日。
   * @param {KeyboardEvent} event
   */
  function handleTimetableDaysKeydown(event) {
    var key = event.key;
    var target = state.ttDay;
    if (key === 'ArrowLeft' || key === 'Left') {
      target = ((state.ttDay - 1 - 1 + 7) % 7) + 1;
    } else if (key === 'ArrowRight' || key === 'Right') {
      target = (state.ttDay % 7) + 1;
    } else if (key === 'Home') {
      target = 1;
    } else if (key === 'End') {
      target = 7;
    } else {
      return;
    }
    event.preventDefault();
    selectTimetableDay(target);
  }

  /**
   * 创建「按天」视图里的一个课程块。
   * 纵向堆叠（时间段 / 节次 / 课名 / 教师·地点 / 备注），不横向滚动、不做省略号截断。
   * @param {Object} course
   * @return {HTMLButtonElement}
   */
  function createDayCourseBlock(course) {
    var pickedIndex = swapState.active ? swapState.picked.indexOf(course.id) : -1;

    var block = document.createElement('button');
    block.type = 'button';
    block.className = 'td-block';
    block.setAttribute('data-course-id', course.id);
    applyCourseColor(block, course);
    if (swapState.active) {
      block.classList.add('is-swap-candidate');
      block.setAttribute('aria-pressed', pickedIndex >= 0 ? 'true' : 'false');
      if (pickedIndex >= 0) {
        block.classList.add('is-swap-picked');
      }
    }

    var timeText =
      normalizeTimeString(course.startTime) + '–' + normalizeTimeString(course.endTime);
    var periodStart = periodIndexByTime(course.startTime);
    var periodCount = countCoursePeriods(course);
    var periodText = '';
    if (periodStart > 0) {
      periodText =
        periodCount > 1
          ? '第' + periodStart + '–' + (periodStart + periodCount - 1) + '节'
          : '第' + periodStart + '节';
    }

    var timeRow = createEl('span', 'td-block__time-row');
    timeRow.appendChild(createEl('span', 'td-block__time', timeText));
    if (periodText) {
      timeRow.appendChild(createEl('span', 'td-block__period', periodText));
    }
    block.appendChild(timeRow);
    block.appendChild(createEl('span', 'td-block__name', course.name));

    var metaParts = [];
    var teacher = typeof course.teacher === 'string' ? course.teacher.trim() : '';
    if (teacher) {
      metaParts.push(teacher);
    }
    var placeInfo = toPlaceInfo(course.place);
    if (placeInfo) {
      metaParts.push(placeInfo.text);
    }
    if (metaParts.length > 0) {
      block.appendChild(createEl('span', 'td-block__meta', metaParts.join(' · ')));
    }
    var note = typeof course.note === 'string' ? course.note.trim() : '';
    if (note) {
      block.appendChild(createEl('span', 'td-block__note', note));
    }

    var weekdayText = WEEKDAY_LABELS[clampWeekday(course.weekday) - 1];
    var ariaLabel = course.name + '，' + weekdayText + ' ' + timeText;
    if (periodText) {
      ariaLabel += '，' + periodText;
    }
    if (teacher) {
      ariaLabel += '，' + teacher;
    }
    if (placeInfo) {
      ariaLabel += '，' + placeInfo.text;
    }
    if (swapState.active) {
      ariaLabel +=
        pickedIndex >= 0
          ? '，已选为第 ' + (pickedIndex + 1) + ' 门，再次点击可取消选择'
          : '，点击选择用于互换';
    } else {
      ariaLabel += '，查看课程详情';
    }
    block.setAttribute('aria-label', ariaLabel);
    block.title = course.name + '  ' + timeText;

    if (pickedIndex >= 0) {
      block.appendChild(createEl('span', 'swap-pick-badge', String(pickedIndex + 1)));
    }
    return block;
  }

  /**
   * 构建「按天」视图：顶部一行（周X + N 门 / N 节），下面是当天的课程纵向排列。
   * @param {Array<Object>} scheduled 有有效时间的课程
   */
  function buildDayView(scheduled) {
    if (!timetableScrollEl) {
      return;
    }
    // 按天视图没有横向滚动：清掉整周模式的溢出装饰
    timetableScrollEl.classList.remove('has-h-overflow');
    timetableScrollEl.classList.remove('is-scroll-start');
    timetableScrollEl.classList.remove('is-scroll-end');
    ttLastScrollLeft = 0;
    hideTtHint();

    var day = state.ttDay;
    var today = todayWeekday();
    var dayCourses = [];
    for (var i = 0; i < scheduled.length; i += 1) {
      if (clampWeekday(scheduled[i].weekday) === day) {
        dayCourses.push(scheduled[i]);
      }
    }
    dayCourses.sort(function (a, b) {
      var diff = timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
      if (diff !== 0) {
        return diff;
      }
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });

    var wrap = createEl('div', 'td');
    var head = createEl('div', 'td__head');
    var dayLabel = WEEKDAY_LABELS[day - 1] + (day === today ? ' · 今天' : '');
    head.appendChild(createEl('span', 'td__day', dayLabel));
    var periodTotal = 0;
    for (var p = 0; p < dayCourses.length; p += 1) {
      periodTotal += countCoursePeriods(dayCourses[p]);
    }
    head.appendChild(
      createEl(
        'span',
        'td__count',
        dayCourses.length === 0
          ? '没有课'
          : dayCourses.length + ' 门 · ' + periodTotal + ' 节'
      )
    );
    wrap.appendChild(head);

    if (dayCourses.length === 0) {
      wrap.appendChild(
        createEl('p', 'td__empty', day === today ? '今天没有课' : dayLabel + '没有课')
      );
      timetableScrollEl.appendChild(wrap);
      return;
    }

    var list = createEl('div', 'td__list');
    for (var k = 0; k < dayCourses.length; k += 1) {
      list.appendChild(createDayCourseBlock(dayCourses[k]));
    }
    wrap.appendChild(list);
    timetableScrollEl.appendChild(wrap);
  }

  /**
   * 整周模式下的「两端渐隐 + 首次进入的一行提示 + 自动定位到今天列」。
   */
  function syncWeekScrollState() {
    if (!timetableScrollEl) {
      return;
    }
    var el = timetableScrollEl;
    updateTimetableScrollMask();
    var overflow = el.scrollWidth - el.clientWidth > 2;
    if (!overflow) {
      hideTtHint();
      return;
    }
    // 自动定位到今天列：本次只做一次；用户手动滚过之后不再抢滚动
    if (!ttAutoScrolled && !ttUserScrolled) {
      ttAutoScrolled = true;
      scrollToToday(true);
      // 定位是同步完成的，立刻把滚动基线对齐并重算渐变：
      // 这样首帧的两端渐隐就是对的，不必等浏览器派发 scroll 事件
      // （等事件的话，第一眼看到的会是「右侧可滑」，而其实已经贴到右端了）。
      ttLastScrollLeft = el.scrollLeft;
      updateTimetableScrollMask();
    }
    if (!ttHintShown) {
      showTtHint();
    }
  }

  /**
   * 按「这一侧是否还有内容」维护两端渐隐的状态类。
   *
   * `.has-h-overflow` 表示整体有溢出（保留给外部观察/调试用），
   * `.is-scroll-start` / `.is-scroll-end` 表示已经贴到左 / 右端点，对应那一侧不再渐隐。
   */
  function updateTimetableScrollMask() {
    var el = timetableScrollEl;
    if (!el) {
      return;
    }
    if (state.ttMode === 'day') {
      el.classList.remove('has-h-overflow');
      el.classList.remove('is-scroll-start');
      el.classList.remove('is-scroll-end');
      return;
    }
    var overflow = el.scrollWidth - el.clientWidth > 2;
    if (overflow) {
      el.classList.add('has-h-overflow');
    } else {
      el.classList.remove('has-h-overflow');
    }
    var atStart = el.scrollLeft <= 2;
    var atEnd = !overflow || el.scrollLeft >= el.scrollWidth - el.clientWidth - 2;
    if (atStart) {
      el.classList.add('is-scroll-start');
    } else {
      el.classList.remove('is-scroll-start');
    }
    if (atEnd) {
      el.classList.add('is-scroll-end');
    } else {
      el.classList.remove('is-scroll-end');
    }
  }

  /**
   * 显示「左右滑动查看整周」提示（本次会话只显示一次，8 秒后自动收起）。
   */
  function showTtHint() {
    if (!ttHintEl) {
      return;
    }
    ttHintShown = true;
    ttHintEl.hidden = false;
    if (ttHintTimerId !== null) {
      window.clearTimeout(ttHintTimerId);
    }
    ttHintTimerId = window.setTimeout(function () {
      ttHintTimerId = null;
      hideTtHint();
    }, TT_HINT_TIMEOUT_MS);
  }

  /**
   * 收起「左右滑动查看整周」提示。
   */
  function hideTtHint() {
    if (ttHintTimerId !== null) {
      window.clearTimeout(ttHintTimerId);
      ttHintTimerId = null;
    }
    if (ttHintEl) {
      ttHintEl.hidden = true;
    }
  }

  /**
   * 课表横向滚动：更新渐隐、记录「用户手动滚过」。
   */
  function handleTimetableScroll() {
    var el = timetableScrollEl;
    if (!el) {
      return;
    }
    if (Math.abs(el.scrollLeft - ttLastScrollLeft) > 2) {
      // 自动定位（scrollToToday）会先把 ttLastScrollLeft 对齐，
      // 所以这里只要位置变了，就是用户自己滚的
      ttUserScrolled = true;
    }
    ttLastScrollLeft = el.scrollLeft;
    updateTimetableScrollMask();
  }

  /**
   * 视口变化：用户没手动选过显示方式时，按宽度重新取默认值。
   */
  function handleViewportChange() {
    var nextDefault = defaultTimetableMode();
    if (!state.ttModeUserSet && nextDefault !== state.ttMode) {
      state.ttMode = nextDefault;
      if (state.view === 'grid' && state.courses.length > 0) {
        buildTimetable();
      } else {
        syncTimetableModeControls();
      }
      return;
    }
    if (state.view === 'grid') {
      // 窗口宽度一变，7 列的兜底宽度和两端渐隐都要重算
      applyTimetableColumnFit();
      updateTimetableScrollMask();
    }
  }

  /**
   * 防抖后执行 handleViewportChange（缩放窗口时 resize 会连续触发几十次）。
   */
  function scheduleViewportChange() {
    if (ttResizeTimerId !== null) {
      window.clearTimeout(ttResizeTimerId);
    }
    ttResizeTimerId = window.setTimeout(function () {
      ttResizeTimerId = null;
      handleViewportChange();
    }, 150);
  }

  /* ==================== 八、今天信息条 / 更多菜单 ==================== */

  /**
   * 当前时刻的分钟数。
   * @return {number}
   */
  function nowMinutes() {
    var now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  /**
   * 今天的课程（按开始时间升序，只含有有效时间的课）。
   * @return {Array<Object>}
   */
  function todayCourses() {
    var today = todayWeekday();
    var list = [];
    for (var i = 0; i < state.courses.length; i += 1) {
      var course = state.courses[i];
      if (clampWeekday(course.weekday) !== today || !isSchedulable(course)) {
        continue;
      }
      list.push(course);
    }
    list.sort(function (a, b) {
      return timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
    });
    return list;
  }

  /**
   * 生成「今天」信息条的文案。
   * @return {{text: string, courseId: string}}
   */
  function buildTodayBarText() {
    var list = todayCourses();
    if (list.length === 0) {
      return { text: '今天没课', courseId: '' };
    }
    // 「今天 N 节」按节次区间求和：一门第1-2节的课算 2 节，不是 1 门
    var periodCount = 0;
    for (var p = 0; p < list.length; p += 1) {
      periodCount += countCoursePeriods(list[p]);
    }
    var nowMinute = nowMinutes();
    var current = null;
    var next = null;
    for (var i = 0; i < list.length; i += 1) {
      var startMinute = timeToMinutes(list[i].startTime);
      var endMinute = timeToMinutes(list[i].endTime);
      if (startMinute <= nowMinute && nowMinute < endMinute) {
        current = list[i];
        break;
      }
      if (startMinute > nowMinute) {
        next = list[i];
        break;
      }
    }

    if (current) {
      var remain = timeToMinutes(current.endTime) - nowMinute;
      var currentText = '今天 ' + periodCount + ' 节 · 正在上 ' + current.startTime + ' ' + current.name;
      if (current.place) {
        currentText += ' ' + current.place;
      }
      return { text: currentText + ' · 还有 ' + remain + ' 分钟', courseId: current.id };
    }
    if (next) {
      var wait = timeToMinutes(next.startTime) - nowMinute;
      var nextText = '今天 ' + periodCount + ' 节 · 下一节 ' + next.startTime + ' ' + next.name;
      if (next.place) {
        nextText += ' ' + next.place;
      }
      return { text: nextText + ' · 还有 ' + wait + ' 分钟', courseId: next.id };
    }
    return { text: '今天 ' + periodCount + ' 节 · 今天的课已结束', courseId: list[list.length - 1].id };
  }

  /**
   * 启动「今天」信息条 / 今日面板的 60s 定时刷新。
   *
   * 定时器同时负责两件事：
   *   ① 「今天 N 节 · 正在上 …」信息条的分钟数；
   *   ② 今日面板里「进行中」徽章的判定 —— 面板开着跨过上下课时间时，
   *      不刷新就会一直显示过期状态。
   * 因此只要「信息条可见」**或**「面板开着」就必须跑（见 syncTodayTimer）。
   */
  function startTodayTimer() {
    if (todayTimerId !== null) {
      return;
    }
    todayTimerId = window.setInterval(function () {
      if (document.hidden) {
        // 后台不跑：省电，也避免回来时数字跳变（恢复时统一刷一次）
        stopTodayTimer();
        return;
      }
      renderTodayBar();
      if (isTodayPanelOpen()) {
        refreshTodayPanel();
      }
    }, TODAY_REFRESH_MS);
  }

  /**
   * 停止「今天」信息条的定时刷新。
   */
  function stopTodayTimer() {
    if (todayTimerId === null) {
      return;
    }
    window.clearInterval(todayTimerId);
    todayTimerId = null;
  }

  /**
   * 「今天」信息条是否该显示（信息条与定时器共用这一个判定）。
   * @return {boolean}
   */
  function isTodayBarVisible() {
    return state.courses.length > 0 && state.view === 'grid';
  }

  /**
   * 按需启停 60s 定时器：信息条可见 或 今日面板开着 时都要跑。
   */
  function syncTodayTimer() {
    if (isTodayBarVisible() || isTodayPanelOpen()) {
      startTodayTimer();
      return;
    }
    stopTodayTimer();
  }

  /**
   * 渲染「今天」信息条：只在课表视图且有课程时显示。
   */
  function renderTodayBar() {
    if (!todayBarEl || !todayBarTextEl) {
      return;
    }
    var visible = isTodayBarVisible();
    todayBarEl.hidden = !visible;
    if (!visible) {
      // 信息条藏起来，但面板可能正开着（任务栏目也能打开面板），定时器不能一刀切停掉
      syncTodayTimer();
      return;
    }
    var info = buildTodayBarText();
    todayBarTextEl.textContent = info.text;
    if (info.courseId) {
      todayBarEl.setAttribute('data-course-id', info.courseId);
    } else {
      todayBarEl.removeAttribute('data-course-id');
    }
    syncTodayTimer();
  }

  /**
   * 点击「今天」信息条：打开今日面板（当日课程 + 当日任务）。
   * 以前这里只把课表滚到今天那一列，信息量太低——用户真正要的是「今天上什么、还要做什么」。
   */
  function handleTodayBarClick() {
    if (state.view !== 'grid') {
      setView('grid');
    }
    openTodayPanel(todayBarEl);
  }

  /* ==================== 八·二、今日面板（当日课程 + 当日任务） ==================== */

  /**
   * 今日面板的标题：「今天 · 11月28日 周六」，按当天实时生成。
   * 日期文案复用 sections.js 的实现（与任务栏目同一套），不另造一份。
   * @return {string}
   */
  function buildTodayPanelTitle() {
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    var parts = [];
    if (typeof SEC.formatDateLabel === 'function') {
      var dateLabel = SEC.formatDateLabel(today);
      if (dateLabel) {
        parts.push(dateLabel);
      }
    }
    if (typeof SEC.weekdayCn === 'function') {
      var weekdayLabel = SEC.weekdayCn(today);
      if (weekdayLabel) {
        parts.push(weekdayLabel);
      }
    }
    return parts.length > 0 ? '今天 · ' + parts.join(' ') : '今天';
  }

  /**
   * 今日任务：「今天」这一天的任务，未完成在前、已完成置底。
   *
   * 数据来源就是任务栏目那一份 `state.tasks`（用同一个 filterTasksByDate 过滤），
   * 不另建读取逻辑——面板勾选后任务栏目的界面与存储会同步变化。
   *
   * 排序（与「任务」栏目的 groupTasks 保持同一套语义，否则同一份数据两处顺序不一致）：
   *   ① 未完成在前、已完成置底；
   *   ② 未完成组内按 startTime 升序，没有时间的排在有时刻的后面；
   *   ③ 已完成组内按 doneAt 降序（刚勾选的排在最后），doneAt 相同再看 updatedAt
   *      —— 与 sections.js 的 doneSort 完全一致。
   * @return {Array<Object>}
   */
  function todayTaskList() {
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    var source =
      typeof SEC.filterTasksByDate === 'function'
        ? SEC.filterTasksByDate(state.tasks, today)
        : [];
    var list = source.slice();
    list.sort(function (a, b) {
      var aDone = Boolean(a && a.done);
      var bDone = Boolean(b && b.done);
      if (aDone !== bDone) {
        return aDone ? 1 : -1;
      }
      if (aDone && bDone) {
        // 已完成：与任务栏目同序（doneAt 降序 → 刚完成的在最后一行）
        var doneDiff = Number(b.doneAt || 0) - Number(a.doneAt || 0);
        if (doneDiff !== 0) {
          return doneDiff;
        }
        return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
      }
      var aMinute = timeToMinutes(a && a.startTime);
      var bMinute = timeToMinutes(b && b.startTime);
      if (aMinute !== bMinute) {
        // 没有时间的（-1）排在有时刻的后面
        if (aMinute < 0) {
          return 1;
        }
        if (bMinute < 0) {
          return -1;
        }
        return aMinute - bMinute;
      }
      return 0;
    });
    return list;
  }

  /**
   * 今日面板是否开着。
   * @return {boolean}
   */
  function isTodayPanelOpen() {
    return Boolean(todayOverlayEl && !todayOverlayEl.hidden);
  }

  /**
   * 创建「今日课程」里的一行：时间 + 课名（+ 进行中标记）+ 教师 / 地点。
   * 「进行中」用文字标记，不让颜色单独承载语义。
   * @param {Object} course
   * @param {number} nowMinute 当前时刻的分钟数
   * @return {HTMLLIElement}
   */
  function createTodayCourseRow(course, nowMinute) {
    var row = createEl('li', 'today-item');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'today-course';
    button.setAttribute('data-course-id', course.id);

    var timeText =
      normalizeTimeString(course.startTime) + '–' + normalizeTimeString(course.endTime);
    var startMinute = timeToMinutes(course.startTime);
    var endMinute = timeToMinutes(course.endTime);
    var running =
      startMinute >= 0 && endMinute > startMinute && startMinute <= nowMinute && nowMinute < endMinute;

    button.appendChild(createEl('span', 'today-course__time', timeText));

    var body = createEl('span', 'today-course__body');
    var nameRow = createEl('span', 'today-course__name-row');
    nameRow.appendChild(createEl('span', 'today-course__name', course.name));
    if (running) {
      nameRow.appendChild(createEl('span', 'today-course__badge', '进行中'));
    }
    body.appendChild(nameRow);

    var metaParts = [];
    var teacher = typeof course.teacher === 'string' ? course.teacher.trim() : '';
    if (teacher) {
      metaParts.push(teacher);
    }
    var placeInfo = toPlaceInfo(course.place);
    if (placeInfo) {
      metaParts.push(placeInfo.text);
    }
    if (metaParts.length > 0) {
      body.appendChild(createEl('span', 'today-course__meta', metaParts.join(' · ')));
    }
    button.appendChild(body);

    button.setAttribute(
      'aria-label',
      course.name + '，' + timeText + (running ? '，正在进行' : '') + '，查看课程详情'
    );
    row.appendChild(button);
    return row;
  }

  /**
   * 创建「今日任务」里的一行：勾选框 + 标题 + 时间（有 startTime 才显示）。
   * 勾选框复用任务栏目那套 `.row__check`（24px 视觉 + 44px 命中区 + aria-checked）。
   * @param {Object} task
   * @return {HTMLLIElement}
   */
  function createTodayTaskRow(task) {
    var row = createEl('li', 'today-task');
    row.setAttribute('data-task-id', task.id);
    if (task.done) {
      row.classList.add('is-done');
    }

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'row__check today-task__check';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', task.done ? 'true' : 'false');
    check.setAttribute(
      'aria-label',
      (task.done ? '取消完成：' : '标记完成：') + task.title
    );
    check.setAttribute('data-task-id', task.id);
    check.appendChild(createIcon('icon-check'));
    row.appendChild(check);

    row.appendChild(createEl('span', 'today-task__title', task.title));

    var timeText = normalizeTimeString(task.startTime);
    if (timeText) {
      row.appendChild(createEl('span', 'today-task__time', timeText));
    }
    return row;
  }

  /**
   * 构建「今日课程」整段（含空态）。
   * @return {HTMLElement}
   */
  function buildTodayCourseSection() {
    var section = createEl('section', 'today-sec');
    section.setAttribute('aria-labelledby', 'today-courses-title');
    var head = createEl('div', 'today-sec__head');
    var title = createEl('h3', 'today-sec__title', '今日课程');
    title.id = 'today-courses-title';
    head.appendChild(title);
    section.appendChild(head);

    var list = todayCourses();
    if (list.length === 0) {
      section.appendChild(createEl('p', 'today-empty', '今天没有课'));
      return section;
    }
    var nowMinute = nowMinutes();
    var ul = createEl('ul', 'today-list');
    for (var i = 0; i < list.length; i += 1) {
      ul.appendChild(createTodayCourseRow(list[i], nowMinute));
    }
    section.appendChild(ul);
    return section;
  }

  /**
   * 构建「今日任务」整段（含空态）。
   * @return {HTMLElement}
   */
  function buildTodayTaskSection() {
    var section = createEl('section', 'today-sec');
    section.setAttribute('aria-labelledby', 'today-tasks-title');
    var head = createEl('div', 'today-sec__head');
    var title = createEl('h3', 'today-sec__title', '今日任务');
    title.id = 'today-tasks-title';
    head.appendChild(title);
    section.appendChild(head);

    var list = todayTaskList();
    if (list.length === 0) {
      section.appendChild(createEl('p', 'today-empty', '今天没有任务'));
      return section;
    }
    var ul = createEl('ul', 'today-list');
    for (var i = 0; i < list.length; i += 1) {
      ul.appendChild(createTodayTaskRow(list[i]));
    }
    section.appendChild(ul);
    return section;
  }

  /**
   * 渲染今日面板内容（标题 + 今日课程 + 今日任务）。
   * 面板每次打开都重建，面板打开期间的数据变化（勾选 / 编辑 / 删除）也会重建。
   */
  function renderTodayPanel() {
    if (!todayBodyEl) {
      return;
    }
    if (todayTitleEl) {
      todayTitleEl.textContent = buildTodayPanelTitle();
    }
    todayBodyEl.textContent = '';
    todayBodyEl.appendChild(buildTodayCourseSection());
    todayBodyEl.appendChild(buildTodayTaskSection());
  }

  /**
   * 重建面板内容，并把焦点还给"重建前所在的那一行"。
   *
   * 60s 定时刷新（「进行中」徽章会随上下课变化）和面板打开期间的增删改都会走到这里，
   * 如果只是 renderTodayPanel()，键盘 / 读屏用户正在操作的那一行会被抽走，
   * 焦点掉回 BODY。因此先记下 data-task-id / data-course-id，重建后再找回来。
   */
  function refreshTodayPanel() {
    if (!isTodayPanelOpen() || !todayBodyEl) {
      return;
    }
    var active = document.activeElement;
    var focusType = '';
    var focusId = '';
    if (active && typeof active.getAttribute === 'function' && todayBodyEl.contains(active)) {
      var taskId = active.getAttribute('data-task-id');
      var courseId = active.getAttribute('data-course-id');
      if (taskId) {
        focusType = 'task';
        focusId = taskId;
      } else if (courseId) {
        focusType = 'course';
        focusId = courseId;
      }
    }
    renderTodayPanel();
    if (focusType === 'task') {
      focusTodayTaskCheck(focusId);
      return;
    }
    if (focusType === 'course') {
      focusTodayCourse(focusId);
    }
  }

  /**
   * 把焦点放回今日面板里某条任务的勾选框（勾选后重建面板不会丢焦点）。
   * @param {string} taskId
   */
  function focusTodayTaskCheck(taskId) {
    if (!todayBodyEl || !taskId) {
      return;
    }
    var checks = todayBodyEl.querySelectorAll('.today-task__check[data-task-id]');
    for (var i = 0; i < checks.length; i += 1) {
      if (checks[i].getAttribute('data-task-id') === taskId) {
        safeFocus(checks[i]);
        return;
      }
    }
    safeFocus(todayCloseEl || todaySheetEl);
  }

  /**
   * 把焦点放回今日面板里某一门课的行（面板刷新后不丢焦点）。
   * @param {string} courseId
   */
  function focusTodayCourse(courseId) {
    if (!todayBodyEl || !courseId) {
      return;
    }
    var rows = todayBodyEl.querySelectorAll('.today-course[data-course-id]');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute('data-course-id') === courseId) {
        safeFocus(rows[i]);
        return;
      }
    }
    safeFocus(todayCloseEl || todaySheetEl);
  }

  /**
   * 打开今日面板。
   * @param {HTMLElement|null} trigger 关闭后焦点归还到这个元素
   */
  function openTodayPanel(trigger) {
    if (!todayOverlayEl || !todaySheetEl) {
      return;
    }
    if (todayOverlayEl.classList.contains('is-open')) {
      return;
    }
    lastTodayTrigger = trigger || null;
    renderTodayPanel();
    showOverlay(todayOverlayEl);
    pushDialog(todaySheetEl, function () {
      closeTodayPanel(true);
    });
    lockBodyScroll();
    // 面板在任务栏目也能打开（那里没有「今天」信息条），定时器要跟着起来，
    // 否则「进行中」徽章不会随时间更新
    syncTodayTimer();
    window.setTimeout(
      function () {
        if (!todayOverlayEl.classList.contains('is-open')) {
          return;
        }
        safeFocus(todayCloseEl || todaySheetEl);
      },
      prefersReducedMotion() ? 0 : 60
    );
  }

  /**
   * 关闭今日面板。
   * @param {boolean} restoreFocus 关闭后焦点是否回到触发元素
   */
  function closeTodayPanel(restoreFocus) {
    if (!todayOverlayEl || todayOverlayEl.hidden) {
      return;
    }
    popDialog(todaySheetEl);
    hideOverlay(todayOverlayEl);
    unlockBodyScroll();
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    syncTodayTimer();
    var trigger = lastTodayTrigger;
    lastTodayTrigger = null;
    if (restoreFocus) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * 今日面板的事件委托：课程行 → 打开课程详情；任务勾选框 → 切换完成态。
   * @param {MouseEvent} event
   */
  function handleTodayPanelClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var courseButton = target.closest('.today-course[data-course-id]');
    if (courseButton) {
      var courseId = courseButton.getAttribute('data-course-id');
      if (courseId) {
        openDetail(courseId, courseButton);
      }
      return;
    }
    var check = target.closest('.today-task__check[data-task-id]');
    if (check) {
      var taskId = check.getAttribute('data-task-id');
      if (!taskId) {
        return;
      }
      // 复用任务栏目的那条路径：写库（persistTasks）+ 全量 render()，
      // render() 里会把打开着的今日面板一起重建（见 render 第 0 步），任务栏目同步
      toggleTaskDone(taskId);
      // toggleTaskDone 内部会把焦点落到任务栏目那边，这里把焦点拉回面板里同一行的勾选框
      focusTodayTaskCheck(taskId);
    }
  }

  /**
   * 空状态主 CTA 的文案：未配置识别服务时改成「先配置识别服务」并直接展开设置区。
   */
  function updateEmptyStateCta() {
    if (!btnCameraEmptyEl || !btnCameraEmptyLabelEl) {
      return;
    }
    var ready = Boolean(
      window.CourseImport &&
        typeof window.CourseImport.isReady === 'function' &&
        window.CourseImport.isReady()
    );
    btnCameraEmptyLabelEl.textContent = ready ? '拍课表导入' : '先配置识别服务';
  }

  /**
   * 展开识别服务设置并聚焦第一个空字段（未配置时给一条可走的路，而不是撞墙）。
   */
  function focusConfigFirstEmpty() {
    var details = document.getElementById('import-config');
    if (details) {
      details.open = true;
    }
    var candidates = ['vision-base', 'vision-model', 'vision-key'];
    var target = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var field = document.getElementById(candidates[i]);
      if (field && !field.value) {
        target = field;
        break;
      }
    }
    safeFocus(target || document.getElementById('vision-save') || importSheetEl);
  }

  /**
   * 「更多」菜单里可聚焦的条目（跳过 hidden 的，例如空课表时的「今天」）。
   * @return {Array<HTMLElement>}
   */
  function menuItems() {
    if (!moreMenuEl) {
      return [];
    }
    var nodes = moreMenuEl.querySelectorAll('[role="menuitem"]');
    var items = [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (!nodes[i].hidden) {
        items.push(nodes[i]);
      }
    }
    return items;
  }

  /**
   * 打开「更多」菜单并聚焦第一项。
   */
  function openMoreMenu() {
    if (!moreMenuEl || !btnMoreEl) {
      return;
    }
    moreMenuOpen = true;
    moreMenuEl.hidden = false;
    updateNotifyMenuItem();
    btnMoreEl.setAttribute('aria-expanded', 'true');
    var items = menuItems();
    safeFocus(items.length > 0 ? items[0] : btnMoreEl);
  }

  /**
   * 关闭「更多」菜单。
   * @param {boolean} restoreFocus 关闭后焦点是否回到触发按钮
   */
  function closeMoreMenu(restoreFocus) {
    if (!moreMenuEl || !btnMoreEl) {
      return;
    }
    if (!moreMenuOpen) {
      return;
    }
    moreMenuOpen = false;
    moreMenuEl.hidden = true;
    btnMoreEl.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      safeFocus(btnMoreEl);
    }
  }

  /**
   * 「更多」菜单的键盘导航：↑↓ / Home / End / Esc / Tab 焦点陷阱。
   * @param {KeyboardEvent} event
   */
  function handleMenuKeydown(event) {
    if (!moreMenuOpen) {
      return;
    }
    var items = menuItems();
    if (items.length === 0) {
      return;
    }
    var currentIndex = items.indexOf(document.activeElement);
    var key = event.key;

    if (key === 'Escape' || key === 'Esc') {
      event.preventDefault();
      event.stopPropagation();
      closeMoreMenu(true);
      return;
    }
    if (key === 'ArrowDown' || key === 'Down') {
      event.preventDefault();
      var nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      safeFocus(items[nextIndex]);
      return;
    }
    if (key === 'ArrowUp' || key === 'Up') {
      event.preventDefault();
      var prevIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
      safeFocus(items[prevIndex]);
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      safeFocus(items[0]);
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      safeFocus(items[items.length - 1]);
      return;
    }
    if (key === 'Tab') {
      // 焦点陷阱：在菜单内循环，不跑到页面其它地方
      event.preventDefault();
      var step = event.shiftKey ? -1 : 1;
      var base = currentIndex < 0 ? 0 : currentIndex;
      var target = (base + step + items.length) % items.length;
      safeFocus(items[target]);
    }
  }

  /* ==================== 八之二、候选批量操作 ==================== */

  /**
   * 当前勾选的候选。
   * @return {Array<Object>}
   */
  function checkedCandidates() {
    var list = [];
    for (var i = 0; i < importState.candidates.length; i += 1) {
      if (importState.candidates[i].checked !== false) {
        list.push(importState.candidates[i]);
      }
    }
    return list;
  }

  /**
   * 初始化批量改节次的两个下拉（第1节…第12节，来自 PERIODS，不硬编码）。
   */
  function initImportBulkSelects() {
    var periods = Array.isArray(PERIODS) ? PERIODS : [];
    if (importBulkPeriodStartEl && importBulkPeriodStartEl.options.length <= 1) {
      for (var i = 0; i < periods.length; i += 1) {
        var option = document.createElement('option');
        option.value = String(periods[i].index);
        option.textContent = '第' + periods[i].index + '节';
        importBulkPeriodStartEl.appendChild(option);
      }
    }
    if (importBulkPeriodEndEl && importBulkPeriodEndEl.options.length <= 1) {
      for (var j = 0; j < periods.length; j += 1) {
        var endOption = document.createElement('option');
        endOption.value = String(periods[j].index);
        endOption.textContent = '第' + periods[j].index + '节';
        importBulkPeriodEndEl.appendChild(endOption);
      }
    }
  }

  /**
   * 批量改星期 / 节次。
   * @param {'weekday'|'period'} kind
   * @param {string} value
   */
  function applyBulkEdit(kind, value) {
    var targets = checkedCandidates();
    if (targets.length === 0) {
      setImportStatus('先勾选要批量修改的课程，再统一改星期 / 节次。');
      return;
    }
    if (kind === 'weekday') {
      var day = clampWeekday(value);
      for (var i = 0; i < targets.length; i += 1) {
        targets[i].weekday = day;
      }
    } else if (kind === 'period') {
      var start = Number(importBulkPeriodStartEl ? importBulkPeriodStartEl.value : 0);
      var end = Number(importBulkPeriodEndEl ? importBulkPeriodEndEl.value : 0);
      if (!start || !end) {
        return;
      }
      if (end < start) {
        var swap = start;
        start = end;
        end = swap;
      }
      var times = { startTime: '', endTime: '' };
      if (window.CourseTimetable && typeof window.CourseTimetable.periodRangeToTimes === 'function') {
        times = window.CourseTimetable.periodRangeToTimes(start, end);
      }
      for (var j = 0; j < targets.length; j += 1) {
        targets[j].periodStart = start;
        targets[j].periodEnd = end;
        if (times.startTime) {
          targets[j].startTime = times.startTime;
          targets[j].endTime = times.endTime;
        }
      }
    }
    detectIssues(importState.candidates, state.courses, false);
    renderCandidates();
    updateImportConfirm();
  }

  /**
   * 全选 / 全不选。
   * @param {boolean} checked
   */
  function setAllCandidates(checked) {
    for (var i = 0; i < importState.candidates.length; i += 1) {
      importState.candidates[i].checked = checked;
    }
    renderCandidates();
    updateImportConfirm();
  }

  /**
   * 展开 / 收起某条候选的详情（展开时才创建 6 个输入框）。
   * @param {number} index
   */
  function toggleCandidate(index) {
    var entry = importState.candidates[index];
    if (!entry) {
      return;
    }
    syncCandidatesFromDom();
    entry.expanded = !entry.expanded;
    renderCandidates();
    updateImportConfirm();
    var row = importCandidatesEl
      ? importCandidatesEl.querySelector('.candidate[data-index="' + index + '"]')
      : null;
    var toggle = row ? row.querySelector('[data-role="toggle"]') : null;
    safeFocus(toggle || importConfirmEl);
  }

  /**
   * 删除某条候选（不写库，只影响本次导入）。
   * @param {number} index
   */
  function removeCandidate(index) {
    syncCandidatesFromDom();
    if (!importState.candidates[index]) {
      return;
    }
    importState.candidates.splice(index, 1);
    renderCandidates();
    updateImportConfirm();
    var nextIndex = Math.min(index, importState.candidates.length - 1);
    var row =
      nextIndex >= 0 && importCandidatesEl
        ? importCandidatesEl.querySelector('.candidate[data-index="' + nextIndex + '"]')
        : null;
    var target = row ? row.querySelector('[data-role="toggle"]') : null;
    safeFocus(target || importBulkAllEl || importConfirmEl);
  }

  /* ==================== 九、全量渲染 ==================== */

  /**
   * 全量渲染：栏目外壳、视图切换、概要文案、空状态、今天信息条都在这里统一处理。
   *
   * 关键改动（T01）：原来 `isEmpty` 时**提前 return**，导致"课程为空 + 停在任务页"
   * 会整页空白。现在改为按栏目分派：课程相关的空态/容器只在课程栏目里处理，
   * 任务与旅游栏目各自独立渲染，互不拦截。
   */
  function render() {
    var courseView = isCourseView();
    var isEmpty = state.courses.length === 0;

    // 0) 今日面板开着的时候，课程 / 任务的增删改要同步进去（否则面板还显示旧数据）。
    //    放在最前面，后面所有分支的提前 return 都不会漏掉这一步。
    //    refreshTodayPanel 会把焦点还给重建前所在的那一行。
    if (isTodayPanelOpen()) {
      refreshTodayPanel();
    }

    // 1) 栏目外壳：标题 / 副标题 / 添加按钮 / 相机 / 更多 / 日期条 / data-view / document.title
    applySectionChrome();

    // 2) 互换入口与操作条的显隐（非课程栏目必须收起）
    updateSwapUi();

    // 3) 空状态三选一：courseEmpty | tasksEmpty | tripsEmpty（其余 hidden）
    if (emptyStateEl) {
      emptyStateEl.hidden = !(courseView && isEmpty);
    }
    if (tasksEmptyEl) {
      tasksEmptyEl.hidden = state.view !== 'tasks';
    }

    if (!courseView) {
      // 课程容器全部隐藏，并把课表 DOM 清空：
      // 否则隐藏的课程块仍会被 findGridBlock 找到，焦点会落到 display:none 的元素上。
      if (timetableViewEl) {
        timetableViewEl.hidden = true;
      }
      if (unscheduledEl) {
        unscheduledEl.hidden = true;
      }
      if (timetableScrollEl) {
        timetableScrollEl.textContent = '';
      }
      if (courseListEl) {
        courseListEl.textContent = '';
        courseListEl.hidden = true;
      }
      // 排课助手只对课程有意义
      hideAssistant();
      // 今天条自己会隐藏（它只在课表视图显示）
      renderTodayBar();
      if (state.view === 'trips') {
        renderTrips();
      } else {
        renderTasks();
      }
      syncHeaderVars();
      return;
    }

    // ---- 以下是课程两个视图（grid / list）----
    if (timetableViewEl) {
      timetableViewEl.hidden = isEmpty || state.view !== 'grid';
    }
    if (courseListEl) {
      courseListEl.textContent = '';
      courseListEl.hidden = isEmpty || state.view !== 'list';
    }
    if (tasksViewEl) {
      tasksViewEl.hidden = true;
    }
    if (tripsViewEl) {
      tripsViewEl.hidden = true;
    }

    // 空状态主 CTA 文案随「识别服务是否就绪」变化；今天条只在课表视图显示
    updateEmptyStateCta();
    renderTodayBar();

    if (isEmpty) {
      if (unscheduledEl) {
        unscheduledEl.hidden = true;
      }
      if (timetableScrollEl) {
        timetableScrollEl.textContent = '';
      }
      syncHeaderVars();
      return;
    }

    if (state.view === 'grid') {
      buildTimetable();
    } else {
      if (unscheduledEl) {
        unscheduledEl.hidden = true;
      }
      // 切到清单后必须清掉课表 DOM（理由同上：避免焦点落到隐藏元素）
      if (timetableScrollEl) {
        timetableScrollEl.textContent = '';
      }
      renderList();
    }

    syncHeaderVars();
  }

  /**
   * 栏目外壳：所有「随栏目变化」的顶栏文案与控件显隐都收敛在这一个函数里。
   * 这样加栏目时只需要改这张表，不用去每处 `=== 'grid'` 判断里补分支。
   */
  function applySectionChrome() {
    var view = state.view;

    // 分段控件的选中态 + body[data-view]（4 个 tab 一次同步）
    updateViewTabs();

    if (appTitleEl) {
      appTitleEl.textContent = SECTION_TITLES[view] || SECTION_TITLES.grid;
    }
    if (courseSummaryEl) {
      courseSummaryEl.textContent = buildSectionSubtitle();
    }
    if (btnAddLabelEl) {
      btnAddLabelEl.textContent = SECTION_ADD_LABELS[view] || SECTION_ADD_LABELS.grid;
    }
    if (btnAddEl) {
      // 320px 下按钮文案被隐藏（≤359px 只留图标），所以 aria-label 必须自己承担文案
      btnAddEl.setAttribute('aria-label', SECTION_ADD_LABELS[view] || SECTION_ADD_LABELS.grid);
    }

    // 相机只对课程有意义（旅游/任务下隐藏，把 44px 让给 tab）
    if (btnCameraEl) {
      btnCameraEl.hidden = !isCourseView(view);
    }
    // 「更多」常显：三个栏目都有条目（课程：今天/互换/日志；列表栏目：显示设置）
    if (btnMoreEl) {
      btnMoreEl.hidden = false;
    }
    // 菜单项按栏目显隐（用单条 hidden，不整颗藏菜单，键盘导航会自动跳过）
    if (btnTodayEl) {
      // 「今天」打开今日面板（当日课程 + 当日任务）。
      // 面板是「今天」的聚合视图，任务栏目里更需要它，因此只在
      // 清单 / 旅游（这两个栏目没有"今天"这个维度）时隐藏。
      btnTodayEl.hidden = view === 'list' || view === 'trips';
    }
    if (btnSwapEl) {
      btnSwapEl.hidden = !isCourseView(view);
    }
    if (btnLogEl) {
      btnLogEl.hidden = !isCourseView(view);
    }
    if (btnSettingsEl) {
      // 课表不是列表，没有可配置的东西，因此只在这三个栏目出现
      btnSettingsEl.hidden = view === 'grid';
    }

    syncDateBar();
    document.title = buildDocumentTitle();
  }

  /**
   * 副标题文案（按栏目）。
   * @return {string}
   */
  function buildSectionSubtitle() {
    var view = state.view;
    if (view === 'tasks') {
      return buildTasksSubtitle();
    }
    if (view === 'trips') {
      return buildTripsSubtitle();
    }
    var count = state.courses.length;
    if (count === 0) {
      return '还没有课程';
    }
    // 本周节数按「节次区间」求和：一门第1-2节的课算 2 节，不是 1 门
    var slotCount = 0;
    for (var s = 0; s < state.courses.length; s += 1) {
      slotCount += countCoursePeriods(state.courses[s]);
    }
    return '共 ' + count + ' 门 · 本周 ' + slotCount + ' 节';
  }

  /**
   * 旅游栏目副标题。
   *
   * 必须**单行**：副标题折行会把顶栏从 120px 顶到 130px，破掉 ≤128px 的硬约束
   * （68 + 18 = 78 的行一 + 52 的行二）。所以这里的措辞刻意短：
   * 「仅显示该日期在行程中的项目」整句放在空状态描述与日期条的 aria-label 里。
   * @return {string}
   */
  function buildTripsSubtitle() {
    var total = Array.isArray(state.trips) ? state.trips.length : 0;
    var date = state.tripsDate;
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    if (!date) {
      if (total === 0) {
        return '还没有行程';
      }
      var inFlight = 0;
      if (typeof SEC.tripCoversDate === 'function') {
        for (var i = 0; i < state.trips.length; i += 1) {
          var trip = state.trips[i];
          if (trip.status === 'idea') {
            continue;
          }
          // 区间覆盖今天 **且** 没结束才算「进行中」——与右列共用 isTripEnded()，
          // 否则"手动标完成、但日期还盖着今天"的行程会被算进这个数，
          // 出现"副标题说 1 个进行中、列表里却一条进行中都没有"的矛盾。
          if (!SEC.tripCoversDate(trip, today)) {
            continue;
          }
          if (typeof SEC.isTripEnded === 'function' && SEC.isTripEnded(trip, today)) {
            continue;
          }
          inFlight += 1;
        }
      }
      // 「进行中」与右列同词（原为"在途"，容易被读成"在路上/交通中"）
      return '共 ' + total + ' 个行程' + (inFlight > 0 ? ' · ' + inFlight + ' 个进行中' : '');
    }
    var label = typeof SEC.formatDateLabel === 'function' ? SEC.formatDateLabel(date) : date;
    var weekday = typeof SEC.weekdayCn === 'function' ? SEC.weekdayCn(date) : '';
    // 「行程」而不是「在途」：学生语境里"在途"容易被读成"在路上/交通中"（QA G2）
    return label + ' ' + weekday + ' · 仅显示该日行程';
  }

  /**
   * 任务栏目副标题：`11月26日 周三 · 3 项待完成`（非今天时补相对词）。
   * @return {string}
   */
  function buildTasksSubtitle() {
    var date = state.tasksDate;
    var pending = pendingTaskCount(date);
    var parts = [];
    parts.push(SEC.formatDateLabel ? SEC.formatDateLabel(date) : date);
    parts.push(SEC.weekdayCn ? SEC.weekdayCn(date) : '');
    var relative = SEC.relativeDayLabel ? SEC.relativeDayLabel(date) : '';
    if (relative && relative !== '今天') {
      parts.push(relative);
    }
    var head = parts.filter(Boolean).join(' ');
    return head + ' · ' + pending + ' 项待完成';
  }

  /**
   * 某一天未完成的任务数。
   * @param {string} date
   * @return {number}
   */
  function pendingTaskCount(date) {
    if (typeof SEC.filterTasksByDate !== 'function') {
      return 0;
    }
    var list = SEC.filterTasksByDate(state.tasks, date);
    var count = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i].done) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * document.title（按栏目与选中日期）。
   * @return {string}
   */
  function buildDocumentTitle() {
    var view = state.view;
    var sectionTitle = SECTION_TITLES[view] || SECTION_TITLES.grid;
    if (view === 'tasks') {
      var pending = pendingTaskCount(state.tasksDate);
      if (state.tasksDate === (SEC.todayString ? SEC.todayString() : '')) {
        return sectionTitle + ' · ' + pending + ' 项';
      }
      return sectionTitle + ' · ' + SEC.formatDateLabel(state.tasksDate) + ' · ' + pending + ' 项';
    }
    if (view === 'trips') {
      var tripTotal = Array.isArray(state.trips) ? state.trips.length : 0;
      if (!state.tripsDate) {
        return sectionTitle + (tripTotal > 0 ? ' · ' + tripTotal + ' 个行程' : '');
      }
      return sectionTitle + ' · ' + SEC.formatDateLabel(state.tripsDate);
    }
    var count = state.courses.length;
    return count === 0 ? sectionTitle : sectionTitle + ' · ' + count + ' 门';
  }

  /**
   * 更新分段控件的选中态（4 个 tab 平级，形状与原来的 2 tab 完全一致）。
   */
  function updateViewTabs() {
    var tabs = [
      { el: viewTabGridEl, value: 'grid' },
      { el: viewTabListEl, value: 'list' },
      { el: viewTabTripsEl, value: 'trips' },
      { el: viewTabTasksEl, value: 'tasks' }
    ];
    for (var i = 0; i < tabs.length; i += 1) {
      if (!tabs[i].el) {
        continue;
      }
      var active = state.view === tabs[i].value;
      tabs[i].el.classList.toggle('is-active', active);
      tabs[i].el.setAttribute('aria-pressed', String(active));
    }
    document.body.setAttribute('data-view', state.view);
  }

  /**
   * 切换栏目。4 个栏目共用同一份 state 与同一套编辑 / 删除入口，
   * 因此切换不会触碰滚动锁。
   *
   * 三条硬规则：
   *   1. 互换模式只属于课程，切走前先 exitSwapMode()（否则 swap-pick-badge 会挂在
   *      不存在的行上）；
   *   2. 撤销 toast 是单槽位，跨栏目一律 clearUndo()（R6）；
   *   3. 切换后焦点不许落在 BODY。
   * @param {'grid'|'list'|'trips'|'tasks'} view
   */
  function setView(view) {
    var next = VIEWS.indexOf(view) >= 0 ? view : 'grid';
    if (next === state.view) {
      return;
    }

    // 互换态不能跨栏目残留
    if (swapState.active) {
      exitSwapMode({ restoreFocus: false });
    }
    // 单槽位撤销不能跨栏目
    clearUndo();
    hideUndoToast();

    // 必须在 render() 之前取焦点节点 *并* 判断它属于哪个栏目：
    // render() 会清空 / 重建另一个栏目的 DOM，之后 activeElement 只会读到 BODY。
    var active = document.activeElement;
    var activeWasInGrid = Boolean(active && timetableViewEl && timetableViewEl.contains(active));
    var activeWasInList = Boolean(active && courseListEl && courseListEl.contains(active));
    var previous = state.view;
    state.view = next;

    // 记住上次停留的栏目（刷新后回到同一页）
    persistSectionConfig({ lastSection: next });
    render();

    // 课程 ↔ 课程：尽量把焦点搬到「同一门课」在新视图里的入口
    if (isCourseView(previous) && isCourseView(next)) {
      var wasInHiddenView = previous === 'grid' ? activeWasInGrid : activeWasInList;
      if (active && wasInHiddenView) {
        var courseId = '';
        if (typeof active.getAttribute === 'function' && active.getAttribute('data-course-id')) {
          courseId = active.getAttribute('data-course-id');
        } else if (typeof active.closest === 'function') {
          var owner = active.closest('.card[data-course-id]');
          if (owner) {
            courseId = owner.getAttribute('data-course-id');
          }
        }
        if (courseId) {
          var counterpart = next === 'grid' ? findGridBlock(courseId) : findCardElement(courseId);
          if (counterpart) {
            var focusTarget =
              counterpart.tagName === 'BUTTON'
                ? counterpart
                : counterpart.querySelector('button[data-action="edit"]');
            if (focusTarget) {
              safeFocus(focusTarget);
              return;
            }
          }
        }
        if (next === 'grid') {
          safeFocus(timetableScrollEl || viewTabGridEl);
        } else {
          safeFocus(courseListEl || viewTabListEl);
        }
        return;
      }
    }

    // 其余情形（含课程 ↔ 任务 / 旅游）：焦点落到当前栏目的 tab 上。
    // 点击 tab 时部分浏览器（Safari）不会给按钮焦点，这里显式补上，保证 activeElement ≠ BODY。
    var tabEl = tabElementFor(next);
    if (tabEl) {
      safeFocus(tabEl);
      return;
    }
    safeFocus(btnAddEl);
  }

  /**
   * 横向滚动定位到「今天」那一列。
   */
  function scrollToToday(instant) {
    if (!timetableScrollEl) {
      return;
    }
    var todayColumn = timetableScrollEl.querySelector('.tt__col.is-today');
    if (!todayColumn) {
      return;
    }
    var axisEl = timetableScrollEl.querySelector('.tt__axis');
    var containerRect = timetableScrollEl.getBoundingClientRect();
    var columnRect = todayColumn.getBoundingClientRect();
    var axisWidth = axisEl ? axisEl.getBoundingClientRect().width : 0;
    var target =
      timetableScrollEl.scrollLeft + (columnRect.left - containerRect.left) - axisWidth - 8;
    var maxScroll = Math.max(0, timetableScrollEl.scrollWidth - timetableScrollEl.clientWidth);
    target = Math.max(0, Math.min(target, maxScroll));
    // instant：刚建好的课表要在首帧就定位到今天列（平滑滚动会让用户看到"跳一下"）
    if (instant || prefersReducedMotion()) {
      timetableScrollEl.scrollLeft = target;
      return;
    }
    try {
      timetableScrollEl.scrollTo({ left: target, behavior: 'smooth' });
    } catch (err) {
      timetableScrollEl.scrollLeft = target;
    }
  }

  /* ==================== 九、元素查找 / 高亮 ==================== */

  /**
   * 按 id 查找清单卡片。
   * @param {string} courseId
   * @return {HTMLElement|null}
   */
  function findCardElement(courseId) {
    var cards = document.querySelectorAll('.card[data-course-id]');
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].getAttribute('data-course-id') === courseId) {
        return cards[i];
      }
    }
    return null;
  }

  /**
   * 按 id 查找课表块。
   * @param {string} courseId
   * @return {HTMLElement|null}
   */
  function findGridBlock(courseId) {
    if (!timetableScrollEl) {
      return null;
    }
    var blocks = timetableScrollEl.querySelectorAll('.tt-block[data-course-id], .td-block[data-course-id]');
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].getAttribute('data-course-id') === courseId) {
        return blocks[i];
      }
    }
    return null;
  }

  /**
   * 高亮并滚动到刚保存的课程（两种视图都支持）。
   * @param {string} courseId
   */
  function highlightCourse(courseId) {
    var target = findCardElement(courseId) || findGridBlock(courseId);
    if (!target) {
      return;
    }
    target.classList.add('is-new');
    window.setTimeout(function () {
      target.classList.remove('is-new');
    }, 900);
    window.setTimeout(
      function () {
        try {
          target.scrollIntoView({
            block: 'nearest',
            behavior: prefersReducedMotion() ? 'auto' : 'smooth'
          });
        } catch (err) {
          /* 老浏览器不支持配置对象时忽略 */
        }
      },
      prefersReducedMotion() ? 0 : 180
    );
  }

  /* ==================== 十、遮罩 / 滚动锁定 / 焦点 ==================== */

  /**
   * 打开遮罩：移除 hidden，再通过 is-open 触发过渡。
   * @param {HTMLElement} overlayEl
   */
  function showOverlay(overlayEl) {
    var timer = hideTimers.get(overlayEl);
    if (timer) {
      window.clearTimeout(timer);
      hideTimers.delete(overlayEl);
    }
    overlayEl.hidden = false;
    // 强制回流，保证过渡动画生效
    void overlayEl.offsetWidth;
    overlayEl.classList.add('is-open');
  }

  /**
   * 关闭遮罩：先移除 is-open，动画结束后再 hidden。
   * @param {HTMLElement} overlayEl
   */
  function hideOverlay(overlayEl) {
    overlayEl.classList.remove('is-open');
    var delay = prefersReducedMotion() ? 0 : OVERLAY_ANIMATION_MS;
    var existing = hideTimers.get(overlayEl);
    if (existing) {
      window.clearTimeout(existing);
    }
    var timer = window.setTimeout(function () {
      overlayEl.hidden = true;
      hideTimers.delete(overlayEl);
    }, delay);
    hideTimers.set(overlayEl, timer);
  }

  /**
   * 锁定背景滚动（iOS 需要 position: fixed 才可靠）。
   */
  function lockBodyScroll() {
    if (scrollLockDepth === 0) {
      savedScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + savedScrollY + 'px';
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
    }
    scrollLockDepth += 1;
  }

  /**
   * 解锁背景滚动并还原滚动位置。
   */
  function unlockBodyScroll() {
    if (scrollLockDepth === 0) {
      return;
    }
    scrollLockDepth -= 1;
    if (scrollLockDepth > 0) {
      return;
    }
    releaseBodyScroll();
  }

  /**
   * 解除 body 的滚动锁内联样式并还原滚动位置。
   */
  function releaseBodyScroll() {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, savedScrollY);
  }

  /**
   * 是否还有任意浮层处于打开状态。
   * @return {boolean}
   */
  function isAnyOverlayOpen() {
    var overlays = [
      detailOverlayEl,
      formOverlayEl,
      itemOverlayEl,
      displayOverlayEl,
      ringtoneOverlayEl,
      catalogOverlayEl,
      importOverlayEl,
      logOverlayEl,
      confirmOverlayEl
    ];
    for (var i = 0; i < overlays.length; i += 1) {
      if (overlays[i] && !overlays[i].hidden) {
        return true;
      }
    }
    return false;
  }

  /**
   * 压入对话框栈。
   * @param {HTMLElement} el
   * @param {Function} onEscape
   */
  function pushDialog(el, onEscape) {
    dialogStack.push({ el: el, onEscape: onEscape });
  }

  /**
   * 弹出指定对话框。
   * @param {HTMLElement} el
   */
  function popDialog(el) {
    for (var i = dialogStack.length - 1; i >= 0; i -= 1) {
      if (dialogStack[i].el === el) {
        dialogStack.splice(i, 1);
        return;
      }
    }
  }

  /**
   * 当前最上层对话框。
   * @return {{el: HTMLElement, onEscape: Function}|null}
   */
  function topDialog() {
    return dialogStack.length > 0 ? dialogStack[dialogStack.length - 1] : null;
  }

  /**
   * 收集容器内可聚焦且可见的元素。
   * @param {HTMLElement} container
   * @return {Array<HTMLElement>}
   */
  function getFocusableElements(container) {
    var nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
    var result = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.disabled) {
        continue;
      }
      if (node.getClientRects().length === 0) {
        continue;
      }
      result.push(node);
    }
    return result;
  }

  /**
   * Tab 焦点循环，保证焦点不逃出对话框。
   * @param {KeyboardEvent} event
   * @param {HTMLElement} dialogEl
   */
  function trapFocus(event, dialogEl) {
    var items = getFocusableElements(dialogEl);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    var inside = dialogEl.contains(active);

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * 安全聚焦。
   * @param {HTMLElement|null} el
   */
  function safeFocus(el) {
    if (!el || !document.contains(el)) {
      return;
    }
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
  }

  /**
   * 焦点是否停在「已经关闭且不可见」的浮层内部。
   * 浏览器隐藏 `display:none` 的祖先时不一定立刻把焦点移走，
   * 这类焦点在语义上等同于丢焦点，必须允许归还给触发按钮。
   * @return {boolean}
   */
  function isFocusInHiddenOverlay() {
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      return false;
    }
    var overlays = [
      detailOverlayEl,
      formOverlayEl,
      itemOverlayEl,
      displayOverlayEl,
      ringtoneOverlayEl,
      catalogOverlayEl,
      importOverlayEl,
      logOverlayEl,
      confirmOverlayEl,
      todayOverlayEl
    ];
    for (var i = 0; i < overlays.length; i += 1) {
      var overlay = overlays[i];
      if (overlay && overlay.hidden && overlay.contains(active)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 通用浮层关闭后的焦点归还：只在没有任何浮层打开、且焦点处于空档时才归还，
   * 避免把焦点从刚打开的面板里抢走。
   * @param {HTMLElement|null} trigger
   */
  function restoreFocusAfterDialog(trigger) {
    if (!trigger) {
      return;
    }
    window.setTimeout(function () {
      if (isAnyOverlayOpen()) {
        return;
      }
      if (!document.contains(trigger)) {
        return;
      }
      var active = document.activeElement;
      var focusIsNeutral =
        !active ||
        active === document.body ||
        active === document.documentElement ||
        isFocusInHiddenOverlay();
      if (focusIsNeutral) {
        safeFocus(trigger);
      }
    }, 250);
  }

  /* ==================== 十一、表单面板 ==================== */

  /**
   * 读取当前选中的颜色 token。
   * 选「自动」时返回空串（保存时即表示不写 color 字段）。
   * @return {string}
   */
  function readColorValue() {
    if (!formEl) {
      return '';
    }
    var checked = formEl.querySelector('input[name="color"]:checked');
    return normalizeCourseColor(checked ? checked.value : '');
  }

  /**
   * 把颜色选择器设为指定 token（空串 = 自动）。
   * @param {string} value
   */
  function setColorValue(value) {
    if (!formEl) {
      return;
    }
    var token = normalizeCourseColor(value);
    var inputs = formEl.querySelectorAll('input[name="color"]');
    for (var i = 0; i < inputs.length; i += 1) {
      inputs[i].checked = inputs[i].value === token;
    }
  }

  /**
   * 创建单个颜色选项：视觉隐藏的 radio + 可见色块。
   * radio 保证方向键可切换、读屏可播报；label 提供 ≥44×44 的点击热区。
   * @param {string} token 颜色 token，'' 表示「自动」
   * @param {string} label 无障碍标签
   * @param {boolean} isAuto
   * @return {HTMLLabelElement}
   */
  function createColorOption(token, label, isAuto) {
    var wrapper = createEl('label', 'color-option' + (isAuto ? ' color-option--auto' : ''));
    var input = document.createElement('input');
    input.type = 'radio';
    input.className = 'color-option__input';
    input.name = 'color';
    input.value = token;
    input.setAttribute('aria-label', label);
    if (isAuto) {
      input.checked = true;
    }
    wrapper.appendChild(input);

    var swatch = createEl('span', 'color-swatch' + (isAuto ? ' color-swatch--auto' : ''));
    swatch.setAttribute('aria-hidden', 'true');
    if (isAuto) {
      // 「自动」是虚线圆 + 图标；选中后图标换成对勾（对勾颜色跟随 --course-text）
      var autoIcon = createIcon('icon-auto');
      autoIcon.setAttribute('class', 'icon color-swatch__auto-icon');
      swatch.appendChild(autoIcon);
    } else {
      swatch.setAttribute('data-color', token);
    }
    var checkIcon = createIcon('icon-check');
    checkIcon.setAttribute('class', 'icon color-swatch__check');
    swatch.appendChild(checkIcon);
    wrapper.appendChild(swatch);
    return wrapper;
  }

  /**
   * 构建颜色选择器（token 列表只存在于 COURSE_COLORS，不在 HTML 里重复一遍）。
   */
  function buildColorPicker() {
    if (!colorPickerEl || colorPickerEl.childNodes.length > 0) {
      return;
    }
    var fragment = document.createDocumentFragment();
    fragment.appendChild(createColorOption('', '自动配色', true));
    for (var i = 0; i < COURSE_COLORS.length; i += 1) {
      var token = COURSE_COLORS[i];
      fragment.appendChild(createColorOption(token, COURSE_COLOR_LABELS[token], false));
    }
    colorPickerEl.appendChild(fragment);
  }

  /**
   * 读取表单原始值（用于脏检查）。
   * @return {Object}
   */
  function readRawFormValues() {
    return {
      name: nameInput.value,
      weekday: weekdaySelect.value,
      startTime: startInput.value,
      endTime: endInput.value,
      teacher: teacherInput.value,
      place: placeInput.value,
      note: noteInput.value,
      color: readColorValue()
    };
  }

  /**
   * 读取并规范化表单值（用于保存）。
   * @return {Object}
   */
  function readFormValues() {
    return {
      name: nameInput.value.trim(),
      weekday: clampWeekday(weekdaySelect.value),
      startTime: normalizeTimeString(startInput.value),
      endTime: normalizeTimeString(endInput.value),
      teacher: teacherInput.value.trim(),
      place: placeInput.value.trim(),
      note: noteInput.value.trim().slice(0, NOTE_MAX_LENGTH),
      color: readColorValue()
    };
  }

  /**
   * 业务校验（不触碰 DOM）：手动录入与图片导入共用同一套规则。
   * @param {Object} values
   * @return {Array<{field: string, message: string}>}
   */
  function validateCourseValues(values) {
    var issues = [];
    if (!values.name) {
      issues.push({ field: 'name', message: '请填写课程名称' });
    }
    if (!values.startTime) {
      issues.push({ field: 'startTime', message: '请选择上课开始时间' });
    }
    if (!values.endTime) {
      issues.push({ field: 'endTime', message: '请选择结束时间' });
    }
    if (
      values.startTime &&
      values.endTime &&
      timeToMinutes(values.endTime) <= timeToMinutes(values.startTime)
    ) {
      issues.push({
        field: 'endTime',
        message: '结束时间需晚于开始时间（暂不支持跨零点课程）'
      });
    }
    return issues;
  }

  /**
   * 表单校验：把业务校验结果映射到对应的输入框与错误容器。
   * @param {Object} values
   * @return {Array<{target: HTMLElement, errorEl: HTMLElement, message: string}>}
   */
  function validate(values) {
    var issues = validateCourseValues(values);
    var errors = [];
    for (var i = 0; i < issues.length; i += 1) {
      var issue = issues[i];
      if (issue.field === 'name') {
        errors.push({ target: nameInput, errorEl: errorNameEl, message: issue.message });
      } else if (issue.field === 'startTime') {
        errors.push({ target: startInput, errorEl: errorTimeEl, message: issue.message });
      } else {
        errors.push({ target: endInput, errorEl: errorTimeEl, message: issue.message });
      }
    }
    return errors;
  }

  /**
   * 清空所有内联错误。
   * @param {HTMLElement} [scopeEl] 作用域容器，缺省为课程表单（零回归：
   *        不带参数调用时行为与改造前完全一致）
   */
  function clearFieldErrors(scopeEl) {
    var scope = scopeEl || formEl;
    if (scope === formEl) {
      if (errorNameEl) {
        errorNameEl.textContent = '';
      }
      if (errorTimeEl) {
        errorTimeEl.textContent = '';
      }
    } else if (scope) {
      var errEls = scope.querySelectorAll('.field__error');
      for (var e = 0; e < errEls.length; e += 1) {
        errEls[e].textContent = '';
      }
    }
    if (!scope) {
      return;
    }
    var inputs = scope.querySelectorAll('.input');
    for (var i = 0; i < inputs.length; i += 1) {
      inputs[i].removeAttribute('aria-invalid');
    }
  }

  /**
   * 展示内联错误。
   * @param {Array<{target: HTMLElement, errorEl: HTMLElement, message: string}>} errors
   * @param {boolean} shouldFocus 是否把焦点移到第一个出错字段
   * @param {HTMLElement} [scopeEl] 作用域容器，缺省为课程表单
   */
  function showFieldErrors(errors, shouldFocus, scopeEl) {
    clearFieldErrors(scopeEl);
    if (errors.length === 0) {
      return;
    }
    // 同一错误容器可能有多条信息，用中文分号合并
    var messages = [];
    var containers = [];
    for (var i = 0; i < errors.length; i += 1) {
      var index = containers.indexOf(errors[i].errorEl);
      if (index === -1) {
        containers.push(errors[i].errorEl);
        messages.push([errors[i].message]);
      } else {
        messages[index].push(errors[i].message);
      }
    }
    for (var j = 0; j < containers.length; j += 1) {
      containers[j].textContent = messages[j].join('；');
    }
    for (var k = 0; k < errors.length; k += 1) {
      errors[k].target.setAttribute('aria-invalid', 'true');
    }
    if (shouldFocus !== false) {
      var first = errors[0].target;
      if (first) {
        first.focus();
        if (typeof first.select === 'function' && first.type === 'text') {
          first.select();
        }
      }
    }
  }

  /**
   * 输入过程中实时刷新已显示的错误（不抢焦点）。
   */
  function refreshErrors() {
    var hasError = Boolean(errorNameEl.textContent || errorTimeEl.textContent);
    if (!hasError) {
      return;
    }
    showFieldErrors(validate(readFormValues()), false);
  }

  /**
   * 更新备注字数。
   */
  function updateNoteCounter() {
    if (!noteCounterEl) {
      return;
    }
    noteCounterEl.textContent = noteInput.value.length + ' / ' + NOTE_MAX_LENGTH;
  }

  /**
   * 表单当前是否有未保存的修改。
   * @return {boolean}
   */
  function isFormDirty() {
    return JSON.stringify(readRawFormValues()) !== formSnapshot;
  }

  /**
   * 重置为新增课程的默认值。
   */
  function resetFormForCreate() {
    nameInput.value = '';
    weekdaySelect.value = String(todayWeekday());
    startInput.value = DEFAULT_START_TIME;
    endInput.value = DEFAULT_END_TIME;
    teacherInput.value = '';
    placeInput.value = '';
    noteInput.value = '';
    // 新建默认「自动配色」：颜色跟着课名走，用户想固定再自己选
    setColorValue('');
  }

  /**
   * 用课程数据回填表单。
   * @param {Object} course
   */
  function fillForm(course) {
    nameInput.value = course.name;
    weekdaySelect.value = String(clampWeekday(course.weekday));
    startInput.value = normalizeTimeString(course.startTime) || DEFAULT_START_TIME;
    endInput.value = normalizeTimeString(course.endTime) || DEFAULT_END_TIME;
    teacherInput.value = course.teacher || '';
    placeInput.value = course.place || '';
    noteInput.value = course.note || '';
    // 回填当前颜色；没有 color（旧数据 / 自动配色）时选中「自动」
    setColorValue(course.color);
  }

  /**
   * 用「排课助手」推荐值预填新增表单（用户只需补教师 / 地点）。
   * @param {{name?: string, weekday?: number, startTime?: string, endTime?: string}} prefill
   */
  function applyPrefill(prefill) {
    if (!prefill) {
      return;
    }
    if (typeof prefill.name === 'string') {
      nameInput.value = prefill.name;
    }
    if (prefill.weekday !== undefined) {
      weekdaySelect.value = String(clampWeekday(prefill.weekday));
    }
    if (normalizeTimeString(prefill.startTime)) {
      startInput.value = normalizeTimeString(prefill.startTime);
    }
    if (normalizeTimeString(prefill.endTime)) {
      endInput.value = normalizeTimeString(prefill.endTime);
    }
  }

  /**
   * 打开新增 / 编辑面板。
   * @param {Object|null} course 传入课程表示编辑，null 表示新增
   * @param {HTMLElement|null} trigger 触发按钮，关闭后归还焦点
   * @param {Object|null} [prefill] 新增时的预填值（排课助手使用）
   */
  function openForm(course, trigger, prefill) {
    // 防重入：面板已在打开态时不得再次加锁 / 压栈，否则滚动锁会失衡
    if (formOverlayEl.classList.contains('is-open')) {
      return;
    }
    lastFormTrigger = trigger || null;
    state.editingId = course ? course.id : null;
    formTitleEl.textContent = course ? '编辑课程' : '添加课程';

    if (course) {
      fillForm(course);
    } else {
      resetFormForCreate();
      applyPrefill(prefill);
    }

    clearFieldErrors();
    updateNoteCounter();
    formSnapshot = JSON.stringify(readRawFormValues());

    showOverlay(formOverlayEl);
    pushDialog(sheetEl, requestCloseForm);
    lockBodyScroll();

    // 直接在当前用户手势内聚焦，iOS 才能正常弹出键盘
    if (nameInput) {
      try {
        nameInput.focus({ preventScroll: true });
      } catch (err) {
        nameInput.focus();
      }
    }
    // 面板从底部滑入时把内容滚回顶部
    sheetBodyScrollTop();
    // 记录打开时刻：打开后极短时间内的遮罩点击视为连点误触，不关闭面板
    overlayOpenedAt = Date.now();
  }

  /**
   * 把面板表单区域滚动到顶部。
   */
  function sheetBodyScrollTop() {
    var body = sheetEl.querySelector('.sheet__body');
    if (body) {
      body.scrollTop = 0;
    }
  }

  /**
   * 真正关闭面板（不做脏检查）。
   */
  function closeForm() {
    popDialog(sheetEl);
    hideOverlay(formOverlayEl);
    unlockBodyScroll();
    // 防御：面板关闭后若已无任何对话框，滚动锁必须归零，避免页面永久无法滚动
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    state.editingId = null;
    var trigger = lastFormTrigger;
    lastFormTrigger = null;
    restoreFocusAfterClose(trigger);
  }

  /**
   * 关闭面板后延迟归还焦点。延时可避免“保存后立刻再按 Enter”重复激活触发按钮；
   * 且只在焦点仍处于空档（body / 已关闭的面板内部）时才归还，不抢用户焦点。
   * @param {HTMLElement|null} trigger
   */
  function restoreFocusAfterClose(trigger) {
    if (!trigger) {
      return;
    }
    window.setTimeout(function () {
      // 面板仍可见（含“刚被重新打开”的情况）：绝不能把焦点从面板内抢走
      if (!formOverlayEl.hidden) {
        return;
      }
      if (!document.contains(trigger)) {
        return;
      }
      var active = document.activeElement;
      var focusIsNeutral =
        !active || active === document.body || active === document.documentElement;
      if (focusIsNeutral) {
        safeFocus(trigger);
      }
    }, 250);
  }

  /**
   * 请求关闭面板：有未保存修改时先二次确认。
   */
  function requestCloseForm() {
    if (formOverlayEl.hidden) {
      return;
    }
    if (!isFormDirty()) {
      closeForm();
      return;
    }
    askConfirm({
      title: '放弃本次编辑？',
      message: '表单里还有未保存的内容，关闭后将丢失。',
      confirmLabel: '放弃',
      cancelLabel: '继续编辑',
      danger: true
    }).then(function (confirmed) {
      if (confirmed) {
        closeForm();
      } else {
        safeFocus(nameInput);
      }
    });
  }

  /**
   * 保存表单。
   * @param {Event} event
   */
  function handleSubmit(event) {
    event.preventDefault();
    // 面板已进入关闭流程时（退场动画期间表单仍可能收到隐式提交）直接忽略，
    // 避免“保存后立刻再按 Enter”造成重复新增，或把编辑变成新增。
    if (!formOverlayEl.classList.contains('is-open')) {
      return;
    }
    var values = readFormValues();
    var errors = validate(values);
    if (errors.length > 0) {
      showFieldErrors(errors, true);
      return;
    }
    clearFieldErrors();

    var now = Date.now();
    var savedCourse = null;
    var isNoop = false;

    if (state.editingId) {
      for (var i = 0; i < state.courses.length; i += 1) {
        if (state.courses[i].id === state.editingId) {
          var previous = state.courses[i];
          // 7 个业务字段完全一致时视为未修改：不写库、不动 updatedAt
          if (!hasCourseContentChanged(previous, values)) {
            isNoop = true;
            break;
          }
          savedCourse = buildCourseRecord(values, {
            id: previous.id,
            createdAt: previous.createdAt,
            now: now,
            source: previous.source,
            importBatchId: previous.importBatchId
          });
          state.courses[i] = savedCourse;
          break;
        }
      }
    }

    if (isNoop) {
      closeForm();
      showInfoToast('课程未做修改');
      announce('课程未做修改：' + values.name);
      return;
    }

    var isCreate = savedCourse === null;
    if (isCreate) {
      savedCourse = buildCourseRecord(values, { now: now, source: 'manual' });
      state.courses.push(savedCourse);
    }

    var savedToStore = persistCourses();
    render();
    closeForm();
    announce(
      (isCreate ? '已添加课程：' : '已保存课程：') +
        savedCourse.name +
        (savedToStore ? '' : '（未能保存到本地）')
    );
    highlightCourse(savedCourse.id);

    if (isCreate) {
      showAssistantSuggestion(savedCourse);
    } else {
      // 编辑保存不触发推荐，同时清掉可能已经过期的建议
      hideAssistant();
    }
  }

  /**
   * 判断表单内容相对原记录是否发生变化（业务字段 + 颜色）。
   * 颜色必须计入，否则「只改颜色」会被误判为无改动而丢掉。
   * @param {Object} previous
   * @param {Object} values
   * @return {boolean}
   */
  function hasCourseContentChanged(previous, values) {
    return (
      previous.name !== values.name ||
      clampWeekday(previous.weekday) !== values.weekday ||
      normalizeTimeString(previous.startTime) !== values.startTime ||
      normalizeTimeString(previous.endTime) !== values.endTime ||
      String(previous.teacher || '') !== values.teacher ||
      String(previous.place || '') !== values.place ||
      String(previous.note || '') !== values.note ||
      normalizeCourseColor(previous.color) !== normalizeCourseColor(values.color)
    );
  }

  /* ==================== 十二、排课助手 ==================== */

  /**
   * 新增课程成功后，计算并展示「下一节」推荐。
   * 算法本身在 timetable.js（纯函数），这里只负责文案与交互。
   * @param {Object} course 刚保存的课程
   */
  function showAssistantSuggestion(course) {
    if (!assistantBarEl || !assistantTextEl) {
      return;
    }
    var weekday = clampWeekday(course.weekday);
    var duration = timeToMinutes(course.endTime) - timeToMinutes(course.startTime);
    if (!(duration > 0)) {
      hideAssistant();
      return;
    }

    var slot = null;
    if (typeof TT.findNextSlot === 'function') {
      slot = TT.findNextSlot({
        weekday: weekday,
        duration: duration,
        courses: state.courses,
        periods: PERIODS,
        lunch: LUNCH,
        dayStart: AXIS.start,
        dayEnd: AXIS.end,
        // 起点接在刚保存课程的结束时间之后
        afterTime: course.endTime
      });
    }

    var dayName = WEEKDAY_LABELS[weekday - 1];
    var head =
      '已添加「' +
      course.name +
      '」' +
      dayName +
      ' ' +
      normalizeTimeString(course.startTime) +
      '–' +
      normalizeTimeString(course.endTime) +
      '。';

    var text = '';
    if (!slot) {
      text = head + '本周已排满，没有找到可用的连续时段。';
      pendingSuggestion = null;
    } else {
      var slotText =
        typeof TT.formatSlotLabel === 'function'
          ? TT.formatSlotLabel(slot)
          : WEEKDAY_LABELS[slot.weekday - 1] + ' ' + slot.startTime + '–' + slot.endTime;
      if (slot.weekday === weekday) {
        text = head + '下一节：' + slotText;
      } else {
        text = head + dayName + '已排不下，改到' + slotText;
      }
      // 记下课程名与推荐时段，「继续添加」时据此预填
      pendingSuggestion = {
        name: course.name,
        weekday: slot.weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
        periodIndex: slot.periodIndex
      };
    }

    assistantTextEl.textContent = text;
    if (assistantContinueEl) {
      assistantContinueEl.hidden = !slot;
    }
    if (assistantDismissEl) {
      assistantDismissEl.textContent = slot ? '不用了' : '知道了';
    }
    assistantBarEl.hidden = false;
    // 提示条自身就是 role="status" + aria-live="polite" 的播报区域，
    // 这里不再重复调用 announce()，避免同一句话被念两遍。
  }

  /**
   * 关闭排课助手提示条。
   */
  function hideAssistant() {
    pendingSuggestion = null;
    if (assistantTextEl) {
      assistantTextEl.textContent = '';
    }
    if (assistantBarEl) {
      assistantBarEl.hidden = true;
    }
  }

  /**
   * 点击「继续添加」：用推荐值预填新增表单。
   * 提示条会被收起，所以焦点归还目标用常驻的「添加课程」按钮，
   * 否则关闭面板时会把焦点还给一个已隐藏的按钮（等于丢焦点）。
   */
  function continueWithSuggestion() {
    var suggestion = pendingSuggestion;
    hideAssistant();
    if (!suggestion) {
      openForm(null, btnAddEl);
      return;
    }
    openForm(null, btnAddEl, {
      name: suggestion.name,
      weekday: suggestion.weekday,
      startTime: suggestion.startTime,
      endTime: suggestion.endTime
    });
  }

  /* ==================== 十三、课程详情浮层 ==================== */

  /**
   * 渲染详情内容。
   * @param {Object} course
   */
  function renderDetail(course) {
    if (!detailBodyEl) {
      return;
    }
    detailBodyEl.textContent = '';
    // 标题左侧圆点与卡片、课表块共用同一份颜色（applyCourseColor）
    detailTitleEl.textContent = '';
    var dot = createEl('span', 'detail-dot');
    dot.setAttribute('aria-hidden', 'true');
    applyCourseColor(dot, course);
    detailTitleEl.appendChild(dot);
    detailTitleEl.appendChild(createEl('span', 'sheet__title-text', course.name));

    var weekday = clampWeekday(course.weekday);
    var dayLine = createEl(
      'p',
      'detail__day',
      WEEKDAY_LABELS[weekday - 1] + (weekday === todayWeekday() ? ' · 今天' : '')
    );
    detailBodyEl.appendChild(dayLine);

    var timeRow = createEl('p', 'detail__time');
    timeRow.appendChild(createIcon('icon-clock'));
    var timeText = formatTimeRange(course) || '未设置时间';
    timeRow.appendChild(createEl('span', '', timeText));
    detailBodyEl.appendChild(timeRow);

    var meta = createEl('ul', 'card__meta');
    var teacher = typeof course.teacher === 'string' ? course.teacher.trim() : '';
    if (teacher) {
      meta.appendChild(createMetaItem('icon-user', teacher));
    }
    var placeInfo = toPlaceInfo(course.place);
    if (placeInfo) {
      meta.appendChild(createMetaItem('icon-pin', createPlaceNode(placeInfo)));
    }
    if (meta.childNodes.length > 0) {
      detailBodyEl.appendChild(meta);
    }

    var note = typeof course.note === 'string' ? course.note.trim() : '';
    if (note) {
      detailBodyEl.appendChild(createEl('p', 'card__note', note));
    }

    if (course.source === 'image') {
      var source = createEl('p', 'detail__source');
      source.appendChild(createIcon('icon-camera'));
      source.appendChild(createEl('span', '', '由图片识别导入'));
      detailBodyEl.appendChild(source);
    }
  }

  /**
   * 打开课程详情。
   * @param {string} courseId
   * @param {HTMLElement|null} trigger
   */
  function openDetail(courseId, trigger) {
    // 互换模式的点击语义是「选中」，防御性地拒绝在互换模式下打开详情
    if (swapState.active) {
      return;
    }
    var course = findCourseById(courseId);
    if (!course || !detailOverlayEl) {
      return;
    }
    if (detailOverlayEl.classList.contains('is-open')) {
      return;
    }
    detailCourseId = courseId;
    lastDetailTrigger = trigger || null;
    renderDetail(course);
    showOverlay(detailOverlayEl);
    pushDialog(detailSheetEl, function () {
      closeDetail(true);
    });
    lockBodyScroll();
    detailOpenedAt = Date.now();
    window.setTimeout(
      function () {
        if (!detailOverlayEl.classList.contains('is-open')) {
          return;
        }
        safeFocus(detailCloseEl);
      },
      prefersReducedMotion() ? 0 : 60
    );
  }

  /**
   * 关闭课程详情。
   * @param {boolean} restoreFocus
   */
  function closeDetail(restoreFocus) {
    if (!detailOverlayEl || detailOverlayEl.hidden) {
      return;
    }
    popDialog(detailSheetEl);
    hideOverlay(detailOverlayEl);
    unlockBodyScroll();
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    detailCourseId = null;
    var trigger = lastDetailTrigger;
    lastDetailTrigger = null;
    if (restoreFocus) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /* ==================== 十四、删除与撤销 ==================== */

  /**
   * 删除确认（详情浮层与清单卡片共用同一套文案）。
   * @param {string} courseId
   * @return {Promise<boolean>}
   */
  function askDeleteConfirm(courseId) {
    var target = findCourseById(courseId);
    if (!target) {
      return Promise.resolve(false);
    }
    return askConfirm({
      title: '删除课程',
      message: '确定要删除「' + target.name + '」吗？删除后 5 秒内可以撤销。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true
    });
  }

  /**
   * 请求删除课程（清单 / 未设置时间卡片）。
   * @param {string} courseId
   */
  function requestDelete(courseId) {
    if (!findCourseById(courseId)) {
      return;
    }
    askDeleteConfirm(courseId).then(function (confirmed) {
      if (confirmed) {
        removeCourse(courseId);
      }
    });
  }

  /**
   * 执行删除并显示撤销提示。
   * @param {string} courseId
   */
  function removeCourse(courseId) {
    var index = -1;
    for (var i = 0; i < state.courses.length; i += 1) {
      if (state.courses[i].id === courseId) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      return;
    }
    // 删除前记录位置，删除后据此把焦点落到相邻课程
    var focusHint = getDeleteFocusHint(courseId) || getGridFocusHint(courseId);

    var removed = state.courses.splice(index, 1)[0];
    var savedToStore = persistCourses();
    render();
    announce('已删除课程：' + removed.name + (savedToStore ? '' : '（未能保存到本地）'));
    focusAfterDelete(focusHint);
    showUndoToast(removed, index);
  }

  /**
   * 记录被删卡片所在星期与组内序号（清单视图，用于删除后的焦点落点）。
   * @param {string} courseId
   * @return {{weekday: number, position: number, scope: string}|null}
   */
  function getDeleteFocusHint(courseId) {
    var cardEl = findCardElement(courseId);
    if (!cardEl || typeof cardEl.closest !== 'function') {
      return null;
    }
    var groupEl = cardEl.closest('.group');
    if (!groupEl) {
      return null;
    }
    var cards = groupEl.querySelectorAll('.card');
    var position = -1;
    for (var i = 0; i < cards.length; i += 1) {
      if (cards[i].getAttribute('data-course-id') === courseId) {
        position = i;
        break;
      }
    }
    var titleEl = groupEl.querySelector('.group__title');
    var weekday = -1;
    if (titleEl && typeof titleEl.id === 'string' && titleEl.id.indexOf('group-title-') === 0) {
      weekday = Number(titleEl.id.replace('group-title-', ''));
    }
    if (position === -1 || !isFinite(weekday) || weekday < 1) {
      return null;
    }
    return { weekday: weekday, position: position, scope: 'list' };
  }

  /**
   * 记录被删课表块所在列与列内序号（课表视图，用于删除后的焦点落点）。
   * @param {string} courseId
   * @return {{weekday: number, position: number, scope: string}|null}
   */
  function getGridFocusHint(courseId) {
    var block = findGridBlock(courseId);
    if (!block || typeof block.closest !== 'function') {
      return null;
    }
    var column = block.closest('.tt__col');
    if (!column) {
      return null;
    }
    var weekday = Number(column.getAttribute('data-weekday'));
    var blocks = column.querySelectorAll('.tt-block');
    var position = -1;
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].getAttribute('data-course-id') === courseId) {
        position = i;
        break;
      }
    }
    if (position === -1 || !isFinite(weekday) || weekday < 1) {
      return null;
    }
    return { weekday: weekday, position: position, scope: 'grid' };
  }

  /**
   * 删除后聚焦：同组 / 同列的下一门 → 上一门 → 当前视图容器 → 顶部新增按钮。
   * @param {{weekday: number, position: number, scope?: string}|null} hint
   */
  function focusAfterDelete(hint) {
    if (hint && hint.scope === 'grid') {
      if (timetableScrollEl) {
        var column = timetableScrollEl.querySelector(
          '.tt__col[data-weekday="' + hint.weekday + '"]'
        );
        if (column) {
          var blocks = column.querySelectorAll('.tt-block');
          if (blocks.length > 0) {
            var blockIndex = Math.min(Math.max(hint.position, 0), blocks.length - 1);
            safeFocus(blocks[blockIndex]);
            return;
          }
        }
      }
      focusViewFallback();
      return;
    }

    if (hint) {
      var titleEl = document.getElementById('group-title-' + hint.weekday);
      var groupEl =
        titleEl && typeof titleEl.closest === 'function' ? titleEl.closest('.group') : null;
      if (groupEl) {
        var cards = groupEl.querySelectorAll('.card');
        if (cards.length > 0) {
          var targetIndex = Math.min(Math.max(hint.position, 0), cards.length - 1);
          var deleteButton = cards[targetIndex].querySelector('button[data-action="delete"]');
          if (deleteButton) {
            safeFocus(deleteButton);
            return;
          }
        }
      }
    }
    focusViewFallback();
  }

  /**
   * 焦点兜底：当前视图容器（若有可聚焦内容）→ 顶部新增按钮。
   */
  function focusViewFallback() {
    if (state.view === 'grid') {
      if (timetableScrollEl && timetableScrollEl.querySelector('.tt-block')) {
        safeFocus(timetableScrollEl);
        return;
      }
      safeFocus(btnAddEl);
      return;
    }
    if (state.view === 'tasks') {
      if (tasksListEl && tasksListEl.querySelector('.row__main')) {
        safeFocus(tasksListEl.querySelector('.row__main'));
        return;
      }
      safeFocus(btnAddEl);
      return;
    }
    if (state.view === 'list') {
      if (courseListEl && courseListEl.querySelector('.card')) {
        safeFocus(courseListEl);
        return;
      }
      safeFocus(btnAddEl);
      return;
    }
    // trips 本轮没有可聚焦列表，直接回新增按钮
    safeFocus(btnAddEl);
  }

  /**
   * 显示底部轻提示（撤销 / 信息共用同一个 toast 槽位）。
   * @param {string} text
   * @param {{showUndo: boolean, timeoutMs: number, onTimeout: Function|null}} options
   */
  function showToast(text, options) {
    var showUndo = Boolean(options && options.showUndo);
    var timeoutMs = options && options.timeoutMs ? options.timeoutMs : UNDO_TIMEOUT_MS;
    var onTimeout = options && options.onTimeout ? options.onTimeout : null;

    undoToastTextEl.textContent = text;
    undoButtonEl.hidden = !showUndo;
    undoToastEl.classList.toggle('is-info', !showUndo);
    document.body.classList.add('has-toast');

    if (toastHideTimerId !== null) {
      window.clearTimeout(toastHideTimerId);
      toastHideTimerId = null;
    }
    if (undoTimerId !== null) {
      window.clearTimeout(undoTimerId);
      undoTimerId = null;
    }

    undoToastEl.hidden = false;
    void undoToastEl.offsetWidth;
    undoToastEl.classList.add('is-visible');

    undoTimerId = window.setTimeout(function () {
      undoTimerId = null;
      hideUndoToast();
      if (onTimeout) {
        onTimeout();
      }
    }, timeoutMs);
  }

  /**
   * 显示撤销提示（5 秒）。
   * @param {Object} course
   * @param {number} index 原位置
   */
  function showUndoToast(course, index) {
    clearUndo();
    pendingUndo = { type: 'delete', course: course, index: index };
    showToast('已删除「' + course.name + '」', {
      showUndo: true,
      timeoutMs: UNDO_TIMEOUT_MS,
      onTimeout: function () {
        pendingUndo = null;
      }
    });
  }

  /**
   * 显示信息提示（无操作按钮），5 秒后自动消失。
   * 复用同一个 toast 容器，滑入位置与样式与撤销提示一致。
   * @param {string} text
   */
  function showInfoToast(text) {
    // 单槽位策略：信息提示不保留隐藏的撤销入口，避免状态不一致
    clearUndo();
    showToast(text, {
      showUndo: false,
      timeoutMs: UNDO_TIMEOUT_MS,
      onTimeout: null
    });
  }

  /**
   * 隐藏底部提示。
   */
  function hideUndoToast() {
    undoToastEl.classList.remove('is-visible');
    document.body.classList.remove('has-toast');
    var delay = prefersReducedMotion() ? 0 : OVERLAY_ANIMATION_MS;
    if (toastHideTimerId !== null) {
      window.clearTimeout(toastHideTimerId);
    }
    toastHideTimerId = window.setTimeout(function () {
      undoToastEl.hidden = true;
      toastHideTimerId = null;
    }, delay);
  }

  /**
   * 清理撤销状态与定时器。
   */
  function clearUndo() {
    if (undoTimerId !== null) {
      window.clearTimeout(undoTimerId);
      undoTimerId = null;
    }
    pendingUndo = null;
  }

  /**
   * 撤销删除，把课程放回原位置。
   */
  function undoDelete() {
    if (!pendingUndo) {
      return;
    }
    if (pendingUndo.type === 'import-batch') {
      undoImportBatch();
      return;
    }
    if (pendingUndo.type === 'catalog-add') {
      undoCatalogAdd();
      return;
    }
    if (pendingUndo.type === 'task-delete') {
      undoTaskDelete();
      return;
    }
    if (pendingUndo.type === 'trip-delete') {
      undoTripDelete();
      return;
    }
    var course = pendingUndo.course;
    var insertAt = Math.min(Math.max(pendingUndo.index, 0), state.courses.length);
    clearUndo();
    state.courses.splice(insertAt, 0, course);
    var savedToStore = persistCourses();
    render();
    hideUndoToast();
    announce('已恢复课程：' + course.name + (savedToStore ? '' : '（未能保存到本地）'));
    highlightCourse(course.id);
    focusRestoredCourse(course.id);
  }

  /**
   * 撤销后把焦点落到被恢复的课程上（撤销按钮随后隐藏，不能把焦点留在 body）。
   * @param {string} courseId
   */
  function focusRestoredCourse(courseId) {
    // 优先落在当前视图里的那个元素，避免把焦点交给另一个（隐藏）视图
    if (state.view === 'grid') {
      var block = findGridBlock(courseId);
      if (block) {
        safeFocus(block);
        return;
      }
    }
    var cardEl = findCardElement(courseId);
    if (cardEl) {
      var deleteButton = cardEl.querySelector('button[data-action="delete"]');
      if (deleteButton) {
        safeFocus(deleteButton);
        return;
      }
    }
    focusViewFallback();
  }

  /* ==================== 十五、确认框 ==================== */

  /**
   * 轻量确认框（Promise 版），复用遮罩样式并支持焦点管理。
   * @param {{title: string, message: string, confirmLabel: string, cancelLabel: string, danger: boolean}} options
   * @return {Promise<boolean>}
   */
  function askConfirm(options) {
    return new Promise(function (resolve) {
      // 若已有确认框，先把上一个按“取消”结束，避免 Promise 悬挂
      if (confirmResolver) {
        var previous = confirmResolver;
        confirmResolver = null;
        previous(false);
        popDialog(confirmDialogEl);
        hideOverlay(confirmOverlayEl);
        unlockBodyScroll();
      }

      confirmResolver = resolve;
      lastConfirmTrigger = document.activeElement;
      confirmTitleEl.textContent = options.title;
      confirmMessageEl.textContent = options.message;
      confirmOkEl.textContent = options.confirmLabel;
      confirmCancelEl.textContent = options.cancelLabel;
      confirmOkEl.classList.toggle('btn--danger', Boolean(options.danger));
      confirmOkEl.classList.toggle('btn--primary', !options.danger);

      showOverlay(confirmOverlayEl);
      pushDialog(confirmDialogEl, function () {
        settleConfirm(false);
      });
      lockBodyScroll();

      window.setTimeout(
        function () {
          // 弹窗可能已被极快交互关闭：此时绝不能再把焦点拉回已关闭的确认框
          if (!confirmResolver || confirmOverlayEl.hidden) {
            return;
          }
          safeFocus(confirmCancelEl);
        },
        prefersReducedMotion() ? 0 : 60
      );
    });
  }

  /**
   * 结束确认框并回传结果。
   * @param {boolean} result
   */
  function settleConfirm(result) {
    if (!confirmResolver) {
      return;
    }
    var resolve = confirmResolver;
    confirmResolver = null;
    popDialog(confirmDialogEl);
    hideOverlay(confirmOverlayEl);
    unlockBodyScroll();
    var trigger = lastConfirmTrigger;
    lastConfirmTrigger = null;
    safeFocus(trigger);
    resolve(result);
  }

  /* ==================== 十六、图片识别导入 ==================== */

  /**
   * 释放所有缩略图 objectURL。
   */
  function revokeImportUrls() {
    var urls = importState.objectUrls || [];
    for (var i = 0; i < urls.length; i += 1) {
      try {
        window.URL.revokeObjectURL(urls[i]);
      } catch (err) {
        /* 忽略：URL 可能已被浏览器回收 */
      }
    }
    importState.objectUrls = [];
  }

  /**
   * 重置导入面板的界面与状态。
   */
  function resetImportUi() {
    revokeImportUrls();
    importState.files = [];
    importState.candidates = [];
    importState.busy = false;
    importState.requestId += 1;
    if (importThumbsEl) {
      importThumbsEl.textContent = '';
      importThumbsEl.hidden = true;
    }
    if (importWarningsEl) {
      importWarningsEl.textContent = '';
      importWarningsEl.hidden = true;
    }
    if (importCandidatesEl) {
      importCandidatesEl.textContent = '';
      importCandidatesEl.hidden = true;
    }
    if (importStatusEl) {
      importStatusEl.textContent = '';
    }
    if (importDropzoneEl) {
      importDropzoneEl.hidden = false;
    }
    if (importBulkEl) {
      importBulkEl.hidden = true;
    }
    if (importBulkWeekdayEl) {
      importBulkWeekdayEl.value = '';
    }
    if (importBulkPeriodStartEl) {
      importBulkPeriodStartEl.value = '';
    }
    if (importBulkPeriodEndEl) {
      importBulkPeriodEndEl.value = '';
    }
    setImportRunning(false);
    if (importPickEl) {
      importPickEl.textContent = '从相册选';
    }
    if (importFileEl) {
      importFileEl.value = '';
    }
    updateImportConfirm();
  }

  /**
   * 设置识别状态文案。
   * @param {string} text
   */
  function setImportStatus(text) {
    if (importStatusEl) {
      importStatusEl.textContent = text;
    }
  }

  /**
   * 渲染警告列表。
   * @param {Array<string>} warnings
   */
  function renderImportWarnings(warnings) {
    if (!importWarningsEl) {
      return;
    }
    importWarningsEl.textContent = '';
    if (!warnings || warnings.length === 0) {
      importWarningsEl.hidden = true;
      return;
    }
    for (var i = 0; i < warnings.length; i += 1) {
      importWarningsEl.appendChild(createEl('li', 'import-warnings__item', warnings[i]));
    }
    importWarningsEl.hidden = false;
  }

  /**
   * 渲染已选图片的缩略图。
   * @param {Array<File>} files
   */
  function renderImportThumbs(files) {
    if (!importThumbsEl) {
      return;
    }
    importThumbsEl.textContent = '';
    importState.objectUrls = [];
    if (!files || files.length === 0) {
      importThumbsEl.hidden = true;
      return;
    }
    for (var i = 0; i < files.length; i += 1) {
      var item = createEl('li', 'thumb');
      var url = '';
      try {
        url = window.URL.createObjectURL(files[i]);
      } catch (err) {
        url = '';
      }
      if (url) {
        importState.objectUrls.push(url);
        var img = document.createElement('img');
        img.className = 'thumb__img';
        img.src = url;
        img.alt = '课表截图 ' + (i + 1);
        img.loading = 'lazy';
        item.appendChild(img);
      } else {
        item.appendChild(createEl('span', 'thumb__fallback', '图片 ' + (i + 1)));
      }
      item.appendChild(createEl('span', 'thumb__index', String(i + 1)));
      importThumbsEl.appendChild(item);
    }
    importThumbsEl.hidden = false;
  }

  /**
   * 创建一条候选课程的输入控件。
   * @param {string} labelText
   * @param {string} role
   * @param {string} inputType
   * @param {string} value
   * @param {number} index
   * @return {HTMLElement}
   */
  function createCandidateField(labelText, role, inputType, value, index) {
    var wrap = createEl('div', 'candidate__field');
    var id = 'candidate-' + role + '-' + index;
    var label = createEl('label', 'candidate__label', labelText);
    label.setAttribute('for', id);
    wrap.appendChild(label);
    var input = document.createElement('input');
    input.className = 'input';
    input.id = id;
    input.type = inputType;
    input.value = value || '';
    input.setAttribute('data-role', role);
    if (inputType === 'time') {
      input.step = '300';
    }
    wrap.appendChild(input);
    return wrap;
  }

  /**
   * 创建星期选择器。
   * @param {number} value
   * @param {number} index
   * @return {HTMLElement}
   */
  function createCandidateWeekday(value, index) {
    var wrap = createEl('div', 'candidate__field');
    var id = 'candidate-weekday-' + index;
    var label = createEl('label', 'candidate__label', '星期');
    label.setAttribute('for', id);
    wrap.appendChild(label);
    var select = document.createElement('select');
    select.className = 'input input--select';
    select.id = id;
    select.setAttribute('data-role', 'weekday');
    for (var day = 1; day <= 7; day += 1) {
      var option = document.createElement('option');
      option.value = String(day);
      option.textContent = WEEKDAY_LABELS[day - 1];
      if (day === clampWeekday(value)) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    wrap.appendChild(select);
    return wrap;
  }

  /**
   * 候选的「节次 / 时间」摘要文案：优先用节次（模型只报节次时更可靠）。
   * @param {Object} entry
   * @return {string}
   */
  function formatPeriodLabel(entry) {
    var start = Number(entry && entry.periodStart) || 0;
    var end = Number(entry && entry.periodEnd) || 0;
    if (start > 0) {
      return end > start ? '第' + start + '-' + end + '节' : '第' + start + '节';
    }
    var from = normalizeTimeString(entry && entry.startTime);
    var to = normalizeTimeString(entry && entry.endTime);
    if (from && to) {
      return from + '–' + to;
    }
    return '时间待补';
  }

  /**
   * 候选的摘要行文案：`周三 · 第3-4节 · A301 · ✓93%`。
   * 置信度写进同一行（不做独立徽标），320px 下才能把每条卡片压到 ~96px。
   * 教师**只在需要区分时**才追加（与库内同名，或同时间有多门），平时不加那一行。
   * @param {Object} entry
   * @return {string}
   */
  function formatCandidateMeta(entry) {
    var flags = (entry && entry.flags) || {};
    var parts = [WEEKDAY_LABELS[clampWeekday(entry && entry.weekday) - 1]];
    parts.push(formatPeriodLabel(entry));
    var teacher = String((entry && entry.teacher) || '').trim();
    if (flags.showTeacher && teacher) {
      parts.push(teacher);
    }
    var place = String((entry && entry.place) || '').trim();
    if (place) {
      parts.push(place);
    }
    var confidence = Number(entry && entry.confidence) || 0;
    var percent = Math.round(confidence * 100);
    parts.push((confidence < LOW_CONFIDENCE ? '⚠ ' : '✓ ') + percent + '%');
    return parts.join(' · ');
  }

  /**
   * 时间区间是否重叠（首尾相接不算重叠）。
   * @param {number} aStart
   * @param {number} aEnd
   * @param {number} bStart
   * @param {number} bEnd
   * @return {boolean}
   */
  function isTimeOverlap(aStart, aEnd, bStart, bEnd) {
    if (aStart < 0 || aEnd < 0 || bStart < 0 || bEnd < 0) {
      return false;
    }
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * 从 weeks / note 里提取单双周提示（只做展示，不落库、不新增字段）。
   * @param {Object} entry
   * @return {string} 形如 '单周' / '1-16周'，没有则空串
   */
  function extractWeeksHint(entry) {
    var weeks = String((entry && entry.weeks) || '').trim();
    var note = String((entry && entry.note) || '').trim();
    var pattern = /(单双周|单周|双周|\d+\s*-\s*\d+\s*周)/;
    if (weeks && pattern.test(weeks)) {
      return weeks;
    }
    var matched = pattern.exec(note);
    return matched ? matched[0] : '';
  }

  /**
   * 给候选打标记：低置信度 / 疑似重复 / 时间冲突 / 单双周。
   *
   * - 低置信度（<0.6）：黄边 + 默认不勾选 + 置顶
   * - 与库内课程**同名同时间**：疑似重复 → 默认不勾选
   * - 与库内课程**时间重叠但不重名**：时间冲突 → 允许导入，但必须提示
   * - 同名或同时间有多门时，摘要里补出「教师」帮助区分
   *
   * @param {Array<Object>} candidates
   * @param {Array<Object>} courseList
   * @param {boolean} [resetChecked] 是否按默认规则重设勾选（批量编辑必须传 false，否则会静默改掉用户的选择）
   * @return {{duplicates: number, conflicts: number, low: number}}
   */
  function detectIssues(candidates, courseList, resetChecked) {
    var summary = { duplicates: 0, conflicts: 0, low: 0 };
    var library = Array.isArray(courseList) ? courseList : [];
    var keepChecked = resetChecked === false;
    for (var i = 0; i < candidates.length; i += 1) {
      var entry = candidates[i];
      var flags = { low: false, duplicate: false, conflict: [], showTeacher: false, weeksHint: '' };
      flags.low = Number(entry.confidence) < LOW_CONFIDENCE;
      if (flags.low) {
        summary.low += 1;
      }
      var entryStart = timeToMinutes(entry.startTime);
      var entryEnd = timeToMinutes(entry.endTime);
      var entryWeekday = clampWeekday(entry.weekday);
      var entryName = String(entry.name || '').trim().toLowerCase();
      for (var j = 0; j < library.length; j += 1) {
        var course = library[j];
        if (clampWeekday(course.weekday) !== entryWeekday) {
          continue;
        }
        if (!isTimeOverlap(
          entryStart,
          entryEnd,
          timeToMinutes(course.startTime),
          timeToMinutes(course.endTime)
        )) {
          continue;
        }
        if (String(course.name || '').trim().toLowerCase() === entryName) {
          flags.duplicate = true;
        } else {
          flags.conflict.push(String(course.name || '未命名课程'));
        }
      }
      // 批次内同时间有多门：也算「需要靠教师区分」的场景
      var batchOverlap = 0;
      for (var b = 0; b < candidates.length; b += 1) {
        if (b === i) {
          continue;
        }
        var other = candidates[b];
        if (clampWeekday(other.weekday) !== entryWeekday) {
          continue;
        }
        if (isTimeOverlap(
          entryStart,
          entryEnd,
          timeToMinutes(other.startTime),
          timeToMinutes(other.endTime)
        )) {
          batchOverlap += 1;
        }
      }
      flags.showTeacher = flags.duplicate || flags.conflict.length > 0 || batchOverlap > 0;
      flags.weeksHint = extractWeeksHint(entry);
      if (flags.duplicate) {
        summary.duplicates += 1;
      }
      if (flags.conflict.length > 0) {
        summary.conflicts += 1;
      }
      entry.flags = flags;
      // 批量编辑路径必须保留用户已有的勾选（resetChecked === false）
      if (!keepChecked) {
        entry.checked = !(flags.low || flags.duplicate);
      }
    }
    return summary;
  }

  /**
   * 候选排序：低置信度置顶，其余按「星期 → 节次 → 开始时间」。
   * 用户核对时沿时间线走更顺，需要人工处理的项集中在最前面。
   * @param {Array<Object>} candidates
   * @return {Array<Object>} 同一个数组（就地排序后返回）
   */
  function sortCandidates(candidates) {
    candidates.sort(function (a, b) {
      var aLow = a.flags && a.flags.low ? 0 : 1;
      var bLow = b.flags && b.flags.low ? 0 : 1;
      if (aLow !== bLow) {
        return aLow - bLow;
      }
      var aWeekday = clampWeekday(a.weekday);
      var bWeekday = clampWeekday(b.weekday);
      if (aWeekday !== bWeekday) {
        return aWeekday - bWeekday;
      }
      var aPeriod = Number(a.periodStart) || 99;
      var bPeriod = Number(b.periodStart) || 99;
      if (aPeriod !== bPeriod) {
        return aPeriod - bPeriod;
      }
      return timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
    });
    return candidates;
  }

  /**
   * 渲染一条候选课程（摘要卡）。
   *
   * 默认只显示：勾选框 + 课名 + `周X 第N-M节 · 地点` + 置信度 + 标记。
   * 6 个输入框只在点「改」之后才创建 —— 10 门课的可见输入框从 60 个降到 0 个。
   *
   * @param {Object} entry
   * @param {number} index
   * @return {HTMLElement}
   */
  function createCandidateRow(entry, index) {
    var flags = entry.flags || {
      low: false,
      duplicate: false,
      conflict: [],
      showTeacher: false,
      weeksHint: ''
    };
    var row = createEl('div', 'candidate');
    row.setAttribute('data-index', String(index));
    row.classList.toggle('candidate--low', Boolean(flags.low));
    row.classList.toggle('candidate--dup', Boolean(flags.duplicate));
    row.classList.toggle('candidate--conflict', flags.conflict.length > 0);
    row.classList.toggle('is-expanded', Boolean(entry.expanded));

    var head = createEl('div', 'candidate__head');
    var checkWrap = createEl('label', 'candidate__check');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'candidate__checkbox';
    checkbox.checked = entry.checked !== false;
    checkbox.setAttribute('data-role', 'check');
    checkbox.id = 'candidate-check-' + index;
    checkbox.setAttribute('aria-label', '导入「' + (entry.name || '未命名课程') + '」');
    checkWrap.appendChild(checkbox);

    var summary = createEl('span', 'candidate__summary');
    summary.appendChild(createEl('span', 'candidate__name', entry.name || '（未命名课程）'));
    summary.appendChild(createEl('span', 'candidate__meta', formatCandidateMeta(entry)));

    var flagTexts = [];
    if (flags.duplicate) {
      flagTexts.push('疑似重复：库里已有同名同时间的课，默认不导入');
    }
    if (flags.conflict.length > 0) {
      flagTexts.push('时间冲突：与「' + flags.conflict.join('」「') + '」时间重叠');
    }
    if (flags.low) {
      flagTexts.push('置信度较低，建议核对后再导入');
    }
    if (flagTexts.length > 0 || flags.weeksHint) {
      var flagsRow = createEl('span', 'candidate__flags');
      for (var f = 0; f < flagTexts.length; f += 1) {
        var flagClass = 'candidate__flag';
        if (f === 0) {
          flagClass += flags.duplicate
            ? ' candidate__flag--dup'
            : flags.low
              ? ' candidate__flag--low'
              : ' candidate__flag--conflict';
        }
        flagsRow.appendChild(createEl('span', flagClass, flagTexts[f]));
      }
      // 单双周只做提示：不新增字段、不进渲染逻辑，原文来自 weeks / note
      if (flags.weeksHint) {
        flagsRow.appendChild(
          createEl('span', 'candidate__flag candidate__flag--weeks', '单双周：' + flags.weeksHint)
        );
      }
      summary.appendChild(flagsRow);
    }
    checkWrap.appendChild(summary);
    head.appendChild(checkWrap);

    // 操作按钮与摘要同一行：多留一行就装不下 10 条 <1000px 的预算
    var actions = createEl('div', 'candidate__actions');
    var toggleLabel = entry.expanded ? '收起' : '改';
    var toggleBtn = createEl('button', 'btn btn--ghost candidate__action', toggleLabel);
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('data-role', 'toggle');
    toggleBtn.setAttribute('aria-expanded', entry.expanded ? 'true' : 'false');
    toggleBtn.setAttribute('aria-controls', 'candidate-grid-' + index);
    toggleBtn.setAttribute(
      'aria-label',
      (entry.expanded ? '收起「' : '编辑「') + (entry.name || '未命名课程') + '」'
    );
    toggleBtn.title = entry.expanded ? '收起字段' : '展开字段修改';
    actions.appendChild(toggleBtn);

    // 删除按钮用图标而不是单字：既省宽度（44px 热区不变）又不含糊。
    // 复用内联精灵里的 icon-trash（与互换 / 日志图标同一套笔画风格）。
    var removeBtn = createEl('button', 'btn btn--danger-ghost candidate__action');
    removeBtn.type = 'button';
    removeBtn.setAttribute('data-role', 'remove');
    removeBtn.setAttribute('aria-label', '删除候选「' + (entry.name || '未命名课程') + '」');
    removeBtn.title = '删除这条候选';
    removeBtn.appendChild(createIcon('icon-trash'));
    actions.appendChild(removeBtn);
    head.appendChild(actions);

    row.appendChild(head);

    var grid = createEl('div', 'candidate__grid');
    grid.id = 'candidate-grid-' + index;
    grid.hidden = !entry.expanded;
    grid.appendChild(createCandidateField('课程名称', 'name', 'text', entry.name, index));
    grid.appendChild(createCandidateWeekday(entry.weekday, index));
    grid.appendChild(createCandidateField('开始', 'startTime', 'time', entry.startTime, index));
    grid.appendChild(createCandidateField('结束', 'endTime', 'time', entry.endTime, index));
    grid.appendChild(createCandidateField('教师', 'teacher', 'text', entry.teacher, index));
    grid.appendChild(createCandidateField('地点', 'place', 'text', entry.place, index));
    row.appendChild(grid);

    return row;
  }

  /**
   * 渲染全部候选课程。
   */
  function renderCandidates() {
    if (!importCandidatesEl) {
      return;
    }
    importCandidatesEl.textContent = '';
    if (importState.candidates.length === 0) {
      importCandidatesEl.hidden = true;
      updateImportBulkBar();
      return;
    }
    for (var i = 0; i < importState.candidates.length; i += 1) {
      importCandidatesEl.appendChild(createCandidateRow(importState.candidates[i], i));
    }
    importCandidatesEl.hidden = false;
    updateImportBulkBar();
  }

  /**
   * 刷新批量操作条：已选条数 + 可见性。
   */
  function updateImportBulkBar() {
    if (!importBulkEl) {
      return;
    }
    var total = importState.candidates.length;
    if (total === 0) {
      importBulkEl.hidden = true;
      return;
    }
    var checked = 0;
    for (var i = 0; i < total; i += 1) {
      if (importState.candidates[i].checked !== false) {
        checked += 1;
      }
    }
    importBulkEl.hidden = false;
    if (importBulkTitleEl) {
      importBulkTitleEl.textContent = '已选 ' + checked + ' / ' + total + ' 条';
    }
  }

  /**
   * 从界面读回一条候选值。
   * @param {HTMLElement} row
   * @param {string} role
   * @return {string}
   */
  function readCandidateValue(row, role) {
    var node = row.querySelector('[data-role="' + role + '"]');
    return node ? String(node.value || '').trim() : '';
  }

  /**
   * 把界面上的编辑同步回候选数据。
   * 折叠状态的卡片没有用户改动，直接跳过回读（省一次 DOM 查询）。
   */
  function syncCandidatesFromDom() {
    if (!importCandidatesEl) {
      return;
    }
    var rows = importCandidatesEl.querySelectorAll('.candidate');
    for (var i = 0; i < rows.length; i += 1) {
      var index = Number(rows[i].getAttribute('data-index'));
      var entry = importState.candidates[index];
      if (!entry) {
        continue;
      }
      var check = rows[i].querySelector('[data-role="check"]');
      entry.checked = Boolean(check && check.checked);
      var grid = rows[i].querySelector('.candidate__grid');
      if (!grid || grid.hidden) {
        continue;
      }
      var nextName = readCandidateValue(rows[i], 'name');
      var nextStart = readCandidateValue(rows[i], 'startTime');
      var nextEnd = readCandidateValue(rows[i], 'endTime');
      var timesChanged =
        normalizeTimeString(nextStart) !== normalizeTimeString(entry.startTime) ||
        normalizeTimeString(nextEnd) !== normalizeTimeString(entry.endTime);
      entry.name = nextName;
      entry.weekday = clampWeekday(readCandidateValue(rows[i], 'weekday'));
      entry.startTime = nextStart;
      entry.endTime = nextEnd;
      entry.teacher = readCandidateValue(rows[i], 'teacher');
      entry.place = readCandidateValue(rows[i], 'place');
      if (timesChanged) {
        // 用户手工改了时间：节次信息随之失效，摘要改显示具体时间
        entry.periodStart = 0;
        entry.periodEnd = 0;
      }
    }
  }

  /**
   * 就地刷新一行候选的摘要（不重建 DOM，焦点不会掉）。
   * @param {HTMLElement} row
   * @param {Object} entry
   */
  function updateCandidateSummaryDom(row, entry) {
    if (!row || !entry) {
      return;
    }
    var nameEl = row.querySelector('.candidate__name');
    if (nameEl) {
      nameEl.textContent = entry.name || '（未命名课程）';
    }
    var metaEl = row.querySelector('.candidate__meta');
    if (metaEl) {
      metaEl.textContent = formatCandidateMeta(entry);
    }
  }

  /**
   * 刷新「确认导入 (N)」按钮与批量操作条。
   */
  function updateImportConfirm() {
    if (!importConfirmEl) {
      return;
    }
    var count = 0;
    for (var i = 0; i < importState.candidates.length; i += 1) {
      if (importState.candidates[i].checked !== false) {
        count += 1;
      }
    }
    importConfirmEl.textContent = count > 0 ? '确认导入 (' + count + ')' : '确认导入';
    importConfirmEl.disabled = importState.busy || count === 0;
    updateImportBulkBar();
  }

  /**
   * 应用识别结果（stub 时为「空结果 + 未接入提示」，绝不生成假数据）。
   * @param {{courses: Array<Object>, warnings: Array<string>, meta: Object}} result
   */
  function applyImportResult(result) {
    var courses = result && Array.isArray(result.courses) ? result.courses : [];
    var warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    var ready = Boolean(
      window.CourseImport &&
        typeof window.CourseImport.isReady === 'function' &&
        window.CourseImport.isReady()
    );

    var merged = warnings.slice();
    var notReadyText =
      (window.CourseImport && window.CourseImport.NOT_READY_WARNING) ||
      '识别服务尚未接入（接口已预留）';
    if (!ready && merged.indexOf(notReadyText) === -1) {
      merged.push(notReadyText);
    }
    renderImportWarnings(merged);

    importState.phase = 'reviewing';
    var candidates = [];
    for (var i = 0; i < courses.length; i += 1) {
      var periodStart = Number(courses[i].periodStart) || 0;
      var periodEnd = Number(courses[i].periodEnd) || 0;
      var startTime = normalizeTimeString(courses[i].startTime);
      var endTime = normalizeTimeString(courses[i].endTime);
      // 容错：第三方识别器可能只给节次（契约允许）。节次是唯一事实来源，
      // 这里用 timetable.js 换算一次，避免「有节次却没时间」被当成无效候选丢掉。
      if (
        (!startTime || !endTime) &&
        periodStart > 0 &&
        window.CourseTimetable &&
        typeof window.CourseTimetable.periodRangeToTimes === 'function'
      ) {
        var derived = window.CourseTimetable.periodRangeToTimes(periodStart, periodEnd || periodStart);
        if (!startTime) {
          startTime = derived.startTime;
        }
        if (!endTime) {
          endTime = derived.endTime;
        }
      }
      candidates.push({
        checked: true,
        expanded: false,
        name: courses[i].name,
        weekday: courses[i].weekday,
        startTime: startTime,
        endTime: endTime,
        teacher: courses[i].teacher,
        place: courses[i].place,
        note: courses[i].note,
        confidence: courses[i].confidence,
        periodStart: periodStart,
        periodEnd: periodEnd,
        weeks: courses[i].weeks || '',
        rowSpan: Number(courses[i].rowSpan) || 1,
        col: Number(courses[i].col) || 0,
        flags: { low: false, duplicate: false, conflict: [] }
      });
    }
    var issueSummary = detectIssues(candidates, state.courses);
    importState.candidates = sortCandidates(candidates);
    renderCandidates();

    // 状态行要说清「为什么没有结果」：
    // 识别失败 / 超时 / 文件不合法时直接显示原因，只有「识别成功但结果为空」
    // 才使用「没有识别到课程」这句兜底文案。
    if (courses.length > 0) {
      var statusText = '识别到 ' + courses.length + ' 门课程，请核对后导入。';
      var trouble = [];
      if (issueSummary.duplicates > 0) {
        trouble.push(issueSummary.duplicates + ' 条疑似重复');
      }
      if (issueSummary.conflicts > 0) {
        trouble.push(issueSummary.conflicts + ' 条时间冲突');
      }
      if (issueSummary.low > 0) {
        trouble.push(issueSummary.low + ' 条置信度偏低');
      }
      if (trouble.length > 0) {
        statusText += '提示：' + trouble.join('、') + '。';
        if (issueSummary.duplicates > 0 || issueSummary.low > 0) {
          statusText += '疑似重复与置信度偏低的项已默认不勾选；';
        }
        if (issueSummary.conflicts > 0) {
          statusText += '时间冲突的项仍已勾选，请确认确实要导入。';
        }
      }
      setImportStatus(statusText);
    } else if (!ready) {
      setImportStatus('识别服务尚未配置，展开上方「识别服务设置」填写接口信息后即可识别。');
    } else {
      var reason = '';
      for (var r = 0; r < merged.length; r += 1) {
        if (merged[r] === notReadyText) {
          continue;
        }
        // 「部分结果缺少课程名称」属于「识别成功但不完整」，不能用来解释空结果
        if (merged[r].indexOf('缺少课程名称') >= 0) {
          continue;
        }
        reason = merged[r];
        break;
      }
      setImportStatus(reason || '没有识别到课程，可以换一张更清晰的截图再试。');
    }
    updateImportConfirm();
  }

  /**
   * 显示 / 隐藏「取消识别」按钮。
   * @param {boolean} running
   */
  function setImportRunning(running) {
    if (importRunEl) {
      importRunEl.hidden = !running;
    }
  }

  /**
   * 刷新识别进度文案（节流 ≥1s，避免 aria-live 被刷屏）。
   * @param {number} done
   * @param {number} total
   */
  function updateImportProgress(done, total) {
    var now = Date.now();
    if (now - importState.lastStatusAt < IMPORT_STATUS_THROTTLE_MS) {
      return;
    }
    importState.lastStatusAt = now;
    setImportStatus('识别中 ' + Math.min(done, total) + '/' + total + '…');
  }

  /**
   * 开始识别（含文件校验）。
   * @param {Array<File>} files
   * @param {{source?: string}} [options] source: 'camera' | 'screenshot'
   */
  function startImportRecognition(files, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var source = opts.source === 'camera' ? 'camera' : 'screenshot';

    revokeImportUrls();
    importState.files = files;
    importState.candidates = [];
    importState.source = source;
    importState.phase = 'recognizing';
    importState.requestId += 1;
    var token = importState.requestId;

    renderImportThumbs(files);
    if (importCandidatesEl) {
      importCandidatesEl.textContent = '';
      importCandidatesEl.hidden = true;
    }
    if (importBulkEl) {
      importBulkEl.hidden = true;
    }
    renderImportWarnings([]);
    if (importDropzoneEl) {
      importDropzoneEl.hidden = true;
    }
    if (importPickEl) {
      importPickEl.textContent = '重新选择';
    }
    importState.busy = true;
    importState.lastStatusAt = 0;
    setImportStatus('识别中…');
    setImportRunning(true);
    updateImportConfirm();

    var api = window.CourseImport;
    if (!api || typeof api.recognize !== 'function') {
      importState.busy = false;
      importState.phase = 'collecting';
      setImportRunning(false);
      applyImportResult({
        courses: [],
        warnings: ['识别服务不可用（import-service.js 未加载）']
      });
      return;
    }

    var controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    importState.controller = controller;

    api
      .recognize(files, {
        source: source,
        signal: controller ? controller.signal : null,
        onProgress: function (done, total) {
          if (token !== importState.requestId) {
            return;
          }
          updateImportProgress(done, total);
        }
      })
      .then(
        function (result) {
          if (token !== importState.requestId) {
            return;
          }
          importState.busy = false;
          importState.controller = null;
          setImportRunning(false);
          applyImportResult(result);
        },
        function (err) {
          if (token !== importState.requestId) {
            return;
          }
          importState.busy = false;
          importState.controller = null;
          setImportRunning(false);
          applyImportResult({
            courses: [],
            warnings: ['识别失败：' + (err && err.message ? err.message : '未知错误')]
          });
        }
      );
  }

  /**
   * 取消正在进行的识别：abort 在飞请求，回到可重新识别的状态。
   * 不抛异常、不 toast 报错（取消是用户的正常操作）。
   */
  function cancelImportRecognition() {
    if (importState.phase !== 'recognizing') {
      return;
    }
    importState.requestId += 1;
    importState.busy = false;
    importState.phase = 'collecting';
    importState.controller = null;
    if (window.CourseImport && typeof window.CourseImport.abortRecognition === 'function') {
      window.CourseImport.abortRecognition();
    }
    setImportRunning(false);
    // 取消后必须能立刻重新选图：dropzone 重新露出来（缩略图保留，方便用户对照）
    if (importDropzoneEl) {
      importDropzoneEl.hidden = false;
    }
    setImportStatus('已取消识别。可以重新选一张图，或再拍一张。');
    if (importPickEl) {
      importPickEl.textContent = '重新选择';
    }
    updateImportConfirm();
    safeFocus(importCameraPickEl || importPickEl || importCloseEl);
  }

  /**
   * 选择文件后的处理（相册 / 文件选择器）。
   * @param {Event} event
   */
  function handleImportFileChange(event) {
    var input = event.target;
    var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (files.length === 0) {
      return;
    }
    if (importDropzoneEl) {
      importDropzoneEl.hidden = true;
    }
    startImportRecognition(files, { source: 'screenshot' });
  }

  /**
   * 打开系统相机。
   *
   * ⚠️ 必须在 click 事件里**同步**调用 input.click()：先 await / setTimeout 再 click
   * 会丢掉用户手势，iOS Safari 会静默拒绝弹出相机。
   *
   * @param {HTMLElement|null} trigger 取消拍摄后焦点回到这里
   */
  function openCamera(trigger) {
    if (!importCameraEl) {
      return;
    }
    cameraTrigger = trigger || null;
    try {
      importCameraEl.click();
    } catch (err) {
      /* 极少数环境禁止程序化点击：退回文件选择器 */
      if (importFileEl) {
        importFileEl.click();
      }
    }
  }

  /**
   * 拍完照后的处理：自动进面板并立即开始识别（用户不需要再点任何按钮）。
   * @param {Event} event
   */
  function handleCameraFileChange(event) {
    var input = event.target;
    var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    // 清空 value：同一张照片再拍一次也能触发 change
    if (input) {
      input.value = '';
    }
    if (files.length === 0) {
      // 用户取消拍摄：静默返回，不 toast、不报错，状态仍是 collecting
      if (cameraTrigger && document.activeElement === document.body) {
        safeFocus(cameraTrigger);
      }
      return;
    }
    var trigger = cameraTrigger || btnCameraEl;
    cameraTrigger = null;
    if (!importOverlayEl || !importOverlayEl.classList.contains('is-open')) {
      // 表单里点的「拍照导入」：导入面板层叠在表单上，导入成功后按 form 来源收尾
      var origin =
        formOverlayEl && formOverlayEl.classList.contains('is-open') ? 'form' : 'toolbar';
      openImport(trigger, origin);
    }
    startImportRecognition(files, { source: 'camera' });
  }

  /**
   * 打开导入面板。
   * @param {HTMLElement|null} trigger
   * @param {'form'|'toolbar'} origin
   */
  function openImport(trigger, origin) {
    if (!importOverlayEl || importOverlayEl.classList.contains('is-open')) {
      return;
    }
    importState.origin = origin === 'form' ? 'form' : 'toolbar';
    importState.trigger = trigger || null;
    importState.phase = 'collecting';
    resetImportUi();
    showOverlay(importOverlayEl);
    pushDialog(importSheetEl, function () {
      closeImport(true);
    });
    lockBodyScroll();
    importOpenedAt = Date.now();
    window.setTimeout(
      function () {
        if (!importOverlayEl.classList.contains('is-open')) {
          return;
        }
        safeFocus(importCameraPickEl || importPickEl || importCloseEl);
      },
      prefersReducedMotion() ? 0 : 60
    );
  }

  /**
   * 关闭导入面板。
   * @param {boolean} restoreFocus
   */
  function closeImport(restoreFocus) {
    if (!importOverlayEl || importOverlayEl.hidden) {
      return;
    }
    popDialog(importSheetEl);
    hideOverlay(importOverlayEl);
    unlockBodyScroll();
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    // 让在途识别结果失效，并真正中止在飞请求（关掉面板不等于网络请求结束）
    importState.requestId += 1;
    importState.busy = false;
    importState.phase = 'collecting';
    importState.controller = null;
    setImportRunning(false);
    if (window.CourseImport && typeof window.CourseImport.abortRecognition === 'function') {
      window.CourseImport.abortRecognition();
    }
    // 内容清理与缩略图释放延后到退场动画之后：
    // 一是避免淡出过程中缩略图变成空白，二是保证面板关闭后 DOM 里不残留候选课程。
    var cleanupDelay = prefersReducedMotion() ? 0 : OVERLAY_ANIMATION_MS + 40;
    window.setTimeout(function () {
      if (!importOverlayEl || !importOverlayEl.hidden) {
        // 已经重新打开：交给 resetImportUi 处理，别把新内容清掉
        return;
      }
      revokeImportUrls();
      if (importThumbsEl) {
        importThumbsEl.textContent = '';
        importThumbsEl.hidden = true;
      }
      if (importCandidatesEl) {
        importCandidatesEl.textContent = '';
        importCandidatesEl.hidden = true;
      }
      if (importWarningsEl) {
        importWarningsEl.textContent = '';
        importWarningsEl.hidden = true;
      }
      if (importStatusEl) {
        importStatusEl.textContent = '';
      }
      importState.candidates = [];
      importState.files = [];
    }, cleanupDelay);

    var trigger = importState.trigger;
    importState.trigger = null;
    if (restoreFocus) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * 确认导入：与手动录入走同一套校验与写库路径。
   * 写库后立即回读校验，任何一步失败都整批回滚（绝不出现「UI 有了、库里没有」）。
   */
  function confirmImport() {
    if (importState.busy) {
      return;
    }
    syncCandidatesFromDom();

    var batchId = createId();
    var now = Date.now();
    var added = [];
    var skipped = 0;

    for (var i = 0; i < importState.candidates.length; i += 1) {
      var entry = importState.candidates[i];
      if (entry.checked === false) {
        continue;
      }
      var values = {
        name: String(entry.name || '').trim(),
        weekday: clampWeekday(entry.weekday),
        startTime: normalizeTimeString(entry.startTime),
        endTime: normalizeTimeString(entry.endTime),
        teacher: String(entry.teacher || '').trim(),
        place: String(entry.place || '').trim(),
        note: String(entry.note || '').trim().slice(0, NOTE_MAX_LENGTH)
      };
      if (validateCourseValues(values).length > 0) {
        skipped += 1;
        continue;
      }
      added.push(buildCourseRecord(values, { source: 'image', importBatchId: batchId, now: now }));
    }

    if (added.length === 0) {
      renderImportWarnings(['没有可导入的课程：请至少勾选一条，并补全课程名称与有效时间。']);
      return;
    }

    importState.phase = 'importing';
    importState.busy = true;

    var previous = state.courses;
    state.courses = previous.concat(added);

    var writeResult = writeStore(state.courses);
    var verified = false;
    if (writeResult.ok) {
      var reloaded = readStore();
      for (var v = 0; v < reloaded.courses.length; v += 1) {
        if (reloaded.courses[v].importBatchId === batchId) {
          verified = true;
          break;
        }
      }
    }

    if (!writeResult.ok || !verified) {
      // 回滚内存与界面：库里没有的东西，界面上也不许有
      state.courses = previous;
      importState.busy = false;
      importState.phase = 'reviewing';
      render();
      var reason = writeResult.ok
        ? '写入后回读校验失败（数据未真正落盘）'
        : '本地存储写入失败（可能空间已满或被禁用）';
      renderImportWarnings(['导入失败：' + reason + '，已回滚，本次没有写入任何课程。']);
      setImportStatus('导入失败，已回滚。');
      announce('导入失败，已回滚');
      return;
    }

    importState.busy = false;
    importState.phase = 'collecting';
    render();

    var origin = importState.origin;
    var trigger = importState.trigger;
    closeImport(false);
    if (origin === 'form' && formOverlayEl && formOverlayEl.classList.contains('is-open')) {
      // 数据已经入库：收起表单，并硬复位到「刚打开」的干净状态。
      // 这样下次打开不会带着上一次的草稿，也不可能把已入库的内容再提交一次
      //（editingId 由 closeForm 清空，字段与脏检查基线在此重置）。
      closeForm();
      resetFormForCreate();
      clearFieldErrors();
      updateNoteCounter();
      formSnapshot = JSON.stringify(readRawFormValues());
    } else {
      restoreFocusAfterDialog(trigger);
    }

    var text = '已导入 ' + added.length + ' 门课程';
    if (skipped > 0) {
      text += '，' + skipped + ' 条因信息不全被跳过';
    }
    showImportUndoToast(text, batchId, added.length);
    announce(text + '。10 秒内可撤销。');
  }

  /**
   * 导入成功后的整批撤销提示（10 秒窗口，比单条删除的 5 秒更宽）。
   * @param {string} text
   * @param {string} batchId
   * @param {number} count
   */
  function showImportUndoToast(text, batchId, count) {
    clearUndo();
    pendingUndo = { type: 'import-batch', batchId: batchId, count: count };
    showToast(text, {
      showUndo: true,
      timeoutMs: IMPORT_UNDO_TIMEOUT_MS,
      onTimeout: function () {
        pendingUndo = null;
      }
    });
  }

  /**
   * 按 importBatchId 整批撤销一次导入（写库，刷新后仍是撤销后状态）。
   */
  function undoImportBatch() {
    var batchId = pendingUndo && pendingUndo.batchId;
    if (!batchId) {
      return;
    }
    var previous = state.courses;
    var kept = [];
    var removed = 0;
    for (var i = 0; i < previous.length; i += 1) {
      if (previous[i].importBatchId === batchId) {
        removed += 1;
      } else {
        kept.push(previous[i]);
      }
    }
    if (removed === 0) {
      clearUndo();
      hideUndoToast();
      return;
    }
    state.courses = kept;
    if (!persistCourses()) {
      // 写库失败：把内存恢复成撤销前，保证「界面 = 库里」
      state.courses = previous;
      clearUndo();
      hideUndoToast();
      render();
      announce('撤销失败，课程仍然保留');
      return;
    }
    clearUndo();
    render();
    hideUndoToast();
    // 课程目录浮层若开着（10 秒内又打开的情况），行状态要跟着回退，
    // 否则会出现「库里已经没有了，行还写着已添加」的自相矛盾。
    if (catalogOverlayEl && catalogOverlayEl.classList.contains('is-open')) {
      syncCatalogAfterExternalChange();
      announce('已撤销本次导入，共 ' + removed + ' 门');
      // 焦点留在浮层里，不能还给已被遮住的顶栏按钮
      safeFocus(catalogSearchEl || catalogListEl);
      return;
    }
    announce('已撤销本次导入，共 ' + removed + ' 门');
    // 撤销后不能把焦点丢在 body 上（toast 里的按钮随即隐藏）
    safeFocus(btnCameraEl || btnAddEl);
  }

  /* ==================== 十七、课表互换 ==================== */

  /**
   * 本地存储当前是否可读（用于判断「课程真的不存在」还是「存储被禁用」）。
   * @return {boolean}
   */
  function isStorageReadable() {
    try {
      window.localStorage.getItem(STORAGE_KEY);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * 重新读取一份课程快照（互换校验一律基于这份新数据，不用闭包里的旧对象）。
   * 存储不可用时退回内存副本，避免把「存储被禁用」误判成「课程已不存在」。
   * @return {Array<Object>}
   */
  function readCoursesSnapshot() {
    if (!isStorageReadable()) {
      return state.courses;
    }
    var loaded = readStore();
    return loaded.courses;
  }

  /**
   * 在给定列表里按 id 查课程。
   * @param {Array<Object>} list
   * @param {string} courseId
   * @return {Object|null}
   */
  function findInList(list, courseId) {
    if (!Array.isArray(list)) {
      return null;
    }
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === courseId) {
        return list[i];
      }
    }
    return null;
  }

  /**
   * 位置文案："周三 08:30–10:00" / "周三 时间未设置"。
   * @param {Object} course
   * @return {string}
   */
  function formatPositionText(course) {
    var weekday = WEEKDAY_LABELS[clampWeekday(course.weekday) - 1];
    var range = formatTimeRange(course);
    return weekday + ' ' + (range || '时间未设置');
  }

  /**
   * 位置文案（带时长），用于互换确认框把两边时长都说清楚。
   * @param {Object} course
   * @return {string}
   */
  function formatPositionWithDuration(course) {
    var text = formatPositionText(course);
    var minutes = timeToMinutes(course.endTime) - timeToMinutes(course.startTime);
    if (minutes > 0) {
      text += '（' + minutes + ' 分钟）';
    }
    return text;
  }

  /**
   * 课程完整位置文案："高等数学 周三 08:30–10:00"。
   * @param {Object} course
   * @return {string}
   */
  function formatCoursePosition(course) {
    return String(course.name) + ' ' + formatPositionText(course);
  }

  /**
   * 位置三元组（星期 + 起止时间）。
   * @param {Object} course
   * @return {{weekday: number, startTime: string, endTime: string}}
   */
  function readPosition(course) {
    return {
      weekday: clampWeekday(course.weekday),
      startTime: normalizeTimeString(course.startTime),
      endTime: normalizeTimeString(course.endTime)
    };
  }

  /**
   * 两个位置是否完全相同。
   * @param {{weekday: number, startTime: string, endTime: string}} a
   * @param {{weekday: number, startTime: string, endTime: string}} b
   * @return {boolean}
   */
  function isSamePosition(a, b) {
    return a.weekday === b.weekday && a.startTime === b.startTime && a.endTime === b.endTime;
  }

  /**
   * 同步「互换」入口按钮的锁定态与模式态。
   * 课程少于 2 门时视觉上锁定（aria-disabled），但仍可点击——点击时给出明确中文提示。
   */
  function syncSwapButton() {
    if (!btnSwapEl) {
      return;
    }
    var locked = state.courses.length < SWAP_PICK_LIMIT;
    btnSwapEl.classList.toggle('is-locked', locked);
    btnSwapEl.classList.toggle('is-active', swapState.active);
    btnSwapEl.setAttribute('aria-disabled', locked ? 'true' : 'false');
    btnSwapEl.setAttribute('aria-pressed', swapState.active ? 'true' : 'false');
  }

  /**
   * 把「已消失」的已选条目从选择里剔除（防御：外部改库、跨标签页等）。
   */
  function pruneSwapPicks() {
    var kept = [];
    for (var i = 0; i < swapState.picked.length; i += 1) {
      if (findCourseById(swapState.picked[i])) {
        kept.push(swapState.picked[i]);
      }
    }
    swapState.picked = kept;
  }

  /**
   * 同步吸底操作条的文案与按钮可用性。
   */
  function syncSwapBar() {
    if (!swapBarEl) {
      return;
    }
    if (!swapState.active) {
      swapBarEl.hidden = true;
      syncSwapBarMetrics();
      return;
    }
    swapBarEl.hidden = false;

    var count = swapState.picked.length;
    var first = count > 0 ? findCourseById(swapState.picked[0]) : null;
    var second = count > 1 ? findCourseById(swapState.picked[1]) : null;

    var status = '已选 0/2 · 点选两门课程';
    if (count === 1) {
      status = '已选 1/2 · 再选一门';
    } else if (count >= SWAP_PICK_LIMIT) {
      status = '已选 2/2 · 确认后立即互换';
    }
    if (swapBarStatusEl) {
      swapBarStatusEl.textContent = status;
    }

    var detail = '';
    if (count === 1 && first) {
      detail = '已选：' + formatCoursePosition(first);
    } else if (count >= SWAP_PICK_LIMIT && first && second) {
      detail = formatCoursePosition(first) + ' ⇄ ' + formatCoursePosition(second);
    }
    if (swapBarDetailEl) {
      swapBarDetailEl.textContent = detail;
      swapBarDetailEl.hidden = !detail;
    }
    if (swapConfirmEl) {
      // 不设原生 disabled：原生 disabled 不派发 click，「只选 1 门点确认要有提示」就永远走不到。
      // 改用 aria-disabled + 视觉锁定，点击/Enter/Space 都能进入 handleSwapConfirm 的 guard 给出提示。
      var confirmLocked = count < SWAP_PICK_LIMIT || swapState.busy;
      swapConfirmEl.classList.toggle('is-locked', confirmLocked);
      swapConfirmEl.setAttribute('aria-disabled', confirmLocked ? 'true' : 'false');
      swapConfirmEl.textContent = swapState.busy ? '互换中…' : '确认互换';
    }
    // 操作条高度随文案行数变化（320px + 长课名时明细会折 3 行），
    // 兜底留白必须按实测高度来算，不能用写死的 px。
    syncSwapBarMetrics();
  }

  /**
   * 把操作条实测高度写进 CSS 变量 `--swap-bar-h`，
   * 供 body 的底部留白与 toast 的抬升位置使用（写死的 px 会在窄屏长课名下不够）。
   */
  function syncSwapBarMetrics() {
    if (!swapBarEl) {
      return;
    }
    if (!swapState.active || swapBarEl.hidden) {
      document.body.style.removeProperty('--swap-bar-h');
      return;
    }
    var height = swapBarEl.offsetHeight;
    if (height > 0) {
      document.body.style.setProperty('--swap-bar-h', Math.ceil(height) + 'px');
    }
  }

  /**
   * 互换相关的整体同步（每次全量渲染后调用）。
   */
  function updateSwapUi() {
    if (swapState.active) {
      pruneSwapPicks();
    }
    syncSwapButton();
    syncSwapBar();
  }

  /**
   * 当前焦点所在元素的课程 id（用于重渲染后把焦点放回同一门课）。
   * @return {string}
   */
  function readActiveCourseId() {
    var active = document.activeElement;
    if (!active || typeof active.closest !== 'function') {
      return '';
    }
    var owner = active.closest('[data-course-id]');
    return owner ? owner.getAttribute('data-course-id') || '' : '';
  }

  /**
   * 重渲染后把焦点放回同一门课对应的可点元素。
   * @param {string} courseId
   */
  function focusSwapCounterpart(courseId) {
    if (!courseId) {
      return;
    }
    var target = state.view === 'grid' ? findGridBlock(courseId) : findCardElement(courseId);
    if (!target) {
      target = state.view === 'grid' ? findCardElement(courseId) : findGridBlock(courseId);
    }
    if (target) {
      safeFocus(target);
    }
  }

  /**
   * 进入互换模式。课程不足时只提示，不切换模式。
   */
  function enterSwapMode() {
    if (swapState.active) {
      announce('已经在互换模式里，点选两门课程');
      return;
    }
    var total = state.courses.length;
    if (total === 0) {
      var emptyText = '还没有课程，先添加两门再互换';
      showInfoToast(emptyText);
      announce(emptyText);
      return;
    }
    if (total < SWAP_PICK_LIMIT) {
      var shortText = '至少需要两门课程才能互换';
      showInfoToast(shortText);
      announce(shortText);
      return;
    }

    swapState.active = true;
    swapState.picked = [];
    swapState.busy = false;
    document.body.setAttribute('data-swap', 'on');
    hideAssistant();
    render();
    announce('互换模式：已选 0/2，点选两门课程');
  }

  /**
   * 退出互换模式并清空选择。
   * @param {{restoreFocus?: boolean}} [options]
   */
  function exitSwapMode(options) {
    if (!swapState.active) {
      return;
    }
    var restoreFocus = !options || options.restoreFocus !== false;
    var courseId = readActiveCourseId();
    swapState.active = false;
    swapState.picked = [];
    swapState.busy = false;
    document.body.removeAttribute('data-swap');
    render();
    if (!restoreFocus) {
      return;
    }
    // 重渲染销毁了原来聚焦的课程元素：优先把焦点放回同一门课，否则回到互换入口
    if (courseId) {
      var counterpart =
        state.view === 'grid' ? findGridBlock(courseId) : findCardElement(courseId);
      if (counterpart) {
        safeFocus(counterpart);
        return;
      }
    }
    safeFocus(btnSwapEl);
  }

  /**
   * 重渲染并保持课表滚动位置 + 焦点（选点不应该让用户丢失位置）。
   * @param {string} courseId
   */
  function refreshSwapSelection(courseId) {
    var scrollLeft = timetableScrollEl ? timetableScrollEl.scrollLeft : 0;
    var scrollTop = timetableScrollEl ? timetableScrollEl.scrollTop : 0;
    render();
    if (timetableScrollEl) {
      timetableScrollEl.scrollLeft = scrollLeft;
      timetableScrollEl.scrollTop = scrollTop;
    }
    focusSwapCounterpart(courseId);
  }

  /**
   * 点选 / 取消选中一门课程。
   * @param {string} courseId
   */
  function toggleSwapPick(courseId) {
    if (!swapState.active || swapState.busy || !courseId) {
      return;
    }
    var course = findCourseById(courseId);
    if (!course) {
      var goneText = '这门课程已不存在，请重新选择';
      showInfoToast(goneText);
      announce(goneText);
      return;
    }

    var index = swapState.picked.indexOf(courseId);
    if (index >= 0) {
      // 重复点击已选条目 = 取消选择（不报错）
      swapState.picked.splice(index, 1);
      refreshSwapSelection(courseId);
      announce('已取消选择：' + course.name + '，已选 ' + swapState.picked.length + '/2');
      return;
    }
    if (swapState.picked.length >= SWAP_PICK_LIMIT) {
      var fullText = '已选两门课程，请先取消其中一门';
      showInfoToast(fullText);
      announce(fullText);
      return;
    }

    swapState.picked.push(courseId);
    refreshSwapSelection(courseId);
    if (swapState.picked.length === SWAP_PICK_LIMIT) {
      announce('已选择第 2 门：' + course.name + '，已选两门，可以确认互换');
    } else {
      announce('已选择第 1 门：' + course.name + '，还需选择 1 门');
    }
  }

  /**
   * 点击「确认互换」：二次确认后执行交换。含同步置忙守卫，连点只会执行一次。
   */
  function handleSwapConfirm() {
    if (!swapState.active || swapState.busy) {
      return;
    }
    var picked = swapState.picked;
    if (picked.length < SWAP_PICK_LIMIT) {
      var shortText = picked.length === 1 ? '还需再选一门课程' : '请先选择两门课程';
      showInfoToast(shortText);
      announce(shortText);
      return;
    }
    var idA = picked[0];
    var idB = picked[1];
    if (idA === idB) {
      var sameText = '同一门课程不能与自己互换';
      showInfoToast(sameText);
      announce(sameText);
      return;
    }

    var snapshot = readCoursesSnapshot();
    var courseA = findInList(snapshot, idA);
    var courseB = findInList(snapshot, idB);
    // 条目已失效（记录不存在 / 时间非法）就不要弹确认框了，直接给出明确提示
    if (!courseA || !courseB || !isSchedulable(courseA) || !isSchedulable(courseB)) {
      // 条目已失效：明确提示 + 清空选择 + 退出互换模式，日志同样记一条失败
      var reason = '所选课程已不存在或时间无效，请重新选择';
      var goneLogOk = appendSwapLog(idA, idB, courseA, courseB, 'failed', reason);
      exitSwapMode();
      showInfoToast(reason + (goneLogOk ? '' : '（日志未能保存）'));
      announce(reason + (goneLogOk ? '' : '（日志未能保存）'));
      return;
    }

    // 同步置忙：连点 3 次时后两次会在函数入口被挡掉，绝不会弹出第二个确认框
    swapState.busy = true;
    syncSwapBar();

    askConfirm({
      title: '确认互换',
      message:
        '将「' +
        courseA.name +
        '」（' +
        formatPositionWithDuration(courseA) +
        '）与「' +
        courseB.name +
        '」（' +
        formatPositionWithDuration(courseB) +
        '）互换位置？',
      confirmLabel: '互换',
      cancelLabel: '取消',
      danger: false
    }).then(function (confirmed) {
      if (!confirmed) {
        swapState.busy = false;
        syncSwapBar();
        if (swapConfirmEl) {
          safeFocus(swapConfirmEl);
        }
        return;
      }
      var status = performSwap(idA, idB);
      swapState.busy = false;
      syncSwapBar();
      if (status === SWAP_STATUS_SAME_POSITION && swapConfirmEl) {
        safeFocus(swapConfirmEl);
      }
    });
  }

  /**
   * 执行交换：重新读库校验 → 交换位置 → 一次写库 → 刷新视图 / 写日志。
   * @param {string} idA
   * @param {string} idB
   * @return {string} SWAP_STATUS_* 之一
   */
  function performSwap(idA, idB) {
    var snapshot = readCoursesSnapshot();
    var sourceA = findInList(snapshot, idA);
    var sourceB = findInList(snapshot, idB);

    var invalidReason = '';
    if (!sourceA || !sourceB) {
      invalidReason = '所选课程已不存在或时间无效，请重新选择';
    } else if (idA === idB) {
      invalidReason = '同一门课程不能与自己互换';
    } else if (!isSchedulable(sourceA) || !isSchedulable(sourceB)) {
      invalidReason = '所选课程已不存在或时间无效，请重新选择';
    }
    if (invalidReason) {
      var invalidLogOk = appendSwapLog(idA, idB, sourceA, sourceB, 'failed', invalidReason);
      var invalidText = invalidReason + (invalidLogOk ? '' : '（日志未能保存）');
      exitSwapMode();
      showInfoToast(invalidText);
      announce(invalidText);
      return SWAP_STATUS_INVALID;
    }

    var positionA = readPosition(sourceA);
    var positionB = readPosition(sourceB);
    if (isSamePosition(positionA, positionB)) {
      // 位置完全相同：不写库，只记一条失败日志
      var sameReason = '两门课程位置相同，无需互换';
      var sameLogOk = appendSwapLog(idA, idB, sourceA, sourceB, 'failed', sameReason);
      var sameText = sameReason + (sameLogOk ? '' : '（日志未能保存）');
      showInfoToast(sameText);
      announce(sameText);
      return SWAP_STATUS_SAME_POSITION;
    }

    var recordA = findCourseById(idA);
    var recordB = findCourseById(idB);
    if (!recordA || !recordB) {
      var lostReason = '所选课程已不存在或时间无效，请重新选择';
      var lostLogOk = appendSwapLog(idA, idB, sourceA, sourceB, 'failed', lostReason);
      var lostText = lostReason + (lostLogOk ? '' : '（日志未能保存）');
      exitSwapMode();
      showInfoToast(lostText);
      announce(lostText);
      return SWAP_STATUS_INVALID;
    }

    // 交换前的内存快照，写库失败时据此回滚
    var backupA = {
      weekday: recordA.weekday,
      startTime: recordA.startTime,
      endTime: recordA.endTime,
      updatedAt: recordA.updatedAt
    };
    var backupB = {
      weekday: recordB.weekday,
      startTime: recordB.startTime,
      endTime: recordB.endTime,
      updatedAt: recordB.updatedAt
    };

    var now = Date.now();
    // 整体对调位置（含时长不同的情况），其余字段跟着课程自己走
    recordA.weekday = positionB.weekday;
    recordA.startTime = positionB.startTime;
    recordA.endTime = positionB.endTime;
    recordA.updatedAt = now;

    recordB.weekday = positionA.weekday;
    recordB.startTime = positionA.startTime;
    recordB.endTime = positionA.endTime;
    recordB.updatedAt = now;

    // 一次写库（绝不写两次）
    var writeResult = writeStore(state.courses);
    if (!writeResult.ok) {
      recordA.weekday = backupA.weekday;
      recordA.startTime = backupA.startTime;
      recordA.endTime = backupA.endTime;
      recordA.updatedAt = backupA.updatedAt;
      recordB.weekday = backupB.weekday;
      recordB.startTime = backupB.startTime;
      recordB.endTime = backupB.endTime;
      recordB.updatedAt = backupB.updatedAt;
      render();
      var failLogOk = appendSwapLog(idA, idB, sourceA, sourceB, 'failed', '写库失败');
      var failText = '保存失败，已恢复原课表' + (failLogOk ? '' : '（日志未能保存）');
      showInfoToast(failText);
      announce(failText);
      // 保持互换模式与已选状态，用户可以直接重试
      if (swapConfirmEl) {
        safeFocus(swapConfirmEl);
      }
      return SWAP_STATUS_WRITE_FAILED;
    }

    var successLogOk = appendSwapLog(idA, idB, sourceA, sourceB, 'success', '');
    render();
    exitSwapMode();
    // 位置变了，上一次「继续添加」的推荐时段可能已经失效，直接收起提示条
    hideAssistant();
    var successText =
      '已互换：' + sourceA.name + ' ⇄ ' + sourceB.name + (successLogOk ? '' : '（日志未能保存）');
    showInfoToast(successText);
    announce(successText);
    return SWAP_STATUS_SUCCESS;
  }

  /* ==================== 十八、工作日志 ==================== */

  /**
   * 取日志模块（swap-log.js）。
   * @return {Object|null}
   */
  function getLogApi() {
    return window.CourseSwapLog || null;
  }

  /**
   * 组装日志里的「涉及对象」：优先用 store 快照，其次内存副本，最后用占位名。
   * @param {string} idA
   * @param {string} idB
   * @param {Object|null} sourceA
   * @param {Object|null} sourceB
   * @return {Array<Object>}
   */
  function buildLogTargets(idA, idB, sourceA, sourceB) {
    var ids = [idA, idB];
    var sources = [sourceA, sourceB];
    var targets = [];
    for (var i = 0; i < ids.length; i += 1) {
      var source = sources[i] || findCourseById(ids[i]);
      if (source) {
        targets.push({
          id: ids[i],
          name: String(source.name),
          weekday: clampWeekday(source.weekday),
          startTime: normalizeTimeString(source.startTime),
          endTime: normalizeTimeString(source.endTime)
        });
      } else {
        targets.push({
          id: ids[i],
          name: '（已删除的课程）',
          weekday: 0,
          startTime: '',
          endTime: ''
        });
      }
    }
    return targets;
  }

  /**
   * 追加一条互换日志。日志失败绝不影响互换结果，只回传 false 供 toast 追加提示。
   * @param {string} idA
   * @param {string} idB
   * @param {Object|null} sourceA
   * @param {Object|null} sourceB
   * @param {'success'|'failed'} result
   * @param {string} reason
   * @return {boolean} 是否写入成功
   */
  function appendSwapLog(idA, idB, sourceA, sourceB, result, reason) {
    var api = getLogApi();
    if (!api || typeof api.append !== 'function') {
      return false;
    }
    try {
      var res = api.append({
        id: createId(),
        at: Date.now(),
        action: 'swap',
        title: '互换课程位置',
        targets: buildLogTargets(idA, idB, sourceA, sourceB),
        result: result,
        reason: reason || ''
      });
      return Boolean(res && res.ok);
    } catch (err) {
      return false;
    }
  }

  /**
   * 打开工作日志浮层。
   * @param {HTMLElement|null} trigger
   */
  function openLog(trigger) {
    if (!logOverlayEl || logOverlayEl.classList.contains('is-open')) {
      return;
    }
    logTrigger = trigger || null;
    renderLogSheet();
    showOverlay(logOverlayEl);
    pushDialog(logSheetEl, function () {
      closeLog(true);
    });
    lockBodyScroll();
    logOpenedAt = Date.now();
    window.setTimeout(
      function () {
        if (!logOverlayEl.classList.contains('is-open')) {
          return;
        }
        safeFocus(logCloseEl || logDoneEl);
      },
      prefersReducedMotion() ? 0 : 60
    );
  }

  /**
   * 关闭工作日志浮层。
   * @param {boolean} restoreFocus
   */
  function closeLog(restoreFocus) {
    if (!logOverlayEl || logOverlayEl.hidden) {
      return;
    }
    popDialog(logSheetEl);
    hideOverlay(logOverlayEl);
    unlockBodyScroll();
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    var trigger = logTrigger;
    logTrigger = null;
    if (restoreFocus) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * 渲染日志浮层内容（分组 + 每条记录 + 空状态）。
   */
  function renderLogSheet() {
    if (!logGroupsEl) {
      return;
    }
    logGroupsEl.textContent = '';
    var api = getLogApi();
    var result =
      api && typeof api.read === 'function'
        ? api.read()
        : { entries: [], notice: '工作日志模块未能加载，暂时无法读取记录。', corrupt: false };
    var entries = result && Array.isArray(result.entries) ? result.entries : [];

    if (logCountEl) {
      logCountEl.textContent = '共 ' + entries.length + ' 条记录';
    }
    if (logNoticeEl) {
      if (result && result.notice) {
        logNoticeEl.textContent = result.notice;
        logNoticeEl.hidden = false;
      } else {
        logNoticeEl.textContent = '';
        logNoticeEl.hidden = true;
      }
    }
    if (logEmptyEl) {
      logEmptyEl.hidden = entries.length > 0;
    }
    if (logClearEl) {
      logClearEl.disabled = entries.length === 0;
    }
    if (entries.length === 0) {
      return;
    }

    var groups =
      api && typeof api.groupByDay === 'function' ? api.groupByDay(entries) : [];
    for (var i = 0; i < groups.length; i += 1) {
      logGroupsEl.appendChild(createLogGroup(groups[i], api));
    }
  }

  /**
   * 渲染一个日期分组（组标题样式与课表星期标题一致）。
   * @param {{key: string, label: string, items: Array<Object>}} group
   * @param {Object|null} api
   * @return {HTMLElement}
   */
  function createLogGroup(group, api) {
    var section = createEl('section', 'group');
    var header = createEl('div', 'group__header');
    header.appendChild(createEl('h3', 'group__title', String(group.label || '')));
    header.appendChild(
      createEl('span', 'group__count', String(group.items ? group.items.length : 0) + ' 条')
    );
    section.appendChild(header);

    var list = createEl('ul', 'log-list');
    var items = group.items || [];
    for (var i = 0; i < items.length; i += 1) {
      list.appendChild(createLogItem(items[i], api));
    }
    section.appendChild(list);
    return section;
  }

  /**
   * 渲染一条日志：时间 + 互换图标 + 摘要 + 结果徽标（失败附原因）。
   * @param {Object} entry
   * @param {Object|null} api
   * @return {HTMLLIElement}
   */
  function createLogItem(entry, api) {
    var failed = entry && entry.result === 'failed';
    var item = createEl('li', 'log-item');
    item.setAttribute('data-result', failed ? 'failed' : 'success');

    var head = createEl('div', 'log-item__head');
    var clock =
      api && typeof api.formatClock === 'function' ? api.formatClock(entry && entry.at) : '';
    head.appendChild(createEl('span', 'log-item__time', clock));
    head.appendChild(createIcon('icon-swap'));
    head.appendChild(createEl('span', 'log-item__title', String((entry && entry.title) || '互换课程位置')));
    head.appendChild(createEl('span', 'log-badge', failed ? '失败' : '成功'));
    item.appendChild(head);

    var summary =
      api && typeof api.formatEntrySummary === 'function'
        ? api.formatEntrySummary(entry)
        : '（无涉及对象）';
    item.appendChild(createEl('p', 'log-item__summary', summary));

    if (failed && entry.reason) {
      item.appendChild(createEl('p', 'log-item__reason', '原因：' + entry.reason));
    }
    return item;
  }

  /**
   * 清空日志（二次确认）。
   */
  function requestClearLog() {
    var api = getLogApi();
    if (!api || typeof api.clear !== 'function') {
      var missingText = '工作日志模块未能加载，暂时无法清空';
      showInfoToast(missingText);
      announce(missingText);
      return;
    }
    var current = typeof api.read === 'function' ? api.read() : { entries: [] };
    var count = current && Array.isArray(current.entries) ? current.entries.length : 0;
    if (count === 0) {
      var emptyText = '还没有日志可以清空';
      showInfoToast(emptyText);
      announce(emptyText);
      return;
    }

    askConfirm({
      title: '清空工作日志',
      message: '将删除全部 ' + count + ' 条记录，清空后无法恢复。',
      confirmLabel: '清空',
      cancelLabel: '取消',
      danger: true
    }).then(function (confirmed) {
      if (!confirmed) {
        if (logClearEl && !logClearEl.disabled) {
          safeFocus(logClearEl);
        }
        return;
      }
      var cleared = api.clear();
      renderLogSheet();
      var text = cleared && cleared.ok ? '工作日志已清空' : (cleared && cleared.notice) || '工作日志清空失败';
      showInfoToast(text);
      announce(text);
      // 清空后「清空日志」变为 disabled，不能再把焦点交给它
      if (logClearEl && !logClearEl.disabled) {
        safeFocus(logClearEl);
      } else if (logDoneEl) {
        safeFocus(logDoneEl);
      }
    });
  }

  /* ==================== 十八·A、顶栏高度实测（吸顶基准） ==================== */

  /** 上一次写入的顶栏高度（避免每次量都写样式） */
  var lastHeaderHeight = 0;
  /** .app-header 的尺寸观察器 */
  var headerObserver = null;

  /**
   * 把顶栏实测高度写进 CSS 变量 `--header-h`，供分组头 `position:sticky` 使用。
   * 不硬编码 120px：字号 / 缩放 / 安全区变化都会让真实高度漂移，
   * 硬编码会让吸顶的组头被顶栏盖住或漏出一条缝。
   */
  function syncHeaderVars() {
    var header = document.querySelector('.app-header');
    if (!header) {
      return;
    }
    var height = Math.round(header.getBoundingClientRect().height);
    if (!(height > 0) || height === lastHeaderHeight) {
      return;
    }
    lastHeaderHeight = height;
    document.documentElement.style.setProperty('--header-h', height + 'px');
  }

  /**
   * 启动顶栏高度观察：优先 ResizeObserver，缺省降级为 window.resize。
   */
  function initHeaderObserver() {
    var header = document.querySelector('.app-header');
    if (!header) {
      return;
    }
    if (typeof window.ResizeObserver === 'function') {
      try {
        headerObserver = new window.ResizeObserver(function () {
          syncHeaderVars();
        });
        headerObserver.observe(header);
      } catch (err) {
        headerObserver = null;
      }
    }
    if (!headerObserver) {
      window.addEventListener('resize', syncHeaderVars);
    }
    syncHeaderVars();
  }

  /* ==================== 十八·B、日期条（任务栏目） ==================== */

  /**
   * 同步日期条的显隐与取值（任务 / 旅游共用一个控件，靠栏目切语义）。
   *
   * 尾部只有一个按钮槽位：任务显示「今天」，旅游显示「全部」。
   * 320px 只容得下 44×3 + 输入框一段（再多的 44px 会溢出），所以两者互斥。
   */
  function syncDateBar() {
    if (!dateBarEl) {
      return;
    }
    var isTrips = state.view === 'trips';
    var visible = state.view === 'tasks' || isTrips;
    dateBarEl.hidden = !visible;
    if (!visible) {
      return;
    }
    var date = isTrips ? state.tripsDate : state.tasksDate;
    if (dateInputEl) {
      if (dateInputEl.value !== date) {
        // 旅游的 '' = 全部，要真的清空输入框（而不是留着上一次的日期）
        dateInputEl.value = date;
      }
      dateInputEl.setAttribute(
        'aria-label',
        isTrips ? '选择行程日期，留空显示全部' : '选择任务日期'
      );
    }
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    if (dateTodayEl) {
      // 任务：非今天才有意义；旅游：只有在"全部"(空)时才出现，用来跳到今天
      dateTodayEl.hidden = isTrips ? Boolean(date) : !today || date === today;
    }
    if (dateClearEl) {
      // 旅游：一旦选了具体日期就提供"回到全部"
      dateClearEl.hidden = !(isTrips && Boolean(date));
    }
    dateBarEl.setAttribute('aria-label', isTrips ? '按日期筛选行程' : '选择任务日期');
  }

  /**
   * 切换任务栏目选中的日期（并持久化到 sections:v1 的 dates.tasks）。
   * @param {string} nextDate
   */
  function setTasksDate(nextDate) {
    var normalized =
      typeof SEC.normalizeDateString === 'function' ? SEC.normalizeDateString(nextDate) : '';
    if (!normalized) {
      // 空 / 非法（例如用户清空了 input）：忽略并回写原值，绝不把筛选主键置空
      syncDateBar();
      return;
    }
    if (normalized === state.tasksDate) {
      syncDateBar();
      return;
    }
    state.tasksDate = normalized;
    persistSectionConfig({ dates: { tasks: normalized } });
    render();
    announceTasksDate(normalized);
    // render() 重建了列表，焦点若原本在行上会掉到 BODY
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      safeFocus(dateInputEl || datePrevEl);
    }
  }

  /**
   * 切换旅游栏目的日期筛选（`''` = 全部，是合法值）。
   * @param {string} nextDate
   */
  function setTripsDate(nextDate) {
    var raw = typeof nextDate === 'string' ? nextDate.trim() : '';
    var normalized = raw
      ? typeof SEC.normalizeDateString === 'function'
        ? SEC.normalizeDateString(raw)
        : ''
      : '';
    if (raw && !normalized) {
      // 非空但非法（例如 0000-01-01）：忽略并回写原值
      syncDateBar();
      return;
    }
    if (normalized === state.tripsDate) {
      syncDateBar();
      return;
    }
    state.tripsDate = normalized;
    persistSectionConfig({ dates: { trips: normalized } });
    render();
    announceTripsDate(normalized);
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      safeFocus(dateInputEl || datePrevEl);
    }
  }

  /**
   * 播报当前日期与条数（读屏用户切换日期后需要确认落在哪一天）。
   * @param {string} date
   */
  function announceTasksDate(date) {
    var list =
      typeof SEC.filterTasksByDate === 'function' ? SEC.filterTasksByDate(state.tasks, date) : [];
    var label = typeof SEC.formatDateLabel === 'function' ? SEC.formatDateLabel(date) : date;
    var weekday = typeof SEC.weekdayCn === 'function' ? SEC.weekdayCn(date) : '';
    announce('已切换到 ' + label + '，' + weekday + '，共 ' + list.length + ' 项');
  }

  /**
   * 播报旅游栏目的筛选结果。
   * @param {string} date 空串 = 全部
   */
  function announceTripsDate(date) {
    if (!date) {
      announce('已显示全部行程，共 ' + state.trips.length + ' 个');
      return;
    }
    var list =
      typeof SEC.filterTripsByDate === 'function'
        ? SEC.filterTripsByDate(state.trips, date)
        : [];
    var label = typeof SEC.formatDateLabel === 'function' ? SEC.formatDateLabel(date) : date;
    var weekday = typeof SEC.weekdayCn === 'function' ? SEC.weekdayCn(date) : '';
    announce('仅显示 ' + label + ' ' + weekday + ' 的行程，共 ' + list.length + ' 个');
  }

  /**
   * 前一天 / 后一天：按当前栏目分派。
   * 旅游在「全部」状态下以今天为基准跳一天（否则没有可加减的锚点）。
   * @param {number} delta
   */
  function shiftCurrentDate(delta) {
    if (typeof SEC.shiftDate !== 'function') {
      return;
    }
    var isTrips = state.view === 'trips';
    var base = (isTrips ? state.tripsDate : state.tasksDate) ||
      (typeof SEC.todayString === 'function' ? SEC.todayString() : '');
    var next = SEC.shiftDate(base, delta);
    if (isTrips) {
      setTripsDate(next);
    } else {
      setTasksDate(next);
    }
  }

  /**
   * 回到今天（任务）/ 筛选到今天（旅游）。
   */
  function goCurrentToday() {
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    if (!today) {
      return;
    }
    if (state.view === 'trips') {
      setTripsDate(today);
      return;
    }
    setTasksDate(today);
  }

  /**
   * 清空日期筛选（仅旅游）：回到「全部」。任务必须有日期，故不提供。
   */
  function clearCurrentDateFilter() {
    if (state.view !== 'trips') {
      return;
    }
    setTripsDate('');
  }

  /**
   * 日期输入框的 change：按当前栏目写回。
   * 旅游把空值当「全部」，任务把空值当"非法输入、忽略"。
   */
  function handleDateInputChange() {
    if (!dateInputEl) {
      return;
    }
    if (state.view === 'trips') {
      setTripsDate(dateInputEl.value);
      return;
    }
    setTasksDate(dateInputEl.value);
  }

  /* ==================== 十八·C、任务列表渲染 ==================== */

  /**
   * 渲染当日任务列表（分组 → 行）。
   * 只渲染非空分组；已完成独立成组并置末（由 sections.groupTasks 保证顺序）。
   */
  function renderTasks() {
    if (tasksViewEl) {
      tasksViewEl.hidden = state.view !== 'tasks';
    }
    if (tripsViewEl) {
      tripsViewEl.hidden = true;
    }
    if (!tasksListEl) {
      return;
    }
    tasksListEl.textContent = '';

    var dayTasks =
      typeof SEC.filterTasksByDate === 'function'
        ? SEC.filterTasksByDate(state.tasks, state.tasksDate)
        : [];
    var groups = typeof SEC.groupTasks === 'function' ? SEC.groupTasks(dayTasks) : [];
    var cfg = getViewConfig('tasks');

    updateTasksEmptyState(dayTasks.length === 0);

    if (groups.length === 0) {
      tasksListEl.hidden = true;
      return;
    }

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < groups.length; i += 1) {
      fragment.appendChild(createSectionGroup(groups[i], 'tasks', cfg, ''));
    }
    tasksListEl.appendChild(fragment);
    tasksListEl.hidden = false;
  }

  /**
   * 旅游栏目：按出发月份分组 + 末尾「想法清单」+ 日期区间筛选。
   *
   * 筛选语义（`SEC.filterTripsForView`）：日期为空 = 全部；否则只留区间覆盖该天的行程，
   * 但 `idea`（想法）恒保留——想法没有确定日期，不该因为选了某天就消失。
   * 筛选态下组头会追加「不随日期筛选」小字，避免用户误以为想法也被筛过。
   */
  function renderTrips() {
    if (tasksViewEl) {
      tasksViewEl.hidden = true;
    }
    if (tripsViewEl) {
      tripsViewEl.hidden = state.view !== 'trips';
    }
    if (!tripsListEl) {
      return;
    }
    tripsListEl.textContent = '';

    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    var list =
      typeof SEC.filterTripsForView === 'function'
        ? SEC.filterTripsForView(state.trips, state.tripsDate)
        : state.trips;
    var groups =
      typeof SEC.groupTrips === 'function' ? SEC.groupTrips(list, today) : [];
    var cfg = getViewConfig('trips');

    updateTripsEmptyState(groups.length === 0);

    if (groups.length === 0) {
      tripsListEl.hidden = true;
      return;
    }

    var filtered = Boolean(state.tripsDate);
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < groups.length; i += 1) {
      var note = filtered && groups[i].key === 'idea' ? '不随日期筛选' : '';
      fragment.appendChild(createSectionGroup(groups[i], 'trips', cfg, note));
    }
    tripsListEl.appendChild(fragment);
    tripsListEl.hidden = false;
  }

  /**
   * 空状态文案：今天与非今天要说不同的话（非今天必须带完整日期，不能复用"今天"）。
   * @param {boolean} isEmpty
   */
  function updateTasksEmptyState(isEmpty) {
    if (!tasksEmptyEl) {
      return;
    }
    tasksEmptyEl.hidden = !isEmpty;
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    var isToday = state.tasksDate === today;
    // 文案无论是否可见都同步一遍：避免「切回有数据的日期后，空状态里还留着上一天的日期」
    if (tasksEmptyTitleEl) {
      tasksEmptyTitleEl.textContent = isToday
        ? '今天还没有任务'
        : (typeof SEC.formatDateFullCn === 'function'
            ? SEC.formatDateFullCn(state.tasksDate)
            : state.tasksDate) + '没有任务';
    }
    if (tasksEmptyDescEl) {
      tasksEmptyDescEl.textContent = isToday
        ? '点右上角「添加任务」，或用上方日期条切换到其他日期。'
        : '这一天还没有安排。点右上角「添加任务」补一条，或用上方日期条切换日期。';
    }
  }

  /**
   * 旅游栏目的空状态。两种情形说两种话：
   *   全局为空 → 引导添加第一个行程；
   *   筛选后为空 → 说清"这一天没有任何行程覆盖它"，并提醒想法清单不参与筛选。
   * @param {boolean} isEmpty
   */
  function updateTripsEmptyState(isEmpty) {
    if (!tripsEmptyEl) {
      return;
    }
    tripsEmptyEl.hidden = !isEmpty;
    var noTrips = state.trips.length === 0;
    var date = state.tripsDate;
    if (tripsEmptyTitleEl) {
      if (noTrips) {
        tripsEmptyTitleEl.textContent = '还没有行程';
      } else if (date) {
        // 与副标题「仅显示该日行程」同词（原来写"没有在途行程"，"在途"容易被读成交通中）
        tripsEmptyTitleEl.textContent =
          (typeof SEC.formatDateFullCn === 'function' ? SEC.formatDateFullCn(date) : date) +
          '没有行程';
      } else {
        tripsEmptyTitleEl.textContent = '还没有行程';
      }
    }
    if (tripsEmptyDescEl) {
      if (noTrips) {
        tripsEmptyDescEl.textContent =
          '点右上角「添加行程」，按出发月份自动归档；还没定下来的，可以先记成「想法」，日期之后再定。';
      } else {
        tripsEmptyDescEl.textContent =
          '这一天没有任何行程的日期区间覆盖它。想法清单不参与日期筛选，点「全部」可以看到全部行程。';
      }
    }
    if (tripsEmptyAddLabelEl) {
      tripsEmptyAddLabelEl.textContent = noTrips ? '添加第一个行程' : '添加行程';
    }
    if (tripsEmptyHintEl) {
      tripsEmptyHintEl.textContent = noTrips
        ? '行程数据只保存在这台设备上。'
        : '点右上角「添加行程」可以补一条新的；目的地与备注都是选填。';
    }
  }

  /**
   * 创建一个吸顶分组（与清单视图同一套 .group / .group__header / .group__title /
   * .group__count 类名，只多一个 sticky 修饰类）。
   *
   * 关掉「分组标题」时不渲染组头，但 `<section>` 必须改用 `aria-label` 保住分组语义
   * （否则读屏只听到一串孤立的行，不知道它们属于哪一组）。
   * @param {{key: string, label: string, items: Array<Object>, ended?: boolean}} group
   * @param {'tasks'|'trips'} kind
   * @param {Object} cfg 该栏目的显示配置
   * @param {string} [note] 组头右侧的小字提示（例如"不随日期筛选"）
   * @return {HTMLElement}
   */
  function createSectionGroup(group, kind, cfg, note) {
    var config = cfg || getViewConfig(kind === 'trips' ? 'trips' : 'tasks');
    var section = createEl('section', 'group');
    var titleId = 'section-group-' + kind + '-' + group.key;
    var label = String(group.label || '');
    // 分组自己也带一份 data-layout：双列时组头的左右内边距要归零，
    // 才能和两侧的单元左边缘对齐（见 styles.css）
    section.setAttribute('data-layout', config.layout === LAYOUT_COLUMN ? 'column' : 'row');

    if (config.showGroupTitle === false) {
      section.setAttribute('aria-label', label);
    } else {
      section.setAttribute('aria-labelledby', titleId);
      var header = createEl('div', 'group__header group__header--sticky');
      var title = createEl('h2', 'group__title', label);
      title.id = titleId;
      header.appendChild(title);
      if (group.ended) {
        header.appendChild(createEl('span', 'badge badge--muted', '已结束'));
      }
      if (note) {
        header.appendChild(createEl('span', 'group__note', note));
      }
      header.appendChild(
        createEl(
          'span',
          'group__count',
          group.items.length + (kind === 'tasks' ? ' 项' : ' 个行程')
        )
      );
      section.appendChild(header);
    }

    var list = createEl('ul', 'section-list');
    applySectionListConfig(list, config);
    for (var i = 0; i < group.items.length; i += 1) {
      list.appendChild(
        kind === 'tasks'
          ? createTaskRow(group.items[i], config)
          : createTripRow(group.items[i], config)
      );
    }
    section.appendChild(list);
    return section;
  }

  /**
   * 创建一行任务。
   *
   * 结构（严格按设计 §5.5，**不允许嵌套可交互元素**，故用并列兄弟节点）：
   *   <li class="row">
   *     <button class="row__main">头像 + 文案 + 右列</button>   ← 整行点开编辑浮层
   *     <button class="row__check" role="checkbox">           ← 命中区 44×44
   *   </li>
   * 行内不放编辑 / 删除按钮：删除只在编辑浮层的 footer（与微信一致，少一个误触热区）。
   * @param {Object} task
   * @param {Object} [cfg] 显示配置（关掉的头像 / 副标题 / 右列**不创建节点**，不留空洞）
   * @return {HTMLLIElement}
   */
  function createTaskRow(task, cfg) {
    var config = cfg || getViewConfig('tasks');
    var row = createEl('li', 'row');
    row.setAttribute('data-task-id', task.id);
    if (task.done) {
      row.classList.add('is-done');
    }

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'row__main';
    main.setAttribute('data-action', 'edit-task');
    main.setAttribute('aria-label', buildTaskRowAria(task, config));

    if (config.showAvatar !== false) {
      // 头像：首字 + 按标题派生的颜色（与课程同一套 8 色 token）
      var avatar = createEl('span', 'row-avatar', firstChar(task.title));
      avatar.setAttribute('aria-hidden', 'true');
      avatar.setAttribute('data-color', deriveCourseColor(task.title));
      main.appendChild(avatar);
    }

    var body = createEl('span', 'row__body');
    body.appendChild(createEl('span', 'row__title', task.title));
    var sub = config.showMeta === false ? '' : typeof task.note === 'string' ? task.note.trim() : '';
    if (sub) {
      body.appendChild(createEl('span', 'row__sub', sub));
    }
    main.appendChild(body);

    if (config.showSide !== false) {
      var side = createEl('span', 'row__side');
      if (!task.done && task.remindMinutes !== null && task.remindMinutes !== undefined) {
        // 设了提醒的任务在行里可见，否则只能进编辑表单才知道
        var bell = createIcon('icon-bell');
        bell.classList.add('row__bell');
        bell.setAttribute('aria-hidden', 'true');
        side.appendChild(bell);
      }
      var sideText =
        typeof SEC.formatTaskSide === 'function' ? SEC.formatTaskSide(task) : '';
      side.appendChild(createEl('span', 'row__side-text', sideText));
      main.appendChild(side);
    }

    row.appendChild(main);

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'row__check';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', task.done ? 'true' : 'false');
    check.setAttribute(
      'aria-label',
      (task.done ? '取消完成：' : '标记完成：') + task.title
    );
    check.setAttribute('data-action', 'toggle-task');
    check.appendChild(createIcon('icon-check'));
    row.appendChild(check);

    return row;
  }

  /**
   * 创建一行行程。行程没有完成勾选（§5.5：勾选框仅任务），
   * 因此整行只有 `.row__main` 一个可交互元素，删除入口在编辑浮层 footer。
   * @param {Object} trip
   * @param {Object} [cfg]
   * @return {HTMLLIElement}
   */
  function createTripRow(trip, cfg) {
    var config = cfg || getViewConfig('trips');
    var row = createEl('li', 'row row--trip');
    row.setAttribute('data-trip-id', trip.id);

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'row__main';
    main.setAttribute('data-action', 'edit-trip');
    main.setAttribute('aria-label', buildTripRowAria(trip, config));

    if (config.showAvatar !== false) {
      var avatar = createEl('span', 'row-avatar', firstChar(trip.title));
      avatar.setAttribute('aria-hidden', 'true');
      avatar.setAttribute('data-color', deriveCourseColor(trip.title));
      main.appendChild(avatar);
    }

    var body = createEl('span', 'row__body');
    body.appendChild(createEl('span', 'row__title', trip.title));
    var sub =
      config.showMeta === false
        ? ''
        : typeof SEC.formatTripSub === 'function'
          ? SEC.formatTripSub(trip)
          : '';
    if (sub) {
      body.appendChild(createEl('span', 'row__sub', sub));
    }
    main.appendChild(body);

    if (config.showSide !== false) {
      var sideText =
        typeof SEC.formatTripSide === 'function'
          ? SEC.formatTripSide(trip, typeof SEC.todayString === 'function' ? SEC.todayString() : '')
          : '';
      main.appendChild(createEl('span', 'row__side', sideText));
    }

    row.appendChild(main);
    return row;
  }

  /**
   * 任务行的无障碍标签：标题 + 时间 + 完成态 + 动作。
   * @param {Object} task
   * @param {Object} [cfg]
   * @return {string}
   */
  function buildTaskRowAria(task, cfg) {
    var parts = [task.title];
    var range = typeof SEC.formatTaskTimeRange === 'function' ? SEC.formatTaskTimeRange(task) : '';
    if (range) {
      parts.push(range);
    }
    var note = typeof task.note === 'string' ? task.note.trim() : '';
    if (note && (!cfg || cfg.showMeta !== false)) {
      parts.push(note);
    }
    parts.push(task.done ? '已完成' : '未完成');
    parts.push('打开编辑');
    return parts.join('，');
  }

  /**
   * 行程行的无障碍标签：标题 + 目的地 + 日期区间 + 状态 + 动作。
   * 关掉某列后，标签仍然把信息念全（视觉收起只是取舍，不该丢信息）。
   * @param {Object} trip
   * @param {Object} [cfg]
   * @return {string}
   */
  function buildTripRowAria(trip, cfg) {
    var parts = [trip.title];
    var dest = typeof SEC.formatTripSub === 'function' ? SEC.formatTripSub(trip) : '';
    if (dest && (!cfg || cfg.showMeta !== false)) {
      parts.push(dest);
    }
    var range = typeof SEC.formatTripRange === 'function' ? SEC.formatTripRange(trip) : '';
    if (range) {
      parts.push(range);
    }
    var status =
      typeof SEC.formatTripSide === 'function'
        ? SEC.formatTripSide(trip, typeof SEC.todayString === 'function' ? SEC.todayString() : '')
        : '';
    if (status) {
      parts.push(status);
    }
    parts.push('打开编辑');
    return parts.join('，');
  }

  /* ==================== 十八·D、任务增删改（勾选 / 删除 / 撤销） ==================== */

  /**
   * 切换完成态：立即写库 + announce，**不弹 toast**（勾选是高频动作，toast 会盖住列表）。
   * @param {string} taskId
   */
  function toggleTaskDone(taskId) {
    var task = findTaskById(taskId);
    if (!task) {
      return;
    }
    var next = !task.done;
    var now = Date.now();
    task.done = next;
    task.doneAt = next ? now : null;
    task.updatedAt = now;

    var saved = persistTasks();
    render();

    // 重渲染后焦点必须跟着回到这一行的勾选框（不能落到 BODY）
    var row = findTaskRow(taskId);
    if (row) {
      var check = row.querySelector('.row__check');
      if (check) {
        safeFocus(check);
      }
      row.classList.add('is-new');
      window.setTimeout(function () {
        row.classList.remove('is-new');
      }, 900);
    } else {
      safeFocus(btnAddEl);
    }
    announce((next ? '已完成：' : '已取消完成：') + task.title + (saved ? '' : '（未能保存到本地）'));
  }

  /**
   * 记录一行在渲染结果里的序号（删除后据此把焦点落到相邻行）。
   * @param {string} taskId
   * @return {number} 找不到返回 -1
   */
  function taskRowIndexOf(taskId) {
    if (!tasksListEl) {
      return -1;
    }
    var rows = tasksListEl.querySelectorAll('.row[data-task-id]');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute('data-task-id') === taskId) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 删除一条任务（写库 + 5 秒撤销）。
   * @param {string} taskId
   */
  function removeTask(taskId) {
    var index = taskIndexOf(taskId);
    if (index === -1) {
      return;
    }
    var rowIndex = taskRowIndexOf(taskId);
    var removed = state.tasks.splice(index, 1)[0];
    var saved = persistTasks();
    render();
    announce('已删除任务：' + removed.title + (saved ? '' : '（未能保存到本地）'));
    focusAfterTaskDelete(rowIndex);
    showTaskUndoToast(removed, index);
  }

  /**
   * 删除后聚焦：同位置的下一行 → 上一行 → 顶部新增按钮。
   * @param {number} rowIndex 删除前该行的渲染序号
   */
  function focusAfterTaskDelete(rowIndex) {
    if (tasksListEl) {
      var rows = tasksListEl.querySelectorAll('.row[data-task-id]');
      if (rows.length > 0) {
        var targetIndex = Math.min(Math.max(rowIndex, 0), rows.length - 1);
        var main = rows[targetIndex].querySelector('.row__main');
        if (main) {
          safeFocus(main);
          return;
        }
      }
    }
    safeFocus(btnAddEl);
  }

  /**
   * 显示任务删除的撤销提示（5 秒）——沿用同一个单槽位 toast。
   * @param {Object} task
   * @param {number} index 在 state.tasks 里的原位置
   */
  function showTaskUndoToast(task, index) {
    clearUndo();
    pendingUndo = { type: 'task-delete', task: task, index: index };
    showToast('已删除「' + task.title + '」', {
      showUndo: true,
      timeoutMs: UNDO_TIMEOUT_MS,
      onTimeout: function () {
        pendingUndo = null;
      }
    });
  }

  /**
   * 撤销任务删除：放回原位置、写库、焦点落到该行。
   */
  function undoTaskDelete() {
    var task = pendingUndo && pendingUndo.task;
    if (!task) {
      return;
    }
    var insertAt = Math.min(Math.max(pendingUndo.index, 0), state.tasks.length);
    clearUndo();
    state.tasks.splice(insertAt, 0, task);
    var saved = persistTasks();
    render();
    hideUndoToast();
    announce('已恢复任务：' + task.title + (saved ? '' : '（未能保存到本地）'));
    var row = findTaskRow(task.id);
    if (row) {
      row.classList.add('is-new');
      var main = row.querySelector('.row__main');
      if (main) {
        safeFocus(main);
        return;
      }
    }
    safeFocus(btnAddEl);
  }

  /* ==================== 十八·D2、行程增删改 ==================== */

  /**
   * 持久化行程列表（写 `course-manager:trips:v1`，与课程键完全隔离）。
   * @return {boolean}
   */
  function persistTrips() {
    if (typeof SEC.writeTrips !== 'function') {
      showNotice('行程模块未能加载，本次修改无法保存。');
      return false;
    }
    var result = SEC.writeTrips(state.trips);
    if (!result.ok && result.notice) {
      showNotice(result.notice);
    }
    return result.ok;
  }

  /**
   * 记录一行在渲染结果里的序号（删除后据此把焦点落到相邻行）。
   * @param {string} tripId
   * @return {number} 找不到返回 -1
   */
  function tripRowIndexOf(tripId) {
    if (!tripsListEl) {
      return -1;
    }
    var rows = tripsListEl.querySelectorAll('.row[data-trip-id]');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute('data-trip-id') === tripId) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 删除一条行程（写库 + 5 秒撤销）。
   * @param {string} tripId
   */
  function removeTrip(tripId) {
    var index = tripIndexOf(tripId);
    if (index === -1) {
      return;
    }
    var rowIndex = tripRowIndexOf(tripId);
    var removed = state.trips.splice(index, 1)[0];
    var saved = persistTrips();
    render();
    announce('已删除行程：' + removed.title + (saved ? '' : '（未能保存到本地）'));
    focusAfterTripDelete(rowIndex);
    showTripUndoToast(removed, index);
  }

  /**
   * 删除后聚焦：同位置的下一行 → 上一行 → 顶部新增按钮。
   * @param {number} rowIndex 删除前该行的渲染序号
   */
  function focusAfterTripDelete(rowIndex) {
    if (tripsListEl) {
      var rows = tripsListEl.querySelectorAll('.row[data-trip-id]');
      if (rows.length > 0) {
        var targetIndex = Math.min(Math.max(rowIndex, 0), rows.length - 1);
        var main = rows[targetIndex].querySelector('.row__main');
        if (main) {
          safeFocus(main);
          return;
        }
      }
    }
    safeFocus(btnAddEl);
  }

  /**
   * 显示行程删除的撤销提示（5 秒）——沿用同一个单槽位 toast。
   * @param {Object} trip
   * @param {number} index 在 state.trips 里的原位置
   */
  function showTripUndoToast(trip, index) {
    clearUndo();
    pendingUndo = { type: 'trip-delete', trip: trip, index: index };
    showToast('已删除「' + trip.title + '」', {
      showUndo: true,
      timeoutMs: UNDO_TIMEOUT_MS,
      onTimeout: function () {
        pendingUndo = null;
      }
    });
  }

  /**
   * 撤销行程删除：放回原位置、写库、焦点落到该行。
   */
  function undoTripDelete() {
    var trip = pendingUndo && pendingUndo.trip;
    if (!trip) {
      return;
    }
    var insertAt = Math.min(Math.max(pendingUndo.index, 0), state.trips.length);
    clearUndo();
    state.trips.splice(insertAt, 0, trip);
    var saved = persistTrips();
    render();
    hideUndoToast();
    announce('已恢复行程：' + trip.title + (saved ? '' : '（未能保存到本地）'));
    var row = findTripRow(trip.id);
    if (row) {
      row.classList.add('is-new');
      var main = row.querySelector('.row__main');
      if (main) {
        safeFocus(main);
        return;
      }
    }
    safeFocus(btnAddEl);
  }

  /* ==================== 十八·E、新增 / 编辑浮层（任务 / 行程共用） ==================== */

  /**
   * 打开新增 / 编辑任务浮层。
   *
   * 刻意不复用课程的 openForm：课程表单的状态机（editingId / 排课助手 / 颜色派生）
   * 全是课程专属，复用会把"正在编辑的任务 id"塞进课程状态。CSS 与浮层基础设施 100% 复用。
   * @param {Object|null} task 传任务表示编辑，null 表示新增
   * @param {HTMLElement|null} trigger 关闭后归还焦点
   */
  function openItemForm(mode, record, trigger) {
    if (!itemOverlayEl || !itemFormEl) {
      return;
    }
    if (itemOverlayEl.classList.contains('is-open')) {
      return;
    }
    var kind = mode === 'trip' ? 'trip' : 'task';
    state.itemMode = kind;
    state.itemEditingId = record && record.id ? record.id : null;
    // data-mode 是任务/行程共用一个表单的开关：字段显隐全靠它（见 styles.css）
    itemFormEl.setAttribute('data-mode', kind);
    applyItemFormChrome(kind, Boolean(record));

    // 先清空**所有**控件，再按模式补默认值 / 回填 —— 这是 T03 最容易出错的地方：
    // 只重置本模式字段的话，上一次另一个模式填过的值会留在隐藏字段里，脏检查还会误判。
    resetItemFormFields(kind);
    if (record) {
      fillItemForm(kind, record);
    }

    clearFieldErrors(itemFormEl);
    updateItemNoteCounter();
    itemFormSnapshot = serializeFields(itemFormEl);
    itemTrigger = trigger || null;

    showOverlay(itemOverlayEl);
    pushDialog(itemSheetEl, requestCloseItemForm);
    lockBodyScroll();
    itemOverlayOpenedAt = Date.now();

    // 直接在当前用户手势内聚焦，iOS 才能正常弹出键盘
    if (itemTitleInput) {
      try {
        itemTitleInput.focus({ preventScroll: true });
      } catch (err) {
        itemTitleInput.focus();
      }
    }
    var body = itemSheetEl ? itemSheetEl.querySelector('.sheet__body') : null;
    if (body) {
      body.scrollTop = 0;
    }
  }

  /**
   * 按模式切换浮层文案与输入约束（标题、字段标签、footer、placeholder、maxlength）。
   * 每次打开都完整重写一遍，避免"上个模式的文案残留"。
   * @param {'task'|'trip'} kind
   * @param {boolean} isEdit
   */
  function applyItemFormChrome(kind, isEdit) {
    var isTrip = kind === 'trip';
    if (itemTitleEl) {
      itemTitleEl.textContent = (isEdit ? '编辑' : '添加') + (isTrip ? '行程' : '任务');
    }
    if (itemTitleLabelEl) {
      itemTitleLabelEl.textContent = isTrip ? '行程名称' : '标题';
    }
    if (itemDeleteEl) {
      itemDeleteEl.textContent = isTrip ? '删除行程' : '删除任务';
      // 新增时没有可删除对象：footer 只留「取消 / 保存」
      itemDeleteEl.hidden = !isEdit;
    }
    if (itemTitleInput) {
      var maxTitle = isTrip
        ? SEC.TITLE_MAX_TRIP || 60
        : SEC.TITLE_MAX_TASK || 80;
      itemTitleInput.setAttribute('maxlength', String(maxTitle));
      itemTitleInput.setAttribute('placeholder', isTrip ? '例如：婺源晒秋' : '例如：交课程设计');
    }
    if (itemNoteInput) {
      itemNoteInput.setAttribute(
        'placeholder',
        isTrip ? '选填，例如：带广角镜头，日出 6:10' : '选填，例如：打印 2 份'
      );
    }
    updateRemindAvailability();
  }

  /**
   * 提醒只有在填了开始时间后才有意义：没填就置灰并给出说明，
   * 而不是让用户选完才在保存时报错。
   */
  function updateRemindAvailability() {
    if (!itemRemindInput) {
      return;
    }
    var hasStart = !!(itemStartInput && itemStartInput.value);
    if (itemRemindHintEl) {
      itemRemindHintEl.textContent = hasStart
        ? '到点会响所选铃声；提醒在应用打开时生效。'
        : '先填「开始」时间，才能设置提醒。';
    }
    if (!hasStart) {
      itemRemindInput.value = '';
    }
    itemRemindInput.disabled = !hasStart;
    itemRemindInput.setAttribute('aria-disabled', hasStart ? 'false' : 'true');
  }

  /**
   * 清空表单里的**所有**控件（含另一模式的隐藏字段），再按模式补默认值。
   * @param {'task'|'trip'} kind
   */
  function resetItemFormFields(kind) {
    var controls = itemFormEl.querySelectorAll('.input');
    for (var i = 0; i < controls.length; i += 1) {
      var node = controls[i];
      if (node.tagName === 'SELECT') {
        node.selectedIndex = 0;
      } else {
        node.value = '';
      }
    }
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    if (kind === 'trip') {
      // 行程默认「出发日期」取当前筛选日期（全部时用今天），状态默认计划中
      if (itemStartDateInput) {
        itemStartDateInput.value = state.tripsDate || today;
      }
      if (itemStatusSelect) {
        itemStatusSelect.value = 'planned';
      }
      return;
    }
    // 任务默认日期取当前选中的那天，而不是今天
    if (itemDateInput) {
      itemDateInput.value = state.tasksDate || today;
    }
    updateRemindAvailability();
  }

  /**
   * 用记录回填表单。
   * @param {'task'|'trip'} kind
   * @param {Object} record
   */
  function fillItemForm(kind, record) {
    if (!record) {
      return;
    }
    if (itemTitleInput) {
      itemTitleInput.value = record.title || '';
    }
    if (itemNoteInput) {
      itemNoteInput.value = record.note || '';
    }
    if (kind === 'trip') {
      if (itemDestinationInput) {
        itemDestinationInput.value = record.destination || '';
      }
      if (itemStartDateInput) {
        itemStartDateInput.value = record.startDate || '';
      }
      if (itemEndDateInput) {
        itemEndDateInput.value = record.endDate || '';
      }
      if (itemStatusSelect) {
        itemStatusSelect.value = record.status || 'planned';
      }
      return;
    }
    if (itemDateInput) {
      itemDateInput.value = record.date || '';
    }
    if (itemStartInput) {
      itemStartInput.value = record.startTime || '';
    }
    if (itemEndInput) {
      itemEndInput.value = record.endTime || '';
    }
    if (itemRemindInput) {
      var minutes = record.remindMinutes;
      itemRemindInput.value = minutes === 0 || minutes ? String(minutes) : '';
    }
    updateRemindAvailability();
  }

  /**
   * 读取并规范化任务表单值。
   * @return {{title: string, date: string, startTime: string, endTime: string, note: string}}
   */
  function readTaskFormValues() {
    return {
      title: itemTitleInput ? itemTitleInput.value.trim() : '',
      date:
        itemDateInput && typeof SEC.normalizeDateString === 'function'
          ? SEC.normalizeDateString(itemDateInput.value)
          : '',
      startTime:
        itemStartInput && typeof SEC.normalizeTimeString === 'function'
          ? SEC.normalizeTimeString(itemStartInput.value)
          : '',
      endTime:
        itemEndInput && typeof SEC.normalizeTimeString === 'function'
          ? SEC.normalizeTimeString(itemEndInput.value)
          : '',
      // 空字符串 = 不提醒；'0' = 准时（注意 0 是有效值，不能用 falsy 判断）
      remindMinutes:
        itemRemindInput && itemRemindInput.value !== ''
          ? Number(itemRemindInput.value)
          : null,
      note: itemNoteInput ? itemNoteInput.value.trim().slice(0, NOTE_MAX_LENGTH) : ''
    };
  }

  /**
   * 读取并规范化行程表单值。
   * @return {{title: string, destination: string, startDate: string, endDate: string, status: string, note: string}}
   */
  function readTripFormValues() {
    return {
      title: itemTitleInput ? itemTitleInput.value.trim() : '',
      destination: itemDestinationInput ? itemDestinationInput.value.trim() : '',
      startDate:
        itemStartDateInput && typeof SEC.normalizeDateString === 'function'
          ? SEC.normalizeDateString(itemStartDateInput.value)
          : '',
      endDate:
        itemEndDateInput && typeof SEC.normalizeDateString === 'function'
          ? SEC.normalizeDateString(itemEndDateInput.value)
          : '',
      status: itemStatusSelect ? itemStatusSelect.value : 'planned',
      note: itemNoteInput ? itemNoteInput.value.trim().slice(0, NOTE_MAX_LENGTH) : ''
    };
  }

  /**
   * 表单校验：把 sections 的纯函数校验结果映射到具体输入框与错误容器。
   * `endDate < startDate` 在**校验期**报错（红字 + 聚焦到结束日期），
   * 绝不先保存再靠 sanitizeTrip 静默清洗成 ''。
   * @param {Object} values
   * @return {Array<{target: HTMLElement, errorEl: HTMLElement, message: string}>}
   */
  function validateItemForm(values) {
    var isTrip = state.itemMode === 'trip';
    var issues = [];
    if (isTrip) {
      // previousStatus 只用来区分"同一个数据状态"下的两种提示文案：
      // 从「想法」改成「计划中」却没补日期 → "计划中的行程需要出发日期"
      var previousStatus = '';
      if (state.itemEditingId) {
        var editing = findTripById(state.itemEditingId);
        if (editing) {
          previousStatus = editing.status;
        }
      }
      issues =
        typeof SEC.validateTripValues === 'function'
          ? SEC.validateTripValues(values, { previousStatus: previousStatus })
          : [];
    } else {
      issues = typeof SEC.validateTaskValues === 'function' ? SEC.validateTaskValues(values) : [];
    }
    var errors = [];
    for (var i = 0; i < issues.length; i += 1) {
      var issue = issues[i];
      if (issue.field === 'title') {
        errors.push({ target: itemTitleInput, errorEl: itemErrorTitleEl, message: issue.message });
      } else if (isTrip && issue.field === 'startDate') {
        errors.push({
          target: itemStartDateInput,
          errorEl: itemErrorTripDateEl,
          message: issue.message
        });
      } else if (isTrip && issue.field === 'endDate') {
        errors.push({
          target: itemEndDateInput,
          errorEl: itemErrorTripDateEl,
          message: issue.message
        });
      } else if (!isTrip && issue.field === 'date') {
        errors.push({ target: itemDateInput, errorEl: itemErrorDateEl, message: issue.message });
      } else if (!isTrip && issue.field === 'remind') {
        errors.push({ target: itemRemindInput, errorEl: itemErrorRemindEl, message: issue.message });
      } else if (!isTrip && issue.field === 'time') {
        // 结束时间 ≤ 开始时间在**校验期**报错，绝不保存后偷偷修正
        errors.push({ target: itemEndInput, errorEl: itemErrorTimeEl, message: issue.message });
      }
      // note 由 maxlength + slice 双重兜底，永远不可能超长，故不映射
    }
    return errors;
  }

  /**
   * 表单当前是否有未保存的修改。
   * @return {boolean}
   */
  function isItemFormDirty() {
    return serializeFields(itemFormEl) !== itemFormSnapshot;
  }

  /**
   * 更新备注字数。
   */
  function updateItemNoteCounter() {
    if (!itemNoteCounterEl || !itemNoteInput) {
      return;
    }
    itemNoteCounterEl.textContent = itemNoteInput.value.length + ' / ' + NOTE_MAX_LENGTH;
  }

  /**
   * 真正关闭浮层（不做脏检查）。
   * @param {boolean} restoreFocus 是否归还焦点
   */
  function closeItemForm(restoreFocus) {
    if (!itemOverlayEl || itemOverlayEl.hidden) {
      return;
    }
    popDialog(itemSheetEl);
    hideOverlay(itemOverlayEl);
    unlockBodyScroll();
    // 防御：浮层关闭后若已无任何对话框，滚动锁必须归零，避免页面永久无法滚动
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    state.itemEditingId = null;
    var trigger = itemTrigger;
    itemTrigger = null;
    if (restoreFocus !== false) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * 请求关闭浮层：有未保存修改时先二次确认。
   */
  function requestCloseItemForm() {
    if (!itemOverlayEl || itemOverlayEl.hidden) {
      return;
    }
    if (!isItemFormDirty()) {
      closeItemForm(true);
      return;
    }
    askConfirm({
      title: '放弃本次编辑？',
      message: '表单里还有未保存的内容，关闭后将丢失。',
      confirmLabel: '放弃',
      cancelLabel: '继续编辑',
      danger: true
    }).then(function (confirmed) {
      if (confirmed) {
        closeItemForm(true);
      } else {
        safeFocus(itemTitleInput);
      }
    });
  }

  /**
   * 保存任务（新增 / 编辑共用一条写库路径）。
   * @param {Event} event
   */
  function submitItemForm(event) {
    event.preventDefault();
    // 退场动画期间仍可能收到隐式提交：直接忽略，避免重复新增
    if (!itemOverlayEl.classList.contains('is-open')) {
      return;
    }
    var isTrip = state.itemMode === 'trip';

    if (isTrip) {
      if (typeof SEC.buildTripRecord !== 'function') {
        showNotice('行程模块未能加载，本次修改无法保存。');
        return;
      }
      submitTripForm();
      return;
    }
    if (typeof SEC.buildTaskRecord !== 'function') {
      showNotice('任务模块未能加载，本次修改无法保存。');
      return;
    }

    var values = readTaskFormValues();
    var errors = validateItemForm(values);
    if (errors.length > 0) {
      showFieldErrors(errors, true, itemFormEl);
      return;
    }
    clearFieldErrors(itemFormEl);

    var now = Date.now();
    var editingId = state.itemEditingId;
    var isCreate = !editingId;
    var record = null;

    if (editingId) {
      var existing = findTaskById(editingId);
      if (!existing) {
        closeItemForm(true);
        showInfoToast('这条任务已不存在');
        return;
      }
      record = SEC.buildTaskRecord(values, {
        id: existing.id,
        createdAt: existing.createdAt,
        now: now,
        done: existing.done,
        doneAt: existing.doneAt
      });
      if (!record) {
        showInfoToast('任务内容不合法，未保存');
        return;
      }
      var index = taskIndexOf(existing.id);
      if (index >= 0) {
        state.tasks[index] = record;
      }
    } else {
      record = SEC.buildTaskRecord(values, { now: now, done: false });
      if (!record) {
        showInfoToast('任务内容不合法，未保存');
        return;
      }
      state.tasks.push(record);
    }

    // 日期被改到另一天时，跟着切到那一天：否则用户会"保存后任务凭空消失"
    if (record.date !== state.tasksDate) {
      state.tasksDate = record.date;
      persistSectionConfig({ dates: { tasks: record.date } });
    }

    var saved = persistTasks();
    render();
    closeItemForm(false);
    announce(
      (isCreate ? '已添加任务：' : '已保存任务：') +
        record.title +
        (saved ? '' : '（未能保存到本地）')
    );

    // 焦点：回到该行（或该行的勾选框），搬不到再回「添加任务」
    var row = findTaskRow(record.id);
    if (row) {
      var main = row.querySelector('.row__main');
      row.classList.add('is-new');
      if (main) {
        safeFocus(main);
        return;
      }
    }
    safeFocus(btnAddEl);
  }

  /**
   * 保存行程（新增 / 编辑共用一条写库路径）。
   * 与任务同一套流程：校验 → 构造 → 写库 → 全量渲染 → 关面板 → 焦点回该行。
   */
  function submitTripForm() {
    var values = readTripFormValues();
    var errors = validateItemForm(values);
    if (errors.length > 0) {
      showFieldErrors(errors, true, itemFormEl);
      return;
    }
    clearFieldErrors(itemFormEl);

    var now = Date.now();
    var editingId = state.itemEditingId;
    var isCreate = !editingId;
    var record = null;

    if (editingId) {
      var existing = findTripById(editingId);
      if (!existing) {
        closeItemForm(true);
        showInfoToast('这个行程已不存在');
        return;
      }
      record = SEC.buildTripRecord(values, {
        id: existing.id,
        createdAt: existing.createdAt,
        now: now
      });
      if (!record) {
        showInfoToast('行程内容不合法，未保存');
        return;
      }
      var index = tripIndexOf(existing.id);
      if (index >= 0) {
        state.trips[index] = record;
      }
    } else {
      record = SEC.buildTripRecord(values, { now: now });
      if (!record) {
        showInfoToast('行程内容不合法，未保存');
        return;
      }
      state.trips.push(record);
    }

    // 改到筛选外的日期时，把筛选切到能看见它的那一天（否则保存后"凭空消失"）。
    // `idea` 例外：它不参与日期筛选、任何日期下都显示，而且可能根本没有日期（startDate 为 ''），
    // 跟着它走会把筛选清成"全部"，等于用户没要求的一次隐式变更。
    if (
      record.status !== 'idea' &&
      state.tripsDate &&
      typeof SEC.tripCoversDate === 'function'
    ) {
      if (!SEC.tripCoversDate(record, state.tripsDate)) {
        state.tripsDate = record.startDate;
        persistSectionConfig({ dates: { trips: state.tripsDate } });
      }
    }

    var saved = persistTrips();
    render();
    closeItemForm(false);
    announce(
      (isCreate ? '已添加行程：' : '已保存行程：') +
        record.title +
        (saved ? '' : '（未能保存到本地）')
    );

    var row = findTripRow(record.id);
    if (row) {
      var main = row.querySelector('.row__main');
      row.classList.add('is-new');
      if (main) {
        safeFocus(main);
        return;
      }
    }
    safeFocus(btnAddEl);
  }

  /**
   * 从编辑浮层里删除当前记录（任务或行程）→ 确认 → 删除 → 5 秒撤销。
   */
  function requestDeleteCurrentItem() {
    var editingId = state.itemEditingId;
    if (!editingId) {
      return;
    }
    var isTrip = state.itemMode === 'trip';
    var record = isTrip ? findTripById(editingId) : findTaskById(editingId);
    if (!record) {
      closeItemForm(true);
      return;
    }
    var noun = isTrip ? '行程' : '任务';
    askConfirm({
      title: '删除' + noun,
      message: '确定要删除「' + record.title + '」吗？删除后 5 秒内可以撤销。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true
    }).then(function (confirmed) {
      if (!confirmed) {
        safeFocus(itemDeleteEl || itemTitleInput);
        return;
      }
      closeItemForm(false);
      if (isTrip) {
        removeTrip(record.id);
      } else {
        removeTask(record.id);
      }
    });
  }

  /* ==================== 十八·F、显示设置（清单 / 旅游 / 任务） ==================== */

  /** 显示设置浮层的固定顺序：布局 → 4 个开关 */
  var layoutSettingRow = null;

  /**
   * 清单位是否支持双列。
   * 实测：320px 下一个单元只有 ~139px，`.card__actions` 的两个按钮（编辑/删除）
   * 本身就要 ~110px，双列下卡片信息区被挤到 40px 以下 —— 不可读。
   * 因此清单保留布局开关，但「按列」置灰并说明（T04 验收 8 允许的降级路径）。
   */
  var LIST_COLUMN_SUPPORTED = false;

  /**
   * 某栏目是否允许切成双列。
   * @param {'list'|'trips'|'tasks'} section
   * @return {boolean}
   */
  function isLayoutColumnSupported(section) {
    if (section === 'list') {
      return LIST_COLUMN_SUPPORTED;
    }
    return true;
  }

  /* ==================== 任务定时提醒 ==================== */

  /**
   * 提醒的唯一键：任务 id + 日期 + 提前量 + 开始时间。
   * 改时间或改提前量都会生成新键，因此「改了时间还能再响」；
   * 同一配置在本次会话里只响一次。
   * @param {Object} task
   * @return {string}
   */
  function reminderKey(task) {
    return (
      String(task.id) +
      '|' +
      String(task.date) +
      '|' +
      String(task.remindMinutes) +
      '|' +
      String(task.startTime)
    );
  }

  function notificationsSupported() {
    return typeof window.Notification === 'function';
  }

  function notificationPermission() {
    if (!notificationsSupported()) {
      return 'unsupported';
    }
    return window.Notification.permission;
  }

  /**
   * 「开启通知」菜单项只在「支持且还没决定」时出现；
   * 已授权/已拒绝都不再打扰（拒绝后浏览器也不允许再次弹窗）。
   */
  function updateNotifyMenuItem() {
    if (!btnNotifyEl) {
      return;
    }
    // file:// 下浏览器不会授予通知权限，这一项点了也没用，直接不显示
    var httpLike = location.protocol === 'http:' || location.protocol === 'https:';
    btnNotifyEl.hidden = !httpLike || notificationPermission() !== 'default';
  }

  function requestNotifyPermission(silent) {
    if (!notificationsSupported()) {
      if (!silent) {
        showInfoToast('当前浏览器不支持系统通知，提醒只在应用内显示。');
      }
      return;
    }
    var result = window.Notification.requestPermission();
    if (!result || typeof result.then !== 'function') {
      updateNotifyMenuItem();
      return;
    }
    result.then(function (state) {
      updateNotifyMenuItem();
      if (silent) {
        return;
      }
      showInfoToast(
        state === 'granted'
          ? '已开启通知：切到后台也能收到提醒。'
          : '未开启通知，提醒只在应用打开时显示。'
      );
    });
  }

  /**
   * 后台时的系统通知（应用在前台时不用它，避免和卡片重复）。
   * @param {Object} task
   */
  function showSystemNotification(task) {
    if (notificationPermission() !== 'granted') {
      return;
    }
    try {
      var note = new window.Notification('任务提醒', {
        body: task.title + (task.startTime ? ' · ' + task.startTime : ''),
        tag: 'task-' + task.id,
        icon: 'assets/icons/icon-192.png',
        silent: true // 声音已经由铃声模块播过，避免系统再响一次
      });
      note.onclick = function () {
        try {
          window.focus();
        } catch (e) {
          /* 某些环境不允许聚焦，忽略 */
        }
        note.close();
      };
    } catch (e) {
      /* 通知构造失败（权限被撤销等）不影响卡片提醒 */
    }
  }

  /**
   * 找出此刻应当提醒的任务。
   * 规则：今天、未完成、设置了提醒、已到点且迟到不超过 90 秒。
   * 超过窗口的不补响——避免早上打开应用被昨晚的提醒连环轰炸。
   * @param {number} now
   * @return {Array<{task:Object, at:number, key:string}>}
   */
  function findDueReminders(now) {
    var due = [];
    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    for (var i = 0; i < state.tasks.length; i += 1) {
      var task = state.tasks[i];
      if (!task || task.done) {
        continue;
      }
      if (task.date !== today) {
        continue;
      }
      if (typeof SEC.taskReminderAt !== 'function') {
        break;
      }
      var at = SEC.taskReminderAt(task);
      if (at === null || now < at || now - at > REMINDER_GRACE_MS) {
        continue;
      }
      var key = reminderKey(task);
      if (reminderFired[key]) {
        continue;
      }
      due.push({ task: task, at: at, key: key });
    }

    // 「稍后提醒」到点后重新入队（不受 fired 去重影响）
    for (var j = reminderSnoozes.length - 1; j >= 0; j -= 1) {
      var snooze = reminderSnoozes[j];
      if (now < snooze.at) {
        continue;
      }
      reminderSnoozes.splice(j, 1);
      due.push({ task: snooze.task, at: snooze.at, key: snooze.key });
    }
    return due;
  }

  /**
   * 轮询入口：由 interval 与 visibilitychange 触发。
   * 幂等——同一条任务同一配置在本次会话只响一次。
   */
  function checkReminders() {
    var due = findDueReminders(Date.now());
    for (var i = 0; i < due.length; i += 1) {
      reminderFired[due[i].key] = Date.now();
      fireReminder(due[i].task);
    }
  }

  /**
   * 真正提醒：响铃 + 播报 + （后台时）系统通知 + 卡片。
   * @param {Object} task
   */
  function fireReminder(task) {
    if (window.CourseRingtone && typeof window.CourseRingtone.preview === 'function') {
      var result = window.CourseRingtone.preview(window.CourseRingtone.getSelectedId());
      if (result && !result.ok && result.notice) {
        // 铃声不可用不该拦住提醒本身：卡片照常出现
        announce(result.notice);
      }
    }
    announce('任务提醒：' + task.title + (task.startTime ? '，' + task.startTime : ''));
    if (document.hidden) {
      showSystemNotification(task);
    }
    showReminderCard(task);
  }

  /**
   * 提醒卡片：role=alert，不抢焦点（用户可能正在输入）。
   * 最多同时 3 张，更早的自动清掉，避免堆满屏幕。
   * @param {Object} task
   */
  function showReminderCard(task) {
    if (!reminderStackEl) {
      return;
    }
    while (reminderStackEl.children.length >= 3) {
      reminderStackEl.removeChild(reminderStackEl.firstChild);
    }

    var card = createEl('div', 'reminder');
    card.setAttribute('role', 'alert');
    card.setAttribute('data-task-id', String(task.id));

    var head = createEl('div', 'reminder__head');
    head.appendChild(createIcon('icon-bell'));
    head.appendChild(createEl('span', 'reminder__label', '任务提醒'));
    var timeText = task.startTime || '';
    if (timeText && task.remindMinutes) {
      timeText += ' · 提前 ' + task.remindMinutes + ' 分钟';
    }
    if (timeText) {
      head.appendChild(createEl('span', 'reminder__time', timeText));
    }
    card.appendChild(head);

    card.appendChild(createEl('p', 'reminder__title', task.title));
    if (task.note) {
      card.appendChild(createEl('p', 'reminder__meta', task.note));
    }

    var actions = createEl('div', 'reminder__actions');
    var doneBtn = createEl('button', 'btn btn--primary btn--sm', '完成');
    doneBtn.type = 'button';
    doneBtn.setAttribute('data-action', 'complete');
    var snoozeBtn = createEl('button', 'btn btn--ghost btn--sm', '稍后 5 分钟');
    snoozeBtn.type = 'button';
    snoozeBtn.setAttribute('data-action', 'snooze');
    var dismissBtn = createEl('button', 'btn btn--ghost btn--sm', '知道了');
    dismissBtn.type = 'button';
    dismissBtn.setAttribute('data-action', 'dismiss');
    actions.appendChild(doneBtn);
    actions.appendChild(snoozeBtn);
    actions.appendChild(dismissBtn);
    card.appendChild(actions);

    reminderStackEl.appendChild(card);
    card.classList.add('is-new');
  }

  /**
   * 卡片上的三个动作：完成 / 稍后 5 分钟 / 知道了。
   * @param {MouseEvent} event
   */
  function handleReminderAction(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var button = target.closest('[data-action]');
    var card = target.closest('.reminder');
    if (!button || !card) {
      return;
    }
    var action = button.getAttribute('data-action');
    var taskId = card.getAttribute('data-task-id') || '';
    var task = findTaskById(taskId);

    if (window.CourseRingtone && typeof window.CourseRingtone.stop === 'function') {
      window.CourseRingtone.stop();
    }

    if (action === 'complete') {
      if (task && !task.done) {
        toggleTaskDone(taskId);
      }
      removeReminderCard(card);
      return;
    }
    if (action === 'snooze') {
      if (task) {
        reminderSnoozes.push({
          task: task,
          at: Date.now() + REMINDER_SNOOZE_MS,
          key: reminderKey(task) + '|snooze'
        });
        showInfoToast('5 分钟后再次提醒');
      }
      removeReminderCard(card);
      return;
    }
    removeReminderCard(card);
  }

  function removeReminderCard(card) {
    if (card && card.parentNode) {
      card.parentNode.removeChild(card);
    }
  }

  /**
   * 启动提醒轮询。只在 init 里调一次；可见性恢复时立刻补一次判定
   * （后台标签页的定时器会被浏览器降频，不能只靠 interval）。
   */
  function startReminders() {
    if (reminderTickerId !== null) {
      return;
    }
    checkReminders();
    reminderTickerId = window.setInterval(checkReminders, REMINDER_TICK_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        checkReminders();
      }
    });
  }

  /* ==================== 铃声设置 ==================== */

  /**
   * 取铃声模块（未加载时返回 null，UI 据此提示而不是静默失效）。
   * @return {Object|null}
   */
  function ringtoneApi() {
    return window.CourseRingtone && typeof window.CourseRingtone.list === 'function'
      ? window.CourseRingtone
      : null;
  }

  /**
   * 是否运行在 Capacitor 原生壳里（Android/iOS 打包版）。
   * 网页版、file://、PWA 都返回 false。
   * @return {boolean}
   */
  function isNativeShell() {
    var cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  /**
   * 原生壳专属：接管安卓返回键。
   * 默认行为是直接退出应用——正在填表单或看日志时被弹出去很容易丢内容。
   * 这里改成：有浮层/互换态就先关掉，都没有才最小化（不杀进程）。
   */
  function initNativeShell() {
    var cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
      return;
    }
    var appPlugin = cap.Plugins && cap.Plugins.App;
    if (!appPlugin || typeof appPlugin.addListener !== 'function') {
      return;
    }
    appPlugin.addListener('backButton', function () {
      if (topDialog() || swapState.active) {
        // 复用既有的 Esc 链路：它会关掉最上层浮层，或退出互换模式
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return;
      }
      if (typeof appPlugin.minimizeApp === 'function') {
        appPlugin.minimizeApp();
      }
    });
  }

  /**
   * 注册 Service Worker（应用外壳离线缓存）。
   * `file://` 下浏览器禁用 SW，直接跳过——这也是「双击 index.html 也能用」的前提：
   * 离线能力是增强项，不是运行前提。
   */
  function registerServiceWorker() {
    // 原生壳（Capacitor）里资源已在本地，不需要离线缓存；注册 SW 反而会在更新后
    // 继续跑旧缓存，所以直接跳过。
    if (isNativeShell()) {
      return;
    }
    // PWA 只在 http/https 下有意义：把 manifest 动态挂上，再注册 Service Worker。
    // file:// 下不挂 manifest（浏览器会报 CORS 且无法安装），双击打开照常可用。
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      return;
    }
    if (!document.querySelector('link[rel="manifest"]')) {
      var link = document.createElement('link');
      link.rel = 'manifest';
      link.href = 'manifest.webmanifest';
      document.head.appendChild(link);
    }
    if (!('serviceWorker' in navigator)) {
      return;
    }
    navigator.serviceWorker.register('sw.js').catch(function () {
      // 注册失败（例如内网 http 被限制）不影响应用本体，静默即可
    });
  }

  /**
   * 打开铃声浮层。草稿从已保存值开始，关闭不保存即丢弃。
   * @param {HTMLElement} trigger
   */
  function openRingtone(trigger) {
    if (!ringtoneOverlayEl || !ringtoneSheetEl) {
      return;
    }
    if (ringtoneOverlayEl.classList.contains('is-open')) {
      return;
    }
    var api = ringtoneApi();
    if (!api) {
      showInfoToast('铃声模块没有加载，无法打开铃声设置。');
      return;
    }
    ringtoneTrigger = trigger || btnMoreEl;
    ringtoneSavedId = api.getSelectedId();
    ringtoneDraftId = ringtoneSavedId;
    renderRingtone();
    showOverlay(ringtoneOverlayEl);
    pushDialog(ringtoneSheetEl, function () {
      closeRingtone(true);
    });
    lockBodyScroll();
    ringtoneOpenedAt = Date.now();
    window.setTimeout(
      function () {
        if (!ringtoneOverlayEl.classList.contains('is-open')) {
          return;
        }
        // 焦点先给列表里当前选中的项，键盘用户可以直接用方向键换铃声
        var picked = ringtoneListEl
          ? ringtoneListEl.querySelector('[aria-checked="true"]')
          : null;
        safeFocus(picked || ringtoneCloseEl);
      },
      prefersReducedMotion() ? 0 : 60
    );
  }

  /**
   * 关闭铃声浮层：停掉试听，未保存的草稿丢弃。
   * @param {boolean} restoreFocus
   */
  function closeRingtone(restoreFocus) {
    if (!ringtoneOverlayEl || ringtoneOverlayEl.hidden) {
      return;
    }
    var api = ringtoneApi();
    if (api && typeof api.stop === 'function') {
      api.stop();
    }
    ringtoneDraftId = '';
    popDialog(ringtoneSheetEl);
    hideOverlay(ringtoneOverlayEl);
    unlockBodyScroll();
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    var trigger = ringtoneTrigger;
    ringtoneTrigger = null;
    if (restoreFocus !== false) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * 构建一条铃声。选择区（role=radio）与试听按钮是并列兄弟节点，
   * 不允许 button 套 button：嵌套可交互元素会让键盘顺序与读屏都错乱。
   * @param {Object} item
   * @return {HTMLElement}
   */
  function createRingtoneRow(item) {
    var li = createEl('li', 'ringtone');
    li.setAttribute('data-ringtone-id', item.id);
    var checked = item.id === ringtoneDraftId;
    if (checked) {
      li.classList.add('is-selected');
    }

    var pick = createEl('button', 'ringtone__pick');
    pick.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', checked ? 'true' : 'false');
    pick.setAttribute(
      'aria-label',
      item.name + (item.desc ? '，' + item.desc : '') + (checked ? '，已选择' : '，选择')
    );

    var dot = createEl('span', 'ringtone__dot');
    dot.setAttribute('aria-hidden', 'true');
    pick.appendChild(dot);

    var text = createEl('span', 'ringtone__text');
    text.appendChild(createEl('span', 'ringtone__name', item.name));
    if (item.desc) {
      text.appendChild(createEl('span', 'ringtone__desc', item.desc));
    }
    pick.appendChild(text);

    var api = ringtoneApi();
    var playing =
      !!api && typeof api.getPlayingId === 'function' && api.getPlayingId() === item.id;

    var play = createEl('button', 'ringtone__play');
    play.type = 'button';
    play.setAttribute('data-action', 'preview');
    play.setAttribute('aria-label', '试听「' + item.name + '」');
    play.setAttribute('title', '试听');
    play.setAttribute('aria-pressed', playing ? 'true' : 'false');
    if (playing) {
      play.classList.add('is-playing');
    }
    play.appendChild(createIcon(playing ? 'icon-stop' : 'icon-play'));

    li.appendChild(pick);
    li.appendChild(play);
    return li;
  }

  /**
   * 重画铃声列表与「当前铃声」。只重建列表容器内部，不重建整个浮层，
   * 避免焦点与滚动位置在每次选择后丢失。
   */
  function renderRingtone() {
    var api = ringtoneApi();
    if (!api || !ringtoneListEl) {
      return;
    }
    var supported = typeof api.isSupported === 'function' ? api.isSupported() : true;
    var items = api.list();
    var current = null;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id === ringtoneDraftId) {
        current = items[i];
        break;
      }
    }
    if (ringtoneCurrentNameEl) {
      ringtoneCurrentNameEl.textContent = current ? current.name : '未选择';
    }
    if (ringtoneCurrentPlayEl) {
      var silent = !!current && current.silent;
      ringtoneCurrentPlayEl.disabled = !supported || silent;
      ringtoneCurrentPlayEl.setAttribute(
        'aria-label',
        silent ? '当前为静音铃声，不发声' : '试听当前铃声'
      );
    }

    ringtoneListEl.textContent = '';
    for (var j = 0; j < items.length; j += 1) {
      ringtoneListEl.appendChild(createRingtoneRow(items[j]));
    }
    if (ringtoneHintEl) {
      ringtoneHintEl.textContent = supported
        ? '点「试听」立即播放，选好后点「保存」生效；设置保存在这台设备上。铃声为实时合成，不占用存储空间。'
        : '当前浏览器不支持播放声音，只能保存选择，无法试听。';
      ringtoneHintEl.classList.toggle('is-warning', !supported);
    }
  }

  /**
   * 选一个铃声（草稿）并立刻试听——与手机闹钟选铃声的手感一致。
   * @param {string} id
   */
  function selectRingtone(id) {
    var api = ringtoneApi();
    if (!api || id === ringtoneDraftId) {
      return;
    }
    ringtoneDraftId = id;
    renderRingtone();
    var result = api.preview(id);
    if (!result.ok && result.notice) {
      showInfoToast(result.notice);
    }
  }

  /**
   * 试听某个铃声（不改变选择）。
   * @param {string} id
   */
  function previewRingtone(id) {
    var api = ringtoneApi();
    if (!api) {
      return;
    }
    var result = api.preview(id);
    if (!result.ok) {
      if (result.notice) {
        showInfoToast(result.notice);
      }
      return;
    }
    if (result.notice) {
      // 静音只震动、或浏览器拦截自动播放：明确告知，避免用户以为坏了
      showInfoToast(result.notice);
    }
    renderRingtone();
  }

  /**
   * 保存铃声设置：写库成功才提示并关闭；失败留在浮层里让用户重试。
   */
  function saveRingtone() {
    var api = ringtoneApi();
    if (!api) {
      closeRingtone(true);
      return;
    }
    var result = api.setSelected(ringtoneDraftId);
    if (!result.ok) {
      showInfoToast(result.notice || '保存失败。');
      return;
    }
    api.stop();
    ringtoneSavedId = ringtoneDraftId;
    updateRingtoneMenuLabel();
    showInfoToast('已保存铃声：' + api.getSelected().name);
    closeRingtone(true);
  }

  /**
   * 把已选铃声写进「更多」菜单项的标题与无障碍名称，
   * 不进浮层也能知道当前铃声是什么。
   */
  function updateRingtoneMenuLabel() {
    if (!btnRingtoneEl) {
      return;
    }
    var api = ringtoneApi();
    if (!api) {
      return;
    }
    var name = api.getSelected().name;
    btnRingtoneEl.setAttribute('title', '铃声：' + name);
    btnRingtoneEl.setAttribute('aria-label', '铃声，当前为' + name);
  }

  /**
   * 打开显示设置浮层（配置对象是当前栏目）。
   * @param {HTMLElement|null} trigger 关闭后归还焦点（设计指定回「更多」按钮）
   */
  function openSettings(trigger) {
    if (!displayOverlayEl || !displaySettingsEl) {
      return;
    }
    if (displayOverlayEl.classList.contains('is-open')) {
      return;
    }
    settingsTrigger = trigger || btnMoreEl;
    renderSettings();
    showOverlay(displayOverlayEl);
    pushDialog(displaySheetEl, function () {
      closeSettings(true);
    });
    lockBodyScroll();
    displayOpenedAt = Date.now();
    window.setTimeout(
      function () {
        if (!displayOverlayEl.classList.contains('is-open')) {
          return;
        }
        var first = displaySettingsEl.querySelector('button');
        safeFocus(first || displayCloseEl);
      },
      prefersReducedMotion() ? 0 : 60
    );
  }

  /**
   * 关闭显示设置浮层。
   * @param {boolean} restoreFocus
   */
  function closeSettings(restoreFocus) {
    if (!displayOverlayEl || displayOverlayEl.hidden) {
      return;
    }
    popDialog(displaySheetEl);
    hideOverlay(displayOverlayEl);
    unlockBodyScroll();
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    var trigger = settingsTrigger;
    settingsTrigger = null;
    if (restoreFocus !== false) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * 构建设置面板的内容（每次打开重建：栏目名、说明、开关状态都可能已变）。
   */
  function renderSettings() {
    if (!displaySettingsEl) {
      return;
    }
    var section = currentListSection();
    var cfg = getViewConfig(section);
    var name = LIST_SECTION_NAMES[section];
    if (displayTitleEl) {
      displayTitleEl.textContent = '显示设置 · ' + name;
    }
    if (displayNoteEl) {
      displayNoteEl.textContent =
        '只影响「' + name + '」栏目；清单、旅游、任务三套设置互不影响，改完立即生效。';
    }
    displaySettingsEl.textContent = '';
    layoutSettingRow = buildLayoutSetting(section, cfg);
    displaySettingsEl.appendChild(layoutSettingRow);
    for (var i = 0; i < SETTING_DEFS.length; i += 1) {
      displaySettingsEl.appendChild(buildToggleSetting(SETTING_DEFS[i], section, cfg));
    }
  }

  /**
   * 布局行：按行 / 按列，两个 role="radio" 按钮（radiogroup）。
   * @param {'list'|'trips'|'tasks'} section
   * @param {Object} cfg
   * @return {HTMLElement}
   */
  function buildLayoutSetting(section, cfg) {
    var row = createEl('div', 'setting setting--layout');
    var text = createEl('div', 'setting__text');
    text.appendChild(createEl('span', 'setting__label', '布局'));
    var columnOk = isLayoutColumnSupported(section);
    text.appendChild(
      createEl(
        'span',
        'setting__desc',
        columnOk ? '按行信息更全；按列一屏更多' : '清单信息较多，仅支持按行'
      )
    );
    row.appendChild(text);

    var group = createEl('div', 'segmented segmented--sm');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '列表布局');
    var options = [
      { value: LAYOUT_ROW, label: '按行' },
      { value: LAYOUT_COLUMN, label: '按列' }
    ];
    for (var i = 0; i < options.length; i += 1) {
      // IIFE 必须保留：`var option` 是函数作用域，不包起来的话两个按钮的 click
      // 都闭包到最后一次迭代的值（点「按行」实际执行「按列」）
      (function (option) {
        var disabled = option.value === LAYOUT_COLUMN && !columnOk;
        var btn = createEl('button', 'segmented__btn', option.label);
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('data-layout-option', option.value);
        btn.setAttribute('aria-checked', String(cfg.layout === option.value));
        btn.setAttribute('aria-label', option.label + (disabled ? '（清单仅支持按行）' : ''));
        if (disabled) {
          btn.setAttribute('aria-disabled', 'true');
        }
        btn.addEventListener('click', function () {
          if (disabled) {
            announce('清单信息较多，仅支持按行');
            return;
          }
          setListLayout(option.value);
        });
        group.appendChild(btn);
      })(options[i]);
    }
    row.appendChild(group);
    return row;
  }

  /**
   * 单个开关行：整行是 role="checkbox" 的按钮（热区 = 行高 56 ≥ 44）。
   * @param {{key: string, label: string, desc: Object}} def
   * @param {'list'|'trips'|'tasks'} section
   * @param {Object} cfg
   * @return {HTMLElement}
   */
  function buildToggleSetting(def, section, cfg) {
    var supported = isSettingSupported(section, def.key);
    var btn = createEl('button', 'setting');
    btn.type = 'button';
    btn.setAttribute('role', 'checkbox');
    btn.setAttribute('data-setting', def.key);
    btn.setAttribute('aria-checked', String(supported && cfg[def.key] !== false));
    if (!supported) {
      btn.classList.add('is-disabled');
      btn.setAttribute('aria-disabled', 'true');
    }

    var text = createEl('span', 'setting__text');
    text.appendChild(createEl('span', 'setting__label', def.label));
    var desc = def.desc && def.desc[section] ? def.desc[section] : '';
    text.appendChild(createEl('span', 'setting__desc', desc));
    btn.appendChild(text);

    var sw = createEl('span', 'setting__switch');
    sw.setAttribute('aria-hidden', 'true');
    btn.appendChild(sw);

    btn.addEventListener('click', function () {
      toggleSetting(def.key);
    });
    return btn;
  }

  /**
   * 切换一个开关（不支持时给解释，不静默失败）。
   * @param {string} key
   */
  function toggleSetting(key) {
    var section = currentListSection();
    var def = null;
    for (var d = 0; d < SETTING_DEFS.length; d += 1) {
      if (SETTING_DEFS[d].key === key) {
        def = SETTING_DEFS[d];
        break;
      }
    }
    var label = def ? def.label : key;
    if (!isSettingSupported(section, key)) {
      announce('「' + label + '」对' + LIST_SECTION_NAMES[section] + '栏目不适用');
      return;
    }
    var cfg = getViewConfig(section);
    cfg[key] = cfg[key] === false;
    persistConfigFor(section, cfg);
    syncSettingsUi();
    render();
    announce(
      (cfg[key] ? '已显示' : '已隐藏') + '「' + label + '」'
    );
  }

  /**
   * 切换布局（立即生效并写库）。
   * @param {'row'|'column'} layout
   */
  function setListLayout(layout) {
    var section = currentListSection();
    if (layout === LAYOUT_COLUMN && !isLayoutColumnSupported(section)) {
      return;
    }
    var cfg = getViewConfig(section);
    if (cfg.layout === layout) {
      syncSettingsUi();
      return;
    }
    cfg.layout = layout;
    persistConfigFor(section, cfg);
    syncSettingsUi();
    render();
    announce('已切换为' + (layout === LAYOUT_COLUMN ? '按列' : '按行') + '布局');
  }

  /**
   * 只刷新面板上的 aria-checked（不重建 DOM，焦点不会丢）。
   */
  function syncSettingsUi() {
    if (!displaySettingsEl) {
      return;
    }
    var section = currentListSection();
    var cfg = getViewConfig(section);
    var toggles = displaySettingsEl.querySelectorAll('.setting[data-setting]');
    for (var i = 0; i < toggles.length; i += 1) {
      var key = toggles[i].getAttribute('data-setting');
      toggles[i].setAttribute(
        'aria-checked',
        String(isSettingSupported(section, key) && cfg[key] !== false)
      );
    }
    var radios = displaySettingsEl.querySelectorAll('[data-layout-option]');
    for (var j = 0; j < radios.length; j += 1) {
      radios[j].setAttribute(
        'aria-checked',
        String(radios[j].getAttribute('data-layout-option') === cfg.layout)
      );
    }
  }

  /**
   * 把某栏目的配置写库（同时同步内存里的 state.sectionConfig）。
   * @param {'list'|'trips'|'tasks'} section
   * @param {Object} cfg
   * @return {boolean}
   */
  function persistConfigFor(section, cfg) {
    var clean = {
      layout: cfg.layout === LAYOUT_COLUMN ? LAYOUT_COLUMN : LAYOUT_ROW,
      showMeta: cfg.showMeta !== false,
      showSide: cfg.showSide !== false,
      showAvatar: cfg.showAvatar !== false,
      showGroupTitle: cfg.showGroupTitle !== false
    };
    var patch = { configs: {} };
    patch.configs[section] = clean;
    return persistSectionConfig(patch);
  }

  /* ==================== 十八·G、课程目录（勾选批量添加） ==================== */

  /**
   * 当前目录的判重键集合（每次打开 / 每次提交前重建一次）。
   * 不缓存到 state 里：目录是只读视图，不需要参与持久化。
   * @return {Object<string, boolean>}
   */
  function buildCatalogKeys() {
    return CAT.buildKeySet(state.courses);
  }

  /**
   * 课程被外部改动后（另一个标签页写库、整批撤销），把目录浮层拉回一致状态。
   * 做三件事：重建判重键 → 撤掉「已被别处加过」的勾选 → 整表重渲染（行状态 / 统计 / 计数）。
   * 浮层没开着就什么都不做（目录是纯视图，不需要维护）。
   */
  function syncCatalogAfterExternalChange() {
    if (!catalogOverlayEl || !catalogOverlayEl.classList.contains('is-open')) {
      return;
    }
    if (!Array.isArray(CAT.CATALOG)) {
      return;
    }
    catalogState.keys = buildCatalogKeys();
    var ids = selectedCatalogIds();
    for (var i = 0; i < ids.length; i += 1) {
      var entry = CAT.findEntry(ids[i]);
      if (entry && CAT.isDuplicate(entry, catalogState.keys)) {
        // 别处已经加过了：勾选作废，重渲染后这一行会显示「已添加」
        delete catalogState.selected[ids[i]];
      }
    }
    renderCatalog();
  }

  /**
   * 目录顶部的统计文案：「共 N 门 · 已添加 M 门」。
   */
  function renderCatalogStats() {
    if (!catalogStatsEl) {
      return;
    }
    var total = CAT.CATALOG.length;
    var added = CAT.countAdded(CAT.CATALOG, catalogState.keys);
    catalogStatsEl.textContent = '共 ' + total + ' 门 · 已添加 ' + added + ' 门';
  }

  /**
   * 建一次分类 chips（含「全部」）。只建一次，之后只切 aria-pressed，
   * 这样点 chip 时焦点不会被重建的 DOM 抢走。
   */
  function buildCatalogChips() {
    if (!catalogChipsEl || catalogChipsEl.childNodes.length > 0) {
      return;
    }
    var labels = [CAT.CATEGORY_ALL].concat(CAT.CATEGORIES);
    for (var i = 0; i < labels.length; i += 1) {
      var chip = createEl('button', 'chip', labels[i]);
      chip.type = 'button';
      chip.setAttribute('data-category', labels[i]);
      chip.setAttribute('aria-pressed', 'false');
      catalogChipsEl.appendChild(chip);
    }
  }

  /**
   * 同步 chips 的选中态。
   */
  function renderCatalogChips() {
    if (!catalogChipsEl) {
      return;
    }
    var chips = catalogChipsEl.querySelectorAll('[data-category]');
    for (var i = 0; i < chips.length; i += 1) {
      var value = chips[i].getAttribute('data-category');
      chips[i].setAttribute('aria-pressed', String(value === catalogState.category));
    }
  }

  /**
   * 目录条目的时间文案（「周三 08:30–10:00」）。
   * 星期取本文件唯一的 WEEKDAY_LABELS，时段复用 formatTimeRange ——
   * 全应用只有一份时间格式，目录不另造一套。
   * @param {Object} entry
   * @return {string}
   */
  function formatCatalogTime(entry) {
    if (!entry || typeof entry !== 'object') {
      return '';
    }
    var weekday = WEEKDAY_LABELS[clampWeekday(entry.weekday) - 1];
    var range = formatTimeRange(entry);
    return range ? weekday + ' ' + range : weekday;
  }

  /**
   * 目录行的无障碍名称：把「名称 / 分类 / 时间 / 状态」一次读全。
   * @param {Object} entry
   * @param {string} stateText '已添加' / '已选' / ''
   * @return {string}
   */
  function buildCatalogRowAria(entry, stateText) {
    var parts = [
      entry.name,
      entry.category,
      formatCatalogTime(entry),
      entry.teacher + ' ' + entry.place
    ];
    if (stateText) {
      parts.push(stateText);
    }
    return parts.join('，');
  }

  /**
   * 设置目录行右侧徽标。
   * @param {HTMLElement} rowEl
   * @param {string} text '' 表示隐藏
   */
  function setCatalogBadge(rowEl, text) {
    if (!rowEl) {
      return;
    }
    var badge = rowEl.querySelector('.catalog-row__badge');
    if (!badge) {
      return;
    }
    badge.textContent = text;
    badge.hidden = !text;
  }

  /**
   * 构建一行目录条目。
   * @param {Object} entry
   * @return {HTMLLIElement}
   */
  function createCatalogRow(entry) {
    var added = CAT.isDuplicate(entry, catalogState.keys);
    var selected = Boolean(catalogState.selected[entry.id]);
    var stateText = added ? '已添加' : selected ? '已选' : '';

    var li = createEl('li', 'catalog-row');
    if (added) {
      li.classList.add('is-added');
    } else if (selected) {
      li.classList.add('is-selected');
    }

    // 勾选行本身是 role="checkbox" 的自定义控件：
    // Tab 可停、空格切换、Enter 提交；已添加的行退化为不可勾选（tabindex=-1 + aria-disabled）。
    var row = createEl('div', 'catalog-row__pick');
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', selected ? 'true' : 'false');
    row.setAttribute('tabindex', added ? '-1' : '0');
    row.setAttribute('data-catalog-id', entry.id);
    row.setAttribute('aria-label', buildCatalogRowAria(entry, stateText));
    if (added) {
      row.setAttribute('aria-disabled', 'true');
    }

    var box = createEl('span', 'catalog-row__box');
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(createIcon('icon-check'));

    var body = createEl('span', 'catalog-row__body');
    var titleLine = createEl('span', 'catalog-row__titleline');
    titleLine.appendChild(createEl('span', 'catalog-row__name', entry.name));
    titleLine.appendChild(createEl('span', 'catalog-row__cat', entry.category));
    var badge = createEl('span', 'catalog-row__badge', stateText);
    badge.hidden = !stateText;
    titleLine.appendChild(badge);
    body.appendChild(titleLine);
    body.appendChild(createEl('span', 'catalog-row__intro', entry.intro));
    body.appendChild(
      createEl('span', 'catalog-row__meta', formatCatalogTime(entry))
    );
    body.appendChild(createEl('span', 'catalog-row__meta', entry.teacher + ' · ' + entry.place));

    row.appendChild(box);
    row.appendChild(body);
    li.appendChild(row);
    return li;
  }

  /**
   * 渲染目录列表（搜索 / 分类变化时整体重建，此时焦点在搜索框或 chip 上，不受影响）。
   */
  function renderCatalogList() {
    if (!catalogListEl) {
      return;
    }
    var entries = CAT.filterEntries(CAT.CATALOG, {
      query: catalogState.query,
      category: catalogState.category
    });
    catalogListEl.textContent = '';
    catalogState.rowEls = {};

    if (entries.length === 0) {
      if (catalogEmptyEl) {
        if (catalogState.query) {
          catalogEmptyEl.textContent =
            '没有找到与「' + catalogState.query + '」匹配的课程，换个关键词试试。';
        } else if (catalogState.category !== CAT.CATEGORY_ALL) {
          catalogEmptyEl.textContent = '「' + catalogState.category + '」分类下暂时没有课程。';
        } else {
          catalogEmptyEl.textContent = '课程目录暂时是空的。';
        }
        catalogEmptyEl.hidden = false;
      }
      return;
    }
    if (catalogEmptyEl) {
      catalogEmptyEl.hidden = true;
    }

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i += 1) {
      var li = createCatalogRow(entries[i]);
      fragment.appendChild(li);
      var rowEl = li.firstChild;
      if (rowEl) {
        catalogState.rowEls[entries[i].id] = rowEl;
      }
    }
    catalogListEl.appendChild(fragment);
  }

  /**
   * 更新底部操作条上方的结果摘要（空串表示收起）。
   * 摘要多占一行会让操作条变高，必须重新量一次高度，
   * 否则撤销提示（抬到操作条上方）会压住「添加所选」。
   * @param {string} text
   */
  function setCatalogStatus(text) {
    if (!catalogStatusEl) {
      return;
    }
    var value = typeof text === 'string' ? text : '';
    catalogStatusEl.textContent = value;
    catalogStatusEl.hidden = !value;
    if (catalogFooterEl && document.body) {
      document.body.style.setProperty('--catalog-foot-h', catalogFooterEl.offsetHeight + 'px');
    }
  }

  /**
   * 同步底部操作条的计数与禁用态。
   */
  function updateCatalogFooter() {
    var count = selectedCatalogIds().length;
    if (catalogCountEl) {
      catalogCountEl.textContent = '已选 ' + count + ' 门';
    }
    if (catalogAddEl) {
      catalogAddEl.textContent = '添加所选(' + count + ')';
      catalogAddEl.disabled = count === 0 || catalogState.busy;
    }
    if (catalogClearEl) {
      catalogClearEl.disabled = count === 0 || catalogState.busy;
    }
  }

  /**
   * 全量渲染目录浮层内容。
   */
  function renderCatalog() {
    renderCatalogStats();
    renderCatalogChips();
    renderCatalogList();
    updateCatalogFooter();
  }

  /**
   * 当前勾选的目录 id（按目录顺序，保证写入顺序稳定）。
   * @return {Array<string>}
   */
  function selectedCatalogIds() {
    var ids = [];
    for (var i = 0; i < CAT.CATALOG.length; i += 1) {
      var id = CAT.CATALOG[i].id;
      if (catalogState.selected[id]) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * 就地同步一行的勾选外观（不重建 DOM，焦点与滚动位置都不动）。
   * @param {string} id
   * @param {string} stateText '已选' / '' / '已添加'
   */
  function syncCatalogRow(id, stateText) {
    var rowEl = catalogState.rowEls[id];
    if (!rowEl) {
      return;
    }
    var entry = CAT.findEntry(id);
    if (!entry) {
      return;
    }
    rowEl.setAttribute('aria-checked', stateText === '已选' ? 'true' : 'false');
    rowEl.setAttribute('aria-label', buildCatalogRowAria(entry, stateText));
    setCatalogBadge(rowEl, stateText);
    var li = rowEl.parentNode;
    if (li && li.classList) {
      li.classList.toggle('is-selected', stateText === '已选');
      li.classList.toggle('is-added', stateText === '已添加');
    }
  }

  /**
   * 把一组目录行标记为「已添加」（不可再勾选）。
   * @param {Array<string>} ids
   */
  function markCatalogRowsAdded(ids) {
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      delete catalogState.selected[id];
      var rowEl = catalogState.rowEls[id];
      if (!rowEl) {
        continue;
      }
      rowEl.setAttribute('tabindex', '-1');
      rowEl.setAttribute('aria-disabled', 'true');
      syncCatalogRow(id, '已添加');
    }
  }

  /**
   * 空格切换某一行的勾选。
   * @param {string} id
   */
  function toggleCatalogPick(id) {
    var entry = CAT.findEntry(id);
    if (!entry) {
      return;
    }
    if (CAT.isDuplicate(entry, catalogState.keys)) {
      // 已添加：不可勾选，但要给出原因，不能静默失败
      announce('「' + entry.name + '」已经在课表里了');
      return;
    }
    if (catalogState.selected[id]) {
      delete catalogState.selected[id];
      syncCatalogRow(id, '');
    } else {
      catalogState.selected[id] = true;
      syncCatalogRow(id, '已选');
    }
    // 勾选一变，上一次添加的摘要就过期了
    setCatalogStatus('');
    updateCatalogFooter();
  }

  /**
   * 清空全部勾选。
   */
  function clearCatalogSelection() {
    var ids = selectedCatalogIds();
    catalogState.selected = {};
    for (var i = 0; i < ids.length; i += 1) {
      syncCatalogRow(ids[i], '');
    }
    setCatalogStatus('');
    updateCatalogFooter();
  }

  /**
   * 加完之后把焦点挪到下一个还能选的行（键盘连续添加不用重新 Tab 一圈）。
   * @param {string} fromId
   */
  function focusNextCatalogRow(fromId) {
    var ids = [];
    for (var i = 0; i < CAT.CATALOG.length; i += 1) {
      ids.push(CAT.CATALOG[i].id);
    }
    var start = ids.indexOf(fromId);
    if (start < 0) {
      start = -1;
    }
    // 先往下找，再回到开头绕一圈；都不行就回到搜索框
    for (var step = 1; step <= ids.length; step += 1) {
      var candidate = ids[(start + step) % ids.length];
      var rowEl = catalogState.rowEls[candidate];
      if (rowEl && rowEl.getAttribute('aria-disabled') !== 'true') {
        safeFocus(rowEl);
        return;
      }
    }
    safeFocus(catalogSearchEl);
  }

  /**
   * 打开课程目录浮层。
   * @param {HTMLElement|null} trigger 关闭后归还焦点
   */
  function openCatalog(trigger) {
    if (!catalogOverlayEl) {
      return;
    }
    // 目录模块缺失（文件被拦截 / 版本不匹配）时退回原来的单个添加，功能不中断
    if (!Array.isArray(CAT.CATALOG) || typeof CAT.filterEntries !== 'function') {
      showNotice('课程目录模块未能加载，已改为手动填写。');
      openForm(null, trigger || btnAddEl);
      return;
    }
    // 防重入：已经在打开态时不得再次加锁 / 压栈，否则滚动锁会失衡
    if (catalogOverlayEl.classList.contains('is-open')) {
      return;
    }
    catalogState.trigger = trigger || null;
    catalogState.busy = false;
    catalogState.query = '';
    catalogState.category = CAT.CATEGORY_ALL;
    catalogState.selected = {};
    if (catalogSearchEl) {
      catalogSearchEl.value = '';
    }
    catalogState.keys = buildCatalogKeys();

    buildCatalogChips();
    renderCatalog();
    setCatalogStatus('');

    showOverlay(catalogOverlayEl);
    pushDialog(catalogSheetEl, requestCloseCatalog);
    lockBodyScroll();
    // 撤销提示要抬到底部操作条上方，否则会压住「添加所选」（高度实测，同互换操作条的做法）
    document.body.setAttribute('data-catalog', 'on');
    if (catalogFooterEl) {
      document.body.style.setProperty('--catalog-foot-h', catalogFooterEl.offsetHeight + 'px');
    }

    safeFocus(catalogSearchEl || catalogCloseEl);
    catalogState.openedAt = Date.now();
  }

  /**
   * 关闭课程目录浮层。
   * @param {boolean} restoreFocus 是否把焦点还给触发按钮
   */
  function closeCatalog(restoreFocus) {
    if (!catalogOverlayEl || !catalogOverlayEl.classList.contains('is-open')) {
      return;
    }
    popDialog(catalogSheetEl);
    hideOverlay(catalogOverlayEl);
    unlockBodyScroll();
    document.body.removeAttribute('data-catalog');
    document.body.style.removeProperty('--catalog-foot-h');
    // 防御：浮层关掉后若已没有任何对话框，滚动锁必须归零
    if (dialogStack.length === 0 && scrollLockDepth !== 0) {
      scrollLockDepth = 0;
      releaseBodyScroll();
    }
    var trigger = catalogState.trigger;
    catalogState.trigger = null;
    catalogState.busy = false;
    catalogState.selected = {};
    catalogState.rowEls = {};
    if (restoreFocus) {
      restoreFocusAfterDialog(trigger);
    }
  }

  /**
   * Esc / 关闭按钮：目录没有未保存内容，直接关。
   */
  function requestCloseCatalog() {
    closeCatalog(true);
  }

  /**
   * 「手动填写」：退出目录，走原有的单个添加表单（行为与改造前完全一致）。
   */
  function openFormFromCatalog() {
    closeCatalog(false);
    openForm(null, btnAddEl);
  }

  /**
   * 目录行点击：已添加的行只提示原因，其余切换勾选。
   * @param {MouseEvent} event
   */
  function handleCatalogListClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var rowEl = target.closest('[data-catalog-id]');
    if (!rowEl) {
      return;
    }
    var id = rowEl.getAttribute('data-catalog-id') || '';
    if (!id) {
      return;
    }
    if (rowEl.getAttribute('aria-disabled') === 'true') {
      var entry = CAT.findEntry(id);
      if (entry) {
        announce('「' + entry.name + '」已经在课表里了');
      }
      return;
    }
    toggleCatalogPick(id);
  }

  /**
   * 目录行键盘：空格切换、Enter 提交（与需求约定的键盘模型一致）。
   * @param {KeyboardEvent} event
   */
  function handleCatalogListKeydown(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var rowEl = target.closest('[data-catalog-id]');
    if (!rowEl) {
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      toggleCatalogPick(rowEl.getAttribute('data-catalog-id') || '');
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submitCatalogSelection();
    }
  }

  /**
   * 单门连续添加的撤销（5 秒，单条通道）。
   * 与「删除撤销」方向相反：这里撤销的是「刚加进来的一门」，所以按 id 移除。
   * @param {Object} course 刚写入的课程记录
   * @param {string} catalogId 对应的目录条目 id（撤销后把该行退回可勾选）
   */
  function showCatalogUndoToast(course, catalogId) {
    clearUndo();
    pendingUndo = { type: 'catalog-add', courseId: course.id, catalogId: catalogId, name: course.name };
    showToast('已添加「' + course.name + '」', {
      showUndo: true,
      timeoutMs: UNDO_TIMEOUT_MS,
      onTimeout: function () {
        pendingUndo = null;
      }
    });
  }

  /**
   * 撤销「刚通过目录添加的一门课」。
   */
  function undoCatalogAdd() {
    var courseId = pendingUndo && pendingUndo.courseId;
    var catalogId = pendingUndo && pendingUndo.catalogId;
    if (!courseId) {
      return;
    }
    var previous = state.courses;
    var kept = [];
    var removed = null;
    for (var i = 0; i < previous.length; i += 1) {
      if (previous[i].id === courseId) {
        removed = previous[i];
      } else {
        kept.push(previous[i]);
      }
    }
    if (!removed) {
      clearUndo();
      hideUndoToast();
      return;
    }
    state.courses = kept;
    if (!persistCourses()) {
      // 写库失败：内存恢复成撤销前，保证「界面 = 库里」
      state.courses = previous;
      clearUndo();
      hideUndoToast();
      render();
      announce('撤销失败，课程仍然保留');
      return;
    }
    clearUndo();
    render();
    hideUndoToast();

    // 目录还开着的话，把这一行退回「可勾选」
    if (catalogOverlayEl && catalogOverlayEl.classList.contains('is-open')) {
      syncCatalogAfterExternalChange();
      if (catalogId) {
        var rowEl = catalogState.rowEls[catalogId];
        if (rowEl) {
          safeFocus(rowEl);
        }
      }
    }
    announce('已撤销添加：' + removed.name);
  }

  /**
   * 「添加所选」：勾选的目录条目一次写入课表。
   *
   * 四条不可让步的约束：
   *   1. **读-改-写**：判重键与合并基线都取自「存储里的最新快照」而不是内存。
   *      课程键是整包覆盖写（writeStore 只写 {version, courses}），
   *      拿内存拼接会把另一个标签页刚写进去的课整批抹掉 —— 这是数据丢失级 bug。
   *   2. 提交前**再判重一次**（勾选期间状态可能已变，例如另一个标签页加了同一门课）；
   *   3. 写库失败必须回滚内存（回到存储里的样子）+ 保留勾选，绝不假装成功；
   *   4. 只有「回读校验通过」才算成功（与拍照导入同一套落盘校验）。
   */
  function submitCatalogSelection() {
    if (catalogState.busy) {
      return;
    }
    var ids = selectedCatalogIds();
    if (ids.length === 0) {
      announce('请先勾选要添加的课程');
      return;
    }

    // ★ 读-改-写：基线取自存储（存储不可读时才退回内存副本）。
    //   判重必须基于这份最新快照，否则跨标签页会互相覆盖。
    var fresh = readCoursesSnapshot();
    // 写失败的回滚目标 = 写之前的内存状态（正常情况下与 fresh 内容一致）
    var previousMemory = state.courses;
    catalogState.keys = CAT.buildKeySet(fresh);

    var entries = [];
    var alreadyAdded = [];
    var invalid = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var entry = CAT.findEntry(ids[i]);
      if (!entry) {
        continue;
      }
      if (CAT.isDuplicate(entry, catalogState.keys)) {
        alreadyAdded.push(entry.id);
        continue;
      }
      var values = {
        name: String(entry.name || '').trim(),
        weekday: clampWeekday(entry.weekday),
        startTime: normalizeTimeString(entry.startTime),
        endTime: normalizeTimeString(entry.endTime),
        teacher: String(entry.teacher || '').trim(),
        place: String(entry.place || '').trim(),
        note: ''
      };
      if (validateCourseValues(values).length > 0) {
        invalid += 1;
        continue;
      }
      entries.push({ entry: entry, values: values });
    }

    // 已被别处加过的：行立刻变「已添加」，勾选撤掉（这不是失败，是状态同步）
    if (alreadyAdded.length > 0) {
      markCatalogRowsAdded(alreadyAdded);
      updateCatalogFooter();
    }

    if (entries.length === 0) {
      var onlyText = alreadyAdded.length > 0
        ? '所选课程都已经在课表里了'
        : '所选课程信息不完整，无法添加';
      showInfoToast(onlyText);
      announce(onlyText);
      return;
    }

    var batchId = createId();
    var now = Date.now();
    var records = [];
    // 冲突只统计不拦截（应用本就支持同星期重叠课并排显示），但要分两个口径说清：
    //   · 与已有课程重叠 —— 跨批次，用户可能没意识到今天已经排了课；
    //   · 本批内部互相重叠 —— 一次勾了两门同段选修，摘要里必须点明。
    var conflictWithExisting = 0;
    var conflictInBatch = 0;
    var batchEntries = [];
    for (var b = 0; b < entries.length; b += 1) {
      batchEntries.push(entries[b].entry);
    }
    for (var j = 0; j < entries.length; j += 1) {
      if (CAT.hasConflict(entries[j].entry, fresh)) {
        conflictWithExisting += 1;
      }
      var others = [];
      for (var o = 0; o < batchEntries.length; o += 1) {
        if (o !== j) {
          others.push(batchEntries[o]);
        }
      }
      if (CAT.hasConflict(entries[j].entry, others)) {
        conflictInBatch += 1;
      }
      records.push(
        buildCourseRecord(entries[j].values, {
          source: 'manual',
          importBatchId: batchId,
          now: now
        })
      );
    }

    catalogState.busy = true;
    updateCatalogFooter();

    // 写 merged（= 存储快照 + 本批记录），绝不写「旧内存 + 本批」
    var merged = fresh.concat(records);
    state.courses = merged;

    var writeResult = writeStore(merged);
    var verified = false;
    if (writeResult.ok) {
      var wanted = {};
      for (var k = 0; k < records.length; k += 1) {
        wanted[records[k].id] = true;
      }
      var reloaded = readStore();
      for (var v = 0; v < reloaded.courses.length; v += 1) {
        if (wanted[reloaded.courses[v].id]) {
          verified = true;
          break;
        }
      }
    }

    if (!writeResult.ok || !verified) {
      // 回滚内存与界面：库里没有的东西，界面上也不许有；勾选原样保留。
      // 回滚到 fresh（= 写之前存储里的内容），内存与库始终一致；
      // 存储不可读时 readCoursesSnapshot 返回的就是内存副本，此时等价于原地回滚。
      state.courses = fresh === previousMemory ? previousMemory : fresh;
      catalogState.busy = false;
      render();
      updateCatalogFooter();
      var reason = writeResult.ok
        ? '写入后回读校验失败（数据未真正落盘）'
        : '本地存储写入失败（可能空间已满或被禁用）';
      setCatalogStatus('添加失败，已回滚，勾选已保留');
      showInfoToast('添加失败：' + reason + '，已回滚，勾选已保留');
      announce('添加失败，已回滚，勾选已保留');
      return;
    }

    catalogState.busy = false;
    catalogState.keys = buildCatalogKeys();

    var addedIds = [];
    for (var m = 0; m < entries.length; m += 1) {
      addedIds.push(entries[m].entry.id);
    }
    var focusedRow =
      document.activeElement && document.activeElement.getAttribute
        ? document.activeElement.getAttribute('data-catalog-id')
        : '';
    markCatalogRowsAdded(addedIds);
    catalogState.selected = {};
    renderCatalog();

    // 课表 / 清单立即重渲染
    render();

    if (focusedRow && addedIds.indexOf(focusedRow) >= 0) {
      focusNextCatalogRow(focusedRow);
    }

    var text = '已添加 ' + records.length + ' 门课程';
    if (conflictWithExisting > 0) {
      text += '，' + conflictWithExisting + ' 门与已有课程时间重叠';
    }
    if (conflictInBatch > 0) {
      text += '，其中本批 ' + conflictInBatch + ' 门互相重叠';
    }
    if (alreadyAdded.length > 0) {
      text += '，' + alreadyAdded.length + ' 门已存在已跳过';
    }
    if (invalid > 0) {
      text += '，' + invalid + ' 门信息不完整已跳过';
    }

    if (records.length > 1) {
      // 批量：收起浮层 + 10 秒整批撤销（与拍照导入共用同一个 importBatchId 通道）
      var trigger = catalogState.trigger;
      closeCatalog(false);
      showImportUndoToast(text, batchId, records.length);
      announce(text + '。10 秒内可撤销。');
      restoreFocusAfterDialog(trigger || btnAddEl);
      return;
    }

    // 单门：浮层不关闭，方便接着挑下一门；撤销走单条通道（5 秒）
    showCatalogUndoToast(records[0], addedIds[0]);
    // 完整摘要（含重叠加「N 门已跳过」）留在操作条上方，不随 5 秒提示消失
    setCatalogStatus(text + '，5 秒内可撤销');
    announce(text + '。5 秒内可撤销，可继续勾选下一门。');
  }

  /* ==================== 十九、事件绑定 ==================== */

  /**
   * 缓存所有 DOM 引用。
   */
  function cacheDomRefs() {
    courseSummaryEl = document.getElementById('course-summary');
    courseListEl = document.getElementById('course-list');
    emptyStateEl = document.getElementById('empty-state');
    btnAddEl = document.getElementById('btn-add');
    btnAddEmptyEl = document.getElementById('btn-add-empty');

    timetableViewEl = document.getElementById('timetable-view');
    timetableScrollEl = document.getElementById('timetable');
    unscheduledEl = document.getElementById('unscheduled');
    unscheduledListEl = document.getElementById('unscheduled-list');
    viewTabGridEl = document.getElementById('view-tab-grid');
    viewTabListEl = document.getElementById('view-tab-list');
    btnTodayEl = document.getElementById('btn-today');
    btnCameraEl = document.getElementById('btn-camera');
    btnCameraEmptyEl = document.getElementById('btn-camera-empty');
    btnCameraEmptyLabelEl = document.getElementById('btn-camera-empty-label');
    btnMoreEl = document.getElementById('btn-more');
    moreMenuEl = document.getElementById('more-menu');
    btnSwapEl = document.getElementById('btn-swap');
    btnLogEl = document.getElementById('btn-log');
    todayBarEl = document.getElementById('today-bar');
    todayBarTextEl = document.getElementById('today-bar-text');

    todayOverlayEl = document.getElementById('today-overlay');
    todaySheetEl = document.getElementById('today-sheet');
    todayTitleEl = document.getElementById('today-title');
    todayBodyEl = document.getElementById('today-body');
    todayCloseEl = document.getElementById('today-close');
    todayDoneEl = document.getElementById('today-done');

    ttModeEl = document.querySelector('.tt-mode');
    ttModeWeekEl = document.getElementById('tt-mode-week');
    ttModeDayEl = document.getElementById('tt-mode-day');
    ttDaysEl = document.getElementById('tt-days');
    ttHintEl = document.getElementById('tt-hint');

    swapBarEl = document.getElementById('swap-bar');
    swapBarStatusEl = document.getElementById('swap-bar-status');
    swapBarDetailEl = document.getElementById('swap-bar-detail');
    swapExitEl = document.getElementById('swap-exit');
    swapConfirmEl = document.getElementById('swap-confirm');

    logOverlayEl = document.getElementById('log-overlay');
    logSheetEl = document.getElementById('log-sheet');
    logCloseEl = document.getElementById('log-close');
    logDoneEl = document.getElementById('log-done');
    logClearEl = document.getElementById('log-clear');
    logCountEl = document.getElementById('log-count');
    logNoticeEl = document.getElementById('log-notice');
    logEmptyEl = document.getElementById('log-empty');
    logGroupsEl = document.getElementById('log-groups');

    assistantBarEl = document.getElementById('assistant-bar');
    assistantTextEl = document.getElementById('assistant-text');
    assistantContinueEl = document.getElementById('assistant-continue');
    assistantDismissEl = document.getElementById('assistant-dismiss');

    noticeEl = document.getElementById('storage-notice');
    noticeTextEl = noticeEl ? noticeEl.querySelector('.notice__text') : null;
    noticeCloseEl = document.getElementById('notice-close');

    detailOverlayEl = document.getElementById('detail-overlay');
    detailSheetEl = document.getElementById('detail-sheet');
    detailTitleEl = document.getElementById('detail-title');
    detailBodyEl = document.getElementById('detail-body');
    detailCloseEl = document.getElementById('detail-close');
    detailEditEl = document.getElementById('detail-edit');
    detailDeleteEl = document.getElementById('detail-delete');

    formOverlayEl = document.getElementById('form-overlay');
    sheetEl = document.getElementById('form-sheet');
    formTitleEl = document.getElementById('form-title');
    formEl = document.getElementById('course-form');
    formCloseEl = document.getElementById('form-close');
    formCancelEl = document.getElementById('form-cancel');
    formImportEl = document.getElementById('form-import');
    nameInput = document.getElementById('field-name');
    weekdaySelect = document.getElementById('field-weekday');
    startInput = document.getElementById('field-start');
    endInput = document.getElementById('field-end');
    teacherInput = document.getElementById('field-teacher');
    placeInput = document.getElementById('field-place');
    noteInput = document.getElementById('field-note');
    noteCounterEl = document.getElementById('note-counter');
    colorPickerEl = document.getElementById('color-picker');
    errorNameEl = document.getElementById('error-name');
    errorTimeEl = document.getElementById('error-time');

    catalogOverlayEl = document.getElementById('catalog-overlay');
    catalogSheetEl = document.getElementById('catalog-sheet');
    catalogFooterEl = document.getElementById('catalog-footer');
    catalogCloseEl = document.getElementById('catalog-close');
    catalogManualEl = document.getElementById('catalog-manual');
    catalogStatsEl = document.getElementById('catalog-stats');
    catalogSearchEl = document.getElementById('catalog-search');
    catalogChipsEl = document.getElementById('catalog-chips');
    catalogListEl = document.getElementById('catalog-list');
    catalogEmptyEl = document.getElementById('catalog-empty');
    catalogCountEl = document.getElementById('catalog-selected-count');
    catalogClearEl = document.getElementById('catalog-clear');
    catalogAddEl = document.getElementById('catalog-add');
    catalogStatusEl = document.getElementById('catalog-status');

    importOverlayEl = document.getElementById('import-overlay');
    importSheetEl = document.getElementById('import-sheet');
    importCloseEl = document.getElementById('import-close');
    importCancelEl = document.getElementById('import-cancel');
    importConfirmEl = document.getElementById('import-confirm');
    importPickEl = document.getElementById('import-pick');
    importCameraPickEl = document.getElementById('import-camera-pick');
    importFileEl = document.getElementById('import-file');
    importCameraEl = document.getElementById('import-camera');
    importRunEl = document.getElementById('import-run');
    importCancelRunEl = document.getElementById('import-cancel-run');
    importDropzoneEl = document.getElementById('import-dropzone');
    importThumbsEl = document.getElementById('import-thumbs');
    importStatusEl = document.getElementById('import-status');
    importWarningsEl = document.getElementById('import-warnings');
    importCandidatesEl = document.getElementById('import-candidates');
    importBulkEl = document.getElementById('import-bulk');
    importBulkTitleEl = document.getElementById('import-bulk-title');
    importBulkWeekdayEl = document.getElementById('import-bulk-weekday');
    importBulkPeriodStartEl = document.getElementById('import-bulk-period-start');
    importBulkPeriodEndEl = document.getElementById('import-bulk-period-end');
    importBulkAllEl = document.getElementById('import-bulk-all');
    importBulkNoneEl = document.getElementById('import-bulk-none');

    confirmOverlayEl = document.getElementById('confirm-overlay');
    confirmDialogEl = document.getElementById('confirm-dialog');
    confirmTitleEl = document.getElementById('confirm-title');
    confirmMessageEl = document.getElementById('confirm-message');
    confirmOkEl = document.getElementById('confirm-ok');
    confirmCancelEl = document.getElementById('confirm-cancel');

    undoToastEl = document.getElementById('undo-toast');
    undoToastTextEl = document.getElementById('undo-toast-text');
    undoButtonEl = document.getElementById('undo-button');

    liveRegionEl = document.getElementById('live-region');

    /* ---- 栏目（旅游 / 任务）---- */
    appTitleEl = document.getElementById('app-title');
    btnAddLabelEl = document.getElementById('btn-add-label');
    viewTabTripsEl = document.getElementById('view-tab-trips');
    viewTabTasksEl = document.getElementById('view-tab-tasks');

    dateBarEl = document.getElementById('date-bar');
    dateInputEl = document.getElementById('date-input');
    datePrevEl = document.getElementById('date-prev');
    dateNextEl = document.getElementById('date-next');
    dateTodayEl = document.getElementById('date-today');
    dateClearEl = document.getElementById('date-clear');
    btnSettingsEl = document.getElementById('btn-settings');
    btnRingtoneEl = document.getElementById('btn-ringtone');
    ringtoneOverlayEl = document.getElementById('ringtone-overlay');
    ringtoneSheetEl = document.getElementById('ringtone-sheet');
    ringtoneListEl = document.getElementById('ringtone-list');
    ringtoneCurrentNameEl = document.getElementById('ringtone-current-name');
    ringtoneCurrentPlayEl = document.getElementById('ringtone-current-play');
    ringtoneHintEl = document.getElementById('ringtone-hint');
    ringtoneSaveEl = document.getElementById('ringtone-save');
    ringtoneCancelEl = document.getElementById('ringtone-cancel');
    ringtoneCloseEl = document.getElementById('ringtone-close');

    tasksViewEl = document.getElementById('tasks-view');
    tasksListEl = document.getElementById('tasks-list');
    tasksEmptyEl = document.getElementById('tasks-empty');
    tasksEmptyTitleEl = document.getElementById('tasks-empty-title');
    tasksEmptyDescEl = document.getElementById('tasks-empty-desc');
    tasksEmptyAddEl = document.getElementById('tasks-empty-add');

    tripsViewEl = document.getElementById('trips-view');
    tripsListEl = document.getElementById('trips-list');
    tripsEmptyEl = document.getElementById('trips-empty');
    tripsEmptyTitleEl = document.getElementById('trips-empty-title');
    tripsEmptyDescEl = document.getElementById('trips-empty-desc');
    tripsEmptyAddEl = document.getElementById('trips-empty-add');
    tripsEmptyAddLabelEl = document.getElementById('trips-empty-add-label');
    tripsEmptyHintEl = document.getElementById('trips-empty-hint');

    /* ---- 新增 / 编辑浮层（任务 + 行程）---- */
    itemOverlayEl = document.getElementById('item-overlay');
    itemSheetEl = document.getElementById('item-sheet');
    itemTitleEl = document.getElementById('item-title');
    itemTitleLabelEl = document.getElementById('item-title-label');
    itemFormEl = document.getElementById('item-form');
    itemCloseEl = document.getElementById('item-close');
    itemCancelEl = document.getElementById('item-cancel');
    itemDeleteEl = document.getElementById('item-delete');
    itemTitleInput = document.getElementById('item-field-title');
    itemDateInput = document.getElementById('item-field-date');
    itemStartInput = document.getElementById('item-field-start');
    itemRemindInput = document.getElementById('item-field-remind');
    itemErrorRemindEl = document.getElementById('item-error-remind');
    itemRemindHintEl = document.getElementById('item-remind-hint');
    reminderStackEl = document.getElementById('reminder-stack');
    btnNotifyEl = document.getElementById('btn-notify');
    itemEndInput = document.getElementById('item-field-end');
    itemDestinationInput = document.getElementById('item-field-destination');
    itemStartDateInput = document.getElementById('item-field-start-date');
    itemEndDateInput = document.getElementById('item-field-end-date');
    itemStatusSelect = document.getElementById('item-field-status');
    itemNoteInput = document.getElementById('item-field-note');
    itemNoteCounterEl = document.getElementById('item-note-counter');
    itemErrorTitleEl = document.getElementById('item-error-title');
    itemErrorDateEl = document.getElementById('item-error-date');
    itemErrorTimeEl = document.getElementById('item-error-time');
    itemErrorTripDateEl = document.getElementById('item-error-trip-date');

    /* ---- 显示设置浮层 ---- */
    displayOverlayEl = document.getElementById('display-overlay');
    displaySheetEl = document.getElementById('display-sheet');
    displayTitleEl = document.getElementById('display-title');
    displayCloseEl = document.getElementById('display-close');
    displayDoneEl = document.getElementById('display-done');
    displayNoteEl = document.getElementById('display-note');
    displaySettingsEl = document.getElementById('display-settings');
  }

  /**
   * 事件委托：卡片上的编辑 / 删除按钮（清单与「未设置时间」共用）。
   * @param {MouseEvent} event
   */
  function handleListClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    // 互换模式下点卡片 = 选中 / 取消选中，绝不打开编辑对话框
    if (swapState.active) {
      var swapCard = target.closest('.card[data-course-id]');
      if (swapCard) {
        toggleSwapPick(swapCard.getAttribute('data-course-id') || '');
      }
      return;
    }
    var button = target.closest('button[data-action]');
    if (!button) {
      return;
    }
    var card = button.closest('.card');
    if (!card) {
      return;
    }
    var courseId = card.getAttribute('data-course-id');
    if (!courseId) {
      return;
    }
    var action = button.getAttribute('data-action');
    if (action === 'edit') {
      var course = findCourseById(courseId);
      if (course) {
        openForm(course, button);
      }
    } else if (action === 'delete') {
      requestDelete(courseId);
    }
  }

  /**
   * 事件委托：课表块点击 → 打开详情。
   * @param {MouseEvent} event
   */
  function handleTimetableClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    // 整周模式是 .tt-block，按天模式是 .td-block；两者的点击语义一致
    var block = target.closest('.tt-block, .td-block');
    if (!block) {
      return;
    }
    var courseId = block.getAttribute('data-course-id');
    if (!courseId) {
      return;
    }
    // 互换模式下点课程块 = 选中 / 取消选中，不打开详情
    if (swapState.active) {
      toggleSwapPick(courseId);
      return;
    }
    openDetail(courseId, block);
  }

  /**
   * 顶栏主按钮：文案随栏目变化，行为也跟着变
   * （课程 → 课程目录 / 任务 → 任务表单 / 旅游 → 行程表单）。
   * 课程走「先看目录」这条路：勾选批量添加比一门一门手填快得多，
   * 手动填写仍然保留在目录浮层右上角（openFormFromCatalog）。
   * @param {HTMLElement|null} trigger
   */
  function handleAddClick(trigger) {
    if (state.view === 'tasks') {
      openItemForm('task', null, trigger || btnAddEl);
      return;
    }
    if (state.view === 'trips') {
      openItemForm('trip', null, trigger || btnAddEl);
      return;
    }
    openCatalog(trigger || btnAddEl);
  }

  /**
   * 事件委托：任务行的两个按钮（互不嵌套）。
   * 勾选按钮 → 切换完成态；整行主体 → 打开编辑浮层。
   * @param {MouseEvent} event
   */
  function handleTasksListClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var row = target.closest('.row[data-task-id]');
    if (!row) {
      return;
    }
    var taskId = row.getAttribute('data-task-id') || '';
    if (!taskId) {
      return;
    }
    if (target.closest('.row__check')) {
      toggleTaskDone(taskId);
      return;
    }
    var main = target.closest('.row__main');
    if (!main) {
      return;
    }
    var task = findTaskById(taskId);
    if (task) {
      openItemForm('task', task, main);
    }
  }

  /**
   * 事件委托：行程行只有一个可交互元素，点整行 = 打开编辑浮层。
   * @param {MouseEvent} event
   */
  function handleTripsListClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    var row = target.closest('.row[data-trip-id]');
    if (!row) {
      return;
    }
    var tripId = row.getAttribute('data-trip-id') || '';
    if (!tripId) {
      return;
    }
    var main = target.closest('.row__main');
    if (!main) {
      return;
    }
    var trip = findTripById(tripId);
    if (trip) {
      openItemForm('trip', trip, main);
    }
  }

  /**
   * 绑定全部事件。
   */
  function bindEvents() {
    if (btnAddEl) {
      btnAddEl.addEventListener('click', function () {
        handleAddClick(btnAddEl);
      });
    }
    if (btnAddEmptyEl) {
      btnAddEmptyEl.addEventListener('click', function () {
        // 空状态 CTA 与顶栏一致：先打开课程目录（手动填写在目录里）
        openCatalog(btnAddEmptyEl);
      });
    }
    if (noticeCloseEl) {
      noticeCloseEl.addEventListener('click', hideNotice);
    }

    // 视图切换
    if (viewTabGridEl) {
      viewTabGridEl.addEventListener('click', function () {
        setView('grid');
      });
    }
    if (viewTabListEl) {
      viewTabListEl.addEventListener('click', function () {
        setView('list');
      });
    }
    if (viewTabTripsEl) {
      viewTabTripsEl.addEventListener('click', function () {
        setView('trips');
      });
    }
    if (viewTabTasksEl) {
      viewTabTasksEl.addEventListener('click', function () {
        setView('tasks');
      });
    }
    if (btnTodayEl) {
      btnTodayEl.addEventListener('click', function () {
        // 更多菜单是浮层入口，关闭后焦点回到「更多」按钮本身
        var trigger = btnMoreEl || btnTodayEl;
        closeMoreMenu(false);
        openTodayPanel(trigger);
      });
    }
    // 拍照：主行动。桌面上 capture 被忽略，退化为文件选择器（不做 UA 分支）
    if (btnCameraEl) {
      btnCameraEl.addEventListener('click', function () {
        closeMoreMenu(false);
        openCamera(btnCameraEl);
      });
    }
    if (btnCameraEmptyEl) {
      btnCameraEmptyEl.addEventListener('click', function () {
        var ready = Boolean(
          window.CourseImport &&
            typeof window.CourseImport.isReady === 'function' &&
            window.CourseImport.isReady()
        );
        if (ready) {
          openCamera(btnCameraEmptyEl);
          return;
        }
        // 未配置：不进拍照，直接展开设置区并聚焦第一个空字段
        openImport(btnCameraEmptyEl, 'toolbar');
        window.setTimeout(focusConfigFirstEmpty, prefersReducedMotion() ? 0 : 60);
      });
    }
    if (btnMoreEl) {
      btnMoreEl.addEventListener('click', function (event) {
        event.stopPropagation();
        if (moreMenuOpen) {
          closeMoreMenu(true);
        } else {
          openMoreMenu();
        }
      });
    }
    if (moreMenuEl) {
      moreMenuEl.addEventListener('keydown', handleMenuKeydown);
    }
    if (todayBarEl) {
      todayBarEl.addEventListener('click', handleTodayBarClick);
    }

    // 今日面板：点课程打开详情，点勾选框切换完成态（事件委托）
    if (todayBodyEl) {
      todayBodyEl.addEventListener('click', handleTodayPanelClick);
    }
    if (todayCloseEl) {
      todayCloseEl.addEventListener('click', function () {
        closeTodayPanel(true);
      });
    }
    if (todayDoneEl) {
      todayDoneEl.addEventListener('click', function () {
        closeTodayPanel(true);
      });
    }

    // 课表显示方式（整周 / 按天）+ 星期 chips
    if (ttModeEl) {
      ttModeEl.addEventListener('click', handleTimetableModeClick);
    }
    if (ttDaysEl) {
      ttDaysEl.addEventListener('click', handleTimetableDaysClick);
      ttDaysEl.addEventListener('keydown', handleTimetableDaysKeydown);
    }
    if (timetableScrollEl) {
      timetableScrollEl.addEventListener('scroll', handleTimetableScroll, { passive: true });
    }
    // 视口变化：用户没手动选过显示方式时按宽度重新取默认值（防抖 150ms）
    window.addEventListener('resize', scheduleViewportChange);
    // 部分浏览器旋转屏幕时只发 matchMedia 的 change、不发 resize，两条都接上更稳
    if (typeof window.matchMedia === 'function') {
      try {
        var modeQuery = window.matchMedia(TT_DAY_QUERY);
        if (modeQuery && typeof modeQuery.addEventListener === 'function') {
          modeQuery.addEventListener('change', scheduleViewportChange);
        } else if (modeQuery && typeof modeQuery.addListener === 'function') {
          modeQuery.addListener(scheduleViewportChange);
        }
      } catch (err) {
        /* 老环境不支持监听视口查询时，只靠 resize 兜底 */
      }
    }

    // 互换模式
    if (btnSwapEl) {
      btnSwapEl.addEventListener('click', function () {
        closeMoreMenu(false);
        if (swapState.active) {
          exitSwapMode();
          announce('已退出互换模式');
          return;
        }
        enterSwapMode();
      });
    }
    if (swapExitEl) {
      swapExitEl.addEventListener('click', function () {
        var hadPick = swapState.picked.length > 0;
        exitSwapMode();
        announce(hadPick ? '已退出互换模式，选择已清空' : '已退出互换模式');
      });
    }
    if (swapConfirmEl) {
      swapConfirmEl.addEventListener('click', handleSwapConfirm);
    }

    // 视口变化会让操作条的明细重新折行 → 重新测量高度，保证底部留白仍然够
    window.addEventListener('resize', function () {
      if (!swapState.active) {
        return;
      }
      if (swapMetricsTimerId !== null) {
        window.clearTimeout(swapMetricsTimerId);
      }
      swapMetricsTimerId = window.setTimeout(function () {
        swapMetricsTimerId = null;
        syncSwapBarMetrics();
      }, 120);
    });

    // 工作日志
    if (btnLogEl) {
      btnLogEl.addEventListener('click', function () {
        // 先把菜单收起（否则返回值焦点会落在隐藏的菜单项上），trigger 用可见的「更多」按钮
        var trigger = btnMoreEl || btnLogEl;
        closeMoreMenu(false);
        openLog(trigger);
      });
    }
    if (logCloseEl) {
      logCloseEl.addEventListener('click', function () {
        closeLog(true);
      });
    }
    if (logDoneEl) {
      logDoneEl.addEventListener('click', function () {
        closeLog(true);
      });
    }
    if (logClearEl) {
      logClearEl.addEventListener('click', requestClearLog);
    }
    if (logOverlayEl) {
      logOverlayEl.addEventListener('click', function (event) {
        if (event.target !== logOverlayEl) {
          return;
        }
        if (Date.now() - logOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        closeLog(true);
      });
    }

    // ---- 栏目：日期条（前 / 后一天、原生日期输入、今天 / 全部）----
    // 任务与旅游共用同一个控件，处理函数按 state.view 分派
    if (datePrevEl) {
      datePrevEl.addEventListener('click', function () {
        shiftCurrentDate(-1);
      });
    }
    if (dateNextEl) {
      dateNextEl.addEventListener('click', function () {
        shiftCurrentDate(1);
      });
    }
    if (dateTodayEl) {
      dateTodayEl.addEventListener('click', goCurrentToday);
    }
    if (dateClearEl) {
      dateClearEl.addEventListener('click', clearCurrentDateFilter);
    }
    if (dateInputEl) {
      // change 为主：桌面手动键入时 input 事件过于频繁，且 iOS 原生滚轮只派发 change
      dateInputEl.addEventListener('change', handleDateInputChange);
    }

    // ---- 栏目：任务列表（事件委托：勾选 / 整行编辑）----
    if (tasksListEl) {
      tasksListEl.addEventListener('click', handleTasksListClick);
    }
    if (tasksEmptyAddEl) {
      tasksEmptyAddEl.addEventListener('click', function () {
        openItemForm('task', null, tasksEmptyAddEl);
      });
    }

    // ---- 栏目：行程列表（只有整行一个可交互元素）----
    if (tripsListEl) {
      tripsListEl.addEventListener('click', handleTripsListClick);
    }
    if (tripsEmptyAddEl) {
      tripsEmptyAddEl.addEventListener('click', function () {
        openItemForm('trip', null, tripsEmptyAddEl);
      });
    }

    // ---- 显示设置 ----
    if (btnSettingsEl) {
      btnSettingsEl.addEventListener('click', function () {
        // 先把菜单收起（否则焦点归还会落在隐藏的菜单项上），trigger 用常驻的「更多」
        var trigger = btnMoreEl || btnSettingsEl;
        closeMoreMenu(false);
        openSettings(trigger);
      });
    }
    if (displayCloseEl) {
      displayCloseEl.addEventListener('click', function () {
        closeSettings(true);
      });
    }
    if (displayDoneEl) {
      displayDoneEl.addEventListener('click', function () {
        closeSettings(true);
      });
    }
    if (displayOverlayEl) {
      displayOverlayEl.addEventListener('click', function (event) {
        if (event.target !== displayOverlayEl) {
          return;
        }
        if (Date.now() - displayOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        closeSettings(true);
      });
    }

    // ---- 任务提醒：卡片动作（事件委托，卡片是动态生成的）----
    if (reminderStackEl) {
      reminderStackEl.addEventListener('click', handleReminderAction);
    }
    if (btnNotifyEl) {
      btnNotifyEl.addEventListener('click', function () {
        closeMoreMenu(false);
        requestNotifyPermission(false);
      });
    }
    // 填/清开始时间时，提醒下拉跟着可用/置灰
    if (itemStartInput) {
      itemStartInput.addEventListener('input', updateRemindAvailability);
      itemStartInput.addEventListener('change', updateRemindAvailability);
    }

    // ---- 铃声设置 ----
    if (btnRingtoneEl) {
      btnRingtoneEl.addEventListener('click', function () {
        var trigger = btnMoreEl || btnRingtoneEl;
        closeMoreMenu(false);
        openRingtone(trigger);
      });
    }
    if (ringtoneCloseEl) {
      ringtoneCloseEl.addEventListener('click', function () {
        closeRingtone(true);
      });
    }
    if (ringtoneCancelEl) {
      ringtoneCancelEl.addEventListener('click', function () {
        closeRingtone(true);
      });
    }
    if (ringtoneSaveEl) {
      ringtoneSaveEl.addEventListener('click', saveRingtone);
    }
    if (ringtoneCurrentPlayEl) {
      ringtoneCurrentPlayEl.addEventListener('click', function () {
        previewRingtone(ringtoneDraftId);
      });
    }
    if (ringtoneListEl) {
      // 事件委托：选择区与试听按钮是兄弟节点，用 closest 分辨点击目标
      ringtoneListEl.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') {
          return;
        }
        var li = target.closest('.ringtone');
        if (!li) {
          return;
        }
        var id = li.getAttribute('data-ringtone-id') || '';
        if (target.closest('[data-action="preview"]')) {
          previewRingtone(id);
          return;
        }
        if (target.closest('.ringtone__pick')) {
          selectRingtone(id);
        }
      });
      // radiogroup 的方向键：↑↓ 在铃声之间移动并选中（与原生 radio 的键盘约定一致）
      ringtoneListEl.addEventListener('keydown', function (event) {
        var key = event.key;
        if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowRight' && key !== 'ArrowLeft') {
          return;
        }
        var picks = ringtoneListEl.querySelectorAll('.ringtone__pick');
        if (!picks.length) {
          return;
        }
        var index = Array.prototype.indexOf.call(picks, event.target);
        if (index === -1) {
          return;
        }
        event.preventDefault();
        var step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
        var next = (index + step + picks.length) % picks.length;
        safeFocus(picks[next]);
        selectRingtone(picks[next].closest('.ringtone').getAttribute('data-ringtone-id') || '');
        safeFocus(picks[next]);
      });
    }
    if (ringtoneOverlayEl) {
      ringtoneOverlayEl.addEventListener('click', function (event) {
        if (event.target !== ringtoneOverlayEl) {
          return;
        }
        if (Date.now() - ringtoneOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        closeRingtone(true);
      });
    }

    // ---- 新增 / 编辑浮层（任务本轮；旅游下一轮复用）----
    if (itemCloseEl) {
      itemCloseEl.addEventListener('click', requestCloseItemForm);
    }
    if (itemCancelEl) {
      itemCancelEl.addEventListener('click', requestCloseItemForm);
    }
    if (itemDeleteEl) {
      itemDeleteEl.addEventListener('click', requestDeleteCurrentItem);
    }
    if (itemFormEl) {
      itemFormEl.addEventListener('submit', submitItemForm);
      itemFormEl.addEventListener('input', updateItemNoteCounter);
    }
    if (itemOverlayEl) {
      itemOverlayEl.addEventListener('click', function (event) {
        if (event.target !== itemOverlayEl) {
          return;
        }
        // 打开浮层的同一操作若连点到遮罩上，不视为「点遮罩关闭」
        if (Date.now() - itemOverlayOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        requestCloseItemForm();
      });
    }

    // ---- 课程目录（勾选批量添加）----
    if (catalogCloseEl) {
      catalogCloseEl.addEventListener('click', requestCloseCatalog);
    }
    if (catalogManualEl) {
      catalogManualEl.addEventListener('click', openFormFromCatalog);
    }
    if (catalogSearchEl) {
      // 即时过滤：只重建列表，焦点留在搜索框里
      catalogSearchEl.addEventListener('input', function () {
        catalogState.query = catalogSearchEl.value;
        renderCatalogList();
      });
    }
    if (catalogChipsEl) {
      catalogChipsEl.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') {
          return;
        }
        var chip = target.closest('[data-category]');
        if (!chip) {
          return;
        }
        catalogState.category = chip.getAttribute('data-category') || CAT.CATEGORY_ALL;
        renderCatalogChips();
        renderCatalogList();
      });
    }
    if (catalogListEl) {
      catalogListEl.addEventListener('click', handleCatalogListClick);
      catalogListEl.addEventListener('keydown', handleCatalogListKeydown);
    }
    if (catalogClearEl) {
      catalogClearEl.addEventListener('click', clearCatalogSelection);
    }
    if (catalogAddEl) {
      catalogAddEl.addEventListener('click', submitCatalogSelection);
    }
    if (catalogOverlayEl) {
      catalogOverlayEl.addEventListener('click', function (event) {
        if (event.target !== catalogOverlayEl) {
          return;
        }
        // 打开浮层的同一操作若连点到遮罩上，不视为「点遮罩关闭」
        if (Date.now() - catalogState.openedAt < OVERLAY_GUARD_MS) {
          return;
        }
        closeCatalog(true);
      });
    }

    // 排课助手
    if (assistantContinueEl) {
      assistantContinueEl.addEventListener('click', continueWithSuggestion);
    }
    if (assistantDismissEl) {
      assistantDismissEl.addEventListener('click', function () {
        hideAssistant();
        safeFocus(btnAddEl);
      });
    }

    // 表单
    if (formCloseEl) {
      formCloseEl.addEventListener('click', requestCloseForm);
    }
    if (formCancelEl) {
      formCancelEl.addEventListener('click', requestCloseForm);
    }
    if (formImportEl) {
      formImportEl.addEventListener('click', function () {
        // 与顶栏相机一致：同步触发 input.click()，拍完自动进导入面板
        openCamera(formImportEl);
      });
    }
    if (formOverlayEl) {
      formOverlayEl.addEventListener('click', function (event) {
        if (event.target !== formOverlayEl) {
          return;
        }
        // 打开面板的同一操作若连点到遮罩上，不视为“点遮罩关闭”
        if (Date.now() - overlayOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        requestCloseForm();
      });
    }
    if (formEl) {
      formEl.addEventListener('submit', handleSubmit);
      formEl.addEventListener('input', function () {
        updateNoteCounter();
        refreshErrors();
      });
      formEl.addEventListener('change', refreshErrors);
    }

    // 清单 / 未设置时间
    if (courseListEl) {
      courseListEl.addEventListener('click', handleListClick);
    }
    if (unscheduledListEl) {
      unscheduledListEl.addEventListener('click', handleListClick);
    }
    // 课表网格
    if (timetableScrollEl) {
      timetableScrollEl.addEventListener('click', handleTimetableClick);
    }

    // 课程详情
    if (detailCloseEl) {
      detailCloseEl.addEventListener('click', function () {
        closeDetail(true);
      });
    }
    if (detailOverlayEl) {
      detailOverlayEl.addEventListener('click', function (event) {
        if (event.target !== detailOverlayEl) {
          return;
        }
        if (Date.now() - detailOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        closeDetail(true);
      });
    }
    if (detailEditEl) {
      detailEditEl.addEventListener('click', function () {
        var course = findCourseById(detailCourseId);
        if (!course) {
          closeDetail(true);
          return;
        }
        var trigger = findGridBlock(course.id) || findCardElement(course.id) || btnAddEl;
        closeDetail(true);
        openForm(course, trigger);
      });
    }
    if (detailDeleteEl) {
      detailDeleteEl.addEventListener('click', function () {
        var courseId = detailCourseId;
        if (!courseId) {
          return;
        }
        // 先确认再关闭详情：取消时用户留在详情里，滚动锁 depth 也不会被提前解开
        askDeleteConfirm(courseId).then(function (confirmed) {
          if (!confirmed) {
            safeFocus(detailDeleteEl);
            return;
          }
          closeDetail(false);
          removeCourse(courseId);
        });
      });
    }

    // 图片导入
    if (importPickEl) {
      importPickEl.addEventListener('click', function () {
        if (importFileEl) {
          importFileEl.click();
        }
      });
    }
    if (importCameraPickEl) {
      importCameraPickEl.addEventListener('click', function () {
        openCamera(importCameraPickEl);
      });
    }
    if (importFileEl) {
      importFileEl.addEventListener('change', handleImportFileChange);
    }
    if (importCameraEl) {
      importCameraEl.addEventListener('change', handleCameraFileChange);
    }
    if (importCancelRunEl) {
      importCancelRunEl.addEventListener('click', cancelImportRecognition);
    }
    if (importBulkAllEl) {
      importBulkAllEl.addEventListener('click', function () {
        setAllCandidates(true);
      });
    }
    if (importBulkNoneEl) {
      importBulkNoneEl.addEventListener('click', function () {
        setAllCandidates(false);
      });
    }
    if (importBulkWeekdayEl) {
      importBulkWeekdayEl.addEventListener('change', function () {
        var value = importBulkWeekdayEl.value;
        if (!value) {
          return;
        }
        applyBulkEdit('weekday', value);
        importBulkWeekdayEl.value = '';
        safeFocus(importBulkWeekdayEl);
      });
    }
    if (importBulkPeriodStartEl) {
      importBulkPeriodStartEl.addEventListener('change', function () {
        if (!importBulkPeriodStartEl.value || !importBulkPeriodEndEl || !importBulkPeriodEndEl.value) {
          return;
        }
        applyBulkEdit('period', '');
        safeFocus(importBulkPeriodStartEl);
      });
    }
    if (importBulkPeriodEndEl) {
      importBulkPeriodEndEl.addEventListener('change', function () {
        if (!importBulkPeriodEndEl.value || !importBulkPeriodStartEl || !importBulkPeriodStartEl.value) {
          return;
        }
        applyBulkEdit('period', '');
        safeFocus(importBulkPeriodEndEl);
      });
    }
    if (importCandidatesEl) {
      var onCandidateEdit = function (event) {
        syncCandidatesFromDom();
        updateImportConfirm();
        // 正在编辑的那一行就地刷新摘要（不重建 DOM，焦点与滚动位置都不动）
        var target = event && event.target;
        var row = target && typeof target.closest === 'function' ? target.closest('.candidate') : null;
        if (row) {
          var index = Number(row.getAttribute('data-index'));
          updateCandidateSummaryDom(row, importState.candidates[index]);
        }
      };
      importCandidatesEl.addEventListener('input', onCandidateEdit);
      importCandidatesEl.addEventListener('change', onCandidateEdit);
      importCandidatesEl.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') {
          return;
        }
        var row = target.closest('.candidate');
        if (!row) {
          return;
        }
        var index = Number(row.getAttribute('data-index'));
        if (!isFinite(index)) {
          return;
        }
        var toggle = target.closest('[data-role="toggle"]');
        if (toggle) {
          toggleCandidate(index);
          return;
        }
        var remove = target.closest('[data-role="remove"]');
        if (remove) {
          removeCandidate(index);
        }
      });
    }
    if (importCloseEl) {
      importCloseEl.addEventListener('click', function () {
        closeImport(true);
      });
    }
    if (importCancelEl) {
      importCancelEl.addEventListener('click', function () {
        closeImport(true);
      });
    }
    if (importConfirmEl) {
      importConfirmEl.addEventListener('click', confirmImport);
    }
    if (importOverlayEl) {
      importOverlayEl.addEventListener('click', function (event) {
        if (event.target !== importOverlayEl) {
          return;
        }
        if (Date.now() - importOpenedAt < OVERLAY_GUARD_MS) {
          return;
        }
        closeImport(true);
      });
    }

    // 确认框
    if (confirmOkEl) {
      confirmOkEl.addEventListener('click', function () {
        settleConfirm(true);
      });
    }
    if (confirmCancelEl) {
      confirmCancelEl.addEventListener('click', function () {
        settleConfirm(false);
      });
    }
    if (confirmOverlayEl) {
      confirmOverlayEl.addEventListener('click', function (event) {
        if (event.target === confirmOverlayEl) {
          settleConfirm(false);
        }
      });
    }

    if (undoButtonEl) {
      undoButtonEl.addEventListener('click', undoDelete);
    }

    // 点页面其它地方收起「更多」菜单
    document.addEventListener('click', function (event) {
      if (!moreMenuOpen) {
        return;
      }
      var target = event.target;
      if (moreMenuEl && moreMenuEl.contains(target)) {
        return;
      }
      if (btnMoreEl && btnMoreEl.contains(target)) {
        return;
      }
      closeMoreMenu(false);
    });

    // 页面切走时暂停「今天」条的定时器；切回来立即刷一次（避免数字跳变）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopTodayTimer();
        return;
      }
      renderTodayBar();
    });

    // 其它标签页改了课程 / 任务 / 行程键：重读存储并刷新界面（含目录行状态）。
    // 这里**只读不写**：storage 事件在回环里再写库会互相触发，形成写风暴。
    // key === null 表示 clear()，三份数据一起重读。
    window.addEventListener('storage', function (event) {
      var key = event ? event.key : null;
      var allCleared = key === null;
      if (!allCleared && key !== STORAGE_KEY && key !== TASKS_STORAGE_KEY && key !== TRIPS_STORAGE_KEY) {
        return;
      }
      // 课程：沿用原有的读档 + 目录状态同步
      if (allCleared || key === STORAGE_KEY) {
        var loaded = readStore();
        state.courses = loaded.courses;
        if (loaded.notice) {
          showNotice(loaded.notice);
        }
        syncCatalogAfterExternalChange();
      }
      // 任务 / 行程：必须走 sections.js 的读取路径（校验 + 损坏兜底都在那里），
      // 不在 app.js 里自己拼 JSON.parse
      if ((allCleared || key === TASKS_STORAGE_KEY) && typeof SEC.readTasks === 'function') {
        var tasksResult = SEC.readTasks();
        state.tasks = Array.isArray(tasksResult.list) ? tasksResult.list : [];
        if (tasksResult.notice) {
          showNotice(tasksResult.notice);
        }
      }
      if ((allCleared || key === TRIPS_STORAGE_KEY) && typeof SEC.readTrips === 'function') {
        var tripsResult = SEC.readTrips();
        state.trips = Array.isArray(tripsResult.list) ? tripsResult.list : [];
        if (tripsResult.notice) {
          showNotice(tripsResult.notice);
        }
      }
      render();
    });

    // 识别服务配置变化（保存 / 清除）：空状态主 CTA 的文案要跟着变
    document.addEventListener('courseimport:configchange', updateEmptyStateCta);

    document.addEventListener('keydown', function (event) {
      var key = event.key;
      var top = topDialog();
      if (!top) {
        // 没有对话框时，Esc 退出互换模式并清空选择
        if (swapState.active && (key === 'Escape' || key === 'Esc')) {
          event.preventDefault();
          var hadPick = swapState.picked.length > 0;
          exitSwapMode();
          announce(hadPick ? '已退出互换模式，选择已清空' : '已退出互换模式');
        }
        return;
      }
      if (key === 'Escape' || key === 'Esc') {
        event.preventDefault();
        top.onEscape();
        return;
      }
      if (key === 'Tab') {
        trapFocus(event, top.el);
      }
    });
  }

  /* ==================== 二十、启动 ==================== */

  /**
   * 初始化应用。
   */
  function init() {
    cacheDomRefs();

    if (!courseListEl || !formEl || !formOverlayEl) {
      // 页面结构异常时不做任何渲染，避免抛出中断脚本
      return;
    }

    noteInput.setAttribute('maxlength', String(NOTE_MAX_LENGTH));
    if (itemNoteInput) {
      itemNoteInput.setAttribute('maxlength', String(NOTE_MAX_LENGTH));
    }
    // 颜色选择器由 JS 构建：8 个 token 只存在于 COURSE_COLORS 一处，HTML 里不重复
    buildColorPicker();
    // 批量改节次的下拉由 PERIODS 生成（节次表只有一个所有者）
    initImportBulkSelects();
    // 顶栏高度实测：分组头吸顶的 top 基准
    initHeaderObserver();

    bindEvents();

    var loaded = readStore();
    state.courses = loaded.courses;
    if (loaded.notice) {
      showNotice(loaded.notice);
    }

    // 栏目数据 + 上次停留的栏目 / 选中日期
    loadSections();

    updateNoteCounter();
    updateItemNoteCounter();
    // 已保存的铃声写进「更多」菜单的标题（不打开浮层也知道当前铃声）
    updateRingtoneMenuLabel();
    updateNotifyMenuItem();
    updateViewTabs();
    // 课表显示方式：按屏幕宽度取默认值（窄屏按天 / 宽屏整周）。
    // 只放内存，刷新后重新按宽度决定，不写 sections:v1、也不新增存储键。
    state.ttMode = defaultTimetableMode();
    state.ttDay = todayWeekday();
    render();
    startReminders();
    initNativeShell();
    registerServiceWorker();
  }

  /**
   * 读取栏目数据（任务 / 行程）与栏目配置，并恢复上次停留的栏目与选中日期。
   *
   * 三条兜底规则：
   *   1. lastSection 不在白名单 → 回落「课表」；
   *   2. dates.tasks 非法（空 / 0000-01-01）→ 今天；
   *   3. dates.tasks 距今天 > 30 天 → 今天 + announce（长期不用后打开不应看到空白页）。
   *      `dates.trips` 的 ''（全部）是合法值，不受 30 天规则影响。
   */
  function loadSections() {
    if (typeof SEC.readTasks === 'function') {
      var tasksResult = SEC.readTasks();
      state.tasks = Array.isArray(tasksResult.list) ? tasksResult.list : [];
      if (tasksResult.notice) {
        showNotice(tasksResult.notice);
      }
    }
    if (typeof SEC.readTrips === 'function') {
      var tripsResult = SEC.readTrips();
      state.trips = Array.isArray(tripsResult.list) ? tripsResult.list : [];
      if (tripsResult.notice) {
        showNotice(tripsResult.notice);
      }
    }

    var config = null;
    if (typeof SEC.readConfig === 'function') {
      config = SEC.readConfig();
      if (config && config.notice) {
        showNotice(config.notice);
      }
    }
    if (config) {
      state.sectionConfig = {
        lastSection: config.lastSection || 'grid',
        dates: {
          tasks: config.dates && config.dates.tasks ? config.dates.tasks : '',
          trips: config.dates && config.dates.trips ? config.dates.trips : ''
        },
        configs: config.configs || state.sectionConfig.configs
      };
    }

    state.view =
      VIEWS.indexOf(state.sectionConfig.lastSection) >= 0 ? state.sectionConfig.lastSection : 'grid';

    var today = typeof SEC.todayString === 'function' ? SEC.todayString() : '';
    var savedDate =
      typeof SEC.normalizeDateString === 'function'
        ? SEC.normalizeDateString(state.sectionConfig.dates.tasks)
        : '';
    var fallbackNotice = '';
    if (!savedDate) {
      savedDate = today;
    } else if (
      today &&
      typeof SEC.daysBetween === 'function' &&
      Math.abs(SEC.daysBetween(today, savedDate)) > (SEC.MAX_DATE_DRIFT_DAYS || 30)
    ) {
      // 长期不用后打开直接看到半年前的空白页，用户会以为数据丢了
      savedDate = today;
      fallbackNotice = '已回到今天';
    }
    state.tasksDate = savedDate || today;
    state.tripsDate = state.sectionConfig.dates.trips || '';

    if (fallbackNotice) {
      announce(fallbackNotice);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
