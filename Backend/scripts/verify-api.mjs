const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3001/api";

async function request(path, options) {
  const response = await fetch(`${apiBaseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const checks = [
  async () => {
    const { response, body } = await request("/health");
    if (!response.ok || body.ok !== true) throw new Error("/health returned an unexpected payload");
    console.log("ok /health");
  },
  async () => {
    const { response, body } = await request("/workspaces/quick-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Verify Project", description: "API verification", stackPreference: "react-node" }),
    });
    if (!response.ok || body?.agentReadme?.fileName !== "readme-for-agent.mdc") {
      throw new Error("/workspaces/quick-project returned an unexpected payload");
    }
    console.log("ok /workspaces/quick-project");
  },
  async () => {
    const { response, body } = await request("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText: "在首页文章卡片展示阅读量", pattern: "frontend-only", targetRepo: "conduit" }),
    });
    if (response.status !== 201 || !Array.isArray(body.steps) || body.steps.length !== 8) {
      throw new Error("/workflows returned an unexpected payload");
    }
    console.log("ok /workflows");
  },
  async () => {
    const { response, body } = await request("/repository");
    if (!response.ok || typeof body.name !== "string" || typeof body.branch !== "string") {
      throw new Error("/repository returned an unexpected payload");
    }
    console.log("ok /repository");
  },
  async () => {
    const { response, body } = await request("/metrics");
    if (!response.ok || !Array.isArray(body)) {
      throw new Error("/metrics returned an unexpected payload");
    }
    console.log("ok /metrics");
  },
];

for (const check of checks) {
  await check();
}
