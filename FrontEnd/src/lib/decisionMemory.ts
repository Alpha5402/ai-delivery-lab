import type { WorkflowStepId } from "../features/workflow/types";

export type StructuredFeedbackDraft = {
  questionFeedback: Record<string, string>;
  selectedOptions: Record<string, string[]>;
  generalFeedback: string;
};

/** 检查是否有任何待提交的结构化反馈 */
export function hasStructuredFeedbackDraft(draft: StructuredFeedbackDraft): boolean {
  if (draft.generalFeedback.trim()) return true;
  if (Object.values(draft.questionFeedback).some((v) => v.trim())) return true;
  if (Object.values(draft.selectedOptions).some((arr) => arr.length > 0)) return true;
  return false;
}

/** 构建结构化反馈消息 */
export function buildStructuredFeedbackMessage(opts: {
  draft: StructuredFeedbackDraft;
  questions?: Array<{ id: string; question: string }>;
}): string | null {
  const { draft, questions = [] } = opts;
  const parts: string[] = [];

  for (const q of questions) {
    const feedback = draft.questionFeedback[q.id]?.trim();
    const selected = draft.selectedOptions[q.id];
    if (selected?.length || feedback) {
      const qParts: string[] = [`问题：${q.question}`];
      if (selected?.length) qParts.push(`选择：${selected.join("、")}`);
      if (feedback) qParts.push(`自定义补充：${feedback}`);
      parts.push(qParts.join("\n"));
    }
  }

  if (draft.generalFeedback.trim()) {
    parts.push(`整体补充：${draft.generalFeedback.trim()}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export type DecisionMemoryItem = {
  id: string;
  title: string;
  type: "business-rule" | "display-rule" | "technical-constraint" | "risk" | "preference" | "other";
  content: string;
  target?: string;
  source: "user-confirmed" | "user-feedback" | "option-selection";
  sourceStepId?: WorkflowStepId;
  sourceStepLabel?: string;
  updatedAt: string;
};

function classifyDecisionType(text: string): DecisionMemoryItem["type"] {
  const t = text.toLowerCase();
  if (/展示|显示|格式|位置|布局|样式|UI|颜色/.test(t)) return "display-rule";
  if (/统计|计算|业务|规则|逻辑|算法|数据/.test(t)) return "business-rule";
  if (/接口|API|字段|组件|模块|测试|schema|类型/.test(t)) return "technical-constraint";
  if (/风险|避免|不要|不能|禁止|防止|依赖/.test(t)) return "risk";
  return "other";
}

type MessageInput = {
  id: string;
  role: string;
  content: string;
  stepId: WorkflowStepId;
  createdAt: string;
};

export function parseDecisionMemoryItems(messages: MessageInput[]): DecisionMemoryItem[] {
  const items: DecisionMemoryItem[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const blocks = message.content.split(/\n\n+/).filter(Boolean);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const questionMatch = block.match(/^问题[：:]\s*(.+)$/m);
      const selectionMatch = block.match(/^选择[：:]\s*(.+)$/m);
      const noteMatch = block.match(/^说明[：:]\s*(.+)$/m);
      const customMatch = block.match(/^自定义补充[：:]\s*([\s\S]+)$/m);
      const generalMatch = block.match(/^整体补充[：:]\s*([\s\S]+)$/m);
      const feedbackMatch = block.match(/我的反馈[：:]([\s\S]+)/);

      if (questionMatch && selectionMatch) {
        const title = questionMatch[1].trim().slice(0, 24);
        items.push({
          id: `${message.id}-sel-${i}`,
          title: title || "已确认决策",
          type: classifyDecisionType(title),
          content: selectionMatch[1].trim(),
          source: "option-selection",
          sourceStepId: message.stepId,
          updatedAt: message.createdAt,
        });
        if (noteMatch) {
          items.push({
            id: `${message.id}-note-${i}`,
            title: `${title} · 说明`,
            type: classifyDecisionType(noteMatch[1]),
            content: noteMatch[1].trim(),
            source: "user-feedback",
            sourceStepId: message.stepId,
            updatedAt: message.createdAt,
          });
        }
        if (customMatch && customMatch[1].trim()) {
          items.push({
            id: `${message.id}-custom-${i}`,
            title: `${title} · 自定义`,
            type: "preference",
            content: customMatch[1].trim(),
            source: "user-feedback",
            sourceStepId: message.stepId,
            updatedAt: message.createdAt,
          });
        }
      } else if (generalMatch) {
        const content = generalMatch[1].trim();
        items.push({
          id: `${message.id}-general-${i}`,
          title: "整体约束",
          type: classifyDecisionType(content),
          content,
          source: "user-feedback",
          sourceStepId: message.stepId,
          updatedAt: message.createdAt,
        });
      } else if (feedbackMatch) {
        const content = feedbackMatch[1].trim();
        items.push({
          id: `${message.id}-fb-${i}`,
          title: content.slice(0, 24),
          type: classifyDecisionType(content),
          content,
          source: "user-feedback",
          sourceStepId: message.stepId,
          updatedAt: message.createdAt,
        });
      } else {
        const content = block.trim();
        items.push({
          id: `${message.id}-raw-${i}`,
          title: content.slice(0, 18),
          type: "other",
          content,
          source: "user-confirmed",
          sourceStepId: message.stepId,
          updatedAt: message.createdAt,
        });
      }
    }
  }
  return items;
}
