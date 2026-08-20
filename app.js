(function () {
  'use strict';

  var STORAGE_KEY = 'ironlog.sets.v1';
  var WORKOUTS_STORAGE_KEY = 'ironlog.workouts.v1';
  var REST_TARGET_KEY = 'ironlog.restTarget.v1';
  var REST_TARGET_PRESETS = [null, 60, 90, 120, 150, 180];
  var TEMPLATES_KEY = 'ironlog.templates.v1';
  var BODYWEIGHT_KEY = 'ironlog.bodyweights.v1';
  var PINNED_KEY = 'ironlog.pinned.v1';
  var PLATE_SIZES = [45, 35, 25, 10, 5, 2.5];

  var SYNC_CODE_KEY = 'ironlog.syncCode.v1';
  var SUPABASE_URL = 'https://feqgozzxbjaoctwemmxp.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_QfHJbnEJANsrT3RkrkeLTA_YHg2VRej';

  // ---------- storage ----------

  function loadSets() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveSets(sets) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  }

  function loadWorkouts() {
    try {
      var raw = localStorage.getItem(WORKOUTS_STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveWorkouts(workouts) {
    localStorage.setItem(WORKOUTS_STORAGE_KEY, JSON.stringify(workouts));
  }

  function loadRestTarget() {
    var raw = localStorage.getItem(REST_TARGET_KEY);
    if (raw === null) return null;
    var n = Number(raw);
    return isNaN(n) ? null : n;
  }

  function saveRestTarget(seconds) {
    if (seconds === null) localStorage.removeItem(REST_TARGET_KEY);
    else localStorage.setItem(REST_TARGET_KEY, String(seconds));
  }

  function loadTemplates() {
    try {
      var raw = localStorage.getItem(TEMPLATES_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveTemplates(templates) {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
  }

  function loadBodyweights() {
    try {
      var raw = localStorage.getItem(BODYWEIGHT_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveBodyweights(list) {
    localStorage.setItem(BODYWEIGHT_KEY, JSON.stringify(list));
  }

  function loadPinned() {
    try {
      var raw = localStorage.getItem(PINNED_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function savePinned(list) {
    localStorage.setItem(PINNED_KEY, JSON.stringify(list));
  }

  var state = {
    sets: loadSets(),
    workouts: loadWorkouts(),
    templates: loadTemplates(),
    bodyweights: loadBodyweights(),
    pinnedExercises: loadPinned(),
    activeTemplateExercises: [],
    lastEndedWorkoutId: null,
    historySearchQuery: '',
    selectedExercise: null,
    metric: 'topWeight',
    view: 'menu',
    workoutActive: false,
    workoutStartTime: null,
    lastSetTime: null,
    currentWorkoutId: null,
    restTargetSeconds: loadRestTarget(),
    restAlertFired: false,
    editingEntryId: null,
    pendingConfirmAction: null,
    syncCode: localStorage.getItem(SYNC_CODE_KEY),
    syncStatus: 'idle',
    lastSyncedAt: null,
    // Guards against pushing stale pre-pull local data over a fresher cloud copy
    // while the initial pull (on page load) is still in flight.
    syncReady: false,
  };
  state.syncReady = !state.syncCode;

  // ---------- calculations ----------

  function estOneRepMax(weight, reps) {
    if (reps <= 1) return weight;
    return weight * (1 + reps / 30);
  }

  function volumeOf(entry) {
    return entry.weight * entry.reps;
  }

  function distinctExercises(sets) {
    var seen = {};
    var out = [];
    sets.forEach(function (s) {
      var key = s.exercise.toLowerCase();
      if (!seen[key]) {
        seen[key] = true;
        out.push(s.exercise);
      }
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  // Most recently used exercise names, most recent first.
  function recentExercises(sets, limit) {
    var byKey = {};
    sets.forEach(function (s) {
      var key = s.exercise.toLowerCase();
      if (!byKey[key] || s.createdAt > byKey[key].createdAt) {
        byKey[key] = { name: s.exercise, createdAt: s.createdAt };
      }
    });
    var order = Object.keys(byKey).map(function (k) { return byKey[k]; });
    order.sort(function (a, b) { return b.createdAt - a.createdAt; });
    return order.slice(0, limit || 6).map(function (o) { return o.name; });
  }

  function lastEntryForExercise(sets, exercise) {
    var key = exercise.toLowerCase();
    var match = null;
    sets.forEach(function (s) {
      if (s.exercise.toLowerCase() !== key) return;
      if (!match || s.createdAt > match.createdAt) match = s;
    });
    return match;
  }

  function lastEntryOverall(sets) {
    if (sets.length === 0) return null;
    var match = sets[0];
    sets.forEach(function (s) { if (s.createdAt > match.createdAt) match = s; });
    return match;
  }

  // Returns a Set of entry ids that count as a PR (beat the prior best for that exercise).
  function computePRIds(sets) {
    var byExercise = {};
    sets.forEach(function (s) {
      var key = s.exercise.toLowerCase();
      if (!byExercise[key]) byExercise[key] = [];
      byExercise[key].push(s);
    });

    var prIds = {};
    Object.keys(byExercise).forEach(function (key) {
      var entries = byExercise[key].slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.createdAt - b.createdAt;
      });
      var maxWeight = -Infinity;
      var maxE1rm = -Infinity;
      entries.forEach(function (entry, idx) {
        var e1rm = estOneRepMax(entry.weight, entry.reps);
        if (idx > 0 && (entry.weight > maxWeight || e1rm > maxE1rm)) {
          prIds[entry.id] = true;
        }
        if (entry.weight > maxWeight) maxWeight = entry.weight;
        if (e1rm > maxE1rm) maxE1rm = e1rm;
      });
    });
    return prIds;
  }

  // Returns a Set of entry ids that count as a rep PR: more reps than you've ever
  // done at that exact weight before, for that exercise (independent of the
  // weight/e1RM PR above — a lighter, higher-rep set can still be a rep PR).
  function computeRepPRIds(sets) {
    var byExerciseWeight = {};
    sets.forEach(function (s) {
      var key = s.exercise.toLowerCase() + '|' + s.weight;
      if (!byExerciseWeight[key]) byExerciseWeight[key] = [];
      byExerciseWeight[key].push(s);
    });

    var repPrIds = {};
    Object.keys(byExerciseWeight).forEach(function (key) {
      var entries = byExerciseWeight[key].slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.createdAt - b.createdAt;
      });
      var maxReps = -Infinity;
      entries.forEach(function (entry, idx) {
        if (idx > 0 && entry.reps > maxReps) {
          repPrIds[entry.id] = true;
        }
        if (entry.reps > maxReps) maxReps = entry.reps;
      });
    });
    return repPrIds;
  }

  // Groups entries (already filtered to whatever scope, e.g. one date) by exercise.
  // Each group's sets are ordered oldest-first (Set 1, Set 2, ...). Groups are ordered
  // by the most recent activity in that group, newest first.
  function groupByExercise(entries) {
    var byKey = {};
    var order = [];
    entries.forEach(function (s) {
      var key = s.exercise.toLowerCase();
      if (!byKey[key]) {
        byKey[key] = { exercise: s.exercise, entries: [], latest: s.createdAt };
        order.push(key);
      }
      byKey[key].entries.push(s);
      if (s.createdAt > byKey[key].latest) byKey[key].latest = s.createdAt;
    });
    var groups = order.map(function (k) { return byKey[k]; });
    groups.forEach(function (g) {
      g.entries.sort(function (a, b) { return a.createdAt - b.createdAt; });
    });
    groups.sort(function (a, b) { return b.latest - a.latest; });
    return groups;
  }

  // ---------- dom refs ----------

  var exerciseInput = document.getElementById('exercise-input');
  var exerciseSuggestions = document.getElementById('exercise-suggestions');
  var weightInput = document.getElementById('weight-input');
  var repsInput = document.getElementById('reps-input');
  var dateInput = document.getElementById('date-input');
  var logForm = document.getElementById('log-form');
  var logSubmitBtn = document.getElementById('log-submit-btn');
  var endExerciseBtn = document.getElementById('end-exercise-btn');

  var repeatBtn = document.getElementById('repeat-last-btn');
  var repeatDetail = document.getElementById('repeat-detail');
  var chipRow = document.getElementById('recent-chips');

  var todayList = document.getElementById('today-list');
  var todayEmpty = document.getElementById('today-empty');

  var exerciseSelect = document.getElementById('exercise-select');
  var metricToggle = document.getElementById('metric-toggle');
  var chartSvg = document.getElementById('chart-svg');
  var chartEmpty = document.getElementById('chart-empty');

  var sessionList = document.getElementById('session-list');
  var sessionEmpty = document.getElementById('session-empty');
  var resetBtn = document.getElementById('reset-btn');

  var toast = document.getElementById('toast');
  var toastMessage = document.getElementById('toast-message');
  var toastUndo = document.getElementById('toast-undo');

  var confirmModal = document.getElementById('confirm-modal');
  var confirmMessage = document.getElementById('confirm-message');
  var confirmCancel = document.getElementById('confirm-cancel');
  var confirmOk = document.getElementById('confirm-ok');

  var tabBar = document.querySelector('.tab-bar');
  var appEl = document.querySelector('.app');
  var siteHeader = document.querySelector('.site-header');
  var headerBackBtn = document.getElementById('header-back-btn');
  var startWorkoutBtn = document.getElementById('start-workout-btn');
  var menuProgressBtn = document.getElementById('menu-progress-btn');
  var menuHistoryBtn = document.getElementById('menu-history-btn');
  var menuStat = document.getElementById('menu-stat');

  var workoutStatusBar = document.getElementById('workout-status-bar');
  var workoutTimerEl = document.getElementById('workout-timer');
  var restTimerEl = document.getElementById('rest-timer');
  var restBlock = document.getElementById('rest-block');
  var endWorkoutBtn = document.getElementById('end-workout-btn');
  var workoutHistoryList = document.getElementById('workout-history-list');
  var workoutHistoryEmpty = document.getElementById('workout-history-empty');

  var summaryDuration = document.getElementById('summary-duration');
  var summarySets = document.getElementById('summary-sets');
  var summaryVolume = document.getElementById('summary-volume');
  var summaryExerciseList = document.getElementById('summary-exercise-list');
  var summaryDoneBtn = document.getElementById('summary-done-btn');

  var menuStatWeek = document.getElementById('menu-stat-week');
  var recordsList = document.getElementById('records-list');
  var recordsEmpty = document.getElementById('records-empty');

  var exportBtn = document.getElementById('export-btn');
  var importBtn = document.getElementById('import-btn');
  var importFileInput = document.getElementById('import-file-input');

  var editModal = document.getElementById('edit-modal');
  var editWeightInput = document.getElementById('edit-weight-input');
  var editRepsInput = document.getElementById('edit-reps-input');
  var editNoteInput = document.getElementById('edit-note-input');
  var editCancelBtn = document.getElementById('edit-cancel');
  var editSaveBtn = document.getElementById('edit-save');

  var menuStreak = document.getElementById('menu-streak');

  var bodyweightForm = document.getElementById('bodyweight-form');
  var bodyweightInput = document.getElementById('bodyweight-input');
  var bodyweightTrend = document.getElementById('bodyweight-trend');
  var bodyweightList = document.getElementById('bodyweight-list');
  var bodyweightEmpty = document.getElementById('bodyweight-empty');

  var historySearchInput = document.getElementById('history-search');
  var sessionSearchEmpty = document.getElementById('session-search-empty');
  var sessionSearchEmptyQuery = document.getElementById('session-search-empty-query');

  var templatesList = document.getElementById('templates-list');
  var templatesEmpty = document.getElementById('templates-empty');
  var templateModal = document.getElementById('template-modal');
  var templateNameInput = document.getElementById('template-name-input');
  var templateCancelBtn = document.getElementById('template-cancel');
  var templateSaveBtn = document.getElementById('template-save');

  var plateCalcBtn = document.getElementById('plate-calc-btn');
  var plateModal = document.getElementById('plate-modal');
  var plateBarInput = document.getElementById('plate-bar-input');
  var plateResult = document.getElementById('plate-result');
  var plateCloseBtn = document.getElementById('plate-close');
  var plateSizeBtns = document.querySelectorAll('.plate-size-btn');
  var plateClearBtn = document.getElementById('plate-clear-btn');
  var plateCalculateBtn = document.getElementById('plate-calculate-btn');

  var summaryShareBtn = document.getElementById('summary-share-btn');
  var summarySaveTemplateBtn = document.getElementById('summary-save-template-btn');

  var syncDisabledView = document.getElementById('sync-disabled-view');
  var syncEnabledView = document.getElementById('sync-enabled-view');
  var syncEnableBtn = document.getElementById('sync-enable-btn');
  var syncRestoreInput = document.getElementById('sync-restore-input');
  var syncRestoreBtn = document.getElementById('sync-restore-btn');
  var syncCodeDisplay = document.getElementById('sync-code-display');
  var syncCodeCopyBtn = document.getElementById('sync-code-copy-btn');
  var syncStatusText = document.getElementById('sync-status-text');
  var syncDisableBtn = document.getElementById('sync-disable-btn');

  var toastTimer = null;
  var timerIntervalId = null;

  function dateStrFromDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function todayStr() {
    return dateStrFromDate(new Date());
  }

  function formatDate(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatShort(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- click sound (industrial mechanical switch) ----------

  var audioCtx = null;

  function getAudioCtx() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // A mechanical-keyboard-style click: a short burst of filtered noise (the
  // percussive "snap" of a switch), not a tone sweep — that's what actually
  // reads as a key click rather than a synth blip.
  function playClickSound() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    var duration = 0.02;

    var bufferSize = Math.max(1, Math.round(ctx.sampleRate * duration));
    var buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) {
      var decay = Math.pow(1 - i / bufferSize, 3);
      data[i] = (Math.random() * 2 - 1) * decay;
    }

    var noise = ctx.createBufferSource();
    noise.buffer = buffer;

    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3200;
    filter.Q.value = 0.9;

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start(t);
    noise.stop(t + duration);
  }

  // A short triumphant three-note chime for the instant a PR is logged.
  function playPRSound() {
    var ctx = getAudioCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      var start = t + i * 0.07;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  }

  // Delegated on pointerdown (not click) so it fires uniformly for every button —
  // including the +/- steppers, which use pointerdown for hold-to-repeat and would
  // otherwise double-fire (or miss the sound) if this listened for 'click' instead.
  document.addEventListener('pointerdown', function (e) {
    var btn = e.target.closest('button');
    if (btn && !btn.disabled) playClickSound();
  }, { passive: true });

  // ---------- toast ----------

  function showToast(message, undoFn) {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastMessage.textContent = message;
    toast.classList.remove('hidden');
    toastUndo.onclick = function () {
      toast.classList.add('hidden');
      if (toastTimer) clearTimeout(toastTimer);
      if (undoFn) undoFn();
    };
    toastTimer = setTimeout(function () {
      toast.classList.add('hidden');
    }, 5000);
  }

  // ---------- tab navigation ----------

  tabBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    switchView(btn.getAttribute('data-view'));
  });

  function switchView(view) {
    state.view = view;
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (section) {
      section.classList.toggle('active', section.id === 'view-' + view);
    });

    var isMenu = view === 'menu';
    var isSummary = view === 'summary';
    siteHeader.classList.toggle('hidden', isMenu);
    tabBar.classList.toggle('hidden', isMenu || isSummary);
    headerBackBtn.classList.toggle('hidden', isMenu);
    appEl.classList.toggle('no-tabbar', isMenu || isSummary);

    if (!isMenu) {
      Array.prototype.forEach.call(tabBar.querySelectorAll('.tab-btn'), function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === view);
      });
    }

    if (view === 'progress') renderChart();
    if (view === 'menu') renderMenuStat();
    window.scrollTo(0, 0);
  }

  function endWorkoutAndProceed() {
    var saved = endWorkout();
    if (saved) {
      state.lastEndedWorkoutId = saved.id;
      renderSummary(saved);
      switchView('summary');
    } else {
      switchView('menu');
    }
  }

  headerBackBtn.addEventListener('click', endWorkoutAndProceed);
  startWorkoutBtn.addEventListener('click', function () {
    startWorkoutTimers();
    switchView('log');
  });
  menuProgressBtn.addEventListener('click', function () { switchView('progress'); });
  menuHistoryBtn.addEventListener('click', function () { switchView('history'); });
  summaryDoneBtn.addEventListener('click', function () { switchView('menu'); });
  endWorkoutBtn.addEventListener('click', endWorkoutAndProceed);

  // ---------- workout timer + rest stopwatch ----------

  function formatElapsed(ms) {
    var totalSeconds = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    var ss = String(s).padStart(2, '0');
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
    return m + ':' + ss;
  }

  function restLabelText() {
    return state.restTargetSeconds ? 'Rest (' + state.restTargetSeconds + 's)' : 'Rest';
  }

  function updateTimerDisplay() {
    workoutTimerEl.textContent = formatElapsed(Date.now() - state.workoutStartTime);
    if (state.lastSetTime) {
      var restMs = Date.now() - state.lastSetTime;
      restTimerEl.textContent = formatElapsed(restMs);
      restBlock.classList.add('resting');

      if (state.restTargetSeconds && !state.restAlertFired && restMs / 1000 >= state.restTargetSeconds) {
        state.restAlertFired = true;
        restBlock.classList.add('rest-alert');
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      }
    } else {
      restTimerEl.textContent = '—';
      restBlock.classList.remove('resting');
    }
  }

  restBlock.addEventListener('click', function () {
    var idx = REST_TARGET_PRESETS.indexOf(state.restTargetSeconds);
    var next = REST_TARGET_PRESETS[(idx + 1) % REST_TARGET_PRESETS.length];
    state.restTargetSeconds = next;
    saveRestTarget(next);
    restBlock.classList.remove('rest-alert');
    restBlock.querySelector('.status-label').textContent = restLabelText();
  });

  // ---------- keep screen awake during a workout ----------

  var wakeLock = null;

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
    }).catch(function () {});
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.workoutActive) requestWakeLock();
  });

  function startWorkoutTimers() {
    state.workoutActive = true;
    state.workoutStartTime = Date.now();
    state.lastSetTime = null;
    state.restAlertFired = false;
    state.activeTemplateExercises = [];
    state.currentWorkoutId = 'workout_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    workoutStatusBar.classList.remove('hidden');
    appEl.classList.add('with-status-bar');
    restBlock.classList.remove('rest-alert');
    restBlock.querySelector('.status-label').textContent = restLabelText();
    if (timerIntervalId) clearInterval(timerIntervalId);
    timerIntervalId = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
    requestWakeLock();
  }

  function stopWorkoutTimers() {
    state.workoutActive = false;
    if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }
    workoutStatusBar.classList.add('hidden');
    appEl.classList.remove('with-status-bar');
    releaseWakeLock();
  }

  // Saves a Past Workout record if any sets were actually logged during this
  // session, then stops the timers. Starting-and-immediately-ending with no
  // sets logged is treated as a no-op (nothing worth showing in history).
  function endWorkout() {
    var saved = null;
    if (state.workoutActive && state.currentWorkoutId) {
      var workoutId = state.currentWorkoutId;
      var loggedInWorkout = state.sets.filter(function (s) { return s.workoutId === workoutId; });
      if (loggedInWorkout.length > 0) {
        saved = {
          id: workoutId,
          date: dateStrFromDate(new Date(state.workoutStartTime)),
          startedAt: state.workoutStartTime,
          endedAt: Date.now(),
          durationMs: Date.now() - state.workoutStartTime,
        };
        state.workouts.push(saved);
        saveWorkouts(state.workouts);
      }
    }
    state.currentWorkoutId = null;
    stopWorkoutTimers();
    render();
    return saved;
  }

  function markSetLogged() {
    state.lastSetTime = Date.now();
    state.restAlertFired = false;
    restBlock.classList.remove('rest-alert');
    if (state.workoutActive) updateTimerDisplay();
  }

  function relativeDayLabel(dateStr) {
    var today = todayStr();
    if (dateStr === today) return 'today';
    var d = new Date(dateStr + 'T00:00:00');
    var t = new Date(today + 'T00:00:00');
    var days = Math.round((t - d) / 86400000);
    if (days === 1) return 'yesterday';
    if (days > 1 && days < 7) return days + ' days ago';
    return formatShort(dateStr);
  }

  // Consecutive days (ending today or yesterday) with at least one completed workout.
  function computeStreak() {
    var dates = {};
    state.workouts.forEach(function (w) { dates[w.date] = true; });
    if (Object.keys(dates).length === 0) return 0;

    var cursor = new Date();
    if (!dates[todayStr()]) cursor.setDate(cursor.getDate() - 1);

    var streak = 0;
    while (dates[dateStrFromDate(cursor)]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function renderMenuStat() {
    if (state.sets.length === 0) {
      menuStat.textContent = 'No sets logged yet.';
      menuStatWeek.textContent = '';
      menuStreak.textContent = '';
      return;
    }
    var last = lastEntryOverall(state.sets);
    var count = state.sets.length;
    menuStat.textContent = count + (count === 1 ? ' set logged' : ' sets logged') + ' · last: ' + last.exercise + ' (' + relativeDayLabel(last.date) + ')';

    var weekAgo = Date.now() - 7 * 86400000;
    var workoutsThisWeek = state.workouts.filter(function (w) { return w.startedAt >= weekAgo; }).length;
    var volumeThisWeek = state.sets
      .filter(function (s) { return s.createdAt >= weekAgo; })
      .reduce(function (sum, s) { return sum + volumeOf(s); }, 0);
    menuStatWeek.textContent = workoutsThisWeek === 0
      ? 'No workouts in the last 7 days'
      : 'This week: ' + workoutsThisWeek + (workoutsThisWeek === 1 ? ' workout' : ' workouts') + ' · ' + Math.round(volumeThisWeek).toLocaleString() + ' lb';

    var streak = computeStreak();
    menuStreak.textContent = streak >= 2 ? '🔥 ' + streak + '-day streak' : '';
  }

  // ---------- steppers ----------

  var stepConfig = {
    weight: { step: 5, min: 0, decimals: 1 },
    reps: { step: 1, min: 1, decimals: 0 },
  };

  var fieldInputs = { weight: weightInput, reps: repsInput };

  function adjustField(field, dir) {
    var cfg = stepConfig[field];
    var input = fieldInputs[field];
    var current = parseFloat(input.value);
    if (isNaN(current)) current = cfg.min;
    var next = current + cfg.step * dir;
    if (next < cfg.min) next = cfg.min;
    input.value = cfg.decimals > 0 ? next.toFixed(1).replace(/\.0$/, '') : String(next);
  }

  var holdTimer = null;
  var holdInterval = null;

  function bindStepper(btn) {
    var field = btn.getAttribute('data-field');
    var dir = parseInt(btn.getAttribute('data-dir'), 10);

    function start(e) {
      e.preventDefault();
      adjustField(field, dir);
      holdTimer = setTimeout(function () {
        holdInterval = setInterval(function () { adjustField(field, dir); }, 90);
      }, 450);
    }
    function stop() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
    }

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.step-btn'), bindStepper);

  // ---------- exercise defaults autofill + set-number badge ----------

  function applyExerciseDefaults(name) {
    var last = lastEntryForExercise(state.sets, name);
    if (!last) return;
    weightInput.value = last.weight;
    repsInput.value = last.reps;
  }

  function updateSubmitLabel() {
    var name = exerciseInput.value.trim();
    if (!name) {
      logSubmitBtn.textContent = 'Log Set';
      return;
    }
    var key = name.toLowerCase();
    var count;
    if (state.workoutActive && state.currentWorkoutId) {
      // Count sets logged in THIS workout session, so the counter starts fresh
      // every workout instead of accumulating across multiple sessions same day.
      count = state.sets.filter(function (s) {
        return s.workoutId === state.currentWorkoutId && s.exercise.toLowerCase() === key;
      }).length;
    } else {
      var selectedDate = dateInput.value || todayStr();
      count = state.sets.filter(function (s) {
        return s.date === selectedDate && s.exercise.toLowerCase() === key;
      }).length;
    }
    logSubmitBtn.textContent = 'Log Set ' + (count + 1);
  }

  dateInput.addEventListener('change', updateSubmitLabel);

  historySearchInput.addEventListener('input', function () {
    state.historySearchQuery = historySearchInput.value;
    var prIds = computePRIds(state.sets);
    var repPrIds = computeRepPRIds(state.sets);
    renderSessionLog(prIds, repPrIds);
  });

  exerciseInput.addEventListener('input', function () {
    updateSubmitLabel();
    renderSuggestions();
  });

  exerciseInput.addEventListener('change', function () {
    if (exerciseInput.value.trim()) applyExerciseDefaults(exerciseInput.value.trim());
    highlightActiveChip();
    updateSubmitLabel();
  });

  // ---------- end exercise (clear form, ready for the next lift) ----------

  endExerciseBtn.addEventListener('click', function () {
    exerciseInput.value = '';
    weightInput.value = '';
    repsInput.value = '';
    highlightActiveChip();
    updateSubmitLabel();
    hideSuggestions();
    exerciseInput.focus();
  });

  // ---------- repeat last set ----------

  repeatBtn.addEventListener('click', function () {
    var last = lastEntryOverall(state.sets);
    if (!last) return;
    exerciseInput.value = last.exercise;
    weightInput.value = last.weight;
    repsInput.value = last.reps;
    highlightActiveChip();
    updateSubmitLabel();
    hideSuggestions();
  });

  function renderRepeatCard() {
    var last = lastEntryOverall(state.sets);
    if (!last) {
      repeatBtn.classList.add('hidden');
      return;
    }
    repeatBtn.classList.remove('hidden');
    repeatDetail.textContent = last.exercise + ' · ' + last.weight + ' lb × ' + last.reps + ' reps';
  }

  // ---------- recent chips ----------

  function highlightActiveChip() {
    var current = exerciseInput.value.trim().toLowerCase();
    Array.prototype.forEach.call(chipRow.querySelectorAll('.chip'), function (chip) {
      chip.classList.toggle('active', chip.getAttribute('data-name').toLowerCase() === current);
    });
  }

  function togglePin(name) {
    var key = name.toLowerCase();
    var idx = state.pinnedExercises.indexOf(key);
    if (idx === -1) state.pinnedExercises.push(key);
    else state.pinnedExercises.splice(idx, 1);
    savePinned(state.pinnedExercises);
    render();
  }

  // Chips prioritize: this workout's template exercises, then pinned exercises,
  // then most-recently-used — deduped, capped at 8.
  function renderChips() {
    var seen = {};
    var names = [];
    function addName(n) {
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      names.push(n);
    }
    (state.activeTemplateExercises || []).forEach(addName);
    distinctExercises(state.sets)
      .filter(function (n) { return state.pinnedExercises.indexOf(n.toLowerCase()) !== -1; })
      .forEach(addName);
    recentExercises(state.sets, 12).forEach(addName);
    names = names.slice(0, 8);

    if (names.length === 0) {
      chipRow.innerHTML = '';
      return;
    }
    chipRow.innerHTML = names.map(function (name) {
      var isPinned = state.pinnedExercises.indexOf(name.toLowerCase()) !== -1;
      return '<button type="button" class="chip' + (isPinned ? ' chip-pinned' : '') + '" data-name="' + escapeHtml(name) + '">' + (isPinned ? '&#9733; ' : '') + escapeHtml(name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(chipRow.querySelectorAll('.chip'), function (chip) {
      chip.addEventListener('click', function () {
        chooseExercise(chip.getAttribute('data-name'));
      });
    });
    highlightActiveChip();
  }

  // ---------- form submit ----------

  logForm.addEventListener('submit', function (e) {
    e.preventDefault();

    var exercise = exerciseInput.value.trim();
    var weight = parseFloat(weightInput.value);
    var reps = parseInt(repsInput.value, 10);
    var date = dateInput.value;

    if (!exercise || isNaN(weight) || isNaN(reps) || reps < 1 || !date) {
      return;
    }

    var entry = {
      id: 'set_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      exercise: exercise,
      weight: weight,
      reps: reps,
      date: date,
      createdAt: Date.now(),
      workoutId: state.workoutActive ? state.currentWorkoutId : null,
    };

    state.sets.push(entry);
    saveSets(state.sets);
    state.selectedExercise = entry.exercise;
    markSetLogged();

    var prIdsNow = computePRIds(state.sets);
    var repPrIdsNow = computeRepPRIds(state.sets);
    if (prIdsNow[entry.id] || repPrIdsNow[entry.id]) {
      playPRSound();
      if (navigator.vibrate) navigator.vibrate([80, 40, 80, 40, 160]);
    }

    // Keep exercise/weight/reps in place: mid-workout you almost always log the
    // next set of the same lift right after, tweaking weight/reps via the steppers.
    exerciseInput.value = exercise;
    weightInput.value = weight;
    repsInput.value = reps;

    render();
    updateSubmitLabel();
  });

  // ---------- delete ----------

  function deleteEntry(id) {
    var idx = state.sets.findIndex(function (s) { return s.id === id; });
    if (idx === -1) return;
    var removed = state.sets[idx];
    var removedIdx = idx;
    state.sets.splice(idx, 1);
    saveSets(state.sets);
    render();
    showToast('Set deleted.', function () {
      state.sets.splice(removedIdx, 0, removed);
      saveSets(state.sets);
      render();
    });
  }

  // ---------- reset ----------

  function openConfirm(message, buttonText, action) {
    confirmMessage.textContent = message;
    confirmOk.textContent = buttonText;
    state.pendingConfirmAction = action;
    confirmModal.classList.remove('hidden');
  }

  resetBtn.addEventListener('click', function () {
    openConfirm('Delete all logged sets? This cannot be undone.', 'Reset', function () {
      state.sets = [];
      saveSets(state.sets);
      state.workouts = [];
      saveWorkouts(state.workouts);
      state.selectedExercise = null;
      render();
    });
  });

  confirmCancel.addEventListener('click', function () {
    confirmModal.classList.add('hidden');
    state.pendingConfirmAction = null;
  });

  confirmOk.addEventListener('click', function () {
    var action = state.pendingConfirmAction;
    confirmModal.classList.add('hidden');
    state.pendingConfirmAction = null;
    if (action) action();
  });

  // ---------- backup: export / import ----------

  function buildFullPayload() {
    return {
      sets: state.sets,
      workouts: state.workouts,
      templates: state.templates,
      bodyweights: state.bodyweights,
      pinnedExercises: state.pinnedExercises,
      restTargetSeconds: state.restTargetSeconds,
    };
  }

  function applyFullPayload(data) {
    state.sets = Array.isArray(data.sets) ? data.sets : [];
    state.workouts = Array.isArray(data.workouts) ? data.workouts : [];
    state.templates = Array.isArray(data.templates) ? data.templates : [];
    state.bodyweights = Array.isArray(data.bodyweights) ? data.bodyweights : [];
    state.pinnedExercises = Array.isArray(data.pinnedExercises) ? data.pinnedExercises : [];
    state.restTargetSeconds = typeof data.restTargetSeconds === 'number' ? data.restTargetSeconds : null;

    saveSets(state.sets);
    saveWorkouts(state.workouts);
    saveTemplates(state.templates);
    saveBodyweights(state.bodyweights);
    savePinned(state.pinnedExercises);
    saveRestTarget(state.restTargetSeconds);

    state.selectedExercise = null;
    restBlock.querySelector('.status-label').textContent = restLabelText();
  }

  exportBtn.addEventListener('click', function () {
    var payload = Object.assign({ exportedAt: new Date().toISOString() }, buildFullPayload());
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'platelog-backup-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', function () {
    importFileInput.value = '';
    importFileInput.click();
  });

  importFileInput.addEventListener('change', function () {
    var file = importFileInput.files && importFileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        showToast('That file is not valid backup data.');
        return;
      }
      if (!parsed || !Array.isArray(parsed.sets) || !Array.isArray(parsed.workouts)) {
        showToast('That file is not valid backup data.');
        return;
      }
      openConfirm('Import will replace all current data with this backup. Continue?', 'Import', function () {
        applyFullPayload(parsed);
        render();
        showToast('Backup imported.');
        scheduleSyncPush();
      });
    };
    reader.readAsText(file);
  });

  // ---------- cloud sync ----------

  var syncPushTimer = null;
  var syncHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };

  function renderSyncPanel() {
    var enabled = !!state.syncCode;
    syncDisabledView.classList.toggle('hidden', enabled);
    syncEnabledView.classList.toggle('hidden', !enabled);
    if (!enabled) return;

    syncCodeDisplay.textContent = state.syncCode;
    if (state.syncStatus === 'syncing') {
      syncStatusText.textContent = 'Syncing…';
    } else if (state.syncStatus === 'error') {
      syncStatusText.textContent = 'Sync failed — will retry on the next change. (Offline is fine, your local data is safe.)';
    } else if (state.lastSyncedAt) {
      syncStatusText.textContent = 'Last synced ' + new Date(state.lastSyncedAt).toLocaleTimeString();
    } else {
      syncStatusText.textContent = 'Not synced yet.';
    }
  }

  function syncPushNow() {
    if (!state.syncCode) return;
    state.syncStatus = 'syncing';
    renderSyncPanel();
    fetch(SUPABASE_URL + '/rest/v1/sync_data?on_conflict=sync_code', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, syncHeaders),
      body: JSON.stringify({
        sync_code: state.syncCode,
        payload: buildFullPayload(),
        updated_at: new Date().toISOString(),
      }),
    }).then(function (res) {
      state.syncStatus = res.ok ? 'idle' : 'error';
      if (res.ok) state.lastSyncedAt = Date.now();
      renderSyncPanel();
    }).catch(function () {
      state.syncStatus = 'error';
      renderSyncPanel();
    });
  }

  // Debounced so rapid changes (several sets logged in a row) collapse into one push.
  function scheduleSyncPush() {
    if (!state.syncCode || !state.syncReady) return;
    if (syncPushTimer) clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(syncPushNow, 1500);
  }

  function syncPull(code) {
    return fetch(SUPABASE_URL + '/rest/v1/sync_data?sync_code=eq.' + encodeURIComponent(code) + '&select=payload,updated_at', {
      headers: syncHeaders,
    }).then(function (res) {
      if (!res.ok) throw new Error('pull failed');
      return res.json();
    }).then(function (rows) {
      return rows && rows[0] ? rows[0] : null;
    });
  }

  syncEnableBtn.addEventListener('click', function () {
    var code = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/-/g, '');
    state.syncCode = code;
    localStorage.setItem(SYNC_CODE_KEY, code);
    renderSyncPanel();
    syncPushNow();
    showToast('Cloud sync enabled. Save your code somewhere safe!');
  });

  syncCodeCopyBtn.addEventListener('click', function () {
    if (!navigator.clipboard) { showToast('Could not copy — select the code manually.'); return; }
    navigator.clipboard.writeText(state.syncCode).then(function () {
      showToast('Sync code copied.');
    }).catch(function () {
      showToast('Could not copy — select the code manually.');
    });
  });

  syncDisableBtn.addEventListener('click', function () {
    openConfirm('Stop syncing this device? Your data already in the cloud stays there — this only stops updating it from here.', 'Disable', function () {
      state.syncCode = null;
      localStorage.removeItem(SYNC_CODE_KEY);
      renderSyncPanel();
    });
  });

  syncRestoreBtn.addEventListener('click', function () {
    var code = syncRestoreInput.value.trim();
    if (!code) return;
    syncRestoreBtn.disabled = true;
    syncPull(code).then(function (row) {
      syncRestoreBtn.disabled = false;
      if (!row) {
        showToast('No data found for that code.');
        return;
      }
      openConfirm('Restore this data? It will replace everything currently on this device.', 'Restore', function () {
        applyFullPayload(row.payload);
        state.syncCode = code;
        localStorage.setItem(SYNC_CODE_KEY, code);
        state.syncReady = true;
        state.lastSyncedAt = Date.now();
        render();
        showToast('Data restored and sync enabled.');
      });
    }).catch(function () {
      syncRestoreBtn.disabled = false;
      showToast('Could not reach the server. Check your connection and try again.');
    });
  });

  // On load, if a sync code already exists locally, pull down the latest cloud
  // copy — this is what recovers your data after local storage gets wiped.
  function initSyncOnLoad() {
    if (!state.syncCode) return;
    syncPull(state.syncCode).then(function (row) {
      if (row && row.payload) {
        applyFullPayload(row.payload);
        state.lastSyncedAt = new Date(row.updated_at).getTime();
        render();
        renderMenuStat();
      }
      state.syncReady = true;
      renderSyncPanel();
    }).catch(function () {
      state.syncReady = true;
      renderSyncPanel();
    });
  }

  // ---------- exercise select / metric toggle (progress view) ----------

  exerciseSelect.addEventListener('change', function () {
    state.selectedExercise = exerciseSelect.value;
    renderChart();
  });

  metricToggle.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-metric]');
    if (!btn) return;
    state.metric = btn.getAttribute('data-metric');
    Array.prototype.forEach.call(metricToggle.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b === btn);
    });
    renderChart();
  });

  // ---------- exercise autocomplete dropdown (works on iOS Safari, unlike <datalist>) ----------

  function hideSuggestions() {
    exerciseSuggestions.classList.add('hidden');
    exerciseSuggestions.innerHTML = '';
  }

  function renderSuggestions() {
    var query = exerciseInput.value.trim().toLowerCase();
    if (!query) { hideSuggestions(); return; }
    var matches = distinctExercises(state.sets).filter(function (name) {
      return name.toLowerCase().indexOf(query) !== -1 && name.toLowerCase() !== query;
    });
    if (matches.length === 0) { hideSuggestions(); return; }
    exerciseSuggestions.innerHTML = matches.slice(0, 6).map(function (name) {
      return '<div class="suggestion-item">' + escapeHtml(name) + '</div>';
    }).join('');
    exerciseSuggestions.classList.remove('hidden');
  }

  function chooseExercise(name) {
    exerciseInput.value = name;
    applyExerciseDefaults(name);
    highlightActiveChip();
    updateSubmitLabel();
    hideSuggestions();
  }

  exerciseSuggestions.addEventListener('click', function (e) {
    var item = e.target.closest('.suggestion-item');
    if (!item) return;
    chooseExercise(item.textContent);
  });

  exerciseInput.addEventListener('focus', renderSuggestions);

  exerciseInput.addEventListener('blur', function () {
    // Delay so a tap on a suggestion registers before the dropdown disappears.
    setTimeout(hideSuggestions, 150);
  });

  // ---------- render: exercise-grouped set lists (shared by Today + History) ----------

  function renderGroupHtml(group, prIds, repPrIds) {
    var best = group.entries[0];
    var totalVolume = 0;
    group.entries.forEach(function (entry) {
      var e1rm = estOneRepMax(entry.weight, entry.reps);
      if (e1rm > estOneRepMax(best.weight, best.reps)) best = entry;
      totalVolume += volumeOf(entry);
    });

    var html = '<div class="exercise-group">';
    html += '  <div class="exercise-group-header">';
    html += '    <span class="exercise-group-name">' + escapeHtml(group.exercise) + '</span>';
    html += '    <span class="exercise-group-summary">Best ' + best.weight + ' lb &times; ' + best.reps + ' reps &middot; Vol ' + Math.round(totalVolume).toLocaleString() + ' lb</span>';
    html += '  </div>';

    group.entries.forEach(function (entry, idx) {
      var isPR = !!prIds[entry.id];
      var isRepPR = !!repPrIds[entry.id];
      var badges = (isPR ? ' <span class="pr-badge">PR</span>' : '') + (isRepPR ? ' <span class="pr-badge rep-pr-badge">REP PR</span>' : '');
      html += '  <div class="set-row" data-id="' + entry.id + '">';
      html += '    <span class="set-row-label">Set ' + (idx + 1) + '</span>';
      html += '    <span class="set-row-main">' + entry.weight + ' lb &times; ' + entry.reps + ' reps' + badges + '</span>';
      html += '    <button type="button" class="delete-btn" data-id="' + entry.id + '" aria-label="Delete set" title="Delete set">&times;</button>';
      if (entry.note) {
        html += '    <span class="set-row-note">' + escapeHtml(entry.note) + '</span>';
      }
      html += '  </div>';
    });

    html += '</div>';
    return html;
  }

  function bindDeleteButtons(container) {
    Array.prototype.forEach.call(container.querySelectorAll('.delete-btn'), function (btn) {
      btn.addEventListener('click', function () {
        deleteEntry(btn.getAttribute('data-id'));
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll('.set-row-main'), function (el) {
      el.addEventListener('click', function () {
        var row = el.closest('.set-row');
        if (row) openEditModal(row.getAttribute('data-id'));
      });
    });
  }

  // ---------- edit set modal ----------

  function openEditModal(id) {
    var entry = state.sets.find(function (s) { return s.id === id; });
    if (!entry) return;
    state.editingEntryId = id;
    editWeightInput.value = entry.weight;
    editRepsInput.value = entry.reps;
    editNoteInput.value = entry.note || '';
    editModal.classList.remove('hidden');
  }

  function closeEditModal() {
    editModal.classList.add('hidden');
    state.editingEntryId = null;
  }

  editCancelBtn.addEventListener('click', closeEditModal);

  editSaveBtn.addEventListener('click', function () {
    var entry = state.sets.find(function (s) { return s.id === state.editingEntryId; });
    if (!entry) { closeEditModal(); return; }
    var weight = parseFloat(editWeightInput.value);
    var reps = parseInt(editRepsInput.value, 10);
    if (isNaN(weight) || isNaN(reps) || reps < 1) return;
    entry.weight = weight;
    entry.reps = reps;
    entry.note = editNoteInput.value.trim();
    saveSets(state.sets);
    closeEditModal();
    render();
  });

  // ---------- render: today list (log view) ----------

  function renderTodayList(prIds, repPrIds) {
    var today = todayStr();
    var entries = state.sets.filter(function (s) { return s.date === today; });

    if (entries.length === 0) {
      todayList.innerHTML = '';
      todayEmpty.classList.remove('hidden');
      return;
    }
    todayEmpty.classList.add('hidden');

    var groups = groupByExercise(entries);
    todayList.innerHTML = groups.map(function (g) { return renderGroupHtml(g, prIds, repPrIds); }).join('');
    bindDeleteButtons(todayList);
  }

  // ---------- render: session log (history view) ----------

  function renderSessionLog(prIds, repPrIds) {
    if (state.sets.length === 0) {
      sessionList.innerHTML = '';
      sessionEmpty.classList.remove('hidden');
      sessionSearchEmpty.classList.add('hidden');
      return;
    }
    sessionEmpty.classList.add('hidden');

    var query = state.historySearchQuery.trim().toLowerCase();
    var sets = query
      ? state.sets.filter(function (s) { return s.exercise.toLowerCase().indexOf(query) !== -1; })
      : state.sets;

    if (sets.length === 0) {
      sessionList.innerHTML = '';
      sessionSearchEmptyQuery.textContent = state.historySearchQuery.trim();
      sessionSearchEmpty.classList.remove('hidden');
      return;
    }
    sessionSearchEmpty.classList.add('hidden');

    var byDate = {};
    sets.forEach(function (s) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    });

    var dates = Object.keys(byDate).sort(function (a, b) { return a < b ? 1 : -1; });

    var html = '';
    dates.forEach(function (date) {
      var groups = groupByExercise(byDate[date]);
      html += '<div class="date-group">';
      html += '<div class="date-heading">' + escapeHtml(formatDate(date)) + '</div>';
      groups.forEach(function (g) { html += renderGroupHtml(g, prIds, repPrIds); });
      html += '</div>';
    });

    sessionList.innerHTML = html;
    bindDeleteButtons(sessionList);
  }

  // ---------- render: past workouts (history view) ----------

  function renderWorkoutHistory() {
    if (state.workouts.length === 0) {
      workoutHistoryList.innerHTML = '';
      workoutHistoryEmpty.classList.remove('hidden');
      return;
    }
    workoutHistoryEmpty.classList.add('hidden');

    var sorted = state.workouts.slice().sort(function (a, b) { return b.startedAt - a.startedAt; });

    workoutHistoryList.innerHTML = sorted.map(function (w) {
      var loggedInWorkout = state.sets.filter(function (s) { return s.workoutId === w.id; });
      var exerciseNames = distinctExercises(loggedInWorkout);
      var totalVolume = loggedInWorkout.reduce(function (sum, s) { return sum + volumeOf(s); }, 0);

      var exercisesText = exerciseNames.join(', ') || 'No exercises logged';
      var statsText = loggedInWorkout.length + (loggedInWorkout.length === 1 ? ' set' : ' sets') + ' &middot; Vol ' + Math.round(totalVolume).toLocaleString() + ' lb';

      var html = '<div class="workout-card">';
      html += '  <div class="workout-card-header">';
      html += '    <span class="workout-card-date">' + escapeHtml(formatDate(w.date)) + '</span>';
      html += '    <span class="workout-card-duration">' + formatElapsed(w.durationMs) + '</span>';
      html += '  </div>';
      html += '  <div class="workout-card-exercises">' + escapeHtml(exercisesText) + '</div>';
      html += '  <div class="workout-card-stats">' + statsText + '</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  // ---------- render: post-workout summary ----------

  function renderSummary(workout) {
    var prIds = computePRIds(state.sets);
    var repPrIds = computeRepPRIds(state.sets);
    var workoutSets = state.sets.filter(function (s) { return s.workoutId === workout.id; });
    var totalVolume = workoutSets.reduce(function (sum, s) { return sum + volumeOf(s); }, 0);

    summaryDuration.textContent = formatElapsed(workout.durationMs);
    summarySets.textContent = workoutSets.length;
    summaryVolume.textContent = Math.round(totalVolume).toLocaleString();

    var groups = groupByExercise(workoutSets);
    summaryExerciseList.innerHTML = groups.map(function (g) {
      var best = g.entries[0];
      g.entries.forEach(function (entry) {
        if (estOneRepMax(entry.weight, entry.reps) > estOneRepMax(best.weight, best.reps)) best = entry;
      });
      var hitPR = g.entries.some(function (entry) { return !!prIds[entry.id]; });
      var hitRepPR = g.entries.some(function (entry) { return !!repPrIds[entry.id]; });
      var badges = (hitPR ? ' <span class="pr-badge">PR</span>' : '') + (hitRepPR ? ' <span class="pr-badge rep-pr-badge">REP PR</span>' : '');
      var vol = g.entries.reduce(function (sum, entry) { return sum + volumeOf(entry); }, 0);

      var html = '<div class="summary-exercise">';
      html += '  <div class="summary-exercise-header"><span>' + escapeHtml(g.exercise) + '</span>' + badges + '</div>';
      html += '  <div class="summary-exercise-detail">Best ' + best.weight + ' lb &times; ' + best.reps + ' reps &middot; ' + g.entries.length + (g.entries.length === 1 ? ' set' : ' sets') + ' &middot; Vol ' + Math.round(vol).toLocaleString() + ' lb</div>';
      html += '</div>';
      return html;
    }).join('');
  }

  // ---------- render: personal records (progress view) ----------

  function computeRecords() {
    var byExercise = {};
    state.sets.forEach(function (s) {
      var key = s.exercise.toLowerCase();
      var e1rm = estOneRepMax(s.weight, s.reps);
      if (!byExercise[key]) {
        byExercise[key] = {
          exercise: s.exercise,
          bestWeight: s.weight, bestWeightReps: s.reps, bestWeightDate: s.date,
          bestE1rm: e1rm, bestE1rmDate: s.date,
        };
      } else {
        var r = byExercise[key];
        if (s.weight > r.bestWeight) { r.bestWeight = s.weight; r.bestWeightReps = s.reps; r.bestWeightDate = s.date; }
        if (e1rm > r.bestE1rm) { r.bestE1rm = e1rm; r.bestE1rmDate = s.date; }
      }
    });
    return Object.keys(byExercise).map(function (k) { return byExercise[k]; })
      .sort(function (a, b) { return a.exercise.localeCompare(b.exercise); });
  }

  function renderRecords() {
    var records = computeRecords();
    if (records.length === 0) {
      recordsList.innerHTML = '';
      recordsEmpty.classList.remove('hidden');
      return;
    }
    recordsEmpty.classList.add('hidden');

    records.sort(function (a, b) {
      var aPinned = state.pinnedExercises.indexOf(a.exercise.toLowerCase()) !== -1;
      var bPinned = state.pinnedExercises.indexOf(b.exercise.toLowerCase()) !== -1;
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return a.exercise.localeCompare(b.exercise);
    });

    recordsList.innerHTML = records.map(function (r) {
      var isPinned = state.pinnedExercises.indexOf(r.exercise.toLowerCase()) !== -1;
      var html = '<div class="record-row">';
      html += '  <span class="record-row-main"><button type="button" class="pin-btn' + (isPinned ? ' pinned' : '') + '" data-pin-name="' + escapeHtml(r.exercise) + '" aria-label="Pin exercise">' + (isPinned ? '&#9733;' : '&#9734;') + '</button><span class="record-name">' + escapeHtml(r.exercise) + '</span></span>';
      html += '  <span class="record-detail">Top <strong>' + r.bestWeight + ' lb</strong> &middot; e1RM <strong>' + Math.round(r.bestE1rm) + ' lb</strong></span>';
      html += '</div>';
      return html;
    }).join('');

    Array.prototype.forEach.call(recordsList.querySelectorAll('.pin-btn'), function (btn) {
      btn.addEventListener('click', function () {
        togglePin(btn.getAttribute('data-pin-name'));
      });
    });
  }

  // ---------- body weight tracking ----------

  bodyweightForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var w = parseFloat(bodyweightInput.value);
    if (isNaN(w) || w <= 0) return;
    state.bodyweights.push({
      id: 'bw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      weight: w,
      date: todayStr(),
      createdAt: Date.now(),
    });
    saveBodyweights(state.bodyweights);
    bodyweightInput.value = '';
    renderBodyweights();
  });

  function deleteBodyweight(id) {
    var idx = state.bodyweights.findIndex(function (b) { return b.id === id; });
    if (idx === -1) return;
    state.bodyweights.splice(idx, 1);
    saveBodyweights(state.bodyweights);
    renderBodyweights();
  }

  function renderBodyweights() {
    if (state.bodyweights.length === 0) {
      bodyweightList.innerHTML = '';
      bodyweightEmpty.classList.remove('hidden');
      bodyweightTrend.textContent = '';
      return;
    }
    bodyweightEmpty.classList.add('hidden');

    var sorted = state.bodyweights.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    bodyweightList.innerHTML = sorted.slice(0, 10).map(function (b) {
      return '<div class="bw-row" data-id="' + b.id + '"><span class="bw-row-date">' + escapeHtml(formatShort(b.date)) + '</span><span class="bw-row-weight">' + b.weight + ' lb</span><button type="button" class="bw-delete-btn" data-id="' + b.id + '" aria-label="Delete entry">&times;</button></div>';
    }).join('');
    Array.prototype.forEach.call(bodyweightList.querySelectorAll('.bw-delete-btn'), function (btn) {
      btn.addEventListener('click', function () { deleteBodyweight(btn.getAttribute('data-id')); });
    });

    var monthAgo = Date.now() - 30 * 86400000;
    var inWindow = sorted.filter(function (b) { return b.createdAt >= monthAgo; });
    if (inWindow.length >= 2) {
      var latest = inWindow[0];
      var earliest = inWindow[inWindow.length - 1];
      var delta = latest.weight - earliest.weight;
      bodyweightTrend.textContent = (delta > 0 ? '+' : '') + delta.toFixed(1) + ' lb over last 30 days';
    } else {
      bodyweightTrend.textContent = '';
    }
  }

  // ---------- plate calculator ----------

  var plateCounts = {};
  PLATE_SIZES.forEach(function (p) { plateCounts[p] = 0; });

  function updatePlateButtons() {
    Array.prototype.forEach.call(plateSizeBtns, function (btn) {
      var size = btn.getAttribute('data-plate');
      var count = plateCounts[size];
      btn.innerHTML = size + (count > 0 ? '<span class="plate-size-count">&times; ' + count + '</span>' : '');
      btn.classList.toggle('has-count', count > 0);
    });
  }

  function resetPlateCounts() {
    PLATE_SIZES.forEach(function (p) { plateCounts[p] = 0; });
    updatePlateButtons();
    plateResult.innerHTML = '';
  }

  function renderPlateResult() {
    var bar = parseFloat(plateBarInput.value);
    if (isNaN(bar)) { plateResult.innerHTML = '<p class="empty-state">Enter a bar weight.</p>'; return; }
    var perSide = 0;
    var plates = [];
    PLATE_SIZES.forEach(function (p) {
      var count = plateCounts[p];
      if (count > 0) {
        plates.push({ plate: p, count: count });
        perSide += p * count;
      }
    });
    var total = bar + perSide * 2;
    var html = '<div class="plate-line"><span>Total weight</span><span class="plate-per-side">' + total.toFixed(1).replace(/\.0$/, '') + ' lb</span></div>';
    html += '<div class="plate-line"><span>Per side</span><span>' + perSide.toFixed(1).replace(/\.0$/, '') + ' lb</span></div>';
    if (plates.length === 0) {
      html += '<div class="plate-line"><span>Just the bar</span><span></span></div>';
    } else {
      plates.forEach(function (p) {
        html += '<div class="plate-line"><span>' + p.plate + ' lb plate' + (p.count > 1 ? 's' : '') + '</span><span>&times; ' + p.count + '</span></div>';
      });
    }
    plateResult.innerHTML = html;
  }

  plateCalcBtn.addEventListener('click', function () {
    plateBarInput.value = 45;
    resetPlateCounts();
    plateModal.classList.remove('hidden');
  });

  Array.prototype.forEach.call(plateSizeBtns, function (btn) {
    btn.addEventListener('click', function () {
      var size = btn.getAttribute('data-plate');
      plateCounts[size]++;
      updatePlateButtons();
    });
  });

  plateClearBtn.addEventListener('click', resetPlateCounts);
  plateCalculateBtn.addEventListener('click', renderPlateResult);
  plateCloseBtn.addEventListener('click', function () { plateModal.classList.add('hidden'); });

  // ---------- workout templates ----------

  function renderTemplates() {
    if (state.templates.length === 0) {
      templatesList.innerHTML = '';
      templatesEmpty.classList.remove('hidden');
      return;
    }
    templatesEmpty.classList.add('hidden');
    templatesList.innerHTML = state.templates.map(function (tpl) {
      var html = '<div class="template-card">';
      html += '  <div class="template-info"><div class="template-name">' + escapeHtml(tpl.name) + '</div><div class="template-exercises">' + escapeHtml(tpl.exercises.join(', ')) + '</div></div>';
      html += '  <div class="template-actions">';
      html += '    <button type="button" class="template-start-btn" data-id="' + tpl.id + '">Start</button>';
      html += '    <button type="button" class="template-delete-btn" data-id="' + tpl.id + '" aria-label="Delete template">&times;</button>';
      html += '  </div>';
      html += '</div>';
      return html;
    }).join('');
    Array.prototype.forEach.call(templatesList.querySelectorAll('.template-start-btn'), function (btn) {
      btn.addEventListener('click', function () { startFromTemplate(btn.getAttribute('data-id')); });
    });
    Array.prototype.forEach.call(templatesList.querySelectorAll('.template-delete-btn'), function (btn) {
      btn.addEventListener('click', function () { deleteTemplate(btn.getAttribute('data-id')); });
    });
  }

  function deleteTemplate(id) {
    var idx = state.templates.findIndex(function (t) { return t.id === id; });
    if (idx === -1) return;
    state.templates.splice(idx, 1);
    saveTemplates(state.templates);
    renderTemplates();
  }

  function startFromTemplate(id) {
    var tpl = state.templates.find(function (t) { return t.id === id; });
    if (!tpl) return;
    startWorkoutTimers();
    state.activeTemplateExercises = tpl.exercises.slice();
    switchView('log');
    if (tpl.exercises.length > 0) {
      exerciseInput.value = tpl.exercises[0];
      applyExerciseDefaults(tpl.exercises[0]);
      updateSubmitLabel();
    }
    render();
  }

  var pendingTemplateWorkoutId = null;

  summarySaveTemplateBtn.addEventListener('click', function () {
    pendingTemplateWorkoutId = state.lastEndedWorkoutId;
    if (!pendingTemplateWorkoutId) return;
    templateNameInput.value = '';
    templateModal.classList.remove('hidden');
    templateNameInput.focus();
  });

  templateCancelBtn.addEventListener('click', function () {
    templateModal.classList.add('hidden');
  });

  templateSaveBtn.addEventListener('click', function () {
    var name = templateNameInput.value.trim();
    if (!name || !pendingTemplateWorkoutId) { templateModal.classList.add('hidden'); return; }
    var workoutSets = state.sets.filter(function (s) { return s.workoutId === pendingTemplateWorkoutId; });
    var exercises = distinctExercises(workoutSets);
    if (exercises.length === 0) { templateModal.classList.add('hidden'); return; }
    state.templates.push({
      id: 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      name: name,
      exercises: exercises,
    });
    saveTemplates(state.templates);
    templateModal.classList.add('hidden');
    showToast('Template saved.');
    renderTemplates();
  });

  // ---------- share workout summary ----------

  summaryShareBtn.addEventListener('click', function () {
    var text = 'Platelog workout\n' +
      'Duration: ' + summaryDuration.textContent + '\n' +
      'Sets: ' + summarySets.textContent + '\n' +
      'Volume: ' + summaryVolume.textContent + ' lb\n' +
      summaryExerciseList.innerText;

    if (navigator.share) {
      navigator.share({ title: 'Platelog Workout', text: text }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('Copied to clipboard.');
      }).catch(function () {
        showToast('Could not copy.');
      });
    } else {
      showToast('Sharing is not supported on this browser.');
    }
  });

  // ---------- render: exercise select ----------

  function renderExerciseSelect() {
    var names = distinctExercises(state.sets);
    if (names.length === 0) {
      exerciseSelect.innerHTML = '';
      exerciseSelect.disabled = true;
      return;
    }
    exerciseSelect.disabled = false;

    if (!state.selectedExercise || names.indexOf(state.selectedExercise) === -1) {
      state.selectedExercise = names[0];
    }

    exerciseSelect.innerHTML = names.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    exerciseSelect.value = state.selectedExercise;
  }

  // ---------- render: chart ----------
  // The chart aggregates every set logged for the exercise on a given day, so
  // "progression" reflects the whole session (e.g. 155x8, 155x7, 150x7), not one set.

  function metricLabel(metric) {
    if (metric === 'topWeight') return 'Top Weight (lb)';
    if (metric === 'e1rm') return 'Est. 1RM (lb)';
    return 'Volume (lb)';
  }

  function aggregateForChart(exercise, metric) {
    var byDate = {};
    state.sets.forEach(function (s) {
      if (s.exercise !== exercise) return;
      var e1rm = estOneRepMax(s.weight, s.reps);
      var vol = volumeOf(s);
      if (!byDate[s.date]) {
        byDate[s.date] = { date: s.date, topWeight: s.weight, e1rm: e1rm, volume: vol };
      } else {
        var d = byDate[s.date];
        d.topWeight = Math.max(d.topWeight, s.weight);
        d.e1rm = Math.max(d.e1rm, e1rm);
        d.volume += vol;
      }
    });
    var points = Object.keys(byDate).map(function (k) { return byDate[k]; });
    points.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return points.map(function (p) { return { date: p.date, value: p[metric] }; });
  }

  function renderChart() {
    if (!state.selectedExercise) {
      chartSvg.innerHTML = '';
      chartSvg.classList.add('hidden');
      chartEmpty.classList.remove('hidden');
      chartEmpty.textContent = 'Log a set to see progress.';
      return;
    }

    var points = aggregateForChart(state.selectedExercise, state.metric);

    if (points.length === 0) {
      chartSvg.innerHTML = '';
      chartSvg.classList.add('hidden');
      chartEmpty.classList.remove('hidden');
      chartEmpty.textContent = 'No data yet for ' + state.selectedExercise + '.';
      return;
    }

    chartEmpty.classList.add('hidden');
    chartSvg.classList.remove('hidden');

    var W = 640, H = 400;
    var padL = 68, padR = 24, padT = 34, padB = 52;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var values = points.map(function (p) { return p.value; });
    var minV = Math.min.apply(null, values);
    var maxV = Math.max.apply(null, values);
    if (minV === maxV) {
      minV = minV - (minV * 0.1 || 1);
      maxV = maxV + (maxV * 0.1 || 1);
    } else {
      var pad = (maxV - minV) * 0.12;
      minV -= pad;
      maxV += pad;
    }
    if (minV < 0 && values.every(function (v) { return v >= 0; })) minV = 0;

    function xFor(i) {
      if (points.length === 1) return padL + plotW / 2;
      return padL + (plotW * i) / (points.length - 1);
    }
    function yFor(v) {
      return padT + plotH - ((v - minV) / (maxV - minV)) * plotH;
    }

    var svg = '';

    var bands = 4;
    for (var b = 0; b <= bands; b++) {
      var v = minV + ((maxV - minV) * b) / bands;
      var y = yFor(v);
      svg += '<line class="chart-grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (padL + plotW) + '" y2="' + y + '" />';
      svg += '<text class="chart-axis-label" x="' + (padL - 12) + '" y="' + (y + 5) + '" text-anchor="end">' + Math.round(v).toLocaleString() + '</text>';
    }

    svg += '<line class="chart-axis-line" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" />';

    var maxLabels = 6;
    var step = Math.max(1, Math.ceil(points.length / maxLabels));
    points.forEach(function (p, i) {
      if (i % step !== 0 && i !== points.length - 1) return;
      var x = xFor(i);
      svg += '<text class="chart-axis-label" x="' + x + '" y="' + (padT + plotH + 26) + '" text-anchor="middle">' + escapeHtml(formatShort(p.date)) + '</text>';
    });

    var linePoints = points.map(function (p, i) { return xFor(i) + ',' + yFor(p.value); }).join(' ');
    svg += '<polyline class="chart-line" points="' + linePoints + '" />';

    points.forEach(function (p, i) {
      var x = xFor(i);
      var y = yFor(p.value);
      svg += '<circle class="chart-point" cx="' + x + '" cy="' + y + '" r="6"><title>' + escapeHtml(formatDate(p.date)) + ': ' + Math.round(p.value).toLocaleString() + '</title></circle>';
    });

    svg += '<text class="chart-title-label" x="' + padL + '" y="18" text-anchor="start">' + escapeHtml(metricLabel(state.metric)) + '</text>';

    chartSvg.innerHTML = svg;
  }

  // ---------- master render ----------

  function render() {
    var prIds = computePRIds(state.sets);
    var repPrIds = computeRepPRIds(state.sets);
    renderExerciseSelect();
    renderSessionLog(prIds, repPrIds);
    renderWorkoutHistory();
    renderTodayList(prIds, repPrIds);
    renderRepeatCard();
    renderChips();
    renderRecords();
    renderBodyweights();
    renderTemplates();
    renderSyncPanel();
    resetBtn.disabled = state.sets.length === 0;
    if (state.view === 'progress') renderChart();
    scheduleSyncPush();
  }

  // ---------- init ----------

  dateInput.value = todayStr();
  restBlock.querySelector('.status-label').textContent = restLabelText();
  render();
  switchView('menu');
  initSyncOnLoad();
})();
