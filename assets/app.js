/* ==========================================================================
   Умскул — квалификация клиента в Telegram Mini App
   ========================================================================== */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');

  var cfg = window.UMSKUL_CONFIG || {};

  /**
   * Контекст запуска. start_param — то, что бот подставил в ссылку
   * t.me/<bot>/<app>?startapp=<...>: по нему бэкенд связывает анкету
   * с нужным диалогом/клиентом.
   */
  var launch = (function () {
    var unsafe = (tg && tg.initDataUnsafe) || {};
    var qs = new URLSearchParams(window.location.search);
    return {
      startParam: unsafe.start_param || qs.get('tgWebAppStartParam') || qs.get('startapp') || null,
      queryId: unsafe.query_id || null,
      user: unsafe.user || null
    };
  })();

  /* ----------------------------------------------------------- данные -- */

  var ROLES = [
    { id: 'student', emoji: '🎒', title: 'Я ученик', desc: 'Готовлюсь сам(а) и выбираю программу' },
    { id: 'parent',  emoji: '👨‍👩‍👦', title: 'Я родитель', desc: 'Подбираю курс для ребёнка' }
  ];

  var GRADES = [11, 10, 9, 8, 7, 6, 5];

  var EXAM_LABEL = { oge: 'ОГЭ', ege: 'ЕГЭ', school: 'Школа' };

  var SUBJECTS = {
    ege: [
      { id: 'math_p', name: 'Математика (профиль)', emoji: '📐' },
      { id: 'math_b', name: 'Математика (база)', emoji: '➗' },
      { id: 'rus',    name: 'Русский язык', emoji: '📖' },
      { id: 'inf',    name: 'Информатика', emoji: '💻' },
      { id: 'phys',   name: 'Физика', emoji: '🧲' },
      { id: 'chem',   name: 'Химия', emoji: '⚗️' },
      { id: 'bio',    name: 'Биология', emoji: '🧬' },
      { id: 'soc',    name: 'Обществознание', emoji: '⚖️' },
      { id: 'hist',   name: 'История', emoji: '🏛' },
      { id: 'geo',    name: 'География', emoji: '🌍' },
      { id: 'eng',    name: 'Английский язык', emoji: '🇬🇧' },
      { id: 'lit',    name: 'Литература', emoji: '✍️' }
    ],
    oge: [
      { id: 'math', name: 'Математика', emoji: '📐' },
      { id: 'rus',  name: 'Русский язык', emoji: '📖' },
      { id: 'inf',  name: 'Информатика', emoji: '💻' },
      { id: 'phys', name: 'Физика', emoji: '🧲' },
      { id: 'chem', name: 'Химия', emoji: '⚗️' },
      { id: 'bio',  name: 'Биология', emoji: '🧬' },
      { id: 'soc',  name: 'Обществознание', emoji: '⚖️' },
      { id: 'hist', name: 'История', emoji: '🏛' },
      { id: 'geo',  name: 'География', emoji: '🌍' },
      { id: 'eng',  name: 'Английский язык', emoji: '🇬🇧' },
      { id: 'lit',  name: 'Литература', emoji: '✍️' }
    ],
    school: [
      { id: 'math', name: 'Математика', emoji: '📐' },
      { id: 'rus',  name: 'Русский язык', emoji: '📖' },
      { id: 'eng',  name: 'Английский язык', emoji: '🇬🇧' },
      { id: 'inf',  name: 'Информатика', emoji: '💻' },
      { id: 'phys', name: 'Физика', emoji: '🧲' },
      { id: 'chem', name: 'Химия', emoji: '⚗️' },
      { id: 'bio',  name: 'Биология', emoji: '🧬' },
      { id: 'soc',  name: 'Обществознание', emoji: '⚖️' },
      { id: 'hist', name: 'История', emoji: '🏛' }
    ]
  };

  // Доступен в любом наборе предметов: ученик ещё не определился с экзаменами
  var SUBJECT_UNKNOWN = { id: 'unknown', name: 'Пока не знаю', emoji: '🤔' };
  Object.keys(SUBJECTS).forEach(function (key) {
    SUBJECTS[key] = SUBJECTS[key].concat([SUBJECT_UNKNOWN]);
  });

  var TRACKS = [
    {
      id: 'full',
      emoji: '🧭',
      title: 'Подробная диагностика',
      desc: '8 вопросов, около 2 минут — подберём формат занятий точнее',
      badge: 'Советуем'
    },
    {
      id: 'express',
      emoji: '⚡️',
      title: 'Экспресс-диагностика',
      desc: '3 вопроса, меньше минуты — если совсем нет времени'
    }
  ];

  var LEVELS = [
    { id: 'gaps', emoji: '🧩', title: 'Есть западающие темы', p: {
      student: 'Основное понимаю, но часть тем проседает',
      parent: 'Основное ребёнок понимает, но часть тем проседает'
    } },
    { id: 'structure', emoji: '🗂', title: 'Нет структуры в знаниях', p: {
      student: 'Знания есть, но разрозненные — сложно собрать в систему',
      parent: 'Знания есть, но разрозненные — нет системы'
    } },
    { id: 'zero', emoji: '🌱', title: 'Хочу изучить всё с нуля', p: {
      student: 'Начинаю подготовку с базы',
      parent: 'Ребёнок начинает подготовку с базы'
    } }
  ];

  var PRIORITIES = [
    { id: 'explain',  emoji: '🧠', name: 'Понятное объяснение тем' },
    { id: 'practice', emoji: '✍️', name: 'Много практики и разборов' },
    { id: 'homework', emoji: '📝', name: 'Проверка домашки с обратной связью' },
    { id: 'control',  emoji: '⏰', name: 'Контроль и дисциплина' },
    { id: 'motivation', emoji: '🔥', name: 'Мотивация и поддержка' },
    { id: 'tactics',  emoji: '🎯', name: 'Тактика и лайфхаки на экзамене' },
    { id: 'schedule', emoji: '🗓', name: 'Удобное расписание' },
    { id: 'price',    emoji: '💰', name: 'Доступная цена' }
  ];

  var ONLINE = [
    { id: 'liked',    emoji: '👍', title: 'Да, и всё понравилось' },
    { id: 'disliked', emoji: '🤷', title: 'Да, но не зашло' },
    { id: 'quit',     emoji: '🌀', title: 'Пробовал(а), но забросил(а)' },
    { id: 'never',    emoji: '✨', title: 'Нет, будет первый раз' }
  ];

  var PREP = [
    { id: 'none',     emoji: '🌱', title: 'Пока никак', p: { student: 'Ещё не начинал(а) готовиться', parent: 'Ребёнок ещё не начинал готовиться' } },
    { id: 'self',     emoji: '📚', title: 'Готовлюсь сам(а)', p: { student: 'Разбираю темы и решаю варианты сам(а)', parent: 'Ребёнок занимается самостоятельно' } },
    { id: 'tutor',    emoji: '🧑‍🏫', title: 'С репетитором', p: { student: 'Занимаюсь индивидуально', parent: 'Занимается с репетитором' } },
    { id: 'school',   emoji: '🏫', title: 'Буду готовиться в школе', p: { student: 'Рассчитываю на школьные уроки и учителя', parent: 'Рассчитываем на школьные уроки и учителя' } },
    { id: 'umschool', emoji: '🧡', title: 'Уже в Умскул', p: { student: 'Учусь на курсе Умскул', parent: 'Ребёнок учится на курсе Умскул' } }
  ];

  // Экспресс — только базовая квалификация; подробная — весь набор вопросов
  var TRACK_STEPS = {
    express: ['role', 'grade', 'subjects'],
    full: ['role', 'grade', 'subjects', 'level', 'goal', 'priorities', 'prep', 'online']
  };

  function steps() { return TRACK_STEPS[state.track] || TRACK_STEPS.full; }
  function total() { return steps().length; }

  /* --------------------------------------------------------- состояние -- */

  var STORAGE_KEY = 'umskul_quiz_v1';

  var state = {
    step: -1, // -1 = интро, 0..total()-1 = вопросы, total() = результат
    track: null, // express | full
    role: null,
    level: null,
    priorities: [],
    online: null,
    grade: null,
    subjects: [],
    goals: {},
    prep: null,
    sent: false,
    busy: false,
    error: null
  };

  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.track = saved.track || null;
      state.role = saved.role || null;
      state.grade = saved.grade || null;
      state.subjects = Array.isArray(saved.subjects) ? saved.subjects : [];
      state.goals = saved.goals && typeof saved.goals === 'object' ? saved.goals : {};
      state.level = saved.level || null;
      state.priorities = Array.isArray(saved.priorities) ? saved.priorities : [];
      state.prep = saved.prep || null;
      state.online = saved.online || null;
    }
  } catch (e) { /* приватный режим — просто работаем без сохранения */ }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        track: state.track, role: state.role, grade: state.grade, subjects: state.subjects,
        goals: state.goals, level: state.level, priorities: state.priorities,
        prep: state.prep, online: state.online
      }));
    } catch (e) { /* no-op */ }
  }

  /* ----------------------------------------------------------- хелперы -- */

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    screen: $('screen'), footer: $('footer'), cta: $('cta'), ctaHint: $('ctaHint'),
    back: $('backBtn'), progress: $('progress'), fill: $('progressFill'),
    label: $('progressLabel'), pct: $('progressPct'), dots: $('progressDots'),
    confetti: $('confetti'), brand: $('brand')
  };

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === false || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function haptic(type) {
    if (!inTelegram || !tg.HapticFeedback) return;
    try {
      if (type === 'select') tg.HapticFeedback.selectionChanged();
      else if (type === 'success' || type === 'error' || type === 'warning') tg.HapticFeedback.notificationOccurred(type);
      else tg.HapticFeedback.impactOccurred(type || 'light');
    } catch (e) { /* старые клиенты */ }
  }

  function examType(grade) {
    if (grade === 9) return 'oge';
    if (grade >= 10) return 'ege';
    return 'school';
  }

  function currentExam() { return examType(state.grade); }

  function subjectList() { return SUBJECTS[currentExam()]; }

  function subjectById(id) {
    var list = subjectList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // Единица измерения цели: баллы для ЕГЭ, оценка для ОГЭ и школы
  function goalUnit() { return currentExam() === 'ege' ? 'score' : 'mark'; }
  function defaultGoal() { return goalUnit() === 'score' ? 80 : 5; }

  function isParent() { return state.role === 'parent'; }
  function who(a, b) { return isParent() ? b : a; }

  function checkIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    return svg;
  }

  /* ------------------------------------------------------------ маскот -- */

  function mascot() {
    var wrap = h('div', { class: 'mascot' });
    wrap.innerHTML = [
      '<svg viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">',
      '<defs><linearGradient id="mg" x1="0" y1="0" x2="1" y2="1">',
      '<stop offset="0%" stop-color="#FF8A3D"/><stop offset="100%" stop-color="#F26100"/>',
      '</linearGradient></defs>',
      '<g class="mascot__body">',
      '<path class="mascot__cap" d="M64 16 L104 34 L64 52 L24 34 Z"/>',
      '<path class="mascot__cap-line" d="M96 39 v18" stroke-width="4" stroke-linecap="round"/>',
      '<circle class="mascot__cap" cx="96" cy="61" r="5"/>',
      '<rect x="26" y="50" width="76" height="62" rx="26" fill="url(#mg)"/>',
      '<circle class="mascot__eye" cx="51" cy="78" r="6.5" fill="#fff"/>',
      '<circle class="mascot__eye" cx="77" cy="78" r="6.5" fill="#fff"/>',
      '<path d="M54 93 q10 9 20 0" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/>',
      '</g>',
      '<g class="mascot__spark">',
      '<path d="M16 66 l3 7 7 3 -7 3 -3 7 -3-7 -7-3 7-3 z"/>',
      '<path d="M112 84 l2.2 5 5 2.2 -5 2.2 -2.2 5 -2.2-5 -5-2.2 5-2.2 z"/>',
      '</g>',
      '</svg>'
    ].join('');
    return wrap;
  }

  /* ----------------------------------------------------------- шаги ---- */

  function stepIntro() {
    var options = h('div', { class: 'options stagger' }, TRACKS.map(function (t, i) {
      var node = h('button', {
        class: 'option option--track' + (state.track === t.id ? ' option--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          if (state.track && state.track !== t.id) resetAnswers();
          state.track = t.id;
          haptic('select');
          persist();
          refreshSelection(options, '.option', t.id, 'option--selected');
          syncCta();
          setTimeout(next, 220);
        }
      }, [
        h('span', { class: 'option__emoji', text: t.emoji }),
        h('span', { class: 'option__body' }, [
          h('span', { class: 'option__title' }, [
            document.createTextNode(t.title),
            t.badge ? h('span', { class: 'option__badge', text: t.badge }) : null
          ]),
          h('span', { class: 'option__desc', text: t.desc })
        ]),
        h('span', { class: 'option__check' }, [checkIcon()])
      ]);
      node.dataset.value = t.id;
      return node;
    }));

    return {
      node: h('div', { class: 'step' }, [
        mascot(),
        h('h1', { class: 'step__title', text: 'Подберём формат занятий' }),
        h('p', { class: 'step__subtitle', text: 'Советуем пройти подробную диагностику, чтобы мы подобрали наиболее подходящий формат занятий. Но если времени совсем мало — воспользуйся экспресс-диагностикой.' }),
        options
      ]),
      cta: 'Начать',
      valid: function () { return !!state.track; }
    };
  }

  /** Смена трека обнуляет ответы: наборы вопросов у веток разные. */
  function resetAnswers() {
    state.role = null;
    state.grade = null;
    state.subjects = [];
    state.goals = {};
    state.level = null;
    state.priorities = [];
    state.prep = null;
    state.online = null;
  }

  function stepRole() {
    var options = h('div', { class: 'options stagger' }, ROLES.map(function (r, i) {
      var selected = state.role === r.id;
      var node = h('button', {
        class: 'option' + (selected ? ' option--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          state.role = r.id;
          haptic('select');
          persist();
          refreshSelection(options, '.option', r.id, 'option--selected');
          syncCta();
          setTimeout(next, 220);
        }
      }, [
        h('span', { class: 'option__emoji', text: r.emoji }),
        h('span', { class: 'option__body' }, [
          h('span', { class: 'option__title', text: r.title }),
          h('span', { class: 'option__desc', text: r.desc })
        ]),
        h('span', { class: 'option__check' }, [checkIcon()])
      ]);
      node.dataset.value = r.id;
      return node;
    }));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '👋 Знакомимся' }),
        h('h1', { class: 'step__title', text: 'Кто заполняет анкету?' }),
        h('p', { class: 'step__subtitle', text: 'От этого зависит, как мы будем к вам обращаться и что покажем в конце.' }),
        options
      ]),
      cta: 'Далее',
      valid: function () { return !!state.role; }
    };
  }

  function stepGrade() {
    var grid = h('div', { class: 'grid-grades stagger' }, GRADES.map(function (g, i) {
      var ex = examType(g);
      var selected = state.grade === g;
      var node = h('button', {
        class: 'grade' + (selected ? ' grade--selected' : '') + (ex !== 'school' ? ' grade--exam' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          var prevExam = state.grade ? currentExam() : null;
          state.grade = g;
          // сменился тип экзамена — набор предметов другой, старый выбор не подходит
          if (prevExam && prevExam !== examType(g)) { state.subjects = []; state.goals = {}; }
          haptic('select');
          persist();
          refreshSelection(grid, '.grade', String(g), 'grade--selected');
          syncCta();
          setTimeout(next, 220);
        }
      }, [
        h('span', { class: 'grade__num', text: String(g) }),
        h('span', { class: 'grade__cls', text: 'класс' }),
        h('span', { class: 'grade__tag', text: EXAM_LABEL[ex] })
      ]);
      node.dataset.value = String(g);
      return node;
    }));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '🎒 Класс' }),
        h('h1', { class: 'step__title', text: who('В какой класс ты переходишь?', 'В какой класс переходит ребёнок?') }),
        h('p', { class: 'step__subtitle', text: 'Имеется в виду класс, в котором начнётся новый учебный год.' }),
        grid
      ]),
      cta: 'Далее',
      valid: function () { return !!state.grade; }
    };
  }

  function stepSubjects() {
    var exam = currentExam();
    var counter = h('p', { class: 'counter' });

    function updateCounter() {
      if (state.subjects.length === 1 && state.subjects[0] === SUBJECT_UNKNOWN.id) {
        counter.textContent = 'Ничего страшного — поможем определиться';
        return;
      }
      var n = state.subjects.length;
      counter.textContent = n === 0
        ? 'Выберите минимум один предмет'
        : 'Выбрано: ' + n + ' ' + plural(n, ['предмет', 'предмета', 'предметов']);
    }

    var chips = h('div', { class: 'chips stagger' }, SUBJECTS[exam].map(function (s, i) {
      var node = h('button', {
        class: 'chip' + (state.subjects.indexOf(s.id) > -1 ? ' chip--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          var idx = state.subjects.indexOf(s.id);
          if (idx > -1) {
            state.subjects.splice(idx, 1);
            delete state.goals[s.id];
          } else if (s.id === SUBJECT_UNKNOWN.id) {
            // «Пока не знаю» отменяет конкретные предметы
            state.subjects = [s.id];
            state.goals = {};
          } else {
            state.subjects = state.subjects.filter(function (id) { return id !== SUBJECT_UNKNOWN.id; });
            state.subjects.push(s.id);
            delete state.goals[SUBJECT_UNKNOWN.id];
          }
          haptic('select');
          persist();
          syncChips();
          updateCounter();
          syncCta();
        }
      }, [
        h('span', { text: s.emoji }),
        h('span', { text: s.name })
      ]);
      node.dataset.value = s.id;
      return node;
    }));

    function syncChips() {
      Array.prototype.forEach.call(chips.querySelectorAll('.chip'), function (node) {
        node.classList.toggle('chip--selected', state.subjects.indexOf(node.dataset.value) > -1);
      });
    }

    updateCounter();

    var hint = exam === 'ege'
      ? 'Отметьте все предметы ЕГЭ, включая обязательные.'
      : exam === 'oge'
        ? 'Отметьте предметы ОГЭ: два обязательных и предметы по выбору.'
        : 'Отметьте предметы, которые хочется подтянуть в этом году.';

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '📚 ' + (exam === 'school' ? 'Предметы' : EXAM_LABEL[exam]) }),
        h('h1', { class: 'step__title', text: who('Что будешь сдавать?', 'Что будет сдавать ребёнок?') }),
        h('p', { class: 'step__subtitle', text: hint }),
        chips,
        counter
      ]),
      cta: 'Далее',
      valid: function () { return state.subjects.length > 0; }
    };
  }

  function stepGoal() {
    var unit = goalUnit();
    var cards = h('div', { class: 'stagger' }, state.subjects.map(function (id, i) {
      var subj = subjectById(id);
      if (!subj) return null;
      if (state.goals[id] === undefined) state.goals[id] = defaultGoal();
      var cardTitle = subj.id === SUBJECT_UNKNOWN.id
        ? (unit === 'score' ? 'Общая цель по баллам' : 'Желаемая оценка')
        : subj.name;

      var value = h('span', { class: 'goal-card__value', text: String(state.goals[id]) });
      var body;

      if (unit === 'score') {
        var input = h('input', {
          class: 'slider', type: 'range', min: '40', max: '100', step: '1',
          value: String(state.goals[id]),
          style: '--p:' + pctOf(state.goals[id]) + '%'
        });
        var presets = h('div', { class: 'presets' }, [70, 80, 90, 100].map(function (p) {
          var b = h('button', {
            class: 'preset' + (state.goals[id] === p ? ' preset--active' : ''),
            type: 'button', text: String(p),
            onclick: function () { setScore(p); haptic('light'); }
          });
          b.dataset.value = String(p);
          return b;
        }));

        function setScore(v) {
          state.goals[id] = v;
          input.value = String(v);
          input.style.setProperty('--p', pctOf(v) + '%');
          value.textContent = String(v);
          value.classList.add('goal-card__value--bump');
          setTimeout(function () { value.classList.remove('goal-card__value--bump'); }, 180);
          refreshSelection(presets, '.preset', String(v), 'preset--active');
          persist();
          syncCta();
        }

        input.addEventListener('input', function () {
          var v = parseInt(input.value, 10);
          if (v !== state.goals[id]) haptic('select');
          setScore(v);
        });

        body = h('div', {}, [input, presets]);
      } else {
        var marks = h('div', { class: 'marks' }, [3, 4, 5].map(function (m) {
          var b = h('button', {
            class: 'mark' + (state.goals[id] === m ? ' mark--active' : ''),
            type: 'button', text: String(m),
            onclick: function () {
              state.goals[id] = m;
              value.textContent = String(m);
              haptic('select');
              refreshSelection(marks, '.mark', String(m), 'mark--active');
              persist();
              syncCta();
            }
          });
          b.dataset.value = String(m);
          return b;
        }));
        body = marks;
      }

      return h('div', { class: 'goal-card', style: '--i:' + i }, [
        h('div', { class: 'goal-card__head' }, [
          h('span', { class: 'option__emoji', text: subj.emoji }),
          h('span', { class: 'goal-card__name', text: cardTitle }),
          value,
          h('span', { class: 'goal-card__unit', text: unit === 'score' ? 'баллов' : 'оценка' })
        ]),
        body
      ]);
    }).filter(Boolean));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '🎯 Цель' }),
        h('h1', { class: 'step__title', text: unit === 'score' ? who('Сколько баллов хочешь набрать?', 'Сколько баллов нужно ребёнку?') : who('На какую оценку целишься?', 'Какая оценка нужна ребёнку?') }),
        h('p', { class: 'step__subtitle', text: unit === 'score' ? 'Двигайте ползунок — от цели зависит интенсивность программы.' : 'Отметьте желаемый результат по каждому предмету.' }),
        cards
      ]),
      cta: 'Далее',
      valid: function () { return state.subjects.length > 0; }
    };
  }

  function stepPrep() {
    var options = h('div', { class: 'options stagger' }, PREP.map(function (p, i) {
      var node = h('button', {
        class: 'option' + (state.prep === p.id ? ' option--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          state.prep = p.id;
          haptic('select');
          persist();
          refreshSelection(options, '.option', p.id, 'option--selected');
          syncCta();
          setTimeout(next, 240);
        }
      }, [
        h('span', { class: 'option__emoji', text: p.emoji }),
        h('span', { class: 'option__body' }, [
          h('span', { class: 'option__title', text: p.id === 'self' ? who('Готовлюсь сам(а)', 'Готовится сам(а)') : p.title }),
          h('span', { class: 'option__desc', text: who(p.p.student, p.p.parent) })
        ]),
        h('span', { class: 'option__check' }, [checkIcon()])
      ]);
      node.dataset.value = p.id;
      return node;
    }));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '🧭 Подготовка' }),
        h('h1', { class: 'step__title', text: who('Как готовишься сейчас?', 'Как ребёнок готовится сейчас?') }),
        h('p', { class: 'step__subtitle', text: 'Честный ответ поможет не предлагать лишнего.' }),
        options
      ]),
      cta: 'Показать результат',
      valid: function () { return !!state.prep; }
    };
  }

  function stepLevel() {
    var options = h('div', { class: 'options stagger' }, LEVELS.map(function (l, i) {
      var node = h('button', {
        class: 'option' + (state.level === l.id ? ' option--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          state.level = l.id;
          haptic('select');
          persist();
          refreshSelection(options, '.option', l.id, 'option--selected');
          syncCta();
          setTimeout(next, 220);
        }
      }, [
        h('span', { class: 'option__emoji', text: l.emoji }),
        h('span', { class: 'option__body' }, [
          h('span', { class: 'option__title', text: l.title }),
          h('span', { class: 'option__desc', text: who(l.p.student, l.p.parent) })
        ]),
        h('span', { class: 'option__check' }, [checkIcon()])
      ]);
      node.dataset.value = l.id;
      return node;
    }));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '📊 Уровень' }),
        h('h1', { class: 'step__title', text: who('Какой у тебя сейчас уровень знаний?', 'Какой сейчас уровень знаний у ребёнка?') }),
        h('p', { class: 'step__subtitle', text: 'От этого зависит, с чего начнём программу.' }),
        options
      ]),
      cta: 'Далее',
      valid: function () { return !!state.level; }
    };
  }

  function stepPriorities() {
    var counter = h('p', { class: 'counter' });

    function updateCounter() {
      var n = state.priorities.length;
      counter.textContent = n === 0
        ? 'Отметьте хотя бы один пункт'
        : 'Выбрано: ' + n + ' ' + plural(n, ['пункт', 'пункта', 'пунктов']);
    }

    var chips = h('div', { class: 'chips stagger' }, PRIORITIES.map(function (p, i) {
      var node = h('button', {
        class: 'chip' + (state.priorities.indexOf(p.id) > -1 ? ' chip--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          var idx = state.priorities.indexOf(p.id);
          if (idx > -1) { state.priorities.splice(idx, 1); node.classList.remove('chip--selected'); }
          else { state.priorities.push(p.id); node.classList.add('chip--selected'); }
          haptic('select');
          persist();
          updateCounter();
          syncCta();
        }
      }, [
        h('span', { text: p.emoji }),
        h('span', { text: p.name })
      ]);
      node.dataset.value = p.id;
      return node;
    }));

    updateCounter();

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '⭐️ Приоритеты' }),
        h('h1', { class: 'step__title', text: who('Что для тебя важнее всего в подготовке?', 'Что важнее всего в подготовке для ребёнка?') }),
        h('p', { class: 'step__subtitle', text: 'Отметьте всё, чего сейчас не хватает — можно выбрать несколько.' }),
        chips,
        counter
      ]),
      cta: 'Далее',
      valid: function () { return state.priorities.length > 0; }
    };
  }

  function stepOnline() {
    var options = h('div', { class: 'options stagger' }, ONLINE.map(function (o, i) {
      var node = h('button', {
        class: 'option' + (state.online === o.id ? ' option--selected' : ''),
        type: 'button',
        style: '--i:' + i,
        onclick: function () {
          state.online = o.id;
          haptic('select');
          persist();
          refreshSelection(options, '.option', o.id, 'option--selected');
          syncCta();
          setTimeout(next, 220);
        }
      }, [
        h('span', { class: 'option__emoji', text: o.emoji }),
        h('span', { class: 'option__body' }, [
          h('span', { class: 'option__title', text: o.title })
        ]),
        h('span', { class: 'option__check' }, [checkIcon()])
      ]);
      node.dataset.value = o.id;
      return node;
    }));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'step__eyebrow', text: '💻 Онлайн' }),
        h('h1', { class: 'step__title', text: who('Был ли опыт онлайн-занятий?', 'Был ли у ребёнка опыт онлайн-занятий?') }),
        h('p', { class: 'step__subtitle', text: 'Подскажем, как всё устроено, если формат новый.' }),
        options
      ]),
      cta: 'Далее',
      valid: function () { return !!state.online; }
    };
  }

  function stepResult() {
    var exam = currentExam();
    var unit = goalUnit();
    var names = state.subjects.map(function (id) {
      var s = subjectById(id);
      if (!s) return null;
      if (s.id === SUBJECT_UNKNOWN.id) return 'Пока не определились';
      return s.name + (state.goals[id] !== undefined ? ' — ' + state.goals[id] : '');
    }).filter(Boolean);

    var roleTitle = state.role === 'parent' ? 'Родитель' : 'Ученик';
    var prepItem = PREP.filter(function (p) { return p.id === state.prep; })[0];

    var levelItem = LEVELS.filter(function (l) { return l.id === state.level; })[0];
    var onlineItem = ONLINE.filter(function (o) { return o.id === state.online; })[0];
    var priorityNames = PRIORITIES.filter(function (p) {
      return state.priorities.indexOf(p.id) > -1;
    }).map(function (p) { return p.name; });

    var onlyUnknown = state.subjects.length === 1 && state.subjects[0] === SUBJECT_UNKNOWN.id;
    var hasGoals = state.subjects.some(function (id) { return state.goals[id] !== undefined; });

    var rows = [
      ['Кто вы', roleTitle],
      ['Класс', state.grade + ' класс · ' + (exam === 'school' ? 'школьная программа' : EXAM_LABEL[exam])],
      [onlyUnknown || !hasGoals ? 'Предметы' : (unit === 'score' ? 'Предметы и баллы' : 'Предметы и оценки'), names.join('\n')]
    ];
    if (levelItem) rows.push(['Уровень', levelItem.title]);
    if (priorityNames.length) rows.push(['Важно', priorityNames.join('\n')]);
    if (prepItem) rows.push(['Подготовка', prepItem.title]);
    if (onlineItem) rows.push(['Опыт онлайна', onlineItem.title]);

    var summary = h('div', { class: 'summary' }, rows.map(function (r, i) {
      return h('div', { class: 'summary__row', style: '--i:' + i }, [
        h('div', { class: 'summary__key', text: r[0] }),
        h('div', { class: 'summary__val', style: 'white-space:pre-line', text: r[1] })
      ]);
    }));

    return {
      node: h('div', { class: 'step' }, [
        h('span', { class: 'result__badge', text: '✨ Готово' }),
        h('h1', { class: 'step__title', style: 'margin-top:14px', text: who('Отлично, мы всё поняли!', 'Отлично, анкета заполнена!') }),
        h('p', { class: 'step__subtitle', text: 'Вот что мы записали. Куратор Умскул подберёт программу под эти вводные.' }),
        summary,
        h('div', { class: 'plan' }, [
          h('div', { class: 'plan__title', text: recommendation(exam) }),
          h('ul', { class: 'plan__list' }, planItems(exam, unit).map(function (t) {
            return h('li', { class: 'plan__item', text: t });
          }))
        ]),
        h('p', { class: 'note', text: transport() === 'clipboard'
          ? 'Мини-апп открыт вне Telegram: отправка в бот недоступна.'
          : 'Нажмите кнопку ниже — ответы уйдут менеджеру Умскул.' })
      ]),
      cta: transport() === 'clipboard' ? 'Скопировать ответы' : 'Отправить и получить подборку',
      valid: function () { return !state.busy; },
      result: true
    };
  }

  /** Экран после успешной отправки по HTTP. */
  function stepSent() {
    return {
      node: h('div', { class: 'step hero' }, [
        mascot(),
        h('h1', { class: 'hero__title', text: 'Анкета отправлена!' }),
        h('p', { class: 'hero__text', text: who(
          'Куратор Умскул уже видит твои ответы и напишет в этот чат с подборкой курсов.',
          'Куратор Умскул уже видит ваши ответы и напишет в этот чат с подборкой курсов.'
        ) })
      ]),
      cta: inTelegram ? 'Вернуться в чат' : 'Готово',
      valid: true,
      sent: true
    };
  }

  function recommendation(exam) {
    if (exam === 'ege') {
      var avg = averageGoal();
      if (avg >= 90) return 'Рекомендуем интенсив на 90+';
      if (avg >= 75) return 'Рекомендуем годовой курс подготовки';
      return 'Рекомендуем базовый годовой курс';
    }
    if (exam === 'oge') return 'Рекомендуем годовой курс подготовки к ОГЭ';
    return 'Рекомендуем курс по школьной программе';
  }

  function planItems(exam, unit) {
    // подсказки по новым ответам добавляются ниже, если ветка подробная
    var items = [
      'Онлайн-занятия с преподавателями и личным куратором',
      'Домашние задания с проверкой и разбором ошибок'
    ];
    if (exam === 'school') items.push('Упор на пробелы школьной программы');
    else items.push('Пробники в формате ' + EXAM_LABEL[exam] + ' каждый месяц');
    if (unit === 'score' && averageGoal() >= 90) items.push('Дополнительные вебинары по задачам второй части');
    if (state.level === 'zero') items.push('Стартуем с базовых тем — без пробелов в фундаменте');
    if (state.level === 'structure') items.push('Соберём знания в систему: план тем от простого к сложному');
    if (state.priorities.indexOf('control') > -1) items.push('Куратор следит за дедлайнами и не даёт забросить');
    if (state.priorities.indexOf('price') > -1) items.push('Подберём тариф под бюджет и расскажем про рассрочку');
    if (state.online === 'never') items.push('Покажем платформу и проведём вводное занятие');
    if (state.prep === 'school') items.push('Дополним школьную программу форматом экзамена');
    if (state.prep === 'umschool') items.push('Учтём ваш текущий курс — предложим апгрейд, а не дубль');
    if (state.subjects.length >= 3) items.push('Комплект из ' + state.subjects.length + ' предметов — со скидкой за пакет');
    return items;
  }

  function averageGoal() {
    var vals = state.subjects.map(function (id) { return state.goals[id]; }).filter(function (v) { return typeof v === 'number'; });
    if (!vals.length) return 0;
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
  }

  var BUILDERS = {
    role: stepRole, grade: stepGrade, subjects: stepSubjects, level: stepLevel,
    goal: stepGoal, priorities: stepPriorities, prep: stepPrep, online: stepOnline
  };

  /* -------------------------------------------------------- утилиты UI -- */

  function pctOf(v) { return Math.round((v - 40) / 60 * 100); }

  function plural(n, forms) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
    return forms[2];
  }

  function refreshSelection(container, selector, value, cls) {
    Array.prototype.forEach.call(container.querySelectorAll(selector), function (n) {
      n.classList.toggle(cls, n.dataset.value === value);
    });
  }

  /* ------------------------------------------------------------ рендер -- */

  var current = null;

  function build() {
    if (state.step === -1) return stepIntro();
    if (state.step > total()) return stepSent();
    if (state.step === total()) return stepResult();
    return BUILDERS[steps()[state.step]]();
  }

  function render(direction) {
    current = build();

    var old = el.screen.firstElementChild;
    if (old) {
      old.classList.add('step--leaving', direction >= 0 ? 'step--leave-fwd' : 'step--leave-back');
      old.addEventListener('animationend', function () { old.remove(); }, { once: true });
      setTimeout(function () { if (old.parentNode) old.remove(); }, 400);
    }

    current.node.classList.add(direction >= 0 ? 'step--enter-fwd' : 'step--enter-back');
    el.screen.appendChild(current.node);
    window.scrollTo({ top: 0, behavior: old ? 'smooth' : 'auto' });

    syncChrome();
    syncCta();

    if (state.step === total() && !state.sent) {
      haptic('success');
      confetti();
    }
  }

  function syncChrome() {
    var isQuestion = state.step >= 0 && state.step < total();
    el.progress.hidden = !isQuestion;
    el.brand.hidden = isQuestion;
    el.back.hidden = state.step <= -1 || state.step > total();

    if (isQuestion) {
      var done = state.step;
      var pct = Math.round(done / total() * 100);
      el.fill.style.width = Math.max(pct, 4) + '%';
      el.pct.textContent = pct + '%';
      el.label.textContent = 'Вопрос ' + (state.step + 1) + ' из ' + total();

      if (el.dots.childElementCount !== total()) {
        el.dots.innerHTML = '';
        for (var i = 0; i < total(); i++) el.dots.appendChild(h('span', { class: 'progress__dot' }));
      }
      Array.prototype.forEach.call(el.dots.children, function (d, i) {
        d.className = 'progress__dot' + (i < state.step ? ' progress__dot--done' : i === state.step ? ' progress__dot--current' : '');
      });
    }

    if (state.step >= total()) {
      el.fill.style.width = '100%';
      el.pct.textContent = '100%';
    }

    // Кнопка «назад» в клиенте Telegram
    if (inTelegram && tg.BackButton) {
      if (state.step > -1 && state.step <= total()) tg.BackButton.show(); else tg.BackButton.hide();
    }
  }

  function syncCta() {
    var valid = typeof current.valid === 'function' ? current.valid() : current.valid;
    var text = state.error && current.result ? 'Отправить ещё раз' : current.cta;

    if (useMainButton()) {
      document.body.classList.add('native-cta');
      el.footer.hidden = true;
      tg.MainButton.setText(text);
      if (valid) { tg.MainButton.enable(); tg.MainButton.setParams({ color: '#FF6B00', text_color: '#FFFFFF' }); }
      else { tg.MainButton.disable(); tg.MainButton.setParams({ color: '#F0C3A2', text_color: '#FFFFFF' }); }
      tg.MainButton.show();
    } else {
      el.footer.hidden = false;
      el.cta.textContent = text;
      el.cta.disabled = !valid;
    }

    el.ctaHint.textContent = hintFor(valid);
  }

  function stepId() {
    var ids = steps();
    return state.step >= 0 && state.step < ids.length ? ids[state.step] : null;
  }

  function hintFor(valid) {
    if (state.error) return state.error + ' — проверьте связь и попробуйте ещё раз';
    var id = stepId();
    if (id === 'subjects' && !valid) return 'Отметьте хотя бы один предмет';
    if (id === 'priorities' && !valid) return 'Отметьте хотя бы один пункт';
    if (id === 'goal') return 'Можно вернуться и изменить в любой момент';
    return '';
  }

  function useMainButton() { return inTelegram && !!tg.MainButton; }

  /* ------------------------------------------------------- навигация --- */

  function next() {
    if (state.busy) return;
    var valid = typeof current.valid === 'function' ? current.valid() : current.valid;
    if (!valid) { haptic('rigid'); return; }

    if (state.step > total()) { if (inTelegram) tg.close(); return; }
    if (state.step === total()) { submit(); return; }

    // Пропускаем шаг цели, если предметов почему-то нет
    state.step += 1;
    haptic('light');
    render(1);
  }

  function back() {
    if (state.busy || state.step > total()) return;
    if (state.step <= -1) { if (inTelegram) tg.close(); return; }
    state.step -= 1;
    state.sent = false;
    state.error = null;
    haptic('light');
    render(-1);
  }

  /* ------------------------------------------------------------ submit -- */

  function payload() {
    var exam = currentExam();
    return {
      v: 2,
      source: 'umskul_qualification',
      track: state.track || 'full',
      role: state.role,
      grade: state.grade,
      exam: exam,
      goal_unit: goalUnit(),
      subjects: state.subjects.map(function (id) {
        var s = subjectById(id);
        return { id: id, name: s ? s.name : id, goal: state.goals[id] };
      }),
      goal_avg: averageGoal(),
      level: state.level,
      priorities: state.priorities.slice(),
      preparation: state.prep,
      online_experience: state.online,
      recommendation: recommendation(exam),
      ts: new Date().toISOString(),
      context: Object.assign({ start_param: launch.startParam }, cfg.extra || {})
    };
  }

  /** Конверт для бэкенда: сырой initData нужен серверу для проверки подписи. */
  function envelope() {
    return {
      init_data: (tg && tg.initData) || '',
      start_param: launch.startParam,
      query_id: launch.queryId,
      data: payload()
    };
  }

  /**
   * Транспорт:
   *  http     — POST на submitUrl; работает при любом способе запуска;
   *  senddata — Telegram.WebApp.sendData(), только для reply-клавиатуры;
   *  clipboard — фолбэк для обычного браузера.
   */
  function transport() {
    if (cfg.submitUrl) return 'http';
    if (inTelegram && typeof tg.sendData === 'function') return 'senddata';
    return 'clipboard';
  }

  function finishTelegramSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* no-op */ }
    if (inTelegram && typeof tg.disableClosingConfirmation === 'function') tg.disableClosingConfirmation();
  }

  function submit() {
    if (state.busy) return;
    var mode = transport();

    if (mode === 'senddata') {
      state.sent = true;
      haptic('success');
      finishTelegramSession();
      tg.sendData(JSON.stringify(payload())); // Telegram сам закроет мини-апп
      return;
    }

    if (mode === 'http') { submitHttp(); return; }

    // Вне Telegram и без submitUrl — отдаём ответы в буфер обмена
    var data = JSON.stringify(payload());
    var done = function () {
      el.ctaHint.textContent = 'Ответы скопированы в буфер обмена';
      haptic('success');
      confetti();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(data).then(done, function () { console.log(data); done(); });
    } else {
      console.log(data);
      done();
    }
  }

  function submitHttp() {
    setBusy(true);
    state.error = null;

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, cfg.submitTimeout || 15000);

    fetch(cfg.submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope()),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function () {
      clearTimeout(timer);
      setBusy(false);
      state.sent = true;
      finishTelegramSession();
      haptic('success');
      state.step = total() + 1;
      render(1);
    }, function (err) {
      clearTimeout(timer);
      setBusy(false);
      state.error = err && err.name === 'AbortError' ? 'Не дождались ответа сервера' : 'Не удалось отправить';
      haptic('error');
      syncCta();
    });
  }

  function setBusy(busy) {
    state.busy = busy;
    if (useMainButton()) {
      if (busy) {
        if (typeof tg.MainButton.showProgress === 'function') tg.MainButton.showProgress(true);
        tg.MainButton.disable();
      } else {
        if (typeof tg.MainButton.hideProgress === 'function') tg.MainButton.hideProgress();
        tg.MainButton.enable();
      }
    } else {
      el.cta.disabled = busy;
      el.cta.textContent = busy ? 'Отправляем…' : (state.error ? 'Отправить ещё раз' : current.cta);
    }
    if (busy) el.ctaHint.textContent = 'Отправляем ответы…';
  }

  /* ---------------------------------------------------------- конфетти -- */

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var colors = ['#FF6B00', '#FF9A4D', '#14110F', '#FFC79E', '#FF7A1A'];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 46; i++) {
      var piece = h('span', { class: 'confetti__piece' });
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
      piece.style.setProperty('--rot', (Math.random() * 900 - 300) + 'deg');
      piece.style.animationDuration = (1.9 + Math.random() * 1.6) + 's';
      piece.style.animationDelay = (Math.random() * .5) + 's';
      piece.style.opacity = String(.75 + Math.random() * .25);
      frag.appendChild(piece);
    }
    el.confetti.appendChild(frag);
    setTimeout(function () { el.confetti.innerHTML = ''; }, 4200);
  }

  /* -------------------------------------------------------------- init -- */

  function applyTheme() {
    if (!inTelegram) return;
    document.documentElement.setAttribute('data-scheme', tg.colorScheme === 'dark' ? 'dark' : 'light');
    var bg = tg.colorScheme === 'dark' ? '#121110' : '#FFFFFF';
    try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch (e) { /* старые клиенты */ }
  }

  function init() {
    el.cta.addEventListener('click', next);
    el.back.addEventListener('click', back);

    if (inTelegram) {
      tg.ready();
      tg.expand();
      applyTheme();
      tg.onEvent('themeChanged', applyTheme);
      if (tg.MainButton) tg.MainButton.onClick(next);
      if (tg.BackButton) tg.BackButton.onClick(back);
      if (typeof tg.enableClosingConfirmation === 'function') tg.enableClosingConfirmation();
      if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    }

    render(1);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
