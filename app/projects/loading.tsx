export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8" aria-busy="true" aria-label="Loading projects">
      <div className="mb-6 h-6 w-40 animate-pulse bg-panel-2" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="mb-2 flex gap-4 border-b border-line py-2">
          <div className="h-4 w-1/4 animate-pulse bg-panel-2" />
          <div className="h-4 w-1/4 animate-pulse bg-panel-2" />
          <div className="h-4 w-1/6 animate-pulse bg-panel-2" />
        </div>
      ))}
    </div>
  );
}
