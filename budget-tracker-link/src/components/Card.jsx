export default function Card({ children, className = "", padding = "p-6", as: Tag = "div" }) {
  return (
    <Tag
      className={`bg-surface rounded-card shadow-card border border-line/60 ${padding} ${className}`}
    >
      {children}
    </Tag>
  );
}
