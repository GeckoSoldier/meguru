/* ==========================================================================
   icons.js - TODOのサムネイル用ピクトグラム（このアプリ用に描いた線画アイコン）
   すべて 24×24 の座標で、線の色は currentColor。
   ========================================================================== */
(function (global) {
  "use strict";

  const GROUPS = [
    { label: "家事", icons: [
      ["check", "チェック", '<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
      ["broom", "掃除", '<path d="M18 3l-5.5 9"/><path d="M7.5 12h8l1.5 9h-11z"/><path d="M10 16v5M13.5 16v5"/>'],
      ["laundry", "洗濯", '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="4.5"/><path d="M7 6.5h2M14 6.5h3"/>'],
      ["trash", "ゴミ出し", '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'],
      ["pot", "料理", '<path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M2 10h2M20 10h2"/><path d="M9 6.5c0-1 1-1 1-2.5M14 6.5c0-1 1-1 1-2.5"/>'],
      ["bath", "お風呂", '<path d="M3 12h18v2.5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z"/><path d="M6 12V6a2 2 0 0 1 3.8-.9"/><path d="M7 19.5L6 21M17 19.5l1 1.5"/>'],
      ["aircon", "エアコン", '<rect x="3" y="5" width="18" height="8" rx="2"/><path d="M6.5 10h11"/><path d="M8 16c0 1.5-1 2-1 3.5M12 16c0 1.5-1 2-1 3.5M16 16c0 1.5-1 2-1 3.5"/>'],
      ["shirt", "衣類", '<path d="M8.5 3.5L4 6l-1.5 4.5 3 1.2v8.8h13v-8.8l3-1.2L20 6l-4.5-2.5c-.5 1.8-1.8 2.8-3.5 2.8S9 5.3 8.5 3.5z"/>'],
      ["bulb", "電球・電気", '<path d="M9 17.5h6M10 20.5h4"/><path d="M8.5 14.5C6.8 13.2 6 11.6 6 9.5a6 6 0 0 1 12 0c0 2.1-.8 3.7-2.5 5v3h-7z"/>'],
      ["wrench", "修理・点検", '<path d="M15 3.5a5 5 0 0 0-4.6 6.9L3.8 17a2.1 2.1 0 0 0 3 3l6.6-6.6A5 5 0 0 0 20.5 9l-3 3-3.5-1-1-3.5 3-3z"/>'],
      ["battery", "電池・充電", '<rect x="3" y="7.5" width="16" height="9" rx="2"/><path d="M21 10.5v3"/><path d="M6 10.5v3M9 10.5v3M12 10.5v3"/>'],
      ["cart", "買い物", '<path d="M3 4h2.5l2.2 10.5h10.3L20 7.5H6.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>']
    ]},
    { label: "暮らし", icons: [
      ["house", "家", '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'],
      ["plant", "植物・水やり", '<path d="M12 21v-8"/><path d="M12 13c0-4 3-6 7-6 0 4-3 6-7 6z"/><path d="M12 15c0-3-2.5-5-6-5 0 3 2.5 5 6 5z"/><path d="M7 21h10"/>'],
      ["drop", "水", '<path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z"/>'],
      ["paw", "ペット", '<circle cx="6.5" cy="10.5" r="1.8"/><circle cx="10" cy="6.5" r="1.8"/><circle cx="14" cy="6.5" r="1.8"/><circle cx="17.5" cy="10.5" r="1.8"/><path d="M12 12c-3 0-5.5 3.5-5.5 5.5 0 2 2 2.5 3 2.5s1.5-.5 2.5-.5 1.5.5 2.5.5 3-.5 3-2.5c0-2-2.5-5.5-5.5-5.5z"/>'],
      ["pill", "くすり", '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M10 10l4 4"/>'],
      ["cross", "病院・健診", '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M12 8v8M8 12h8"/>'],
      ["dumbbell", "運動", '<path d="M6 7.5v9M18 7.5v9M3.5 10v4M20.5 10v4M6 12h12"/>'],
      ["scissors", "散髪・カット", '<circle cx="6.5" cy="7" r="2.8"/><circle cx="6.5" cy="17" r="2.8"/><path d="M8.8 8.6L20 18M8.8 15.4L20 6"/>'],
      ["book", "読書・勉強", '<path d="M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5z"/><path d="M12 6v13.5"/>'],
      ["gift", "贈り物・記念日", '<rect x="4" y="9" width="16" height="11.5" rx="1"/><path d="M3 9h18M12 9v11.5"/><path d="M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9c2 0 5.5-.5 5.5-1.5S13.5 5.5 12 9z"/>'],
      ["heart", "家族・大切なこと", '<path d="M12 20s-8-4.8-8-10.5A4.5 4.5 0 0 1 12 6.7a4.5 4.5 0 0 1 8 2.8C20 15.2 12 20 12 20z"/>'],
      ["star", "お気に入り", '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>']
    ]},
    { label: "仕事・IT", icons: [
      ["office", "会社", '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M11 21v-3h2v3"/>'],
      ["laptop", "パソコン", '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 19h19l-2-4h-15z"/>'],
      ["shield", "セキュリティ", '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'],
      ["key", "鍵・パスワード", '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>'],
      ["cloud", "バックアップ", '<path d="M7 18.5a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5 3.75 3.75 0 0 1-.5 7.5z"/><path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5"/>'],
      ["refresh", "更新", '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>'],
      ["mail", "メール", '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'],
      ["phone", "電話・スマホ", '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'],
      ["doc", "書類", '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>'],
      ["chart", "報告・数字", '<path d="M4 4v16h16"/><path d="M8 15l3.5-4 3 2.5L19 8"/>'],
      ["people", "会議・人", '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.6-.3 4.8 1.8 4.8 4.5"/>'],
      ["bell", "お知らせ", '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>']
    ]},
    { label: "お金・手続き", icons: [
      ["yen", "支払い", '<circle cx="12" cy="12" r="9"/><path d="M8.5 7l3.5 5 3.5-5M12 12v5.5M9 13h6M9 15.5h6"/>'],
      ["card", "カード", '<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M2.5 10h19M6 15h4"/>'],
      ["calendar", "予定・期限", '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
      ["clock", "時間", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'],
      ["stamp", "手続き・申請", '<path d="M9.5 3.5h5v3.5l-1 4h-3l-1-4z"/><path d="M5 14.5h14v3H5z"/><path d="M5 20.5h14"/><path d="M10.5 11v3.5M13.5 11v3.5"/>']
    ]},
    { label: "移動", icons: [
      ["car", "車", '<path d="M3 16.5v-3.5l2.5-5.5h13L21 13v3.5z"/><path d="M3 13h18"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>'],
      ["bike", "バイク", '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16L9 11h5l4.5 5"/><path d="M14 11l2-4h2.5"/><path d="M8 8.5h4"/>'],
      ["bicycle", "自転車", '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16L9 9h6l3.5 7"/><path d="M9 9l3.5 7L15 9"/><path d="M8 6.5h3"/>'],
      ["plane", "旅行・出張", '<path d="M21 4L3 11l6.5 2.5L12 20l3-5.5"/><path d="M21 4l-11.5 9.5"/>'],
      ["fuel", "給油・メンテ", '<path d="M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5v15.5"/><path d="M3.5 20.5h12"/><path d="M7.5 7h4v3.5h-4z"/><path d="M14 9.5h2.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V8l-2.5-2.5"/>']
    ]}
  ];

  const COLORS = [
    ["indigo", "#34548f", "#e3eaf6"],
    ["teal",   "#2a7a70", "#dcf0ec"],
    ["green",  "#4c7a3f", "#e4f0dc"],
    ["yellow", "#9a7300", "#fbf1c7"],
    ["orange", "#b8622a", "#fbe5d3"],
    ["red",    "#b1443a", "#f8e0dc"],
    ["pink",   "#a8457a", "#f8e1ee"],
    ["purple", "#6a4fa3", "#ebe4f7"],
    ["gray",   "#5d6170", "#eceef2"]
  ];

  const MAP = {};
  GROUPS.forEach((g) => g.icons.forEach(([key, label, body]) => { MAP[key] = { key, label, body }; }));
  const COLOR_MAP = {};
  COLORS.forEach(([key, fg, bg]) => { COLOR_MAP[key] = { key, fg, bg }; });

  function svg(key, size) {
    const ic = MAP[key] || MAP.check;
    const s = size || 24;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic.body}</svg>`;
  }

  global.MeguruIcons = {
    groups: GROUPS,
    colors: COLORS,
    has: (k) => Object.prototype.hasOwnProperty.call(MAP, k),
    hasColor: (k) => Object.prototype.hasOwnProperty.call(COLOR_MAP, k),
    label: (k) => (MAP[k] ? MAP[k].label : ""),
    color: (k) => COLOR_MAP[k] || COLOR_MAP.indigo,
    svg
  };
})(window);
