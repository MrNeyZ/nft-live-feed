'use client';

import React from 'react';

// Per-letter left-margin offsets (em) applied before each character.
// Negative = tighter. Based on optical balance for Bookman Old Style (Victory)
// and Parisienne (Labs) at display sizes.
const VICTORY: [string, string?][] = [
  ['V'],
  ['i', '-0.025em'],   // V's open diagonal creates excess gap before narrow i
  ['c', '-0.015em'],   // i→c: slight tighten into the bowl
  ['t', '-0.010em'],   // c→t: mild
  ['o'],               // t→o: normal
  ['r', '-0.015em'],   // o→r: o closes right, r shoulder needs to meet it
  ['y', '-0.038em'],   // r→y: noticeably tighter — r arm + y fork has too much air
];

const LABS: [string, string?][] = [
  ['L'],
  ['a', '-0.045em'],   // script L flourish → a needs to tuck in
  ['b', '-0.025em'],
  ['s', '-0.018em'],
];

function KernedSpan({ letters, className }: { letters: [string, string?][]; className: string }) {
  return (
    <span className={className} aria-hidden>
      {letters.map(([ch, ml], i) => (
        <span key={i} style={ml ? { marginLeft: ml } : undefined}>{ch}</span>
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
          <KernedSpan letters={LABS} className="vl-logo__labs" />
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
      <KernedSpan letters={LABS} className="vl-logo__labs" />
    </span>
  );
}
