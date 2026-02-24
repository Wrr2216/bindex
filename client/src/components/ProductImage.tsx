import { useState } from "react";
import { api } from "../api/client";

type Props = {
  src: string | null | undefined;
  alt?: string;
  className?: string;
};

/**
 * A product photo, fetched through the server so that hotlink-protected,
 * expired and plain-http URLs still render. Falls back to a placeholder when
 * there is no photo or it fails to load.
 */
export function ProductImage({ src, alt = "", className = "" }: Props) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-800 text-slate-600 ${className}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-1/3 w-1/3">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </div>
    );
  }

  // Anything this app already hosts loads directly; the rest is proxied.
  const displaySrc = src.startsWith("/") ? src : api.imageProxyUrl(src);

  return (
    <img
      src={displaySrc}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
