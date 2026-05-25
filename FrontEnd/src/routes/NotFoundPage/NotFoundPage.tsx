import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="workbench">
      <section className="panel-heading">
        <span>Route Missing</span>
        <h2>这个页面还没有接入交付链路。</h2>
        <p><Link to="/start">回到 /start</Link></p>
      </section>
    </main>
  );
}
