/**
 * 课程表 · 图片识别导入服务（接缝层）
 *
 * 设计目标：把「图片 → 课程候选」这一段完全隔离在本文件里。
 * app.js 只允许调用 `window.CourseImport.recognize(files)`，不得把任何识别逻辑写进 app.js；
 * 将来接真实的 OCR / 多模态大模型时，只需在本文件（或任意在它之后加载的脚本里）
 * 调用一次 `registerRecognizer(fn)`，应用层代码零改动。
 *
 * file:// 下不能用 ES module，因此挂到 window.CourseImport 上。
 *
 * ---------------------------------------------------------------- 契约
 *
 * window.CourseImport = {
 *   registerRecognizer(fn, name?),  // fn: (files: File[], ctx) => Promise<RecognizeResult>
 *   getRecognizerName(),            // 当前识别器名字，stub 时为 'stub'
 *   isReady(),                      // 是否已接入真实识别服务（stub 时 false）
 *   recognize(files, options?)      // 统一入口：校验 + 超时 + 并发 + 取消 + 异常兜底 + 结果规范化
 *   abortRecognition()              // 取消正在进行的识别（abort 所有在飞请求）
 * }
 *
 * recognize() 的第二个参数是可选的，**单参数旧调用保持完全兼容**：
 *   { source: 'camera'|'screenshot',  // 默认 'screenshot'；只影响预处理的长边档位
 *     signal: AbortSignal,            // 外部取消信号（可选）
 *     onProgress: (done, total, phase) => void }
 *
 * ImportCandidate = {
 *   name: string,          // 课程名称（必填）
 *   weekday: number,       // 1-7，1 = 周一
 *   startTime: string,     // 'HH:MM'（由节次换算得来，优先于模型自报的时间）
 *   endTime: string,       // 'HH:MM'
 *   teacher: string,       // 可为空
 *   place: string,         // 可为空，形如 http(s):// 时应用层会渲染成外链
 *   note: string,          // 可为空（单双周等原文会拼在这里）
 *   confidence: number,    // 0-1
 *   periodStart: number,   // 1-12，0 表示未知（新增，可选）
 *   periodEnd: number,     // 1-12，0 表示未知（新增，可选）
 *   weeks: string,         // 单双周原文，如 '单周'、'1-16周'（新增，可选）
 *   rowSpan: number,       // 合并单元格跨的节数（新增，可选）
 *   col: number            // 所在列（新增，可选，为将来「局部重试」留位）
 * }
 *
 * RecognizeResult = { courses: ImportCandidate[], warnings: string[] }
 *   （新增可选的 meta: { calls, failures, promptVersion, cancelled }，旧调用方可忽略）
 *
 * recognize() 永不 reject、永不 throw：
 *   - 文件不合法（类型 / 大小 / 数量）→ { courses: [], warnings: ['...中文提示...'] }
 *   - 识别器超时（单张 45s）          → { courses: [], warnings: ['第 N 张识别超时，已跳过。'] }
 *   - 识别器抛错                      → { courses: [], warnings: ['识别失败：...'] }
 *   - 未接入真实服务时                → { courses: [], warnings: ['识别服务尚未接入（接口已预留）'] }
 *   - 用户取消（abortRecognition）    → { courses: 已识别的部分, warnings: ['识别已取消。'] }
 *
 * ctx（传给识别器的第二个参数）：
 *   { maxFiles, maxFileSize, timeoutMs, source, signal, onProgress }
 *
 * ================================================================ 接入示例
 *
 * 下面整段都是注释，本文件运行期不会发起任何网络请求。
 * 真实接入时把这段代码放到 registerRecognizer 里即可：
 *
 * // 1) 图片转 base64（去掉 dataURL 前缀）
 * function fileToBase64(file) {
 *   return new Promise(function (resolve, reject) {
 *     var reader = new FileReader();
 *     reader.onload = function () {
 *       var result = String(reader.result || '');
 *       resolve(result.indexOf(',') >= 0 ? result.split(',')[1] : result);
 *     };
 *     reader.onerror = function () { reject(new Error('读取图片失败')); };
 *     reader.readAsDataURL(file);
 *   });
 * }
 *
 * // 2) 调后端 OCR（地址仅为示例说明，切勿照抄到生产）
 * function ocrRecognizer(files, ctx) {
 *   var images = [];
 *   return files.reduce(function (chain, file) {
 *     return chain.then(function () {
 *       return fileToBase64(file).then(function (base64) { images.push(base64); });
 *     });
 *   }, Promise.resolve()).then(function () {
 *     return fetch('/api/timetable/ocr', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ images: images, timeoutMs: ctx.timeoutMs })
 *     });
 *   }).then(function (response) {
 *     if (!response.ok) {
 *       throw new Error('识别服务返回 ' + response.status);
 *     }
 *     return response.json();
 *   }).then(function (payload) {
 *     // 3) 映射为 ImportCandidate[]
 *     var courses = (payload.courses || []).map(function (item) {
 *       return {
 *         name: item.name,
 *         weekday: item.weekday,              // 1-7
 *         startTime: item.start_time,         // 'HH:MM'
 *         endTime: item.end_time,
 *         teacher: item.teacher || '',
 *         place: item.place || '',
 *         note: item.note || '',
 *         confidence: typeof item.confidence === 'number' ? item.confidence : 0.6
 *       };
 *     });
 *     // 4) 返回标准结构，剩下的校验 / 去重 / 入库由应用层负责
 *     return { courses: courses, warnings: payload.warnings || [] };
 *   });
 * }
 *
 * // 5) 在应用启动时注册一次即可（之后 app.js 无需任何改动）
 * if (window.CourseImport && window.CourseImport.isReady() === false) {
 *   window.CourseImport.registerRecognizer(ocrRecognizer, 'backend-ocr');
 * }
 */
(function (global) {
  'use strict';

  /* ==================== 一、限制与常量 ==================== */

  /** 一次最多几张图片 */
  var MAX_FILES = 9;
  /** 单张图片上限：5 MB */
  var MAX_FILE_SIZE = 5 * 1024 * 1024;
  /** 单张图片的识别超时（毫秒）。不再用「张数 × 预算」的总预算 —— 用户等的是「这一张」 */
  var PER_IMAGE_TIMEOUT_MS = 45000;
  /** 对外仍保留 timeoutMs 字段（老 UI 可能读它），语义为「单张超时」 */
  var TIMEOUT_MS = PER_IMAGE_TIMEOUT_MS;
  /** 并发上限：多数服务商 QPS 限制在 3-10，2 并发安全且能把 9 张图的等待时间接近减半 */
  var MAX_CONCURRENCY = 2;
  /** 429 / 5xx / 网络错误的重试次数（配置类错误绝不重试） */
  var MAX_RETRIES = 1;
  /** 重试退避基数（毫秒），实际等待会叠加 0-200ms 抖动 */
  var RETRY_BACKOFF_MS = 800;
  /** 模糊检测阈值：3×3 拉普拉斯响应的方差，低于此值视为可能拍糊 */
  var BLUR_THRESHOLD = 60;
  /** 备注长度上限，与 app.js 保持一致 */
  var NOTE_MAX_LENGTH = 500;
  /** 真实服务未配置时的统一提示文案 */
  var NOT_READY_WARNING = '识别服务尚未配置，展开「识别服务设置」填写接口信息即可启用';

  /* ==================== 二、内部工具 ==================== */

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
   * 星期值收敛到 1-7。
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
   * 单张文件的类型是否被接受。
   * @param {File} file
   * @return {boolean}
   */
  function isImageFile(file) {
    if (!file || typeof file !== 'object') {
      return false;
    }
    var type = typeof file.type === 'string' ? file.type : '';
    if (type.indexOf('image/') === 0) {
      return true;
    }
    // 极少数环境（如拖拽自某些桌面程序）拿不到 MIME，退回扩展名判断
    var name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    return /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/.test(name);
  }

  /**
   * 文件体积描述。
   * @param {number} bytes
   * @return {string}
   */
  function formatSize(bytes) {
    var mb = bytes / (1024 * 1024);
    if (mb >= 1) {
      return (Math.round(mb * 10) / 10) + ' MB';
    }
    return Math.round(bytes / 1024) + ' KB';
  }

  /* ==================== 三、结果规范化 ==================== */

  /**
   * 节次值收敛到 1-12，非法值返回 0（0 = 未知，不参与换算）。
   * @param {*} value
   * @return {number}
   */
  function toPeriodIndex(value) {
    if (value === null || value === undefined || value === '') {
      return 0;
    }
    var num = Number(value);
    if (!isFinite(num) || Math.floor(num) !== num || num < 1 || num > 12) {
      return 0;
    }
    return num;
  }

  /**
   * 规范化单条候选课程，非法项返回 null（由调用方丢弃并计数）。
   * 节次字段一律保留给上层（UI 要显示「第N-M节」，应用层要按节次排序）。
   * @param {*} raw
   * @return {Object|null}
   */
  function normalizeCandidate(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    var name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      return null;
    }
    var startTime = normalizeTimeString(raw.startTime);
    var endTime = normalizeTimeString(raw.endTime);
    // 区间非法时不在这里报错，置空后交给应用层的同一套校验去提示用户
    if (startTime && endTime && timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      endTime = '';
    }
    var confidence = Number(raw.confidence);
    if (!isFinite(confidence)) {
      confidence = 0;
    }
    confidence = Math.min(1, Math.max(0, confidence));
    var periodStart = toPeriodIndex(raw.periodStart);
    var periodEnd = toPeriodIndex(raw.periodEnd);
    if (periodStart > 0) {
      if (periodEnd < periodStart) {
        periodEnd = periodStart;
      }
    } else {
      periodEnd = 0;
    }
    var rowSpan = Math.round(Number(raw.rowSpan));
    if (!isFinite(rowSpan) || rowSpan < 1) {
      rowSpan = 1;
    }
    var col = Math.round(Number(raw.col));
    if (!isFinite(col) || col < 0) {
      col = 0;
    }
    return {
      name: name,
      weekday: clampWeekday(raw.weekday),
      startTime: startTime,
      endTime: endTime,
      teacher: typeof raw.teacher === 'string' ? raw.teacher.trim() : '',
      place: typeof raw.place === 'string' ? raw.place.trim() : '',
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, NOTE_MAX_LENGTH) : '',
      confidence: confidence,
      periodStart: periodStart,
      periodEnd: periodEnd,
      weeks: typeof raw.weeks === 'string' ? raw.weeks.trim().slice(0, 60) : '',
      rowSpan: rowSpan,
      col: col
    };
  }

  /**
   * 规范化整个识别结果，保证返回结构永远可用。
   * @param {*} raw
   * @return {{courses: Array<Object>, warnings: Array<string>}}
   */
  function normalizeResult(raw) {
    var warnings = [];
    var courses = [];
    var payload = raw && typeof raw === 'object' ? raw : {};
    var rawWarnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    for (var i = 0; i < rawWarnings.length; i += 1) {
      if (typeof rawWarnings[i] === 'string' && rawWarnings[i]) {
        warnings.push(rawWarnings[i]);
      }
    }
    var rawCourses = Array.isArray(payload.courses) ? payload.courses : [];
    var dropped = 0;
    for (var j = 0; j < rawCourses.length; j += 1) {
      var candidate = normalizeCandidate(rawCourses[j]);
      if (candidate) {
        courses.push(candidate);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      warnings.push('有 ' + dropped + ' 条识别结果缺少课程名称，已忽略。');
    }
    var result = { courses: courses, warnings: warnings };
    // meta 是可选的诊断信息（调用次数 / 失败数 / prompt 版本 / 是否取消），旧调用方忽略即可
    if (payload.meta && typeof payload.meta === 'object') {
      result.meta = payload.meta;
    }
    return result;
  }

  /* ==================== 四、识别器注册 ==================== */

  /**
   * 占位识别器：不产生任何假数据，只诚实告知「尚未接入」。
   * @return {Promise<{courses: Array<Object>, warnings: Array<string>}>}
   */
  function stubRecognizer() {
    return Promise.resolve({
      courses: [],
      warnings: [NOT_READY_WARNING]
    });
  }

  var activeRecognizer = stubRecognizer;
  var activeName = 'stub';
  var activeIsStub = true;

  /**
   * 注册真实识别器。之后 app.js 仍然只调用 recognize()。
   * @param {Function} fn (files: File[], ctx) => Promise<{courses: Array<Object>, warnings: Array<string>}>
   * @param {string} [name] 识别器名称，便于调试
   * @return {boolean} 注册是否成功
   */
  function registerRecognizer(fn, name) {
    if (typeof fn !== 'function') {
      return false;
    }
    activeRecognizer = fn;
    activeIsStub = false;
    activeName = typeof name === 'string' && name ? name : 'custom';
    return true;
  }

  /**
   * 当前识别器名称。
   * @return {string}
   */
  function getRecognizerName() {
    return activeName;
  }

  /**
   * 是否已接入真实识别服务。
   * @return {boolean}
   */
  function isReady() {
    return !activeIsStub;
  }

  /* ==================== 五、统一入口 ==================== */

  /**
   * 校验文件列表，返回错误文案（无错误时返回空串）。
   * @param {Array<File>} files
   * @return {string}
   */
  function validateFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return '请先选择课表截图。';
    }
    if (files.length > MAX_FILES) {
      return '一次最多选择 ' + MAX_FILES + ' 张图片，当前选了 ' + files.length + ' 张。';
    }
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      if (!isImageFile(file)) {
        return '第 ' + (i + 1) + ' 个文件不是图片，仅支持 PNG / JPG 等图片格式。';
      }
      var size = typeof file.size === 'number' ? file.size : 0;
      if (size <= 0) {
        return '第 ' + (i + 1) + ' 个文件内容为空，请重新选择。';
      }
      if (size > MAX_FILE_SIZE) {
        return '第 ' + (i + 1) + ' 张图片 ' + formatSize(size) + '，超过单张 ' +
          formatSize(MAX_FILE_SIZE) + ' 的限制。';
      }
    }
    return '';
  }

  /** 当前在飞的识别运行（用于 abortRecognition） */
  var activeRun = null;

  /**
   * 取消正在进行的识别：abort 所有在飞请求。
   * 识别器内部会把 AbortError 吞掉并转成 warnings，recognize() 依旧永不 reject。
   * @return {boolean} 是否有正在进行的识别被取消
   */
  function abortRecognition() {
    if (!activeRun) {
      return false;
    }
    var run = activeRun;
    activeRun = null;
    try {
      run.abort();
    } catch (err) {
      /* abort 本身失败不影响调用方 */
    }
    return true;
  }

  /**
   * 统一识别入口：校验文件 → 调识别器（单张超时 + 并发 + 可取消）→ 规范化结果 → 异常兜底。
   * 无论发生什么都不会 reject。
   * @param {Array<File>} files
   * @param {{source?: string, signal?: AbortSignal, onProgress?: Function}} [options] 可省略，省略时行为与旧版一致
   * @return {Promise<{courses: Array<Object>, warnings: Array<string>}>}
   */
  function recognize(files, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var source = opts.source === 'camera' ? 'camera' : 'screenshot';
    var list = Array.isArray(files) ? files.slice() : [];
    var invalidMessage = validateFiles(list);
    if (invalidMessage) {
      return Promise.resolve({ courses: [], warnings: [invalidMessage] });
    }

    // 单张超时 45s，并发 2 → 总的安全网预算按「批次」估算，只用于兜底卡死的识别器
    var batches = Math.ceil(list.length / MAX_CONCURRENCY);
    var timeoutMs = PER_IMAGE_TIMEOUT_MS * batches + 15000;

    var ctx = {
      maxFiles: MAX_FILES,
      maxFileSize: MAX_FILE_SIZE,
      timeoutMs: PER_IMAGE_TIMEOUT_MS,
      source: source,
      signal: opts.signal || null,
      onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null
    };

    var timerId = null;
    var timeoutPromise = new Promise(function (resolve) {
      timerId = global.setTimeout(function () {
        abortRecognition();
        resolve({
          courses: [],
          warnings: ['识别超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒），请减少图片数量后重试。']
        });
      }, timeoutMs);
    });

    var recognizePromise = null;
    try {
      recognizePromise = Promise.resolve(activeRecognizer(list, ctx));
    } catch (err) {
      recognizePromise = Promise.reject(err);
    }

    var guardedPromise = recognizePromise.then(
      function (raw) {
        return normalizeResult(raw);
      },
      function (err) {
        var message = err && err.message ? String(err.message) : '未知错误';
        return { courses: [], warnings: ['识别失败：' + message] };
      }
    );

    return Promise.race([guardedPromise, timeoutPromise]).then(function (result) {
      if (timerId !== null) {
        global.clearTimeout(timerId);
        timerId = null;
      }
      return normalizeResult(result);
    });
  }

  /* ==================== 六、视觉模型识别器（OpenAI 兼容协议） ==================== */

  /** 配置在 localStorage 里的键（与课程数据分开，清课程不会丢配置） */
  var CONFIG_KEY = 'course-manager:vision';

  /** 截图长边压到 1600：文字密集的网格还能看清 12px 小字 */
  var IMAGE_MAX_EDGE_SCREENSHOT = 1600;
  /** 拍照长边保留 2000：有透视与噪声，需要更多像素 */
  var IMAGE_MAX_EDGE_CAMERA = 2000;
  /** 压缩后的 JPEG 质量（0.82 → 0.85：体积 +12%，文字边缘伪影明显减少） */
  var IMAGE_QUALITY = 0.85;
  /** 单次请求的最大输出 token（v2 多了 grid 结构，输出更长） */
  var MAX_OUTPUT_TOKENS = 3072;
  /** Prompt 版本号，写进 meta 便于排查「这是哪版提示词识别的」 */
  var PROMPT_VERSION = 2;

  /**
   * 服务商预设。都走 OpenAI Chat Completions 兼容协议，只有地址与默认模型不同。
   * 想加新服务商：这里加一项 + index.html 的下拉里加一个 option 即可。
   */
  var PROVIDERS = {
    qwen: { label: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max-latest' },
    zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus' },
    ark: { label: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-vision-pro-32k-250115' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
  };

  /**
   * Prompt v2：两段式输出（grid 结构 + courses + uncertain）。
   *
   * 核心改变：**让模型只报节次，不要自己换算时间**。
   * 节次 → 时间由 timetable.js 的 periodRangeToTimes() 确定性换算，
   * 这样「第3-4节」永远等于 10:20–11:00，不会随模型心情变化。
   *
   * @return {string}
   */
  function buildPromptV2() {
    return [
      '你是课程表识别器。请从这张课程表图片里提取课程与表格结构，只输出 JSON，不要输出解释、Markdown 代码块或任何多余文字。',
      '输出格式：' +
        '{"grid":{"dayColumns":[{"col":1,"label":"周一"}],"periodRows":[{"row":1,"label":"第1节","start":"08:30","end":"09:10"}],' +
        '"hasHeaderRow":true,"mergedCells":[{"rowStart":1,"rowEnd":2,"col":3,"text":"高等数学"}]},' +
        '"courses":[{"name":"高等数学","weekdayLabel":"周三","weekday":3,"periodLabel":"第1-2节","periodStart":1,"periodEnd":2,' +
        '"weeks":"1-16周","teacher":"张老师","place":"A301","note":"","rowSpan":2,"col":3,"confidence":0.93}],' +
        '"uncertain":[{"col":3,"periodStart":5,"periodEnd":6,"rawText":"大物(单)","reason":"单双周无法确定"}]}',
      '规则：',
      '1) 【最重要】能看出节次时只输出 periodStart / periodEnd（1-12 的整数），**不要自己换算成具体时间**；' +
        '只有图上明确写着具体时间（如 10:20）时才填 startTime / endTime。',
      '2) weekday 用 1-7 表示周一至周日（周一=1）；若图上只有中文，同时给出 weekdayLabel（如“周三”）便于交叉校验。',
      '3) 合并单元格（一个课程纵向跨 2-4 节）必须写 rowSpan，并在 grid.mergedCells 里登记 rowStart / rowEnd / col / text。',
      '4) 单双周一律写进 weeks（如“1-16周”“单周”“双周”），**不允许**为了表达单双周而拆成两条课程。',
      '5) 任何无法确定的字段留空字符串，禁止编造；拿不准的课程放进 uncertain，不要硬塞进 courses。',
      '6) 表头、时间轴、日期、页码、学期、作息时间表、水印、二维码等非课程内容不要输出；' +
        '姓名 / 学号 / 班级人数等个人信息一律不要输出。',
      '7) confidence 是 0 到 1 之间的小数，表示这一条识别的把握。',
      '8) 没有识别到课程时输出 {"grid":{"dayColumns":[],"periodRows":[],"hasHeaderRow":false,"mergedCells":[]},"courses":[],"uncertain":[]}。'
    ].join('\n');
  }

  /** 让模型只吐 JSON 的提示词（v2）。规则写得越死，后续解析越稳。 */
  var EXTRACT_PROMPT = buildPromptV2();

  /** 1x1 透明 PNG，用于「测试连接」时验证鉴权与模型可用 */
  var TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** 星期中文 → 1-7 */
  var WEEKDAY_CHAR_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

  /**
   * 读取本地保存的识别配置。
   * @return {{provider: string, baseUrl: string, model: string, apiKey: string}|null}
   */
  function readConfig() {
    var raw = null;
    try {
      raw = global.localStorage ? global.localStorage.getItem(CONFIG_KEY) : null;
    } catch (err) {
      return null;
    }
    if (!raw) {
      return null;
    }
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    var baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '';
    var model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    var apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    if (!baseUrl || !model || !apiKey) {
      return null;
    }
    return {
      provider: PROVIDERS[parsed.provider] ? parsed.provider : 'custom',
      baseUrl: baseUrl,
      model: model,
      apiKey: apiKey
    };
  }

  /**
   * 校验配置，返回错误文案（合法时返回空串）。
   * @param {Object} config
   * @return {string}
   */
  function validateConfig(config) {
    if (!config || typeof config !== 'object') {
      return '配置为空。';
    }
    var baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
    var model = typeof config.model === 'string' ? config.model.trim() : '';
    var apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!baseUrl) {
      return '请填写接口地址。';
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return '接口地址需以 http:// 或 https:// 开头。';
    }
    if (!model) {
      return '请填写模型名称。';
    }
    if (!apiKey) {
      return '请填写 API Key。';
    }
    return '';
  }

  /**
   * 通知应用层「识别服务配置变了」。
   * 用自定义事件而不是回调：app.js 与 import-service.js 仍然只靠 window.CourseImport 通信，
   * 事件只是单向广播（谁爱听谁听），不构成新的契约依赖。
   */
  function notifyConfigChange() {
    try {
      if (global.document && typeof global.CustomEvent === 'function') {
        global.document.dispatchEvent(new global.CustomEvent('courseimport:configchange'));
      }
    } catch (err) {
      /* 广播失败不影响配置本身 */
    }
  }

  /**
   * 保存配置并立即切换识别器。配置只写本机 localStorage。
   * @param {Object} config
   * @return {{ok: boolean, error: string}}
   */
  function saveConfig(config) {
    var invalid = validateConfig(config);
    if (invalid) {
      return { ok: false, error: invalid };
    }
    var store = {
      version: 1,
      provider: PROVIDERS[config.provider] ? config.provider : 'custom',
      baseUrl: String(config.baseUrl).trim().replace(/\/+$/, ''),
      model: String(config.model).trim(),
      apiKey: String(config.apiKey).trim()
    };
    try {
      if (!global.localStorage) {
        throw new Error('当前环境不可用');
      }
      global.localStorage.setItem(CONFIG_KEY, JSON.stringify(store));
    } catch (err) {
      return { ok: false, error: '配置保存失败（浏览器禁止写入本地存储）：' + (err && err.message ? err.message : '未知错误') };
    }
    applyConfig(store);
    notifyConfigChange();
    return { ok: true, error: '' };
  }

  /**
   * 清除配置，回到「未配置」状态。
   */
  function clearConfig() {
    try {
      if (global.localStorage) {
        global.localStorage.removeItem(CONFIG_KEY);
      }
    } catch (err) { /* 清不掉也不影响后续降级为 stub */ }
    applyConfig(null);
    notifyConfigChange();
  }

  /**
   * 把配置生效到当前识别器上；null 表示回到 stub。
   * @param {Object|null} config
   */
  function applyConfig(config) {
    if (!config) {
      activeRecognizer = stubRecognizer;
      activeIsStub = true;
      activeName = 'stub';
      return;
    }
    activeRecognizer = createVisionRecognizer(config);
    activeIsStub = false;
    activeName = 'vision:' + (config.provider || 'custom');
  }

  /**
   * 把文件读成 dataURL。
   * @param {File} file
   * @return {Promise<string>}
   */
  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(new Error('读取图片失败'));
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 用 canvas 采样估算模糊程度：缩到长边 256 → 灰度 → 3×3 拉普拉斯 → 响应方差。
   *
   * 为什么用方差：清晰图像有大量高频边缘，拉普拉斯响应分布很散（方差大）；
   * 虚焦图边缘被抹平，响应集中在 0 附近（方差小）。这是零依赖的经典近似，
   * 只用于「提醒用户可能拍糊了」，不参与任何拦截决策。
   *
   * @param {HTMLCanvasElement} canvas 已重绘过的画布
   * @return {number} 方差；无法计算时返回 -1（调用方视为「未检测」）
   */
  function blurScoreFromCanvas(canvas) {
    try {
      if (!canvas || !canvas.width || !canvas.height) {
        return -1;
      }
      var scale = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
      var sw = Math.max(3, Math.round(canvas.width * scale));
      var sh = Math.max(3, Math.round(canvas.height * scale));
      var small = global.document.createElement('canvas');
      small.width = sw;
      small.height = sh;
      var context = small.getContext('2d');
      if (!context) {
        return -1;
      }
      // 先铺白底：PNG 透明区域若直接转灰度会被当成纯黑，制造出假的高频边缘
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, sw, sh);
      context.drawImage(canvas, 0, 0, sw, sh);
      var data = context.getImageData(0, 0, sw, sh).data;
      var gray = new Float32Array(sw * sh);
      for (var i = 0; i < sw * sh; i += 1) {
        gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      }
      var sum = 0;
      var sumSq = 0;
      var count = 0;
      for (var y = 1; y < sh - 1; y += 1) {
        for (var x = 1; x < sw - 1; x += 1) {
          var idx = y * sw + x;
          var response =
            gray[idx - sw] + gray[idx + sw] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
          sum += response;
          sumSq += response * response;
          count += 1;
        }
      }
      if (count === 0) {
        return -1;
      }
      var mean = sum / count;
      return sumSq / count - mean * mean;
    } catch (err) {
      return -1;
    }
  }

  /**
   * 图片预处理：**无论长边是否超限，一律经过一次 canvas 重绘**。
   *
   * 两个必须重绘的理由：
   *   ① 浏览器加载 <img> 时会按 EXIF Orientation 转正（现代浏览器 image-orientation: from-image 默认），
   *      重绘后方向就固化进像素，不依赖服务商是否读 EXIF；
   *   ② toDataURL 重新编码会丢弃全部 EXIF（含 GPS 坐标、机型、拍摄时间），
   *      截图/照片原样上传的隐私问题就此消失。
   *
   * @param {File} file
   * @param {string} [source] 'camera' | 'screenshot'
   * @return {Promise<{dataUrl: string, width: number, height: number, bytes: number, blur: number, warning: string}>}
   */
  function prepareImage(file, source) {
    var maxEdge = source === 'camera' ? IMAGE_MAX_EDGE_CAMERA : IMAGE_MAX_EDGE_SCREENSHOT;
    return readFileAsDataUrl(file).then(function (original) {
      return new Promise(function (resolve) {
        // 无 DOM（Node 单测 / 外部注册识别器场景）：无法重绘，原样返回并标记 blur=-1
        if (typeof global.Image !== 'function' || !global.document) {
          resolve({
            dataUrl: original,
            width: 0,
            height: 0,
            bytes: original.length,
            blur: -1,
            warning: ''
          });
          return;
        }
        var img = new global.Image();
        img.onload = function () {
          try {
            var naturalWidth = img.naturalWidth || img.width;
            var naturalHeight = img.naturalHeight || img.height;
            if (!naturalWidth || !naturalHeight) {
              resolve({
                dataUrl: original,
                width: 0,
                height: 0,
                bytes: original.length,
                blur: -1,
                warning: '这张图尺寸异常，已按原图上传。'
              });
              return;
            }
            var edge = Math.max(naturalWidth, naturalHeight);
            var scale = edge > maxEdge ? maxEdge / edge : 1;
            var canvas = global.document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(naturalHeight * scale));
            var context = canvas.getContext('2d');
            if (!context) {
              resolve({
                dataUrl: original,
                width: 0,
                height: 0,
                bytes: original.length,
                blur: -1,
                warning: ''
              });
              return;
            }
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            var dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
            resolve({
              dataUrl: dataUrl,
              width: canvas.width,
              height: canvas.height,
              bytes: dataUrl.length,
              blur: blurScoreFromCanvas(canvas),
              warning: ''
            });
          } catch (err) {
            resolve({
              dataUrl: original,
              width: 0,
              height: 0,
              bytes: original.length,
              blur: -1,
              warning: '这张图无法在浏览器里解码（HEIC 等格式请改存为 JPG 或直接用截图）。'
            });
          }
        };
        img.onerror = function () {
          resolve({
            dataUrl: original,
            width: 0,
            height: 0,
            bytes: original.length,
            blur: -1,
            warning: '这张图无法在浏览器里解码（HEIC 等格式请改存为 JPG 或直接用截图）。'
          });
        };
        img.src = original;
      });
    });
  }

  /**
   * 兼容旧名：外部脚本若调用过 downscaleDataUrl，行为等价于「按截图档位重绘一次」。
   * @param {string} dataUrl
   * @return {Promise<string>}
   */
  function downscaleDataUrl(dataUrl) {
    return new Promise(function (resolve) {
      if (typeof global.Image !== 'function' || !global.document) {
        resolve(dataUrl);
        return;
      }
      var img = new global.Image();
      img.onload = function () {
        try {
          var naturalWidth = img.naturalWidth || img.width;
          var naturalHeight = img.naturalHeight || img.height;
          var edge = Math.max(naturalWidth, naturalHeight);
          var scale = edge > IMAGE_MAX_EDGE_SCREENSHOT ? IMAGE_MAX_EDGE_SCREENSHOT / edge : 1;
          var canvas = global.document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(naturalHeight * scale));
          var context = canvas.getContext('2d');
          if (!context) {
            resolve(dataUrl);
            return;
          }
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', IMAGE_QUALITY));
        } catch (err) {
          resolve(dataUrl);
        }
      };
      img.onerror = function () {
        resolve(dataUrl);
      };
      img.src = dataUrl;
    });
  }

  /**
   * 把 HTTP 状态码映射成用户能看懂的中文原因。
   * @param {number} status
   * @param {string} bodyText
   * @return {string}
   */
  function friendlyHttpError(status, bodyText) {
    var detail = '';
    try {
      var parsed = JSON.parse(bodyText);
      detail = (parsed && parsed.error && (parsed.error.message || parsed.error.code)) ||
        (parsed && parsed.message) || '';
    } catch (err) {
      detail = String(bodyText || '').slice(0, 120);
    }
    var head;
    if (status === 401 || status === 403) {
      head = 'API Key 无效或没有访问权限（' + status + '）';
    } else if (status === 404) {
      head = '接口地址或模型名称不存在（404）';
    } else if (status === 429) {
      head = '调用太频繁或额度已用尽（429）';
    } else if (status >= 500) {
      head = '识别服务暂时不可用（' + status + '）';
    } else if (status === 400 || status === 422) {
      head = '识别服务不接受这次请求（' + status + '）';
    } else {
      head = '识别服务返回异常状态（' + status + '）';
    }
    return detail ? head + '：' + detail : head;
  }

  /**
   * 从模型响应里取出正文（兼容 content 为字符串或分段数组两种形态）。
   * @param {Object} payload
   * @return {string}
   */
  function extractContentText(payload) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    var choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return '';
    }
    var message = choices[0] && choices[0].message;
    if (!message) {
      return '';
    }
    var content = message.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i += 1) {
        var part = content[i];
        if (typeof part === 'string') {
          parts.push(part);
        } else if (part && typeof part.text === 'string') {
          parts.push(part.text);
        }
      }
      return parts.join('\n');
    }
    return '';
  }

  /**
   * 解析模型输出为 JSON。模型常带 ```json 围栏或前后废话，这里做容错。
   * @param {string} text
   * @return {Object|Array}
   */
  function parseModelJson(text) {
    var cleaned = String(text || '').replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
    if (!cleaned) {
      throw new Error('识别服务没有返回内容');
    }
    try {
      return JSON.parse(cleaned);
    } catch (err) { /* 继续尝试截取 */ }
    var braces = [cleaned.indexOf('{'), cleaned.indexOf('[')];
    var start = -1;
    for (var i = 0; i < braces.length; i += 1) {
      if (braces[i] >= 0 && (start === -1 || braces[i] < start)) {
        start = braces[i];
      }
    }
    if (start >= 0) {
      var slice = cleaned.slice(start);
      var lastBrace = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
      if (lastBrace > 0) {
        try {
          return JSON.parse(slice.slice(0, lastBrace + 1));
        } catch (err2) { /* 落到下方统一报错 */ }
      }
    }
    throw new Error('识别结果不是有效 JSON，可换一张更清晰的截图重试');
  }

  /**
   * 各种星期写法归一化为 1-7。
   * @param {*} value
   * @return {number}
   */
  function toWeekday(value) {
    if (typeof value === 'number' && isFinite(value) && value >= 1 && value <= 7) {
      return Math.round(value);
    }
    var text = String(value === null || value === undefined ? '' : value).trim();
    if (/^[1-7]$/.test(text)) {
      return Number(text);
    }
    var match = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/.exec(text);
    if (match) {
      var ch = match[1];
      return WEEKDAY_CHAR_MAP[ch] || Number(ch) || 1;
    }
    if (WEEKDAY_CHAR_MAP[text]) {
      return WEEKDAY_CHAR_MAP[text];
    }
    return 1;
  }

  /**
   * 节次区间 → 具体时间。
   *
   * 实现归口到 timetable.js（节次配置的唯一所有者），本文件不再自己算下标越界。
   * 兼容旧结构：只给了 `period`（单节）时按「起止同一节」处理。
   *
   * @param {Object} item 含 periodStart / periodEnd / period 的原始对象
   * @return {{startTime: string, endTime: string}}
   */
  function timesFromPeriods(item) {
    var empty = { startTime: '', endTime: '' };
    if (!item || typeof item !== 'object') {
      return empty;
    }
    var from = toPeriodIndex(item.periodStart);
    var to = toPeriodIndex(item.periodEnd);
    if (from === 0) {
      var single = toPeriodIndex(item.period);
      if (single === 0) {
        return empty;
      }
      from = single;
      to = single;
    }
    var timetable = global.CourseTimetable;
    if (timetable && typeof timetable.periodRangeToTimes === 'function') {
      return timetable.periodRangeToTimes(from, to);
    }
    // 兜底：timetable.js 未加载时自己按 PERIODS 换算（保持与它一致的语义）
    var periods = timetable && Array.isArray(timetable.PERIODS) ? timetable.PERIODS : null;
    if (!periods || periods.length === 0) {
      return empty;
    }
    var first = periods[from - 1];
    var last = periods[(to || from) - 1] || first;
    if (!first || !last) {
      return empty;
    }
    return { startTime: first.start || '', endTime: last.end || '' };
  }

  /**
   * 校验并规范化模型输出的 grid 结构（只保留有意义的字段，脏值一律归零）。
   * @param {*} raw
   * @return {{dayColumns: Array<Object>, periodRows: Array<Object>, hasHeaderRow: boolean, mergedCells: Array<Object>}}
   */
  function normalizeGrid(raw) {
    var grid = { dayColumns: [], periodRows: [], hasHeaderRow: false, mergedCells: [] };
    if (!raw || typeof raw !== 'object') {
      return grid;
    }
    grid.hasHeaderRow = Boolean(raw.hasHeaderRow);
    var dayColumns = Array.isArray(raw.dayColumns) ? raw.dayColumns : [];
    for (var i = 0; i < dayColumns.length; i += 1) {
      var column = dayColumns[i];
      if (!column || typeof column !== 'object') {
        continue;
      }
      var col = Math.round(Number(column.col));
      if (!isFinite(col) || col < 1) {
        continue;
      }
      grid.dayColumns.push({
        col: col,
        label: typeof column.label === 'string' ? column.label.trim() : ''
      });
    }
    var periodRows = Array.isArray(raw.periodRows) ? raw.periodRows : [];
    for (var j = 0; j < periodRows.length; j += 1) {
      var row = periodRows[j];
      if (!row || typeof row !== 'object') {
        continue;
      }
      var rowIndex = Math.round(Number(row.row));
      if (!isFinite(rowIndex) || rowIndex < 1) {
        continue;
      }
      grid.periodRows.push({
        row: rowIndex,
        label: typeof row.label === 'string' ? row.label.trim() : '',
        start: normalizeTimeString(row.start),
        end: normalizeTimeString(row.end)
      });
    }
    var mergedCells = Array.isArray(raw.mergedCells) ? raw.mergedCells : [];
    for (var k = 0; k < mergedCells.length; k += 1) {
      var cell = mergedCells[k];
      if (!cell || typeof cell !== 'object') {
        continue;
      }
      var rowStart = Math.round(Number(cell.rowStart));
      var rowEnd = Math.round(Number(cell.rowEnd));
      var cellCol = Math.round(Number(cell.col));
      if (!isFinite(rowStart) || rowStart < 1) {
        continue;
      }
      if (!isFinite(rowEnd) || rowEnd < rowStart) {
        rowEnd = rowStart;
      }
      if (!isFinite(cellCol) || cellCol < 1) {
        cellCol = 0;
      }
      grid.mergedCells.push({
        rowStart: rowStart,
        rowEnd: rowEnd,
        col: cellCol,
        text: typeof cell.text === 'string' ? cell.text.trim() : ''
      });
    }
    return grid;
  }

  /**
   * 把合并单元格的信息回填到课程上：模型有时只在 mergedCells 里写跨行，忘了写 rowSpan。
   * @param {Object} course 已映射的候选（会被就地修改）
   * @param {Array<Object>} mergedCells normalizeGrid 的输出
   */
  function applyMergedCells(course, mergedCells) {
    if (!course || !mergedCells || mergedCells.length === 0) {
      return;
    }
    for (var i = 0; i < mergedCells.length; i += 1) {
      var cell = mergedCells[i];
      if (!cell || course.periodStart <= 0) {
        continue;
      }
      var colMatches = cell.col === 0 || !course.col || cell.col === course.col;
      if (!colMatches) {
        continue;
      }
      if (course.periodStart < cell.rowStart || course.periodStart > cell.rowEnd) {
        continue;
      }
      if (cell.rowEnd > course.periodStart) {
        course.periodEnd = Math.max(course.periodEnd || 0, cell.rowEnd);
        course.rowSpan = cell.rowEnd - cell.rowStart + 1;
      }
      return;
    }
  }

  /** 课表之外的噪声（学期标题、页码、纯星期表头等），二次过滤用 */
  var NOISE_PATTERN = /学期|作息|上课时间表|第\s*\d+\s*页|^星期[一二三四五六日天]$|^周[一二三四五六日天]$/;

  /**
   * 把模型给的任意结构映射成候选课程（字段兜底，不规范的值交给应用层同一套校验）。
   *
   * 关键规则：**节次优先于模型自报的时间**。两条都有时以 periodRangeToTimes 的结果为准，
   * 这样「第3-4节」一定等于 10:20–11:00，而不是模型自由发挥的时间。
   *
   * @param {Object|Array} payload
   * @return {Array<Object>}
   */
  function mapPayloadToCourses(payload) {
    var list = [];
    var mergedCells = [];
    if (Array.isArray(payload)) {
      list = payload;
    } else if (payload && typeof payload === 'object') {
      if (payload.grid) {
        mergedCells = normalizeGrid(payload.grid).mergedCells;
      }
      var keys = ['courses', 'items', 'list', 'data', 'result', 'schedule'];
      for (var k = 0; k < keys.length; k += 1) {
        if (Array.isArray(payload[keys[k]])) {
          list = payload[keys[k]];
          break;
        }
      }
    }
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item || typeof item !== 'object') {
        continue;
      }
      var name = item.name || item.course || item.courseName || item.title || '';
      name = typeof name === 'string' ? name.trim() : '';
      if (!name || NOISE_PATTERN.test(name)) {
        continue;
      }
      var periodStart = toPeriodIndex(item.periodStart);
      var periodEnd = toPeriodIndex(item.periodEnd);
      var rowSpan = Math.round(Number(item.rowSpan));
      if (!isFinite(rowSpan) || rowSpan < 1) {
        rowSpan = 1;
      }
      // rowSpan > 1 但只给了单节：按合并单元格补齐结束节次
      if (periodStart > 0 && rowSpan > 1 && (periodEnd === 0 || periodEnd === periodStart)) {
        periodEnd = Math.min(12, periodStart + rowSpan - 1);
      }
      var periodTimes = timesFromPeriods({ periodStart: periodStart, periodEnd: periodEnd });
      var modelStart = normalizeTimeString(
        item.startTime || item.start_time || item.start || ''
      );
      var modelEnd = normalizeTimeString(item.endTime || item.end_time || item.end || '');
      var weeks = typeof item.weeks === 'string' ? item.weeks.trim() : '';
      var note = item.note || item.remark || item.notes || '';
      note = typeof note === 'string' ? note.trim() : '';
      // 单双周只写进 note（schema 不动），两者都有时用「 · 」拼接
      if (weeks && note.indexOf(weeks) === -1) {
        note = note ? note + ' · ' + weeks : weeks;
      }
      var course = {
        name: name,
        weekday: toWeekday(
          item.weekday !== undefined
            ? item.weekday
            : item.day !== undefined
              ? item.day
              : item.weekDay
        ),
        startTime: periodTimes.startTime || modelStart,
        endTime: periodTimes.endTime || modelEnd,
        teacher: item.teacher || item.lecturer || item.instructor || '',
        place: item.place || item.location || item.room || item.classroom || '',
        note: note.slice(0, NOTE_MAX_LENGTH),
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
        periodStart: periodStart,
        periodEnd: periodEnd,
        weeks: weeks,
        rowSpan: rowSpan,
        col: Math.round(Number(item.col)) > 0 ? Math.round(Number(item.col)) : 0
      };
      applyMergedCells(course, mergedCells);
      // 回填后如果节次变了，时间要跟着重算（节次是唯一事实来源）
      if (course.periodEnd !== periodEnd) {
        var refilled = timesFromPeriods({
          periodStart: course.periodStart,
          periodEnd: course.periodEnd
        });
        if (refilled.startTime) {
          course.startTime = refilled.startTime;
          course.endTime = refilled.endTime;
        }
      }
      out.push(course);
    }
    return out;
  }

  /**
   * 构造带「是否可重试」标记的请求错误。
   * @param {string} message
   * @param {{status?: number, retryable?: boolean}} [options]
   * @return {Error}
   */
  function makeRequestError(message, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var err = new Error(message);
    err.status = isFinite(Number(opts.status)) ? Number(opts.status) : 0;
    err.retryable = opts.retryable === true;
    return err;
  }

  /**
   * 判断错误是否由 abort 引起（用户取消 / 单张超时）。
   * @param {*} err
   * @return {boolean}
   */
  function isAbortError(err) {
    return Boolean(err && (err.name === 'AbortError' || err.code === 20 || err.timedOut === true));
  }

  /**
   * 发起一次 Chat Completions 请求，返回模型正文文本。
   *
   * 错误分两类：429 / 5xx / 网络错误标 `retryable = true`（可退避重试 1 次），
   * 401 / 403 / 404 / 400 属于配置问题，标 `retryable = false`（重试必再失败）。
   *
   * @param {Object} config
   * @param {string} dataUrl
   * @param {string} [prompt]
   * @param {number} [maxTokens]
   * @param {AbortSignal|null} [signal]
   * @return {Promise<string>}
   */
  function requestVisionCompletion(config, dataUrl, prompt, maxTokens, signal) {
    var url = String(config.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    var body = {
      model: config.model,
      temperature: 0.1,
      max_tokens: typeof maxTokens === 'number' ? maxTokens : MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: '你只输出严格的 JSON，不要输出 Markdown 代码块或任何额外说明。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt || EXTRACT_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    };

    var init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey
      },
      body: JSON.stringify(body)
    };
    if (signal) {
      init.signal = signal;
    }

    return global.fetch(url, init).then(
      function (response) {
        return response.text().then(function (text) {
          if (!response.ok) {
            var retryable = response.status === 429 || response.status >= 500;
            throw makeRequestError(friendlyHttpError(response.status, text), {
              status: response.status,
              retryable: retryable
            });
          }
          var payload = null;
          try {
            payload = JSON.parse(text);
          } catch (err) {
            throw makeRequestError('识别服务返回的不是合法 JSON', { retryable: true });
          }
          var content = extractContentText(payload);
          if (!content) {
            throw makeRequestError('识别服务没有返回内容', { retryable: false });
          }
          return content;
        });
      },
      function (err) {
        if (isAbortError(err)) {
          throw err;
        }
        throw makeRequestError('无法连接识别服务（网络不通，或该接口不允许浏览器跨域访问）', {
          retryable: true
        });
      }
    );
  }

  /**
   * 退避等待。
   * @param {number} ms
   * @return {Promise<void>}
   */
  function wait(ms) {
    return new Promise(function (resolve) {
      global.setTimeout(resolve, ms);
    });
  }

  /**
   * 单张图片的请求：45s 超时 + 可重试错误退避重试 1 次。
   *
   * 超时与取消都用 AbortController：超时只 abort 这一张（不影响其它在飞的），
   * 用户取消则通过 runSignal 转发到每一张。
   *
   * @param {Object} config
   * @param {string} dataUrl
   * @param {AbortSignal|null} runSignal 整个运行共用的取消信号
   * @return {Promise<string>}
   */
  function requestWithTimeout(config, dataUrl, runSignal) {
    var canAbort = typeof global.AbortController === 'function';
    var controller = canAbort ? new global.AbortController() : null;
    var timedOut = false;
    var timerId = global.setTimeout(function () {
      timedOut = true;
      if (controller) {
        controller.abort();
      }
    }, PER_IMAGE_TIMEOUT_MS);
    var relay = null;
    if (controller && runSignal && typeof runSignal.addEventListener === 'function') {
      relay = function () {
        if (controller) {
          controller.abort();
        }
      };
      runSignal.addEventListener('abort', relay);
    }

    function cleanup() {
      if (timerId !== null) {
        global.clearTimeout(timerId);
        timerId = null;
      }
      if (relay && runSignal && typeof runSignal.removeEventListener === 'function') {
        runSignal.removeEventListener('abort', relay);
      }
    }

    var attempts = 0;

    function attempt() {
      attempts += 1;
      return requestVisionCompletion(
        config,
        dataUrl,
        EXTRACT_PROMPT,
        MAX_OUTPUT_TOKENS,
        controller ? controller.signal : null
      ).catch(function (err) {
        if (timedOut) {
          throw makeRequestError('识别超时（超过 ' + Math.round(PER_IMAGE_TIMEOUT_MS / 1000) + ' 秒）', {
            retryable: false
          });
        }
        var retryable = Boolean(err && err.retryable);
        var cancelled = runSignal && runSignal.aborted;
        if (!retryable || attempts > MAX_RETRIES || cancelled) {
          throw err;
        }
        // 800ms + 0-200ms 抖动：避免多张图的重试在同一毫秒打回服务商
        return wait(RETRY_BACKOFF_MS + Math.floor(Math.random() * 200)).then(attempt);
      });
    }

    return attempt().then(
      function (text) {
        cleanup();
        return text;
      },
      function (err) {
        cleanup();
        throw err;
      }
    );
  }

  /**
   * 并发池：最多 limit 个任务同时进行，全部结束后 resolve。
   * 单个任务失败不影响其它任务（worker 内部必须自行 catch）。
   *
   * @param {Array<*>} items
   * @param {number} limit
   * @param {function(*, number): Promise<*>} worker
   * @return {Promise<void>}
   */
  function runPool(items, limit, worker) {
    var size = Math.max(1, Math.min(limit, items.length));
    var cursor = 0;
    var active = 0;

    return new Promise(function (resolve) {
      var finished = false;

      function next() {
        if (finished) {
          return;
        }
        if (cursor >= items.length && active === 0) {
          finished = true;
          resolve();
          return;
        }
        while (active < size && cursor < items.length) {
          var index = cursor;
          cursor += 1;
          active += 1;
          worker(items[index], index).then(onSettled, onSettled);
        }
      }

      function onSettled() {
        active -= 1;
        next();
      }

      next();
    });
  }

  /**
   * 创建视觉识别器：并发 2、单张 45s 超时、可重试错误退避重试 1 次、可取消、有进度回调。
   * @param {Object} config
   * @return {function(Array<File>, Object): Promise<Object>}
   */
  function createVisionRecognizer(config) {
    return function (files, ctx) {
      var context = ctx && typeof ctx === 'object' ? ctx : {};
      var source = context.source === 'camera' ? 'camera' : 'screenshot';
      var onProgress = typeof context.onProgress === 'function' ? context.onProgress : null;
      var externalSignal = context.signal || null;
      var canAbort = typeof global.AbortController === 'function';
      var controller = canAbort ? new global.AbortController() : null;
      var cancelled = false;
      var collected = [];
      var warnings = [];
      var total = files.length;
      var completed = 0;
      var failures = 0;
      var calls = 0;
      var multi = total > 1;

      var run = {
        abort: function () {
          cancelled = true;
          if (controller) {
            controller.abort();
          }
        }
      };
      activeRun = run;
      if (controller && externalSignal && typeof externalSignal.addEventListener === 'function') {
        if (externalSignal.aborted) {
          run.abort();
        } else {
          externalSignal.addEventListener('abort', function () {
            run.abort();
          });
        }
      }

      function emitProgress(phase) {
        if (!onProgress) {
          return;
        }
        try {
          onProgress(completed, total, phase);
        } catch (err) {
          /* 进度回调是 UI 的事，绝不让它中断识别 */
        }
      }

      function processOne(index) {
        var label = '第 ' + (index + 1) + ' 张';
        var prefix = multi ? '第 ' + (index + 1) + ' 张图片：' : label + '：';
        if (cancelled) {
          return Promise.resolve();
        }
        return prepareImage(files[index], source)
          .then(function (prepared) {
            if (prepared.blur >= 0 && prepared.blur < BLUR_THRESHOLD) {
              warnings.push('第 ' + (index + 1) + ' 张可能拍糊了，建议重拍（识别继续）。');
            }
            if (prepared.warning) {
              warnings.push(prefix + prepared.warning);
            }
            if (cancelled) {
              return null;
            }
            calls += 1;
            return requestWithTimeout(
              config,
              prepared.dataUrl,
              controller ? controller.signal : null
            ).then(
              function (content) {
                var mapped = mapPayloadToCourses(parseModelJson(content));
                if (mapped.length === 0) {
                  warnings.push(prefix + '没有识别到课程。');
                  return;
                }
                collected = collected.concat(mapped);
              },
              function (err) {
                if (cancelled || isAbortError(err)) {
                  return;
                }
                failures += 1;
                var message = err && err.message ? err.message : '未知错误';
                if (/识别超时/.test(message)) {
                  warnings.push(label + '识别超时，已跳过。');
                  return;
                }
                warnings.push(prefix + message);
              }
            );
          })
          .catch(function (err) {
            if (cancelled) {
              return;
            }
            failures += 1;
            warnings.push(prefix + (err && err.message ? err.message : '未知错误'));
          })
          .then(function () {
            completed += 1;
            emitProgress('done');
          });
      }

      var indexes = [];
      for (var i = 0; i < total; i += 1) {
        indexes.push(i);
      }

      emitProgress('start');

      return runPool(indexes, MAX_CONCURRENCY, processOne).then(function () {
        if (activeRun === run) {
          activeRun = null;
        }
        if (cancelled) {
          warnings.push('识别已取消。');
        }
        var seen = {};
        var unique = [];
        for (var j = 0; j < collected.length; j += 1) {
          var course = collected[j];
          var key = [
            course.name,
            course.weekday,
            course.periodStart,
            course.periodEnd,
            course.startTime,
            course.endTime
          ].join('|');
          if (seen[key]) {
            continue;
          }
          seen[key] = 1;
          unique.push(course);
        }
        return {
          courses: unique,
          warnings: warnings,
          meta: {
            calls: calls,
            failures: failures,
            promptVersion: PROMPT_VERSION,
            cancelled: cancelled
          }
        };
      });
    };
  }

  /**
   * 测试连接：用 1x1 图 + 极短输出验证「地址 / Key / 模型」三者可用。
   * @param {Object} config
   * @return {Promise<{ok: boolean, message: string}>}
   */
  function testConnection(config) {
    var invalid = validateConfig(config);
    if (invalid) {
      return Promise.resolve({ ok: false, message: invalid });
    }
    var probe = {
      baseUrl: String(config.baseUrl).trim().replace(/\/+$/, ''),
      model: String(config.model).trim(),
      apiKey: String(config.apiKey).trim()
    };
    return requestVisionCompletion(probe, TEST_IMAGE_DATA_URL, '这是一张 1x1 测试图。只回复 {"ok":true}，不要输出别的。', 64).then(
      function () {
        return { ok: true, message: '连接成功，模型已响应。' };
      },
      function (err) {
        return { ok: false, message: err && err.message ? err.message : '连接失败' };
      }
    );
  }

  /* ==================== 七、设置界面（自包含在此文件内） ==================== */

  /** 设置界面缓存的 DOM 引用 */
  var configEls = null;

  /**
   * 读取设置表单当前值。
   * @return {{provider: string, baseUrl: string, model: string, apiKey: string}}
   */
  function readConfigForm() {
    if (!configEls) {
      return { provider: 'custom', baseUrl: '', model: '', apiKey: '' };
    }
    return {
      provider: configEls.provider ? configEls.provider.value : 'custom',
      baseUrl: configEls.base ? configEls.base.value : '',
      model: configEls.model ? configEls.model.value : '',
      apiKey: configEls.key ? configEls.key.value : ''
    };
  }

  /**
   * 刷新「已配置 / 未配置」状态徽标。
   */
  function renderConfigState() {
    if (!configEls || !configEls.state) {
      return;
    }
    var config = readConfig();
    if (config) {
      configEls.state.textContent = '已配置 · ' + config.model;
      configEls.state.classList.add('is-ready');
    } else {
      configEls.state.textContent = '未配置';
      configEls.state.classList.remove('is-ready');
    }
  }

  /**
   * 把已保存的配置回填到表单；没有配置时用当前服务商预设填充。
   */
  function fillConfigForm() {
    if (!configEls) {
      return;
    }
    var config = readConfig();
    if (config) {
      if (configEls.provider) {
        configEls.provider.value = config.provider;
      }
      if (configEls.base) {
        configEls.base.value = config.baseUrl;
      }
      if (configEls.model) {
        configEls.model.value = config.model;
      }
      if (configEls.key) {
        configEls.key.value = config.apiKey;
      }
    } else {
      var preset = PROVIDERS[configEls.provider ? configEls.provider.value : 'qwen'] || PROVIDERS.qwen;
      if (configEls.base) {
        configEls.base.value = preset.baseUrl;
      }
      if (configEls.model) {
        configEls.model.value = preset.model;
      }
    }
    renderConfigState();
  }

  /**
   * 设置区结果文案。
   * @param {string} text
   * @param {'ok'|'error'|''} tone
   */
  function setConfigFeedback(text, tone) {
    if (!configEls || !configEls.result) {
      return;
    }
    configEls.result.textContent = text || '';
    configEls.result.classList.toggle('is-error', tone === 'error');
    configEls.result.classList.toggle('is-ok', tone === 'ok');
  }

  /**
   * 绑定设置区交互。DOM 缺任何一个都安全跳过（便于在无此面板的环境复用本文件）。
   */
  function initSettingsUI() {
    var details = global.document ? global.document.getElementById('import-config') : null;
    if (!details || details.dataset.bound === '1') {
      return;
    }
    details.dataset.bound = '1';
    configEls = {
      details: details,
      provider: global.document.getElementById('vision-provider'),
      base: global.document.getElementById('vision-base'),
      model: global.document.getElementById('vision-model'),
      key: global.document.getElementById('vision-key'),
      save: global.document.getElementById('vision-save'),
      test: global.document.getElementById('vision-test'),
      clear: global.document.getElementById('vision-clear'),
      state: global.document.getElementById('import-config-state'),
      result: global.document.getElementById('vision-result')
    };

    if (configEls.provider) {
      configEls.provider.addEventListener('change', function () {
        var preset = PROVIDERS[configEls.provider.value];
        if (!preset || configEls.provider.value === 'custom') {
          return;
        }
        if (configEls.base) {
          configEls.base.value = preset.baseUrl;
        }
        if (configEls.model) {
          configEls.model.value = preset.model;
        }
        setConfigFeedback('', '');
      });
    }

    if (configEls.save) {
      configEls.save.addEventListener('click', function () {
        var outcome = saveConfig(readConfigForm());
        if (!outcome.ok) {
          setConfigFeedback(outcome.error, 'error');
          return;
        }
        renderConfigState();
        setConfigFeedback('已保存，现在可以选择课表截图开始识别。', 'ok');
      });
    }

    if (configEls.clear) {
      configEls.clear.addEventListener('click', function () {
        clearConfig();
        if (configEls.key) {
          configEls.key.value = '';
        }
        renderConfigState();
        setConfigFeedback('已清除配置，识别功能回到未配置状态。', 'ok');
      });
    }

    if (configEls.test) {
      configEls.test.addEventListener('click', function () {
        var config = readConfigForm();
        var invalid = validateConfig(config);
        if (invalid) {
          setConfigFeedback(invalid, 'error');
          return;
        }
        configEls.test.disabled = true;
        setConfigFeedback('正在测试连接…', '');
        testConnection(config).then(function (result) {
          configEls.test.disabled = false;
          setConfigFeedback(result.message, result.ok ? 'ok' : 'error');
        });
      });
    }

    fillConfigForm();
    if (!readConfig()) {
      details.open = true;
    }
  }

  /* ==================== 八、导出 ==================== */

  // 启动时若本机已有配置，直接让识别器就绪（应用层无需关心）
  applyConfig(readConfig());
  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', initSettingsUI);
    } else {
      initSettingsUI();
    }
  }

  global.CourseImport = {
    registerRecognizer: registerRecognizer,
    getRecognizerName: getRecognizerName,
    isReady: isReady,
    recognize: recognize,
    abortRecognition: abortRecognition,
    // 视觉模型相关（配置界面与外部脚本都可能用到）
    PROVIDERS: PROVIDERS,
    saveConfig: saveConfig,
    clearConfig: clearConfig,
    getConfig: readConfig,
    testConnection: testConnection,
    // 供界面复用同一套限额文案，避免两处硬编码
    limits: {
      maxFiles: MAX_FILES,
      maxFileSize: MAX_FILE_SIZE,
      timeoutMs: TIMEOUT_MS,
      perImageTimeoutMs: PER_IMAGE_TIMEOUT_MS,
      maxConcurrency: MAX_CONCURRENCY
    },
    // 预处理与提示词的诊断信息（README / 自测脚本会用到）
    diagnostics: {
      promptVersion: PROMPT_VERSION,
      imageMaxEdgeScreenshot: IMAGE_MAX_EDGE_SCREENSHOT,
      imageMaxEdgeCamera: IMAGE_MAX_EDGE_CAMERA,
      imageQuality: IMAGE_QUALITY,
      blurThreshold: BLUR_THRESHOLD,
      prompt: EXTRACT_PROMPT
    },
    NOT_READY_WARNING: NOT_READY_WARNING
  };
})(typeof window !== 'undefined' ? window : globalThis);
