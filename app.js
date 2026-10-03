/* ==========================================================================
   MEGURU（めぐる） - app.js
   くりかえすTODO（○日・週・か月・年ごと）と1回きりのTODOを、
   サイクル・場所・カテゴリで管理するPWA。
   「日用品ストック管理」と同じ考え方で作っています：
     ・同期モードが "cloud" なら Firebase Firestore、"local" なら localStorage のみ
     ・「やった」ボタン1つで次回の予定日を自動計算
     ・やった日の履歴から平均間隔を出して、ボタン1つで間隔に反映
   ========================================================================== */

const DEFAULT_CATEGORIES = ["家事", "掃除", "身の回り", "仕事", "お金・手続き", "車・バイク", "その他"];
const DEFAULT_PLACES = ["自宅", "会社", "外出先", "車", "ネット"];
const SETTINGS_KEY = "meguru_settings_v1";
const LOCAL_TASKS_KEY = "meguru_tasks_local_v1";
const CLOUD_ROOT = "meguru";              // Firestore: meguru/{共有コード}/tasks/{id}

// アプリのバージョン（更新のたびに index.html の ?v= と合わせて変える）
const APP_VERSION = "2026.10.03-1";
const SETUP_PARAM = "setup=";

const state = {
  tasks: [],
  settings: {
    syncMode: "local",       // "local" | "cloud"
    warnDays: 2,
    showNoDate: true,        // 期限なしの1回きりTODOを「今やること」に出すか
    categories: [...DEFAULT_CATEGORIES],
    places: [...DEFAULT_PLACES],
    placeFilter: "",         // 「今やること」「これから」の場所の絞り込み（この端末だけ）
    remindTime: "08:00",
    firebaseConfig: null,
    syncCode: "",
    mergedCodes: []
  },
  activeTab: "today",
  cloud: { app: null, db: null, unsub: null, metaUnsub: null, sharedOk: false, ready: false }
};

/* ---------------------------- Utilities -------------------------------- */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

const pad2 = (n) => String(n).padStart(2, "0");

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayStr() { return ymd(new Date()); }

function addDaysStr(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// 月・年の加算は「月末」に合わせる（1/31 の1か月後は 2/28 など）
function addMonthsStr(s, n) {
  const d = parseYmd(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
}

function addInterval(s, n, unit) {
  if (unit === "week") return addDaysStr(s, n * 7);
  if (unit === "month") return addMonthsStr(s, n);
  if (unit === "year") return addMonthsStr(s, n * 12);
  return addDaysStr(s, n);
}

// a から b まで何日か（b が後なら正）
function diffDays(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dispDate(s) {
  if (!s) return "";
  const d = parseYmd(s);
  const base = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${d.getFullYear()}/${base}`;
}

let toastTimer = null;
let toastUndo = null;
function showToast(msg, undoFn) {
  const t = document.getElementById("toast");
  document.getElementById("toastMsg").textContent = msg;
  const btn = document.getElementById("toastAction");
  toastUndo = typeof undoFn === "function" ? undoFn : null;
  btn.hidden = !toastUndo;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; toastUndo = null; }, toastUndo ? 5000 : 2400);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------------------------- 安全対策：データの検査と整形 ------------------- */
// インポートしたファイル・同期で届いたデータ・端末に保存されたデータは、
// 書き換えられている可能性があるものとして、使う前に決まった形に整える。

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNITS = ["day", "week", "month", "year"];
const MAX_IMAGE_DATA = 400000;
const MAX_IMPORT_ITEMS = 2000;
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

function cleanStr(v, max) {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  return "";
}

function safeImageData(d) {
  return typeof d === "string" && d.length <= MAX_IMAGE_DATA &&
    /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(d) ? d : "";
}

function cleanDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const d = parseYmd(v);
  return Number.isNaN(d.getTime()) ? null : v;
}

function sanitizeTask(raw, keepId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let id = typeof raw.id === "string" ? raw.id : "";
  if (!keepId && !ID_RE.test(id)) id = uid();
  if (!id) return null;
  const interval = Math.round(Number(raw.interval));
  const kind = raw.kind === "once" ? "once" : "repeat";
  return {
    id,
    name: cleanStr(raw.name, 100).trim() || "（名前なし）",
    kind,
    interval: Number.isFinite(interval) && interval >= 1 ? Math.min(interval, 999) : 1,
    unit: UNITS.includes(raw.unit) ? raw.unit : "week",
    lastDone: cleanDate(raw.lastDone),
    nextOverride: cleanDate(raw.nextOverride),
    dueDate: cleanDate(raw.dueDate),
    done: kind === "once" && raw.done === true,
    doneAt: cleanDate(raw.doneAt),
    thumbType: raw.thumbType === "upload" ? "upload" : "icon",
    icon: window.MeguruIcons.has(raw.icon) ? raw.icon : "check",
    color: window.MeguruIcons.hasColor(raw.color) ? raw.color : "indigo",
    imageData: safeImageData(raw.imageData),
    category: cleanStr(raw.category, 50),
    place: cleanStr(raw.place, 50).trim(),
    memo: cleanStr(raw.memo, 500),
    history: Array.from(new Set((Array.isArray(raw.history) ? raw.history : []).map(cleanDate).filter(Boolean))).sort().slice(-10),
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0
  };
}

function sanitizeTasks(list, keepId) {
  return (Array.isArray(list) ? list : []).map((x) => sanitizeTask(x, keepId)).filter(Boolean);
}

function sanitizeNameList(list, fallback, allowEmpty) {
  if (!Array.isArray(list)) return [...fallback];
  const out = Array.from(new Set(list.map((c) => cleanStr(c, 50).trim()).filter(Boolean))).slice(0, 50);
  return out.length || allowEmpty ? out : [...fallback];
}

function isValidSyncCode(code) {
  return typeof code === "string" && /^[^\/\s]{4,100}$/.test(code) && !/^__.*__$/.test(code) && code !== "." && code !== "..";
}

function isPlausibleFirebaseConfig(cfg) {
  return !!cfg &&
    /^[A-Za-z0-9_-]{20,80}$/.test(cfg.apiKey || "") &&
    /^[a-z0-9-]{4,40}$/.test(cfg.projectId || "") &&
    /^[A-Za-z0-9:._-]{5,120}$/.test(cfg.appId || "") &&
    (!cfg.authDomain || /^[a-z0-9.-]{4,120}$/i.test(cfg.authDomain));
}

function sanitizeForCloud(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function getWarnDays() {
  const v = Number(state.settings.warnDays);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------------------------- 接続用リンク -------------------------------- */

function buildSetupLink() {
  const cfg = state.settings.firebaseConfig || {};
  const code = (state.settings.syncCode || "").trim();
  const payload = { v: 1, a: cfg.apiKey, p: cfg.projectId, i: cfg.appId, k: code };
  if (cfg.authDomain && cfg.authDomain !== `${cfg.projectId}.firebaseapp.com`) payload.d = cfg.authDomain;
  const base = location.href.split("#")[0];
  return `${base}#${SETUP_PARAM}${base64UrlEncode(JSON.stringify(payload))}`;
}

function parseSetupLink(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const idx = t.indexOf(SETUP_PARAM);
  const token = (idx >= 0 ? t.slice(idx + SETUP_PARAM.length) : t).split(/[&\s]/)[0];
  try {
    const obj = JSON.parse(base64UrlDecode(token));
    if (!obj || typeof obj !== "object") return null;
    const config = {
      apiKey: String(obj.a || ""),
      authDomain: obj.d ? String(obj.d) : `${obj.p}.firebaseapp.com`,
      projectId: String(obj.p || ""),
      appId: String(obj.i || "")
    };
    const code = String(obj.k || "");
    if (!isPlausibleFirebaseConfig(config) || !isValidSyncCode(code)) return null;
    return { config, code };
  } catch (e) {
    return null;
  }
}

/* ---------------------------- Firebase 設定の読み取り -------------------- */

function parseFirebaseConfig(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch (e) { /* JSON ではないので下の方法で読み取る */ }
  const cfg = {};
  const re = /["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    cfg[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  }
  return Object.keys(cfg).length ? cfg : null;
}

const REQUIRED_CONFIG_KEYS = ["apiKey", "projectId", "appId"];
function missingConfigKeys(cfg) {
  return REQUIRED_CONFIG_KEYS.filter((k) => !cfg || !cfg[k]);
}

function describeFirebaseError(err) {
  const code = (err && err.code) || "";
  if (code.includes("operation-not-allowed") || code.includes("admin-restricted-operation")) {
    return "匿名ログインが有効になっていません。Firebaseコンソールの「セキュリティ」→「Authentication」→「ログイン方法」で「匿名」をオンにしてください。";
  }
  if (code.includes("api-key-not-valid") || code.includes("invalid-api-key")) {
    return "apiKey が正しくないようです。Firebaseの設定をもう一度コピーし直して貼り付けてください。";
  }
  if (code.includes("permission-denied")) {
    return "Firestoreへのアクセスが拒否されました。Firestoreの「ルール」に、MEGURU用のルール（手順書の手順C）が入っているか確認してください。";
  }
  if (code.includes("not-found")) {
    return "Firestoreのデータベースが見つかりません。データベースIDを「(default)」のまま作成したか確認してください。";
  }
  if (code.includes("network-request-failed") || code.includes("unavailable")) {
    return "ネットワークに接続できませんでした。インターネット接続を確認して、もう一度お試しください。";
  }
  if (typeof firebase === "undefined") {
    return "Firebaseの部品を読み込めませんでした。インターネット接続を確認して、ページを再読み込みしてください。";
  }
  return "接続できませんでした。（エラー: " + (code || (err && err.message) || "不明") + "）";
}

/* ---------------------------- Persistence ------------------------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.settings = { ...state.settings, ...parsed };
      state.settings.categories = sanitizeNameList(parsed.categories, DEFAULT_CATEGORIES, false);
      state.settings.places = sanitizeNameList(parsed.places, DEFAULT_PLACES, true);
      state.settings.placeFilter = cleanStr(parsed.placeFilter, 50);
      state.settings.showNoDate = parsed.showNoDate !== false;
    }
  } catch (e) { console.warn("settings load failed", e); }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { console.warn(e); }
}

function readLocalTasks() {
  try {
    const raw = localStorage.getItem(LOCAL_TASKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function loadLocalTasks() {
  state.tasks = sanitizeTasks(readLocalTasks(), false);
}

function saveLocalTasks() {
  try {
    localStorage.setItem(LOCAL_TASKS_KEY, JSON.stringify(state.tasks));
    return true;
  } catch (e) {
    console.warn(e);
    showToast("この端末の保存容量がいっぱいです。写真を外すか、クラウド同期をお使いください");
    return false;
  }
}

/* ---------------------------- Cloud (Firestore) -------------------------- */

function setSyncStatus(mode, label) {
  const dot = document.getElementById("syncDot");
  dot.classList.remove("on", "error");
  if (mode === "on") dot.classList.add("on");
  if (mode === "error") dot.classList.add("error");
  document.getElementById("syncLabel").textContent = label;
}

function stopCloud() {
  if (state.cloud.unsub) { state.cloud.unsub(); state.cloud.unsub = null; }
  if (state.cloud.metaUnsub) { state.cloud.metaUnsub(); state.cloud.metaUnsub = null; }
  state.cloud.ready = false;
  state.cloud.sharedOk = false;
}

function metaRef(code) {
  return state.cloud.db.collection(CLOUD_ROOT).doc(code).collection("meta").doc("settings");
}

function sharedPayload() {
  return {
    categories: state.settings.categories,
    places: state.settings.places,
    warnDays: getWarnDays(),
    showNoDate: !!state.settings.showNoDate,
    updatedAt: Date.now()
  };
}

function applySharedSettings(data) {
  if (!data) return;
  if (Array.isArray(data.categories)) state.settings.categories = sanitizeNameList(data.categories, DEFAULT_CATEGORIES, false);
  if (Array.isArray(data.places)) state.settings.places = sanitizeNameList(data.places, DEFAULT_PLACES, true);
  if (typeof data.warnDays === "number" && Number.isFinite(data.warnDays) && data.warnDays >= 0 && data.warnDays <= 365) {
    state.settings.warnDays = data.warnDays;
    document.getElementById("warnDays").value = data.warnDays;
  }
  if (typeof data.showNoDate === "boolean") {
    state.settings.showNoDate = data.showNoDate;
    document.getElementById("showNoDate").checked = data.showNoDate;
  }
  saveSettings();
  render();
}

// 共有設定（カテゴリ・場所・判定日数）の同期を始める。初めての共有コードでは端末側の一覧を足し合わせる
async function setupSharedSettings(code) {
  const ref = metaRef(code);
  try {
    const snap = await ref.get();
    const alreadyMerged = (state.settings.mergedCodes || []).includes(code);
    if (!snap.exists) {
      await ref.set(sanitizeForCloud(sharedPayload()));
    } else if (!alreadyMerged) {
      const cloud = snap.data() || {};
      const union = (a, b) => a.concat(b.filter((x) => !a.includes(x)));
      const cats = union(Array.isArray(cloud.categories) ? cloud.categories : [], state.settings.categories);
      const places = union(Array.isArray(cloud.places) ? cloud.places : [], state.settings.places);
      await ref.set(sanitizeForCloud({
        categories: cats,
        places,
        warnDays: typeof cloud.warnDays === "number" ? cloud.warnDays : getWarnDays(),
        showNoDate: typeof cloud.showNoDate === "boolean" ? cloud.showNoDate : !!state.settings.showNoDate,
        updatedAt: Date.now()
      }), { merge: true });
    }
    state.settings.mergedCodes = Array.from(new Set([...(state.settings.mergedCodes || []), code]));
    saveSettings();
    state.cloud.metaUnsub = ref.onSnapshot((doc) => {
      if (doc.exists) applySharedSettings(doc.data());
    }, (err) => {
      console.warn(err);
      state.cloud.sharedOk = false;
    });
    state.cloud.sharedOk = true;
    return true;
  } catch (e) {
    console.warn("共有設定を同期できません", e);
    state.cloud.sharedOk = false;
    return false;
  }
}

function saveSharedSettings() {
  saveSettings();
  if (state.settings.syncMode === "cloud" && state.cloud.ready && state.cloud.sharedOk) {
    const code = (state.settings.syncCode || "").trim();
    metaRef(code).set(sanitizeForCloud(sharedPayload()), { merge: true }).catch((e) => {
      console.error(e);
      showToast(describeFirebaseError(e));
    });
  }
}

const RULES_UPDATE_NOTE = "※カテゴリ・場所・判定日数は、まだ同期されていません。Firestoreの「ルール」に、手順書の手順CのMEGURU用ルール（meta の部分を含む）を貼り付けて「公開」してから、アプリを再読み込みしてください。TODOの同期は問題なく動いています。";

async function connectCloud(options = {}) {
  const cfg = state.settings.firebaseConfig;
  const code = (state.settings.syncCode || "").trim();
  if (!cfg || !code) {
    setSyncStatus("off", "未設定");
    return { ok: false, message: "Firebaseの設定と共有コードの両方を入力してください。" };
  }
  try {
    if (typeof firebase === "undefined") throw new Error("firebase-sdk-not-loaded");
    stopCloud();
    if (state.cloud.app) {
      try { await state.cloud.app.delete(); } catch (e) { /* ignore */ }
      state.cloud.app = null;
    }
    // 「日用品ストック管理」と同じページ上で動くことはないが、念のため名前付きで初期化する
    state.cloud.app = firebase.initializeApp(cfg, "meguru");
    await state.cloud.app.auth().signInAnonymously();
    state.cloud.db = state.cloud.app.firestore();
    const colRef = state.cloud.db.collection(CLOUD_ROOT).doc(code).collection("tasks");

    const firstSnap = await colRef.get();

    if (options.offerMigration && firstSnap.empty) {
      const localTasks = readLocalTasks();
      if (localTasks.length) {
        const ok = confirm(
          `この端末に登録済みの ${localTasks.length} 件のTODOを、クラウドにコピーしますか？\n` +
          "（コピーすると、同じ共有コードを入れたスマホなど他の端末でも表示されます）"
        );
        if (ok) {
          const batch = state.cloud.db.batch();
          sanitizeTasks(localTasks, false).forEach((t) => batch.set(colRef.doc(t.id), sanitizeForCloud(t)));
          await batch.commit();
        }
      }
    }

    const sharedOk = await setupSharedSettings(code);

    state.cloud.unsub = colRef.onSnapshot((snap) => {
      const tasks = [];
      snap.forEach((doc) => {
        const t = sanitizeTask({ ...doc.data(), id: doc.id }, true);
        if (t) tasks.push(t);
      });
      tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      state.tasks = tasks;
      render();
    }, (err) => {
      console.error(err);
      setSyncStatus("error", "同期エラー");
      showToast(describeFirebaseError(err));
    });

    state.cloud.ready = true;
    setSyncStatus("on", "同期中：" + code);
    return { ok: true, sharedOk };
  } catch (e) {
    console.error(e);
    stopCloud();
    setSyncStatus("error", "接続失敗");
    return { ok: false, message: describeFirebaseError(e) };
  }
}

function cloudCollection() {
  const code = (state.settings.syncCode || "").trim();
  return state.cloud.db.collection(CLOUD_ROOT).doc(code).collection("tasks");
}

/* ---------------------------- Data operations ---------------------------- */

async function upsertTask(task) {
  if (state.settings.syncMode === "cloud" && state.cloud.ready) {
    try {
      await cloudCollection().doc(task.id).set(sanitizeForCloud(task));
      return true; // 画面は onSnapshot 経由で更新される
    } catch (e) {
      console.error(e);
      showToast(describeFirebaseError(e));
      return false;
    }
  }
  const prev = state.tasks.slice();
  const idx = state.tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) state.tasks[idx] = task; else state.tasks.push(task);
  const ok = saveLocalTasks();
  if (!ok) state.tasks = prev;
  render();
  return ok;
}

async function deleteTaskById(id) {
  if (state.settings.syncMode === "cloud" && state.cloud.ready) {
    try {
      await cloudCollection().doc(id).delete();
    } catch (e) {
      console.error(e);
      showToast(describeFirebaseError(e));
    }
  } else {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    saveLocalTasks();
    render();
  }
}

/* ---------------------------- Cycle logic --------------------------------- */

function intervalLabel(n, unit) {
  n = Number(n) || 1;
  if (unit === "day") return n === 1 ? "毎日" : `${n}日ごと`;
  if (unit === "week") return n === 1 ? "毎週" : `${n}週間ごと`;
  if (unit === "month") return n === 1 ? "毎月" : (n === 6 ? "半年ごと" : `${n}か月ごと`);
  if (unit === "year") return n === 1 ? "毎年" : `${n}年ごと`;
  return "";
}

// 前回やった日と間隔から計算した、本来の次回予定日（前回の記録がなければ今日）
function naturalNext(task) {
  return task.lastDone ? addInterval(task.lastDone, task.interval, task.unit) : todayStr();
}

// 実際の予定日（延期・前倒しの指定を優先）
function dueOf(task) {
  if (task.kind === "once") return task.dueDate || null;
  return task.nextOverride || naturalNext(task);
}

function createdDay(task) {
  return task.createdAt ? ymd(new Date(task.createdAt)) : null;
}

/** { due, daysLeft, status, progress } status: due / soon / ok / nodate / done */
function computeStatus(task) {
  const today = todayStr();
  if (task.kind === "once" && task.done) return { due: task.dueDate, daysLeft: null, status: "done", progress: 1 };
  const due = dueOf(task);
  if (!due) return { due: null, daysLeft: null, status: "nodate", progress: null };
  const daysLeft = diffDays(today, due);
  let status = "ok";
  if (daysLeft <= 0) status = "due";
  else if (daysLeft <= getWarnDays()) status = "soon";

  // サイクルの進み具合（0〜1）：サムネイルのまわりのリングに使う
  let start = task.kind === "once" ? createdDay(task) : task.lastDone;
  let progress = null;
  if (start) {
    const span = diffDays(start, due);
    progress = span > 0 ? Math.max(0, Math.min(1, diffDays(start, today) / span)) : 1;
  } else if (status === "due") {
    progress = 1;
  }
  return { due, daysLeft, status, progress };
}

function statusLabel(st) {
  const d = st.daysLeft;
  if (st.status === "done") return "完了";
  if (st.status === "nodate") return "期限なし";
  if (st.status === "due") return d < 0 ? `${-d}日超過` : "今日";
  if (d === 1) return "明日";
  return `あと${d}日`;
}

function isInToday(task, st) {
  if (st.status === "due" || st.status === "soon") return true;
  return st.status === "nodate" && state.settings.showNoDate;
}

/* ---------------------------- Rendering ----------------------------------- */

const I = () => window.MeguruIcons;

function thumbHtml(task, st) {
  let inner;
  const photo = task.thumbType === "upload" ? safeImageData(task.imageData) : "";
  if (photo) {
    inner = `<button type="button" class="thumb-tile thumb-photo" data-action="photo" data-id="${escapeHtml(task.id)}" aria-label="写真を大きく表示"><img src="${escapeHtml(photo)}" alt=""></button>`;
  } else {
    const c = I().color(task.color);
    inner = `<span class="thumb-tile" style="color:${c.fg};background:${c.bg}" title="${escapeHtml(I().label(task.icon))}">${I().svg(task.icon, 34)}</span>`;
  }
  const p = st.progress === null ? 0 : Math.round(st.progress * 100);
  const ringCls = st.progress === null ? "no-ring" : st.status;
  return `<div class="thumb-ring ${ringCls}" style="--p:${p}">${inner}</div>`;
}

function taskCardHtml(task) {
  const st = computeStatus(task);
  const cardClass = st.status === "due" ? "overdue" : (st.status === "soon" ? "urgent" : "");
  const kindText = task.kind === "repeat"
    ? `<span class="kind-pill repeat">🔁 ${escapeHtml(intervalLabel(task.interval, task.unit))}</span>`
    : `<span class="kind-pill once">📌 1回きり</span>`;
  let meta;
  if (task.kind === "repeat") {
    meta = `前回 ${task.lastDone ? dispDate(task.lastDone) : "未記録"} → 次回 ${dispDate(st.due)}${task.nextOverride ? '<span class="moved">（日付変更）</span>' : ""}`;
  } else {
    meta = st.due ? `期限 ${dispDate(st.due)}` : "期限なし";
  }
  const memoLine = task.memo ? `<div class="item-memo">${escapeHtml(task.memo.split("\n")[0])}</div>` : "";

  return `
  <div class="item-card ${cardClass}" data-id="${escapeHtml(task.id)}">
    <div class="item-card-top">
      ${thumbHtml(task, st)}
      <div class="item-title-wrap">
        <div class="item-name">${escapeHtml(task.name)}</div>
        <div class="tag-row">
          ${kindText}
          ${task.category ? `<span class="item-category">${escapeHtml(task.category)}</span>` : ""}
          ${task.place ? `<span class="item-place">📍${escapeHtml(task.place)}</span>` : ""}
        </div>
      </div>
      <span class="status-badge ${st.status}">${statusLabel(st)}</span>
    </div>
    <div class="item-meta">${meta}</div>
    ${memoLine}
    <div class="item-actions">
      <button class="btn btn-primary" data-action="done" data-id="${escapeHtml(task.id)}">✓ やった</button>
      <button class="btn btn-secondary" data-action="postpone" data-id="${escapeHtml(task.id)}">延期</button>
      <button class="btn btn-secondary" data-action="edit" data-id="${escapeHtml(task.id)}">編集</button>
    </div>
  </div>`;
}

function placeMatches(task) {
  const f = state.settings.placeFilter;
  if (!f) return true;
  if (f === "__none__") return !task.place;
  return task.place === f;
}

function sortByDue(a, b) {
  const ad = a.st.due, bd = b.st.due;
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
  if (ad && !bd) return -1;
  if (!ad && bd) return 1;
  return (a.task.createdAt || 0) - (b.task.createdAt || 0);
}

function render() {
  renderCategorySelects();
  renderPlaceSelects();
  renderChips();
  renderPlaceFilters();

  const active = state.tasks.filter((t) => !(t.kind === "once" && t.done)).map((t) => ({ task: t, st: computeStatus(t) }));

  // 今やること
  const todayAll = active.filter((x) => isInToday(x.task, x.st));
  const rank = { due: 0, soon: 1, nodate: 2 };
  const todayItems = todayAll.filter((x) => placeMatches(x.task)).sort((a, b) => {
    if (rank[a.st.status] !== rank[b.st.status]) return rank[a.st.status] - rank[b.st.status];
    return sortByDue(a, b);
  });
  document.getElementById("todayList").innerHTML = todayItems.map((x) => taskCardHtml(x.task)).join("");
  document.getElementById("todayEmpty").hidden = todayItems.length > 0;
  document.getElementById("todayEmpty").querySelector("p").textContent = todayAll.length && !todayItems.length
    ? "この場所で今やることはありません。" : "今やることはありません。おつかれさまでした。";
  document.getElementById("countToday").textContent = todayAll.length ? String(todayAll.length) : "";

  // 今日やった件数
  const today = todayStr();
  const doneToday = state.tasks.filter((t) => (t.kind === "repeat" && t.lastDone === today) || (t.kind === "once" && t.done && t.doneAt === today)).length;
  const dt = document.getElementById("doneToday");
  dt.hidden = doneToday === 0;
  dt.textContent = `今日やったこと：${doneToday}件`;

  // これから
  const upcoming = active.filter((x) => !isInToday(x.task, x.st) && placeMatches(x.task)).sort(sortByDue);
  const groups = [
    { label: "1週間以内", items: [] },
    { label: "1か月以内", items: [] },
    { label: "それ以降", items: [] },
    { label: "期限なし", items: [] }
  ];
  upcoming.forEach((x) => {
    const d = x.st.daysLeft;
    if (d === null) groups[3].items.push(x);
    else if (d <= 7) groups[0].items.push(x);
    else if (d <= 31) groups[1].items.push(x);
    else groups[2].items.push(x);
  });
  document.getElementById("upcomingGroups").innerHTML = groups.filter((g) => g.items.length).map((g) => `
    <h3 class="group-head">${g.label}<span>${g.items.length}件</span></h3>
    <div class="item-list">${g.items.map((x) => taskCardHtml(x.task)).join("")}</div>
  `).join("");
  document.getElementById("upcomingEmpty").hidden = upcoming.length > 0;

  // すべて
  const search = (document.getElementById("searchBox").value || "").trim().toLowerCase();
  const catFilter = document.getElementById("categoryFilter").value;
  const placeFilter = document.getElementById("placeFilterAll").value;
  const kindFilter = document.getElementById("kindFilter").value;
  let all = active.slice();
  if (search) all = all.filter((x) => (x.task.name + " " + x.task.memo).toLowerCase().includes(search));
  if (catFilter && catFilter !== "__all__") all = all.filter((x) => x.task.category === catFilter);
  if (placeFilter && placeFilter !== "__all__") all = all.filter((x) => placeFilter === "__none__" ? !x.task.place : x.task.place === placeFilter);
  if (kindFilter) all = all.filter((x) => x.task.kind === kindFilter);
  all.sort(sortByDue);
  document.getElementById("allList").innerHTML = all.map((x) => taskCardHtml(x.task)).join("");
  const allEmpty = document.getElementById("allEmpty");
  allEmpty.hidden = all.length > 0;
  allEmpty.querySelector("p").textContent = active.length
    ? "条件に合うTODOはありません。" : "まだTODOが登録されていません。「＋ TODOを追加」から始めましょう。";

  // 完了済み（1回きり）
  const done = state.tasks.filter((t) => t.kind === "once" && t.done)
    .sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || "") || (b.updatedAt - a.updatedAt));
  document.getElementById("doneSection").hidden = done.length === 0;
  document.getElementById("doneCount").textContent = String(done.length);
  document.getElementById("doneList").innerHTML = done.slice(0, 100).map((t) => `
    <div class="done-row">
      <span class="done-name">${escapeHtml(t.name)}</span>
      <span class="done-date">${t.doneAt ? dispDate(t.doneAt) + " 完了" : "完了"}</span>
      <button class="btn btn-secondary btn-small" data-action="undone" data-id="${escapeHtml(t.id)}">戻す</button>
      <button class="btn btn-danger btn-small" data-action="remove" data-id="${escapeHtml(t.id)}">削除</button>
    </div>`).join("");
}

function optionHtml(v, label) {
  return `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`;
}

function renderCategorySelects() {
  const cats = state.settings.categories;
  const sel = document.getElementById("taskCategory");
  if (document.getElementById("taskModalOverlay").hidden) {
    sel.innerHTML = optionHtml("", "（なし）") + cats.map((c) => optionHtml(c, c)).join("");
  }
  const f = document.getElementById("categoryFilter");
  const fv = f.value || "__all__";
  f.innerHTML = optionHtml("__all__", "すべてのカテゴリ") + cats.map((c) => optionHtml(c, c)).join("");
  f.value = cats.includes(fv) ? fv : "__all__";
}

function renderPlaceSelects() {
  const places = state.settings.places || [];
  const f = document.getElementById("placeFilterAll");
  const fv = f.value || "__all__";
  f.innerHTML = optionHtml("__all__", "すべての場所") + places.map((c) => optionHtml(c, c)).join("") + optionHtml("__none__", "場所なし");
  f.value = places.includes(fv) || fv === "__none__" ? fv : "__all__";
}

// 編集画面の選択肢（設定から消した値でも、登録済みなら残す）
function fillModalSelect(id, list, value) {
  const sel = document.getElementById(id);
  const options = value && !list.includes(value) ? [...list, value] : list;
  sel.innerHTML = optionHtml("", "（なし）") + options.map((c) => optionHtml(c, c)).join("");
  sel.value = value || "";
}

function renderPlaceFilters() {
  const places = state.settings.places || [];
  const f = state.settings.placeFilter;
  const valid = !f || f === "__none__" || places.includes(f);
  if (!valid) state.settings.placeFilter = "";
  const cur = state.settings.placeFilter;
  const html = places.length ? [["", "すべて"], ...places.map((p) => [p, p])]
    .map(([v, label]) => `<button type="button" class="pf-chip${cur === v ? " active" : ""}" data-place="${escapeHtml(v)}">${v ? "📍" : ""}${escapeHtml(label)}</button>`)
    .join("") : "";
  document.querySelectorAll("[data-place-filter]").forEach((el) => {
    el.innerHTML = html;
    el.hidden = !places.length;
  });
}

function renderChips() {
  document.getElementById("categoryChips").innerHTML = state.settings.categories.map((c) =>
    `<span class="chip">${escapeHtml(c)}<button data-cat="${escapeHtml(c)}" title="削除" aria-label="${escapeHtml(c)} を削除">✕</button></span>`).join("");
  const places = state.settings.places || [];
  document.getElementById("placeChips").innerHTML = places.length
    ? places.map((c) => `<span class="chip">📍${escapeHtml(c)}<button data-place-del="${escapeHtml(c)}" title="削除" aria-label="${escapeHtml(c)} を削除">✕</button></span>`).join("")
    : `<p class="hint">まだ登録されていません。</p>`;
}

/* ---------------------------- Card actions ---------------------------------- */

function findTask(id) { return state.tasks.find((t) => t.id === id); }

async function markDone(task) {
  const before = { ...task, history: task.history.slice() };
  const today = todayStr();
  let updated;
  if (task.kind === "once") {
    updated = { ...task, done: true, doneAt: today, updatedAt: Date.now() };
  } else {
    let history = task.history.slice();
    if (task.lastDone && task.lastDone !== today && !history.includes(task.lastDone)) history.push(task.lastDone);
    history = history.sort().slice(-10);
    updated = { ...task, lastDone: today, nextOverride: null, history, updatedAt: Date.now() };
  }
  if (await upsertTask(updated)) {
    const msg = task.kind === "once"
      ? `「${task.name}」を完了しました`
      : `「${task.name}」次回は ${dispDate(naturalNext(updated))}`;
    showToast(msg, async () => {
      before.updatedAt = Date.now();
      if (await upsertTask(before)) showToast("元に戻しました");
    });
  }
}

let postponeId = null;

function openPostpone(task) {
  postponeId = task.id;
  const st = computeStatus(task);
  document.getElementById("postponeTarget").textContent =
    `「${task.name}」 いまの予定日：${st.due ? dispDate(st.due) : "なし"}`;
  document.getElementById("postponeDate").value = addDaysStr(todayStr(), 1);
  document.getElementById("postponeOverlay").hidden = false;
}

function closePostpone() {
  document.getElementById("postponeOverlay").hidden = true;
  postponeId = null;
}

async function applyPostpone(dateStr) {
  const task = findTask(postponeId);
  if (!task || !cleanDate(dateStr)) return;
  const updated = task.kind === "once"
    ? { ...task, dueDate: dateStr, updatedAt: Date.now() }
    : { ...task, nextOverride: dateStr === naturalNext(task) ? null : dateStr, updatedAt: Date.now() };
  closePostpone();
  if (await upsertTask(updated)) showToast(`「${task.name}」を ${dispDate(dateStr)} にしました`);
}

function nextSaturday() {
  const d = new Date();
  const add = ((6 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  return ymd(d);
}

function handleListClick(e) {
  const btn = e.target.closest("[data-action]");
  const card = e.target.closest(".item-card");
  if (btn) {
    e.stopPropagation();
    const task = findTask(btn.getAttribute("data-id"));
    if (!task) return;
    const action = btn.getAttribute("data-action");
    if (action === "done") markDone(task);
    else if (action === "postpone") openPostpone(task);
    else if (action === "edit") openEditModal(task.id);
    else if (action === "photo") openPhotoViewer(task);
    else if (action === "undone") {
      upsertTask({ ...task, done: false, doneAt: null, updatedAt: Date.now() }).then((ok) => ok && showToast("未完了に戻しました"));
    } else if (action === "remove") {
      if (confirm(`「${task.name}」を削除しますか？`)) deleteTaskById(task.id).then(() => showToast("削除しました"));
    }
    return;
  }
  if (card) openEditModal(card.getAttribute("data-id"));
}

/* ---------------------------- Tabs ----------------------------------------- */

const TABS = ["today", "upcoming", "all", "settings"];

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  TABS.forEach((t) => { document.getElementById("panel-" + t).hidden = t !== tab; });
  window.scrollTo(0, 0);
}

/* ---------------------------- Modal ----------------------------------------- */

// 編集中のサムネイル（保存を押すまでTODOには反映しない）
const modal = { thumbType: "icon", icon: "check", color: "indigo", imageData: "", iconTouched: false, history: [] };

// 名前からアイコンを自動で選ぶ（新規追加で、まだ自分でアイコンを選んでいないときだけ）
const ICON_KEYWORDS = [
  [/エアコン|フィルター|換気扇/, "aircon"], [/洗濯|シーツ|布団/, "laundry"], [/ゴミ|ごみ|資源/, "trash"],
  [/掃除|そうじ|拭き|ワックス|片付/, "broom"], [/風呂|浴室|排水/, "bath"], [/料理|作り置き|冷蔵庫|キッチン/, "pot"],
  [/水やり|植物|観葉|花/, "plant"], [/ペット|犬|猫|散歩|トリミング/, "paw"], [/薬|くすり|サプリ/, "pill"],
  [/病院|健診|検診|歯医者|歯科|通院/, "cross"], [/運動|ジム|筋トレ|ランニング|ストレッチ/, "dumbbell"],
  [/散髪|美容院|床屋|カット|爪/, "scissors"], [/本|読書|勉強|資格/, "book"], [/誕生日|記念日|プレゼント|お中元|お歳暮/, "gift"],
  [/会議|1on1|面談|打合せ|打ち合わせ/, "people"], [/メール|返信/, "mail"], [/電話|スマホ/, "phone"],
  [/報告|レポート|集計|KPI/, "chart"], [/書類|資料|契約|議事録/, "doc"], [/パスワード|鍵|カギ|証明書/, "key"],
  [/バックアップ|クラウド/, "cloud"], [/セキュリティ|パッチ|脆弱性|ウイルス|監査/, "shield"],
  [/アップデート|更新|入れ替え/, "refresh"], [/パソコン|PC|サーバ/, "laptop"],
  [/支払|払い|振込|家賃|税|請求|精算/, "yen"], [/カード/, "card"], [/申請|手続|届出|提出/, "stamp"],
  [/車検|洗車|タイヤ|車/, "car"], [/バイク/, "bike"], [/自転車/, "bicycle"], [/給油|オイル|ガソリン/, "fuel"],
  [/旅行|出張|帰省/, "plane"], [/電池|充電/, "battery"], [/電球|照明/, "bulb"], [/修理|点検|メンテ/, "wrench"],
  [/衣替え|服|クリーニング/, "shirt"], [/買い物|購入|買う/, "cart"], [/予約|予定/, "calendar"]
];

function guessIcon(name) {
  for (const [re, key] of ICON_KEYWORDS) if (re.test(name)) return key;
  return null;
}

function renderIconPicker() {
  const box = document.getElementById("iconPicker");
  box.innerHTML = I().groups.map((g) => `
    <div class="ip-group">
      <div class="ip-label">${escapeHtml(g.label)}</div>
      <div class="ip-grid">
        ${g.icons.map(([key, label]) => `<button type="button" class="ip-btn${modal.icon === key ? " active" : ""}" data-icon="${key}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" aria-pressed="${modal.icon === key}">${I().svg(key, 24)}</button>`).join("")}
      </div>
    </div>`).join("");
}

function renderColorRow() {
  document.getElementById("colorRow").innerHTML = I().colors.map(([key, fg, bg]) =>
    `<button type="button" class="color-swatch${modal.color === key ? " active" : ""}" data-color="${key}" style="--fg:${fg};--bg:${bg}" aria-label="色：${key}" aria-pressed="${modal.color === key}"></button>`).join("");
}

function renderThumbPreview() {
  const box = document.getElementById("thumbPreview");
  const isPhoto = modal.thumbType === "upload";
  const photo = safeImageData(modal.imageData);
  if (isPhoto && photo) {
    box.innerHTML = `<img src="${escapeHtml(photo)}" alt="">`;
    box.style.color = ""; box.style.background = "";
  } else if (isPhoto) {
    box.innerHTML = `<span class="thumb-empty">写真<br>未選択</span>`;
    box.style.color = ""; box.style.background = "";
  } else {
    const c = I().color(modal.color);
    box.innerHTML = I().svg(modal.icon, 40);
    box.style.color = c.fg;
    box.style.background = c.bg;
  }
}

function applyThumbUI() {
  document.querySelectorAll('input[name="thumbType"]').forEach((r) => { r.checked = r.value === modal.thumbType; });
  const isPhoto = modal.thumbType === "upload";
  document.getElementById("iconPickerBox").hidden = isPhoto;
  document.getElementById("colorRow").hidden = isPhoto;
  document.getElementById("imageUploadBox").hidden = !isPhoto;
  document.getElementById("btnClearPhoto").hidden = !modal.imageData;
  document.getElementById("btnPickPhoto").textContent = modal.imageData ? "写真を撮り直す／選び直す" : "写真を撮る／選ぶ";
  renderIconPicker();
  renderColorRow();
  renderThumbPreview();
}

function compressImage(file, maxSide = 480) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        let quality = 0.8;
        let data = canvas.toDataURL("image/jpeg", quality);
        while (data.length > 120000 && quality > 0.45) {
          quality -= 0.1;
          data = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(data);
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("decode-failed")); };
    img.src = objectUrl;
  });
}

async function handlePhotoSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const btn = document.getElementById("btnPickPhoto");
  btn.disabled = true;
  btn.textContent = "写真を読み込み中...";
  try {
    modal.imageData = await compressImage(file);
  } catch (err) {
    console.error(err);
    showToast("この写真は読み込めませんでした。JPEG や PNG の写真を選んでください");
  }
  btn.disabled = false;
  applyThumbUI();
}

function openPhotoViewer(task) {
  const photo = safeImageData(task.imageData);
  if (!photo) return;
  document.getElementById("photoViewerImg").src = photo;
  document.getElementById("photoViewerCaption").textContent = task.name || "";
  document.getElementById("photoViewer").hidden = false;
}

function closePhotoViewer() {
  document.getElementById("photoViewer").hidden = true;
  document.getElementById("photoViewerImg").src = "";
}

/* ---------- 種類・間隔・次回予定日・履歴（登録／編集画面） ---------- */

function checkedKind() {
  const r = document.querySelector('input[name="taskKind"]:checked');
  return r ? r.value : "repeat";
}

function applyKindUI() {
  const once = checkedKind() === "once";
  document.getElementById("repeatBox").hidden = once;
  document.getElementById("onceBox").hidden = !once;
  updateNextAuto();
}

function modalIntervalValues() {
  const n = Math.max(1, Math.min(999, Math.round(Number(document.getElementById("taskInterval").value)) || 1));
  const u = document.getElementById("taskUnit").value;
  return { n, u: UNITS.includes(u) ? u : "week" };
}

function updatePresetActive() {
  const { n, u } = modalIntervalValues();
  document.querySelectorAll("#presetRow .preset").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.v) === n && b.dataset.u === u);
  });
}

function updateNextAuto() {
  const el = document.getElementById("nextAutoText");
  const last = document.getElementById("taskLastDone").value;
  const { n, u } = modalIntervalValues();
  const override = document.getElementById("useNextOverride").checked;
  const overrideInput = document.getElementById("taskNextOverride");
  overrideInput.hidden = !override;
  const auto = cleanDate(last) ? addInterval(last, n, u) : todayStr();
  const base = cleanDate(last)
    ? `自動計算：${dispDate(auto)}（前回 ${dispDate(last)} の${afterLabel(n, u)}）`
    : "前回の記録がないので、今日から「今やること」に表示します。";
  el.textContent = override ? base + " ※下の日付を優先します" : base;
  if (override && !overrideInput.value) overrideInput.value = auto;
  updatePresetActive();
}

function afterLabel(n, u) {
  if (u === "week") return `${n}週間後`;
  if (u === "month") return `${n}か月後`;
  if (u === "year") return `${n}年後`;
  return `${n}日後`;
}

function visibleHistory(lastDone) {
  const uniq = Array.from(new Set(modal.history.filter(Boolean)));
  return uniq.filter((d) => d !== lastDone).sort().reverse().slice(0, 4);
}

function averageInterval(lastDone, history) {
  const dates = Array.from(new Set([...history, lastDone].filter(Boolean))).sort();
  if (dates.length < 2) return null;
  const span = diffDays(dates[0], dates[dates.length - 1]);
  if (span <= 0) return null;
  return { avg: span / (dates.length - 1), count: dates.length };
}

function renderHistory() {
  const last = document.getElementById("taskLastDone").value;
  const hist = visibleHistory(last);
  const list = document.getElementById("historyList");
  list.innerHTML = hist.map((d) => `
    <li class="history-chip"><span>${escapeHtml(dispDate(d))}</span><button type="button" data-date="${escapeHtml(d)}" title="この記録を削除" aria-label="${escapeHtml(d)} の記録を削除">✕</button></li>
  `).join("");
  document.getElementById("historyEmpty").hidden = hist.length > 0;

  const avgText = document.getElementById("avgText");
  const btn = document.getElementById("btnApplyAvg");
  const avg = averageInterval(last, hist);
  if (!avg) {
    avgText.textContent = "実際の平均間隔：2回分以上の記録がそろうと計算します";
    btn.hidden = true;
    btn.dataset.days = "";
  } else {
    const shown = Math.round(avg.avg * 10) / 10;
    const applied = Math.max(1, Math.ceil(avg.avg));
    avgText.textContent = `実際の平均間隔：約${shown}日（${avg.count}回分から計算）`;
    btn.hidden = false;
    btn.textContent = `間隔に反映（${applied}日ごと）`;
    btn.dataset.days = String(applied);
  }
}

function applyAverage() {
  const days = Number(document.getElementById("btnApplyAvg").dataset.days);
  if (!days) return;
  // 7の倍数なら「週ごと」で入れる
  if (days % 7 === 0) {
    document.getElementById("taskInterval").value = days / 7;
    document.getElementById("taskUnit").value = "week";
  } else {
    document.getElementById("taskInterval").value = days;
    document.getElementById("taskUnit").value = "day";
  }
  updateNextAuto();
  showToast(`間隔を${intervalLabel(Number(document.getElementById("taskInterval").value), document.getElementById("taskUnit").value)}にしました（保存で確定）`);
}

function setKind(kind) {
  document.querySelectorAll('input[name="taskKind"]').forEach((r) => { r.checked = r.value === kind; });
  applyKindUI();
}

function openAddModal() {
  document.getElementById("modalTitle").textContent = "TODOを追加";
  document.getElementById("taskForm").reset();
  document.getElementById("taskId").value = "";
  document.getElementById("btnDeleteTask").hidden = true;
  document.getElementById("taskInterval").value = 1;
  document.getElementById("taskUnit").value = "week";
  document.getElementById("taskLastDone").value = "";
  document.getElementById("useNextOverride").checked = false;
  document.getElementById("taskNextOverride").value = "";
  document.getElementById("taskDue").value = "";
  Object.assign(modal, { thumbType: "icon", icon: "check", color: "indigo", imageData: "", iconTouched: false, history: [] });
  fillModalSelect("taskCategory", state.settings.categories, "");
  // 場所で絞り込み中なら、その場所を初期値にする
  const pf = state.settings.placeFilter;
  fillModalSelect("taskPlace", state.settings.places, pf && pf !== "__none__" && state.activeTab !== "all" ? pf : "");
  setKind("repeat");
  applyThumbUI();
  renderHistory();
  document.getElementById("taskModalOverlay").hidden = false;
  setTimeout(() => document.getElementById("taskName").focus(), 50);
}

function openEditModal(id) {
  const task = findTask(id);
  if (!task) return;
  document.getElementById("modalTitle").textContent = "TODOを編集";
  document.getElementById("taskId").value = task.id;
  document.getElementById("taskName").value = task.name || "";
  document.getElementById("taskInterval").value = task.interval;
  document.getElementById("taskUnit").value = task.unit;
  document.getElementById("taskLastDone").value = task.lastDone || "";
  document.getElementById("useNextOverride").checked = !!task.nextOverride;
  document.getElementById("taskNextOverride").value = task.nextOverride || "";
  document.getElementById("taskDue").value = task.dueDate || "";
  document.getElementById("taskMemo").value = task.memo || "";
  fillModalSelect("taskCategory", state.settings.categories, task.category || "");
  fillModalSelect("taskPlace", state.settings.places, task.place || "");
  document.getElementById("btnDeleteTask").hidden = false;
  Object.assign(modal, {
    thumbType: task.thumbType, icon: task.icon, color: task.color,
    imageData: task.imageData || "", iconTouched: true, history: task.history.slice()
  });
  setKind(task.kind);
  applyThumbUI();
  renderHistory();
  document.getElementById("taskModalOverlay").hidden = false;
}

function closeModal() {
  document.getElementById("taskModalOverlay").hidden = true;
  render();
}

async function handleTaskFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("taskId").value || uid();
  const existing = findTask(id);
  const name = document.getElementById("taskName").value.trim().slice(0, 100);
  if (!name) return;
  const kind = checkedKind();
  const { n, u } = modalIntervalValues();
  const lastDone = cleanDate(document.getElementById("taskLastDone").value);
  const useOverride = document.getElementById("useNextOverride").checked;
  const overrideVal = cleanDate(document.getElementById("taskNextOverride").value);

  if (modal.thumbType === "upload" && !safeImageData(modal.imageData)) {
    showToast("写真が選ばれていないので、アイコンで保存しました");
    modal.thumbType = "icon";
  }

  const task = {
    id,
    name,
    kind,
    interval: n,
    unit: u,
    lastDone,
    nextOverride: kind === "repeat" && useOverride ? overrideVal : null,
    dueDate: kind === "once" ? cleanDate(document.getElementById("taskDue").value) : null,
    done: kind === "once" && existing ? !!existing.done : false,
    doneAt: kind === "once" && existing ? existing.doneAt : null,
    thumbType: modal.thumbType,
    icon: modal.icon,
    color: modal.color,
    imageData: modal.thumbType === "upload" ? safeImageData(modal.imageData) : "",
    category: cleanStr(document.getElementById("taskCategory").value, 50),
    place: cleanStr(document.getElementById("taskPlace").value, 50).trim(),
    memo: document.getElementById("taskMemo").value.trim().slice(0, 500),
    history: Array.from(new Set(modal.history.filter((d) => d && d !== lastDone))).sort().slice(-10),
    createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  };
  if (task.nextOverride && task.nextOverride === (lastDone ? addInterval(lastDone, n, u) : null)) task.nextOverride = null;

  if (!(await upsertTask(task))) return;
  document.getElementById("taskModalOverlay").hidden = true;
  render();
  showToast("保存しました");
}

async function handleDeleteTask() {
  const id = document.getElementById("taskId").value;
  if (!id) return;
  if (!confirm("このTODOを削除しますか？")) return;
  await deleteTaskById(id);
  closeModal();
  showToast("削除しました");
}

/* ---------------------------- リマインド（カレンダー登録） -------------------- */

const REMINDER_TITLE = "MEGURU：今日のやることチェック";

function nextReminderStart(timeStr) {
  const [h, m] = String(timeStr || "08:00").split(":").map((x) => Number(x) || 0);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (start <= now) start.setDate(start.getDate() + 1);
  return start;
}

function fmtLocalDateTime(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
}

function appTodayUrl() {
  return location.href.split("#")[0] + "#tab=today";
}

function googleCalendarUrl(timeStr) {
  const start = nextReminderStart(timeStr);
  const end = new Date(start.getTime() + 15 * 60000);
  let tz = "Asia/Tokyo";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) { /* 既定のまま */ }
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: REMINDER_TITLE,
    dates: `${fmtLocalDateTime(start)}/${fmtLocalDateTime(end)}`,
    ctz: tz,
    recur: "RRULE:FREQ=DAILY",
    details: `「今やること」を確認しましょう。\n${appTodayUrl()}`
  });
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

function icsEscape(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsFold(line) {
  const enc = new TextEncoder();
  let out = "";
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > 75) {
      out += cur + "\r\n ";
      cur = "";
      len = 1;
    }
    cur += ch;
    len += n;
  }
  return out + cur;
}

function buildReminderIcs(timeStr) {
  const start = nextReminderStart(timeStr);
  const end = new Date(start.getTime() + 15 * 60000);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const url = appTodayUrl();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MEGURU//Reminder//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid()}@meguru`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmtLocalDateTime(start)}`,
    `DTEND:${fmtLocalDateTime(end)}`,
    "RRULE:FREQ=DAILY",
    `SUMMARY:${icsEscape(REMINDER_TITLE)}`,
    `DESCRIPTION:${icsEscape("「今やること」を確認しましょう。\n" + url)}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(REMINDER_TITLE)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function initReminderUI() {
  const input = document.getElementById("remindTime");
  input.value = state.settings.remindTime || "08:00";
  input.addEventListener("change", () => {
    state.settings.remindTime = input.value || "08:00";
    saveSettings();
  });
  document.getElementById("btnGoogleCal").addEventListener("click", () => {
    window.open(googleCalendarUrl(input.value), "_blank", "noopener");
  });
  document.getElementById("btnIcs").addEventListener("click", () => {
    downloadBlob(new Blob([buildReminderIcs(input.value)], { type: "text/calendar;charset=utf-8" }), "meguru-reminder.ics");
    showToast("カレンダー用ファイルを作りました。開いてカレンダーに追加してください");
  });
}

function handleTabHash() {
  if (!location.hash.startsWith("#tab=")) return;
  const tab = decodeURIComponent(location.hash.slice(5));
  history.replaceState(null, "", location.href.split("#")[0]);
  if (TABS.includes(tab)) switchTab(tab);
}

/* ---------------------------- Settings UI ----------------------------------- */

function showConnectResult(kind, message) {
  const el = document.getElementById("connectResult");
  el.hidden = !message;
  el.className = "connect-result" + (kind ? " " + kind : "");
  el.textContent = message || "";
}

function hideSharePanel() {
  document.getElementById("sharePanel").hidden = true;
  document.getElementById("qrBox").innerHTML = "";
  document.getElementById("setupLinkOutput").value = "";
  document.getElementById("btnShowShare").hidden = false;
}

function updateShareCard() {
  const connected = state.settings.syncMode === "cloud" && state.cloud.ready;
  document.getElementById("shareCard").hidden = !connected;
  if (!connected) hideSharePanel();
}

async function connectWith(cfg, code, button, options = {}) {
  if (button) button.disabled = true;
  showConnectResult(null, "接続中です...");
  const prev = { ...state.settings };
  state.settings.firebaseConfig = cfg;
  state.settings.syncCode = code;

  const result = await connectCloud({ offerMigration: !!options.offerMigration });
  if (button) button.disabled = false;

  if (result.ok) {
    state.settings.syncMode = "cloud";
    saveSettings();
    document.getElementById("modeCloud").checked = true;
    document.getElementById("cloudSettings").hidden = false;
    document.getElementById("firebaseConfig").value = JSON.stringify(cfg, null, 2);
    document.getElementById("syncCode").value = code;
    let msg = `接続しました。共有コード「${code}」でクラウド同期中です。\n他の端末を追加するときは、下の「他の端末を追加する」から接続用リンクやQRコードを使えます。`;
    if (!result.sharedOk) msg += "\n" + RULES_UPDATE_NOTE;
    showConnectResult("ok", msg);
  } else {
    state.settings = prev;
    saveSettings();
    if (prev.syncMode === "cloud" && prev.firebaseConfig && prev.syncCode) {
      await connectCloud();
    } else {
      setSyncStatus("off", "この端末のみ");
      loadLocalTasks();
      render();
    }
    showConnectResult("error", result.message);
  }
  updateShareCard();
  return result;
}

async function handleSetupLinkOnLoad(hash) {
  const setup = parseSetupLink(hash);
  if (!setup) {
    showToast("接続用リンクを読み取れませんでした");
    return;
  }
  const cur = state.settings;
  if (cur.syncMode === "cloud" && state.cloud.ready && cur.syncCode === setup.code &&
      cur.firebaseConfig && cur.firebaseConfig.projectId === setup.config.projectId) {
    showToast("この端末はすでに同期中です");
    return;
  }
  const switching = cur.syncMode === "cloud" && cur.firebaseConfig &&
    (cur.syncCode !== setup.code || cur.firebaseConfig.projectId !== setup.config.projectId);
  const ok = confirm(
    "この端末をクラウド同期に接続しますか？\n\n" +
    `Firebaseプロジェクト：${setup.config.projectId}\n共有コード：${setup.code}\n\n` +
    (switching ? `【注意】いま同期中の場所（共有コード「${cur.syncCode}」）から切り替わります。\n\n` : "") +
    "心当たりのないリンクの場合は「キャンセル」を押してください。"
  );
  if (!ok) return;
  switchTab("settings");
  document.getElementById("modeCloud").checked = true;
  document.getElementById("cloudSettings").hidden = false;
  await connectWith(setup.config, setup.code, null);
}

function initSettingsUI() {
  document.getElementById("modeLocal").checked = state.settings.syncMode === "local";
  document.getElementById("modeCloud").checked = state.settings.syncMode === "cloud";
  document.getElementById("cloudSettings").hidden = state.settings.syncMode !== "cloud";
  document.getElementById("firebaseConfig").value = state.settings.firebaseConfig
    ? JSON.stringify(state.settings.firebaseConfig, null, 2) : "";
  document.getElementById("syncCode").value = state.settings.syncCode || "";
  document.getElementById("warnDays").value = state.settings.warnDays;
  document.getElementById("showNoDate").checked = !!state.settings.showNoDate;

  document.querySelectorAll('input[name="syncMode"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      document.getElementById("cloudSettings").hidden = r.value !== "cloud";
      if (r.value === "local") {
        state.settings.syncMode = "local";
        saveSettings();
        stopCloud();
        loadLocalTasks();
        setSyncStatus("off", "この端末のみ");
        showConnectResult(null, "");
        updateShareCard();
        render();
      }
    });
  });

  document.getElementById("btnGenCode").addEventListener("click", () => {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const body = Array.from(bytes, (b) => chars[b % chars.length]).join("");
    document.getElementById("syncCode").value = `meguru-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
  });

  document.getElementById("btnConnect").addEventListener("click", async () => {
    const cfg = parseFirebaseConfig(document.getElementById("firebaseConfig").value);
    const code = document.getElementById("syncCode").value.trim();
    if (!cfg) {
      showConnectResult("error", "Firebaseの設定を読み取れませんでした。Firebaseコンソールに表示された「const firebaseConfig = { ... };」の部分をそのまま貼り付けてください。");
      return;
    }
    const missing = missingConfigKeys(cfg);
    if (missing.length) {
      showConnectResult("error", `Firebaseの設定に次の項目が見つかりません：${missing.join("、")}\n「{」から「}」まで全部コピーできているか確認してください。`);
      return;
    }
    if (!code) {
      showConnectResult("error", "共有コードを入力してください（「コード生成」ボタンで作れます）。");
      return;
    }
    if (!isValidSyncCode(code)) {
      showConnectResult("error", "共有コードは「/」や空白を含まない4文字以上にしてください（「コード生成」ボタンで作るのがおすすめです）。");
      return;
    }
    if (!isPlausibleFirebaseConfig(cfg)) {
      showConnectResult("error", "Firebaseの設定の中身が正しくないようです。Firebaseコンソールからもう一度コピーしてください。");
      return;
    }
    await connectWith(cfg, code, document.getElementById("btnConnect"), { offerMigration: true });
  });

  document.getElementById("btnQuickConnect").addEventListener("click", async () => {
    const input = document.getElementById("setupLinkInput");
    const setup = parseSetupLink(input.value);
    if (!setup) {
      showConnectResult("error", "接続用リンクを読み取れませんでした。同期済みの端末で「リンクをコピー」したものを、最後まで全部貼り付けてください。");
      return;
    }
    const result = await connectWith(setup.config, setup.code, document.getElementById("btnQuickConnect"));
    if (result.ok) input.value = "";
  });

  document.getElementById("btnShowShare").addEventListener("click", () => {
    const link = buildSetupLink();
    document.getElementById("setupLinkOutput").value = link;
    const box = document.getElementById("qrBox");
    try {
      box.innerHTML = window.QRMini.toSvg(link, { ecl: "M", border: 4 });
    } catch (e) {
      console.error(e);
      box.innerHTML = '<p class="qr-error">QRコードを作れませんでした。下のリンクをコピーして使ってください。</p>';
    }
    document.getElementById("sharePanel").hidden = false;
    document.getElementById("btnShowShare").hidden = true;
  });

  document.getElementById("btnHideShare").addEventListener("click", hideSharePanel);

  document.getElementById("btnCopyLink").addEventListener("click", async () => {
    const out = document.getElementById("setupLinkOutput");
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(out.value);
        copied = true;
      }
    } catch (e) { /* 下の方法で試す */ }
    if (!copied) {
      out.focus();
      out.select();
      try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
    }
    showToast(copied ? "リンクをコピーしました" : "コピーできませんでした。リンクを長押しして選択・コピーしてください");
  });

  const addToList = (inputId, key, label) => {
    const input = document.getElementById(inputId);
    const val = cleanStr(input.value, 50).trim();
    if (!val) return;
    const list = state.settings[key] || [];
    if (list.length >= 50) { showToast(`${label}は50件まで登録できます`); return; }
    if (!list.includes(val)) {
      state.settings[key] = [...list, val];
      saveSharedSettings();
      render();
    }
    input.value = "";
  };
  document.getElementById("btnAddCategory").addEventListener("click", () => addToList("newCategory", "categories", "カテゴリ"));
  document.getElementById("newCategory").addEventListener("keydown", (e) => { if (e.key === "Enter") addToList("newCategory", "categories", "カテゴリ"); });
  document.getElementById("btnAddPlace").addEventListener("click", () => addToList("newPlace", "places", "場所"));
  document.getElementById("newPlace").addEventListener("keydown", (e) => { if (e.key === "Enter") addToList("newPlace", "places", "場所"); });

  document.getElementById("categoryChips").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-cat]");
    if (!btn) return;
    if (state.settings.categories.length <= 1) { showToast("カテゴリは1つ以上必要です"); return; }
    const cat = btn.getAttribute("data-cat");
    state.settings.categories = state.settings.categories.filter((c) => c !== cat);
    saveSharedSettings();
    render();
  });
  document.getElementById("placeChips").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-place-del]");
    if (!btn) return;
    const name = btn.getAttribute("data-place-del");
    state.settings.places = (state.settings.places || []).filter((c) => c !== name);
    saveSharedSettings();
    render();
  });

  document.getElementById("warnDays").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    state.settings.warnDays = Number.isFinite(v) && v >= 0 ? Math.min(v, 365) : 2;
    saveSharedSettings();
    render();
  });
  document.getElementById("showNoDate").addEventListener("change", (e) => {
    state.settings.showNoDate = e.target.checked;
    saveSharedSettings();
    render();
  });

  document.getElementById("btnExport").addEventListener("click", () => {
    const data = { app: "meguru", version: APP_VERSION, tasks: state.tasks, categories: state.settings.categories, places: state.settings.places };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `meguru-export-${todayStr()}.json`);
  });

  document.getElementById("btnImport").addEventListener("click", () => document.getElementById("importFile").click());

  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        showToast("ファイルが大きすぎます（30MBまで）");
        e.target.value = "";
        return;
      }
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.tasks)) {
        showToast("MEGURUのデータファイルではないようです");
      } else {
        const tasks = sanitizeTasks(data.tasks.slice(0, MAX_IMPORT_ITEMS), false);
        // カテゴリ・場所は、いまの一覧に無いものだけ足す
        const addMissing = (key, incoming) => {
          const list = sanitizeNameList(incoming, [], true);
          const merged = state.settings[key].concat(list.filter((x) => !state.settings[key].includes(x))).slice(0, 50);
          state.settings[key] = merged;
        };
        addMissing("categories", data.categories);
        addMissing("places", data.places);
        saveSharedSettings();
        let ok = 0;
        for (const t of tasks) {
          if (await upsertTask(t)) ok++;
        }
        render();
        showToast(`${ok}件のTODOを取り込みました`);
      }
    } catch (err) {
      console.error(err);
      showToast("インポートに失敗しました");
    }
    e.target.value = "";
  });
}

/* ---------------------------- Init ----------------------------------------- */

function initGeneralUI() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll("[data-open-add]").forEach((b) => b.addEventListener("click", openAddModal));

  ["todayList", "upcomingGroups", "allList", "doneList"].forEach((id) => {
    document.getElementById(id).addEventListener("click", handleListClick);
  });

  document.querySelectorAll("[data-place-filter]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-place]");
      if (!b) return;
      state.settings.placeFilter = b.getAttribute("data-place");
      saveSettings();
      render();
    });
  });

  // 登録・編集画面
  document.getElementById("btnCloseModal").addEventListener("click", closeModal);
  document.getElementById("btnCancelTask").addEventListener("click", closeModal);
  document.getElementById("taskModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "taskModalOverlay") closeModal();
  });
  document.getElementById("taskForm").addEventListener("submit", handleTaskFormSubmit);
  document.getElementById("btnDeleteTask").addEventListener("click", handleDeleteTask);

  document.querySelectorAll('input[name="thumbType"]').forEach((r) => r.addEventListener("change", () => {
    modal.thumbType = r.value;
    applyThumbUI();
    if (r.value === "upload" && !modal.imageData) document.getElementById("taskImageFile").click();
  }));
  document.getElementById("iconPicker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-icon]");
    if (!b) return;
    modal.icon = b.getAttribute("data-icon");
    modal.iconTouched = true;
    applyThumbUI();
  });
  document.getElementById("colorRow").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    modal.color = b.getAttribute("data-color");
    applyThumbUI();
  });
  document.getElementById("taskName").addEventListener("input", (e) => {
    if (modal.iconTouched) return;
    const g = guessIcon(e.target.value);
    const next = g || "check";
    if (next !== modal.icon) { modal.icon = next; if (modal.thumbType === "icon") applyThumbUI(); }
  });
  document.getElementById("btnPickPhoto").addEventListener("click", () => document.getElementById("taskImageFile").click());
  document.getElementById("taskImageFile").addEventListener("change", handlePhotoSelected);
  document.getElementById("btnClearPhoto").addEventListener("click", () => { modal.imageData = ""; applyThumbUI(); });

  document.querySelectorAll('input[name="taskKind"]').forEach((r) => r.addEventListener("change", applyKindUI));
  document.getElementById("presetRow").addEventListener("click", (e) => {
    const b = e.target.closest(".preset");
    if (!b) return;
    document.getElementById("taskInterval").value = b.dataset.v;
    document.getElementById("taskUnit").value = b.dataset.u;
    updateNextAuto();
  });
  ["input", "change"].forEach((ev) => {
    document.getElementById("taskInterval").addEventListener(ev, updateNextAuto);
    document.getElementById("taskUnit").addEventListener(ev, updateNextAuto);
    document.getElementById("taskLastDone").addEventListener(ev, () => { renderHistory(); updateNextAuto(); });
  });
  document.getElementById("useNextOverride").addEventListener("change", updateNextAuto);
  document.getElementById("historyList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-date]");
    if (!b) return;
    const d = b.getAttribute("data-date");
    modal.history = modal.history.filter((x) => x !== d);
    renderHistory();
  });
  document.getElementById("btnApplyAvg").addEventListener("click", applyAverage);

  // 延期
  document.getElementById("btnClosePostpone").addEventListener("click", closePostpone);
  document.getElementById("postponeOverlay").addEventListener("click", (e) => {
    if (e.target.id === "postponeOverlay") { closePostpone(); return; }
    const b = e.target.closest("[data-postpone]");
    if (!b) return;
    const v = b.getAttribute("data-postpone");
    applyPostpone(v === "weekend" ? nextSaturday() : addDaysStr(todayStr(), Number(v)));
  });
  document.getElementById("btnPostponeDate").addEventListener("click", () => {
    applyPostpone(document.getElementById("postponeDate").value);
  });

  // 写真の拡大表示・トースト
  document.getElementById("photoViewer").addEventListener("click", closePhotoViewer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closePhotoViewer();
    if (!document.getElementById("postponeOverlay").hidden) closePostpone();
    else if (!document.getElementById("taskModalOverlay").hidden) closeModal();
  });
  document.getElementById("toastAction").addEventListener("click", () => {
    const fn = toastUndo;
    toastUndo = null;
    document.getElementById("toast").hidden = true;
    if (fn) fn();
  });

  document.getElementById("searchBox").addEventListener("input", render);
  ["categoryFilter", "placeFilterAll", "kindFilter"].forEach((id) => document.getElementById(id).addEventListener("change", render));

  // 日付が変わったあとにアプリへ戻ってきたとき、表示を今日に合わせる
  let lastDay = todayStr();
  const refreshIfNewDay = () => {
    if (todayStr() !== lastDay) { lastDay = todayStr(); render(); }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshIfNewDay(); });
  setInterval(refreshIfNewDay, 60000);
}

async function init() {
  let setupHash = null;
  if (location.hash.includes(SETUP_PARAM)) {
    setupHash = location.hash;
    history.replaceState(null, "", location.href.split("#")[0]);
  }

  loadSettings();
  initGeneralUI();
  initSettingsUI();
  document.getElementById("appVersion").textContent = APP_VERSION;
  initReminderUI();

  if (state.settings.syncMode === "cloud" && state.settings.firebaseConfig && state.settings.syncCode) {
    setSyncStatus("off", "接続中...");
    render();
    const result = await connectCloud();
    if (!result.ok) showToast(result.message);
    else if (!result.sharedOk) {
      showToast("カテゴリ・場所の同期には、Firestoreのルールの更新が必要です（設定タブ参照）");
      showConnectResult("error", RULES_UPDATE_NOTE);
    }
  } else {
    state.settings.syncMode = "local";
    loadLocalTasks();
    setSyncStatus("off", "この端末のみ");
  }

  render();
  updateShareCard();

  if (setupHash) await handleSetupLinkOnLoad(setupHash);
  handleTabHash();

  window.addEventListener("hashchange", () => {
    if (location.hash.startsWith("#tab=")) { handleTabHash(); return; }
    if (!location.hash.includes(SETUP_PARAM)) return;
    const hash = location.hash;
    history.replaceState(null, "", location.href.split("#")[0]);
    handleSetupLinkOnLoad(hash);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW登録失敗", e));
  }
}

document.addEventListener("DOMContentLoaded", init);
