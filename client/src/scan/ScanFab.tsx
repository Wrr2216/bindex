/** The button that starts a camera scan. On a phone this is the main way in. */
export function ScanFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Scan a barcode with the camera"
      className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg shadow-sky-900/50 transition hover:bg-sky-500 active:scale-95"
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7V5a2 2 0 0 1 2-2h2" />
        <path d="M17 3h2a2 2 0 0 1 2 2v2" />
        <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
        <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
        <path d="M7 8v8M11 8v8M15 8v8M18 8v8" />
      </svg>
    </button>
  );
}
