import type { RepoWriteResult } from "../../features/workflow/types";
import type { RepositorySnapshot } from "../../features/repository/types";
import "./RepositoryChanges.css";

function formatChangeType(value: string) {
  const typeMap: Record<string, string> = {
    added: "新增",
    created: "新增",
    deleted: "删除",
    modified: "修改",
    renamed: "重命名",
    updated: "更新",
  };
  return typeMap[value] ?? value;
}

export function RepositoryChanges({ repository, result }: { repository: RepositorySnapshot; result?: RepoWriteResult }) {
  return (
    <section className="repository-changes">
      <header>
        <span>沙箱仓库</span>
        <h3>{repository.name}</h3>
        <p>{repository.branch} · {repository.baseCommit}</p>
      </header>
      <div className="repository-changes__list">
        {(result?.filesChanged ?? []).map((file) => (
          <article key={file.path}>
            <b>{file.path}</b>
            <small>{formatChangeType(file.changeType)} · +{file.additions} / -{file.deletions}</small>
          </article>
        ))}
        {!result?.filesChanged?.length ? <p className="repository-changes__empty">等待写入代码库后展示文件变更。</p> : null}
      </div>
    </section>
  );
}
