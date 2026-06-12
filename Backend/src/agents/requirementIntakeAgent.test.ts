import { describe, expect, it } from "vitest";
import { deriveFallbackTitle } from "./requirementIntakeAgent.js";

describe("deriveFallbackTitle", () => {
  it("summarizes a long requirement into a semantic title", () => {
    expect(deriveFallbackTitle("在文章详情页展示正文纯文本字数，保持现有样式，并补充计算逻辑测试。"))
      .toBe("文章详情页展示字数");
  });

  it("does not concatenate punctuation-stripped raw text", () => {
    const title = deriveFallbackTitle("请帮我在登录页修复 OAuth 回调失败的问题，然后补充错误态测试");

    expect(title).toBe("登录页修复 OAuth 回调失败的问题");
    expect(title).not.toContain("然后补充");
  });

  it("keeps useful field names without cutting them in the middle", () => {
    expect(deriveFallbackTitle("文章详情页新增字数统计，前端根据 Article.body 计算，并在合适位置展示。"))
      .toBe("文章详情页新增字数统计");
  });
});
