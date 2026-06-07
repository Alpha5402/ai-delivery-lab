import type { CodeGenerationPlan, WorkflowRun } from "../domain/workflow.js";

/**
 * Golden path: 前端计算指标展示 → 自动生成可落盘的 CodeGenerationPlan。
 * 仅对 article word count / reading time 类需求生效。
 */

const GOLDEN_SIGNALS = [
  "字数统计", "阅读时长", "预计阅读", "word count", "reading time",
  "统计字数", "阅读时间", "文章详情",
];

const ARTICLE_PATCH = `import Markdown from "markdown-to-jsx";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import ArticleMeta from "../../components/ArticleMeta";
import ArticlesButtons from "../../components/ArticlesButtons";
import ArticleTags from "../../components/ArticleTags";
import BannerContainer from "../../components/BannerContainer";
import { useAuth } from "../../context/AuthContext";
import getArticle from "../../services/getArticle";

/** 统计纯文本字数（排除空白和 Markdown 标记） */
function countWords(text) {
  if (!text) return 0;
  const cleaned = text
    .replace(/[#*_~>\\-\`\\[\\]()!|]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return 0;
  return cleaned.split(/\\s+/).length;
}

/** 按平均阅读速度估算阅读时长（分钟） */
function estimateReadingTime(wordCount, wordsPerMinute = 250) {
  if (wordCount === 0) return "< 1";
  const minutes = Math.ceil(wordCount / wordsPerMinute);
  return String(minutes);
}

function Article() {
  const { state } = useLocation();
  const [article, setArticle] = useState(state || {});
  const { title, body, tagList, createdAt, author } = article || {};
  const { headers, isAuth } = useAuth();
  const navigate = useNavigate();
  const { slug } = useParams();

  useEffect(() => {
    if (state) return;
    getArticle({ slug, headers })
      .then(setArticle)
      .catch((error) => {
        console.error(error);
        navigate("/not-found", { replace: true });
      });
  }, [isAuth, slug, headers, state, navigate]);

  const wordCount = countWords(body);
  const readingTime = estimateReadingTime(wordCount);

  return (
    <div className="article-page">
      <BannerContainer>
        <h1>{title}</h1>
        <ArticleMeta author={author} createdAt={createdAt}>
          <ArticlesButtons article={article} setArticle={setArticle} />
        </ArticleMeta>
      </BannerContainer>

      <div className="container page">
        <div className="row article-content">
          <div className="col-md-12">
            {body && <Markdown options={{ forceBlock: true }}>{body}</Markdown>}
            <div className="article-stats" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #e5e5e5", color: "#999", fontSize: 13 }}>
              <span>共 {wordCount} 字</span>
              <span style={{ marginLeft: 16 }}>预计阅读 {readingTime} 分钟</span>
            </div>
            <ArticleTags tagList={tagList} />
          </div>
        </div>

        <hr />

        <div className="article-actions">
          <ArticleMeta author={author} createdAt={createdAt}>
            <ArticlesButtons article={article} setArticle={setArticle} />
          </ArticleMeta>
        </div>

        <Outlet />
      </div>
    </div>
  );
}

export default Article;
`;

/**
 * 检查需求文本和 workspace 是否符合 golden path 条件。
 * 返回 CodeGenerationPlan 或 null（走 LLM）。
 */
export function tryGoldenPathCodegen(
  run: WorkflowRun,
  workspace?: { repositoryScan?: { fileTree?: string[] } },
): CodeGenerationPlan | null {
  const requirement = run.steps.find((s) => s.id === "requirement_intake")?.output as
    | { rawText?: string }
    | undefined;
  const rawText = (requirement?.rawText ?? run.title ?? "").toLowerCase();

  const hasSignal = GOLDEN_SIGNALS.some((s) => rawText.includes(s.toLowerCase()));
  if (!hasSignal) return null;

  // 确认 workspace 中存在目标文件
  const fileTree = workspace?.repositoryScan?.fileTree ?? [];
  const hasTarget = fileTree.some((f) =>
    f.includes("Article.jsx") || f.includes("routes/Article"),
  );
  if (fileTree.length > 0 && !hasTarget) return null; // 有 fileTree 但没有目标文件 → 不触发

  return {
    strategy: "前端计算指标展示 golden path：为 Article 页面添加字数统计和预计阅读时长",
    tasks: [
      {
        id: "gp-1",
        title: "修改 Article 页面，添加 countWords / estimateReadingTime 辅助函数，并在正文下方展示字数和预计阅读时长",
        files: ["frontend/src/routes/Article/Article.jsx"],
        testRequired: true,
      },
    ],
    patches: [
      {
        path: "frontend/src/routes/Article/Article.jsx",
        changeType: "modified",
        content: ARTICLE_PATCH,
      },
    ],
  };
}
