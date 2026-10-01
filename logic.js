// 認知テストツールの純粋なロジック（画面なし）。ブラウザでもnodeでも動く。研究専用。
// 外部通信は一切しない。質問・順序・割当は questions_data.js（cognitive_test_v1.md から生成）だけを使う。
(function (root) {
  "use strict";

  const EXTRA_COLUMNS = ["first_answer", "answer_changed", "change_count", "first_response_time_ms", "final_response_time_ms", "tool_version"];

  // 参加者IDの末尾の数字が奇数ならA、偶数ならB（cognitive_test_v1.md 5節）
  function parseParticipantId(raw) {
    const id = String(raw || "").trim();
    const m = /^[A-Za-z]*(\d+)$/.exec(id);
    if (!m) return { ok: false, id, error: "参加者IDは、末尾が数字の形式にしてください（例：P01）" };
    const last = Number(id[id.length - 1]);
    return { ok: true, id, number: Number(m[1]), pattern: last % 2 === 1 ? "A" : "B" };
  }

  // 深掘りのアンカー2問（H5-Q10/Q22のどちらか1問＋H6/H8の1問）。表にあるIDだけ自動、他は手動指定
  function anchorsFor(data, id) {
    const key = String(id || "").trim().toUpperCase();
    const hit = data.rotation[key];
    return hit ? { h5: hit.h5, h68: hit.h68, manual: false } : null;
  }

  // 深掘り対象：C 4問（完全）＋H1 4問（短縮）＋アンカー2問（短縮）。提示順に並べる
  function planProbes(data, pattern, anchors) {
    const order = data.orders[pattern];
    const chosen = new Set();
    for (const qid of order) {
      const role = data.questions[qid].item_role;
      if (role === "c_target" || role === "h1_comparison") chosen.add(qid);
    }
    chosen.add(anchors.h5);
    chosen.add(anchors.h68);
    return order.filter((q) => chosen.has(q)).map((q) => ({ question_id: q, tier: data.questions[q].probe_tier }));
  }

  function newSession(data, profile, anchors, nowIso) {
    const p = parseParticipantId(profile.participant_id);
    if (!p.ok) throw new Error(p.error);
    return {
      tool_version: data.tool_version,
      source_doc: data.source_doc,
      source_sha256_12: data.source_sha256_12,
      participant: {
        participant_id: p.id, order_pattern: p.pattern,
        age_band: profile.age_band, gender_optional: profile.gender_optional || "",
        status: profile.status, work_experience: profile.work_experience, managerial_experience: profile.managerial_experience,
      },
      anchors,
      order: data.orders[p.pattern].slice(),
      probe_plan: planProbes(data, p.pattern, anchors),
      started_at: nowIso,
      finished_at: null,
      phase: "handoff", // handoff → quiz → probe_intro → probe → break → end → done
      position: 0,       // 0始まりの現在の質問位置
      last_action_was_back: false,
      answers: {},
      events: [],
      probes: {},
      probe_index: 0,
      end: { similar_free_text: "", similar_positions: [], q5: [{ question_id: "", response: "" }, { question_id: "", response: "" }], note: "" },
    };
  }

  // 回答の確定。first_* は最初の回答、final_* は最後に表示されたときの回答
  function recordAnswer(session, qid, answer, elapsedMs) {
    if (!["left", "right", "up"].includes(answer)) throw new Error("answer must be left/right/up");
    const prev = session.answers[qid];
    const position = session.order.indexOf(qid) + 1;
    if (!prev) {
      session.answers[qid] = {
        position, answer, first_answer: answer, first_response_time_ms: Math.round(elapsedMs),
        final_response_time_ms: Math.round(elapsedMs), change_count: 0, changes: [],
      };
    } else {
      if (prev.answer !== answer) {
        prev.change_count += 1;
        prev.changes.push({ from: prev.answer, to: answer });
      }
      prev.answer = answer;
      prev.final_response_time_ms = Math.round(elapsedMs);
    }
    return session.answers[qid];
  }

  // 直前の1問だけ戻れる。戻った直後は、もう一度回答するまで連続では戻れない
  function canGoBack(session) {
    return session.phase === "quiz" && session.position > 0 && !session.last_action_was_back;
  }

  function goBack(session, tMs) {
    if (!canGoBack(session)) return false;
    session.events.push({ t_ms: Math.round(tMs), type: "back", from_position: session.position + 1, to_position: session.position });
    session.position -= 1;
    session.last_action_was_back = true;
    return true;
  }

  function emptyProbe(tier) {
    return {
      probe_tier: tier, free_reason: "", opposite_rejection_reason: "", perceived_construct: "",
      context_changes: "", context_variation_note: "", misunderstanding_flag: false, misunderstanding_note: "",
      paraphrase: "", social_desirability_flag: false, recall_failure_flag: false, interviewer_note: "",
    };
  }

  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function flag01(probed, v) { return probed ? (v ? "1" : "0") : ""; }

  // CSV：cognitive_test_response_template.csv の26列をそのまま先頭に置き、追加列を後ろへ
  function buildRows(data, s) {
    const rows = [];
    const q5 = {};
    for (const x of s.end.q5) if (x.question_id) q5[x.question_id] = x.response;
    s.order.forEach((qid, i) => {
      const q = data.questions[qid], a = s.answers[qid] || {}, pr = s.probes[qid];
      const probed = !!pr;
      const notes = [];
      if (pr && pr.misunderstanding_note) notes.push("[読みにくい/意味が分からない] " + pr.misunderstanding_note);
      if (pr && pr.paraphrase) notes.push("[言い換え] " + pr.paraphrase);
      if (pr && pr.interviewer_note) notes.push(pr.interviewer_note);
      rows.push({
        participant_id: s.participant.participant_id, order_pattern: s.participant.order_pattern,
        age_band: s.participant.age_band, gender_optional: s.participant.gender_optional,
        work_experience: s.participant.work_experience, managerial_experience: s.participant.managerial_experience,
        status: s.participant.status, question_id: qid, dimension_internal: q.dimension_internal, item_role: q.item_role,
        position: i + 1, answer: a.answer || "",
        response_time_sec: a.first_response_time_ms != null ? (a.first_response_time_ms / 1000).toFixed(3) : "",
        probe_tier: probed ? pr.probe_tier : "",
        free_reason: probed ? pr.free_reason : "", opposite_rejection_reason: probed ? pr.opposite_rejection_reason : "",
        perceived_construct: probed ? pr.perceived_construct : "", context_variation_note: probed ? pr.context_variation_note : "",
        desirability_note: q5[qid] || "", reason_tag_primary: "", reason_tag_secondary: "",
        social_desirability_flag: flag01(probed, pr && pr.social_desirability_flag),
        context_dependency_flag: probed ? (pr.context_changes === "yes" ? "1" : pr.context_changes ? "0" : "") : "",
        misunderstanding_flag: flag01(probed, pr && pr.misunderstanding_flag),
        recall_failure_flag: flag01(probed, pr && pr.recall_failure_flag),
        interviewer_note: notes.join(" / "),
        first_answer: a.first_answer || "", answer_changed: a.change_count ? "1" : "0", change_count: a.change_count || 0,
        first_response_time_ms: a.first_response_time_ms != null ? a.first_response_time_ms : "",
        final_response_time_ms: a.final_response_time_ms != null ? a.final_response_time_ms : "",
        tool_version: s.tool_version,
      });
    });
    const e = s.end;
    rows.push({
      participant_id: s.participant.participant_id, order_pattern: s.participant.order_pattern,
      age_band: s.participant.age_band, gender_optional: s.participant.gender_optional,
      work_experience: s.participant.work_experience, managerial_experience: s.participant.managerial_experience,
      status: s.participant.status, question_id: "SESSION_END", dimension_internal: "", item_role: "session",
      free_reason: e.similar_free_text, perceived_construct: e.similar_positions.length ? "似ている質問(第N問): " + e.similar_positions.join(";") : "",
      interviewer_note: e.note, tool_version: s.tool_version,
    });
    return rows;
  }

  function toCsv(data, s) {
    const cols = data.template_columns.concat(EXTRA_COLUMNS);
    const lines = [cols.join(",")];
    for (const r of buildRows(data, s)) lines.push(cols.map((c) => csvEscape(r[c])).join(","));
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  function toJson(data, s, exportedAt) {
    return JSON.stringify({
      tool_version: s.tool_version, source_doc: s.source_doc, source_sha256_12: s.source_sha256_12, exported_at: exportedAt,
      note: "研究専用の認知テスト記録。診断結果は含まない。dimension_internalは研究者用の内部記録。",
      participant: s.participant, anchors: s.anchors, order: s.order, started_at: s.started_at, finished_at: s.finished_at,
      answers: s.order.map((qid) => Object.assign({ question_id: qid }, s.answers[qid] || {})),
      probe_plan: s.probe_plan, probes: s.probes, end_questions: s.end, events: s.events,
      rows: buildRows(data, s),
    }, null, 2);
  }

  // 完了前の確認：未回答・未記入の数
  function summary(s) {
    const answered = Object.keys(s.answers).length;
    const probed = s.probe_plan.filter((p) => s.probes[p.question_id]).length;
    let blank = 0;
    for (const p of s.probe_plan) {
      const pr = s.probes[p.question_id];
      if (!pr || !pr.free_reason.trim() || !pr.opposite_rejection_reason.trim()) blank += 1;
    }
    return { answered, probe_total: s.probe_plan.length, probed, blank_reason_items: blank };
  }

  const api = { EXTRA_COLUMNS, parseParticipantId, anchorsFor, planProbes, newSession, recordAnswer, canGoBack, goBack, emptyProbe, csvEscape, buildRows, toCsv, toJson, summary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.COGLOGIC = api;
})(typeof window !== "undefined" ? window : globalThis);
