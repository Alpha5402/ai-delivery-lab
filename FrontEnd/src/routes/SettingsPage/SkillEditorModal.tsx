import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { createJsonSkill, updateJsonSkill, type SkillManifest } from "../../api/client";
import type { WorkflowStepId } from "../../features/workflow/types";
import { stepLabels } from "../../features/workflow/stepDefinitions";

const { TextArea } = Input;
const { Text } = Typography;

type SkillEditorProps = {
  open: boolean;
  editingSkill: SkillManifest | null; // null = create new
  onClose: (saved: boolean) => void;
};

type FormValues = {
  id: string;
  name: string;
  description: string;
  version: string;
  requirementPatterns: string[];
  scopes: string[];
  fileGlobs: string;
  routeHints: string;
  keywords: string;
  selectedSteps: string[];
  // per-step fields are collected from the form
};

function manifestToForm(skill: SkillManifest | null): FormValues {
  if (!skill) return {
    id: "", name: "", description: "", version: "1.0.0",
    requirementPatterns: [], scopes: [],
    fileGlobs: "", routeHints: "", keywords: "",
    selectedSteps: [],
  };
  return {
    id: skill.id,
    name: skill.name,
    description: (skill as { description?: string }).description ?? "",
    version: skill.version,
    requirementPatterns: [...skill.requirementPatterns],
    scopes: [...skill.scopes],
    fileGlobs: (skill.match.fileGlobs ?? []).join("\n"),
    routeHints: (skill.match.routeHints ?? []).join("\n"),
    keywords: (skill.match.keywords ?? []).join(", "),
    selectedSteps: Object.keys(skill.steps ?? {}),
  };
}

function formToManifest(values: FormValues, existingSteps?: Record<string, unknown>): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  const selected = values.selectedSteps ?? [];
  const stepInstructions = (values as Record<string, unknown>)._stepInstruction as Record<string, string> | undefined ?? {};
  for (const sid of selected) {
    const existing = (existingSteps ?? {})[sid] as Record<string, unknown> | undefined;
    const formInstruction = stepInstructions[sid]?.trim();
    steps[sid] = existing
      ? { ...existing, instructionAddon: formInstruction || (existing as { instructionAddon?: string }).instructionAddon || "" }
      : { instructionAddon: formInstruction || "" };
  }
  return {
    id: values.id,
    name: values.name,
    description: values.description || undefined,
    version: values.version,
    requirementPatterns: values.requirementPatterns ?? [],
    scopes: values.scopes ?? [],
    match: {
      keywords: (values.keywords ?? "").split(/[,;\n]+/).map((k) => k.trim()).filter(Boolean),
      fileGlobs: (values.fileGlobs ?? "").split("\n").map((g) => g.trim()).filter(Boolean),
      routeHints: (values.routeHints ?? "").split("\n").map((h) => h.trim()).filter(Boolean),
    },
    steps,
  };
}

export function SkillEditorModal({ open, editingSkill, onClose }: SkillEditorProps) {
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [jsonPreview, setJsonPreview] = useState(false);
  const isCreate = !editingSkill;

  useEffect(() => {
    if (open) {
      form.setFieldsValue(manifestToForm(editingSkill));
      // 回填每步的 instructionAddon 到 _stepInstruction
      if (editingSkill?.steps) {
        const instructions: Record<string, string> = {};
        for (const [sid, spec] of Object.entries(editingSkill.steps)) {
          const s = spec as { instructionAddon?: string };
          if (s.instructionAddon) instructions[sid] = s.instructionAddon;
        }
        form.setFieldsValue({ _stepInstruction: instructions } as Partial<FormValues> & { _stepInstruction: Record<string, string> });
      }
    }
  }, [open, editingSkill, form]);

  async function handleSubmit(values: FormValues) {
    setSaving(true);
    try {
      const manifest = formToManifest(values, (editingSkill?.steps ?? {}) as Record<string, unknown>);
      if (isCreate) {
        await createJsonSkill(manifest);
      } else {
        await updateJsonSkill(values.id, manifest);
      }
      message.success(isCreate ? "Skill 已创建" : "Skill 已更新");
      onClose(true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  const patternOptions = [
    { label: "frontend-only", value: "frontend-only" },
    { label: "cross-stack", value: "cross-stack" },
    { label: "interaction", value: "interaction" },
    { label: "unclear", value: "unclear" },
  ];
  const scopeOptions = [
    { label: "frontend", value: "frontend" },
    { label: "backend", value: "backend" },
    { label: "fullstack", value: "fullstack" },
  ];
  const stepOptions = Object.entries(stepLabels).map(([id, label]) => ({ label: `${label} (${id})`, value: id }));

  const values = Form.useWatch([], form) as FormValues | undefined;
  const previewManifest = values ? formToManifest(values) : null;

  return (
    <Modal
      open={open}
      title={isCreate ? "新增 Skill" : `编辑 ${editingSkill?.name ?? editingSkill?.id}`}
      width={640}
      onCancel={() => onClose(false)}
      footer={null}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit} initialValues={manifestToForm(editingSkill)}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Form.Item name="id" label="ID" rules={[{ required: true, pattern: /^[a-z0-9][-a-z0-9]*[a-z0-9]?$/i, message: "slug 格式" }]} style={{ flex: 1 }}>
            <Input disabled={!isCreate} placeholder="my-skill-id" />
          </Form.Item>
          <Form.Item name="version" label="Version" initialValue="1.0.0" style={{ width: 100 }}>
            <Input placeholder="1.0.0" />
          </Form.Item>
        </Space>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input placeholder="Skill 名称" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <TextArea rows={2} placeholder="简要描述该 Skill 的用途" />
        </Form.Item>
        <Form.Item name="requirementPatterns" label="需求模式">
          <Select mode="multiple" options={patternOptions} placeholder="选择适用的需求模式" />
        </Form.Item>
        <Form.Item name="scopes" label="技术范围">
          <Select mode="multiple" options={scopeOptions} placeholder="选择适用的技术范围" />
        </Form.Item>
        <Form.Item name="selectedSteps" label="影响步骤">
          <Select mode="multiple" options={stepOptions} placeholder="选择该 Skill 影响的 workflow step" />
        </Form.Item>
        <Form.Item shouldUpdate={(prev, cur) => prev.selectedSteps !== cur.selectedSteps} noStyle>
          {({ getFieldValue }) => {
            const steps: string[] = getFieldValue("selectedSteps") ?? [];
            if (steps.length === 0) return null;
            return (
              <div style={{ marginBottom: 16 }}>
                <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>步骤提示词配置</Text>
                {steps.map((sid) => (
                  <Form.Item key={sid} name={["_stepInstruction", sid]} label={`${stepLabels[sid as WorkflowStepId] ?? sid} 提示词`} style={{ marginBottom: 8 }}>
                    <TextArea rows={2} placeholder={`针对 ${sid} 的约束和提示`} />
                  </Form.Item>
                ))}
              </div>
            );
          }}
        </Form.Item>
        <Form.Item name="fileGlobs" label="文件规则（一行一个 glob）">
          <TextArea rows={3} placeholder={"src/components/**/*.tsx\nsrc/hooks/**"} />
        </Form.Item>
        <Form.Item name="routeHints" label="路由提示（一行一个 hint）">
          <TextArea rows={2} placeholder={"Article\nmarkdown\ncomponent"} />
        </Form.Item>
        <Form.Item name="keywords" label="检索关键词（逗号/换行分隔，留空自动生成）">
          <TextArea rows={2} placeholder="留空则由 Agent 自动生成" />
        </Form.Item>

        <Tabs
          items={[{
            key: "form",
            label: "表单",
            children: null,
          }, {
            key: "json",
            label: "预览 JSON",
            children: previewManifest ? (
              <pre style={{ fontSize: 11, maxHeight: 300, overflow: "auto", background: "#f5f5f5", padding: 8, borderRadius: 4 }}>
                {JSON.stringify(previewManifest, null, 2)}
              </pre>
            ) : <Text type="secondary">请填写表单后查看 JSON 预览</Text>,
          }]}
          style={{ marginBottom: 12 }}
        />

        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>
            {isCreate ? "创建" : "保存"}
          </Button>
          <Button onClick={() => onClose(false)}>取消</Button>
        </Space>
      </Form>
    </Modal>
  );
}
