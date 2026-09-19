(() => {
  'use strict';

  // Перший тиждень семестру — чисельник. Раз на семестр міняти цю дату.
  const SEMESTER_START = new Date(2026, 8, 1); // 1 вересня 2026 (місяці з 0)

  const DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця"];
  const DAY_SHORT = { 'Понеділок': 'Пн', 'Вівторок': 'Вт', 'Середа': 'Ср', 'Четвер': 'Чт', "П'ятниця": 'Пт' };
  const MONTH_GEN = ['січ.', 'лют.', 'бер.', 'квіт.', 'трав.', 'черв.', 'лип.', 'серп.', 'вер.', 'жовт.', 'лист.', 'груд.'];

  const STORAGE_KEY = 'college-schedule-selection';

  let lessons = [];
  let groups = {}; // назва групи -> відділення
  let pairTimes = {}; // номер_пари -> {початок, кінець}

  const state = {
    mode: 'student', // 'student' | 'teacher'
    course: null,
    department: null,
    group: null,
    teacher: null,
    weekOffset: null, // ціле число тижнів відносно поточного реального тижня
  };

  // ---------- Дати / тижні ----------

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function mondayOf(date) {
    const d = startOfDay(date);
    const dow = d.getDay(); // 0=нд..6=сб
    const diff = (dow + 6) % 7; // днів від понеділка
    d.setDate(d.getDate() - diff);
    return d;
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function weeksBetween(mondayA, mondayB) {
    return Math.round((mondayB - mondayA) / (7 * 24 * 3600 * 1000));
  }

  const SEMESTER_MONDAY = mondayOf(SEMESTER_START);

  function currentWeekOffset() {
    return weeksBetween(SEMESTER_MONDAY, mondayOf(new Date()));
  }

  function weekParity(offset) {
    return offset % 2 === 0 ? 'чисельник' : 'знаменник';
  }

  function formatDay(date) {
    return `${date.getDate()} ${MONTH_GEN[date.getMonth()]}`;
  }

  // ---------- Завантаження даних ----------

  async function loadData() {
    const [lessonsRes, groupsRes, pairTimesRes] = await Promise.all([
      fetch('data/lessons.json'),
      fetch('data/groups.json'),
      fetch('data/pair_times.json'),
    ]);
    lessons = await lessonsRes.json();
    groups = await groupsRes.json();
    pairTimes = await pairTimesRes.json();
  }

  function courseOf(groupName) {
    const m = groupName.match(/\d/);
    return m ? m[0] : '?';
  }

  function buildTaxonomy() {
    const byCourse = new Map(); // course -> Map(department -> [groups])
    for (const groupName of Object.keys(groups)) {
      const course = courseOf(groupName);
      const dept = groups[groupName];
      if (!byCourse.has(course)) byCourse.set(course, new Map());
      const byDept = byCourse.get(course);
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(groupName);
    }
    for (const byDept of byCourse.values()) {
      for (const list of byDept.values()) list.sort();
    }
    return byCourse;
  }

  function allTeachers() {
    return [...new Set(lessons.filter((l) => l.викладач).map((l) => l.викладач))].sort();
  }

  // Розклад дзвінків береться з data/pair_times.json (окремо від занять),
  // щоб зміну часу пар можна було внести в одному місці.
  function buildPairInfo() {
    const pairNumbers = [...new Set(lessons.map((l) => l.номер_пари))].sort((a, b) => a - b);
    const labels = new Map();
    for (const pair of pairNumbers) {
      const t = pairTimes[String(pair)];
      labels.set(pair, t ? `${t.початок}–${t.кінець}` : null);
    }
    return { pairNumbers, labels };
  }

  function timeRangeFor(pairNumber) {
    return pairTimes[String(pairNumber)] || null;
  }

  // ---------- Стан / персистентність ----------

  function saveSelection() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: state.mode,
        course: state.course,
        department: state.department,
        group: state.group,
        teacher: state.teacher,
      }));
    } catch (e) { /* ігноруємо: приватний режим тощо */ }
  }

  function loadSelection() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // ---------- DOM ----------

  const els = {};

  function cacheEls() {
    els.selectorBtn = document.getElementById('selector-btn');
    els.selectorLabel = document.getElementById('selector-label');
    els.overlay = document.getElementById('selector-overlay');
    els.panelTitle = document.getElementById('selector-panel-title');
    els.closeBtn = document.getElementById('selector-close');
    els.studentSelectors = document.getElementById('student-selectors');
    els.teacherSelectors = document.getElementById('teacher-selectors');
    els.selectCourse = document.getElementById('select-course');
    els.selectDepartment = document.getElementById('select-department');
    els.selectGroup = document.getElementById('select-group');
    els.selectTeacher = document.getElementById('select-teacher');
    els.weekPrev = document.getElementById('week-prev');
    els.weekNext = document.getElementById('week-next');
    els.weekNumber = document.getElementById('week-number');
    els.weekParity = document.getElementById('week-parity');
    els.dayTabs = document.getElementById('day-tabs');
    els.grid = document.getElementById('schedule-grid');
    els.empty = document.getElementById('schedule-empty');
    els.modeBtns = [...document.querySelectorAll('.mode-btn')];
  }

  let taxonomy;
  let teachers;
  let pairInfo;
  let activeMobileDay = null;

  function populateSelect(select, options, selectedValue) {
    select.innerHTML = '';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    if (selectedValue && options.includes(selectedValue)) {
      select.value = selectedValue;
    }
  }

  function refreshStudentSelectors() {
    const courses = [...taxonomy.keys()].sort();
    if (!state.course || !courses.includes(state.course)) state.course = courses[0];
    populateSelect(els.selectCourse, courses, state.course);

    const byDept = taxonomy.get(state.course);
    const depts = [...byDept.keys()].sort();
    if (!state.department || !depts.includes(state.department)) state.department = depts[0];
    populateSelect(els.selectDepartment, depts, state.department);

    const groupList = byDept.get(state.department);
    if (!state.group || !groupList.includes(state.group)) state.group = groupList[0];
    populateSelect(els.selectGroup, groupList, state.group);
  }

  function refreshTeacherSelector() {
    if (!state.teacher || !teachers.includes(state.teacher)) state.teacher = teachers[0];
    populateSelect(els.selectTeacher, teachers, state.teacher);
  }

  function updateSelectorLabel() {
    if (state.mode === 'student') {
      els.selectorLabel.textContent = state.group ? `Група ${state.group}` : 'Оберіть групу';
    } else {
      els.selectorLabel.textContent = state.teacher || 'Оберіть викладача';
    }
  }

  function setMode(mode) {
    state.mode = mode;
    for (const btn of els.modeBtns) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
    }
    els.studentSelectors.hidden = mode !== 'student';
    els.teacherSelectors.hidden = mode === 'student';
    els.panelTitle.textContent = mode === 'student' ? 'Обрати групу' : 'Обрати викладача';
    if (mode === 'student') refreshStudentSelectors(); else refreshTeacherSelector();
    updateSelectorLabel();
    saveSelection();
    render();
  }

  function openOverlay() {
    els.overlay.hidden = false;
    els.selectorBtn.setAttribute('aria-expanded', 'true');
  }
  function closeOverlay() {
    els.overlay.hidden = true;
    els.selectorBtn.setAttribute('aria-expanded', 'false');
  }

  function wireEvents() {
    for (const btn of els.modeBtns) {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    }
    els.selectorBtn.addEventListener('click', () => openOverlay());
    els.closeBtn.addEventListener('click', () => closeOverlay());
    els.overlay.addEventListener('click', (e) => {
      if (e.target === els.overlay) closeOverlay();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.overlay.hidden) closeOverlay();
    });

    els.selectCourse.addEventListener('change', () => {
      state.course = els.selectCourse.value;
      state.department = null;
      state.group = null;
      refreshStudentSelectors();
      updateSelectorLabel();
      saveSelection();
      render();
    });
    els.selectDepartment.addEventListener('change', () => {
      state.department = els.selectDepartment.value;
      state.group = null;
      refreshStudentSelectors();
      updateSelectorLabel();
      saveSelection();
      render();
    });
    els.selectGroup.addEventListener('change', () => {
      state.group = els.selectGroup.value;
      updateSelectorLabel();
      saveSelection();
      closeOverlay();
      render();
    });
    els.selectTeacher.addEventListener('change', () => {
      state.teacher = els.selectTeacher.value;
      updateSelectorLabel();
      saveSelection();
      closeOverlay();
      render();
    });

    els.weekPrev.addEventListener('click', () => { state.weekOffset -= 1; render(); });
    els.weekNext.addEventListener('click', () => { state.weekOffset += 1; render(); });
  }

  // ---------- Побудова карток ----------

  function pickColumnKey(entry) {
    // У режимі "Викладач" всі записи вже одного викладача — колонку
    // (той самий "потік" між чисельником і знаменником) визначає група,
    // а не викладач. У режимі "Студент" — навпаки.
    if (state.mode === 'teacher') {
      if (entry.група) return 'g:' + entry.група;
      if (entry.предмет) return 's:' + entry.предмет;
    } else {
      if (entry.викладач) return 't:' + entry.викладач;
      if (entry.предмет) return 's:' + entry.предмет;
    }
    return 'p:' + (entry.підгрупа || '');
  }

  function weekSortRank(week) {
    if (week === 'чисельник') return 0;
    if (week === 'знаменник') return 1;
    return 2; // "кожен"
  }

  function buildColumns(entries) {
    const subgroupValues = new Set(entries.map((e) => e.підгрупа).filter(Boolean));
    let columns;
    if (subgroupValues.size >= 2) {
      const withSub = entries.filter((e) => e.підгрупа);
      const without = entries.filter((e) => !e.підгрупа);
      const buckets = new Map();
      for (const e of withSub) {
        const key = pickColumnKey(e);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(e);
      }
      if (buckets.size === 2) {
        columns = [...buckets.values()];
      } else {
        columns = [
          withSub.filter((e) => e.підгрупа === 'А'),
          withSub.filter((e) => e.підгрупа === 'Б'),
        ].filter((c) => c.length);
      }
      if (without.length) columns.push(without);
    } else {
      columns = [entries];
    }
    for (const col of columns) col.sort((a, b) => weekSortRank(a.тиждень) - weekSortRank(b.тиждень));
    return columns;
  }

  function entryIsActive(entry, viewedParity) {
    return entry.тиждень === 'кожен' || entry.тиждень === viewedParity;
  }

  function entryIsNow(entry, isRealCurrentWeek, dayName, viewedParity) {
    if (!isRealCurrentWeek) return false;
    if (!entryIsActive(entry, viewedParity)) return false;
    const now = new Date();
    if (DAYS[now.getDay() - 1] !== dayName) return false;
    const time = timeRangeFor(entry.номер_пари);
    if (!time) return false;
    const [sh, sm] = time.початок.split(':').map(Number);
    const [eh, em] = time.кінець.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return nowMin >= start && nowMin <= end;
  }

  function renderLayer(entry, showParityTag, viewedParity) {
    const dim = showParityTag && !entryIsActive(entry, viewedParity);
    const wrap = document.createElement('div');
    wrap.className = 'lesson-layer' + (showParityTag ? '' : ' simple') + (dim ? ' dim' : '');

    if (showParityTag && entry.тиждень !== 'кожен') {
      const tag = document.createElement('div');
      const isNum = entry.тиждень === 'чисельник';
      tag.className = 'lesson-parity-tag ' + (isNum ? 'num' : 'den');
      tag.innerHTML = `<span class="${isNum ? 'dot-num' : 'dot-den'}"></span><span>${isNum ? 'чис.' : 'знам.'}</span>`;
      wrap.appendChild(tag);
    }

    if (entry.підгрупа) {
      const badge = document.createElement('span');
      badge.className = entry.підгрупа === 'А' ? 'badge-a' : 'badge-b';
      badge.textContent = entry.підгрупа;
      wrap.appendChild(badge);
    }

    const row = document.createElement('div');
    row.className = 'lesson-row';
    const subj = document.createElement('span');
    subj.className = 'subj';
    subj.textContent = entry.предмет;
    row.appendChild(subj);
    if (entry.аудиторія) {
      const room = document.createElement('span');
      room.className = 'room';
      room.textContent = entry.аудиторія;
      row.appendChild(room);
    }
    wrap.appendChild(row);

    // У режимі "Студент" показуємо викладача; у режимі "Викладач" він і так
    // один і той самий (обраний) — замість цього показуємо групу.
    const metaText = state.mode === 'teacher' ? entry.група : entry.викладач;
    if (metaText) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = metaText;
      wrap.appendChild(meta);
    }

    return wrap;
  }

  function buildCard(entries, isRealCurrentWeek, dayName, viewedParity) {
    const columns = buildColumns(entries);
    const card = document.createElement('div');
    card.className = 'card' + (columns.length > 1 ? ' split' : '');

    const isCurrent = entries.some((e) => entryIsNow(e, isRealCurrentWeek, dayName, viewedParity));
    if (isCurrent) {
      card.classList.add('current');
      const badge = document.createElement('span');
      badge.className = 'current-badge';
      badge.textContent = 'зараз';
      card.appendChild(badge);
    }

    const colsWrap = document.createElement('div');
    colsWrap.className = 'lesson-columns';
    for (const col of columns) {
      const colEl = document.createElement('div');
      colEl.className = 'lesson-column';
      const showParityTag = col.length > 1;
      for (const entry of col) {
        colEl.appendChild(renderLayer(entry, showParityTag, viewedParity));
      }
      colsWrap.appendChild(colEl);
    }
    card.appendChild(colsWrap);
    return card;
  }

  // ---------- Рендер сітки ----------

  function currentSelectionLessons() {
    if (state.mode === 'student') {
      if (!state.group) return [];
      return lessons.filter((l) => l.група === state.group);
    }
    if (!state.teacher) return [];
    return lessons.filter((l) => l.викладач === state.teacher);
  }

  function renderDayTabs(weekMonday) {
    els.dayTabs.innerHTML = '';
    DAYS.forEach((day, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(day === activeMobileDay));
      btn.textContent = `${DAY_SHORT[day]} ${formatDay(addDays(weekMonday, idx))}`;
      btn.addEventListener('click', () => {
        activeMobileDay = day;
        render();
      });
      els.dayTabs.appendChild(btn);
    });
  }

  function render() {
    if (state.weekOffset === null) state.weekOffset = currentWeekOffset();
    if (!activeMobileDay) {
      const todayIdx = new Date().getDay() - 1;
      activeMobileDay = DAYS[todayIdx >= 0 && todayIdx < 5 ? todayIdx : 0];
    }

    const weekMonday = addDays(SEMESTER_MONDAY, state.weekOffset * 7);
    const viewedParity = weekParity(state.weekOffset);
    const isRealCurrentWeek = state.weekOffset === currentWeekOffset();

    els.weekNumber.textContent = `Тиждень ${state.weekOffset + 1} · ${formatDay(weekMonday)}–${formatDay(addDays(weekMonday, 4))}`;
    els.weekParity.textContent = viewedParity;
    els.weekParity.className = 'week-parity ' + (viewedParity === 'чисельник' ? 'num' : 'den');

    renderDayTabs(weekMonday);

    const selLessons = currentSelectionLessons();
    const hasSelection = state.mode === 'student' ? !!state.group : !!state.teacher;

    els.empty.hidden = hasSelection;
    els.grid.hidden = !hasSelection;
    if (!hasSelection) return;

    els.grid.innerHTML = '';

    // Заголовковий рядок
    els.grid.appendChild(document.createElement('div'));
    const todayName = DAYS[new Date().getDay() - 1];
    DAYS.forEach((day, idx) => {
      const head = document.createElement('div');
      head.className = 'day-head' + (day === activeMobileDay ? ' active' : '');
      if (isRealCurrentWeek && day === todayName) head.classList.add('today');
      head.innerHTML = `<div class="day-head-name">${day.toUpperCase()}</div><div class="day-head-date">${formatDay(addDays(weekMonday, idx))}</div>`;
      els.grid.appendChild(head);
    });

    // Індекс занять за день+пара
    const byDayPair = new Map();
    for (const l of selLessons) {
      const key = l.день + '|' + l.номер_пари;
      if (!byDayPair.has(key)) byDayPair.set(key, []);
      byDayPair.get(key).push(l);
    }

    for (const pair of pairInfo.pairNumbers) {
      const label = document.createElement('div');
      label.className = 'pair-label';
      const time = pairInfo.labels.get(pair) || '';
      const [start, end] = time ? time.split('–') : ['', ''];
      label.innerHTML = `<div class="pair-number">${pair}</div><div class="pair-time">${start}${start ? '–<br>' + end : ''}</div>`;
      els.grid.appendChild(label);

      DAYS.forEach((day) => {
        const entries = byDayPair.get(day + '|' + pair) || [];
        const isActiveDay = day === activeMobileDay;
        if (!entries.length) {
          const empty = document.createElement('div');
          empty.className = 'cell-empty' + (isActiveDay ? ' active' : '');
          els.grid.appendChild(empty);
        } else {
          const card = buildCard(entries, isRealCurrentWeek, day, viewedParity);
          if (isActiveDay) card.classList.add('active');
          els.grid.appendChild(card);
        }
      });
    }
  }

  // ---------- Ініціалізація ----------

  async function init() {
    cacheEls();
    await loadData();
    taxonomy = buildTaxonomy();
    teachers = allTeachers();
    pairInfo = buildPairInfo();

    const saved = loadSelection();
    if (saved) Object.assign(state, saved);

    wireEvents();
    setMode(state.mode || 'student');
    render();

    setInterval(render, 60 * 1000); // оновлення "зараз" щохвилини
  }

  document.addEventListener('DOMContentLoaded', init);
})();
