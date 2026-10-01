// 認知テスト記録ツール（研究専用）。ブラウザ内だけで完結する。外部送信・Firebase・APIは使わない。
// 質問・順序・深掘り対象は cognitive_test_v1.md が正本（questions_data.js はそこから生成）。
(function () {
  "use strict";
  const D = window.COGTEST_DATA, L = window.COGLOGIC;
  const app = document.getElementById("app");
  const DRAFT_KEY = "cogtest_draft_v1";
  const LOCK_MS = 350;       // 画面表示直後の誤タップ防止
  const BREAK_AFTER = 5;     // 深掘り5問目の後に休憩（cognitive_test_v1.md 7節）
  const BREAK_SEC = 180;

  let S = null;              // 進行中のセッション
  let shownAt = 0, busy = false, breakTimer = null, saveTimer = null;

  // ---------- 小さな道具 ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  }
  function show(...nodes) { clearTimeout(breakTimer); app.replaceChildren(...nodes.filter(Boolean)); window.scrollTo(0, 0); }
  const nowIso = () => new Date().toISOString();
  const ANS_JA = { left: "左", right: "右", up: "どちらとも言えない" };
  const snippet = (qid, n = 18) => { const t = D.questions[qid].scene; return t.length > n ? t.slice(0, n) + "…" : t; };

  function saveDraft() {
    if (!S) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(S)); } catch (e) { /* 保存できなくても続行 */ }
  }
  function saveDraftSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 400); }
  function loadDraft() {
    try { const t = localStorage.getItem(DRAFT_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 無視 */ } }

  window.addEventListener("beforeunload", (e) => {
    if (S && S.phase !== "done") { e.preventDefault(); e.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => {
    if (S && S.phase === "quiz") S.events.push({ t_ms: Math.round(performance.now()), type: document.hidden ? "page_hidden" : "page_visible", position: S.position + 1 });
  });

  function bindText(el, obj, key) {
    el.value = obj[key] || "";
    el.addEventListener("input", () => { obj[key] = el.value; saveDraftSoon(); });
    return el;
  }
  function bindCheck(el, obj, key) {
    el.checked = !!obj[key];
    el.addEventListener("change", () => { obj[key] = el.checked; saveDraftSoon(); });
    return el;
  }

  // ---------- 0. 開始（実施者） ----------
  function renderSetup() {
    S = null;
    const draft = loadDraft();
    const idIn = h("input", { type: "text", id: "pid", placeholder: "例：P01", autocomplete: "off", autocapitalize: "characters" });
    const age = h("select", { id: "age" }, h("option", { value: "", text: "選択してください" }),
      ...["10代", "20代", "30代", "40代", "50代", "60代以上"].map((x) => h("option", { value: x, text: x })));
    const status = h("select", { id: "status" }, h("option", { value: "", text: "選択してください" }),
      ...["学生", "社会人", "その他"].map((x) => h("option", { value: x, text: x })));
    const gender = h("select", { id: "gender" }, h("option", { value: "", text: "回答しない／未入力" }),
      ...["女性", "男性", "その他"].map((x) => h("option", { value: x, text: x })));
    const radios = (name) => h("div", { class: "radios" },
      ...["あり", "なし"].map((x) => h("label", {}, h("input", { type: "radio", name, value: x }), x)));
    const work = radios("work"), mgr = radios("mgr");
    const info = h("div", { class: "answerbox", id: "info", text: "参加者IDを入力すると、質問順が自動で決まります。" });
    const manual = h("div", { id: "manual" });
    const err = h("div", { class: "warn", id: "err" });

    function refresh() {
      const p = L.parseParticipantId(idIn.value);
      manual.replaceChildren();
      if (!idIn.value.trim()) { info.textContent = "参加者IDを入力すると、質問順が自動で決まります。"; return; }
      if (!p.ok) { info.textContent = p.error; return; }
      const auto = L.anchorsFor(D, p.id);
      info.textContent = `質問順：${p.pattern}（ID末尾が${p.pattern === "A" ? "奇数" : "偶数"}）／深掘り対象：${auto ? "自動で選択されます" : "表にないIDのため、下で手動指定してください"}`;
      if (!auto) {
        const h5 = h("select", { id: "m_h5" }, ...["H5-Q10", "H5-Q22"].map((id) => h("option", { value: id, text: snippet(id, 24) })));
        const h68 = h("select", { id: "m_h68" }, ...Object.keys(D.questions).filter((id) => /^H[68]-/.test(id)).map((id) => h("option", { value: id, text: snippet(id, 24) })));
        manual.append(h("label", { text: "深掘りのアンカー（1）" }), h5, h("label", { text: "深掘りのアンカー（2）" }), h68);
      }
    }
    idIn.addEventListener("input", refresh);

    const startBtn = h("button", { class: "primary", text: "テストを始める", onclick: () => {
      err.textContent = "";
      const p = L.parseParticipantId(idIn.value);
      const pick = (n) => (document.querySelector(`input[name=${n}]:checked`) || {}).value || "";
      if (!p.ok) { err.textContent = p.error; return; }
      if (!age.value || !status.value || !pick("work") || !pick("mgr")) { err.textContent = "年代・学生/社会人/その他・仕事経験・管理職経験を選んでください。"; return; }
      let anchors = L.anchorsFor(D, p.id);
      if (!anchors) {
        const a = document.getElementById("m_h5"), b = document.getElementById("m_h68");
        anchors = { h5: a.value, h68: b.value, manual: true };
      }
      S = L.newSession(D, { participant_id: p.id, age_band: age.value, status: status.value, gender_optional: gender.value,
        work_experience: pick("work"), managerial_experience: pick("mgr") }, anchors, nowIso());
      saveDraft();
      render();
    } });

    const nodes = [h("h1", { text: "認知テスト記録ツール（研究専用）" }),
      h("p", { class: "note", text: "データはこのブラウザの中だけに保持します。外部には送信しません。氏名など個人を特定する情報は入力しないでください。" })];
    if (draft && draft.phase !== "done") {
      nodes.push(h("div", { class: "card" },
        h("strong", { text: `途中のデータがあります（${draft.participant.participant_id}）` }),
        h("div", { class: "row" },
          h("button", { text: "続きから再開", onclick: () => { S = draft; S.events.push({ t_ms: Math.round(performance.now()), type: "resume" }); render(); } }),
          h("button", { text: "破棄する", onclick: () => { if (confirm("途中のデータを破棄します。よろしいですか？")) { clearDraft(); renderSetup(); } } }))));
    }
    nodes.push(h("div", { class: "card" },
      h("label", { for: "pid", text: "参加者ID（個人名は入れない）" }), idIn, info, manual,
      h("label", { text: "年代" }), age,
      h("label", { text: "学生／社会人／その他" }), status,
      h("label", { text: "仕事経験" }), work,
      h("label", { text: "管理職経験" }), mgr,
      h("label", { text: "性別（任意）" }), gender, err, startBtn));
    show(...nodes);
  }

  // ---------- 1. 参加者へ渡す ----------
  function renderHandoff() {
    show(h("h1", { text: "回答のお願い" }),
      h("div", { class: "card" },
        h("p", { text: "これから、場面と2つの選択肢が1問ずつ出ます。正解はありません。自分ならどうするか、直感で選んでください。" }),
        h("p", { text: "どちらとも言えないときは「どちらとも言えない」を選んでかまいません。全部で18問です。" }),
        h("p", { class: "note", text: "押し間違えたときは、画面上の「前の問題に戻る」で1問だけ戻れます。" })),
      h("button", { class: "primary", text: "はじめる", onclick: () => { S.phase = "quiz"; S.position = 0; S.last_action_was_back = false; saveDraft(); render(); } }));
  }

  // ---------- 2. 18問 ----------
  function renderQuiz() {
    busy = false;
    const qid = S.order[S.position], q = D.questions[qid], cur = S.answers[qid];
    const mk = (side, text) => {
      const b = h("button", { class: "choice" + (cur && cur.answer === side ? " sel" : ""), "data-side": side, disabled: true, text, onclick: () => answer(side) });
      return b;
    };
    const left = mk("left", q.left), right = mk("right", q.right);
    const up = h("button", { class: "up" + (cur && cur.answer === "up" ? " sel" : ""), "data-side": "up", disabled: true, text: "どちらとも言えない", onclick: () => answer("up") });
    const back = h("button", { class: "small", text: "← 前の問題に戻る", disabled: !L.canGoBack(S), onclick: () => {
      if (busy || !L.goBack(S, performance.now())) return;
      saveDraft(); render();
    } });
    show(h("div", { class: "top" }, h("span", { class: "count", text: `${S.position + 1} / 18` }), back),
      h("div", { class: "bar" }, h("i", { style: `width:${(S.position / 18) * 100}%` })),
      h("div", { class: "scene", text: q.scene }),
      h("div", { class: "choices" }, left, right), up);
    shownAt = performance.now();
    setTimeout(() => { for (const b of [left, right, up]) b.disabled = false; }, LOCK_MS);
  }

  function answer(side) {
    if (busy) return;
    busy = true;
    const elapsed = performance.now() - shownAt;
    const qid = S.order[S.position];
    L.recordAnswer(S, qid, side, elapsed);
    for (const b of app.querySelectorAll("[data-side]")) b.classList.toggle("sel", b.dataset.side === side);
    setTimeout(() => {
      S.last_action_was_back = false;
      if (S.position >= 17) S.phase = "probe_intro"; else S.position += 1;
      saveDraft(); render();
    }, 220);
  }

  // ---------- 3. 深掘り（実施者） ----------
  function renderProbeIntro() {
    show(h("h1", { text: "回答ありがとうございました" }),
      h("div", { class: "card" }, h("p", { text: "ここから、いくつかの質問について、選んだ理由をうかがいます。" }),
        h("p", { class: "note", text: "（実施者が操作・記入します。端末を実施者へ渡してください）" })),
      h("button", { class: "primary", text: "深掘りを始める", onclick: () => { S.phase = "probe"; S.probe_index = 0; saveDraft(); render(); } }));
  }

  function renderProbe() {
    const total = S.probe_plan.length, item = S.probe_plan[S.probe_index], qid = item.question_id, q = D.questions[qid];
    const a = S.answers[qid];
    if (!S.probes[qid]) S.probes[qid] = L.emptyProbe(item.tier);
    const pr = S.probes[qid];
    const optRow = (side, text) => h("div", { class: "opt" + (a.answer === side ? " mine" : "") }, (side === "left" ? "左：" : "右：") + text);
    const ta = (key, rows) => bindText(h("textarea", { rows: rows || 3 }), pr, key);

    const ctx = h("div", { class: "radios" }, ...[["yes", "変わりそう"], ["no", "変わらなそう"], ["unsure", "分からない"]].map(([v, t]) => {
      const r = h("input", { type: "radio", name: "ctx", value: v });
      r.checked = pr.context_changes === v;
      r.addEventListener("change", () => { pr.context_changes = v; saveDraftSoon(); });
      return h("label", {}, r, t);
    }));
    const nodes = [
      h("div", { class: "top" }, h("span", { class: "count", text: `深掘り ${S.probe_index + 1} / ${total}` }), h("span", { class: "note", text: item.tier === "tier1" ? "完全" : "短縮" })),
      h("div", { class: "bar" }, h("i", { style: `width:${(S.probe_index / total) * 100}%` })),
      h("div", { class: "card" }, h("div", { class: "note", text: q.scene }), optRow("left", q.left), optRow("right", q.right),
        h("div", { class: "answerbox", text: `本人の回答：${ANS_JA[a.answer]}${a.change_count ? `（回答を${a.change_count}回変更）` : ""}` })),
      h("label", { text: "何を基準にこちらを選びましたか？" }), ta("free_reason"),
      h("label", { id: "opp_label", text: a.answer === "up" ? "どちらの側も選ばなかった理由は何ですか？" : "反対側を選ばなかった理由は何ですか？" }), ta("opposite_rejection_reason"),
    ];
    if (q.ask_perceived_construct) nodes.push(h("label", { text: "この質問は、あなたの何を見ている質問だと思いましたか？" }), ta("perceived_construct"));
    nodes.push(h("details", {}, h("summary", { text: "必要な場合のみ" }),
      h("label", { text: "別の場面なら回答が変わりそうですか？" }), ctx, h("label", { text: "変わりそうな場合の場面" }), ta("context_variation_note", 2),
      h("div", { class: "checks" }, h("label", {}, bindCheck(h("input", { type: "checkbox" }), pr, "misunderstanding_flag"), "読みにくかった・意味が分からなかった")),
      ta("misunderstanding_note", 2),
      h("label", { text: "（誤読が疑われる場合）この場面を自分の言葉で言い換えてもらう" }), ta("paraphrase", 2)));
    nodes.push(h("details", {}, h("summary", { text: "実施者メモ" }),
      h("div", { class: "checks" },
        h("label", {}, bindCheck(h("input", { type: "checkbox" }), pr, "social_desirability_flag"), "社会的望ましさの兆候があった"),
        h("label", {}, bindCheck(h("input", { type: "checkbox" }), pr, "recall_failure_flag"), "回答を覚えていなかった")),
      ta("interviewer_note", 2)));
    nodes.push(h("div", { class: "row" },
      h("button", { text: "← 前へ", disabled: S.probe_index === 0, onclick: () => { S.probe_index -= 1; saveDraft(); render(); } }),
      h("button", { class: "primary", style: "margin-top:0", text: S.probe_index === total - 1 ? "終了質問へ" : "次へ →", onclick: () => {
        if (S.probe_index === total - 1) { S.phase = "end"; }
        else {
          S.probe_index += 1;
          if (S.probe_index === BREAK_AFTER && !S.break_done) { S.break_done = true; S.phase = "break"; }
        }
        saveDraft(); render();
      } })));
    show(...nodes);
  }

  function renderBreak() {
    let left = BREAK_SEC;
    const t = h("div", { class: "timer", text: fmt(left) });
    function fmt(n) { return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; }
    show(h("h1", { text: "休憩" }), h("div", { class: "card" }, h("p", { text: "少し休憩します。" }), t),
      h("button", { class: "primary", text: "再開する", onclick: () => { S.phase = "probe"; saveDraft(); render(); } }));
    breakTimer = setInterval(() => { left = Math.max(0, left - 1); t.textContent = fmt(left); }, 1000);
    // show() は breakTimer を消すので、表示後に作り直す
  }

  // ---------- 4. 終了質問（実施者） ----------
  function renderEnd() {
    const e = S.end;
    const posLabel = (qid) => `第${S.order.indexOf(qid) + 1}問：${snippet(qid, 16)}`;
    const itemsOf = (role) => S.order.filter((id) => D.questions[id].item_role === role);
    const sel = (idx, role) => {
      const s = h("select", {}, h("option", { value: "", text: "（聞かない）" }), ...itemsOf(role).map((id) => h("option", { value: id, text: posLabel(id) })));
      s.value = e.q5[idx].question_id;
      s.addEventListener("change", () => { e.q5[idx].question_id = s.value; saveDraftSoon(); });
      return s;
    };
    const checks = h("div", { class: "grid2 checks" }, ...S.order.map((id, i) => {
      const c = h("input", { type: "checkbox" });
      c.checked = e.similar_positions.includes(i + 1);
      c.addEventListener("change", () => {
        e.similar_positions = c.checked ? [...new Set([...e.similar_positions, i + 1])].sort((a, b) => a - b) : e.similar_positions.filter((x) => x !== i + 1);
        saveDraftSoon();
      });
      return h("label", {}, c, `第${i + 1}問`);
    }));
    show(h("h1", { text: "終了質問" }),
      h("label", { text: "全体を通して、似ている、あるいは同じことを聞かれていると感じた質問はありましたか？" }),
      bindText(h("textarea", { rows: 3 }), e, "similar_free_text"),
      h("label", { text: "あった場合、どの質問ですか（本人が挙げたものだけ）" }), checks,
      h("p", { class: "note", text: "実施者から質問の組を示さない。" }),
      h("h2", { text: "「良い人・有能な人・賢い人に見えたか」（最大2問）" }),
      h("label", { text: "1問目の対象" }), sel(0, "c_target"), bindText(h("textarea", { rows: 2 }), e.q5[0], "response"),
      h("label", { text: "2問目の対象" }), sel(1, "h1_comparison"), bindText(h("textarea", { rows: 2 }), e.q5[1], "response"),
      h("label", { text: "メモ" }), bindText(h("textarea", { rows: 2 }), e, "note"),
      h("div", { class: "row" },
        h("button", { text: "← 深掘りへ", onclick: () => { S.phase = "probe"; S.probe_index = S.probe_plan.length - 1; saveDraft(); render(); } }),
        h("button", { class: "primary", style: "margin-top:0", text: "記録を完了する", onclick: () => { S.finished_at = nowIso(); S.phase = "done"; saveDraft(); render(); } })));
  }

  // ---------- 5. 保存 ----------
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  function download(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = h("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function renderDone() {
    const sm = L.summary(S);
    const base = `cognitive_test_${S.participant.participant_id}_${stamp()}`;
    show(h("h1", { text: "記録が完了しました" }),
      h("div", { class: "card" },
        h("p", { text: `参加者：${S.participant.participant_id}（質問順 ${S.participant.order_pattern}）` }),
        h("p", { text: `回答：${sm.answered} / 18　深掘り：${sm.probed} / ${sm.probe_total}` }),
        sm.blank_reason_items ? h("p", { class: "warn", text: `理由が未記入の深掘りが ${sm.blank_reason_items} 問あります（意図的な空欄でなければ戻って記入してください）。` }) : null),
      h("button", { class: "primary", text: "CSVをダウンロード", onclick: () => download(base + ".csv", "text/csv;charset=utf-8", L.toCsv(D, S)) }),
      h("button", { class: "primary", text: "JSONをダウンロード", onclick: () => download(base + ".json", "application/json", L.toJson(D, S, nowIso())) }),
      h("p", { class: "note", text: "ダウンロード前にこのページを閉じないでください。データはこのブラウザ内にだけあり、外部には送信されていません。" }),
      h("div", { class: "row" },
        h("button", { text: "← 終了質問を直す", onclick: () => { S.phase = "end"; saveDraft(); render(); } }),
        h("button", { text: "新しい参加者", onclick: () => { if (confirm("次の参加者を始めます。ダウンロード済みか確認しましたか？ このブラウザの保存データは消えます。")) { clearDraft(); S = null; renderSetup(); } } })));
  }

  function render() {
    if (!S) return renderSetup();
    ({ handoff: renderHandoff, quiz: renderQuiz, probe_intro: renderProbeIntro, probe: renderProbe,
       break: renderBreak, end: renderEnd, done: renderDone })[S.phase]();
  }

  // 検証用（本番には関係ない。研究者がブラウザのコンソールから状態を確認できる）
  window.COGTEST_TOOL = { state: () => S, csv: () => L.toCsv(D, S), json: () => L.toJson(D, S, nowIso()) };
  renderSetup();
})();
