/**
 * ask 工具提问的飞书呈现层（纯函数，无 IO）：问题 → interactive 卡片 JSON、按钮回调 → 答案。
 *
 * 卡片固定用 interactive 1.0（elements + action 模块）。只有 1.0 静态卡能安全走
 * transport.updateCard 原地刷新，且卡片回调必须返回与卡片同版本的 JSON，混用 CardKit 2.0
 * 会触发 200830/200671。因此多选与自由输入都用 1.0 能表达的方式实现：
 * - 多选：按钮点按切换选中态（回调返回刷新后的卡），选中后出现「提交」；
 * - 自由输入：「其他」按钮把该问题置为等待文本，用户在话题里直接回复，由网关消费；
 * - 原生富表单的 preview 在飞书没有等价物，忽略；备注用同一个等待文本通道。
 */

export type AskOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type AskQuestion = {
  id: string;
  question: string;
  options: AskOption[];
  header?: string;
  multi?: boolean;
  recommended?: number;
};

export type AskAnswer = {
  selectedOptions: string[];
  customInput?: string;
  note?: string;
};

export type AskResult = {
  question: AskQuestion;
  answer: AskAnswer;
};

export type AskCardStatus = "pending" | "done" | "terminal" | "expired";

export type AskCardState = {
  runId: string;
  questions: AskQuestion[];
  answers: ReadonlyMap<string, AskAnswer>;
  /** 已提交的多选题；有勾选但未提交时必须继续显示按钮和提交入口。 */
  submitted: ReadonlySet<string>;
  status: AskCardStatus;
  /** 等待用户在话题里回复文本的目标：其他答案或备注。 */
  awaiting?: { questionId: string; kind: "other" | "note" };
};

export type AskActionKind = "option" | "toggle" | "submit" | "other" | "note";

export type AskActionValue = {
  runId: string;
  questionId: string;
  kind: AskActionKind;
  label?: string;
};

export const ASK_ACTION = "pi_feishu_ask_answer";

/** 超过该选项数就降级成编号列表 + 自由回复：一排按钮挤太多选项在飞书里读不出来。 */
const MAX_OPTION_BUTTONS = 5;
/** 单条问题正文上限，防止超长选项列表把卡片顶爆。 */
const MAX_QUESTION_CHARS = 1500;

type AskButton = {
  tag: "button";
  type: "default" | "primary";
  text: { tag: "plain_text"; content: string };
  value: { action: typeof ASK_ACTION; runId: string; questionId: string; kind: AskActionKind; label?: string };
};

/** 校验模型传入的 questions；非法输入直接抛错，避免把坏数据渲染成卡片。 */
export function parseAskQuestions(value: unknown): AskQuestion[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("ask 需要至少一个问题。");
  return value.map((raw, index) => {
    const item = asRecord(raw);
    if (!item) throw new Error(`第 ${index + 1} 个问题不是对象。`);
    const id = nonEmptyString(item.id) ?? `q${index + 1}`;
    const question = nonEmptyString(item.question);
    if (!question) throw new Error(`第 ${index + 1} 个问题缺少 question 文本。`);
    const options = Array.isArray(item.options)
      ? item.options.map((option, optionIndex) => parseAskOption(option, id, optionIndex))
      : [];
    return {
      id,
      question,
      options,
      header: nonEmptyString(item.header),
      multi: item.multi === true,
      recommended: typeof item.recommended === "number" && Number.isInteger(item.recommended) ? item.recommended : undefined,
    };
  });
}

export function parseAskActionValue(value: unknown): AskActionValue | undefined {
  const raw = asRecord(value);
  if (!raw || raw.action !== ASK_ACTION) return undefined;
  const runId = nonEmptyString(raw.runId);
  const questionId = nonEmptyString(raw.questionId);
  if (!runId || !questionId) return undefined;
  const kind = raw.kind;
  if (kind !== "option" && kind !== "toggle" && kind !== "submit" && kind !== "other" && kind !== "note") return undefined;
  return { runId, questionId, kind, label: nonEmptyString(raw.label) };
}

export function emptyAnswer(): AskAnswer {
  return { selectedOptions: [] };
}

/** 只有选了选项或给了自由答案才算答完；仅填备注不算。 */
export function isAnswered(answer: AskAnswer | undefined): boolean {
  if (!answer) return false;
  return answer.selectedOptions.length > 0 || (answer.customInput !== undefined && answer.customInput !== "");
}

export function buildAskCard(state: AskCardState): object {
  const elements: object[] = [];
  const awaiting = state.awaiting;
  state.questions.forEach((question, index) => {
    if (index > 0) elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: questionTitle(question) } });
    const answer = state.answers.get(question.id);
    // 多选题勾选后仍算未答完：卡片必须继续显示按钮与「提交」，否则用户在卡上无法结束这一题。
    const settled = isAnswered(answer) && (!question.multi || state.submitted.has(question.id));
    if (settled) {
      elements.push({ tag: "div", text: { tag: "lark_md", content: answeredText(answer!) } });
      return;
    }
    if (awaiting?.questionId === question.id) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: awaiting.kind === "note"
            ? "⌨️ 请在话题里直接回复补充说明，回复后会并入这条问题的答案。"
            : "⌨️ 请在话题里直接回复你想要的答案文本。",
        },
      });
      return;
    }
    if (state.status !== "pending") return;
    if (question.options.length > MAX_OPTION_BUTTONS) {
      elements.push({ tag: "div", text: { tag: "lark_md", content: numberedOptions(question) } });
      elements.push({ tag: "action", actions: [askButton(state.runId, question.id, "other", "✏️ 回复编号或文字")] });
      return;
    }
    const actions: AskButton[] = [];
    question.options.forEach((option, optionIndex) => {
      const selected = answer?.selectedOptions?.includes(option.label) === true;
      actions.push(askButton(
        state.runId,
        question.id,
        question.multi ? "toggle" : "option",
        `${selected ? "✅ " : ""}${option.label}${question.recommended === optionIndex ? " (推荐)" : ""}`,
        question.multi || selected ? "primary" : "default",
        option.label,
      ));
      const description = option.description?.trim();
      if (description) elements.push({ tag: "div", text: { tag: "lark_md", content: `　　${truncate(description, 200)}` } });
    });
    elements.push({ tag: "action", actions });
    const secondary: AskButton[] = [];
    if (question.multi && answer?.selectedOptions?.length) {
      secondary.push(askButton(state.runId, question.id, "submit", `提交（已选 ${answer.selectedOptions.length} 项）`, "primary"));
    }
    secondary.push(askButton(state.runId, question.id, "other", "✏️ 其他（回复文本）"));
    secondary.push(askButton(state.runId, question.id, "note", "📝 补充说明"));
    elements.push({ tag: "action", actions: secondary });
    if (question.multi && answer?.selectedOptions?.length) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: `⏳ 已勾选 ${answer.selectedOptions.length} 项，点上面的「提交」才会结束这一题。` },
      });
    }
  });

  const footer = statusText(state);
  if (footer) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: footer } });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: headerTemplate(state.status),
      title: { tag: "plain_text", content: titleForStatus(state.status) },
    },
    elements,
  };
}

/** ask 工具返回给模型的文本：对齐原生 ask 的 text 结构。 */
export function formatAskText(results: AskResult[]): string {
  if (results.length === 1) return answerText(results[0].answer);
  return ["User answers:", ...results.map((item) => `${item.question.id}: ${answerText(item.answer)}`)].join("\n");
}

/** ask 工具返回给模型的 details：单问题扁平、多问题 results 数组，与原生一致。 */
export function formatAskDetails(results: AskResult[]): Record<string, unknown> {
  if (results.length === 1) {
    const details = resultEntry(results[0]);
    const { id: _id, ...single } = details;
    return single;
  }
  return { results: results.map(resultEntry) };
}

function resultEntry(item: AskResult): Record<string, unknown> {
  const details: Record<string, unknown> = {
    id: item.question.id,
    question: item.question.question,
    options: item.question.options,
    multi: item.question.multi === true,
    selectedOptions: item.answer.selectedOptions,
  };
  if (item.answer.customInput !== undefined) details.customInput = item.answer.customInput;
  if (item.answer.note !== undefined) details.note = item.answer.note;
  return details;
}

function answerText(answer: AskAnswer): string {
  const parts: string[] = [];
  if (answer.customInput !== undefined && answer.customInput !== "") parts.push(answer.customInput);
  if (answer.selectedOptions.length) parts.push(answer.selectedOptions.join(", "));
  let text = parts.join(" / ") || "(未选择)";
  if (answer.note) text += `\nUser added note: ${answer.note}`;
  return text;
}

function answeredText(answer: AskAnswer) {
  const lines: string[] = [];
  if (answer.selectedOptions.length) {
    lines.push(`✅ 已选：${answer.selectedOptions.join("、")}`);
  } else if (answer.customInput) {
    lines.push(`✅ 已答：${truncate(answer.customInput, 300)}`);
  } else {
    lines.push("✅ 已作答");
  }
  if (answer.note) lines.push(`📝 备注：${truncate(answer.note, 300)}`);
  return lines.join("\n");
}

function questionTitle(question: AskQuestion) {
  const chip = question.header ? `【${question.header}】` : "";
  const type = question.multi ? "（可多选）" : "";
  return `**${truncate(`${chip}${question.question}`, MAX_QUESTION_CHARS)}**${type}`;
}

function numberedOptions(question: AskQuestion) {
  return question.options
    .map((option, index) => `${index + 1}. ${option.label}${option.description ? ` —— ${truncate(option.description, 120)}` : ""}`)
    .join("\n");
}

function askButton(
  runId: string,
  questionId: string,
  kind: AskActionKind,
  content: string,
  type: "default" | "primary" = "default",
  label?: string,
): AskButton {
  return {
    tag: "button",
    type,
    text: { tag: "plain_text", content: truncate(content, 60) },
    value: { action: ASK_ACTION, runId, questionId, kind, label },
  };
}

function statusText(state: AskCardState): string | undefined {
  if (state.status === "pending" && state.questions.length > 1) {
    const done = state.questions.filter((question) => isAnswered(state.answers.get(question.id)) && (!question.multi || state.submitted.has(question.id))).length;
    const unsubmitted = state.questions.filter((question) => question.multi && state.answers.get(question.id)?.selectedOptions?.length && !state.submitted.has(question.id)).length;
    return `进度：已答 ${done}/${state.questions.length} 题。${unsubmitted ? "有已勾选但未提交的多选题。" : ""}`;
  }
  if (state.status === "done") return "✅ 问题已全部回答，答案已返回终端会话。";
  if (state.status === "terminal") return "🖥 已在终端回答，本卡片已失效。";
  if (state.status === "expired") return "提问已结束：终端会话离线或已切换。";
  return undefined;
}

function titleForStatus(status: AskCardStatus) {
  if (status === "done") return "✅ 已作答";
  if (status === "terminal") return "🖥 已在终端回答";
  if (status === "expired") return "已结束";
  return "❓ 需要你的回答";
}

function headerTemplate(status: AskCardStatus) {
  if (status === "done") return "green";
  return "blue";
}

function parseAskOption(option: unknown, questionId: string, index: number): AskOption {
  if (typeof option === "string") {
    if (!option.trim()) throw new Error(`问题 ${questionId} 的第 ${index + 1} 个选项为空。`);
    return { label: option };
  }
  const item = asRecord(option);
  if (!item) throw new Error(`问题 ${questionId} 的第 ${index + 1} 个选项无效。`);
  const label = nonEmptyString(item.label);
  if (!label) throw new Error(`问题 ${questionId} 的第 ${index + 1} 个选项缺少 label。`);
  return {
    label,
    description: typeof item.description === "string" ? item.description : undefined,
    preview: typeof item.preview === "string" ? item.preview : undefined,
  };
}

/** 只做“是普通对象”这一层收窄；字段一律用 typeof 逐个校验。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
