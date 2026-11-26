/**
 * ============================================================================
 * 铃声模块（window.CourseRingtone）
 * ----------------------------------------------------------------------------
 * 职责：铃声清单、试听（Web Audio 实时合成）、选择持久化。
 * 为什么不用音频文件：
 *   1. 零资源体积、零版权风险，打包进手机时不必附带 mp3；
 *   2. `file://` 下 <audio src> 的加载行为在各浏览器不一致，合成音最稳；
 *   3. 铃声需要"短、可循环、可随时打断"，合成比裁剪音频更可控。
 *
 * 存储：course-manager:ringtone:v1 = { version:1, selectedId:string }
 *   读：版本缺失或 ≤1 正常解析；>1 仍尽力解析已知字段（前向兼容），不阻断。
 *   写：永远写 version:1；读取阶段绝不回写。
 *   损坏：JSON.parse 失败 → 回落默认铃声，并把原文备份到 …:corrupt-backup（尽力而为）。
 *
 * 对外契约：
 *   list()                        → 铃声数组（只读副本）
 *   getSelected() / getSelectedId()
 *   setSelected(id)               → WriteResult { ok, notice }
 *   preview(id) / stop() / isPlaying()
 *   ensureAudio()                 → 在用户手势里调用，解锁 iOS 的 AudioContext
 *   isSupported()
 * ============================================================================
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'course-manager:ringtone:v1';
  var BACKUP_KEY = 'course-manager:ringtone:v1:corrupt-backup';
  var VERSION = 1;

  /**
   * 铃声定义。notes 里的元素：[开始秒, 频率Hz, 时长秒, 波形, 峰值增益]。
   * 波形只用 sine / triangle / square，避免谐波过多刺耳；峰值增益统一压到 0.2 以下。
   */
  var RINGTONES = [
    {
      id: 'classic',
      name: '经典铃音',
      desc: '两声下行，像门铃',
      vibrate: [180, 90, 180],
      notes: [
        [0, 659.25, 0.55, 'sine', 0.20],
        [0.42, 523.25, 0.95, 'sine', 0.18]
      ]
    },
    {
      id: 'marimba',
      name: '木琴',
      desc: '四音上行，清脆不吵',
      vibrate: [60, 60, 60, 60],
      notes: [
        [0, 523.25, 0.38, 'triangle', 0.16],
        [0.13, 659.25, 0.38, 'triangle', 0.15],
        [0.26, 783.99, 0.42, 'triangle', 0.14],
        [0.39, 1046.5, 0.75, 'triangle', 0.12]
      ]
    },
    {
      id: 'pulse',
      name: '电子脉冲',
      desc: '短促三连，适合提醒',
      vibrate: [90, 60, 90],
      notes: [
        [0, 880, 0.09, 'square', 0.10],
        [0.16, 880, 0.09, 'square', 0.10],
        [0.32, 880, 0.09, 'square', 0.10],
        [0.78, 987.77, 0.09, 'square', 0.10],
        [0.94, 987.77, 0.09, 'square', 0.10],
        [1.1, 987.77, 0.09, 'square', 0.10]
      ]
    },
    {
      id: 'chime',
      name: '风铃',
      desc: '高频泛音，余音长',
      vibrate: [40, 120, 40],
      notes: [
        [0, 1318.51, 1.6, 'sine', 0.12],
        [0.18, 1567.98, 1.5, 'sine', 0.09],
        [0.36, 2093.0, 1.3, 'sine', 0.06]
      ]
    },
    {
      id: 'dawn',
      name: '柔和晨光',
      desc: '三音慢起，不惊扰',
      vibrate: [220],
      notes: [
        [0, 392.0, 0.9, 'triangle', 0.14],
        [0.34, 523.25, 0.9, 'triangle', 0.13],
        [0.68, 659.25, 1.4, 'triangle', 0.12]
      ]
    },
    {
      id: 'radar',
      name: '雷达',
      desc: '单声回响，间隔较长',
      vibrate: [400],
      notes: [
        [0, 740, 0.5, 'sine', 0.16],
        [0.42, 740, 0.35, 'sine', 0.08],
        [1.5, 740, 0.5, 'sine', 0.16],
        [1.92, 740, 0.35, 'sine', 0.08]
      ]
    },
    {
      id: 'silent',
      name: '静音',
      desc: '只震动，不发声',
      vibrate: [220, 120, 220],
      notes: []
    }
  ];

  var DEFAULT_ID = 'classic';

  var audioCtx = null;
  var masterGain = null;
  var activeNodes = [];
  var stopTimer = 0;
  var playingId = null;

  /* ---------------------------- 存储 ---------------------------- */

  function cloneRingtone(r) {
    return {
      id: r.id,
      name: r.name,
      desc: r.desc,
      silent: r.notes.length === 0
    };
  }

  /**
   * 列出全部铃声（只读副本，UI 不应拿到内部数组引用）。
   * @return {Array<{id:string,name:string,desc:string,silent:boolean}>}
   */
  function list() {
    var out = [];
    for (var i = 0; i < RINGTONES.length; i += 1) {
      out.push(cloneRingtone(RINGTONES[i]));
    }
    return out;
  }

  function findRingtone(id) {
    for (var i = 0; i < RINGTONES.length; i += 1) {
      if (RINGTONES[i].id === id) {
        return RINGTONES[i];
      }
    }
    return null;
  }

  /**
   * 读取已保存的铃声配置。任何异常都回落默认值，绝不抛错。
   * @return {{selectedId:string, notice:string|null}}
   */
  function readConfig() {
    var fallback = { selectedId: DEFAULT_ID, notice: null };
    var raw = null;
    try {
      raw = global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return { selectedId: DEFAULT_ID, notice: '无法读取本机存储，铃声设置不会被保存。' };
    }
    if (!raw) {
      return fallback;
    }
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 损坏：尽力备份原文（只备份一次，避免覆盖最早的真实数据），但不阻断使用
      try {
        if (!global.localStorage.getItem(BACKUP_KEY)) {
          global.localStorage.setItem(BACKUP_KEY, raw);
        }
      } catch (e2) {
        /* 备份失败不影响主流程 */
      }
      return { selectedId: DEFAULT_ID, notice: '铃声设置数据已损坏，已恢复为默认铃声。' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return fallback;
    }
    var id = typeof parsed.selectedId === 'string' ? parsed.selectedId : '';
    // 未来版本可能删掉某个铃声：落到默认值，而不是让 UI 选不中任何一项
    if (!findRingtone(id)) {
      var futureNotice = Number(parsed.version) > VERSION ? '铃声设置由更高版本创建，已使用默认铃声。' : null;
      return { selectedId: DEFAULT_ID, notice: futureNotice };
    }
    return { selectedId: id, notice: null };
  }

  function getSelectedId() {
    return readConfig().selectedId;
  }

  function getSelected() {
    return cloneRingtone(findRingtone(getSelectedId()) || findRingtone(DEFAULT_ID));
  }

  /**
   * 保存选择。
   * @param {string} id
   * @return {{ok:boolean, notice:string|null}}
   */
  function setSelected(id) {
    var target = findRingtone(id);
    if (!target) {
      return { ok: false, notice: '没有这个铃声。' };
    }
    try {
      global.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: VERSION, selectedId: target.id })
      );
      return { ok: true, notice: null };
    } catch (e) {
      return { ok: false, notice: '保存失败：本机存储不可用（可能空间已满或被禁用）。' };
    }
  }

  /* ---------------------------- 播放 ---------------------------- */

  function isSupported() {
    var Ctor = global.AudioContext || global.webkitAudioContext;
    return typeof Ctor === 'function';
  }

  /**
   * 创建 / 恢复 AudioContext。必须在用户手势（click / touch）里调用，
   * 否则 iOS 会把它创建成 suspended 状态且之后无法播放。
   * @return {boolean}
   */
  function ensureAudio() {
    if (!isSupported()) {
      return false;
    }
    if (!audioCtx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      try {
        audioCtx = new Ctor();
      } catch (e) {
        audioCtx = null;
        return false;
      }
      try {
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 1;
        masterGain.connect(audioCtx.destination);
      } catch (e) {
        masterGain = null;
      }
    }
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      try {
        audioCtx.resume();
      } catch (e) {
        /* 恢复失败时保持静默，由调用方决定是否提示 */
      }
    }
    return true;
  }

  /** 停掉所有已排期的振荡器与定时器。 */
  function stop() {
    for (var i = 0; i < activeNodes.length; i += 1) {
      var node = activeNodes[i];
      try {
        node.stop();
      } catch (e) {
        /* 已经自然结束的节点，stop 会抛错，忽略即可 */
      }
      try {
        node.disconnect();
      } catch (e) {
        /* 同上 */
      }
    }
    activeNodes = [];
    if (stopTimer) {
      global.clearTimeout(stopTimer);
      stopTimer = 0;
    }
    playingId = null;
  }

  function scheduleRingtone(ringtone) {
    var ctx = audioCtx;
    if (!ctx || !ringtone) {
      return;
    }
    var now = ctx.currentTime + 0.02;
    var endAt = 0;

    for (var i = 0; i < ringtone.notes.length; i += 1) {
      var note = ringtone.notes[i];
      var at = now + note[0];
      var dur = note[2];
      var osc = ctx.createOscillator();
      var env = ctx.createGain();
      osc.type = note[3];
      osc.frequency.setValueAtTime(note[1], at);
      // 指数衰减比线性更接近真实铃声（起音快、尾巴长）
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(note[4], at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(env);
      env.connect(masterGain || ctx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.02);
      activeNodes.push(osc);
      if (note[0] + dur > endAt) {
        endAt = note[0] + dur;
      }
    }

    playingId = ringtone.id;
    stopTimer = global.setTimeout(function () {
      stopTimer = 0;
      playingId = null;
      activeNodes = [];
    }, Math.ceil((endAt + 0.15) * 1000));
  }

  function vibrate(pattern) {
    if (!pattern || typeof global.navigator === 'undefined') {
      return;
    }
    if (typeof global.navigator.vibrate !== 'function') {
      return;
    }
    // 浏览器要求"用户已与页面交互过"才允许震动。没有这个判断时，
    // 自动触发的提醒会在控制台刷一串 Blocked call to navigator.vibrate。
    var activation = global.navigator.userActivation;
    if (activation && activation.isActive === false) {
      return;
    }
    try {
      global.navigator.vibrate(pattern);
    } catch (e) {
      /* 不支持震动就算了，不打扰用户 */
    }
  }

  /**
   * 试听指定铃声。重复点击同一个铃声会先停再播（符合闹钟试听的手感）。
   * @param {string} id
   * @return {{ok:boolean, notice:string|null}}
   */
  function preview(id) {
    var ringtone = findRingtone(id || getSelectedId());
    if (!ringtone) {
      return { ok: false, notice: '没有这个铃声。' };
    }
    stop();
    if (!ringtone.notes.length) {
      vibrate(ringtone.vibrate);
      return { ok: true, notice: '静音铃声只震动。' };
    }
    if (!ensureAudio()) {
      return { ok: false, notice: '当前浏览器不支持播放声音。' };
    }
    if (audioCtx.state === 'suspended') {
      // resume() 是异步的：此时 state 仍是 'suspended'，不能据此判定"被拦截"。
      // 先乐观返回成功，等 resume 完成后再真正排期；失败就静默（提醒卡片本身仍在）。
      var resuming = audioCtx.resume();
      if (resuming && typeof resuming.then === 'function') {
        resuming
          .then(function () {
            if (audioCtx && audioCtx.state === 'running') {
              scheduleRingtone(ringtone);
            }
          })
          .catch(function () {
            /* 无法恢复就当作静音提醒，不打断流程 */
          });
      }
      return { ok: true, notice: null };
    }
    scheduleRingtone(ringtone);
    vibrate(ringtone.vibrate);
    return { ok: true, notice: null };
  }

  function isPlaying() {
    return playingId !== null;
  }

  function getPlayingId() {
    return playingId;
  }

  global.CourseRingtone = {
    STORAGE_KEY: STORAGE_KEY,
    list: list,
    getSelected: getSelected,
    getSelectedId: getSelectedId,
    setSelected: setSelected,
    preview: preview,
    stop: stop,
    isPlaying: isPlaying,
    getPlayingId: getPlayingId,
    ensureAudio: ensureAudio,
    isSupported: isSupported
  };
})(typeof window !== 'undefined' ? window : this);
