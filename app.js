const STORAGE_KEY = "haru.events.v3";
const TASK_KEY = "haru.tasks.v3";
const REMINDER_DEFAULTS = { previousEvening: true, sameMorning: true, oneHourBefore: true };
const $ = (id) => document.getElementById(id);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const load = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
};
let events = load(STORAGE_KEY, load("haru.events.v2", load("haru.events.v1", [])));
let tasks = load(TASK_KEY, load("haru.tasks.v2", load("haru.tasks.v1", [])));
let selectedDate = todayISO();
let editingEventId = null;
let editingTaskId = null;
let toastTimer = null;

function persist(nextEvents = events, nextTasks = tasks) {
  let previousEvents;
  let previousTasks;
  try {
    previousEvents = localStorage.getItem(STORAGE_KEY);
    previousTasks = localStorage.getItem(TASK_KEY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEvents));
    localStorage.setItem(TASK_KEY, JSON.stringify(nextTasks));
    events = nextEvents;
    tasks = nextTasks;
    return true;
  } catch {
    // 두 저장소 중 하나만 기록되는 상황을 최대한 되돌립니다.
    try {
      if (previousEvents === null || previousEvents === undefined) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previousEvents);
      if (previousTasks === null || previousTasks === undefined) localStorage.removeItem(TASK_KEY);
      else localStorage.setItem(TASK_KEY, previousTasks);
    } catch { /* 저장소 자체가 잠긴 경우에는 복구를 보장할 수 없습니다. */ }
    showToast("저장에 실패했어요. 기존 내용은 유지했어요. 저장 공간과 브라우저 설정을 확인해 주세요.");
    return false;
  }
}
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function isValidISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}
function isValidTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function parseISO(iso) {
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(y, m-1, d, 12);
}
function fmtDate(iso, options = {month:"long",day:"numeric",weekday:"long"}) {
  return parseISO(iso).toLocaleDateString("ko-KR", options);
}
function reminderFlags(event) {
  if (event.reminderFlags && typeof event.reminderFlags === "object") {
    return {
      previousEvening: event.reminderFlags.previousEvening !== false,
      sameMorning: event.reminderFlags.sameMorning !== false,
      oneHourBefore: event.reminderFlags.oneHourBefore !== false
    };
  }
  // 이전 버전 일정은 사용자가 기존에 선택한 알림 범위를 최대한 보존
  const legacy = event.reminder || "하루 전 + 당일";
  if (legacy === "없음") return {previousEvening:false,sameMorning:false,oneHourBefore:false};
  if (legacy === "당일") return {previousEvening:false,sameMorning:true,oneHourBefore:true};
  if (legacy === "하루 전") return {previousEvening:true,sameMorning:false,oneHourBefore:false};
  return {...REMINDER_DEFAULTS};
}
function selectedReminderFlags() {
  return {
    previousEvening: $("reminderPrevious").checked,
    sameMorning: $("reminderMorning").checked,
    oneHourBefore: $("reminderBefore").checked
  };
}
function reminderSummary(event) {
  const flags = reminderFlags(event);
  const labels = [];
  if (flags.previousEvening) labels.push("전날 19시");
  if (flags.sameMorning) labels.push("당일 09시");
  if (flags.oneHourBefore) labels.push("1시간 전");
  return labels.length ? `알림 ${labels.join(" · ")}` : "알림 꺼짐";
}
function makeLocalDate(iso, hh, mm) {
  const [y,m,d] = iso.split("-").map(Number);
  return new Date(y, m-1, d, hh, mm, 0, 0);
}
function shiftISO(iso, amount) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + amount);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function reminderItems(days = 30) {
  const now = new Date();
  const grouped = new Map();
  for (let offset = 0; offset < days; offset++) {
    const occurrenceDate = shiftISO(todayISO(), offset);
    for (const event of events) {
      if (!occursOn(event, occurrenceDate)) continue;
      const flags = reminderFlags(event);
      const candidates = [];
      if (flags.previousEvening) {
        const prev = shiftISO(occurrenceDate, -1);
        candidates.push({at:makeLocalDate(prev,19,0), label:"전날 저녁 7시"});
      }
      if (flags.sameMorning) candidates.push({at:makeLocalDate(occurrenceDate,9,0), label:"당일 오전 9시"});
      if (flags.oneHourBefore && event.time) {
        const [h,m] = event.time.split(":").map(Number);
        const start = makeLocalDate(occurrenceDate,h,m);
        candidates.push({at:new Date(start.getTime()-60*60*1000), label:"시작 1시간 전"});
      }
      for (const item of candidates) {
        if (item.at <= now) continue;
        const isDailySummary = item.label === "전날 저녁 7시" || item.label === "당일 오전 9시";
        const key = isDailySummary
          ? `${item.label}|${occurrenceDate}|${item.at.getTime()}`
          : `${event.id}|${occurrenceDate}|${item.at.getTime()}`;
        if (!grouped.has(key)) grouped.set(key,{at:item.at,titles:[],date:occurrenceDate,labels:[]});
        const row = grouped.get(key);
        if (!row.titles.includes(event.title)) row.titles.push(event.title);
        if (!row.labels.includes(item.label)) row.labels.push(item.label);
      }
    }
  }
  return [...grouped.values()].sort((a,b)=>a.at-b.at).slice(0,30);
}
function renderReminderPreview() {
  const host = $("reminderPreview");
  if (!host) return;
  const rows = reminderItems();
  host.innerHTML = rows.length ? rows.map(row => `
    <div class="reminder-preview-row">
      <span class="preview-date">${row.at.toLocaleDateString("ko-KR",{month:"numeric",day:"numeric"})}</span>
      <span class="preview-time">${row.at.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",hour12:false})}</span>
      <span class="preview-detail"><strong>${esc(row.titles.join(" · "))}</strong><small>${esc(row.labels.join(" · "))}</small></span>
    </div>`).join("") : `<div class="preview-empty">앞으로 30일 동안 예정된 알림이 없어요.</div>`;
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}
function occursOn(event, date) {
  if (date < event.date) return false;
  if (event.repeat === "매일") return true;
  if (event.repeat === "매주") return parseISO(date).getDay() === parseISO(event.date).getDay();
  if (event.repeat === "매월") return parseISO(date).getDate() === parseISO(event.date).getDate();
  return date === event.date;
}
function eventsForDate(date) {
  return events.filter(event => occursOn(event, date)).sort((a,b) => (a.time || "00:00").localeCompare(b.time || "00:00"));
}
function render() {
  $("selectedDate").value = selectedDate;
  $("weekdayLabel").textContent = fmtDate(selectedDate, {weekday:"long",month:"long",day:"numeric"});
  $("todayLabel").textContent = selectedDate === todayISO() ? "오늘의 하루" : fmtDate(selectedDate);
  const dayEvents = eventsForDate(selectedDate);
  const dayTasks = tasks.filter(task => task.date === selectedDate);
  $("scheduleCount").textContent = dayEvents.length;
  $("todoCount").textContent = dayTasks.filter(task => !task.done).length;
  $("doneCount").textContent = dayTasks.filter(task => task.done).length;

  $("scheduleList").innerHTML = dayEvents.length ? dayEvents.map(event => `
    <div class="schedule-item">
      <div class="event-time">${esc(event.time || "시간 미정")}</div>
      <div class="event-bar"></div>
      <div class="event-main">
        <strong>${esc(event.title)}</strong>
        <small>${esc([event.place, event.memo, event.repeat && event.repeat !== "없음" ? `반복 ${event.repeat}` : "", reminderSummary(event)].filter(Boolean).join(" · "))}</small>
      </div>
      <button class="more-button" data-edit-event="${esc(event.id)}" aria-label="일정 수정">···</button>
    </div>`).join("") : `<div class="empty">이 날짜에는 등록된 일정이 없어요.<br>새 일정을 추가해 보세요.</div>`;

  $("taskList").innerHTML = dayTasks.length ? dayTasks.map(task => `
    <div class="task-row ${task.done ? "done" : ""}">
      <input type="checkbox" data-toggle-task="${esc(task.id)}" aria-label="할 일 완료" ${task.done ? "checked" : ""}>
      <button class="task-title-button" data-edit-task="${esc(task.id)}">${esc(task.title)}</button>
      <button class="task-more" data-edit-task="${esc(task.id)}" aria-label="할 일 수정">···</button>
    </div>`).join("") : `<div class="empty">등록된 할 일이 없어요.<br>오늘 할 일을 하나 추가해 볼까요?</div>`;
}
function openNewEvent() {
  editingEventId = null;
  $("scheduleForm").reset();
  $("eventDate").value = selectedDate;
  $("eventTime").value = "09:00";
  $("reminderPrevious").checked = true;
  $("reminderMorning").checked = true;
  $("reminderBefore").checked = true;
  $("dialogTitle").textContent = "새 일정 추가";
  $("deleteEventBtn").classList.add("hidden");
  $("scheduleDialog").showModal();
}
function openEditEvent(id) {
  const event = events.find(item => item.id === id);
  if (!event) return;
  editingEventId = id;
  $("eventTitle").value = event.title;
  $("eventDate").value = event.date;
  $("eventTime").value = event.time || "09:00";
  $("eventPlace").value = event.place || "";
  $("eventMemo").value = event.memo || "";
  const flags = reminderFlags(event);
  $("reminderPrevious").checked = flags.previousEvening;
  $("reminderMorning").checked = flags.sameMorning;
  $("reminderBefore").checked = flags.oneHourBefore;
  $("eventRepeat").value = event.repeat || "없음";
  $("dialogTitle").textContent = "일정 수정";
  $("deleteEventBtn").classList.remove("hidden");
  $("scheduleDialog").showModal();
}
function openNewTask() {
  editingTaskId = null;
  $("taskForm").reset();
  $("taskDate").value = selectedDate;
  $("taskDialogTitle").textContent = "할 일 추가";
  $("deleteTaskBtn").classList.add("hidden");
  $("taskDialog").showModal();
}
function openEditTask(id) {
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  editingTaskId = id;
  $("taskTitle").value = task.title;
  $("taskDate").value = task.date;
  $("taskDialogTitle").textContent = "할 일 수정";
  $("deleteTaskBtn").classList.remove("hidden");
  $("taskDialog").showModal();
}

$("addScheduleBtn").addEventListener("click", openNewEvent);
$("closeDialog").addEventListener("click", () => $("scheduleDialog").close());
$("scheduleList").addEventListener("click", e => {
  const button = e.target.closest("[data-edit-event]");
  if (button) openEditEvent(button.dataset.editEvent);
});
$("scheduleForm").addEventListener("submit", e => {
  e.preventDefault();
  const title = $("eventTitle").value.trim();
  const date = $("eventDate").value;
  if (!title || !date) return showToast("일정 제목과 날짜를 확인해 주세요.");
  const time = $("eventTime").value || "09:00";
  if (!isValidISODate(date) || !isValidTime(time)) return showToast("날짜와 시간을 다시 확인해 주세요.");
  const wasEditing = Boolean(editingEventId);
  const item = {
    id: editingEventId || uid(), title, date, time,
    place: $("eventPlace").value.trim(),
    memo: $("eventMemo").value.trim(),
    reminderFlags: selectedReminderFlags(),
    repeat: $("eventRepeat").value
  };
  const nextEvents = wasEditing
    ? events.map(old => old.id === editingEventId ? item : old)
    : [...events, item];
  if (persist(nextEvents, tasks)) {
    selectedDate = date;
    render();
    $("scheduleDialog").close();
    showToast(wasEditing ? "일정을 수정했어요." : "일정을 저장했어요.");
  }
});
$("deleteEventBtn").addEventListener("click", () => {
  if (!editingEventId || !confirm("이 반복 일정을 포함해 원본 일정을 삭제할까요?")) return;
  const nextEvents = events.filter(event => event.id !== editingEventId);
  if (persist(nextEvents, tasks)) {
    render();
    $("scheduleDialog").close();
    showToast("일정을 삭제했어요.");
  }
});

$("addTaskBtn").addEventListener("click", openNewTask);
$("closeTaskDialog").addEventListener("click", () => $("taskDialog").close());
$("taskList").addEventListener("click", e => {
  const button = e.target.closest("[data-edit-task]");
  if (button) openEditTask(button.dataset.editTask);
});
$("taskList").addEventListener("change", e => {
  const id = e.target.dataset.toggleTask;
  if (!id) return;
  const task = tasks.find(item => item.id === id);
  if (task) {
    const nextTasks = tasks.map(item => item.id === id ? {...item, done:e.target.checked} : item);
    if (persist(events, nextTasks)) render();
    else e.target.checked = !e.target.checked;
  }
});
$("taskForm").addEventListener("submit", e => {
  e.preventDefault();
  const title = $("taskTitle").value.trim();
  const date = $("taskDate").value;
  if (!title || !date) return showToast("할 일과 날짜를 확인해 주세요.");
  const old = tasks.find(task => task.id === editingTaskId);
  if (!isValidISODate(date)) return showToast("날짜를 다시 확인해 주세요.");
  const wasEditing = Boolean(editingTaskId);
  const item = {id: editingTaskId || uid(), title, date, done: old?.done || false};
  const nextTasks = wasEditing
    ? tasks.map(task => task.id === editingTaskId ? item : task)
    : [...tasks, item];
  if (persist(events, nextTasks)) {
    selectedDate = date;
    render();
    $("taskDialog").close();
    showToast(wasEditing ? "할 일을 수정했어요." : "할 일을 추가했어요.");
  }
});
$("deleteTaskBtn").addEventListener("click", () => {
  if (!editingTaskId || !confirm("이 할 일을 삭제할까요?")) return;
  const nextTasks = tasks.filter(task => task.id !== editingTaskId);
  if (persist(events, nextTasks)) {
    render();
    $("taskDialog").close();
    showToast("할 일을 삭제했어요.");
  }
});

$("selectedDate").addEventListener("change", e => {
  selectedDate = e.target.value || todayISO();
  render();
});
function shiftDate(amount) {
  const date = parseISO(selectedDate);
  date.setDate(date.getDate() + amount);
  selectedDate = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  render();
}
$("prevDay").addEventListener("click", () => shiftDate(-1));
$("nextDay").addEventListener("click", () => shiftDate(1));
$("todayBtn").addEventListener("click", () => { selectedDate = todayISO(); render(); });

function renderAllEvents() {
  const upcoming = [];
  const start = todayISO();
  for (let offset = 0; offset < 90; offset++) {
    const d = parseISO(start);
    d.setDate(d.getDate() + offset);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    for (const event of eventsForDate(iso)) upcoming.push({date:iso, event});
  }
  $("allScheduleList").innerHTML = upcoming.length ? upcoming.slice(0,100).map(({date,event}) => `
    <button class="all-event-row" data-jump-date="${date}" data-jump-event="${esc(event.id)}">
      <span class="all-event-date">${fmtDate(date,{month:"short",day:"numeric",weekday:"short"})}</span>
      <span class="all-event-time">${esc(event.time || "시간 미정")}</span>
      <strong>${esc(event.title)}</strong>
    </button>`).join("") : `<div class="empty">앞으로 등록된 일정이 없어요.</div>`;
}
$("showAllBtn").addEventListener("click", () => {
  renderAllEvents();
  $("allDialog").showModal();
});
$("closeAllDialog").addEventListener("click", () => $("allDialog").close());
$("allScheduleList").addEventListener("click", e => {
  const row = e.target.closest("[data-jump-date]");
  if (!row) return;
  selectedDate = row.dataset.jumpDate;
  $("allDialog").close();
  render();
  openEditEvent(row.dataset.jumpEvent);
});

$("settingsBtn").addEventListener("click", () => {
  renderReminderPreview();
  $("settingsDialog").showModal();
});
$("closeSettings").addEventListener("click", () => $("settingsDialog").close());
$("exportBtn").addEventListener("click", () => {
  const backup = {app:"haru", version:3, exportedAt:new Date().toISOString(), events, tasks};
  const blob = new Blob([JSON.stringify(backup,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `haru-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("백업 파일을 내보냈어요.");
});
$("importFile").addEventListener("change", async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || (data.app && data.app !== "haru") || !Array.isArray(data.events) || !Array.isArray(data.tasks)) throw new Error("invalid");
    if (!confirm("현재 하루의 일정과 할 일을 백업 파일 내용으로 바꿀까요?")) return;
    const usedEventIds = new Set();
    const restoredEvents = data.events.filter(x => x && typeof x.title === "string" && x.title.trim() && isValidISODate(x.date)).map(x => {
      let id = typeof x.id === "string" && x.id.trim() ? x.id : uid();
      if (usedEventIds.has(id)) id = uid();
      usedEventIds.add(id);
      const repeat = ["없음", "매일", "매주", "매월"].includes(x.repeat) ? x.repeat : "없음";
      const flags = x.reminderFlags && typeof x.reminderFlags === "object" ? x.reminderFlags : reminderFlags(x);
      return {
        id, title:x.title.trim().slice(0,80), date:x.date,
        time:isValidTime(x.time) ? x.time : "09:00",
        place:typeof x.place === "string" ? x.place.slice(0,100) : "",
        memo:typeof x.memo === "string" ? x.memo.slice(0,500) : "",
        repeat,
        reminderFlags:{
          previousEvening:flags.previousEvening !== false,
          sameMorning:flags.sameMorning !== false,
          oneHourBefore:flags.oneHourBefore !== false
        }
      };
    });
    const usedTaskIds = new Set();
    const restoredTasks = data.tasks.filter(x => x && typeof x.title === "string" && x.title.trim() && isValidISODate(x.date)).map(x => {
      let id = typeof x.id === "string" && x.id.trim() ? x.id : uid();
      if (usedTaskIds.has(id)) id = uid();
      usedTaskIds.add(id);
      return {id, title:x.title.trim().slice(0,100), date:x.date, done:x.done === true};
    });
    if (persist(restoredEvents, restoredTasks)) {
      render();
      renderReminderPreview();
      $("settingsDialog").close();
      showToast("백업을 복원했어요.");
    }
  } catch {
    showToast("올바른 하루 백업 파일이 아니에요.");
  } finally {
    e.target.value = "";
  }
});

function parseSpokenSchedule(spoken) {
  let text = spoken.trim();
  let date = selectedDate;
  const base = parseISO(todayISO());
  const datePatterns = [
    {re:/모레/, days:2}, {re:/내일/, days:1}, {re:/오늘/, days:0}
  ];
  for (const item of datePatterns) {
    if (item.re.test(text)) {
      const d = new Date(base);
      d.setDate(d.getDate() + item.days);
      date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      text = text.replace(item.re, " ");
      break;
    }
  }
  let time = "09:00";
  const match = text.match(/(오전|오후|저녁|아침)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (match) {
    let hour = Number(match[2]);
    const minute = Number(match[3] || 0);
    const hasMeridiem = Boolean(match[1]);
    const validHour = hasMeridiem ? hour >= 1 && hour <= 12 : hour >= 0 && hour <= 23;
    if (validHour && minute >= 0 && minute <= 59) {
      if (["오후","저녁"].includes(match[1]) && hour < 12) hour += 12;
      if (match[1] === "오전" && hour === 12) hour = 0;
      if (!match[1] && hour >= 1 && hour <= 6) hour += 12;
      time = `${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`;
      text = text.replace(match[0], " ");
    }
  }
  text = text.replace(/(일정|예약|등록해줘|추가해줘|잡아줘|해줘)/g, " ").replace(/\s+/g," ").trim();
  return {date, time, title:text || spoken.trim()};
}
$("voiceBtn").addEventListener("click", () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("현재 브라우저에서는 음성 입력을 지원하지 않아요.");
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "ko-KR";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  $("voiceNote").textContent = "듣고 있어요. 일정 내용을 말해 주세요.";
  recognition.onresult = event => {
    const spoken = event.results[0][0].transcript;
    const parsed = parseSpokenSchedule(spoken);
    editingEventId = null;
    $("scheduleForm").reset();
    $("eventTitle").value = parsed.title;
    $("eventDate").value = parsed.date;
    $("eventTime").value = parsed.time;
    $("dialogTitle").textContent = "음성 입력 확인";
    $("deleteEventBtn").classList.add("hidden");
    $("scheduleDialog").showModal();
    $("voiceNote").textContent = `인식한 내용: ${spoken}`;
  };
  recognition.onerror = () => {
    $("voiceNote").textContent = "음성을 인식하지 못했어요. 다시 시도해 주세요.";
    showToast("음성을 인식하지 못했어요.");
  };
  recognition.onend = () => {
    if ($("voiceNote").textContent === "듣고 있어요. 일정 내용을 말해 주세요.") {
      $("voiceNote").textContent = "예: “내일 오후 3시 치과 예약”처럼 말해 보세요.";
    }
  };
  try { recognition.start(); }
  catch { showToast("음성 입력을 시작하지 못했어요."); }
});

document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  button.classList.add("active");
  if (button.dataset.tab === "schedule") window.scrollTo({top:0,behavior:"smooth"});
  if (button.dataset.tab === "tasks") {
    $("taskList").scrollIntoView({behavior:"smooth",block:"center"});
    $("addTaskBtn").focus();
  }
  if (button.dataset.tab === "voice") $("voiceBtn").click();
  if (button.dataset.tab === "settings") $("settingsDialog").showModal();
}));

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
render();
