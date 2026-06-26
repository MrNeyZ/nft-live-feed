'use client';

import React from 'react';

// Per-letter kerning for Victory — same pairs for both contexts, letter-spacing differs via CSS.
// Tuple: [char, marginLeft?] — no vertical offset for Victory
const VICTORY: [string, string?, string?][] = [
  ['V', '0.03em'],
  ['i', '-0.01em'],
  ['c', '0.01em'],
  ['t', '-0.01em'],
  ['o', '0.02em'],
  ['r', '0.01em'],
  ['y', '0.07em'],
];

// Per-letter kerning for Labs — kerning shared, vertical offsets differ per context.
// Tuple: [char, marginLeft?, top?]
const LABS_GATE: [string, string?, string?][] = [
  ['L'],
  ['a', '-0.086em', '2px'],
  ['b', '-0.035em', '2px'],
  ['s', '-0.062em', '2px'],
];
const LABS_NAV: [string, string?, string?][] = [
  ['L'],
  ['a', '-0.086em', '1px'],
  ['b', '-0.035em', '1px'],
  ['s', '-0.062em', '1px'],
];

function KernedSpan({ letters, className }: { letters: [string, string?, string?][]; className: string }) {
  return (
    <span className={className} aria-hidden>
      {letters.map(([ch, ml, dy], i) => (
        <span key={i} style={{
          ...(ml ? { marginLeft: ml } : {}),
          ...(dy ? { position: 'relative', top: dy } : {}),
        }}>{ch}</span>
      ))}
    </span>
  );
}

function VLStar() {
  return (
    <svg className="vl-star" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 0 C12.6 7.4 16.6 11.4 24 12 C16.6 12.6 12.6 16.6 12 24 C11.4 16.6 7.4 12.6 0 12 C7.4 11.4 11.4 7.4 12 0 Z"
        fill="currentColor"
      />
    </svg>
  );
}

interface VictoryLabsLogoProps {
  variant?: 'primary' | 'hero';
  /** Overrides --vl-size for this instance only (e.g. "26px", "52px"). */
  size?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function VictoryLabsLogo({
  variant = 'primary',
  size,
  style,
  className = '',
}: VictoryLabsLogoProps) {
  // CSS custom props require the cast; React.CSSProperties allows index access
  const sizeVar = size ? ({ '--vl-size': size } as React.CSSProperties) : undefined;
  const combined: React.CSSProperties = { ...sizeVar, ...style };

  if (variant === 'hero') {
    return (
      <span
        className={`vl-hero${className ? ' ' + className : ''}`}
        style={combined}
        aria-label="VictoryLabs"
      >
        <span className="vl-logo" aria-hidden>
          <KernedSpan letters={VICTORY} className="vl-logo__victory" />
          <KernedSpan letters={LABS_GATE} className="vl-logo__labs" />
        </span>
        <span className="vl-divider">
          <hr className="vl-ln vl-ln--l" />
          <VLStar />
          <hr className="vl-ln vl-ln--r" />
        </span>
      </span>
    );
  }

  return (
    <span
      className={`vl-logo${className ? ' ' + className : ''}`}
      style={combined}
      aria-label="VictoryLabs"
    >
      <KernedSpan letters={VICTORY} className="vl-logo__victory" />
      <KernedSpan letters={LABS_NAV} className="vl-logo__labs" />
    </span>
  );
}
