/* ===========================================================
   工事写真台帳 — アプリ本体
   Phase 2: 工事情報入力 / 写真ごとのテキスト入力 / 設定画面
   - 設定・工事情報・区分タグは localStorage に保存。
   - 写真本体と写真ごとのテキストはセッション中のみ保持（長期保存しない）。
   =========================================================== */

(function () {
  "use strict";

  /* ---------- Service Worker 登録 ---------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("sw.js")
        .then((reg) => console.log("[koji] SW 登録:", reg.scope))
        .catch((err) => console.error("[koji] SW 登録失敗:", err));
    });
  }

  /* ---------- localStorage ヘルパ ---------- */
  const LS = {
    job: "koji.jobInfo",
    company: "koji.company",
    mail: "koji.mail",
    bodyTpl: "koji.bodyTemplates",
    cats: "koji.categories",
    perPage: "koji.perPage",
    showDate: "koji.showDate", // 撮影日をPDFに表示するか（true/false）
    session: "koji.session", // 写真の並び順・区分（本体はIndexedDB）
  };

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("[koji] 保存失敗:", key, e);
    }
  }

  /* ---------- IndexedDB（写真本体の一時保存。再読み込みで復元） ----------
     iOSはPWAを背面化/プレビュー表示で再読み込みすることがあり、メモリ上の
     写真が失われる。作業セッション中だけIndexedDBに退避し復元する（クリアで消去）。 */
  const IDB = (function () {
    const DB = "koji-db";
    const STORE = "photos";
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(
        (db) =>
          new Promise((res, rej) => {
            const t = db.transaction(STORE, mode);
            const store = t.objectStore(STORE);
            const out = fn(store);
            t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
            t.onerror = () => rej(t.error);
            t.onabort = () => rej(t.error);
          })
      );
    }
    return {
      put: (id, blob) => run("readwrite", (s) => s.put(blob, id)).catch(() => {}),
      del: (id) => run("readwrite", (s) => s.delete(id)).catch(() => {}),
      clear: () => run("readwrite", (s) => s.clear()).catch(() => {}),
      get: (id) => run("readonly", (s) => s.get(id)).catch(() => null),
    };
  })();

  /* ---------- 既定値 ---------- */
  const DEFAULT_CATS = [
    "型式／シリアル",
    "施工前",
    "部材",
    "施工中",
    "完了",
  ];
  // 会社名は固定（設定画面から変更できない。光陽向けの版であることの担保）
  const FIXED_COMPANY_NAME = "株式会社光陽";
  const DEFAULT_COMPANY = {
    name: FIXED_COMPANY_NAME,
    postal: "671-1101",
    address: "兵庫県姫路市広畑区東夢前台4丁目16番地",
    tel: "079-230-4331",
    fax: "079-230-4333",
  };
  const DEFAULT_MAIL = {
    subject: "工事写真帳送付（{工事名}）",
  };
  // 本文の定型句（複数登録・選択式。選択中のものを本文に挿入）
  const DEFAULT_BODY =
    "ご担当者様\n\n" +
    "本メールはアプリによる自動配信のため、文面が十分に整っておりませんことをお詫び申し上げます。\n" +
    "ご依頼の工事が完了致しましたので、添付にて工事写真帳を送付致します。\n" +
    "ご査収の程よろしくお願い致します。";
  const DEFAULT_BODY_TPL = { list: [DEFAULT_BODY], selected: 0 };
  const DEFAULT_JOB = { orderNo: "", name: "", customer: "", place: "" };

  /* ---------- 状態 ---------- */
  const state = {
    // photos: [{ id, file, url, title, place, category }]
    photos: [],
    job: Object.assign({}, DEFAULT_JOB, load(LS.job, {})),
    company: Object.assign({}, DEFAULT_COMPANY, load(LS.company, {})),
    mail: Object.assign({}, DEFAULT_MAIL, load(LS.mail, {})),
    // 候補が空（全削除された等）になると選択肢が出ないため、空なら既定に戻す
    cats: (function () {
      const c = load(LS.cats, null);
      return Array.isArray(c) && c.length ? c : DEFAULT_CATS.slice();
    })(),
    // 本文の定型句 { list:[文章...], selected:index }
    bodyTpl: (function () {
      const b = load(LS.bodyTpl, null);
      if (b && Array.isArray(b.list) && b.list.length) {
        const sel = Math.min(Math.max(0, b.selected | 0), b.list.length - 1);
        return { list: b.list, selected: sel };
      }
      return { list: DEFAULT_BODY_TPL.list.slice(), selected: 0 };
    })(),
    perPage: [2, 3, 4].indexOf(load(LS.perPage, 3)) >= 0 ? load(LS.perPage, 3) : 3,
    // 撮影日をPDFに表示するか（既定: 表示する）
    showDate: load(LS.showDate, true) === false ? false : true,
  };

  // 一度だけ: 新しく既定に加えた「部材」を、未登録なら「施工前」の後に追加
  (function migrateBuzai() {
    try {
      if (localStorage.getItem("koji.mig.buzai")) return;
      if (state.cats.indexOf("部材") === -1) {
        const i = state.cats.indexOf("施工前");
        if (i >= 0) state.cats.splice(i + 1, 0, "部材");
        else state.cats.unshift("部材");
        save(LS.cats, state.cats);
      }
      localStorage.setItem("koji.mig.buzai", "1");
    } catch (e) {
      /* noop */
    }
  })();

  // 一度だけ: 旧既定の会社名/件名を新既定へ更新（ユーザーが未変更の場合のみ）
  (function migrateDefaultsV2() {
    try {
      if (localStorage.getItem("koji.mig.defaults2")) return;
      if (state.company.name === "（株）安福冷暖") {
        state.company.name = "株式会社安福冷暖";
        save(LS.company, state.company);
      }
      if (state.mail.subject === "工事写真帳送付の件（{工事名}）") {
        state.mail.subject = "工事写真帳送付（{工事名}）";
        save(LS.mail, state.mail);
      }
      localStorage.setItem("koji.mig.defaults2", "1");
    } catch (e) {
      /* noop */
    }
  })();

  // 一度だけ: 過去の既定値（安福冷暖／土牛産業）が入ったままの端末を空欄へ更新。
  // ユーザーが独自に編集済みの場合は上書きしない。
  (function migrateCompanyBlank() {
    try {
      if (localStorage.getItem("koji.mig.company_blank")) return;
      const oldNames = [
        "株式会社安福冷暖",
        "（株）安福冷暖",
        "土牛産業株式会社",
      ];
      if (oldNames.indexOf(state.company.name) !== -1) {
        state.company = Object.assign({}, DEFAULT_COMPANY);
        save(LS.company, state.company);
      }
      localStorage.setItem("koji.mig.company_blank", "1");
    } catch (e) {
      /* noop */
    }
  })();

  // 一度だけ: 施工区分の候補を光陽向けの5つへ揃える。
  // 端末に古い候補（解体前・隠蔽前など）が残っていても入れ替える。
  (function migrateCatsKoyoh() {
    try {
      if (localStorage.getItem("koji.mig.cats_koyoh")) return;
      state.cats.length = 0;
      DEFAULT_CATS.forEach((c) => state.cats.push(c));
      save(LS.cats, state.cats);
      localStorage.setItem("koji.mig.cats_koyoh", "1");
    } catch (e) {
      /* noop */
    }
  })();

  // 会社名は常に固定値にする。
  // localStorage はドメイン単位で共有されるため、同じ端末で別の会社向けの版を
  // 開いた履歴があると別の会社名が残っていることがある。起動のたびに上書きする。
  (function fixCompanyName() {
    if (state.company.name !== FIXED_COMPANY_NAME) {
      state.company.name = FIXED_COMPANY_NAME;
      save(LS.company, state.company);
    }
  })();

  let nextId = 1;
  let catEditMode = false; // 写真側の区分チップが「候補を編集」モードか
  let jobInfoCollapsed = false; // 工事情報を折りたたんでいるか
  let settingsSnapshot = null; // 設定オープン時のスナップショット（キャンセル復元用）

  /* ---------- DOM 参照 ---------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    // 工事情報
    jobOrderNo: $("job-orderNo"),
    jobName: $("job-name"),
    jobCustomer: $("job-customer"),
    jobPlace: $("job-place"),
    jobToggle: $("job-toggle"),
    jobBody: $("job-body"),
    jobSummary: $("job-summary"),
    // 写真
    input: $("photo-input"),
    list: $("photo-list"),
    count: $("photo-count"),
    empty: $("empty-state"),
    photoAddBottom: $("photo-add-bottom"),
    clearAll: $("clear-all"),
    generatePdf: $("generate-pdf"),
    generatePdfTop: $("generate-pdf-top"),
    pdfResult: $("pdf-result"),
    // 設定
    openSettings: $("open-settings"),
    settingsSave: $("settings-save"),
    settingsCancel: $("settings-cancel"),
    settings: $("settings"),
    coName: $("co-name"),
    coPostal: $("co-postal"),
    coAddress: $("co-address"),
    coTel: $("co-tel"),
    coFax: $("co-fax"),
    mailSubject: $("mail-subject"),
    bodyTplList: $("body-tpl-list"),
    bodyTplAdd: $("body-tpl-add"),
    catList: $("cat-list"),
    catNew: $("cat-new"),
    catAddBtn: $("cat-add-btn"),
    catReset: $("cat-reset"),
    perPage: $("per-page"),
    showDate: $("show-date"),
  };

  /* ===========================================================
     工事情報
     =========================================================== */
  function initJobInfo() {
    els.jobOrderNo.value = state.job.orderNo;
    els.jobName.value = state.job.name;
    els.jobCustomer.value = state.job.customer || "";
    els.jobPlace.value = state.job.place;

    els.jobOrderNo.addEventListener("input", () => {
      state.job.orderNo = els.jobOrderNo.value;
      save(LS.job, state.job);
      updateClearBtn();
    });
    els.jobName.addEventListener("input", () => {
      state.job.name = els.jobName.value;
      save(LS.job, state.job);
      updateClearBtn();
    });
    els.jobCustomer.addEventListener("input", () => {
      state.job.customer = els.jobCustomer.value;
      save(LS.job, state.job);
      updateClearBtn();
    });
    els.jobPlace.addEventListener("input", () => {
      state.job.place = els.jobPlace.value;
      save(LS.job, state.job);
      updateClearBtn();
    });

    els.jobToggle.addEventListener("click", () => {
      jobInfoCollapsed = !jobInfoCollapsed;
      renderJobInfo();
    });
    renderJobInfo();
  }

  // 工事情報の折りたたみ表示
  function renderJobInfo() {
    const hasPhotos = state.photos.length > 0;
    // 写真が無いときは常に展開（入力できるように）
    const collapsed = hasPhotos && jobInfoCollapsed;

    els.jobBody.classList.toggle("is-hidden", collapsed);
    els.jobSummary.classList.toggle("is-hidden", !collapsed);
    // トグルは写真がある時だけ表示
    els.jobToggle.classList.toggle("is-hidden", !hasPhotos);
    els.jobToggle.textContent = collapsed ? "編集" : "閉じる";

    if (collapsed) {
      const parts = [
        state.job.orderNo && "No." + state.job.orderNo,
        state.job.name,
        state.job.customer,
        state.job.place,
      ].filter(Boolean);
      els.jobSummary.textContent = parts.length
        ? parts.join(" ／ ")
        : "（未入力）";
    }
  }

  /* ===========================================================
     設定画面
     =========================================================== */

  /* ---------- 本文の定型句（複数・選択式） ---------- */
  function saveBodyTpl() {
    save(LS.bodyTpl, state.bodyTpl);
  }

  function addBodyTpl() {
    state.bodyTpl.list.push("");
    state.bodyTpl.selected = state.bodyTpl.list.length - 1;
    saveBodyTpl();
    renderBodyTpls();
  }

  function deleteBodyTpl(i) {
    if (state.bodyTpl.list.length <= 1) {
      alert("定型句は1つ以上必要です。");
      return;
    }
    state.bodyTpl.list.splice(i, 1);
    if (state.bodyTpl.selected >= state.bodyTpl.list.length) {
      state.bodyTpl.selected = state.bodyTpl.list.length - 1;
    }
    saveBodyTpl();
    renderBodyTpls();
  }

  function renderBodyTpls() {
    els.bodyTplList.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.bodyTpl.list.forEach((text, i) => {
      const item = document.createElement("div");
      item.className = "tpl-item";

      const head = document.createElement("div");
      head.className = "tpl-item__head";

      const radioLabel = document.createElement("label");
      radioLabel.className = "tpl-item__radio";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "body-tpl";
      radio.checked = i === state.bodyTpl.selected;
      radio.addEventListener("change", () => {
        state.bodyTpl.selected = i;
        saveBodyTpl();
      });
      const radioText = document.createElement("span");
      radioText.textContent = "この定型句を使う";
      radioLabel.append(radio, radioText);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "link-btn tpl-item__del";
      del.textContent = "削除";
      del.addEventListener("click", () => deleteBodyTpl(i));

      head.append(radioLabel, del);

      const ta = document.createElement("textarea");
      ta.className = "field__input field__textarea";
      ta.rows = 5;
      ta.value = text;
      ta.placeholder = "メール本文に挿入する定型句";
      ta.addEventListener("input", () => {
        state.bodyTpl.list[i] = ta.value;
        saveBodyTpl();
      });

      item.append(head, ta);
      frag.appendChild(item);
    });
    els.bodyTplList.appendChild(frag);
  }

  function bindText(input, obj, key, lsKey) {
    input.value = obj[key] || "";
    input.addEventListener("input", () => {
      obj[key] = input.value;
      save(lsKey, obj);
    });
  }

  // 設定を開く: 現在値をスナップショット（キャンセル復元用）
  function openSettings() {
    settingsSnapshot = {
      company: Object.assign({}, state.company),
      mail: Object.assign({}, state.mail),
      bodyTpl: {
        list: state.bodyTpl.list.slice(),
        selected: state.bodyTpl.selected,
      },
      cats: state.cats.slice(),
      perPage: state.perPage,
      showDate: state.showDate,
    };
    els.settings.classList.remove("is-hidden");
    document.body.classList.add("no-scroll");
  }

  // 設定を閉じる。cancel=true ならスナップショットに復元（保存しない）。
  function closeSettings(cancel) {
    if (cancel && settingsSnapshot) {
      const s = settingsSnapshot;
      // 入力系（オブジェクトは bindText が参照を保持しているため中身を上書き）
      Object.assign(state.company, s.company);
      Object.assign(state.mail, s.mail);
      save(LS.company, state.company);
      save(LS.mail, state.mail);
      // 配列系は中身を入れ替え
      state.cats.length = 0;
      s.cats.forEach((c) => state.cats.push(c));
      save(LS.cats, state.cats);
      state.bodyTpl.list.length = 0;
      s.bodyTpl.list.forEach((t) => state.bodyTpl.list.push(t));
      state.bodyTpl.selected = s.bodyTpl.selected;
      saveBodyTpl();
      state.perPage = s.perPage;
      save(LS.perPage, state.perPage);
      state.showDate = s.showDate;
      save(LS.showDate, state.showDate);

      // 画面に反映し直す（会社名は固定値）
      state.company.name = FIXED_COMPANY_NAME;
      els.coName.value = FIXED_COMPANY_NAME;
      els.coPostal.value = state.company.postal || "";
      els.coAddress.value = state.company.address || "";
      els.coTel.value = state.company.tel || "";
      els.coFax.value = state.company.fax || "";
      els.mailSubject.value = state.mail.subject || "";
      renderCats();
      renderBodyTpls();
      syncPerPage();
      syncShowDate();
      renderPhotos();
    }
    settingsSnapshot = null;
    els.settings.classList.add("is-hidden");
    document.body.classList.remove("no-scroll");
  }

  function initSettings() {
    // 会社名は固定のため入力を受け付けない（bindText で結びつけない）
    bindText(els.coPostal, state.company, "postal", LS.company);
    bindText(els.coAddress, state.company, "address", LS.company);
    bindText(els.coTel, state.company, "tel", LS.company);
    bindText(els.coFax, state.company, "fax", LS.company);
    bindText(els.mailSubject, state.mail, "subject", LS.mail);

    els.bodyTplAdd.addEventListener("click", addBodyTpl);
    renderBodyTpls();

    els.openSettings.addEventListener("click", openSettings);
    els.settingsSave.addEventListener("click", () => closeSettings(false));
    els.settingsCancel.addEventListener("click", () => closeSettings(true));

    els.catAddBtn.addEventListener("click", addCategory);
    els.catNew.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addCategory();
    });
    els.catReset.addEventListener("click", () => {
      if (!confirm("施工区分タグを初期状態に戻します。よろしいですか？")) return;
      state.cats = DEFAULT_CATS.slice();
      save(LS.cats, state.cats);
      renderCats();
      renderPhotos(); // 各写真の区分チップも更新
    });

    // 1ページの写真枚数（2/3/4）
    els.perPage.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.perPage = parseInt(btn.dataset.value, 10);
        save(LS.perPage, state.perPage);
        syncPerPage();
      });
    });
    syncPerPage();

    // 撮影日の表示有無（有/無）
    els.showDate.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.showDate = btn.dataset.value === "1";
        save(LS.showDate, state.showDate);
        syncShowDate();
      });
    });
    syncShowDate();

    renderCats();
  }

  function syncPerPage() {
    els.perPage.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        parseInt(btn.dataset.value, 10) === state.perPage
      );
    });
  }

  function syncShowDate() {
    els.showDate.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        (btn.dataset.value === "1") === state.showDate
      );
    });
  }

  function addCategory() {
    const v = els.catNew.value.trim();
    if (!v) return;
    if (state.cats.includes(v)) {
      els.catNew.value = "";
      return;
    }
    state.cats.push(v);
    save(LS.cats, state.cats);
    els.catNew.value = "";
    renderCats();
    renderPhotos();
  }

  function editCategory(index) {
    const cur = state.cats[index];
    const v = prompt("区分名を編集", cur);
    if (v == null) return;
    const trimmed = v.trim();
    if (!trimmed) return;
    if (state.cats.includes(trimmed) && trimmed !== cur) return;
    state.cats[index] = trimmed;
    save(LS.cats, state.cats);
    renderCats();
    renderPhotos();
  }

  function deleteCategory(index) {
    state.cats.splice(index, 1);
    save(LS.cats, state.cats);
    renderCats();
    renderPhotos();
  }

  // 区分タグの並べ替え（設定画面で順番入れ替え）
  function moveCategory(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= state.cats.length) return;
    const arr = state.cats;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    save(LS.cats, state.cats);
    renderCats();
    renderPhotos();
  }

  // 値ベースの候補 追加 / 削除（写真側のインライン編集から使用）
  function addCandidateValue(value) {
    const v = (value || "").trim();
    if (!v || state.cats.includes(v)) return;
    state.cats.push(v);
    save(LS.cats, state.cats);
    renderCats();
    renderPhotos();
  }
  function removeCandidateValue(cat) {
    const i = state.cats.indexOf(cat);
    if (i === -1) return;
    state.cats.splice(i, 1);
    save(LS.cats, state.cats);
    renderCats();
    renderPhotos();
  }
  function toggleCatEdit() {
    catEditMode = !catEditMode;
    renderPhotos();
  }

  function renderCats() {
    els.catList.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.cats.forEach((cat, i) => {
      const li = document.createElement("li");
      li.className = "cat-item";

      const name = document.createElement("button");
      name.type = "button";
      name.className = "cat-item__name";
      name.textContent = cat;
      name.title = "タップで編集";
      name.addEventListener("click", () => editCategory(i));

      // 並べ替え（▲▼）
      const up = document.createElement("button");
      up.type = "button";
      up.className = "icon-btn";
      up.textContent = "▲";
      up.setAttribute("aria-label", cat + " を上へ");
      up.disabled = i === 0;
      up.addEventListener("click", () => moveCategory(i, -1));

      const down = document.createElement("button");
      down.type = "button";
      down.className = "icon-btn";
      down.textContent = "▼";
      down.setAttribute("aria-label", cat + " を下へ");
      down.disabled = i === state.cats.length - 1;
      down.addEventListener("click", () => moveCategory(i, 1));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn photo-item__del";
      del.textContent = "✕";
      del.setAttribute("aria-label", cat + " を削除");
      del.addEventListener("click", () => deleteCategory(i));

      li.append(name, up, down, del);
      frag.appendChild(li);
    });
    els.catList.appendChild(frag);
  }
  /* ===========================================================
     写真
     =========================================================== */
  // ファイルの更新日時から日付文字列（YYYY/MM/DD）を得る（写真データ参照）
  function fileToDate(file) {
    const t = file && file.lastModified;
    if (!t) return "";
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate());
  }

  // 写真の並び順・区分・日付を localStorage に、本体はIndexedDBに退避
  function saveSession() {
    const order = state.photos.map((p) => p.id);
    const cats = {};
    const dates = {};
    const notes = {};
    state.photos.forEach((p) => {
      if (p.category) cats[p.id] = p.category;
      if (p.date) dates[p.id] = p.date;
      if (p.note) notes[p.id] = p.note;
    });
    save(LS.session, { order: order, cats: cats, dates: dates, notes: notes });
  }

  // 起動時: IndexedDBから写真を復元（再読み込み対策）
  async function restoreSession() {
    const s = load(LS.session, null);
    if (!s || !Array.isArray(s.order) || s.order.length === 0) return;
    const restored = [];
    for (const id of s.order) {
      const blob = await IDB.get(id);
      if (!blob) continue;
      restored.push({
        id: id,
        file: blob,
        url: URL.createObjectURL(blob),
        category: (s.cats && s.cats[id]) || "",
        date: (s.dates && s.dates[id]) || "",
        note: (s.notes && s.notes[id]) || "",
      });
    }
    if (restored.length === 0) return;
    state.photos = restored;
    nextId = Math.max.apply(null, restored.map((p) => p.id)) + 1;
    jobInfoCollapsed = true; // 復元時は工事情報を折りたたむ
    renderPhotos();
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length === 0) return;

    const wasEmpty = state.photos.length === 0;

    files.forEach((file) => {
      const id = nextId++;
      state.photos.push({
        id: id,
        file: file,
        url: URL.createObjectURL(file),
        // 工事件名・工事場所は工事情報の共通値を使うため写真ごとには持たない。
        // 写真ごとに設定するのは施工区分（選択）と自由入力のみ。日付は写真データから参照。
        category: "",
        note: "",
        date: fileToDate(file),
      });
      IDB.put(id, file); // 本体を退避
    });
    // 初めて写真を入れたら工事情報を折りたたむ
    if (wasEmpty) jobInfoCollapsed = true;
    markPdfStale(); // 写真を足したら要再生成 → 生成ボタンを青に戻す
    saveSession();
    renderPhotos();
  }

  // 生成済みPDFが古くなった（写真変更）→ 生成ボタンを青背景・白文字に戻す
  function markPdfStale() {
    els.generatePdf.classList.remove("btn--ghost");
    els.generatePdfTop.classList.remove("btn--ghost");
  }

  function move(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= state.photos.length) return;
    const arr = state.photos;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    markPdfStale();
    saveSession();
    renderPhotos();
  }

  function remove(id) {
    const idx = state.photos.findIndex((p) => p.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(state.photos[idx].url);
    state.photos.splice(idx, 1);
    IDB.del(id);
    markPdfStale();
    saveSession();
    renderPhotos();
  }

  // 最初からやり直す: 写真・工事情報・PDF結果をリセット。
  // 設定（自社情報・メール雛形・区分タグ）は残す。
  function clearAll() {
    const hasJob = state.job.orderNo || state.job.name || state.job.place;
    if (state.photos.length === 0 && !hasJob) return;
    if (
      !confirm(
        "選択した写真・工事情報をリセットします。\n（設定・区分タグ・自社情報・メール雛形は残ります）\nよろしいですか？"
      )
    )
      return;

    // 写真（メモリ・IndexedDB・並び順をすべて消去）
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    IDB.clear();
    save(LS.session, { order: [], cats: {} });

    // 工事情報
    state.job = { orderNo: "", name: "", customer: "", place: "" };
    save(LS.job, state.job);
    els.jobOrderNo.value = "";
    els.jobName.value = "";
    els.jobCustomer.value = "";
    els.jobPlace.value = "";
    jobInfoCollapsed = false; // 工事情報を展開状態に戻す

    // PDF結果
    if (lastPdfUrl) {
      URL.revokeObjectURL(lastPdfUrl);
      lastPdfUrl = null;
    }
    els.pdfResult.innerHTML = "";
    els.pdfResult.classList.add("is-hidden");

    // 「PDF生成・プレビュー」ボタンを元の青背景に戻す
    els.generatePdf.classList.remove("btn--ghost");
    els.generatePdfTop.classList.remove("btn--ghost");

    renderPhotos();
    renderJobInfo();
  }

  function iconButton(label, aria, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    b.disabled = !!disabled;
    return b;
  }

  function createRow(photo, index, total) {
    const li = document.createElement("li");
    li.className = "photo-item";

    /* --- 上段: 番号 + サムネ + 並べ替え/削除 --- */
    const head = document.createElement("div");
    head.className = "photo-item__head";

    const num = document.createElement("span");
    num.className = "photo-item__num";
    num.textContent = String(index + 1);

    const thumb = document.createElement("img");
    thumb.className = "photo-item__thumb";
    thumb.src = photo.url;
    thumb.alt = "写真 " + (index + 1);
    thumb.loading = "lazy";
    thumb.decoding = "async";

    const ctrls = document.createElement("div");
    ctrls.className = "photo-item__ctrls";
    const upBtn = iconButton("▲", "上へ移動", index === 0);
    upBtn.addEventListener("click", () => move(index, -1));
    const downBtn = iconButton("▼", "下へ移動", index === total - 1);
    downBtn.addEventListener("click", () => move(index, 1));
    const delBtn = iconButton("✕", "削除", false);
    delBtn.classList.add("photo-item__del");
    delBtn.addEventListener("click", () => remove(photo.id));
    ctrls.append(upBtn, downBtn, delBtn);

    head.append(num, thumb, ctrls);

    /* --- 下段: 施工区分のみ（件名・場所は工事情報の共通値を使う） --- */
    const body = document.createElement("div");
    body.className = "photo-item__body";

    // 施工区分（選択）: 候補チップをタップで選択（再タップで解除）
    const catWrap = document.createElement("div");
    catWrap.className = "pfield";

    // ラベルと「候補を編集」を同じ行に（ラベル左寄せ／編集リンク右端）
    const catHead = document.createElement("div");
    catHead.className = "pfield__head";
    const catLabel = document.createElement("span");
    catLabel.className = "pfield__label";
    catLabel.textContent = "施工区分（選択）";
    catHead.appendChild(catLabel);
    const editToggle = document.createElement("button");
    editToggle.type = "button";
    editToggle.className = "link-btn";
    editToggle.textContent = catEditMode ? "完了" : "候補を編集";
    editToggle.addEventListener("click", toggleCatEdit);
    catHead.appendChild(editToggle);

    const chips = document.createElement("div");
    chips.className = "chips";

    if (catEditMode) {
      // 編集モード: 各候補は ✕ で削除、末尾の「＋追加」で候補を追加
      state.cats.forEach((cat) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip chip--editing";
        chip.textContent = cat + "  ✕";
        chip.setAttribute("aria-label", cat + " を候補から削除");
        chip.addEventListener("click", () => removeCandidateValue(cat));
        chips.appendChild(chip);
      });
      const addChip = document.createElement("button");
      addChip.type = "button";
      addChip.className = "chip chip--add";
      addChip.textContent = "＋ 追加";
      addChip.addEventListener("click", () => {
        const v = prompt("追加する施工区分を入力", "");
        if (v != null) addCandidateValue(v);
      });
      chips.appendChild(addChip);
    } else {
      // 通常モード: タップで選択（選択済みを再タップで解除）
      state.cats.forEach((cat) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = cat;
        chip.addEventListener("click", () => {
          photo.category = photo.category === cat ? "" : cat;
          syncChips(chips, photo.category);
          saveSession();
        });
        chips.appendChild(chip);
      });
      syncChips(chips, photo.category);
    }

    catWrap.append(catHead, chips);

    // 編集モードのヒント（候補を編集中のみ）
    if (catEditMode) {
      const hint = document.createElement("p");
      hint.className = "cat-tools__hint";
      hint.textContent = "✕で削除 ／「＋追加」で候補を追加";
      catWrap.appendChild(hint);
    }

    // 自由入力: 選択肢とは別の行としてPDFに表示される
    const noteWrap = document.createElement("div");
    noteWrap.className = "pfield";
    const noteLabel = document.createElement("span");
    noteLabel.className = "pfield__label";
    noteLabel.textContent = "自由入力";
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "pfield__input";
    noteInput.value = photo.note || "";
    noteInput.addEventListener("input", () => {
      photo.note = noteInput.value;
      saveSession();
    });
    noteWrap.append(noteLabel, noteInput);

    body.append(catWrap, noteWrap);
    li.append(head, body);
    return li;
  }

  // クリアはヘッダーに常設（何も無いときは clearAll() が早期returnする）。
  function updateClearBtn() {
    /* ヘッダーのクリアボタンは常時表示のため何もしない */
  }

  function syncChips(chipsEl, value) {
    Array.from(chipsEl.children).forEach((chip) => {
      chip.classList.toggle("is-active", chip.textContent === value);
    });
  }

  function renderPhotos() {
    const total = state.photos.length;
    els.count.textContent = total === 0 ? "" : total + " 枚を選択中";
    els.empty.classList.toggle("is-hidden", total > 0);
    // 生成ボタン（上下とも）: 写真が無ければグレーアウト
    els.generatePdf.disabled = total === 0;
    els.generatePdfTop.disabled = total === 0;
    // 下段の「写真を選択／追加」は写真がある時だけ表示
    els.photoAddBottom.classList.toggle("is-hidden", total === 0);
    updateClearBtn();
    renderJobInfo();

    els.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.photos.forEach((photo, i) => {
      frag.appendChild(createRow(photo, i, total));
    });
    els.list.appendChild(frag);
  }

  /* ===========================================================
     PDF生成
     =========================================================== */
  let lastPdfUrl = null;

  function sanitizeFileName(s) {
    return (s || "工事").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  }

  // 雛形のプレースホルダを差し込む（{工事名}{工事場所}{注文番号}{会社名}）
  function fillTemplate(tmpl) {
    return String(tmpl || "")
      .replace(/\{工事名\}/g, state.job.name || "")
      .replace(/\{工事場所\}/g, state.job.place || "")
      .replace(/\{注文番号\}/g, state.job.orderNo || "")
      .replace(/\{会社名\}/g, state.company.name || "");
  }

  // 件名の雛形に差し込み
  function buildSubject() {
    return fillTemplate(state.mail.subject || "工事写真帳送付の件");
  }

  // 本文の定型句（選択中）に差し込み
  function buildBody() {
    const t = state.bodyTpl;
    const tpl = (t.list && t.list[t.selected]) || "";
    return fillTemplate(tpl);
  }

  // テキストをクリップボードへコピー（失敗時はprompt）
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const org = btn.textContent;
        btn.textContent = "コピー済み";
        setTimeout(() => (btn.textContent = org), 1200);
      }
    } catch (e) {
      window.prompt("コピーしてください", text);
    }
  }

  // PDFを共有・保存（共有シート）。メール添付や「"ファイル"に保存」が選べる。
  // 宛先はメールアプリ側で入力する。非対応環境: ダウンロード保存にフォールバック。
  async function sharePdf(file, body) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        // iOSメールは共有の title を件名欄に入れず本文に混ぜてしまうため title は渡さない。
        // text=本文の定型句のみ渡す（本文に入る）。件名は「件名をコピー」で貼り付け。
        const data = { files: [file] };
        if (body) data.text = body;
        await navigator.share(data);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    // フォールバック: ダウンロード保存
    const a = document.createElement("a");
    a.href = lastPdfUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // 送付ブロック（PDFを送る＋件名表示）を組み立てる。
  // 宛先はメールアプリ側で入力する。件名は送付時に自動コピー。
  function buildSendBox(file, filename, subject, body, canShareFile) {
    const box = document.createElement("div");
    box.className = "send-box";

    // PDFを添付して送る（共有シート → メールでPDFが自動添付）。
    // タップ時に件名をクリップボードへ自動コピー → メールの件名欄に貼り付けるだけ。
    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "btn btn--block";
    shareBtn.textContent = canShareFile ? "PDFを送る" : "PDFを保存（ダウンロード）";

    const status = document.createElement("p");
    status.className = "send-box__status is-hidden";

    shareBtn.addEventListener("click", async () => {
      if (canShareFile && subject) {
        try {
          await navigator.clipboard.writeText(subject);
        } catch (e) {
          /* 失敗しても送付は続行 */
        }
        status.textContent =
          "件名をコピーしました。メールの件名欄を長押し→ペーストで貼り付けてください。";
        status.classList.remove("is-hidden");
      }
      await sharePdf(file, body);
    });

    // 件名（雛形＋工事名差し込み。表示＋手動コピーも可）
    const subjRow = document.createElement("div");
    subjRow.className = "send-box__field";
    const subjLabel = document.createElement("span");
    subjLabel.className = "send-box__label";
    subjLabel.textContent = "件名";
    const subjVal = document.createElement("span");
    subjVal.className = "send-box__subject";
    subjVal.textContent = subject || "（未設定）";
    const subjCopy = document.createElement("button");
    subjCopy.type = "button";
    subjCopy.className = "link-btn";
    subjCopy.textContent = "件名をコピー";
    subjCopy.addEventListener("click", () => copyText(subject, subjCopy));
    subjRow.append(subjLabel, subjVal, subjCopy);

    const note = document.createElement("p");
    note.className = "send-box__note";
    note.textContent = canShareFile
      ? "「PDFを送る」を押すと、PDFが添付され、本文に定型句が入り、件名が自動でコピーされます。メールアプリで宛先を入力し、件名欄に貼り付け（ペースト）してください。（本文の定型句は設定で変更できます）"
      : "「PDFを保存」でダウンロード後、メールに添付してください。宛先はメールアプリで入力、件名は「件名をコピー」で貼り付けてください。";

    // 「PDFを送る」をカード最上段に配置
    box.append(shareBtn, status, subjRow, note);
    return box;
  }

  async function generatePdf() {
    if (state.photos.length === 0) return;
    if (typeof window.KojiPDF === "undefined") {
      alert("PDFライブラリの読み込みに失敗しました。通信状況を確認して再読み込みしてください。");
      return;
    }

    // 生成後に自動でプレビュー表示するため、ユーザー操作（クリック）の文脈で
    // 先に空タブを開いておく（iOSのポップアップブロック回避）。
    let previewWin = null;
    try {
      previewWin = window.open("", "_blank");
    } catch (e) {
      previewWin = null;
    }

    const genBtns = [els.generatePdf, els.generatePdfTop];
    genBtns.forEach((b) => (b.disabled = true));
    const orgLabel = "PDF生成・プレビュー";
    const setLabel = (t) => genBtns.forEach((b) => (b.textContent = t));
    setLabel("生成中…");
    els.pdfResult.classList.add("is-hidden");

    try {
      const bytes = await window.KojiPDF.generate({
        job: state.job,
        company: state.company,
        photos: state.photos,
        perPage: state.perPage,
        showDate: state.showDate,
        onProgress: setLabel,
      });

      // 以前のURLを解放
      if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
      const blob = new Blob([bytes], { type: "application/pdf" });
      lastPdfUrl = URL.createObjectURL(blob);

      // 端末のローカル日付。toISOString() はUTC基準のため、朝9時前だと前日になる
      const nowD = new Date();
      const pad2 = (n) => String(n).padStart(2, "0");
      const today =
        nowD.getFullYear() + "-" + pad2(nowD.getMonth() + 1) + "-" + pad2(nowD.getDate());
      const filename =
        "工事写真帳_" + sanitizeFileName(state.job.name) + "_" + today + ".pdf";

      // 保存・共有用の File（iOSの共有シートで「"ファイル"に保存」が選べる）
      const file = new File([blob], filename, { type: "application/pdf" });
      const canShareFile =
        navigator.canShare && navigator.canShare({ files: [file] });

      // 結果UI（送付ブロックのみ。プレビュー/生成/クリアは下部の固定ボタン）
      els.pdfResult.innerHTML = "";
      const subject = buildSubject();
      const body = buildBody();
      const sendBox = buildSendBox(file, filename, subject, body, canShareFile);

      const info = document.createElement("p");
      info.className = "pdf-result__info";
      const pages = 1 + Math.ceil(state.photos.length / state.perPage);
      info.textContent =
        filename + "（表紙＋写真" + state.photos.length + "枚 / 全" + pages + "ページ）";

      els.pdfResult.append(sendBox, info);
      els.pdfResult.classList.remove("is-hidden");

      // 生成後に自動でPDFをプレビュー表示する
      if (previewWin && !previewWin.closed) {
        previewWin.location.href = lastPdfUrl;
      } else {
        // ポップアップがブロックされた場合は新規タブで開く（アプリ画面は保持）
        window.open(lastPdfUrl, "_blank");
      }

      // 一度生成したら生成ボタン（上下とも）を白背景・青文字に
      genBtns.forEach((b) => b.classList.add("btn--ghost"));
    } catch (e) {
      console.error("[koji] PDF生成エラー:", e);
      if (previewWin && !previewWin.closed) previewWin.close();
      alert("PDFの生成に失敗しました: " + (e && e.message ? e.message : e));
    } finally {
      setLabel(orgLabel);
      genBtns.forEach((b) => (b.disabled = state.photos.length === 0));
    }
  }

  /* ===========================================================
     イベント / 初期化
     =========================================================== */
  els.input.addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = ""; // 同じ写真を連続選択しても発火させる
  });
  els.clearAll.addEventListener("click", clearAll);
  els.generatePdf.addEventListener("click", generatePdf);
  els.generatePdfTop.addEventListener("click", generatePdf);

  initJobInfo();
  initSettings();
  renderPhotos();
  restoreSession(); // 再読み込み時に作業中の写真を復元
  console.log("[koji] 工事写真台帳 起動（Phase 4）");
})();
