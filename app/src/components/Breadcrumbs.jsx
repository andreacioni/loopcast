export function Breadcrumbs({ path, onNavigate }) {
  return (
    <nav id="breadcrumbs">
      {path.map((p, i) => (
        <span key={p.id + i} onClick={() => onNavigate(i)}>
          {i > 0 ? " / " : ""}
          {p.title}
        </span>
      ))}
    </nav>
  );
}
