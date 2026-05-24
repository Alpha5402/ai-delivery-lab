import type { RepoWriteResult } from "../../features/workflow/types";
import type { RepositorySnapshot } from "../../features/repository/types";
import "./RepositoryChanges.css";

export function RepositoryChanges({ repository, result }: { repository: RepositorySnapshot; result?: RepoWriteResult }) {
  return (
    <section className="repository-changes">
      <header>
        <span>Sandbox Repo</span>
        <h3>{repository.name}</h3>
        <p>{repository.branch} · {repository.baseCommit}</p>
      </header>
      <div className="repository-changes__list">
        {(result?.filesChanged ?? []).map((file) => (
          <article key={file.path}>
            <b>{file.path}</b>
            <small>{file.changeType} · +{file.additions} / -{file.deletions}</small>
          </article>
        ))}
        {!result?.filesChanged?.length ? <p className="repository-changes__empty">等待写入 Conduit 后展示文件变更。</p> : null}
      </div>
    </section>
  );
}
